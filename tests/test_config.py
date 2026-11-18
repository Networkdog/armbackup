import json

import pytest

from armbackup.config import Config
from armbackup.contracts import BackupError


def load(tmp_path, data):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return Config.load(p)


def test_example_valid(tmp_path, config_data):
    config = load(tmp_path, config_data)
    assert config.require_private_storage
    assert config.credential == "managed_identity"
    assert len(config.tables) == 4


@pytest.mark.parametrize("key,value", [
    ("workers", 0), ("workers", True), ("timeout_seconds", 301), ("retries", -1),
    ("credential", "default"), ("subscriptions", ["not-uuid"]),
    ("subscriptions", ["11111111-1111-1111-1111-111111111111"] * 2),
    ("discovery_tables", []), ("discovery_tables", ["Typo"]),
    ("allow_preview", "true"), ("api_versions", {"x/y": "latest"}),
    ("api_versions", {"x/y": "2024-01-01-preview"}),
    ("unknown", "mistyped setting"),
])
def test_reject_config(tmp_path, config_data, key, value):
    config_data[key] = value
    with pytest.raises(BackupError):
        load(tmp_path, config_data)


@pytest.mark.parametrize("section,key,value", [
    ("storage", "account_url", "https://evil.example.com"),
    ("storage", "prefix", "../x"), ("storage", "container", "a"),
    ("storage", "require_private_endpoint", "false"),
    ("logging", "endpoint", "https://monitor.azure.com.evil.example.com"),
    ("logging", "rule_id", "workspace-id"), ("logging", "stream", "ArmBackup_CL"),
    ("logging", "workspace_resource_id", "workspace-id"),
    ("logging", "dcr_resource_id", None),
])
def test_reject_endpoints(tmp_path, config_data, section, key, value):
    config_data[section][key] = value
    with pytest.raises(BackupError):
        load(tmp_path, config_data)


@pytest.mark.parametrize("path", ["../secrets", "/absolute", "foo?x=1", "foo//bar", "https://evil"])
def test_reject_collection_escape(tmp_path, config_data, path):
    config_data["collections"]["x/y"] = [{
        "name": "bad", "path": path, "api_version": "2024-01-01", "mode": "object",
    }]
    with pytest.raises(BackupError):
        load(tmp_path, config_data)


def test_logging_section_is_optional_and_can_be_supplied_by_env_vars(tmp_path, config_data, monkeypatch):
    original_logging = config_data.pop("logging")
    without_logging = load(tmp_path, config_data)
    assert not without_logging.logging_enabled
    assert without_logging.dcr_id == "" and without_logging.workspace_id == ""

    monkeypatch.setenv("ARMBACKUP_LOG_WORKSPACE_ID", original_logging["workspace_resource_id"])
    with pytest.raises(BackupError):
        load(tmp_path, config_data)

    monkeypatch.setenv("ARMBACKUP_LOG_DCR_ID", original_logging["dcr_resource_id"])
    monkeypatch.setenv("ARMBACKUP_LOG_ENDPOINT", original_logging["endpoint"])
    monkeypatch.setenv("ARMBACKUP_LOG_RULE_ID", original_logging["rule_id"])
    with_env_logging = load(tmp_path, config_data)
    assert with_env_logging.logging_enabled
    assert with_env_logging.logs_stream == "Custom-ArmBackup"
    assert with_env_logging.dcr_id == original_logging["dcr_resource_id"]

