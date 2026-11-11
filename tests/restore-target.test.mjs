import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupItems, filterBackupItems, restoreItem, restoreTargetHtml } from "../src/armbackup/ui_static/restore-target.mjs";

const resource = (id, name, tags = {}) => ({ id, name, type: "t", typeLabel: "NSG", tags });
const snapshot = (resourceId, capturedAt) => ({ resourceId, capturedAt });
const state = {
  resources: [resource("/b", "beta", { customer: "contoso" }), resource("/a", "alpha"), resource("/c", "gamma")],
  runs: [
    { id: "r1", status: "Captured", capturedAt: "2026-11-01T00:00:00Z", snapshots: [snapshot("/A", "2026-11-01T00:00:00Z"), snapshot("/b", "2026-11-01T00:00:00Z")] },
    { id: "r2", status: "Captured", capturedAt: "2026-11-02T00:00:00Z", snapshots: [snapshot("/a", "2026-11-02T00:00:00Z")] },
    { id: "r3", status: "Failed", capturedAt: "2026-11-03T00:00:00Z", snapshots: [snapshot("/c", "2026-11-03T00:00:00Z")] },
  ],
  current: { "/a": { status: "present" } },
};
const helpers = { esc: (v) => String(v), icon: () => "", relativeTime: (v) => `rel(${v})`, symbol: () => "" };

test("backup items list only resources with a verified backup, sorted by name, with counts", () => {
  const items = backupItems(state);
  assert.deepEqual(items.map((item) => [item.resource.name, item.count]), [["alpha", 2], ["beta", 1]]);
  assert.equal(items[0].latestAt, "2026-11-02T00:00:00Z");
});

test("item search matches name, id, type and customer tag", () => {
  const items = backupItems(state);
  assert.deepEqual(filterBackupItems(items, "CONTOSO").map((item) => item.resource.name), ["beta"]);
  assert.equal(filterBackupItems(items, "").length, 2);
  assert.equal(filterBackupItems(items, "nothing").length, 0);
});

test("the same target panel renders whether the item was preselected or picked", () => {
  assert.equal(restoreItem(state, "/A").resource.name, "alpha");
  assert.equal(restoreItem(state, "/missing"), null);
  const picker = restoreTargetHtml(state, "", "", helpers);
  assert.match(picker, /restore-item-query/);
  assert.match(picker, /data-action="pick-restore-item" data-id="\/a"/);
  const card = restoreTargetHtml(state, "/a", "", helpers);
  assert.match(card, /restore-item/);
  assert.match(card, /data-action="clear-restore"/);
  assert.match(card, /백업<\/dt><dd>2회/);
  assert.match(card, /현재 Azure<\/dt><dd>있음/);
  assert.doesNotMatch(card, /restore-item-query/);
  assert.equal(restoreTargetHtml(state, "/missing", "", helpers), picker);
});

test("restore page shows the item panel first, then the backup calendar, in both apps", () => {
  for (const file of ["live-app.mjs", "app.mjs"]) {
    const source = readFileSync(new URL(`../src/armbackup/ui_static/${file}`, import.meta.url), "utf8");
    const render = source.slice(source.indexOf("function renderRestore()"));
    assert.ok(render.indexOf("restoreTargetPanel()") < render.indexOf("renderRestoreCalendar("), file);
    assert.match(source, /fixedItem: true/);
    assert.match(source, /pick-restore-item/);
    assert.doesNotMatch(source, /query: resourceId/);
  }
});
