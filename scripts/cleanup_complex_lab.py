from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, encode_json, utc_now
from armbackup.resource_profiles import arm_identity


def cleanup(path: Path, confirmation: str) -> None:
    config = ConsoleConfig.load(path)
    if confirmation != config.group:
        raise BackupError("Exact approved LAB group confirmation is required")
    definition = json.loads((path.parent / "complex-resources.local.json").read_bytes())
    if definition["scope"] != config.scope:
        raise BackupError("Cleanup definition scope mismatch")
    console = LiveConsole.connect(config)
    evidence = {"startedAt": utc_now(), "scope": config.scope, "deleted": [], "alreadyAbsent": []}
    evidence_path = path.parent / "complex-cleanup.local.json"
    root = config.scope + "/providers/"
    targets = {identifier: item["apiVersion"] for identifier, item in definition["desired"].items()
               if arm_identity(identifier)[2] is None}
    vm_id = root + "Microsoft.Compute/virtualMachines/abx-http-vm"
    targets[vm_id] = "2024-11-01"
    targets[root + "Microsoft.Network/networkInterfaces/abx-vm-nic"] = "2024-05-01"

    def save() -> None:
        evidence_path.write_bytes(encode_json(evidence))

    def observed(identifier: str, api: str):
        try:
            return console.arm.request("GET", identifier, api)
        except ArmHttpError as exc:
            if exc.status == 404 and exc.code in {"ResourceNotFound", "NotFound"}:
                return None
            raise

    def owned(identifier: str, raw: dict) -> None:
        if (not identifier.lower().startswith(root.lower()) or not raw["name"].startswith("abx-")
                or raw.get("tags", {}).get("armbackupLab") != config.lab_id
                or raw.get("tags", {}).get("purpose") != "complex-validation"):
            raise BackupError("Cleanup refused a resource outside recorded test ownership")

    def remove(identifier: str, api: str, *, disk: bool = False) -> None:
        console.guard_scope()
        raw = observed(identifier, api)
        if raw is None:
            evidence["alreadyAbsent"].append(identifier)
            save()
            return
        if not disk:
            owned(identifier, raw)
        for attempt in range(12):
            try:
                console.arm.request("DELETE", identifier, api)
                break
            except ArmHttpError as exc:
                if exc.status != 409 or exc.code not in {
                    "InUseSubnetCannotBeDeleted", "InUseNetworkSecurityGroupCannotBeDeleted", "ResourceInUse",
                } or attempt == 11:
                    raise
                time.sleep(15)
                console.guard_scope()
        for _ in range(180):
            if observed(identifier, api) is None:
                evidence["deleted"].append(identifier)
                save()
                print("Cleaned: " + raw["name"], flush=True)
                return
            time.sleep(5)
        raise BackupError("Cleanup wait exceeded bound; inspect recorded resource state")

    try:
        console.guard_scope()
        vm = observed(vm_id, "2024-11-01")
        disk_id = None
        if vm is not None:
            owned(vm_id, vm)
            disk_id = vm["properties"]["storageProfile"]["osDisk"]["managedDisk"]["id"]
            if disk_id.lower() != (root + "Microsoft.Compute/disks/abx-http-osdisk").lower():
                raise BackupError("Temporary VM disk differs from its recorded creation contract")
            disk = observed(disk_id, "2024-03-02")
            if disk is None or str(disk.get("managedBy", "")).lower() != vm_id.lower():
                raise BackupError("Temporary disk association could not be verified")
            evidence["temporaryDiskProof"] = {"diskId": disk_id, "ownedVmId": vm_id}
            save()
        priorities = {
            "microsoft.cdn/profiles": 0, "microsoft.network/applicationgateways": 1,
            "microsoft.network/loadbalancers": 2, "microsoft.containerinstance/containergroups": 3,
            "microsoft.compute/virtualmachines": 4, "microsoft.network/networkinterfaces": 5,
            "microsoft.network/virtualnetworks": 6, "microsoft.network/natgateways": 7,
            "microsoft.network/networksecuritygroups": 8,
            "microsoft.network/applicationgatewaywebapplicationfirewallpolicies": 8,
            "microsoft.network/publicipaddresses": 9,
        }
        if any(arm_identity(identifier)[0] not in priorities for identifier in targets):
            raise BackupError("Cleanup has a resource type outside the explicit test list")
        for identifier in sorted(targets, key=lambda rid: priorities[arm_identity(rid)[0]]):
            remove(identifier, targets[identifier])
        if disk_id:
            remove(disk_id, "2024-03-02", disk=True)
        remaining = [identifier for identifier, api in targets.items() if observed(identifier, api) is not None]
        if remaining:
            raise BackupError("Recorded test roots remain after cleanup")
        evidence.update({"finishedAt": utc_now(), "status": "Passed",
                         "resourceGroupDeleted": False, "originalLabResourcesPreserved": True})
        save()
    finally:
        console.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Delete only recorded owned abx complex-test roots, never the RG")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--confirm-group", required=True)
    args = parser.parse_args()
    cleanup(args.config.resolve(), args.confirm_group)


if __name__ == "__main__":
    main()
