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


_OMITTED = object()


def _display_path(path: str) -> str:
    return path[9:] if path.startswith("resource.") else path


def _project(
    value: object, node: JsonObject, path: str, *, root: bool = False,
    omissions: list[JsonObject] | None = None,
) -> object:
    if value is None:
        return None
    if node.get("secret"):
        if omissions is not None:
            omissions.append({
                "path": _display_path(path), "change": "dropped",
                "reason": "외부 비밀값(Secret) 원본이 필요한 쓰기 전용 속성이어서 복원 대상에서 제외합니다.",
            })
            return _OMITTED
        raise BackupError(f"{path}: secret/write-only data requires an external secret source")
    if "ref" in node:
        target = object_value(contracts()["nodes"].get(node["ref"]), "field node")
        return _project(value, target, path, root=root, omissions=omissions)
    discriminator = node.get("discriminator")
    if discriminator and isinstance(value, dict):
        variant = node.get("variants", {}).get(value.get(discriminator))
        if variant:
            return _project(value, {"ref": variant}, path, root=root, omissions=omissions)
        if omissions is not None:
            omissions.append({
                "path": _display_path(path), "change": "dropped",
                "reason": f"지원하지 않는 다형성 설정({value.get(discriminator)!r})이어서 복원 대상에서 제외합니다.",
            })
            return _OMITTED
        raise BackupError(f"{path}: unsupported polymorphic settings")
    kind = node.get("type")
    if kind == "object":
        source = object_value(value, path)
        fields = object_value(node.get("fields", {}), "field contract")
        result = {}
        ignored = set(node.get("readonly", []))
        if root:
            ignored |= {"id", "name", "type", "etag", "systemData", "createdTime", "changedTime"}
        for key, item in source.items():
            if key in ignored:
                continue
            child_path = path + "." + key
            if key in fields:
                projected = _project(item, fields[key], child_path, omissions=omissions)
                if projected is not _OMITTED:
                    result[key] = projected
            elif "additional" in node:
                projected = _project(item, node["additional"], child_path, omissions=omissions)
                if projected is not _OMITTED:
                    result[key] = projected
            elif omissions is not None:
                omissions.append({
                    "path": _display_path(child_path), "change": "dropped",
                    "reason": f"검토된 복원 API 스키마 밖의 속성({key})이어서 복원 대상에서 제외합니다.",
                })
            else:
                raise BackupError(f"{path}: field is not in the reviewed API contract: {key}")
        missing = set(node.get("required", [])) - set(result) - ignored
        if missing:
            raise BackupError(f"{path}: required settings missing: {sorted(missing)}")
        return result
    if kind == "array":
        if not isinstance(value, list):
            raise BackupError(f"{path}: expected array")
        items = []
        for index, item in enumerate(value):
            item_label = (f"{path}[name={item['name']}]"
                          if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"]
                          else f"{path}[{index}]")
            projected = _project(item, node.get("items", {"type": "any"}), item_label, omissions=omissions)
            if projected is not _OMITTED:
                items.append(projected)
        return items
    if kind == "string" and not isinstance(value, str):
        raise BackupError(f"{path}: expected string")
    if kind == "integer" and type(value) is not int:
        raise BackupError(f"{path}: expected integer")
    if kind == "number" and (not isinstance(value, int | float) or isinstance(value, bool)):
        raise BackupError(f"{path}: expected number")
    if kind == "boolean" and not isinstance(value, bool):
        raise BackupError(f"{path}: expected boolean")
    return deepcopy(value)


def restore_projection(raw: JsonObject, resource_type: str) -> tuple[JsonObject, list[JsonObject]]:
    if resource_type in {NSG, ROUTES}:
        return project_body(raw, resource_type), []
    schema = contracts()["roots"].get(resource_type)
    if schema is None:
        raise BackupError("No reviewed restore field contract for this type")
    omissions: list[JsonObject] = []
    source = raw
    if resource_type in {LB, LB_POOL}:
        source = deepcopy(raw)
        pools = (source.get("properties", {}).get("backendAddressPools", []) if resource_type == LB
                 else [source])
        for pool in pools:
            pprops = pool.get("properties", {}) if isinstance(pool.get("properties"), dict) else {}
            if "loadBalancerBackendAddresses" in pprops and isinstance(pprops["loadBalancerBackendAddresses"], list):
                # NIC-owned members are listed by ARM but belong to the NIC, so they are never written back.
                pprops["loadBalancerBackendAddresses"] = [
                    address for address in pprops["loadBalancerBackendAddresses"]
                    if isinstance(address, dict)
                    and not (isinstance(address.get("properties"), dict)
                             and address["properties"].get("networkInterfaceIPConfiguration"))]
            for address in pprops.get("loadBalancerBackendAddresses", []) if isinstance(pprops.get("loadBalancerBackendAddresses"), list) else []:
                if not isinstance(address, dict):
                    continue
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
                if isinstance(address.get("properties"), dict):
                    address["properties"].pop("provisioningState", None)
        sprops = source.get("properties", {}) if isinstance(source.get("properties"), dict) else {}
        for index, rule in enumerate(sprops.get("loadBalancingRules", []) if isinstance(sprops.get("loadBalancingRules"), list) else []):
            if not isinstance(rule, dict) or not isinstance(rule.get("properties"), dict):
                continue
            props = rule["properties"]
            rule_selector = f"[name={rule['name']}]" if isinstance(rule.get("name"), str) and rule["name"] else f"[{index}]"
            for field in ("enableDestinationServiceEndpoint", "allowBackendPortConflict",
                          "disableConnectionTracking", "enableConnectionTracking"):
                if field in props:
                    enabled = props.pop(field)
                    if enabled is not False:
                        omissions.append({
                            "path": f"properties.loadBalancingRules{rule_selector}.properties.{field}",
                            "change": "dropped",
                            "reason": f"비공개 Load Balancer 규칙 속성({field})은 ARM 재전송을 지원하지 않아 복원 대상에서 제외합니다.",
                        })
    if resource_type == AGW:
        object_value(raw.get("properties"), "gateway")
        source = deepcopy(raw)
        props = object_value(source.get("properties"), "gateway")
        isolation = props.pop("networkIsolationEnabled", None)
        if isolation is not None and not isinstance(isolation, bool):
            raise BackupError("Invalid observed network-isolation flag")
        backlinks = {
            "frontendIPConfigurations": ("httpListeners", "listeners"),
            "frontendPorts": ("httpListeners", "listeners"),
            "backendAddressPools": ("requestRoutingRules", "routingRules", "urlPathMaps", "pathRules"),
            "backendHttpSettingsCollection": ("requestRoutingRules", "urlPathMaps", "pathRules"),
            "backendSettingsCollection": ("routingRules",),
            "httpListeners": ("requestRoutingRules", "redirectConfiguration"),
            "listeners": ("routingRules",),
            "urlPathMaps": ("requestRoutingRules",),
            "probes": ("backendHttpSettings", "backendSettings"),
            "sslCertificates": ("httpListeners", "listeners"),
            "sslProfiles": ("httpListeners", "listeners"),
            "rewriteRuleSets": ("requestRoutingRules", "pathRules"),
        }
        own = str(raw.get("id", "")).lower()
        for collection, fields in backlinks.items():
            for child in props.get(collection, []) if isinstance(props.get(collection), list) else []:
                if not isinstance(child, dict) or not isinstance(child.get("properties"), dict):
                    continue
                child_props = child["properties"]
                for field in fields:
                    values = child_props.pop(field, [])
                    values = values if isinstance(values, list) else [values]
                    if any(not isinstance(item, dict) or not str(item.get("id", "")).lower().startswith(own + "/")
                           for item in values):
                        raise BackupError("Gateway response backlink points outside the captured resource")
        for index, listener in enumerate(props.get("httpListeners", []) if isinstance(props.get("httpListeners"), list) else []):
            if not isinstance(listener, dict) or not isinstance(listener.get("properties"), dict):
                continue
            listener_props = listener["properties"]
            selector = f"[name={listener['name']}]" if isinstance(listener.get("name"), str) and listener["name"] else f"[{index}]"
            if listener_props.pop("enableHttp3", False) is not False:
                omissions.append({
                    "path": f"properties.httpListeners{selector}.properties.enableHttp3",
                    "change": "dropped",
                    "reason": "리스너 HTTP/3 설정(enableHttp3)은 복원 API 버전에서 지원하지 않아 제외합니다.",
                })
        for redirect in props.get("redirectConfigurations", []) if isinstance(props.get("redirectConfigurations"), list) else []:
            if isinstance(redirect, dict) and isinstance(redirect.get("properties"), dict):
                redirect["properties"].pop("provisioningState", None)
    if resource_type == WAF:
        source = deepcopy(raw)
        wprops = source.get("properties", {}) if isinstance(source.get("properties"), dict) else {}
        for index, rule in enumerate(wprops.get("customRules", []) if isinstance(wprops.get("customRules"), list) else []):
            if not isinstance(rule, dict):
                continue
            selector = f"[name={rule['name']}]" if isinstance(rule.get("name"), str) and rule["name"] else f"[{index}]"
            if rule.get("skippedManagedRuleSets"):
                omissions.append({
                    "path": f"properties.customRules{selector}.skippedManagedRuleSets",
                    "change": "dropped",
                    "reason": "WAF 커스텀 규칙의 관리형 규칙 우회(skippedManagedRuleSets)는 복원 대상에서 제외합니다.",
                })
            rule.pop("skippedManagedRuleSets", None)
    if resource_type == AFD and raw.get("sku", {}).get("name") not in {"Standard_AzureFrontDoor", "Premium_AzureFrontDoor"}:
        raise BackupError("Only Front Door Standard/Premium profiles are reviewed; classic CDN is not replayed")
    if resource_type.startswith("microsoft.cdn/"):
        source = deepcopy(source) if source is raw else source
        cprops = source.get("properties", {}) if isinstance(source.get("properties"), dict) else {}
        for pl_field in ("sharedPrivateLinkResource", "privateLink"):
            if cprops.get(pl_field):
                omissions.append({
                    "path": f"properties.{pl_field}",
                    "change": "dropped",
                    "reason": "프라이빗 링크 연결 승인(Private Link)은 대상 리소스의 별도 수동 승인이 필요해 자동 복원에서 제외합니다.",
                })
            cprops.pop(pl_field, None)
    if resource_type == VNET:
        # Peerings belong to a pair of VNets and attached NICs/endpoints to their own resources.
        # Neither is replayed, so a VNet restore can neither recreate a peer link nor drag in the remote VNet.
        source = deepcopy(raw)
        if isinstance(source.get("properties"), dict):
            source["properties"].pop("virtualNetworkPeerings", None)
    body = object_value(_project(source, schema, "resource", root=True, omissions=omissions), "restore body")
    if resource_type == PIP:
        props = object_value(body.get("properties"), "public IP")
        if isinstance(props.get("dnsSettings"), dict):
            props["dnsSettings"].pop("fqdn", None)
            if not props["dnsSettings"]:
                props.pop("dnsSettings", None)
        for field in ("ipAddress", "servicePublicIPAddress", "natGateway", "migrationPhase",
                      "linkedPublicIPAddress"):
            props.pop(field, None)
    return body, omissions


def restore_body(raw: JsonObject, resource_type: str) -> JsonObject:
    return restore_projection(raw, resource_type)[0]


def references(value: object, path: str = "") -> list[JsonObject]:
    if path == "tags" or path.startswith("tags."):
        return []
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
    if resource_type in {LB, LB_POOL}:
        if resource_type == LB:
            for fe in body.get("properties", {}).get("frontendIPConfigurations") or []:
                fe_props = fe.get("properties") if isinstance(fe, dict) else None
                if isinstance(fe_props, dict) and str(fe_props.get("privateIPAllocationMethod", "")).lower() == "dynamic":
                    fe_props.pop("privateIPAddress", None)
        pools = (body.get("properties", {}).get("backendAddressPools", []) if resource_type == LB else [body])
        for pool in pools if isinstance(pools, list) else []:
            if isinstance(pool, dict) and isinstance(pool.get("properties"), dict):
                pprops = pool["properties"]
                if pprops.get("loadBalancerBackendAddresses") == []:
                    pprops.pop("loadBalancerBackendAddresses", None)
                for addr in pprops.get("loadBalancerBackendAddresses") or []:
                    aprops = addr.get("properties") if isinstance(addr, dict) else None
                    if isinstance(aprops, dict) and aprops.get("ipAddress") and aprops.get("virtualNetwork"):
                        aprops.pop("subnet", None)
    if resource_type == AGW:
        for pool in body.get("properties", {}).get("backendAddressPools") or []:
            pprops = pool.get("properties") if isinstance(pool, dict) else None
            if isinstance(pprops, dict) and pprops.get("backendAddresses") == []:
                pprops.pop("backendAddresses", None)
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
