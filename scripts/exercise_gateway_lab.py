from __future__ import annotations

import argparse
import copy
import json
import time
from pathlib import Path

import requests
from provision_backend_vm import provision as provision_vm
from provision_complex_lab import ready

from armbackup.comparison import compare
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, encode_json, utc_now
from armbackup.resource_profiles import AGW, WAF, restore_body


def run(path: Path, confirmation: str, resume: Path | None = None, cleanup_only: bool = False,
        backend: str = "vm") -> None:
    config = ConsoleConfig.load(path)
    if confirmation != config.group:
        raise BackupError("Exact owned LAB confirmation required")
    console = LiveConsole.connect(config)
    seed = json.loads((path.parent / "complex-resources.local.json").read_bytes())
    if seed["scope"] != config.scope:
        raise BackupError("Gateway seed scope mismatch")
    output = path.parent / f"gateway-experiment-{time.time_ns()}.local.json"
    evidence: JsonObject = {"scope": config.scope, "startedAt": utc_now(), "scenarios": [],
                            "targets": {}, "jobs": [], "sourceRunId": "", "productionReady": False,
                            "backend": backend, "diagnostics": []}
    previous = json.loads(resume.read_bytes()) if resume else None
    if previous:
        if previous["scope"] != config.scope or not previous.get("sourceRunId"):
            raise BackupError("Resume evidence does not match the owned scope/verified source")
        evidence["targets"] = previous["targets"]
        evidence["sourceRunId"] = previous["sourceRunId"]
        evidence["resumedFrom"] = str(resume)
        evidence["backend"] = previous.get("backend", "legacy-aci")
        if previous.get("vmDiskProof"):
            evidence["vmDiskProof"] = previous["vmDiskProof"]

    def save() -> None:
        output.write_bytes(encode_json(evidence))

    def record(name: str, **details: object) -> None:
        evidence["scenarios"].append({"scenario": name, "status": "Passed", **details})
        save()
        print("PASS: " + name, flush=True)

    def create(identifier: str, api: str, body: JsonObject) -> JsonObject:
        console.guard_scope()
        try:
            old = console.arm.request("GET", identifier, api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
        else:
            raise BackupError(f"Refusing overwrite of existing test target: {old['name']}")
        evidence["targets"][identifier] = api
        save()
        console.arm.request("PUT", identifier, api, body)
        return ready(console.arm, identifier, api)

    def operation(action: str, payload: JsonObject) -> JsonObject:
        job = console.submit(action, payload)
        evidence["jobs"].append(job["id"])
        save()
        for _ in range(2400):
            result = console.job(job["id"])
            if result["status"] == "Succeeded":
                return result["result"]
            if result["status"] == "Failed":
                raise BackupError(f"Gateway operation {job['id']}: {result['error']}")
            time.sleep(2)
        raise BackupError("Gateway operation exceeded bound; inspect stored job, do not resubmit")

    def restore(ids: list[str], mode: str, prefix: str = "", related: bool = True) -> JsonObject:
        payload = {"runId": evidence["sourceRunId"], "resourceIds": ids,
                   "includeRelated": related, "mode": mode, "ticket": "LAB-GATEWAY-DEEP",
                   "reason": "Approved detailed Gateway/WAF backup, independent clone and recovery exercise",
                   "acknowledgeExternal": True}
        if prefix:
            payload["clonePrefix"] = prefix
        plan = console.bundle_review(payload)
        for action in plan["actions"]:
            evidence["targets"][action["resourceId"]] = action["apiVersion"]
        save()
        result = operation("bundle-restore", {"planId": plan["id"], "approvalSha256": plan["approvalSha256"],
                                               "confirmGroup": config.group})
        if not console.read_run(result["safetyRunId"])["verified"]:
            raise BackupError("Gateway safety verification failed")
        record(mode + " / safety and full shape verified", resources=len(result["resourceIds"]),
               safetyRunId=result["safetyRunId"])
        return result

    def check(gateway: str, prefix: str, *, port: int = 80, admin: int = 403) -> None:
        gateway_id = next(value for value in evidence["targets"] if value.endswith("/" + prefix + "abx-agw"))
        console.arm.request("PUT", gateway_id + "/providers/Microsoft.Insights/diagnosticSettings/abx-troubleshooting",
                            "2021-05-01-preview", {"properties": {
                                "workspaceId": config.capture.workspace_id, "logAnalyticsDestinationType": "Dedicated",
                                "logs": [{"category": category, "enabled": True}
                                         for category in ("ApplicationGatewayFirewallLog", "ApplicationGatewayAccessLog")]}})
        health = console.arm.request_operation("POST", gateway_id + "/backendhealth", "2024-05-01", {}, max_polls=18)
        evidence["diagnostics"].append({"gatewayId": gateway_id, "stage": gateway,
                                        "time": utc_now(), "backendHealth": health})
        save()
        pip = next(value for value in evidence["targets"] if value.endswith("/" + prefix + "abx-agw-ip"))
        raw = console.arm.request("GET", pip, "2024-05-01")
        host = raw["properties"]["dnsSettings"]["fqdn"]
        tests = [("/health", {}, 200, port, 80), ("/api/health", {}, 200, 8080, 8081),
                 ("/health", {"X-Armbackup-Test": "block"}, 403, None, 80),
                 ("/admin", {}, admin, None, 80), ("/health", {}, 301, None, 8082)]
        for endpoint, extra, status, expected_port, front_port in tests:
            for _ in range(48):
                response = requests.get(f"http://{host}:{front_port}{endpoint}",
                                        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json", **extra},
                                        timeout=(10, 30), allow_redirects=False)
                if response.status_code == status and (expected_port is None or response.json().get("port") == expected_port):
                    break
                time.sleep(5)
            else:
                health = console.arm.request_operation("POST", gateway_id + "/backendhealth", "2024-05-01", {}, max_polls=18)
                evidence["diagnostics"].append({"gatewayId": gateway_id, "stage": gateway + " failure",
                                                "time": utc_now(), "backendHealth": health,
                                                "httpStatus": response.status_code})
                save()
                raise BackupError(f"Gateway HTTP mismatch: {gateway} {endpoint} {response.status_code}")
        record(gateway + " / HTTP path, ports, header WAF, admin WAF and redirect", port=port, adminStatus=admin)

    def remove(identifier: str, api: str) -> None:
        console.guard_scope()
        try:
            raw = console.arm.request("GET", identifier, api)
        except ArmHttpError as exc:
            if exc.status == 404:
                return
            raise
        is_proven_disk = identifier == evidence.get("vmDiskProof", {}).get("diskId")
        if (not identifier.lower().startswith((config.scope + "/providers/").lower())
                or not raw["name"].startswith("abx-")
                or (not is_proven_disk and raw.get("tags", {}).get("armbackupLab") != config.lab_id)):
            raise BackupError("Gateway cleanup ownership mismatch")
        console.arm.request("DELETE", identifier, api)
        for _ in range(240):
            try:
                console.arm.request("GET", identifier, api)
            except ArmHttpError as exc:
                if exc.status == 404:
                    return
                raise
            time.sleep(5)
        raise BackupError("Gateway deletion wait exceeded bound")

    shared_names = ["abx-nat-ip", "abx-nat", "abx-backend-nsg", "abx-gateway-nsg", "abx-vnet", "abx-http-backend"]
    shared = []
    try:
        if cleanup_only:
            if previous is None:
                raise BackupError("Cleanup-only requires exact recorded evidence")
            evidence["status"] = "CleanupOnly"
            return
        for name in ([] if previous else [name for name in shared_names if backend == "aci" or name != "abx-http-backend"]):
            identifier = next(key for key in seed["desired"] if key.rsplit("/", 1)[-1] == name)
            entry = seed["desired"][identifier]
            shared.append(create(identifier, entry["apiVersion"], copy.deepcopy(entry["body"])))
        backend_ip = shared[-1]["properties"]["ipAddress"]["ip"] if shared and backend == "aci" else "10.85.3.4"
        if not previous and backend == "vm":
            vm = config.scope + "/providers/Microsoft.Compute/virtualMachines/abx-http-vm"
            nic = config.scope + "/providers/Microsoft.Network/networkInterfaces/abx-vm-nic"
            evidence["targets"].update({vm: "2024-11-01", nic: "2024-05-01"})
            save()
            provision_vm(path)
            raw_vm = console.arm.request("GET", vm, "2024-11-01")
            disk = raw_vm["properties"]["storageProfile"]["osDisk"]["managedDisk"]["id"]
            if disk.lower() != (config.scope + "/providers/Microsoft.Compute/disks/abx-http-osdisk").lower():
                raise BackupError("Unexpected test VM disk")
            raw_disk = console.arm.request("GET", disk, "2024-03-02")
            if str(raw_disk.get("managedBy", "")).lower() != vm.lower():
                raise BackupError("Test VM/disk relationship unconfirmed")
            evidence["vmDiskProof"] = {"diskId": disk, "ownedVmId": vm}
            evidence["targets"][disk] = "2024-03-02"
            save()
        root_ids = {}
        for name in ["abx-waf", "abx-agw-ip", "abx-agw"]:
            identifier = next(key for key in seed["desired"] if key.rsplit("/", 1)[-1] == name)
            root_ids[name] = identifier
            if previous:
                continue
            entry = seed["desired"][identifier]
            body = copy.deepcopy(entry["body"])
            if name == "abx-waf":
                body["properties"]["customRules"].append({"name": "BlockAdminPath", "priority": 20,
                    "ruleType": "MatchRule", "action": "Block", "matchConditions": [{
                        "matchVariables": [{"variableName": "RequestUri"}], "operator": "Contains",
                        "matchValues": ["/admin"], "negationConditon": False}]})
            if name == "abx-agw":
                body["properties"]["backendAddressPools"][0]["properties"]["backendAddresses"] = [{"ipAddress": backend_ip}]
                body["properties"]["backendHttpSettingsCollection"][0]["properties"]["cookieBasedAffinity"] = "Enabled"
                body["properties"]["backendHttpSettingsCollection"][0]["properties"]["affinityCookieName"] = "LabAffinity"
            create(identifier, entry["apiVersion"], body)
            root_ids[name] = identifier
        gateway = root_ids["abx-agw"]
        if previous:
            from armbackup.resource_bundles import clone_targets, topology

            source = console.read_run(evidence["sourceRunId"])
            if not source["verified"]:
                raise BackupError("Resume source integrity failed")
            snapshots = {item["resourceId"].lower(): item for item in source["envelopes"]}
            for identifier in source["manifest"]["bundle"]["resourceIds"]:
                item = snapshots[identifier.lower()]
                resource = config.resource(identifier)
                observed = console.observe(resource, item["captureApiVersion"])
                for _ in range(240):
                    if observed["status"] != "present" or observed.get("provisioningState") in {None, "Succeeded"}:
                        break
                    time.sleep(5)
                    observed = console.observe(resource, item["captureApiVersion"])
                else:
                    raise BackupError("Previous original operation has not settled; refusing resume write")
                if observed["status"] == "missing":
                    restore([identifier], "create", related=False)
                elif observed["status"] != "present":
                    raise BackupError("Resume original state is unconfirmed")
            graph = topology(source["envelopes"])
            targets = clone_targets(graph, source["manifest"]["bundle"]["resourceIds"], "abx-twin")
            rebuild_clone = False
            for mapped in targets.values():
                resource = config.resource(mapped["resourceId"])
                observed = console.observe(resource, config.api_version(resource.type))
                if observed["status"] == "missing" or observed.get("provisioningState") not in {None, "Succeeded"}:
                    rebuild_clone = True
                    continue
                result = compare({"raw": {**mapped["body"], "id": resource.id},
                                  "captureApiVersion": config.api_version(resource.type)},
                                 observed, resource.type, complete=True)
                if result["status"] != "same":
                    raise BackupError("Existing clone does not match reviewed mapping; no blind upsert")
            if rebuild_clone:
                for original in reversed(source["manifest"]["bundle"]["resourceIds"]):
                    mapped = targets[original.lower()]
                    remove(mapped["resourceId"], config.api_version(config.resource(mapped["resourceId"]).type))
                restore([gateway], "clone", "abx-twin")
            captured = {"runId": evidence["sourceRunId"], "bundle": source["manifest"]["bundle"]}
            record("resumed verified original and clone with derived DNS and case-insensitive ARM references")
        else:
            check("original baseline", "")
            captured = operation("bundle-backup", {"resourceIds": [gateway], "includeRelated": True})
            evidence["sourceRunId"] = captured["runId"]
            save()
            source = console.read_run(captured["runId"])
            if not source["verified"] or len(source["envelopes"]) != 3:
                raise BackupError("Gateway/WAF/PIP baseline incomplete")
            record("detailed Gateway/WAF/PIP verified bundle", resources=3)
            restore([gateway], "clone", "abx-twin")
        check("independent clone", "abx-twin-")
        for snapshot in source["envelopes"]:
            resource = config.resource(snapshot["resourceId"])
            if compare(snapshot, console.observe(resource, snapshot["captureApiVersion"]), resource.type, complete=True)["status"] != "same":
                raise BackupError("Clone changed original configuration")
        record("clone leaves all original writable configurations unchanged")
        waf = root_ids["abx-waf"]
        body = restore_body(console.arm.request("GET", waf, "2024-05-01"), WAF)
        next(rule for rule in body["properties"]["customRules"] if rule["name"] == "BlockAdminPath")["action"] = "Log"
        console.arm.request("PUT", waf, "2024-05-01", body)
        ready(console.arm, waf, "2024-05-01")
        body = restore_body(console.arm.request("GET", gateway, "2024-05-01"), AGW)
        next(settings for settings in body["properties"]["backendHttpSettingsCollection"] if settings["name"] == "normal")["properties"]["port"] = 8080
        console.arm.request("PUT", gateway, "2024-05-01", body)
        ready(console.arm, gateway, "2024-05-01")
        check("changed original", "", port=8080, admin=200)
        check("clone isolated from original changes", "abx-twin-")
        restore([gateway], "update")
        check("restored original", "")
        for identifier in reversed(captured["bundle"]["resourceIds"]):
            remove(identifier, "2024-05-01")
        restore([gateway], "create")
        check("deleted then recreated original", "")
        check("clone survives original deletion and recreation", "abx-twin-")
        evidence["status"] = "Passed"
    except (BackupError, requests.RequestException, OSError, ValueError) as exc:
        evidence.update({"status": "Failed", "error": str(exc) if isinstance(exc, BackupError) else type(exc).__name__})
        save()
        print("FAIL: " + evidence["error"], flush=True)
        raise
    finally:
        priorities = {"microsoft.network/applicationgateways": 0, "microsoft.containerinstance/containergroups": 1,
                      "microsoft.compute/virtualmachines": 1, "microsoft.network/networkinterfaces": 2,
                      "microsoft.compute/disks": 2, "microsoft.network/virtualnetworks": 3,
                      "microsoft.network/natgateways": 4, "microsoft.network/networksecuritygroups": 5,
                      "microsoft.network/applicationgatewaywebapplicationfirewallpolicies": 5,
                      "microsoft.network/publicipaddresses": 6}
        from armbackup.resource_profiles import arm_identity

        try:
            for identifier in sorted(evidence["targets"], key=lambda value: priorities[arm_identity(value)[0]]):
                remove(identifier, evidence["targets"][identifier])
            evidence["cleanup"] = "Passed"
        finally:
            evidence["finishedAt"] = utc_now()
            save()
            console.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Owned detailed HTTP Gateway/WAF original, clone and recovery lab")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--confirm-group", required=True)
    parser.add_argument("--resume-evidence", type=Path)
    parser.add_argument("--cleanup-only", action="store_true")
    parser.add_argument("--backend", choices=("vm", "aci"), default="vm")
    args = parser.parse_args()
    run(args.config.resolve(), args.confirm_group, args.resume_evidence, args.cleanup_only, args.backend)


if __name__ == "__main__":
    main()
