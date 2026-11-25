from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from armbackup.contracts import BackupError, JsonObject, object_value

UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
UAMI_RESOURCE_ID = re.compile(
    r"^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[^/?#\\]+/providers/"
    r"Microsoft\.ManagedIdentity/userAssignedIdentities/[^/?#\\]+$",
    re.IGNORECASE,
)
API_VERSION = re.compile(r"^\d{4}-\d{2}-\d{2}(?:-preview)?$")
TABLES = {
    "Resources": "",
    "ResourceContainers": " | where type in~ ('microsoft.resources/subscriptions', 'microsoft.resources/subscriptions/resourcegroups')",
    "AuthorizationResources": " | where type in~ ('microsoft.authorization/roleassignments', 'microsoft.authorization/roledefinitions')",
    "PolicyResources": " | where type in~ ('microsoft.authorization/policyassignments', 'microsoft.authorization/policydefinitions', 'microsoft.authorization/policysetdefinitions', 'microsoft.authorization/policyexemptions')",
}


def keys(value: JsonObject, allowed: set[str], label: str) -> None:
    extra = set(value) - allowed
    if extra:
        raise BackupError(f"{label}: unknown settings {sorted(extra)}")


def version(value: object, *, preview: bool = False) -> str:
    if not isinstance(value, str) or not API_VERSION.fullmatch(value):
        raise BackupError("API version must use YYYY-MM-DD[-preview]")
    if value.endswith("-preview") and not preview:
        raise BackupError("Preview API requires allow_preview=true")
    return value


def strings(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise BackupError(f"{label}: expected string array")
    if len(set(v.lower() for v in value)) != len(value):
        raise BackupError(f"{label}: duplicates")
    return value


@dataclass(frozen=True)
class Collection:
    name: str
    path: str
    api_version: str
    mode: str

    @classmethod
    def parse(cls, raw: object, preview: bool) -> Collection:
        data = object_value(raw, "collection")
        keys(data, {"name", "path", "api_version", "mode"}, "collection")
        name, path = data.get("name"), data.get("path")
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise BackupError("collection name must be an identifier")
        if not isinstance(path, str) or not re.fullmatch(r"[a-zA-Z0-9_./-]+", path):
            raise BackupError("collection path must be a relative ARM child path")
        if path.startswith("/") or any(p in {"", ".", ".."} for p in path.split("/")):
            raise BackupError("collection path must not escape parent")
        mode = data.get("mode", "list")
        if mode not in {"list", "object"}:
            raise BackupError("collection mode must be list or object")
        return cls(name, path, version(data.get("api_version"), preview=preview), mode)


LOG_ENV_KEYS = (
    "ARMBACKUP_LOG_WORKSPACE_ID",
    "ARMBACKUP_LOG_DCR_ID",
    "ARMBACKUP_LOG_ENDPOINT",
    "ARMBACKUP_LOG_RULE_ID",
    "ARMBACKUP_LOG_STREAM",
)


def _clean_env(value: str) -> str:
    cleaned = value.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
        cleaned = cleaned[1:-1].strip()
    return cleaned


def _parse_logging(raw_log: object) -> tuple[str, str, str, str, str]:
    if raw_log is None:
        return "", "", "", "", ""
    log = object_value(raw_log, "logging")
    keys(log, {"endpoint", "rule_id", "stream", "workspace_resource_id", "dcr_resource_id"}, "logging")
    raw_endpoint = log.get("endpoint", "")
    if not isinstance(raw_endpoint, str):
        raise BackupError("logging.endpoint must be a URL")
    try:
        parsed_url = urlsplit(raw_endpoint.strip())
        port = parsed_url.port
    except ValueError as exc:
        raise BackupError("logging.endpoint must be the Azure Monitor DCR/DCE ingestion endpoint") from exc
    if (parsed_url.scheme != "https" or not parsed_url.hostname
            or not parsed_url.hostname.endswith(".ingest.monitor.azure.com")
            or parsed_url.username or parsed_url.password or port
            or parsed_url.path not in {"", "/"} or parsed_url.query or parsed_url.fragment):
        raise BackupError("logging.endpoint must be the Azure Monitor DCR/DCE ingestion endpoint")
    endpoint = raw_endpoint.strip().rstrip("/")
    raw_rule, raw_stream = log.get("rule_id", ""), log.get("stream", "")
    if not isinstance(raw_rule, str) or not re.fullmatch(r"dcr-[a-zA-Z0-9]+", raw_rule):
        raise BackupError("logging.rule_id must be the DCR immutableId, not workspace ID")
    if not isinstance(raw_stream, str) or not re.fullmatch(r"Custom-[A-Za-z0-9_]+", raw_stream):
        raise BackupError("logging.stream must be a Custom- stream")
    raw_workspace, raw_dcr = log.get("workspace_resource_id"), log.get("dcr_resource_id")
    if not isinstance(raw_workspace, str) or not isinstance(raw_dcr, str):
        raise BackupError("logging workspace_resource_id and dcr_resource_id must be strings")
    for rid, namespace, label in [
        (raw_workspace, "Microsoft.OperationalInsights/workspaces", "workspace_resource_id"),
        (raw_dcr, "Microsoft.Insights/dataCollectionRules", "dcr_resource_id"),
    ]:
        if not re.fullmatch(
            r"/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[^/?#\\]+/providers/"
            + re.escape(namespace) + r"/[^/?#\\]+", rid, re.IGNORECASE,
        ):
            raise BackupError(f"logging.{label} must be a full Azure resource ID")
    return endpoint, raw_rule, raw_stream, raw_workspace, raw_dcr


def _parse_managed_identity(
    env: Mapping[str, str],
    *,
    raw_client_id: object = None,
    raw_resource_id: object = None,
    raw_object_id: object = None,
    raw_require_user_assigned: object = None,
) -> tuple[str | None, str | None, str | None, bool]:
    env_client_id = (
        _clean_env(env.get("ARMBACKUP_MANAGED_IDENTITY_CLIENT_ID", ""))
        or _clean_env(env.get("AZURE_CLIENT_ID", ""))
    )
    if env_client_id:
        if not UUID.fullmatch(env_client_id):
            raise BackupError("ARMBACKUP_MANAGED_IDENTITY_CLIENT_ID must be a UUID")
        client_id: str | None = env_client_id
    elif raw_client_id:
        if not isinstance(raw_client_id, str) or not UUID.fullmatch(raw_client_id):
            raise BackupError("managed_identity_client_id must be a UUID")
        client_id = raw_client_id
    else:
        client_id = None

    env_res_id = (
        _clean_env(env.get("ARMBACKUP_MANAGED_IDENTITY_RESOURCE_ID", ""))
        or _clean_env(env.get("AZURE_CLIENT_RESOURCE_ID", ""))
    )
    if env_res_id:
        if not UAMI_RESOURCE_ID.fullmatch(env_res_id):
            raise BackupError(
                "ARMBACKUP_MANAGED_IDENTITY_RESOURCE_ID must be a Microsoft.ManagedIdentity/userAssignedIdentities resource ID"
            )
        resource_id: str | None = env_res_id
    elif raw_resource_id:
        if not isinstance(raw_resource_id, str) or not UAMI_RESOURCE_ID.fullmatch(raw_resource_id):
            raise BackupError(
                "managed_identity_resource_id must be a Microsoft.ManagedIdentity/userAssignedIdentities resource ID"
            )
        resource_id = raw_resource_id
    else:
        resource_id = None

    env_obj_id = (
        _clean_env(env.get("ARMBACKUP_MANAGED_IDENTITY_OBJECT_ID", ""))
        or _clean_env(env.get("AZURE_CLIENT_OBJECT_ID", ""))
    )
    if env_obj_id:
        if not UUID.fullmatch(env_obj_id):
            raise BackupError("ARMBACKUP_MANAGED_IDENTITY_OBJECT_ID must be a UUID")
        object_id: str | None = env_obj_id
    elif raw_object_id:
        if not isinstance(raw_object_id, str) or not UUID.fullmatch(raw_object_id):
            raise BackupError("managed_identity_object_id must be a UUID")
        object_id = raw_object_id
    else:
        object_id = None

    req_env = _clean_env(env.get("ARMBACKUP_REQUIRE_USER_ASSIGNED_IDENTITY", "")).lower()
    if req_env:
        if req_env not in {"true", "false"}:
            raise BackupError("ARMBACKUP_REQUIRE_USER_ASSIGNED_IDENTITY must be true or false")
        require_uami = req_env == "true"
    elif raw_require_user_assigned is not None:
        if not isinstance(raw_require_user_assigned, bool):
            raise BackupError("require_user_assigned_identity must be boolean")
        require_uami = raw_require_user_assigned
    else:
        require_uami = False

    return client_id, resource_id, object_id, require_uami


@dataclass(frozen=True)
class Config:
    subscriptions: tuple[str, ...]
    tables: tuple[str, ...]
    resource_groups: tuple[str, ...]
    exclude_types: tuple[str, ...]
    api_versions: dict[str, str]
    collections: dict[str, tuple[Collection, ...]]
    workers: int
    retries: int
    timeout: int
    allow_preview: bool
    credential: str
    client_id: str | None
    storage_url: str
    container: str
    prefix: str
    require_private_storage: bool
    logs_endpoint: str = ""
    logs_rule_id: str = ""
    logs_stream: str = ""
    workspace_id: str = ""
    dcr_id: str = ""
    logging_warning: str = ""
    identity_resource_id: str | None = None
    identity_object_id: str | None = None
    require_user_assigned_identity: bool = False

    @property
    def logging_enabled(self) -> bool:
        return bool(self.dcr_id)

    @classmethod
    def load(cls, path: Path, *, allow_degraded_logging: bool = False) -> Config:
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise BackupError(f"Unable to read valid configuration: {type(exc).__name__}") from exc
        data = object_value(raw, "config")
        keys(data, {"subscriptions", "discovery_tables", "resource_groups", "exclude_types",
                    "api_versions", "collections", "workers", "retries", "timeout_seconds",
                    "allow_preview", "credential", "managed_identity_client_id",
                    "managed_identity_resource_id", "managed_identity_object_id",
                    "require_user_assigned_identity", "storage", "logging"}, "config")
        subs = strings(data.get("subscriptions", []), "subscriptions")
        if any(not UUID.fullmatch(s) for s in subs):
            raise BackupError("subscriptions must be subscription UUIDs")
        tables = strings(data.get("discovery_tables", list(TABLES)), "discovery_tables")
        if not tables or any(t not in TABLES for t in tables):
            raise BackupError("Unsupported or empty discovery_tables")
        groups = strings(data.get("resource_groups", []), "resource_groups")
        exclusions = strings(data.get("exclude_types", []), "exclude_types")
        preview = data.get("allow_preview", False)
        if not isinstance(preview, bool):
            raise BackupError("allow_preview must be boolean")
        api = object_value(data.get("api_versions", {}), "api_versions")
        versions = {k.lower(): version(v, preview=preview) for k, v in api.items()}
        extras = object_value(data.get("collections", {}), "collections")
        collections: dict[str, tuple[Collection, ...]] = {}
        for resource_type, entries in extras.items():
            if not isinstance(entries, list):
                raise BackupError("collections values must be arrays")
            parsed = tuple(Collection.parse(e, preview) for e in entries)
            if len({c.name for c in parsed}) != len(parsed):
                raise BackupError("duplicate collection name")
            collections[resource_type.lower()] = parsed
        for field, default, low, high in [
            ("workers", 4, 1, 32), ("retries", 4, 0, 8), ("timeout_seconds", 60, 1, 300),
        ]:
            v = data.get(field, default)
            if type(v) is not int or not low <= v <= high:
                raise BackupError(f"{field} must be an integer in {low}..{high}")
        mode = data.get("credential", "managed_identity")
        if mode not in {"managed_identity", "cli"}:
            raise BackupError("credential must be managed_identity or cli")
        client_id, identity_res_id, identity_obj_id, require_uami = _parse_managed_identity(
            os.environ,
            raw_client_id=data.get("managed_identity_client_id"),
            raw_resource_id=data.get("managed_identity_resource_id"),
            raw_object_id=data.get("managed_identity_object_id"),
            raw_require_user_assigned=data.get("require_user_assigned_identity"),
        )
        storage = object_value(data.get("storage"), "storage")
        keys(storage, {"account_url", "container", "prefix", "require_private_endpoint"}, "storage")
        url = storage.get("account_url", "")
        if not isinstance(url, str) or not re.fullmatch(r"https://[a-z0-9]{3,24}\.blob\.core\.windows\.net", url):
            raise BackupError("storage.account_url must be a public-Azure Blob service URL without slash")
        container = storage.get("container", "")
        if not isinstance(container, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])", container) or "--" in container:
            raise BackupError("Invalid storage container name")
        prefix = storage.get("prefix", "armbackup")
        if not isinstance(prefix, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", prefix):
            raise BackupError("storage.prefix must be a single safe path segment")
        private = storage.get("require_private_endpoint", True)
        if not isinstance(private, bool):
            raise BackupError("require_private_endpoint must be boolean")
        env_log = {name: _clean_env(os.environ.get(name, "")) for name in LOG_ENV_KEYS}
        if any(env_log.values()):
            raw_log: object = {
                "workspace_resource_id": env_log["ARMBACKUP_LOG_WORKSPACE_ID"],
                "dcr_resource_id": env_log["ARMBACKUP_LOG_DCR_ID"],
                "endpoint": env_log["ARMBACKUP_LOG_ENDPOINT"],
                "rule_id": env_log["ARMBACKUP_LOG_RULE_ID"],
                "stream": env_log["ARMBACKUP_LOG_STREAM"] or "Custom-ArmBackup",
            }
        else:
            raw_log = data.get("logging")
        logging_warning = ""
        try:
            endpoint, rule, stream, workspace, dcr = _parse_logging(raw_log)
        except BackupError as exc:
            if not allow_degraded_logging:
                raise
            endpoint, rule, stream, workspace, dcr = "", "", "", "", ""
            logging_warning = str(exc)
        return cls(
            tuple(subs), tuple(tables), tuple(g.lower() for g in groups),
            tuple(t.lower() for t in exclusions), versions, collections,
            data.get("workers", 4), data.get("retries", 4), data.get("timeout_seconds", 60),
            preview, mode, client_id, url, container, prefix, private,
            endpoint, rule, stream, workspace, dcr, logging_warning,
            identity_res_id, identity_obj_id, require_uami,
        )

    @classmethod
    def from_environment(cls) -> Config:
        return cls.load(Path(os.environ.get("ARMBACKUP_CONFIG", "config.json")))
