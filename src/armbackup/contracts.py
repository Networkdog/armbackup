from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import threading
from collections.abc import Iterator, Mapping
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import urlsplit

import requests
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


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
_SAFE_SEG_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_PLATFORM_CLIENT_ID_KEY_RE = re.compile(
    r"^(?:AZURE_CLIENT_ID|MSI_CLIENT_ID|Identity_[A-Za-z0-9_]+_ClientId|AZURE_[A-Z0-9_]+_CLIENTID)$",
    re.IGNORECASE,
)


def _is_local_msi_endpoint(endpoint: str) -> bool:
    try:
        parsed = urlsplit(endpoint)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_link_local or ip.is_private


def _candidate_uami_resource_ids(
    environ: Mapping[str, str],
    *,
    subscriptions: tuple[str, ...] = (),
    resource_groups: tuple[str, ...] = (),
) -> list[str]:
    owner = environ.get("WEBSITE_OWNER_NAME", "").strip()
    owner_sub = owner.split("+", 1)[0].strip() if "+" in owner else owner
    sub_candidates = [
        owner_sub,
        environ.get("ARMBACKUP_SUBSCRIPTION_ID", "").strip(),
        *subscriptions,
    ]
    sub_id = next((s for s in sub_candidates if _UUID_RE.fullmatch(s)), "")
    if not sub_id:
        return []
    site_name = environ.get("WEBSITE_SITE_NAME", "").strip()
    if not _SAFE_SEG_RE.fullmatch(site_name):
        return []
    lower_site = site_name.lower()
    slug = (
        lower_site[4:]
        if lower_site.startswith("app-")
        else (lower_site[3:] if lower_site.startswith("as-") else lower_site)
    )
    groups: list[str] = []
    raw_groups = [
        environ.get("WEBSITE_RESOURCE_GROUP", "").strip(),
        environ.get("ARMBACKUP_STORAGE_RESOURCE_GROUP", "").strip(),
        environ.get("ARMBACKUP_RESOURCE_GROUP", "").strip(),
        *resource_groups,
    ]
    for rg_val in raw_groups:
        if _SAFE_SEG_RE.fullmatch(rg_val) and rg_val.lower() not in {g.lower() for g in groups}:
            groups.append(rg_val)
    if not groups:
        return []
    names: list[str] = []
    for candidate in (
        f"id-{slug}",
        f"id-{lower_site}",
        f"mi-{slug}",
        f"mi-{lower_site}",
        f"uami-{slug}",
        f"uami-{lower_site}",
        f"{lower_site}-id",
        f"{slug}-id",
    ):
        if _SAFE_SEG_RE.fullmatch(candidate) and candidate not in names:
            names.append(candidate)
    return [
        f"/subscriptions/{sub_id}/resourceGroups/{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{nm}"
        for rg in groups
        for nm in names
    ]


class _AppServiceIdentityChainCredential:
    """Resolves App Service Managed Identity in priority order without requiring manual client_id input:
    1st: User Assigned Managed Identity attached to the App Service
    2nd: System Assigned Managed Identity
    """

    def __init__(
        self,
        environ: Mapping[str, str] | None = None,
        *,
        subscriptions: tuple[str, ...] = (),
        resource_groups: tuple[str, ...] = (),
    ) -> None:
        self._env: Mapping[str, str] = os.environ if environ is None else environ
        self._subscriptions = subscriptions
        self._resource_groups = resource_groups
        self._lock = threading.Lock()
        self._delegate: TokenCredential | None = None

    @staticmethod
    def _extract_uami_credential(site_doc: object) -> TokenCredential | None:
        from azure.identity import ManagedIdentityCredential

        if not isinstance(site_doc, dict):
            return None
        ident = site_doc.get("identity") or {}
        uamis = ident.get("userAssignedIdentities") if isinstance(ident, dict) else None
        if isinstance(uamis, dict) and uamis:
            first_rid, first_meta = next(iter(uamis.items()))
            cid = first_meta.get("clientId", "") if isinstance(first_meta, dict) else ""
            if isinstance(cid, str) and _UUID_RE.fullmatch(cid):
                return ManagedIdentityCredential(client_id=cid)
            if isinstance(first_rid, str) and first_rid.startswith("/subscriptions/"):
                return ManagedIdentityCredential(identity_config={"resource_id": first_rid})
        return None

    def _discover_uami(self) -> TokenCredential | None:
        from azure.identity import ManagedIdentityCredential

        for key, raw_val in self._env.items():
            val = raw_val.strip().strip("'\"")
            if _PLATFORM_CLIENT_ID_KEY_RE.fullmatch(key) and _UUID_RE.fullmatch(val):
                return ManagedIdentityCredential(client_id=val)

        endpoint = self._env.get("IDENTITY_ENDPOINT", "").strip()
        header = self._env.get("IDENTITY_HEADER", "").strip()
        if not endpoint or not header or not _is_local_msi_endpoint(endpoint):
            return None

        headers = {"X-IDENTITY-HEADER": header}
        owner = self._env.get("WEBSITE_OWNER_NAME", "").strip()
        owner_sub = owner.split("+", 1)[0].strip() if "+" in owner else owner
        sub_candidates = [owner_sub, self._env.get("ARMBACKUP_SUBSCRIPTION_ID", "").strip(), *self._subscriptions]
        site_sub = next((s for s in sub_candidates if _UUID_RE.fullmatch(s)), "")
        site_rg = self._env.get("WEBSITE_RESOURCE_GROUP", "").strip()
        site_name = self._env.get("WEBSITE_SITE_NAME", "").strip()

        # 1a. If SystemAssigned is also enabled and can read the Web App resource, inspect identity.userAssignedIdentities
        # so ANY arbitrarily-named attached User Assigned Managed Identity still takes priority over SystemAssigned.
        if site_sub and _SAFE_SEG_RE.fullmatch(site_name):
            try:
                tok_resp = requests.get(
                    endpoint,
                    params={"api-version": "2019-08-01", "resource": "https://management.azure.com/"},
                    headers=headers,
                    timeout=2.0,
                )
                if tok_resp.status_code == 200:
                    sys_token = tok_resp.json().get("access_token", "")
                    if isinstance(sys_token, str) and sys_token:
                        arm_headers = {"Authorization": f"Bearer {sys_token}"}
                        site_checked = False
                        if _SAFE_SEG_RE.fullmatch(site_rg):
                            site_url = (
                                f"https://management.azure.com/subscriptions/{site_sub}/resourceGroups/{site_rg}"
                                f"/providers/Microsoft.Web/sites/{site_name}"
                            )
                            site_resp = requests.get(
                                site_url, params={"api-version": "2023-12-01"}, headers=arm_headers, timeout=5.0,
                            )
                            if site_resp.status_code == 200:
                                site_checked = True
                                found = self._extract_uami_credential(site_resp.json())
                                if found is not None:
                                    return found
                                return None
                        if not site_checked:
                            list_url = f"https://management.azure.com/subscriptions/{site_sub}/providers/Microsoft.Web/sites"
                            list_resp = requests.get(
                                list_url, params={"api-version": "2023-12-01"}, headers=arm_headers, timeout=5.0,
                            )
                            if list_resp.status_code == 200:
                                items = list_resp.json().get("value")
                                if isinstance(items, list):
                                    for entry in items:
                                        if isinstance(entry, dict) and str(entry.get("name", "")).lower() == site_name.lower():
                                            found = self._extract_uami_credential(entry)
                                            if found is not None:
                                                return found
                                            return None
            except (requests.RequestException, ValueError, KeyError):
                pass

        # 1b. Probe local App Service IDENTITY_ENDPOINT (mi_res_id) for standard UAMI names in app/common RGs
        # (succeeds even when SystemAssigned is Off or lacks ARM Reader on the Web App resource).
        for candidate_rid in _candidate_uami_resource_ids(
            self._env, subscriptions=self._subscriptions, resource_groups=self._resource_groups,
        ):
            try:
                probe = requests.get(
                    endpoint,
                    params={
                        "api-version": "2019-08-01",
                        "resource": "https://management.azure.com/",
                        "mi_res_id": candidate_rid,
                    },
                    headers=headers,
                    timeout=2.0,
                )
                if probe.status_code == 200 and probe.json().get("access_token"):
                    return ManagedIdentityCredential(identity_config={"resource_id": candidate_rid})
            except (requests.RequestException, ValueError):
                continue

        return None

    def _resolve(self) -> TokenCredential:
        if self._delegate is not None:
            return self._delegate
        with self._lock:
            if self._delegate is not None:
                return self._delegate
            from azure.identity import ManagedIdentityCredential

            discovered = self._discover_uami()
            if discovered is not None:
                self._delegate = discovered
                return discovered
            # 2nd priority fallback: System Assigned Managed Identity
            self._delegate = ManagedIdentityCredential()
            return self._delegate

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        return self._resolve().get_token(*scopes, **kwargs)

    def close(self) -> None:
        if self._delegate is not None and hasattr(self._delegate, "close"):
            self._delegate.close()

    def __enter__(self) -> _AppServiceIdentityChainCredential:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


def credential(
    mode: str,
    client_id: str | None = None,
    *,
    resource_id: str | None = None,
    object_id: str | None = None,
    require_user_assigned: bool = False,
    environ: Mapping[str, str] | None = None,
    subscriptions: tuple[str, ...] = (),
    resource_groups: tuple[str, ...] = (),
) -> TokenCredential:
    from azure.identity import AzureCliCredential, ManagedIdentityCredential

    if mode == "managed_identity":
        if client_id:
            return ManagedIdentityCredential(client_id=client_id)
        if resource_id:
            return ManagedIdentityCredential(identity_config={"resource_id": resource_id})
        if object_id:
            return ManagedIdentityCredential(identity_config={"object_id": object_id})
        env = os.environ if environ is None else environ
        if env.get("WEBSITE_SITE_NAME") or env.get("IDENTITY_ENDPOINT") or require_user_assigned:
            return _AppServiceIdentityChainCredential(
                env, subscriptions=subscriptions, resource_groups=resource_groups,
            )
        return ManagedIdentityCredential()
    if mode == "cli":
        return AzureCliCredential()
    raise BackupError("credential must be managed_identity or cli")
