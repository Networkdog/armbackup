from __future__ import annotations

import re
from copy import deepcopy

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
                  target_scope: str | None = None) -> dict[str, JsonObject]:
    """Map each selected resource to its clone.

    With ``target_scope`` (``/subscriptions/<id>/resourceGroups/<name>``) the clones are created in that
    group and the name prefix is optional; without it the prefix is what keeps the clone apart from the original.
    """
    if prefix is None and target_scope is None:
        raise BackupError("Clone requires an explicit target name prefix")
    if prefix is not None and (not isinstance(prefix, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,19}", prefix)):
        raise BackupError("Clone prefix must be 2..20 lowercase letters/digits/hyphens")
    if target_scope is not None and not re.fullmatch(r"/subscriptions/[^/]+/resourceGroups/[^/]+", target_scope):
        raise BackupError("Clone target scope must be a subscription resource group")
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    selected_keys = {identifier.lower() for identifier in selected}
    mapping: dict[str, str] = {}
    for identifier in sorted(selected, key=lambda value: len(value.split("/"))):
        kind, name, parent = arm_identity(identifier)
        if parent:
            if parent.lower() not in mapping:
                raise BackupError("Cloning a child requires its selected parent")
            target = mapping[parent.lower()] + identifier[len(parent):]
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

    def remap(value: object) -> object:
        if isinstance(value, dict):
            return {key: remap(child) for key, child in value.items()}
        if isinstance(value, list):
            return [remap(child) for child in value]
        if isinstance(value, str) and value.lower().startswith("/subscriptions/"):
            owner = dependency_owner(value, selected_keys)
            if owner:
                return mapping[owner] + value[len(nodes[owner]["id"]):]
        return deepcopy(value)

    result = {}
    for key, target in mapping.items():
        node = nodes[key]
        body = remap(node["body"])
        if not isinstance(body, dict):
            raise BackupError("Clone source has no reviewed body")
        if "tags" in node["body"]:
            body["tags"] = deepcopy(node["body"]["tags"])
        if node["resourceType"] == PIP and body.get("properties", {}).get("dnsSettings"):
            if not prefix:
                raise BackupError("A public IP DNS label is unique per region; clone it with a name prefix")
            label = prefix + "-" + body["properties"]["dnsSettings"]["domainNameLabel"]
            if len(label) > 63:
                raise BackupError("Expanded clone DNS label exceeds 63 characters")
            body["properties"]["dnsSettings"]["domainNameLabel"] = label
        result[key] = {"resourceId": target, "body": body}
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
            "parentId": parent, "tags": tags, "body": body,
            "restoreSupported": body is not None, "blockedReason": error,
            "captureApiVersion": envelope["captureApiVersion"],
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
            edges.append({"from": node["id"], "to": nodes[parent]["id"], "kind": "contained", "path": "ARM parent"})
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
                              "path": "Front Door route requires prepared origin/rule configuration"})
    return {"nodes": list(nodes.values()), "edges": edges, "addresses": addresses}


def select_bundle(graph: JsonObject, resource_ids: list[str], *, include_related: bool) -> list[str]:
    if not resource_ids or len(resource_ids) > 50:
        raise BackupError("Select 1..50 resource roots")
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    selected = {resource_id.lower() for resource_id in resource_ids}
    if selected - set(nodes):
        raise BackupError("Selected resource is not in the verified backup/inventory")
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
                    if edge["from"].lower() == key and target in nodes and target not in selected:
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


def bundle_definition(graph: JsonObject, roots: list[str], *, include_related: bool) -> JsonObject:
    selected = select_bundle(graph, roots, include_related=include_related)
    nodes = {node["id"].lower(): node for node in graph["nodes"]}
    for resource_id in selected:
        node = nodes[resource_id.lower()]
        if node["resourceType"] not in SUPPORTED_TYPES or not node["restoreSupported"]:
            raise BackupError(f"{node['name']}: {node['blockedReason'] or 'unreviewed restore profile'}")
    order = restore_order(graph, selected)
    external = [edge for edge in graph["edges"] if edge["from"].lower() in {identifier.lower() for identifier in selected}
                and edge["to"].lower() not in {identifier.lower() for identifier in selected}]
    return {"rootResourceIds": roots, "resourceIds": order, "includeRelated": include_related,
            "externalReferences": external,
            "sha256": digest(encode_json({"selected": order, "external": external}))}
