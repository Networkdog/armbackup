import assert from "node:assert/strict";
import test from "node:test";
import { createDemoState } from "../src/armbackup/ui_static/demo-data.mjs";
import {
  STORAGE_KEY, DemoError, DemoStore, normalize, diffValues, compareResource,
  comparisonRows, visibleTree, matchesPolicy, savePolicy, makeTargetId,
  prepareRestore, executeRestore, queryLogs, logQueryExample,
} from "../src/armbackup/ui_static/model.mjs";

const NOW = new Date("2026-10-31T01:24:00Z");
class MemoryStorage {
  values = new Map();
  writes = 0;
  failAt = Infinity;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    this.writes++;
    if (this.writes === this.failAt) throw new DOMException("Test storage full", "QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key) { this.values.delete(key); }
}
function setup() {
  const storage = new MemoryStorage();
  const store = new DemoStore(storage, NOW);
  return { storage, store, state: store.state };
}
function resource(state, name) { return state.resources.find((item) => item.name === name); }
function updatePlan(state, name = "nsg-prod-web", runId = state.runs[0].id) {
  return prepareRestore(state, { resourceId: resource(state, name).id, runId, mode: "update" });
}
function createPlan(state, source = "nsg-prod-web", name = "nsg-restored") {
  const item = resource(state, source);
  return prepareRestore(state, { resourceId: item.id, runId: state.runs[0].id, mode: "create", groupId: item.groupId, name });
}

test("the baseline has exactly 12 backup resource leaves and all five status categories", () => {
  const { state } = setup();
  const rows = comparisonRows(state, state.runs[0].id);
  assert.equal(rows.length, 12);
  assert.deepEqual(Object.fromEntries(["same", "critical", "warning", "minor", "unknown"].map(
    (status) => [status, rows.filter((row) => row.status === status).length],
  )), { same: 6, critical: 2, warning: 2, minor: 1, unknown: 1 });
  assert.equal(state.resources.length, 13);
  assert.ok(!rows.some((row) => row.resource.name === "appi-prod-api"));
});

test("403 is unknown, confirmed absence is red, and unconfirmed absence is not deletion", () => {
  const { state } = setup();
  const rows = comparisonRows(state, state.runs[0].id);
  assert.equal(rows.find((row) => row.resource.name === "sql-prod-primary").status, "unknown");
  const missing = rows.find((row) => row.resource.name === "pip-prod-legacy");
  assert.equal(missing.status, "critical");
  assert.equal(compareResource(missing.snapshot, { ...missing.observation, confirmed: false }, missing.resource.type).status, "unknown");
});

test("incomplete backups, redaction, API version differences, and pending lookups cannot be green", () => {
  const { state } = setup();
  const same = comparisonRows(state, state.runs[0].id).find((row) => row.status === "same");
  for (const result of [
    compareResource(same.snapshot, same.observation, same.resource.type, "Incomplete"),
    compareResource({ ...same.snapshot, complete: false }, same.observation, same.resource.type),
    compareResource(same.snapshot, { ...same.observation, redacted: true }, same.resource.type),
    compareResource(same.snapshot, { ...same.observation, apiVersion: "other" }, same.resource.type),
    compareResource(same.snapshot, { status: "pending" }, same.resource.type),
  ]) assert.equal(result.status, "unknown");
});

test("object key order is immaterial, but missing, null, false, and array order differ", () => {
  assert.equal(diffValues({ a: 1, b: null }, { b: null, a: 1 }).length, 0);
  assert.equal(diffValues({}, { a: null }).length, 1);
  assert.equal(diffValues({ a: false }, { a: null }).length, 1);
  assert.equal(diffValues({ a: [] }, { a: {} }).length, 1);
  assert.equal(diffValues([1, 2], [2, 1]).length, 2);
  const diff = diffValues({}, { a: null })[0];
  assert.equal(diff.beforePresent, false);
  assert.equal(diff.afterPresent, true);
});

test("only reviewed named arrays are sorted; duplicate rule names are rejected", () => {
  const type = "Microsoft.Network/networkSecurityGroups";
  const a = { properties: { securityRules: [{ name: "b" }, { name: "a" }] } };
  const b = { properties: { securityRules: [{ name: "a" }, { name: "b" }] } };
  assert.deepEqual(normalize(a, type), normalize(b, type));
  assert.notDeepEqual(normalize(a, "Other/type"), normalize(b, "Other/type"));
  assert.throws(() => normalize({ properties: { securityRules: [{ name: "a" }, { name: "A" }] } }, type), DemoError);
});

test("tree collapse removes children, search keeps the management-group ancestor path", () => {
  const { state } = setup();
  const rows = comparisonRows(state, state.runs[0].id);
  const folded = visibleTree(state, rows, new Set());
  assert.equal(folded.length, 1);
  assert.equal(folded[0].scope.kind, "managementGroup");
  const expanded = visibleTree(state, rows, new Set(state.scopes.map((scope) => scope.id)));
  assert.equal(expanded.filter((node) => node.kind === "resource").length, 12);
  const filtered = comparisonRows(state, state.runs[0].id, { query: "nsg-prod-web" });
  const nodes = visibleTree(state, filtered, new Set(state.scopes.map((scope) => scope.id)));
  assert.deepEqual(nodes.map((node) => node.level), [1, 2, 3, 4]);
  assert.deepEqual(nodes.slice(0, 3).map((node) => node.scope.kind), ["managementGroup", "subscription", "resourceGroup"]);
});

test("status, type, scope and AND-tag filters are applied consistently", () => {
  const { state } = setup();
  assert.equal(comparisonRows(state, state.runs[0].id, { status: "changed" }).length, 5);
  const item = resource(state, "nsg-prod-web");
  const raw = state.current[item.id.toLowerCase()].raw;
  const policy = { scopeIds: ["sub-prod"], types: [item.type], tags: [{ key: "ENVIRONMENT", operator: "equals", value: "prod" }, { key: "owner", operator: "exists", value: "" }] };
  assert.equal(matchesPolicy(state, item, raw, policy), true);
  assert.equal(matchesPolicy(state, item, raw, { ...policy, scopeIds: ["sub-dev"] }), false);
  assert.equal(matchesPolicy(state, item, raw, { ...policy, tags: [{ key: "environment", operator: "equals", value: "Prod" }] }), false);
  state.policy = policy;
  assert.equal(comparisonRows(state, state.runs[0].id, { targetOnly: true }).length, 1);
});

test("settings persist across reloads; empty scope, empty types and invalid tags are explicit errors", () => {
  const { store, storage } = setup();
  const policy = { ...store.state.policy, scopeIds: ["sub-dev"], tags: [{ key: "owner", operator: "exists", value: "" }] };
  savePolicy(store, policy);
  assert.deepEqual(new DemoStore(storage).state.policy, policy);
  assert.equal(store.state.logs[0].event, "policy_saved");
  for (const invalid of [{ ...policy, scopeIds: [] }, { ...policy, types: [] }, { ...policy, tags: [{ key: "", operator: "equals", value: "" }] }]) {
    assert.throws(() => savePolicy(store, invalid), DemoError);
  }
});

test("a full resource ID selects only that resource, not its siblings or all of its resource group", () => {
  const { store, storage } = setup();
  const item = resource(store.state, "nsg-prod-web");
  const policy = { ...store.state.policy, scopeIds: [item.id.toUpperCase()] };
  savePolicy(store, policy);
  assert.deepEqual(store.state.policy.scopeIds, [item.id]);
  assert.equal(matchesPolicy(store.state, item, {}, policy), true);
  assert.equal(matchesPolicy(store.state, resource(store.state, "nsg-dev-app"), {}, policy), false);
  const rows = comparisonRows(new DemoStore(storage).state, store.state.runs[0].id, { targetOnly: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource.id, item.id);
});
test("new targets and update targets have opposite existence requirements", () => {
  const { state } = setup();
  assert.throws(() => createPlan(state, "nsg-prod-web", "nsg-prod-web"), /이미 있거나/);
  assert.throws(() => updatePlan(state, "pip-prod-legacy"), /존재하지/);
  assert.throws(() => updatePlan(state, "sql-prod-primary"), /현재 상태/);
  assert.throws(() => createPlan(state, "sql-prod-primary"), /현재 상태/);
  assert.throws(() => makeTargetId(state, resource(state, "nsg-prod-web"), "rg-network", "../escape"), DemoError);
  assert.throws(() => prepareRestore(state, { resourceId: resource(state, "nsg-prod-web").id, runId: state.runs[0].id, mode: "upsert" }), DemoError);
  assert.equal(createPlan(state, "pip-prod-legacy", "pip-prod-legacy").mode, "create");
});

test("update stores an exact current safety snapshot BEFORE applying the selected backup", async () => {
  const { store, storage } = setup();
  const plan = updatePlan(store.state);
  const before = structuredClone(store.state.current[plan.sourceId.toLowerCase()].raw);
  const phases = [];
  const result = await executeRestore(store, plan, async (phase) => {
    phases.push(phase);
    if (phase === "safety") {
      assert.deepEqual(store.state.current[plan.sourceId.toLowerCase()].raw, before);
      assert.deepEqual(store.state.runs[0].snapshots[0].raw, before);
      assert.deepEqual(new DemoStore(storage).state.runs[0].snapshots[0].raw, before);
    }
  }, NOW);
  assert.deepEqual(phases, ["checking", "safety", "applied"]);
  assert.equal(store.state.runs[0].id, result.safetyId);
  assert.equal(store.state.runs.length, 4);
  assert.equal(comparisonRows(store.state, plan.runId).find((row) => row.resource.id === plan.sourceId).status, "same");
  assert.equal(new DemoStore(storage).state.logs[0].event, "restore_completed");
});

test("failure to persist the pre-restore safety backup prevents ALL resource mutation", async () => {
  const { store, storage } = setup();
  const before = structuredClone(store.state);
  const plan = updatePlan(store.state);
  storage.failAt = storage.writes + 1;
  await assert.rejects(executeRestore(store, plan), /브라우저 저장에 실패/);
  assert.deepEqual(store.state, before);
  assert.deepEqual(new DemoStore(storage).state, before);
});

test("failure to persist the applied result preserves the safety backup and original current state", async () => {
  const { store, storage } = setup();
  const plan = updatePlan(store.state);
  const before = structuredClone(store.state.current);
  storage.failAt = storage.writes + 2;
  await assert.rejects(executeRestore(store, plan), /브라우저 저장에 실패/);
  assert.equal(store.state.runs[0].kind, "safety");
  assert.deepEqual(store.state.current, before);
  assert.deepEqual(new DemoStore(storage).state.current, before);
  assert.ok(!store.state.logs.some((log) => log.event === "restore_completed"));
});

test("new creation preserves source and records target absence before adding the new current resource", async () => {
  const { store } = setup();
  const plan = createPlan(store.state);
  const before = structuredClone(store.state.current[plan.sourceId.toLowerCase()]);
  const result = await executeRestore(store, plan, async (phase) => {
    if (phase === "safety") assert.equal(store.state.current[plan.targetId.toLowerCase()], undefined);
  }, NOW);
  assert.equal(result.mode, "create");
  assert.deepEqual(store.state.current[plan.sourceId.toLowerCase()], before);
  assert.equal(store.state.current[plan.targetId.toLowerCase()].raw.id, plan.targetId);
  assert.equal(store.state.runs[0].absences[0].resourceId, plan.targetId);
  assert.equal(store.state.resources.length, 14);
});

test("creation of a deleted resource records absence without inventing a current configuration", async () => {
  const { store } = setup();
  const plan = createPlan(store.state, "pip-prod-legacy", "pip-prod-legacy");
  await executeRestore(store, plan, undefined, NOW);
  assert.equal(store.state.runs[0].snapshots.length, 0);
  assert.equal(store.state.runs[0].absences.length, 1);
  assert.equal(comparisonRows(store.state, plan.runId).find((row) => row.resource.id === plan.sourceId).status, "same");
});

test("date selection applies the chosen historical backup rather than the newest one", async () => {
  const { store } = setup();
  const id = resource(store.state, "nsg-prod-web").id;
  const historical = store.state.runs[2];
  historical.snapshots.find((snapshot) => snapshot.resourceId === id).raw.tags.history = "old";
  const plan = updatePlan(store.state, "nsg-prod-web", historical.id);
  await executeRestore(store, plan, undefined, NOW);
  assert.equal(store.state.current[id.toLowerCase()].raw.tags.history, "old");
});

test("stale or modified plans cannot mutate resources, including changes between safety and apply", async () => {
  const { store } = setup();
  const plan = updatePlan(store.state);
  const tampered = structuredClone(plan);
  tampered.snapshot.raw.tags.tampered = "yes";
  await assert.rejects(executeRestore(store, tampered), /실행 입력이 다릅니다/);
  await assert.rejects(executeRestore(store, plan, async (phase) => {
    if (phase === "safety") savePolicy(store, store.state.policy);
  }), /안전 백업 이후/);
  assert.equal(store.state.runs[0].kind, "safety");
  assert.equal(comparisonRows(store.state, plan.runId).find((row) => row.resource.id === plan.sourceId).status, "critical");
  await assert.rejects(executeRestore(store, plan), /검토 이후/);
});

test("another tab's persisted change is not silently overwritten", () => {
  const { store, storage } = setup();
  const other = new DemoStore(storage);
  savePolicy(other, { ...other.state.policy, scopeIds: ["sub-dev"] });
  assert.throws(() => savePolicy(store, store.state.policy), /다른 탭/);
});

test("invalid saved data is reported and never overwritten by a successful-looking reset", () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, "{bad-json");
  assert.throws(() => new DemoStore(storage), /읽을 수 없습니다/);
  assert.equal(storage.getItem(STORAGE_KEY), "{bad-json");
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999 }));
  assert.throws(() => new DemoStore(storage), /형식이 올바르지/);
});

test("logs filter by time, level and search while preserving chronological ordering", () => {
  const { state } = setup();
  assert.equal(queryLogs(state, { days: 1, level: "Error" }, NOW).length, 0);
  assert.equal(queryLogs(state, { days: 7, level: "Error" }, NOW).length, 1);
  assert.equal(queryLogs(state, { query: "AuthorizationFailed" }, NOW).length, 0);
  assert.equal(queryLogs(state, { query: "sql-prod-primary" }, NOW).length, 1);
  const logs = queryLogs(state, { days: 7 }, NOW);
  assert.equal(logs[0].event, "comparison_unconfirmed");
  assert.ok(logs.every((log) => log.source.includes("예시")));
});

test("the illustrative KQL uses existing ingestion columns and escapes text without executing it", () => {
  const query = logQueryExample({ days: 7, level: "Warning", query: "a'b\\c\n" });
  assert.ok(query.includes("ago(7d)"));
  assert.ok(query.includes("Level == 'Warning'"));
  assert.ok(query.includes("a\\'b\\\\c\\n"));
  assert.ok(query.includes("tostring(Details)"));
  assert.ok(query.includes("RunId contains"));
  assert.ok(!query.includes("Message"));
  assert.equal(query.split("\n").at(-1), "| take 200");
  assert.throws(() => logQueryExample({ days: -1 }), DemoError);
  assert.throws(() => logQueryExample({ level: "Other" }), DemoError);
});
