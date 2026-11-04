from __future__ import annotations

import argparse
import copy
import json
import re
import time
from dataclasses import replace
from pathlib import Path

import requests
from provision_backend_vm import provision as provision_vm
from provision_complex_lab import ready

from armbackup.comparison import compare
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, encode_json, utc_now
from armbackup.resource_profiles import LB, LB_POOL, PIP, arm_identity, restore_body
from armbackup.support import verify_official_configuration

API = "2024-05-01"


def run(path: Path, confirmation: str, test_group: str = "") -> None:
    config = ConsoleConfig.load(path)
    seed = json.loads((path.parent / "complex-resources.local.json").read_bytes())
    if seed["scope"] != config.scope:
        raise BackupError("Test seed scope mismatch")
    if test_group:
        if not re.fullmatch(r"rg-armbackup-cert-lb-[a-f0-9]{8}", test_group):
            raise BackupError("Separate validation group must use rg-armbackup-cert-lb-<8 hex digits>")
        old_scope = config.scope
        config = replace(config, capture=replace(config.capture, resource_groups=(test_group,)))
        seed = json.loads(json.dumps(seed).replace(old_scope, config.scope))
        for entry in seed["desired"].values():
            dns = entry["body"].get("properties", {}).get("dnsSettings", {})
            if dns.get("domainNameLabel"):
                dns["domainNameLabel"] += "-" + test_group.rsplit("-", 1)[1]
    if config.inventory_scope != "lab" or confirmation != config.group:
        raise BackupError("This owned-resource validation runner requires its exact test RG confirmation")
    console = LiveConsole.connect(config)
    output = path.parent / f"load-balancer-experiment-{time.time_ns()}.local.json"
    evidence: JsonObject = {"scope": config.scope, "startedAt": utc_now(), "scenarios": [],
                            "targets": {}, "jobs": [], "safetyRuns": [], "httpChecks": 0}
    targets = evidence["targets"]

    def save() -> None:
        output.write_bytes(encode_json(evidence))

    def passed(name: str, **details: object) -> None:
        evidence["scenarios"].append({"scenario": name, "status": "Passed", **details})
        save()
        print("PASS: " + name, flush=True)

    def create(identifier: str, body: JsonObject) -> None:
        console.guard_scope()
        try:
            console.arm.request("GET", identifier, API)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
        else:
            raise BackupError("Refusing to overwrite an existing validation resource")
        targets[identifier] = API
        save()
        console.arm.request("PUT", identifier, API, body)
        ready(console.arm, identifier, API)

    def operation(action: str, payload: JsonObject) -> JsonObject:
        submitted = console.submit(action, payload)
        evidence["jobs"].append(submitted["id"])
        save()
        console.futures[submitted["id"]].result(timeout=1800)
        finished = console.job(submitted["id"])
        if finished["status"] != "Succeeded":
            raise BackupError(f"Validation operation failed: {finished['id']} / {finished.get('error', '')}")
        return finished["result"]

    def restore(mode: str) -> JsonObject:
        plan = console.bundle_review({
            "runId": evidence["sourceRunId"], "resourceIds": [lb], "includeRelated": True,
            "mode": mode, "ticket": "CERT-LB-20261103",
            "reason": "Validate Standard TCP/IP-pool recovery and independent cloning",
            "acknowledgeExternal": True, **({"clonePrefix": "abx-twin"} if mode == "clone" else {}),
        })
        for action in plan["actions"]:
            targets[action["resourceId"]] = action["apiVersion"]
        save()
        result = operation("bundle-restore", {
            "planId": plan["id"], "approvalSha256": plan["approvalSha256"],
            "confirmGroup": config.confirmation,
        })
        if not console.read_run(result["safetyRunId"])["verified"]:
            raise BackupError("Safety snapshot is not verified")
        evidence["safetyRuns"].append(result["safetyRunId"])
        passed(mode + " / full shape and safety", count=len(result["resourceIds"]))
        return plan

    def check(pip_id: str, expected_port: int, stage: str) -> None:
        raw = console.arm.request("GET", pip_id, API)
        host = raw["properties"]["dnsSettings"]["fqdn"]
        error = ""
        for _ in range(60):
            try:
                response = requests.get(f"http://{host}:8080/health", timeout=(5, 15))
                error = f"HTTP {response.status_code}"
                if response.status_code == 200 and response.json().get("port") == expected_port:
                    evidence["httpChecks"] += 1
                    passed(stage, backendPort=expected_port, httpStatus=200)
                    return
            except (requests.Timeout, requests.ConnectionError) as exc:
                error = type(exc).__name__
            time.sleep(3)
        raise BackupError("Load Balancer HTTP verification failed: " + stage + " / " + error)

    def remove(identifier: str, api: str) -> None:
        console.guard_scope()
        try:
            raw = console.arm.request("GET", identifier, api)
        except ArmHttpError as exc:
            if exc.status == 404:
                return
            raise
        disk = evidence.get("vmDiskProof", {})
        disk_owned = identifier == disk.get("diskId")
        if (not identifier.lower().startswith((config.scope + "/providers/").lower())
                or not raw["name"].startswith("abx-")
                or not disk_owned and raw.get("tags", {}).get("armbackupLab") != config.lab_id):
            raise BackupError("Validation cleanup ownership mismatch")
        console.arm.request_operation("DELETE", identifier, api, max_polls=240)
        for _ in range(240):
            try:
                console.arm.request("GET", identifier, api)
            except ArmHttpError as exc:
                if exc.status == 404:
                    return
                raise
            time.sleep(3)
        raise BackupError("Validation resource deletion exceeded bound")

    lb = config.scope + "/providers/Microsoft.Network/loadBalancers/abx-lb"
    pip = config.scope + "/providers/Microsoft.Network/publicIPAddresses/abx-lb-ip"
    pool = lb + "/backendAddressPools/http"
    pool_body: JsonObject = {"properties": {"loadBalancerBackendAddresses": [{
        "name": "vm-backend", "properties": {
            "ipAddress": "10.85.3.4",
            "virtualNetwork": {"id": config.scope + "/providers/Microsoft.Network/virtualNetworks/abx-vnet"},
        },
    }]}}
    try:
        for name in ("abx-nat-ip", "abx-nat", "abx-backend-nsg", "abx-gateway-nsg", "abx-vnet"):
            identifier = next(key for key in seed["desired"] if key.endswith("/" + name))
            create(identifier, copy.deepcopy(seed["desired"][identifier]["body"]))
        vm = config.scope + "/providers/Microsoft.Compute/virtualMachines/abx-http-vm"
        nic = config.scope + "/providers/Microsoft.Network/networkInterfaces/abx-vm-nic"
        targets.update({vm: "2024-11-01", nic: API})
        save()
        provision_vm(path, config=config)
        disk = console.arm.request("GET", vm, "2024-11-01")["properties"]["storageProfile"]["osDisk"]["managedDisk"]["id"]
        if disk.lower() != (config.scope + "/providers/Microsoft.Compute/disks/abx-http-osdisk").lower():
            raise BackupError("Unexpected validation VM disk")
        raw_disk = console.arm.request("GET", disk, "2024-03-02")
        if str(raw_disk.get("managedBy", "")).lower() != vm.lower():
            raise BackupError("VM disk ownership is unconfirmed")
        evidence["vmDiskProof"] = {"diskId": disk, "ownedVmId": vm}
        targets[disk] = "2024-03-02"
        save()
        for identifier in (pip, lb):
            create(identifier, copy.deepcopy(seed["desired"][identifier]["body"]))
        parent_pool = console.arm.request("GET", pool, API)
        if parent_pool.get("properties", {}).get("loadBalancerBackendAddresses"):
            raise BackupError("New parent pool unexpectedly contains backend addresses")
        targets[pool] = API
        save()
        console.arm.request("PUT", pool, API, pool_body)
        ready(console.arm, pool, API)
        verify_official_configuration(console.arm.request("GET", lb, API))
        check(pip, 80, "baseline public TCP flow")
        proof_archive = path.parent / f"official-lb-policy-{time.time_ns()}"
        subscription_config = replace(config, inventory_scope="subscription", local_archive=proof_archive)
        subscription_console = LiveConsole.connect(subscription_config)
        try:
            subscription_console.save_policy({"id": "official-policy-proof"}, {"policy": {
                "scopeIds": [lb], "types": [LB], "tags": [],
            }})
            saved = subscription_console.backup({"id": "official-backup-proof"}, {"label": "Official LB policy with automatic dependencies"})
            verified = subscription_console.read_run(saved["runId"])
            if not verified["verified"] or {item["resourceType"] for item in verified["envelopes"]} != {LB, LB_POOL, PIP}:
                raise BackupError("Official policy did not capture the full Load Balancer recovery unit")
            evidence["officialPolicyProof"] = {"runId": saved["runId"], "archive": str(proof_archive), "count": saved["capturedCount"]}
            passed("official selector policy and automatic pool/public-IP capture")
        finally:
            subscription_console.close()
        backup = operation("bundle-backup", {"resourceIds": [lb], "includeRelated": True})
        evidence["sourceRunId"] = backup["runId"]
        source = console.read_run(backup["runId"])
        if not source["verified"] or {item["resourceType"] for item in source["envelopes"]} != {LB, LB_POOL, PIP}:
            raise BackupError("Independent pool/public IP backup coverage is incomplete")
        passed("verified LB, independent pool and public IP bundle")
        for cycle in range(2):
            body = restore_body(console.arm.request("GET", lb, API), LB)
            body["properties"]["loadBalancingRules"][0]["properties"]["backendPort"] = 8080
            if cycle:
                body["properties"]["probes"][0]["properties"].update({"protocol": "Http", "requestPath": "/health"})
            console.arm.request("PUT", lb, API, body)
            ready(console.arm, lb, API)
            changed_pool = copy.deepcopy(pool_body)
            changed_pool["properties"]["loadBalancerBackendAddresses"][0]["name"] = "changed-backend"
            console.arm.request("PUT", pool, API, changed_pool)
            ready(console.arm, pool, API)
            check(pip, 8080, f"cycle {cycle + 1} / changed routing and independent pool")
            restore("update")
            check(pip, 80, f"cycle {cycle + 1} / restored TCP flow")
        clone = restore("clone")
        clone_pip = next(action["resourceId"] for action in clone["actions"] if action["resourceType"] == PIP)
        check(clone_pip, 80, "independent clone TCP flow")
        for snapshot in source["envelopes"]:
            resource = config.resource(snapshot["resourceId"])
            if compare(snapshot, console.observe(resource, API), resource.type, complete=True)["status"] != "same":
                raise BackupError("Cloning changed the original writable settings")
        passed("clone preserves original configurations")
        remove(lb, API)
        remove(pip, API)
        restore("create")
        check(pip, 80, "deleted original recreated TCP flow")
        check(clone_pip, 80, "clone stays available after original recreation")
        evidence["status"] = "Succeeded"
    except Exception as exc:
        evidence["status"] = "Failed"
        evidence["error"] = str(exc)
        save()
        raise
    finally:
        priorities = {LB: 0, LB_POOL: 1, "microsoft.compute/virtualmachines": 1,
                      "microsoft.network/networkinterfaces": 2, "microsoft.compute/disks": 2,
                      "microsoft.network/virtualnetworks": 3, "microsoft.network/natgateways": 4,
                      "microsoft.network/networksecuritygroups": 5, PIP: 6}
        try:
            for identifier in sorted(targets, key=lambda value: priorities[arm_identity(value)[0]]):
                remove(identifier, targets[identifier])
            evidence["cleanup"] = "Passed"
        finally:
            evidence["finishedAt"] = utc_now()
            save()
            console.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Owned Standard Load Balancer recovery certification")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--confirm-group", required=True)
    parser.add_argument("--test-group", default="")
    args = parser.parse_args()
    run(args.config.resolve(), args.confirm_group, args.test_group)
