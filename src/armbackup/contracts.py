from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Any, Protocol

from azure.core.credentials import TokenCredential

JsonObject = dict[str, Any]


class BackupError(Exception):
    """An explicit capture, transport, configuration, or restore failure."""


class ArmHttpError(BackupError):
    def __init__(self, status: int, code: str) -> None:
        self.status, self.code = status, code
        super().__init__(f"ARM HTTP {status}: {code}")


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encode_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def object_value(value: Any, label: str) -> JsonObject:
    if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
        raise BackupError(f"{label}: expected JSON object")
    return value


class Arm(Protocol):
    def request(
        self, method: str, path: str, api_version: str | None = None,
        body: JsonObject | None = None,
    ) -> JsonObject: ...

    def pages(self, path: str, api_version: str) -> Iterator[JsonObject]: ...


class Archive(Protocol):
    def put(self, name: str, content: bytes) -> None: ...

    def get(self, name: str) -> bytes: ...

    def guard(self, key: str) -> AbstractContextManager[None]: ...

    def assert_lock(self) -> None: ...


class BrowseArchive(Archive, Protocol):
    def names(self, prefix: str, *, limit: int = 1000) -> list[str]: ...

    def read_pointer(self, name: str) -> tuple[bytes, str] | None: ...

    def replace_pointer(self, name: str, content: bytes, etag: str | None) -> bool: ...


class Events(Protocol):
    def emit(
        self, event: str, *, level: str = "Information", resource_id: str = "",
        status: str = "", code: str = "", **metrics: int | float | str,
    ) -> None: ...

    def flush(self) -> None: ...


def credential(mode: str, client_id: str | None = None) -> TokenCredential:
    from azure.identity import AzureCliCredential, ManagedIdentityCredential

    if mode == "managed_identity":
        return ManagedIdentityCredential(client_id=client_id)
    if mode == "cli":
        return AzureCliCredential()
    raise BackupError("credential must be managed_identity or cli")
