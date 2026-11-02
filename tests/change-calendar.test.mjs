import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  dateKey, dateNumber, calendarWeeks, summarizeHistory, dayLabel,
  heatLevel, navigateCalendar, CALENDAR_FILLS, matchesHistory,
} from "../src/armbackup/ui_static/change-calendar.mjs";
import { createDemoState } from "../src/armbackup/ui_static/demo-data.mjs";
import { createDemoHistory, demoHistoryDetail } from "../src/armbackup/ui_static/demo-history.mjs";

function record(kind, at, id = "resource-a", properties = 1) {
  return { kind, at, id: `${id}-${at}`, resourceId: id, name: id, resourceType: "nsg",
    typeLabel: "NSG", customers: ["alpha"], inventoryAdded: false,
    propertyCount: properties, truncated: false };
}
function data(records = [], observations = []) {
  return { records, observations };
}

test("calendar is exactly seven Monday-to-Sunday rows in weekly columns", () => {
  const weeks = calendarWeeks("2026-10-31", 53);
  assert.equal(weeks.length, 53);
  assert.ok(weeks.every((week) => week.days.length === 7));
  assert.ok(weeks.every((week) => new Date(`${week.days[0].date}T00:00:00Z`).getUTCDay() === 1));
  assert.equal(weeks.at(-1).days[5].date, "2026-10-31");
  assert.equal(weeks.at(-1).days[6].future, true);
});

test("year/month boundaries and leap day are not omitted or duplicated", () => {
  const cells = calendarWeeks("2024-03-01", 53).flatMap((week) => week.days);
  assert.equal(cells.filter((cell) => cell.date === "2024-02-29").length, 1);
  assert.equal(cells.filter((cell) => cell.date === "2024-01-01").length, 1);
  assert.equal(new Set(cells.map((cell) => cell.date)).size, 371);
  assert.throws(() => dateNumber("2026-02-29"));
  assert.throws(() => calendarWeeks("2026-10-31", 52));
});

test("KST and UTC group the same observation into the correct different dates", () => {
  const at = "2026-10-30T16:30:00Z";
  assert.equal(dateKey(at, "UTC"), "2026-10-30");
  assert.equal(dateKey(at, "Asia/Seoul"), "2026-10-31");
  const values = data([record("changed", at)]);
  assert.ok(summarizeHistory(values, "Asia/Seoul").has("2026-10-31"));
  assert.ok(summarizeHistory(values, "UTC").has("2026-10-30"));
});

test("changed resources are unique per day while occurrences and property changes retain repeats", () => {
  const summaries = summarizeHistory(data([
    record("changed", "2026-10-31T00:00:00Z", "a", 3),
    record("changed", "2026-10-31T01:00:00Z", "a", 2),
    record("changed", "2026-10-31T02:00:00Z", "b", 1),
  ]), "UTC");
  const day = summaries.get("2026-10-31");
  assert.equal(day.changedResources, 2);
  assert.equal(day.occurrences, 3);
  assert.equal(day.properties, 6);
  assert.equal(day.state, "observed");
});

test("unobserved, observed zero, initial baseline and partial states are distinct", () => {
  const summaries = summarizeHistory(data([
    record("unchanged", "2026-10-28T00:00:00Z", "a", 0),
    record("baseline", "2026-10-29T00:00:00Z", "a", 0),
    record("unknown", "2026-10-30T00:00:00Z", "a", 0),
  ], [{ at: "2026-10-30T00:00:00Z", verified: false }]), "UTC");
  const cells = calendarWeeks("2026-10-31", 13, summaries).flatMap((week) => week.days);
  const byDate = (date) => cells.find((cell) => cell.date === date);
  assert.equal(byDate("2026-10-28").state, "observed");
  assert.equal(byDate("2026-10-28").value, 0);
  assert.equal(byDate("2026-10-29").state, "baseline");
  assert.equal(byDate("2026-10-30").state, "partial");
  assert.equal(byDate("2026-10-31").state, "unobserved");
  assert.match(dayLabel(byDate("2026-10-31")), /관측 없음/);
});

test("initial records and uncertain comparisons do not inflate change volume", () => {
  const day = summarizeHistory(data([
    record("baseline", "2026-10-31T00:00:00Z", "a", 0),
    record("unknown", "2026-10-31T01:00:00Z", "b", 0),
  ]), "UTC").get("2026-10-31");
  assert.equal(day.changedResources, 0);
  assert.equal(day.properties, 0);
  assert.equal(day.firstResources, 1);
  assert.equal(day.unknownResources, 1);
});

test("inventory movements count separately and a resource is not double-counted", () => {
  const day = summarizeHistory(data([
    record("inventory_added", "2026-10-31T00:00:00Z", "a", 0),
    record("changed", "2026-10-31T01:00:00Z", "a"),
    record("inventory_removed", "2026-10-31T02:00:00Z", "b", 0),
  ]), "UTC").get("2026-10-31");
  assert.equal(day.changedResources, 2);
  assert.equal(day.inventory, 2);
  assert.equal(day.occurrences, 3);
});

test("customer/type/search filters apply to cell totals and day records equally", () => {
  const a = record("changed", "2026-10-31T00:00:00Z", "a");
  a.customers = ["alpha", "beta"];
  const b = { ...record("changed", "2026-10-31T01:00:00Z", "b"), customers: ["gamma"], resourceType: "route" };
  assert.equal(matchesHistory(a, { customer: "beta" }), true);
  const filtered = summarizeHistory(data([a, b]), "UTC", { customer: "beta", type: "nsg", query: "a" }).get("2026-10-31");
  assert.equal(filtered.changedResources, 1);
  assert.equal(filtered.records.length, 1);
});

test("property metric does not reuse resource intensity or hide truncation", () => {
  const r = record("changed", "2026-10-31T00:00:00Z", "a", 200);
  r.truncated = true;
  const summaries = summarizeHistory(data([r]), "UTC");
  const resources = calendarWeeks("2026-10-31", 13, summaries, "resources").at(-1).days[5];
  const properties = calendarWeeks("2026-10-31", 13, summaries, "properties").at(-1).days[5];
  assert.equal(resources.value, 1);
  assert.equal(properties.value, 200);
  assert.match(dayLabel(properties, "properties"), /200\+/);
});

test("keyboard arrows preserve weekday when moving between weeks and never focus future cells", () => {
  const weeks = calendarWeeks("2026-10-31", 13);
  const saturday = 12 * 7 + 5;
  assert.equal(navigateCalendar(saturday, "ArrowLeft", weeks), saturday - 7);
  assert.equal(navigateCalendar(saturday, "ArrowUp", weeks), saturday - 1);
  assert.equal(navigateCalendar(saturday, "ArrowDown", weeks), saturday);
  assert.equal(navigateCalendar(saturday, "Home", weeks, true), 0);
  assert.equal(navigateCalendar(0, "End", weeks, true), saturday);
  assert.equal(navigateCalendar(0, "Enter", weeks), null);
});

test("fixed intensity scale is monotonic and distinguishes 0/1/3/7/8+", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 100].map(heatLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
});

test("the preview contains explicitly synthetic weekly patterns and matching detail sources", () => {
  const demo = createDemoHistory(createDemoState(new Date("2026-10-31T12:00:00Z")), new Date("2026-10-31T12:00:00Z"));
  assert.equal(demo.mode, "design-preview");
  assert.equal(demo.timestampMeaning, "synthetic-demo-only");
  assert.ok(demo.records.length > 365);
  const change = demo.records.find((record) => record.kind === "changed");
  const detail = demoHistoryDetail(change);
  assert.equal(detail.afterRunId, change.afterRunId);
  assert.equal(detail.comparison.diffs.length, 1);
});

test("numeric labels and badge colors clear WCAG AA on their actual fills", () => {
  function luminance(hex) {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  }
  const css = readFileSync(new URL("../src/armbackup/ui_static/styles.css", import.meta.url), "utf8");
  const pairs = [["#2e6648", "#fbfdfc"], ["#526c5b", "#fbfdfc"], ["#2e6045", "#edf5ef"], ["#365e7a", "#edf4f9"],
    ["#705927", "#faf5e9"], ["#52675a", "#f5f7f6"]];
  for (const [text, fill] of pairs) {
    assert.ok(css.includes(text) && css.includes(fill));
    const a = luminance(text), b = luminance(fill);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${text} / ${fill}`);
  }
  assert.ok(CALENDAR_FILLS.every((color) => color !== "#000000" && color !== "#ffffff"));
  CALENDAR_FILLS.forEach((fill, level) => assert.ok(css.includes(`.day-cell.heat-${level} { background: ${fill}`)));
});
