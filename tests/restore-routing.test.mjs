import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("calendar-to-Gateway review preserves the historical run instead of the latest aggregate", () => {
  const row = { resource: { id: "/gateway", type: "microsoft.network/applicationgateways" },
    snapshot: {}, observation: { status: "present" } };
  const context = vm.createContext({
    ui: { runId: "latest" }, state: {}, location: { hash: "#restore" },
    bundlePreferences: null, renders: 0,
    selectedRow: () => row, rowsFor: (_, id) => { assert.equal(id, "historical-run"); return [row]; },
    restoreAvailability: () => ({ allowed: true }),
    render: () => context.renders++,
  });
  vm.runInContext(functionSource("function openBundle(", "function renderRestoreCalendar("), context);
  vm.runInContext(functionSource("function startRestore(", "function renderRestore()"), context);
  context.startRestore("/gateway", "historical-run", true);
  assert.equal(context.bundlePreferences.runId, "historical-run");
  assert.equal(context.ui.restore.bundle, true);
  assert.equal(context.location.hash, "#restore");
  assert.equal(context.renders, 1);
});

test("status start-restore opens the restore plan immediately and keeps navigation open when view cache is stale", () => {
  const restoreBtn = { disabled: true, title: "" };
  const hintEl = { innerHTML: "", textContent: "" };
  const row = {
    resource: { id: "/lb-1", name: "lb-prod", type: "microsoft.network/loadbalancers" },
    snapshot: { sourceRunId: "20261117T010000Z-abcdef123456", complete: true, restoreSupported: true },
    observation: { status: "present" },
  };
  const context = vm.createContext({
    ui: { runId: "latest", selected: "/lb-1", busy: false, stale: true, restore: null, restoreTarget: "" },
    state: { workspace: { restoreEnabled: true } },
    location: { hash: "#status" },
    bundlePreferences: null, historyPreferences: null, bundlePanel: null,
    viewNeedsRender: false, viewError: null, session: null,
    $: (sel) => sel === ".environment-pill" ? { classList: { toggle() {} } }
      : sel.includes("start-restore") ? restoreBtn
        : sel === "#selection-hint" ? hintEl : null,
    $$: () => [],
    notifier: { notify() {}, dismiss() {} },
    esc: (v) => String(v), date: (v) => v, timezone: () => "KST", relativeTime: () => "1분 전",
    legacyPolicyTypes: () => [], snapshotHealth: () => ({ stale: true, message: "" }),
    selectedRow: () => row,
    restoreAvailability: () => ({ allowed: true, cloneAllowed: true, reason: "단일 또는 관계 묶음을 선택하고 검토 계획·티켓·안전 백업 후 적용합니다." }),
    browseBackups: () => { throw new Error("should open bundle directly"); },
    render: () => {},
  });
  vm.runInContext(functionSource("function syncViewStatus()", "function renderRefreshedView()"), context);
  vm.runInContext(functionSource("function openBundle(", "function renderRestoreCalendar("), context);
  context.syncViewStatus();
  assert.equal(restoreBtn.disabled, false);
  assert.match(hintEl.innerHTML, /최신 ARM 상태 확인 전/);

  const startBranch = source.slice(source.indexOf('if (name === "start-restore")'), source.indexOf('if (name === "restore-next")'));
  vm.runInContext(`(() => { const name = "start-restore"; ${startBranch} })()`, context);
  assert.equal(context.location.hash, "restore");
  assert.equal(context.ui.restore?.bundle, true);
  assert.equal(context.ui.restore?.runId, "20261117T010000Z-abcdef123456");
  assert.equal(context.historyPreferences?.selectedRunId, "20261117T010000Z-abcdef123456");
});
