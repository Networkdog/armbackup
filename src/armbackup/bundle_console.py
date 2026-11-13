from __future__ import annotations

import re
import time
import uuid
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from armbackup.azure_semantics import (
    destructive_changes,
    destructive_message,
    exclusive_reference,
    immutable_conflicts,
    immutable_message,
    inspect_runtime_state,
    keep_current,
    normalize_reference_bindings,
    validate_subnet_ips,
)
from armbackup.backup import Backup, new_run_id
from armbackup.comparison import compare
from armbackup.config import UUID, keys
from armbackup.contracts import (
    ArmHttpError,
    BackupError,
    Events,
    JsonObject,
    digest,
    encode_json,
    object_value,
    utc_now,
)
from armbackup.resource_bundles import bundle_definition, clone_targets, dependency_owner, topology
from armbackup.resource_profiles import (
    LB_POOL,
    PROFILE_APIS,
    arm_identity,
    configuration_body,
    ownership_parent,
    references,
    restore_body,
)
from armbackup.support import restore_profile_reason

if TYPE_CHECKING:
    from armbackup.console import LiveConsole


class BundleConsole:
    def __init__(self, console: LiveConsole) -> None:
        self.console = console
        self.config = console.config

    def _official(self) -> bool:
        return self.config.inventory_scope != "lab"

    def _mark_profile(self, graph: JsonObject, envelopes: list[JsonObject]) -> None:
        """Official (subscription) scope: a stored Gateway/LB outside the certified profile is backup-only."""
        if not self._official():
            return
        nodes = {node["id"].lower(): node for node in graph["nodes"]}
        for envelope in envelopes:
            node = nodes.get(str(envelope["resourceId"]).lower())
            if node is None:
                continue
            reason = restore_profile_reason(envelope["raw"])
            if reason:
                node.update({"restoreSupported": False, "blockedReason": reason, "body": None})

    def _inventory_graph(self) -> JsonObject:
        envelopes = []
        for raw in self.console.inventory():
            resource = self.config.read_resource(raw["id"])
            observed = self.console.observe(resource, self.config.api_version(resource.type),
                                            require_ownership=self.config.inventory_scope == "lab")
            if observed["status"] != "present":
                raise BackupError(f"{raw['name']}: current inventory is unconfirmed")
            envelopes.append({"resourceId": resource.id, "resourceType": resource.type,
                              "captureApiVersion": observed["apiVersion"],
                              "raw": observed["raw"], "metadata": {"tags": raw.get("tags", {}),
                                                                  "ownershipParent": raw.get("ownershipParent", "")}})
        graph = topology(envelopes)
        self._mark_profile(graph, envelopes)
        return graph

    def inventory_graph(self) -> JsonObject:
        return self._public_graph(self._inventory_graph())

    def _public_graph(self, graph: JsonObject) -> JsonObject:
        for node in graph["nodes"]:
            node.pop("body", None)
            try:
                self.config.resource(node["id"])
                if self.config.inventory_scope == "lab" and (
                        node["tags"].get("armbackupLab") != self.config.lab_id
                        or node["tags"].get("armbackupWorkload") != "true"):
                    raise BackupError("Restore requires an explicitly marked LAB workload")
            except BackupError as exc:
                node.update({"restoreSupported": False, "blockedReason": str(exc)})
        return graph

    def graph(self, run_id: str) -> JsonObject:
        source = self.console.read_run(run_id)
        if not source["verified"]:
            raise BackupError("Bundle source is not a verified complete backup")
        graph = topology(source["envelopes"])
        self._mark_profile(graph, source["envelopes"])
        return {**self._public_graph(graph), "sourceRunId": run_id, "scope": self.config.scope}

    def backup(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"resourceIds", "includeRelated", "excludedRelated"}, "bundle backup")
        resources = payload.get("resourceIds")
        if not isinstance(resources, list) or not all(isinstance(value, str) for value in resources):
            raise BackupError("Bundle resource IDs are required")
        for resource_id in resources:
            self.config.read_resource(resource_id)
        related = payload.get("includeRelated", True)
        if not isinstance(related, bool):
            raise BackupError("includeRelated must be boolean")
        excluded = self._excluded_related(payload)
        inventory = {str(raw["id"]).lower(): raw for raw in self.console.inventory()}
        graph = self._inventory_graph()
        definition = bundle_definition(graph, resources, include_related=related, exclude_related=excluded)
        selected = [self.config.read_resource(identifier) for identifier in definition["resourceIds"]]
        job["backupResourceIds"] = [resource.id for resource in selected]
        run_id = new_run_id()
        events = self.console.events(run_id, job["id"])
        job.update({"phase": "capturing", "runId": run_id})
        capture = self.config.capture
        capture = replace(capture, resource_groups=tuple(sorted({resource.group.lower() for resource in selected})),
                          api_versions={**PROFILE_APIS, **capture.api_versions})
        selection = {"scope": self.config.read_scope, "scopeIds": definition["resourceIds"],
                     "types": sorted({resource.type for resource in selected}), "tags": []}
        result = Backup(capture, self.console.arm, self.console.archive, events).run(
            run_id, inventory=selected, inventory_source="verified allowed-scope bundle inventory",
            selection=selection, bundle=definition,
            resource_metadata={resource.id.lower(): {"tags": inventory[resource.id.lower()].get("tags", {}),
                                                     "ownershipParent": inventory[resource.id.lower()].get("ownershipParent", "")}
                               for resource in selected},
        )
        if result["status"] != "Captured":
            raise BackupError("Bundle backup is incomplete; no complete restore source exists")
        return {"status": "Captured", "runId": run_id, "capturedCount": result["capturedCount"],
                "bundle": definition}

    def _subscriptions(self) -> dict[str, JsonObject]:
        found: dict[str, JsonObject] = {}
        for raw in self.console.arm.pages("/subscriptions", "2022-12-01"):
            identifier = raw.get("subscriptionId")
            if isinstance(identifier, str) and UUID.fullmatch(identifier) and raw.get("state") == "Enabled":
                found[identifier.lower()] = {"subscriptionId": identifier,
                                             "name": str(raw.get("displayName") or identifier)}
        current = self.config.subscription
        found.setdefault(current.lower(), {"subscriptionId": current, "name": self.config.subscription_name})
        return found

    def targets(self, subscription_id: str = "", *, include_networks: bool = False) -> JsonObject:
        """Subscriptions, resource groups, and optionally VNets/Subnets that a clone may target."""
        current = self.config.subscription
        result: JsonObject = {"enabled": False, "currentSubscription": current,
                              "subscriptions": [], "resourceGroups": []}
        if not self.config.restore_enabled or self.config.inventory_scope != "subscription":
            return result
        subscriptions = self._subscriptions()
        result.update({"enabled": True, "subscriptions": sorted(
            subscriptions.values(), key=lambda item: (item["subscriptionId"].lower() != current.lower(),
                                                      item["name"].lower()))})
        if subscription_id:
            chosen = subscriptions.get(subscription_id.lower())
            if chosen is None:
                raise BackupError("Target subscription is unavailable or not enabled for this identity")
            groups = [{"name": raw["name"], "location": raw.get("location", "")}
                      for raw in self.console.arm.pages(f"/subscriptions/{chosen['subscriptionId']}/resourcegroups",
                                                        "2021-04-01")
                      if isinstance(raw.get("name"), str)
                      and raw.get("properties", {}).get("provisioningState") in {None, "Succeeded"}]
            result["resourceGroups"] = sorted(groups, key=lambda item: item["name"].lower())
            result["subscriptionId"] = chosen["subscriptionId"]
            if include_networks:
                vnets: list[JsonObject] = []
                for raw in self.console.arm.pages(
                    f"/subscriptions/{chosen['subscriptionId']}/providers/Microsoft.Network/virtualNetworks",
                    "2024-05-01",
                ):
                    vid, vname = raw.get("id"), raw.get("name")
                    props = raw.get("properties", {}) if isinstance(raw.get("properties"), dict) else {}
                    if (not isinstance(vid, str) or not isinstance(vname, str)
                            or props.get("provisioningState") not in {None, "Succeeded"}):
                        continue
                    vparts = vid.split("/")
                    vrg = vparts[4] if len(vparts) > 4 else ""
                    subnets: list[JsonObject] = []
                    for sub in props.get("subnets") or []:
                        if not isinstance(sub, dict) or not isinstance(sub.get("name"), str):
                            continue
                        sprops = sub.get("properties", {}) if isinstance(sub.get("properties"), dict) else {}
                        if sprops.get("provisioningState") not in {None, "Succeeded"}:
                            continue
                        sid_val = sub.get("id") if isinstance(sub.get("id"), str) else f"{vid}/subnets/{sub['name']}"
                        prefixes = ([sprops["addressPrefix"]] if isinstance(sprops.get("addressPrefix"), str)
                                    else [str(p) for p in (sprops.get("addressPrefixes") or []) if isinstance(p, str)])
                        subnets.append({"id": sid_val, "name": sub["name"], "addressPrefixes": prefixes})
                    vnets.append({
                        "id": vid, "name": vname, "resourceGroup": vrg,
                        "location": str(raw.get("location") or ""),
                        "subnets": sorted(subnets, key=lambda s: str(s["name"]).lower()),
                    })
                result["virtualNetworks"] = sorted(vnets, key=lambda v: (str(v["resourceGroup"]).lower(),
                                                                         str(v["name"]).lower()))
        return result

    def _target(self, subscription_id: object, group: object) -> JsonObject:
        if (self.config.inventory_scope != "subscription"
                or not isinstance(subscription_id, str) or not UUID.fullmatch(subscription_id)
                or not isinstance(group, str) or not re.fullmatch(r"[-\w._()]{1,90}", group)):
            raise BackupError("Clone target must be a subscription ID and resource group name of a subscription-scope console")
        chosen = self._subscriptions().get(subscription_id.lower())
        if chosen is None:
            raise BackupError("Target subscription is unavailable or not enabled for this identity")
        sid = chosen["subscriptionId"]
        try:
            raw = self.console.arm.request("GET", f"/subscriptions/{sid}/resourcegroups/{group}", "2021-04-01")
        except ArmHttpError as exc:
            if exc.status == 404:
                raise BackupError("Target resource group does not exist") from exc
            raise
        name = raw.get("name")
        if not isinstance(name, str) or name.lower() != group.lower():
            raise BackupError("Target resource group response does not match the request")
        if raw.get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
            raise BackupError("Target resource group is not in a stable state")
        return {"id": f"/subscriptions/{sid}/resourceGroups/{name}", "subscriptionId": sid,
                "subscriptionName": chosen["name"], "resourceGroup": name}

    @staticmethod
    def _excluded_related(payload: JsonObject) -> list[str]:
        value = payload.get("excludedRelated", [])
        if not isinstance(value, list) or len(value) > 50 or not all(isinstance(item, str) for item in value):
            raise BackupError("excludedRelated must be a list of resource IDs")
        return value

    @staticmethod
    def _changes(payload: JsonObject, allowed: list[str], mode: str) -> tuple[dict[str, str], dict[str, list[JsonObject]]]:
        """Split clone edits into per-resource renames and per-resource field overrides."""
        items = payload.get("overrides", [])
        if not isinstance(items, list) or len(items) > 100:
            raise BackupError("overrides must be a list of at most 100 entries")
        if items and mode != "clone":
            raise BackupError("Field overrides are only allowed for clone mode")
        known = {identifier.lower(): identifier for identifier in allowed}
        names: dict[str, str] = {}
        changes: dict[str, list[JsonObject]] = {}
        for item in items:
            if not isinstance(item, dict) or set(item) - {"resourceId", "path", "value"} or "path" not in item:
                raise BackupError("Each override needs resourceId, path and value")
            owner = str(item.get("resourceId", "")).lower()
            if owner not in known:
                raise BackupError("An override names a resource that is not part of this clone")
            if item["path"] == "name":
                if not isinstance(item.get("value"), str) or owner in names:
                    raise BackupError("A resource can be renamed once, to a non-empty name")
                names[owner] = item["value"]
            else:
                changes.setdefault(owner, []).append({"path": item["path"], "value": item.get("value")})
        return names, changes

    @staticmethod
    def _confirmation_for(plan: JsonObject, default: str) -> str:
        target = plan.get("target")
        return target["resourceGroup"] if isinstance(target, dict) else default

    def _external(self, edge: JsonObject, *, allowed_subscription: str | None = None) -> JsonObject:
        identifier = edge.get("referenceId") or edge.get("to")
        if not isinstance(identifier, str):
            raise BackupError("Shared reference ID is missing")
        kind, _, _ = arm_identity(identifier)
        if allowed_subscription and self.config.inventory_scope == "subscription":
            prefix = f"/subscriptions/{allowed_subscription}/resourceGroups/"
        else:
            prefix = self.config.scope + ("/resourceGroups/" if self.config.inventory_scope == "subscription" else "/providers/")
        if not identifier.lower().startswith(prefix.lower()):
            raise BackupError("Shared reference is outside the configured subscription or resource group")
        base = kind.rsplit("/", 1)[0] if kind == "microsoft.network/virtualnetworks/subnets" else kind
        if base not in PROFILE_APIS:
            raise BackupError("Shared reference has no reviewed API contract")
        api = self.config.api_version(base)
        raw = self.console.arm.request("GET", identifier, api)
        props = raw.get("properties", {}) if isinstance(raw.get("properties"), dict) else {}
        state = props.get("provisioningState")
        if state not in {None, "Succeeded"}:
            raise BackupError("Shared dependency is not ready")
        location = raw.get("location") if isinstance(raw.get("location"), str) else ""
        prefixes: list[str] = []
        if kind == "microsoft.network/virtualnetworks/subnets":
            prefixes = ([props["addressPrefix"]] if isinstance(props.get("addressPrefix"), str)
                        else [str(p) for p in (props.get("addressPrefixes") or []) if isinstance(p, str)])
            if not location and "/subnets/" in identifier:
                vnet_id = identifier.rsplit("/subnets/", 1)[0]
                try:
                    vnet_raw = self.console.arm.request("GET", vnet_id, api)
                    if isinstance(vnet_raw.get("location"), str):
                        location = vnet_raw["location"]
                except ArmHttpError as exc:
                    if exc.status != 404:
                        raise
        ownership_required = edge.get("kind") == "contained" or edge.get("ownershipRequired") is True
        if ownership_required and self.config.inventory_scope == "lab":
            owner = ownership_parent(identifier)
            owner_raw = (self.console.arm.request("GET", owner, self.config.api_version(arm_identity(owner)[0]))
                         if owner else raw)
            if (owner_raw.get("tags", {}).get("armbackupLab") != self.config.lab_id
                    or owner_raw.get("tags", {}).get("armbackupWorkload") != "true"):
                raise BackupError("Contained child parent is not an approved owned workload")
        entry: JsonObject = {
            "id": identifier, "apiVersion": api, "readOnly": True,
            "resourceType": kind, "observedAt": utc_now(),
            "location": location,
            "fingerprint": digest(encode_json(raw)), "ownershipRequired": ownership_required,
        }
        if prefixes:
            entry["addressPrefixes"] = prefixes
        return entry

    @staticmethod
    def _same_region(actions: list[JsonObject], external: list[JsonObject]) -> None:
        """Network resources can only reference each other inside one region; catch it before the write."""
        def place(value: object) -> str:
            return str(value or "").replace(" ", "").lower()

        located = {action["resourceId"].lower(): place(action["body"].get("location")) for action in actions}
        located.update({item["id"].lower(): place(item.get("location")) for item in external})
        for action in actions:
            here = place(action["body"].get("location"))
            for reference in references(action["body"]):
                owner = dependency_owner(reference["id"], set(located))
                there = located.get(owner or "", "")
                if here and there and "global" not in {here, there} and here != there:
                    raise BackupError(
                        f"{action['name']}: 복제본의 위치({here})와 참조하는 자원({reference['id'].rsplit('/', 1)[-1]}, {there})가 "
                        "달라 연결할 수 없습니다. 참조 자원도 같은 위치로 함께 복제하세요.")

    def prepare(self, payload: JsonObject) -> JsonObject:
        keys(payload, {"runId", "resourceIds", "mode", "includeRelated", "ticket", "reason",
                       "acknowledgeExternal", "clonePrefix", "targetSubscriptionId", "targetResourceGroup",
                       "excludedRelated", "overrides", "immutableConflict",
                       "referenceBindings", "targetLocation"},
             "bundle review")
        self.console.guard_scope()
        if not self.config.restore_enabled:
            raise BackupError("Restore is disabled")
        run_id = payload.get("runId")
        resources = payload.get("resourceIds")
        mode = payload.get("mode")
        if (not isinstance(run_id, str) or not isinstance(resources, list)
                or not all(isinstance(value, str) for value in resources) or mode not in {"create", "update", "clone"}):
            raise BackupError("Select a backup, resources and an explicit mode")
        for resource_id in resources:
            self.config.resource(resource_id)
        for field, minimum, maximum in (("ticket", 3, 80), ("reason", 5, 500)):
            value = payload.get(field)
            if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
                raise BackupError(f"Bundle {field} is required")
        source = self.console.read_run(run_id)
        if not source["verified"]:
            raise BackupError("Bundle backup completion/integrity is unconfirmed")
        related = payload.get("includeRelated", True)
        if not isinstance(related, bool):
            raise BackupError("includeRelated must be boolean")
        policy = payload.get("immutableConflict", "block")
        if policy not in {"block", "keep-current"}:
            raise BackupError("immutableConflict must be block or keep-current")
        if policy != "block" and mode != "update":
            raise BackupError("immutableConflict only applies to update mode")
        if (payload.get("referenceBindings") is not None or payload.get("targetLocation") is not None) and mode != "clone":
            raise BackupError("Reference bindings and target location are only allowed for clone mode")
        bindings = normalize_reference_bindings(payload.get("referenceBindings"))
        target_location = payload.get("targetLocation")
        if target_location is not None and not isinstance(target_location, str):
            raise BackupError("targetLocation must be a string")
        graph = topology(source["envelopes"])
        self._mark_profile(graph, source["envelopes"])
        definition = bundle_definition(graph, resources, include_related=related,
                                       exclude_related=self._excluded_related(payload))
        if bindings:
            ext_sources = {str(edge.get("referenceId") or edge.get("to") or "").lower()
                           for edge in definition["externalReferences"]}
            for src_key in bindings:
                if not any(ref == src_key or ref.startswith(src_key + "/") for ref in ext_sources):
                    raise BackupError("연결 대상을 바꾸려는 공유 리소스가 선택된 복제 대상의 외부 참조에 없습니다.")
        names, changes = self._changes(payload, definition["resourceIds"], mode)
        nodes = {node["id"].lower(): node for node in graph["nodes"]}
        prefix = payload.get("clonePrefix")
        target: JsonObject | None = None
        if payload.get("targetSubscriptionId") is not None or payload.get("targetResourceGroup") is not None:
            if mode != "clone":
                raise BackupError("A target subscription and resource group are only allowed for clone mode")
            target = self._target(payload.get("targetSubscriptionId"), payload.get("targetResourceGroup"))
        target_scope = target["id"] if target else None
        if mode == "clone" and not isinstance(prefix, str) and target is None:
            raise BackupError("Clone requires an explicit target name prefix or a target resource group")
        if mode != "clone" and payload.get("clonePrefix"):
            raise BackupError("Clone prefix is only allowed for clone mode")
        targets = (clone_targets(graph, definition["resourceIds"], prefix, target_scope, names, changes,
                                 reference_bindings=bindings, target_location=target_location)
                   if mode == "clone" else {})
        clone_external_edges: list[JsonObject] = []
        if mode == "clone":
            cloned_ids = {item["resourceId"].lower() for item in targets.values()}
            seen_ext: set[str] = set()
            for rid in definition["resourceIds"]:
                mapped_entry = targets[rid.lower()]
                own_target = mapped_entry["resourceId"].lower()
                projected = restore_body(mapped_entry["body"], nodes[rid.lower()]["resourceType"])
                for ref in references(projected):
                    ref_id = str(ref["id"])
                    ref_low = ref_id.lower()
                    if ref_low == own_target or ref_low.startswith(own_target + "/"):
                        continue
                    if dependency_owner(ref_id, cloned_ids):
                        continue
                    if ref_low not in seen_ext:
                        seen_ext.add(ref_low)
                        clone_external_edges.append({"to": ref_id, "referenceId": ref_id, "kind": "shared",
                                                     "path": ref["path"]})
            if (target and target["subscriptionId"].lower() != self.config.subscription.lower()
                    and any(not str(edge["referenceId"]).lower().startswith(
                        f"/subscriptions/{target['subscriptionId'].lower()}/") for edge in clone_external_edges)):
                raise BackupError("Shared references cannot cross subscriptions; add the related resources to the clone")
        actions = []
        for resource_id in definition["resourceIds"]:
            node = nodes[resource_id.lower()]
            mapped = targets.get(resource_id.lower(), {"resourceId": resource_id, "body": node["body"]})
            resource = self.config.resource(mapped["resourceId"], target_scope)
            body = mapped["body"]
            adjustments = list(mapped.get("adjustments", []))
            warnings = list(mapped.get("warnings", []))
            if self.config.inventory_scope == "lab" and (
                    node["tags"].get("armbackupLab") != self.config.lab_id
                    or node["tags"].get("armbackupWorkload") != "true"):
                raise BackupError(f"{node['name']}: bundle source lacks approved LAB workload ownership")
            api = node["captureApiVersion"]
            if api != self.config.api_version(resource.type):
                raise BackupError("Bundle API version differs from the reviewed configuration")
            observed = self.console.observe(resource, api, target_scope=target_scope)
            if (self.config.inventory_scope == "lab" and observed["status"] == "present"
                    and observed["metadataTags"].get("armbackupWorkload") != "true"):
                raise BackupError("Current bundle target is no longer an approved workload")
            if mode in {"create", "clone"} and observed["status"] != "missing":
                raise BackupError(f"{node['name']}: create-only target exists or is unconfirmed")
            if mode == "update" and observed["status"] != "present":
                raise BackupError(f"{node['name']}: update-only target is missing or unconfirmed")
            if observed["status"] == "present":
                state_block, state_warnings = inspect_runtime_state(resource.type, observed["raw"], mode, snapshot=body)
                if state_block:
                    raise BackupError(f"{node['name']}: {state_block}")
                warnings.extend(state_warnings)
            if mode == "clone":
                body = restore_body(body, resource.type)
                shared_ip = exclusive_reference(body, {item["resourceId"].lower() for item in targets.values()})
                if shared_ip:
                    raise BackupError(
                        f"{node['name']}: 복제본이 원본의 공용 IP({shared_ip.rsplit('/', 1)[1]})를 그대로 참조합니다. "
                        "공용 IP는 한 곳에만 연결할 수 있으므로 '연관 자원 추가'로 공용 IP를 함께 복제하세요.")
            if mode == "update":
                live = restore_body(observed["raw"], resource.type)
                conflicts = immutable_conflicts(resource.type, body, live, observed["raw"])
                if conflicts and policy != "keep-current":
                    raise BackupError(f"{node['name']}: {immutable_message(conflicts)}")
                if conflicts:
                    body = deepcopy(body)
                    adjustments += keep_current(body, live, conflicts)
                lost = destructive_changes(resource.type, body, live, observed["raw"])
                if lost:
                    raise BackupError(f"{node['name']}: {destructive_message(resource.type, lost)}")
            actions.append({"resourceId": resource.id, "sourceResourceId": resource_id, "resourceType": resource.type,
                            "apiVersion": api, "name": resource.id.rsplit("/", 1)[1], "body": body,
                            "adjustments": adjustments, "warnings": warnings,
                            "expectedFingerprint": observed.get("fingerprint"),
                            "expectedConfigurationFingerprint": (
                                digest(encode_json(configuration_body(observed["raw"], resource.type)))
                                if observed["status"] == "present" else None),
                            "wasPresent": observed["status"] == "present",
                            "snapshotSha256": digest(encode_json(next(item for item in source["envelopes"]
                                                                     if item["resourceId"].lower() == resource_id.lower())))})
        allowed_sub = target["subscriptionId"] if target else None
        external_edges = clone_external_edges if mode == "clone" else definition["externalReferences"]
        external = [self._external(edge, allowed_subscription=allowed_sub) for edge in external_edges]
        if mode == "clone":
            subnet_prefixes = {
                str(item["id"]).lower(): list(item["addressPrefixes"])
                for item in external if isinstance(item.get("addressPrefixes"), list)
            }
            for action in actions:
                validate_subnet_ips(action["resourceType"], action["body"], subnet_prefixes)
            self._same_region(actions, external)
        selected_ids = {identifier.lower() for identifier in definition["resourceIds"]}
        addresses = [address for address in graph["addresses"] if address["from"].lower() in selected_ids]
        if (external or addresses) and payload.get("acknowledgeExternal") is not True:
            raise BackupError("Explicitly acknowledge shared/address dependencies; they are not restored")
        identifier = str(uuid.uuid4())
        plan: JsonObject = {
            "id": identifier, "schemaVersion": 1, "scope": self.config.scope, "sourceRunId": run_id,
            "mode": "create" if mode == "clone" else mode, "operationMode": mode,
            "ticket": payload["ticket"].strip(), "reason": payload["reason"].strip(),
            "createdAt": utc_now(),
            "expiresAt": (datetime.now(UTC) + timedelta(minutes=60)).isoformat().replace("+00:00", "Z"),
            "bundle": definition, "actions": actions, "sharedDependencies": external,
            "addressDependencies": addresses,
            "limitations": ["Only reviewed API fields in the configured subscription", "Public IP/domain identities may change after recreation",
                            "Backend contents, secrets/certificates and shared resources are not restored",
                            "No atomic lock over Azure Portal/other tools", "Failure is not rollback"],
        }
        if definition["excludedRelations"]:
            plan["limitations"].append("VNet 피어링, 서브넷에 연결된 NIC·프라이빗 엔드포인트, 백엔드 풀의 NIC 멤버는 복원·복제하지 않습니다")
        if target:
            plan["target"] = target
            plan["targetScope"] = target["id"]
            plan["limitations"].append("The managed identity needs write access to the target resource group; this is not pre-verified")
        sha = digest(encode_json(plan))
        with self.console.archive.guard("capture"):
            self.console.guard_scope()
            events = self.console.events(identifier, identifier, plan["ticket"])
            events.emit("bundle_plan_reviewed", status="PendingApproval", resource_id=self.config.scope,
                        resources=len(actions), planSha256=sha)
            events.flush()
            self.console.archive.put(f"console/bundle-plans/{identifier}.json", encode_json(plan))
        return {"id": identifier, "approvalSha256": sha, "sourceRunId": run_id, "mode": mode,
                "ticket": plan["ticket"], "reason": plan["reason"], "expiresAt": plan["expiresAt"],
                "actions": [{key: value for key, value in action.items() if key != "body"} for action in actions],
                "sharedDependencies": external, "addressDependencies": addresses,
                "target": target, "confirmation": self._confirmation_for(plan, self.config.confirmation),
                "bundle": definition, "limitations": plan["limitations"]}

    def _safety(self, plan: JsonObject, job: JsonObject, events: Events) -> str:
        run_id = new_run_id()
        manifest: JsonObject = {"schemaVersion": 1, "runId": run_id, "kind": "safety",
                               "startedAt": utc_now(), "status": "Captured", "resources": [],
                               "absences": [], "bundlePlanId": plan["id"], "sourceRunId": plan["sourceRunId"]}
        target_scope = plan.get("targetScope")
        for action in plan["actions"]:
            resource = self.config.resource(action["resourceId"], target_scope)
            observed = self.console.observe(resource, action["apiVersion"], target_scope=target_scope)
            if observed["status"] not in {"present", "missing"}:
                raise BackupError("Bundle safety state is unconfirmed")
            if observed.get("fingerprint") != action["expectedFingerprint"]:
                raise BackupError("Bundle target changed after review")
            if observed["status"] == "present":
                entry = Backup(self.config.capture, self.console.arm, self.console.archive, events).capture_resource(
                    resource, action["apiVersion"], run_id,
                    {"tags": observed.get("metadataTags", {}), "bundlePlanId": plan["id"]},
                )
                stored = self.console.archive.get(entry["blob"])
                raw = json_document(stored)
                if digest(stored) != entry["sha256"] or digest(encode_json(raw["raw"])) != action["expectedFingerprint"]:
                    raise BackupError("Bundle safety readback/shape mismatch")
                manifest["resources"].append(entry)
            else:
                manifest["absences"].append({"resourceId": resource.id, "status": "ConfirmedAbsent",
                                             "observedAt": observed["observedAt"], "source": "ARM GET"})
        manifest.update({"finishedAt": utc_now(), "capturedCount": len(manifest["resources"])})
        content = encode_json(manifest)
        self.console.archive.put(f"runs/{run_id}/manifest.json", content)
        events.emit("bundle_safety_completed", status="Succeeded", resource_id=self.config.scope,
                    safetyRunId=run_id, resources=len(plan["actions"]))
        events.flush()
        self.console.archive.put(f"runs/{run_id}/COMPLETE.json", encode_json({
            "runId": run_id, "manifestSha256": digest(content), "completedAt": utc_now(),
            "logsIngestion": "Accepted", "kind": "safety",
        }))
        if not self.console.read_run(run_id)["verified"]:
            raise BackupError("Bundle safety completion verification failed")
        job["safetyRunId"] = run_id
        return run_id

    def restore(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"planId", "approvalSha256", "confirmGroup"}, "bundle execution")
        identifier = payload.get("planId")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", identifier):
            raise BackupError("Invalid bundle plan ID")
        plan = json_document(self.console.archive.get(f"console/bundle-plans/{identifier}.json"))
        # A clone only creates new resources, so the typed scope confirmation applies to restores alone.
        confirmed = (plan.get("operationMode") == "clone"
                     or payload.get("confirmGroup") == self._confirmation_for(plan, self.config.confirmation))
        if (digest(encode_json(plan)) != payload.get("approvalSha256") or plan.get("scope") != self.config.scope
                or not confirmed):
            raise BackupError("Bundle approval hash/scope confirmation mismatch")
        if not self.config.restore_enabled:
            raise BackupError("Restore is disabled")
        deadline = datetime.fromisoformat(plan["expiresAt"].replace("Z", "+00:00"))
        if deadline <= datetime.now(UTC):
            raise BackupError("Bundle review expired")
        events = self.console.events(job["id"], job["id"], plan["ticket"])
        applied: list[str] = []
        created_by_parent: dict[str, str] = {}
        target_scope = plan.get("targetScope")
        with self.console.archive.guard("capture"):
            self.console.guard_scope()
            if target_scope:
                target = plan["target"]
                if self._target(target["subscriptionId"], target["resourceGroup"])["id"] != target_scope:
                    raise BackupError("Clone target changed after review; no write performed")
            for action in plan["actions"]:
                if action["apiVersion"] != self.config.api_version(action["resourceType"]):
                    raise BackupError("Bundle API configuration changed after review")
            claim = f"console/bundle-claims/{identifier}.json"
            if self.console.archive.names(claim):
                raise BackupError("This bundle plan was already submitted; inspect its result")
            self.console.archive.put(claim, encode_json({"operationId": job["id"], "claimedAt": utc_now()}))
            job.update({"phase": "safety-backup", "ticket": plan["ticket"], "planId": identifier,
                        "sourceRunId": plan["sourceRunId"],
                        "plannedResources": [action["resourceId"] for action in plan["actions"]]})
            safety_id = self._safety(plan, job, events)
            source = self.console.read_run(plan["sourceRunId"])
            if not source["verified"]:
                raise BackupError("Bundle source no longer verifies")
            snapshots = {item["resourceId"].lower(): item for item in source["envelopes"]}
            for action in plan["actions"]:
                snapshot = snapshots.get(action.get("sourceResourceId", action["resourceId"]).lower())
                if snapshot is None or digest(encode_json(snapshot)) != action["snapshotSha256"]:
                    raise BackupError("Bundle source changed after review")
            allowed_sub = plan["target"]["subscriptionId"] if isinstance(plan.get("target"), dict) else None
            for external in plan["sharedDependencies"]:
                current_external = self._external(
                    {"to": external["id"], "ownershipRequired": external["ownershipRequired"]},
                    allowed_subscription=allowed_sub,
                )
                if current_external["fingerprint"] != external["fingerprint"]:
                    raise BackupError("Shared dependency changed after review; no write performed")
            for action in plan["actions"]:
                self.console.guard_scope()
                self.console.archive.assert_lock()
                if deadline <= datetime.now(UTC):
                    raise BackupError("Bundle approval expired before write; safety is retained")
                resource = self.config.resource(action["resourceId"], target_scope)
                observed = self.console.observe(resource, action["apiVersion"], target_scope=target_scope)
                parent = arm_identity(resource.id)[2]
                parent_applied = parent is not None and parent.lower() in {identifier.lower() for identifier in applied}
                if plan["mode"] == "create" and observed["status"] != "missing":
                    expected = created_by_parent.get(resource.id.lower())
                    if (resource.type != LB_POOL or not parent_applied or expected is None
                            or observed.get("fingerprint") != expected):
                        raise BackupError("A create-only bundle target appeared before write")
                if plan["mode"] == "update":
                    if observed["status"] != "present":
                        raise BackupError("An update-only bundle target disappeared before write")
                    if observed["fingerprint"] != action["expectedFingerprint"]:
                        config_fingerprint = digest(encode_json(configuration_body(observed["raw"], resource.type)))
                        dependency_applied = any(
                            reference["id"].lower() == applied_id.lower()
                            or reference["id"].lower().startswith(applied_id.lower() + "/")
                            for reference in references(action["body"]) for applied_id in applied)
                        if (not parent_applied and not dependency_applied) or config_fingerprint != action["expectedConfigurationFingerprint"]:
                            job["targetDrift"] = {"resourceId": resource.id,
                                                  "configurationChanged": config_fingerprint != action["expectedConfigurationFingerprint"]}
                            raise BackupError("An update-only bundle target changed before write")
                        events.emit("bundle_readonly_state_revalidated", resource_id=resource.id,
                                    status="Succeeded", planId=identifier, safetyRunId=safety_id)
                        events.flush()
                body = restore_body(action["body"], resource.type)
                job.update({"phase": "applying", "targetResourceId": resource.id,
                            "writeAttempted": True, "appliedResources": list(applied)})
                events.emit("bundle_resource_apply_started", resource_id=resource.id, status="Running",
                            planId=identifier, safetyRunId=safety_id)
                events.flush()
                self.console.arm.request("PUT", resource.id, action["apiVersion"], body)
                current = None
                for _ in range(480):
                    observed = self.console.observe(resource, action["apiVersion"], target_scope=target_scope)
                    if observed["status"] == "missing":
                        time.sleep(5)
                        continue
                    if observed["status"] != "present":
                        raise BackupError("Applied bundle state is unconfirmed; inspect current state")
                    current = observed["raw"]
                    state = current.get("properties", {}).get("provisioningState", "Succeeded")
                    if state in {"Failed", "Canceled"}:
                        raise BackupError("Bundle resource provisioning failed; no rollback assumed")
                    if state == "Succeeded":
                        break
                    time.sleep(5)
                else:
                    raise BackupError("Bundle resource provisioning timeout; inspect actual state")
                applied.append(resource.id)
                job["appliedResources"] = list(applied)
                if plan["mode"] == "create":
                    for child_action in plan["actions"]:
                        if (child_action["resourceType"] == LB_POOL
                                and arm_identity(child_action["resourceId"])[2] == resource.id):
                            child = self.console.observe(self.config.resource(child_action["resourceId"], target_scope),
                                                         child_action["apiVersion"], target_scope=target_scope)
                            if child["status"] == "present":
                                created_by_parent[child_action["resourceId"].lower()] = child["fingerprint"]
                events.emit("bundle_resource_apply_completed", resource_id=resource.id, status="Succeeded",
                            planId=identifier, safetyRunId=safety_id)
                events.flush()
            job["phase"] = "verification"
            for action in plan["actions"]:
                resource = self.config.resource(action["resourceId"], target_scope)
                job["targetResourceId"] = resource.id
                observed = self.console.observe(resource, action["apiVersion"], target_scope=target_scope)
                comparison = compare(
                    {"raw": {**action["body"], "id": resource.id}, "captureApiVersion": action["apiVersion"]},
                    observed, resource.type, complete=True,
                )
                if comparison["status"] != "same":
                    job["verification"] = {"resourceId": resource.id, **comparison}
                    detail = ", ".join(item["path"] for item in comparison["diffs"]) or comparison["reason"]
                    raise BackupError(
                        f"{resource.id.rsplit('/', 1)[-1]}: Azure write completed, but post-write "
                        f"verification is {comparison['status']} ({detail}); inspect current state "
                        "and safety backup; failure is not rollback"
                    )
                events.emit("bundle_resource_verified", resource_id=resource.id, status="Succeeded",
                            planId=identifier, safetyRunId=safety_id)
            events.flush()
            events.emit("bundle_restore_completed", status="Succeeded", resource_id=self.config.scope,
                        resources=len(applied), safetyRunId=safety_id, planId=identifier)
            events.flush()
        return {"status": "Succeeded", "planId": identifier, "ticket": plan["ticket"],
                "mode": plan.get("operationMode", plan["mode"]), "resourceIds": applied, "safetyRunId": safety_id,
                "verifiedAt": utc_now(), "sharedResourcesWriteAttempted": False}


def json_document(value: bytes) -> JsonObject:
    import json

    return object_value(json.loads(value), "bundle stored document")
