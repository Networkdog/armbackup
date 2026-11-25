import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { hideTooltip, initActionTooltips, syncTooltipTarget } from "../src/armbackup/ui_static/action-tooltip.mjs";
import { restoreAvailability } from "../src/armbackup/ui_static/live-client.mjs";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const demoSource = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
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

test("status restore button uses aria-disabled with exact tooltip reason when a selected backup item cannot be restored", () => {
  const attrs = new Map();
  const restoreBtn = {
    disabled: true,
    title: "",
    dataset: {},
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
  };
  const hintEl = { innerHTML: "", textContent: "" };
  let activeRow = null;
  const state = { workspace: { restoreEnabled: true } };
  const context = vm.createContext({
    ui: { runId: "latest", selected: null, busy: false, stale: false, restore: null, restoreTarget: "" },
    state,
    location: { hash: "#status" },
    bundlePreferences: null, historyPreferences: null, bundlePanel: null,
    viewNeedsRender: false, viewError: null, session: null,
    $: (sel) => sel === ".environment-pill" ? { classList: { toggle() {} } }
      : sel.includes("start-restore") ? restoreBtn
        : sel === "#selection-hint" ? hintEl : null,
    $$: () => [],
    notifier: { notify() {}, dismiss() {} },
    esc: (v) => String(v), date: (v) => v, timezone: () => "KST", relativeTime: () => "1분 전",
    legacyPolicyTypes: () => [], snapshotHealth: () => ({ stale: false, message: "" }),
    selectedRow: () => activeRow,
    restoreAvailability,
    browseBackups: () => { throw new Error("disabled button must not navigate"); },
    openBundle: () => { throw new Error("disabled button must not open bundle"); },
    render: () => {},
  });
  vm.runInContext(functionSource("function syncViewStatus()", "function renderRefreshedView()"), context);
  const startBranch = source.slice(source.indexOf('if (name === "start-restore")'), source.indexOf('if (name === "restore-next")'));

  // 1. Nothing selected
  context.syncViewStatus();
  assert.equal(restoreBtn.disabled, false);
  assert.equal(restoreBtn.getAttribute("aria-disabled"), "true");
  assert.equal(restoreBtn.getAttribute("data-tooltip"), "복원할 백업 항목을 먼저 선택해 주세요.");

  // 2. Comparison-only resource selected (e.g. Virtual Network)
  activeRow = {
    resource: { id: "/vnet-1", name: "vnet-prod", type: "microsoft.network/virtualnetworks" },
    snapshot: { complete: true, restoreSupported: false, blockedReason: "No reviewed restore field contract for this type" },
    observation: { status: "present" },
  };
  context.ui.selected = "/vnet-1";
  context.syncViewStatus();
  assert.equal(restoreBtn.disabled, false);
  assert.equal(restoreBtn.getAttribute("aria-disabled"), "true");
  assert.match(restoreBtn.getAttribute("data-tooltip"), /비교만 지원합니다.*검토된 복원 프로필이 없는 리소스 종류입니다/);
  vm.runInContext(`(() => { const name = "start-restore"; ${startBranch} })()`, context);
  assert.equal(context.location.hash, "#status");

  // 3. Unbacked live resource selected
  activeRow = {
    resource: { id: "/agw-unbacked", name: "agw-unbacked", type: "microsoft.network/applicationgateways" },
    snapshot: { complete: false, viewOnly: true, restoreSupported: false },
    observation: { status: "present" },
  };
  context.syncViewStatus();
  assert.equal(restoreBtn.getAttribute("aria-disabled"), "true");
  assert.match(restoreBtn.getAttribute("data-tooltip"), /보관된 검증 백업이 없습니다/);

  // 4. Demo preview mode explains why a selected resource is not restorable
  const demoReasonFn = demoSource.slice(demoSource.indexOf("function restorable("), demoSource.indexOf("function currentOnly("));
  const demoCtx = vm.createContext({ ui: { restore: { busy: false } } });
  vm.runInContext(demoReasonFn, demoCtx);
  assert.match(
    demoCtx.demoRestoreReason(
      { snapshot: { complete: true, redacted: false }, observation: { status: "error", code: "AuthorizationFailed" } },
      { status: "Captured" },
    ),
    /AuthorizationFailed/,
  );
  assert.equal(
    demoCtx.demoRestoreReason(
      { snapshot: { complete: true, redacted: false }, observation: { status: "present" } },
      { status: "Captured" },
    ),
    "",
  );
});

test("action tooltip opens on hover/focus, stays open while hovered, dismisses on Escape, and blocks aria-disabled clicks", () => {
  const listeners = new Map();
  let appendedTooltip = null;
  const makeElement = (tag, attrs = {}) => {
    const map = new Map(Object.entries(attrs));
    const el = {
      tagName: tag.toUpperCase(),
      id: attrs.id || "",
      className: attrs.class || "",
      hidden: false,
      textContent: "",
      dataset: {},
      isConnected: true,
      style: { props: new Map(), setProperty(k, v) { this.props.set(k, v); } },
      setAttribute(k, v) { map.set(k, String(v)); if (k === "id") this.id = String(v); },
      getAttribute(k) { return map.get(k) ?? null; },
      removeAttribute(k) { map.delete(k); },
      hasAttribute(k) { return map.has(k); },
      getBoundingClientRect: () => ({ left: 900, top: 700, right: 1040, bottom: 736, width: 140, height: 36 }),
      contains(other) { return other === el; },
      closest(sel) {
        if (sel === "#action-tooltip" && this.id === "action-tooltip") return this;
        if (sel === "[data-tooltip]" && map.has("data-tooltip")) return this;
        if (sel === '[aria-disabled="true"]' && map.get("aria-disabled") === "true") return this;
        return null;
      },
    };
    return el;
  };
  const doc = {
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    defaultView: { addEventListener() {} },
    body: { append(node) { appendedTooltip = node; } },
    getElementById: (id) => (appendedTooltip?.id === id ? appendedTooltip : null),
    createElement: (tag) => {
      const node = makeElement(tag);
      node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 260, bottom: 40, width: 260, height: 40 });
      return node;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  initActionTooltips(doc);
  assert.ok(appendedTooltip);
  assert.equal(appendedTooltip.getAttribute("role"), "tooltip");
  assert.equal(appendedTooltip.hidden, true);

  const btn = makeElement("button", {
    "aria-disabled": "true",
    "data-tooltip": "이 형상은 비교만 지원합니다. 검토된 복원 프로필이 없는 리소스 종류입니다.",
  });

  // Hover opens tooltip and wires aria-describedby
  for (const fn of listeners.get("pointerover")) fn({ target: btn });
  assert.equal(appendedTooltip.hidden, false);
  assert.match(appendedTooltip.textContent, /비교만 지원합니다/);
  assert.equal(btn.getAttribute("aria-describedby"), "action-tooltip");
  assert.equal(appendedTooltip.dataset.placement, "above");

  // Moving pointer onto tooltip keeps it open (WCAG 1.4.13)
  for (const fn of listeners.get("pointerout")) fn({ target: btn, relatedTarget: appendedTooltip });
  for (const fn of listeners.get("pointerover")) fn({ target: appendedTooltip });
  assert.equal(appendedTooltip.hidden, false);

  // Escape dismisses tooltip
  for (const fn of listeners.get("keydown")) fn({ key: "Escape", target: btn });
  assert.equal(appendedTooltip.hidden, true);
  assert.equal(btn.getAttribute("aria-describedby"), null);

  // Clicking aria-disabled button prevents execution and shows tooltip reason
  let prevented = false, stopped = false;
  for (const fn of listeners.get("click")) {
    fn({
      target: btn,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
  }
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(appendedTooltip.hidden, false);

  // Dynamic sync hides tooltip when button becomes enabled without caveat
  btn.removeAttribute("aria-disabled");
  btn.removeAttribute("data-tooltip");
  syncTooltipTarget(btn);
  assert.equal(appendedTooltip.hidden, true);
  hideTooltip();
});

test("background restore or clone never blocks menu navigation or browser close and offers a return link in progress notifications", () => {
  // 1) Menu navigation listener does not check ui.busy, and beforeunload only checks unsaved policy edits
  const clickListener = source.slice(source.indexOf('document.addEventListener("click"'), source.indexOf('$("#main").addEventListener("input"'));
  assert.doesNotMatch(clickListener, /link\s*&&\s*\(ui\.busy/);
  const beforeUnload = source.slice(source.indexOf('window.addEventListener("beforeunload"'), source.indexOf('window.addEventListener("beforeunload"') + 220);
  assert.doesNotMatch(beforeUnload, /ui\.busy/);

  // 2) renderOperation on another page includes an action button back to #restore while job runs in background
  const notices = [];
  const context = vm.createContext({
    ui: {
      page: "status",
      job: {
        id: "job-bg-99", action: "bundle-restore", operationMode: "clone", status: "Running", phase: "applying",
        totalCount: 2, completedCount: 1, currentStepIndex: 2, currentResourceName: "copy-agw",
        appliedResources: ["/pip"], safetyRunId: "safety-99",
      },
    },
    JOB_STATES: { Queued: "대기", Running: "진행 중", Succeeded: "완료", Failed: "실패" },
    location: { hash: "#status" },
    readableJob: () => "단일·묶음 복제 · ARM 적용·프로비저닝 대기 (2/2 · copy-agw)",
    notifier: { notify: (n) => notices.push(n), dismiss: () => {} },
    action: async () => {},
    showError: () => {},
  });
  vm.runInContext(functionSource("function renderOperation()", "async function refresh("), context);
  context.renderOperation();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "progress");
  assert.match(notices[0].message, /서버 백그라운드 수행 중/);
  assert.equal(notices[0].actions[0].label, "복원·복제 진행 보기");
  notices[0].actions[0].run();
  assert.equal(context.location.hash, "restore");
});


