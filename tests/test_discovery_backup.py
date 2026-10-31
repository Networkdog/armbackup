import json
from dataclasses import replace

import pytest
from conftest import RID, SID, CaptureArm, MemoryArchive, MemoryEvents

from armbackup.backup import Backup
from armbackup.config import Collection
from armbackup.contracts import BackupError, digest
from armbackup.discovery import ApiResolver, Resource, discover, subscriptions
from armbackup.restore import load_snapshot

RUN = "20261031T000000Z-abcdef123456"


def test_capture_and_manifest_and_marker(config):
    arm, archive, events = CaptureArm(), MemoryArchive(), MemoryEvents()
    manifest = Backup(config, arm, archive, events).run(RUN)
    assert manifest["status"] == "Captured"
    assert manifest["capturedCount"] == 1
    complete = json.loads(archive.data[f"runs/{RUN}/COMPLETE.json"])
    assert complete["manifestSha256"] == digest(archive.data[f"runs/{RUN}/manifest.json"])
    envelope = load_snapshot(archive, RUN, RID)
    assert envelope["captureApiVersion"] == "2024-05-01"
    assert envelope["restoreStatus"] == "Unverified"
    assert all(call[0] != "PUT" for call in arm.calls)
    assert not archive.locked


def test_capture_failure_is_incomplete(config):
    arm, archive, events = CaptureArm(), MemoryArchive(), MemoryEvents()
    arm.fail_capture = True
    result = Backup(config, arm, archive, events).run(RUN)
    assert result["status"] == "Incomplete"
    assert len(result["captureFailures"]) == 1
    assert f"runs/{RUN}/COMPLETE.json" not in archive.data
    with pytest.raises(BackupError):
        load_snapshot(archive, RUN, RID)


def test_discovery_failure_not_complete(config):
    arm, archive, events = CaptureArm(), MemoryArchive(), MemoryEvents()
    arm.arg_response = {"data": [], "totalRecords": 10, "resultTruncated": "true"}
    result = Backup(config, arm, archive, events).run(RUN)
    assert result["discoveryFailures"]
    assert result["status"] == "Incomplete"
    assert f"runs/{RUN}/COMPLETE.json" not in archive.data


def test_log_failure_no_success_marker(config):
    archive, events = MemoryArchive(), MemoryEvents()
    events.fail_at = 2
    with pytest.raises(BackupError, match="log ingestion"):
        Backup(config, CaptureArm(), archive, events).run(RUN)
    assert f"runs/{RUN}/manifest.json" in archive.data
    assert f"runs/{RUN}/COMPLETE.json" not in archive.data


def test_storage_failure_is_fatal(config):
    archive = MemoryArchive()
    archive.fail_writes = True
    with pytest.raises(BackupError):
        Backup(config, CaptureArm(), archive, MemoryEvents()).run(RUN)
    assert not archive.data


def test_exclusion_is_visible(config):
    archive = MemoryArchive()
    config = replace(config, exclude_types=("microsoft.network/networksecuritygroups",))
    result = Backup(config, CaptureArm(), archive, MemoryEvents()).run(RUN)
    assert result["excludedCount"] == 1
    assert result["resources"][0]["status"] == "Excluded"


def test_supplemental_collection_capture(config):
    config = replace(config, collections={"microsoft.network/networksecuritygroups": (
        Collection("securityRules", "securityRules", "2024-05-01", "list"),
    )})
    archive = MemoryArchive()
    Backup(config, CaptureArm(), archive, MemoryEvents()).run(RUN)
    envelope = load_snapshot(archive, RUN, RID)
    assert envelope["collections"]["securityRules"]["response"]["value"] == [{"name": "child"}]


def test_missing_expected_subscription_container(config):
    config = replace(config, tables=("ResourceContainers",))
    _, failures = discover(CaptureArm(), config, [SID], MemoryEvents())
    assert any("container missing" in f["error"] for f in failures)


def test_arg_pagination_and_duplicate_detection(config):
    arm = CaptureArm()
    arm.responses = [
        {"data": arm.arg_rows, "totalRecords": 2, "$skipToken": "next", "resultTruncated": "true"},
        {"data": [{"id": RID + "2", "type": arm.arg_rows[0]["type"]}],
         "totalRecords": 2, "resultTruncated": "false"},
    ]
    resources, failures = discover(arm, config, [SID], MemoryEvents())
    assert not failures
    assert len(resources) == 2
    assert arm.calls[1][3]["options"]["$skipToken"] == "next"
    arm.responses = [
        {"data": arm.arg_rows, "totalRecords": 2, "$skipToken": "again"},
        {"data": arm.arg_rows, "totalRecords": 2},
    ]
    _, failures = discover(arm, config, [SID], MemoryEvents())
    assert "duplicate" in failures[0]["error"]


@pytest.mark.parametrize("second", [
    {"data": [], "totalRecords": 3},
    {"data": [], "totalRecords": 2, "$skipToken": "next"},
    {"data": [], "totalRecords": 2},
])
def test_arg_changed_repeated_or_incomplete_pages(config, second):
    arm = CaptureArm()
    arm.responses = [{"data": arm.arg_rows, "totalRecords": 2, "$skipToken": "next"}, second]
    _, failures = discover(arm, config, [SID], MemoryEvents())
    assert failures


def test_arg_wrong_subscription_fails(config):
    arm = CaptureArm()
    arm.arg_rows = [{"id": RID.replace(SID, "22222222-2222-2222-2222-222222222222"), "type": "x/y"}]
    _, failures = discover(arm, config, [SID], MemoryEvents())
    assert "outside" in failures[0]["error"]


def test_subscription_missing_not_silently_removed(config):
    config = replace(config, subscriptions=("22222222-2222-2222-2222-222222222222",))
    with pytest.raises(BackupError, match="unavailable"):
        subscriptions(CaptureArm(), config)


def test_auto_api_selects_stable_and_caches(config):
    arm = CaptureArm()
    resource = Resource(RID, "microsoft.network/virtualnetworks", SID, "test")
    resolver = ApiResolver(arm, config)
    assert resolver.resolve(resource) == "2024-01-01"
    assert resolver.resolve(resource) == "2024-01-01"
    assert len(arm.calls) == 1


def test_tampered_snapshot_rejected(config):
    archive = MemoryArchive()
    manifest = Backup(config, CaptureArm(), archive, MemoryEvents()).run(RUN)
    archive.data[manifest["resources"][0]["blob"]] += b" "
    with pytest.raises(BackupError, match="hash mismatch"):
        load_snapshot(archive, RUN, RID)
