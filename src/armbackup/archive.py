from __future__ import annotations

import ipaddress
import re
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlsplit

from azure.core import MatchConditions
from azure.core.credentials import TokenCredential
from azure.core.exceptions import (
    AzureError,
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.storage.blob import BlobLeaseClient, ContainerClient

from armbackup.config import Config
from armbackup.contracts import BackupError, require_view_artifact


def private_storage_check(url: str) -> None:
    host = urlsplit(url).hostname
    if host is None:
        raise BackupError("Storage URL has no host")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as exc:
        raise BackupError("Storage DNS resolution failed") from exc
    networks = [ipaddress.ip_network(n) for n in
                ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")]
    if not addresses or any(
        not any(ipaddress.ip_address(a) in n for n in networks) for a in addresses
    ):
        raise BackupError("Storage DNS must resolve only to private addresses; public path refused")


class BlobArchive:
    def __init__(self, config: Config, credential: TokenCredential) -> None:
        if config.require_private_storage:
            private_storage_check(config.storage_url)
        self.container = ContainerClient(
            config.storage_url, config.container, credential=credential,
            connection_timeout=10, read_timeout=config.timeout, retry_total=config.retries,
        )
        self.prefix = config.prefix
        self._lost = threading.Event()
        try:
            self.container.get_container_properties()
        except AzureError as exc:
            raise BackupError(f"Blob container preflight failed: {type(exc).__name__}") from exc

    def _name(self, name: str) -> str:
        if name.startswith("/") or "\\" in name or any(x in {"", ".", ".."} for x in name.split("/")):
            raise BackupError("Unsafe archive path")
        return f"{self.prefix}/{name}"

    def put(self, name: str, content: bytes) -> None:
        self.assert_lock()
        try:
            self.container.upload_blob(self._name(name), content, overwrite=False)
        except AzureError as exc:
            raise BackupError(f"Blob write failed: {type(exc).__name__}") from exc

    def get(self, name: str) -> bytes:
        try:
            return self.container.download_blob(self._name(name)).readall()
        except AzureError as exc:
            raise BackupError(f"Blob read failed: {type(exc).__name__}") from exc

    def names(self, prefix: str, *, limit: int = 1000) -> list[str]:
        if not 1 <= limit <= 10000:
            raise BackupError("Archive listing limit must be in 1..10000")
        root = self._name(prefix)
        try:
            result: list[str] = []
            for entry in self.container.list_blobs(name_starts_with=root):
                result.append(entry.name[len(self.prefix) + 1:])
                if len(result) > limit:
                    raise BackupError("Archive listing exceeds configured limit; narrow the prefix")
            return sorted(result)
        except AzureError as exc:
            raise BackupError(f"Blob listing failed: {type(exc).__name__}") from exc

    def read_pointer(self, name: str) -> tuple[bytes, str] | None:
        try:
            download = self.container.download_blob(self._name(name))
            return download.readall(), download.properties.etag
        except ResourceNotFoundError:
            return None
        except AzureError as exc:
            raise BackupError(f"Blob pointer read failed: {type(exc).__name__}") from exc

    def replace_pointer(self, name: str, content: bytes, etag: str | None) -> bool:
        self.assert_lock()
        if not re.fullmatch(r"console/views/heads/[a-f0-9]{64}\.json", name):
            raise BackupError("Only state view pointers may be replaced")
        try:
            if etag is None:
                self.container.upload_blob(self._name(name), content, overwrite=False)
            else:
                self.container.upload_blob(self._name(name), content, overwrite=True,
                                           etag=etag, match_condition=MatchConditions.IfNotModified)
            return True
        except (ResourceExistsError, ResourceModifiedError):
            return False
        except AzureError as exc:
            raise BackupError(f"Blob pointer publication failed: {type(exc).__name__}") from exc

    def delete_view_artifact(self, name: str, etag: str) -> bool:
        self.assert_lock()
        require_view_artifact(name)
        try:
            self.container.delete_blob(self._name(name), etag=etag, match_condition=MatchConditions.IfNotModified)
            return True
        except ResourceNotFoundError:
            return True
        except ResourceModifiedError:
            return False
        except AzureError as exc:
            raise BackupError(f"Cache artifact deletion failed: {type(exc).__name__}") from exc

    def assert_lock(self) -> None:
        if self._lost.is_set():
            raise BackupError("Backup scope lease was lost")

    @contextmanager
    def guard(self, key: str) -> Iterator[None]:
        blob = self.container.get_blob_client(self._name(f"locks/{key}.lock"))
        try:
            blob.upload_blob(b"lock", overwrite=False)
        except ResourceExistsError:
            pass
        except AzureError as exc:
            raise BackupError(f"Cannot initialize scope lock: {type(exc).__name__}") from exc
        lease = BlobLeaseClient(blob)
        try:
            lease.acquire(lease_duration=60)
        except AzureError as exc:
            raise BackupError(f"Cannot acquire scope lock: {type(exc).__name__}") from exc
        stop = threading.Event()

        def renew() -> None:
            while not stop.wait(20):
                try:
                    lease.renew()
                except AzureError:
                    self._lost.set()
                    return

        thread = threading.Thread(target=renew, name="scope-lease", daemon=True)
        thread.start()
        try:
            yield
            self.assert_lock()
        finally:
            stop.set()
            thread.join(timeout=30)
            try:
                lease.release()
            except AzureError as exc:
                raise BackupError(f"Scope lock release failed: {type(exc).__name__}") from exc
