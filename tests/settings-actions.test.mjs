import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ConsoleError } from "../src/armbackup/ui_static/live-client.mjs";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const policy = { scopeIds: ["/scope"], types: ["microsoft.network/loadbalancers"], tags: [] };

function harness({ fail = "", editDuringSave = false } = {}) {
  const calls = [], notifications = [], refreshes = [];
  const context = vm.createContext({
    state: { policy: { ...policy, scopeIds: ["/old"] } },
    ui: { policy: structuredClone(policy), busy: false, stale: false, page: "settings" },
    ConsoleError, clone: structuredClone, historyCache: {}, JSON, Date,
    render() {}, renderOperation() {}, renderSettings() {},
    date: () => "now", archiveLabel: () => "Azure Blob", toast: (text) => notifications.push(text),
    refresh: async (run) => refreshes.push(run),
    api: {
      async operation(action, payload, onProgress) {
        calls.push({ action, payload });
        if (fail === "save") throw new ConsoleError("대상 저장 실패 · 백업 미실행");
        const job = { policySaved: action === "backup", savedPolicy: structuredClone(policy),
          result: { capturedCount: 1, policy: structuredClone(policy) } };
        if (editDuringSave) context.ui.policy.tags.push({ key: "customer", operator: "exists" });
        onProgress(job);
        if (fail === "backup") throw new ConsoleError("대상 저장 완료 · 백업 실패");
        return job;
      },
    },
  });
  vm.runInContext(section("async function operation(", "function renderStatus()"), context);
  vm.runInContext(section("async function action(", 'document.addEventListener("click"'), context);
  return { context, calls, notifications, refreshes };
}

test("settings save and back up the draft in one operation without a preliminary save request", async () => {
  const h = harness();
  await h.context.action("save-backup", {});
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "backup");
  assert.equal(JSON.stringify(h.calls[0].payload.policy), JSON.stringify(policy));
  assert.equal(JSON.stringify(h.context.state.policy), JSON.stringify(policy));
  assert.deepEqual(h.refreshes, ["latest"]);
  assert.match(h.notifications[0], /대상을 저장하고 1개/);
  assert.equal(h.context.ui.busy, false);
});

test("saved policy remains acknowledged when backup fails, and later draft edits survive", async () => {
  for (const editDuringSave of [false, true]) {
    const h = harness({ fail: "backup", editDuringSave });
    await assert.rejects(h.context.action("save-backup", {}), /대상 저장 완료 · 백업 실패/);
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(h.context.state.policy), JSON.stringify(policy));
    assert.equal(h.context.ui.policy.tags.length, editDuringSave ? 1 : 0);
    assert.equal(h.context.ui.busy, false);
    assert.equal(h.notifications.length, 0);
  }
});

test("save failure leaves the existing saved policy untouched and does not report success", async () => {
  const h = harness({ fail: "save" });
  await assert.rejects(h.context.action("save-backup", {}), /대상 저장 실패 · 백업 미실행/);
  assert.equal(h.context.state.policy.scopeIds[0], "/old");
  assert.equal(h.notifications.length, 0);
  assert.equal(h.refreshes.length, 0);
});

test("save-only remains one policy operation and never starts a backup", async () => {
  const h = harness();
  await h.context.action("save-policy", {});
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "policy");
  assert.match(h.notifications[0], /대상 정책/);
});
