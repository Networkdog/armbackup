from __future__ import annotations

import ipaddress
import re
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
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
from armbackup.contracts import (
    BackupError,
    JsonObject,
    require_purge_prefix,
    require_view_artifact,
    validate_explore_prefix,
)


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
    def __init__(
        self, config: Config, credential: TokenCredential, *,
        auto_create_container: bool = False, defer_preflight: bool = False,
    ) -> None:
        self._storage_url = config.storage_url
        self._require_private = config.require_private_storage
        self._auto_create = auto_create_container
        self._ready = False
        self._ready_lock = threading.Lock()
        self.container = ContainerClient(
            config.storage_url, config.container, credential=credential,
            connection_timeout=10, read_timeout=config.timeout, retry_total=config.retries,
        )
        self.prefix = config.prefix
        self._lost = threading.Event()
        if not defer_preflight:
            self._ensure_ready()

    @staticmethod
    def _preflight_error(exc: AzureError) -> BackupError:
        status = getattr(exc, "status_code", None)
        code = getattr(exc, "error_code", None)
        detail = f" (HTTP {status}{f' {code}' if code else ''})" if status else ""
        return BackupError(f"Blob container preflight failed: {type(exc).__name__}{detail}")

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        with self._ready_lock:
            if self._ready:
                return
            if self._require_private:
                private_storage_check(self._storage_url)
            try:
                self.container.get_container_properties()
            except ResourceNotFoundError as exc:
                if not self._auto_create:
                    raise self._preflight_error(exc) from exc
                try:
                    self.container.create_container()
                except ResourceExistsError:
                    pass
                except AzureError as create_exc:
                    if getattr(create_exc, "status_code", None) != 409:
                        raise self._preflight_error(create_exc) from create_exc
            except AzureError as exc:
                raise self._preflight_error(exc) from exc
            self._ready = True

    def put_if_absent(self, name: str, content: bytes) -> bool:
        self._ensure_ready()
        try:
            self.container.upload_blob(self._name(name), content, overwrite=False)
            return True
        except ResourceExistsError:
            return False
        except AzureError as exc:
            if getattr(exc, "status_code", None) == 409:
                return False
            raise BackupError(f"Blob write failed: {type(exc).__name__}") from exc

    def bootstrap(self, *, metadata: bytes | None = None, seed_dir: Path | None = None) -> int:
        """Initializes the isolated container and seeds write-once blobs from App Service startup."""
        self._ensure_ready()
        seeded = 0
        if metadata is not None and self.put_if_absent("console/bootstrap.json", metadata):
            seeded += 1
        if seed_dir is not None and seed_dir.is_dir():
            for item in sorted(seed_dir.rglob("*")):
                if item.is_file():
                    rel = item.relative_to(seed_dir).as_posix()
                    if self.put_if_absent(rel, item.read_bytes()):
                        seeded += 1
        return seeded

    def _name(self, name: str) -> str:
        if name.startswith("/") or "\\" in name or any(x in {"", ".", ".."} for x in name.split("/")):
            raise BackupError("Unsafe archive path")
        return f"{self.prefix}/{name}"

    def put(self, name: str, content: bytes) -> None:
        self.assert_lock()
        self._ensure_ready()
        try:
            self.container.upload_blob(self._name(name), content, overwrite=False)
        except AzureError as exc:
            raise BackupError(f"Blob write failed: {type(exc).__name__}") from exc

    def get(self, name: str) -> bytes:
        self._ensure_ready()
        try:
            return self.container.download_blob(self._name(name)).readall()
        except AzureError as exc:
            raise BackupError(f"Blob read failed: {type(exc).__name__}") from exc

    def names(self, prefix: str, *, limit: int = 1000) -> list[str]:
        if not 1 <= limit <= 10000:
            raise BackupError("Archive listing limit must be in 1..10000")
        self._ensure_ready()
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

    def explore(self, prefix: str = "", *, limit: int = 10000) -> JsonObject:
        if type(limit) is not int or not 1 <= limit <= 20000:
            raise BackupError("Archive explore limit must be in 1..20000")
        self._ensure_ready()
        cleaned = validate_explore_prefix(prefix)
        try:
            iterator = (
                self.container.list_blobs(name_starts_with=f"{cleaned}/")
                if cleaned else self.container.list_blobs()
            )
            blobs: list[JsonObject] = []
            truncated = False
            for entry in iterator:
                name = str(entry.name)
                size = int(getattr(entry, "size", 0) or 0)
                if name.endswith("/") and size == 0:
                    continue
                if len(blobs) >= limit:
                    truncated = True
                    break
                modified = getattr(entry, "last_modified", None)
                last_modified = (
                    modified.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
                    if isinstance(modified, datetime) else ""
                )
                settings = getattr(entry, "content_settings", None)
                content_type = str(getattr(settings, "content_type", "") or "")
                tier = str(getattr(entry, "blob_tier", "") or "")
                blobs.append({
                    "name": name,
                    "size": size,
                    "lastModified": last_modified,
                    **({"contentType": content_type} if content_type else {}),
                    **({"tier": tier} if tier else {}),
                })
            blobs.sort(key=lambda item: str(item["name"]))
            return {
                "blobs": blobs,
                "truncated": truncated,
                "scanLimit": limit,
                "prefix": cleaned,
                "configuredPrefix": self.prefix,
            }
        except AzureError as exc:
            raise BackupError(f"Blob listing failed: {type(exc).__name__}") from exc

    def read_pointer(self, name: str) -> tuple[bytes, str] | None:
        self._ensure_ready()
        try:
            download = self.container.download_blob(self._name(name))
            return download.readall(), download.properties.etag
        except ResourceNotFoundError:
            return None
        except AzureError as exc:
            raise BackupError(f"Blob pointer read failed: {type(exc).__name__}") from exc

    def replace_pointer(self, name: str, content: bytes, etag: str | None) -> bool:
        self.assert_lock()
        self._ensure_ready()
        if not re.fullmatch(r"console/views/(?:heads|status)/[a-f0-9]{64}\.json", name):
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
        self._ensure_ready()
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

    def purge(self, prefix: str) -> int:
        self.assert_lock()
        self._ensure_ready()
        require_purge_prefix(prefix)
        deleted = 0
        try:
            for entry in self.container.list_blobs(name_starts_with=self._name(prefix) + "/"):
                self.container.delete_blob(entry.name)
                deleted += 1
        except ResourceNotFoundError:
            pass
        except AzureError as exc:
            raise BackupError(f"Backup purge failed after {deleted} blobs: {type(exc).__name__}") from exc
        return deleted

    def assert_lock(self) -> None:
        if self._lost.is_set():
            raise BackupError("Backup scope lease was lost")

    @contextmanager
    def guard(self, key: str) -> Iterator[None]:
        self._ensure_ready()
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
