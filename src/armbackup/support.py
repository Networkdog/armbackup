from __future__ import annotations

import json
from importlib.resources import files

from armbackup.contracts import BackupError, JsonObject
from armbackup.resource_profiles import (
    AGW,
    LB,
    PROFILE_APIS,
    arm_identity,
    references,
    restore_body,
)

CATALOG: JsonObject = json.loads(
    files("armbackup").joinpath("ui_static", "resource-support.json").read_bytes(),
)
OFFICIAL_TYPES = {entry["type"] for entry in CATALOG["resources"]}


def verify_official_configuration(raw: JsonObject) -> None:
    kind = str(raw.get("type", "")).lower()
    props = raw.get("properties", {})
    if props.get("provisioningState") not in {None, "Succeeded"}:
        raise BackupError("Official backup requires a stable successfully provisioned resource")
    if kind == AGW:
        if props.get("sku", {}).get("name") != "WAF_v2":
            raise BackupError("Official Application Gateway support requires the tested WAF_v2 HTTP profile")
        if any(item.get("properties", {}).get("protocol") != "Http"
               for name in ("httpListeners", "backendHttpSettingsCollection")
               for item in props.get(name, [])):
            raise BackupError("Official Application Gateway support is HTTP-only; TLS requires separate validation")
        if any(not item.get("properties", {}).get("publicIPAddress")
               for item in props.get("frontendIPConfigurations", [])):
            raise BackupError("Only public IPv4 Gateway frontends are in the certified profile")
    elif kind == LB:
        if raw.get("sku", {}).get("name") != "Standard":
            raise BackupError("Official Load Balancer support requires the tested Standard SKU")
        if any(props.get(name) for name in ("outboundRules", "inboundNatRules", "inboundNatPools")):
            raise BackupError("Outbound/NAT rules are not in the certified Load Balancer profile")
        if any(item.get("properties", {}).get("protocol") != "Tcp"
               for item in props.get("loadBalancingRules", [])):
            raise BackupError("Only TCP Load Balancer rules are in the certified profile")
        if any(not item.get("properties", {}).get("publicIPAddress")
               for item in props.get("frontendIPConfigurations", [])):
            raise BackupError("Only public IPv4 Load Balancer frontends are in the certified profile")
        if any(pool.get("properties", {}).get("backendIPConfigurations")
               for pool in props.get("backendAddressPools", [])):
            raise BackupError("NIC-backed pools require separate attachment validation")
    else:
        raise BackupError("This resource is not an official selectable backup type")
    restore_body(raw, kind)


def verify_official_capture(envelope: JsonObject, captured_ids: set[str]) -> None:
    kind = envelope["resourceType"]
    if envelope.get("captureApiVersion") != PROFILE_APIS.get(kind):
        raise BackupError("Capture API version is outside the certified support profile")
    profile = next((entry for entry in CATALOG["resources"] if entry["type"] == kind), None)
    if profile is None:
        dependencies = {kind for entry in CATALOG["resources"]
                        for kind in entry["relatedTypes"] + entry["containedTypes"]}
        if kind in dependencies:
            if envelope["raw"].get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
                raise BackupError("Official backup dependency is not stably provisioned")
            restore_body(envelope["raw"], kind)
            if kind == "microsoft.network/publicipaddresses" and envelope["raw"].get("properties", {}).get("publicIPAddressVersion", "IPv4") != "IPv4":
                raise BackupError("Only IPv4 public IP dependencies are in the certified profile")
        return
    raw = envelope["raw"]
    verify_official_configuration(raw)
    for reference in references(raw):
        if (arm_identity(reference["id"])[0] in profile["relatedTypes"]
                and reference["id"].lower() not in captured_ids):
            raise BackupError("A required related resource changed or was omitted during capture")
    if kind == LB:
        for pool in raw.get("properties", {}).get("backendAddressPools", []):
            identifier = envelope["resourceId"] + "/backendAddressPools/" + pool["name"]
            if identifier.lower() not in captured_ids:
                raise BackupError("An independent Load Balancer backend pool was omitted during capture")
