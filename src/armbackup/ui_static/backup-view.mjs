import { DAY_MS, dateKey, dateNumber, heatLevel, isMutation } from "./change-calendar.mjs";

export const BACKUP_STATUS = {
  healthy: { label: "최근 백업 완료", icon: "check" },
  failed: { label: "최근 백업 실패", icon: "alert" },
  overdue: { label: "24시간 이상 미백업", icon: "clock" },
  never: { label: "검증된 백업 없음", icon: "alert" },
  unknown: { label: "백업 상태 미확인", icon: "help" },
  excluded: { label: "백업 대상 제외", icon: "sliders" },
};

export function relativeTime(value, now = Date.now()) {
  if (!value) return "백업 없음";
  const at = Date.parse(value), reference = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(reference) || at > reference) return "시각 미확인";
  const seconds = Math.floor((reference - at) / 1000);
  if (seconds < 60) return "방금 전";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}일 전`;
  return `${Math.floor(seconds / 604800)}주 전`;
}

export function backupHealth(state, resourceId, now = Date.now()) {
  const id = resourceId.toLowerCase();
  const runs = [...state.runs].filter((run) => run.kind !== "safety").sort((a, b) =>
    (Date.parse(b.capturedAt) || 0) - (Date.parse(a.capturedAt) || 0));
  let latestSuccess = null;
  let latestAttempt = null;
  for (const run of runs) {
    const snapshot = run.snapshots.find((snapshot) => snapshot.resourceId.toLowerCase() === id);
    const attempt = run.resourceAttempts?.find((attempt) => attempt.resourceId.toLowerCase() === id);
    if (!latestAttempt && (snapshot || attempt)) latestAttempt = { run, snapshot, attempt };
    if (!latestSuccess && run.status === "Captured" && snapshot?.complete) latestSuccess = snapshot;
  }
  let status;
  const failedJob = (state.journal || []).filter((job) => job.status === "Failed"
    && ["backup", "bundle-backup"].includes(job.action)
    && job.backupResourceIds?.some((resourceId) => resourceId.toLowerCase() === id))
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
  if (failedJob && (!latestAttempt || Date.parse(failedJob.finishedAt) > Date.parse(latestAttempt.run.capturedAt))) status = "failed";
  else if (latestAttempt?.attempt?.status === "Excluded") status = "excluded";
  else if (latestAttempt && latestAttempt.run.status !== "Captured") status = "failed";
  else if (latestAttempt?.attempt?.status === "Failed") status = "failed";
  else if (!latestSuccess) status = state.historyLimited ? "unknown" : "never";
  else if (!Number.isFinite(Date.parse(latestSuccess.capturedAt)) || Date.parse(latestSuccess.capturedAt) > now) status = "unknown";
  else if (now - Date.parse(latestSuccess.capturedAt) >= DAY_MS) status = "overdue";
  else status = "healthy";
  return { status, label: BACKUP_STATUS[status].label, lastSuccessAt: latestSuccess?.capturedAt || "",
    lastAttemptAt: latestAttempt?.run.capturedAt || "", runId: latestAttempt?.run.id || "",
    red: ["failed", "overdue", "never"].includes(status) };
}

export function recentResourceDays(data, resourceId, now = Date.now(), timezone = "Asia/Seoul", { missingNow = false } = {}) {
  const end = dateNumber(dateKey(now, timezone)), id = resourceId.toLowerCase();
  const records = data?.records.filter((record) => record.resourceId.toLowerCase() === id) || [];
  return Array.from({ length: 10 }, (_, i) => {
    const date = new Date(end - (9 - i) * DAY_MS).toISOString().slice(0, 10);
    const items = records.filter((record) => dateKey(record.at, timezone) === date);
    const count = (kind) => items.filter((record) => record.kind === kind).length;
    const counts = { changed: count("changed"), added: count("inventory_added"), removed: count("inventory_removed"),
      unchanged: count("unchanged"), baseline: count("baseline"), unknown: count("unknown") };
    const deleted = missingNow && i === 9;
    const changes = items.filter(isMutation).length;
    const comparable = counts.changed + counts.unchanged > 0;
    const status = !data ? "loading" : counts.unknown ? "unknown" : counts.removed || deleted ? "removed"
      : counts.changed ? "changed" : counts.added ? "added" : comparable ? "unchanged"
        : items.length ? "baseline" : "unobserved";
    return { date, status, changes, counts, deleted, backedUp: items.length > 0, records: items };
  });
}

export const RECENT_DAY_LEGEND = [
  ["unobserved", "백업 없음"], ["baseline", "첫 백업"], ["unchanged", "변경 없음"],
  ["changed", "형상 변경 · 목록 추가"], ["unknown", "비교 미확인"], ["removed", "목록 제외 · 현재 부재"],
];

// 변경 이력 달력(history-panel)의 칸 색·무늬와 같은 클래스를 쓴다. 칸 수만 다르다.
export function recentCellClass(day) {
  if (day.status === "changed" || day.status === "added") return `heat-${Math.max(1, heatLevel(day.changes))}`;
  return { unchanged: "heat-0", baseline: "baseline", unknown: "partial", removed: "removed" }[day.status] || "unobserved";
}

export function recentDayLabel(day) {
  if (day.status === "loading") return `${day.date} · 이력 조회 중`;
  const parts = [];
  if (day.deleted) parts.push("현재 리소스 부재 확인(삭제됨)");
  if (!day.backedUp && !day.deleted) return `${day.date} · 백업 없음`;
  if (day.backedUp) parts.push("백업됨");
  const { counts } = day;
  if (counts.changed) parts.push(`변경 ${counts.changed}건`);
  if (counts.added) parts.push(`목록 추가 ${counts.added}건`);
  if (counts.removed) parts.push(`다음 백업 목록에서 제외 ${counts.removed}건(삭제 확인 아님)`);
  if (counts.unchanged && !counts.changed) parts.push("변경 없음");
  if (counts.baseline) parts.push("첫 관측");
  if (counts.unknown) parts.push("비교 미확인");
  return `${day.date} · ${parts.join(" · ")}`;
}

export function recentDaysHtml(days, { esc, cell }) {
  return days.map((day) => {
    const label = recentDayLabel(day);
    const classes = `day-cell recent-day day-${day.status} ${recentCellClass(day)}`;
    return cell(day, classes, esc(label));
  }).join("");
}

export function recentLegendHtml(esc = (value) => value) {
  const cell = (status, extra) => `<i class="day-cell recent-day day-${status} ${extra}" aria-hidden="true"></i>`;
  return `<div class="recent-legend" aria-label="변경 달력 범례">${RECENT_DAY_LEGEND.map(([status, label]) => status === "changed"
    ? `<span>적음 ${cell(status, "heat-1")}${[2, 3, 4].map((level) => `<i class="day-cell recent-day heat-${level}" aria-hidden="true"></i>`).join("")} 많음 ${esc(label)}</span>`
    : `<span>${cell(status, recentCellClass({ status, changes: 0 }))}${esc(label)}</span>`).join("")}</div>`;
}
