from __future__ import annotations

import re
import time
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from armbackup.backup import Backup, new_run_id
from armbackup.comparison import compare
from armbackup.config import keys
from armbackup.contracts import (
    BackupError,
    Events,
    JsonObject,
    digest,
    encode_json,
    object_value,
    utc_now,
)
from armbackup.resource_bundles import bundle_definition, clone_targets, topology
from armbackup.resource_profiles import (
    LB_POOL,
    PROFILE_APIS,
    arm_identity,
    configuration_body,
    ownership_parent,
    references,
    restore_body,
)

if TYPE_CHECKING:
    from armbackup.console import LiveConsole


class BundleConsole:
    def __init__(self, console: LiveConsole) -> None:
        self.console = console
        self.config = console.config

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
        return topology(envelopes)

    def inventory_graph(self) -> JsonObject:
        return self._public_graph(self._inventory_graph())

    def _public_graph(self, graph: JsonObject) -> JsonObject:
        for node in graph["nodes"]:
            node.pop("body", None)
            try:
                self.config.resource(node["id"])
                if (node["tags"].get("armbackupLab") != self.config.lab_id
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
        return {**self._public_graph(graph), "sourceRunId": run_id, "scope": self.config.scope}

    def backup(self, job: JsonObject, payload: JsonObject) -> JsonObject:
        keys(payload, {"resourceIds", "includeRelated"}, "bundle backup")
        resources = payload.get("resourceIds")
        if not isinstance(resources, list) or not all(isinstance(value, str) for value in resources):
            raise BackupError("Bundle resource IDs are required")
        for resource_id in resources:
            self.config.read_resource(resource_id)
        related = payload.get("includeRelated", True)
        if not isinstance(related, bool):
            raise BackupError("includeRelated must be boolean")
        inventory = {str(raw["id"]).lower(): raw for raw in self.console.inventory()}
        graph = self._inventory_graph()
        definition = bundle_definition(graph, resources, include_related=related)
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

    def _external(self, edge: JsonObject) -> JsonObject:
        identifier = edge.get("referenceId") or edge.get("to")
        if not isinstance(identifier, str):
            raise BackupError("Shared reference ID is missing")
        kind, _, _ = arm_identity(identifier)
        if not identifier.lower().startswith((self.config.scope + "/providers/").lower()):
            raise BackupError("Shared reference outside this LAB requires a separately authorized mapping")
        base = kind.rsplit("/", 1)[0] if kind == "microsoft.network/virtualnetworks/subnets" else kind
        if base not in PROFILE_APIS:
            raise BackupError("Shared reference has no reviewed API contract")
        api = self.config.api_version(base)
        raw = self.console.arm.request("GET", identifier, api)
        state = raw.get("properties", {}).get("provisioningState")
        if state not in {None, "Succeeded"}:
            raise BackupError("Shared dependency is not ready")
        ownership_required = edge.get("kind") == "contained" or edge.get("ownershipRequired") is True
        if ownership_required:
            owner = ownership_parent(identifier)
            owner_raw = (self.console.arm.request("GET", owner, self.config.api_version(arm_identity(owner)[0]))
                         if owner else raw)
            if (owner_raw.get("tags", {}).get("armbackupLab") != self.config.lab_id
                    or owner_raw.get("tags", {}).get("armbackupWorkload") != "true"):
                raise BackupError("Contained child parent is not an approved owned workload")
        return {"id": identifier, "apiVersion": api, "readOnly": True,
                "resourceType": kind, "observedAt": utc_now(),
                "fingerprint": digest(encode_json(raw)), "ownershipRequired": ownership_required}

    def prepare(self, payload: JsonObject) -> JsonObject:
        keys(payload, {"runId", "resourceIds", "mode", "includeRelated", "ticket", "reason",
                       "acknowledgeExternal", "clonePrefix"}, "bundle review")
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
        graph = topology(source["envelopes"])
        definition = bundle_definition(graph, resources, include_related=related)
        nodes = {node["id"].lower(): node for node in graph["nodes"]}
        prefix = payload.get("clonePrefix")
        if mode == "clone" and not isinstance(prefix, str):
            raise BackupError("Clone requires an explicit target name prefix")
        targets = clone_targets(graph, definition["resourceIds"], prefix) if isinstance(prefix, str) and mode == "clone" else {}
        if mode != "clone" and payload.get("clonePrefix"):
            raise BackupError("Clone prefix is only allowed for clone mode")
        actions = []
        for resource_id in definition["resourceIds"]:
            node = nodes[resource_id.lower()]
            mapped = targets.get(resource_id.lower(), {"resourceId": resource_id, "body": node["body"]})
            resource = self.config.resource(mapped["resourceId"])
            if (node["tags"].get("armbackupLab") != self.config.lab_id
                    or node["tags"].get("armbackupWorkload") != "true"):
                raise BackupError(f"{node['name']}: bundle source lacks approved LAB workload ownership")
            api = node["captureApiVersion"]
            if api != self.config.api_version(resource.type):
                raise BackupError("Bundle API version differs from the reviewed configuration")
            observed = self.console.observe(resource, api)
            if observed["status"] == "present" and observed["metadataTags"].get("armbackupWorkload") != "true":
                raise BackupError("Current bundle target is no longer an approved workload")
            if mode in {"create", "clone"} and observed["status"] != "missing":
                raise BackupError(f"{node['name']}: create-only target exists or is unconfirmed")
            if mode == "update" and observed["status"] != "present":
                raise BackupError(f"{node['name']}: update-only target is missing or unconfirmed")
            if observed["status"] == "present" and observed["raw"].get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
                raise BackupError(f"{node['name']}: wait for stable provisioning")
            actions.append({"resourceId": resource.id, "sourceResourceId": resource_id, "resourceType": resource.type,
                            "apiVersion": api, "name": resource.id.rsplit("/", 1)[1], "body": mapped["body"],
                            "expectedFingerprint": observed.get("fingerprint"),
                            "expectedConfigurationFingerprint": (
                                digest(encode_json(configuration_body(observed["raw"], resource.type)))
                                if observed["status"] == "present" else None),
                            "wasPresent": observed["status"] == "present",
                            "snapshotSha256": digest(encode_json(next(item for item in source["envelopes"]
                                                                     if item["resourceId"].lower() == resource_id.lower())))})
        external = [self._external(edge) for edge in definition["externalReferences"]]
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
            "limitations": ["Only reviewed LAB API fields", "Public IP/domain identities may change after recreation",
                            "Backend contents, secrets/certificates and shared resources are not restored",
                            "No atomic lock over Azure Portal/other tools", "Failure is not rollback"],
        }
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
                "bundle": definition, "limitations": plan["limitations"]}

    def _safety(self, plan: JsonObject, job: JsonObject, events: Events) -> str:
        run_id = new_run_id()
        manifest: JsonObject = {"schemaVersion": 1, "runId": run_id, "kind": "safety",
                               "startedAt": utc_now(), "status": "Captured", "resources": [],
                               "absences": [], "bundlePlanId": plan["id"], "sourceRunId": plan["sourceRunId"]}
        for action in plan["actions"]:
            resource = self.config.resource(action["resourceId"])
            observed = self.console.observe(resource, action["apiVersion"])
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
        if (digest(encode_json(plan)) != payload.get("approvalSha256") or plan.get("scope") != self.config.scope
                or payload.get("confirmGroup") != self.config.group):
            raise BackupError("Bundle approval hash/scope/group confirmation mismatch")
        if not self.config.restore_enabled:
            raise BackupError("Restore is disabled")
        deadline = datetime.fromisoformat(plan["expiresAt"].replace("Z", "+00:00"))
        if deadline <= datetime.now(UTC):
            raise BackupError("Bundle review expired")
        events = self.console.events(job["id"], job["id"], plan["ticket"])
        applied: list[str] = []
        created_by_parent: dict[str, str] = {}
        with self.console.archive.guard("capture"):
            self.console.guard_scope()
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
            for external in plan["sharedDependencies"]:
                current_external = self._external({"to": external["id"],
                                                   "ownershipRequired": external["ownershipRequired"]})
                if current_external["fingerprint"] != external["fingerprint"]:
                    raise BackupError("Shared dependency changed after review; no write performed")
            for action in plan["actions"]:
                self.console.guard_scope()
                self.console.archive.assert_lock()
                if deadline <= datetime.now(UTC):
                    raise BackupError("Bundle approval expired before write; safety is retained")
                resource = self.config.resource(action["resourceId"])
                observed = self.console.observe(resource, action["apiVersion"])
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
                    observed = self.console.observe(resource, action["apiVersion"])
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
                            child = self.console.observe(self.config.resource(child_action["resourceId"]),
                                                         child_action["apiVersion"])
                            if child["status"] == "present":
                                created_by_parent[child_action["resourceId"].lower()] = child["fingerprint"]
                events.emit("bundle_resource_apply_completed", resource_id=resource.id, status="Succeeded",
                            planId=identifier, safetyRunId=safety_id)
                events.flush()
            job["phase"] = "verification"
            for action in plan["actions"]:
                resource = self.config.resource(action["resourceId"])
                observed = self.console.observe(resource, action["apiVersion"])
                comparison = compare(
                    {"raw": {**action["body"], "id": resource.id}, "captureApiVersion": action["apiVersion"]},
                    observed, resource.type, complete=True,
                )
                if comparison["status"] != "same":
                    raise BackupError(f"{resource.id.rsplit('/', 1)[-1]}: replayed fields differ; inspect safety and current state")
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
