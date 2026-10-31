import copy
import importlib.util
import json
import stat
import zipfile
from unittest.mock import Mock

import pytest
from conftest import RID, ROOT, SID, MemoryEvents, nsg

from armbackup.cli import main
from armbackup.contracts import ArmHttpError, BackupError, digest, encode_json
from armbackup.restore import apply_plan, build_plan


def snapshot():
    return {"schemaVersion": 1, "resourceType": "microsoft.network/networksecuritygroups",
            "resourceId": RID, "captureApiVersion": "2024-05-01", "raw": nsg()}


def test_restore_projection_no_read_only_fields():
    plan = build_plan(snapshot(), RID, "2024-05-01")
    assert "provisioningState" not in plan["body"]["properties"]
    assert "defaultSecurityRules" not in plan["body"]["properties"]
    assert "etag" not in plan["body"]["properties"]["securityRules"][0]
    assert plan["body"]["properties"]["securityRules"][0]["properties"]["priority"] == 100


def test_cross_version_restore_explicitly_blocked():
    with pytest.raises(BackupError, match="Cross-version"):
        build_plan(snapshot(), RID, "2025-01-01")


def test_unknown_new_properties_not_silently_dropped():
    data = snapshot()
    data["raw"]["properties"]["unknownFutureSetting"] = "x"
    with pytest.raises(BackupError, match="does not recognize"):
        build_plan(data, RID, "2024-05-01")


def test_missing_rule_array_does_not_become_empty():
    data = snapshot()
    del data["raw"]["properties"]["securityRules"]
    with pytest.raises(BackupError, match="missing explicit"):
        build_plan(data, RID, "2024-05-01")


def test_clone_reference_mapping_required():
    data = snapshot()
    asg = f"/subscriptions/{SID}/resourceGroups/test/providers/Microsoft.Network/applicationSecurityGroups/a"
    data["raw"]["properties"]["securityRules"][0]["properties"]["sourceApplicationSecurityGroups"] = [{"id": asg}]
    with pytest.raises(BackupError, match="explicit mapping"):
        build_plan(data, RID + "-clone", "2024-05-01")
    plan = build_plan(data, RID + "-clone", "2024-05-01", {asg: asg + "-clone"})
    assert asg + "-clone" in json.dumps(plan["body"])


def test_apply_hash_gates_all_writes():
    arm = Mock()
    with pytest.raises(BackupError, match="hash"):
        apply_plan(build_plan(snapshot(), RID, "2024-05-01"), "wrong", arm, MemoryEvents())
    arm.request.assert_not_called()


def test_existing_target_denied_without_flag():
    arm = Mock()
    arm.request.return_value = nsg()
    plan = build_plan(snapshot(), RID, "2024-05-01")
    with pytest.raises(BackupError, match="Target exists"):
        apply_plan(plan, digest(encode_json(plan)), arm, MemoryEvents())
    assert arm.request.call_count == 1


def test_approved_restore_polls_and_compares():
    arm = Mock()
    plan = build_plan(snapshot(), RID, "2024-05-01")
    arm.request.side_effect = [ArmHttpError(404, "NotFound"), {}, nsg()]
    result = apply_plan(plan, digest(encode_json(plan)), arm, MemoryEvents(), sleep=lambda _: None)
    assert result["status"] == "Succeeded"
    assert arm.request.call_args_list[1].args[0] == "PUT"


def test_restore_different_settings_fails():
    arm = Mock()
    plan = build_plan(snapshot(), RID, "2024-05-01")
    different = copy.deepcopy(nsg())
    different["properties"]["securityRules"][0]["properties"]["priority"] = 200
    arm.request.side_effect = [ArmHttpError(404, "NotFound"), {}, different]
    with pytest.raises(BackupError, match="settings differ"):
        apply_plan(plan, digest(encode_json(plan)), arm, MemoryEvents(), sleep=lambda _: None)


def test_validate_config_cli_no_azure(capsys):
    assert main(["--config", str(ROOT / "examples" / "config.example.json"), "validate-config"]) == 0
    assert "NOT tested" in capsys.readouterr().out


def test_invalid_config_cli_exit(tmp_path):
    assert main(["--config", str(tmp_path / "missing.json"), "validate-config"]) == 1


def test_source_package_layout_and_shell_permissions(tmp_path):
    spec = importlib.util.spec_from_file_location("packager", ROOT / "scripts" / "package_webjob.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = tmp_path / "package.zip"
    module.build(output, dependencies=False)
    with zipfile.ZipFile(output) as archive:
        job = "App_Data/jobs/triggered/armbackup/"
        assert job + "armbackup/cli.py" in archive.namelist()
        assert job + "settings.job" in archive.namelist()
        assert "site_health.py" in archive.namelist()
        assert stat.S_IMODE(archive.getinfo(job + "run.sh").external_attr >> 16) == 0o755
        schedule = json.loads(archive.read(job + "settings.job"))
        assert schedule["schedule"] == "0 0 17 * * *"
        assert "config.json" not in archive.namelist()
        assert b"\r\n" not in archive.read(job + "run.sh")
    with pytest.raises(FileExistsError):
        module.build(output, dependencies=False)
