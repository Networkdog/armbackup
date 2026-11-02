from __future__ import annotations

from copy import deepcopy
from typing import Literal

from armbackup.contracts import BackupError, JsonObject, encode_json, object_value
from armbackup.resource_profiles import PROFILE_LABELS, SUPPORTED_TYPES, configuration_body
from armbackup.restore import NSG, ROUTES, project_body

VNET = "microsoft.network/virtualnetworks"
NETWORK_TYPES = {NSG, ROUTES, VNET}
TYPE_LABELS = {NSG: "Network security group", ROUTES: "Route table", VNET: "Virtual network"}
TYPE_LABELS.update({kind: label[0] for kind, label in PROFILE_LABELS.items() if kind not in TYPE_LABELS})
ComparisonStatus = Literal["same", "critical", "warning", "minor", "unknown"]


def configuration(raw: JsonObject, resource_type: str) -> JsonObject:
    if resource_type in {NSG, ROUTES}:
        return project_body(raw, resource_type)
    if resource_type != VNET:
        if resource_type in SUPPORTED_TYPES:
            return configuration_body(raw, resource_type)
        raise BackupError("No reviewed comparison profile for this resource type")
    body = {key: deepcopy(value) for key, value in raw.items()
            if key not in {"id", "name", "type", "etag", "systemData"}}
    props = object_value(body.get("properties"), "virtual network properties")
    for field in ("provisioningState", "resourceGuid"):
        props.pop(field, None)
    for subnet in props.get("subnets", []):
        subnet = object_value(subnet, "subnet")
        for field in ("id", "etag", "type"):
            subnet.pop(field, None)
        child = object_value(subnet.get("properties"), "subnet properties")
        for field in ("provisioningState", "ipConfigurations", "ipConfigurationProfiles",
                      "privateEndpoints", "applicationGatewayIPConfigurations"):
            child.pop(field, None)
    props["subnets"] = sorted(props.get("subnets", []), key=lambda item: str(item.get("name", "")))
    return body


def differences(
    before: object, after: object, path: str = "", *, limit: int = 200,
) -> tuple[list[JsonObject], bool]:
    result: list[JsonObject] = []
    truncated = False

    def add(left: object, right: object, pointer: str, left_exists: bool, right_exists: bool) -> None:
        nonlocal truncated
        if len(result) >= limit:
            truncated = True
            return
        result.append({"path": pointer or "(resource)", "before": left, "after": right,
                       "beforePresent": left_exists, "afterPresent": right_exists})

    def walk(left: object, right: object, pointer: str) -> None:
        if encode_json(left) == encode_json(right):
            return
        if isinstance(left, dict) and isinstance(right, dict):
            for name in sorted(left.keys() | right.keys()):
                target = f"{pointer}.{name}" if pointer else name
                if name not in left or name not in right:
                    add(left.get(name), right.get(name), target, name in left, name in right)
                else:
                    walk(left[name], right[name], target)
        elif isinstance(left, list) and isinstance(right, list):
            named = pointer in {"properties.securityRules", "properties.routes", "properties.subnets"}
            if named:
                for values in (left, right):
                    if (any(not isinstance(item, dict) or not isinstance(item.get("name"), str)
                            for item in values)
                            or len({item["name"].lower() for item in values}) != len(values)):
                        raise BackupError("Cannot compare missing or duplicate named child resources")
                old = {item["name"].lower(): item for item in left}
                new = {item["name"].lower(): item for item in right}
                for name in sorted(old.keys() | new.keys()):
                    target = f"{pointer}[{name}]"
                    if name not in old or name not in new:
                        add(old.get(name), new.get(name), target, name in old, name in new)
                    else:
                        walk(old[name], new[name], target)
            else:
                for index in range(max(len(left), len(right))):
                    target = f"{pointer}[{index}]"
                    if index >= len(left) or index >= len(right):
                        add(left[index] if index < len(left) else None,
                            right[index] if index < len(right) else None,
                            target, index < len(left), index < len(right))
                    else:
                        walk(left[index], right[index], target)
        else:
            add(left, right, pointer, True, True)

    walk(before, after, path)
    return result, truncated


def compare(
    snapshot: JsonObject, current: JsonObject, resource_type: str, *, complete: bool,
) -> JsonObject:
    base: JsonObject = {"diffs": [], "truncated": False, "profile": "network-v1"}
    if not complete:
        return {**base, "status": "unknown", "reason": "백업 완료 표식·무결성을 확인하지 못했습니다."}
    if snapshot.get("raw", {}).get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
        return {**base, "status": "unknown", "reason": "백업 수집 당시 리소스가 안정 상태가 아니었습니다."}
    if current.get("status") == "error":
        return {**base, "status": "unknown",
                "reason": f"현재 조회 실패 · {current.get('code', 'Unknown')}"}
    if current.get("status") == "missing" and current.get("confirmed") is True:
        return {**base, "status": "critical", "reason": "ARM에서 현재 리소스 부재를 확인했습니다.",
                "diffs": [{"path": "(resource)", "before": "백업에 있음", "after": "현재 부재 확인",
                           "beforePresent": True, "afterPresent": True}]}
    if current.get("status") != "present":
        return {**base, "status": "unknown", "reason": "현재 존재·형상을 확인하지 못했습니다."}
    if current.get("raw", {}).get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
        return {**base, "status": "unknown", "reason": "현재 프로비저닝이 진행 중이거나 실패했습니다. 완료 후 다시 조회해 주세요."}
    if snapshot.get("captureApiVersion") != current.get("apiVersion"):
        return {**base, "status": "unknown", "reason": "API 버전이 달라 비교할 수 없습니다."}
    try:
        before = configuration(object_value(snapshot.get("raw"), "snapshot raw"), resource_type)
        after = configuration(object_value(current.get("raw"), "current raw"), resource_type)
        diffs, truncated = differences(before, after)
    except BackupError as exc:
        return {**base, "status": "unknown", "reason": str(exc)}
    status: ComparisonStatus = "same"
    if diffs:
        paths = [str(item["path"]) for item in diffs]
        if all(path == "tags" or path.startswith("tags.") or path == "properties.description"
               for path in paths):
            status = "minor"
        elif any(
            (resource_type == NSG and path.startswith("properties.securityRules"))
            or any(field in path for field in (
                "publicNetworkAccess", "enableDdosProtection", "networkSecurityGroup",
                "privateEndpointNetworkPolicies",
            )) for path in paths
        ):
            status = "critical"
        else:
            status = "warning"
    if truncated:
        status = "critical" if status == "critical" else "warning"
    return {**base, "status": status, "diffs": diffs, "truncated": truncated,
            "reason": "비교 범위 내 동일" if status == "same"
            else f"{len(diffs)}개 이상의 차이 · network-v1 분류" if truncated
            else f"{len(diffs)}개 속성 차이 · network-v1 분류"}
