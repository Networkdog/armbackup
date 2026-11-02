from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from armbackup.contracts import (
    BackupError,
    BrowseArchive,
    JsonObject,
    digest,
    encode_json,
    object_value,
    utc_now,
)

LOGGER = logging.getLogger(__name__)
FRESH_SECONDS = 300


class StateView:
    def __init__(self, archive: BrowseArchive, scope: str, identity: str) -> None:
        self.archive, self.scope, self.identity = archive, scope, identity

    @property
    def key(self) -> str:
        return digest(encode_json({"scope": self.scope, "identity": self.identity}))

    @property
    def pointer(self) -> str:
        return f"console/views/heads/{self.key}.json"

    def generation(self) -> str:
        names = {prefix: self.archive.names(prefix, limit=10000)
                 for prefix in ("runs", "console/jobs", "console/policies", "console/labels")}
        return digest(encode_json(names))

    def read(self) -> JsonObject | None:
        pointer = self.archive.read_pointer(self.pointer)
        if pointer is not None:
            head = object_value(json.loads(pointer[0]), "state view pointer")
            if (head.get("schemaVersion") != 1
                    or head.get("scope") != self.scope or head.get("identity") != self.identity):
                raise BackupError("State view pointer scope/config mismatch")
            name = head.get("marker")
            if not isinstance(name, str) or not re.fullmatch(r"console/views/complete/[\w-]+\.json", name):
                raise BackupError("State view pointer marker path is invalid")
            payload = self.archive.get(name)
            if digest(payload) != head.get("markerSha256"):
                raise BackupError("State view marker integrity verification failed")
            return self._read_marker(object_value(json.loads(payload), "state view marker"))
        # One-time compatibility path; new publications use a scope-specific direct pointer.
        markers = self.archive.names("console/views/complete", limit=10000)
        for name in reversed(markers):
            marker = object_value(json.loads(self.archive.get(name)), "state view marker")
            if marker.get("scope") == self.scope and marker.get("identity") == self.identity:
                return self._read_marker(marker)
        return None

    def _read_marker(self, marker: JsonObject) -> JsonObject:
        if (marker.get("schemaVersion") != 1
                or marker.get("scope") != self.scope or marker.get("identity") != self.identity):
            raise BackupError("State view marker scope/config mismatch")
        created_at = marker.get("createdAt")
        if not isinstance(created_at, str):
            raise BackupError("State view timestamp is invalid")
        try:
            moment = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise BackupError("State view timestamp is invalid") from exc
        if moment.tzinfo is None:
            raise BackupError("State view timestamp requires a timezone")
        age = datetime.now(UTC) - moment
        if age < timedelta():
            raise BackupError("State view timestamp is in the future")
        sha = marker.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise BackupError("State view marker hash is invalid")
        payload = self.archive.get(f"console/views/objects/{sha}.json")
        if digest(payload) != sha:
            raise BackupError("State view integrity verification failed")
        state = object_value(json.loads(payload), "state view")
        if state.get("workspace", {}).get("scope") != self.scope or state.get("mode") != "live-lab":
            raise BackupError("State view scope/mode mismatch")
        return {**state, "materializedView": {"cached": True, "createdAt": marker["createdAt"],
                                             "sha256": sha, "generation": marker["generation"],
                                             "expired": age.total_seconds() > FRESH_SECONDS,
                                             "requiresLiveRefresh": True}}

    def build(self, loader: Callable[[], JsonObject]) -> JsonObject:
        previous = self.archive.read_pointer(self.pointer)
        before = self.generation()
        state = loader()
        if state.get("workspace", {}).get("scope") != self.scope or state.get("mode") != "live-lab":
            raise BackupError("Cannot publish a state view outside its configured scope/mode")
        after = self.generation()
        if before != after:
            return {**state, "materializedView": {"cached": False, "persisted": False,
                                                 "reason": "Inputs changed during observation"}}
        payload = encode_json(state)
        sha = digest(payload)
        with self.archive.guard("state-view"):
            if self.generation() != after:
                return {**state, "materializedView": {"cached": False, "persisted": False,
                                                     "reason": "Inputs changed before publication"}}
            object_name = f"console/views/objects/{sha}.json"
            if not self.archive.names(object_name):
                self.archive.put(object_name, payload)
            if digest(self.archive.get(object_name)) != sha:
                raise BackupError("State view readback verification failed")
            now = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
            name = now.replace(":", "").replace(".", "") + "-" + uuid.uuid4().hex
            marker_name = f"console/views/complete/{name}.json"
            marker = encode_json({
                "schemaVersion": 1, "scope": self.scope, "identity": self.identity, "createdAt": now,
                "generation": after, "sha256": sha,
            })
            self.archive.put(marker_name, marker)
            if digest(self.archive.get(marker_name)) != digest(marker):
                raise BackupError("State view marker readback verification failed")
            published = self.archive.replace_pointer(self.pointer, encode_json({
                "schemaVersion": 1, "scope": self.scope, "identity": self.identity,
                "marker": marker_name, "markerSha256": digest(marker),
            }), previous[1] if previous else None)
            if not published:
                return {**state, "materializedView": {"cached": False, "persisted": False,
                                                     "reason": "Another collector published a newer view"}}
        return {**state, "materializedView": {"cached": False, "persisted": True, "sha256": sha,
                                              "createdAt": now, "requiresLiveRefresh": False}}


class StateRefresher:
    def __init__(self, view: Callable[[], StateView], loader: Callable[[], JsonObject]) -> None:
        self.view, self.loader = view, loader
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="armbackup-state")
        self.lock = threading.Lock()
        self.future: Future[JsonObject] | None = None
        self.record: JsonObject = {}
        self.result: JsonObject | None = None
        self.revision = 0
        self.completed_revision = -1
        self.completed_at = 0.0
        self.failed_at = 0.0
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def request(self, *, force: bool = False) -> str:
        view = self.view()
        with self.lock:
            if self.stop.is_set():
                raise BackupError("State refresh service is closing")
            if self.future is not None and not self.future.done():
                if self.record["key"] != view.key:
                    raise BackupError("Configuration changed during state refresh; retry after it finishes")
                return str(self.record["id"])
            if (not force and self.record.get("status") == "Failed" and self.record.get("key") == view.key
                    and time.monotonic() - self.failed_at < 30):
                return str(self.record["id"])
            if (not force and self.result is not None and self.record.get("key") == view.key
                    and self.completed_revision == self.revision
                    and time.monotonic() - self.completed_at < FRESH_SECONDS):
                return str(self.record["id"])
            identifier = str(uuid.uuid4())
            self.record = {"id": identifier, "key": view.key, "status": "Running", "startedAt": utc_now()}
            self.result = None
            self.future = self.executor.submit(self._collect, view)
            return identifier

    def _collect(self, view: StateView) -> JsonObject:
        try:
            for _ in range(3):
                with self.lock:
                    revision = self.revision
                state = view.build(self.loader)
                if self.view().key != view.key:
                    raise BackupError("Configuration changed during state collection")
                with self.lock:
                    if revision != self.revision or not state["materializedView"]["persisted"]:
                        continue
                    self.result = state
                    self.completed_at = time.monotonic()
                    self.completed_revision = revision
                    self.record.update({"status": "Succeeded", "finishedAt": utc_now()})
                    return state
            raise BackupError("State inputs kept changing; no stable view was published")
        except Exception as exc:
            LOGGER.exception("State view background refresh failed")
            with self.lock:
                self.failed_at = time.monotonic()
                self.record.update({"status": "Failed", "finishedAt": utc_now(),
                                    "error": str(exc), "errorCode": type(exc).__name__})
            raise

    def status(self, identifier: str, *, include_state: bool = True) -> JsonObject:
        with self.lock:
            if identifier != self.record.get("id") or self.record.get("key") != self.view().key:
                raise BackupError("State refresh is no longer current; request it again")
            record = {key: value for key, value in self.record.items() if key != "key"}
            if include_state and record["status"] == "Succeeded":
                record["state"] = self.result
            return record

    def wait(self, identifier: str) -> JsonObject:
        with self.lock:
            if identifier != self.record.get("id") or self.future is None:
                raise BackupError("State refresh was not found")
            future = self.future
        return future.result()

    def invalidate(self) -> None:
        with self.lock:
            self.revision += 1
        if self.thread is not None:
            self.request()

    def start(self) -> None:
        if self.thread is not None:
            return
        self.request()

        def periodically() -> None:
            while not self.stop.wait(FRESH_SECONDS):
                try:
                    self.request(force=True)
                except BackupError:
                    LOGGER.exception("Cannot schedule state view refresh")

        self.thread = threading.Thread(target=periodically, name="armbackup-state-scheduler", daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join()
        self.executor.shutdown(wait=True, cancel_futures=False)
