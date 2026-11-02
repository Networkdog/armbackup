from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests
from provision_complex_lab import ready

from armbackup.comparison import compare
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, encode_json, utc_now
from armbackup.resource_profiles import (
    LB,
    PROFILE_APIS,
    WAF,
    arm_identity,
    restore_body,
)


def run(path: Path, mode: str, confirmation: str, resume_run: str = "", complete_partial: bool = False) -> None:
    config = ConsoleConfig.load(path)
    if confirmation != config.group:
        raise BackupError("Exact approved LAB RG confirmation is required")
    definition = json.loads((path.parent / "complex-resources.local.json").read_bytes())
    if definition["scope"] != config.scope:
        raise BackupError("Complex validation scope mismatch")
    console = LiveConsole.connect(config)
    suffix = "-partial" if complete_partial else "-resumed" if resume_run else ""
    evidence_path = path.parent / f"complex-{mode}{suffix}.local.json"
    if evidence_path.exists():
        evidence_path = path.parent / f"complex-{mode}{suffix}-{time.time_ns()}.local.json"
    evidence: JsonObject = {"startedAt": utc_now(), "scope": config.scope, "mode": mode,
                            "scenarios": [], "jobs": [], "productionReady": False}

    def save() -> None:
        evidence_path.write_bytes(encode_json(evidence))

    def record(scenario: str, **details: object) -> None:
        evidence["scenarios"].append({"scenario": scenario, "status": "Passed", **details})
        save()
        print("PASS: " + scenario, flush=True)

    def operation(action: str, payload: JsonObject) -> JsonObject:
        job = console.submit(action, payload)
        evidence["jobs"].append(job["id"])
        save()
        for _ in range(2400):
            result = console.job(job["id"])
            if result["status"] == "Succeeded":
                return result["result"]
            if result["status"] == "Failed":
                raise BackupError(f"Complex operation failed: {result['id']} / {result['error']}")
            time.sleep(2)
        raise BackupError(f"Operation wait exceeded bound; inspect {job['id']}, do not resubmit")

    def restore(source: str, roots: list[str], restore_mode: str, include_related: bool = True) -> JsonObject:
        plan = console.bundle_review({
            "runId": source, "resourceIds": roots, "includeRelated": include_related, "mode": restore_mode,
            "ticket": "LAB-COMPLEX-" + mode.upper(),
            "reason": "Approved isolated creation, detailed settings, backup, deletion and recovery exercise",
            "acknowledgeExternal": True,
        })
        result = operation("bundle-restore", {"planId": plan["id"], "approvalSha256": plan["approvalSha256"],
                                              "confirmGroup": config.group})
        if not console.read_run(result["safetyRunId"])["verified"]:
            raise BackupError("Complex safety source is not verified")
        record("Verified safety run and full post-bundle configuration", safetyRunId=result["safetyRunId"],
               resources=len(result["resourceIds"]), planId=plan["id"])
        return result

    def delete(identifier: str, api: str) -> None:
        console.guard_scope()
        raw = console.arm.request("GET", identifier, api)
        if (not identifier.lower().startswith((config.scope + "/providers/").lower())
                or not raw["name"].startswith("abx-")
                or raw.get("tags", {}).get("armbackupLab") != config.lab_id):
            raise BackupError("Refusing deletion outside explicitly owned abx test roots")
        console.arm.request("DELETE", identifier, api)
        for _ in range(180):
            try:
                console.arm.request("GET", identifier, api)
            except ArmHttpError as exc:
                if exc.status == 404 and exc.code in {"ResourceNotFound", "NotFound"}:
                    print("Deleted: " + raw["name"], flush=True)
                    return
                raise
            time.sleep(5)
        raise BackupError("Deletion wait exceeded bound; inspect actual Azure state")

    def check_http(stage: str) -> None:
        agw_pip = console.arm.request("GET", config.scope + "/providers/Microsoft.Network/publicIPAddresses/abx-agw-ip", "2024-05-01")
        lb_pip = console.arm.request("GET", config.scope + "/providers/Microsoft.Network/publicIPAddresses/abx-lb-ip", "2024-05-01")
        host = agw_pip["properties"]["dnsSettings"]["fqdn"]
        endpoint_id = next(identifier for identifier in definition["desired"] if "/afdEndpoints/" in identifier and "/routes/" not in identifier)
        endpoint = console.arm.request("GET", endpoint_id, "2024-02-01")
        cases = [
            ("Gateway backend", "http://" + host + "/health", {}, 200, 80),
            ("Gateway path route", "http://" + host + ":8081/api/health", {}, 200, 8080),
            ("Gateway redirect", "http://" + host + ":8082/health", {}, 301, None),
            ("WAF custom header", "http://" + host + "/health", {"X-Armbackup-Test": "block"}, 403, None),
            ("Load Balancer VM backend", "http://" + lb_pip["properties"]["ipAddress"] + ":8080/health", {}, 200, 80),
            ("Front Door route and response rule", "https://" + endpoint["properties"]["hostName"] + "/health", {}, 200, 80),
        ]
        for name, url, headers, expected, port in cases:
            last = ""
            for _ in range(270 if name.startswith("Front Door") else 36):
                try:
                    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0", **headers},
                                            timeout=(10, 30), allow_redirects=False)
                    last = f"HTTP {response.status_code}"
                    correct = response.status_code == expected
                    if correct and port is not None:
                        correct = response.json().get("port") == port
                    if correct and name.startswith("Front Door"):
                        correct = response.headers.get("X-Armbackup-Lab") == "restorable-edge"
                    if correct and expected == 301:
                        correct = "/health" in response.headers.get("Location", "")
                    if correct:
                        record(stage + " / " + name, httpStatus=response.status_code)
                        break
                except (requests.Timeout, requests.ConnectionError) as exc:
                    last = type(exc).__name__
                time.sleep(10)
            else:
                raise BackupError(f"Functional validation failed: {name} / {last}")

    try:
        roots = definition["edgeRoots"]
        if resume_run:
            if mode != "recreate":
                raise BackupError("Resume is only for explicit recreation from an existing verified source")
            stored = console.read_run(resume_run)
            if not stored["verified"] or stored["manifest"].get("kind") != "bundle":
                raise BackupError("Resume source must be a verified bundle")
            source = {"runId": resume_run, "capturedCount": len(stored["envelopes"]),
                      "bundle": stored["manifest"]["bundle"]}
            graph = console.bundle_graph(resume_run)
            if {root.lower() for root in roots} != {root.lower() for root in source["bundle"]["rootResourceIds"]}:
                raise BackupError("Resume source roots differ from this approved exercise")
        else:
            graph = console.bundle_inventory()
            source = operation("bundle-backup", {"resourceIds": roots, "includeRelated": True})
        source_id = source["runId"]
        evidence["sourceRunId"] = source_id
        save()
        verified = console.read_run(source_id)
        if not verified["verified"] or len(verified["envelopes"]) < 13:
            raise BackupError("Complex baseline is not a complete parent/child backup")
        record("Same-run owned roots, children and verified source", runId=source_id,
               capturedCount=source["capturedCount"], graphNodes=len(graph["nodes"]))
        if not resume_run:
            check_http("Before")
        if complete_partial:
            if not resume_run or mode != "recreate":
                raise BackupError("Partial completion requires an explicit verified recreate source")
            updates, creates, same = [], [], []
            for snapshot in verified["envelopes"]:
                resource = config.resource(snapshot["resourceId"])
                observed = console.observe(resource, config.api_version(resource.type))
                if observed["status"] == "missing":
                    creates.append(resource.id)
                elif observed["status"] == "present":
                    result = compare(snapshot, observed, resource.type, complete=True)
                    if result["status"] == "unknown":
                        raise BackupError("Partial recovery state is unconfirmed")
                    (same if result["status"] == "same" else updates).append(resource.id)
                else:
                    raise BackupError("Partial recovery presence could not be confirmed")
            record("Preserved already matching resources without rollback", resources=len(same))
            if updates:
                restore(source_id, updates, "update", False)
            if creates:
                restore(source_id, creates, "create", False)
            for snapshot in verified["envelopes"]:
                resource = config.resource(snapshot["resourceId"])
                observed = console.observe(resource, config.api_version(resource.type))
                if compare(snapshot, observed, resource.type, complete=True)["status"] != "same":
                    raise BackupError("Full source differs after explicit partial completion")
            record("All original deleted resources now match the verified source", resources=len(verified["envelopes"]))
        elif mode == "recreate":
            if not resume_run:
                for identifier in reversed(source["bundle"]["resourceIds"]):
                    if arm_identity(identifier)[2] is None:
                        delete(identifier, PROFILE_APIS[arm_identity(identifier)[0]])
            for identifier in source["bundle"]["resourceIds"]:
                observed = console.observe(config.resource(identifier), config.api_version(arm_identity(identifier)[0]))
                if observed["status"] != "missing":
                    raise BackupError("Deletion did not confirm every parent/child absence")
            record("Deleted all selected roots and confirmed contained child absences")
            restore(source_id, roots, "create")
        else:
            target = config.scope + "/providers/Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/abx-waf"
            raw = console.arm.request("GET", target, PROFILE_APIS[WAF])
            body = restore_body(raw, WAF)
            body["properties"]["customRules"][0]["action"] = "Allow"
            console.arm.request("PUT", target, PROFILE_APIS[WAF], body)
            ready(console.arm, target, PROFILE_APIS[WAF])
            record("Configured and changed WAF custom-rule action")
            restore(source_id, [target], "update")
            target = config.scope + "/providers/Microsoft.Network/loadBalancers/abx-lb"
            body = restore_body(console.arm.request("GET", target, PROFILE_APIS[LB]), LB)
            body["properties"]["loadBalancingRules"][0]["properties"]["backendPort"] = 8080
            console.arm.request("PUT", target, PROFILE_APIS[LB], body)
            ready(console.arm, target, PROFILE_APIS[LB])
            record("Changed LB backend port without changing shared VM")
            restore(source_id, [target], "update")
        check_http("After")
        evidence.update({"finishedAt": utc_now(), "status": "Passed"})
        save()
    except (BackupError, OSError, ValueError, requests.RequestException) as exc:
        evidence.update({"finishedAt": utc_now(), "status": "Failed", "error": type(exc).__name__})
        save()
        raise
    finally:
        console.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Owned abx LAB configuration and real HTTP recovery exercise")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--mode", choices=("update", "recreate"), required=True)
    parser.add_argument("--confirm-group", required=True)
    parser.add_argument("--resume-run", default="", help="Re-review an already verified bundle after confirmed deletions")
    parser.add_argument("--complete-partial", action="store_true", help="Re-observe and separately review existing/missing targets; never roll back")
    args = parser.parse_args()
    run(args.config.resolve(), args.mode, args.confirm_group, args.resume_run, args.complete_partial)


if __name__ == "__main__":
    main()
