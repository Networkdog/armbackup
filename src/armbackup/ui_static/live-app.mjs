import {
  visibleTree, visibleTypeTree, ancestors, policySelection, policyMatchesScope, togglePolicyScope,
} from "./view-model.mjs";
import { HistoryPanel } from "./history-panel.mjs";
import { BundlePanel } from "./bundle-panel.mjs";
import { BACKUP_STATUS, backupHealth, recentResourceDays, relativeTime } from "./backup-view.mjs";
import { HISTORY_KINDS } from "./change-calendar.mjs";
import {
  LiveClient, ConsoleError, WORKFLOWS, rowsFor, initialRun, restoreAvailability,
  currentOnly, readableJob,
  scopeNoticeRequired, acknowledgeScopeNotice,
} from "./live-client.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const indent = (depth) => depth ? `<span class="scope-indent" aria-hidden="true">${"<span></span>".repeat(depth)}</span>` : "";
const clone = (value) => structuredClone(value);
const api = new LiveClient();
const narrowScreen = window.matchMedia("(max-width: 59.375em)");
const pages = { settings: "백업 대상 설정", status: "백업 현황", history: "변경 달력", relations: "자원·관계 작업대", restore: "복원", logs: "로그·작업 이력" };
const kinds = { manual: "수동 백업", safety: "복원 전 안전 백업", scheduled: "일일 백업", bundle: "묶음 백업" };
let state;
let session;
let toastTimer;
let historyPanel = null;
let historyCache = null;
let historyPreferences = null;
let bundlePanel = null;
let bundlePreferences = null;
let recentHistoryPromise = null;
let startupNoticeWorkspace = null;
const ui = {
  runId: "", selected: null, focus: null, expanded: new Set(), tree: [], page: "status",
  filters: { query: "", status: "all", backupStatus: "all", type: "", customer: "", priority: true },
  recentHistoryError: "", recentRecords: [], recentGeneration: 0,
  grouping: "hierarchy", typeGroupsInitialized: false,
  workflow: "all", loading: false, busy: false, stale: false, job: null, policy: null,
  scopesInitialized: false,
  restore: null, logs: null, logFilters: { days: 7, level: "", search: "" },
  logTab: "analytics", timezone: "Asia/Seoul",
};
const failure = (error) => error instanceof Error ? error.message : "알 수 없는 오류입니다. 작업 성공을 가정하지 않습니다.";

function date(value, short = false) {
  if (!value) return "미확인";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: ui.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${short ? "" : `${parts.year}.`}${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
const timezone = () => ui.timezone === "UTC" ? "UTC" : "KST";
const archiveLabel = () => state?.workspace.archiveLabel || session?.workspace.archiveLabel || "서버 백업 저장소";
const statusBadge = (status) => `<span class="status-badge">${icon(status === "same" ? "check" : status === "unknown" ? "help" : "edit")}${status === "same" ? "형상 같음" : status === "unknown" ? "비교 미확인" : "변경 있음"}</span>`;
function resourceSymbol(resource) {
  const icons = { "microsoft.network/applicationgateways": "gateway", "microsoft.network/loadbalancers": "balance",
    "microsoft.network/publicipaddresses": "globe" };
  const name = icons[resource.type] || (resource.type.includes("security") || resource.type.includes("firewall") ? "shield" : resource.type.startsWith("microsoft.cdn/") ? "globe" : "network");
  return `<span class="resource-symbol ${name === "shield" ? "security" : "network"}">${icon(name)}</span>`;
}
function button(action, label, name = "", primary = false, disabled = false) {
  return `<button class="button ${primary ? "primary" : ""}" data-action="${action}" ${disabled ? "disabled" : ""}>${name ? icon(name) : ""}${label}</button>`;
}
function heading(eyebrow, title, description, actions = "") {
  return `<section class="page-heading"><div><p class="heading-eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-description">${description}</p></div><div class="heading-actions">${actions}</div></section>`;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast-region").innerHTML = `<div class="toast">${esc(message)}</div>`;
  toastTimer = setTimeout(() => $("#toast-region").replaceChildren(), 6000);
}
function showError(error) {
  const target = $("#error-banner");
  target.innerHTML = `${icon("alert")}<span>${esc(failure(error))}</span><button class="button small" data-action="refresh">상태 다시 확인</button><button class="icon-button" data-action="dismiss-error" aria-label="오류 알림 닫기">${icon("close")}</button>`;
  target.hidden = false;
}
function dialog(title, body) {
  ui.recentGeneration++;
  $("#sidebar").classList.remove("mobile-open");
  syncNavigation();
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = body;
  $("#dialog-actions").innerHTML = '<button class="button primary" data-action="close-dialog">확인</button>';
  $("#app-dialog").showModal();
}
function showScopeGuide() {
  const workspace = session.workspace;
  const storage = workspace.archiveMode === "local"
    ? "명시적 로컬 디스크 검증 모드 · Blob 접속 검증이 아닙니다."
    : "Azure Blob · 완료 표식·SHA 검증";
  dialog("연결 범위 안내",
    `<p>생성·복원·복제는 <strong>${esc(workspace.resourceGroup)}</strong> 안의 표시된 실험 자원으로 제한합니다.</p>
    <dl class="summary-list"><dt>조회·백업</dt><dd>${esc(workspace.readScope || workspace.scope)}</dd><dt>복원·복제</dt><dd>${workspace.restoreEnabled ? esc(workspace.resourceGroup) : "비활성"}</dd><dt>저장 원천</dt><dd>${esc(storage)}</dd><dt>복구 제외</dt><dd>업무 데이터 · 인증서 · 권한 · 공유·주소 대상</dd></dl>
    <p>단일 운영자 LAB입니다. 실패는 자동 롤백이 아니며, 다른 실행자·Portal의 동시 변경은 별도 통제가 필요합니다.</p>`);
}
function showStartupNotice() {
  const workspace = session.workspace;
  let required = true;
  try { required = scopeNoticeRequired(window.sessionStorage, workspace); }
  catch (error) {
    if (!(error instanceof DOMException)) throw error;
    toast("브라우저 설정으로 안내 확인 기록을 읽지 못했습니다. 다시 안내합니다.");
  }
  if (!required) return;
  startupNoticeWorkspace = workspace;
  showScopeGuide();
}
function acknowledgeStartupNotice() {
  if (!startupNoticeWorkspace) return;
  const workspace = startupNoticeWorkspace;
  startupNoticeWorkspace = null;
  try { acknowledgeScopeNotice(window.sessionStorage, workspace); }
  catch (error) {
    if (!(error instanceof DOMException)) { showError(error); return; }
    toast("안내 확인을 보관하지 못했습니다. 새로고침하면 다시 표시될 수 있습니다.");
  }
}
function closeDialog() {
  acknowledgeStartupNotice();
  $("#app-dialog").close();
}
function syncNavigation() {
  if (!narrowScreen.matches) $("#sidebar").classList.remove("mobile-open");
  const open = narrowScreen.matches && $("#sidebar").classList.contains("mobile-open");
  $("#sidebar").inert = narrowScreen.matches && !open;
  $("#menu-toggle").setAttribute("aria-expanded", open);
  $("#menu-toggle").setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
}
function empty(title, message, action = "") {
  return `<div class="empty-state">${icon("shield")}<strong>${title}</strong>${message}${action ? `<p>${action}</p>` : ""}</div>`;
}
function selectionRows() {
  return rowsFor(state, ui.runId, { ...ui.filters, priority: false }).filter((row) => {
    const health = backupHealth(state, row.resource.id);
    return ui.filters.backupStatus === "all" || (ui.filters.backupStatus === "problem" ? health.red
      : health.status === ui.filters.backupStatus);
  }).sort((a, b) => {
    const rank = { failed: 0, never: 1, overdue: 2, unknown: 3, healthy: 4, excluded: 5 };
    return rank[backupHealth(state, a.resource.id).status] - rank[backupHealth(state, b.resource.id).status]
      || a.resource.name.localeCompare(b.resource.name);
  });
}
function selectedRow() { return rowsFor(state, ui.runId).find((row) => row.resource.id === ui.selected); }
function selectedRun() { return ui.runId === "latest" ? state.latestView : state.runs.find((run) => run.id === ui.runId); }
function download(name, content) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function workspaceContext() {
  const missing = state.resources.filter((resource) => state.current[resource.id.toLowerCase()]?.status === "missing").length;
  const unknown = state.resources.filter((resource) => state.current[resource.id.toLowerCase()]?.status === "error").length;
  const scopeLabel = state.workspace.inventoryScope === "subscription" ? "구독 전체 조회·백업" : state.workspace.resourceGroup;
  return `<section class="workspace-context" aria-label="현재 연결 범위" data-observed="${esc(state.observedAt)}"><div class="workspace-context-title"><span class="live-dot"></span><strong>${esc(state.workspace.name)}</strong><span class="context-chip" title="${esc(state.workspace.resourceGroup)}">복원·복제 LAB</span><span class="context-chip">${esc(archiveLabel())}</span></div><div class="context-path"><span>${esc(state.workspace.subscriptionName)}</span>${icon("chevron")}<strong>${esc(scopeLabel)}</strong></div><div class="context-observed"><span>${icon("clock")}ARM 관측 완료 ${date(state.observedAt)} ${timezone()}</span><label class="sr-only" for="timezone">표시 시간대</label><select id="timezone"><option value="Asia/Seoul" ${ui.timezone !== "UTC" ? "selected" : ""}>KST</option><option value="UTC" ${ui.timezone === "UTC" ? "selected" : ""}>UTC</option></select></div>${missing || unknown ? `<div class="context-health">현재 부재 ${missing} · 조회 미확인 ${unknown}</div>` : ""}</section>`;
}
function render() {
  if (!state) return;
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); historyPanel = null; }
  if (bundlePanel) { bundlePreferences = bundlePanel.snapshot(); bundlePanel.destroy(); bundlePanel = null; }
  const hash = location.hash.slice(1);
  ui.page = Object.hasOwn(pages, hash) ? hash : "status";
  document.title = `${pages[ui.page]} · armbackup LIVE`;
  $("#breadcrumb-current").textContent = pages[ui.page];
  $$(".navigation a").forEach((link) => {
    const active = link.dataset.page === ui.page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    if (link.dataset.page === "logs") link.querySelector("span").textContent = pages.logs;
  });
  $("#nav-count").textContent = rowsFor(state, ui.runId, { status: "changed" }).length;
  const main = $("#main");
  main.innerHTML = `${workspaceContext()}${ui.stale ? `<div class="notice ${state.materializedView?.requiresLiveRefresh ? "" : "error"} below-table">${icon("info")}${state.materializedView?.requiresLiveRefresh ? "검증된 저장 뷰 · 최신 ARM 관측 전 · 쓰기 잠금" : "조회 실패 후 이전 관측값 · 상태 재확인 전 쓰기 잠금"}</div>` : ""}<div id="read-progress"></div><div id="operation-status"></div><div id="page-content"></div>`;
  renderOperation();
  ({ status: renderStatus, history: renderHistory, relations: renderRelations, settings: renderSettings, restore: renderRestore, logs: renderLogs })[ui.page]();
}
function renderRelations() {
  $("#page-content").innerHTML = `${heading("RESOURCE WORKBENCH", "자원 · 관계 · 복원", "단일 / 포함 / 연관 / 공유", '<a class="button" href="#history">' + icon("calendar") + '변경 달력</a><a class="button" href="#logs">' + icon("logs") + '작업 이력</a>')}<div id="bundle-workbench"></div>`;
  bundlePanel = new BundlePanel($("#bundle-workbench"), {
    api, state, model: bundlePreferences, timezone: ui.timezone,
    run: async (action, payload) => {
      if (ui.busy || ui.stale) throw new ConsoleError("상태를 다시 조회하고 진행 중인 작업이 끝난 뒤 실행하세요.");
      ui.busy = true;
      $("#timezone").disabled = true;
      try {
        const job = await api.operation(action, payload, (progress) => { ui.job = progress; renderOperation(); });
        ui.job = job;
        return job;
      } finally { ui.busy = false; $("#timezone").disabled = false; }
    },
    refresh: async () => { historyCache = null; await refresh("latest"); },
    onLogs: (search) => { ui.logFilters.search = search; ui.logTab = "analytics"; location.hash = "logs"; loadLogs().catch(showError); },
  });
  bundlePreferences = bundlePanel.model;
}
function openBundle(row = selectedRow()) {
  bundlePreferences = { runId: row ? (row.snapshot.sourceRunId || ui.runId) : "current",
    selected: row ? [row.resource.id] : [], includeRelated: false,
    mode: row?.observation?.status === "missing" ? "create" : "update" };
  if (location.hash === "#relations") render(); else location.hash = "relations";
}
function renderHistory() {
  $("#page-content").innerHTML = `<div id="change-history" class="panel change-history-panel"></div>`;
  historyPanel = new HistoryPanel($("#change-history"), {
    timezone: ui.timezone, initial: historyPreferences,
    load: async (force) => {
      if (force || !historyCache) historyCache = await api.history();
      return historyCache;
    },
    detail: (record) => api.historyDetail(record),
  });
}
function renderOperation() {
  const target = $("#operation-status");
  if (!target) return;
  if (!ui.job) { target.replaceChildren(); return; }
  const running = ["Queued", "Running"].includes(ui.job.status);
  target.innerHTML = `<div class="operation-strip ${ui.job.status === "Failed" ? "failed" : ""}" role="status" aria-live="polite">${running ? '<span class="spinner"></span>' : icon(ui.job.status === "Failed" ? "alert" : "check")}<span><strong>${esc(readableJob(ui.job))}</strong><small>작업 ${esc(ui.job.id)}${ui.job.safetyRunId ? ` · 안전 백업 ${esc(ui.job.safetyRunId)}` : ""}${ui.job.appliedResources ? ` · 적용 ${ui.job.appliedResources.length}개${ui.job.status === "Failed" ? " · 전체 검증 미완료 · 롤백 아님" : ""}` : ""}</small></span><span class="operation-state">${esc(ui.job.status)}</span>${ui.job.status === "Failed" && ui.job.sourceRunId ? button("recover-bundle", "부분 적용 다시 검토", "layers") : ""}</div>`;
}
async function refresh(preferred = ui.runId, fresh = true) {
  ui.recentHistoryError = "";
  ui.loading = true;
  if ($("#read-progress")) $("#read-progress").innerHTML = '<div class="operation-strip" role="status"><span class="spinner"></span><span>ARM 형상·검증된 백업·최근 관리 작업을 다시 읽고 있습니다. 표시된 이전 관측값은 완료 후 교체합니다.</span></div>';
  $$("[data-action='refresh']").forEach((control) => { control.disabled = true; });
  if (!state) $("#main").innerHTML = '<div class="initial-loading" role="status">허용 범위의 ARM 형상과 지정 저장소의 백업을 읽는 중입니다. 예시 데이터는 사용하지 않습니다…</div>';
  const oldPolicy = state?.policy;
  try {
    const next = await api.state(fresh);
    if (next.mode !== "live-lab" || !Array.isArray(next.runs) || !Array.isArray(next.resources)) throw new ConsoleError("실환경 상태 형식이 올바르지 않습니다.");
    state = next;
    ui.runId = initialRun(state, preferred);
    if (!ui.policy || JSON.stringify(ui.policy) === JSON.stringify(oldPolicy)) ui.policy = clone(state.policy);
    if (!ui.scopesInitialized) {
      ui.expanded = new Set(state.scopes.map((scope) => scope.id));
      ui.scopesInitialized = true;
    }
    ui.stale = next.materializedView?.requiresLiveRefresh === true;
    ui.loading = false;
    $("#error-banner").hidden = true;
    render();
    if (ui.stale) $("#read-progress").innerHTML = '<div class="operation-strip" role="status"><span class="spinner"></span>SHA와 입력 세대를 검증한 저장 뷰입니다. 현재 ARM 상태를 갱신 중이며 쓰기는 잠겨 있습니다.</div>';
  } catch (error) {
    ui.stale = true;
    ui.loading = false;
    showError(error);
    if (state) render();
    else $("#main").innerHTML = `<section class="panel">${empty("실환경을 조회하지 못했습니다", "권한·연결·범위를 확인해 주세요. 예시 데이터로 대체하지 않았습니다.", button("refresh", "연결 다시 확인", "refresh", true))}</section>`;
    throw error;
  } finally { ui.loading = false; }
}
async function operation(action, payload) {
  if (ui.busy || ui.stale) throw new ConsoleError("현재 작업이 끝나고 상태를 다시 확인한 뒤 실행해 주세요.");
  ui.busy = true;
  render();
  try {
    const job = await api.operation(action, payload, (progress) => {
      ui.job = progress;
      renderOperation();
      if (ui.page === "restore" && ui.restore) renderRestore();
    });
    ui.job = job;
    return job;
  } finally { ui.busy = false; render(); }
}

function renderStatus() {
  const target = $("#page-content");
  const all = rowsFor(state, ui.runId);
  const counts = Object.fromEntries(Object.keys(BACKUP_STATUS).map((status) => [status, all.filter((row) => backupHealth(state, row.resource.id).status === status).length]));
  target.innerHTML = `
    ${heading("MSP OPERATIONS", "백업 현황", "변경 확인 → 관계 검토 → 안전 백업 → 복원",
      `${button("open-bundle", "관계·묶음", "layers", false, ui.busy)}${button("export-report", "인수인계", "logs", false, !ui.runId || ui.busy)}${button("refresh", "현재 조회", "refresh", false, ui.busy || ui.loading)}${button("backup-now", "백업", "plus", true, ui.busy || ui.stale)}`)}
    <div class="workflow-bar" aria-label="엔지니어 업무 모드">${Object.entries(WORKFLOWS).map(([id, workflow]) => `<button class="workflow-button ${ui.workflow === id ? "active" : ""}" data-action="workflow" data-id="${id}" aria-pressed="${ui.workflow === id}" title="${esc(workflow.hint)}">${icon({ all: "grid", oncall: "pulse", change: "edit", backup: "storage", audit: "logs" }[id])}${workflow.name}</button>`).join("")}</div>
    <section class="summary-cards" aria-label="리소스별 최근 일반 백업 상태">${Object.entries(BACKUP_STATUS).map(([status, info]) => `<button class="summary-card backup-${status}" data-action="backup-filter" data-id="${status}" aria-pressed="${ui.filters.backupStatus === status}"><span class="summary-top"><span class="summary-icon">${icon(info.icon)}</span>${info.label}</span><span class="summary-value">${counts[status]}<small>개</small></span></button>`).join("")}</section>
    ${state.warnings.length ? `<div class="notice warning below-table">${icon("alert")}<div>${state.warnings.map(esc).join("<br>")}</div></div>` : ""}
    ${!state.runs.length && !state.resources.length ? `<section class="panel">${empty("아직 보관한 백업이 없습니다", "백업 대상을 확인하세요.", button("backup-now", "첫 백업 만들기", "plus", true, ui.busy))}</section>` : `
    <section class="panel below-table" aria-labelledby="comparison-title"><div class="panel-header"><h2 class="panel-title" id="comparison-title">보호 자원 · 형상 비교 <span class="count-pill">${all.length}개 백업</span></h2><span class="panel-header-note">현재값은 개별 ARM GET 관측 · 기준 시각 고정</span></div>
      <div class="toolbar"><label class="search-field">${icon("search")}<input type="search" id="resource-search" aria-label="리소스 검색" value="${esc(ui.filters.query)}" placeholder="리소스 이름, ID, 고객·담당 태그 검색"></label>
      <select id="customer-filter" class="filter-select" aria-label="고객 필터"><option value="">모든 고객 태그</option>${[...new Set(state.resources.map((resource) => resource.tags?.customer).filter(Boolean))].sort().map((customer) => `<option ${ui.filters.customer === customer ? "selected" : ""}>${esc(customer)}</option>`).join("")}</select>
      <select id="backup-status-filter" class="filter-select" aria-label="최근 백업 상태 필터"><option value="all">모든 백업 상태</option><option value="problem">실패·미백업</option>${Object.entries(BACKUP_STATUS).map(([status, info]) => `<option value="${status}">${info.label}</option>`).join("")}</select>
      <select id="group-view" class="filter-select" aria-label="리소스 그룹 보기"><option value="hierarchy" ${ui.grouping === "hierarchy" ? "selected" : ""}>리소스 체계별</option><option value="type" ${ui.grouping === "type" ? "selected" : ""}>리소스 종류별</option></select>
      <select id="type-filter" class="filter-select" aria-label="리소스 종류 필터"><option value="">모든 종류</option>${[...new Map(state.resources.map((resource) => [resource.type, resource.typeLabel])).entries()].map(([type, label]) => `<option value="${type}" ${ui.filters.type === type ? "selected" : ""}>${label}</option>`).join("")}</select>
      </div>
      <div class="run-strip"><div class="run-meta">${icon("clock")}<span class="run-label">비교 기준</span><select id="baseline-run" class="run-select" aria-label="비교 기준 백업">${state.latestView?.snapshots.length ? `<option value="latest" ${ui.runId === "latest" ? "selected" : ""}>리소스별 최신 검증된 일반 백업 · 행별 시각</option>` : ""}${state.runs.map((run) => `<option value="${run.id}" ${run.id === ui.runId ? "selected" : ""}>${date(run.capturedAt)} · ${esc(run.label || kinds[run.kind] || "백업")} · ${run.status}</option>`).join("")}</select><span id="shown-count"></span></div><div><button class="button ghost small" data-action="expand-all">펼치기</button><button class="button ghost small" data-action="collapse-all">접기</button></div></div>
      ${ui.runId === "latest" ? '<div class="latest-source-note">삭제되거나 다음 백업에서 제외된 자원도 마지막 검증된 일반 백업을 유지합니다. 안전 백업은 기준에서 제외하며, 행들의 수집 시각은 서로 다를 수 있습니다.</div>' : ""}
      <div id="recent-history-notice"></div><div class="table-scroll" id="tree-container"></div><div class="table-bottom"><span>행 음영: 최근 일반 백업 상태 · 빨강: 실패/없음/24시간 이상 미백업</span><span>미니 달력: 변경 기록 수 · 왼쪽 과거 → 오른쪽 오늘</span></div>
      <div class="selection-toolbar"><span id="selection-hint">행을 선택하면 속성 차이와 복원 가능 범위를 확인합니다.</span>${button("start-restore", "선택 리소스 복원", "restore", true, true)}</div>
    </section><div id="current-only-note" class="below-table"></div><div id="resource-detail"></div>`}
    <p class="status-note">${icon("info")}백업 상태는 비교 기준 날짜와 독립적인 최신 일반 백업 기준입니다. 안전 백업은 제외합니다. 상대시각 위에 마우스를 올리면 정확한 시각을 표시합니다.</p>
    ${state.historyLimited ? '<p class="status-note">최근 30개 백업만 화면에 읽었습니다. 전체 보관 수는 ' + state.totalRuns + '개입니다.</p>' : ""}`;
  if (ui.runId) {
    $("#backup-status-filter").value = ui.filters.backupStatus;
    updateTree();
    loadRecentHistory();
  }
}
function loadRecentHistory() {
  if (historyCache || recentHistoryPromise || ui.recentHistoryError) return;
  const observed = state.observedAt;
  recentHistoryPromise = api.history().then((data) => {
    if (!Array.isArray(data.records)) throw new ConsoleError("변경 이력 데이터가 불완전합니다.");
    if (state.observedAt === observed) historyCache = data;
  }).catch((error) => {
    ui.recentHistoryError = failure(error);
  }).finally(() => {
    recentHistoryPromise = null;
    if (ui.page === "status" && $("#tree-container")) {
      $("#recent-history-notice").innerHTML = ui.recentHistoryError ? `<div class="notice error" role="alert">변경 이력 조회 실패 · ${esc(ui.recentHistoryError)}</div>` : "";
      updateTree();
      if (!historyCache && !ui.recentHistoryError) loadRecentHistory();
    }
  });
}
function miniCalendar(resourceId) {
  return `<div class="recent-days" aria-label="최근 10일 변경">${recentResourceDays(historyCache, resourceId, Date.now(), ui.timezone).map((day) => {
    const label = `${day.date} · ${day.status === "changed" ? `변경 ${day.changes}건` : { loading: "이력 조회 중", unknown: "비교 미확인", unchanged: "변화 없음", baseline: "첫 관측", unobserved: "관측 없음" }[day.status]}`;
    return `<button class="recent-day day-${day.status} day-level-${Math.min(4, day.changes)}" data-action="recent-day" data-resource="${esc(resourceId)}" data-day="${day.date}" title="${esc(label)}" aria-label="${esc(label)}" ${!historyCache ? "disabled" : ""}></button>`;
  }).join("")}</div>`;
}
function updateTree(reveal = false) {
  const rows = selectionRows();
  if (reveal) rows.forEach((row) => {
    if (ui.grouping === "type") ui.expanded.add(`type:${row.resource.type}`);
    else ancestors(state, row.resource.groupId).forEach((scope) => ui.expanded.add(scope.id));
  });
  if (!rows.some((row) => row.resource.id === ui.selected)) ui.selected = null;
  const nodes = ui.grouping === "type" ? visibleTypeTree(rows, ui.expanded) : visibleTree(state, rows, ui.expanded);
  ui.tree = nodes;
  if (!nodes.some((node) => node.id === ui.focus)) ui.focus = nodes[0]?.id;
  $("#shown-count").textContent = `${rows.length}개 표시 · ${timezone()} · 형제 내 우선순위 정렬`;
  const body = nodes.map((node, index) => {
    const common = `data-node="${esc(node.id)}" tabindex="${ui.focus === node.id ? 0 : -1}" role="row" aria-level="${node.level}" aria-rowindex="${index + 2}" aria-posinset="${node.position}" aria-setsize="${node.setSize}"`;
    if (node.kind === "scope") {
      const open = ui.expanded.has(node.id);
      const labels = { managementGroup: "Management Group", subscription: "Subscription", resourceType: "리소스 종류", resourceGroup: "Resource Group" };
      return `<tr ${common} class="scope-row" aria-expanded="${open}"><td role="gridcell"></td><td role="gridcell" colspan="6"><div class="scope-cell">${indent(node.level - 1)}<button class="tree-toggle ${open ? "open" : ""}" data-action="toggle-scope" data-id="${node.id}" aria-label="${esc(node.scope.name)} ${open ? "접기" : "펼치기"}" tabindex="-1">${icon("chevron")}</button>${icon(node.scope.kind === "managementGroup" ? "layers" : node.scope.kind === "subscription" ? "cloud" : node.scope.kind === "resourceType" ? "box" : "folder")}<span class="scope-name">${esc(node.scope.name)}</span><span class="count-pill">${node.count}</span><span class="scope-kind">${labels[node.scope.kind]}</span></div></td></tr>`;
    }
    const row = node.row;
    const current = row.observation;
    const availability = restoreAvailability(state, row);
    const actor = current?.actor;
    const health = backupHealth(state, row.resource.id);
    return `<tr ${common} class="resource-row backup-${health.status} ${ui.selected === node.id ? "selected" : ""}" aria-selected="${ui.selected === node.id}" data-action="select-resource" data-id="${esc(node.id)}">
      <td role="gridcell"><input type="checkbox" tabindex="-1" aria-label="${esc(row.resource.name)} 선택" ${ui.selected === node.id ? "checked" : ""}></td>
      <td role="gridcell"><div class="resource-identity">${indent(node.level - 1)}${resourceSymbol(row.resource)}<span class="resource-name-wrap"><span class="resource-name" title="${esc(node.id)}">${esc(row.resource.name)}</span><span class="resource-region">${esc(row.resource.tags?.customer || "고객 태그 없음")} · ${esc(row.resource.tags?.owner || "담당 미지정")}</span></span></div></td>
      <td role="gridcell"><span class="type-text">${esc(row.resource.typeLabel)}</span><span class="table-sub">${row.snapshot.restoreSupported ? "형상 복원 지원 · LAB" : "비교만 지원"}</span></td>
      <td role="gridcell"><time class="table-time" datetime="${esc(row.snapshot.capturedAt || "")}" title="${row.snapshot.capturedAt ? date(row.snapshot.capturedAt) + " " + timezone() : "검증된 백업 없음"}">${relativeTime(row.snapshot.capturedAt)}</time><span class="table-sub" title="${esc(health.lastAttemptAt)}">${icon(BACKUP_STATUS[health.status].icon)}${health.label}</span></td>
      <td role="gridcell"><span class="table-time">${current?.status === "present" ? date(current.observedAt, true) : current?.status === "missing" ? "현재 부재 확인" : "조회 미확인"}</span><span class="table-sub">${esc(current?.code || current?.provisioningState || "ARM REST")}</span></td>
      <td role="gridcell">${miniCalendar(row.resource.id)}<span class="table-sub">${row.status === "same" ? "현재 형상 같음" : row.status === "unknown" ? "현재 비교 미확인" : "현재 형상 차이 있음"}</span></td>
      <td role="gridcell">${actor ? `<span class="actor-name" title="${esc(actor.operation)} · ${esc(actor.eventResourceId || row.resource.id)}">${esc(actor.caller)}</span><span class="table-sub">${date(actor.at, true)} · 최근 ${state.workspace.activityDays}일</span>` : '<span class="actor-empty">미확인</span><span class="table-sub">기간 내 없음·지연·권한 확인</span>'}<span class="sr-only">${esc(availability.reason)}</span></td>
    </tr>`;
  }).join("");
  $("#tree-container").innerHTML = nodes.length ? `<table class="resource-table" role="treegrid" aria-label="실제 Azure 최근 백업 상태와 최근 10일 변경" aria-multiselectable="false" aria-colcount="7" aria-rowcount="${nodes.length + 1}"><colgroup><col class="selection-col"><col class="resource-col"><col class="type-col"><col class="time-col"><col class="time-col"><col class="recent-col"><col class="actor-col"></colgroup><thead><tr role="row" aria-rowindex="1"><th role="columnheader"><span class="sr-only">선택</span></th><th role="columnheader">리소스 / 고객 · 담당</th><th role="columnheader">종류 / 복원 지원</th><th role="columnheader">백업 형상 · 상대시각</th><th role="columnheader">현재 형상</th><th role="columnheader">변경 달력 · 최근 10일</th><th role="columnheader">기간 내 최근 변경 주체</th></tr></thead><tbody>${body}</tbody></table>` : empty("조건에 맞는 백업 자원이 없습니다", selectedRun()?.absences.length ? "이 안전 백업은 부재 기록만 포함할 수 있습니다. 다른 기준 백업을 선택해 주세요." : "고객·백업 상태·검색 필터를 확인해 주세요.");
  const extras = currentOnly(state, ui.runId);
  $("#current-only-note").innerHTML = extras.length ? `<div class="notice warning">${icon("info")}<span>이 기준 백업에 없는 현재 자원이 <strong>${extras.length}개</strong> 있습니다. 백업 범위 차이일 수 있으며 자동 삭제하지 않습니다. <button class="text-button" data-action="current-only">기준에 없는 목록 확인</button></span></div>` : "";
  const row = selectedRow();
  const availability = row ? restoreAvailability(state, row) : { allowed: false };
  const restore = $('[data-action="start-restore"]');
  restore.disabled = !availability.allowed || ui.busy || ui.stale;
  restore.title = availability.reason || "최종 리소스 행을 선택해 주세요.";
  $("#selection-hint").innerHTML = row ? `<strong>${esc(row.resource.name)}</strong> 선택 · ${esc(availability.reason)}` : "행을 선택하면 속성 차이와 복원 가능 범위를 확인합니다.";
  renderDetail(row);
  $$(".summary-card").forEach((card) => {
    const count = rowsFor(state, ui.runId).filter((row) => backupHealth(state, row.resource.id).status === card.dataset.id).length;
    $(".summary-value", card).innerHTML = `${count}<small>개</small>`;
    const active = ui.filters.backupStatus === card.dataset.id;
    card.classList.toggle("active", active); card.setAttribute("aria-pressed", active);
  });
}
function diffTable(diffs, truncated = false) {
  const value = (diff, side) => diff[`${side}Present`] ? JSON.stringify(diff[side]) : "필드 없음";
  return `<div class="table-scroll"><table class="diff-table"><thead><tr><th>속성 경로</th><th>선택한 백업 · 복원 목표</th><th>현재 관측값</th></tr></thead><tbody>${diffs.map((diff) => `<tr><td class="mono">${esc(diff.path)}</td><td class="diff-before mono">${esc(value(diff, "before"))}</td><td class="diff-after mono">${esc(value(diff, "after"))}</td></tr>`).join("")}</tbody></table></div>${truncated ? '<div class="notice warning">차이가 많아 처음 200개만 표시합니다. 전체 일치로 해석하지 마세요.</div>' : ""}`;
}
function renderDetail(row) {
  const target = $("#resource-detail");
  if (!row) { target.replaceChildren(); return; }
  target.innerHTML = `<section class="panel detail-panel"><div class="panel-header"><h2 class="panel-title">${esc(row.resource.name)} · 변경 검토 ${statusBadge(row.status)}</h2><button class="icon-button" data-action="clear-selection" aria-label="상세 닫기">${icon("close")}</button></div><div class="detail-content"><p class="small-text muted">${esc(row.reason)} · 프로필 ${esc(row.profile)} · API ${esc(row.snapshot.apiVersion)}</p><code class="resource-id">${esc(row.resource.id)}</code>
    ${row.diffs.length ? diffTable(row.diffs, row.truncated) : `<div class="notice ${row.status === "same" ? "success" : "warning"} below-table">${icon(row.status === "same" ? "check" : "help")}${esc(row.reason)}</div>`}
    <div class="detail-tags">${Object.entries(row.snapshot.raw?.tags || {}).filter(([name]) => !["armbackupLab", "expiresOn", "purpose", "lifecycle"].includes(name)).map(([name, value]) => `<span class="tag-chip">${esc(name)} <strong>${esc(value)}</strong></span>`).join("")}</div>
    <div class="detail-actions">${button("open-bundle", "단일·관계 묶음 검토", "layers")}<a class="button" href="#history">${icon("calendar")}날짜별 변경</a></div><p class="small-text muted">공유·주소 참조는 별도 검증 · 인증서·RBAC·진단 설정·업무 데이터 제외</p></div></section>`;
}

function policyMatches(resource, policy) {
  const contained = resource.type.startsWith("microsoft.cdn/profiles/") || resource.type.startsWith("microsoft.network/loadbalancers/");
  if (!policyMatchesScope(state, resource, policy)) return false;
  if (!policy.types.includes(resource.type) && !(contained && policy.types.some((type) =>
    ["microsoft.cdn/profiles", "microsoft.network/loadbalancers"].includes(type) && resource.type.startsWith(type + "/")))) return false;
  const tags = Object.fromEntries(Object.entries(resource.tags || {}).map(([name, value]) => [name.toLowerCase(), value]));
  return policy.tags.every((rule) => Object.hasOwn(tags, rule.key.toLowerCase()) && (rule.operator === "exists" || tags[rule.key.toLowerCase()] === rule.value));
}
function updatePolicyPreview() {
  const selected = state.resources.filter((resource) => state.current[resource.id.toLowerCase()]?.status === "present" && policyMatches(resource, ui.policy));
  $("#target-count").textContent = selected.length;
  $("#policy-dirty").textContent = JSON.stringify(ui.policy) === JSON.stringify(state.policy) ? "서버에 보관한 설정과 같습니다." : "아직 서버에 저장하지 않은 변경이 있습니다.";
}
function renderSettings() {
  const policy = ui.policy;
  const choices = policySelection(state, policy);
  const scopeNames = { managementGroup: "Management Group", subscription: "Subscription", resourceGroup: "Resource Group" };
  const scopeIcons = { managementGroup: "layers", subscription: "cloud", resourceGroup: "folder" };
  const wholeSubscription = state.workspace.inventoryScope === "subscription";
  $("#page-content").innerHTML = `
    ${heading("PROTECTION POLICY", "백업 대상 설정", "범위·종류·태그로 다음 백업 대상을 지정합니다.",
      `${button("discard-policy", "변경 취소")}${button("save-policy", "서버에 대상 저장", "check", true, ui.busy || ui.stale)}`)}
    <div class="settings-layout"><div class="settings-sections">
    <section class="panel"><div class="panel-header"><h2 class="panel-title"><span class="section-number">01</span>허용된 리소스 체계</h2><span class="context-chip">${wholeSubscription ? "구독 전체 조회·백업" : "LAB 범위"}</span></div><div class="panel-body"><p class="section-description">관리 그룹 → 구독 → 리소스 그룹 · 상위 선택 시 허용된 하위 범위 포함</p><div class="scope-choices">
    ${choices.map((node) => `<label class="scope-choice ${node.kind}">${indent(node.depth)}<input type="checkbox" data-policy-scope="${esc(node.id)}" ${node.checked ? "checked" : ""}>${icon(scopeIcons[node.kind])}<span class="scope-choice-name" title="${esc(node.detail || node.id)}">${esc(node.name)}</span><span class="scope-choice-detail">${esc(scopeNames[node.kind])}</span></label>`).join("")}</div></div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title"><span class="section-number">02</span>수집할 리소스 종류</h2></div><div class="panel-body"><div class="type-grid">${[...new Map(state.resources.map((resource) => [resource.type, resource.typeLabel])).entries()].map(([type, name]) => `<label class="type-option ${policy.types.includes(type) ? "checked" : ""}"><input type="checkbox" data-type="${type}" ${policy.types.includes(type) ? "checked" : ""}>${icon("network")}<span>${name}</span></label>`).join("")}</div></div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title"><span class="section-number">03</span>태그 조건</h2><span class="panel-header-note">모두 만족 · AND</span></div><div class="panel-body">${policy.tags.length ? policy.tags.map((tag, index) => `<div class="tag-rule"><input type="text" data-tag-index="${index}" data-field="key" aria-label="태그 ${index + 1} 이름" value="${esc(tag.key)}" placeholder="customer"><select data-tag-index="${index}" data-field="operator" aria-label="태그 ${index + 1} 연산자"><option value="equals" ${tag.operator === "equals" ? "selected" : ""}>같음 =</option><option value="exists" ${tag.operator === "exists" ? "selected" : ""}>키 있음</option></select><input type="text" data-tag-index="${index}" data-field="value" aria-label="태그 ${index + 1} 값" value="${esc(tag.value)}" placeholder="customer-alpha" ${tag.operator === "exists" ? "disabled" : ""}><button class="icon-button" data-action="remove-tag" data-index="${index}" aria-label="태그 ${index + 1} 삭제">${icon("close")}</button></div>`).join("") : '<p class="empty-tags">조건이 없으면 모든 태그를 포함합니다.</p>'}${button("add-tag", "태그 조건 추가", "plus")}</div></section>
    <p class="small-text muted" id="policy-dirty"></p></div>
    <aside class="panel settings-summary"><div class="summary-preview"><p class="heading-eyebrow">EFFECTIVE TARGETS</p><h2 class="panel-title">다음 백업의 예상 대상</h2><div class="summary-preview-number"><strong id="target-count">0</strong><span>개 리소스</span></div><p class="small-text muted">현재 ARM · 범위 ∩ 종류 ∩ 태그</p></div><div class="panel-body">${button("backup-now", "저장한 설정으로 지금 백업", "plus", true, ui.busy || ui.stale)}</div></aside></div>`;
  const statuses = new Map(choices.map((node) => [node.id, node]));
  $$("[data-policy-scope]").forEach((input) => { input.indeterminate = statuses.get(input.dataset.policyScope).indeterminate; });
  updatePolicyPreview();
}

function startRestore(id) {
  const row = rowsFor(state, ui.runId).find((item) => item.resource.id === id);
  const availability = restoreAvailability(state, row);
  if (!availability.allowed) throw new ConsoleError(availability.reason);
  if (!["microsoft.network/networksecuritygroups", "microsoft.network/routetables"].includes(row.resource.type)) {
    openBundle(row);
    return;
  }
  ui.restore = {
    resourceId: id, runId: row.snapshot.sourceRunId || ui.runId, step: 1,
    mode: row.observation.status === "present" ? "update" : "create",
    targetName: row.observation.status === "present" ? `${row.resource.name}-restored` : row.resource.name,
    ticket: "", reason: "", plan: null, confirmTarget: "", confirmed: false, result: null,
  };
  location.hash = "restore";
  renderRestore();
}
function renderRestore() {
  const target = $("#page-content");
  const r = ui.restore;
  target.innerHTML = heading("REVIEWED RECOVERY", "복원", `과거 형상을 검토하고, 현재 상태를 ${esc(archiveLabel())}에 안전 백업한 뒤 명시적으로 적용합니다.`);
  if (!r) {
    const candidates = rowsFor(state, ui.runId).filter((row) => restoreAvailability(state, row).allowed);
    target.insertAdjacentHTML("beforeend", `<section class="panel restore-empty">${icon("restore")}<h2>복원할 자원을 선택하세요</h2><p>NSG와 Route Table의 검토한 형상을 지원합니다.<br>지원하지 않는 유형이나 현재 미확인 자원은 실행하지 않습니다.</p><select id="restore-picker" class="restore-resource-picker" aria-label="복원할 리소스"><option value="">리소스 선택</option>${candidates.map((row) => `<option value="${esc(row.resource.id)}">${esc(row.resource.name)} · ${row.resource.typeLabel}</option>`).join("")}</select><a class="button" href="#status">현황에서 변경 검토</a></section>`);
    return;
  }
  const resource = state.resources.find((item) => item.id === r.resourceId);
  const history = state.runs.filter((run) => run.snapshots.some((snapshot) => snapshot.resourceId.toLowerCase() === r.resourceId.toLowerCase()));
  target.insertAdjacentHTML("beforeend", `<ol class="stepper" aria-label="복원 단계">${["백업 시점", "방식·변경 근거", "계획 확인·승인"].map((label, index) => `<li class="wizard-step ${r.step === index + 1 ? "active" : r.step > index + 1 ? "done" : ""}" ${r.step === index + 1 ? 'aria-current="step"' : ""}><span class="step-number">${r.step > index + 1 ? icon("check") : `0${index + 1}`}</span><span>${label}</span></li>`).join("")}</ol>
    <div class="restore-context">${resourceSymbol(resource)}<div class="restore-context-main"><strong>${esc(resource.name)}</strong><code class="resource-id">${esc(resource.id)}</code></div>${button("clear-restore", "자원 변경", "", false, ui.busy)}</div><section class="panel" id="restore-body"></section>`);
  const body = $("#restore-body");
  if (ui.busy) {
    body.innerHTML = `<div class="panel-body"><h2 class="panel-title">작업을 진행하고 있습니다</h2><div class="execution-list"><div class="execution-item running"><span class="spinner"></span>${ui.job ? esc(readableJob(ui.job)) : "서버에 작업 제출"}</div></div><div class="notice warning">${icon("info")}다시 실행하지 마세요. 실패 응답도 자동 롤백을 의미하지 않습니다. 작업 ID와 안전 백업을 확인할 수 있습니다.</div></div>`;
    return;
  }
  if (r.result) {
    const result = r.result;
    body.innerHTML = `<div class="panel-body"><div class="result-header"><span class="result-icon">${icon("check")}</span><div><h2>Azure 형상 복원·검증을 완료했습니다</h2><p>요청한 관리 설정을 적용하고 사후 비교에서 일치를 확인했습니다.</p></div></div><dl class="result-meta"><div><dt>변경 티켓</dt><dd>${esc(result.ticket)}</dd></div><div><dt>안전 백업</dt><dd class="mono">${esc(result.safetyRunId)}</dd></div><div><dt>대상</dt><dd class="mono">${esc(result.targetResourceId)}</dd></div><div><dt>검증 시각</dt><dd>${date(result.verifiedAt)} ${timezone()}</dd></div></dl><div class="notice warning">${icon("info")}형상 일치는 업무 서비스·트래픽·데이터 복구 검증이 아닙니다. 실제 사용 전 별도 기능 검증이 필요합니다.</div></div><div class="wizard-actions">${button("restore-logs", "티켓·실행 로그 확인", "logs")}${button("restore-status", "현재 형상으로 돌아가기", "arrow", true)}</div>`;
    return;
  }
  if (r.step === 1) {
    body.innerHTML = `<div class="panel-header"><h2 class="panel-title">복원 기준 시점을 선택하세요</h2><span class="panel-header-note">${timezone()} · 완료 표식·SHA 검증</span></div><div class="panel-body"><div class="history-list">${history.map((run) => `<label class="history-option ${r.runId === run.id ? "checked" : ""}"><input type="radio" name="restore-run" value="${run.id}" ${r.runId === run.id ? "checked" : ""} ${run.status === "Captured" ? "" : "disabled"}><span><span class="history-date">${date(run.capturedAt)} · ${esc(run.label || kinds[run.kind] || "백업")}</span><span class="history-meta">${run.id} · ${run.status}</span></span><span class="history-kind">${kinds[run.kind] || "백업"}</span></label>`).join("")}</div><div class="notice below-table">${icon("shield")}적용 전 현재 형상 또는 부재 확인을 별도 보관합니다. 안전 백업 저장·로그 전송·완료 표식·재검증이 실패하면 ARM 쓰기를 하지 않습니다.</div></div><div class="wizard-actions"><a class="button" href="#status">취소</a>${button("restore-next", "복원 방식 선택", "arrow", true)}</div>`;
  } else if (r.step === 2) {
    const present = state.current[r.resourceId.toLowerCase()]?.status === "present";
    body.innerHTML = `<div class="panel-header"><h2 class="panel-title">복원 방식과 변경 근거를 기록하세요</h2><span class="panel-header-note">이전 관측값만으로 실행하지 않음</span></div><div class="panel-body">
      <div class="mode-grid"><label class="mode-card ${r.mode === "create" ? "checked" : ""}"><span class="mode-title"><input type="radio" name="restore-mode" value="create" ${r.mode === "create" ? "checked" : ""}>신규 생성 · Create-only</span><p>같은 허용 RG의 새 이름에 만듭니다.<br>대상이 이미 있으면 중단합니다.</p></label><label class="mode-card ${r.mode === "update" ? "checked" : ""} ${present ? "" : "disabled"}"><span class="mode-title"><input type="radio" name="restore-mode" value="update" ${r.mode === "update" ? "checked" : ""} ${present ? "" : "disabled"}>기존 업데이트 · Update-only</span><p>선택 자원에만 적용합니다.<br>없어졌다면 생성으로 바꾸지 않습니다.</p></label></div>
      <div class="target-form">${r.mode === "create" ? `<label class="field full">신규 리소스 이름<input type="text" id="target-name" value="${esc(r.targetName)}" maxlength="63"></label>` : ""}
      <label class="field">변경·장애 티켓 <span class="required">필수</span><input type="text" id="restore-ticket" value="${esc(r.ticket)}" placeholder="CHG-20261031-001" maxlength="80"></label><label class="field">적용 범위<input type="text" value="${esc(state.workspace.resourceGroup)}" readonly></label>
      <label class="field full">복원 사유 <span class="required">필수</span><textarea id="restore-reason" rows="3" maxlength="500" placeholder="예: 승인되지 않은 인바운드 규칙 변경을 기준 백업으로 되돌립니다.">${esc(r.reason)}</textarea></label></div>
      <div class="notice warning below-table">${icon("alert")}검토한 설정 전체를 되돌립니다. 백업에 없는 기존 규칙·경로가 제거될 수 있습니다. 연결·진단·권한·업무 데이터는 복구하지 않습니다.</div></div><div class="wizard-actions">${button("restore-back", "이전")}${button("review-plan", "현재 재확인·계획 생성", "shield", true, ui.loading)}</div>`;
  } else {
    const plan = r.plan;
    body.innerHTML = `<div class="panel-header"><h2 class="panel-title">서버에서 검토한 계획을 확인하세요</h2><span class="panel-header-note">10분 유효 · 재확인 후 실행</span></div><div class="panel-body">
      <dl class="summary-list"><dt>변경 티켓</dt><dd>${esc(plan.ticket)}</dd><dt>방식</dt><dd>${plan.mode === "create" ? "신규 생성" : "기존 업데이트"}</dd><dt>계획 만료</dt><dd>${date(plan.expiresAt)} ${timezone()}</dd><dt class="wide">대상 Resource ID<code class="resource-id">${esc(plan.targetResourceId)}</code></dt><dt class="wide">사유: ${esc(plan.reason)}</dt></dl>
      ${plan.comparison.diffs.length ? diffTable(plan.comparison.diffs, plan.comparison.truncated) : `<div class="notice success">${icon("check")}현재 형상과 검토한 설정의 차이가 없습니다. 불필요한 업데이트는 실행하지 않습니다.</div>`}
      <ol class="procedure"><li><div>현재 상태·소유 표식·계획 hash를 재확인<small>검토 후 변경됐거나 존재 조건이 달라지면 중단합니다.</small></div></li><li><div>현재 시점의 안전 백업을 ${esc(archiveLabel())}에 보관<small>원본·대상의 형상 또는 부재 기록과 완료 표식을 검증한 뒤에만 진행합니다.</small></div></li><li><div>검토한 ARM 설정 적용·사후 비교<small>동일 프로파일로 검증하고 티켓·안전 백업·작업 ID를 감사 로그로 남깁니다.</small></div></li></ol>
      <div class="notice warning">${icon("alert")}이 도구의 lease는 Portal·다른 배포 도구의 변경을 잠그지 못합니다. 격리된 LAB에서만 실행합니다. 동시에 다른 변경을 하지 마세요.</div>
      <label class="field confirm-name">최종 확인: <strong>${esc(plan.targetResourceId.split("/").at(-1))}</strong> 을 정확히 입력<input type="text" id="confirm-target" autocomplete="off" value="${esc(r.confirmTarget)}" aria-label="복원 대상 이름 확인"></label>
      <div class="confirm-box"><label class="check-label"><input type="checkbox" id="restore-confirm" ${r.confirmed ? "checked" : ""}>허용된 실험 RG의 실제 Azure 리소스를 변경하며, 규칙·경로가 제거될 수 있음을 확인합니다.</label></div>
      <details class="plan-proof"><summary>계획·승인 hash 확인</summary><code class="resource-id">${esc(plan.id)}<br>${esc(plan.approvalSha256)}</code></details></div><div class="wizard-actions">${button("restore-back", "재검토")}${button("execute-restore", "안전 백업 후 실제 복원", "shield", true, true)}</div>`;
    updateRestoreGate();
  }
}
function updateRestoreGate() {
  const r = ui.restore;
  const execute = $('[data-action="execute-restore"]');
  if (execute) execute.disabled = !r.confirmed || r.confirmTarget !== r.plan.targetResourceId.split("/").at(-1)
    || (r.plan.mode === "update" && r.plan.comparison.status === "same") || ui.busy || ui.stale;
}

function renderLogs() {
  const filters = ui.logFilters;
  const entries = ui.logTab === "analytics" ? ui.logs?.logs || [] : state.journal;
  $("#page-content").innerHTML = `
    ${heading("AUDIT & HANDOVER", "로그·작업 이력", "전송 수락과 실제 조회를 구분하고, 티켓·작업 ID로 처리 근거를 추적합니다.",
      button("load-logs", "Log Analytics 조회", "search", true, ui.loading))}
    <div class="workflow-bar"><button class="workflow-button ${ui.logTab === "analytics" ? "active" : ""}" data-action="log-tab" data-id="analytics">Log Analytics · 실제 조회</button><button class="workflow-button ${ui.logTab === "journal" ? "active" : ""}" data-action="log-tab" data-id="journal">${esc(archiveLabel())} · 작업 완료 기록</button></div>
    <div class="notice ${ui.logs?.error && ui.logTab === "analytics" ? "error" : ""} below-table">${icon("info")}${ui.logTab === "analytics"
      ? ui.loading ? "Workspace를 조회하고 있습니다. 아래 이전 결과는 새 조회가 완료된 뒤 교체합니다."
        : ui.logs?.error ? esc(ui.logs.error) : ui.logs ? `Workspace에서 ${ui.logs.logs.length}건을 조회했습니다. 수집·색인 지연으로 직전 작업이 아직 보이지 않을 수 있습니다. 다른 원천으로 자동 대체하지 않습니다.`
        : "아직 Workspace를 조회하지 않았습니다. 조건을 정하고 조회해 주세요. 서버 작업 기록은 별도 탭입니다."
      : `${esc(archiveLabel())}에 저장한 작업 완료 기록입니다. Log Analytics 조회 결과와 혼합하거나 대신하지 않습니다. 실행 중 작업은 상단 작업 ID로 확인하세요.`}</div>
    <section class="panel below-table"><div class="panel-header"><h2 class="panel-title">${ui.logTab === "analytics" ? "ArmBackup_CL · 지정 Workspace" : "서버의 영속 작업 이력"}</h2><span class="panel-header-note">${timezone()} · 원천 분리</span></div>
      ${ui.logTab === "analytics" ? `<form class="toolbar" id="logs-form"><label class="search-field">${icon("search")}<input type="search" name="search" aria-label="로그 검색" placeholder="이벤트·티켓·리소스·작업 ID" value="${esc(filters.search)}"></label><select name="days" aria-label="로그 조회 기간">${[1, 7, 30].map((days) => `<option value="${days}" ${days === filters.days ? "selected" : ""}>최근 ${days === 1 ? "24시간" : days + "일"}</option>`).join("")}</select><select name="level" aria-label="로그 수준"><option value="">모든 수준</option>${["Information", "Warning", "Error"].map((level) => `<option ${filters.level === level ? "selected" : ""}>${level}</option>`).join("")}</select><button class="button primary" type="submit" ${ui.loading ? "disabled" : ""}>실제 로그 조회</button></form>` : ""}
      ${entries.length ? `<div class="table-scroll"><table class="logs-table" aria-label="${ui.logTab === "analytics" ? "실제 Log Analytics 로그" : "서버 작업 완료 기록"}"><colgroup><col class="time-col"><col class="level-col"><col class="event-col"><col><col class="detail-col"></colgroup><thead><tr><th>시각 · ${timezone()}</th><th>${ui.logTab === "analytics" ? "수준" : "결과"}</th><th>${ui.logTab === "analytics" ? "이벤트" : "작업"}</th><th>티켓 · 추적 ID · 대상</th><th><span class="sr-only">상세</span></th></tr></thead><tbody>${entries.map((entry, index) => `<tr><td><time class="table-time">${date(entry.time || entry.finishedAt)}</time><span class="table-sub">${ui.logTab === "analytics" ? "Log Analytics" : esc(archiveLabel())}</span></td><td><span class="log-level ${entry.level || (entry.status === "Failed" ? "Error" : "Information")}">${esc(entry.level || entry.status)}</span></td><td class="log-event mono">${esc(entry.event || entry.action)}</td><td><span class="log-message">${esc(entry.ticket || entry.details?.ticket || "티켓 없음")}</span><span class="table-sub mono">${esc(entry.correlationId || entry.id)}</span><span class="table-sub">${esc((entry.resourceId || entry.targetResourceId || "").split("/").at(-1))}</span></td><td><button class="icon-button" data-action="log-detail" data-index="${index}" aria-label="로그 ${index + 1} 상세">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>` : empty(ui.logs?.error && ui.logTab === "analytics" ? "로그 조회에 실패했습니다" : "표시할 이력이 없습니다", ui.logTab === "analytics" ? "조회 실패·아직 조회하지 않음·빈 조회는 서로 다른 상태입니다. 위 원천 상태를 확인해 주세요." : "새 작업의 완료 기록은 상태 새로고침 후 읽습니다.")}
      <div class="table-bottom"><span>${entries.length}건 · ${ui.logTab === "analytics" ? "최대 200건, 지정 RG와 상관관계 범위만" : "최근 완료 작업 최대 30건"}</span>${button("refresh", "작업 상태 새로고침", "refresh")}</div></section>
    ${ui.logs?.query && ui.logTab === "analytics" ? `<details class="panel query-panel"><summary>실제 실행한 KQL 확인</summary><pre>${esc(ui.logs.query)}</pre></details>` : ""}`;
}
async function loadLogs() {
  ui.loading = true;
  renderLogs();
  try {
    ui.logs = await api.logs(ui.logFilters);
    ui.logTab = "analytics";
    $("#error-banner").hidden = true;
  } catch (error) {
    ui.logs = { error: failure(error), logs: [] };
    showError(error);
  } finally { ui.loading = false; renderLogs(); }
}

function focusTree(id) {
  const row = $$("[data-node]").find((item) => item.dataset.node === id);
  if (!row) return;
  ui.focus = id;
  $$("[data-node]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; });
  row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" });
}
function treeKey(event) {
  const element = event.target.closest("[data-node]");
  if (!element || event.target !== element) return;
  const index = ui.tree.findIndex((node) => node.id === element.dataset.node);
  const node = ui.tree[index];
  let next;
  if (event.key === "ArrowDown") next = ui.tree[Math.min(index + 1, ui.tree.length - 1)].id;
  else if (event.key === "ArrowUp") next = ui.tree[Math.max(index - 1, 0)].id;
  else if (event.key === "Home") next = ui.tree[0].id;
  else if (event.key === "End") next = ui.tree.at(-1).id;
  else if (event.key === "ArrowRight" && node.kind === "scope") {
    if (!ui.expanded.has(node.id)) { ui.expanded.add(node.id); updateTree(); next = node.id; }
    else next = ui.tree[index + 1]?.id;
  } else if (event.key === "ArrowLeft") {
    if (node.kind === "scope" && ui.expanded.has(node.id)) { ui.expanded.delete(node.id); updateTree(); next = node.id; }
    else next = node.parentId;
  } else if (["Enter", " "].includes(event.key)) {
    if (node.kind === "scope") {
      if (ui.expanded.has(node.id)) ui.expanded.delete(node.id); else ui.expanded.add(node.id);
    } else ui.selected = ui.selected === node.id ? null : node.id;
    updateTree(); next = node.id;
  } else return;
  event.preventDefault();
  if (next) focusTree(next);
}

async function action(name, target) {
  if (name === "dismiss-error") { $("#error-banner").hidden = true; return; }
  if (name === "close-dialog") { closeDialog(); return; }
  if (name === "open-bundle") { openBundle(); return; }
  if (name === "recover-bundle") {
    const job = ui.job;
    await refresh();
    const pending = (job.plannedResources || []).filter((id) => !(job.appliedResources || []).some((applied) => applied.toLowerCase() === id.toLowerCase()));
    bundlePreferences = { runId: job.sourceRunId, selected: pending, includeRelated: false, mode: "create" };
    if (location.hash === "#relations") render(); else location.hash = "relations";
    toast("현재 존재·부재를 다시 확인하고 생성/업데이트를 나눠 검토하세요. 이미 적용한 자원은 자동 롤백하지 않습니다.");
    return;
  }
  if (ui.busy || ui.loading) throw new ConsoleError("조회 또는 작업이 진행 중입니다. 중복 실행하지 말고 완료 상태를 확인해 주세요.");
  if (name === "refresh") { await refresh(); return; }
  if (name === "workflow") {
    ui.workflow = target.dataset.id; ui.filters.status = ui.workflow === "change" ? "changed" : "all";
    ui.filters.backupStatus = ui.workflow === "oncall" ? "problem" : "all";
    ui.filters.query = ""; renderStatus();
  }
  if (name === "backup-filter") {
    ui.filters.backupStatus = ui.filters.backupStatus === target.dataset.id ? "all" : target.dataset.id;
    $("#backup-status-filter").value = ui.filters.backupStatus; updateTree(true);
  }
  if (name === "recent-day") {
    const days = recentResourceDays(historyCache, target.dataset.resource, Date.now(), ui.timezone);
    const day = days.find((day) => day.date === target.dataset.day);
    ui.recentGeneration++;
    ui.recentRecords = day.records;
    dialog(`${day.date} · ${target.dataset.resource.split("/").at(-1)}`,
      `<p>백업 관측 간 기록 · ${timezone()} · ${day.changes}건 변경</p>${day.records.length ? day.records.map((record, index) =>
        `<div class="recent-record">${date(record.at)} · ${esc(HISTORY_KINDS[record.kind])} · 속성 ${record.propertyCount}개 <button class="button small" data-action="recent-detail" data-index="${index}" ${record.kind === "unknown" ? "disabled" : ""}>${icon("edit")}이전/이후 원본</button></div>`).join("") : "<p>이 날짜의 이 리소스는 관측 기록이 없습니다. 변화 없음으로 판정하지 않습니다.</p>"}`);
  }
  if (name === "recent-detail") {
    const generation = ++ui.recentGeneration;
    const record = ui.recentRecords[Number(target.dataset.index)];
    target.disabled = true;
    try {
      const detail = await api.historyDetail(record);
      if (generation !== ui.recentGeneration || !$("#app-dialog").open) return;
      $("#dialog-body").innerHTML = `<p>이전 ${date(detail.beforeAt)} → 이후 ${date(detail.afterAt)} · ${timezone()}</p>${detail.comparison.diffs.length ? diffTable(detail.comparison.diffs, detail.comparison.truncated) : `<p>${esc(detail.comparison.reason)}</p>`}`;
    } finally { if (target.isConnected) target.disabled = false; }
  }
  if (name === "expand-all" || name === "collapse-all") {
    const scopes = ui.grouping === "type" ? [...new Set(state.resources.map((resource) => `type:${resource.type}`))]
      : state.scopes.map((scope) => scope.id);
    scopes.forEach((id) => name === "expand-all" ? ui.expanded.add(id) : ui.expanded.delete(id));
    updateTree();
  }
  if (name === "toggle-scope") {
    if (ui.expanded.has(target.dataset.id)) ui.expanded.delete(target.dataset.id); else ui.expanded.add(target.dataset.id);
    updateTree(); focusTree(target.dataset.id);
  }
  if (name === "select-resource") {
    ui.selected = ui.selected === target.dataset.id ? null : target.dataset.id;
    updateTree(); focusTree(target.dataset.id);
  }
  if (name === "clear-selection") { ui.selected = null; updateTree(); }
  if (name === "current-only") dialog("선택한 기준 백업에 없는 현재 자원", `<p>백업 이후 생성인지 수집 범위 차이인지는 별도로 확인해야 합니다. 자동 삭제하지 않습니다.</p>${currentOnly(state, ui.runId).map((resource) => `<p><strong>${esc(resource.name)}</strong><br>${esc(resource.typeLabel)}<code class="resource-id">${esc(resource.id)}</code></p>`).join("")}`);
  if (name === "export-report") {
    ui.loading = true;
    if ($("#read-progress")) $("#read-progress").innerHTML = '<div class="operation-strip" role="status"><span class="spinner"></span><span>현재 형상을 재조회해 관측 구간·검증 근거·티켓을 포함한 보고서를 준비하고 있습니다.</span></div>';
    target.disabled = true;
    try {
      const report = await api.report(ui.runId);
      download(`armbackup-handover-${ui.runId}.json`, report);
      toast("현재 재조회한 비교 결과·범위·티켓 원천을 포함한 JSON 보고서를 저장했습니다.");
    } finally { ui.loading = false; render(); }
  }
  if (name === "backup-now") {
    if (ui.policy && JSON.stringify(ui.policy) !== JSON.stringify(state.policy)) throw new ConsoleError("대상 설정에 미저장 변경이 있습니다. 먼저 저장하거나 취소해 주세요.");
    const job = await operation("backup", { label: `MSP manual · ${date(new Date().toISOString())}` });
    historyCache = null;
    await refresh("latest");
    toast(`${job.result.capturedCount}개 관리 형상을 ${archiveLabel()}에 보관하고 완료 표식·로그 전송을 확인했습니다.`);
  }
  if (name === "add-tag") { ui.policy.tags.push({ key: "", operator: "equals", value: "" }); renderSettings(); }
  if (name === "remove-tag") { ui.policy.tags.splice(Number(target.dataset.index), 1); renderSettings(); }
  if (name === "discard-policy") { ui.policy = clone(state.policy); renderSettings(); }
  if (name === "save-policy") {
    const job = await operation("policy", { policy: ui.policy });
    ui.policy = clone(job.result.policy);
    await refresh();
    toast(`다음 콘솔 백업에 적용할 대상 정책을 ${archiveLabel()}에 저장했습니다. 예약 CLI 설정은 바꾸지 않았습니다.`);
  }
  if (name === "start-restore") startRestore(ui.selected);
  if (name === "clear-restore") { ui.restore = null; renderRestore(); }
  if (name === "restore-next") { ui.restore.step = 2; renderRestore(); }
  if (name === "restore-back") { ui.restore.step = Math.max(1, ui.restore.step - 1); ui.restore.plan = null; ui.restore.confirmed = false; renderRestore(); }
  if (name === "review-plan") {
    ui.loading = true;
    renderRestore();
    try {
      const r = ui.restore;
      r.plan = await api.review({ resourceId: r.resourceId, runId: r.runId, mode: r.mode,
        targetName: r.targetName, ticket: r.ticket, reason: r.reason });
      r.step = 3; r.confirmed = false; r.confirmTarget = "";
      $("#error-banner").hidden = true;
    } finally { ui.loading = false; renderRestore(); }
  }
  if (name === "execute-restore") {
    const r = ui.restore;
    if (!r.confirmed || r.confirmTarget !== r.plan.targetResourceId.split("/").at(-1)) throw new ConsoleError("실행 확인과 대상 이름을 확인해 주세요.");
    const plan = r.plan;
    try {
      const job = await operation("restore", { planId: plan.id, approvalSha256: plan.approvalSha256, confirmTarget: r.confirmTarget });
      r.result = job.result;
      await refresh(r.runId);
      renderRestore();
    } catch (error) {
      r.confirmed = false; r.plan = null; r.step = 2;
      await refresh(r.runId);
      renderRestore();
      throw error;
    }
  }
  if (name === "restore-status") { location.hash = "status"; }
  if (name === "restore-logs") { ui.logFilters.search = ui.restore.result.ticket; ui.logTab = "analytics"; location.hash = "logs"; await loadLogs(); }
  if (name === "log-tab") { ui.logTab = target.dataset.id; renderLogs(); }
  if (name === "load-logs") { ui.logTab = "analytics"; await loadLogs(); }
  if (name === "log-detail") {
    const entries = ui.logTab === "analytics" ? ui.logs.logs : state.journal;
    dialog(ui.logTab === "analytics" ? "Log Analytics 실제 레코드" : "서버 작업 완료 기록", `<pre>${esc(JSON.stringify(entries[Number(target.dataset.index)], null, 2))}</pre>`);
  }
}

document.addEventListener("click", (event) => {
  if (narrowScreen.matches && $("#sidebar").classList.contains("mobile-open")
      && !$("#sidebar").contains(event.target) && !$("#menu-toggle").contains(event.target)) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
    event.preventDefault();
    return;
  }
  const link = event.target.closest('a[href^="#"]');
  if (link && (ui.busy || ui.loading)) { event.preventDefault(); toast("현재 조회나 작업이 끝난 뒤 화면을 이동해 주세요."); return; }
  if (link) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
  }
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) action(target.dataset.action, target).catch(showError);
});
$("#main").addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "resource-search") { ui.filters.query = target.value; updateTree(true); }
  if (target.dataset.tagIndex !== undefined && ["key", "value"].includes(target.dataset.field)) {
    ui.policy.tags[Number(target.dataset.tagIndex)][target.dataset.field] = target.value;
    updatePolicyPreview();
  }
  const fields = { "target-name": "targetName", "restore-ticket": "ticket", "restore-reason": "reason", "confirm-target": "confirmTarget" };
  if (fields[target.id] && ui.restore) { ui.restore[fields[target.id]] = target.value; updateRestoreGate(); }
});
$("#main").addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "group-view") {
    ui.grouping = target.value;
    if (ui.grouping === "type" && !ui.typeGroupsInitialized) {
      state.resources.forEach((resource) => ui.expanded.add(`type:${resource.type}`));
      ui.typeGroupsInitialized = true;
    }
    updateTree(); $("#group-view").focus();
  }
  if (target.id === "timezone") { ui.timezone = target.value; render(); $("#timezone").focus(); }
  const filters = { "customer-filter": "customer", "backup-status-filter": "backupStatus", "type-filter": "type" };
  if (filters[target.id]) { ui.filters[filters[target.id]] = target.value; updateTree(true); }
  if (target.id === "baseline-run") { ui.runId = target.value; ui.selected = null; renderStatus(); $("#baseline-run").focus(); }
  if (target.dataset.policyScope) {
    ui.policy.scopeIds = togglePolicyScope(state, ui.policy, target.dataset.policyScope, target.checked);
    renderSettings();
    $$("[data-policy-scope]").find((element) => element.dataset.policyScope === target.dataset.policyScope)?.focus();
  }
  if (target.dataset.type) {
    ui.policy.types = target.checked ? [...ui.policy.types, target.dataset.type] : ui.policy.types.filter((type) => type !== target.dataset.type);
    renderSettings();
    $$("[data-type]").find((element) => element.dataset.type === target.dataset.type)?.focus();
  }
  if (target.dataset.field === "operator") {
    ui.policy.tags[Number(target.dataset.tagIndex)].operator = target.value; renderSettings();
    $$("[data-tag-index][data-field='operator']").find((element) => element.dataset.tagIndex === target.dataset.tagIndex)?.focus();
  }
  if (target.id === "restore-picker" && target.value) startRestore(target.value);
  if (target.name === "restore-run") { ui.restore.runId = target.value; renderRestore(); }
  if (target.name === "restore-mode") { ui.restore.mode = target.value; renderRestore(); }
  if (target.id === "restore-confirm") { ui.restore.confirmed = target.checked; updateRestoreGate(); }
});
$("#main").addEventListener("submit", (event) => {
  if (event.target.id !== "logs-form") return;
  event.preventDefault();
  if (ui.loading || ui.busy) { showError(new ConsoleError("진행 중인 조회가 끝난 뒤 다시 조회해 주세요.")); return; }
  const data = new FormData(event.target);
  ui.logFilters = { days: Number(data.get("days")), level: String(data.get("level")), search: String(data.get("search")) };
  loadLogs().catch(showError);
});
$("#main").addEventListener("keydown", treeKey);
$("#main").addEventListener("focusin", (event) => {
  const row = event.target.closest("[data-node]");
  if (row) { ui.focus = row.dataset.node; $$("[data-node]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; }); }
});
$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("mobile-open");
  syncNavigation();
  if (open) $(".navigation a").focus();
});
narrowScreen.addEventListener("change", syncNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && narrowScreen.matches && $("#sidebar").classList.contains("mobile-open")) {
    $("#sidebar").classList.remove("mobile-open");
    syncNavigation();
    $("#menu-toggle").focus();
  }
});
$("#dialog-close").addEventListener("click", closeDialog);
$("#app-dialog").addEventListener("cancel", acknowledgeStartupNotice);
$("#app-dialog").addEventListener("close", () => { acknowledgeStartupNotice(); ui.recentGeneration++; });
$("#preview-guide").addEventListener("click", () => { if (session) showScopeGuide(); });
$("#reload-connection").addEventListener("click", () => refresh().catch(showError));
window.addEventListener("hashchange", () => { if (state) { render(); $("#main").focus({ preventScroll: true }); } });
window.addEventListener("beforeunload", (event) => {
  if (ui.busy || (state && JSON.stringify(ui.policy) !== JSON.stringify(state.policy))) event.preventDefault();
});
setInterval(() => {
  if (ui.page === "status" && !ui.busy && !ui.loading && !$("#app-dialog").open
      && $("#tree-container") && !document.activeElement?.closest(".recent-days")) {
    const focused = document.activeElement?.dataset.node;
    updateTree();
    if (focused) focusTree(focused);
  }
}, 60_000);
window.addEventListener("error", (event) => showError(event.error || new ConsoleError("화면 처리 오류입니다. 상태를 다시 확인해 주세요.")));
window.addEventListener("unhandledrejection", (event) => showError(event.reason));
async function bootstrap() {
  syncNavigation();
  try {
    session = await api.connect();
    showStartupNotice();
    await refresh(ui.runId, false);
    if (ui.stale) await refresh(ui.runId, true);
    if (state.activeOperations?.length) {
      ui.busy = true;
      ui.job = state.activeOperations[0];
      render();
      try {
        ui.job = await api.waitJob(ui.job.id, (job) => { ui.job = job; renderOperation(); });
      } finally {
        ui.busy = false;
        await refresh();
      }
    }
  }
  catch (error) { showError(error); }
}
bootstrap();
