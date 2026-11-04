import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from armbackup.contracts import BackupError, digest, encode_json
from armbackup.local_archive import LocalArchive
from armbackup.state_view import InvalidStateView, StateRefresher, StateView


def setup(tmp_path):
    archive = LocalArchive(tmp_path / "view")
    view = StateView(archive, "/scope", "config-v1")
    state = {"schemaVersion": 1, "mode": "live-lab", "workspace": {"scope": "/scope"},
             "resources": [], "runs": [], "scopes": [], "current": {}, "policy": {},
             "observedAt": "2026-11-02T00:00:00Z"}
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


def test_display_content_hash_ignores_poll_times_but_not_resource_or_actor_changes(tmp_path):
    _, view, state = setup(tmp_path)
    state["current"] = {"resource": {"observedAt": "2026-11-02T00:00:00Z", "status": "present",
                                   "raw": {"properties": {"port": 443}},
                                   "actor": {"caller": "operator", "at": "2026-11-01T00:00:00Z"}}}
    first = view.build(lambda: state)
    later = {**state, "observedAt": "2026-11-03T00:00:00Z", "startedAt": "2026-11-02T23:59:00Z",
             "current": {"resource": {**state["current"]["resource"], "observedAt": "2026-11-03T00:00:00Z"}}}
    second = view.build(lambda: later)
    assert first["materializedView"]["sha256"] != second["materializedView"]["sha256"]
    assert first["materializedView"]["contentSha256"] == second["materializedView"]["contentSha256"]
    assert view.read()["materializedView"]["contentSha256"] == second["materializedView"]["contentSha256"]
    changed = {**later, "current": {"resource": {**later["current"]["resource"],
                                               "raw": {"properties": {"port": 8443}}}}}
    third = view.build(lambda: changed)
    assert third["materializedView"]["contentSha256"] != second["materializedView"]["contentSha256"]
    actor = {**later, "current": {"resource": {**later["current"]["resource"],
                                             "actor": {"caller": "operator", "at": "2026-11-02T00:00:00Z"}}}}
    assert view.build(lambda: actor)["materializedView"]["contentSha256"] != second["materializedView"]["contentSha256"]


def test_history_generation_clock_does_not_remount_unchanged_snapshot(tmp_path):
    _, view, state = setup(tmp_path)
    first = view.build(lambda: {**state, "changeHistory": {"generatedAt": "earlier", "records": []}})
    later = view.build(lambda: {**state, "changeHistory": {"generatedAt": "later", "records": []}})
    assert first["materializedView"]["contentSha256"] == later["materializedView"]["contentSha256"]
    changed = view.build(lambda: {**state, "changeHistory": {"generatedAt": "later", "records": [{"id": "change"}]}})
    assert changed["materializedView"]["contentSha256"] != later["materializedView"]["contentSha256"]


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
    original = archive.read_pointer
    archive.read_pointer = Mock(side_effect=lambda path: (b"bad", "bad-etag") if path == name else original(path))
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
    original = archive.read_pointer
    changed = encode_json(marker)
    pointer, etag = archive.read_pointer(view.pointer)
    head = json.loads(pointer)
    head["markerSha256"] = digest(changed)
    with archive.guard("state-view"):
        assert archive.replace_pointer(view.pointer, encode_json(head), etag)
    archive.read_pointer = Mock(side_effect=lambda path: (changed, digest(changed)) if path == name else original(path))
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
    assert archive.get.call_count == 0
    assert archive.read_pointer.call_count == 3
    assert archive.read_pointer.call_args_list[0].args == (view.pointer,)


def test_changed_completion_marker_is_not_a_valid_cached_view(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    original = archive.read_pointer
    archive.read_pointer = Mock(side_effect=lambda path: (b"{}", "bad-etag") if "/complete/" in path else original(path))
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


@pytest.mark.parametrize("damage", ["truncated-object", "missing-object", "bad-marker", "bad-pointer"])
def test_corrupt_intermediates_are_removed_and_recreated_without_deleting_backups(tmp_path, damage):
    archive, view, state = setup(tmp_path)
    archive.put("runs/preserved/manifest.json", b"original-backup")
    archive.put("console/policies/preserved.json", b"original-policy")
    view.build(lambda: state)
    object_name = archive.names("console/views/objects")[0]
    marker_name = archive.names("console/views/complete")[0]
    selected = object_name if "object" in damage else marker_name if damage == "bad-marker" else view.pointer
    path = archive.root.joinpath(*selected.split("/"))
    if damage == "missing-object":
        path.unlink()
    else:
        path.write_bytes(b'{"incomplete":')
    with pytest.raises(InvalidStateView) as error:
        view.read()
    assert view.repair(error.value)
    assert archive.read_pointer(view.pointer) is None
    assert archive.get("runs/preserved/manifest.json") == b"original-backup"
    assert archive.get("console/policies/preserved.json") == b"original-policy"
    assert view.build(lambda: state)["materializedView"]["persisted"]
    assert view.read()["resources"] == []


def test_repair_does_not_remove_a_concurrently_replaced_healthy_view(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    object_name = archive.names("console/views/objects")[0]
    archive.root.joinpath(*object_name.split("/")).write_bytes(b"partial")
    with pytest.raises(InvalidStateView) as error:
        view.read()
    newer = {**state, "resources": [{"id": "newer"}]}
    view.build(lambda: newer)
    assert view.repair(error.value) == []
    assert view.read()["resources"] == newer["resources"]


def test_scope_mismatch_repair_preserves_another_scopes_valid_marker_and_object(tmp_path):
    archive, view, state = setup(tmp_path)
    view.build(lambda: state)
    other = StateView(archive, "/other", "other-config")
    other.build(lambda: {**state, "workspace": {"scope": "/other"}})
    foreign = json.loads(archive.read_pointer(other.pointer)[0])
    ours, etag = archive.read_pointer(view.pointer)
    head = json.loads(ours)
    head.update({"marker": foreign["marker"], "markerSha256": foreign["markerSha256"]})
    with archive.guard("state-view"):
        assert archive.replace_pointer(view.pointer, encode_json(head), etag)
    with pytest.raises(InvalidStateView) as error:
        view.read()
    assert view.repair(error.value) == [view.pointer]
    assert other.read()["workspace"]["scope"] == "/other"


def test_incomplete_successful_upload_is_deleted_before_bounded_retry(tmp_path):
    archive, view, state = setup(tmp_path)
    original = archive.put
    uploads = []
    def partial_once(name, content):
        if "/objects/" in name:
            uploads.append(name)
            if len(uploads) == 1:
                content = b"partial"
        original(name, content)
    archive.put = partial_once
    service = StateRefresher(lambda: view, lambda: state)
    try:
        result = service.wait(service.request())
        assert result["materializedView"]["persisted"]
        assert len(uploads) == 2
        assert view.read()["resources"] == []
    finally:
        service.close()


@pytest.mark.parametrize("name", ["runs/run/manifest.json", "console/policies/policy.json", "console/jobs/job/finished.json"])
def test_cache_delete_rejects_non_cache_paths(tmp_path, name):
    archive, _, _ = setup(tmp_path)
    archive.put(name, b"preserved")
    with archive.guard("state-view"), pytest.raises(BackupError, match="Only intermediate"):
        archive.delete_view_artifact(name, digest(b"preserved"))
    assert archive.get(name) == b"preserved"
