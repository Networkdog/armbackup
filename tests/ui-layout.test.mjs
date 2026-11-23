import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const css = readFileSync(new URL("../src/armbackup/ui_static/styles.css", import.meta.url), "utf8");
const liveApp = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/armbackup/ui_static/index.html", import.meta.url), "utf8");
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing rule: ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

test("the default UI reproduces 125% typography without forcing browser zoom", () => {
  assert.match(rule(":root"), /font-size:\s*125%/);
  for (const [selector, previousPixels] of [
    ["body", 13],
    [".button", 11],
    ["h1", 25],
    [".live-console .resource-name", 12],
  ]) {
    const font = rule(selector).match(/font-size:\s*([\d.]+)rem/);
    assert.ok(font, `Missing relative font size: ${selector}`);
    assert.equal(Number(font[1]) * 16 * 1.25, previousPixels * 1.25);
  }
  assert.doesNotMatch(css, /font-size:\s*[\d.]+px|transform:\s*scale\(/);
  assert.equal((css.match(/\bzoom\s*:/g) || []).length, 1);
  assert.match(rule(".topbar, main, dialog"), /zoom:\s*0\.9/);
});

test("workspace panels and settings summary omit redundant connection and timezone blocks", () => {
  assert.doesNotMatch(html, /workspace-label|workspace-dot|workspace-demo/);
  assert.doesNotMatch(liveApp, /workspaceContext|workspace-context/);
  const settings = liveApp.slice(liveApp.indexOf("function renderSettings()"), liveApp.indexOf("function startRestore("));
  assert.doesNotMatch(settings, /id="connection-settings"|연결 정보|id="timezone"|표시 시간대/);
  assert.doesNotMatch(settings, /ArmBackup 공식 지원|조건이 없으면 모든 태그를 포함합니다/);
  assert.doesNotMatch(liveApp, /서버에 보관한 설정과 같습니다/);
});

test("backup settings select types, then tags, then scopes in live and preview modes", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const expectedLabels = ["수집할 리소스 종류", "태그 조건", "허용된 리소스 체계"];
  for (const source of [liveApp, demo]) {
    const settings = source.slice(source.indexOf("function renderSettings()"));
    const headings = [...settings.matchAll(/class="section-number">(\d+)<\/span>([^<]+)/g)];
    assert.deepEqual(headings.map((match) => [match[1], match[2]]), expectedLabels.map((label, index) => [`0${index + 1}`, label]));
    assert.ok(settings.indexOf('class="type-grid"') < settings.indexOf('class="tag-rule"'));
    assert.ok(settings.indexOf('class="tag-rule"') < settings.indexOf('class="scope-choices"'));
    assert.match(settings, /연관 리소스/);
    assert.match(settings, /종속 리소스/);
  }
});

test("scrollable scope list anchors sr-only spans and topbar freshness indicator renders without a box", () => {
  assert.match(rule(".scope-choices"), /position:\s*relative/);
  assert.match(rule(".scope-choice"), /position:\s*relative/);
  assert.doesNotMatch(rule(".environment-pill"), /border|padding|background/);
});

test("live settings use save-and-backup as primary and keep save-only without a competing backup button", () => {
  const settings = liveApp.slice(liveApp.indexOf("function renderSettings()"), liveApp.indexOf("function startRestore("));
  assert.match(settings, /button\("save-backup", "대상 저장 후 백업", "plus", true/);
  assert.match(settings, /button\("save-policy", "저장만", "check", false/);
  assert.doesNotMatch(settings, /button\("backup-now"/);
});

test("backup settings spend no row on a title and keep the actions under the expected-target count", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const settings = liveApp.slice(liveApp.indexOf("function renderSettings()"), liveApp.indexOf("function startRestore("));
  assert.doesNotMatch(settings, /heading\("백업 대상 설정"/);
  assert.match(settings, /<h1 class="sr-only">백업 대상 설정<\/h1>/);
  assert.ok(settings.indexOf('id="target-count"') < settings.indexOf('class="summary-actions"'));
  assert.ok(settings.indexOf('class="summary-actions"') > settings.indexOf('<aside class="panel settings-summary">'));
  assert.doesNotMatch(demo.slice(demo.indexOf("function renderSettings()")), /heading\("백업 대상 설정"/);
  assert.match(demo, /class="summary-actions"/);
});

test("every message is a top-right notification, not a block that takes page space", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(html + css + liveApp, /error-banner|global-error|error-dialog|toast-region/);
  assert.match(html, /<div id="notification-region"[^>]+popover="manual"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="notification-region"') > html.indexOf("</main>"));
  assert.match(html, /id="notification-bell"[^>]+aria-controls="notification-panel"/);
  assert.ok(html.includes('id="app-dialog"'));
  assert.match(rule(".notification-region"), /position: fixed;[^}]*inset: 3\.25rem 1rem auto auto/);
  assert.match(rule(".notification-text"), /white-space: pre-line/);
  for (const source of [liveApp, demo]) {
    assert.match(source, /createNotifications\(document\)/);
    assert.match(source, /notifier\.watch\(\$\("#main"\)\)/);
    assert.doesNotMatch(source, /read-progress|collection-status|operation-status|recent-history-notice|current-only-note/);
  }
});
test("status selection never appends a lower shape panel while restore and history remain available", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  for (const source of [liveApp, demo]) {
    assert.doesNotMatch(source, /resource-detail|function renderDetail\(/);
    assert.match(source, /select-resource/);
    assert.match(source, /function renderRestore\(/);
    assert.match(source, /function renderRestoreCalendar\(/);
  }
  assert.match(liveApp, /function diffTable\(/);
});

test("restore owns the calendar and the old history route has no standalone menu", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const picker = readFileSync(new URL("../src/armbackup/ui_static/resource-picker.mjs", import.meta.url), "utf8");
  const webui = readFileSync(new URL("../src/armbackup/webui.py", import.meta.url), "utf8");
  assert.doesNotMatch(html, /href="#history"|data-page="history"/);
  assert.match(webui, /"\/resource-picker\.mjs":\s*\("resource-picker\.mjs"/);
  assert.doesNotMatch(picker, /\sstyle="/);
  for (const source of [liveApp, demo]) {
    assert.doesNotMatch(source, /history:\s*"변경 달력"|history:\s*renderHistory/);
    assert.match(source, /function renderRestoreCalendar\(/);
    assert.match(source, /replaceState\(null, "", "#restore"\)/);
    assert.match(source, /startRestore\(record\.resourceId, record\.afterRunId, true(?:, intent)?\)/);
  }
});

test("compact headers keep readable typography without decorative description rows", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  for (const source of [liveApp, demo]) {
    const heading = source.slice(source.indexOf("function heading("), source.indexOf("\n}", source.indexOf("function heading(")));
    assert.doesNotMatch(heading, /heading-eyebrow|page-description/);
    assert.match(heading, /<h1>/);
  }
  assert.match(rule(".topbar"), /height:\s*2\.5rem/);
  assert.match(rule(".page-heading"), /margin-bottom:\s*\.625rem/);
  assert.doesNotMatch(html, /class="preview-banner"/);
});

test("the restore page spends no space on a repeated title or calendar heading", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/armbackup/ui_static/history-panel.mjs", import.meta.url), "utf8");
  for (const source of [liveApp, demo]) {
    assert.doesNotMatch(source, /heading\("복원·복제"/);
    assert.match(source, /<h1 class="sr-only">복원·복제<\/h1>/);
    assert.doesNotMatch(source, /restoreHeading\([^)]/);
    assert.doesNotMatch(source, /백업 현황으로<\/a>/);
  }
  assert.doesNotMatch(panel, /백업 달력|백업 시점 탐색/);
  assert.match(panel, /this\.onRestore \? "" : '<div class="history-title">/);
  assert.match(panel, /const compact = this\.onRestore && this\.fixedItem;/);
  assert.match(panel, /\$\{compact \? "" : `<div class="history-toolbar">/);
  assert.match(panel, /\$\{compact \? "" : `<div class="history-overview">/);
});

test("backup health statistics live on the logs page so the status page gives its height to the TreeGrid", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const section = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from) + 1));
  const liveStatus = section(liveApp, "function renderStatus(", "function loadRecentHistory(");
  const demoStatus = section(demo, "function renderStatus(", "function backupSummaryHtml(");
  for (const status of [liveStatus, demoStatus]) {
    assert.doesNotMatch(status, /summary-card|summaryCardsHtml|backupSummaryHtml|heading\("백업 현황"/);
    assert.match(status, /<h1 class="sr-only">백업 현황<\/h1>/);
    assert.match(status, /topbar-slot|statusHeadingHtml/);
  }
  assert.match(section(liveApp, "function renderLogs(", "async function loadLogs("), /summaryCardsHtml\(\)/);
  assert.match(section(demo, "function renderLogs(", "function focusTree("), /backupSummaryHtml\(\)/);
  assert.match(demoStatus, /topbar-slot"\)\.innerHTML = `[^`]*refresh-status/);
  const header = demoStatus.slice(demoStatus.indexOf('class="panel-header"'), demoStatus.indexOf('class="toolbar"'));
  assert.match(header, /id="restore-selected"/);
  assert.match(header, /id="selection-hint"/);
});

test("the status page fits the viewport so only the backup table scrolls", () => {
  assert.match(liveApp, /classList\.toggle\("fit-page", ui\.page === "status"\)/);
  const fit = css.slice(css.indexOf("@media (min-height: 28em) and (min-width: 60em)"));
  assert.match(fit, /\.main-shell \{[^}]*height: 100dvh/);
  assert.match(fit, /main \{[^}]*overflow: hidden/);
  assert.match(fit, /\.status-panel > \.tree-area \{[^}]*flex: 1 1 auto/);
  assert.match(fit, /\.tree-area \.table-scroll \{[^}]*flex: 1 1 auto;[^}]*max-height: none/);
  assert.match(fit, /\.tree-area \.tree-pane \{[^}]*max-height: none/);
  const status = liveApp.slice(liveApp.indexOf("function renderStatus("), liveApp.indexOf("function loadRecentHistory("));
  assert.doesNotMatch(status, /panel-header|run-strip|latest-source-note|class="status-note"/);
  assert.doesNotMatch(status, /shown-count|expand-all|collapse-all|class="page-heading/);
  assert.match(status, /topbar-slot/);
  assert.doesNotMatch(status, /workflow|export-report|class="table-bottom"|recentLegendHtml/);
  const guide = liveApp.slice(liveApp.indexOf("function showScopeGuide("), liveApp.indexOf("function showCurrentOnly("));
  assert.match(guide, /recentLegendHtml\(esc\)/);
  assert.match(guide, /행 음영/);
});

test("entering the live console does not open the scope guide modal until the user clicks the help button", async () => {
  const appDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const title = { textContent: "" }, body = { innerHTML: "" }, actions = { innerHTML: "" };
  const sidebar = { classList: { remove() {} }, inert: false };
  const elements = new Map([
    ["#app-dialog", appDialog], ["#dialog-title", title], ["#dialog-body", body], ["#dialog-actions", actions],
    ["#sidebar", sidebar], ["#main", { replaceChildren() {} }],
  ]);
  const refreshes = [];
  const context = vm.createContext({
    session: null, state: { historyLimited: false, activeOperations: [] }, dialogTrigger: null,
    ui: { runId: "", stale: false, busy: false, job: null, logTab: "analytics", recentGeneration: 0 },
    document: { activeElement: null }, HTMLElement: class {},
    esc: (value) => String(value ?? ""), recentLegendHtml: () => "<div class='recent-legend'></div>",
    syncNavigation() {}, render() {}, renderOperation() {}, showError(error) { throw error; },
    $: (selector) => elements.get(selector) || null,
    api: {
      connect: async () => ({
        workspace: {
          inventoryScope: "subscription", subscriptionName: "Production",
          scope: "/subscriptions/sub-1", readScope: "/subscriptions/sub-1",
          restoreEnabled: true, archiveMode: "blob", loggingEnabled: true,
        },
      }),
    },
    refresh: async (...args) => { refreshes.push(args); },
  });
  vm.runInContext(liveApp.slice(liveApp.indexOf("function dialog("), liveApp.indexOf("function showCurrentOnly(")), context);
  vm.runInContext(liveApp.slice(liveApp.indexOf("async function bootstrap()"), liveApp.lastIndexOf("bootstrap();")), context);

  await context.bootstrap();
  assert.equal(appDialog.open, false);
  assert.equal(refreshes.length, 1);
  assert.doesNotMatch(liveApp, /showStartupNotice|scopeNoticeRequired/);

  context.showScopeGuide();
  assert.equal(appDialog.open, true);
  assert.equal(title.textContent, "범위 및 화면 안내");
});

test("layout dimensions and media queries scale with readable typography", () => {
  assert.doesNotMatch(liveApp, /\sstyle="/);
  assert.match(rule(".button"), /min-height:\s*2\.1875rem/);
  assert.match(rule(".live-console .sidebar"), /width:\s*11\.375rem/);
  assert.doesNotMatch(css, /[\d.]px\b/);
  const mobileQuery = "max-width: 59.375em";
  assert.ok(css.includes(`@media (${mobileQuery})`));
  assert.ok(liveApp.includes(`window.matchMedia("(${mobileQuery})")`));
  assert.equal(59.375 * 16, 760 * 1.25);
  assert.deepEqual(
    [...css.matchAll(/@media \((?:min|max)-width: ([\d.]+em)\)/g)].map((match) => match[1]),
    ["132.8125em", "93.75em", "78.125em", "85.9375em", "59.375em"],
  );
  assert.match(css, /\.live-console \.summary-cards \{ display: grid;/);
  assert.doesNotMatch(css, /fit-page \.summary-/);
  assert.match(css, /td input\[type="checkbox"\] \{ width: 1\.25rem; height: 1\.25rem; \}/);
  assert.match(css, /dialog\[open\] \{ display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(css, /\.bundle-plan > \.check-label \{ display: flex;/);
  assert.match(liveApp, /보관된 백업 없음 · 현재 자원 표시/);
});

test("status table indents scope rows by depth, keeps ordinary rows unindented and white, and shades header and scope rows darker by depth", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  const demoTable = demo.slice(demo.indexOf("function updateStatusResults("), demo.indexOf("function showCurrentOnly("));
  const liveTable = liveApp.slice(liveApp.indexOf("function updateTree("), liveApp.indexOf("function healthSignature("));
  assert.match(demoTable, /class="scope-cell depth-\$\{Math\.min\(node\.level - 1, 4\)\}"/);
  assert.match(liveTable, /class="scope-cell">\$\{indent\(node\.level - 1\)\}/);
  const demoResourceRow = demoTable.slice(demoTable.indexOf('class="resource-row'));
  const liveResourceRow = liveTable.slice(liveTable.indexOf('class="resource-row'));
  for (const snippet of [demoResourceRow, liveResourceRow]) {
    assert.doesNotMatch(snippet, /indent\(|tree-toggle-spacer|depth-/);
  }
  assert.match(liveTable, /<span class="resource-name-line"><span class="resource-name"[^>]*>[^<]*<\/span>\$\{toggle\}<\/span>/);
  assert.match(rule(".resource-row"), /background:\s*var\(--surface\)/);
  assert.doesNotMatch(css, /\.resource-row\.(?:backup-healthy|backup-failed|backup-overdue|backup-never|backup-unknown|backup-excluded|same|critical|warning|minor|unknown)\s*[,{]/);
  const luminance = (hex) => {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
    const [r, g, b] = [0, 2, 4].map((i) => {
      const s = Number.parseInt(full.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bgHex = (selector, prop = "background") => {
    const match = rule(selector).match(new RegExp(`${prop}:\\s*(#[0-9a-fA-F]{3,6})`));
    assert.ok(match, `Missing ${prop} hex on ${selector}`);
    return match[1];
  };
  const chain = [
    bgHex(".resource-table thead th"),
    bgHex('.scope-row td[data-tree-depth="0"]', "--scope-fill"),
    bgHex('.scope-row td[data-tree-depth="1"]', "--scope-fill"),
    bgHex('.scope-row td[data-tree-depth="2"]', "--scope-fill"),
    bgHex('.scope-row td[data-tree-depth="3"]', "--scope-fill"),
    bgHex(".scope-row", "--scope-fill"),
    "#ffffff",
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.ok(luminance(chain[i]) < luminance(chain[i + 1]), `Expected ${chain[i]} to be darker than ${chain[i + 1]}`);
  }
});

