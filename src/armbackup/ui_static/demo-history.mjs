export function createDemoHistory(state, now = new Date()) {
  const records = [];
  const observations = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3);
  const daily = 86_400_000;
  for (let index = 0; index < 365; index++) {
    const time = end - (364 - index) * daily;
    const weekday = new Date(time).getUTCDay();
    if (index % 17 === 0) continue;
    const count = weekday === 2 || weekday === 4 ? 2 + index % 5
      : weekday === 1 || weekday === 3 || weekday === 5 ? index % 3 : index % 7 === 0 ? 1 : 0;
    const at = new Date(time).toISOString();
    const runId = `demo-history-${at.slice(0, 10)}`;
    observations.push({ runId, at, verified: index % 47 !== 0, scopeChanged: false });
    for (let item = 0; item < Math.max(1, count); item++) {
      const resource = state.resources[(index + item) % state.resources.length];
      const kind = index === 1 ? "baseline" : index % 47 === 0 ? "unknown" : count ? "changed" : "unchanged";
      records.push({
        id: `${runId}-${item}`, resourceId: resource.id, name: resource.name,
        resourceType: resource.type, typeLabel: resource.typeLabel,
        customers: [resource.groupId === "rg-dev" ? "customer-beta" : "customer-alpha"],
        at: new Date(time + item * 900_000).toISOString(),
        beforeAt: new Date(time - daily).toISOString(), beforeRunId: `demo-before-${index}-${item}`,
        afterRunId: runId, kind, inventoryAdded: false,
        status: kind === "changed" ? "warning" : kind === "unchanged" ? "same" : "unknown",
        propertyCount: kind === "changed" ? 1 : 0, truncated: false, paths: ["tags.owner"],
        reason: "명시적 예시 이력 · 실제 Azure 백업이 아님", observationGap: false,
      });
    }
  }
  return { records, observations, generatedAt: now.toISOString(), mode: "design-preview",
    source: "명시적 예시 데이터", warnings: [], verifiedRuns: observations.length,
    scopeChanges: 0, totalRuns: observations.length, historyLimited: false, runLimit: 500,
    timestampMeaning: "synthetic-demo-only" };
}

export function demoHistoryDetail(record) {
  return {
    ...record, beforeApiVersion: "예시", afterApiVersion: "예시", afterAt: record.at,
    comparison: {
      status: record.status, truncated: false,
      reason: record.kind === "unknown" ? "예시 비교 미확인" : record.kind === "baseline" ? "예시 첫 관측" : "예시 형상 비교",
      diffs: record.kind === "changed" ? [{ path: "tags.owner", before: "platform", after: "application",
        beforePresent: true, afterPresent: true }] : [],
    },
  };
}
