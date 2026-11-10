import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ConsoleError, initialRun, stateContentChanged, snapshotHealth } from "../src/armbackup/ui_static/live-client.mjs";
import { relativeTime } from "../src/armbackup/ui_static/backup-view.mjs";
import { legacyPolicyTypes } from "../src/armbackup/ui_static/support-catalog.mjs";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function state(cached = true, port = 443) {
  return {
    mode: "live-lab", observedAt: "2026-11-02T00:00:00Z",
    workspace: { scope: "/subscription" }, scopes: [{ id: "/subscription" }],
    policy: { scopeIds: ["/subscription"], types: ["microsoft.network/loadbalancers"], tags: [] }, runs: [],
    resources: [{ id: "/resource" }], current: { "/resource": { status: "present", raw: { port } } },
    latestView: { snapshots: [] }, materializedView: { cached, requiresLiveRefresh: cached },
  };
}

function harness() {
  const badge = {}, save = { dataset: { action: "save-policy" } }, combined = { dataset: { action: "save-backup" } }, backup = { dataset: { action: "backup-now" } }, refresh = {}, progress = { innerHTML: "", replaceChildren() { this.innerHTML = ""; } };
  const errorModal = { open: false, clear() { this.open = false; } }, dialog = { open: false }, main = { innerHTML: "" };
  const collection = { innerHTML: "" };
  const elements = new Map([
    [".environment-pill", badge], ["#read-progress", progress],
    ["#app-dialog", dialog], ["#main", main], ["#collection-status", collection],
  ]);
  const errors = [];
  const context = vm.createContext({
    state: undefined, session: undefined, ui: { runId: "", viewRefreshing: false, busy: false, loading: false, stale: false, policy: null },
    viewNeedsRender: false, viewError: null, errors: errorModal, historyCache: { records: [] }, bundlePanel: null,
    api: { state: async () => state(), refreshState: async () => state(false) },
    document: { activeElement: null }, clone: structuredClone, ConsoleError,
    initialRun, stateContentChanged, snapshotHealth, relativeTime, esc: (value) => value,
    legacyPolicyTypes, date: (value) => value, timezone: () => "KST",
    $: (selector) => elements.get(selector) || null,
    $$: (selector) => selector.includes("save-policy") ? [save, combined, backup] : selector.includes("refresh") ? [refresh] : [],
    showError: (error) => { errors.push(error); errorModal.open = true; },
    empty: () => "", button: () => "", renders: 0,
  });
  vm.runInContext(functionSource("function syncViewStatus()", "function renderRefreshedView()"), context);
  context.renderRefreshedView = () => { context.renders++; context.viewNeedsRender = false; context.syncViewStatus(); };
  vm.runInContext(functionSource("function flushRefreshedView()", "function renderBundleWorkbench("), context);
  vm.runInContext(functionSource("async function refresh(", "async function operation("), context);
  return { context, badge, save, combined, backup, progress, errors, errorModal, dialog, main, collection };
}

test("Blob state renders before a slow Azure refresh and unchanged data never remounts the page", async () => {
  const h = harness(), c = h.context;
  await c.refresh("", false);
  assert.equal(c.renders, 1);
  assert.equal(h.save.disabled, true);
  assert.equal(h.combined.disabled, true);
  assert.equal(c.state.materializedView.cached, true);
  c.ui.expanded = new Set();
  c.ui.selected = "/resource";
  const collapsed = c.ui.expanded;
  let resolve;
  c.api.refreshState = () => new Promise((done) => { resolve = done; });
  const updating = c.refresh(c.ui.runId, true, false, true);
  assert.equal(c.renders, 1);
  assert.equal(h.progress.innerHTML, "");
  assert.equal(c.ui.loading, false);
  const fresh = { ...state(false), observedAt: "2026-11-03T00:00:00Z" };
  resolve(fresh);
  await updating;
  assert.equal(c.renders, 1);
  assert.equal(c.state.observedAt, fresh.observedAt);
  assert.equal(h.save.disabled, false);
  assert.equal(h.combined.disabled, false);
  assert.equal(h.backup.disabled, false);
  assert.equal(h.badge.textContent, "LIVE");
  assert.equal(c.ui.expanded, collapsed);
  assert.equal(c.ui.selected, "/resource");
});

test("a background shape change remounts once while preserving the draft selection", async () => {
  const h = harness(), c = h.context;
  await c.refresh("", false);
  c.ui.policy = { ...c.ui.policy, scopeIds: ["/resource"] };
  c.api.refreshState = async () => state(false, 8443);
  await c.refresh(c.ui.runId, true, false, true);
  assert.equal(c.renders, 2);
  assert.equal(c.state.current["/resource"].raw.port, 8443);
  assert.deepEqual(c.ui.policy.scopeIds, ["/resource"]);
});

test("combined saving uses the draft type gate even when the stored policy still contains legacy types", async () => {
  const h = harness(), c = h.context;
  await c.refresh("", false);
  c.ui.stale = false;
  c.state.policy = { ...c.state.policy, types: ["microsoft.network/networksecuritygroups"] };
  c.ui.policy = { ...c.ui.policy, types: ["microsoft.network/loadbalancers"] };
  c.syncViewStatus();
  assert.equal(h.combined.disabled, false);
  assert.equal(h.save.disabled, false);
  assert.equal(h.backup.disabled, true);
});

test("editing fields, details and error dialogs defer DOM replacement but not fresh state delivery", async () => {
  for (const interaction of ["field", "details", "error"]) {
    const h = harness(), c = h.context;
    await c.refresh("", false);
    c.document.activeElement = interaction === "field" ? { closest: () => ({}) } : null;
    h.dialog.open = interaction === "details";
    h.errorModal.open = interaction === "error";
    c.api.refreshState = async () => state(false, 8443);
    await c.refresh(c.ui.runId, true, false, true);
    assert.equal(c.renders, 1);
    assert.equal(c.viewNeedsRender, true);
    assert.equal(h.badge.textContent, "LIVE · 새 데이터");
    assert.equal(c.state.current["/resource"].raw.port, 8443);
    c.document.activeElement = null;
    h.dialog.open = false;
    h.errorModal.open = false;
    c.flushRefreshedView();
    assert.equal(c.renders, 2);
    assert.equal(c.viewNeedsRender, false);
  }
});

test("background failure keeps the existing DOM and explicitly blocks writes", async () => {
  const h = harness(), c = h.context;
  await c.refresh("", false);
  c.api.refreshState = async () => { throw new ConsoleError("ARM denied"); };
  await assert.rejects(c.refresh(c.ui.runId, true, false, true), /ARM denied/);
  assert.equal(c.renders, 1);
  assert.equal(c.state.resources.length, 1);
  assert.equal(h.save.disabled, true);
  assert.equal(h.errorModal.open, true);
  assert.equal(h.errors.length, 1);
});

test("unchanged successful polling does not erase an unrelated operation error", async () => {
  const h = harness(), c = h.context;
  await c.refresh("", false);
  h.errorModal.open = true;
  await c.refresh(c.ui.runId, true, false, true);
  assert.equal(h.errorModal.open, true);
  assert.equal(c.renders, 1);
});

test("missing Blob view awaits one shared initial collection instead of displaying an empty success", async () => {
  const h = harness(), c = h.context;
  c.api.state = async () => ({ statePending: true });
  let resolve, entered;
  const collecting = new Promise((done) => { entered = done; });
  c.api.refreshState = () => new Promise((done) => { resolve = done; entered(); });
  const loading = c.refresh("", false);
  await collecting;
  assert.equal(c.renders, 0);
  resolve(state(false));
  await loading;
  assert.equal(c.renders, 1);
});

test("scheduled snapshot renders and refreshes without ever requesting Azure collection", async () => {
  const h = harness(), c = h.context;
  const workspace = { scope: "/subscription", collectionMode: "scheduled-collector" };
  c.session = { workspace };
  c.api.refreshState = () => { throw new Error("Browser must not start a collector"); };
  c.api.state = async () => ({ ...state(), workspace, observedAt: new Date(Date.now() - 180_000).toISOString(),
    materializedView: { cached: true, requiresLiveRefresh: false, maxAgeSeconds: 900 } });
  await c.refresh("", false);
  assert.equal(c.renders, 1);
  assert.equal(h.save.disabled, false);
  assert.match(h.badge.textContent, /저장본 · 3분 전 수집/);
  await c.refresh(c.ui.runId, true, false, true);
  assert.equal(c.renders, 1);
  c.api.state = async () => { throw new ConsoleError("Blob unavailable"); };
  await assert.rejects(c.refresh(c.ui.runId, true, false, true), /Blob unavailable/);
  assert.equal(h.save.disabled, true);
  assert.equal(c.renders, 1);
});

test("scheduled first-run waiting and failures are explicit and never await collection", async () => {
  for (const collection of [{ status: "NotStarted" }, { status: "Running" }, { status: "Failed", error: "ARM denied" }]) {
    const h = harness(), c = h.context;
    c.session = { workspace: { collectionMode: "scheduled-collector" } };
    c.api.state = async () => ({ statePending: true, collection });
    c.api.refreshState = () => { throw new Error("Must not collect"); };
    await c.refresh("", false);
    assert.equal(c.renders, 0);
    assert.match(h.main.innerHTML, /수집 결과 대기/);
    assert.equal(c.ui.loading, false);
    if (collection.status === "Failed") assert.match(h.main.innerHTML, /ARM denied/);
    c.api.state = async () => ({ ...state(false), workspace: c.session.workspace });
    await c.refresh("", true, false, true);
    assert.equal(c.renders, 1);
  }
});

test("collection failure and age expiry preserve the page and lock writes", async () => {
  const h = harness(), c = h.context;
  const snapshot = { ...state(false), workspace: { collectionMode: "scheduled-collector" },
    observedAt: new Date().toISOString(), collection: { status: "Succeeded" } };
  c.session = { workspace: snapshot.workspace };
  c.api.state = async () => snapshot;
  await c.refresh("", false);
  snapshot.collection = { status: "Failed", error: "ARM denied" };
  await c.refresh("", true, false, true);
  assert.equal(c.renders, 1);
  assert.equal(h.save.disabled, true);
  assert.match(h.collection.innerHTML, /최근 수집 실패.*ARM denied/);
  snapshot.collection = { status: "Succeeded" };
  snapshot.observedAt = new Date(Date.now() - 901_000).toISOString();
  c.syncViewStatus();
  assert.equal(h.save.disabled, true);
  assert.match(h.collection.innerHTML, /수집이 지연/);
});

test("changed views restore page and table scroll and the matching focused control", () => {
  let containers = [{ id: "tree", scrollTop: 240, scrollLeft: 80, classList: { contains: () => false } }];
  let focused = false, windowTop;
  const replacement = { id: "tree", scrollTop: 0, scrollLeft: 0 };
  const context = vm.createContext({
    document: { activeElement: { id: "resource-search", dataset: {} },
      getElementById: (id) => id === "tree" ? replacement : { focus: () => { focused = true; } } },
    window: { scrollY: 350, scrollTo: ({ top }) => { windowTop = top; } },
    $$: () => containers,
    render: () => { containers = [replacement]; },
  });
  vm.runInContext(functionSource("function renderRefreshedView()", "function flushRefreshedView()"), context);
  context.renderRefreshedView();
  assert.equal(replacement.scrollTop, 240);
  assert.equal(replacement.scrollLeft, 80);
  assert.equal(windowTop, 350);
  assert.equal(focused, true);
});
