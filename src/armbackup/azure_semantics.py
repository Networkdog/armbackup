"""Azure resource semantics that decide what a restore or clone may carry over.

A snapshot holds everything ARM returned. Replaying all of it is wrong in four ways, and each is
modelled here instead of being left to an ARM error after the safety backup:

* immutable fields: set when the resource is created, so an update that changes them is refused;
* identities that must stay unique (DNS labels, static private IPs, reverse FQDNs): a clone changes or
  drops them;
* relations that belong to another resource (VNet peerings): never replayed and never followed;
* attachments that only exist on one consumer (a public IP): a clone must bring its own copy.
"""
from __future__ import annotations

import ipaddress
import re
from copy import deepcopy
from typing import Any

from armbackup.contracts import BackupError, JsonObject
from armbackup.resource_profiles import AGW, LB, LB_POOL, PIP, VNET, arm_identity, references

EXCLUSIVE_TARGETS = {PIP}
IMMUTABLE_PATHS: dict[str, tuple[tuple[str, str], ...]] = {
    "*": (("location", "리소스 위치는 만든 뒤에 바꿀 수 없습니다."),),
    PIP: (("zones", "공용 IP의 가용성 영역은 만든 뒤에 바꿀 수 없습니다."),
          ("properties.publicIPAddressVersion", "공용 IP의 IPv4/IPv6 종류는 만든 뒤에 바꿀 수 없습니다.")),
    LB: (("sku.name", "Load Balancer SKU는 제자리에서 바꿀 수 없습니다. 새로 만들어 이전해야 합니다."),
         ("sku.tier", "Load Balancer 계층(Regional/Global)은 제자리에서 바꿀 수 없습니다.")),
}
FORBIDDEN_SEGMENTS = {"id", "etag", "type", "systemData", "provisioningState", "resourceGuid"}
AZURE_ASSIGNED_PIP = {"ipAddress", "fqdn", "ipConfiguration", "natGateway", "linkedPublicIPAddress",
                      "servicePublicIPAddress", "migrationPhase"}
PEERING_REASON = ("피어링은 상대 VNet과 양방향으로 맺는 관계이고 두 VNet의 주소 공간이 겹치면 만들 수 없습니다. "
                  "상대 VNet을 끌어오지 않도록 복원·복제 대상에서 제외합니다.")
ATTACHMENT_REASON = "NIC·프라이빗 엔드포인트 같은 연결은 VNet이 소유하지 않아 함께 복원하지 않습니다."
POOL_MEMBERS_REASON = ("풀에 속한 NIC는 NIC 쪽 설정이라 풀을 복원·복제해도 따라오지 않습니다. "
                       "복제본의 새 풀에는 멤버를 따로 연결해야 합니다.")
BACKREFERENCES = ("ipConfigurations", "privateEndpoints", "resourceNavigationLinks",
                  "serviceAssociationLinks", "ipConfigurationProfiles")
LABEL = re.compile(r"^[a-z][a-z0-9-]{0,61}[a-z0-9]$")
RESOURCE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SEGMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]\[]+\])*)$")


def _norm(value: Any) -> Any:
    return value.replace(" ", "").lower() if isinstance(value, str) else value


def _get(body: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(body, dict) or part not in body:
            return None
        body = body[part]
    return body


def _put(body: JsonObject, path: str, value: Any) -> None:
    parts = path.split(".")
    for part in parts[:-1]:
        body = body.setdefault(part, {})
    body[parts[-1]] = deepcopy(value)


def _family(body: JsonObject) -> str | None:
    name = _get(body, "sku.name")
    return None if not isinstance(name, str) else "v2" if name.lower().endswith("_v2") else "v1"


def immutable_conflicts(kind: str, snapshot: JsonObject, live: JsonObject) -> list[JsonObject]:
    """Fields that an update cannot change but the backup disagrees with the live resource on."""
    conflicts: list[JsonObject] = []
    for path, reason in (*IMMUTABLE_PATHS["*"], *IMMUTABLE_PATHS.get(kind, ())):
        before, now = _get(snapshot, path), _get(live, path)
        if before is None and now is None:
            continue
        if _norm(before) != _norm(now):
            conflicts.append({"path": path, "backup": before, "current": now, "reason": reason,
                              "keepable": True})
    if kind == AGW and _family(snapshot) != _family(live):
        family: JsonObject = {
            "path": "sku.name", "backup": _get(snapshot, "sku.name"), "current": _get(live, "sku.name"),
            "keepable": False,
            "reason": "Application Gateway v1과 v2는 서로 바꿀 수 없습니다. 새 게이트웨이로 이전해야 합니다."}
        conflicts.append(family)
    return conflicts


def keep_current(body: JsonObject, live: JsonObject, conflicts: list[JsonObject]) -> list[JsonObject]:
    """Resolve immutable conflicts by leaving the live value in place and saying so."""
    if any(not item["keepable"] for item in conflicts):
        raise BackupError("바꿀 수 없는 필드 중 현재 값을 유지할 수 없는 항목이 있습니다: "
                          + ", ".join(item["path"] for item in conflicts if not item["keepable"]))
    report = []
    for item in conflicts:
        current = _get(live, item["path"])
        if current is None:
            parts = item["path"].split(".")
            parent = _get(body, ".".join(parts[:-1])) if len(parts) > 1 else body
            if isinstance(parent, dict):
                parent.pop(parts[-1], None)
        else:
            _put(body, item["path"], current)
        report.append({"path": item["path"], "change": "kept-current",
                       "reason": item["reason"] + " 현재 값을 그대로 둡니다."})
    return report


def immutable_message(conflicts: list[JsonObject]) -> str:
    return "바꿀 수 없는 필드가 백업과 다릅니다: " + "; ".join(
        f"{item['path']} (백업 {item['backup']!r} / 현재 {item['current']!r})" for item in conflicts
    ) + ". 현재 값 유지를 선택하거나 복제·재생성을 사용하세요."


def destructive_changes(kind: str, snapshot: JsonObject, live: JsonObject) -> list[str]:
    """A PUT replaces whole collections; name what the backup would silently delete."""
    if kind != VNET:
        return []
    kept = {str(item.get("name", "")).lower() for item in _get(snapshot, "properties.subnets") or []
            if isinstance(item, dict)}
    return sorted(str(item.get("name")) for item in _get(live, "properties.subnets") or []
                  if isinstance(item, dict) and str(item.get("name", "")).lower() not in kept)


def excluded_relations(kind: str, raw: JsonObject) -> list[JsonObject]:
    """What the snapshot contains but a restore or clone deliberately does not replay."""
    props = raw.get("properties", {}) if isinstance(raw.get("properties"), dict) else {}
    if kind == LB_POOL:
        listed = [item for item in props.get("loadBalancerBackendAddresses") or []
                  if isinstance(item, dict) and _get(item, "properties.networkInterfaceIPConfiguration")]
        nics = max(len(props.get("backendIPConfigurations") or []), len(listed))
        return [{"kind": "members", "path": "properties.backendIPConfigurations", "name": str(raw.get("name", "")),
                 "count": nics, "reason": POOL_MEMBERS_REASON}] if nics else []
    if kind != VNET:
        return []
    found: list[JsonObject] = []
    for index, peering in enumerate(props.get("virtualNetworkPeerings") or []):
        if not isinstance(peering, dict):
            continue
        remote = _get(peering, "properties.remoteVirtualNetwork.id")
        found.append({"kind": "peering", "path": f"properties.virtualNetworkPeerings[{index}]",
                      "name": str(peering.get("name", "")), "target": remote if isinstance(remote, str) else "",
                      "reason": PEERING_REASON})
    for subnet in props.get("subnets") or []:
        sprops = subnet.get("properties", {}) if isinstance(subnet, dict) else {}
        count = sum(len(sprops.get(field) or []) for field in BACKREFERENCES)
        if count:
            found.append({"kind": "attachment", "path": f"subnet:{subnet.get('name', '')}",
                          "name": str(subnet.get("name", "")), "count": count, "reason": ATTACHMENT_REASON})
    return found


def relation_of(target_id: str) -> str:
    """`required` targets cannot be shared between the original and a copy; the rest are optional."""
    try:
        return "required" if arm_identity(target_id)[0] in EXCLUSIVE_TARGETS else "optional"
    except BackupError:
        return "optional"


def exclusive_reference(body: object, copies: set[str]) -> str | None:
    """An ARM ID of a resource that only one consumer may hold, still referenced by a copy.

    ``copies`` are the lower-cased IDs of the clones themselves; references to those are fine.
    """
    for item in references(body):
        if item["id"].lower() in copies:
            continue
        try:
            if arm_identity(item["id"])[0] in EXCLUSIVE_TARGETS:
                return str(item["id"])
        except BackupError:
            continue
    return None


def parse_path(path: object) -> list[tuple[str, Any]]:
    if not isinstance(path, str) or not path or len(path) > 200:
        raise BackupError("변경 경로가 올바르지 않습니다.")
    tokens: list[tuple[str, Any]] = []
    for part in path.split("."):
        match = SEGMENT.fullmatch(part)
        if not match:
            raise BackupError(f"변경 경로를 해석할 수 없습니다: {path}")
        tokens.append(("key", match[1]))
        for selector in re.findall(r"\[([^\]]+)\]", match[2]):
            if selector.isdigit():
                tokens.append(("index", int(selector)))
            elif selector.startswith("name="):
                tokens.append(("name", selector[5:].lower()))
            else:
                raise BackupError(f"목록 선택자는 [0] 또는 [name=이름] 형식이어야 합니다: {path}")
    return tokens


def _walk(node: Any, tokens: list[tuple[str, Any]], path: str, *, create: bool) -> tuple[Any, tuple[str, Any]]:
    for position, (kind, value) in enumerate(tokens[:-1]):
        node = _step(node, kind, value, path, create=create and tokens[position + 1][0] == "key")
    return node, tokens[-1]


def _step(node: Any, kind: str, value: Any, path: str, *, create: bool = False) -> Any:
    if kind == "key":
        if not isinstance(node, dict):
            raise BackupError(f"변경 경로가 객체가 아닌 값을 지나갑니다: {path}")
        if value not in node:
            if not create:
                raise BackupError(f"백업 형상에 없는 경로입니다: {path}")
            node[value] = {}
        return node[value]
    if not isinstance(node, list):
        raise BackupError(f"변경 경로가 목록이 아닌 값을 선택합니다: {path}")
    if kind == "index":
        if value >= len(node):
            raise BackupError(f"목록 범위를 벗어났습니다: {path}")
        return node[value]
    matches = [item for item in node if isinstance(item, dict) and str(item.get("name", "")).lower() == value]
    if len(matches) != 1:
        raise BackupError(f"이름으로 항목을 하나 선택하지 못했습니다: {path}")
    return matches[0]


def _check_value(value: Any, path: str) -> None:
    if isinstance(value, str) and value.lower().startswith("/subscriptions/"):
        raise BackupError(f"ARM 참조는 직접 바꿀 수 없습니다. 참조 자원을 함께 복제하세요: {path}")
    if isinstance(value, dict):
        for child in value.values():
            _check_value(child, path)
    if isinstance(value, list):
        for child in value:
            _check_value(child, path)


def _check_domain(tokens: list[tuple[str, Any]], value: Any, path: str) -> None:
    last = tokens[-1][1] if tokens[-1][0] == "key" else tokens[-2][1]
    items = value if isinstance(value, list) else [value]
    try:
        if last == "domainNameLabel" and value is not None and not LABEL.fullmatch(str(value)):
            raise ValueError
        if last in {"addressPrefix", "addressPrefixes"}:
            for item in items:
                ipaddress.ip_network(item, strict=True)
        if last == "privateIPAddress" and value is not None:
            ipaddress.ip_address(value)
    except (ValueError, TypeError):
        raise BackupError(f"값 형식이 올바르지 않습니다 ({last}): {path}") from None


def apply_override(body: JsonObject, path: object, value: Any, kind: str = "") -> str:
    """Set (or, with ``None``, remove) one field of a clone body; returns the normalised path."""
    tokens = parse_path(path)
    text = str(path)
    if any(name in FORBIDDEN_SEGMENTS for part, name in tokens if part == "key"):
        raise BackupError(f"서버가 관리하는 필드는 바꿀 수 없습니다: {text}")
    if kind == PIP and any(name in AZURE_ASSIGNED_PIP for part, name in tokens if part == "key"):
        raise BackupError(f"Azure가 배정하거나 계산하는 값이라 지정할 수 없습니다: {text}")
    if any(kind == "key" and name == "name" for kind, name in tokens):
        raise BackupError(f"자원 이름은 path가 아니라 이름 변경 항목으로 지정하세요: {text}")
    _check_value(value, text)
    _check_domain(tokens, value, text)
    node, (kind, key) = _walk(body, tokens, text, create=value is not None)
    if kind != "key":
        raise BackupError(f"변경 경로는 필드 이름으로 끝나야 합니다: {text}")
    if not isinstance(node, dict):
        raise BackupError(f"변경 경로가 객체가 아닌 값을 지나갑니다: {text}")
    if value is None:
        node.pop(key, None)
    else:
        node[key] = deepcopy(value)
    return text


def validate_name(name: object) -> str:
    if not isinstance(name, str) or not RESOURCE_NAME.fullmatch(name):
        raise BackupError("새 이름은 영문·숫자로 시작하는 1~80자 (영문·숫자·_.-)여야 합니다.")
    return name


def adjust_clone(kind: str, source: JsonObject, body: JsonObject, overridden: set[str]) -> tuple[list[JsonObject], list[str]]:
    """Drop or reshape values that would collide with the original; returns (adjustments, warnings)."""
    adjustments: list[JsonObject] = []
    warnings: list[str] = []
    props = body.get("properties")
    if not isinstance(props, dict):
        return adjustments, warnings
    if (kind == PIP and isinstance(props.get("dnsSettings"), dict) and "reverseFqdn" in props["dnsSettings"]
            and "properties.dnsSettings.reverseFqdn" not in overridden):
        props["dnsSettings"].pop("reverseFqdn")
        adjustments.append({"path": "properties.dnsSettings.reverseFqdn", "change": "dropped",
                            "reason": "역방향 FQDN은 원본 FQDN을 가리켜 복제본에서는 확인에 실패합니다."})
    if kind in {LB, AGW}:
        _adjust_frontends(kind, source, body, overridden, adjustments)
    if kind in {LB, LB_POOL}:
        _new_pools(kind, body, adjustments)
    if kind == VNET:
        _check_vnet(body)
        if _get(source, "properties.addressSpace.addressPrefixes") == _get(props, "addressSpace.addressPrefixes"):
            warnings.append("원본과 주소 공간이 같아 원본(및 원본과 연결된 네트워크)과는 피어링·연결할 수 없습니다. "
                            "필요하면 properties.addressSpace.addressPrefixes와 서브넷 주소를 바꾸세요.")
    return adjustments, warnings


POOL_REASON = ("백엔드 풀은 자기 Load Balancer 안에서만 존재하고 다른 Load Balancer와 공유되지 않으므로 복제본이 새 풀을 갖습니다. "
               "멤버(NIC·IP 주소)는 NIC 쪽 설정이고 원본 풀에 이미 연결돼 있어 따라오지 않으니, 새 풀은 비워 두고 필요한 멤버를 따로 연결하세요.")


def _new_pools(kind: str, body: JsonObject, adjustments: list[JsonObject]) -> None:
    """A cloned backend pool starts empty: its members belong to the original pool."""
    pools = [(pool, f"properties.backendAddressPools[name={pool.get('name', '')}]")
             for pool in _get(body, "properties.backendAddressPools") or [] if isinstance(pool, dict)
             ] if kind == LB else [(body, "")]
    for pool, base in pools:
        pprops = pool.get("properties")
        if not isinstance(pprops, dict):
            continue
        members = pprops.pop("loadBalancerBackendAddresses", None) or []
        pprops.pop("backendIPConfigurations", None)
        if members:
            path = (base + "." if base else "") + "properties.loadBalancerBackendAddresses"
            adjustments.append({"path": path, "change": "dropped", "reason":
                                f"IP 주소 멤버 {len(members)}개를 새 풀에 넣지 않습니다. " + POOL_REASON})


def _adjust_frontends(kind: str, source: JsonObject, body: JsonObject, overridden: set[str],
                      adjustments: list[JsonObject]) -> None:
    sources = {str(item.get("name", "")).lower(): item for item in _get(source, "properties.frontendIPConfigurations") or []
               if isinstance(item, dict)}
    for frontend in _get(body, "properties.frontendIPConfigurations") or []:
        if not isinstance(frontend, dict) or not isinstance(frontend.get("properties"), dict):
            continue
        fprops, name = frontend["properties"], str(frontend.get("name", ""))
        path = f"properties.frontendIPConfigurations[name={name}].properties"
        if "privateIPAddress" not in fprops:
            continue
        origin = sources.get(name.lower(), {}).get("properties", {})
        static = str(fprops.get("privateIPAllocationMethod", "")).lower() == "static"
        shared_subnet = (str(_get(fprops, "subnet.id") or "").lower()
                         == str(_get(origin, "subnet.id") or "").lower())
        if not static:
            fprops.pop("privateIPAddress")
            adjustments.append({"path": path + ".privateIPAddress", "change": "dropped",
                                "reason": "동적 사설 IP의 현재 주소는 Azure가 배정한 값이라 복제본에서 새로 배정받습니다."})
        elif (shared_subnet and path + ".privateIPAddress" not in overridden
              and fprops.get("privateIPAddress") == origin.get("privateIPAddress")):
            if kind == AGW:
                raise BackupError(
                    f"{path}: 정적 사설 IP가 원본과 같은 서브넷에서 겹칩니다. Application Gateway v2는 정적 주소가 필요하므로 "
                    f"새 주소를 {path}.privateIPAddress 변경 항목으로 지정하세요.")
            fprops["privateIPAllocationMethod"] = "Dynamic"
            fprops.pop("privateIPAddress")
            adjustments.append({"path": path + ".privateIPAddress", "change": "dynamic",
                                "reason": "정적 사설 IP는 서브넷 안에서 하나만 쓸 수 있어 원본과 겹칩니다. 동적 배정으로 바꿉니다."})


def _check_vnet(body: JsonObject) -> None:
    spaces = [ipaddress.ip_network(item, strict=True)
              for item in _get(body, "properties.addressSpace.addressPrefixes") or []]
    seen: list[Any] = []
    for subnet in _get(body, "properties.subnets") or []:
        sprops = subnet.get("properties", {}) if isinstance(subnet, dict) else {}
        prefixes = [sprops["addressPrefix"]] if sprops.get("addressPrefix") else list(sprops.get("addressPrefixes") or [])
        for prefix in prefixes:
            network = ipaddress.ip_network(prefix, strict=True)
            if spaces and not any(network.network_address in space and network.broadcast_address in space
                                  for space in spaces):
                raise BackupError(f"서브넷 {subnet.get('name')} ({prefix})가 VNet 주소 공간 밖에 있습니다.")
            if any(network.version == other.version and network.overlaps(other) for other in seen):
                raise BackupError(f"서브넷 {subnet.get('name')} ({prefix})가 다른 서브넷과 겹칩니다.")
            seen.append(network)
