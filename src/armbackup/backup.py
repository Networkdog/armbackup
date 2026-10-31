from __future__ import annotations

import uuid
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import UTC, datetime

from armbackup import __version__
from armbackup.config import Config
from armbackup.contracts import (
    Archive,
    Arm,
    BackupError,
    Events,
    JsonObject,
    digest,
    encode_json,
    utc_now,
)
from armbackup.discovery import ApiResolver, Resource, discover, subscriptions


def new_run_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]


class Backup:
    def __init__(self, config: Config, arm: Arm, archive: Archive, events: Events) -> None:
        self.config, self.arm, self.archive, self.events = config, arm, archive, events

    def _capture(self, resource: Resource, api_version: str, run_id: str) -> JsonObject:
        self.archive.assert_lock()
        collected = utc_now()
        primary = self.arm.request("GET", resource.id, api_version)
        supplemental: dict[str, JsonObject] = {}
        for collection in self.config.collections.get(resource.type, ()):
            path = resource.id + "/" + collection.path
            value = (
                {"value": list(self.arm.pages(path, collection.api_version))}
                if collection.mode == "list"
                else self.arm.request("GET", path, collection.api_version)
            )
            supplemental[collection.name] = {
                "path": collection.path, "apiVersion": collection.api_version,
                "mode": collection.mode, "response": value,
            }
        envelope: JsonObject = {
            "schemaVersion": 1, "sourceKind": "arm-rest", "resourceId": resource.id,
            "resourceType": resource.type, "subscriptionId": resource.subscription,
            "captureApiVersion": api_version, "capturedAt": collected,
            "raw": primary, "collections": supplemental,
            "restoreStatus": "Unverified",
        }
        content = encode_json(envelope)
        name = f"runs/{run_id}/resources/{digest(resource.id.lower().encode())}.json"
        self.archive.put(name, content)
        self.events.emit("resource_captured", resource_id=resource.id, status="Succeeded",
                         bytes=len(content), apiVersion=api_version)
        return {"id": resource.id, "type": resource.type, "status": "Captured",
                "blob": name, "sha256": digest(content), "bytes": len(content),
                "captureApiVersion": api_version, "restoreStatus": "Unverified"}

    def run(self, run_id: str) -> JsonObject:
        manifest: JsonObject = {
            "schemaVersion": 1, "runId": run_id, "toolVersion": __version__,
            "startedAt": utc_now(), "status": "Running", "resources": [],
            "discoveryFailures": [], "captureFailures": [],
            "coverage": "ARG-visible subscription scopes and configured supplemental GETs; not all control-plane settings",
            "configurationSha256": digest(encode_json({
                "tables": self.config.tables, "groups": self.config.resource_groups,
                "excludeTypes": self.config.exclude_types, "apiVersions": self.config.api_versions,
                "collections": {t: [vars(c) for c in cs] for t, cs in self.config.collections.items()},
            })),
        }
        self.events.emit("run_started", status="Running", toolVersion=__version__)
        self.events.flush()
        scope, excluded = subscriptions(self.arm, self.config)
        manifest["subscriptions"], manifest["excludedSubscriptions"] = scope, excluded
        # A coarse container-wide lock prevents overlapping jobs with intersecting scopes.
        with self.archive.guard("capture"):
            resources, failures = discover(self.arm, self.config, scope, self.events)
            manifest["discoveryFailures"] = failures
            self.archive.put(f"runs/{run_id}/discovery.json", encode_json({
                "schemaVersion": 1, "runId": run_id, "subscriptions": scope,
                "tables": self.config.tables, "resources": [vars(r) for r in resources],
                "failures": failures,
            }))
            resolver = ApiResolver(self.arm, self.config)
            jobs: list[tuple[Resource, str]] = []
            entries: list[JsonObject] = manifest["resources"]
            errors: list[JsonObject] = manifest["captureFailures"]
            for resource in resources:
                reason = (
                    "ConfiguredTypeExclusion" if resource.type in self.config.exclude_types
                    else "OutsideConfiguredResourceGroups"
                    if self.config.resource_groups and resource.group not in self.config.resource_groups
                    else ""
                )
                if reason:
                    entries.append({"id": resource.id, "type": resource.type,
                                    "status": "Excluded", "reason": reason})
                    continue
                try:
                    jobs.append((resource, resolver.resolve(resource)))
                except BackupError as exc:
                    errors.append({"id": resource.id, "error": str(exc)})
                    self.events.emit("capture_version_failed", level="Error",
                                     resource_id=resource.id, status="Failed",
                                     code=type(exc).__name__)
            with ThreadPoolExecutor(max_workers=self.config.workers) as pool:
                pending: dict[Future[JsonObject], Resource] = {}
                remaining = iter(jobs)
                exhausted = False
                while pending or not exhausted:
                    while len(pending) < self.config.workers * 2 and not exhausted:
                        job = next(remaining, None)
                        if job is None:
                            exhausted = True
                            break
                        resource, api = job
                        pending[pool.submit(self._capture, resource, api, run_id)] = resource
                    if not pending:
                        break
                    finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in finished:
                        resource = pending.pop(future)
                        try:
                            entries.append(future.result())
                        except BackupError as exc:
                            errors.append({"id": resource.id, "error": str(exc)})
                            self.events.emit("capture_failed", level="Error",
                                             resource_id=resource.id, status="Failed",
                                             code=type(exc).__name__)
            manifest["resources"] = sorted(entries, key=lambda e: str(e["id"]).lower())
            captured = sum(e["status"] == "Captured" for e in entries)
            manifest.update({
                "finishedAt": utc_now(), "discoveredCount": len(resources),
                "capturedCount": captured, "excludedCount": len(entries) - captured,
                "status": "Incomplete" if failures or errors else "Captured",
            })
            self.events.emit("capture_finished", status=manifest["status"],
                             discovered=len(resources), captured=captured, failed=len(errors),
                             discoveryFailed=len(failures))
            self.archive.put(f"runs/{run_id}/manifest.json", encode_json(manifest))
            # The success marker requires both durable capture and accepted log ingestion.
            self.events.flush()
            if manifest["status"] == "Captured":
                self.archive.put(f"runs/{run_id}/COMPLETE.json", encode_json({
                    "runId": run_id, "manifestSha256": digest(encode_json(manifest)),
                    "completedAt": utc_now(), "logsIngestion": "Accepted",
                    "restoreStatus": "Unverified",
                }))
            return manifest
