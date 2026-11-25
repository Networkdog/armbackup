import json
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import ROOT

SCRIPT = ROOT / "scripts" / "deploy-customer.ps1"
HARNESS = Path(__file__).with_name("deploy_customer_harness.ps1")
POWERSHELL = shutil.which("pwsh")

pytestmark = pytest.mark.skipif(POWERSHELL is None, reason="PowerShell 7 (pwsh) is not installed")


def run_deploy(scenario: str) -> dict:
    """Runs deploy-customer.ps1 against a fake az that enforces the KT App Service policy."""
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-File", str(HARNESS), "-Script", str(SCRIPT), "-Scenario", scenario],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    lines = [line for line in completed.stdout.splitlines() if line.startswith("RESULT_JSON:")]
    assert lines, completed.stdout + completed.stderr
    return json.loads(lines[-1].removeprefix("RESULT_JSON:"))


def test_new_app_is_created_by_one_policy_compliant_write():
    outcome = run_deploy("new")

    assert outcome["result"] == "OK"
    assert [(w["method"], w["denied"], w["defaultAction"]) for w in outcome["writes"]] == [("PUT", False, "Deny")]
    # Both commands read the site and PUT it back without the default action, which the KT policy rejects.
    assert not [c for c in outcome["calls"] if c.startswith(("webapp identity", "webapp update"))]


def test_converged_app_is_not_written():
    outcome = run_deploy("converged")

    assert outcome["result"] == "OK"
    assert outcome["writes"] == []


def test_drifted_app_is_repaired_by_one_policy_compliant_patch():
    outcome = run_deploy("drifted")

    assert outcome["result"] == "OK"
    [write] = outcome["writes"]
    assert (write["method"], write["denied"], write["defaultAction"]) == ("PATCH", False, "Deny")
    assert write["identityType"] == "None"


def test_user_assigned_identity_is_kept_and_system_identity_is_disabled():
    outcome = run_deploy("userassigned")

    assert outcome["result"] == "OK"
    [write] = outcome["writes"]
    assert write["identityType"] == "UserAssigned"
    assert write["userIdentities"] == [
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami"
    ]


def test_preflight_rejects_mismatched_storage_or_keyvault_before_azure_calls(tmp_path):
    cfg = tmp_path / "deploy-config.json"
    cfg.write_text(
        json.dumps(
            {
                "console": {"archive_mode": "blob", "workspace_name": "W", "subscription_name": "S"},
                "capture": {
                    "subscriptions": ["sub"],
                    "resource_groups": ["rg"],
                    "credential": "managed_identity",
                    "storage": {
                        "account_url": "https://expectedacct.blob.core.windows.net",
                        "container": "armbackup",
                        "require_private_endpoint": True,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    base_cmd = [
        POWERSHELL,
        "-NoProfile",
        "-File",
        str(SCRIPT),
        "-SubscriptionId",
        "sub",
        "-ResourceGroup",
        "rg",
        "-AppName",
        "app-test",
        "-AppServicePlanId",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan",
        "-VnetSubnetId",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s1",
        "-PrivateEndpointSubnetId",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s2",
        "-WorkspaceId",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law",
        "-DeployConfigFile",
        str(cfg),
        "-WhatIf",
    ]
    bad_storage = subprocess.run(
        [*base_cmd, "-StorageAccountId", "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/wrongacct"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert bad_storage.returncode != 0
    assert "storage.account_url" in (bad_storage.stdout + bad_storage.stderr)

    bad_kv = subprocess.run(
        [
            *base_cmd,
            "-StorageAccountId",
            "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/expectedacct",
            "-Username",
            "ops.admin",
            "-PasswordHash",
            "@Microsoft.KeyVault(SecretUri=https://kv-one.vault.azure.net/secrets/h/)",
            "-KeyVaultId",
            "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-two",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert bad_kv.returncode != 0
    assert "Key Vault reference points to vault" in (bad_kv.stdout + bad_kv.stderr)

