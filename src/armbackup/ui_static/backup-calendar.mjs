export function backupCalendarData(state, availability, generatedAt = new Date().toISOString(), compareFn = null) {
  const resources = new Map(state.resources.map((resource) => [resource.id.toLowerCase(), resource]));
  const records = [], observations = [], warnings = [];
  for (const run of state.runs) {
    if (!run.capturedAt || !Number.isFinite(Date.parse(run.capturedAt))) {
      warnings.push(`${run.id} · 백업 시각 미확인 · 날짜 탐색 불가`);
      continue;
    }
    observations.push({ runId: run.id, at: run.capturedAt, verified: run.status === "Captured", scopeChanged: false });
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
        runKind: run.kind, kind: "unchanged", propertyCount: Array.isArray(comparison.diffs) ? comparison.diffs.length : 0,
        truncated: Boolean(comparison.truncated),
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
    const run = state.runs.find((item) => item.id === record.afterRunId);
    const snapshot = run.snapshots.find((item) => item.resourceId.toLowerCase() === record.resourceId.toLowerCase());
    record.inspectAllowed = run.status === "Captured" && snapshot.complete && !snapshot.redacted && run.kind !== "safety";
    if (!record.inspectAllowed) continue;
    const before = previous.get(record.resourceId.toLowerCase());
    record.beforeRunId = before?.afterRunId || "";
    record.beforeAt = before?.capturedAt || "";
    previous.set(record.resourceId.toLowerCase(), record);
  }
  return { records, observations, warnings, generatedAt, source: state.workspace?.archiveLabel || "예시 저장소",
    historyLimited: state.historyLimited || false, runLimit: state.runs.length };
}
