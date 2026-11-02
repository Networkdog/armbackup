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

test("review requires a same-run backup, supported profiles and explicit boundary acknowledgement", () => {
  const input = bundleReviewInput(model(), graph);
  assert.equal(input.ticket, "INC-1"); assert.equal(input.reason, "approved repair");
  assert.deepEqual(input.resourceIds, ["/profile"]); assert.equal(input.acknowledgeExternal, true);
  for (const changes of [{ runId: "current" }, { selected: [] }, { selected: ["/blocked"] },
    { ticket: "" }, { reason: "x" }, { ack: false }, { mode: "upsert" }]) {
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
