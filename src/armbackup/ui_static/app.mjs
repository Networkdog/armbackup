import {
  STORAGE_KEY, STATUS, DemoError, DemoStore, ancestors, scopeResources, matchesScope, matchesPolicy,
  comparisonRows, compareResource, visibleTree, savePolicy, makeTargetId, prepareRestore, executeRestore, queryLogs, logQueryExample,
} from "./model.mjs";
import { HistoryPanel } from "./history-panel.mjs";
import { backupCalendarData } from "./backup-calendar.mjs";
import { createDemoHistory } from "./demo-history.mjs";
import { SUPPORTED_RESOURCES, officialPolicyTypes, legacyPolicyTypes } from "./support-catalog.mjs";
import { BACKUP_STATUS, backupHealth, relativeTime, recentResourceDays, recentDaysHtml, recentLegendHtml } from "./backup-view.mjs";
import { visibleTypeTree } from "./view-model.mjs";
import { createNotifications } from "./notifications.mjs";
import { backupItems, backupItemListHtml, restoreItem, restoreTargetHtml } from "./restore-target.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name, classes = "") => `<svg class="icon ${classes}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clone = (value) => structuredClone(value);
const notifier = createNotifications(document);
const errors = notifier;
notifier.watch($("#main"));
const PAGE_NAMES = { settings: "백업 대상", status: "백업 현황", restore: "복원·복제", logs: "로그" };
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
const narrowScreen = window.matchMedia("(max-width: 59.375em)");

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
function restoreHeading(actions = "") {
  return `<h1 class="sr-only">복원·복제</h1>${actions ? `<section class="page-heading restore-heading"><div class="heading-actions">${actions}</div></section>` : ""}`;
}
function latestRun() {
  return store.state.runs.find((run) => run.kind === "scheduled");
}
function restorable(row, run) {
  return run?.status === "Captured" && row?.snapshot.complete && !row.snapshot.redacted
    && (row.observation?.status === "present" || (row.observation?.status === "missing" && row.observation.confirmed));
}
function currentOnly(run) {
  const ids = new Set(run.snapshots.map((snapshot) => snapshot.resourceId.toLowerCase()));
  return store.state.resources.filter((resource) => !ids.has(resource.id.toLowerCase())
    && store.state.current[resource.id.toLowerCase()]?.status === "present");
}

function render() {
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
  ({ status: renderStatus, settings: renderSettings, restore: renderRestore, logs: renderLogs })[ui.page]();
}
function renderRestoreCalendar(resourceId = "") {
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); }
  $("#main").insertAdjacentHTML("beforeend", '<div id="restore-calendar" class="panel change-history-panel"></div>');
  const initial = historyPreferences ? { ...historyPreferences, filters: { customer: "", type: "", query: "" } } : null;
  historyPanel = new HistoryPanel($("#restore-calendar"), {
    mode: "design-preview", fixedItem: true,
    load: async () => {
      const data = backupCalendarData(store.state, (row) => ({
        allowed: restorable(row, { status: row.snapshot.complete ? "Captured" : "Incomplete" }),
        reason: "불완전한 백업 또는 현재 상태 미확인",
      }));
      return { ...data, records: data.records.filter((record) => record.resourceId.toLowerCase() === resourceId.toLowerCase()) };
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
    onRestore: (record) => {
      try { startRestore(record.resourceId, record.afterRunId, true); }
      catch (error) { showError(error); }
    },
  });
}
function browseBackups(resourceId = "", selectedDate = "") {
  ui.restore = { resourceId: null, busy: false };
  if (resourceId) ui.restoreTarget = resourceId;
  historyPreferences = { weeks: 53, metric: "backups", showAll: true, selectedDate,
    filters: { customer: "", type: "", query: "" } };
  if (historyPanel) { historyPanel.destroy(); historyPanel = null; }
  if (location.hash === "#restore") render(); else location.hash = "restore";
}

function renderStatus() {
  const run = store.state.runs.find((item) => item.id === ui.runId);
  const totals = comparisonRows(store.state, ui.runId);
  const cards = Object.entries(BACKUP_STATUS).map(([status, info]) => {
    const count = totals.filter((row) => demoHealth(row.resource.id).status === status).length;
    return `<div class="summary-card backup-${status}"><span class="summary-top"><span class="summary-icon">${icon(info.icon)}</span>${info.label}</span><span class="summary-value">${count}<small>개</small></span></div>`;
  }).join("");
  const types = [...new Map(totals.map((row) => [row.resource.type, row.resource.typeLabel])).entries()];
  $("#main").innerHTML = `
    ${heading("백업 현황",
      `<span class="selection-hint" id="selection-hint">리소스를 선택해 주세요</span><button class="button" data-action="refresh-status">${icon("refresh")}예시 다시 보기</button><button class="button primary" id="restore-selected" data-action="restore-selected" disabled>${icon("restore")}선택 리소스 복원</button>`)}
    <section class="summary-cards" aria-label="선택 백업 전체의 형상 비교 요약">${cards}</section>
    <section class="panel" aria-labelledby="comparison-title">
      <div class="panel-header"><h2 class="panel-title" id="comparison-title">리소스 형상 비교 <span class="count-pill">${totals.length}개 백업</span></h2><span class="panel-header-note">${icon("clock")}모든 시각 KST · 예시 관측값</span></div>
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
      <div class="table-scroll" id="tree-container"></div>
      <div class="table-bottom"><span>행 음영: 최근 일반 백업 상태 · 빨강: 실패/미백업</span><span>10일 변경 · 왼쪽 과거 → 오늘</span></div>${recentLegendHtml(esc)}
    </section>
    <div class="notice">${icon("info")}백업·변경 이력은 모두 명시적 예시입니다. 실제 Azure 상태가 아닙니다.</div>
    `;
  $("#status-filter").value = ui.filters.status;
  updateStatusResults();
}
function demoHealth(id) {
  return backupHealth({ runs: store.state.runs.map((run) => ({ ...run,
    snapshots: run.snapshots.map((snapshot) => ({ ...snapshot, complete: run.status === "Captured" })) })) }, id);
}
function demoMiniCalendar(id) {
  return `<div class="recent-days">${recentDaysHtml(recentResourceDays(createDemoHistory(store.state), id), {
    esc,
    cell: (day, classes, label) => `<a href="#restore" data-action="browse-backups" data-resource="${esc(id)}" data-day="${day.date}" class="${classes}" title="${label}" aria-label="${label}"></a>`,
  })}</div>`;
}

function updateStatusResults(reveal = false) {
  const rows = comparisonRows(store.state, ui.runId, ui.filters);
  if (reveal) rows.forEach((row) => ancestors(store.state, row.resource.groupId).forEach((scope) => ui.expanded.add(scope.id)));
  if (!rows.some((row) => row.resource.id === ui.selectedId)) ui.selectedId = null;
  const nodes = ui.grouping === "type" ? visibleTypeTree(rows, ui.expanded) : visibleTree(store.state, rows, ui.expanded);
  ui.treeNodes = nodes;
  if (!nodes.some((node) => node.id === ui.focusId)) ui.focusId = nodes[0]?.id;
  const run = store.state.runs.find((item) => item.id === ui.runId);
  $("#shown-count").textContent = `필터 결과 ${rows.length}개`;
  if (!nodes.length) {
    $("#tree-container").innerHTML = empty("표시할 백업 리소스가 없습니다", run.absences?.length ? "이 안전 백업에는 현재 부재 확인 기록만 있습니다. 다른 백업을 선택해 주세요." : "검색어와 대상·종류·상태 필터를 확인해 주세요.");
  } else {
    const body = nodes.map((node, index) => {
      const attributes = `data-node="${esc(node.id)}" tabindex="${node.id === ui.focusId ? 0 : -1}" role="row" aria-level="${node.level}" aria-rowindex="${index + 2}" aria-posinset="${node.position}" aria-setsize="${node.setSize}"`;
      if (node.kind === "scope") {
        const scope = node.scope;
        const open = ui.expanded.has(scope.id);
        const scopeIcon = scope.kind === "managementGroup" ? "layers" : scope.kind === "subscription" ? "cloud" : scope.kind === "resourceType" ? "box" : "folder";
        return `<tr ${attributes} class="scope-row scope-${scope.kind}" aria-expanded="${open}"><td role="gridcell"></td><td role="gridcell" colspan="6" aria-colspan="6"><div class="scope-cell depth-${Math.min(node.level - 1, 4)}"><button class="tree-toggle ${open ? "open" : ""}" data-action="toggle-scope" data-id="${scope.id}" aria-label="${esc(scope.name)} ${open ? "접기" : "펼치기"}" tabindex="-1">${icon("chevron")}</button>${icon(scopeIcon)}<span class="scope-name">${esc(scope.name)}</span><span class="count-pill">${node.count}</span><span class="scope-kind">${KIND_NAMES[scope.kind]}</span></div></td></tr>`;
      }
      const { resource, snapshot, observation, status, reason } = node.row;
      const selected = ui.selectedId === resource.id;
      const currentLabel = observation?.status === "present" ? date(observation.observedAt, true)
        : observation?.status === "missing" && observation.confirmed ? "현재 부재 확인" : "조회 미확인";
      return `<tr ${attributes} class="resource-row backup-${demoHealth(resource.id).status} ${selected ? "selected" : ""}" aria-selected="${selected}" data-action="select-resource" data-id="${esc(resource.id)}">
        <td role="gridcell"><input type="checkbox" tabindex="-1" aria-label="${esc(resource.name)} 선택" ${selected ? "checked" : ""}></td>
        <td role="gridcell"><div class="resource-identity depth-${Math.min(node.level - 1, 4)}">${symbol(resource)}<span class="resource-name-wrap"><span class="resource-name" title="${esc(resource.id)}">${esc(resource.name)}</span><span class="resource-region">Korea Central</span></span></div></td>
        <td role="gridcell"><span class="type-text">${esc(resource.typeLabel)}</span></td>
        <td role="gridcell"><time class="table-time" datetime="${snapshot.capturedAt}" title="${date(snapshot.capturedAt)} KST">${relativeTime(snapshot.capturedAt)}</time><span class="table-sub">${demoHealth(resource.id).label}</span></td>
        <td role="gridcell"><span class="table-time">${currentLabel}</span><span class="table-sub">${observation?.status === "present" ? "예시 REST 관측" : observation?.status === "missing" ? "예시 부재 관측" : esc(observation?.code || "대기")}</span></td>
        <td role="gridcell">${demoMiniCalendar(resource.id)}</td>
        <td role="gridcell">${observation?.actor ? `<span class="actor-name" title="${esc(observation.actor.source)}">${esc(observation.actor.caller)}</span><span class="table-sub">${date(observation.actor.at, true)} · 예시</span>` : '<span class="actor-empty">미확인</span><span class="table-sub">변경 주체 미확인</span>'}</td>
      </tr>`;
    }).join("");
    $("#tree-container").innerHTML = `<table class="resource-table" role="treegrid" aria-label="백업과 현재 리소스의 계층형 형상 비교" aria-multiselectable="false" aria-colcount="7" aria-rowcount="${nodes.length + 1}"><colgroup><col class="selection-col"><col class="resource-col"><col class="type-col"><col class="time-col"><col class="time-col"><col class="recent-col"><col class="actor-col"></colgroup><thead><tr role="row" aria-rowindex="1"><th role="columnheader"><span class="sr-only">선택</span></th><th role="columnheader">리소스 체계 / 이름</th><th role="columnheader">리소스 종류</th><th role="columnheader">백업 형상 · KST</th><th role="columnheader">현재 형상 · KST</th>    <th role="columnheader">변경 달력 · 최근 10일</th><th role="columnheader">마지막 변경 주체</th></tr></thead><tbody>${body}</tbody></table>`;
  }
  const row = rows.find((item) => item.resource.id === ui.selectedId);
  $("#selection-hint").innerHTML = row ? "<strong>1개</strong>리소스 선택" : "리소스를 선택해 주세요";
  $("#restore-selected").disabled = !restorable(row, run);
  $("#restore-selected").title = row && !restorable(row, run) ? "현재 상태·백업 완전성을 확인해야 합니다." : "예시 복원 마법사 열기";
  $$(".summary-card").forEach((card) => {
    const active = ui.filters.status === card.dataset.status;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", active);
  });
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
  $("#settings-dirty").textContent = dirty ? "저장하지 않은 변경이 있습니다" : "현재 예시 설정을 표시하고 있습니다";
  $("#settings-preview").innerHTML = `<div class="summary-preview"><p class="heading-eyebrow">TARGET PREVIEW</p><h2 class="panel-title">백업 대상 미리보기</h2><div class="summary-preview-number">${resources.length}<span>개 리소스</span></div><div class="small-text muted">현재 형상이 확인된 예시 자원 기준</div><div class="summary-actions"><button class="button primary" data-action="save-settings" ${legacyPolicyTypes(ui.settings.types).length ? "disabled" : ""}>${icon("check")}예시 설정 저장</button><button class="button" data-action="discard-settings" ${dirty ? "" : 'disabled title="변경한 설정이 없습니다."'}>변경 취소</button></div></div>
    <dl class="summary-list"><dt>리소스 그룹</dt><dd>${groups.size}개</dd><dt>리소스 종류</dt><dd>${ui.settings.types.length}개 선택</dd><dt>태그 조건</dt><dd>${ui.settings.tags.length ? `${ui.settings.tags.length}개 모두 만족` : "제한 없음"}</dd><dt>현재 조회 미확인</dt><dd>${pending.length}개 · 별도 확인</dd></dl>
    <div class="summary-resources"><span class="small-text muted">포함된 예시 리소스</span>${resources.slice(0, 5).map((resource) => `<div class="mini-resource">${icon("box")}<span>${esc(resource.name)}</span></div>`).join("")}${resources.length > 5 ? `<span class="small-text muted">외 ${resources.length - 5}개</span>` : ""}</div>
    <div class="panel-body"><div class="notice">${icon("info")}범위 AND 종류 AND 모든 태그 조건을 함께 적용합니다. 실제 수집 설정은 변경하지 않습니다.</div></div>`;
}
function renderSettings() {
  const state = store.state;
  const selectedResources = new Set(state.resources.filter((resource) => matchesScope(state, resource, ui.settings.scopeIds)).map((resource) => resource.id));
  const types = SUPPORTED_RESOURCES.map((entry) => [entry.type, entry.label]);
  $("#main").innerHTML = `
    <h1 class="sr-only">백업 대상 설정</h1>
    <div class="settings-layout"><div class="settings-sections">
      <section class="panel" aria-labelledby="types-title"><div class="panel-header"><h2 class="panel-title" id="types-title"><span class="section-number">01</span>리소스 종류</h2><label class="check-label"><input type="checkbox" id="all-types" ${types.every(([type]) => ui.settings.types.includes(type)) ? "checked" : ""}>공식 지원 전체</label></div><div class="panel-body"><div class="type-grid">${SUPPORTED_RESOURCES.map(({type, label, icon: symbol, scope}) => `<label class="type-option ${ui.settings.types.includes(type) ? "checked" : ""}" title="${esc(scope)}"><input type="checkbox" data-type="${esc(type)}" ${ui.settings.types.includes(type) ? "checked" : ""}>${icon(symbol)}<span>${esc(label)}<small class="table-sub">${esc(scope)}</small></span><span class="type-option-count">${state.resources.filter((resource) => resource.type.toLowerCase() === type).length}</span></label>`).join("")}</div>${legacyPolicyTypes(ui.settings.types).length ? '<p class="small-text" role="alert">기존 정책은 보존했습니다. 공식 종류를 선택한 뒤 저장하세요.</p>' : ""}</div></section>
      <section class="panel" aria-labelledby="scope-title"><div class="panel-header"><h2 class="panel-title" id="scope-title"><span class="section-number">02</span>리소스 체계</h2><span class="panel-header-note">상위 선택 시 하위 범위 포함</span></div><div class="panel-body">
        <div class="scope-choices">${state.scopes.map((scope) => {
          const resources = scopeResources(state, scope.id);
          const checked = resources.length > 0 && resources.every((resource) => selectedResources.has(resource.id));
          const scopeIcon = scope.kind === "managementGroup" ? "layers" : scope.kind === "subscription" ? "cloud" : "folder";
          return `<label class="scope-choice ${scope.kind} depth-${ancestors(state, scope.id).length - 1}"><input type="checkbox" id="scope-${scope.id}" data-scope="${scope.id}" ${checked ? "checked" : ""}>${icon(scopeIcon)}<span class="scope-choice-name">${esc(scope.name)}</span><span class="scope-choice-detail">${KIND_NAMES[scope.kind]}</span></label>`;
        }).join("")}</div>
      </div></section>
      <section class="panel" aria-labelledby="tags-title"><div class="panel-header"><h2 class="panel-title" id="tags-title"><span class="section-number">03</span>리소스 태그</h2><span class="panel-header-note">AND · 비우면 전체</span></div><div class="panel-body">
        ${ui.settings.tags.length ? ui.settings.tags.map((rule, index) => `<div class="tag-rule"><input type="text" data-tag-index="${index}" data-tag-field="key" aria-label="태그 ${index + 1} 이름" placeholder="태그 이름" value="${esc(rule.key)}"><select data-tag-index="${index}" data-tag-field="operator" aria-label="태그 ${index + 1} 연산자"><option value="equals" ${rule.operator === "equals" ? "selected" : ""}>같음 =</option><option value="exists" ${rule.operator === "exists" ? "selected" : ""}>키 있음</option></select><input type="text" data-tag-index="${index}" data-tag-field="value" aria-label="태그 ${index + 1} 값" placeholder="태그 값" value="${esc(rule.value)}" ${rule.operator === "exists" ? "disabled" : ""}><button class="icon-button" data-action="remove-tag" data-index="${index}" aria-label="태그 조건 ${index + 1} 삭제">${icon("close")}</button></div>`).join("") : '<div class="empty-tags">등록한 태그 조건이 없습니다. 모든 태그를 포함합니다.</div>'}
        <button class="button small" data-action="add-tag">${icon("plus")}태그 조건 추가</button>
      </div></section>
      <div class="settings-bottom"><span class="dirty-label" id="settings-dirty"></span><span class="small-text muted">저장 위치: 이 브라우저의 예시 저장소</span></div>
    </div><aside class="panel settings-summary" id="settings-preview" aria-label="백업 대상 미리보기"></aside></div>`;
  state.scopes.forEach((scope) => {
    const resources = scopeResources(state, scope.id);
    const included = resources.filter((resource) => selectedResources.has(resource.id)).length;
    $(`#scope-${scope.id}`).indeterminate = included > 0 && included < resources.length;
  });
  updateSettingsSummary();
}
function toggleScope(id, checked) {
  const state = store.state;
  function path(targetId) {
    const scope = state.scopes.find((item) => item.id === targetId);
    if (scope) return ancestors(state, scope.id).map((item) => item.id);
    const resource = state.resources.find((item) => item.id === targetId);
    return [...ancestors(state, resource.groupId).map((item) => item.id), resource.id];
  }
  const targetPath = path(id);
  if (checked) {
    if (ui.settings.scopeIds.some((selected) => targetPath.includes(selected))) return;
    ui.settings.scopeIds = [...ui.settings.scopeIds.filter((selected) => !path(selected).includes(id)), id];
  } else {
    function exclude(selected) {
      if (selected === id) return [];
      if (!targetPath.includes(selected)) return [selected];
      const children = [...state.scopes.filter((scope) => scope.parentId === selected).map((scope) => scope.id),
        ...state.resources.filter((resource) => resource.groupId === selected).map((resource) => resource.id)];
      return children.flatMap(exclude);
    }
    ui.settings.scopeIds = ui.settings.scopeIds.flatMap(exclude);
  }
}

function startRestore(id, runId = ui.runId, fromCalendar = false) {
  const resource = store.state.resources.find((item) => item.id === id);
  if (!resource) throw new DemoError("복원할 리소스를 찾을 수 없습니다.");
  const history = store.state.runs.filter((run) => run.snapshots.some((snapshot) => snapshot.resourceId.toLowerCase() === id.toLowerCase()));
  const selectedRun = history.find((run) => run.id === runId);
  if (!selectedRun) throw new DemoError("리소스의 백업 이력이 없습니다.");
  const present = store.state.current[id.toLowerCase()]?.status === "present";
  ui.restore = {
    resourceId: id, runId: selectedRun.id, step: fromCalendar ? 2 : 1, mode: present ? "update" : "create",
    groupId: resource.groupId, name: present ? `${resource.name}-restored` : resource.name,
    confirmed: false, plan: null, busy: false, phase: null, result: null, failed: false,
  };
  ui.restoreTarget = id;
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); historyPanel = null; }
  if (location.hash === "#restore") renderRestore();
  else location.hash = "restore";
}
function restoreTargetPanel() {
  return restoreTargetHtml(store.state, ui.restoreTarget, ui.restoreQuery, { esc, icon, relativeTime, symbol, busy: ui.restore.busy });
}
function restoreContext() {
  const source = store.state.runs.find((run) => run.id === ui.restore.runId);
  return `${restoreTargetPanel()}<div class="restore-source" data-source-run="${esc(ui.restore.runId)}" title="${esc(ui.restore.runId)}">${icon("clock")}복원 기준 백업 · ${date(source?.capturedAt)} KST</div>`;
}
function stepper(step) {
  return `<ol class="stepper" aria-label="복원 진행 단계">${[["백업 선택", "날짜별 복원 시점"], ["복원 방식", "신규 생성 또는 업데이트"], ["확인 및 실행", "안전 백업 후 복원"]].map(([label, sub], index) => `<li class="wizard-step ${step === index + 1 ? "active" : step > index + 1 ? "done" : ""}" ${step === index + 1 ? 'aria-current="step"' : ""}><span class="step-number">${step > index + 1 ? icon("check") : `0${index + 1}`}</span><span class="step-label">${label}<small>${sub}</small></span></li>`).join("")}</ol>`;
}
function renderRestore() {
  if (historyPanel) { historyPreferences = historyPanel.snapshot(); historyPanel.destroy(); historyPanel = null; }
  const r = ui.restore;
  const chosen = restoreItem(store.state, ui.restoreTarget)?.resource.id || "";
  $("#main").innerHTML = `${restoreHeading(r.resourceId && r.step > 1 ? `<button class="button" data-action="browse-backups" data-resource="${esc(r.resourceId)}">${icon("calendar")}백업 달력</button>` : "")}${r.resourceId ? "" : restoreTargetPanel()}`;
  if (!r.resourceId) {
    if (chosen) renderRestoreCalendar(chosen);
    return;
  }
  if (r.step === 1) { $("#main").insertAdjacentHTML("beforeend", restoreTargetPanel()); renderRestoreCalendar(r.resourceId); return; }
  const resource = store.state.resources.find((item) => item.id === r.resourceId);
  $("#main").insertAdjacentHTML("beforeend", `${restoreContext()}${stepper(r.step)}<div id="restore-step-content"></div>`);
  const target = $("#restore-step-content");
  if (r.result) { renderRestoreResult(target); return; }
  if (r.busy) { renderExecution(target); return; }
  if (r.failed) {
    target.innerHTML = `<section class="panel"><div class="panel-body"><div class="notice error">${icon("alert")}예시 복원을 완료하지 못했습니다. ${esc(r.error)}</div><p class="small-text muted">저장된 안전 백업은 삭제하지 않습니다. 데이터를 다시 확인한 뒤 계획을 새로 검토해 주세요.</p></div><div class="wizard-actions"><a class="button" href="#logs">예시 로그 보기</a><button class="button primary" data-action="retry-restore-review">계획 다시 검토</button></div></section>`;
    return;
  }
  if (r.step === 2) {
    const observed = store.state.current[resource.id.toLowerCase()];
    const canUpdate = observed?.status === "present";
    const groups = store.state.scopes.filter((scope) => scope.kind === "resourceGroup");
    const group = groups.find((scope) => scope.id === r.groupId);
    const subscriptions = store.state.scopes.filter((scope) => scope.kind === "subscription");
    target.innerHTML = `<section class="panel"><div class="panel-header"><h2 class="panel-title">어떻게 복원할까요?</h2><span class="panel-header-note">자동 모드 전환 없음</span></div><div class="panel-body"><p class="section-description">신규 생성은 기존 리소스를 덮어쓰지 않고, 업데이트는 현재 존재하는 리소스에만 적용합니다.</p><div class="mode-grid">
      <label class="mode-card ${r.mode === "create" ? "checked" : ""}"><span class="mode-title"><input type="radio" name="restore-mode" value="create" ${r.mode === "create" ? "checked" : ""}>신규 생성</span><p>새 대상에 백업 형상을 적용합니다.<br>대상이 이미 있거나 미확인이면 중단합니다.</p></label>
      <label class="mode-card ${r.mode === "update" ? "checked" : ""} ${canUpdate ? "" : "disabled"}"><span class="mode-title"><input type="radio" name="restore-mode" value="update" ${r.mode === "update" ? "checked" : ""} ${canUpdate ? "" : "disabled"}>기존 리소스 업데이트</span><p>선택한 리소스의 현재 형상을 되돌립니다.<br>${canUpdate ? "복원 전 현재 형상을 먼저 보관합니다." : "현재 리소스가 없거나 상태를 확인하지 못했습니다."}</p></label></div>
      ${r.mode === "create" ? `<div class="target-form"><label class="field">대상 Subscription<select id="target-subscription">${subscriptions.map((scope) => `<option value="${scope.id}" ${group?.parentId === scope.id ? "selected" : ""}>${esc(scope.name)}</option>`).join("")}</select></label><label class="field">대상 Resource Group<select id="target-group">${groups.filter((scope) => scope.parentId === group?.parentId).map((scope) => `<option value="${scope.id}" ${r.groupId === scope.id ? "selected" : ""}>${esc(scope.name)}</option>`).join("")}</select></label><label class="field full">신규 리소스 이름<input type="text" id="target-name" value="${esc(r.name)}" maxlength="63" autocomplete="off"><span class="field-hint">프리뷰 입력 규칙입니다. 실제 Azure 이름·지역·의존성 제약을 검증하지 않습니다.</span></label><div class="field full">대상 Resource ID<code class="resource-id" id="target-id-preview"></code></div></div>` : `<div class="notice below-table" data-persist>${icon("shield")}선택한 원본 리소스만 업데이트합니다. 없어지면 신규 생성으로 바꾸지 않고 중단합니다.</div>`}
      <div class="notice warning below-table">${icon("alert")}예시 데이터만 변경합니다. 운영 복원 어댑터·참조 매핑·권한 검증은 아직 연결하지 않았습니다.</div></div>
      <div class="wizard-actions"><button class="button" data-action="restore-back">이전</button><button class="button primary" data-action="restore-next">절차 확인 ${icon("arrow")}</button></div></section>`;
    if (r.mode === "create") updateTargetPreview();
  } else {
    const plan = r.plan;
    target.innerHTML = `<section class="panel"><div class="panel-header"><h2 class="panel-title">안전 백업 후 예시 복원을 시작합니다</h2><span class="panel-header-note">최종 검토</span></div><div class="panel-body">
      <dl class="summary-list"><dt>복원 방식</dt><dd>${plan.mode === "create" ? "신규 생성 · Create-only" : "기존 업데이트 · Update-only"}</dd><dt>선택한 백업</dt><dd>${date(plan.snapshot.capturedAt)} KST</dd><dt>적용 범위</dt><dd>브라우저 예시 형상 전체</dd><dt class="wide">대상 Resource ID<code class="resource-id">${esc(plan.targetId)}</code></dt></dl>
      <ol class="procedure"><li><div>현재 상태를 다시 확인합니다<small>검토 이후 데이터가 바뀌거나 대상의 존재 조건이 달라지면 중단합니다.</small></div></li><li><div>현재 시점의 안전 백업을 추가합니다<small>${plan.mode === "create" ? "원본 현재 형상과 신규 대상의 예시 부재 기록을 보관합니다. 원본도 없다면 부재 기록을 남깁니다." : "적용 전 대상의 현재 형상을 별도 백업으로 보관합니다."} 저장 실패 시 적용하지 않습니다.</small></div></li><li><div>선택한 백업을 예시 대상에 적용합니다<small>실제 ARM PUT·DELETE와 백업 CLI는 호출하지 않습니다.</small></div></li><li><div>형상을 다시 비교하고 결과를 기록합니다<small>안전 백업과 처리 결과는 이 브라우저의 예시 저장소에만 남습니다.</small></div></li></ol>
      <div class="notice warning" data-persist>${icon("info")}이 절차는 운영 복원 승인이나 Azure 복원 성공을 의미하지 않습니다. 업무 데이터는 복구하지 않습니다.</div>
      <div class="confirm-box"><label class="check-label"><input type="checkbox" id="restore-confirm" ${r.confirmed ? "checked" : ""}>실제 Azure가 아닌 예시 데이터만 변경하며, 안전 백업이 저장된 뒤 복원한다는 점을 확인했습니다.</label></div></div>
      <div class="wizard-actions"><button class="button" data-action="restore-back">이전</button><button class="button primary" id="execute-restore" data-action="execute-restore" ${r.confirmed ? "" : "disabled"}>${icon("shield")}안전 백업 후 예시 복원</button></div></section>`;
  }
}
function updateTargetPreview() {
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
  const index = { checking: 0, safety: 1, applied: 2 }[phase] ?? 0;
  target.innerHTML = `<section class="panel"><div class="panel-header"><h2 class="panel-title">예시 복원을 진행하고 있습니다</h2></div><div class="panel-body"><div class="notice">${icon("info")}실제 Azure 변경은 없습니다. 로컬 저장이 끝날 때까지 기다려 주세요.</div><div class="execution-list" role="status" aria-live="polite">${["현재 상태와 계획 재확인", "복원 전 안전 백업 보관", "예시 형상 적용 및 사후 비교"].map((label, step) => `<div class="execution-item ${step < index ? "complete" : step === index ? "running" : ""}">${step < index ? icon("check") : step === index ? '<span class="spinner"></span>' : icon("clock")}<span>${label}${step < index ? " · 완료" : ""}</span></div>`).join("")}</div></div></section>`;
}
function renderRestoreResult(target) {
  const result = ui.restore.result;
  const safety = store.state.runs.find((run) => run.id === result.safetyId);
  target.innerHTML = `<section class="panel"><div class="panel-body"><div class="result-header"><span class="result-icon">${icon("check")}</span><div><h2>예시 복원을 완료했습니다</h2><p>안전 백업을 먼저 저장하고, 예시 형상 적용 후 일치를 확인했습니다.</p></div></div>
    <div class="notice success">${icon("shield")}실제 Azure에는 연결하거나 변경하지 않았습니다. 운영 복구 결과가 아닙니다.</div>
    <dl class="result-meta"><div><dt>실행 방식</dt><dd>${result.mode === "create" ? "예시 신규 생성" : "예시 기존 업데이트"}</dd></div><div><dt>안전 백업</dt><dd>${date(safety.capturedAt)} KST · 형상 ${safety.snapshots.length}개 · 부재 기록 ${safety.absences.length}개<code class="resource-id">${esc(result.safetyId)}</code></dd></div><div><dt>적용 대상</dt><dd class="mono">${esc(result.targetId)}</dd></div><div><dt>보관 위치</dt><dd>이 브라우저의 localStorage · 실제 Blob·Log Analytics 미연결</dd></div></dl></div>
    <div class="wizard-actions"><button class="button" data-action="restore-view-logs">${icon("logs")}처리 로그 보기</button><button class="button primary" data-action="restore-view-status">형상 비교로 돌아가기 ${icon("arrow")}</button></div></section>`;
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

async function handleAction(action, target) {
  if (ui.restore.busy) { toast("예시 복원이 진행 중입니다. 저장이 끝난 뒤 다시 시도해 주세요.", "warning"); return; }
  if (action === "refresh-status") { store.assertFresh(); updateStatusResults(); toast("저장된 예시 관측값을 다시 표시했습니다. 실제 ARM 조회는 없습니다."); }
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
  if (action === "restore-selected") browseBackups(ui.selectedId);
  if (action === "browse-backups") browseBackups(target.dataset.resource || "", target.dataset.day || "");
  if (action === "show-current-only") showCurrentOnly();
  if (action === "add-tag") { ui.settings.tags.push({ key: "", operator: "equals", value: "" }); renderSettings(); $$("[data-tag-field='key']").at(-1)?.focus(); }
  if (action === "remove-tag") { ui.settings.tags.splice(Number(target.dataset.index), 1); renderSettings(); }
  if (action === "discard-settings") { ui.settings = clone(store.state.policy); renderSettings(); toast("저장하지 않은 예시 설정 변경을 취소했습니다."); }
  if (action === "save-settings") {
    savePolicy(store, ui.settings);
    ui.restore.plan = null;
    if (ui.restore.step === 3 && !ui.restore.result) ui.restore.step = 2;
    renderSettings();
    toast("이 브라우저에 예시 설정을 저장했습니다. 실제 수집 설정은 바뀌지 않았습니다.");
  }
  if (action === "pick-restore-resource") {
    ui.restore = { busy: false, resourceId: null }; ui.restoreTarget = ""; ui.restoreQuery = ""; historyPreferences = null;
    renderRestore();
  }
  if (action === "pick-restore-item") browseBackups(target.dataset.id);
  if (action === "restore-back") { ui.restore.step--; ui.restore.confirmed = false; ui.restore.plan = null; renderRestore(); }
  if (action === "restore-next") {
    const r = ui.restore;
    if (r.step === 1) {
      const run = store.state.runs.find((item) => item.id === r.runId);
      if (run?.status !== "Captured") throw new DemoError("완료된 백업을 선택해 주세요.");
      r.step = 2;
    } else {
      r.plan = prepareRestore(store.state, { resourceId: r.resourceId, runId: r.runId, mode: r.mode, groupId: r.groupId, name: r.name });
      r.step = 3;
      r.confirmed = false;
    }
    renderRestore();
    $("#main").focus({ preventScroll: true });
  }
  if (action === "retry-restore-review") { ui.restore.failed = false; ui.restore.step = 2; ui.restore.plan = null; ui.restore.confirmed = false; renderRestore(); }
  if (action === "execute-restore") {
    const r = ui.restore;
    if (!r.confirmed || !r.plan) throw new DemoError("최종 확인과 계획 검토가 필요합니다.");
    r.busy = true; r.phase = "checking";
    renderRestore();
    try {
      r.result = await executeRestore(store, r.plan, async (phase) => {
        r.phase = phase;
        renderRestore();
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      r.busy = false;
      render();
      toast("예시 복원을 완료했습니다. 안전 백업과 처리 로그를 브라우저에 보관했습니다.");
    } catch (error) {
      r.busy = false; r.failed = true; r.error = errorText(error);
      showError(error);
      renderRestore();
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
  if (target.name === "restore-mode") { ui.restore.mode = target.value; renderRestore(); }
  if (target.id === "target-subscription") {
    ui.restore.groupId = store.state.scopes.find((scope) => scope.parentId === target.value && scope.kind === "resourceGroup").id;
    renderRestore();
  }
  if (target.id === "target-group") { ui.restore.groupId = target.value; updateTargetPreview(); }
  if (target.id === "restore-confirm") { ui.restore.confirmed = target.checked; $("#execute-restore").disabled = !target.checked; }
}

function bootstrap() {
  syncNavigation();
  try {
    store = new DemoStore(window.localStorage);
    ui = {
      page: "status", runId: latestRun().id, selectedId: null, focusId: null,
      expanded: new Set(store.state.scopes.map((scope) => scope.id)), treeNodes: [],
      filters: { query: "", status: "all", type: "", targetOnly: false },
      settings: clone(store.state.policy), restore: { resourceId: null, busy: false }, restoreTarget: "", restoreQuery: "",
      logs: { days: 7, level: "", query: "" }, logPage: 0,
    };
    render();
  } catch (error) {
    $("#main").innerHTML = `<section class="panel"><div class="panel-body"><h1>프리뷰를 열 수 없습니다</h1><p class="page-description">${esc(errorText(error))}</p><p class="page-description">예시 데이터를 조용히 덮어쓰지 않았습니다. 브라우저 저장소를 허용하거나 ‘예시 데이터 초기화’를 선택해 주세요.</p></div></section>`;
    showError(error);
  }
}

$("#main").addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) handleAction(target.dataset.action, target).catch(showError);
});
$("#main").addEventListener("change", (event) => {
  try { handleChange(event.target); } catch (error) { showError(error); }
});
$("#main").addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "resource-search") { ui.filters.query = target.value; updateStatusResults(true); }
  if (target.id === "restore-item-query") {
    ui.restoreQuery = target.value;
    $("#restore-item-list").innerHTML = backupItemListHtml(backupItems(store.state), ui.restoreQuery, { esc, icon, relativeTime });
  }
  if (target.dataset.tagField && target.dataset.tagField !== "operator") {
    ui.settings.tags[Number(target.dataset.tagIndex)][target.dataset.tagField] = target.value;
    updateSettingsSummary();
  }
  if (target.id === "target-name") { ui.restore.name = target.value; updateTargetPreview(); }
});
$("#main").addEventListener("submit", (event) => {
  if (event.target.id !== "logs-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  ui.logs = { days: Number(form.get("days")), level: String(form.get("level")), query: String(form.get("query")) };
  ui.logPage = 0;
  renderLogs();
});
$("#main").addEventListener("keydown", handleTreeKey);
$("#main").addEventListener("focusin", (event) => {
  const row = event.target.closest("[data-node]");
  if (row) {
    ui.focusId = row.dataset.node;
    $$("[data-node]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; });
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
  if (link && ui?.restore.busy) { event.preventDefault(); toast("예시 복원이 끝날 때까지 기다려 주세요.", "warning"); return; }
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
  if (!allowUnload && (ui?.restore.busy || (ui && JSON.stringify(ui.settings) !== JSON.stringify(store.state.policy)))) event.preventDefault();
});
window.addEventListener("error", (event) => showError(event.error || new DemoError("화면 처리 중 오류가 발생했습니다. 작업을 중단하고 새로고침해 주세요.")));
window.addEventListener("unhandledrejection", (event) => showError(event.reason));
bootstrap();
