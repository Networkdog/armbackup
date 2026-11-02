from __future__ import annotations

import argparse
import base64
import json
import re
import time
import uuid
from pathlib import Path

from azure.core.exceptions import AzureError
from azure.identity import AzureCliCredential

from armbackup.config import UUID
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, encode_json, object_value
from armbackup.events import LOG_COLUMNS
from armbackup.http import ARM_SCOPE, ArmClient


def poll(arm: ArmClient, path: str, api: str, attempts: int = 60) -> JsonObject:
    for _ in range(attempts):
        try:
            value = arm.request("GET", path, api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
            time.sleep(5)
            continue
        state = value.get("properties", {}).get("provisioningState", "Succeeded")
        if state == "Succeeded":
            return value
        if state in {"Failed", "Canceled"}:
            raise BackupError(f"Provisioning failed: {path.rsplit('/', 1)[-1]} ({state})")
        time.sleep(5)
    raise BackupError("Lab provisioning timed out; inspect the explicit resource group")


def put_owned(
    arm: ArmClient, path: str, api: str, body: JsonObject, lab_id: str,
) -> JsonObject:
    try:
        existing = arm.request("GET", path, api)
    except ArmHttpError as exc:
        if exc.status != 404:
            raise
    else:
        if existing.get("tags", {}).get("armbackupLab") != lab_id:
            raise BackupError("Refusing to overwrite an existing resource without the lab ownership tag")
        return existing
    arm.request("PUT", path, api, body)
    return poll(arm, path, api)


def assign_role(
    arm: ArmClient, subscription: str, scope: str, principal: str, kind: str, role: str,
) -> None:
    assignment = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{scope}/{principal}/{role}".lower()))
    arm.request("PUT", scope + f"/providers/Microsoft.Authorization/roleAssignments/{assignment}",
                "2022-04-01", {"properties": {
                    "principalId": principal, "principalType": kind,
                    "roleDefinitionId": f"/subscriptions/{subscription}/providers/Microsoft.Authorization/roleDefinitions/{role}",
                }})


def provision(args: argparse.Namespace) -> None:
    if not UUID.fullmatch(args.subscription):
        raise BackupError("--subscription must be an explicit UUID")
    if not re.fullmatch(r"rg-armbackup-[a-zA-Z0-9-]{1,60}", args.resource_group):
        raise BackupError("Lab resource group must start with rg-armbackup-")
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", args.lab_id):
        raise BackupError("Invalid lab ownership identifier")
    auth = AzureCliCredential()
    arm = ArmClient(auth, timeout=60)
    root = f"/subscriptions/{args.subscription}/resourceGroups/{args.resource_group}"
    tags = {"armbackupLab": args.lab_id, "purpose": "isolated-validation",
            "lifecycle": "temporary", "expiresOn": args.expires_on}
    put_owned(arm, root, "2021-04-01", {"location": args.location, "tags": tags}, args.lab_id)
    network_api = "2024-05-01"
    for name, resource_type, customer, props in [
        ("nsg-msp-edge", "networkSecurityGroups", "customer-alpha", {
            "securityRules": [{"name": "allow-private-https", "properties": {
                "access": "Allow", "direction": "Inbound", "priority": 110,
                "protocol": "Tcp", "sourceAddressPrefix": "10.40.0.0/16",
                "sourcePortRange": "*", "destinationAddressPrefix": "*",
                "destinationPortRange": "443",
            }}],
        }),
        ("nsg-msp-app", "networkSecurityGroups", "customer-beta", {"securityRules": []}),
        ("rt-msp-egress", "routeTables", "customer-alpha", {
            "disableBgpRoutePropagation": False,
            "routes": [{"name": "private-network", "properties": {
                "addressPrefix": "10.50.0.0/16", "nextHopType": "VnetLocal",
            }}],
        }),
        ("vnet-msp-lab", "virtualNetworks", "customer-beta", {
            "addressSpace": {"addressPrefixes": ["10.40.0.0/16"]},
            "subnets": [{"name": "workload", "properties": {"addressPrefix": "10.40.1.0/24"}}],
        }),
    ]:
        body = {
            "location": args.location, "properties": props,
            "tags": {**tags, "armbackupWorkload": "true", "customer": customer,
                     "environment": "lab", "owner": "network-ops", "service": "network"},
        }
        put_owned(arm, root + f"/providers/Microsoft.Network/{resource_type}/{name}",
                  network_api, body, args.lab_id)
        print(f"Ready: {name}", flush=True)

    account = "abmsp" + uuid.uuid5(uuid.NAMESPACE_URL, root.lower()).hex[:17]
    storage_id = root + f"/providers/Microsoft.Storage/storageAccounts/{account}"
    storage_api = "2023-05-01"
    put_owned(arm, storage_id, storage_api, {
        "location": args.location, "tags": tags, "kind": "StorageV2",
        "sku": {"name": "Standard_LRS"},
        "properties": {
            "minimumTlsVersion": "TLS1_2", "allowBlobPublicAccess": False,
            "allowSharedKeyAccess": False, "defaultToOAuthAuthentication": True,
            "publicNetworkAccess": "Disabled",
            "networkAcls": {"bypass": "None", "defaultAction": "Allow"},
            "accessTier": "Hot",
        },
    }, args.lab_id)
    arm.request("PUT", storage_id + "/blobServices/default/containers/armbackup",
                storage_api, {"properties": {"publicAccess": "None"}})
    workspace_id = root + "/providers/Microsoft.OperationalInsights/workspaces/law-armbackup-msp-lab"
    workspace = put_owned(arm, workspace_id, "2023-09-01", {
        "location": args.location, "tags": tags,
        "properties": {"sku": {"name": "PerGB2018"}, "retentionInDays": 30,
                       "workspaceCapping": {"dailyQuotaGb": 0.1},
                       "publicNetworkAccessForIngestion": "Enabled",
                       "publicNetworkAccessForQuery": "Enabled"},
    }, args.lab_id)
    arm.request("PUT", workspace_id + "/tables/ArmBackup_CL", "2022-10-01", {
        "properties": {"schema": {"name": "ArmBackup_CL", "columns": [
            {"name": name, "type": field_type} for name, field_type in LOG_COLUMNS.items()
        ]}, "retentionInDays": 30, "totalRetentionInDays": 30},
    })
    dcr_id = root + "/providers/Microsoft.Insights/dataCollectionRules/dcr-armbackup-msp-lab"
    dcr = put_owned(arm, dcr_id, "2024-03-11", {
        "location": args.location, "tags": tags, "kind": "Direct",
        "properties": {
            "streamDeclarations": {"Custom-ArmBackup": {"columns": [
                {"name": name, "type": field_type} for name, field_type in LOG_COLUMNS.items()
            ]}},
            "destinations": {"logAnalytics": [{"name": "workspace", "workspaceResourceId": workspace_id}]},
            "dataFlows": [{"streams": ["Custom-ArmBackup"], "destinations": ["workspace"],
                           "transformKql": "source", "outputStream": "Custom-ArmBackup_CL"}],
        },
    }, args.lab_id)
    claims_raw = auth.get_token(ARM_SCOPE).token.split(".")[1]
    claims = object_value(json.loads(base64.urlsafe_b64decode(
        claims_raw + "=" * (-len(claims_raw) % 4),
    )), "signed-in token claims")
    principal = claims.get("oid")
    if not isinstance(principal, str) or not UUID.fullmatch(principal):
        raise BackupError("Unable to resolve the current principal for scoped data roles")
    principal_kind = "ServicePrincipal" if claims.get("idtyp") == "app" else "User"
    assign_role(arm, args.subscription, storage_id, principal, principal_kind,
                "ba92f5b4-2d11-453d-a403-e96b0029c9fe")
    assign_role(arm, args.subscription, dcr_id, principal, principal_kind,
                "3913510d-42f4-4e42-8a64-420c390055eb")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    capture = {
        "subscriptions": [args.subscription], "discovery_tables": ["Resources"],
        "resource_groups": [args.resource_group], "exclude_types": [],
        "api_versions": {f"microsoft.network/{kind}": network_api for kind in
                         ("networksecuritygroups", "routetables", "virtualnetworks")},
        "collections": {}, "workers": 3, "retries": 4, "timeout_seconds": 60,
        "credential": "cli",
        "storage": {"account_url": f"https://{account}.blob.core.windows.net",
                    "container": "armbackup", "prefix": "armbackup",
                    "require_private_endpoint": True},
        "logging": {"workspace_resource_id": workspace_id, "dcr_resource_id": dcr_id,
                    "endpoint": dcr["properties"]["endpoints"]["logsIngestion"],
                    "rule_id": dcr["properties"]["immutableId"], "stream": "Custom-ArmBackup"},
    }
    console = {
        "capture_config": "capture.local.json", "workspace_name": "MSP Engineering Lab",
        "subscription_name": args.subscription_name, "lab_id": args.lab_id,
        "workspace_guid": workspace["properties"]["customerId"],
        "restore_enabled": True, "activity_days": 2,
        "archive_mode": "local", "local_archive": "archive",
    }
    for name, content in [("capture.local.json", capture), ("console.local.json", console)]:
        path = output / name
        if path.exists() and path.read_bytes() != encode_json(content) and not args.refresh_lab_settings:
            raise BackupError(f"Existing lab settings differ; refusing to overwrite {name}")
        if not path.exists() or args.refresh_lab_settings:
            path.write_bytes(encode_json(content))
    print(json.dumps({"resourceGroup": args.resource_group, "location": args.location,
                      "storageAccount": account, "workspace": "law-armbackup-msp-lab",
                      "consoleConfig": str(output / "console.local.json"),
                      "network": "Storage private-only; console uses explicit local lab archive, private runner validates Blob",
                      "cleanup": "Delete ONLY the tagged lab resource group when testing is finished"},
                     ensure_ascii=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision only an explicitly owned isolated Azure lab")
    parser.add_argument("--subscription", required=True)
    parser.add_argument("--subscription-name", required=True)
    parser.add_argument("--resource-group", required=True)
    parser.add_argument("--location", default="koreacentral")
    parser.add_argument("--lab-id", required=True)
    parser.add_argument("--expires-on", required=True)
    parser.add_argument("--output", type=Path, default=Path(".armbackup-lab"))
    parser.add_argument("--refresh-lab-settings", action="store_true",
                        help="Explicitly replace generated non-secret lab settings after reviewing the lab scope")
    args = parser.parse_args()
    try:
        provision(args)
    except (BackupError, AzureError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"Lab setup stopped: {message}\n")


if __name__ == "__main__":
    main()
