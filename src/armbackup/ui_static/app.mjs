import {
  STORAGE_KEY, STATUS, DemoError, DemoStore, ancestors, scopeResources, matchesScope, matchesPolicy,
  comparisonRows, compareResource, visibleTree, savePolicy, makeTargetId, prepareRestore, executeRestore, queryLogs, logQueryExample, previewStorageData,
} from "./model.mjs";
import {
  createStorageState, buildStorageIndex, defaultCollapsedDirs, defaultExpandedTableDirs, defaultInitialScope,
  buildStoragePaneNodes, storageTopbarHtml, storageBreadcrumbHtml, storageTableHtml,
  storageShellHtml, storageFooterText, blobDetailDialogHtml, selectStorageDirectory,
  toggleStorageTableDir, focusStorageRow, handleStorageTableKey, formatBytes, exactBytes,
} from "./storage-explorer.mjs";
import { HistoryPanel } from "./history-panel.mjs";
import { backupCalendarData } from "./backup-calendar.mjs";
import { createDemoHistory } from "./demo-history.mjs";
import { SUPPORTED_RESOURCES, officialPolicyTypes, legacyPolicyTypes, resourceBackupCompanions } from "./support-catalog.mjs";
import { BACKUP_STATUS, backupHealth, relativeTime, recentResourceDays, recentDaysHtml, recentLegendHtml } from "./backup-view.mjs";
import { visibleTypeTree, resourceNodes } from "./view-model.mjs";
import { createPaneState, buildPaneNodes, rowsInScope, renderTreePane, scopeBarHtml, bindTreePane, mountTreeArea } from "./tree-pane.mjs";
import { createNotifications } from "./notifications.mjs";
import { initActionTooltips, syncTooltipTarget } from "./action-tooltip.mjs";
import { initSidebarCollapse } from "./sidebar-collapse.mjs";
import { backupItems, restoreItem, restorePickerMetaHtml, restoreTargetHtml } from "./restore-target.mjs";
import { openPolicyScopePicker, openResourcePicker, openTargetLocationPicker, pickerTriggerHtml } from "./resource-picker.mjs";
import { CLONE_NAME_MODES, applySequenceName, azurePortalResourceUrl, nextSequenceToken, stepSequenceToken } from "./bundle-panel.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name, classes = "") => `<svg class="icon ${classes}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clone = (value) => structuredClone(value);
const notifier = createNotifications(document);
const errors = notifier;
notifier.watch($("#main"));
const PAGE_NAMES = { settings: "백업 대상", status: "백업 현황", restore: "복원·복제", logs: "로그", storage: "저장소" };
const KIND_NAMES = { managementGroup: "Management Group", subscription: "Subscription", resourceGroup: "Resource Group", resourceType: "리소스 종류" };
const RUN_NAMES = { scheduled: "일일 백업", safety: "복원 전 안전 백업" };
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function date(value, short = false) {
  if (!value) return "미확인";
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${short ? "" : `${parts.year}.`}${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}
function symbol(resource) {
  const type = resource.type.toLowerCase();
  const [name, color] = type.includes("storage") || type.includes("sql") ? ["storage", "storage"]
    : type.includes("keyvault") || type.includes("securitygroups") ? ["shield", "security"]
      : type.includes("network") ? ["network", "network"] : ["box", ""];
  return `<span class="resource-symbol ${color}">${icon(name)}</span>`;
}
const badge = (status) => `<span class="status-badge">${icon(status === "same" ? "check" : status === "unknown" ? "help" : "edit")}${status === "same" ? "형상 같음" : status === "unknown" ? "비교 미확인" : "형상 차이 있음"}</span>`;
const errorText = (error) => error instanceof DemoError ? error.message
  : `작업을 완료하지 못했습니다. (${error instanceof Error ? error.name : "UnknownError"}) 저장소와 브라우저 상태를 확인해 주세요.`;
let store;
let ui;
let allowUnload = false;
let historyPanel = null;
let historyPreferences = null;
let dialogTrigger = null;
let unmountTreeArea = null;
const narrowScreen = window.matchMedia("(max-width: 59.375em)");
initSidebarCollapse();
initActionTooltips(document);

function syncNavigation() {
  if (!narrowScreen.matches) $("#sidebar").classList.remove("mobile-open");
  const open = narrowScreen.matches && $("#sidebar").classList.contains("mobile-open");
  $("#sidebar").inert = narrowScreen.matches && !open;
  $("#menu-toggle").setAttribute("aria-expanded", open);
  $("#menu-toggle").setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
}

function toast(message, level = "success") {
  notifier.notify({ level, message });
}
function showError(error) {
  errors.show(errorText(error), [{ label: "새로고침", run: () => { allowUnload = true; location.reload(); } }]);
}
function dialog(title, content, actions = '<button class="button primary" data-dialog="close">확인</button>') {
  if (!$("#app-dialog").open) dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("#sidebar").classList.remove("mobile-open");
  syncNavigation();
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = content;
  $("#dialog-actions").innerHTML = actions;
  if (!$("#app-dialog").open) $("#app-dialog").showModal();
}
function empty(title, message) {
  return `<div class="empty-state">${icon("search")}<strong>${esc(title)}</strong>${esc(message)}</div>`;
}
function heading(title, actions = "") {
  return `<section class="page-heading"><h1>${title}</h1>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</section>`;
}
function restoreHeading() {
  return '<h1 class="sr-only">복원·복제</h1>';
}
function latestRun() {
  return store.state.runs.find((run) => run.kind === "scheduled");
}
function restorable(row, run) {
  return run?.status === "Captured" && row?.snapshot.complete && !row.snapshot.redacted
    && (row.observation?.status === "present" || (row.observation?.status === "missing" && row.observation.confirmed));
}
function demoRestoreReason(row, run) {
  if (!row) return "복원할 백업 항목을 먼저 선택해 주세요.";
  if (ui?.restore?.busy) return "예시 복원이 진행 중입니다. 저장이 끝난 뒤 다시 시도해 주세요.";
  if (run?.status !== "Captured") return "선택한 기준 백업이 불완전하여 복원할 수 없습니다. 완전한 기준 백업을 선택해 주세요.";
  if (!row.snapshot?.complete) return "완료 표식·무결성을 검증한 백업이 아니어서 복원할 수 없습니다.";
  if (row.snapshot.redacted) return "민감 속성이 제외된 백업이어서 원본 형상으로 복원할 수 없습니다.";
  if (row.observation?.status === "error") {
    return `현재 리소스 상태를 조회하지 못해(${row.observation.code || "조회 오류"}) 안전 백업과 복원을 진행할 수 없습니다.`;
  }
  if (!(row.observation?.status === "present" || (row.observation?.status === "missing" && row.observation.confirmed))) {
    return "현재 리소스의 존재 여부를 확인하지 못해 복원할 수 없습니다.";
  }
  return "";
}
function currentOnly(run) {
  const ids = new Set(run.snapshots.map((snapshot) => snapshot.resourceId.toLowerCase()));
  return store.state.resources.filter((resource) => !ids.has(resource.id.toLowerCase())
    && store.state.current[resource.id.toLowerCase()]?.status === "present");
}

function render() {
  unmountTreeArea?.();
  unmountTreeArea = null;
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); historyPanel = null; }
  const requested = location.hash.slice(1);
  if (requested === "history") {
    ui.restore = { resourceId: null, busy: false };
    window.history.replaceState(null, "", "#restore");
  }
  ui.page = requested === "history" ? "restore" : Object.hasOwn(PAGE_NAMES, requested) ? requested : "status";
  document.title = `${PAGE_NAMES[ui.page]} · armbackup`;
  $("#breadcrumb-current").textContent = PAGE_NAMES[ui.page];
  $$(".navigation a").forEach((link) => {
    const active = link.dataset.page === ui.page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const count = comparisonRows(store.state, latestRun().id).filter((row) => ["critical", "warning", "minor"].includes(row.status)).length;
  $("#nav-count").innerHTML = `<span class="sr-only">변경 리소스 </span>${count}<span class="sr-only">개</span>`;
  $("#topbar-slot").replaceChildren();
  ({ status: renderStatus, settings: renderSettings, restore: renderRestore, logs: renderLogs, storage: renderStorage })[ui.page]();
}
function openDemoResourcePicker() {
  openResourcePicker({
    dialogElement: $("#app-dialog"),
    openDialog: dialog,
    closeDialog: () => $("#app-dialog").close(),
    state: store.state,
    items: backupItems(store.state),
    selectedId: ui.restoreTarget,
    title: "복원·복제 대상 리소스 선택",
    emptyMessage: "검증된 백업이 있는 예시 리소스가 없습니다.",
    renderMeta: (entry) => restorePickerMetaHtml(store.state, entry, { esc, relativeTime }),
    returnFocusSelector: '[data-action="open-resource-picker"]',
    helpers: { esc, icon, symbol },
    onSelect: (chosenId) => {
      browseBackups(chosenId);
    },
  });
}
function renderRestoreCalendar(resourceId = "") {
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); }
  $("#main").insertAdjacentHTML("beforeend", '<div id="restore-calendar" class="panel change-history-panel"></div><div id="restore-plan-section"></div>');
  const initial = {
    ...(historyPreferences || { weeks: 53, metric: "backups", showAll: true }),
    filters: { customer: "", type: "", query: "" },
    ...(ui.restore?.runId ? { selectedRunId: ui.restore.runId } : {}),
    activeAction: ui.restore?.intent || historyPreferences?.activeAction || "",
  };
  historyPanel = new HistoryPanel($("#restore-calendar"), {
    mode: "design-preview", fixedItem: true, busy: ui.restore.busy,
    load: async () => {
      const data = backupCalendarData(
        store.state,
        (row) => ({
          allowed: restorable(row, { status: row.snapshot.complete ? "Captured" : "Incomplete" }),
          reason: "불완전한 백업 또는 현재 상태 미확인",
        }),
        new Date().toISOString(),
        compareResource,
      );
      return {
        ...data,
        targetResourceId: resourceId,
        records: data.records.filter((record) => record.resourceId.toLowerCase() === resourceId.toLowerCase()),
      };
    },
    initial,
    detail: async (record) => {
      const state = store.state;
      const snapshot = (id) => state.runs.find((run) => run.id === id)?.snapshots
        .find((item) => item.resourceId.toLowerCase() === record.resourceId.toLowerCase());
      const before = snapshot(record.beforeRunId), after = snapshot(record.afterRunId);
      if (!after) throw new DemoError("선택한 백업 원본을 찾지 못했습니다.");
      return { ...record, afterAt: after.capturedAt, beforeApiVersion: before?.apiVersion,
        afterApiVersion: after.apiVersion,
        comparison: before ? compareResource(before, { status: "present", raw: after.raw, apiVersion: after.apiVersion }, record.resourceType)
          : { diffs: [], truncated: false, reason: "이전 백업이 없는 첫 보관 형상입니다." } };
    },
    onSelectBackup: (record) => {
      if (!ui.restore?.resourceId) return;
      if (!record || !record.restoreAllowed) {
        ui.restore = { resourceId: null, busy: false };
        historyPanel?.setActiveAction("");
        renderRestorePlanSection();
        return;
      }
      ui.restore = {
        ...ui.restore,
        runId: record.afterRunId,
        plan: null,
        confirmed: false,
        result: null,
        failed: false,
      };
      renderRestorePlanSection();
    },
    onRestore: (record, intent = "restore") => {
      try { startRestore(record.resourceId, record.afterRunId, true, intent); }
      catch (error) { showError(error); }
    },
  });
}
function browseBackups(resourceId = "", selectedDate = "", selectedRunId = "") {
  ui.restore = { resourceId: null, busy: false };
  if (resourceId) ui.restoreTarget = resourceId;
  historyPreferences = { weeks: 53, metric: "backups", showAll: true, selectedDate, selectedRunId,
    activeAction: "", filters: { customer: "", type: "", query: "" } };
  if (historyPanel) { historyPanel.destroy(); historyPanel = null; }
  if (location.hash === "#restore") render(); else location.hash = "restore";
}

function renderStatus() {
  unmountTreeArea?.();
  unmountTreeArea = null;
  const run = store.state.runs.find((item) => item.id === ui.runId);
  const totals = comparisonRows(store.state, ui.runId);
  const types = [...new Map(totals.map((row) => [row.resource.type, row.resource.typeLabel])).entries()];
  $("#topbar-slot").innerHTML = `<button class="button" data-action="refresh-status">${icon("refresh")}예시 다시 보기</button>`;
  $("#main").innerHTML = `
    <h1 class="sr-only">백업 현황</h1>
    <section class="panel" aria-labelledby="comparison-title">
      <div class="panel-header"><h2 class="panel-title" id="comparison-title">리소스 형상 비교 <span class="count-pill">${totals.length}개 백업</span></h2><div class="panel-header-actions"><span class="panel-header-note">${icon("clock")}모든 시각 KST · 예시 관측값</span><span class="selection-hint" id="selection-hint">리소스를 선택해 주세요</span><button class="button primary small" type="button" id="restore-selected" data-action="restore-selected" aria-disabled="true" data-tooltip="복원할 백업 항목을 먼저 선택해 주세요.">${icon("restore")}선택 리소스 복원</button></div></div>
      <div class="toolbar">
        <label class="search-field">${icon("search")}<input type="search" id="resource-search" aria-label="리소스 검색" placeholder="리소스 이름, ID 또는 계층 검색" value="${esc(ui.filters.query)}"></label>
        <select id="status-filter" class="filter-select" aria-label="비교 상태 필터"><option value="all">모든 리소스</option><option value="changed">형상 차이 있음</option><option value="unknown">비교 미확인</option></select>
        <select id="type-filter" class="filter-select" aria-label="리소스 종류 필터"><option value="">모든 리소스 종류</option>${types.map(([type, label]) => `<option value="${esc(type)}" ${ui.filters.type === type ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
        <select id="group-view-demo" aria-label="리소스 그룹 보기"><option value="hierarchy">리소스 체계별</option><option value="type" ${ui.grouping === "type" ? "selected" : ""}>리소스 종류별</option></select>
        <span class="toolbar-spacer"></span><button class="button ghost small" data-action="expand-all">모두 펼치기</button><button class="button ghost small" data-action="collapse-all">모두 접기</button>
      </div>
      <div class="run-strip"><div class="run-meta">${icon("clock")}<span class="run-label">기준 백업</span>
        <select id="baseline-run" class="run-select" aria-label="비교 기준 백업">${store.state.runs.map((item) => `<option value="${esc(item.id)}" ${item.id === ui.runId ? "selected" : ""}>${date(item.capturedAt)} · ${RUN_NAMES[item.kind]} · ${item.snapshots.length}개${item.status !== "Captured" ? " · 불완전" : ""}</option>`).join("")}</select>
        <span class="run-dot"></span><span id="shown-count"></span></div>
        <label class="check-label"><input type="checkbox" id="target-only" ${ui.filters.targetOnly ? "checked" : ""}>설정한 대상만 보기</label>
      </div>
      ${run.status !== "Captured" ? `<div class="notice warning">${icon("alert")}불완전한 백업입니다. 동일 여부와 복원 가능 상태를 확정하지 않습니다.</div>` : ""}
      <div class="tree-area" id="tree-area"><aside class="tree-pane" id="tree-pane" aria-label="리소스 계층"></aside>
        <div class="tree-area-main"><div id="tree-scope"></div><div class="table-scroll tree-grid-scroll" id="tree-container"></div></div></div>
      <div class="table-bottom"><span>행 음영: 머리글·계층 단계별 구분 · 일반 행 흰색</span><span>10일 변경 · 왼쪽 과거 → 오늘</span></div>${recentLegendHtml(esc)}
    </section>
    <div class="notice">${icon("info")}백업·변경 이력은 모두 명시적 예시입니다. 실제 Azure 상태가 아닙니다.</div>
    `;
  $("#status-filter").value = ui.filters.status;
  unmountTreeArea = mountTreeArea($("#tree-area"), $("#tree-container"), ui, () => updateStatusResults());
  updateStatusResults();
}
function backupSummaryHtml() {
  const totals = comparisonRows(store.state, ui.runId);
  return `<section class="summary-cards" aria-label="리소스별 최근 일반 백업 상태 요약">${Object.entries(BACKUP_STATUS).map(([status, info]) => {
    const count = totals.filter((row) => demoHealth(row.resource.id).status === status).length;
    return `<div class="summary-card backup-${status}"><span class="summary-top"><span class="summary-icon">${icon(info.icon)}</span>${info.label}</span><span class="summary-value">${count}<small>개</small></span></div>`;
  }).join("")}</section>`;
}
function demoHealth(id) {
  return backupHealth({ runs: store.state.runs.map((run) => ({ ...run,
    snapshots: run.snapshots.map((snapshot) => ({ ...snapshot, complete: run.status === "Captured" })) })) }, id);
}
function demoMiniCalendar(id) {
  const lower = id.toLowerCase();
  const observed = store.state.current?.[lower];
  const resource = store.state.resources.find((item) => item.id.toLowerCase() === lower);
  const days = recentResourceDays(createDemoHistory(store.state), id, Date.now(), "Asia/Seoul", {
    missingNow: observed?.status === "missing" && observed.confirmed === true,
    createdAt: resource?.createdAt || "",
  });
  return `<div class="recent-days">${recentDaysHtml(days, {
    esc,
    cell: (day, classes, label, inner) => `<a href="#restore" data-action="browse-backups" data-resource="${esc(id)}" data-day="${day.date}" class="${classes}" title="${label}" aria-label="${label}">${inner}</a>`,
  })}</div>`;
}

function updateStatusResults(reveal = false) {
  const rows = comparisonRows(store.state, ui.runId, ui.filters);
  if (reveal) rows.forEach((row) => ancestors(store.state, row.resource.groupId).forEach((scope) => ui.expanded.add(scope.id)));
  if (!rows.some((row) => row.resource.id === ui.selectedId)) ui.selectedId = null;
  const attention = (row) => demoHealth(row.resource.id).red;
  const paneNodes = buildPaneNodes(store.state, rows, { grouping: ui.grouping, attention });
  ui.pane.nodes = paneNodes;
  if (ui.pane.scope !== null && (!paneNodes.some((node) => node.key === ui.pane.scope)
      || (reveal && !rowsInScope(store.state, rows, ui.grouping, ui.pane.scope).length))) ui.pane.scope = null;
  // 트리를 펼치면(E 형) 표는 선택한 범위의 자원만 평평하게 보이고, 접으면(A 형) 계층마다 제목 행을 둔다.
  const treeLayout = ui.pane.open;
  const scoped = treeLayout ? rowsInScope(store.state, rows, ui.grouping, ui.pane.scope) : rows;
  const nodes = treeLayout ? resourceNodes(scoped, null, 1, ui.expanded, null)
    : ui.grouping === "type" ? visibleTypeTree(rows, ui.expanded) : visibleTree(store.state, rows, ui.expanded);
  ui.treeNodes = nodes;
  if (!nodes.some((node) => node.id === ui.focusId)) ui.focusId = nodes[0]?.id;
  const run = store.state.runs.find((item) => item.id === ui.runId);
  $("#shown-count").textContent = `필터 결과 ${rows.length}개`;
  $$("[data-action='expand-all'], [data-action='collapse-all']").forEach((control) => { control.hidden = treeLayout; });
  renderTreePane($("#tree-pane"), { nodes: paneNodes, pane: ui.pane, rootCount: rows.length, rootAttention: rows.filter(attention).length }, { esc, icon });
  $("#tree-scope").innerHTML = treeLayout ? scopeBarHtml({ nodes: paneNodes, scope: ui.pane.scope, count: scoped.length }, { esc, icon }) : "";
  if (!nodes.length) {
    $("#tree-container").innerHTML = treeLayout && ui.pane.scope !== null
      ? empty("선택한 계층 범위에 리소스가 없습니다", "왼쪽 계층에서 다른 범위를 고르거나 ‘전체’를 선택해 주세요.")
      : empty("표시할 백업 리소스가 없습니다", run.absences?.length ? "이 안전 백업에는 현재 부재 확인 기록만 있습니다. 다른 백업을 선택해 주세요." : "검색어와 대상·종류·상태 필터를 확인해 주세요.");
  } else {
    const body = nodes.map((node, index) => {
      const attributes = `data-node="${esc(node.id)}" tabindex="${node.id === ui.focusId ? 0 : -1}" role="row" aria-level="${node.level}" aria-rowindex="${index + 2}" aria-posinset="${node.position}" aria-setsize="${node.setSize}"`;
      if (node.kind === "scope") {
        const scope = node.scope;
        const open = ui.expanded.has(scope.id);
        const scopeIcon = scope.kind === "managementGroup" ? "layers" : scope.kind === "subscription" ? "cloud" : scope.kind === "resourceType" ? "box" : "folder";
        return `<tbody class="tree-grid-group"><tr ${attributes} class="scope-row scope-${scope.kind}" aria-expanded="${open}"><td role="gridcell" colspan="7" aria-colspan="7" data-tree-depth="${node.level - 1}"><div class="scope-cell depth-${Math.min(node.level - 1, 4)}"><button class="tree-toggle ${open ? "open" : ""}" data-action="toggle-scope" data-id="${scope.id}" aria-label="${esc(scope.name)} ${open ? "접기" : "펼치기"}" tabindex="-1">${icon("chevron")}</button>${icon(scopeIcon)}<span class="scope-name">${esc(scope.name)}</span><span class="count-pill">${node.count}</span><span class="scope-kind">${KIND_NAMES[scope.kind]}</span></div></td></tr></tbody>`;
      }
      const { resource, snapshot, observation, status, reason } = node.row;
      const selected = ui.selectedId === resource.id;
      const currentLabel = observation?.status === "present" ? date(observation.observedAt, true)
        : observation?.status === "missing" && observation.confirmed ? "현재 부재 확인" : "조회 미확인";
      const health = demoHealth(resource.id);
      return `<tbody class="resource-group"><tr ${attributes} class="resource-row backup-${health.status} ${selected ? "selected" : ""}" aria-selected="${selected}" data-action="select-resource" data-id="${esc(resource.id)}">
        <td role="gridcell"><input type="checkbox" tabindex="-1" aria-label="${esc(resource.name)} 선택" ${selected ? "checked" : ""}></td>
        <td role="gridcell"><div class="resource-identity">${symbol(resource)}<span class="resource-name-wrap"><span class="resource-name" title="${esc(resource.id)}">${esc(resource.name)}</span></span></div></td>
        <td role="gridcell"><span class="type-text">${esc(resource.typeLabel)}</span></td>
        <td role="gridcell"><time class="table-time" datetime="${snapshot.capturedAt}" title="${date(snapshot.capturedAt)} KST">${relativeTime(snapshot.capturedAt)}</time><span class="table-sub backup-health-sub">${icon(BACKUP_STATUS[health.status].icon)}${health.label}</span></td>
        <td role="gridcell"><span class="table-time">${currentLabel}</span><span class="table-sub">${observation?.status === "present" ? "예시 REST 관측" : observation?.status === "missing" ? "예시 부재 관측" : esc(observation?.code || "대기")}</span></td>
        <td role="gridcell">${demoMiniCalendar(resource.id)}</td>
        <td role="gridcell">${observation?.actor ? `<span class="actor-name" title="${esc(observation.actor.source)}">${esc(observation.actor.caller)}</span><span class="table-sub">${date(observation.actor.at, true)} · 예시</span>` : '<span class="actor-empty">미확인</span><span class="table-sub">변경 주체 미확인</span>'}</td>
      </tr></tbody>`;
    }).join("");
    $("#tree-container").innerHTML = `<table class="resource-table tree-grid" role="treegrid" aria-label="백업과 현재 리소스의 계층형 형상 비교" aria-multiselectable="false" aria-colcount="7" aria-rowcount="${nodes.length + 1}"><colgroup><col class="selection-col"><col class="resource-col"><col class="type-col"><col class="time-col"><col class="time-col"><col class="recent-col"><col class="actor-col"></colgroup><thead><tr role="row" aria-rowindex="1"><th role="columnheader"><span class="sr-only">선택</span></th><th role="columnheader">리소스 체계 / 이름</th><th role="columnheader">리소스 종류</th><th role="columnheader">백업 형상 · KST</th><th role="columnheader">현재 형상 · KST</th>    <th role="columnheader">변경 달력 · 최근 10일</th><th role="columnheader">마지막 변경 주체</th></tr></thead>${body}</table>`;
  }
  const row = rows.find((item) => item.resource.id === ui.selectedId);
  const canRestore = Boolean(restorable(row, run) && !ui.restore?.busy);
  const blockReason = canRestore ? "" : demoRestoreReason(row, run);
  $("#selection-hint").innerHTML = row ? `<strong>${esc(row.resource.name)}</strong> 선택${canRestore ? "" : " · 복원 불가"}` : "리소스를 선택해 주세요";
  const restoreBtn = $("#restore-selected");
  restoreBtn.disabled = false;
  if (canRestore) {
    restoreBtn.removeAttribute("aria-disabled");
    restoreBtn.removeAttribute("data-tooltip");
  } else {
    restoreBtn.setAttribute("aria-disabled", "true");
    restoreBtn.setAttribute("data-tooltip", blockReason);
  }
  restoreBtn.removeAttribute("title");
  syncTooltipTarget(restoreBtn);
  const extras = currentOnly(run);
  if (extras.length) notifier.notify({
    key: "current-only", level: "info", dedupe: true,
    message: `선택한 백업에 없는 현재 리소스가 ${extras.length}개 있습니다. 최종 백업 행과 구분하며, 삭제·복원 대상으로 자동 선택하지 않습니다.`,
    actions: [{ label: "목록 보기", run: showCurrentOnly }],
  });
  else notifier.dismiss("current-only");
}
function showCurrentOnly() {
  const run = store.state.runs.find((item) => item.id === ui.runId);
  dialog("선택한 백업에 없는 현재 리소스", `<p>백업 이후 생성됐다고 단정하지 않습니다. 백업의 수집 범위가 다를 수 있으며, 자동 삭제·복원하지 않습니다.</p>${currentOnly(run).map((resource) => `<p><strong>${esc(resource.name)}</strong><br><span class="small-text">${esc(resource.typeLabel)}</span><code class="resource-id">${esc(resource.id)}</code></p>`).join("")}`);
}

function policyPreview() {
  const state = store.state;
  const resources = state.resources.filter((resource) => {
    const observed = state.current[resource.id.toLowerCase()];
    return observed?.status === "present" && matchesPolicy(state, resource, observed.raw, ui.settings);
  });
  const pending = state.resources.filter((resource) => {
    const observed = state.current[resource.id.toLowerCase()];
    return observed?.status === "error" && matchesPolicy(state, resource, {}, { ...ui.settings, tags: [] });
  });
  return { resources, pending };
}
function updateSettingsSummary() {
  const { resources, pending } = policyPreview();
  const groups = new Set(store.state.resources.filter((resource) => matchesScope(store.state, resource, ui.settings.scopeIds)).map((resource) => resource.groupId));
  const dirty = JSON.stringify(ui.settings) !== JSON.stringify(store.state.policy);
  const dirtyEl = $("#settings-dirty");
  if (dirtyEl) {
    dirtyEl.hidden = !dirty;
    dirtyEl.textContent = dirty ? "저장하지 않은 변경이 있습니다." : "";
  }
  $("#settings-preview").innerHTML = `<div class="summary-preview"><p class="heading-eyebrow">TARGET PREVIEW</p><h2 class="panel-title">다음 백업의 예상 대상</h2><div class="summary-preview-number">${resources.length}<span>개 리소스</span></div><div class="small-text muted">현재 형상이 확인된 예시 자원 기준</div><div class="summary-actions"><button class="button primary" data-action="save-settings" ${legacyPolicyTypes(ui.settings.types).length ? "disabled" : ""}>${icon("check")}예시 설정 저장</button><button class="button" data-action="discard-settings" ${dirty ? "" : 'disabled title="변경한 설정이 없습니다."'}>변경 취소</button></div></div>
    <dl class="summary-list"><dt>리소스 종류</dt><dd>${ui.settings.types.length}개 선택</dd><dt>태그 조건</dt><dd>${ui.settings.tags.length ? `${ui.settings.tags.length}개 모두 만족` : "제한 없음"}</dd><dt>리소스 그룹</dt><dd>${groups.size}개</dd><dt>현재 조회 미확인</dt><dd>${pending.length}개 · 별도 확인</dd></dl>
    <div class="summary-resources"><span class="small-text muted">포함된 예시 리소스</span>${resources.slice(0, 5).map((resource) => `<div class="mini-resource">${icon("box")}<span>${esc(resource.name)}</span></div>`).join("")}${resources.length > 5 ? `<span class="small-text muted">외 ${resources.length - 5}개</span>` : ""}</div>
    <div class="panel-body"><div class="notice">${icon("info")}종류 AND 모든 태그 조건 AND 범위를 함께 적용합니다. 실제 수집 설정은 변경하지 않습니다.</div></div>`;
}
function computeDemoScopeNodes(state, scopeIds) {
  const selectedResources = new Set(
    state.resources.filter((resource) => matchesScope(state, resource, scopeIds)).map((resource) => resource.id),
  );
  return state.scopes.map((scope) => {
    const resources = scopeResources(state, scope.id);
    const included = resources.filter((resource) => selectedResources.has(resource.id)).length;
    const checked = resources.length > 0 && included === resources.length;
    const indeterminate = included > 0 && included < resources.length;
    return {
      ...scope,
      depth: ancestors(state, scope.id).length - 1,
      checked,
      indeterminate,
      resourceCount: resources.length,
    };
  });
}
function toggleDemoScopeIds(state, currentScopeIds, id, checked) {
  function path(targetId) {
    const scope = state.scopes.find((item) => item.id === targetId);
    if (scope) return ancestors(state, scope.id).map((item) => item.id);
    const resource = state.resources.find((item) => item.id === targetId);
    return [...ancestors(state, resource.groupId).map((item) => item.id), resource.id];
  }
  const targetPath = path(id);
  if (checked) {
    if (currentScopeIds.some((selected) => targetPath.includes(selected))) return currentScopeIds;
    return [...currentScopeIds.filter((selected) => !path(selected).includes(id)), id];
  }
  function exclude(selected) {
    if (selected === id) return [];
    if (!targetPath.includes(selected)) return [selected];
    const children = [...state.scopes.filter((scope) => scope.parentId === selected).map((scope) => scope.id),
      ...state.resources.filter((resource) => resource.groupId === selected).map((resource) => resource.id)];
    return children.flatMap(exclude);
  }
  return currentScopeIds.flatMap(exclude);
}
function openDemoPolicyScopePicker() {
  const state = store.state;
  openPolicyScopePicker({
    dialogElement: $("#app-dialog"),
    openDialog: dialog,
    closeDialog: () => $("#app-dialog").close(),
    initialDraft: { ...ui.settings },
    getNodes: (draft) => computeDemoScopeNodes(state, draft.scopeIds),
    toggleNode: (draft, scopeId, checked) => ({
      ...draft,
      scopeIds: toggleDemoScopeIds(state, draft.scopeIds, scopeId, checked),
    }),
    setAllNodes: (draft, selectAll) => ({
      ...draft,
      scopeIds: selectAll ? state.scopes.filter((s) => !s.parentId).map((s) => s.id) : [],
    }),
    countMatchedResources: (draft) => state.resources.filter((resource) =>
      state.current[resource.id.toLowerCase()]?.status === "present" && matchesPolicy(state, resource, draft)).length,
    returnFocusSelector: '[data-action="open-policy-scope-picker"]',
    helpers: { esc, icon },
    onApply: (nextDraft) => {
      ui.settings = nextDraft;
      renderSettings();
    },
  });
}
function openDemoCloneTargetPicker() {
  const state = store.state;
  const r = ui.restore;
  if (!r) return;
  const subscriptions = state.scopes.filter((s) => s.kind === "subscription");
  const groups = state.scopes.filter((s) => s.kind === "resourceGroup");
  const currentGroup = groups.find((g) => g.id === r.groupId);
  const groupsBySub = {};
  for (const sub of subscriptions) {
    groupsBySub[sub.id] = groups.filter((g) => g.parentId === sub.id).map((g) => ({ id: g.id, name: g.name, location: g.location || "" }));
  }
  openTargetLocationPicker({
    dialogElement: $("#app-dialog"),
    openDialog: dialog,
    closeDialog: () => $("#app-dialog").close(),
    state,
    subscriptions: subscriptions.map((s) => ({ subscriptionId: s.id, name: s.name })),
    currentSubscription: currentGroup?.parentId || subscriptions[0]?.id || "",
    groupsBySub,
    selectedSubscription: currentGroup?.parentId || "",
    selectedGroup: r.groupId,
    returnFocusSelector: '[data-action="pick-demo-clone-target"]',
    helpers: { esc, icon },
    onSelect: ({ resourceGroup }) => {
      if (resourceGroup) {
        r.groupId = resourceGroup;
        const resource = state.resources.find((item) => item.id === r.resourceId);
        if (r.intent === "clone" && resource) r.name = computeDemoCloneName(r, resource);
        r.plan = null;
        renderRestorePlanSection();
      }
    },
  });
}
function renderSettings() {
  const state = store.state;
  const scopeNodes = computeDemoScopeNodes(state, ui.settings.scopeIds);
  const scopeNames = { managementGroup: "관리 그룹", subscription: "구독", resourceGroup: "리소스 그룹" };
  const scopeIcons = { managementGroup: "layers", subscription: "cloud", resourceGroup: "folder" };
  const topSelected = scopeNodes.filter(
    (node) => node.checked && !scopeNodes.some((p) => p.checked && p.id === node.parentId),
  );
  const scopeTrigger = pickerTriggerHtml({
    ariaLabel: "허용된 리소스 체계 요약",
    segments: topSelected.slice(0, 3).map((node) => ({
      icon: scopeIcons[node.kind],
      kind: scopeNames[node.kind],
      value: node.name,
    })),
    emptyTitle: "선택된 범위가 없습니다",
    emptyHint: "관리 그룹 · 구독 · 리소스 그룹을 선택하세요",
    metaHtml: topSelected.length > 3 ? `<span class="count-pill">외 ${topSelected.length - 3}개</span>` : `<span class="count-pill">선택 ${topSelected.length}개</span>`,
    buttonLabel: "범위 선택",
    actionAttr: 'data-action="open-policy-scope-picker"',
    attention: topSelected.length === 0,
  }, { esc, icon });
  const types = SUPPORTED_RESOURCES.map((entry) => [entry.type, entry.label]);
  const typeCards = SUPPORTED_RESOURCES.map((entry) => {
    const { type, label, icon: symbol, scope } = entry;
    const { relatedText, dependentText } = resourceBackupCompanions(entry);
    const checked = ui.settings.types.includes(type);
    const count = state.resources.filter((resource) => resource.type.toLowerCase() === type).length;
    return `<label class="type-option ${checked ? "checked" : ""}"><input type="checkbox" data-type="${esc(type)}" ${checked ? "checked" : ""}>${icon(symbol)}<span class="type-option-body"><span class="type-option-head"><strong>${esc(label)}</strong><small class="type-option-scope">${esc(scope)}</small><span class="type-option-count">${count}</span></span><span class="type-relations"><span class="type-relation-row"><span class="type-relation-kind">연관 리소스</span><span class="type-relation-items">${esc(relatedText)}</span></span><span class="type-relation-row"><span class="type-relation-kind">종속 리소스</span><span class="type-relation-items">${esc(dependentText)}</span></span></span></span></label>`;
  }).join("");
  $("#main").innerHTML = `
    <h1 class="sr-only">백업 대상 설정</h1>
    <div class="settings-layout"><div class="settings-sections">
      <section class="panel" aria-labelledby="types-title"><div class="panel-header"><h2 class="panel-title" id="types-title"><span class="section-number">01</span>수집할 리소스 종류</h2><label class="check-label"><input type="checkbox" id="all-types" ${types.every(([type]) => ui.settings.types.includes(type)) ? "checked" : ""}>전체 선택</label></div><div class="panel-body"><div class="type-grid">${typeCards}</div>${legacyPolicyTypes(ui.settings.types).length ? '<p class="small-text" role="alert">기존 정책은 보존했습니다. 공식 종류를 선택한 뒤 저장하세요.</p>' : ""}</div></section>
      <section class="panel" aria-labelledby="tags-title"><div class="panel-header"><h2 class="panel-title" id="tags-title"><span class="section-number">02</span>태그 조건</h2><span class="panel-header-note">모두 만족 · AND</span></div><div class="panel-body">
        ${ui.settings.tags.length ? ui.settings.tags.map((rule, index) => `<div class="tag-rule"><input type="text" data-tag-index="${index}" data-tag-field="key" aria-label="태그 ${index + 1} 이름" placeholder="태그 이름" value="${esc(rule.key)}"><select data-tag-index="${index}" data-tag-field="operator" aria-label="태그 ${index + 1} 연산자"><option value="equals" ${rule.operator === "equals" ? "selected" : ""}>같음 =</option><option value="exists" ${rule.operator === "exists" ? "selected" : ""}>키 있음</option></select><input type="text" data-tag-index="${index}" data-tag-field="value" aria-label="태그 ${index + 1} 값" placeholder="태그 값" value="${esc(rule.value)}" ${rule.operator === "exists" ? "disabled" : ""}><button class="icon-button" data-action="remove-tag" data-index="${index}" aria-label="태그 조건 ${index + 1} 삭제">${icon("close")}</button></div>`).join("") : ""}
        <button class="button small" data-action="add-tag">${icon("plus")}태그 조건 추가</button>
      </div></section>
      <section class="panel" aria-labelledby="scope-title"><div class="panel-header"><h2 class="panel-title" id="scope-title"><span class="section-number">03</span>허용된 리소스 체계</h2><span class="panel-header-note">상위 선택 시 하위 범위 포함</span></div><div class="panel-body">
        ${scopeTrigger}
        ${topSelected.length ? `<div class="scope-choices below-table">${topSelected.map((scope) => `<div class="scope-choice ${scope.kind}">${icon(scopeIcons[scope.kind])}<span class="scope-choice-name">${esc(scope.name)}</span><span class="count-pill" title="이 범위의 리소스 ${scope.resourceCount}개"><span class="sr-only">리소스 </span>${scope.resourceCount}<span class="sr-only">개</span></span><span class="scope-choice-detail">${KIND_NAMES[scope.kind]} · 하위 포함</span><button class="icon-button" type="button" data-action="remove-policy-scope" data-id="${esc(scope.id)}" aria-label="${esc(scope.name)} 범위 제외">${icon("close")}</button></div>`).join("")}</div>` : '<div class="scope-choices" hidden></div>'}
      </div></section>
      <div class="settings-bottom"><span class="dirty-label" id="settings-dirty" hidden></span><span class="small-text muted">저장 위치: 이 브라우저의 예시 저장소</span></div>
    </div><aside class="panel settings-summary" id="settings-preview" aria-label="다음 백업의 예상 대상"></aside></div>`;
  updateSettingsSummary();
}
function toggleScope(id, checked) {
  ui.settings.scopeIds = toggleDemoScopeIds(store.state, ui.settings.scopeIds, id, checked);
}

function computeDemoCloneName(r, resource) {
  const baseName = resource?.name || "";
  const mode = CLONE_NAME_MODES.includes(r.nameMode) ? r.nameMode : "prefix";
  const sameRg = r.groupId === resource?.groupId;
  if (mode === "suffix") {
    const sfx = String(r.cloneSuffix ?? "").trim();
    return (sfx ? `${baseName}-${sfx}` : baseName).slice(0, 63);
  }
  if (mode === "sequence") {
    const seq = String(r.cloneSequence ?? "").trim();
    return (seq ? applySequenceName(baseName, seq) : baseName).slice(0, 63);
  }
  if (mode === "direct") {
    const direct = String(r.directName ?? "").trim();
    return (direct || (!sameRg ? baseName : "")).slice(0, 63);
  }
  const pfx = String(r.clonePrefix ?? "").trim();
  return (pfx ? `${pfx}-${baseName}` : baseName).slice(0, 63);
}

function startRestore(id, runId = ui.runId, fromCalendar = false, intent = "restore") {
  const resource = store.state.resources.find((item) => item.id.toLowerCase() === id.toLowerCase());
  if (!resource) throw new DemoError("복원할 리소스를 찾을 수 없습니다.");
  const history = store.state.runs.filter((run) => run.snapshots.some((snapshot) => snapshot.resourceId.toLowerCase() === id.toLowerCase()));
  const selectedRun = history.find((run) => run.id === runId);
  if (!selectedRun) throw new DemoError("리소스의 백업 이력이 없습니다.");
  if (!fromCalendar) {
    browseBackups(resource.id, "", selectedRun.id);
    return;
  }
  const present = store.state.current[resource.id.toLowerCase()]?.status === "present";
  const isClone = intent === "clone";
  ui.restore = {
    resourceId: resource.id,
    runId: selectedRun.id,
    intent,
    mode: isClone ? "create" : (present ? "update" : "create"),
    groupId: resource.groupId,
    nameMode: "prefix",
    clonePrefix: "copy",
    cloneSuffix: "copy",
    cloneSequence: nextSequenceToken(resource.name),
    directName: `${resource.name}-copy`.slice(0, 63),
    name: isClone ? `copy-${resource.name}`.slice(0, 63) : resource.name,
    confirmed: false,
    plan: null,
    busy: false,
    phase: null,
    result: null,
    failed: false,
  };
  ui.restoreTarget = resource.id;
  if (location.hash === "#restore" && $("#restore-plan-section")) {
    historyPanel?.setActiveAction(intent);
    renderRestorePlanSection();
    $("#restore-plan-section")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  if (location.hash === "#restore") renderRestore();
  else location.hash = "restore";
}
function restoreTargetPanel() {
  return restoreTargetHtml(store.state, ui.restoreTarget, { esc, icon, relativeTime, symbol, busy: ui.restore.busy });
}
function renderRestorePlanSection() {
  const target = $("#restore-plan-section");
  if (!target) return;
  const r = ui.restore;
  if (!r?.resourceId) {
    target.replaceChildren();
    return;
  }
  const resource = store.state.resources.find((item) => item.id.toLowerCase() === r.resourceId.toLowerCase());
  if (!resource) {
    target.replaceChildren();
    return;
  }
  if (r.result) { renderRestoreResult(target); return; }
  if (r.busy) { renderExecution(target); return; }
  if (r.failed) {
    target.innerHTML = `<section class="panel restore-plan-panel"><div class="panel-body"><div class="notice error" data-persist>${icon("alert")}예시 작업을 완료하지 못했습니다. ${esc(r.error)}</div><p class="small-text muted">저장된 안전 백업은 삭제하지 않습니다. 데이터를 다시 확인한 뒤 계획을 새로 검토해 주세요.</p></div><div class="wizard-actions"><a class="button" href="#logs">예시 로그 보기</a><button class="button primary" data-action="retry-restore-review">계획 다시 검토</button></div></section>`;
    return;
  }
  const isClone = r.intent === "clone";
  const observed = store.state.current[resource.id.toLowerCase()];
  const canUpdate = observed?.status === "present";
  const groups = store.state.scopes.filter((scope) => scope.kind === "resourceGroup");
  const group = groups.find((scope) => scope.id === r.groupId);
  const subscriptions = store.state.scopes.filter((scope) => scope.kind === "subscription");
  const subScope = subscriptions.find((scope) => scope.id === group?.parentId);
  const mgScopes = group ? ancestors(store.state, group.id).filter((scope) => scope.kind === "managementGroup") : [];
  const cloneTargetBar = isClone
    ? pickerTriggerHtml({
        ariaLabel: "대상 구독 · 리소스 그룹",
        segments: [
          ...mgScopes.map((mg) => ({ kind: "관리 그룹", value: mg.name, icon: "layers" })),
          ...(subScope ? [{ kind: "구독", value: subScope.name, icon: "cloud" }] : []),
          ...(group ? [{ kind: "리소스 그룹", value: group.name, icon: "folder" }] : []),
        ],
        buttonLabel: "대상 위치 선택",
        actionAttr: 'data-action="pick-demo-clone-target"',
      }, { esc, icon })
    : "";
  const plan = r.plan;
  const sameRg = r.groupId === resource.groupId;
  const nameMode = CLONE_NAME_MODES.includes(r.nameMode) ? r.nameMode : "prefix";
  const modeButtons = isClone
    ? [
        ["prefix", "접두사"],
        ["suffix", "접미사"],
        ["sequence", "일련 번호"],
        ["direct", "직접 지정"],
      ].map(([id, label]) => `<button type="button" class="segmented-choice ${nameMode === id ? "active" : ""}" data-action="demo-clone-name-mode" data-mode="${id}" aria-pressed="${nameMode === id}">${label}</button>`).join("")
    : "";
  const demoNamingInputHtml = !isClone ? "" : (
    nameMode === "prefix"
      ? `<label class="field"><span class="field-label">이름 접두사${sameRg ? "" : " (선택)"}</span><input type="text" id="demo-clone-prefix" value="${esc(r.clonePrefix ?? "copy")}" maxlength="20" placeholder="${sameRg ? "예: copy, dr, stg" : "비워 두면 원본 이름 유지"}" autocomplete="off"></label>`
      : nameMode === "suffix"
        ? `<label class="field"><span class="field-label">이름 접미사${sameRg ? "" : " (선택)"}</span><input type="text" id="demo-clone-suffix" value="${esc(r.cloneSuffix ?? "copy")}" maxlength="30" placeholder="${sameRg ? "예: copy, dr, blue, v2" : "비워 두면 원본 이름 유지"}" autocomplete="off"></label>`
        : nameMode === "sequence"
          ? `<div class="field"><label for="demo-clone-sequence" class="field-label">일련 번호</label><div class="sequence-input-row"><button type="button" class="button small seq-step-btn" data-action="demo-seq-step" data-step="-1" aria-label="일련 번호 1 감소">−</button><input type="text" id="demo-clone-sequence" inputmode="numeric" maxlength="8" value="${esc(r.cloneSequence ?? "")}" placeholder="예: 02, 001" autocomplete="off"><button type="button" class="button small seq-step-btn" data-action="demo-seq-step" data-step="1" aria-label="일련 번호 1 증가">+</button></div><small class="field-hint">원본 이름 끝의 번호(예: -01)를 바꾸거나, 번호가 없으면 뒤에 붙입니다.</small></div>`
          : `<label class="field"><span class="field-label">새 리소스 이름 (${esc(resource.name)})</span><input type="text" id="target-name" value="${esc(r.directName ?? r.name)}" maxlength="63" placeholder="${esc(`${resource.name}-copy`)}" autocomplete="off"></label>`
  );
  const settingsBodyHtml = isClone
    ? `<div class="field"><span class="field-label">대상 구독 · 리소스 그룹</span>${cloneTargetBar}</div>
      <div class="clone-naming-block">
        <div class="field"><span class="field-label">새 리소스 이름 지정 방식</span><div class="segmented-choices" role="group" aria-label="새 리소스 이름 지정 방식">${modeButtons}</div></div>
        <div class="smart-clone-grid">${demoNamingInputHtml}</div>
      </div>
      <small class="field-hint mono" id="target-id-preview"></small>`
    : `<p class="plan-draft-note">${canUpdate ? "예시 프리뷰 모드입니다. 실환경에서는 연결 리소스 동반 복원과 불변 속성 처리 방식도 여기에서 선택할 수 있습니다." : "현재 부재가 확인된 예시 리소스를 원래 위치·이름으로 재생성합니다."}</p>`;
  const planBodyHtml = plan
    ? `<div class="bundle-plan">
        <ol class="plan-action-list"><li><span class="plan-item-mapping">${isClone ? `${esc(resource.name)} ${icon("arrow")} <strong>${esc(r.name)}</strong>` : `<strong>${esc(resource.name)}</strong>`}</span><span class="relation-label">${isClone || !canUpdate ? "생성" : "업데이트"}</span></li></ol>
        <p class="small-text muted">대상 ID: <code class="mono">${esc(plan.targetId)}</code> (실제 Azure 미호출 · 브라우저 예시)</p>
        ${isClone ? "" : `<label class="check-label"><input type="checkbox" id="restore-confirm" ${r.confirmed ? "checked" : ""}>예시 안전 백업 보관 후 예시 데이터를 복원합니다.</label>`}
        <div class="plan-execute-row"><button class="button primary" type="button" id="execute-restore" data-action="execute-restore" ${isClone || r.confirmed ? "" : "disabled"}>${icon(isClone ? "layers" : "restore")}${isClone ? "예시 복제 실행" : "안전 백업 후 예시 복원"}</button><button class="button ghost small" type="button" data-action="restore-next">${icon("refresh")}다시 검토</button></div>
      </div>`
    : `<div class="plan-draft">
        <ol class="plan-preview-list" aria-label="${isClone ? "생성될 복제 리소스 목록" : "복원 적용 대상 목록"}">
          <li><span class="plan-item-mapping">${isClone ? `${esc(resource.name)} ${icon("arrow")} <strong data-demo-target-name>${esc(r.name)}</strong>` : `<strong>${esc(resource.name)}</strong>`}</span><span class="relation-label">${isClone ? "주 리소스" : (canUpdate ? "기존 설정 업데이트" : "삭제 리소스 재생성")}</span></li>
        </ol>
        <p class="plan-draft-note">${isClone ? "원본은 유지하고 새 리소스를 생성합니다. 실환경에서는 전용 공용 IP 동반 생성과 고유 DNS·사설 IP 자동 보정이 함께 적용됩니다." : "적용 전 현재 형상을 안전 백업으로 먼저 보관합니다."}</p>
        <div class="plan-review-trigger"><button class="button primary" type="button" data-action="restore-next">${icon("shield")}${isClone ? "복제 계획 검토" : "복원 계획 검토"}</button></div>
      </div>`;
  target.innerHTML = `<div class="restore-plan-workspace">
    <div class="restore-plan-split">
      <section class="panel restore-plan-panel restore-settings-pane" aria-label="${isClone ? "복제 설정" : "복원 설정"}">
        <div class="panel-header">
          <h2 class="panel-title">${icon(isClone ? "layers" : "restore")}${isClone ? "복제 설정" : "복원 설정"} <span class="count-pill">예시</span></h2>
        </div>
        <div class="panel-body restore-plan-body">
          <div class="bundle-review">${settingsBodyHtml}</div>
        </div>
      </section>
      <section class="panel restore-plan-panel restore-plan-pane" aria-label="${isClone ? "복제 계획" : "복원 계획"}">
        <div class="panel-header">
          <h2 class="panel-title">${icon("shield")}${isClone ? "복제 계획" : "복원 계획"} <span class="count-pill">1개 리소스 ${isClone ? "생성" : "적용"}</span></h2>
          <div class="panel-header-actions"><span class="side-badge ${plan ? "verified" : "unverified"}">${plan ? "검토 완료" : "검토 전"}</span></div>
        </div>
        <div class="panel-body restore-plan-body">
          ${planBodyHtml}
        </div>
      </section>
    </div>
  </div>`;
  if (isClone) updateTargetPreview();
}
function renderRestore() {
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); historyPanel = null; }
  if (!ui.restoreTarget) {
    const available = backupItems(store.state);
    const preferred = available.find((item) =>
      SUPPORTED_RESOURCES.some((entry) => entry.type === item.resource.type.toLowerCase()),
    ) || available[0];
    if (preferred) ui.restoreTarget = preferred.resource.id;
  }
  const chosen = restoreItem(store.state, ui.restoreTarget)?.resource.id || "";
  $("#main").innerHTML = `${restoreHeading()}${restoreTargetPanel()}`;
  if (!chosen) {
    return;
  }
  renderRestoreCalendar(chosen);
  if (ui.restore?.resourceId && ui.restore.resourceId.toLowerCase() === chosen.toLowerCase()) {
    renderRestorePlanSection();
  }
}
function updateTargetPreview() {
  const previewName = $("[data-demo-target-name]");
  if (previewName) previewName.textContent = ui.restore.name || "—";
  try {
    const resource = store.state.resources.find((item) => item.id === ui.restore.resourceId);
    $("#target-id-preview").textContent = makeTargetId(store.state, resource, ui.restore.groupId, ui.restore.name);
  } catch (error) {
    if (!(error instanceof DemoError)) throw error;
    $("#target-id-preview").textContent = error.message;
  }
}
function renderExecution(target) {
  const phase = ui.restore.phase;
  const isClone = ui.restore.intent === "clone";
  const index = { checking: 0, safety: 1, applied: 2 }[phase] ?? 0;
  target.innerHTML = `<section class="panel restore-plan-panel"><div class="panel-header"><h2 class="panel-title">예시 ${isClone ? "복제" : "복원"}를 진행하고 있습니다</h2></div><div class="panel-body"><div class="execution-list" role="status" aria-live="polite">${["현재 상태와 계획 재확인", "적용 전 안전 백업 보관", "예시 형상 적용 및 사후 비교"].map((label, step) => `<div class="execution-item ${step < index ? "complete" : step === index ? "running" : ""}">${step < index ? icon("check") : step === index ? '<span class="spinner"></span>' : icon("clock")}<span>${label}${step < index ? " · 완료" : ""}</span></div>`).join("")}</div></div></section>`;
}
function renderRestoreResult(target) {
  const result = ui.restore.result;
  const isClone = ui.restore.intent === "clone";
  const safety = store.state.runs.find((run) => run.id === result.safetyId);
  const portalUrl = azurePortalResourceUrl(result.targetId);
  const targetName = String(result.targetId || "").split("/").at(-1) || result.targetId;
  target.innerHTML = `<section class="panel restore-plan-panel"><div class="panel-body"><div class="result-header"><span class="result-icon">${icon("check")}</span><div><h2>예시 ${isClone ? "복제" : "복원"}를 완료했습니다</h2><p>안전 백업을 먼저 저장하고, 예시 형상 적용 후 일치를 확인했습니다.</p></div></div>
    <dl class="result-meta"><div><dt>실행 방식</dt><dd>${isClone ? "예시 독립 설정 복제" : (result.mode === "create" ? "예시 부재 재생성" : "예시 기존 업데이트")}</dd></div><div><dt>안전 백업</dt><dd>${date(safety.capturedAt)} KST · 형상 ${safety.snapshots.length}개 · 부재 기록 ${safety.absences.length}개<code class="resource-id">${esc(result.safetyId)}</code></dd></div><div><dt>적용 대상</dt><dd class="mono">${esc(result.targetId)}</dd></div><div><dt>보관 위치</dt><dd>이 브라우저의 localStorage · 실제 Blob·Log Analytics 미연결</dd></div></dl></div>
    <div class="wizard-actions">${portalUrl ? `<a class="button portal-link" href="${esc(portalUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(`${result.targetId} (실환경에서는 해당 Azure 포털 리소스 화면으로 이동합니다)`)}">${icon("external")}Azure 포털에서 열기 · ${esc(targetName)}</a>` : ""}<button class="button" data-action="restore-view-logs">${icon("logs")}처리 로그 보기</button><button class="button primary" data-action="restore-view-status">형상 비교로 돌아가기 ${icon("arrow")}</button></div></section>`;
}

function renderLogs() {
  const filters = ui.logs;
  const all = queryLogs(store.state, filters).slice(0, 200);
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  ui.logPage = Math.min(ui.logPage, pages - 1);
  const rows = all.slice(ui.logPage * pageSize, (ui.logPage + 1) * pageSize);
  const query = logQueryExample(filters);
  $("#main").innerHTML = `
    ${heading("로그 열람",
      `<button class="button" data-action="refresh-logs">${icon("refresh")}예시 로그 새로고침</button>`)}
    ${backupSummaryHtml()}
    <div class="notice below-table">${icon("info")}Log Analytics Workspace는 아직 연결하지 않았습니다. 아래는 ArmBackup_CL 연동을 가정한 예시 이벤트이며, Azure 로그를 조회한 결과가 아닙니다.</div>
    <section class="panel below-table" aria-labelledby="logs-title"><div class="panel-header"><h2 class="panel-title" id="logs-title">${icon("logs")}실행 로그 <span class="count-pill">예시 데이터</span></h2><span class="panel-header-note">Workspace 미연결 · 모든 시각 KST</span></div>
    <form class="toolbar" id="logs-form"><label class="search-field">${icon("search")}<input type="search" name="query" id="log-search" aria-label="로그 검색" placeholder="이벤트, 리소스 ID 또는 메시지 검색" value="${esc(filters.query)}"></label>
      <select name="days" aria-label="로그 조회 기간"><option value="1" ${filters.days === 1 ? "selected" : ""}>최근 24시간</option><option value="7" ${filters.days === 7 ? "selected" : ""}>최근 7일</option><option value="30" ${filters.days === 30 ? "selected" : ""}>최근 30일</option><option value="0" ${!filters.days ? "selected" : ""}>예시 전체 기간</option></select>
      <select name="level" aria-label="로그 수준"><option value="">모든 수준</option>${["Information", "Warning", "Error"].map((level) => `<option value="${level}" ${filters.level === level ? "selected" : ""}>${level}</option>`).join("")}</select><button class="button primary" type="submit">${icon("search")}예시 로그 조회</button>
    </form><div class="log-summary">${["Information", "Warning", "Error"].map((level) => `<span class="log-summary-item"><span class="log-level ${level}">${level}</span><strong>${all.filter((log) => log.level === level).length}</strong></span>`).join("")}<span class="toolbar-spacer small-text muted">${all.length}건 조회 · 최대 200건</span></div>
    ${rows.length ? `<div class="table-scroll"><table class="logs-table" aria-label="예시 실행 로그"><colgroup><col class="time-col"><col class="level-col"><col class="event-col"><col><col class="detail-col"></colgroup><thead><tr><th>시각 · KST</th><th>수준</th><th>이벤트</th><th>메시지 / 리소스</th><th><span class="sr-only">상세</span></th></tr></thead><tbody>${rows.map((log) => `<tr><td><time class="table-time" datetime="${log.time}">${date(log.time)}</time><span class="table-sub">예시 이벤트</span></td><td><span class="log-level ${log.level}">${log.level}</span></td><td class="log-event mono">${esc(log.event)}</td><td><span class="log-message">${esc(log.message)}</span>${log.resourceId ? `<span class="table-sub mono" title="${esc(log.resourceId)}">${esc(log.resourceId.split("/").at(-1))}</span>` : ""}</td><td><button class="icon-button" data-action="log-detail" data-id="${esc(log.id)}" aria-label="${esc(log.event)} 로그 상세">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>` : empty("조건에 맞는 예시 로그가 없습니다", "검색어·기간·수준을 변경해 주세요. 실제 Workspace의 로그 유무를 뜻하지 않습니다.")}
    <div class="table-bottom"><span>브라우저 예시 저장소 · 서버 KQL 실행 없음</span><span><button class="button ghost small" data-action="log-prev" ${ui.logPage === 0 ? "disabled" : ""}>이전</button> ${ui.logPage + 1} / ${pages} <button class="button ghost small" data-action="log-next" ${ui.logPage + 1 >= pages ? "disabled" : ""}>다음</button></span></div></section>
    <details class="panel query-panel"><summary>운영 연결 시 사용할 KQL 형태 보기 · 설계 예시</summary><pre>${esc(query)}</pre></details>`;
}

function focusTree(id) {
  const row = $$("[data-node]").find((item) => item.dataset.node === id);
  if (row) {
    $$("[data-node]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; });
    ui.focusId = id;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }
}
function handleTreeKey(event) {
  const element = event.target.closest("[data-node]");
  if (!element || event.target !== element) return;
  const index = ui.treeNodes.findIndex((node) => node.id === element.dataset.node);
  const node = ui.treeNodes[index];
  if (!node) return;
  let nextId;
  if (event.key === "ArrowDown") nextId = ui.treeNodes[Math.min(index + 1, ui.treeNodes.length - 1)].id;
  else if (event.key === "ArrowUp") nextId = ui.treeNodes[Math.max(index - 1, 0)].id;
  else if (event.key === "Home") nextId = ui.treeNodes[0].id;
  else if (event.key === "End") nextId = ui.treeNodes.at(-1).id;
  else if (event.key === "ArrowRight" && node.kind === "scope") {
    if (!ui.expanded.has(node.id)) { ui.expanded.add(node.id); updateStatusResults(); nextId = node.id; }
    else nextId = ui.treeNodes[index + 1]?.id;
  } else if (event.key === "ArrowLeft") {
    if (node.kind === "scope" && ui.expanded.has(node.id)) { ui.expanded.delete(node.id); updateStatusResults(); nextId = node.id; }
    else nextId = node.parentId;
  } else if (event.key === "Enter" || event.key === " ") {
    if (node.kind === "scope") {
      if (ui.expanded.has(node.id)) ui.expanded.delete(node.id); else ui.expanded.add(node.id);
    } else ui.selectedId = ui.selectedId === node.id ? null : node.id;
    updateStatusResults();
    nextId = node.id;
  } else return;
  event.preventDefault();
  if (nextId) focusTree(nextId);
}

function updateStorageView() {
  const index = ui.storage.index;
  if (!index || !$("#storage-tree-pane")) return;
  const paneNodes = buildStoragePaneNodes(index);
  ui.storage.pane.nodes = paneNodes;
  if (ui.storage.pane.scope !== null && !index.dirs.has(ui.storage.pane.scope)) ui.storage.pane.scope = null;
  renderTreePane($("#storage-tree-pane"), {
    nodes: paneNodes, pane: ui.storage.pane, rootCount: index.blobCount,
    rootLabel: index.root.name, rootIcon: "storage",
    rootKind: `${index.root.roleLabel} · ${index.blobCount.toLocaleString("en-US")}개`,
    rootMetaText: formatBytes(index.totalBytes),
    rootMetaLabel: `점유 크기 ${formatBytes(index.totalBytes)} (${exactBytes(index.totalBytes)})`,
    label: "디렉터리 계층",
  }, { esc, icon });
  $("#storage-scope").innerHTML = ui.storage.pane.open ? storageBreadcrumbHtml(index, ui.storage, { esc, icon }) : "";
  $("#storage-table-container").innerHTML = storageTableHtml(index, ui.storage, { esc, icon, date, timezone: "KST" });
  $("#storage-footer-hint").textContent = storageFooterText(index, ui.storage, { date, timezone: "KST" });
  $("#topbar-slot").innerHTML = storageTopbarHtml(ui.storage, { esc, icon, busy: ui.restore.busy });
}

function renderStorage() {
  unmountTreeArea?.();
  unmountTreeArea = null;
  const data = previewStorageData(store.state);
  const index = buildStorageIndex(data);
  ui.storage.data = data;
  ui.storage.index = index;
  if (!ui.storage.initialized) {
    ui.storage.pane.collapsed = defaultCollapsedDirs(index);
    ui.storage.expandedDirs = defaultExpandedTableDirs(index);
    if (ui.storage.pane.scope === null) {
      ui.storage.pane.scope = defaultInitialScope(index);
      ui.storage.pane.focusKey = ui.storage.pane.scope ?? "";
    }
    ui.storage.initialized = true;
  }
  $("#topbar-slot").innerHTML = storageTopbarHtml(ui.storage, { esc, icon, busy: ui.restore.busy });
  $("#main").innerHTML = storageShellHtml(ui.storage, { esc, icon });
  if ($("#storage-tree-area")) {
    unmountTreeArea = mountTreeArea($("#storage-tree-area"), $("#storage-table-container"),
      { activePane: () => ui.storage.pane }, () => updateStorageView());
    updateStorageView();
  }
}

async function handleAction(action, target) {
  if (ui.restore.busy) { toast("예시 복원이 진행 중입니다. 저장이 끝난 뒤 다시 시도해 주세요.", "warning"); return; }
  if (action === "refresh-status") { store.assertFresh(); updateStatusResults(); toast("저장된 예시 관측값을 다시 표시했습니다. 실제 ARM 조회는 없습니다."); }
  if (action === "storage-refresh") { store.assertFresh(); renderStorage(); toast("예시 컨테이너의 디렉터리·Blob 크기를 다시 집계했습니다. 실제 Azure 조회는 없습니다."); return; }
  if (action === "storage-dir") { selectStorageDirectory(ui.storage.index, ui.storage, target.dataset.dir || ""); updateStorageView(); return; }
  if (action === "storage-open-dir") { selectStorageDirectory(ui.storage.index, ui.storage, target.dataset.dir || ""); updateStorageView(); focusStorageRow($("#main"), ui.storage, ""); return; }
  if (action === "storage-toggle-dir" || action === "storage-toggle-row") { toggleStorageTableDir(ui.storage, target.dataset.dir || ""); updateStorageView(); focusStorageRow($("#main"), ui.storage, `scope:${target.dataset.dir}`); return; }
  if (action === "storage-clear-search") { ui.storage.query = ""; const input = $("#storage-search"); if (input) { input.value = ""; input.focus(); } updateStorageView(); return; }
  if (action === "storage-inspect-blob") { dialog("Blob 상세 정보", blobDetailDialogHtml(ui.storage.index, target.dataset.blob || "", { esc, date, timezone: "KST" })); return; }
  if (action === "status-filter") {
    ui.filters.status = ui.filters.status === target.dataset.status ? "all" : target.dataset.status;
    $("#status-filter").value = ui.filters.status;
    updateStatusResults(true);
  }
  if (action === "expand-all" || action === "collapse-all") {
    const groups = ui.grouping === "type" ? store.state.resources.map((resource) => `type:${resource.type}`)
      : store.state.scopes.map((scope) => scope.id);
    groups.forEach((id) => action === "expand-all" ? ui.expanded.add(id) : ui.expanded.delete(id));
    updateStatusResults();
  }
  if (action === "toggle-scope") {
    if (ui.expanded.has(target.dataset.id)) ui.expanded.delete(target.dataset.id); else ui.expanded.add(target.dataset.id);
    ui.focusId = target.dataset.id;
    updateStatusResults();
    focusTree(target.dataset.id);
  }
  if (action === "select-resource") {
    ui.selectedId = ui.selectedId === target.dataset.id ? null : target.dataset.id;
    ui.focusId = target.dataset.id;
    updateStatusResults();
    focusTree(target.dataset.id);
  }
  if (action === "restore-selected") {
    const run = store.state.runs.find((item) => item.id === ui.runId);
    const row = comparisonRows(store.state, ui.runId, ui.filters).find((item) => item.resource.id === ui.selectedId);
    if (!restorable(row, run)) return;
    browseBackups(ui.selectedId, "", ui.runId);
  }
  if (action === "browse-backups") browseBackups(target.dataset.resource || "", target.dataset.day || "");
  if (action === "show-current-only") showCurrentOnly();
  if (action === "add-tag") { ui.settings.tags.push({ key: "", operator: "equals", value: "" }); renderSettings(); $$("[data-tag-field='key']").at(-1)?.focus(); }
  if (action === "remove-tag") { ui.settings.tags.splice(Number(target.dataset.index), 1); renderSettings(); }
  if (action === "discard-settings") { ui.settings = clone(store.state.policy); renderSettings(); toast("저장하지 않은 예시 설정 변경을 취소했습니다."); }
  if (action === "save-settings") {
    savePolicy(store, ui.settings);
    ui.restore.plan = null;
    renderSettings();
    toast("이 브라우저에 예시 설정을 저장했습니다. 실제 수집 설정은 바뀌지 않았습니다.");
  }
  if (action === "open-resource-picker" || action === "pick-restore-resource" || action === "clear-restore") {
    openDemoResourcePicker();
  }
  if (action === "open-policy-scope-picker") {
    openDemoPolicyScopePicker();
  }
  if (action === "remove-policy-scope") {
    toggleScope(target.dataset.id, false);
    renderSettings();
    $('[data-action="open-policy-scope-picker"]')?.focus({ preventScroll: true });
  }
  if (action === "pick-demo-clone-target") {
    openDemoCloneTargetPicker();
  }
  if (action === "demo-clone-name-mode") {
    const r = ui.restore;
    const resource = store.state.resources.find((item) => item.id === r.resourceId);
    const nextMode = target.dataset.mode;
    if (CLONE_NAME_MODES.includes(nextMode) && r.nameMode !== nextMode) {
      if (nextMode === "direct" && !r.directName) r.directName = r.name || `${resource?.name || "resource"}-copy`;
      if (nextMode === "sequence" && !r.cloneSequence) r.cloneSequence = nextSequenceToken(resource?.name || "");
      r.nameMode = nextMode;
      r.name = computeDemoCloneName(r, resource);
      r.plan = null;
      renderRestorePlanSection();
      $(`[data-action="demo-clone-name-mode"][data-mode="${nextMode}"]`)?.focus({ preventScroll: true });
    }
    return;
  }
  if (action === "demo-seq-step") {
    const r = ui.restore;
    const resource = store.state.resources.find((item) => item.id === r.resourceId);
    r.cloneSequence = stepSequenceToken(r.cloneSequence, Number(target.dataset.step) || 0);
    r.name = computeDemoCloneName(r, resource);
    const seqInput = $("#demo-clone-sequence");
    if (seqInput) seqInput.value = r.cloneSequence;
    if (r.plan) { r.plan = null; renderRestorePlanSection(); }
    else updateTargetPreview();
    target.focus?.({ preventScroll: true });
    return;
  }
  if (action === "pick-restore-item") browseBackups(target.dataset.id);
  if (action === "restore-next") {
    const r = ui.restore;
    r.plan = prepareRestore(store.state, { resourceId: r.resourceId, runId: r.runId, mode: r.mode, groupId: r.groupId, name: r.name });
    r.confirmed = false;
    renderRestorePlanSection();
  }
  if (action === "retry-restore-review") { ui.restore.failed = false; ui.restore.plan = null; ui.restore.confirmed = false; renderRestorePlanSection(); }
  if (action === "execute-restore") {
    const r = ui.restore;
    const isClone = r.intent === "clone";
    if ((!isClone && !r.confirmed) || !r.plan) throw new DemoError("계획 검토 및 최종 확인이 필요합니다.");
    r.busy = true; r.phase = "checking";
    if (ui.page === "restore") renderRestorePlanSection();
    notifier.notify({ key: "demo-job", level: "progress", message: `예시 ${isClone ? "복제" : "복원"} 진행 중 · 메뉴를 이동해도 백그라운드에서 완료됩니다.` });
    try {
      r.result = await executeRestore(store, r.plan, async (phase) => {
        r.phase = phase;
        if (ui.page === "restore") renderRestorePlanSection();
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      r.busy = false;
      notifier.dismiss("demo-job");
      render();
      toast(isClone ? "예시 복제를 완료했습니다. 안전 백업과 처리 로그를 브라우저에 보관했습니다." : "예시 복원을 완료했습니다. 안전 백업과 처리 로그를 브라우저에 보관했습니다.");
    } catch (error) {
      r.busy = false; r.failed = true; r.error = errorText(error);
      notifier.dismiss("demo-job");
      showError(error);
      if (ui.page === "restore") renderRestorePlanSection();
    }
  }
  if (action === "restore-view-status") { ui.selectedId = ui.restore.result.mode === "update" ? ui.restore.resourceId : null; ui.filters.status = "all"; ui.filters.query = ""; ui.filters.type = ""; location.hash = "status"; }
  if (action === "restore-view-logs") { ui.logs = { days: 7, level: "", query: ui.restore.result.targetId }; ui.logPage = 0; location.hash = "logs"; }
  if (action === "refresh-logs") { store.assertFresh(); renderLogs(); toast("브라우저의 예시 로그를 다시 표시했습니다. Workspace 조회는 없습니다."); }
  if (action === "log-prev" || action === "log-next") { ui.logPage += action === "log-prev" ? -1 : 1; renderLogs(); }
  if (action === "log-detail") {
    const log = store.state.logs.find((item) => item.id === target.dataset.id);
    dialog("예시 로그 상세", `<p>Log Analytics에서 조회한 실제 로그가 아닙니다.</p><pre>${esc(JSON.stringify(log, null, 2))}</pre>`);
  }
}

function handleChange(target) {
  if (target.id === "group-view-demo") {
    ui.grouping = target.value;
    store.state.resources.forEach((resource) => ui.expanded.add(`type:${resource.type}`));
    updateStatusResults(); $("#group-view-demo").focus();
  }
  if (target.id === "status-filter") { ui.filters.status = target.value; updateStatusResults(true); }
  if (target.id === "type-filter") { ui.filters.type = target.value; updateStatusResults(true); }
  if (target.id === "target-only") { ui.filters.targetOnly = target.checked; updateStatusResults(true); }
  if (target.id === "baseline-run") { ui.runId = target.value; ui.selectedId = null; ui.filters.status = "all"; ui.filters.type = ""; renderStatus(); }
  if (target.id === "storage-mode") { ui.storage.mode = target.value; updateStorageView(); $("#storage-mode")?.focus(); }
  if (target.id === "storage-sort") { ui.storage.sort = target.value; updateStorageView(); $("#storage-sort")?.focus(); }
  if (target.dataset.scope) { toggleScope(target.dataset.scope, target.checked); renderSettings(); $(`#scope-${target.dataset.scope}`).focus(); }
  if (target.id === "all-types") { ui.settings.types = target.checked ? SUPPORTED_RESOURCES.map((entry) => entry.type) : []; renderSettings(); $("#all-types").focus(); }
  if (target.dataset.type) {
    const supported = officialPolicyTypes(ui.settings.types);
    ui.settings.types = target.checked ? [...new Set([...supported, target.dataset.type])] : supported.filter((type) => type !== target.dataset.type);
    renderSettings();
    $$("[data-type]").find((element) => element.dataset.type === target.dataset.type)?.focus();
  }
  if (target.dataset.tagField === "operator") {
    ui.settings.tags[Number(target.dataset.tagIndex)].operator = target.value;
    renderSettings();
  }
  if (target.name === "restore-mode") { ui.restore.mode = target.value; ui.restore.plan = null; renderRestorePlanSection(); }
  if (target.id === "target-subscription") {
    ui.restore.groupId = store.state.scopes.find((scope) => scope.parentId === target.value && scope.kind === "resourceGroup").id;
    ui.restore.plan = null;
    renderRestorePlanSection();
  }
  if (target.id === "target-group") { ui.restore.groupId = target.value; ui.restore.plan = null; renderRestorePlanSection(); }
  if (target.id === "restore-confirm") { ui.restore.confirmed = target.checked; const btn = $("#execute-restore"); if (btn) btn.disabled = !target.checked; }
}

function bootstrap() {
  syncNavigation();
  try {
    store = new DemoStore(window.localStorage);
    ui = {
      page: "status", runId: latestRun().id, selectedId: null, focusId: null, pane: createPaneState(window.localStorage),
      expanded: new Set(store.state.scopes.map((scope) => scope.id)), treeNodes: [],
      filters: { query: "", status: "all", type: "", targetOnly: false },
      settings: clone(store.state.policy), restore: { resourceId: null, busy: false }, restoreTarget: "", restoreQuery: "",
      logs: { days: 7, level: "", query: "" }, logPage: 0,
      storage: createStorageState(window.localStorage),
    };
    render();
  } catch (error) {
    $("#main").innerHTML = `<section class="panel"><div class="panel-body"><h1>프리뷰를 열 수 없습니다</h1><p class="page-description">${esc(errorText(error))}</p><p class="page-description">예시 데이터를 조용히 덮어쓰지 않았습니다. 브라우저 저장소를 허용하거나 ‘예시 데이터 초기화’를 선택해 주세요.</p></div></section>`;
    showError(error);
  }
}

$("#main").addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled && target.getAttribute("aria-disabled") !== "true") handleAction(target.dataset.action, target).catch(showError);
});
$("#topbar-slot").addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled && target.getAttribute("aria-disabled") !== "true") handleAction(target.dataset.action, target).catch(showError);
});
$("#main").addEventListener("change", (event) => {
  try { handleChange(event.target); } catch (error) { showError(error); }
});
$("#main").addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "resource-search") { ui.filters.query = target.value; updateStatusResults(true); }
  if (target.id === "storage-search") { ui.storage.query = target.value; updateStorageView(); }
  if (target.dataset.tagField && target.dataset.tagField !== "operator") {
    ui.settings.tags[Number(target.dataset.tagIndex)][target.dataset.tagField] = target.value;
    updateSettingsSummary();
  }
  const demoCloneInputFields = {
    "demo-clone-prefix": "clonePrefix",
    "demo-clone-suffix": "cloneSuffix",
    "demo-clone-sequence": "cloneSequence",
    "target-name": "directName",
  };
  const cloneField = demoCloneInputFields[target.id];
  if (cloneField) {
    ui.restore[cloneField] = target.value;
    const resource = store.state.resources.find((item) => item.id === ui.restore.resourceId);
    ui.restore.name = computeDemoCloneName(ui.restore, resource);
    if (ui.restore.plan) { ui.restore.plan = null; renderRestorePlanSection(); $(`#${target.id}`)?.focus(); }
    else updateTargetPreview();
  }
});
$("#main").addEventListener("submit", (event) => {
  if (event.target.id !== "logs-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  ui.logs = { days: Number(form.get("days")), level: String(form.get("level")), query: String(form.get("query")) };
  ui.logPage = 0;
  renderLogs();
});
$("#main").addEventListener("keydown", (event) => {
  if (ui?.page === "storage" && handleStorageTableKey(event, $("#main"), ui.storage.index, ui.storage, {
    rerender: updateStorageView,
    inspectBlob: (blobName) => dialog("Blob 상세 정보", blobDetailDialogHtml(ui.storage.index, blobName, { esc, date, timezone: "KST" })),
  })) return;
  handleTreeKey(event);
});
bindTreePane($("#main"), { activePane: () => (ui?.page === "storage" ? ui.storage.pane : ui?.pane) },
  () => (ui.page === "storage" ? updateStorageView() : updateStatusResults()));
$("#main").addEventListener("focusin", (event) => {
  const row = event.target.closest("[data-node]");
  if (row) {
    ui.focusId = row.dataset.node;
    $$("[data-node]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; });
  }
  const storageRow = event.target.closest("[data-storage-row]");
  if (storageRow && ui?.storage) {
    ui.storage.focusId = storageRow.dataset.storageRow;
    $$("[data-storage-row]").forEach((item) => { item.tabIndex = item === storageRow ? 0 : -1; });
  }
});
document.addEventListener("click", (event) => {
  if (narrowScreen.matches && $("#sidebar").classList.contains("mobile-open")
      && !$("#sidebar").contains(event.target) && !$("#menu-toggle").contains(event.target)) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
    event.preventDefault();
    return;
  }
  const link = event.target.closest('a[href^="#"]');
  if (link && link.classList.contains("skip-link")) return;
  if (link && Object.hasOwn(PAGE_NAMES, link.hash.slice(1))) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
  }
  const global = event.target.closest("[data-global]")?.dataset.global;
  if (global === "reload") { allowUnload = true; location.reload(); }
});
$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("mobile-open");
  syncNavigation();
  if (open) $(".navigation a")?.focus();
});
narrowScreen.addEventListener("change", syncNavigation);
window.addEventListener("resize", syncNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && narrowScreen.matches && $("#sidebar").classList.contains("mobile-open")) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
    $("#menu-toggle").focus();
  }
});
$("#preview-guide").addEventListener("click", () => dialog("디자인 프리뷰 안내",
  "<p><strong>네 화면의 흐름을 검토하는 로컬 프리뷰입니다.</strong> 리소스, 백업, 변경 주체와 로그는 모두 가상 데이터입니다.</p><p>예시 설정과 복원 결과는 이 브라우저에만 저장합니다. 실제 Azure·Blob·Log Analytics·기존 CLI에는 연결하지 않습니다.</p><p>빨강은 보안 설정 변경·현재 부재, 주황은 그 외 구성 변경, 노랑은 태그·설명 변경을 보여주는 제안 정책입니다. 회색은 조회 미확인이며 차이로 단정하지 않습니다.</p><p>운영 연결 전에는 사용자 인증·범위 인가, 서버 비교 API, Activity Log 조회, 유형별 복원 검증과 내구성 있는 안전 백업을 별도로 구현해야 합니다.</p>"));
$("#reset-demo").addEventListener("click", () => {
  if (ui?.restore.busy) { toast("예시 복원이 끝난 뒤 초기화해 주세요.", "warning"); return; }
  dialog("예시 데이터를 초기화할까요?", "<p>이 브라우저에 저장한 예시 설정·안전 백업·복원 결과·로그만 초기화합니다. 실제 Azure와 프로젝트 설정 파일에는 영향을 주지 않습니다.</p>",
    '<button class="button" data-dialog="close">취소</button><button class="button danger" data-dialog="reset">예시 데이터 초기화</button>');
});
$("#dialog-close").addEventListener("click", () => $("#app-dialog").close());
$("#app-dialog").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  $("#app-dialog").close();
});
$("#app-dialog").addEventListener("close", () => {
  if ($("#app-dialog").open) return;
  const returnTarget = dialogTrigger && dialogTrigger.isConnected && dialogTrigger !== document.body
    ? dialogTrigger : $("#main");
  dialogTrigger = null;
  returnTarget?.focus({ preventScroll: true });
});
$("#dialog-actions").addEventListener("click", (event) => {
  const action = event.target.closest("[data-dialog]")?.dataset.dialog;
  if (action === "close") $("#app-dialog").close();
  if (action === "reset") {
    try { window.localStorage.removeItem(STORAGE_KEY); allowUnload = true; $("#app-dialog").close(); location.reload(); }
    catch (error) { $("#app-dialog").close(); showError(error); }
  }
});
window.addEventListener("hashchange", () => {
  if ($("#app-dialog").open) $("#app-dialog").close();
  if (store && ui) { render(); $("#main").focus({ preventScroll: true }); }
});
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) showError(new DemoError("다른 탭에서 예시 데이터가 변경됐습니다. 새로고침 후 다시 검토해 주세요."));
});
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && ui && JSON.stringify(ui.settings) !== JSON.stringify(store.state.policy)) event.preventDefault();
});
window.addEventListener("error", (event) => showError(event.error || new DemoError("화면 처리 중 오류가 발생했습니다. 작업을 중단하고 새로고침해 주세요.")));
window.addEventListener("unhandledrejection", (event) => showError(event.reason));
bootstrap();
