from __future__ import annotations

import re
from copy import deepcopy

from armbackup.azure_semantics import (
    adjust_clone,
    apply_override,
    clone_hints,
    drop_cross_boundary_pool_vnet,
    excluded_relations,
    exposure_of,
    relation_class_of,
    relation_of,
    validate_location,
    validate_name,
)
from armbackup.contracts import BackupError, JsonObject, digest, encode_json
from armbackup.resource_profiles import (
    AFD,
    AFD_ORIGIN,
    AFD_ORIGIN_GROUP,
    AFD_ROUTE,
    AFD_RULE,
    AFD_RULESET,
    AGW,
    LB,
    LB_POOL,
    PIP,
    PROFILE_LABELS,
    SUPPORTED_TYPES,
    arm_identity,
    references,
    restore_body,
    snapshot_tags,
)


def dependency_owner(reference_id: str, identifiers: set[str]) -> str | None:
    candidates = [identifier for identifier in identifiers
                  if reference_id.lower() == identifier
                  or reference_id.lower().startswith(identifier + "/")]
    return max(candidates, key=len) if candidates else None


def clone_targets(graph: JsonObject, selected: list[str], prefix: str | None,
                  target_scope: str | None = None, names: dict[str, str] | None = None,
                  overrides: dict[str, list[JsonObject]] | None = None,
                  reference_bindings: dict[str, str] | None = None,
                  target_location: str | None = None) -> dict[str, JsonObject]:
    """Map each selected resource to its clone.

    With ``target_scope`` (``/subscriptions/<id>/resourceGroups/<name>``) the clones are created in that
    group and the name prefix is optional; without it the prefix is what keeps the clone apart from the original.
    ``names`` renames a top-level clone (no prefix is added to it), ``overrides`` sets fields on a clone body,
    ``reference_bindings`` rebinds external shared references (such as VNet/Subnet) to target-environment IDs,
    and ``target_location`` moves regional resources in lockstep.
    """
    if prefix is None and target_scope is None:
        raise BackupError("Clone requires an explicit target name prefix")
    if prefix is not None and (not isinstance(prefix, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,19}", prefix)):
        raise BackupError("Clone prefix must be 2..20 lowercase letters/digits/hyphens")
    if target_scope is not None and not re.fullmatch(r"/subscriptions/[^/]+/resourceGroups/[^/]+", target_scope):
        raise BackupError("Clone target scope must be a subscription resource group")
    desired_location = validate_location(target_location) if target_location else ""
    bindings = {key.lower(): value for key, value in (reference_bindings or {}).items()}
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    selected_keys = {identifier.lower() for identifier in selected}
    renames = {key.lower(): value for key, value in (names or {}).items()}
    changes = {key.lower(): value for key, value in (overrides or {}).items()}
    for key in renames.keys() | changes.keys():
        if key not in selected_keys:
            raise BackupError("이름·값을 바꾸려는 자원이 복제 대상에 없습니다.")
    for key in renames:
        if arm_identity(nodes[key]["id"])[2]:
            raise BackupError("하위 리소스 이름은 따로 바꿀 수 없습니다. 부모 이름을 바꾸면 함께 바뀝니다.")
    mapping: dict[str, str] = {}
    for identifier in sorted(selected, key=lambda value: len(value.split("/"))):
        kind, name, parent = arm_identity(identifier)
        if parent:
            if parent.lower() not in mapping:
                raise BackupError("Cloning a child requires its selected parent: 하위 리소스(예: 백엔드 풀)는 부모 안에서만 "
                                  "존재하므로 단독으로 복제할 수 없습니다. 부모 리소스를 선택하면 함께 복제됩니다.")
            target = mapping[parent.lower()] + identifier[len(parent):]
        else:
            if identifier.lower() in renames:
                new_name = validate_name(renames[identifier.lower()])
            else:
                new_name = prefix + "-" + name if prefix else name
                if len(new_name) > 60:
                    raise BackupError("Expanded clone resource name exceeds the reviewed 60-character bound")
            base = identifier.rsplit("/", 1)[0]
            if target_scope is not None:
                base = target_scope + "/" + base.split("/", 5)[5]
            target = base + "/" + new_name
        mapping[identifier.lower()] = target
    if len(set(value.lower() for value in mapping.values())) != len(mapping) or any(
            target.lower() in selected_keys for target in mapping.values()):
        raise BackupError("Clone targets overlap original selected resources")

    def remap(value: object, path: str, rebound: list[tuple[str, str]]) -> object:
        if isinstance(value, dict):
            return {key: remap(child, f"{path}.{key}" if path else key, rebound) for key, child in value.items()}
        if isinstance(value, list):
            return [remap(child, f"{path}[{idx}]", rebound) for idx, child in enumerate(value)]
        if isinstance(value, str) and value.lower().startswith("/subscriptions/"):
            owner = dependency_owner(value, selected_keys)
            if owner:
                return mapping[owner] + value[len(nodes[owner]["id"]):]
            if not path.startswith("tags"):
                bound_owner = dependency_owner(value, set(bindings))
                if bound_owner:
                    rewritten = bindings[bound_owner] + value[len(bound_owner):]
                    rebound.append((path, rewritten))
                    return rewritten
        return deepcopy(value)

    cloned_or_rebound = {val.lower() for val in mapping.values()} | {val.lower() for val in bindings.values()}
    result: dict[str, JsonObject] = {}
    for key, target in mapping.items():
        node = nodes[key]
        rebound_entries: list[tuple[str, str]] = []
        body = remap(node["body"], "", rebound_entries)
        if not isinstance(body, dict):
            raise BackupError("Clone source has no reviewed body")
        if "tags" in node["body"]:
            body["tags"] = deepcopy(node["body"]["tags"])
        overridden: set[str] = set()
        adjustments: list[JsonObject] = [
            {"path": ref_path, "change": "rebound",
             "reason": f"복제 대상 환경의 공유 리소스({new_ref.rsplit('/', 1)[-1]})로 연결 대상을 바꿉니다."}
            for ref_path, new_ref in rebound_entries
        ]
        for change in changes.get(key, []):
            path = apply_override(body, change["path"], change.get("value"), node["resourceType"])
            overridden.add(path)
            adjustments.append({"path": path, "change": "overridden",
                                "reason": "복제할 때 사용자가 지정한 값으로 바꿉니다."})
        if (desired_location and "location" not in overridden
                and isinstance(body.get("location"), str)
                and body["location"].lower() != "global"
                and body["location"].replace(" ", "").lower() != desired_location):
            body["location"] = desired_location
            adjustments.append({"path": "location", "change": "overridden",
                                "reason": "복제 대상 리전으로 일괄 변경합니다."})
        label = body.get("properties", {}).get("dnsSettings", {}).get("domainNameLabel")
        if (node["resourceType"] == PIP and label
                and "properties.dnsSettings.domainNameLabel" not in overridden):
            if not prefix:
                raise BackupError("A public IP DNS label is unique per region; clone it with a name prefix "
                                  "or set properties.dnsSettings.domainNameLabel")
            label = prefix + "-" + label
            if len(label) > 63:
                raise BackupError("Expanded clone DNS label exceeds 63 characters")
            body["properties"]["dnsSettings"]["domainNameLabel"] = label
            adjustments.append({"path": "properties.dnsSettings.domainNameLabel", "change": "renamed",
                                "reason": "DNS 이름 레이블은 같은 지역 안에서 모든 구독에 걸쳐 하나뿐이어야 해서 접두사를 붙입니다."})
        more, warnings = adjust_clone(node["resourceType"], node["body"], body, overridden)
        adjustments.extend(more)
        parent_key = str(node.get("parentId") or "").lower()
        source_loc = str(node["body"].get("location") or (nodes.get(parent_key, {}).get("location") or ""))
        effective_loc = str(body.get("location") or (result.get(parent_key, {}).get("body", {}).get("location") or desired_location or source_loc))
        target_sub = target.split("/")[2] if target.startswith("/subscriptions/") else ""
        drop_cross_boundary_pool_vnet(
            node["resourceType"], body,
            target_subscription=target_sub, target_location=effective_loc,
            cloned_or_rebound=cloned_or_rebound, adjustments=adjustments, source_location=source_loc,
        )
        warnings += [f"{item['name']}: NIC {item['count']}개가 속한 원본 풀입니다. {item['reason']}"
                     for item in node.get("excluded", []) if item["kind"] == "members"]
        result[key] = {"resourceId": target, "body": body, "adjustments": adjustments,
                       "warnings": warnings}
    return result


def topology(envelopes: list[JsonObject]) -> JsonObject:
    nodes: dict[str, JsonObject] = {}
    addresses: list[JsonObject] = []
    for envelope in envelopes:
        resource_id = envelope["resourceId"]
        kind, name, parent = arm_identity(resource_id)
        raw = envelope["raw"]
        body = None
        error = ""
        try:
            body = restore_body(raw, kind)
        except BackupError as exc:
            error = str(exc)
        tags = snapshot_tags(envelope)
        nodes[resource_id.lower()] = {
            "id": resource_id, "name": name, "resourceType": kind,
            "label": PROFILE_LABELS.get(kind, (kind, "box"))[0],
            "icon": PROFILE_LABELS.get(kind, (kind, "box"))[1],
            "exposure": exposure_of(kind),
            "location": raw.get("location") if isinstance(raw.get("location"), str) else "",
            "cloneHints": clone_hints(kind, body),
            "parentId": parent, "tags": tags, "body": body,
            "restoreSupported": body is not None, "blockedReason": error,
            "captureApiVersion": envelope["captureApiVersion"],
            "excluded": excluded_relations(kind, raw),
        }
        if body is not None and kind in {AGW, LB, LB_POOL, AFD_ORIGIN}:
            def address_fields(value: object, path: str, owner: str = resource_id) -> None:
                if isinstance(value, dict):
                    for key, child in value.items():
                        child_path = path + "." + key if path else key
                        if key in {"ipAddress", "fqdn", "hostName"} and isinstance(child, str) and child:
                            addresses.append({"from": owner, "address": child, "path": child_path,
                                              "kind": "address", "automaticRestore": False})
                        else:
                            address_fields(child, child_path, owner)
                elif isinstance(value, list):
                    for index, child in enumerate(value):
                        address_fields(child, f"{path}[{index}]", owner)
            address_fields(body, "")
    identifiers = set(nodes)
    edges: list[JsonObject] = []
    for key, node in nodes.items():
        parent = str(node["parentId"] or "").lower()
        if parent in nodes:
            edges.append({"from": node["id"], "to": nodes[parent]["id"], "kind": "contained",
                          "relation": "owned", "relationClass": "contained", "path": "ARM parent"})
        if node["body"] is None:
            continue
        for reference in references(node["body"]):
            if node["resourceType"] in {AGW, LB} and reference["id"].lower().startswith(key + "/"):
                continue
            owner = dependency_owner(reference["id"], identifiers)
            if owner == key:
                continue
            target = nodes[owner]["id"] if owner else reference["id"]
            edge = {"from": node["id"], "to": target, "kind": "reference" if owner else "shared",
                    "relation": relation_of(target) if owner else "shared",
                    "relationClass": relation_class_of(node["resourceType"], target, in_inventory=bool(owner)),
                    "referenceId": reference["id"], "path": reference["path"]}
            if not any(item["from"].lower() == key and item["to"].lower() == target.lower()
                       and item["kind"] == edge["kind"] for item in edges):
                edges.append(edge)
    for node in nodes.values():
        if node["resourceType"] != AFD_ROUTE:
            continue
        groups = [edge["to"].lower() for edge in edges if edge["from"].lower() == node["id"].lower()
                  and edge["to"].lower() in nodes
                  and nodes[edge["to"].lower()]["resourceType"] in {AFD_ORIGIN_GROUP, AFD_RULESET}]
        for child in nodes.values():
            if (str(child["parentId"] or "").lower() in groups
                    and child["resourceType"] in {AFD_ORIGIN, AFD_RULE}):
                edges.append({"from": node["id"], "to": child["id"], "kind": "configuration",
                              "relation": "required",
                              "path": "Front Door route requires prepared origin/rule configuration"})
    return {"nodes": list(nodes.values()), "edges": edges, "addresses": addresses}


def select_bundle(graph: JsonObject, resource_ids: list[str], *, include_related: bool,
                  exclude_related: tuple[str, ...] | list[str] = ()) -> list[str]:
    if not resource_ids or len(resource_ids) > 50:
        raise BackupError("Select 1..50 resource roots")
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    selected = {resource_id.lower() for resource_id in resource_ids}
    if selected - set(nodes):
        raise BackupError("Selected resource is not in the verified backup/inventory")
    skipped = {identifier.lower() for identifier in exclude_related} - selected
    changed = True
    while changed:
        changed = False
        for key, node in nodes.items():
            parent = str(node["parentId"] or "").lower()
            root_selected = any(nodes[root]["resourceType"] == AFD and key.startswith(root + "/") for root in selected)
            if root_selected and key not in selected:
                selected.add(key)
                changed = True
            if include_related and key in selected:
                for edge in graph["edges"]:
                    target = edge["to"].lower()
                    if (edge["from"].lower() == key and target in nodes and target not in selected
                            and not (edge["kind"] == "reference" and target in skipped)):
                        selected.add(target)
                        changed = True
            if parent in selected and key not in selected:
                selected.add(key)
                changed = True
    if len(selected) > 50:
        raise BackupError("Expanded bundle exceeds 50 resources")
    return [nodes[key]["id"] for key in sorted(selected)]


def restore_order(graph: JsonObject, selected_ids: list[str]) -> list[str]:
    selected = {resource_id.lower(): resource_id for resource_id in selected_ids}
    dependencies: dict[str, set[str]] = {key: set() for key in selected}
    for edge in graph["edges"]:
        source, target = edge["from"].lower(), edge["to"].lower()
        if source in dependencies and target in dependencies:
            dependencies[source].add(target)
    ordered = []
    while dependencies:
        ready = sorted(key for key, requirements in dependencies.items() if not requirements)
        if not ready:
            raise BackupError("Resource references form a cycle; split or explicitly stage this restore")
        for key in ready:
            ordered.append(selected[key])
            dependencies.pop(key)
        for requirements in dependencies.values():
            requirements.difference_update(ready)
    return ordered


def bundle_definition(graph: JsonObject, roots: list[str], *, include_related: bool,
                      exclude_related: tuple[str, ...] | list[str] = ()) -> JsonObject:
    selected = select_bundle(graph, roots, include_related=include_related, exclude_related=exclude_related)
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    for resource_id in selected:
        node = nodes[resource_id.lower()]
        if node["resourceType"] not in SUPPORTED_TYPES or not node["restoreSupported"]:
            raise BackupError(f"{node['name']}: {node['blockedReason'] or 'unreviewed restore profile'}")
    order = restore_order(graph, selected)
    external = [edge for edge in graph["edges"] if edge["from"].lower() in {identifier.lower() for identifier in selected}
                and edge["to"].lower() not in {identifier.lower() for identifier in selected}]
    excluded = [{"resourceId": nodes[identifier.lower()]["id"], **item}
                for identifier in order for item in nodes[identifier.lower()].get("excluded", [])]
    return {"rootResourceIds": roots, "resourceIds": order, "includeRelated": include_related,
            "externalReferences": external, "excludedRelations": excluded,
            "sha256": digest(encode_json({"selected": order, "external": external}))}
