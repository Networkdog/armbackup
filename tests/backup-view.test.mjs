import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { BACKUP_STATUS, backupHealth, recentResourceDays, relativeTime } from "../src/armbackup/ui_static/backup-view.mjs";
import { rowsFor } from "../src/armbackup/ui_static/live-client.mjs";
import { ancestors, nestDependents, resourceNodes, visibleTree, visibleTypeTree } from "../src/armbackup/ui_static/view-model.mjs";
import { buildPaneNodes, createPaneState, rowsInScope, scopeBarHtml } from "../src/armbackup/ui_static/tree-pane.mjs";
import { SUPPORTED_RESOURCES } from "../src/armbackup/ui_static/support-catalog.mjs";

const now = Date.parse("2026-11-01T03:00:00Z");
const run = (id, at, status = "Captured", kind = "bundle") => ({
  id, capturedAt: at, status, kind, snapshots: [{ resourceId: "/r", capturedAt: at, complete: status === "Captured" }],
});

test("relative backup times preserve minute/hour/day/week boundaries", () => {
  for (const [seconds, text] of [[0, "방금 전"], [60, "1분 전"], [3600, "1시간 전"],
    [86400, "1일 전"], [604800, "1주 전"], [1209600, "2주 전"]]) {
    assert.equal(relativeTime(new Date(now - seconds * 1000).toISOString(), now), text);
  }
  assert.equal(relativeTime(null, now), "백업 없음");
  assert.equal(relativeTime("invalid", now), "시각 미확인");
  assert.equal(relativeTime(new Date(now + 1000).toISOString(), now), "시각 미확인");
});

test("row health uses latest relevant backup, never the selected old comparison or change severity", () => {
  const state = { runs: [run("old", "2026-10-20T00:00:00Z"), run("new", "2026-11-01T02:00:00Z")] };
  assert.equal(backupHealth(state, "/R", now).status, "healthy");
  state.runs.push({ ...run("failed", "2026-11-01T02:30:00Z", "Incomplete"),
    snapshots: [], resourceAttempts: [{ resourceId: "/r", status: "Failed" }] });
  assert.equal(backupHealth(state, "/r", now).status, "failed");
  assert.equal(backupHealth(state, "/r", now).red, true);
  state.runs.push(run("safety", "2026-11-01T02:59:00Z", "Captured", "safety"));
  assert.equal(backupHealth(state, "/r", now).status, "failed");
});

test("latest verified success clears failure; stale/never/unknown/excluded are distinct", () => {
  const state = { runs: [run("old", "2026-10-31T03:00:00Z")] };
  assert.equal(backupHealth(state, "/r", now).status, "overdue");
  assert.equal(backupHealth({ runs: [] }, "/r", now).status, "never");
  assert.equal(backupHealth({ runs: [], historyLimited: true }, "/r", now).status, "unknown");
  state.runs.push({ id: "excluded", capturedAt: "2026-11-01T02:00:00Z", kind: "bundle", status: "Captured",
    snapshots: [], resourceAttempts: [{ resourceId: "/r", status: "Excluded" }] });
  assert.equal(backupHealth(state, "/r", now).status, "excluded");
  state.runs.push(run("good", "2026-11-01T02:30:00Z"));
  assert.equal(backupHealth(state, "/r", now).status, "healthy");
});

test("failed known-scope jobs without a manifest are red but restore failures do not change backup health", () => {
  const state = { runs: [run("good", "2026-11-01T02:00:00Z")], journal: [{
    action: "bundle-backup", status: "Failed", finishedAt: "2026-11-01T02:20:00Z", backupResourceIds: ["/r"],
  }] };
  assert.equal(backupHealth(state, "/r", now).status, "failed");
  state.journal[0].action = "bundle-restore";
  assert.equal(backupHealth(state, "/r", now).status, "healthy");
});

test("recent calendar has exactly ten ordered dates and filters resource IDs exactly", () => {
  const data = { records: [
    { resourceId: "/r", at: "2026-11-01T02:00:00Z", kind: "changed", propertyCount: 1 },
    { resourceId: "/r", at: "2026-11-01T02:05:00Z", kind: "changed", propertyCount: 20 },
    { resourceId: "/r/child", at: "2026-11-01T02:00:00Z", kind: "changed", propertyCount: 99 },
    { resourceId: "/R", at: "2026-10-31T02:00:00Z", kind: "unchanged", propertyCount: 0 },
  ] };
  const days = recentResourceDays(data, "/r", now);
  assert.equal(days.length, 10);
  assert.equal(days[0].date, "2026-10-23");
  assert.equal(days[9].date, "2026-11-01");
  assert.equal(days[9].changes, 2);
  assert.equal(days[8].status, "unchanged");
  assert.equal(days[0].status, "unobserved");
  assert.equal(recentResourceDays(null, "/r", now)[0].status, "loading");
});

test("baseline and uncertain history are never colored as confirmed zero changes", () => {
  const data = { records: [
    { resourceId: "/r", at: "2026-11-01T02:00:00Z", kind: "unknown" },
    { resourceId: "/r", at: "2026-10-31T02:00:00Z", kind: "baseline" },
  ] };
  const days = recentResourceDays(data, "/r", now);
  assert.equal(days[9].status, "unknown"); assert.equal(days[8].status, "baseline");
});

test("resource warnings render only in the matching current-shape cell, including unbacked rows", () => {
  const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
  const warning = "resource.properties.outboundRules[].properties: field is not in the reviewed API contract: allocationPolicy <script>";
  const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  for (const backed of [true, false]) {
    const resources = ["/lb", "/nsg"].map((id) => ({
      id, name: "kubernetes", type: id === "/lb" ? "loadbalancers" : "nsg", typeLabel: id, tags: {},
    }));
    const snapshots = resources.filter((resource) => backed || resource.id !== "/lb").map((resource) => ({
      resourceId: resource.id, complete: true, capturedAt: new Date().toISOString(), restoreSupported: true,
      comparison: { status: "same", diffs: [] },
    }));
    const state = {
      resources, runs: [{ id: "run", status: "Captured", snapshots }],
      latestView: { snapshots }, workspace: {}, warnings: ["Management Group: scope unavailable"],
      current: {
        "/lb": { status: "present", warnings: [warning] },
        "/nsg": { status: "present" },
      },
    };
    const elements = new Map();
    const $ = (selector) => {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", classList: { add() {}, remove() {} } });
      return elements.get(selector);
    };
    const ui = { runId: "latest", filters: { backupStatus: "all" }, grouping: "type", expanded: new Set(), pane: createPaneState(null) };
    const notices = [];
    const context = vm.createContext({
      state, ui, $, $$: () => [], BACKUP_STATUS, backupHealth, rowsFor, esc,
      notifier: { notify: (notice) => notices.push(notice), dismiss: () => {} }, showCurrentOnly: () => {},
      WORKFLOWS: {}, kinds: {}, button: () => "", heading: () => "", icon: () => "",
      date: () => "", timezone: () => "KST", indent: () => "", resourceSymbol: () => "",
      restoreAvailability: () => ({ allowed: false }), miniCalendar: () => "", relativeTime, recentLegendHtml: () => "",
      currentOnly: () => [], selectedRow: () => null, renderDetail: () => {}, loadRecentHistory: () => {},
      selectionRows: () => rowsFor(state, "latest"),
      visibleTypeTree: (rows) => rows.map((row) => ({ kind: "resource", id: row.resource.id, level: 1, row })),
      nestDependents, SUPPORTED_RESOURCES: [], resourceNodes, buildPaneNodes, rowsInScope,
      renderTreePane: () => {}, scopeBarHtml: () => "", mountTreeArea: () => () => {}, unmountTreeArea: null,
    });
    vm.runInContext(source.slice(source.indexOf("function updateTree("), source.indexOf("function diffTable(")), context);
    vm.runInContext(source.slice(source.indexOf("function statusHeadingHtml("), source.indexOf("function loadRecentHistory(")), context);
    context.renderStatus();
    const page = $("#page-content").innerHTML;
    assert.ok(!page.includes("Management Group: scope unavailable"));
    assert.ok(notices.some((notice) => notice.level === "warning" && notice.message.includes("Management Group: scope unavailable")));
    assert.ok(!page.includes("allocationPolicy"));
    const table = $("#tree-container").innerHTML;
    const resourceRows = [...table.matchAll(/<tr[^>]*class="resource-row[^>]*>([\s\S]*?)<\/tr>/g)];
    assert.equal(resourceRows.length, 2);
    for (const row of resourceRows) {
      if (row[0].includes('data-id="/lb"')) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
        assert.equal(cells.length, 7);
        assert.ok(cells[4][1].includes(esc(warning)));
        assert.ok(cells[4][1].includes("현재 형상 경고"));
        assert.ok(!row[0].includes("<script>"));
      } else {
        assert.ok(!row[0].includes("allocationPolicy"));
      }
    }
    state.current["/lb"].warnings = [];
    context.updateTree();
    assert.ok(!$("#tree-container").innerHTML.includes("allocationPolicy"));
  }
});

const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Network";
function nestedRows() {
  const make = (path, type, extra = {}) => ({
    resource: { id: `${SUB}/${path}`, name: path.split("/").at(-1), type, typeLabel: type, groupId: "rg", tags: {} },
    snapshot: { raw: {} }, observation: { raw: {} }, status: "same", ...extra,
  });
  const lb = make("loadBalancers/lb", "microsoft.network/loadbalancers", {
    observation: { raw: { properties: { frontendIPConfigurations: [{ properties: { publicIPAddress: { id: `${SUB}/publicIPAddresses/PIP-1` } } }] } } },
  });
  const gw = make("applicationGateways/gw", "microsoft.network/applicationgateways", {
    snapshot: { raw: { properties: { frontend: { publicIPAddress: { id: `${SUB}/publicIPAddresses/pip-1` } } } } },
  });
  return {
    lb, gw,
    pool: make("loadBalancers/lb/backendAddressPools/pool", "microsoft.network/loadbalancers/backendaddresspools"),
    pip: make("publicIPAddresses/pip-1", "microsoft.network/publicipaddresses"),
    free: make("publicIPAddresses/pip-free", "microsoft.network/publicipaddresses"),
  };
}

test("contained and referenced resources nest under their main resource", () => {
  const { lb, gw, pool, pip, free } = nestedRows();
  const all = [free, pool, pip, gw, lb];
  const { tops, children } = nestDependents(all, all, SUPPORTED_RESOURCES);
  assert.deepEqual(tops.map((row) => row.resource.name).sort(), ["gw", "lb", "pip-free"]);
  assert.deepEqual(children.get(lb.resource.id.toLowerCase()).map((dep) => [dep.row.resource.name, dep.relation]), [["pool", "contained"]]);
  const owned = children.get(gw.resource.id.toLowerCase());
  assert.deepEqual(owned.map((dep) => [dep.row.resource.name, dep.relation, dep.shared]), [["pip-1", "related", 1]]);
  assert.ok(!children.has(lb.resource.id.toLowerCase() + "/x"));
});

test("a filtered dependent keeps its main resource as context and dependents stay collapsed by default", () => {
  const { lb, gw, pool, pip } = nestedRows();
  const all = [lb, gw, pool, pip];
  const nested = nestDependents([pool], all, SUPPORTED_RESOURCES);
  assert.deepEqual(nested.tops.map((row) => row.resource.name), ["lb"]);
  const folded = visibleTypeTree(nestDependents(all, all, SUPPORTED_RESOURCES).tops, new Set(["type:microsoft.network/loadbalancers"]),
    nestDependents(all, all, SUPPORTED_RESOURCES).children);
  assert.deepEqual(folded.filter((node) => node.kind === "resource").map((node) => node.row.resource.name), ["lb"]);
  assert.equal(folded.at(-1).expandable, true);
  assert.equal(folded.at(-1).deps.length, 1);
  const group = nestDependents(all, all, SUPPORTED_RESOURCES);
  const state = { scopes: [{ id: "rg", parentId: null, kind: "resourceGroup" }] };
  const open = visibleTree(state, group.tops, new Set(["rg", lb.resource.id]), false, group.children);
  const dependent = open.filter((node) => node.dependent);
  assert.deepEqual(dependent.map((node) => [node.row.resource.name, node.level, node.parentId]), [["pool", 3, lb.resource.id]]);
});

test("the status table is a flat scoped list while the tree is open and heading rows once it is folded", () => {
  const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
  const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const scopes = [
    { id: "sub", parentId: null, kind: "subscription", name: "Prod" },
    { id: "rg1", parentId: "sub", kind: "resourceGroup", name: "rg-a" },
    { id: "rg2", parentId: "sub", kind: "resourceGroup", name: "rg-b" },
  ];
  const resources = [["/a", "rg1"], ["/b", "rg1"], ["/c", "rg2"]].map(([id, groupId]) => ({
    id, name: id.slice(1), type: "microsoft.network/virtualnetworks", typeLabel: "VNet", groupId, tags: {},
  }));
  const snapshots = resources.map((resource) => ({
    resourceId: resource.id, complete: true, capturedAt: new Date().toISOString(), restoreSupported: true,
    comparison: { status: "same", diffs: [] },
  }));
  const state = {
    resources, scopes, runs: [{ id: "run", status: "Captured", snapshots }], latestView: { snapshots }, workspace: {}, warnings: [],
    current: Object.fromEntries(resources.map((resource) => [resource.id, { status: "present" }])),
  };
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", classList: { add() {}, remove() {} } });
    return elements.get(selector);
  };
  const ui = { runId: "latest", filters: { backupStatus: "all" }, grouping: "hierarchy", expanded: new Set(["sub", "rg1", "rg2"]), pane: createPaneState(null) };
  const panes = [];
  const context = vm.createContext({
    state, ui, $, $$: () => [], BACKUP_STATUS, backupHealth, rowsFor, esc,
    notifier: { notify: () => {}, dismiss: () => {} }, showCurrentOnly: () => {},
    WORKFLOWS: {}, kinds: {}, button: () => "", heading: () => "", icon: (name) => `<i data-icon="${name}"></i>`,
    date: () => "", timezone: () => "KST", indent: () => "", resourceSymbol: () => "",
    restoreAvailability: () => ({ allowed: false }), miniCalendar: () => "", relativeTime, recentLegendHtml: () => "",
    currentOnly: () => [], selectedRow: () => null, renderDetail: () => {}, loadRecentHistory: () => {},
    selectionRows: () => rowsFor(state, "latest"),
    visibleTree, visibleTypeTree, nestDependents, ancestors, SUPPORTED_RESOURCES: [], resourceNodes, buildPaneNodes, rowsInScope,
    renderTreePane: (slot, model) => panes.push(model.nodes.map((node) => node.key)), scopeBarHtml,
    mountTreeArea: () => () => {}, unmountTreeArea: null,
  });
  vm.runInContext(source.slice(source.indexOf("function updateTree("), source.indexOf("function diffTable(")), context);
  const ids = () => [...$("#tree-container").innerHTML.matchAll(/class="resource-row[^"]*"[^>]*data-id="([^"]+)"/g)].map((match) => match[1]);

  context.updateTree();
  assert.deepEqual(ids(), ["/a", "/b", "/c"]);
  assert.doesNotMatch($("#tree-container").innerHTML, /scope-row|data-tree-depth/);
  assert.deepEqual(panes.at(-1), ["sub", "rg1", "rg2"]);
  assert.equal($("#tree-scope").innerHTML, "");

  ui.pane.scope = "rg1";
  context.updateTree();
  assert.deepEqual(ids(), ["/a", "/b"]);
  assert.match($("#tree-scope").innerHTML, /rg-a/);

  ui.pane.scope = "rg2";
  ui.pane.open = false;
  context.updateTree();
  const html = $("#tree-container").innerHTML;
  assert.deepEqual(ids(), ["/a", "/b", "/c"]);
  assert.deepEqual([...html.matchAll(/data-tree-depth="(\d)"/g)].map((match) => match[1]), ["0", "1", "1"]);
  assert.match(html, /<tbody class="tree-grid-group"><tr [^>]*class="scope-row scope-subscription"/);
  assert.equal($("#tree-scope").innerHTML, "");

  ui.pane.open = true;
  ui.pane.scope = "rg-gone";
  context.updateTree();
  assert.equal(ui.pane.scope, null);
});
