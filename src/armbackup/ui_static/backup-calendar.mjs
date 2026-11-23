function countBodyDiffs(before, after, limit = 201) {
  let total = 0;
  function visit(left, right) {
    if (total >= limit || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let i = 0; i < length && total < limit; i++) {
        if (i >= left.length || i >= right.length) total++;
        else visit(left[i], right[i]);
      }
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        if (total >= limit) return;
        const inLeft = Object.hasOwn(left, key), inRight = Object.hasOwn(right, key);
        if (!inLeft || !inRight) total++;
        else visit(left[key], right[key]);
      }
      return;
    }
    total++;
  }
  visit(before, after);
  return total;
}

export function backupCalendarData(
  state,
  availability,
  generatedAt = new Date().toISOString(),
  compareFn = null,
  changeHistory = null,
) {
  const resources = new Map(state.resources.map((resource) => [resource.id.toLowerCase(), resource]));
  const historySource = changeHistory || state.changeHistory || null;
  const historyByKey = new Map();
  if (Array.isArray(historySource?.records)) {
    for (const item of historySource.records) {
      if (item.kind === "inventory_removed" || !item.afterRunId || !item.resourceId) continue;
      historyByKey.set(`${item.afterRunId}\0${item.resourceId.toLowerCase()}`, item);
    }
  }
  const records = [], observations = [], warnings = [];
  for (const run of state.runs) {
    if (!run.capturedAt || !Number.isFinite(Date.parse(run.capturedAt))) {
      warnings.push(`${run.id} · 백업 시각 미확인 · 날짜 탐색 불가`);
      continue;
    }
    observations.push({ runId: run.id, at: run.capturedAt, runKind: run.kind, verified: run.status === "Captured", scopeChanged: false });
    if (run.status !== "Captured") warnings.push(`${run.id} · ${run.status}`);
    for (const snapshot of run.snapshots) {
      const resource = resources.get(snapshot.resourceId.toLowerCase());
      if (!resource) throw new Error("백업의 리소스 정보를 찾지 못했습니다. 다시 조회해 주세요.");
      const observation = state.current?.[snapshot.resourceId.toLowerCase()] || null;
      const comparison = snapshot.comparison
        || (typeof compareFn === "function" ? compareFn(snapshot, observation, resource.type, run.status)
          : { status: "unknown", reason: "현재 시점 비교 정보가 없습니다.", diffs: [], truncated: false });
      const row = { resource, snapshot, observation, ...comparison };
      const eligible = run.status === "Captured" ? availability(row)
        : { allowed: false, reason: "완료 표식·무결성을 검증하지 못한 백업입니다." };
      const cloneAllowed = eligible.cloneAllowed ?? eligible.allowed;
      const cloneReason = eligible.cloneReason ?? eligible.reason ?? "";
      records.push({
        id: JSON.stringify([run.id, snapshot.resourceId.toLowerCase()]),
        resourceId: resource.id, resourceType: resource.type, typeLabel: resource.typeLabel,
        name: resource.name, customers: [resource.tags?.customer || snapshot.raw?.tags?.customer].filter(Boolean),
        at: run.capturedAt, capturedAt: snapshot.capturedAt || run.capturedAt, afterRunId: run.id,
        apiVersion: snapshot.apiVersion || resource.apiVersion || "",
        complete: run.status === "Captured" && Boolean(snapshot.complete),
        runStatus: run.status,
        label: run.label || ({ scheduled: "일일 백업", manual: "수동 백업", bundle: "묶음 백업", safety: "복원 전 안전 백업" })[run.kind] || "백업",
        runKind: run.kind, kind: "unchanged", propertyCount: 0,
        truncated: false,
        restoreAllowed: eligible.allowed, restoreReason: eligible.reason || "",
        cloneAllowed, cloneReason,
        currentComparison: {
          status: comparison.status || "unknown",
          reason: comparison.reason || "",
          diffs: Array.isArray(comparison.diffs) ? comparison.diffs : [],
          truncated: Boolean(comparison.truncated),
        },
        currentObservation: observation ? {
          status: observation.status || "unknown",
          confirmed: Boolean(observation.confirmed),
          observedAt: observation.observedAt || "",
          apiVersion: observation.apiVersion || "",
          actor: observation.actor || null,
          code: observation.code || "",
          provisioningState: observation.provisioningState || "",
          warnings: Array.isArray(observation.warnings) ? observation.warnings : [],
        } : null,
      });
    }
  }
  const previous = new Map();
  for (const record of [...records].sort((a, b) => a.at.localeCompare(b.at) || a.afterRunId.localeCompare(b.afterRunId))) {
    const rid = record.resourceId.toLowerCase();
    const run = state.runs.find((item) => item.id === record.afterRunId);
    const snapshot = run.snapshots.find((item) => item.resourceId.toLowerCase() === rid);
    record.inspectAllowed = run.status === "Captured" && Boolean(snapshot.complete) && !snapshot.redacted && run.kind !== "safety";
    if (!record.inspectAllowed) {
      if (run.kind !== "safety") record.kind = "unknown";
      continue;
    }
    const prev = previous.get(rid);
    record.beforeRunId = prev?.record.afterRunId || "";
    record.beforeAt = prev?.record.capturedAt || "";
    const historyMatch = historyByKey.get(`${record.afterRunId}\0${rid}`);
    if (historyMatch) {
      record.kind = historyMatch.kind;
      record.propertyCount = historyMatch.propertyCount || 0;
      record.truncated = Boolean(historyMatch.truncated);
    } else if (!prev) {
      record.kind = "baseline";
      record.propertyCount = 0;
      record.truncated = false;
    } else if (
      (prev.snapshot.apiVersion || "") !== (snapshot.apiVersion || "")
      || !prev.snapshot.raw || !snapshot.raw
      || typeof prev.snapshot.raw !== "object" || typeof snapshot.raw !== "object"
    ) {
      record.kind = "unknown";
      record.propertyCount = 0;
      record.truncated = false;
    } else if (typeof compareFn === "function") {
      const stepComp = compareFn(
        prev.snapshot,
        { status: "present", apiVersion: snapshot.apiVersion, raw: snapshot.raw },
        record.resourceType,
        "Captured",
      );
      if (stepComp.status === "unknown") {
        record.kind = "unknown";
        record.propertyCount = 0;
        record.truncated = false;
      } else if (Array.isArray(stepComp.diffs) && stepComp.diffs.length > 0) {
        record.kind = "changed";
        record.propertyCount = stepComp.diffs.length;
        record.truncated = Boolean(stepComp.truncated);
      } else {
        record.kind = "unchanged";
        record.propertyCount = 0;
        record.truncated = false;
      }
    } else {
      const diffCount = countBodyDiffs(prev.snapshot.raw, snapshot.raw);
      record.kind = diffCount > 0 ? "changed" : "unchanged";
      record.propertyCount = Math.min(diffCount, 200);
      record.truncated = diffCount > 200;
    }
    previous.set(rid, { record, snapshot });
  }
  const resourcesMeta = {};
  for (const [rid, resource] of resources.entries()) {
    const currentObs = state.current?.[rid] || null;
    const createdAt = resource.createdAt || currentObs?.raw?.createdTime || currentObs?.raw?.systemData?.createdAt || "";
    const missingNow = Boolean(currentObs?.status === "missing" && currentObs.confirmed === true);
    const absentTimestamps = state.runs.flatMap((run) => (run.absences || [])
      .filter((entry) => entry.resourceId?.toLowerCase() === rid && entry.status === "ConfirmedAbsent")
      .map((entry) => entry.observedAt)).filter(Boolean);
    resourcesMeta[rid] = { createdAt, missingNow, absentTimestamps };
  }
  return { records, observations, warnings, generatedAt, resourcesMeta, source: state.workspace?.archiveLabel || "예시 저장소",
    historyLimited: state.historyLimited || false, runLimit: state.runs.length };
}
