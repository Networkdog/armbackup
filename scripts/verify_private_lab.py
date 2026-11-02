from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
import uuid
import zlib
from pathlib import Path

from azure.core.exceptions import AzureError
from provision_lab import assign_role, poll, put_owned

from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, credential, encode_json
from armbackup.http import ArmClient
from armbackup.monitoring import LogsReader

ROOT = Path(__file__).resolve().parents[1]


def runner(console_path: Path) -> None:
    config = ConsoleConfig.load(console_path)
    if config.archive_mode != "blob" or not config.capture.require_private_storage:
        raise BackupError("Private runner requires actual Blob and private DNS enforcement")
    console: LiveConsole | None = None
    for attempt in range(24):
        try:
            console = LiveConsole.connect(config)
            break
        except (BackupError, AzureError) as exc:
            if attempt == 23:
                raise
            print(f"Waiting for newly scoped managed-identity roles: {type(exc).__name__}", flush=True)
            time.sleep(10)
    if console is None:
        raise BackupError("Private runner could not initialize")

    def wait(job: JsonObject) -> JsonObject:
        for _ in range(240):
            current = console.job(job["id"])
            if current["status"] == "Failed":
                raise BackupError(str(current.get("error", "Private lab operation failed")))
            if current["status"] == "Succeeded":
                return current["result"]
            time.sleep(3)
        raise BackupError("Private lab operation timed out")

    try:
        backup = wait(console.submit("backup", {"label": "Managed identity + private Blob validation"}))
        snapshot_run = backup["runId"]
        source = config.scope + "/providers/Microsoft.Network/networkSecurityGroups/nsg-msp-edge"
        name = "nsg-msp-private-restored"
        review = console.prepare({"resourceId": source, "runId": snapshot_run, "mode": "create",
                                  "targetName": name, "ticket": "LAB-PRIVATE-001",
                                  "reason": "Validate private Blob safety backup and managed-identity restoration"})
        restored = wait(console.submit("restore", {
            "planId": review["id"], "approvalSha256": review["approvalSha256"], "confirmTarget": name,
        }))
        safety = console.read_run(restored["safetyRunId"])
        if not safety["verified"]:
            raise BackupError("Private safety backup failed integrity verification")
        target = restored["targetResourceId"]
        config.resource(target)
        current = console.arm.request("GET", target, config.capture.api_versions[
            "microsoft.network/networksecuritygroups"])
        if current.get("tags", {}).get("armbackupLab") != config.lab_id:
            raise BackupError("Refusing private test clone cleanup without the ownership tag")
        delete_resource(console.arm, target, config.capture.api_versions["microsoft.network/networksecuritygroups"])
        evidence = {
            "privateStorageEnforced": True, "credential": "managed_identity",
            "archiveMode": "blob", "backupRunId": snapshot_run,
            "capturedCount": backup["capturedCount"], "safetyRunId": restored["safetyRunId"],
            "safetyIntegrityVerified": safety["verified"], "restoreStatus": restored["status"],
            "postRestoreComparison": restored["comparison"]["status"],
            "logsIngestion": "Accepted", "planId": restored["planId"],
            "testCloneCleanupVerified": True,
            "coverage": "Private ACI runner, not App Service/WebJob hosting validation",
        }
        print("PRIVATE_LAB_RESULT=" + json.dumps(evidence, ensure_ascii=False), flush=True)
    finally:
        console.close()


def delete_resource(arm: ArmClient, path: str, api: str) -> None:
    try:
        arm.request("DELETE", path, api)
    except ArmHttpError as exc:
        if exc.status != 404:
            raise
        return
    for _ in range(60):
        try:
            arm.request("GET", path, api)
        except ArmHttpError as exc:
            if exc.status == 404:
                return
            raise
        time.sleep(3)
    raise BackupError(f"Cleanup timed out: {path.rsplit('/', 1)[-1]}")


def verify(console_path: Path) -> None:
    config = ConsoleConfig.load(console_path)
    arm = ArmClient(credential(config.capture.credential, config.capture.client_id))
    group = arm.request("GET", config.scope, "2021-04-01")
    if group.get("tags", {}).get("armbackupLab") != config.lab_id:
        raise BackupError("Private runner refuses a resource group without the expected ownership tag")
    location = group["location"]
    root = config.scope
    tags = {"armbackupLab": config.lab_id, "purpose": "private-path-validation", "lifecycle": "temporary"}
    network_api = "2024-05-01"
    vnet = root + "/providers/Microsoft.Network/virtualNetworks/vnet-msp-lab"
    account = config.capture.storage_url.split("//", 1)[1].split(".", 1)[0]
    storage = root + f"/providers/Microsoft.Storage/storageAccounts/{account}"
    public_ip = root + "/providers/Microsoft.Network/publicIPAddresses/pip-armbackup-runner"
    nat = root + "/providers/Microsoft.Network/natGateways/nat-armbackup-runner"
    pe = root + "/providers/Microsoft.Network/privateEndpoints/pe-armbackup-blob"
    zone = root + "/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net"
    identity_id = root + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-armbackup-runner"
    aci_subnet = vnet + "/subnets/armbackup-runner"
    pe_subnet = vnet + "/subnets/armbackup-private"
    container_id = root + "/providers/Microsoft.ContainerInstance/containerGroups/aci-armbackup-private-check"
    cleanup: list[tuple[str, str]] = []
    try:
        previous_clone = root + "/providers/Microsoft.Network/networkSecurityGroups/nsg-msp-private-restored"
        try:
            previous = arm.request("GET", previous_clone, network_api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
        else:
            if previous.get("tags", {}).get("armbackupLab") != config.lab_id:
                raise BackupError("Previous private test target is not owned by this lab")
            delete_resource(arm, previous_clone, network_api)
        put_owned(arm, public_ip, network_api, {
            "location": location, "tags": tags, "sku": {"name": "Standard"},
            "properties": {"publicIPAllocationMethod": "Static"},
        }, config.lab_id)
        cleanup.append((public_ip, network_api))
        put_owned(arm, nat, network_api, {
            "location": location, "tags": tags, "sku": {"name": "Standard"},
            "properties": {"publicIpAddresses": [{"id": public_ip}], "idleTimeoutInMinutes": 4},
        }, config.lab_id)
        cleanup.append((nat, network_api))
        arm.request("PUT", aci_subnet, network_api, {"properties": {
            "addressPrefix": "10.40.10.0/24", "natGateway": {"id": nat},
            "delegations": [{"name": "aci", "properties": {"serviceName": "Microsoft.ContainerInstance/containerGroups"}}],
        }})
        poll(arm, aci_subnet, network_api)
        cleanup.append((aci_subnet, network_api))
        arm.request("PUT", pe_subnet, network_api, {"properties": {
            "addressPrefix": "10.40.20.0/24", "privateEndpointNetworkPolicies": "Disabled",
        }})
        poll(arm, pe_subnet, network_api)
        cleanup.append((pe_subnet, network_api))
        put_owned(arm, pe, network_api, {
            "location": location, "tags": tags, "properties": {
                "subnet": {"id": pe_subnet}, "privateLinkServiceConnections": [{
                    "name": "blob", "properties": {"privateLinkServiceId": storage, "groupIds": ["blob"]},
                }],
            },
        }, config.lab_id)
        cleanup.append((pe, network_api))
        put_owned(arm, zone, "2020-06-01", {"location": "global", "tags": tags}, config.lab_id)
        cleanup.append((zone, "2020-06-01"))
        arm.request("PUT", zone + "/virtualNetworkLinks/armbackup-runner", "2020-06-01", {
            "location": "global", "tags": tags,
            "properties": {"registrationEnabled": False, "virtualNetwork": {"id": vnet}},
        })
        poll(arm, zone + "/virtualNetworkLinks/armbackup-runner", "2020-06-01")
        cleanup.append((zone + "/virtualNetworkLinks/armbackup-runner", "2020-06-01"))
        arm.request("PUT", pe + "/privateDnsZoneGroups/default", network_api, {
            "properties": {"privateDnsZoneConfigs": [{"name": "blob", "properties": {"privateDnsZoneId": zone}}]},
        })
        cleanup.append((pe + "/privateDnsZoneGroups/default", network_api))
        identity = put_owned(arm, identity_id, "2023-01-31",
                             {"location": location, "tags": tags}, config.lab_id)
        cleanup.append((identity_id, "2023-01-31"))
        principal, client_id = identity["properties"]["principalId"], identity["properties"]["clientId"]
        for scope, role in [
            (root, "acdd72a7-3385-48ef-bd42-f606fba81ae7"),
            (root, "4d97b98b-1d4f-4787-a291-c67834d212e7"),
            (storage, "ba92f5b4-2d11-453d-a403-e96b0029c9fe"),
            (config.capture.dcr_id, "3913510d-42f4-4e42-8a64-420c390055eb"),
        ]:
            assign_role(arm, config.subscription, scope, principal, "ServicePrincipal", role)
            assignment = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{scope}/{principal}/{role}".lower()))
            cleanup.append((scope + f"/providers/Microsoft.Authorization/roleAssignments/{assignment}", "2022-04-01"))
        capture_data = json.loads((console_path.parent / "capture.local.json").read_text(encoding="utf-8"))
        capture_data.update({"credential": "managed_identity", "managed_identity_client_id": client_id})
        capture_data["storage"]["require_private_endpoint"] = True
        console_data = json.loads(console_path.read_text(encoding="utf-8"))
        console_data.update({"archive_mode": "blob", "capture_config": "capture.local.json"})
        payload = {
            "files": {f"armbackup/{path.name}": base64.b64encode(path.read_bytes()).decode()
                      for path in (ROOT / "src" / "armbackup").glob("*.py")},
            "capture": capture_data, "console": console_data,
            "runner": base64.b64encode(Path(__file__).read_bytes()).decode(),
            "helper": base64.b64encode((ROOT / "scripts" / "provision_lab.py").read_bytes()).decode(),
            "requirements": (ROOT / "requirements.txt").read_text(encoding="utf-8"),
        }
        encoded = base64.b64encode(zlib.compress(encode_json(payload), level=9)).decode()
        boot = f"""
import base64,json,pathlib,subprocess,sys,zlib
p=json.loads(zlib.decompress(base64.b64decode({encoded!r})))
r=pathlib.Path('/tmp/armbackup-private');r.mkdir(exist_ok=True)
for name,value in p['files'].items():
 f=r/name;f.parent.mkdir(exist_ok=True);f.write_bytes(base64.b64decode(value))
(r/'capture.local.json').write_text(json.dumps(p['capture']))
(r/'console.local.json').write_text(json.dumps(p['console']))
(r/'private_runner.py').write_bytes(base64.b64decode(p['runner']))
(r/'provision_lab.py').write_bytes(base64.b64decode(p['helper']))
(r/'requirements.txt').write_text(p['requirements'])
subprocess.run([sys.executable,'-m','venv',str(r/'venv')],check=True)
py=str(r/'venv/bin/python')
probe=subprocess.run([py,'-c','import azure.identity,azure.storage.blob,azure.monitor.ingestion'],capture_output=True)
if probe.returncode:
 subprocess.run([py,'-m','pip','install','--disable-pip-version-check','-r',str(r/'requirements.txt')],check=True)
subprocess.run([py,str(r/'private_runner.py'),'--inside',str(r/'console.local.json')],check=True,cwd=r)
"""
        command = boot
        if len(command.encode()) > 96 * 1024:
            raise BackupError(f"Private runner payload exceeds the bounded command size: {len(command.encode())} bytes")
        arm.request("PUT", container_id, "2023-05-01", {
            "location": location, "tags": tags,
            "identity": {"type": "UserAssigned", "userAssignedIdentities": {identity_id: {}}},
            "properties": {
                "osType": "Linux", "restartPolicy": "Never",
                "subnetIds": [{"id": aci_subnet}],
                "ipAddress": {"type": "Private", "ports": [{"port": 8080, "protocol": "TCP"}]},
                "containers": [{
                    "name": "runner", "properties": {
                        "image": "mcr.microsoft.com/azure-cli:latest",
                        "command": ["python3", "-c", command],
                        "resources": {"requests": {"cpu": 1, "memoryInGB": 1.5}},
                        "ports": [{"port": 8080}],
                    },
                }],
            },
        })
        cleanup.append((container_id, "2023-05-01"))
        print("Private runner created; waiting for its terminal state.", flush=True)
        result = None
        for _ in range(180):
            group_state = arm.request("GET", container_id, "2023-05-01")
            props = group_state.get("properties", {})
            instance = props.get("containers", [{}])[0].get("properties", {}).get("instanceView", {})
            current = instance.get("currentState", {})
            if current.get("state") == "Terminated" or props.get("provisioningState") == "Failed":
                content = arm.request("GET", container_id + "/containers/runner/logs?tail=150",
                                      "2023-05-01").get("content", "")
                lines = [line for line in str(content).splitlines() if line.startswith("PRIVATE_LAB_RESULT=")]
                if current.get("exitCode") != 0 or not lines:
                    print(str(content)[-5000:], flush=True)
                    raise BackupError("Private runner failed; inspect its bounded diagnostic output")
                result = json.loads(lines[-1].split("=", 1)[1])
                break
            time.sleep(10)
        if result is None:
            raise BackupError("Private runner wait timed out")
        reader = LogsReader(credential(config.capture.credential, config.capture.client_id),
                            config.workspace_guid, config.scope)
        required = {"pre_restore_backup_completed", "console_restore_completed"}
        for _ in range(30):
            queried = reader.query(days=1, search=result["planId"])
            if required <= {item["event"] for item in queried["logs"]}:
                result["logAnalyticsRows"] = len(queried["logs"])
                result["auditReader"] = f"Separate configured {config.capture.credential} reader; no dedicated log-query role on collector"
                break
            time.sleep(5)
        else:
            raise BackupError("The separate log reader did not observe both safety and restore audit events")
        (console_path.parent / "private-validation.local.json").write_bytes(encode_json(result))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        errors = []
        def cleanup_order(entry: tuple[str, str]) -> int:
            resource_id = entry[0]
            for rank, segment in enumerate((
                "/containerGroups/", "/roleAssignments/", "/userAssignedIdentities/",
                "/privateDnsZoneGroups/", "/virtualNetworkLinks/", "/privateEndpoints/",
                "/privateDnsZones/", "/subnets/", "/natGateways/", "/publicIPAddresses/",
            )):
                if segment in resource_id:
                    return rank
            raise BackupError("Unknown temporary cleanup resource")

        for resource_id, api in sorted(cleanup, key=cleanup_order):
            try:
                delete_resource(arm, resource_id, api)
            except (BackupError, AzureError) as exc:
                errors.append({"resource": resource_id.rsplit("/", 1)[-1],
                               "error": str(exc) if isinstance(exc, BackupError) else type(exc).__name__})
        if errors:
            print(json.dumps({"cleanupErrors": errors}), flush=True)
            raise BackupError("Temporary private-path resources were not all cleaned up")
        print("Temporary ACI, NAT, public IP, PE, private DNS link/zone and runner identity removed.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bounded private-path validation in the owned lab RG")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--inside", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.inside:
            runner(args.inside)
        elif args.config:
            verify(args.config.resolve())
        else:
            parser.error("--config is required")
    except (BackupError, AzureError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"Private validation stopped: {message}\n")


if __name__ == "__main__":
    main()
