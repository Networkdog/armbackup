import json
from zipfile import ZipFile

import pytest

from armbackup.webui import read_build
from scripts.package_appservice import main as package_main
from scripts.package_appservice import package


def test_hosted_zip_excludes_local_state_and_requires_private_identity(tmp_path):
    root = tmp_path / "source"
    (root / "src" / "armbackup").mkdir(parents=True)
    (root / "src" / "armbackup" / "webui.py").write_text("print('entry')")
    (root / "src" / "armbackup" / "collector.py.new").write_text("")
    (root / "requirements.txt").write_text("requests")
    (root / "pyproject.toml").write_text("[project]")
    (root / ".env").write_text("secret=do-not-package")
    config = {"console": {"archive_mode": "blob", "local_archive": "never"},
              "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}
    out = tmp_path / "deploy.zip"
    package(out, config, root)
    with ZipFile(out) as archive:
        assert ".env" not in archive.namelist()
        assert "src/armbackup/collector.py.new" not in archive.namelist()
        assert "local_archive" not in json.loads(archive.read("hosted/console.json"))
        assert "src/armbackup/webui.py" in archive.namelist()
        # Oryx compresses the whole ZIP into output.tar.zst, so Kudu never sees App_Data/jobs here.
        assert not [name for name in archive.namelist() if name.startswith("App_Data/")]
    with pytest.raises(ValueError, match="overwrite"):
        package(out, config, root)
    config["capture"]["credential"] = "cli"
    with pytest.raises(ValueError, match="managed identity"):
        package(tmp_path / "bad.zip", config, root)


def test_hosted_zip_records_the_deployed_commit_for_the_deploy_gate(tmp_path):
    root = tmp_path / "source"
    (root / "src" / "armbackup").mkdir(parents=True)
    (root / "requirements.txt").write_text("requests")
    (root / "pyproject.toml").write_text("[project]")
    config = {"console": {"archive_mode": "blob"},
              "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}
    sha = "484f0adb5f3f05b2395cec48733142d931af7008"
    package(tmp_path / "with-build.zip", config, root, build=sha)
    package(tmp_path / "without-build.zip", config, root)
    with ZipFile(tmp_path / "with-build.zip") as archive:
        assert json.loads(archive.read("hosted/build.json")) == {"commit": sha}
    with ZipFile(tmp_path / "without-build.zip") as archive:
        assert "hosted/build.json" not in archive.namelist()
    for bad in ("main", "484F0AD", "../etc", "484f0ad;rm"):
        with pytest.raises(ValueError, match="hexadecimal"):
            package(tmp_path / f"bad-{abs(hash(bad))}.zip", config, root, build=bad)


def test_package_cli_reads_the_config_file_and_build_argument(tmp_path, monkeypatch):
    monkeypatch.delenv("ARMBACKUP_DEPLOY_CONFIG", raising=False)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    config = tmp_path / "deploy-config.json"
    config.write_text(json.dumps(
        {"console": {"archive_mode": "blob"},
         "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}),
        encoding="utf-8-sig")
    out = tmp_path / "out" / "deploy.zip"
    sha = "484f0adb5f3f05b2395cec48733142d931af7008"
    package_main(["--config", str(config), "--build", sha, "--output", str(out)])
    with ZipFile(out) as archive:
        assert json.loads(archive.read("hosted/build.json")) == {"commit": sha}
        assert "src/armbackup/webui.py" in archive.namelist()
    with pytest.raises(ValueError, match="--config"):
        package_main(["--output", str(tmp_path / "none.zip")])


def test_deploy_config_example_packages_and_passes_the_apps_own_validation(tmp_path):
    from pathlib import Path

    from armbackup.console import ConsoleConfig

    root = Path(__file__).resolve().parents[1]
    out = tmp_path / "deploy.zip"
    package_main(["--config", str(root / "examples" / "deploy-config.example.json"), "--output", str(out)])
    with ZipFile(out) as archive:
        archive.extractall(tmp_path / "unzipped")
    settings = ConsoleConfig.load(tmp_path / "unzipped" / "hosted" / "console.json")
    assert settings.archive_mode == "blob" and settings.restore_enabled is False
    assert settings.capture.credential == "managed_identity"


def test_annotated_deploy_config_matches_the_example_and_its_required_marks_are_true(tmp_path):
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    example = json.loads((root / "examples" / "deploy-config.example.json").read_text(encoding="utf-8"))
    annotated = (root / "examples" / "deploy-config.annotated.jsonc").read_text(encoding="utf-8")
    plain = "\n".join(line for line in annotated.splitlines() if not line.strip().startswith("//"))
    assert json.loads(plain) == example

    # Every key the comments call [생략 가능] must really be optional: removing them still passes the app's own loader.
    optional = re.findall(r'//\s*\[생략 가능\].*\n\s*"(\w+)"', annotated)
    assert {"restore_enabled", "activity_days", "discovery_tables", "workers", "prefix"} <= set(optional)
    from armbackup.console import ConsoleConfig

    stripped = json.loads(json.dumps(example))
    for section in (stripped["console"], stripped["capture"], stripped["capture"]["storage"]):
        for key in optional:
            section.pop(key, None)
    out = tmp_path / "minimal.zip"
    config = tmp_path / "minimal.json"
    config.write_text(json.dumps(stripped), encoding="utf-8")
    package_main(["--config", str(config), "--output", str(out)])
    with ZipFile(out) as archive:
        archive.extractall(tmp_path / "unzipped")
    ConsoleConfig.load(tmp_path / "unzipped" / "hosted" / "console.json")

    # ...and every key it calls [필수] or [고정] must really be needed: removing any one breaks packaging or loading.
    required = [(section, key) for section, key in (
        ("console", "workspace_name"), ("console", "subscription_name"), ("console", "workspace_guid"),
        ("console", "archive_mode"), ("capture", "subscriptions"), ("capture", "resource_groups"),
        ("capture", "api_versions"), ("capture", "credential"), ("capture", "storage"), ("capture", "logging"))]
    required += [("storage", "account_url"), ("storage", "container"), ("storage", "require_private_endpoint")]
    required += [("logging", key) for key in ("workspace_resource_id", "dcr_resource_id", "endpoint", "rule_id", "stream")]
    for index, (section, key) in enumerate(required):
        broken = json.loads(json.dumps(example))
        holder = {"console": broken["console"], "capture": broken["capture"],
                  "storage": broken["capture"]["storage"], "logging": broken["capture"]["logging"]}[section]
        del holder[key]
        bad = tmp_path / f"bad-{index}.json"
        bad.write_text(json.dumps(broken), encoding="utf-8")
        target = tmp_path / f"bad-{index}.zip"
        try:
            package_main(["--config", str(bad), "--output", str(target)])
            with ZipFile(target) as archive:
                archive.extractall(tmp_path / f"bad-{index}")
            ConsoleConfig.load(tmp_path / f"bad-{index}" / "hosted" / "console.json")
        except Exception:  # noqa: BLE001 - any failure proves the key is required
            continue
        raise AssertionError(f"{section}.{key} is marked required but removing it still works")


def test_deployed_build_marker_is_read_defensively(tmp_path):
    marker = tmp_path / "build.json"
    assert read_build(marker) == ""
    marker.write_text('{"commit": "484f0adb5f3f"}')
    assert read_build(marker) == "484f0adb5f3f"
    for text in ('{"commit": "main"}', '{"commit": 5}', '[]', 'not json', '{"commit": "<script>"}'):
        marker.write_text(text)
        assert read_build(marker) == "", text
