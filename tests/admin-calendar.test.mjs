import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adminHtml, purgeReady, scheduleDirty, validTime } from "../src/armbackup/ui_static/admin-panel.mjs";
import {
  RECENT_DAY_LEGEND, recentDayLabel, recentDaysHtml, recentLegendHtml, recentResourceDays,
} from "../src/armbackup/ui_static/backup-view.mjs";

const now = Date.parse("2026-11-01T03:00:00Z");
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const helpers = { esc, icon: () => "", date: (value) => value, timezone: "KST", busy: false, loading: false, error: "" };
const asset = (name) => readFileSync(new URL(`../src/armbackup/ui_static/${name}`, import.meta.url), "utf8");

test("each day cell separates backup, change, addition, removal, unknown and missing-backup states", () => {
  const record = (at, kind) => ({ resourceId: "/r", at, kind, propertyCount: 0 });
  const data = { records: [
    record("2026-11-01T02:00:00Z", "inventory_removed"),
    record("2026-10-31T02:00:00Z", "changed"), record("2026-10-31T03:00:00Z", "changed"),
    record("2026-10-30T02:00:00Z", "inventory_added"),
    record("2026-10-29T02:00:00Z", "unchanged"),
    record("2026-10-28T02:00:00Z", "baseline"),
    record("2026-10-27T02:00:00Z", "unknown"),
  ] };
  const days = recentResourceDays(data, "/R", now);
  const status = Object.fromEntries(days.map((day) => [day.date, day.status]));
  assert.deepEqual(status, {
    "2026-10-23": "unobserved", "2026-10-24": "unobserved", "2026-10-25": "unobserved", "2026-10-26": "unobserved",
    "2026-10-27": "unknown", "2026-10-28": "baseline", "2026-10-29": "unchanged", "2026-10-30": "added",
    "2026-10-31": "changed", "2026-11-01": "removed",
  });
  assert.equal(days[8].counts.changed, 2);
  assert.equal(days[0].backedUp, false);
  assert.equal(days[6].backedUp, true);
});

test("a confirmed-missing resource marks only today as deleted, even without a backup that day", () => {
  const days = recentResourceDays({ records: [] }, "/r", now, "Asia/Seoul", { missingNow: true });
  assert.equal(days[9].status, "removed");
  assert.equal(days[9].deleted, true);
  assert.equal(days.slice(0, 9).every((day) => !day.deleted), true);
  assert.match(recentDayLabel(days[9]), /삭제됨/);
  assert.match(recentDayLabel(days[0]), /백업 없음/);
});

test("labels state backup and change facts without calling a missing list entry a confirmed deletion", () => {
  const days = recentResourceDays({ records: [
    { resourceId: "/r", at: "2026-11-01T02:00:00Z", kind: "inventory_removed" },
    { resourceId: "/r", at: "2026-10-31T02:00:00Z", kind: "changed" },
  ] }, "/r", now);
  assert.match(recentDayLabel(days[8]), /백업됨 · 변경 1건/);
  assert.match(recentDayLabel(days[9]), /목록에서 제외 1건\(삭제 확인 아님\)/);
});

test("cells and legend share the same state classes and stay escaped", () => {
  const days = recentResourceDays(null, "/r", now);
  const html = recentDaysHtml(days, { esc, cell: (day, classes, label) => `<i class="${classes}" title="${label}"></i>` });
  assert.equal((html.match(/day-loading/g) || []).length, 10);
  const legend = recentLegendHtml(esc);
  for (const [status] of RECENT_DAY_LEGEND) assert.ok(legend.includes(`day-${status}`));
  for (const status of ["unchanged", "changed", "added", "removed", "baseline", "unknown"]) {
    assert.match(asset("styles.css"), new RegExp(`\\.recent-day\\.day-${status}\\b`));
  }
});

test("schedule form validates 24-hour minutes and only enables saving when it differs", () => {
  assert.ok(validTime("00:00") && validTime("23:59"));
  for (const value of ["24:00", "2:30", "12:60", "", undefined]) assert.equal(validTime(value), false);
  const admin = { schedule: { schedule: { time: "02:00", enabled: true } } };
  assert.equal(scheduleDirty(admin, { time: "02:00", enabled: true }), false);
  assert.equal(scheduleDirty(admin, { time: "03:00", enabled: true }), true);
  assert.equal(scheduleDirty(admin, { time: "02:00", enabled: false }), true);
});

test("purge stays disabled until the scope value and the phrase are both typed exactly", () => {
  const admin = {
    schedule: { schedule: { time: "02:00", enabled: true }, today: "waiting", nextRunAt: "2026-11-02T17:00:00Z", last: null, retryMinutes: 15, maxAttempts: 3, catchUpHours: 3 },
    runnerActive: true, storage: { account: "https://sa.blob.core.windows.net", container: "armbackup" },
    purge: { confirmGroup: "sub-id", phrase: "모든 백업 삭제" },
  };
  assert.equal(purgeReady(admin, { confirmGroup: "sub-id", confirmPhrase: "모든 백업" }), false);
  assert.equal(purgeReady(admin, { confirmGroup: "SUB-ID", confirmPhrase: "모든 백업 삭제" }), false);
  assert.equal(purgeReady(admin, { confirmGroup: "sub-id", confirmPhrase: "모든 백업 삭제" }), true);
  const form = { time: "02:00", enabled: true, confirmGroup: "", confirmPhrase: "" };
  const html = adminHtml(admin, form, helpers);
  assert.match(html, /data-action="admin-purge" disabled/);
  assert.match(html, /data-action="admin-save-schedule" disabled/);
  assert.ok(!html.includes("예약 실행기가 꺼져"));
  const off = adminHtml({ ...admin, runnerActive: false }, form, helpers);
  assert.ok(off.includes("예약 실행기가 꺼져"));
  const ready = adminHtml(admin, { ...form, confirmGroup: "sub-id", confirmPhrase: "모든 백업 삭제", time: "03:10" }, helpers);
  assert.ok(!/data-action="admin-purge" disabled/.test(ready));
  assert.ok(!/data-action="admin-save-schedule" disabled/.test(ready));
});

test("admin page shows load errors with a retry and escapes server text", () => {
  const html = adminHtml(null, {}, { ...helpers, error: "<script>x</script>" });
  assert.ok(html.includes("&lt;script&gt;") && html.includes('data-action="admin-reload"'));
});

test("navigation drops the relations workbench, renames restore and adds an admin menu", () => {
  const index = asset("index.html"), live = asset("live-app.mjs");
  assert.ok(!index.includes('href="#relations"') && !index.includes("자원·관계 작업대"));
  assert.match(index, /href="#restore"[^>]*>[\s\S]*?<span>복원 복제<\/span>/);
  assert.match(index, /href="#admin" data-page="admin" class="live-only"/);
  assert.ok(!live.includes("자원·관계 작업대") && !live.includes("relations: renderRelations"));
  assert.match(live, /restore: "복원 복제"/);
  assert.match(live, /admin: "관리자"/);
});
