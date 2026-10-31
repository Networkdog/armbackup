from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from armbackup.contracts import BackupError, JsonObject, object_value

UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
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
    logs_endpoint: str
    logs_rule_id: str
    logs_stream: str
    workspace_id: str
    dcr_id: str

    @classmethod
    def load(cls, path: Path) -> Config:
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise BackupError(f"Unable to read valid configuration: {type(exc).__name__}") from exc
        data = object_value(raw, "config")
        keys(data, {"subscriptions", "discovery_tables", "resource_groups", "exclude_types",
                    "api_versions", "collections", "workers", "retries", "timeout_seconds",
                    "allow_preview", "credential", "managed_identity_client_id",
                    "storage", "logging"}, "config")
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
        client_id = data.get("managed_identity_client_id") or None
        if client_id is not None and (not isinstance(client_id, str) or not UUID.fullmatch(client_id)):
            raise BackupError("managed_identity_client_id must be a UUID")
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
        log = object_value(data.get("logging"), "logging")
        keys(log, {"endpoint", "rule_id", "stream", "workspace_resource_id", "dcr_resource_id"}, "logging")
        endpoint = log.get("endpoint", "")
        if not isinstance(endpoint, str):
            raise BackupError("logging.endpoint must be a URL")
        parsed_url = urlsplit(endpoint)
        if (parsed_url.scheme != "https" or not parsed_url.hostname
                or not parsed_url.hostname.endswith(".ingest.monitor.azure.com")
                or parsed_url.username or parsed_url.password or parsed_url.port
                or parsed_url.path not in {"", "/"} or parsed_url.query or parsed_url.fragment):
            raise BackupError("logging.endpoint must be the Azure Monitor DCR/DCE ingestion endpoint")
        rule, stream = log.get("rule_id", ""), log.get("stream", "")
        if not isinstance(rule, str) or not re.fullmatch(r"dcr-[a-zA-Z0-9]+", rule):
            raise BackupError("logging.rule_id must be the DCR immutableId, not workspace ID")
        if not isinstance(stream, str) or not re.fullmatch(r"Custom-[A-Za-z0-9_]+", stream):
            raise BackupError("logging.stream must be a Custom- stream")
        workspace, dcr = log.get("workspace_resource_id"), log.get("dcr_resource_id")
        if not isinstance(workspace, str) or not isinstance(dcr, str):
            raise BackupError("logging workspace_resource_id and dcr_resource_id must be strings")
        for rid, namespace, label in [
            (workspace, "Microsoft.OperationalInsights/workspaces", "workspace_resource_id"),
            (dcr, "Microsoft.Insights/dataCollectionRules", "dcr_resource_id"),
        ]:
            if not isinstance(rid, str) or not re.fullmatch(
                r"/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[^/?#\\]+/providers/"
                + re.escape(namespace) + r"/[^/?#\\]+", rid, re.IGNORECASE,
            ):
                raise BackupError(f"logging.{label} must be a full Azure resource ID")
        return cls(
            tuple(subs), tuple(tables), tuple(g.lower() for g in groups),
            tuple(t.lower() for t in exclusions), versions, collections,
            data.get("workers", 4), data.get("retries", 4), data.get("timeout_seconds", 60),
            preview, mode, client_id, url, container, prefix, private,
            endpoint.rstrip("/"), rule, stream, workspace, dcr,
        )

    @classmethod
    def from_environment(cls) -> Config:
        return cls.load(Path(os.environ.get("ARMBACKUP_CONFIG", "config.json")))
