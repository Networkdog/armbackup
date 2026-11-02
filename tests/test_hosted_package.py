import json
from zipfile import ZipFile

import pytest

from scripts.package_appservice import package


def test_hosted_zip_excludes_local_state_and_requires_private_identity(tmp_path):
    root = tmp_path / "source"
    (root / "src" / "armbackup").mkdir(parents=True)
    (root / "src" / "armbackup" / "webui.py").write_text("print('entry')")
    (root / "requirements.txt").write_text("requests")
    (root / "pyproject.toml").write_text("[project]")
    (root / ".env").write_text("secret=do-not-package")
    config = {"console": {"archive_mode": "blob", "local_archive": "never"},
              "capture": {"credential": "managed_identity", "storage": {"require_private_endpoint": True}}}
    out = tmp_path / "deploy.zip"
    package(out, config, root)
    with ZipFile(out) as archive:
        assert ".env" not in archive.namelist()
        assert "local_archive" not in json.loads(archive.read("hosted/console.json"))
        assert "src/armbackup/webui.py" in archive.namelist()
    with pytest.raises(ValueError, match="overwrite"):
        package(out, config, root)
    config["capture"]["credential"] = "cli"
    with pytest.raises(ValueError, match="managed identity"):
        package(tmp_path / "bad.zip", config, root)
