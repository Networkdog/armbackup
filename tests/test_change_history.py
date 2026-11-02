import copy

import pytest
from conftest import RID, nsg

from armbackup.change_history import captured_time, history_detail, history_records, selection_key
from armbackup.contracts import BackupError
from armbackup.restore import NSG


def snapshot(at, *, port="443", resource_id=RID, api="2024-05-01"):
    raw = nsg()
    raw.update({"id": resource_id, "name": resource_id.rsplit("/", 1)[1]})
    raw["tags"]["customer"] = "alpha"
    raw["properties"]["securityRules"][0]["properties"]["destinationPortRange"] = port
    return {"schemaVersion": 1, "resourceId": resource_id, "resourceType": NSG,
            "captureApiVersion": api, "capturedAt": at, "raw": raw}


def run(identifier, at, snapshots, *, kind="manual", verified=True, tag="alpha"):
    return {
        "manifest": {"runId": identifier, "startedAt": at, "finishedAt": at, "kind": kind,
                     "selection": {"scope": "/scope", "scopeIds": ["resource-group"],
                                   "types": [NSG], "tags": [{"key": "customer", "operator": "equals", "value": tag}],
                                   "argCount": len(snapshots)}},
        "envelopes": snapshots, "verified": verified,
    }


def test_temporal_diff_uses_later_snapshot_not_current_azure_shape():
    first = run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")])
    second = run("b", "2026-10-30T00:00:00Z", [snapshot("2026-10-30T00:00:00Z", port="8443")])
    data = history_records([second, first])
    assert [item["kind"] for item in data["records"]] == ["baseline", "changed"]
    change = data["records"][1]
    assert change["beforeRunId"] == "a"
    assert change["afterRunId"] == "b"
    assert change["propertyCount"] == 1
    assert change["at"] == "2026-10-30T00:00:00Z"
    detail = history_detail(first, second, RID)
    assert detail["comparison"]["diffs"][0]["before"] == "443"
    assert detail["comparison"]["diffs"][0]["after"] == "8443"


def test_safety_backups_never_become_change_baselines():
    runs = [
        run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")]),
        run("safe", "2026-10-30T00:00:00Z", [snapshot("2026-10-30T00:00:00Z", port="22")], kind="safety"),
        run("b", "2026-10-31T00:00:00Z", [snapshot("2026-10-31T00:00:00Z")]),
    ]
    data = history_records(runs)
    assert len(data["observations"]) == 2
    assert [item["kind"] for item in data["records"]] == ["baseline", "unchanged"]
    assert data["records"][-1]["beforeRunId"] == "a"
    with pytest.raises(BackupError, match="Safety"):
        history_detail(runs[0], runs[1], RID)


def test_incomplete_sources_are_skipped_and_break_inventory_inference():
    first = run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")])
    failed = run("failed", "2026-10-30T00:00:00Z", [], verified=False)
    last = run("b", "2026-10-31T00:00:00Z", [snapshot("2026-10-31T00:00:00Z", port="8443")])
    data = history_records([first, failed, last])
    assert data["warnings"]
    assert data["observations"][1]["verified"] is False
    assert data["records"][-1]["observationGap"] is True
    assert data["records"][-1]["kind"] == "changed"
    with pytest.raises(BackupError, match="verified"):
        history_detail(first, failed, RID)


def test_policy_change_is_not_resource_deletion():
    first = run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")])
    narrow = run("b", "2026-10-30T00:00:00Z", [], tag="beta")
    data = history_records([first, narrow])
    assert data["scopeChanges"] == 1
    assert data["observations"][-1]["scopeChanged"] is True
    assert not any(item["kind"] == "inventory_removed" for item in data["records"])


def test_inventory_changes_are_labelled_as_list_changes_not_confirmed_creation_or_deletion():
    first = run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")])
    newer_id = RID + "-new"
    second = run("b", "2026-10-30T00:00:00Z",
                 [snapshot("2026-10-30T00:00:00Z", resource_id=newer_id)])
    data = history_records([first, second])
    kinds = {item["kind"] for item in data["records"]}
    assert kinds == {"baseline", "inventory_added", "inventory_removed"}
    removed = next(item for item in data["records"] if item["kind"] == "inventory_removed")
    assert "삭제를 확인한 기록은 아닙니다" in removed["reason"]
    detail = history_detail(first, second, RID)
    assert detail["comparison"]["status"] == "unknown"
    assert not detail["comparison"]["diffs"]


def test_argument_count_variation_does_not_change_policy_scope():
    first = run("a", "2026-10-29T00:00:00Z", [])
    second = copy.deepcopy(first)
    second["manifest"]["selection"]["argCount"] = 999
    second["manifest"]["selection"]["restSelectedCount"] = 50
    assert selection_key(first["manifest"]) == selection_key(second["manifest"])
    assert selection_key({}) is None


def test_api_mismatch_is_unconfirmed_and_establishes_a_new_comparable_baseline():
    runs = [
        run("a", "2026-10-29T00:00:00Z", [snapshot("2026-10-29T00:00:00Z")]),
        run("b", "2026-10-30T00:00:00Z", [snapshot("2026-10-30T00:00:00Z", api="2025-01-01")]),
        run("c", "2026-10-31T00:00:00Z", [snapshot("2026-10-31T00:00:00Z", api="2025-01-01")]),
    ]
    assert [item["kind"] for item in history_records(runs)["records"]] == ["baseline", "unknown", "unchanged"]


def test_customers_use_both_sides_of_a_tag_change_and_sources_are_not_mutated():
    before = snapshot("2026-10-29T00:00:00Z")
    after = snapshot("2026-10-30T00:00:00Z")
    after["raw"]["tags"]["customer"] = "beta"
    inputs = [run("a", before["capturedAt"], [before]), run("b", after["capturedAt"], [after])]
    original = copy.deepcopy(inputs)
    data = history_records(inputs)
    assert data["records"][-1]["customers"] == ["alpha", "beta"]
    assert inputs == original


def test_multiple_changes_and_reversions_are_preserved_as_distinct_observations():
    runs = [
        run("a", "2026-10-31T00:00:00Z", [snapshot("2026-10-31T00:00:00Z")]),
        run("b", "2026-10-31T01:00:00Z", [snapshot("2026-10-31T01:00:00Z", port="8443")]),
        run("c", "2026-10-31T02:00:00Z", [snapshot("2026-10-31T02:00:00Z")]),
    ]
    changes = [item for item in history_records(runs)["records"] if item["kind"] == "changed"]
    assert len(changes) == 2
    assert len({item["id"] for item in changes}) == 2
    assert all(item["propertyCount"] == 1 for item in changes)


@pytest.mark.parametrize("invalid", [None, "", "not-date", "2026-10-31T00:00:00"])
def test_missing_or_unzoned_timestamp_is_not_assumed_utc(invalid):
    with pytest.raises(BackupError):
        captured_time(invalid, "test")


def test_empty_history_has_no_fabricated_zero_days():
    assert history_records([])["records"] == []
    assert history_records([])["observations"] == []


def test_unstable_snapshot_is_never_counted_as_a_confirmed_change():
    first = snapshot("2026-10-29T00:00:00Z")
    next_snapshot = snapshot("2026-10-30T00:00:00Z", port="8443")
    next_snapshot["raw"]["properties"]["provisioningState"] = "Updating"
    data = history_records([run("a", first["capturedAt"], [first]),
                            run("b", next_snapshot["capturedAt"], [next_snapshot])])
    assert data["records"][-1]["kind"] == "unknown"
    assert data["records"][-1]["propertyCount"] == 0
