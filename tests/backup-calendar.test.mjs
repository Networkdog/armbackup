import assert from "node:assert/strict";
import test from "node:test";
import { backupCalendarData } from "../src/armbackup/ui_static/backup-calendar.mjs";
import { calendarWeeks, dateKey, summarizeHistory, dayLabel } from "../src/armbackup/ui_static/change-calendar.mjs";
import { HistoryPanel } from "../src/armbackup/ui_static/history-panel.mjs";

function fixture() {
  const resource = { id: "/resource", name: "gateway", type: "agw", typeLabel: "Application Gateway", tags: { customer: "alpha" } };
  const snapshot = { resourceId: resource.id, complete: true, restoreSupported: true,
    comparison: { status: "same" }, raw: {} };
  return {
    workspace: { archiveLabel: "Azure Blob" }, resources: [resource], current: { "/resource": { status: "present" } },
    runs: [
      { id: "newer", capturedAt: "2026-11-04T00:00:00Z", status: "Captured", kind: "scheduled", snapshots: [snapshot] },
      { id: "older", capturedAt: "2026-11-03T15:10:00Z", status: "Captured", kind: "manual", snapshots: [snapshot] },
      { id: "failed", capturedAt: "2026-11-03T13:00:00Z", status: "Incomplete", kind: "manual", snapshots: [{ ...snapshot, complete: false }] },
      { id: "safety", capturedAt: "2026-11-03T14:00:00Z", status: "Captured", kind: "safety", snapshots: [snapshot] },
    ],
  };
}
const allowed = (row) => ({ allowed: row.snapshot.complete, reason: row.snapshot.complete ? "검토 후 승인" : "불완전" });

test("unchanged and initial backups remain selectable, with the exact source run and resource", () => {
  const data = backupCalendarData(fixture(), allowed, "2026-11-04T01:00:00Z");
  assert.equal(data.records.length, 4);
  assert.equal(data.records.filter((record) => record.restoreAllowed).length, 3);
  assert.equal(data.records.find((record) => record.runKind === "safety").label, "복원 전 안전 백업");
  const summary = summarizeHistory(data, "Asia/Seoul");
  const day = summary.get("2026-11-04");
  assert.equal(day.records.length, 2);
  assert.equal(day.changedResources, 0);
  const cell = calendarWeeks("2026-11-04", 13, summary, "backups").flatMap((column) => column.days)
    .find((item) => item.date === "2026-11-04");
  assert.equal(cell.value, 2);
  assert.match(dayLabel(cell, "backups"), /백업 자원 2건/);
  assert.deepEqual(day.records.map((record) => record.afterRunId), ["newer", "older"]);
  assert.equal(day.records[0].beforeRunId, "older");
  assert.equal(day.records[1].beforeRunId, "");
  assert.equal(data.records.find((record) => record.runKind === "safety").inspectAllowed, false);
});

test("timezone, resource type, customer and search consistently filter backup calendar entries", () => {
  const data = backupCalendarData(fixture(), allowed);
  assert.equal(dateKey(data.records.find((record) => record.afterRunId === "older").at, "UTC"), "2026-11-03");
  for (const filters of [{ customer: "beta" }, { type: "lb" }, { query: "not-found" }]) {
    const summaries = summarizeHistory(data, "Asia/Seoul", filters);
    assert.ok([...summaries.values()].every((day) => day.records.length === 0));
  }
  assert.equal(summarizeHistory(data, "Asia/Seoul", { query: "/RESOURCE" }).get("2026-11-04").records.length, 2);
});

test("incomplete backups and unavailable current resources never become executable", () => {
  const state = fixture();
  const data = backupCalendarData(state, () => ({ allowed: false, reason: "현재 조회 오류" }));
  assert.ok(data.records.every((record) => !record.restoreAllowed));
  assert.match(data.records.find((record) => record.afterRunId === "failed").restoreReason, /완료 표식/);
  assert.match(data.records.find((record) => record.afterRunId === "older").restoreReason, /현재 조회 오류/);
  assert.equal(data.warnings.length, 1);
});

test("undated corrupt runs are explicitly reported without breaking the valid backup browser", () => {
  const state = fixture();
  state.runs.push({ id: "corrupt", capturedAt: "", status: "IntegrityError", snapshots: [] });
  const data = backupCalendarData(state, allowed);
  assert.equal(data.records.length, 4);
  assert.ok(data.warnings.some((warning) => warning.includes("백업 시각 미확인")));
  state.resources = [];
  assert.throws(() => backupCalendarData(state, allowed), /리소스 정보/);
});

test("a chosen calendar record passes its historical source and restore/clone intent, ignoring disabled records", () => {
  const panel = Object.create(HistoryPanel.prototype), selected = [];
  panel.data = backupCalendarData(fixture(), allowed);
  panel.onRestore = (record, intent) => selected.push([record.afterRunId, record.resourceId, intent]);
  const record = panel.data.records.find((item) => item.afterRunId === "older");
  panel.click({ target: { closest: () => ({ disabled: false, dataset: { restoreBackup: record.id, restoreIntent: "restore" } }) } });
  panel.click({ target: { closest: () => ({ disabled: false, dataset: { restoreBackup: record.id, restoreIntent: "clone" } }) } });
  panel.click({ target: { closest: () => ({ disabled: true, dataset: { restoreBackup: record.id, restoreIntent: "restore" } }) } });
  const failed = panel.data.records.find((item) => item.afterRunId === "failed");
  panel.click({ target: { closest: () => ({ disabled: false, dataset: { restoreBackup: failed.id, restoreIntent: "restore" } }) } });
  assert.deepEqual(selected, [["older", "/resource", "restore"], ["older", "/resource", "clone"]]);
});

test("hover bar sits above the matrix, handles multiple intra-day backups, and renders diff-only backup vs current view with restore/clone buttons", () => {
  const state = fixture();
  state.runs[0].snapshots = [{
    ...state.runs[0].snapshots[0],
    comparison: {
      status: "warning",
      reason: "1개 속성 차이",
      diffs: [{ path: "properties.sku.capacity", before: 2, after: 4, beforePresent: true, afterPresent: true }],
      truncated: false,
    },
  }];
  const data = backupCalendarData(state, allowed, "2026-11-04T01:00:00Z");
  const dayRoot = { innerHTML: "" }, detailRoot = { replaceChildren() {} }, previewEl = { innerHTML: "" };
  const scroller = { scrollLeft: 0, scrollWidth: 320 };
  const panel = Object.create(HistoryPanel.prototype);
  Object.assign(panel, {
    data, onRestore: () => {}, fixedItem: true, timezone: "Asia/Seoul", weeks: 13, metric: "backups",
    filters: { customer: "", type: "", query: "" }, selectedDate: "2026-11-04", selectedRecordId: "",
    selectedRunId: "", activeAction: "", hoverDate: "", hoverRecordId: "", busy: false,
    root: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".history-day-root") return dayRoot;
        if (selector === ".history-detail-root") return detailRoot;
        if (selector === ".calendar-preview") return previewEl;
        if (selector === ".calendar-scroll") return scroller;
        return null;
      },
      querySelectorAll: () => [],
    },
  });
  panel.render();
  assert.ok(panel.root.innerHTML.indexOf('class="calendar-preview"') < panel.root.innerHTML.indexOf('class="calendar-scroll"'));
  const multiDayCell = panel.cells.find((cell) => cell.date === "2026-11-04");
  const hoverMarkup = panel.previewHtml(multiDayCell);
  assert.match(hoverMarkup, /하루 2회 백업/);
  assert.equal((hoverMarkup.match(/data-select-record=/g) || []).length, 2);
  assert.match(dayRoot.innerHTML, /선택한 백업 시점/);
  assert.match(dayRoot.innerHTML, /현재 시점/);
  assert.match(dayRoot.innerHTML, /properties\.sku\.capacity/);
  assert.match(dayRoot.innerHTML, /data-restore-intent="restore"[^>]*>복원<\/button>/);
  assert.match(dayRoot.innerHTML, /data-restore-intent="clone"[^>]*>복제<\/button>/);
  assert.doesNotMatch(dayRoot.innerHTML, /원본 비교|복원 검토/);
  const olderRecord = data.records.find((item) => item.afterRunId === "older");
  panel.selectRecord(olderRecord);
  assert.match(dayRoot.innerHTML, /Run older/);
});
