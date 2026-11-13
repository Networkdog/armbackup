"""Azure resource semantics that decide what a restore or clone may carry over.

A snapshot holds everything ARM returned. Replaying all of it is wrong in five ways, and each is
modelled declaratively here instead of being left to an ARM error after the safety backup:

* immutable fields (M1 family-immutable, M2 create-only immutable): set when the resource is created,
  so an update that changes them is refused or explicitly kept current;
* state-dependent fields (M3): blocked or warned depending on provisioningState, operationalState,
  attachment state (ipConfiguration, NIC pool membership), or compute power/deallocation state;
* identities that must stay unique (DNS labels, static private IPs, reverse FQDNs): a clone changes or
  drops them;
* relations that belong to another resource (VNet peerings, NIC pool backreferences): never replayed;
* attachments that only exist on one consumer (Public IP, future NIC/non-shared Disk): a clone must
  bring its own copy, while shared infrastructure (VNet/Subnet) can be validated or rebound.
"""
from __future__ import annotations

import ipaddress
import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Literal

from armbackup.contracts import BackupError, JsonObject
from armbackup.resource_profiles import (
    AFD,
    AFD_ENDPOINT,
    AFD_ORIGIN,
    AFD_ORIGIN_GROUP,
    AFD_ROUTE,
    AFD_RULE,
    AFD_RULESET,
    AFD_SECURITY,
    AGW,
    LB,
    LB_POOL,
    PIP,
    VNET,
    WAF,
    arm_identity,
    references,
)
from armbackup.restore import NSG, ROUTES

SUBNET_TYPE = VNET + "/subnets"
VM = "microsoft.compute/virtualmachines"
VM_EXT = VM + "/extensions"
VMSS = "microsoft.compute/virtualmachinescalesets"
VMSS_EXT = VMSS + "/extensions"
NIC = "microsoft.network/networkinterfaces"
DISK = "microsoft.compute/disks"

RelationClass = Literal["inline", "contained", "exclusive", "shareable", "shared-infra", "excluded"]
ExposureKind = Literal["top-level", "parent-blade"]
SupportStage = Literal["official", "companion", "legacy", "roadmap"]


@dataclass(frozen=True)
class ResourceTypeSpec:
    resource_type: str
    category: Literal["network", "compute", "edge"]
    exposure: ExposureKind
    stage: SupportStage
    contained_types: tuple[str, ...] = ()
    exclusive_types: tuple[str, ...] = ()
    shareable_types: tuple[str, ...] = ()
    shared_infra_types: tuple[str, ...] = ()
    immutable_paths: tuple[tuple[str, str], ...] = ()


COMMON_IMMUTABLE: tuple[tuple[str, str], ...] = (
    ("location", "리소스 위치는 만든 뒤에 바꿀 수 없습니다."),
    ("extendedLocation.name", "엣지 영역(Extended Location)은 만든 뒤에 바꿀 수 없습니다."),
)

RESOURCE_SPECS: dict[str, ResourceTypeSpec] = {
    AGW: ResourceTypeSpec(
        resource_type=AGW, category="network", exposure="top-level", stage="official",
        exclusive_types=(PIP,), shareable_types=(WAF,), shared_infra_types=(SUBNET_TYPE,),
        immutable_paths=(
            ("zones", "Application Gateway의 가용성 영역 구성은 만든 뒤에 바꿀 수 없습니다. 새 게이트웨이로 배포해야 합니다."),
            ("properties.enableFips", "Application Gateway의 FIPS 모드는 만든 뒤에 바꿀 수 없습니다."),
        ),
    ),
    LB: ResourceTypeSpec(
        resource_type=LB, category="network", exposure="top-level", stage="official",
        contained_types=(LB_POOL,), exclusive_types=(PIP,), shared_infra_types=(VNET, SUBNET_TYPE),
        immutable_paths=(
            ("sku.name", "Load Balancer SKU는 제자리에서 바꿀 수 없습니다. 새로 만들어 이전해야 합니다."),
            ("sku.tier", "Load Balancer 계층(Regional/Global)은 제자리에서 바꿀 수 없습니다."),
        ),
    ),
    LB_POOL: ResourceTypeSpec(
        resource_type=LB_POOL, category="network", exposure="parent-blade", stage="companion",
        shared_infra_types=(VNET,),
    ),
    PIP: ResourceTypeSpec(
        resource_type=PIP, category="network", exposure="top-level", stage="companion",
        immutable_paths=(
            ("zones", "공용 IP의 가용성 영역은 만든 뒤에 바꿀 수 없습니다."),
            ("properties.publicIPAddressVersion", "공용 IP의 IPv4/IPv6 종류는 만든 뒤에 바꿀 수 없습니다."),
            ("sku.tier", "공용 IP 계층(Regional/Global)은 만든 뒤에 바꿀 수 없습니다."),
            ("properties.publicIPPrefix.id", "공용 IP 접두사(Public IP Prefix) 연결은 만든 뒤에 바꿀 수 없습니다."),
            ("properties.ipTags", "공용 IP의 라우팅 선호도 및 IP 태그(ipTags)는 만든 뒤에 바꿀 수 없습니다."),
        ),
    ),
    WAF: ResourceTypeSpec(
        resource_type=WAF, category="network", exposure="top-level", stage="companion",
    ),
    VNET: ResourceTypeSpec(
        resource_type=VNET, category="network", exposure="top-level", stage="legacy",
    ),
    NSG: ResourceTypeSpec(
        resource_type=NSG, category="network", exposure="top-level", stage="legacy",
    ),
    ROUTES: ResourceTypeSpec(
        resource_type=ROUTES, category="network", exposure="top-level", stage="legacy",
    ),
    AFD: ResourceTypeSpec(
        resource_type=AFD, category="edge", exposure="top-level", stage="legacy",
        contained_types=(AFD_ENDPOINT, AFD_ORIGIN_GROUP, AFD_ORIGIN, AFD_ROUTE, AFD_RULESET, AFD_RULE, AFD_SECURITY),
    ),
    VM: ResourceTypeSpec(
        resource_type=VM, category="compute", exposure="top-level", stage="roadmap",
        contained_types=(VM_EXT,), exclusive_types=(NIC, DISK),
        shareable_types=(NSG,), shared_infra_types=(SUBNET_TYPE,),
        immutable_paths=(
            ("zones", "Virtual Machine의 가용성 영역은 일반 업데이트로 바꿀 수 없습니다."),
            ("properties.availabilitySet.id", "가용성 집합(Availability Set)은 VM 생성 시에만 지정할 수 있습니다."),
            ("properties.osProfile.computerName", "OS 호스트 이름(computerName)은 생성 이후 제어 평면에서 바꿀 수 없습니다."),
            ("properties.osProfile.adminUsername", "관리자 계정 이름(adminUsername)은 생성 이후 바꿀 수 없습니다."),
        ),
    ),
    VMSS: ResourceTypeSpec(
        resource_type=VMSS, category="compute", exposure="top-level", stage="roadmap",
        contained_types=(VMSS_EXT,), shareable_types=(NSG,), shared_infra_types=(SUBNET_TYPE, LB_POOL),
        immutable_paths=(
            ("properties.platformFaultDomainCount", "확장 집합의 장애 도메인 수(platformFaultDomainCount)는 만든 뒤에 바꿀 수 없습니다."),
        ),
    ),
    NIC: ResourceTypeSpec(
        resource_type=NIC, category="network", exposure="top-level", stage="roadmap",
        exclusive_types=(PIP,), shareable_types=(NSG,), shared_infra_types=(SUBNET_TYPE, LB_POOL),
    ),
    DISK: ResourceTypeSpec(
        resource_type=DISK, category="compute", exposure="top-level", stage="roadmap",
        immutable_paths=(
            ("zones", "관리 디스크의 가용성 영역은 만든 뒤에 바꿀 수 없습니다."),
            ("properties.creationData.createOption", "디스크 생성 원본 옵션(createOption)은 만든 뒤에 바꿀 수 없습니다."),
        ),
    ),
}

EXCLUSIVE_TARGETS = {PIP, NIC, DISK}
REBINDABLE_SHARED_TYPES = {VNET, SUBNET_TYPE, WAF, NSG, ROUTES}
IMMUTABLE_PATHS: dict[str, tuple[tuple[str, str], ...]] = {
    "*": COMMON_IMMUTABLE,
    **{kind: spec.immutable_paths for kind, spec in RESOURCE_SPECS.items() if spec.immutable_paths},
}
FORBIDDEN_SEGMENTS = {"id", "etag", "type", "systemData", "provisioningState", "resourceGuid", "operationalState"}
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
LOCATION_NAME = re.compile(r"^[a-z0-9][a-z0-9 -]{1,48}[a-z0-9]$", re.IGNORECASE)
RESOURCE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SEGMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]\[]+\])*)$")
IN_PROGRESS_PROVISIONING = {"Updating", "Deleting", "Creating", "Moving"}
RECOVERABLE_FAILED_PROVISIONING = {"Failed", "Canceled"}


def exposure_of(kind: str) -> ExposureKind:
    spec = RESOURCE_SPECS.get(kind.lower())
    if spec is not None:
        return spec.exposure
    parts = kind.lower().split("/")
    return "parent-blade" if len(parts) > 2 else "top-level"


def relation_class_of(source_kind: str, target_id: str, *, in_inventory: bool, contained: bool = False) -> RelationClass:
    if contained:
        return "contained"
    try:
        target_kind = arm_identity(target_id)[0]
    except BackupError:
        return "shared-infra"
    if target_kind in EXCLUSIVE_TARGETS:
        return "exclusive"
    spec = RESOURCE_SPECS.get(source_kind.lower())
    if spec and target_kind in spec.shared_infra_types and not in_inventory:
        return "shared-infra"
    return "shareable" if in_inventory else "shared-infra"


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


def _agw_sku(body: JsonObject) -> tuple[str, str | None]:
    nested = _get(body, "properties.sku.name")
    if isinstance(nested, str):
        return "properties.sku.name", nested
    top = _get(body, "sku.name")
    return "sku.name", top if isinstance(top, str) else None


def _family(body: JsonObject) -> str | None:
    _, name = _agw_sku(body)
    return None if not isinstance(name, str) else "v2" if name.lower().endswith("_v2") else "v1"


def _same_immutable_value(path: str, before: Any, now: Any) -> bool:
    if path == "zones":
        left = sorted(str(item) for item in (before or [])) if isinstance(before, list) or before is None else [str(before)]
        right = sorted(str(item) for item in (now or [])) if isinstance(now, list) or now is None else [str(now)]
        return left == right
    if path == "properties.ipTags":
        def norm_tags(items: Any) -> list[tuple[str, str]]:
            if not items:
                return []
            if not isinstance(items, list):
                return [(str(items), "")]
            return sorted((str(tag.get("ipTagType", "")).lower(), str(tag.get("tag", "")))
                          for tag in items if isinstance(tag, dict))
        return norm_tags(before) == norm_tags(now)
    if path.endswith(".id"):
        return str(before or "").lower() == str(now or "").lower()
    return bool(_norm(before) == _norm(now))


def _has_static_private_frontend(body: JsonObject) -> bool:
    for item in _get(body, "properties.frontendIPConfigurations") or []:
        if isinstance(item, dict):
            props = item.get("properties", {})
            if isinstance(props, dict) and _norm(props.get("privateIPAllocationMethod")) == "static" and props.get("privateIPAddress"):
                return True
    return False


def immutable_conflicts(
    kind: str, snapshot: JsonObject, live: JsonObject, live_raw: JsonObject | None = None,
) -> list[JsonObject]:
    """Fields that an update cannot change (create-only M1/M2 or attachment/state-locked M3)."""
    conflicts: list[JsonObject] = []
    seen_paths: set[str] = set()

    def add_conflict(path: str, before: Any, now: Any, reason: str, *, keepable: bool) -> None:
        if path in seen_paths:
            return
        seen_paths.add(path)
        conflicts.append({"path": path, "backup": before, "current": now, "reason": reason,
                          "keepable": keepable})

    for path, reason in (*IMMUTABLE_PATHS["*"], *IMMUTABLE_PATHS.get(kind, ())):
        before, now = _get(snapshot, path), _get(live, path)
        if before is None and now is None:
            continue
        if not _same_immutable_value(path, before, now):
            add_conflict(path, before, now, reason, keepable=True)

    if kind == AGW:
        snap_path, snap_sku = _agw_sku(snapshot)
        live_path, live_sku = _agw_sku(live)
        if snap_sku is not None and live_sku is not None and _family(snapshot) != _family(live):
            path = snap_path if snap_path == live_path else "properties.sku.name"
            add_conflict(
                path, snap_sku, live_sku, keepable=False,
                reason="Application Gateway v1과 v2는 서로 바꿀 수 없습니다. 새 게이트웨이로 이전해야 합니다.",
            )
        live_gw_ips = {str(item.get("name", "")).lower(): _get(item, "properties.subnet.id")
                       for item in _get(live, "properties.gatewayIPConfigurations") or [] if isinstance(item, dict)}
        for item in _get(snapshot, "properties.gatewayIPConfigurations") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", ""))
            snap_sub = _get(item, "properties.subnet.id")
            live_sub = live_gw_ips.get(name.lower())
            if not isinstance(snap_sub, str) or not isinstance(live_sub, str) or snap_sub.lower() == live_sub.lower():
                continue
            gw_path = f"properties.gatewayIPConfigurations[name={name}].properties.subnet.id"
            snap_vnet = snap_sub.rsplit("/subnets/", 1)[0].lower()
            live_vnet = live_sub.rsplit("/subnets/", 1)[0].lower()
            if snap_vnet != live_vnet:
                add_conflict(gw_path, snap_sub, live_sub, keepable=False,
                             reason="Application Gateway가 연결된 가상 네트워크(VNet)는 만든 뒤에 바꿀 수 없습니다.")
            elif _has_static_private_frontend(snapshot) or _has_static_private_frontend(live):
                add_conflict(gw_path, snap_sub, live_sub, keepable=False,
                             reason="정적 사설 프런트엔드 IP를 사용하는 Application Gateway는 다른 서브넷으로 이동할 수 없습니다.")
            elif _norm(_get(live_raw or {}, "properties.operationalState")) == "running":
                add_conflict(
                    gw_path, snap_sub, live_sub, keepable=False,
                    reason="실행 중(Running)인 Application Gateway는 서브넷을 변경할 수 없습니다. 게이트웨이를 중지(Stopped)한 뒤 다시 검토하세요.",
                )

    if kind == PIP:
        attached = bool(_get(live_raw or {}, "properties.ipConfiguration.id")
                        or _get(live_raw or {}, "properties.ipConfiguration"))
        snap_sku, live_sku = _get(snapshot, "sku.name"), _get(live, "sku.name")
        if isinstance(snap_sku, str) and isinstance(live_sku, str) and _norm(snap_sku) != _norm(live_sku):
            if _norm(live_sku) == "standard" and _norm(snap_sku) == "basic":
                add_conflict("sku.name", snap_sku, live_sku, keepable=True,
                             reason="Standard SKU 공용 IP는 Basic SKU로 되돌릴 수 없습니다.")
            elif "standardv2" in {_norm(snap_sku), _norm(live_sku)}:
                add_conflict("sku.name", snap_sku, live_sku, keepable=True,
                             reason="Standardv2 공용 IP SKU는 만든 뒤에 다른 SKU로 바꿀 수 없습니다.")
            elif attached:
                add_conflict("sku.name", snap_sku, live_sku, keepable=True,
                             reason="다른 리소스에 연결된 공용 IP는 연결을 해제하기 전까지 SKU를 변경할 수 없습니다.")
        snap_alloc = _get(snapshot, "properties.publicIPAllocationMethod")
        live_alloc = _get(live, "properties.publicIPAllocationMethod")
        if isinstance(snap_alloc, str) and isinstance(live_alloc, str) and _norm(snap_alloc) != _norm(live_alloc):
            if _norm(live_sku) in {"standard", "standardv2"} and _norm(snap_alloc) == "dynamic":
                add_conflict("properties.publicIPAllocationMethod", snap_alloc, live_alloc, keepable=True,
                             reason="Standard SKU 공용 IP는 정적(Static) 할당만 지원합니다.")
            elif attached:
                add_conflict(
                    "properties.publicIPAllocationMethod", snap_alloc, live_alloc, keepable=True,
                    reason="현재 프런트엔드나 NIC에 연결된 공용 IP는 연결을 해제하기 전까지 할당 방식(Static/Dynamic)을 바꿀 수 없습니다.",
                )

    if kind == LB:
        live_fes = {str(item.get("name", "")).lower(): item
                    for item in _get(live, "properties.frontendIPConfigurations") or [] if isinstance(item, dict)}
        for item in _get(snapshot, "properties.frontendIPConfigurations") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", ""))
            live_fe = live_fes.get(name.lower())
            if not live_fe:
                continue
            for ref_field in ("publicIPAddress", "subnet"):
                snap_ref = _get(item, f"properties.{ref_field}.id")
                live_ref = _get(live_fe, f"properties.{ref_field}.id")
                if isinstance(snap_ref, str) and isinstance(live_ref, str):
                    snap_parts, live_parts = snap_ref.split("/"), live_ref.split("/")
                    if len(snap_parts) > 2 and len(live_parts) > 2 and snap_parts[2].lower() != live_parts[2].lower():
                        add_conflict(
                            f"properties.frontendIPConfigurations[name={name}].properties.{ref_field}.id",
                            snap_ref, live_ref, keepable=False,
                            reason="Load Balancer 프런트엔드 IP 구성의 참조 구독은 만든 뒤에 바꿀 수 없습니다.",
                        )

    if kind == VMSS:
        snap_mode, live_mode = _get(snapshot, "properties.orchestrationMode"), _get(live, "properties.orchestrationMode")
        if snap_mode is not None and live_mode is not None and _norm(snap_mode) != _norm(live_mode):
            add_conflict("properties.orchestrationMode", snap_mode, live_mode, keepable=False,
                         reason="Virtual Machine Scale Set의 오케스트레이션 모드(Uniform/Flexible)는 만든 뒤에 바꿀 수 없습니다.")
        snap_spg, live_spg = _get(snapshot, "properties.singlePlacementGroup"), _get(live, "properties.singlePlacementGroup")
        if live_spg is False and snap_spg is True:
            add_conflict("properties.singlePlacementGroup", snap_spg, live_spg, keepable=True,
                         reason="다중 배치 그룹(singlePlacementGroup=false) 확장 집합은 단일 배치 그룹(true)으로 되돌릴 수 없습니다.")

    return conflicts


def inspect_runtime_state(kind: str, live_raw: JsonObject, mode: str,
                          snapshot: JsonObject | None = None) -> tuple[str | None, list[str]]:
    """Evaluate control-plane and operational state before preparing an update/restore."""
    warnings: list[str] = []
    props = live_raw.get("properties", {}) if isinstance(live_raw.get("properties"), dict) else {}
    provisioning = props.get("provisioningState")
    if provisioning not in {None, "Succeeded"}:
        if provisioning in RECOVERABLE_FAILED_PROVISIONING and mode == "update":
            warnings.append(
                f"현재 리소스의 프로비저닝 상태가 {provisioning}입니다. 검증된 백업 형상을 다시 적용해 목표 상태 복구를 시도합니다."
            )
        else:
            return f"wait for stable provisioning ({provisioning})", []
    if kind == AGW:
        op_state = props.get("operationalState")
        if op_state in {"Starting", "Stopping"}:
            return f"wait for stable provisioning: Application Gateway가 {op_state} 전이 중입니다.", []
        if mode == "update" and op_state == "Stopped":
            warnings.append(
                "현재 중지(Stopped) 상태인 Application Gateway입니다. 복원(PUT)을 실행하면 Azure 동작에 의해 게이트웨이가 자동으로 시작(Running)됩니다."
            )
    if kind == VM and mode == "update" and snapshot is not None:
        statuses = [str(s.get("code", "")).lower()
                    for s in _get(live_raw, "properties.instanceView.statuses") or [] if isinstance(s, dict)]
        running = any(code == "powerstate/running" or code == "powerstate/stopped" for code in statuses)
        deallocated = any(code == "powerstate/deallocated" for code in statuses)
        if running and not deallocated:
            if _norm(_get(snapshot, "properties.hardwareProfile.vmSize")) != _norm(_get(live_raw, "properties.hardwareProfile.vmSize")):
                warnings.append("실행 중인 Virtual Machine의 크기(vmSize)를 변경하면 재부팅이 발생하며, 현재 클러스터가 지원하지 않는 크기는 할당 해제(Deallocate)가 필요합니다.")
            for host_field in ("properties.host.id", "properties.hostGroup.id", "properties.proximityPlacementGroup.id"):
                if str(_get(snapshot, host_field) or "").lower() != str(_get(live_raw, host_field) or "").lower():
                    return "Virtual Machine의 호스트·근접 배치 그룹을 변경하려면 먼저 할당 해제(Stopped deallocated) 상태여야 합니다.", []
    return None, warnings


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


def destructive_changes(
    kind: str, snapshot: JsonObject, live: JsonObject, live_raw: JsonObject | None = None,
) -> list[str]:
    """A PUT replaces whole collections; name what the backup would silently delete or break."""
    if kind == VNET:
        kept = {str(item.get("name", "")).lower() for item in _get(snapshot, "properties.subnets") or []
                if isinstance(item, dict)}
        return sorted(str(item.get("name")) for item in _get(live, "properties.subnets") or []
                      if isinstance(item, dict) and str(item.get("name", "")).lower() not in kept)
    if kind == LB and live_raw is not None:
        kept_pools = {str(item.get("name", "")).lower()
                      for item in _get(snapshot, "properties.backendAddressPools") or []
                      if isinstance(item, dict)}
        in_use_lost: list[str] = []
        for pool in _get(live_raw, "properties.backendAddressPools") or []:
            if not isinstance(pool, dict):
                continue
            pname = str(pool.get("name", ""))
            if pname.lower() in kept_pools:
                continue
            pprops = pool.get("properties", {}) if isinstance(pool.get("properties"), dict) else {}
            has_nics = bool(pprops.get("backendIPConfigurations")) or any(
                isinstance(addr, dict) and _get(addr, "properties.networkInterfaceIPConfiguration")
                for addr in pprops.get("loadBalancerBackendAddresses") or []
            )
            if has_nics:
                in_use_lost.append(pname)
        return sorted(in_use_lost)
    return []


def destructive_message(kind: str, lost: list[str]) -> str:
    joined = ", ".join(lost)
    if kind == LB:
        return (f"이 복원은 현재 NIC가 연결된 백엔드 풀을 삭제하려 하므로 안전하지 않습니다 ({joined}). "
                "연결된 NIC를 먼저 분리하거나 해당 풀이 포함된 백업을 선택하세요.")
    return (f"이 복원은 백업에 없는 서브넷을 삭제합니다 ({joined}). "
            "백업 이후 만든 서브넷을 먼저 정리하거나 새 백업을 사용하세요.")


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


def validate_location(location: object) -> str:
    if not isinstance(location, str) or not LOCATION_NAME.fullmatch(location.strip()):
        raise BackupError("대상 리전 형식이 올바르지 않습니다 (예: koreacentral, koreasouth).")
    return location.strip().replace(" ", "").lower()


def normalize_reference_bindings(items: object) -> dict[str, str]:
    """Validate explicit shared-infrastructure rebindings for clone mode."""
    if items is None:
        return {}
    if not isinstance(items, list) or len(items) > 50:
        raise BackupError("공유 리소스 연결 매핑(referenceBindings)은 최대 50개 목록이어야 합니다.")
    bindings: dict[str, str] = {}
    for entry in items:
        if not isinstance(entry, dict) or set(entry) - {"sourceId", "targetId"}:
            raise BackupError("공유 리소스 연결 매핑에는 sourceId와 targetId가 필요합니다.")
        source_id, target_id = entry.get("sourceId"), entry.get("targetId")
        if not isinstance(source_id, str) or not isinstance(target_id, str) or not source_id or not target_id:
            raise BackupError("공유 리소스 연결 매핑의 ARM 리소스 ID가 비어 있습니다.")
        source_kind, _, _ = arm_identity(source_id)
        target_kind, _, _ = arm_identity(target_id)
        if source_kind != target_kind:
            raise BackupError(f"공유 리소스 연결 매핑의 종류가 서로 다릅니다: {source_kind} -> {target_kind}")
        if source_kind in EXCLUSIVE_TARGETS:
            raise BackupError("1:1 전용 리소스(공용 IP 등)는 기존 리소스로 공유 연결할 수 없습니다. 함께 복제하세요.")
        if source_kind not in REBINDABLE_SHARED_TYPES:
            raise BackupError(f"지원하지 않는 공유 리소스 바인딩 종류입니다: {source_kind}")
        key = source_id.lower()
        if key in bindings and bindings[key].lower() != target_id.lower():
            raise BackupError(f"동일한 원본 참조에 서로 다른 대상이 중복 지정되었습니다: {source_id}")
        if key != target_id.lower():
            bindings[key] = target_id
    return bindings


def clone_hints(kind: str, body: JsonObject | None) -> JsonObject:
    """Structured non-secret hints so the UI can surface contextual clone fields without raw JSON paths."""
    if not isinstance(body, dict):
        return {}
    hints: JsonObject = {}
    if kind == PIP:
        label = _get(body, "properties.dnsSettings.domainNameLabel")
        if isinstance(label, str) and label:
            hints["dnsLabel"] = label
    if kind in {AGW, LB}:
        frontends: list[JsonObject] = []
        for item in _get(body, "properties.frontendIPConfigurations") or []:
            if not isinstance(item, dict) or not isinstance(item.get("properties"), dict):
                continue
            fprops = item["properties"]
            if (_norm(fprops.get("privateIPAllocationMethod")) == "static"
                    and isinstance(fprops.get("privateIPAddress"), str) and fprops["privateIPAddress"]):
                frontends.append({
                    "name": str(item.get("name", "")),
                    "privateIPAddress": fprops["privateIPAddress"],
                    "subnetId": str(_get(fprops, "subnet.id") or ""),
                    "requiresStatic": kind == AGW,
                })
        if frontends:
            hints["staticFrontends"] = frontends
    return hints


def validate_subnet_ips(kind: str, body: JsonObject, subnet_prefixes: dict[str, list[str]]) -> None:
    """Verify static frontend private IPs belong to the bound/shared subnet CIDR when known."""
    if kind not in {AGW, LB}:
        return
    for item in _get(body, "properties.frontendIPConfigurations") or []:
        if not isinstance(item, dict) or not isinstance(item.get("properties"), dict):
            continue
        fprops = item["properties"]
        if _norm(fprops.get("privateIPAllocationMethod")) != "static":
            continue
        raw_ip = fprops.get("privateIPAddress")
        subnet_id = str(_get(fprops, "subnet.id") or "").lower()
        cidrs = subnet_prefixes.get(subnet_id)
        if not isinstance(raw_ip, str) or not cidrs:
            continue
        addr = ipaddress.ip_address(raw_ip)
        networks = [ipaddress.ip_network(cidr, strict=False) for cidr in cidrs]
        matching = [net for net in networks if addr.version == net.version and addr in net]
        if not matching:
            raise BackupError(
                f"프런트엔드 '{item.get('name')}'의 정적 사설 IP({raw_ip})가 대상 서브넷 대역({', '.join(cidrs)}) 밖에 있습니다."
            )
        for net in matching:
            if net.version == 4 and net.prefixlen <= 29 and addr in {net.network_address, net.broadcast_address}:
                raise BackupError(
                    f"프런트엔드 '{item.get('name')}'의 정적 사설 IP({raw_ip})는 서브넷 예약 주소(네트워크/브로드캐스트)여서 사용할 수 없습니다."
                )


def drop_cross_boundary_pool_vnet(
    kind: str, body: JsonObject, *, target_subscription: str, target_location: str,
    cloned_or_rebound: set[str], adjustments: list[JsonObject], source_location: str = "",
) -> None:
    """An empty cloned LB backend pool should not retain an un-rebound foreign-subscription/region VNet."""
    if kind not in {LB, LB_POOL}:
        return
    pools = [(pool, f"properties.backendAddressPools[name={pool.get('name', '')}]")
             for pool in _get(body, "properties.backendAddressPools") or [] if isinstance(pool, dict)
             ] if kind == LB else [(body, "")]
    location_moved = bool(source_location and target_location and _norm(source_location) != _norm(target_location))
    for pool, base in pools:
        pprops = pool.get("properties")
        if not isinstance(pprops, dict) or pprops.get("loadBalancerBackendAddresses"):
            continue
        vnet_id = _get(pprops, "virtualNetwork.id")
        if not isinstance(vnet_id, str) or vnet_id.lower() in cloned_or_rebound:
            continue
        parts = vnet_id.split("/")
        vnet_sub = parts[2].lower() if len(parts) > 2 else ""
        if (target_subscription and vnet_sub and vnet_sub != target_subscription.lower()) or location_moved:
            pprops.pop("virtualNetwork", None)
            path = (base + "." if base else "") + "properties.virtualNetwork"
            adjustments.append({
                "path": path, "change": "dropped",
                "reason": "비어 있는 새 백엔드 풀이 원본 구독·리전의 VNet에 묶이지 않도록 기존 VNet 참조를 제외합니다.",
            })


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
        elif shared_subnet and fprops.get("privateIPAddress") == origin.get("privateIPAddress"):
            if path + ".privateIPAddress" in overridden:
                raise BackupError(
                    f"{path}: 지정한 정적 사설 IP({fprops.get('privateIPAddress')})가 원본과 같은 서브넷에서 겹칩니다. 다른 주소를 지정하세요.")
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
