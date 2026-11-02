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


class InvalidStateView(BackupError):
    def __init__(self, message: str, artifacts: dict[str, str]) -> None:
        super().__init__(message)
        self.artifacts = dict(artifacts)


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
            artifacts = {self.pointer: pointer[1]}
            head = self._document(pointer[0], "state view pointer", artifacts)
            if (head.get("schemaVersion") != 1
                    or head.get("scope") != self.scope or head.get("identity") != self.identity):
                raise InvalidStateView("State view pointer scope/config mismatch", artifacts)
            name = head.get("marker")
            if not isinstance(name, str) or not re.fullmatch(r"console/views/complete/[A-Za-z0-9_-]+\.json", name):
                raise InvalidStateView("State view pointer marker path is invalid", artifacts)
            marker = self.archive.read_pointer(name)
            if marker is None:
                raise InvalidStateView("State view completion marker is missing", artifacts)
            artifacts[name] = marker[1]
            if digest(marker[0]) != head.get("markerSha256"):
                raise InvalidStateView("State view marker integrity verification failed", artifacts)
            document = self._document(marker[0], "state view marker", artifacts)
            if document.get("scope") != self.scope or document.get("identity") != self.identity:
                raise InvalidStateView("State view marker scope/config mismatch", {self.pointer: pointer[1]})
            return self._read_marker(document, artifacts)
        # One-time compatibility path; new publications use a scope-specific direct pointer.
        markers = self.archive.names("console/views/complete", limit=10000)
        for name in reversed(markers):
            entry = self.archive.read_pointer(name)
            if entry is None:
                raise InvalidStateView("State view completion marker is missing", {})
            legacy_marker = self._document(entry[0], "state view marker", {name: entry[1]})
            if legacy_marker.get("scope") == self.scope and legacy_marker.get("identity") == self.identity:
                return self._read_marker(legacy_marker, {name: entry[1]})
        return None

    @staticmethod
    def _document(raw: bytes, label: str, artifacts: dict[str, str]) -> JsonObject:
        try:
            return object_value(json.loads(raw), label)
        except (ValueError, UnicodeError, BackupError) as exc:
            raise InvalidStateView(f"{label}: invalid or incomplete JSON", artifacts) from exc

    def _read_marker(self, marker: JsonObject, artifacts: dict[str, str]) -> JsonObject:
        if (marker.get("schemaVersion") != 1
                or marker.get("scope") != self.scope or marker.get("identity") != self.identity):
            raise InvalidStateView("State view marker scope/config mismatch", artifacts)
        created_at = marker.get("createdAt")
        if not isinstance(created_at, str):
            raise InvalidStateView("State view timestamp is invalid", artifacts)
        try:
            moment = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise InvalidStateView("State view timestamp is invalid", artifacts) from exc
        if moment.tzinfo is None:
            raise InvalidStateView("State view timestamp requires a timezone", artifacts)
        age = datetime.now(UTC) - moment
        if age < timedelta():
            raise InvalidStateView("State view timestamp is in the future", artifacts)
        sha = marker.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise InvalidStateView("State view marker hash is invalid", artifacts)
        if not isinstance(marker.get("generation"), str):
            raise InvalidStateView("State view input generation is invalid", artifacts)
        object_name = f"console/views/objects/{sha}.json"
        payload = self.archive.read_pointer(object_name)
        if payload is None:
            raise InvalidStateView("State view object is missing", artifacts)
        if digest(payload[0]) != sha:
            raise InvalidStateView("State view integrity verification failed", {**artifacts, object_name: payload[1]})
        state = self._document(payload[0], "state view", {**artifacts, object_name: payload[1]})
        if (not isinstance(state.get("workspace"), dict)
                or state["workspace"].get("scope") != self.scope or state.get("mode") != "live-lab"):
            raise InvalidStateView("State view scope/mode mismatch", artifacts)
        try:
            self._validate_state(state)
        except BackupError as exc:
            raise InvalidStateView(str(exc), {**artifacts, object_name: payload[1]}) from exc
        return {**state, "materializedView": {"cached": True, "createdAt": marker["createdAt"],
                                             "sha256": sha, "generation": marker["generation"],
                                             "expired": age.total_seconds() > FRESH_SECONDS,
                                             "requiresLiveRefresh": True}}

    def _validate_state(self, state: JsonObject) -> None:
        if (state.get("schemaVersion") != 1 or state.get("mode") != "live-lab"
                or not isinstance(state.get("workspace"), dict)
                or state["workspace"].get("scope") != self.scope
                or any(not isinstance(state.get(name), list) for name in ("resources", "runs", "scopes"))
                or any(not isinstance(state.get(name), dict) for name in ("current", "policy"))
                or not isinstance(state.get("observedAt"), str)):
            raise BackupError("State view DTO is incomplete or outside its configured scope")
        try:
            observed = datetime.fromisoformat(state["observedAt"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise BackupError("State view observation timestamp is invalid") from exc
        if observed.tzinfo is None:
            raise BackupError("State view observation timestamp requires a timezone")

    def repair(self, error: InvalidStateView) -> list[str]:
        removed: list[str] = []
        with self.archive.guard("state-view"):
            if self.pointer in error.artifacts:
                expected = error.artifacts[self.pointer]
                current = self.archive.read_pointer(self.pointer)
                if current is not None and current[1] != expected:
                    LOGGER.warning("State cache changed before repair; preserving the replacement")
                    return removed
            ordered = sorted(error.artifacts, key=lambda name: name != self.pointer)
            for name in ordered:
                if self.archive.delete_view_artifact(name, error.artifacts[name]):
                    removed.append(name)
                else:
                    LOGGER.warning("State cache artifact changed during repair: %s", name)
                    if name == self.pointer:
                        return removed
            LOGGER.warning("Removed %d intermediate cache artifacts after %s", len(removed), error)
        return removed

    def build(self, loader: Callable[[], JsonObject]) -> JsonObject:
        previous = self.archive.read_pointer(self.pointer)
        before = self.generation()
        state = loader()
        self._validate_state(state)
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
            existing = self.archive.read_pointer(object_name)
            if existing is not None and digest(existing[0]) != sha:
                if not self.archive.delete_view_artifact(object_name, existing[1]):
                    raise BackupError("Corrupt cache object changed during repair")
                LOGGER.warning("Removed corrupt intermediate object before rebuilding: %s", object_name)
                existing = None
            if existing is None:
                self.archive.put(object_name, payload)
            written = self.archive.read_pointer(object_name)
            if written is None:
                raise InvalidStateView("State view readback object is missing", {})
            if digest(written[0]) != sha:
                raise InvalidStateView("State view readback verification failed", {object_name: written[1]})
            now = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
            name = now.replace(":", "").replace(".", "") + "-" + uuid.uuid4().hex
            marker_name = f"console/views/complete/{name}.json"
            marker = encode_json({
                "schemaVersion": 1, "scope": self.scope, "identity": self.identity, "createdAt": now,
                "generation": after, "sha256": sha,
            })
            self.archive.put(marker_name, marker)
            written_marker = self.archive.read_pointer(marker_name)
            if written_marker is None:
                raise InvalidStateView("State view readback marker is missing", {})
            if digest(written_marker[0]) != digest(marker):
                raise InvalidStateView("State view marker readback verification failed", {marker_name: written_marker[1]})
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
            last_reason = "State inputs changed during collection"
            for _ in range(3):
                with self.lock:
                    revision = self.revision
                try:
                    state = view.build(self.loader)
                except InvalidStateView as exc:
                    last_reason = str(exc)
                    view.repair(exc)
                    continue
                if self.view().key != view.key:
                    raise BackupError("Configuration changed during state collection")
                with self.lock:
                    if revision != self.revision or not state["materializedView"]["persisted"]:
                        last_reason = state["materializedView"].get("reason", "State inputs changed during collection")
                        continue
                    self.result = state
                    self.completed_at = time.monotonic()
                    self.completed_revision = revision
                    self.record.update({"status": "Succeeded", "finishedAt": utc_now()})
                    return state
            raise BackupError(f"State view rebuild exhausted retries: {last_reason}")
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
