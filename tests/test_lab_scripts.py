import importlib.util
from dataclasses import replace
from unittest.mock import Mock, patch

import pytest
from conftest import ROOT, SID

from armbackup.console import ConsoleConfig
from armbackup.contracts import BackupError


@pytest.fixture
def cleanup_module():
    spec = importlib.util.spec_from_file_location("lab_cleanup", ROOT / "scripts" / "cleanup_lab.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def lab_settings(config, tmp_path):
    return ConsoleConfig(replace(config, resource_groups=("rg-armbackup-test",)),
                         "MSP Test", "Lab", "unit-lab", SID, True, 2, "local", tmp_path)


def test_cleanup_requires_exact_name_before_constructing_azure_client(cleanup_module, lab_settings):
    with patch.object(cleanup_module.ConsoleConfig, "load", return_value=lab_settings), patch.object(
        cleanup_module, "ArmClient",
    ) as factory:
        with pytest.raises(BackupError, match="exact"):
            cleanup_module.cleanup(ROOT / "unused.local.json", "wrong")
    factory.assert_not_called()


@pytest.mark.parametrize("case", ["group", "resource", "runner"])
def test_cleanup_blocks_scope_ownership_changes_and_active_runner(cleanup_module, lab_settings, case):
    arm = Mock()
    arm.request.return_value = {"tags": {"armbackupLab": "other" if case == "group" else "unit-lab"}}
    arm.pages.return_value = [
        {"tags": {} if case == "resource" else {"armbackupLab": "unit-lab"},
         "type": "Microsoft.ContainerInstance/containerGroups" if case == "runner" else "Microsoft.Network/networkSecurityGroups"}
    ]
    with patch.object(cleanup_module.ConsoleConfig, "load", return_value=lab_settings), patch.object(
        cleanup_module, "credential",
    ), patch.object(cleanup_module, "ArmClient", return_value=arm):
        with pytest.raises(BackupError):
            cleanup_module.cleanup(ROOT / "unused.local.json", lab_settings.group)
    assert all(call.args[0] != "DELETE" for call in arm.request.call_args_list)


def test_cleanup_deletes_only_confirmed_owned_rg_and_preserves_archive(cleanup_module, lab_settings):
    arm = Mock()
    arm.request.return_value = {"tags": {"armbackupLab": "unit-lab"}}
    arm.pages.return_value = [{"tags": {"armbackupLab": "unit-lab"},
                              "type": "Microsoft.Network/networkSecurityGroups"}]
    local_file = lab_settings.local_archive / "proof.json"
    local_file.write_bytes(b"preserve")
    with patch.object(cleanup_module.ConsoleConfig, "load", return_value=lab_settings), patch.object(
        cleanup_module, "credential",
    ), patch.object(cleanup_module, "ArmClient", return_value=arm):
        cleanup_module.cleanup(ROOT / "unused.local.json", lab_settings.group)
    deletes = [call for call in arm.request.call_args_list if call.args[0] == "DELETE"]
    assert len(deletes) == 1
    assert deletes[0].args[1] == lab_settings.scope
    assert local_file.read_bytes() == b"preserve"
