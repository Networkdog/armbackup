import assert from "node:assert/strict";
import test from "node:test";
import { BundlePanel, bundleSelection, bundleReviewInput } from "../src/armbackup/ui_static/bundle-panel.mjs";
import { LiveClient, readableJob } from "../src/armbackup/ui_static/live-client.mjs";

const graph = {
  nodes: [{ id: "/profile", restoreSupported: true }, { id: "/profile/endpoint", parentId: "/profile", restoreSupported: true },
    { id: "/ip", restoreSupported: true }, { id: "/blocked", restoreSupported: false }],
  edges: [{ from: "/profile/endpoint", to: "/ip", kind: "reference" },
    { from: "/profile", to: "/external", kind: "shared" }],
  addresses: [{ from: "/profile/endpoint", address: "10.1.0.4", automaticRestore: false }],
};
const model = () => ({ runId: "run1", selected: ["/profile"], includeRelated: false,
  mode: "update", ticket: " INC-1 ", reason: " approved repair ", ack: true });

test("single selection includes contained children but not related or shared roots", () => {
  assert.deepEqual(bundleSelection(graph, ["/PROFILE"], false).map((node) => node.id), ["/profile", "/profile/endpoint"]);
  assert.deepEqual(bundleSelection(graph, ["/profile"], true).map((node) => node.id), ["/profile", "/profile/endpoint", "/ip"]);
  assert.equal(graph.nodes.length, 4);
});

test("review requires a same-run backup, supported profiles and defaults optional audit fields", () => {
  const input = bundleReviewInput(model(), graph);
  assert.equal(input.ticket, "INC-1"); assert.equal(input.reason, "approved repair");
  assert.deepEqual(input.resourceIds, ["/profile"]); assert.equal(input.acknowledgeExternal, true);
  const blankAudit = bundleReviewInput({ ...model(), ticket: "", reason: "" }, graph);
  assert.equal(blankAudit.ticket, "RESTORE");
  assert.match(blankAudit.reason, /복원/);
  for (const changes of [{ runId: "current" }, { selected: [] }, { selected: ["/blocked"] },
    { ticket: "ab" }, { reason: "x" }, { ack: false }, { mode: "upsert" }]) {
    assert.throws(() => bundleReviewInput({ ...model(), ...changes }, graph));
  }
});

test("expanded child resources count toward the 50-resource limit", () => {
  const many = { nodes: [graph.nodes[0], ...Array.from({ length: 50 }, (_, i) => ({
    id: `/profile/child${i}`, parentId: "/profile", restoreSupported: true,
  }))], edges: [], addresses: [] };
  assert.throws(() => bundleReviewInput(model(), many), /1~50/);
});

test("clone is explicit and requires a validated target prefix", () => {
  const input = bundleReviewInput({ ...model(), mode: "clone", clonePrefix: "twin" }, graph);
  assert.equal(input.mode, "clone"); assert.equal(input.clonePrefix, "twin");
  assert.throws(() => bundleReviewInput({ ...model(), mode: "clone", clonePrefix: "../outside" }, graph), /접두사/);
  assert.equal(bundleReviewInput(model(), graph).clonePrefix, undefined);
});

test("clone can target another subscription and resource group, where the name prefix is optional", () => {
  const target = { mode: "clone", clonePrefix: "", targetSubscription: "sub-2", targetGroup: "rg-dr" };
  const input = bundleReviewInput({ ...model(), ...target }, graph);
  assert.equal(input.targetSubscriptionId, "sub-2"); assert.equal(input.targetResourceGroup, "rg-dr");
  assert.equal(input.clonePrefix, undefined);
  assert.equal(bundleReviewInput({ ...model(), ...target, clonePrefix: "dr" }, graph).clonePrefix, "dr");
  assert.throws(() => bundleReviewInput({ ...model(), ...target, clonePrefix: "BAD" }, graph), /접두사/);
  assert.throws(() => bundleReviewInput({ ...model(), ...target, targetGroup: "" }, graph), /대상 리소스 그룹/);
  assert.throws(() => bundleReviewInput({ ...model(), mode: "clone", clonePrefix: "" }, graph), /접두사가 필요/);
  const update = bundleReviewInput({ ...model(), mode: "update", targetSubscription: "sub-2", targetGroup: "rg-dr" }, graph);
  assert.equal(update.targetResourceGroup, undefined);
});

test("clone form offers subscriptions and resource groups and asks for no confirmation", () => {
  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, {
    model: { ...model(), mode: "clone", clonePrefix: "", targetSubscription: "sub-2", targetGroup: "rg-dr",
      plan: { id: "p", approvalSha256: "sha", actions: [], confirmation: "rg-dr",
        target: { subscriptionName: "복구 구독", resourceGroup: "rg-dr" } }, approved: false, confirmGroup: "", busy: false },
    state: { workspace: { inventoryScope: "subscription", scopeConfirmation: "sub-1", resourceGroup: "storage-rg" } },
    targets: { loading: false, loaded: true, error: "", enabled: true, currentSubscription: "sub-1",
      subscriptions: [{ subscriptionId: "sub-1", name: "운영" }, { subscriptionId: "sub-2", name: "복구 구독" }],
      groups: { "sub-2": [{ name: "rg-dr", location: "koreasouth" }, { name: "rg-other" }] } },
  });
  const form = panel.reviewForm("");
  assert.match(form, /data-bundle="pick-target"/);
  assert.doesNotMatch(form, /<select id="bundle-target-sub"|<select id="bundle-target-group"|<select id="bundle-target-location"/);
  assert.match(form, /복구 구독/); assert.match(form, /rg-dr/); assert.match(form, /koreasouth/);
  assert.match(form, /구독 경계를 넘는 공유 참조/); assert.match(form, /대상 위치 · 복구 구독 \/ <b>rg-dr/);
  assert.doesNotMatch(form, /최종 확인|bundle-confirm|bundle-approve/);
  assert.match(form, /복제 실행/);
  const execute = { disabled: true };
  panel.root = { querySelector: () => execute };
  panel.updateGates();
  assert.equal(execute.disabled, false);
  panel.model.plan = null;
  panel.updateGates();
  assert.equal(execute.disabled, true);
});

test("choosing a target resource group or subscription resets dependent choices and invalidates the plan", () => {
  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, { model: { ...model(), mode: "clone", plan: { id: "p" }, approved: true, confirmGroup: "x",
    targetSubscription: "", targetGroup: "" }, targets: { currentSubscription: "sub-1" } });
  panel.setTarget("sub-2", "");
  assert.deepEqual([panel.model.targetSubscription, panel.model.targetGroup, panel.model.plan], ["sub-2", "", null]);
  panel.setTarget("sub-2", "rg-dr");
  assert.deepEqual([panel.model.targetSubscription, panel.model.targetGroup], ["sub-2", "rg-dr"]);
  panel.setTarget("sub-1", "rg-home");
  assert.deepEqual([panel.model.targetSubscription, panel.model.targetGroup], ["sub-1", "rg-home"]);
  panel.setTarget("sub-1", "");
  assert.deepEqual([panel.model.targetSubscription, panel.model.targetGroup], ["", ""]);
  assert.equal(panel.targetSubscriptionId(), "sub-1");
});

test("clone targets are read from fixed local routes with an encoded subscription ID", async () => {
  const calls = [];
  const client = new LiveClient(async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; });
  await client.restoreTargets(); await client.restoreTargets("a b&c");
  assert.deepEqual(calls, ["/api/restore-targets", "/api/restore-targets?subscriptionId=a%20b%26c"]);
});

test("subscription-wide restore requires one safety approval check and submits subscription confirmation automatically", async () => {
  const panel = Object.create(BundlePanel.prototype);
  const execute = { disabled: true };
  let submitted = null;
  Object.assign(panel, {
    alive: true,
    model: { ...model(), plan: { id: "approved-plan", approvalSha256: "sha", actions: [] },
      approved: false, confirmGroup: "", busy: false },
    state: { workspace: { inventoryScope: "subscription", scopeConfirmation: "subscription-uuid", resourceGroup: "storage-rg" } },
    root: { querySelector: (selector) => selector.includes("execute") ? execute : null, insertAdjacentHTML: () => {} },
    invalidate() { this.model.plan = null; this.model.approved = false; },
    render() {},
    refresh: async () => {},
    run: async (action, payload) => { submitted = { action, payload }; return { status: "Succeeded", result: { safetyRunId: "s1" } }; },
  });
  panel.updateGates();
  assert.equal(execute.disabled, true);
  await assert.rejects(panel.click({
    target: { closest: () => ({ dataset: { bundle: "execute" }, disabled: false }) },
  }), /안전 백업 보관 및 실제 리소스 복원 확인/);
  panel.model.approved = true;
  panel.updateGates();
  assert.equal(execute.disabled, false);
  const form = panel.reviewForm("");
  assert.doesNotMatch(form, /bundle-confirm|실제 LAB|같은 LAB/);
  assert.match(form, /id="bundle-approve"/);
  await panel.click({
    target: { closest: () => ({ dataset: { bundle: "execute" }, disabled: false }) },
  });
  assert.equal(submitted.payload.confirmGroup, "subscription-uuid");
});

test("bundle client calls only fixed local routes with encoded source/resource IDs", async () => {
  const calls = [];
  const client = new LiveClient(async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ nodes: [], edges: [], addresses: [] }) };
  });
  await client.relations(); await client.bundle("run &1");
  await client.bundleReview(bundleReviewInput(model(), graph));
  await client.diagnostics("/resource?outside#");
  assert.deepEqual(calls.map((call) => call.url), ["/api/relations", "/api/bundle?runId=run%20%261",
    "/api/bundle/review", "/api/diagnostics?resourceId=%2Fresource%3Foutside%23"]);
  assert.ok(calls.every((call) => !call.options.headers.Authorization));
});

test("complex jobs label safety and full final verification rather than returning early success", () => {
  assert.match(readableJob({ action: "bundle-restore", phase: "safety-backup" }), /묶음.*안전 백업/);
  assert.match(readableJob({ action: "bundle-restore", phase: "verification" }), /사후 형상 검증/);
});

test("durable job result is visible before a slow current-state refresh finishes", async () => {
  const panel = Object.create(BundlePanel.prototype);
  let displayed = "", release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const refreshing = new Promise((resolve) => { entered = resolve; });
  Object.assign(panel, {
    model: { ...model(), runId: "current", busy: false }, alive: true,
    render() {}, root: { querySelector: () => null, insertAdjacentHTML: (_, html) => { displayed = html; } },
    run: async () => ({ status: "Succeeded", result: { runId: "verified-new-run", capturedCount: 1 } }),
    refresh: async () => { entered(); await waiting; },
  });
  const running = panel.click({ target: { closest: () => ({ dataset: { bundle: "backup" }, disabled: false }) } });
  await refreshing;
  assert.match(displayed, /묶음 백업 완료/);
  assert.match(displayed, /verified-new-run/);
  assert.equal(panel.model.runId, "verified-new-run");
  release();
  await running;
});

test("empty gateway diagnostics omit an orphan log table header and row clicks toggle selection", async () => {
  const panel = Object.create(BundlePanel.prototype);
  let rendered = 0;
  Object.assign(panel, {
    model: { ...model(), selected: [], busy: false },
    diagnostics: { observedAt: "2026-11-12T00:00:00Z", health: { backendAddressPools: [] }, logs: { logs: [] } },
    time: () => "now",
    invalidate() {},
    render() { rendered++; },
    root: { querySelectorAll: () => [] },
  });
  const emptyView = panel.diagnosticView();
  assert.doesNotMatch(emptyView, /<table/);
  assert.match(emptyView, /수신된 진단 로그가 없습니다/);
  await panel.click({
    target: {
      closest: (selector) => selector === "[data-bundle-row]" ? { dataset: { bundleRow: "/profile" } } : null,
    },
  });
  assert.deepEqual(panel.model.selected, ["/profile"]);
  assert.equal(rendered, 1);
});

test("embedded workspace places settings on the left and deduplicated plan on the right, updating draft live on input", () => {
  const cloneGraph = {
    nodes: [
      { id: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw-web", name: "agw-web", label: "Application Gateway", resourceType: "microsoft.network/applicationgateways", restoreSupported: true },
      { id: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip-web", name: "pip-web", label: "Public IP", resourceType: "microsoft.network/publicipaddresses", restoreSupported: true },
    ],
    edges: [{ from: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw-web", to: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip-web", kind: "reference", relation: "required", relationClass: "exclusive" }],
    addresses: [],
  };
  const planPane = { innerHTML: "" };
  const previewNode = { dataset: { previewFor: cloneGraph.nodes[0].id.toLowerCase() }, textContent: "" };
  const root = {
    innerHTML: "",
    querySelector(sel) {
      if (sel === ".restore-plan-pane") return planPane;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "[data-preview-for]") return [previewNode];
      return [];
    },
  };
  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, {
    alive: true,
    embedded: true,
    intent: "clone",
    graph: cloneGraph,
    root,
    state: { runs: [{ id: "run1", capturedAt: "2026-11-22T07:00:00Z" }], current: {}, workspace: { subscription: "s1", resourceGroup: "rg1" } },
    targets: { loading: false, loaded: true, error: "", enabled: true, currentSubscription: "s1", subscriptions: [{ subscriptionId: "s1", name: "운영 구독" }], groups: { s1: [{ name: "rg1", location: "koreacentral" }] } },
    model: {
      runId: "run1", selected: [cloneGraph.nodes[0].id], includeRelated: true, excludedRelated: [],
      mode: "clone", clonePrefix: "copy", targetSubscription: "", targetGroup: "", targetLocation: "",
      smartNames: {}, smartDnsLabels: {}, smartPrivateIps: {}, smartPoolIps: {}, smartKeyVaultCerts: {},
      referenceBindings: {}, ticket: "", reason: "", overridesText: "", ack: true,
      plan: null, result: null, error: "", busy: false,
    },
  });
  panel.renderEmbedded();
  const settingsIdx = root.innerHTML.indexOf(' restore-settings-pane"');
  const planIdx = root.innerHTML.indexOf(' restore-plan-pane"');
  assert.ok(settingsIdx !== -1 && planIdx > settingsIdx);
  const settingsSlice = root.innerHTML.slice(settingsIdx, planIdx);
  const planSlice = root.innerHTML.slice(planIdx);
  // Settings pane contains controls only, with no duplicate resource mapping or timestamp
  assert.doesNotMatch(settingsSlice, /decision-summary|clone-name-preview|data-preview-for|백업 기준|새 리소스 2개/);
  assert.match(planSlice, /복제 계획/);
  assert.match(planSlice, /copy-agw-web/);
  assert.match(planSlice, /copy-pip-web/);

  // Simulate reviewed plan, then edit prefix -> plan pane resets to draft without replacing settings pane
  panel.model.plan = {
    id: "p1", approvalSha256: "sha", expiresAt: "2026-11-23T00:00:00Z",
    actions: [{ name: "copy-agw-web", sourceResourceId: cloneGraph.nodes[0].id, resourceId: "/new", wasPresent: false }],
  };
  panel.input({ target: { id: "bundle-prefix", value: "dr" } });
  assert.equal(panel.model.plan, null);
  assert.match(planPane.innerHTML, /검토 전/);
  assert.match(planPane.innerHTML, /data-bundle="review"/);
  assert.equal(previewNode.textContent, "dr-agw-web");
});

