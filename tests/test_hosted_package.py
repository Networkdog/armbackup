import json
from zipfile import ZipFile

import pytest

from armbackup.webui import read_build
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


def test_deployed_build_marker_is_read_defensively(tmp_path):
    marker = tmp_path / "build.json"
    assert read_build(marker) == ""
    marker.write_text('{"commit": "484f0adb5f3f"}')
    assert read_build(marker) == "484f0adb5f3f"
    for text in ('{"commit": "main"}', '{"commit": 5}', '[]', 'not json', '{"commit": "<script>"}'):
        marker.write_text(text)
        assert read_build(marker) == "", text
