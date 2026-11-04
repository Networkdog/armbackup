import json
from pathlib import Path
from zipfile import ZipFile

import pytest

from scripts.package_appservice import package


def test_hosted_zip_excludes_local_state_and_requires_private_identity(tmp_path):
    root = tmp_path / "source"
    (root / "src" / "armbackup").mkdir(parents=True)
    (root / "src" / "armbackup" / "webui.py").write_text("print('entry')")
    (root / "requirements.txt").write_text("requests")
    (root / "pyproject.toml").write_text("[project]")
    (root / "webjob").mkdir()
    (root / "webjob" / "snapshot-run.sh").write_bytes(b"#!/bin/sh\r\nexec python -m armbackup.collector\r\n")
    (root / "webjob" / "snapshot-settings.job").write_text('{"schedule":"0 */5 * * * *"}')
    (root / ".env").write_text("secret=do-not-package")
    config = {"console": {"archive_mode": "blob", "local_archive": "never"},
              "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}
    out = tmp_path / "deploy.zip"
    package(out, config, root)
    with ZipFile(out) as archive:
        assert ".env" not in archive.namelist()
        assert "local_archive" not in json.loads(archive.read("hosted/console.json"))
        assert "src/armbackup/webui.py" in archive.namelist()
        job = "App_Data/jobs/triggered/armbackup-snapshot"
        assert json.loads(archive.read(f"{job}/settings.job"))["schedule"] == "0 */5 * * * *"
        assert json.loads(archive.read(f"{job}/console.json"))["capture_config"] == "capture.json"
        assert json.loads(archive.read(f"{job}/capture.json")) == config["capture"]
        assert "armbackup.collector" in archive.read(f"{job}/run.sh").decode()
        assert b"\r" not in archive.read(f"{job}/run.sh")
        assert archive.getinfo(f"{job}/run.sh").external_attr >> 16 & 0o111
        assert f"{job}/armbackup/webui.py" in archive.namelist()
    with pytest.raises(ValueError, match="overwrite"):
        package(out, config, root)
    config["capture"]["credential"] = "cli"
    with pytest.raises(ValueError, match="managed identity"):
        package(tmp_path / "bad.zip", config, root)


def test_hosted_package_includes_worker_dependencies_and_rejects_windows_binaries(tmp_path):
    root = Path(__file__).resolve().parents[1]
    deps = tmp_path / "packages"
    (deps / "azure" / "identity").mkdir(parents=True)
    (deps / "azure" / "identity" / "__init__.py").write_text("# runtime")
    config = {"console": {"archive_mode": "blob"},
              "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}
    out = tmp_path / "deps.zip"
    package(out, config, root, job_dependencies=deps)
    with ZipFile(out) as archive:
        assert "App_Data/jobs/triggered/armbackup-snapshot/.python_packages/lib/site-packages/azure/identity/__init__.py" in archive.namelist()
    (deps / "windows.pyd").write_bytes(b"Windows")
    with pytest.raises(ValueError, match="Windows binary"):
        package(tmp_path / "bad-deps.zip", config, root, job_dependencies=deps)
