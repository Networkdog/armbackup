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
    assert write["identityType"] == "SystemAssigned"


def test_user_assigned_identity_is_kept_when_adding_the_system_identity():
    outcome = run_deploy("userassigned")

    assert outcome["result"] == "OK"
    [write] = outcome["writes"]
    assert write["identityType"] == "SystemAssigned,UserAssigned"
    assert write["userIdentities"] == [
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami"
    ]
