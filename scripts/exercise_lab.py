from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from azure.core.exceptions import AzureError
from verify_private_lab import delete_resource

from armbackup.comparison import configuration
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import BackupError, JsonObject, encode_json, utc_now
from armbackup.restore import NSG, ROUTES, load_snapshot, project_body


def wait(console: LiveConsole, action: str, payload: JsonObject) -> JsonObject:
    job = console.submit(action, payload)
    for _ in range(450):
        result = console.job(job["id"])
        if result["status"] == "Succeeded":
            return result["result"]
        if result["status"] == "Failed":
            raise BackupError(str(result.get("error", "Lab operation failed")))
        time.sleep(2)
    raise BackupError("Lab operation timed out; inspect its stored operation ID")


def run(config_path: Path, retain_review_state: bool) -> None:
    config = ConsoleConfig.load(config_path)
    console = LiveConsole.connect(config)
    evidence: JsonObject = {
        "startedAt": utc_now(), "scope": config.scope, "archiveMode": config.archive_mode,
        "scenarios": [], "safetyRunIds": [], "productionReady": False,
    }

    def record(name: str, **details: object) -> None:
        evidence["scenarios"].append({"scenario": name, "status": "Passed", **details})
        print(f"PASS: {name}", flush=True)

    def put(resource_id: str, resource_type: str, body: JsonObject) -> None:
        resource = config.resource(resource_id)
        if resource.type != resource_type:
            raise BackupError("Lab mutation type mismatch")
        console.guard_scope()
        observed = console.observe(resource, config.capture.api_versions[resource_type])
        console.assert_restorable(observed, may_be_missing=False)
        console.arm.request("PUT", resource_id, config.capture.api_versions[resource_type], body)
        for _ in range(60):
            current = console.arm.request("GET", resource_id, config.capture.api_versions[resource_type])
            if current.get("properties", {}).get("provisioningState") == "Succeeded":
                return
            time.sleep(2)
        raise BackupError("Lab mutation did not finish")

    def restore(source: str, run_id: str, mode: str, ticket: str, target_name: str = "") -> JsonObject:
        plan = console.prepare({
            "resourceId": source, "runId": run_id, "mode": mode, "targetName": target_name,
            "ticket": ticket, "reason": "Approved isolated MSP lab validation; restore reviewed network configuration",
        })
        result = wait(console, "restore", {
            "planId": plan["id"], "approvalSha256": plan["approvalSha256"],
            "confirmTarget": plan["targetResourceId"].rsplit("/", 1)[1],
        })
        if result["comparison"]["status"] != "same":
            raise BackupError("Post-restore full configuration comparison did not match")
        safety = console.read_run(result["safetyRunId"])
        if not safety["verified"]:
            raise BackupError("Safety backup is not verified")
        evidence["safetyRunIds"].append(result["safetyRunId"])
        return result

    def reject(name: str, payload: JsonObject) -> None:
        try:
            console.prepare(payload)
        except BackupError:
            record(name)
        else:
            raise BackupError(f"Unsafe plan was not rejected: {name}")

    try:
        original_policy = console.read_policy()
        all_policy = {"scopeIds": ["resource-group"],
                      "types": sorted(config.capture.api_versions), "tags": []}
        wait(console, "policy", {"policy": all_policy})
        baseline = wait(console, "backup", {"label": "MSP exercise baseline"})
        baseline_id = baseline["runId"]
        edge = config.scope + "/providers/Microsoft.Network/networkSecurityGroups/nsg-msp-edge"
        app = config.scope + "/providers/Microsoft.Network/networkSecurityGroups/nsg-msp-app"
        route = config.scope + "/providers/Microsoft.Network/routeTables/rt-msp-egress"
        old_edge = load_snapshot(console.archive, baseline_id, edge)
        old_route = load_snapshot(console.archive, baseline_id, route)
        record("ARM inventory + immutable baseline + completion verification",
               runId=baseline_id, capturedCount=baseline["capturedCount"])
        changed = project_body(old_edge["raw"], NSG)
        port = changed["properties"]["securityRules"][0]["properties"]["destinationPortRange"]
        changed_port = "8443" if port != "8443" else "443"
        changed["properties"]["securityRules"][0]["properties"]["destinationPortRange"] = changed_port
        put(edge, NSG, changed)
        changed_route = project_body(old_route["raw"], ROUTES)
        changed_route["properties"]["disableBgpRoutePropagation"] = not changed_route["properties"].get(
            "disableBgpRoutePropagation", False)
        put(route, ROUTES, changed_route)
        current = console.state()
        baseline_state = next(run for run in current["runs"] if run["id"] == baseline_id)
        statuses = {snapshot["resourceId"].lower(): snapshot["comparison"]["status"]
                    for snapshot in baseline_state["snapshots"]}
        if statuses[edge.lower()] != "critical" or statuses[route.lower()] != "warning":
            raise BackupError("Real NSG/route-table changes did not produce the intended distinct comparison states")
        record("Real NSG rule and route-table update drift", nsg=statuses[edge.lower()],
               routeTable=statuses[route.lower()])
        actors = sum(bool(item.get("actor")) for item in current["current"].values())
        record("Activity Log management attribution", observedActors=actors,
               note="Latest successful management event, not proof of the cause of a diff")
        reject("Outside-RG review blocked before write", {
            "resourceId": edge.replace(config.group, config.group + "-not-allowed"),
            "runId": baseline_id, "mode": "update", "targetName": "", "ticket": "LAB-MSP-SCOPE",
            "reason": "Negative scope validation",
        })
        stale = console.prepare({"resourceId": edge, "runId": baseline_id, "mode": "update",
                                 "targetName": "", "ticket": "LAB-MSP-STALE",
                                 "reason": "Validate that changes after review invalidate execution"})
        changed["tags"]["reviewRevision"] = utc_now()
        put(edge, NSG, changed)
        try:
            wait(console, "restore", {"planId": stale["id"], "approvalSha256": stale["approvalSha256"],
                                      "confirmTarget": "nsg-msp-edge"})
        except BackupError as stale_error:
            actual = console.arm.request("GET", edge, config.capture.api_versions[NSG])
            if actual["tags"].get("reviewRevision") != changed["tags"]["reviewRevision"]:
                raise BackupError("Stale review unexpectedly overwrote the resource") from stale_error
            record("Changed-after-review restore blocked", currentPort=changed_port)
        else:
            raise BackupError("Stale review was not rejected")
        edge_restore = restore(edge, baseline_id, "update", "LAB-MSP-NSG")
        if configuration(console.arm.request("GET", edge, config.capture.api_versions[NSG]), NSG) != configuration(old_edge["raw"], NSG):
            raise BackupError("NSG was not fully restored within the reviewed profile")
        record("NSG update-only recovery with safety preimage", safetyRunId=edge_restore["safetyRunId"])
        route_restore = restore(route, baseline_id, "update", "LAB-MSP-ROUTE")
        if configuration(console.arm.request("GET", route, config.capture.api_versions[ROUTES]), ROUTES) != configuration(old_route["raw"], ROUTES):
            raise BackupError("Route table was not restored")
        record("Route table update-only recovery", safetyRunId=route_restore["safetyRunId"])
        clone_name = "nsg-msp-restore-check"
        clone = restore(edge, baseline_id, "create", "LAB-MSP-CREATE", clone_name)
        clone_id = clone["targetResourceId"]
        record("Create-only clone with original unchanged", targetResourceId=clone_id)
        reject("Create-only existing target blocked", {
            "resourceId": edge, "runId": baseline_id, "mode": "create", "targetName": clone_name,
            "ticket": "LAB-MSP-EXISTS", "reason": "Existing target must never be overwritten in create-only mode",
        })
        clone_backup = wait(console, "backup", {"label": "Before deletion recovery exercise"})
        console.guard_scope()
        observed = console.observe(config.resource(clone_id), config.capture.api_versions[NSG])
        console.assert_restorable(observed, may_be_missing=False)
        delete_resource(console.arm, clone_id, config.capture.api_versions[NSG])
        deleted_state = console.state()
        selected = next(run for run in deleted_state["runs"] if run["id"] == clone_backup["runId"])
        clone_row = next(snapshot for snapshot in selected["snapshots"]
                         if snapshot["resourceId"].lower() == clone_id.lower())
        if clone_row["comparison"]["status"] != "critical":
            raise BackupError("Confirmed deletion was not distinct from unknown state")
        record("Deleted resource remains in backup tree", resource=clone_id, status="critical")
        reject("Update-only missing target blocked", {
            "resourceId": clone_id, "runId": clone_backup["runId"], "mode": "update",
            "targetName": "", "ticket": "LAB-MSP-MISSING",
            "reason": "Missing target must not be implicitly created by update-only",
        })
        recreated = restore(clone_id, clone_backup["runId"], "create", "LAB-MSP-RECREATE", clone_name)
        absent = console.read_run(recreated["safetyRunId"])["manifest"]["absences"]
        if not absent or absent[0]["resourceId"].lower() != clone_id.lower():
            raise BackupError("Deleted-resource restore did not preserve its pre-restore absence")
        record("Deleted resource recreation with absence record", safetyRunId=recreated["safetyRunId"])
        beta_policy = {"scopeIds": ["resource-group"], "types": [NSG],
                       "tags": [{"key": "customer", "operator": "equals", "value": "customer-beta"}]}
        wait(console, "policy", {"policy": beta_policy})
        beta_run = wait(console, "backup", {"label": "Customer-beta policy coverage"})
        beta = console.read_run(beta_run["runId"])
        if len(beta["envelopes"]) != 1 or beta["envelopes"][0]["resourceId"].lower() != app.lower():
            raise BackupError("Saved customer/type policy did not control actual capture")
        record("Saved customer/type/tag policy actually limits capture", capturedCount=1)
        wait(console, "policy", {"policy": original_policy})
        complete = wait(console, "backup", {"label": "MSP handover baseline"})
        evidence["reviewBaselineRunId"] = complete["runId"]
        audit_rows = 0
        for _ in range(18):
            audit = console.logs_reader.query(days=1, search="LAB-MSP")
            audit_rows = len(audit["logs"])
            if audit_rows:
                break
            time.sleep(5)
        if not audit_rows:
            raise BackupError("Live log query did not return the exercise audit records")
        record("Actual Log Analytics audit query", records=audit_rows)
        exported = console.report(complete["runId"])
        evidence["reportSha256"] = exported["sha256"]
        record("Handover report observation bounds and checksum")
        if retain_review_state:
            latest_edge = console.arm.request("GET", edge, config.capture.api_versions[NSG])
            latest_route = console.arm.request("GET", route, config.capture.api_versions[ROUTES])
            latest_app = console.arm.request("GET", app, config.capture.api_versions[NSG])
            changed = project_body(latest_edge, NSG)
            before_port = changed["properties"]["securityRules"][0]["properties"]["destinationPortRange"]
            changed["properties"]["securityRules"][0]["properties"]["destinationPortRange"] = "8443" if before_port != "8443" else "443"
            put(edge, NSG, changed)
            changed = project_body(latest_route, ROUTES)
            changed["properties"]["disableBgpRoutePropagation"] = not changed["properties"].get(
                "disableBgpRoutePropagation", False)
            put(route, ROUTES, changed)
            changed = project_body(latest_app, NSG)
            changed["tags"]["owner"] = "handover-ops" if changed["tags"].get("owner") != "handover-ops" else "network-ops"
            put(app, NSG, changed)
            arrival = restore(edge, complete["runId"], "create", "LAB-MSP-ARRIVAL", "nsg-msp-new-arrival")
            evidence["currentOnlyExample"] = arrival["targetResourceId"]
            delete_resource(console.arm, clone_id, config.capture.api_versions[NSG])
            evidence["intentionalReviewDrift"] = {
                "securityRule": edge, "configuration": route, "tags": app,
                "confirmedMissing": clone_id, "note": "Approved lab-only review examples, not production incidents",
            }
            record("Retained lab review examples for MSP UI", baseline=complete["runId"])
        evidence["finishedAt"] = utc_now()
        output = config_path.parent / "exercises.local.json"
        output.write_bytes(encode_json(evidence))
        print(json.dumps({"scenariosPassed": len(evidence["scenarios"]),
                          "verifiedSafetyBackups": len(evidence["safetyRunIds"]),
                          "reviewBaselineRunId": evidence["reviewBaselineRunId"],
                          "evidence": str(output), "archiveMode": config.archive_mode}, ensure_ascii=False), flush=True)
    finally:
        console.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Explicit isolated MSP resource mutation and recovery tests")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--retain-review-state", action="store_true",
                        help="Keep only lab examples of drift/deletion/current-only resources for UI review")
    args = parser.parse_args()
    try:
        run(args.config.resolve(), args.retain_review_state)
    except (BackupError, AzureError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"MSP exercises stopped: {message}\n")


if __name__ == "__main__":
    main()
