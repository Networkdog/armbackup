from __future__ import annotations

import json
import re
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from azure.core.credentials import TokenCredential
from azure.core.exceptions import AzureError

from armbackup.archive import BlobArchive
from armbackup.backup import Backup, new_run_id
from armbackup.change_history import history_detail, history_records
from armbackup.comparison import NETWORK_TYPES, TYPE_LABELS, compare, configuration
from armbackup.config import UUID, Config, keys
from armbackup.contracts import (
    Arm,
    ArmHttpError,
    BackupError,
    BrowseArchive,
    Events,
    JsonObject,
    credential,
    digest,
    encode_json,
    object_value,
    utc_now,
)
from armbackup.discovery import Resource, discover, management_groups
from armbackup.events import LogAnalyticsEvents, verify_log_destination
from armbackup.http import ArmClient
from armbackup.local_archive import LocalArchive
from armbackup.monitoring import LogsReader, activity_changes, resource_actor
from armbackup.resource_profiles import (
    AFD,
    AFD_ENDPOINT,
    AFD_ORIGIN_GROUP,
    AFD_RULESET,
    AGW,
    LB,
    PROFILE_APIS,
    SUPPORTED_TYPES,
    arm_identity,
    restore_body,
    snapshot_tags,
)
from armbackup.restore import apply_plan, build_plan, load_snapshot, target_type
from armbackup.state_view import StateRefresher, StateView

RUN_ID = re.compile(r"\d{8}T\d{6}Z-[a-f0-9]{12}")
IDENTIFIER = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


def json_document(raw: bytes, label: str) -> JsonObject:
    try:
        return object_value(json.loads(raw), label)
    except (ValueError, UnicodeError) as exc:
        raise BackupError(f"{label}: invalid JSON") from exc


@dataclass(frozen=True)
class ConsoleConfig:
    capture: Config
    workspace_name: str
    subscription_name: str
    lab_id: str
    workspace_guid: str
    restore_enabled: bool
    activity_days: int
    archive_mode: Literal["blob", "local"] = "blob"
    local_archive: Path | None = None
    inventory_scope: Literal["lab", "subscription"] = "lab"

    @classmethod
    def load(cls, path: Path) -> ConsoleConfig:
        data = json_document(path.read_bytes(), "console config")
        keys(data, {"capture_config", "workspace_name", "subscription_name", "lab_id",
                    "workspace_guid", "restore_enabled", "activity_days", "archive_mode",
                    "local_archive", "inventory_scope"}, "console config")
        capture_path = data.get("capture_config")
        if not isinstance(capture_path, str) or not capture_path:
            raise BackupError("console capture_config path is required")
        capture = Config.load(path.parent / capture_path)
        if len(capture.subscriptions) != 1 or len(capture.resource_groups) != 1:
            raise BackupError("Live lab console requires exactly one subscription and resource group")
        if not capture.resource_groups[0].startswith("rg-armbackup-"):
            raise BackupError("Live lab console refuses non-lab resource groups")
        if not NETWORK_TYPES <= capture.api_versions.keys():
            raise BackupError("LAB console requires explicit API versions for NSG, route table and VNet")
        for label in ("workspace_name", "subscription_name"):
            value = data.get(label)
            if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 100
                    or any(ord(char) < 32 or ord(char) == 127 for char in value)):
                raise BackupError(f"console {label} must be a non-empty label without control characters")
        lab_id = data.get("lab_id")
        if not isinstance(lab_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", lab_id):
            raise BackupError("console lab_id must be a safe ownership tag identifier")
        guid = data.get("workspace_guid")
        if not isinstance(guid, str) or not UUID.fullmatch(guid):
            raise BackupError("console workspace_guid must be the Log Analytics workspace GUID")
        enabled, days = data.get("restore_enabled", False), data.get("activity_days", 2)
        if not isinstance(enabled, bool) or type(days) is not int or not 1 <= days <= 7:
            raise BackupError("Invalid console restore_enabled or activity_days")
        archive_mode = data.get("archive_mode", "blob")
        if archive_mode not in {"blob", "local"}:
            raise BackupError("console archive_mode must explicitly be blob or local")
        local_path = data.get("local_archive")
        if archive_mode == "local" and (not isinstance(local_path, str) or not local_path):
            raise BackupError("Explicit local archive mode requires local_archive path")
        inventory_scope = data.get("inventory_scope", "lab")
        if inventory_scope not in {"lab", "subscription"}:
            raise BackupError("console inventory_scope must be lab or subscription")
        result = cls(capture, data["workspace_name"], data["subscription_name"],
                     data["lab_id"], guid, enabled, days, archive_mode,
                     (path.parent / local_path).resolve() if isinstance(local_path, str) else None,
                     inventory_scope)
        if any(not rid.lower().startswith(result.scope.lower() + "/providers/") for rid in
               (capture.workspace_id, capture.dcr_id)):
            raise BackupError("Lab logging resources must be inside the explicitly allowed resource group")
        return result

    @property
    def subscription(self) -> str:
        return self.capture.subscriptions[0]

    @property
    def group(self) -> str:
        return self.capture.resource_groups[0]

    @property
    def scope(self) -> str:
        return f"/subscriptions/{self.subscription}/resourceGroups/{self.group}"

    @property
    def read_scope(self) -> str:
        return f"/subscriptions/{self.subscription}" if self.inventory_scope == "subscription" else self.scope

    def read_resource(self, resource_id: str) -> Resource:
        if self.inventory_scope == "lab":
            return self.resource(resource_id)
        kind, _, _ = arm_identity(resource_id)
        if not resource_id.lower().startswith(self.read_scope.lower() + "/resourcegroups/"):
            raise BackupError("Resource is outside the configured subscription")
        if kind not in SUPPORTED_TYPES:
            raise BackupError("Resource has no reviewed capture profile")
        return Resource(resource_id, kind, self.subscription, resource_id.split("/")[4].lower())

    def resource(self, resource_id: str) -> Resource:
        if not isinstance(resource_id, str):
            raise BackupError("A full resource ID is required")
        if not resource_id.lower().startswith(self.scope.lower() + "/providers/"):
            raise BackupError("Resource is outside the allowed lab RG or supported network types")
        kind, _, _ = arm_identity(resource_id)
        if kind not in SUPPORTED_TYPES:
            raise BackupError("Resource is outside the reviewed LAB resource profiles")
        return Resource(resource_id, kind, self.subscription, self.group)

    def api_version(self, resource_type: str) -> str:
        if resource_type not in PROFILE_APIS:
            raise BackupError("No reviewed API version for this resource profile")
        return self.capture.api_versions.get(resource_type, PROFILE_APIS[resource_type])


class ScopedEvents:
    def __init__(self, events: Events, scope: str, correlation_id: str, ticket: str = "") -> None:
        self.events, self.scope = events, scope
        self.correlation_id, self.ticket = correlation_id, ticket

    def emit(
        self, event: str, *, level: str = "Information", resource_id: str = "",
        status: str = "", code: str = "", **metrics: int | float | str,
    ) -> None:
        self.events.emit(event, level=level, resource_id=resource_id, status=status, code=code,
                         **{**metrics, "scope": self.scope,
                            "correlationId": self.correlation_id, "ticket": self.ticket})

    def flush(self) -> None:
        self.events.flush()


class LiveConsole:
    def __init__(
        self, config: ConsoleConfig, arm: Arm, archive: BrowseArchive,
        events_factory: Callable[[str], Events], logs_reader: LogsReader,
    ) -> None:
        self.config, self.arm, self.archive = config, arm, archive
        self.events_factory, self.logs_reader = events_factory, logs_reader
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="armbackup-operation")
        self.jobs: dict[str, JsonObject] = {}
        self.futures: dict[str, Future[None]] = {}
        self.jobs_lock = threading.Lock()
        self.views = StateRefresher(self.state_view, self.state)

    @classmethod
    def connect(cls, config: ConsoleConfig) -> LiveConsole:
        auth: TokenCredential = credential(config.capture.credential, config.capture.client_id)
        arm = ArmClient(auth, retries=config.capture.retries, timeout=config.capture.timeout)
        archive: BrowseArchive
        if config.archive_mode == "local":
            if config.local_archive is None:
                raise BackupError("Local archive path is missing")
            archive = LocalArchive(config.local_archive)
        else:
            archive = BlobArchive(config.capture, auth)
        verify_log_destination(config.capture, arm)
        result = cls(config, arm, archive,
                     lambda run_id: LogAnalyticsEvents(config.capture, auth, run_id),
                     LogsReader(auth, config.workspace_guid, config.scope))
        result.guard_scope()
        if config.archive_mode == "blob":
            account = config.capture.storage_url.split("//", 1)[1].split(".", 1)[0]
            storage = arm.request("GET", config.scope +
                                  f"/providers/Microsoft.Storage/storageAccounts/{account}", "2023-05-01")
            if storage.get("tags", {}).get("armbackupLab") != config.lab_id:
                result.close()
                raise BackupError("Backup storage does not belong to the approved lab")
        workspace = arm.request("GET", config.capture.workspace_id, "2023-09-01")
        if workspace.get("properties", {}).get("customerId") != config.workspace_guid:
            result.close()
            raise BackupError("Workspace query GUID differs from the designated ingestion workspace")
        return result

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=False)
        self.views.close()

    def guard_scope(self) -> JsonObject:
        group = self.arm.request("GET", self.config.scope, "2021-04-01")
        if group.get("tags", {}).get("armbackupLab") != self.config.lab_id:
            raise BackupError("Lab ownership tag is missing or changed; no operation is allowed")
        if group.get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
            raise BackupError("Resource group is not in a stable state; no operation is allowed")
        return group

    def troubleshoot(self, resource_id: str) -> JsonObject:
        resource = self.config.resource(resource_id)
        if resource.type != AGW or not isinstance(self.arm, ArmClient):
            raise BackupError("Backend health diagnostics are available only for connected LAB Application Gateways")
        self.guard_scope()
        observed = self.observe(resource, self.config.api_version(AGW))
        self.assert_restorable(observed, may_be_missing=False)
        health = self.arm.request_operation(
            "POST", resource.id + "/backendhealth", self.config.api_version(AGW), {}, max_polls=12,
        )
        if not isinstance(health.get("backendAddressPools"), list):
            raise BackupError("Gateway backend health did not return its expected result")
        logs: JsonObject
        try:
            logs = self.logs_reader.gateway(resource.id)
        except BackupError as exc:
            logs = {"source": "log-analytics", "error": str(exc), "status": "Unconfirmed"}
        return {"resourceId": resource.id, "source": "ARM backendhealth", "observedAt": utc_now(),
                "health": health, "logs": logs, "dataPlaneRecoveryGuaranteed": False}

    def inventory(self) -> list[JsonObject]:
        self.guard_scope()
        result = []
        limit = 5000 if self.config.inventory_scope == "subscription" else 500
        for index, raw in enumerate(self.arm.pages(self.config.read_scope + "/resources", "2021-04-01")):
            if index >= limit:
                raise BackupError(f"Inventory exceeds {limit} resources; narrow the configured scope")
            tags = object_value(raw.get("tags", {}), "inventory tags")
            if self.config.inventory_scope == "lab" and tags.get("armbackupWorkload") != "true":
                continue
            if str(raw.get("type", "")).lower() not in SUPPORTED_TYPES:
                continue
            resource = self.config.read_resource(raw.get("id", ""))
            if self.config.inventory_scope == "lab" and tags.get("armbackupLab") != self.config.lab_id:
                raise BackupError("A selected workload has an unexpected lab ownership tag")
            if resource.type != str(raw.get("type", "")).lower():
                raise BackupError("Resource ID and reported type differ")
            result.append(raw)
        roots = [raw for raw in result if str(raw["type"]).lower() == AFD]
        seen = {str(raw["id"]).lower() for raw in result}

        def children(parent: JsonObject, collection: str, api: str) -> list[JsonObject]:
            try:
                return list(self.arm.pages(parent["id"] + "/" + collection, api))
            except ArmHttpError as exc:
                if exc.status != 404:
                    raise
                observed = self.observe(self.config.read_resource(parent["id"]), api,
                                        require_ownership=self.config.inventory_scope == "lab")
                if observed["status"] != "missing":
                    raise
                prefix = parent["id"].lower()
                result[:] = [raw for raw in result if not (
                    raw["id"].lower() == prefix or raw["id"].lower().startswith(prefix + "/"))]
                seen.difference_update({identifier for identifier in seen
                                        if identifier == prefix or identifier.startswith(prefix + "/")})
                return []

        for parent in [raw for raw in result if str(raw["type"]).lower() == LB]:
            for child in children(parent, "backendAddressPools", self.config.api_version(LB)):
                self.config.read_resource(child.get("id", ""))
                child = {**child, "tags": parent.get("tags", {}), "ownershipParent": parent["id"]}
                if child["id"].lower() not in seen:
                    result.append(child)
                    seen.add(child["id"].lower())
        for profile in roots:
            for collection in ("afdEndpoints", "originGroups", "ruleSets", "securityPolicies"):
                if profile["id"].lower() not in seen:
                    break
                for child in children(profile, collection, self.config.api_version(AFD)):
                    self.config.read_resource(child.get("id", ""))
                    child = {**child, "tags": profile.get("tags", {}), "ownershipParent": profile["id"]}
                    if child["id"].lower() not in seen:
                        result.append(child)
                        seen.add(child["id"].lower())
                    kind = str(child["type"]).lower()
                    subcollection = {AFD_ENDPOINT: "routes", AFD_ORIGIN_GROUP: "origins", AFD_RULESET: "rules"}.get(kind)
                    if subcollection:
                        for nested in children(child, subcollection, self.config.api_version(AFD)):
                            self.config.read_resource(nested.get("id", ""))
                            nested = {**nested, "tags": profile.get("tags", {}), "ownershipParent": profile["id"]}
                            if nested["id"].lower() not in seen:
                                result.append(nested)
                                seen.add(nested["id"].lower())
        if len(result) > limit:
            raise BackupError(f"Expanded inventory exceeds {limit} resources")
        return sorted(result, key=lambda raw: str(raw["id"]).lower())

    def observe(self, resource: Resource, api: str, *, require_ownership: bool = True) -> JsonObject:
        try:
            raw = self.arm.request("GET", resource.id, api)
        except ArmHttpError as exc:
            if exc.status == 404 and exc.code in {"ResourceNotFound", "NotFound", "ParentResourceNotFound"}:
                self.guard_scope()
                return {"status": "missing", "confirmed": True, "observedAt": utc_now(),
                        "apiVersion": api}
            return {"status": "error", "code": str(exc), "observedAt": utc_now(),
                    "apiVersion": api}
        except BackupError as exc:
            return {"status": "error", "code": str(exc), "observedAt": utc_now(),
                    "apiVersion": api}
        ownership_tags = raw.get("tags", {})
        if resource.type.startswith((AFD + "/", LB + "/")):
            pattern = (r".+/providers/Microsoft\.Cdn/profiles/[^/]+" if resource.type.startswith(AFD)
                       else r".+/providers/Microsoft\.Network/loadBalancers/[^/]+")
            root = re.match(pattern, resource.id, re.IGNORECASE)
            if root is None:
                raise BackupError("Owned resource parent could not be identified")
            parent_kind = AFD if resource.type.startswith(AFD) else LB
            try:
                parent = self.arm.request("GET", root[0], self.config.api_version(parent_kind))
            except (ArmHttpError, BackupError) as exc:
                return {"status": "error", "code": "OwnershipParentUnconfirmed: " + str(exc),
                        "observedAt": utc_now(), "apiVersion": api}
            ownership_tags = parent.get("tags", {})
        if require_ownership and ownership_tags.get("armbackupLab") != self.config.lab_id:
            return {"status": "error", "code": "LabOwnershipChanged", "observedAt": utc_now(),
                    "apiVersion": api}
        return {"status": "present", "raw": raw, "observedAt": utc_now(), "apiVersion": api,
                "metadataTags": ownership_tags,
                "provisioningState": raw.get("properties", {}).get("provisioningState"),
                "fingerprint": digest(encode_json(raw))}

    def read_policy(self) -> JsonObject:
        record = self.policy_record()
        if record is None:
            return self.validate_policy({
                "scopeIds": [self.config.read_scope], "types": sorted(NETWORK_TYPES), "tags": [],
            })
        return self.validate_policy(record["policy"])

    def policy_record(self) -> JsonObject | None:
        names = self.archive.names("console/policies")
        records = [json_document(self.archive.get(name), "stored policy") for name in names]
        if any(type(record.get("revision", 0)) is not int for record in records):
            raise BackupError("Stored policy revision is invalid")
        return max(records, key=lambda record: (record.get("revision", 0), record.get("savedAt", ""))) if records else None

    def validate_policy(self, raw: object) -> JsonObject:
        policy = object_value(raw, "target policy")
        keys(policy, {"scopeIds", "types", "tags"}, "target policy")
        scopes, types, tags = policy.get("scopeIds"), policy.get("types"), policy.get("tags")
        if (not isinstance(scopes, list) or not scopes or len(scopes) > 500
                or not all(isinstance(scope, str) for scope in scopes)
                or not isinstance(types, list) or not types or len(types) > len(SUPPORTED_TYPES)
                or not all(isinstance(kind, str) and kind.lower() in SUPPORTED_TYPES for kind in types)
                or not isinstance(tags, list) or len(tags) > 10):
            raise BackupError("Select valid resource scopes and at least one supported type")
        resolved = []
        groups: set[str] | None = None
        subscription = f"/subscriptions/{self.config.subscription}"
        for scope in scopes:
            if scope.lower().startswith("/providers/microsoft.management/managementgroups/"):
                if groups is None:
                    groups = {item["id"].lower() for item in management_groups(self.arm, self.config.subscription)}
                if scope.lower() not in groups:
                    raise BackupError("Management group is outside the configured subscription ancestry")
                scope = self.config.read_scope
            if scope in {"subscription", "resource-group"} or scope.lower() == subscription.lower():
                scope = (self.config.read_scope if scope != "resource-group" else self.config.scope)
            if self.config.inventory_scope == "lab" and scope.lower() == self.config.scope.lower():
                scope = "resource-group"
            elif scope.lower() == self.config.read_scope.lower():
                pass
            elif (self.config.inventory_scope == "subscription"
                  and re.fullmatch(re.escape(subscription) + r"/resourceGroups/[^/?%#\\]+",
                                   scope, re.IGNORECASE)):
                pass
            else:
                self.config.read_resource(scope)
            resolved.append(scope)
        for tag in tags:
            tag = object_value(tag, "tag condition")
            keys(tag, {"key", "operator", "value"}, "tag condition")
            if (not isinstance(tag.get("key"), str) or not 1 <= len(tag["key"].strip()) <= 128
                    or tag.get("operator") not in {"equals", "exists"}
                    or not isinstance(tag.get("value", ""), str)
                    or len(tag.get("value", "")) > 256
                    or (tag["operator"] == "equals" and not tag.get("value"))):
                raise BackupError("Invalid tag condition")
        return {"scopeIds": list(dict.fromkeys(resolved)),
                "types": sorted({kind.lower() for kind in types}), "tags": tags}

    @staticmethod
    def selected(raw: JsonObject, policy: JsonObject) -> bool:
        rid, kind = str(raw["id"]).lower(), str(raw["type"]).lower()
        contained = kind.startswith((AFD + "/", LB + "/"))
        scopes = {scope.lower() for scope in policy["scopeIds"]}
        containers = {scope for scope in scopes if re.fullmatch(
            r"/subscriptions/[^/]+(?:/resourcegroups/[^/]+)?", scope)}
        if ("resource-group" not in scopes and rid not in scopes
                and not any(rid.startswith(scope + "/") for scope in containers)
                and not (contained and any(rid.startswith(scope + "/") for scope in scopes))):
            return False
        if kind not in policy["types"] and not (contained and any(
                kind.startswith(parent + "/") for parent in policy["types"] if parent in {AFD, LB})):
            return False
        tags = {name.lower(): value for name, value in raw.get("tags", {}).items()}
        return all(tag["key"].lower() in tags and (
            tag["operator"] == "exists" or tags[tag["key"].lower()] == tag["value"]
        ) for tag in policy["tags"])

    def read_run(self, run_id: str, names: set[str] | None = None) -> JsonObject:
        if not RUN_ID.fullmatch(run_id):
            raise BackupError("Invalid backup run ID")
        root = f"runs/{run_id}"
        manifest_raw = self.archive.get(root + "/manifest.json")
        manifest = json_document(manifest_raw, "manifest")
        complete_name = root + "/COMPLETE.json"
        if names is None:
            names = set(self.archive.names(root))
        complete = (json_document(self.archive.get(complete_name), "completion marker")
                    if complete_name in names else {})
        verified = (manifest.get("status") == "Captured" and complete.get("runId") == run_id
                    and complete.get("manifestSha256") == digest(manifest_raw))
        if manifest.get("runId") != run_id or manifest.get("schemaVersion") != 1:
            raise BackupError("Manifest schema or run ID mismatch")
        envelopes = []
        for entry in manifest.get("resources", []):
            entry = object_value(entry, "manifest resource")
            if entry.get("status") != "Captured":
                continue
            resource = self.config.read_resource(entry.get("id", ""))
            expected = root + f"/resources/{digest(resource.id.lower().encode())}.json"
            if entry.get("blob") != expected:
                raise BackupError("Snapshot archive path mismatch")
            payload = self.archive.get(expected)
            if digest(payload) != entry.get("sha256"):
                raise BackupError("Snapshot hash mismatch")
            envelope = json_document(payload, "snapshot")
            if (str(envelope.get("resourceId", "")).lower() != resource.id.lower()
                    or envelope.get("resourceType") != resource.type):
                raise BackupError("Snapshot resource identity mismatch")
            envelopes.append(envelope)
        return {"manifest": manifest, "envelopes": envelopes, "verified": verified}

    def state(self) -> JsonObject:
        started = utc_now()
        inventory = self.inventory()
        names = set(self.archive.names("runs", limit=10000))
        run_ids = sorted({name.split("/")[1] for name in names
                          if re.fullmatch(r"runs/\d{8}T\d{6}Z-[a-f0-9]{12}/manifest\.json", name)},
                         reverse=True)
        runs: list[JsonObject] = []
        warnings: list[str] = []
        resources = {str(raw["id"]).lower(): raw for raw in inventory}
        for run_id in run_ids[:30]:
            try:
                run = self.read_run(run_id, names)
            except BackupError as exc:
                warnings.append(f"Backup {run_id}: {exc}")
                runs.append({"manifest": {"runId": run_id, "status": "IntegrityError"},
                             "envelopes": [], "verified": False, "error": str(exc)})
                continue
            runs.append(run)
            for envelope in run["envelopes"]:
                raw = {**envelope["raw"], "tags": snapshot_tags(envelope)}
                resources.setdefault(str(envelope["resourceId"]).lower(), raw)
        observations: dict[str, JsonObject] = {}
        def observe_resource(item: tuple[str, JsonObject]) -> tuple[str, JsonObject]:
            rid, raw = item
            resource = self.config.read_resource(raw["id"])
            api = self.config.api_version(resource.type)
            return rid, self.observe(resource, api, require_ownership=self.config.inventory_scope == "lab")

        with ThreadPoolExecutor(max_workers=self.config.capture.workers) as pool:
            observations.update(pool.map(observe_resource, resources.items()))
        activity_status = "Available"
        activity_groups = ({self.config.read_resource(raw["id"]).group for raw in resources.values()}
                           if self.config.inventory_scope == "subscription" else {self.config.group})

        def group_activity(group: str) -> tuple[dict[str, JsonObject], str]:
            try:
                return activity_changes(self.arm, self.config.subscription, group,
                                        days=self.config.activity_days), ""
            except BackupError as exc:
                return {}, f"Activity Log ({group}): {exc}"

        with ThreadPoolExecutor(max_workers=self.config.capture.workers) as pool:
            activity = list(pool.map(group_activity, sorted(activity_groups)))
        actors = {}
        for records, error in activity:
            actors.update(records)
            if error:
                warnings.append(error)
        failed_groups = sum(bool(error) for _, error in activity)
        if failed_groups:
            activity_status = "Unavailable" if failed_groups == len(activity) else "Partial"
        dto_runs: list[JsonObject] = []
        label_names = set(self.archive.names("console/labels"))
        for run in runs:
            manifest = run["manifest"]
            label = manifest.get("label", "")
            label_name = f"console/labels/{manifest['runId']}.json"
            if label_name in label_names:
                label = json_document(self.archive.get(label_name), "backup label").get("label", "")
                if not isinstance(label, str) or len(label) > 120:
                    raise BackupError("Stored backup label is invalid")
            snapshots = []
            for envelope in run["envelopes"]:
                rid, kind = str(envelope["resourceId"]).lower(), str(envelope["resourceType"])
                result = compare(envelope, observations[rid], kind, complete=run["verified"])
                try:
                    body = configuration(envelope["raw"], kind)
                except BackupError:
                    body = {}
                blocked_reason = ""
                try:
                    restore_body(envelope["raw"], kind)
                    self.config.resource(envelope["resourceId"])
                    if (snapshot_tags(envelope).get("armbackupLab") != self.config.lab_id
                            or snapshot_tags(envelope).get("armbackupWorkload") != "true"):
                        raise BackupError("Restore requires an explicitly marked LAB workload")
                except BackupError as exc:
                    blocked_reason = str(exc)
                snapshots.append({
                    "resourceId": envelope["resourceId"], "apiVersion": envelope["captureApiVersion"],
                    "complete": run["verified"], "capturedAt": envelope["capturedAt"],
                    "raw": body, "comparison": result, "restoreSupported": not blocked_reason,
                    "blockedReason": blocked_reason,
                })
            dto_runs.append({
                "id": manifest["runId"], "kind": manifest.get("kind", "manual"),
                "capturedAt": manifest.get("finishedAt", manifest.get("startedAt", "")),
                "status": "Captured" if run["verified"] else manifest.get("status", "Incomplete")
                if manifest.get("status") != "Captured" else "Unverified",
                "snapshots": snapshots, "absences": manifest.get("absences", []),
                "label": label, "error": run.get("error", ""),
                "inventorySource": manifest.get("inventorySource", ""),
                "selection": manifest.get("selection"),
                "resourceAttempts": [
                    {"resourceId": entry["id"], "status": entry["status"]}
                    for entry in manifest.get("resources", []) if isinstance(entry.get("id"), str)
                ] + [
                    {"resourceId": entry["id"], "status": "Failed"}
                    for entry in manifest.get("captureFailures", []) if isinstance(entry.get("id"), str)
                ],
            })
        dto_current: JsonObject = {}
        for rid, observed in observations.items():
            kind = self.config.read_resource(resources[rid]["id"]).type
            observed_raw = observed.get("raw")
            current_body: JsonObject | None = None
            if observed_raw is not None:
                try:
                    current_body = configuration(observed_raw, kind)
                except BackupError as exc:
                    warnings.append(f"{resources[rid]['name']}: {exc}")
                if current_body is not None:
                    current_body = {**current_body, "id": observed_raw["id"], "name": observed_raw["name"], "type": observed_raw["type"]}
            dto_current[rid] = {key: value for key, value in observed.items()
                                if key not in {"raw", "fingerprint"}}
            dto_current[rid].update({"raw": current_body, "actor": resource_actor(actors, rid, kind)})
        journal_names = self.archive.names("console/jobs", limit=1000)
        finished = [json_document(self.archive.get(name), "operation journal")
                    for name in journal_names if name.endswith("/finished.json")]
        finished_ids = {entry["id"] for entry in finished}
        with self.jobs_lock:
            active_ids = [identifier for identifier, future in self.futures.items() if not future.done()]
        unresolved = [
            {**entry, "status": "Unconfirmed",
             "warning": "No durable terminal record in this archive. The operation may run in another session or have stopped; inspect current Azure state.",
             "writeAttempted": None}
            for name in journal_names if name.endswith("/requested.json")
            for entry in [json_document(self.archive.get(name), "operation request")]
            if entry["id"] not in finished_ids and entry["id"] not in active_ids
        ]
        journal = sorted(finished + unresolved,
                         key=lambda entry: str(entry.get("finishedAt", entry.get("startedAt", ""))),
                         reverse=True)[:30]
        latest_sources: dict[str, JsonObject] = {}
        for run in dto_runs:
            if run["kind"] == "safety" or run["status"] != "Captured":
                continue
            for snapshot in run["snapshots"]:
                key = str(snapshot["resourceId"]).lower()
                if key not in latest_sources:
                    latest_sources[key] = {**snapshot, "sourceRunId": run["id"],
                                           "sourceLabel": run["label"], "sourceKind": run["kind"]}
        latest_view: JsonObject = {
            "id": "latest", "kind": "latest", "label": "리소스별 최신 검증된 일반 백업",
            "capturedAt": "", "status": "VerifiedSources", "absences": [],
            "snapshots": list(latest_sources.values()), "viewOnly": True,
            "sourceTimesVary": True,
        }
        scopes = self.scope_tree(warnings)
        known_scopes = {scope["id"] for scope in scopes}
        for raw in resources.values():
            group_id = "/".join(str(raw["id"]).split("/")[:5])
            if group_id.lower() not in known_scopes:
                scopes.append({"id": group_id.lower(), "kind": "resourceGroup",
                               "name": group_id.rsplit("/", 1)[1], "detail": "Historical backup scope",
                               "parentId": f"/subscriptions/{self.config.subscription}".lower()})
                known_scopes.add(group_id.lower())
        return {
            "schemaVersion": 1, "mode": "live-lab", "observedAt": utc_now(), "startedAt": started,
            "workspace": self.public_context(), "policy": self.read_policy(),
            "scopes": scopes,
            "resources": [
                {"id": raw["id"], "name": raw["name"], "type": str(raw["type"]).lower(),
                 "typeLabel": TYPE_LABELS[str(raw["type"]).lower()],
                 "groupId": "/".join(str(raw["id"]).split("/")[:5]).lower(),
                 "location": raw.get("location", ""), "tags": raw.get("tags", {}),
                 "apiVersion": self.config.api_version(str(raw["type"]).lower())}
                for raw in resources.values()
            ],
            "runs": dto_runs, "current": dto_current, "warnings": warnings, "journal": journal,
            "latestView": latest_view,
            "activeOperations": [self.job(identifier) for identifier in active_ids],
            "activityStatus": activity_status, "totalRuns": len(run_ids),
            "historyLimited": len(run_ids) > 30, "logSource": "Log Analytics",
        }

    def scope_tree(self, warnings: list[str]) -> list[JsonObject]:
        try:
            scopes = management_groups(self.arm, self.config.subscription)
        except BackupError as exc:
            scopes = []
            warnings.append(f"Management Group: {exc}")
        subscription = f"/subscriptions/{self.config.subscription}".lower()
        parent = scopes[-1]["id"] if scopes else None
        scopes.append({"id": subscription, "kind": "subscription",
                       "name": self.config.subscription_name, "detail": self.config.subscription,
                       "subscriptionId": self.config.subscription, "parentId": parent})
        groups = (self.arm.pages(subscription + "/resourcegroups", "2021-04-01")
                  if self.config.inventory_scope == "subscription" else [self.guard_scope()])
        for group in groups:
            identifier = str(group.get("id", "")).lower()
            if not re.fullmatch(re.escape(subscription) + r"/resourcegroups/[^/?%#\\]+", identifier):
                raise BackupError("Resource group inventory is outside the configured subscription")
            scopes.append({"id": identifier, "kind": "resourceGroup", "parentId": subscription,
                           "name": group.get("name") or group["id"].rsplit("/", 1)[1],
                           "detail": group["id"]})
        return scopes

    def state_view(self) -> StateView:
        identity = digest(encode_json({
            "schema": 4, "labId": self.config.lab_id, "scope": self.config.scope,
            "inventoryScope": self.config.read_scope,
            "workspace": self.config.workspace_guid, "restore": self.config.restore_enabled,
            "apiVersions": self.config.capture.api_versions, "archiveMode": self.config.archive_mode,
            "activityDays": self.config.activity_days,
            "credential": self.config.capture.credential, "clientId": self.config.capture.client_id,
            "excludeTypes": self.config.capture.exclude_types,
            "collections": {kind: [vars(item) for item in entries]
                            for kind, entries in self.config.capture.collections.items()},
        }))
        return StateView(self.archive, self.config.scope, identity)

    def initial_state(self, *, fresh: bool = False) -> JsonObject:
        if fresh:
            return self.views.wait(self.views.request(force=True))
        cached = self.state_view().read()
        identifier = self.views.request()
        refresh = self.views.status(identifier, include_state=False)
        if cached is None:
            return {"mode": "live-lab", "statePending": True,
                    "workspace": self.public_context(), "viewRefresh": refresh}
        return {**cached, "viewRefresh": refresh}

    def refresh_state(self, *, force: bool = False) -> JsonObject:
        return self.views.status(self.views.request(force=force))

    def public_context(self) -> JsonObject:
        return {
            "name": self.config.workspace_name, "subscription": self.config.subscription,
            "subscriptionName": self.config.subscription_name, "resourceGroup": self.config.group,
            "scope": self.config.scope, "restoreEnabled": self.config.restore_enabled,
            "inventoryScope": self.config.inventory_scope, "readScope": self.config.read_scope,
            "activityDays": self.config.activity_days,
            "restoreTypes": sorted(SUPPORTED_TYPES),
            "storage": self.config.capture.storage_url, "container": self.config.capture.container,
            "archiveMode": self.config.archive_mode,
            "archiveLabel": "Azure Blob" if self.config.archive_mode == "blob" else "로컬 검증 디스크",
            "privateStorageRequired": self.config.capture.require_private_storage,
            "workspaceResourceId": self.config.capture.workspace_id,
            "limitations": [
                "Subscription capture is opt-in; restore/clone remain restricted to owned LAB workloads",
                "NSG/route-table configuration only; attachments and data plane are not restored",
                "Client rechecks and Blob lease do not lock Portal/other writers",
                "Local lab archive mode is explicit; it does not prove private Blob access",
            ],
        }

    def change_history(self) -> JsonObject:
        self.guard_scope()
        names = set(self.archive.names("runs", limit=10000))
        identifiers = sorted({name.split("/")[1] for name in names
                              if re.fullmatch(r"runs/\d{8}T\d{6}Z-[a-f0-9]{12}/manifest\.json", name)})
        runs: list[JsonObject] = []
        for run_id in identifiers[-500:]:
            try:
                manifest = json_document(self.archive.get(f"runs/{run_id}/manifest.json"), "history manifest")
                if manifest.get("kind") == "safety":
                    continue
                runs.append(self.read_run(run_id, names))
            except BackupError as exc:
                at = datetime.strptime(run_id[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).isoformat()
                runs.append({"manifest": {"runId": run_id, "startedAt": at},
                             "verified": False, "envelopes": [], "error": str(exc)})
        result = history_records(runs)
        return {**result, "generatedAt": utc_now(), "source": self.public_context()["archiveLabel"],
                "totalRuns": len(identifiers), "historyLimited": len(identifiers) > 500,
                "runLimit": 500, "mode": "live-lab"}

    def change_detail(self, before_run: str, after_run: str, resource_id: str) -> JsonObject:
        self.guard_scope()
        self.config.read_resource(resource_id)
        before = self.read_run(before_run) if before_run else None
        after = self.read_run(after_run)
        return history_detail(before, after, resource_id)

    def bundle_graph(self, run_id: str) -> JsonObject:
        from armbackup.bundle_console import BundleConsole

        return BundleConsole(self).graph(run_id)

    def bundle_inventory(self) -> JsonObject:
        from armbackup.bundle_console import BundleConsole

        graph = BundleConsole(self).inventory_graph()
        for node in graph["nodes"]:
            node.pop("body", None)
        return graph

    def bundle_review(self, payload: JsonObject) -> JsonObject:
        from armbackup.bundle_console import BundleConsole

        return BundleConsole(self).prepare(payload)

    def bundle_backup(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        from armbackup.bundle_console import BundleConsole

        return BundleConsole(self).backup(job, payload)

    def bundle_restore(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        from armbackup.bundle_console import BundleConsole

        return BundleConsole(self).restore(job, payload)

    def events(self, run_id: str, correlation_id: str, ticket: str = "") -> ScopedEvents:
        return ScopedEvents(self.events_factory(run_id), self.config.scope, correlation_id, ticket)

    def backup(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"label"}, "backup request")
        policy = self.read_policy()
        inventory = self.inventory()
        selected = [self.config.read_resource(raw["id"]) for raw in inventory if self.selected(raw, policy)]
        if not selected:
            raise BackupError("No current workloads match the saved target policy; no empty backup was created")
        job["backupResourceIds"] = [resource.id for resource in selected]
        label = payload.get("label", "")
        if not isinstance(label, str) or len(label) > 120:
            raise BackupError("Backup label must be at most 120 characters")
        run_id = new_run_id()
        events = self.events(run_id, job["id"])
        job.update({"phase": "discovery", "runId": run_id})
        discovery_config = replace(self.config.capture, resource_groups=(
            () if self.config.inventory_scope == "subscription" else self.config.capture.resource_groups))
        arg, failures = discover(self.arm, discovery_config, [self.config.subscription], events)
        if failures:
            events.flush()
            raise BackupError("ARG discovery failed; inspect the operation log before retrying")
        rest_ids, arg_ids = {r.id.lower() for r in selected}, {r.id.lower() for r in arg}
        selection = {**policy, "argCount": len(arg), "restSelectedCount": len(selected),
                     "argLagResourceIds": sorted(rest_ids - arg_ids), "scope": self.config.read_scope}
        job["phase"] = "capturing"
        capture_config = replace(self.config.capture,
                                 resource_groups=tuple(sorted({resource.group.lower() for resource in selected})),
                                 api_versions={**PROFILE_APIS, **self.config.capture.api_versions})
        manifest = Backup(capture_config, self.arm, self.archive, events).run(
            run_id, inventory=selected, inventory_source="ARM allowed-scope list reconciled with ARG",
            selection=selection,
            resource_metadata={str(raw["id"]).lower(): {"tags": raw.get("tags", {}),
                                                      "ownershipParent": raw.get("ownershipParent", "")}
                               for raw in inventory if self.selected(raw, policy)},
        )
        self.archive.put(f"console/labels/{run_id}.json", encode_json({"label": label}))
        if manifest["status"] != "Captured":
            raise BackupError("Backup is incomplete; no verified completion marker was produced")
        return {"runId": run_id, "status": "Captured", "capturedCount": manifest["capturedCount"],
                "argLagCount": len(selection["argLagResourceIds"]), "label": label}

    def save_policy(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"policy"}, "policy request")
        policy = self.validate_policy(payload.get("policy"))
        with self.archive.guard("capture"):
            self.guard_scope()
            previous = self.policy_record()
            revision = (previous.get("revision", 0) if previous else 0) + 1
            events = self.events(job["id"], job["id"])
            events.emit("console_policy_saved", status="Succeeded",
                        resource_id=self.config.scope, policySha256=digest(encode_json(policy)))
            events.flush()
            self.archive.put(f"console/policies/{new_run_id()}.json",
                             encode_json({"policy": policy, "revision": revision,
                                          "savedAt": utc_now(), "operationId": job["id"]}))
        return {"status": "Succeeded", "policy": policy}

    def assert_restorable(self, observed: JsonObject, *, may_be_missing: bool = True) -> None:
        status = observed.get("status")
        if status == "missing" and observed.get("confirmed") is True and may_be_missing:
            return
        if status != "present":
            raise BackupError("Current state is unconfirmed; restore is blocked")
        raw = object_value(observed.get("raw"), "current resource")
        if raw.get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
            raise BackupError("Resource is still provisioning; wait and regenerate the plan")
        if raw.get("tags", {}).get("armbackupWorkload") != "true":
            raise BackupError("Restore is restricted to explicitly marked lab workloads")
        if any(raw.get("properties", {}).get(field) for field in ("networkInterfaces", "subnets", "flowLogs")):
            raise BackupError("Attached resources are not eligible for isolated lab restore")

    def prepare(self, payload: JsonObject) -> JsonObject:
        if not self.config.restore_enabled:
            raise BackupError("Restore is disabled in this console configuration")
        self.guard_scope()
        keys(payload, {"resourceId", "runId", "mode", "targetName", "ticket", "reason"}, "restore review")
        source = self.config.resource(payload.get("resourceId", ""))
        target_type(source.id)
        run_id, mode = payload.get("runId"), payload.get("mode")
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id) or mode not in {"create", "update"}:
            raise BackupError("Select a verified backup and an explicit create/update mode")
        for field, low, high in (("ticket", 3, 80), ("reason", 5, 500)):
            value = payload.get(field)
            if not isinstance(value, str) or not low <= len(value.strip()) <= high:
                raise BackupError(f"Restore {field} is required ({low}..{high} characters)")
        target_name = payload.get("targetName", "")
        if mode == "create":
            if not isinstance(target_name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}", target_name):
                raise BackupError("New target name must be 1..63 safe characters")
            target_id = source.id.rsplit("/", 1)[0] + "/" + target_name
        else:
            target_id = source.id
        target = self.config.resource(target_id)
        snapshot = load_snapshot(self.archive, run_id, source.id)
        if snapshot.get("raw", {}).get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
            raise BackupError("Backup captured an in-progress or failed resource; use a stable verified snapshot")
        api = snapshot.get("captureApiVersion")
        if not isinstance(api, str) or api != self.config.capture.api_versions[source.type]:
            raise BackupError("Snapshot API differs from the reviewed live API profile")
        observed_source = self.observe(source, api)
        self.assert_restorable(observed_source)
        observed_target = observed_source if target.id.lower() == source.id.lower() else self.observe(target, api)
        if mode == "create" and observed_target.get("status") != "missing":
            raise BackupError("Create-only target already exists or is unconfirmed")
        if mode == "update":
            self.assert_restorable(observed_target, may_be_missing=False)
        arm_plan = build_plan(snapshot, target.id, api)
        preview_result = compare({**snapshot, "resourceId": target.id}, observed_target,
                                 source.type, complete=True)
        identifier = str(uuid.uuid4())
        now = datetime.now(UTC)
        expires = (now + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        plan: JsonObject = {
            "id": identifier, "schemaVersion": 1, "scope": self.config.scope,
            "sourceRunId": run_id, "mode": mode, "ticket": payload["ticket"].strip(),
            "reason": payload["reason"].strip(), "createdAt": utc_now(), "expiresAt": expires,
            "expectedTargetFingerprint": observed_target.get("fingerprint"),
            "expectedSourceFingerprint": observed_source.get("fingerprint"),
            "targetWasPresent": observed_target["status"] == "present",
            "sourceWasPresent": observed_source["status"] == "present",
            "noChange": mode == "update" and preview_result["status"] == "same",
            "armPlan": arm_plan,
            "limitations": [
                "Only isolated tagged lab workloads; NSG/route-table configuration",
                "Whole reviewed settings are replaced; absent rules/routes may be removed",
                "Attachments, RBAC, diagnostics, secrets and data plane are not restored",
                "Blob lease coordinates this tool only; external-writer race remains",
            ],
        }
        sha = digest(encode_json(plan))
        events = self.events(identifier, identifier, plan["ticket"])
        with self.archive.guard("capture"):
            events.emit("restore_plan_reviewed", resource_id=target.id, status="PendingApproval",
                        planSha256=sha, sourceRunId=run_id, mode=mode)
            events.flush()
            self.archive.put(f"console/plans/{identifier}.json", encode_json(plan))
        return {"id": identifier, "approvalSha256": sha, "mode": mode,
                "targetResourceId": target.id, "sourceResourceId": source.id,
                "sourceRunId": run_id, "expiresAt": expires, "ticket": plan["ticket"],
                "reason": plan["reason"], "comparison": preview_result,
                "noChange": plan["noChange"], "limitations": plan["limitations"],
                "desiredSettings": arm_plan["body"], "targetWasPresent": plan["targetWasPresent"]}

    def safety_backup(self, plan: JsonObject, job: JsonObject, events: Events) -> str:
        run_id = new_run_id()
        manifest: JsonObject = {
            "schemaVersion": 1, "runId": run_id, "startedAt": utc_now(),
            "status": "Captured", "kind": "safety", "sourcePlanId": plan["id"],
            "sourceRunId": plan["sourceRunId"], "resources": [], "absences": [],
            "inventorySource": "ARM GET immediately before restore", "scope": self.config.scope,
            "label": f"Pre-restore safety · {plan['ticket']}",
            "selection": {"scope": self.config.scope}, "captureFailures": [],
        }
        capture = Backup(self.config.capture, self.arm, self.archive, events)
        identifiers = list(dict.fromkeys([plan["armPlan"]["sourceResourceId"],
                                         plan["armPlan"]["targetResourceId"]]))
        for identifier in identifiers:
            resource = self.config.resource(identifier)
            observed = self.observe(resource, plan["armPlan"]["apiVersion"])
            self.assert_restorable(observed)
            expected = (plan["expectedTargetFingerprint"]
                        if identifier.lower() == plan["armPlan"]["targetResourceId"].lower()
                        else plan["expectedSourceFingerprint"])
            if observed.get("fingerprint") != expected:
                raise BackupError("Current resource changed after review; no restore was applied")
            if observed["status"] == "present":
                entry = capture.capture_resource(resource, plan["armPlan"]["apiVersion"], run_id)
                captured_raw = self.archive.get(entry["blob"])
                if digest(captured_raw) != entry["sha256"]:
                    raise BackupError("Safety snapshot could not be read back with matching integrity")
                captured = json_document(captured_raw, "safety snapshot")
                if digest(encode_json(captured["raw"])) != expected:
                    raise BackupError("Current configuration changed while capturing safety backup; restore blocked")
                manifest["resources"].append(entry)
            else:
                manifest["absences"].append({"resourceId": identifier, "observedAt": observed["observedAt"],
                                             "status": "ConfirmedAbsent", "source": "ARM GET"})
        manifest.update({"finishedAt": utc_now(), "capturedCount": len(manifest["resources"]),
                         "discoveredCount": len(identifiers)})
        content = encode_json(manifest)
        self.archive.put(f"runs/{run_id}/manifest.json", content)
        events.emit("pre_restore_backup_completed", resource_id=plan["armPlan"]["targetResourceId"],
                    status="Succeeded", safetyRunId=run_id, planId=plan["id"],
                    captured=len(manifest["resources"]), absences=len(manifest["absences"]))
        events.flush()
        self.archive.put(f"runs/{run_id}/COMPLETE.json", encode_json({
            "runId": run_id, "manifestSha256": digest(content), "completedAt": utc_now(),
            "logsIngestion": "Accepted", "kind": "safety",
        }))
        self.read_run(run_id)
        job["safetyRunId"] = run_id
        return run_id

    def restore(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"planId", "approvalSha256", "confirmTarget"}, "restore execution")
        identifier = payload.get("planId")
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise BackupError("Invalid reviewed plan ID")
        plan = json_document(self.archive.get(f"console/plans/{identifier}.json"), "reviewed plan")
        sha = digest(encode_json(plan))
        if payload.get("approvalSha256") != sha or plan.get("scope") != self.config.scope:
            raise BackupError("Restore approval hash or allowed scope mismatch")
        expires = datetime.fromisoformat(plan["expiresAt"].replace("Z", "+00:00"))
        if expires <= datetime.now(UTC):
            raise BackupError("Restore review expired; regenerate the plan")
        arm_plan = object_value(plan.get("armPlan"), "ARM restore plan")
        target = self.config.resource(arm_plan["targetResourceId"])
        if arm_plan.get("apiVersion") != self.config.capture.api_versions[target.type]:
            raise BackupError("Configured API changed after review; regenerate the restore plan")
        if payload.get("confirmTarget") != target.id.rsplit("/", 1)[1]:
            raise BackupError("Type the exact target resource name to confirm")
        if not self.config.restore_enabled:
            raise BackupError("Restore is disabled")
        if plan.get("noChange") is True:
            raise BackupError("No reviewed configuration changes; refusing an unnecessary update")
        mode: Literal["create", "update"] = plan["mode"]
        if mode not in {"create", "update"}:
            raise BackupError("Invalid stored restore mode")
        events = self.events(job["id"], job["id"], plan["ticket"])
        with self.archive.guard("capture"):
            self.guard_scope()
            claim = f"console/claims/{identifier}.json"
            if self.archive.names(claim):
                raise BackupError("This plan has already been submitted; inspect its operation before retrying")
            self.archive.put(claim, encode_json({"operationId": job["id"], "claimedAt": utc_now()}))
            job.update({"phase": "safety-backup", "ticket": plan["ticket"],
                        "targetResourceId": target.id, "planId": identifier})
            safety_id = self.safety_backup(plan, job, events)
            job["phase"] = "applying"

            def before_write() -> None:
                self.archive.assert_lock()
                self.guard_scope()
                if expires <= datetime.now(UTC):
                    raise BackupError("Review expired before write; safety backup was retained, no restore applied")
                job["writeAttempted"] = True

            outcome = apply_plan(
                arm_plan, digest(encode_json(arm_plan)), self.arm, events, mode=mode,
                expected_current_sha256=plan["expectedTargetFingerprint"],
                before_write=before_write,
            )
            job["phase"] = "verification"
            observed = self.observe(target, arm_plan["apiVersion"])
            self.assert_restorable(observed, may_be_missing=False)
            result = compare(
                {"raw": arm_plan["body"], "captureApiVersion": arm_plan["apiVersion"]},
                observed, target.type, complete=True,
            )
            if result["status"] != "same":
                raise BackupError("Requested subset was applied but full reviewed configuration differs; inspect safety backup")
            events.emit("console_restore_completed", resource_id=target.id, status="Succeeded",
                        safetyRunId=safety_id, planId=identifier, ticket=plan["ticket"],
                        mode=mode)
            events.flush()
            return {**outcome, "safetyRunId": safety_id, "planId": identifier,
                    "ticket": plan["ticket"], "mode": mode, "comparison": result}

    def submit(self, action: str, payload: JsonObject) -> JsonObject:
        if action not in {"backup", "policy", "restore", "bundle-backup", "bundle-restore"}:
            raise BackupError("Unsupported console operation")
        with self.jobs_lock:
            if any(not future.done() for future in self.futures.values()):
                raise BackupError("An operation is already running; wait for its result")
            if len(self.jobs) >= 200:
                raise BackupError("Console operation limit reached; restart after reviewing the journal")
            identifier = str(uuid.uuid4())
            job: JsonObject = {"id": identifier, "action": action, "status": "Queued",
                               "phase": "queued", "startedAt": utc_now(), "scope": self.config.scope,
                               "writeAttempted": False}
            self.archive.put(f"console/jobs/{identifier}/requested.json", encode_json(job))
            self.jobs[identifier] = job
            self.futures[identifier] = self.executor.submit(self._run_job, job, action, payload)
            self.views.invalidate()
            return dict(job)

    def _run_job(self, job: JsonObject, action: str, payload: JsonObject) -> None:
        job["status"] = "Running"
        try:
            result = {"backup": self.backup, "policy": self.save_policy,
                      "restore": self.restore, "bundle-backup": self.bundle_backup,
                      "bundle-restore": self.bundle_restore}[action](job, payload)
            job.update({"status": "Succeeded", "phase": "complete", "result": result})
        except (BackupError, AzureError, OSError, ValueError) as exc:
            message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            job.update({"status": "Failed", "error": message, "errorCode": type(exc).__name__})
            if job["writeAttempted"]:
                job["warning"] = "Azure write was attempted. Failure is not rollback; inspect current state and safety backup."
            events = self.events(job["id"], job["id"], str(job.get("ticket", "")))
            try:
                events.emit("console_operation_failed", level="Error", status="Failed",
                            resource_id=job.get("targetResourceId", self.config.scope),
                            code=type(exc).__name__, phase=job["phase"])
                events.flush()
            except (BackupError, AzureError) as log_error:
                job["logDeliveryError"] = type(log_error).__name__
        finally:
            job["finishedAt"] = utc_now()
            self.archive.put(f"console/jobs/{job['id']}/finished.json", encode_json(job))
            self.views.invalidate()

    def job(self, identifier: str) -> JsonObject:
        with self.jobs_lock:
            if identifier not in self.jobs:
                    raise BackupError("Operation not found in this server session; inspect the configured archive journal")
            future, result = self.futures[identifier], self.jobs[identifier]
            if not future.done() and result["status"] in {"Succeeded", "Failed"}:
                return {**result, "status": "Running", "phase": "persisting-audit"}
            if future.done() and future.exception() is not None:
                result = {**result, "status": "Failed", "errorCode": type(future.exception()).__name__,
                          "error": "Operation worker failed; inspect current state and durable operation records",
                          "warning": "A failed response does not imply rollback"}
            return dict(result)

    def report(self, run_id: str) -> JsonObject:
        state = self.state()
        run = state["latestView"] if run_id == "latest" else next(
            (run for run in state["runs"] if run["id"] == run_id), None,
        )
        if run is None:
            raise BackupError("Report backup is not in the currently loaded history")
        report: JsonObject = {
            "schemaVersion": 1, "generatedAt": utc_now(), "scope": self.config.scope,
            "workspace": self.config.workspace_name, "sourceRunId": run_id,
            "backupStatus": run["status"], "backupAt": run["capturedAt"],
            "viewOnly": run.get("viewOnly", False), "sourceTimesVary": run.get("sourceTimesVary", False),
            "currentObservationStartedAt": state["startedAt"], "currentObservationFinishedAt": state["observedAt"],
            "policy": state["policy"], "warnings": state["warnings"],
            "activityStatus": state["activityStatus"],
            "operations": state["journal"],
            "resources": [{"resourceId": item["resourceId"], "capturedAt": item["capturedAt"],
                           "sourceRunId": item.get("sourceRunId", run_id),
                           "comparison": item["comparison"],
                           "lastObservedActor": state["current"][item["resourceId"].lower()].get("actor")}
                          for item in run["snapshots"]],
            "limitations": self.public_context()["limitations"],
            "dataPlaneIncluded": False,
        }
        return {"report": report, "sha256": digest(encode_json(report))}
