export const DAY_MS = 86_400_000;
export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
export const HISTORY_KINDS = {
  changed: "형상 변경", inventory_added: "목록 추가", inventory_removed: "목록 제외",
  baseline: "첫 관측", unchanged: "변화 없음", unknown: "비교 미확인",
};
export const CALENDAR_FILLS = ["#d7efe7", "#bfe6d9", "#a3dac8", "#84ccb5", "#66bda2"];

export function isManualRunKind(runKind) {
  return runKind === "manual" || runKind === "bundle";
}

export function backupOriginFromRecords(records = []) {
  let manual = 0, auto = 0;
  for (const record of records) {
    if (isManualRunKind(record?.runKind)) manual++;
    else if (record?.runKind === "scheduled") auto++;
  }
  if (manual > 0 && auto > 0) return "mixed";
  if (manual > 0) return "manual";
  if (auto > 0) return "auto";
  return "";
}

export function backupOriginClass(origin) {
  if (origin === "mixed") return "backup-manual backup-mixed";
  if (origin === "manual") return "backup-manual";
  if (origin === "auto") return "backup-auto";
  return "";
}

export function backupOriginLabel(origin) {
  if (origin === "mixed") return "자동·수동 백업";
  if (origin === "manual") return "수동 백업";
  if (origin === "auto") return "자동 백업";
  return "";
}

export function pipCount(count) {
  if (!Number.isFinite(count) || count < 1) return 0;
  return Math.min(6, Math.trunc(count));
}

export function dayCellInnerHtml(count, { deleted = false } = {}) {
  const pips = pipCount(count);
  if (pips > 0) {
    const plus = Math.trunc(count) > 6 ? " pips-plus" : "";
    return `<span class="day-pips${plus}" data-pips="${pips}" aria-hidden="true">${'<i class="day-pip"></i>'.repeat(pips)}</span>`;
  }
  if (deleted) return '<span class="day-mark" aria-hidden="true">×</span>';
  return "";
}

export function dateKey(value, timezone = "Asia/Seoul") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function dateNumber(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("날짜 형식이 올바르지 않습니다.");
  const value = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== key) throw new Error("존재하지 않는 날짜입니다.");
  return value;
}

export function isMutation(record) {
  return ["changed", "inventory_added", "inventory_removed"].includes(record.kind) || record.inventoryAdded === true;
}

export function matchesHistory(record, filters = {}) {
  if (filters.customer && !record.customers.includes(filters.customer)) return false;
  if (filters.type && filters.type !== record.resourceType) return false;
  if (filters.query && !`${record.name} ${record.resourceId} ${record.typeLabel} ${record.customers.join(" ")}`.toLowerCase().includes(filters.query.trim().toLowerCase())) return false;
  return true;
}

export function summarizeHistory(data, timezone = "Asia/Seoul", filters = {}) {
  const days = new Map();
  const day = (key) => {
    if (!days.has(key)) days.set(key, { date: key, records: [], observations: [], changedResources: new Set(),
      occurrences: 0, properties: 0, comparedResources: new Set(), firstResources: new Set(), unknownResources: new Set(), inventory: 0, truncated: false });
    return days.get(key);
  };
  for (const observation of data.observations) {
    const target = day(dateKey(observation.at, timezone));
    target.observations.push(observation);
  }
  for (const record of data.records) {
    if (!matchesHistory(record, filters)) continue;
    const target = day(dateKey(record.at, timezone));
    target.records.push(record);
    if (isMutation(record)) {
      target.changedResources.add(record.resourceId.toLowerCase());
      target.occurrences++;
      target.properties += record.propertyCount;
      target.inventory += Number(record.kind.startsWith("inventory_") || record.inventoryAdded);
      target.truncated ||= record.truncated;
    }
    if (["changed", "unchanged"].includes(record.kind)) target.comparedResources.add(record.resourceId.toLowerCase());
    if (record.kind === "baseline") target.firstResources.add(record.resourceId.toLowerCase());
    if (record.kind === "unknown") target.unknownResources.add(record.resourceId.toLowerCase());
  }
  const filtered = Boolean(filters.customer || filters.type || filters.query?.trim());
  return new Map([...days].map(([key, target]) => {
    const failed = target.observations.filter((observation) => !observation.verified).length;
    const known = target.comparedResources.size > 0 || target.occurrences > 0;
    const observed = target.records.length > 0 || (!filtered && target.observations.length > 0);
    const state = !observed ? "unobserved" : failed || target.unknownResources.size ? "partial"
      : known ? "observed" : "baseline";
    const sortedRecords = target.records.sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name, "en"));
    return [key, {
      ...target, state, changedResources: target.changedResources.size,
      comparedResources: target.comparedResources.size, firstResources: target.firstResources.size,
      unknownResources: target.unknownResources.size, failedRuns: failed,
      backupOrigin: backupOriginFromRecords(sortedRecords),
      records: sortedRecords,
    }];
  }));
}

export function heatLevel(value) {
  if (value <= 0) return 0;
  return value === 1 ? 1 : value <= 3 ? 2 : value <= 7 ? 3 : 4;
}

export function calendarWeeks(endDate, count = 53, summaries = new Map(), metric = "resources", options = {}) {
  if (![13, 26, 53].includes(count)) throw new Error("지원하지 않는 달력 기간입니다.");
  const { existedFromDate = "", missingNow = false, absentDates = null } = options || {};
  const end = dateNumber(endDate);
  const weekday = (new Date(end).getUTCDay() + 6) % 7;
  const start = end - weekday * DAY_MS - (count - 1) * 7 * DAY_MS;
  return Array.from({ length: count }, (_, column) => ({
    column,
    days: Array.from({ length: 7 }, (_, row) => {
      const time = start + (column * 7 + row) * DAY_MS;
      const date = new Date(time).toISOString().slice(0, 10);
      const future = time > end;
      const summary = summaries.get(date);
      const value = metric === "backups" ? summary?.records.length || 0
        : metric === "properties" ? summary?.properties || 0 : summary?.changedResources || 0;
      let state = summary?.state || "unobserved";
      let absentReason = "";
      if (!future && state === "unobserved") {
        if (missingNow && date === endDate) {
          state = "removed";
        } else if (existedFromDate && date < existedFromDate) {
          state = "absent";
          absentReason = "before-creation";
        } else if (absentDates?.has?.(date)) {
          state = "absent";
          absentReason = "confirmed-absent";
        }
      }
      return {
        date, row, column, index: column * 7 + row, future,
        state, absentReason, existedFromDate: absentReason === "before-creation" ? existedFromDate : "",
        value, level: heatLevel(value), summary,
      };
    }),
  }));
}

export function dayLabel(cell, metric = "resources") {
  if (cell.future) return `${cell.date} · 아직 관측할 수 없는 미래 날짜`;
  if (cell.state === "absent") {
    return `${cell.date} ${WEEKDAYS[cell.row]}요일 · 리소스 없음${cell.existedFromDate ? ` (생성일 ${cell.existedFromDate} 이전)` : " (부재 확인)"}`;
  }
  if (cell.state === "removed" && !(cell.summary?.records?.length)) {
    return `${cell.date} ${WEEKDAYS[cell.row]}요일 · 현재 리소스 부재 확인(삭제됨)`;
  }
  const summary = cell.summary;
  if (metric === "backups") {
    return `${cell.date} ${WEEKDAYS[cell.row]}요일 · 백업 자원 ${summary?.records.length || 0}건${summary?.failedRuns ? ` · 미검증 백업 ${summary.failedRuns}개` : ""}`;
  }
  if (!summary || cell.state === "unobserved") return `${cell.date} ${WEEKDAYS[cell.row]}요일 · 백업 관측 없음`;
  const count = metric === "properties" ? `${summary.properties}${summary.truncated ? "+" : ""}개 속성 변경` : `${summary.changedResources}개 자원 변경`;
  const coverage = cell.state === "baseline" ? "첫 관측만 있어 이전 형상과 비교하지 못함"
    : cell.state === "partial" ? "일부 비교/백업 미확인" : "백업 간 비교";
  return `${cell.date} ${WEEKDAYS[cell.row]}요일 · ${count} · 비교 ${summary.comparedResources}개 · ${coverage}`;
}

export function navigateCalendar(index, key, weeks, control = false) {
  const flat = weeks.flatMap((week) => week.days);
  const available = flat.filter((cell) => !cell.future);
  let candidate = index;
  if (key === "ArrowUp") candidate--;
  else if (key === "ArrowDown") candidate++;
  else if (key === "ArrowLeft") candidate -= 7;
  else if (key === "ArrowRight") candidate += 7;
  else if (key === "Home") candidate = control ? available[0].index : Math.floor(index / 7) * 7;
  else if (key === "End") candidate = control ? available.at(-1).index : Math.floor(index / 7) * 7 + 6;
  else return null;
  candidate = Math.min(available.at(-1).index, Math.max(available[0].index, candidate));
  return flat[candidate]?.future ? available.at(-1).index : candidate;
}
