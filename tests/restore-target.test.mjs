import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupItems, filterBackupItems, restoreItem, restoreTargetHtml } from "../src/armbackup/ui_static/restore-target.mjs";
import { buildPickerNodes, filterPickerItems, resourceHierarchy, resourcePickerModalHtml } from "../src/armbackup/ui_static/resource-picker.mjs";

const scopes = [
  { id: "mg-corp", kind: "managementGroup", name: "Corp", parentId: null },
  { id: "sub-prod", kind: "subscription", name: "Prod Subscription", subscriptionId: "11111111-1111-1111-1111-111111111111", parentId: "mg-corp" },
  { id: "rg-net", kind: "resourceGroup", name: "rg-network", parentId: "sub-prod" },
  { id: "rg-app", kind: "resourceGroup", name: "rg-application", parentId: "sub-prod" },
];
const resource = (id, name, groupId = "rg-net", tags = {}) => ({ id, name, groupId, type: "t", typeLabel: "NSG", tags });
const snapshot = (resourceId, capturedAt) => ({ resourceId, capturedAt });
const state = {
  scopes,
  resources: [
    resource("/b", "beta", "rg-app", { customer: "contoso" }),
    resource("/a", "alpha", "rg-net"),
    resource("/c", "gamma", "rg-net"),
  ],
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

test("item search matches name, id, type, customer tag and hierarchy scope", () => {
  const items = backupItems(state);
  assert.deepEqual(filterBackupItems(items, "CONTOSO").map((item) => item.resource.name), ["beta"]);
  assert.deepEqual(filterBackupItems(items, "rg-network", state).map((item) => item.resource.name), ["alpha"]);
  assert.equal(filterBackupItems(items, "").length, 2);
  assert.equal(filterBackupItems(items, "nothing").length, 0);
});

test("compact target bar displays management group, subscription, resource group and resource without raw resource ID block", () => {
  assert.equal(restoreItem(state, "/A").resource.name, "alpha");
  assert.equal(restoreItem(state, "/missing"), null);
  const unselected = restoreTargetHtml(state, "", helpers);
  assert.match(unselected, /선택된 리소스가 없습니다/);
  assert.match(unselected, /data-action="open-resource-picker"/);
  assert.match(unselected, /항목 변경/);
  const card = restoreTargetHtml(state, "/a", helpers);
  assert.match(card, /관리 그룹.*Corp/);
  assert.match(card, /구독.*Prod Subscription/);
  assert.match(card, /리소스 그룹.*rg-network/);
  assert.match(card, /리소스.*alpha/);
  assert.match(card, /백업<\/dt><dd>2회/);
  assert.match(card, /현재<\/dt><dd>있음/);
  assert.match(card, /data-action="open-resource-picker"/);
  assert.doesNotMatch(card, /<code class="resource-id">/);
  assert.equal(restoreTargetHtml(state, "/missing", helpers), unselected);
});

test("reusable resource picker modal browses management group, subscription and resource group hierarchy and filters items", () => {
  const items = backupItems(state);
  const hierarchy = resourceHierarchy(state, items[0].resource);
  assert.equal(hierarchy.managementGroup, "Corp");
  assert.equal(hierarchy.subscription, "Prod Subscription");
  assert.equal(hierarchy.resourceGroup, "rg-network");
  const nodes = buildPickerNodes(state, items);
  assert.deepEqual(nodes.map((n) => [n.kind, n.label, n.count]), [
    ["managementGroup", "Corp", 2],
    ["subscription", "Prod Subscription", 2],
    ["resourceGroup", "rg-network", 1],
    ["resourceGroup", "rg-application", 1],
  ]);
  assert.deepEqual(filterPickerItems(state, items, { scopeKey: "rg-app" }).map((i) => i.resource.name), ["beta"]);
  assert.deepEqual(filterPickerItems(state, items, { scopeKey: "mg-corp", query: "alpha" }).map((i) => i.resource.name), ["alpha"]);
  const modal = resourcePickerModalHtml({ state, items, selectedId: "/a", scopeKey: "rg-net", query: "" }, helpers);
  assert.match(modal, /role="tree"/);
  assert.match(modal, /data-picker-select="\/a"/);
  assert.match(modal, /선택됨/);
  assert.doesNotMatch(modal, /data-picker-select="\/b"/);
});

test("restore page keeps target header, backup calendar and bottom plan section on one page in both apps", () => {
  for (const file of ["live-app.mjs", "app.mjs"]) {
    const source = readFileSync(new URL(`../src/armbackup/ui_static/${file}`, import.meta.url), "utf8");
    const render = source.slice(source.indexOf("function renderRestore()"));
    assert.ok(render.indexOf("restoreTargetPanel()") < render.indexOf("renderRestoreCalendar("), file);
    assert.match(source, /id="restore-plan-section"/);
    assert.match(source, /openResourcePicker\(/);
    assert.match(source, /fixedItem: true/);
  }
});
