from __future__ import annotations

import ipaddress
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlsplit

from azure.core.credentials import TokenCredential
from azure.core.exceptions import AzureError, ResourceExistsError
from azure.storage.blob import BlobLeaseClient, ContainerClient

from armbackup.config import Config
from armbackup.contracts import BackupError


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
