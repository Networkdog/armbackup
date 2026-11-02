from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from armbackup.contracts import (
    BackupError,
    BrowseArchive,
    JsonObject,
    digest,
    encode_json,
    object_value,
)


class StateView:
    def __init__(self, archive: BrowseArchive, scope: str, identity: str) -> None:
        self.archive, self.scope, self.identity = archive, scope, identity

    def generation(self) -> str:
        names = {prefix: self.archive.names(prefix, limit=10000)
                 for prefix in ("runs", "console/jobs", "console/policies", "console/labels")}
        return digest(encode_json(names))

    def read(self) -> JsonObject | None:
        markers = self.archive.names("console/views/complete", limit=10000)
        if not markers:
            return None
        marker = object_value(json.loads(self.archive.get(markers[-1])), "state view marker")
        if marker.get("scope") != self.scope or marker.get("identity") != self.identity:
            return None
        moment = datetime.fromisoformat(marker["createdAt"].replace("Z", "+00:00"))
        age = datetime.now(UTC) - moment
        if age < timedelta() or age > timedelta(minutes=5) or marker["generation"] != self.generation():
            return None
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
                                             "requiresLiveRefresh": True}}

    def build(self, loader: Callable[[], JsonObject]) -> JsonObject:
        before = self.generation()
        state = loader()
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
            self.archive.put(f"console/views/complete/{name}.json", encode_json({
                "schemaVersion": 1, "scope": self.scope, "identity": self.identity, "createdAt": now,
                "generation": after, "sha256": sha,
            }))
        return {**state, "materializedView": {"cached": False, "persisted": True, "sha256": sha}}
