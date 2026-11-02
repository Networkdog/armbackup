import json
from unittest.mock import Mock

import pytest

from armbackup.contracts import BackupError, encode_json
from armbackup.local_archive import LocalArchive
from armbackup.state_view import StateView


def setup(tmp_path):
    archive = LocalArchive(tmp_path / "view")
    view = StateView(archive, "/scope", "config-v1")
    state = {"mode": "live-lab", "workspace": {"scope": "/scope"}, "resources": []}
    return archive, view, state


def test_complete_readback_cached_view_never_claims_fresh_arm(tmp_path):
    archive, view, state = setup(tmp_path)
    assert view.read() is None
    result = view.build(lambda: state)
    assert result["materializedView"]["persisted"]
    cached = view.read()
    assert cached["materializedView"]["requiresLiveRefresh"]
    assert cached["workspace"]["scope"] == "/scope"
    assert len(archive.names("console/views/complete")) == 1


def test_scope_config_input_and_age_changes_invalidate(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    assert StateView(archive, "/scope", "changed-config").read() is None
    archive.put("console/jobs/new/requested.json", b"{}")
    assert view.read() is None


def test_during_observation_mutation_never_publishes_success_marker(tmp_path):
    archive, view, state = setup(tmp_path)
    def change():
        archive.put("runs/new/manifest.json", b"{}")
        return state
    result = view.build(change)
    assert not result["materializedView"]["persisted"]
    assert not archive.names("console/views/complete")


def test_corrupt_content_is_explicit_not_a_blank_success(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    name = archive.names("console/views/objects")[0]
    original = archive.get
    archive.get = Mock(side_effect=lambda path: b"bad" if path == name else original(path))
    with pytest.raises(BackupError, match="integrity"):
        view.read()


def test_missing_marker_never_reads_orphan_payload(tmp_path):
    archive, view, _ = setup(tmp_path)
    archive.put("console/views/objects/orphan.json", b"{}")
    assert view.read() is None


def test_expired_marker_never_authorizes_saved_view(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    name = archive.names("console/views/complete")[0]
    marker = json.loads(archive.get(name))
    marker["createdAt"] = "2020-01-01T00:00:00Z"
    original = archive.get
    archive.get = Mock(side_effect=lambda path: encode_json(marker) if path == name else original(path))
    assert view.read() is None
