import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { BACKUP_STATUS, backupHealth, recentResourceDays, relativeTime } from "../src/armbackup/ui_static/backup-view.mjs";
import { rowsFor } from "../src/armbackup/ui_static/live-client.mjs";

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
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "" });
      return elements.get(selector);
    };
    const ui = { runId: "latest", filters: { backupStatus: "all" }, grouping: "type", expanded: new Set() };
    const context = vm.createContext({
      state, ui, $, $$: () => [], BACKUP_STATUS, backupHealth, rowsFor, esc,
      WORKFLOWS: {}, kinds: {}, button: () => "", heading: () => "", icon: () => "",
      date: () => "", timezone: () => "KST", indent: () => "", resourceSymbol: () => "",
      restoreAvailability: () => ({ allowed: false }), miniCalendar: () => "", relativeTime,
      currentOnly: () => [], selectedRow: () => null, renderDetail: () => {}, loadRecentHistory: () => {},
      selectionRows: () => rowsFor(state, "latest"),
      visibleTypeTree: (rows) => rows.map((row) => ({ kind: "resource", id: row.resource.id, level: 1, row })),
    });
    vm.runInContext(source.slice(source.indexOf("function updateTree("), source.indexOf("function diffTable(")), context);
    vm.runInContext(source.slice(source.indexOf("function renderStatus("), source.indexOf("function loadRecentHistory(")), context);
    context.renderStatus();
    const page = $("#page-content").innerHTML;
    assert.ok(page.includes("Management Group: scope unavailable"));
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
