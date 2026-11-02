import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from armbackup.contracts import BackupError, digest, encode_json
from armbackup.local_archive import LocalArchive
from armbackup.state_view import StateRefresher, StateView


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


def test_scope_and_config_changes_invalidate_but_input_changes_remain_read_only(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    assert StateView(archive, "/scope", "changed-config").read() is None
    archive.put("console/jobs/new/requested.json", b"{}")
    cached = view.read()
    assert cached["materializedView"]["requiresLiveRefresh"]


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
    changed = encode_json(marker)
    pointer, etag = archive.read_pointer(view.pointer)
    head = json.loads(pointer)
    head["markerSha256"] = digest(changed)
    with archive.guard("state-view"):
        assert archive.replace_pointer(view.pointer, encode_json(head), etag)
    archive.get = Mock(side_effect=lambda path: changed if path == name else original(path))
    cached = view.read()
    assert cached["materializedView"]["expired"]
    assert cached["materializedView"]["requiresLiveRefresh"]


def test_pointer_read_never_lists_backup_inputs_or_markers(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    archive.names = Mock(side_effect=AssertionError("Fast path must not enumerate archives"))
    archive.get = Mock(wraps=archive.get)
    archive.read_pointer = Mock(wraps=archive.read_pointer)
    assert view.read()["resources"] == []
    assert archive.get.call_count == 2
    archive.read_pointer.assert_called_once_with(view.pointer)


def test_changed_completion_marker_is_not_a_valid_cached_view(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    original = archive.get
    archive.get = Mock(side_effect=lambda path: b"{}" if "/complete/" in path else original(path))
    with pytest.raises(BackupError, match="marker integrity"):
        view.read()


def test_older_collection_cannot_replace_a_concurrently_published_pointer(tmp_path):
    _, view, state = setup(tmp_path)
    newer = {**state, "resources": [{"id": "newer-observation"}]}
    def collect_older():
        assert view.build(lambda: newer)["materializedView"]["persisted"]
        return state
    result = view.build(collect_older)
    assert not result["materializedView"]["persisted"]
    assert view.read()["resources"] == newer["resources"]


def test_pointer_cas_is_atomic_and_never_overwrites_immutable_backups(tmp_path):
    archive, view, _ = setup(tmp_path)
    with archive.guard("state-view"):
        assert archive.replace_pointer(view.pointer, b"first", None)
        assert not archive.replace_pointer(view.pointer, b"wrong", None)
        assert not archive.replace_pointer(view.pointer, b"wrong", "stale-etag")
        assert archive.replace_pointer(view.pointer, b"second", digest(b"first"))
        with pytest.raises(BackupError, match="Only state view"):
            archive.replace_pointer("runs/run/manifest.json", b"bad", None)
    assert archive.read_pointer(view.pointer)[0] == b"second"


def test_background_collectors_are_shared_and_reused_until_invalidated(tmp_path):
    _, view, state = setup(tmp_path)
    started, release = threading.Event(), threading.Event()
    def collect():
        started.set()
        assert release.wait(5)
        return state
    loader = Mock(side_effect=collect)
    service = StateRefresher(lambda: view, loader)
    try:
        first = service.request()
        assert started.wait(5)
        with ThreadPoolExecutor(max_workers=8) as pool:
            assert set(pool.map(lambda _: service.request(force=True), range(20))) == {first}
        assert service.status(first)["status"] == "Running"
        release.set()
        assert service.wait(first)["materializedView"]["persisted"]
        assert service.request() == first
        assert loader.call_count == 1
        service.invalidate()
        second = service.request()
        service.wait(second)
        assert second != first and loader.call_count == 2
    finally:
        release.set()
        service.close()


def test_failed_background_refresh_retains_the_verified_read_only_view(tmp_path):
    _, view, state = setup(tmp_path)
    view.build(lambda: state)
    service = StateRefresher(lambda: view, Mock(side_effect=BackupError("ARM permission denied")))
    try:
        identifier = service.request()
        with pytest.raises(BackupError, match="permission denied"):
            service.wait(identifier)
        assert service.status(identifier)["status"] == "Failed"
        assert service.request() == identifier
        assert view.read()["materializedView"]["requiresLiveRefresh"]
    finally:
        service.close()


def test_periodic_refresh_runs_without_any_browser(tmp_path, monkeypatch):
    import armbackup.state_view as module
    monkeypatch.setattr(module, "FRESH_SECONDS", .05)
    _, view, state = setup(tmp_path)
    repeated = threading.Event()
    calls = []
    def collect():
        calls.append(True)
        if len(calls) >= 2:
            repeated.set()
        return state
    service = StateRefresher(lambda: view, collect)
    try:
        service.start()
        assert repeated.wait(5)
    finally:
        service.close()
    assert service.thread is not None and not service.thread.is_alive()
