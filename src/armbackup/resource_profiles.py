from __future__ import annotations

import json
import re
from copy import deepcopy
from functools import lru_cache
from importlib.resources import files

from armbackup.config import UUID
from armbackup.contracts import BackupError, JsonObject, object_value
from armbackup.restore import NSG, ROUTES, project_body

VNET = "microsoft.network/virtualnetworks"
AGW = "microsoft.network/applicationgateways"
LB = "microsoft.network/loadbalancers"
LB_POOL = LB + "/backendaddresspools"
WAF = "microsoft.network/applicationgatewaywebapplicationfirewallpolicies"
PIP = "microsoft.network/publicipaddresses"
AFD = "microsoft.cdn/profiles"
AFD_ENDPOINT = AFD + "/afdendpoints"
AFD_ORIGIN_GROUP = AFD + "/origingroups"
AFD_ORIGIN = AFD_ORIGIN_GROUP + "/origins"
AFD_ROUTE = AFD_ENDPOINT + "/routes"
AFD_RULESET = AFD + "/rulesets"
AFD_RULE = AFD_RULESET + "/rules"
AFD_SECURITY = AFD + "/securitypolicies"
PROFILE_LABELS = {
    NSG: ("NSG", "shield"), ROUTES: ("Route Table", "network"), VNET: ("Virtual Network", "network"),
    AGW: ("Application Gateway", "gateway"), LB: ("Load Balancer", "balance"),
    LB_POOL: ("Backend Pool", "balance"),
    WAF: ("WAF Policy", "shield"), PIP: ("Public IP", "globe"),
    AFD: ("Front Door", "globe"), AFD_ENDPOINT: ("Endpoint", "globe"),
    AFD_ORIGIN_GROUP: ("Origin Group", "network"), AFD_ORIGIN: ("Origin", "box"),
    AFD_ROUTE: ("Route", "network"), AFD_RULESET: ("Rule Set", "sliders"),
    AFD_RULE: ("Rule", "sliders"), AFD_SECURITY: ("Security Policy", "shield"),
}
SUPPORTED_TYPES = set(PROFILE_LABELS)
PROFILE_APIS = {kind: "2024-02-01" if kind.startswith("microsoft.cdn/") else "2024-05-01"
                for kind in SUPPORTED_TYPES}


def arm_identity(resource_id: str) -> tuple[str, str, str | None]:
    if not isinstance(resource_id, str) or any(character in resource_id for character in "?%#\\"):
        raise BackupError("Invalid ARM resource ID")
    match = re.fullmatch(r"/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/([^/]+)/(.+)",
                         resource_id, re.IGNORECASE)
    if not match or not UUID.fullmatch(match[1]):
        raise BackupError("A subscription/RG ARM resource ID is required")
    parts = match[4].split("/")
    if len(parts) % 2 or any(not re.fullmatch(r"[a-zA-Z0-9_.-]+", part) for part in parts):
        raise BackupError("Unsupported ARM resource name or child path")
    kind = (match[3] + "/" + "/".join(parts[::2])).lower()
    parent = resource_id.rsplit("/", 2)[0] if len(parts) > 2 else None
    return kind, parts[-1], parent


def ownership_parent(resource_id: str) -> str | None:
    kind = arm_identity(resource_id)[0]
    if kind.startswith((AFD + "/", LB + "/")):
        return "/".join(resource_id.split("/")[:9])
    return None


def snapshot_tags(envelope: JsonObject) -> JsonObject:
    raw = object_value(envelope.get("raw"), "snapshot raw")
    metadata = object_value(envelope.get("metadata", {}), "snapshot metadata")
    if str(envelope.get("resourceType", "")).startswith((AFD + "/", LB + "/")):
        owner = ownership_parent(envelope["resourceId"])
        if owner and str(metadata.get("ownershipParent", "")).lower() == owner.lower():
            return object_value(metadata.get("tags", {}), "captured ownership tags")
    return object_value(raw.get("tags", {}), "snapshot tags")


@lru_cache(maxsize=1)
def contracts() -> JsonObject:
    return object_value(json.loads(files("armbackup").joinpath("resource_profiles.json").read_bytes()),
                        "resource field contracts")


def _project(value: object, node: JsonObject, path: str, *, root: bool = False) -> object:
    if value is None:
        return None
    if node.get("secret"):
        raise BackupError(f"{path}: secret/write-only data requires an external secret source")
    if "ref" in node:
        target = object_value(contracts()["nodes"].get(node["ref"]), "field node")
        return _project(value, target, path, root=root)
    discriminator = node.get("discriminator")
    if discriminator and isinstance(value, dict):
        variant = node.get("variants", {}).get(value.get(discriminator))
        if variant:
            return _project(value, {"ref": variant}, path, root=root)
        raise BackupError(f"{path}: unsupported polymorphic settings")
    kind = node.get("type")
    if kind == "object":
        source = object_value(value, path)
        fields = object_value(node.get("fields", {}), "field contract")
        result = {}
        ignored = set(node.get("readonly", []))
        if root:
            ignored |= {"id", "name", "type", "etag", "systemData"}
        for key, item in source.items():
            if key in ignored:
                continue
            if key in fields:
                result[key] = _project(item, fields[key], path + "." + key)
            elif "additional" in node:
                result[key] = _project(item, node["additional"], path + "." + key)
            else:
                raise BackupError(f"{path}: field is not in the reviewed API contract: {key}")
        missing = set(node.get("required", [])) - set(result) - ignored
        if missing:
            raise BackupError(f"{path}: required settings missing: {sorted(missing)}")
        return result
    if kind == "array":
        if not isinstance(value, list):
            raise BackupError(f"{path}: expected array")
        return [_project(item, node.get("items", {"type": "any"}), path + "[]") for item in value]
    if kind == "string" and not isinstance(value, str):
        raise BackupError(f"{path}: expected string")
    if kind == "integer" and type(value) is not int:
        raise BackupError(f"{path}: expected integer")
    if kind == "number" and (not isinstance(value, int | float) or isinstance(value, bool)):
        raise BackupError(f"{path}: expected number")
    if kind == "boolean" and not isinstance(value, bool):
        raise BackupError(f"{path}: expected boolean")
    return deepcopy(value)


def restore_body(raw: JsonObject, resource_type: str) -> JsonObject:
    if resource_type in {NSG, ROUTES}:
        return project_body(raw, resource_type)
    schema = contracts()["roots"].get(resource_type)
    if schema is None:
        raise BackupError("No reviewed restore field contract for this type")
    source = raw
    if resource_type in {LB, LB_POOL}:
        source = deepcopy(raw)
        pools = (source.get("properties", {}).get("backendAddressPools", []) if resource_type == LB
                 else [source])
        for pool in pools:
            for address in pool.get("properties", {}).get("loadBalancerBackendAddresses", []):
                observed_id = address.get("id")
                if observed_id is not None:
                    prefix = (str(pool.get("id", "")) or str(raw.get("id", ""))).lower()
                    if not isinstance(observed_id, str) or not observed_id.lower().startswith(prefix + "/loadbalancerbackendaddresses/"):
                        raise BackupError("Observed LB backend address ID is outside its captured pool")
                observed_type = address.get("type")
                if observed_type is not None and str(observed_type).lower() != LB_POOL + "/loadbalancerbackendaddresses":
                    raise BackupError("Unexpected observed LB backend address type")
                for field in ("id", "type", "etag"):
                    address.pop(field, None)
                address.get("properties", {}).pop("provisioningState", None)
        for rule in source.get("properties", {}).get("loadBalancingRules", []):
            props = rule.get("properties", {})
            for field in ("enableDestinationServiceEndpoint", "allowBackendPortConflict",
                          "disableConnectionTracking", "enableConnectionTracking"):
                if field in props:
                    if props[field] is not False:
                        raise BackupError(f"Undocumented LB field is not replayable when enabled: {field}")
                    props.pop(field)
    if resource_type == AGW:
        source = deepcopy(raw)
        props = source.get("properties", {})
        isolation = props.pop("networkIsolationEnabled", None)
        if isolation is not None and not isinstance(isolation, bool):
            raise BackupError("Invalid observed network-isolation flag")
        backlinks = {
            "frontendIPConfigurations": ("httpListeners",),
            "frontendPorts": ("httpListeners",),
            "backendAddressPools": ("requestRoutingRules", "urlPathMaps", "pathRules"),
            "backendHttpSettingsCollection": ("requestRoutingRules", "urlPathMaps", "pathRules"),
            "httpListeners": ("requestRoutingRules", "redirectConfiguration"),
            "urlPathMaps": ("requestRoutingRules",),
            "probes": ("backendHttpSettings",),
        }
        own = str(raw.get("id", "")).lower()
        for collection, fields in backlinks.items():
            for child in props.get(collection, []):
                child_props = child.get("properties", {})
                for field in fields:
                    values = child_props.pop(field, [])
                    values = values if isinstance(values, list) else [values]
                    if any(not isinstance(item, dict) or not str(item.get("id", "")).lower().startswith(own + "/")
                           for item in values):
                        raise BackupError("Gateway response backlink points outside the captured resource")
        for listener in props.get("httpListeners", []):
            listener_props = listener.get("properties", {})
            if listener_props.pop("enableHttp3", False) is not False:
                raise BackupError("HTTP/3 replay requires a separately reviewed gateway profile")
        for redirect in props.get("redirectConfigurations", []):
            redirect.get("properties", {}).pop("provisioningState", None)
    if resource_type == WAF:
        source = deepcopy(raw)
        for rule in source.get("properties", {}).get("customRules", []):
            if rule.get("skippedManagedRuleSets"):
                raise BackupError("Managed-rule bypass settings require a reviewed WAF profile")
            rule.pop("skippedManagedRuleSets", None)
    if resource_type == AGW:
        props = object_value(raw.get("properties"), "gateway")
        if any(props.get(field) for field in ("sslCertificates", "authenticationCertificates",
                                             "trustedClientCertificates", "sslProfiles")):
            raise BackupError("Certificate-bearing gateway restore requires external certificate inputs; this HTTP profile is blocked")
        if raw.get("identity"):
            raise BackupError("Gateway managed-identity/RBAC restoration requires separate identity verification")
    if resource_type == AFD and raw.get("sku", {}).get("name") not in {"Standard_AzureFrontDoor", "Premium_AzureFrontDoor"}:
        raise BackupError("Only Front Door Standard/Premium profiles are reviewed; classic CDN is not replayed")
    if resource_type.startswith("microsoft.cdn/"):
        props = raw.get("properties", {})
        if props.get("sharedPrivateLinkResource") or props.get("privateLink"):
            raise BackupError("Private Link approvals must be restored through a separately reviewed workflow")
    if resource_type == VNET:
        for subnet in raw.get("properties", {}).get("subnets", []):
            props = subnet.get("properties", {})
            if props.get("ipConfigurations") or props.get("privateEndpoints"):
                raise BackupError("VNet with attached workloads requires an explicitly coordinated restore")
    body = object_value(_project(source, schema, "resource", root=True), "restore body")
    if resource_type == PIP:
        props = object_value(body.get("properties"), "public IP")
        if isinstance(props.get("dnsSettings"), dict):
            props["dnsSettings"].pop("fqdn", None)
        for field in ("ipAddress", "servicePublicIPAddress", "natGateway", "migrationPhase",
                      "linkedPublicIPAddress"):
            props.pop(field, None)
    return body


def references(value: object, path: str = "") -> list[JsonObject]:
    if isinstance(value, dict):
        return [item for key, child in value.items()
                for item in references(child, path + "." + key if path else key)]
    if isinstance(value, list):
        return [item for index, child in enumerate(value)
                for item in references(child, f"{path}[{index}]")]
    if isinstance(value, str) and value.lower().startswith("/subscriptions/"):
        return [{"id": value, "path": path}]
    return []


def configuration_body(raw: JsonObject, resource_type: str) -> JsonObject:
    body = restore_body(raw, resource_type)
    own_id = str(raw.get("id", "")).lower()

    def normalize(value: object, path: str = "") -> object:
        if isinstance(value, str) and path.endswith(".id") and value.lower().startswith("/subscriptions/"):
            arm_identity(value)
            return value.lower()
        if isinstance(value, list):
            items = [normalize(child, path + "[]") for child in value]
            if items and all(isinstance(child, dict) and isinstance(child.get("name"), str) for child in items):
                named = [object_value(child, "named configuration") for child in items]
                return sorted(named, key=lambda child: str(child["name"]).lower())
            return items
        if isinstance(value, dict):
            return {key: normalize(child, path + "." + key) for key, child in value.items()
                    if not (key == "id" and isinstance(child, str) and own_id and
                            (child.lower() == own_id or child.lower().startswith(own_id + "/"))
                            and path.endswith("[]"))}
        return value

    return object_value(normalize(body), "comparison configuration")
