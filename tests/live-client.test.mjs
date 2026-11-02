import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveClient, ConsoleError, rowsFor, restoreAvailability, currentOnly,
  initialRun, validateReview, readableJob, WORKFLOWS,
  scopeNoticeRequired, acknowledgeScopeNotice,
} from "../src/armbackup/ui_static/live-client.mjs";
import {
  visibleTree, visibleTypeTree, policySelection, policyMatchesScope, togglePolicyScope,
} from "../src/armbackup/ui_static/view-model.mjs";

function state() {
  const resources = ["edge", "app", "routes", "vnet", "current-only"].map((name, index) => ({
    id: `/scope/${name}`, name, type: index === 3 ? "vnet" : "nsg", typeLabel: "Network",
    groupId: "rg", tags: { customer: index % 2 === 0 ? "alpha" : "beta", owner: "network-ops" },
  }));
  const states = ["critical", "unknown", "minor", "same"];
  return {
    workspace: { restoreEnabled: true },
    scopes: [
      { id: "subscription", parentId: null, kind: "subscription" },
      { id: "rg", parentId: "subscription", kind: "resourceGroup" },
    ],
    resources, current: Object.fromEntries(resources.map((resource, index) => [
      resource.id.toLowerCase(), { status: index === 1 ? "error" : "present", raw: {} },
    ])),
    runs: [
      { id: "safety", kind: "safety", status: "Captured", snapshots: [] },
      { id: "baseline", kind: "manual", status: "Captured", snapshots: resources.slice(0, 4).map((resource, index) => ({
        resourceId: resource.id, complete: true, restoreSupported: index !== 3,
        comparison: { status: states[index], reason: "server-verified", diffs: [] },
        raw: { tags: resource.tags },
      })) },
    ],
  };
}
test("type grouping preserves leaf IDs, filtering and collapsible typed parents", () => {
  const rows = rowsFor(state(), "baseline");
  const expanded = new Set(rows.map((row) => `type:${row.resource.type}`));
  const nodes = visibleTypeTree(rows, expanded);
  assert.equal(nodes.filter((node) => node.kind === "scope").length, 2);
  assert.equal(nodes.filter((node) => node.kind === "resource").length, 4);
  assert.ok(nodes.filter((node) => node.kind === "resource").every((node) =>
    node.parentId === `type:${node.row.resource.type}` && node.level === 2));
  assert.equal(visibleTypeTree(rows, new Set()).length, 2);
  assert.equal(visibleTypeTree(rows.filter((row) => row.resource.type === "vnet"), expanded).length, 2);
});
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test("scope notice is acknowledged per tab and reappears when the scope or archive changes", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const workspace = { scope: "/lab", readScope: "/subscription", archiveMode: "local", restoreEnabled: true };
  assert.equal(scopeNoticeRequired(storage, workspace), true);
  acknowledgeScopeNotice(storage, workspace);
  assert.equal(scopeNoticeRequired(storage, { ...workspace }), false);
  for (const change of [{ scope: "/another-lab" }, { readScope: "/another-subscription" }, { archiveMode: "blob" }, { restoreEnabled: false }]) {
    assert.equal(scopeNoticeRequired(storage, { ...workspace, ...change }), true);
  }
  assert.equal(scopeNoticeRequired({ getItem: () => null }, workspace), true);
});

test("notice storage failures are explicit rather than treated as acknowledgement", () => {
  const storage = {
    getItem: () => { throw new DOMException("Blocked", "SecurityError"); },
    setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
  };
  assert.throws(() => scopeNoticeRequired(storage, {}), { name: "SecurityError" });
  assert.throws(() => acknowledgeScopeNotice(storage, {}), { name: "QuotaExceededError" });
});
function scopeState() {
  const sub = "/subscriptions/unit";
  const group = `${sub}/resourceGroups/one`, other = `${sub}/resourceGroups/two`;
  const mg = "/providers/Microsoft.Management/managementGroups/root";
  return {
    workspace: { scope: group, subscription: "unit" },
    scopes: [
      { id: mg, parentId: null, kind: "managementGroup", name: "Root" },
      { id: sub, parentId: mg, kind: "subscription", name: "Unit" },
      { id: group, parentId: sub, kind: "resourceGroup", name: "One" },
      { id: other, parentId: sub, kind: "resourceGroup", name: "Two" },
      { id: `${sub}/resourceGroups/empty`, parentId: sub, kind: "resourceGroup", name: "Empty" },
    ],
    resources: [
      { id: `${group}/providers/Microsoft.Network/networkSecurityGroups/a`, groupId: group, name: "a" },
      { id: `${group}/providers/Microsoft.Network/networkSecurityGroups/b`, groupId: group, name: "b" },
      { id: `${other}/providers/Microsoft.Network/networkSecurityGroups/c`, groupId: other, name: "c" },
    ],
  };
}

test("management group and subscription choices include all authorized descendants and empty groups", () => {
  const value = scopeState(), mg = value.scopes[0].id, sub = value.scopes[1].id;
  for (const id of [mg, sub]) {
    const policy = { scopeIds: togglePolicyScope(value, { scopeIds: [] }, id, true) };
    assert.ok(value.resources.every((resource) => policyMatchesScope(value, resource, policy)));
    const choices = policySelection(value, policy);
    assert.ok(choices.every((node) => node.checked));
    assert.equal(choices.length, 5);
    assert.ok(choices.every((node) => node.kind !== "resource"));
  }
});

test("unchecking one resource under a selected subscription preserves siblings and partial ancestors", () => {
  const value = scopeState(), sub = value.scopes[1].id, resource = value.resources[0];
  const policy = { scopeIds: togglePolicyScope(value, { scopeIds: [sub] }, resource.id, false) };
  assert.ok(!policyMatchesScope(value, resource, policy));
  assert.ok(value.resources.slice(1).every((item) => policyMatchesScope(value, item, policy)));
  const choices = policySelection(value, policy);
  assert.ok(choices.filter((node) => ["managementGroup", "subscription"].includes(node.kind))
    .every((node) => node.indeterminate && !node.checked));
  policy.scopeIds = togglePolicyScope(value, policy, sub, false);
  assert.deepEqual(policy.scopeIds, []);
});

test("legacy LAB selection stays confined and contained children follow their parent", () => {
  const value = scopeState(), parent = value.resources[0];
  value.resources.push({ id: parent.id + "/securityRules/allow", groupId: parent.groupId, name: "allow" });
  const oldPolicy = { scopeIds: ["resource-group"] };
  assert.equal(policyMatchesScope(value, value.resources[2], oldPolicy), false);
  const selected = { scopeIds: [parent.id.toUpperCase()] };
  assert.equal(policyMatchesScope(value, value.resources.at(-1), selected), true);
  selected.scopeIds = togglePolicyScope(value, selected, parent.id, false);
  assert.deepEqual(selected.scopeIds, []);
});

test("hiding resource choices preserves individual policies and their partial group state", () => {
  const value = scopeState(), policy = { scopeIds: [value.resources[0].id] };
  const original = structuredClone(policy);
  const choices = policySelection(value, policy);
  assert.deepEqual(policy, original);
  assert.ok(choices.every((node) => node.kind !== "resource"));
  const group = choices.find((node) => node.id === value.resources[0].groupId);
  assert.equal(group.checked, false);
  assert.equal(group.indeterminate, true);
  assert.equal(value.resources.filter((resource) => policyMatchesScope(value, resource, policy)).length, 1);
});
test("live rows use server comparison decisions without recomputing from demo data", () => {
  const value = state();
  const rows = rowsFor(value, "baseline");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].reason, "server-verified");
  assert.deepEqual(rows.map((row) => row.status), ["unknown", "critical", "minor", "same"]);
  delete value.runs[1].snapshots[0].comparison;
  assert.throws(() => rowsFor(value, "baseline"), ConsoleError);
});

test("on-call, change, customer, type and search filters keep distinct unknown semantics", () => {
  const value = state();
  assert.equal(rowsFor(value, "baseline", { status: WORKFLOWS.oncall.status }).length, 2);
  assert.equal(rowsFor(value, "baseline", { status: "changed" }).length, 2);
  assert.equal(rowsFor(value, "baseline", { customer: "alpha" }).length, 2);
  assert.equal(rowsFor(value, "baseline", { query: "network-ops", type: "vnet" }).length, 1);
  const ordered = rowsFor(value, "baseline", { priority: true });
  assert.deepEqual(ordered.map((row) => row.status), ["critical", "unknown", "minor", "same"]);
  const tree = visibleTree(value, ordered, new Set(["subscription", "rg"]));
  assert.deepEqual(tree.slice(0, 2).map((node) => node.kind), ["scope", "scope"]);
  assert.equal(tree[2].row.status, "critical");
});

test("restoration eligibility explains supported type, completeness, permission and current-state gates", () => {
  const value = state();
  const rows = rowsFor(value, "baseline");
  assert.equal(restoreAvailability(value, rows.find((row) => row.resource.name === "edge")).allowed, true);
  assert.equal(restoreAvailability(value, rows.find((row) => row.resource.name === "app")).allowed, false);
  assert.match(restoreAvailability(value, rows.find((row) => row.resource.name === "vnet")).reason, /비교만/);
  assert.equal(restoreAvailability(value, { ...rows[0], snapshot: { complete: false } }).allowed, false);
  value.workspace.restoreEnabled = false;
  assert.match(restoreAvailability(value, rows[0]).reason, /허용하지/);
});

test("current-only resources are not mixed into backup leaves and initial baseline skips safety runs", () => {
  const value = state();
  assert.equal(currentOnly(value, "baseline")[0].name, "current-only");
  assert.equal(initialRun(value), "baseline");
  assert.equal(initialRun(value, "safety"), "safety");
  assert.equal(initialRun({ runs: [] }), "");
});

test("latest-resource view preserves provenance and historical baseline selection", () => {
  const value = state();
  value.latestView = { id: "latest", snapshots: value.runs[1].snapshots.map(
    (snapshot) => ({ ...snapshot, sourceRunId: "baseline" }),
  ) };
  assert.equal(initialRun(value), "latest");
  assert.equal(initialRun(value, "baseline"), "baseline");
  assert.equal(rowsFor(value, "latest")[0].snapshot.sourceRunId, "baseline");
  assert.equal(currentOnly(value, "latest").length, 1);
});

test("latest view surfaces never-backed current resources without fabricating restorable snapshots", () => {
  const value = state();
  value.latestView = { id: "latest", snapshots: [] };
  const rows = rowsFor(value, "latest");
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.snapshot.viewOnly && !row.snapshot.complete && row.snapshot.capturedAt === null));
  value.runs = [];
  assert.equal(initialRun(value), "latest");
});

test("the review form requires a ticket, reason, mode and safe new name", () => {
  const valid = { resourceId: "/scope/edge", runId: "baseline", mode: "create",
    targetName: "nsg-restored", ticket: " CHG-1 ", reason: " approved repair " };
  assert.equal(validateReview(valid).ticket, "CHG-1");
  for (const invalid of [{ ...valid, ticket: "" }, { ...valid, reason: "a" },
    { ...valid, mode: "upsert" }, { ...valid, targetName: "../escape" }, { ...valid, runId: "" }]) {
    assert.throws(() => validateReview(invalid), ConsoleError);
  }
});

test("only explicit live sessions are accepted; demo is never an error fallback", async () => {
  const client = new LiveClient(async () => response({ mode: "design-preview" }));
  await assert.rejects(client.connect(), /예시 데이터로 대체하지/);
  assert.equal(client.session, null);
});

test("server-side Azure tokens are not requested or attached to the browser API", async () => {
  const calls = [];
  const client = new LiveClient(async (path, options) => {
    calls.push({ path, options });
    return response(path === "/api/session" ? {
      mode: "live-lab", sessionToken: "test-local-session-token", workspace: { scope: "/scope" },
    } : { mode: "live-lab", runs: [], resources: [] });
  });
  await client.connect();
  await client.state();
  assert.equal(calls[1].options.headers["X-Console-Token"], "test-local-session-token");
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.ok(calls.every((call) => call.path.startsWith("/api/")));
});

test("operations submit exactly once, poll by job ID, and surface terminal failures without retrying writes", async () => {
  const calls = [];
  const client = new LiveClient(async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/restore") return response({ id: "job-1", action: "restore", status: "Queued", phase: "queued" });
    return response({ id: "job-1", status: "Failed", error: "Write status unknown", writeAttempted: true,
      safetyRunId: "safety-1", warning: "No rollback" });
  });
  const progress = [];
  await assert.rejects(client.operation("restore", { planId: "plan-1" }, (job) => progress.push(job), async () => {}), /실패는 롤백/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(calls[1].path, "/api/jobs/job-1");
  assert.equal(progress.length, 2);
});

test("successful jobs report their server-confirmed result", async () => {
  const client = new LiveClient(async (path) => response(path === "/api/backup"
    ? { id: "job-2", status: "Queued" }
    : { id: "job-2", status: "Succeeded", result: { runId: "actual-run", capturedCount: 4 } }));
  const result = await client.operation("backup", {}, () => {}, async () => {});
  assert.equal(result.result.runId, "actual-run");
});

test("HTTP, malformed JSON and transport errors are explicit, not empty successful state", async () => {
  await assert.rejects(new LiveClient(async () => response({ error: "Permission denied" }, 403)).state(), /Permission denied/);
  await assert.rejects(new LiveClient(async () => ({ json: async () => { throw new SyntaxError("invalid"); } })).state(), /올바른 JSON/);
  await assert.rejects(new LiveClient(async () => { throw new TypeError("disconnected"); }).state(), /재실행하지 말고/);
  assert.match(readableJob({ action: "restore", phase: "safety-backup" }), /안전 백업/);
});
