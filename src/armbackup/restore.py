from __future__ import annotations

import re
import time
from collections.abc import Callable
from copy import deepcopy
from typing import Literal

from armbackup.config import UUID, version
from armbackup.contracts import (
    Archive,
    Arm,
    ArmHttpError,
    BackupError,
    Events,
    JsonObject,
    digest,
    encode_json,
    object_value,
    utc_now,
)

NSG = "microsoft.network/networksecuritygroups"
ROUTES = "microsoft.network/routetables"
RULE_FIELDS = {
    "access", "description", "destinationAddressPrefix", "destinationAddressPrefixes",
    "destinationApplicationSecurityGroups", "destinationPortRange", "destinationPortRanges",
    "direction", "priority", "protocol", "sourceAddressPrefix", "sourceAddressPrefixes",
    "sourceApplicationSecurityGroups", "sourcePortRange", "sourcePortRanges",
}
IGNORED_PROPERTIES = {
    NSG: {"provisioningState", "resourceGuid", "defaultSecurityRules", "networkInterfaces",
          "subnets", "flowLogs"},
    ROUTES: {"provisioningState", "resourceGuid", "subnets"},
}
TOP_PROPERTIES = {NSG: {"securityRules", "flushConnection"},
                  ROUTES: {"routes", "disableBgpRoutePropagation"}}
CHILD_FIELDS = {NSG: RULE_FIELDS,
                ROUTES: {"addressPrefix", "nextHopType", "nextHopIpAddress", "hasBgpOverride"}}


def target_type(resource_id: str) -> str:
    match = re.fullmatch(
        r"/subscriptions/([^/]+)/resourceGroups/[^/?#\\]+/providers/"
        r"(Microsoft\.Network)/(networkSecurityGroups|routeTables)/[^/?#\\]+",
        resource_id, re.IGNORECASE,
    )
    if not match or not UUID.fullmatch(match[1]):
        raise BackupError("Restore target must be an NSG or route table resource ID")
    return (match[2] + "/" + match[3]).lower()


def project_body(raw: JsonObject, rtype: str) -> JsonObject:
    if rtype not in TOP_PROPERTIES:
        raise BackupError("No reviewed restore adapter for this resource type")
    props = object_value(raw.get("properties"), "resource properties")
    unsupported = set(props) - TOP_PROPERTIES[rtype] - IGNORED_PROPERTIES[rtype]
    if unsupported:
        raise BackupError(f"Restore adapter does not recognize properties: {sorted(unsupported)}")
    location = raw.get("location")
    if not isinstance(location, str) or not location:
        raise BackupError("Missing resource location")
    body: JsonObject = {"location": location, "properties": {}}
    if "tags" in raw:
        tags = object_value(raw["tags"], "tags")
        if not all(isinstance(v, str) for v in tags.values()):
            raise BackupError("Tags must contain string values")
        body["tags"] = tags
    for key in TOP_PROPERTIES[rtype]:
        if key in props:
            body["properties"][key] = props[key]
    collection_name = "securityRules" if rtype == NSG else "routes"
    if collection_name not in props or not isinstance(props[collection_name], list):
        raise BackupError("Snapshot missing explicit rule/route array; refusing default synthesis")
    children: list[JsonObject] = []
    for entry in props[collection_name]:
        item = object_value(entry, "child resource")
        child = object_value(item.get("properties"), "child properties")
        unsupported = set(child) - CHILD_FIELDS[rtype] - {"provisioningState"}
        if unsupported:
            raise BackupError(f"Unknown child properties: {sorted(unsupported)}")
        name = item.get("name")
        if not isinstance(name, str) or not name or "/" in name:
            raise BackupError("Invalid rule/route name")
        required = {"access", "direction", "priority", "protocol"} if rtype == NSG else {
            "addressPrefix", "nextHopType",
        }
        if not required <= child.keys():
            raise BackupError("Missing required rule/route settings")
        children.append({"name": name, "properties": {
            k: v for k, v in child.items() if k in CHILD_FIELDS[rtype]
        }})
    body["properties"][collection_name] = sorted(children, key=lambda x: x["name"])
    return deepcopy(body)


def map_references(value: object, mapping: dict[str, str], *, cloning: bool) -> object:
    if isinstance(value, dict):
        return {k: map_references(v, mapping, cloning=cloning) for k, v in value.items()}
    if isinstance(value, list):
        return [map_references(v, mapping, cloning=cloning) for v in value]
    if isinstance(value, str) and value.lower().startswith("/subscriptions/"):
        replacement = mapping.get(value.lower())
        if replacement is not None:
            if not replacement.lower().startswith("/subscriptions/"):
                raise BackupError("Reference mapping destination must be an Azure resource ID")
            return replacement
        if cloning:
            raise BackupError("Clone requires an explicit mapping for each external resource ID")
    return value


def build_plan(
    envelope: JsonObject, target: str, api_version: str,
    reference_map: dict[str, str] | None = None,
) -> JsonObject:
    rtype = target_type(target)
    if envelope.get("schemaVersion") != 1 or envelope.get("resourceType") != rtype:
        raise BackupError("Snapshot schema/type not supported")
    # There is no implicit cross-version migration; adapters must be tested before admitting it.
    if envelope.get("captureApiVersion") != version(api_version):
        raise BackupError("Cross-version restore requires a separately reviewed migration adapter")
    source = envelope.get("resourceId")
    if not isinstance(source, str):
        raise BackupError("Snapshot missing source resource ID")
    body = project_body(object_value(envelope.get("raw"), "snapshot raw"), rtype)
    body = object_value(map_references(
        body, {k.lower(): v for k, v in (reference_map or {}).items()},
        cloning=source.lower() != target.lower(),
    ), "mapped restore body")
    return {
        "schemaVersion": 1, "adapterVersion": "1", "sourceResourceId": source,
        "sourceSha256": digest(encode_json(envelope)), "targetResourceId": target,
        "resourceType": rtype, "apiVersion": api_version, "body": body,
        "createdAt": utc_now(), "operation": "PUT", "deleteResources": False,
        "limitations": "Rules/routes only; NIC/subnet attachments, diagnostics, RBAC and supplemental collections are NOT restored.",
    }


def load_snapshot(
    archive: Archive, run_id: str, resource_id: str,
) -> JsonObject:
    import json

    if not re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{12}", run_id):
        raise BackupError("Invalid run ID")
    manifest_raw = archive.get(f"runs/{run_id}/manifest.json")
    manifest = object_value(json.loads(manifest_raw), "manifest")
    complete = object_value(json.loads(archive.get(f"runs/{run_id}/COMPLETE.json")), "complete")
    if (complete.get("manifestSha256") != digest(manifest_raw)
            or complete.get("runId") != run_id or manifest.get("status") != "Captured"):
        raise BackupError("Backup completion marker or manifest integrity mismatch")
    for entry in manifest.get("resources", []):
        if str(entry.get("id", "")).lower() != resource_id.lower():
            continue
        if entry.get("status") != "Captured":
            raise BackupError("Resource was not captured")
        name = entry.get("blob")
        expected = f"runs/{run_id}/resources/{digest(resource_id.lower().encode())}.json"
        if name != expected:
            raise BackupError("Snapshot path does not match requested resource")
        raw = archive.get(name)
        if digest(raw) != entry.get("sha256"):
            raise BackupError("Snapshot hash mismatch")
        return object_value(json.loads(raw), "snapshot")
    raise BackupError("Resource not found in backup")


def apply_plan(
    plan: JsonObject, approval_hash: str, arm: Arm, events: Events, *,
    allow_existing: bool = False, sleep: Callable[[float], None] = time.sleep,
    mode: Literal["create", "update"] | None = None,
    expected_current_sha256: str | None = None,
    before_write: Callable[[], None] | None = None,
) -> JsonObject:
    if digest(encode_json(plan)) != approval_hash:
        raise BackupError("Plan approval hash mismatch")
    target, api = plan.get("targetResourceId"), plan.get("apiVersion")
    if not isinstance(target, str) or not isinstance(api, str):
        raise BackupError("Invalid restore plan")
    rtype = target_type(target)
    if (plan.get("operation") != "PUT" or plan.get("adapterVersion") != "1"
            or plan.get("schemaVersion") != 1 or plan.get("deleteResources") is not False
            or plan.get("resourceType") != rtype):
        raise BackupError("Unsupported restore operation")
    version(api)
    body = project_body(object_value(plan.get("body"), "restore body"), rtype)
    events.emit("restore_requested", resource_id=target, status="PendingApproval",
                planSha256=approval_hash)
    events.flush()
    try:
        existing = arm.request("GET", target, api)
    except ArmHttpError as exc:
        if exc.status != 404:
            raise
        if mode == "update":
            raise BackupError("Update-only target is missing; refusing implicit creation") from exc
        if expected_current_sha256 is not None:
            raise BackupError("Target changed after review: expected an existing resource") from exc
    else:
        if mode == "create" or (mode is None and not allow_existing):
            raise BackupError("Target exists; explicit --allow-existing required")
        if (expected_current_sha256 is not None
                and digest(encode_json(existing)) != expected_current_sha256):
            raise BackupError("Target changed after review; regenerate the restore plan")
    if before_write is not None:
        before_write()
    arm.request("PUT", target, api, body)
    for _ in range(90):
        current = arm.request("GET", target, api)
        state = current.get("properties", {}).get("provisioningState")
        if state in {"Failed", "Canceled"}:
            raise BackupError(f"Restore provisioning ended: {state}")
        if state == "Succeeded":
            observed = project_body(current, rtype)
            # Compare requested properties only; service-populated defaults remain observable.
            if not contains_settings(observed, body):
                raise BackupError("Restore finished but requested settings differ")
            events.emit("restore_verified", resource_id=target, status="Succeeded",
                        planSha256=approval_hash)
            events.flush()
            return {"status": "Succeeded", "targetResourceId": target,
                    "planSha256": approval_hash, "verifiedAt": utc_now()}
        sleep(10)
    raise BackupError("Restore polling timed out; inspect actual resource before retrying")


def contains_settings(actual: object, expected: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and contains_settings(actual[k], v) for k, v in expected.items()
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            contains_settings(a, e) for a, e in zip(actual, expected, strict=True)
        )
    return actual == expected
