"""Daily backup schedule: one administrator-defined KST time per day, run by the web process.

WebJobs cannot be used on the Oryx-compressed deployment, so the hosted console runs this thread.
Per-day claim blobs (written with overwrite=False) keep a scaled-out or restarted app from
starting the same attempt twice.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import TYPE_CHECKING

from azure.core.exceptions import AzureError

from armbackup.backup import new_run_id
from armbackup.config import keys
from armbackup.contracts import (
    BackupError,
    BrowseArchive,
    JsonObject,
    encode_json,
    object_value,
    utc_now,
)

if TYPE_CHECKING:
    from armbackup.console import LiveConsole

LOGGER = logging.getLogger(__name__)
KST = timezone(timedelta(hours=9), "KST")
DEFAULT_SCHEDULE: JsonObject = {"time": "02:00", "enabled": True}
TIME = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")
RUNS = "console/schedule-runs"
POLICIES = "console/schedule-settings"
MAX_ATTEMPTS = 3
RETRY_DELAY = timedelta(minutes=15)
STALE_CLAIM = timedelta(hours=3)
CATCH_UP = timedelta(hours=3)
TICK_SECONDS = 60.0


def validate_schedule(raw: object) -> JsonObject:
    data = object_value(raw, "backup schedule")
    keys(data, {"time", "enabled"}, "backup schedule")
    value, enabled = data.get("time"), data.get("enabled", True)
    if not isinstance(value, str) or not TIME.fullmatch(value):
        raise BackupError("Backup time must be HH:MM in 24-hour KST")
    if not isinstance(enabled, bool):
        raise BackupError("Backup schedule enabled must be boolean")
    return {"time": value, "enabled": enabled}


def read_schedule(archive: BrowseArchive) -> JsonObject:
    records = []
    for name in archive.names(POLICIES):
        record = _document(archive, name)
        if type(record.get("revision")) is not int:
            raise BackupError("Stored backup schedule revision is invalid")
        records.append(record)
    if not records:
        return {"schedule": dict(DEFAULT_SCHEDULE), "revision": 0, "savedAt": "", "default": True}
    latest = max(records, key=lambda record: (record["revision"], record.get("savedAt", "")))
    return {"schedule": validate_schedule(latest.get("schedule")), "revision": latest["revision"],
            "savedAt": latest.get("savedAt", ""), "default": False}


def write_schedule(archive: BrowseArchive, schedule: JsonObject, operation_id: str) -> JsonObject:
    previous = read_schedule(archive)
    revision = previous["revision"] + 1
    saved = utc_now()
    archive.put(f"{POLICIES}/{new_run_id()}.json",
                encode_json({"schedule": schedule, "revision": revision,
                             "savedAt": saved, "operationId": operation_id}))
    return {"schedule": schedule, "revision": revision, "savedAt": saved, "default": False}


def due_time(schedule: JsonObject, day: datetime) -> datetime:
    hour, minute = map(int, str(schedule["time"]).split(":"))
    return day.astimezone(KST).replace(hour=hour, minute=minute, second=0, microsecond=0)


def _parse(value: object) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _document(archive: BrowseArchive, name: str) -> JsonObject:
    return object_value(json.loads(archive.get(name)), "schedule record")


def day_state(archive: BrowseArchive, day: str, now: datetime) -> tuple[str, int]:
    """Return (state, next attempt) for a KST day; state is due/running/retrying/succeeded/failed."""
    names = archive.names(f"{RUNS}/{day}-")
    claims = {int(name.rsplit("-", 1)[1].split(".")[0]) for name in names if name.endswith(".claim.json")}
    results = {int(name.rsplit("-", 1)[1].split(".")[0]): _document(archive, name)
               for name in names if name.endswith(".result.json")}
    if not claims:
        return "due", 1
    if any(result.get("status") == "Succeeded" for result in results.values()):
        return "succeeded", 0
    last = max(claims)
    if last in results:
        settled = _parse(results[last]["finishedAt"])
    else:
        settled = _parse(_document(archive, f"{RUNS}/{day}-{last}.claim.json")["startedAt"]) + STALE_CLAIM
        if now < settled:
            return "running", 0
    if last >= MAX_ATTEMPTS:
        return "failed", 0
    return ("retrying" if now - settled < RETRY_DELAY else "due"), last + 1


def latest_result(archive: BrowseArchive) -> JsonObject | None:
    names = sorted(name for name in archive.names(RUNS, limit=10000) if name.endswith(".result.json"))
    return _document(archive, names[-1]) if names else None


def today_state(archive: BrowseArchive, schedule: JsonObject, now: datetime) -> tuple[str, int]:
    """State of today's run: disabled/waiting/missed on top of the per-day claim state."""
    if not schedule["enabled"]:
        return "disabled", 0
    due = due_time(schedule, now)
    if now < due:
        return "waiting", 0
    state, attempt = day_state(archive, now.astimezone(KST).strftime("%Y-%m-%d"), now)
    if state == "due" and attempt == 1 and now >= due + CATCH_UP:
        return "missed", 0
    return state, attempt


def schedule_status(archive: BrowseArchive, now: datetime) -> JsonObject:
    record = read_schedule(archive)
    schedule = record["schedule"]
    state, _ = today_state(archive, schedule, now)
    due = due_time(schedule, now)
    upcoming = due if state in {"waiting", "due", "running", "retrying"} else due + timedelta(days=1)
    return {**record, "timezone": "Asia/Seoul", "today": state,
            "nextRunAt": upcoming.astimezone(UTC).isoformat().replace("+00:00", "Z") if schedule["enabled"] else "",
            "last": latest_result(archive), "maxAttempts": MAX_ATTEMPTS,
            "retryMinutes": int(RETRY_DELAY.total_seconds() // 60),
            "catchUpHours": int(CATCH_UP.total_seconds() // 3600)}


class BackupScheduler:
    """Starts the saved-policy backup once per KST day at the administrator's chosen time."""

    def __init__(self, console: LiveConsole, *, tick: float = TICK_SECONDS,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.console, self.tick, self.clock = console, tick, clock
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.thread is None:
            self.console.scheduler_active = True
            self.thread = threading.Thread(target=self._loop, name="armbackup-schedule", daemon=True)
            self.thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=120)

    def _loop(self) -> None:
        while not self.stop.wait(self.tick):
            try:
                self.run_once()
            except (BackupError, AzureError, OSError, ValueError) as exc:
                LOGGER.error("Scheduled backup check failed: %s", type(exc).__name__)

    def run_once(self) -> str:
        now = self.clock()
        archive = self.console.archive
        schedule = read_schedule(archive)["schedule"]
        state, attempt = today_state(archive, schedule, now)
        if state != "due" or self.console.operation_running():
            return state
        day = now.astimezone(KST).strftime("%Y-%m-%d")
        try:
            archive.put(f"{RUNS}/{day}-{attempt}.claim.json",
                        encode_json({"day": day, "attempt": attempt, "startedAt": stamp(now)}))
        except BackupError:
            return "claimed-elsewhere"
        outcome: JsonObject = {"day": day, "attempt": attempt, "status": "Failed", "runId": "", "error": ""}
        try:
            job = self.console.submit("backup", {}, scheduled=True)
            while not self.stop.is_set():
                current = self.console.job(job["id"])
                if current["status"] in {"Succeeded", "Failed"}:
                    outcome.update(status=current["status"], error=str(current.get("error", "")),
                                   runId=str(current.get("result", {}).get("runId", "")))
                    break
                self.stop.wait(2.0)
            else:
                return "stopped"
        except BackupError as exc:
            outcome["error"] = str(exc)
        archive.put(f"{RUNS}/{day}-{attempt}.result.json",
                    encode_json({**outcome, "finishedAt": stamp(max(now, self.clock()))}))
        LOGGER.info("Scheduled backup %s attempt %d: %s", day, attempt, outcome["status"])
        return str(outcome["status"])
