import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
import requests
import test_console
from test_console import GROUP, NSG, RID

from armbackup.contracts import BackupError
from armbackup.schedule import (
    KST,
    MAX_ATTEMPTS,
    RETRY_DELAY,
    BackupScheduler,
    day_state,
    due_time,
    schedule_status,
    validate_schedule,
)

POLICY = {"scopeIds": [RID], "types": [NSG], "tags": []}
console = test_console.console
live_url = test_console.live_url


def kst(day: str, clock: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{clock}:00").replace(tzinfo=KST).astimezone(UTC)


def manifests(console):
    return [name for name in console.archive.names("runs") if name.endswith("manifest.json")]


def save_policy(console):
    job = console.submit("policy", {"policy": POLICY})
    console.futures[job["id"]].result(timeout=5)


def scheduler_at(console, moment):
    scheduler = BackupScheduler(console, clock=lambda: moment[0])
    scheduler.stop.wait = lambda _timeout=None: False
    return scheduler


def test_schedule_validation_defaults_and_revisions(console):
    default = console.admin_status()["schedule"]
    assert default["schedule"] == {"time": "02:00", "enabled": True} and default["default"] is True
    for bad in ({"time": "24:00"}, {"time": "2:30"}, {"time": "02:00", "enabled": "yes"},
                {"time": "02:00", "weekday": 1}, {}):
        with pytest.raises(BackupError):
            validate_schedule(bad)
    saved = console.save_schedule({"time": "03:30", "enabled": True})["schedule"]
    assert saved["schedule"]["time"] == "03:30" and saved["revision"] == 1 and saved["timezone"] == "Asia/Seoul"
    assert console.save_schedule({"time": "04:15", "enabled": False})["schedule"]["revision"] == 2
    final = console.admin_status()["schedule"]
    assert final["schedule"] == {"time": "04:15", "enabled": False}
    assert final["nextRunAt"] == "" and final["today"] == "disabled"
    assert console.admin_status()["purge"]["confirmGroup"] == GROUP


def test_next_run_is_the_chosen_kst_time():
    schedule = {"time": "03:30", "enabled": True}
    assert due_time(schedule, kst("2026-11-10", "12:00")) == kst("2026-11-10", "03:30")


def test_scheduler_backs_up_once_per_kst_day_at_the_chosen_time(console):
    save_policy(console)
    console.save_schedule({"time": "03:30", "enabled": True})
    before = len(manifests(console))
    moment = [kst("2026-11-10", "03:29")]
    scheduler = scheduler_at(console, moment)
    assert scheduler.run_once() == "waiting"
    assert len(manifests(console)) == before
    moment[0] = kst("2026-11-10", "03:31")
    assert scheduler.run_once() == "Succeeded"
    created = [name for name in manifests(console) if json.loads(console.archive.get(name)).get("kind") == "scheduled"]
    assert len(created) == 1
    assert scheduler.run_once() == "succeeded"
    assert len(manifests(console)) == before + 1
    moment[0] = kst("2026-11-11", "03:30")
    assert scheduler.run_once() == "Succeeded"
    assert len(manifests(console)) == before + 2
    status = console.admin_status()["schedule"]
    assert status["last"]["status"] == "Succeeded" and status["last"]["day"] == "2026-11-11"


def test_a_missed_start_runs_within_the_catch_up_window_but_not_after_it(console):
    save_policy(console)
    console.save_schedule({"time": "02:00", "enabled": True})
    late = scheduler_at(console, [kst("2026-11-10", "05:01")])
    assert late.run_once() == "missed"
    assert not console.archive.names("console/schedule-runs")
    assert schedule_status(console.archive, kst("2026-11-10", "05:01"))["today"] == "missed"
    assert schedule_status(console.archive, kst("2026-11-10", "05:01"))["nextRunAt"] == "2026-11-10T17:00:00Z"
    restarted = scheduler_at(console, [kst("2026-11-10", "04:59")])
    assert restarted.run_once() == "Succeeded"


def test_disabled_schedule_never_runs(console):
    save_policy(console)
    console.save_schedule({"time": "01:00", "enabled": False})
    scheduler = scheduler_at(console, [kst("2026-11-10", "23:00")])
    assert scheduler.run_once() == "disabled"
    assert len(manifests(console)) == 1


def test_failed_attempts_retry_after_the_delay_up_to_the_daily_limit(console):
    console.save_schedule({"time": "02:00", "enabled": True})
    moment = [kst("2026-11-10", "02:01")]
    scheduler = scheduler_at(console, moment)
    assert scheduler.run_once() == "Failed"
    assert scheduler.run_once() == "retrying"
    for _attempt in range(2, MAX_ATTEMPTS + 1):
        moment[0] += RETRY_DELAY + timedelta(seconds=1)
        assert scheduler.run_once() == "Failed"
        assert day_state(console.archive, "2026-11-10", moment[0])[0] in {"retrying", "failed"}
    moment[0] += RETRY_DELAY + timedelta(minutes=1)
    assert scheduler.run_once() == "failed"
    assert len(console.archive.names("console/schedule-runs/2026-11-10-")) == MAX_ATTEMPTS * 2
    assert console.admin_status()["schedule"]["last"]["status"] == "Failed"


def test_an_existing_claim_prevents_a_second_instance_from_starting(console):
    save_policy(console)
    console.save_schedule({"time": "02:00", "enabled": True})
    moment = [kst("2026-11-10", "02:05")]
    other = json.dumps({"day": "2026-11-10", "attempt": 1, "startedAt": moment[0].isoformat()}).encode()
    console.archive.put("console/schedule-runs/2026-11-10-1.claim.json", other)
    scheduler = scheduler_at(console, moment)
    assert scheduler.run_once() == "running"
    assert len(manifests(console)) == 1


def test_scheduler_does_not_start_while_another_operation_is_running(console):
    save_policy(console)
    console.save_schedule({"time": "02:00", "enabled": True})
    scheduler = scheduler_at(console, [kst("2026-11-10", "02:05")])
    with patch.object(console, "operation_running", return_value=True):
        assert scheduler.run_once() == "due"
    assert not console.archive.names("console/schedule-runs")


def test_purge_requires_both_confirmations_and_removes_only_backup_data(console):
    save_policy(console)
    console.save_schedule({"time": "05:00", "enabled": True})
    assert manifests(console)
    for payload in ({"confirmGroup": "wrong", "confirmPhrase": "모든 백업 삭제"},
                    {"confirmGroup": GROUP, "confirmPhrase": "delete"}):
        with pytest.raises(BackupError, match="confirmation"):
            console.purge({"id": "purge-test"}, payload)
        assert manifests(console)
    job = console.submit("purge", {"confirmGroup": GROUP, "confirmPhrase": "모든 백업 삭제"})
    console.futures[job["id"]].result(timeout=60)
    outcome = console.job(job["id"])
    assert outcome["status"] == "Succeeded" and outcome["result"]["deletedTotal"] > 0
    assert not console.archive.names("runs")
    assert console.archive.names("console/policies") and console.archive.names("console/schedule-settings")
    assert console.admin_status()["schedule"]["schedule"]["time"] == "05:00"
    assert console.archive.names("console/jobs")


def test_archives_refuse_to_purge_anything_but_backup_prefixes(console):
    for prefix in ("locks", "console/policies", "console/schedule-settings", "console/jobs", "runs/x", ""):
        with pytest.raises(BackupError):
            with console.archive.guard("capture"):
                console.archive.purge(prefix)


def test_admin_http_routes_save_the_schedule_and_start_a_purge(live_url):
    url, server = live_url
    headers = {"X-Console-Token": server.session_token, "Origin": url}
    assert requests.get(url + "/api/admin", timeout=5).status_code == 403
    status = requests.get(url + "/api/admin", headers=headers, timeout=5).json()
    assert status["schedule"]["schedule"]["time"] == "02:00" and status["runnerActive"] is False
    assert status["storage"]["archive"] == "local"
    assert status["storage"]["path"] == str(server.console.config.local_archive)
    saved = requests.post(url + "/api/admin/schedule", headers=headers,
                          json={"time": "06:45", "enabled": True}, timeout=5)
    assert saved.status_code == 200 and saved.json()["schedule"]["schedule"]["time"] == "06:45"
    bad = requests.post(url + "/api/admin/schedule", headers=headers, json={"time": "6:45"}, timeout=5)
    assert bad.status_code == 400
    refused = requests.post(url + "/api/purge", headers=headers,
                            json={"confirmGroup": "x", "confirmPhrase": "y"}, timeout=5)
    assert refused.status_code == 202
    job = refused.json()["id"]
    server.console.futures[job].result(timeout=30)
    assert server.console.job(job)["status"] == "Failed"


def test_live_console_never_serves_the_sample_data_modules(live_url):
    url, _ = live_url
    for path in ("/app.mjs", "/model.mjs", "/demo-data.mjs", "/demo-history.mjs"):
        assert requests.get(url + path, timeout=5).status_code == 404, path
    page = requests.get(url, timeout=5).text
    assert "/app.mjs" not in page and "demo" not in page.lower().replace("reset-demo", "")
    assert '<span class="avatar">L</span>' in page and '<span class="avatar">P</span>' not in page
    assert requests.get(url + "/live-app.mjs", timeout=5).status_code == 200


def test_status_lists_only_resources_the_saved_policy_would_back_up(console):
    key = RID.lower()
    state = console.state()
    assert [r["inPolicy"] for r in state["resources"] if r["id"].lower() == key] == [False]
    save_policy(console)
    assert console.state()["resources"][0]["inPolicy"] is True
    job = console.submit("purge", {"confirmGroup": GROUP, "confirmPhrase": "모든 백업 삭제"})
    console.futures[job["id"]].result(timeout=60)
    after = console.state()
    assert after["runs"] == [] and after["resources"][0]["inPolicy"] is True
    console.arm.resources[key]["tags"]["customer"] = "alpha"
    job = console.submit("policy", {"policy": {"scopeIds": [RID], "types": [NSG],
                                              "tags": [{"key": "customer", "operator": "equals", "value": "zzz"}]}})
    console.futures[job["id"]].result(timeout=30)
    assert console.state()["resources"][0]["inPolicy"] is False
