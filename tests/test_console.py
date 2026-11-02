import base64
import copy
import json
import threading
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock, patch

import pytest
import requests
from conftest import SID, MemoryEvents, nsg

from armbackup.backup import Backup
from armbackup.comparison import VNET, compare, configuration, differences
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, digest, encode_json
from armbackup.discovery import Resource
from armbackup.local_archive import LocalArchive
from armbackup.monitoring import LogsReader, activity_changes, kql_literal, resource_actor
from armbackup.restore import NSG, ROUTES, project_body
from armbackup.webui import ConsoleServer

GROUP = "rg-armbackup-unit"
SCOPE = f"/subscriptions/{SID}/resourceGroups/{GROUP}"
RID = SCOPE + "/providers/Microsoft.Network/networkSecurityGroups/nsg-unit"
RUN = "20261031T030000Z-aabbccddeeff"


class LabArm:
    def __init__(self):
        raw = nsg()
        raw.update({"id": RID, "name": "nsg-unit"})
        raw["tags"].update({"armbackupLab": "unit-lab", "armbackupWorkload": "true",
                            "customer": "alpha", "environment": "lab"})
        self.resources = {RID.lower(): raw}
        self.calls = []
        self.denied = set()
        self.group_tag = "unit-lab"

    def pages(self, path, api_version):
        if path == "/subscriptions":
            yield {"subscriptionId": SID, "state": "Enabled"}
        elif path == SCOPE + "/resources":
            yield from [copy.deepcopy(value) for value in self.resources.values()]
        elif "Microsoft.Insights/eventtypes/" in path:
            return
        else:
            raise AssertionError(f"Unexpected page path {path}")

    def request(self, method, path, api_version=None, body=None):
        self.calls.append((method, path, api_version, copy.deepcopy(body)))
        if path == SCOPE and method == "GET":
            return {"id": SCOPE, "location": "koreacentral", "tags": {"armbackupLab": self.group_tag}}
        if method == "POST" and path.endswith("Microsoft.ResourceGraph/resources"):
            return {"data": [{"id": raw["id"], "type": raw["type"], "resourceGroup": GROUP}
                             for raw in self.resources.values()],
                    "totalRecords": len(self.resources), "resultTruncated": "false"}
        key = path.lower()
        if key in self.denied:
            raise ArmHttpError(403, "AuthorizationFailed")
        if method == "GET":
            if key not in self.resources:
                raise ArmHttpError(404, "ResourceNotFound")
            return copy.deepcopy(self.resources[key])
        if method == "PUT":
            self.resources[key] = {**copy.deepcopy(body), "id": path,
                                   "name": path.rsplit("/", 1)[1],
                                   "type": "Microsoft.Network/networkSecurityGroups"}
            self.resources[key]["properties"]["provisioningState"] = "Succeeded"
            return copy.deepcopy(self.resources[key])
        raise AssertionError(f"Unexpected {method} {path}")


@pytest.fixture
def console(tmp_path, config):
    capture = replace(config, resource_groups=(GROUP,), collections={},
                      api_versions={NSG: "2024-05-01", ROUTES: "2024-05-01", VNET: "2024-05-01"})
    settings = ConsoleConfig(capture, "MSP Test", "Lab", "unit-lab", SID, True, 2,
                             "local", tmp_path / "archive")
    arm, archive, events = LabArm(), LocalArchive(settings.local_archive), MemoryEvents()
    client = LiveConsole(settings, arm, archive, lambda _: events, Mock(spec=LogsReader))
    Backup(capture, arm, archive, events).run(
        RUN, inventory=[Resource(RID, NSG, SID, GROUP)], inventory_source="unit ARM inventory",
    )
    try:
        yield client
    finally:
        client.close()


def review(console, mode="update", **extra):
    payload = {"resourceId": RID, "runId": RUN, "mode": mode, "targetName": "nsg-unit-clone",
               "ticket": "CHG-UNIT-001", "reason": "Validate reviewed recovery in the isolated unit lab"}
    return console.prepare({**payload, **extra})


def drift(console):
    console.arm.resources[RID.lower()]["properties"]["securityRules"][0]["properties"]["destinationPortRange"] = "8443"


def execute(console, plan, **extra):
    return console.restore({"id": "test-operation", "writeAttempted": False}, {
        "planId": plan["id"], "approvalSha256": plan["approvalSha256"],
        "confirmTarget": plan["targetResourceId"].rsplit("/", 1)[1], **extra,
    })


def writes(console):
    return [call for call in console.arm.calls if call[0] == "PUT"]


def expand_subscription(console):
    console.config = replace(console.config, inventory_scope="subscription")
    other_scope = f"/subscriptions/{SID}/resourceGroups/rg-existing-service"
    other_id = other_scope + "/providers/Microsoft.Network/networkSecurityGroups/nsg-existing"
    raw = copy.deepcopy(console.arm.resources[RID.lower()])
    raw.update({"id": other_id, "name": "nsg-existing", "tags": {"customer": "existing"}})
    console.arm.resources[other_id.lower()] = raw
    old_pages, old_request = console.arm.pages, console.arm.request

    def pages(path, api):
        if path == f"/subscriptions/{SID}/resources":
            yield from [copy.deepcopy(value) for value in console.arm.resources.values()]
        elif path == f"/subscriptions/{SID}/resourcegroups":
            yield {"id": SCOPE, "name": GROUP}
            yield {"id": other_scope, "name": "rg-existing-service"}
            yield {"id": f"/subscriptions/{SID}/resourceGroups/empty", "name": "empty"}
        else:
            yield from old_pages(path, api)

    def request(method, path, api=None, body=None):
        if path.endswith("Microsoft.ResourceGraph/resources") and "ancestors=" in body.get("query", ""):
            return {"data": [{"id": f"/subscriptions/{SID}", "ancestors": [
                {"name": "team", "displayName": "Team"},
                {"name": "root", "displayName": "Root"},
            ]}], "totalRecords": 1}
        return old_request(method, path, api, body)

    console.arm.pages, console.arm.request = pages, request
    return other_id


def test_subscription_inventory_includes_untagged_resources_and_actual_management_hierarchy(console):
    other_id = expand_subscription(console)
    state = console.state()
    assert {raw["id"] for raw in state["resources"]} == {RID, other_id}
    assert state["current"][other_id.lower()]["status"] == "present"
    assert [scope["name"] for scope in state["scopes"][:3]] == ["Root", "Team", "Lab"]
    assert state["scopes"][2]["parentId"].endswith("/team")
    assert sum(scope["kind"] == "resourceGroup" for scope in state["scopes"]) == 3
    assert state["workspace"]["readScope"] == f"/subscriptions/{SID}"
    assert state["workspace"]["scope"] == SCOPE
    assert state["resources"][1]["groupId"] == "/".join(state["resources"][1]["id"].split("/")[:5]).lower()
    assert not writes(console)


def test_subscription_policy_can_capture_unmarked_resource_without_allowing_restore(console):
    other_id = expand_subscription(console)
    policy = console.validate_policy({"scopeIds": [f"/subscriptions/{SID}"], "types": [NSG], "tags": []})
    console.save_policy({"id": "scope-policy"}, {"policy": policy})
    result = console.backup({"id": "subscription-capture"}, {"label": "Read-only subscription capture"})
    assert result["capturedCount"] == 2
    run = console.read_run(result["runId"])
    assert run["verified"]
    assert {item["resourceId"] for item in run["envelopes"]} == {RID, other_id}
    snapshot = next(item for item in console.state()["runs"][0]["snapshots"] if item["resourceId"] == other_id)
    assert not snapshot["restoreSupported"]
    with pytest.raises(BackupError, match="outside the allowed lab"):
        console.prepare({"resourceId": other_id, "runId": result["runId"], "mode": "update"})
    assert not writes(console)


def test_management_group_selection_is_projected_to_authorized_subscription_only(console):
    expand_subscription(console)
    policy = console.validate_policy({
        "scopeIds": ["/providers/Microsoft.Management/managementGroups/team"],
        "types": [NSG], "tags": [],
    })
    assert policy["scopeIds"] == [f"/subscriptions/{SID}"]
    with pytest.raises(BackupError, match="outside the configured subscription ancestry"):
        console.validate_policy({**policy, "scopeIds": ["/providers/Microsoft.Management/managementGroups/other"]})
    with pytest.raises(BackupError, match="outside the configured subscription"):
        console.validate_policy({**policy, "scopeIds": [
            RID.replace(SID, "22222222-2222-2222-2222-222222222222"),
        ]})


def test_expansion_preserves_saved_lab_policy_and_invalidates_narrow_cached_view(console):
    console.save_policy({"id": "old-policy"}, {"policy": {"scopeIds": ["resource-group"], "types": [NSG], "tags": []}})
    console.initial_state(fresh=True)
    other_id = expand_subscription(console)
    expanded = console.initial_state()
    assert expanded["statePending"]
    assert console.views.wait(expanded["viewRefresh"]["id"])["materializedView"]["cached"] is False
    policy = console.read_policy()
    assert policy["scopeIds"] == [SCOPE]
    assert not console.selected(console.arm.resources[other_id.lower()], policy)


def test_unavailable_management_group_ancestry_is_an_explicit_warning_not_a_fake_node(console):
    state = console.state()
    assert not any(scope["kind"] == "managementGroup" for scope in state["scopes"])
    assert any("Management Group:" in warning for warning in state["warnings"])


def test_initial_state_repairs_partial_pointer_and_rebuilds_but_preserves_original_backup(console):
    console.initial_state(fresh=True)
    view = console.state_view()
    original = console.archive.get(f"runs/{RUN}/manifest.json")
    console.archive.root.joinpath(*view.pointer.split("/")).write_bytes(b'{"partial":')
    pending = console.initial_state()
    assert pending["statePending"] and pending["cacheRecovery"]["deletedArtifacts"] == 1
    rebuilt = console.views.wait(pending["viewRefresh"]["id"])
    assert rebuilt["materializedView"]["persisted"]
    assert console.archive.get(f"runs/{RUN}/manifest.json") == original


def test_storage_permission_failure_never_deletes_cached_artifacts(console):
    console.initial_state(fresh=True)
    console.archive.delete_view_artifact = Mock(wraps=console.archive.delete_view_artifact)
    console.archive.read_pointer = Mock(side_effect=BackupError("Storage HTTP 403"))
    with pytest.raises(BackupError, match="403"):
        console.initial_state()
    console.archive.delete_view_artifact.assert_not_called()


def test_subscription_activity_limits_do_not_hide_other_groups(console):
    expand_subscription(console)
    original = console.arm.pages

    def pages(path, api):
        if "Microsoft.Insights/eventtypes/" in path and "rg-existing-service" in path:
            raise BackupError("Activity Log exceeds the 2,000-event limit")
        yield from original(path, api)

    console.arm.pages = pages
    state = console.state()
    assert state["activityStatus"] == "Partial"
    assert any("Activity Log (rg-existing-service)" in warning for warning in state["warnings"])


def test_state_uses_real_source_labels_and_verified_snapshots(console):
    state = console.state()
    assert state["mode"] == "live-lab"
    assert state["workspace"]["archiveMode"] == "local"
    assert state["workspace"]["archiveLabel"] == "로컬 검증 디스크"
    assert len(state["resources"]) == 1
    assert state["runs"][0]["snapshots"][0]["comparison"]["status"] == "same"
    assert state["runs"][0]["snapshots"][0]["restoreSupported"]
    assert "fingerprint" not in state["current"][RID.lower()]
    assert state["latestView"]["snapshots"][0]["sourceRunId"] == RUN


def test_state_exposes_failed_resource_attempt_even_without_a_snapshot(console):
    console.arm.denied.add(RID.lower())
    failed_run = "20261101T070000Z-111111111111"
    Backup(console.config.capture, console.arm, console.archive, console.events_factory("failure")).run(
        failed_run, inventory=[console.config.resource(RID)],
    )
    state = console.state()
    latest = next(run for run in state["runs"] if run["id"] == failed_run)
    assert latest["status"] == "Incomplete" and latest["snapshots"] == []
    assert latest["resourceAttempts"] == [{"resourceId": RID, "status": "Failed"}]


def test_hosted_console_requires_tenant_operator_exact_origin_and_blob(console):
    with pytest.raises(BackupError, match="Hosted console requires"):
        ConsoleServer(("127.0.0.1", 0), console, hosted_host="unit.azurewebsites.net",
                      operator_id=SID, tenant_id=SID)
    console.config = replace(console.config, archive_mode="blob")
    server = ConsoleServer(("127.0.0.1", 0), console, hosted_host="unit.azurewebsites.net",
                           operator_id=SID, tenant_id=SID)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    headers = {"Host": "unit.azurewebsites.net"}
    try:
        assert requests.get(url + "/", headers=headers, timeout=5).status_code == 403
        principal = {"auth_typ": "aad", "claims": [{"typ": "oid", "val": SID}, {"typ": "tid", "val": SID}]}
        headers["X-MS-CLIENT-PRINCIPAL"] = base64.b64encode(encode_json(principal)).decode()
        assert requests.get(url + "/api/session", headers=headers, timeout=5).status_code == 200
        assert requests.get(url + "/api/session", headers={**headers, "Origin": "https://evil.example"}, timeout=5).status_code == 403
        principal["claims"][0]["val"] = "unauthorized"
        headers["X-MS-CLIENT-PRINCIPAL"] = base64.b64encode(encode_json(principal)).decode()
        assert requests.get(url + "/api/session", headers=headers, timeout=5).status_code == 403
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_update_saves_current_snapshot_before_apply_and_checks_whole_configuration(console):
    drift(console)
    before = copy.deepcopy(console.arm.resources[RID.lower()])
    plan = review(console)
    assert plan["comparison"]["status"] == "critical"
    result = execute(console, plan)
    assert result["comparison"]["status"] == "same"
    safety = console.read_run(result["safetyRunId"])
    assert safety["verified"]
    assert safety["envelopes"][0]["raw"] == before
    assert console.arm.resources[RID.lower()]["properties"]["securityRules"][0]["properties"]["destinationPortRange"] == "443"
    assert len(writes(console)) == 1
    latest = console.state()["latestView"]["snapshots"][0]
    assert latest["sourceRunId"] == RUN
    assert latest["comparison"]["status"] == "same"


def test_newer_backup_omitting_a_deleted_resource_preserves_its_last_verified_source(console):
    new_id = RID + "-new"
    new_raw = copy.deepcopy(console.arm.resources[RID.lower()])
    new_raw.update({"id": new_id, "name": "nsg-unit-new"})
    del console.arm.resources[RID.lower()]
    console.arm.resources[new_id.lower()] = new_raw
    newer = "20261031T050000Z-abcdefabcdef"
    Backup(console.config.capture, console.arm, console.archive, console.events_factory("unit")).run(
        newer, inventory=[Resource(new_id, NSG, SID, GROUP)],
    )
    state = console.state()
    rows = {snapshot["resourceId"]: snapshot for snapshot in state["latestView"]["snapshots"]}
    assert len(rows) == 2
    assert rows[RID]["sourceRunId"] == RUN
    assert rows[RID]["comparison"]["status"] == "critical"
    assert rows[new_id]["sourceRunId"] == newer
    assert state["latestView"]["viewOnly"] is True
    assert console.report("latest")["report"]["sourceTimesVary"] is True


def test_create_preserves_original_and_records_target_absence(console):
    source = copy.deepcopy(console.arm.resources[RID.lower()])
    plan = review(console, "create")
    result = execute(console, plan)
    assert console.arm.resources[RID.lower()] == source
    safety = console.read_run(result["safetyRunId"])
    assert len(safety["envelopes"]) == 1
    assert safety["manifest"]["absences"][0]["resourceId"] == plan["targetResourceId"]
    assert console.arm.resources[plan["targetResourceId"].lower()]["name"] == "nsg-unit-clone"


def test_deleted_resource_recreation_preserves_absence_without_inventing_snapshot(console):
    del console.arm.resources[RID.lower()]
    plan = review(console, "create", targetName="nsg-unit")
    result = execute(console, plan)
    safety = console.read_run(result["safetyRunId"])
    assert safety["verified"]
    assert safety["envelopes"] == []
    assert len(safety["manifest"]["absences"]) == 1
    assert RID.lower() in console.arm.resources


def test_storage_failure_at_safety_marker_prevents_every_arm_write(console):
    drift(console)
    plan = review(console)
    original = console.archive.put

    def fail_marker(name, content):
        if name.endswith("/COMPLETE.json"):
            raise BackupError("Test safety marker write failed")
        original(name, content)

    with patch.object(console.archive, "put", side_effect=fail_marker):
        with pytest.raises(BackupError, match="safety marker"):
            execute(console, plan)
    assert writes(console) == []


def test_log_delivery_failure_at_safety_phase_prevents_every_arm_write(console):
    drift(console)
    plan = review(console)
    events = console.events_factory("unused")
    events.fail_at = events.flushes + 1
    with pytest.raises(BackupError, match="log ingestion"):
        execute(console, plan)
    assert writes(console) == []


@pytest.mark.parametrize("change", ["configuration", "deletion", "ownership"])
def test_change_since_review_invalidates_plan_without_put(console, change):
    drift(console)
    plan = review(console)
    if change == "deletion":
        del console.arm.resources[RID.lower()]
    elif change == "ownership":
        console.arm.resources[RID.lower()]["tags"]["armbackupLab"] = "another"
    else:
        console.arm.resources[RID.lower()]["tags"]["new"] = "later"
    with pytest.raises(BackupError):
        execute(console, plan)
    assert writes(console) == []


def test_create_target_appearing_after_review_is_not_overwritten(console):
    plan = review(console, "create")
    console.arm.resources[plan["targetResourceId"].lower()] = {
        **copy.deepcopy(console.arm.resources[RID.lower()]), "id": plan["targetResourceId"],
    }
    with pytest.raises(BackupError, match="changed after review"):
        execute(console, plan)
    assert writes(console) == []


def test_403_is_unknown_and_never_treated_as_missing(console):
    console.arm.denied.add(RID.lower())
    state = console.state()
    assert state["current"][RID.lower()]["status"] == "error"
    assert state["runs"][0]["snapshots"][0]["comparison"]["status"] == "unknown"
    with pytest.raises(BackupError, match="unconfirmed"):
        review(console, "create")
    assert writes(console) == []


def test_in_progress_provisioning_is_not_green_or_restorable(console):
    console.arm.resources[RID.lower()]["properties"]["provisioningState"] = "Updating"
    snapshot = console.state()["runs"][0]["snapshots"][0]
    assert snapshot["comparison"]["status"] == "unknown"
    with pytest.raises(BackupError, match="provisioning"):
        review(console)
    assert writes(console) == []


@pytest.mark.parametrize("invalid", [
    RID.replace(SID, "22222222-2222-2222-2222-222222222222"),
    RID.replace(GROUP, GROUP + "-other"),
    RID + "/securityRules/a",
    "https://management.azure.com" + RID,
    RID + "?api-version=2024-05-01",
    RID.replace("nsg-unit", "../outside"),
])
def test_resource_scope_is_checked_before_azure_write(console, invalid):
    with pytest.raises(BackupError):
        review(console, resourceId=invalid)
    assert writes(console) == []


@pytest.mark.parametrize("field,value", [("ticket", ""), ("reason", "x"), ("mode", "upsert")])
def test_ticket_reason_and_explicit_mode_are_required(console, field, value):
    with pytest.raises(BackupError):
        review(console, **{field: value})
    assert writes(console) == []


def test_attached_resources_are_blocked_in_lab(console):
    console.arm.resources[RID.lower()]["properties"]["subnets"] = [{"id": SCOPE + "/some-subnet"}]
    with pytest.raises(BackupError, match="Attached"):
        review(console)
    assert writes(console) == []


def test_plan_hash_exact_name_expiry_and_replay_gate_writes(console):
    drift(console)
    plan = review(console)
    with pytest.raises(BackupError, match="hash"):
        execute(console, plan, approvalSha256="bad")
    with pytest.raises(BackupError, match="exact target"):
        execute(console, plan, confirmTarget="wrong")
    execute(console, plan)
    with pytest.raises(BackupError, match="already been submitted"):
        execute(console, plan)
    assert len(writes(console)) == 1
    other = review(console, "create", targetName="another")
    path = f"console/plans/{other['id']}.json"
    raw = json.loads(console.archive.get(path))
    raw["expiresAt"] = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    with patch.object(console.archive, "get", side_effect=lambda name: encode_json(raw) if name == path else b""):
        with pytest.raises(BackupError, match="expired"):
            execute(console, {**other, "approvalSha256": digest(encode_json(raw))})


def test_noop_update_is_not_written_or_backed_up_unnecessarily(console):
    plan = review(console)
    assert plan["noChange"] is True
    before = len(console.archive.names("runs"))
    with pytest.raises(BackupError, match="unnecessary"):
        execute(console, plan)
    assert writes(console) == []
    assert len(console.archive.names("runs")) == before


def test_review_expiring_during_safety_backup_is_rechecked_at_the_write_boundary(console):
    drift(console)
    plan = review(console)
    now = datetime.now(UTC)
    with patch("armbackup.console.datetime", wraps=datetime) as clock:
        clock.now.side_effect = [now, now + timedelta(minutes=15)]
        with pytest.raises(BackupError, match="expired before write"):
            execute(console, plan)
    assert writes(console) == []
    assert len([name for name in console.archive.names("runs") if name.endswith("/COMPLETE.json")]) == 2


def test_changed_api_profile_invalidates_a_previously_reviewed_plan(console):
    drift(console)
    plan = review(console)
    console.config = replace(console.config, capture=replace(
        console.config.capture, api_versions={**console.config.capture.api_versions, NSG: "2025-01-01"},
    ))
    with pytest.raises(BackupError, match="API changed"):
        execute(console, plan)
    assert writes(console) == []


def test_corrupt_backup_is_explicitly_unusable_and_other_inventory_remains_visible(console):
    snapshot = next(name for name in console.archive.names(f"runs/{RUN}") if "/resources/" in name)
    path = console.archive._path(snapshot)
    path.write_bytes(path.read_bytes() + b" ")
    state = console.state()
    assert state["runs"][0]["status"] == "IntegrityError"
    assert state["warnings"]
    assert len(state["resources"]) == 1
    with pytest.raises(BackupError, match="hash"):
        review(console)
    assert writes(console) == []


def test_policy_is_enforced_by_next_actual_capture_and_empty_result_is_not_success(console):
    policy = {"scopeIds": ["resource-group"], "types": [NSG],
              "tags": [{"key": "CUSTOMER", "operator": "equals", "value": "beta"}]}
    console.save_policy({"id": "policy-test"}, {"policy": policy})
    assert console.read_policy() == policy
    with pytest.raises(BackupError, match="No current workloads"):
        console.backup({"id": "backup-test"}, {})
    assert len([name for name in console.archive.names("runs") if name.endswith("manifest.json")]) == 1


def test_policy_order_uses_revision_not_random_filename_or_equal_timestamps(console):
    first = {"scopeIds": ["resource-group"], "types": [NSG], "tags": []}
    second = {**first, "scopeIds": [RID]}
    with patch("armbackup.console.utc_now", return_value="2026-10-31T00:00:00.000Z"):
        console.save_policy({"id": "first"}, {"policy": first})
        console.save_policy({"id": "second"}, {"policy": second})
    assert console.read_policy() == second
    assert console.policy_record()["revision"] == 2


def test_safety_snapshot_readback_mismatch_blocks_write_even_after_an_observation_matches(console):
    drift(console)
    plan = review(console)
    original = console.arm.request
    calls = 0

    def change_during_capture(method, path, api_version=None, body=None):
        nonlocal calls
        if method == "GET" and path == RID:
            calls += 1
            if calls == 2:
                console.arm.resources[RID.lower()]["tags"]["changedDuringCapture"] = "true"
        return original(method, path, api_version, body)

    with patch.object(console.arm, "request", side_effect=change_during_capture):
        with pytest.raises(BackupError, match="while capturing"):
            execute(console, plan)
    assert writes(console) == []


def test_explicit_inventory_cannot_lie_about_resource_id_scope(console):
    outside = RID.replace(GROUP, GROUP + "-outside")
    with pytest.raises(BackupError, match="outside"):
        Backup(console.config.capture, console.arm, console.archive, console.events_factory("unit")).run(
            "20261031T040000Z-123456abcdef",
            inventory=[Resource(outside, NSG, SID, GROUP)],
        )


def test_report_records_observation_scope_limits_and_checksum_without_raw_credentials(console):
    report = console.report(RUN)
    assert digest(encode_json(report["report"])) == report["sha256"]
    assert report["report"]["scope"] == SCOPE
    assert report["report"]["dataPlaneIncluded"] is False
    assert len(report["report"]["resources"]) == 1
    assert "sessionToken" not in json.dumps(report)


def test_background_job_is_persistent_and_failures_are_terminal(console):
    job = console.submit("policy", {"policy": {"scopeIds": [], "types": [NSG], "tags": []}})
    for _ in range(100):
        outcome = console.job(job["id"])
        if outcome["status"] == "Failed":
            break
        time.sleep(0.01)
    assert outcome["status"] == "Failed"
    console.futures[job["id"]].result(timeout=5)
    saved = json.loads(console.archive.get(f"console/jobs/{job['id']}/finished.json"))
    assert saved["status"] == "Failed"
    assert saved["errorCode"] == "BackupError"


def test_job_is_not_successful_before_terminal_journal_is_durable(console):
    entered, release = threading.Event(), threading.Event()
    original = console.archive.put

    def wait_for_journal(name, content):
        if name.endswith("/finished.json"):
            entered.set()
            release.wait(timeout=5)
        original(name, content)

    policy = {"scopeIds": ["resource-group"], "types": [NSG], "tags": []}
    with patch.object(console.archive, "put", side_effect=wait_for_journal):
        job = console.submit("policy", {"policy": policy})
        assert entered.wait(timeout=5)
        assert console.job(job["id"])["status"] == "Running"
        assert console.job(job["id"])["phase"] == "persisting-audit"
        release.set()
        console.futures[job["id"]].result(timeout=5)
    assert console.job(job["id"])["status"] == "Succeeded"


def test_abandoned_requested_operation_is_unconfirmed_not_hidden_or_successful(console):
    identifier = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    console.archive.put(f"console/jobs/{identifier}/requested.json", encode_json({
        "id": identifier, "status": "Queued", "startedAt": "2026-10-31T00:00:00Z",
        "action": "restore", "scope": SCOPE,
    }))
    record = console.state()["journal"][0]
    assert record["status"] == "Unconfirmed"
    assert record["writeAttempted"] is None
    assert record["warning"]


@pytest.fixture
def live_url(console):
    server = ConsoleServer(("127.0.0.1", 0), console)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_live_http_does_not_expose_azure_credentials_or_demo_fallback(live_url):
    url, server = live_url
    page = requests.get(url, timeout=5)
    assert page.status_code == 200
    assert 'src="/live-app.mjs"' in page.text
    assert "LIVE LAB" in page.text
    assert 'class="preview-banner' not in page.text
    assert 'id="preview-guide"' in page.text
    assert 'id="app-dialog"' in page.text
    assert 'class="sidebar-note"' not in page.text
    assert 'class="workspace-label"' not in page.text
    assert "connect-src 'self'" in page.headers["Content-Security-Policy"]
    session = requests.get(url + "/api/session", timeout=5).json()
    assert session["mode"] == "live-lab"
    assert session["sessionToken"] == server.session_token
    assert "credential" not in session
    assert requests.get(url + "/api/state", timeout=5).status_code == 403
    state = requests.get(url + "/api/state", headers={"X-Console-Token": server.session_token}, timeout=5)
    assert state.status_code == 202
    assert state.json()["statePending"]
    assert state.json()["mode"] == "live-lab"


def test_http_cached_state_returns_while_one_shared_refresh_is_blocked(live_url):
    url, server = live_url
    console = server.console
    initial = console.initial_state(fresh=True)
    entered, release = threading.Event(), threading.Event()
    def collect():
        entered.set()
        assert release.wait(5)
        return {key: value for key, value in initial.items() if key != "materializedView"}
    console.views.loader = Mock(side_effect=collect)
    console.views.invalidate()
    headers = {"X-Console-Token": server.session_token, "Origin": url}
    try:
        response = requests.get(url + "/api/state", headers=headers, timeout=2)
        assert response.status_code == 200 and entered.wait(2)
        assert not release.is_set()
        assert response.json()["materializedView"]["requiresLiveRefresh"]
        refresh = response.json()["viewRefresh"]
        started = requests.post(url + "/api/state/refresh", headers=headers, json={}, timeout=2)
        assert started.status_code == 202
        assert started.json()["id"] == refresh["id"]
        progress = requests.get(url + "/api/state/refresh?id=" + refresh["id"], headers=headers, timeout=2)
        assert progress.json()["status"] == "Running"
        release.set()
        console.views.wait(refresh["id"])
        completed = requests.get(url + "/api/state/refresh?id=" + refresh["id"], headers=headers, timeout=2)
        assert completed.json()["state"]["materializedView"]["requiresLiveRefresh"] is False
        assert console.views.loader.call_count == 1
        invalid = requests.post(url + "/api/state/refresh", headers=headers, json={"force": "yes"}, timeout=2)
        assert invalid.status_code == 400
    finally:
        release.set()


@pytest.mark.parametrize("headers", [
    {"Host": "attacker.example"}, {"Origin": "https://attacker.example"},
    {"Sec-Fetch-Site": "cross-site"},
])
def test_live_http_rejects_rebinding_and_cross_origin_before_returning_session(live_url, headers):
    url, _ = live_url
    assert requests.get(url + "/api/session", headers=headers, timeout=5).status_code == 403


def test_live_http_rejects_untrusted_mutation_oversized_input_and_unknown_api(live_url):
    url, server = live_url
    assert requests.post(url + "/api/restore", json={}, timeout=5).status_code == 403
    headers = {"X-Console-Token": server.session_token}
    assert requests.post(url + "/api/backup", data="x", headers=headers, timeout=5).status_code == 415
    assert requests.post(url + "/api/backup", json={"label": "x" * 33000}, headers=headers, timeout=5).status_code == 413
    assert requests.post(url + "/api/delete", json={}, headers=headers, timeout=5).status_code == 404
    assert requests.get(url + "/config.json", timeout=5).status_code == 404


def test_local_archive_atomic_no_overwrite_paths_lock_and_persistence(tmp_path):
    archive = LocalArchive(tmp_path / "archive")
    archive.put("runs/test/value.json", b"first")
    assert LocalArchive(archive.root).get("runs/test/value.json") == b"first"
    with pytest.raises(BackupError, match="write failed"):
        archive.put("runs/test/value.json", b"second")
    assert archive.get("runs/test/value.json") == b"first"
    assert archive.names("runs") == ["runs/test/value.json"]
    for path in ["../escape", "/absolute", "a\\b", "a//b"]:
        with pytest.raises(BackupError):
            archive.put(path, b"x")
    other = LocalArchive(archive.root)
    with archive.guard("capture"):
        archive.assert_lock()
        with pytest.raises(BackupError, match="Another process"):
            with other.guard("capture"):
                pytest.fail("Conflicting lock must not be acquired")
    with pytest.raises(BackupError, match="not held"):
        archive.assert_lock()
    assert not list(archive.root.rglob(".writing-*"))


def log_response(details):
    return {"tables": [{"columns": [{"name": name} for name in
                                    ["TimeGenerated", "Level", "Event", "ResourceId", "RunId",
                                     "Status", "ErrorCode", "Details"]],
                         "rows": [["2026-10-31T00:00:00Z", "Information", "event", RID,
                                   RUN, "Succeeded", "", details]]}]}


@pytest.mark.parametrize("details", [{"ticket": "CHG-1"}, '{"ticket":"CHG-1"}'])
def test_actual_log_dynamic_shapes_and_scope_bound_kql(details):
    reader = LogsReader(Mock(), SID, SCOPE)
    response = Mock(status_code=200)
    response.json.return_value = log_response(details)
    with patch("armbackup.monitoring.requests.post", return_value=response) as post:
        result = reader.query(days=1, search="a'b")
    assert result["logs"][0]["ticket"] == "CHG-1"
    assert result["source"] == "log-analytics"
    assert SCOPE in post.call_args.kwargs["json"]["query"]
    assert "a\\'b" in result["query"]
    assert post.call_args.kwargs["allow_redirects"] is False


@pytest.mark.parametrize("details", ["not-json", [], 7])
def test_invalid_dynamic_fields_fail_instead_of_fabricating_log_success(details):
    response = Mock(status_code=200)
    response.json.return_value = log_response(details)
    with patch("armbackup.monitoring.requests.post", return_value=response):
        with pytest.raises(BackupError):
            LogsReader(Mock(), SID, SCOPE).query()


def test_log_partial_error_and_403_are_not_empty_success():
    reader = LogsReader(Mock(), SID, SCOPE)
    partial = Mock(status_code=200)
    partial.json.return_value = {"error": {"code": "PartialError"}, **log_response({})}
    with patch("armbackup.monitoring.requests.post", return_value=partial):
        with pytest.raises(BackupError, match="partial"):
            reader.query()
    denied = Mock(status_code=403)
    denied.json.return_value = {"error": {"code": "InsufficientAccessError"}}
    with patch("armbackup.monitoring.requests.post", return_value=denied):
        with pytest.raises(BackupError, match="403"):
            reader.query()
    assert kql_literal("a'b\n") == "'a\\'b\\n'"


def test_activity_uses_only_latest_successful_write_or_delete():
    arm = Mock()
    arm.pages.return_value = [
        {"resourceId": RID, "operationName": {"value": "x/write"}, "status": {"value": "Succeeded"},
         "eventTimestamp": "2026-10-31T01:00:00Z", "caller": "pipeline"},
        {"resourceId": RID, "operationName": {"value": "x/write"}, "status": {"value": "Failed"},
         "eventTimestamp": "2026-10-31T02:00:00Z", "caller": "failed-caller"},
        {"resourceId": RID, "operationName": {"value": "x/delete"}, "status": {"value": "Succeeded"},
         "eventTimestamp": "2026-10-31T03:00:00Z", "caller": "operator"},
    ]
    result = activity_changes(arm, SID, GROUP)
    assert result[RID.lower()]["caller"] == "operator"
    assert result[RID.lower()]["source"] == "Azure Activity Log"
    assert GROUP in arm.pages.call_args.args[0]


def test_parent_attribution_includes_known_child_writes_not_siblings_or_dependencies():
    child = RID.lower() + "/securityrules/https"
    actors = {
        RID.lower(): {"at": "2026-10-31T01:00:00Z", "caller": "parent"},
        child: {"at": "2026-10-31T02:00:00Z", "caller": "rule-operator"},
        RID.lower() + "-other/securityrules/https": {"at": "2026-10-31T03:00:00Z", "caller": "sibling"},
        RID.lower() + "/providers/microsoft.insights/diagnosticsettings/a": {
            "at": "2026-10-31T04:00:00Z", "caller": "uncompared-setting",
        },
    }
    assert resource_actor(actors, RID, NSG)["caller"] == "rule-operator"
    assert resource_actor(actors, RID, ROUTES)["caller"] == "parent"


def test_comparison_named_paths_missing_null_readonly_and_limits():
    left = {"properties": {"securityRules": [{"name": "b", "value": 2}, {"name": "a", "value": 1}]}}
    right = {"properties": {"securityRules": [{"name": "a", "value": 3}, {"name": "b", "value": 2}]}}
    diff, truncated = differences(left, right)
    assert diff[0]["path"] == "properties.securityRules[a].value"
    assert not truncated
    assert differences({}, {"value": None})[0][0]["beforePresent"] is False
    assert differences([1, 2], [2, 1])[0]
    assert differences({str(i): i for i in range(10)}, {}, limit=2)[1]
    raw = nsg()
    assert "provisioningState" not in configuration(raw, NSG)["properties"]
    current = {"status": "present", "apiVersion": "2024-05-01", "raw": raw}
    snapshot = {"captureApiVersion": "2024-05-01", "raw": raw}
    assert compare(snapshot, current, NSG, complete=True)["status"] == "same"
    assert compare(snapshot, current, NSG, complete=False)["status"] == "unknown"


def test_projection_is_independent_of_the_immutable_source_snapshot():
    raw = nsg()
    raw["properties"]["securityRules"][0]["properties"]["sourcePortRanges"] = []
    before = copy.deepcopy(raw)
    projected = project_body(raw, NSG)
    projected["tags"]["reviewRevision"] = "new"
    projected["properties"]["securityRules"][0]["properties"]["sourcePortRanges"].append("443")
    assert raw == before


def test_console_config_allows_korean_display_labels_but_requires_reviewed_apis(tmp_path, config_data):
    config_data.update({"subscriptions": [SID], "resource_groups": [GROUP], "collections": {},
                        "api_versions": {NSG: "2024-05-01", ROUTES: "2024-05-01", VNET: "2024-05-01"}})
    config_data["logging"].update({
        "workspace_resource_id": SCOPE + "/providers/Microsoft.OperationalInsights/workspaces/law",
        "dcr_resource_id": SCOPE + "/providers/Microsoft.Insights/dataCollectionRules/dcr",
    })
    capture_path = tmp_path / "capture.json"
    capture_path.write_bytes(encode_json(config_data))
    console_path = tmp_path / "console.json"
    raw = {"capture_config": "capture.json", "workspace_name": "운영 검증 콘솔",
           "subscription_name": "고객 구독", "lab_id": "unit-lab", "workspace_guid": SID}
    console_path.write_bytes(encode_json(raw))
    assert ConsoleConfig.load(console_path).workspace_name == "운영 검증 콘솔"
    config_data["api_versions"].pop(VNET)
    capture_path.write_bytes(encode_json(config_data))
    with pytest.raises(BackupError, match="explicit API"):
        ConsoleConfig.load(console_path)


def test_history_api_reads_archived_shapes_without_current_arm_mutation(console):
    drift(console)
    later = "20261101T050000Z-001122334455"
    Backup(console.config.capture, console.arm, console.archive, console.events_factory("unit")).run(
        later, inventory=[Resource(RID, NSG, SID, GROUP)],
    )
    before = len(writes(console))
    data = console.change_history()
    change = next(item for item in data["records"] if item["kind"] == "changed")
    assert change["beforeRunId"] == RUN
    assert change["afterRunId"] == later
    detail = console.change_detail(RUN, later, RID)
    assert detail["comparison"]["diffs"][0]["after"] == "8443"
    assert len(writes(console)) == before
    with pytest.raises(BackupError, match="outside"):
        console.change_detail(RUN, later, RID.replace(GROUP, GROUP + "-other"))


def test_history_session_endpoints_preserve_scope_and_source_integrity(live_url):
    url, server = live_url
    assert requests.get(url + "/api/history", timeout=5).status_code == 403
    headers = {"X-Console-Token": server.session_token}
    response = requests.get(url + "/api/history", headers=headers, timeout=5)
    assert response.status_code == 200
    assert response.json()["timestampMeaning"] == "later-backup-observation-not-operation-time"
    assert response.json()["records"][0]["kind"] == "baseline"
    detail = requests.get(url + "/api/history/detail", params={
        "afterRunId": RUN, "resourceId": RID,
    }, headers=headers, timeout=5)
    assert detail.status_code == 200
    assert detail.json()["comparison"]["diffs"] == []
