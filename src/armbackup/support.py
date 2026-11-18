from __future__ import annotations

import json
from importlib.resources import files

from armbackup.contracts import BackupError, JsonObject
from armbackup.resource_profiles import (
    AGW,
    LB,
    PROFILE_APIS,
    SUPPORTED_TYPES,
    arm_identity,
    references,
    restore_projection,
)

CATALOG: JsonObject = json.loads(
    files("armbackup").joinpath("ui_static", "resource-support.json").read_bytes(),
)
OFFICIAL_TYPES = {entry["type"] for entry in CATALOG["resources"]}


def verify_backup_source(raw: JsonObject) -> None:
    """Backup only needs a stable, official-type source; restorability is judged separately."""
    if str(raw.get("type", "")).lower() not in OFFICIAL_TYPES:
        raise BackupError("This resource is not an official selectable backup type")
    if raw.get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
        raise BackupError("Official backup requires a stable successfully provisioned resource")


def verify_restore_profile(raw: JsonObject) -> None:
    """Verify a backed-up official resource has a structurally valid ARM shape for partial/full restore."""
    kind = str(raw.get("type", "")).lower()
    if kind not in OFFICIAL_TYPES:
        raise BackupError("This resource is not an official selectable backup type")
    props = raw.get("properties")
    if not isinstance(props, dict):
        raise BackupError("Resource properties are missing or malformed")
    if kind == AGW:
        sku_name = (props.get("sku") or {}).get("name") or (raw.get("sku") or {}).get("name")
        if sku_name is not None and not isinstance(sku_name, str):
            raise BackupError("Application Gateway SKU name must be a string")
    elif kind == LB:
        sku_name = (raw.get("sku") or {}).get("name")
        if sku_name is not None and not isinstance(sku_name, str):
            raise BackupError("Load Balancer SKU name must be a string")
    restore_projection(raw, kind)


def restore_omissions(raw: JsonObject, resource_type: str | None = None) -> list[JsonObject]:
    """Non-restorable properties that will be omitted or kept-current instead of blocking the whole resource."""
    kind = (resource_type or str(raw.get("type", ""))).lower()
    if kind not in SUPPORTED_TYPES:
        return []
    body, omissions = restore_projection(raw, kind)
    if kind == AGW:
        bprops = body.get("properties")
        certs = bprops.get("sslCertificates") if isinstance(bprops, dict) else None
        for cert in certs if isinstance(certs, list) else []:
            if not isinstance(cert, dict):
                continue
            raw_cprops = cert.get("properties")
            cprops = raw_cprops if isinstance(raw_cprops, dict) else {}
            if not cprops.get("keyVaultSecretId") and not cprops.get("data"):
                cname = str(cert.get("name", ""))
                omissions.append({
                    "path": f"properties.sslCertificates[name={cname}]",
                    "change": "kept-current",
                    "reason": "업로드형 PFX 인증서 비밀값(개인키·암호)은 ARM 백업에 포함되지 않아 업데이트 시 현재 인증서를 유지하며, 신규 생성·복제 시에는 제외합니다.",
                })
    return omissions


def verify_official_configuration(raw: JsonObject) -> None:
    verify_backup_source(raw)
    verify_restore_profile(raw)


def restore_profile_reason(raw: JsonObject) -> str:
    """Why a backed-up Gateway/LB cannot be restored by this tool, or '' when it can (or is not a root type)."""
    if str(raw.get("type", "")).lower() not in OFFICIAL_TYPES:
        return ""
    try:
        verify_restore_profile(raw)
    except BackupError as exc:
        return str(exc)
    return ""


def related_kind(identifier: str) -> str:
    try:
        return arm_identity(identifier)[0]
    except BackupError:
        return ""


def verify_official_capture(envelope: JsonObject, captured_ids: set[str]) -> None:
    """Capture integrity only: the stored source is complete. Restore support is not required to back up."""
    kind = envelope["resourceType"]
    if envelope.get("captureApiVersion") != PROFILE_APIS.get(kind):
        raise BackupError("Capture API version is outside the certified support profile")
    profile = next((entry for entry in CATALOG["resources"] if entry["type"] == kind), None)
    if profile is None:
        dependencies = {kind for entry in CATALOG["resources"]
                        for kind in entry["relatedTypes"] + entry["containedTypes"]}
        if kind in dependencies and envelope["raw"].get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
            raise BackupError("Official backup dependency is not stably provisioned")
        return
    raw = envelope["raw"]
    verify_backup_source(raw)
    for reference in references(raw):
        if (related_kind(reference["id"]) in profile["relatedTypes"]
                and reference["id"].lower() not in captured_ids):
            raise BackupError("A required related resource changed or was omitted during capture")
    if kind == LB:
        for pool in raw.get("properties", {}).get("backendAddressPools", []):
            identifier = envelope["resourceId"] + "/backendAddressPools/" + pool["name"]
            if identifier.lower() not in captured_ids:
                raise BackupError("An independent Load Balancer backend pool was omitted during capture")
