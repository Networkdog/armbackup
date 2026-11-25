from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Any, Protocol

from azure.core.credentials import AccessToken, TokenCredential

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


def require_view_artifact(name: str) -> None:
    if not re.fullmatch(
        r"console/views/(?:heads/[a-f0-9]{64}|objects/[a-f0-9]{64}|complete/[A-Za-z0-9_-]+)\.json",
        name,
    ):
        raise BackupError("Only intermediate state view artifacts may be deleted")


PURGE_PREFIXES = (
    "runs", "console/labels", "console/bundle-plans", "console/bundle-claims", "console/views",
)


def require_purge_prefix(prefix: str) -> None:
    if prefix not in PURGE_PREFIXES:
        raise BackupError("Only backup data prefixes may be purged")


def validate_explore_prefix(prefix: str) -> str:
    if not isinstance(prefix, str) or len(prefix) > 1024:
        raise BackupError("Invalid storage explore prefix")
    if prefix == "":
        return ""
    cleaned = prefix[:-1] if len(prefix) > 1 and prefix.endswith("/") and not prefix.endswith("//") else prefix
    if (cleaned.startswith("/") or "\\" in cleaned
            or any(part in {"", ".", ".."} or any(ord(ch) < 32 or ord(ch) == 127 for ch in part)
                   for part in cleaned.split("/"))):
        raise BackupError("Unsafe storage explore prefix")
    return cleaned


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

    def delete_view_artifact(self, name: str, etag: str) -> bool: ...

    def purge(self, prefix: str) -> int: ...

    def explore(self, prefix: str = "", *, limit: int = 10000) -> JsonObject: ...


class Events(Protocol):
    def emit(
        self, event: str, *, level: str = "Information", resource_id: str = "",
        status: str = "", code: str = "", **metrics: int | float | str,
    ) -> None: ...

    def flush(self) -> None: ...


class _MissingUserAssignedIdentityCredential:
    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        raise BackupError(
            "User Assigned Managed Identity is required: set ARMBACKUP_MANAGED_IDENTITY_CLIENT_ID "
            "(or AZURE_CLIENT_ID / ARMBACKUP_MANAGED_IDENTITY_RESOURCE_ID) and restart the app"
        )


def credential(
    mode: str,
    client_id: str | None = None,
    *,
    resource_id: str | None = None,
    object_id: str | None = None,
    require_user_assigned: bool = False,
) -> TokenCredential:
    from azure.identity import AzureCliCredential, ManagedIdentityCredential

    if mode == "managed_identity":
        if client_id:
            return ManagedIdentityCredential(client_id=client_id)
        if resource_id:
            return ManagedIdentityCredential(identity_config={"resource_id": resource_id})
        if object_id:
            return ManagedIdentityCredential(identity_config={"object_id": object_id})
        if require_user_assigned:
            return _MissingUserAssignedIdentityCredential()
        return ManagedIdentityCredential()
    if mode == "cli":
        return AzureCliCredential()
    raise BackupError("credential must be managed_identity or cli")
