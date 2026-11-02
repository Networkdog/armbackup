from __future__ import annotations

from datetime import UTC, datetime

from armbackup.comparison import TYPE_LABELS, compare, configuration
from armbackup.contracts import BackupError, JsonObject, digest, encode_json, object_value
from armbackup.resource_profiles import snapshot_tags


def captured_time(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise BackupError(f"{label}: capture timestamp is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BackupError(f"{label}: invalid capture timestamp") from exc
    if parsed.tzinfo is None:
        raise BackupError(f"{label}: capture timestamp requires a timezone")
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def selection_key(manifest: JsonObject) -> str | None:
    selection = manifest.get("selection")
    if not isinstance(selection, dict) or not all(
        key in selection for key in ("scope", "scopeIds", "types", "tags")
    ):
        return None
    return digest(encode_json({key: selection[key] for key in ("scope", "scopeIds", "types", "tags")}))


def descriptor(envelope: JsonObject) -> JsonObject:
    rid, kind = envelope["resourceId"], envelope["resourceType"]
    raw = object_value(envelope.get("raw"), "history snapshot")
    tags = snapshot_tags(envelope)
    return {"resourceId": rid, "name": str(raw.get("name") or rid.rsplit("/", 1)[-1]),
            "resourceType": kind, "typeLabel": TYPE_LABELS.get(kind, kind),
            "customers": [tags["customer"]] if isinstance(tags.get("customer"), str) else []}


def history_records(runs: list[JsonObject]) -> JsonObject:
    ordered = sorted(runs, key=lambda run: captured_time(
        run["manifest"].get("finishedAt", run["manifest"].get("startedAt")), "history run",
    ))
    records: list[JsonObject] = []
    observations: list[JsonObject] = []
    warnings: list[str] = []
    last: dict[str, tuple[JsonObject, str]] = {}
    previous: JsonObject | None = None
    verified_runs = 0
    scope_changes = 0
    for run in ordered:
        manifest = run["manifest"]
        if manifest.get("kind") == "safety":
            continue
        run_id = str(manifest["runId"])
        run_at = captured_time(manifest.get("finishedAt", manifest.get("startedAt")), "history run")
        if not run.get("verified"):
            warnings.append(f"{run_id}: {run.get('error') or 'backup completion/integrity unverified'}")
            observations.append({"runId": run_id, "at": run_at, "verified": False,
                                 "scopeChanged": False})
            previous = None
            continue
        verified_runs += 1
        snapshots = {str(item["resourceId"]).lower(): item for item in run["envelopes"]}
        current_selection = selection_key(manifest)
        comparable_inventory = (previous is not None and current_selection is not None
                                and current_selection == selection_key(previous["manifest"]))
        changed_scope = previous is not None and not comparable_inventory
        if changed_scope:
            scope_changes += 1
        observations.append({"runId": run_id, "at": run_at, "verified": True,
                             "scopeChanged": changed_scope})
        prior_inventory = ({str(item["resourceId"]).lower(): item for item in previous["envelopes"]}
                           if previous is not None else {})
        for rid, envelope in snapshots.items():
            meta = descriptor(envelope)
            at = captured_time(envelope.get("capturedAt"), "history snapshot")
            old = last.get(rid)
            before_run = old[1] if old else ""
            before_at = captured_time(old[0].get("capturedAt"), "previous snapshot") if old else ""
            result: JsonObject = {"status": "unknown", "diffs": [], "truncated": False}
            valid_current = True
            try:
                configuration(envelope["raw"], envelope["resourceType"])
                if envelope["raw"].get("properties", {}).get("provisioningState") not in {None, "Succeeded"}:
                    raise BackupError("History snapshot captured unstable provisioning")
            except BackupError as exc:
                valid_current = False
                result["reason"] = str(exc)
            if valid_current and old:
                result = compare(old[0], {"status": "present", "raw": envelope["raw"],
                                         "apiVersion": envelope["captureApiVersion"]},
                                 envelope["resourceType"], complete=True)
            kind = "baseline" if valid_current and not old else "unknown"
            if old:
                kind = "unchanged" if result["status"] == "same" else "unknown" if result["status"] == "unknown" else "changed"
                meta["customers"] = sorted(set(meta["customers"]) | set(descriptor(old[0])["customers"]))
            added = comparable_inventory and rid not in prior_inventory
            if kind == "baseline" and added:
                kind = "inventory_added"
            if valid_current:
                last[rid] = (envelope, run_id)
            records.append({
                **meta, "id": digest(encode_json([run_id, rid, kind]))[:24],
                "at": at, "beforeAt": before_at, "beforeRunId": before_run, "afterRunId": run_id,
                "kind": kind, "inventoryAdded": bool(added), "status": result["status"],
                "propertyCount": len(result["diffs"]), "truncated": result["truncated"],
                "paths": [item["path"] for item in result["diffs"][:3]],
                "reason": result.get("reason", "첫 검증된 형상 관측" if kind == "baseline" else ""),
                "observationGap": bool(old and old[1] != (previous or {}).get("manifest", {}).get("runId")),
            })
        if comparable_inventory and previous is not None:
            for rid in sorted(prior_inventory.keys() - snapshots.keys()):
                envelope = prior_inventory[rid]
                records.append({
                    **descriptor(envelope),
                    "id": digest(encode_json([run_id, rid, "inventory_removed"]))[:24],
                    "at": run_at, "beforeAt": captured_time(envelope.get("capturedAt"), "inventory snapshot"),
                    "beforeRunId": previous["manifest"]["runId"], "afterRunId": run_id,
                    "kind": "inventory_removed", "inventoryAdded": False,
                    "status": "unknown", "propertyCount": 0, "truncated": False, "paths": [],
                    "reason": "같은 대상 정책의 이후 백업 목록에 없습니다. 리소스 삭제를 확인한 기록은 아닙니다.",
                    "observationGap": False,
                })
        previous = run
    return {"records": records, "observations": observations, "warnings": warnings,
            "verifiedRuns": verified_runs, "scopeChanges": scope_changes,
            "timestampMeaning": "later-backup-observation-not-operation-time"}


def history_detail(before: JsonObject | None, after: JsonObject, resource_id: str) -> JsonObject:
    if not after.get("verified") or (before is not None and not before.get("verified")):
        raise BackupError("History details require verified backup completion and integrity")
    if after["manifest"].get("kind") == "safety" or (before and before["manifest"].get("kind") == "safety"):
        raise BackupError("Safety backups are not normal change-history comparison sources")
    rid = resource_id.lower()
    old = next((item for item in (before or {}).get("envelopes", [])
                if str(item["resourceId"]).lower() == rid), None)
    new = next((item for item in after["envelopes"] if str(item["resourceId"]).lower() == rid), None)
    if old is None and new is None:
        raise BackupError("Resource is not in either history source")
    if new is not None and old is not None:
        comparison = compare(old, {"status": "present", "raw": new["raw"],
                                   "apiVersion": new["captureApiVersion"]},
                             new["resourceType"], complete=True)
    else:
        comparison = {"status": "unknown", "diffs": [], "truncated": False,
                      "reason": "첫 형상 관측 또는 백업 목록 변동입니다. 이 정보만으로 생성/삭제를 확정하지 않습니다."}
    envelope = new if new is not None else old
    if envelope is None:
        raise BackupError("History source is missing")
    return {**descriptor(envelope), "beforeRunId": (before or {}).get("manifest", {}).get("runId", ""),
            "afterRunId": after["manifest"]["runId"],
            "beforeAt": old.get("capturedAt", "") if old else "",
            "afterAt": new.get("capturedAt", after["manifest"].get("finishedAt", "")) if new else after["manifest"].get("finishedAt", ""),
            "beforeApiVersion": old.get("captureApiVersion", "") if old else "",
            "afterApiVersion": new.get("captureApiVersion", "") if new else "",
            "comparison": comparison, "timestampMeaning": "backup-observation"}
