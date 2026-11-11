import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.doesNotMatch(css, /font-size:\s*[\d.]+px|\bzoom\s*:|transform:\s*scale\(/);
});

test("connection metadata belongs to settings, not persistent workspace panels", () => {
  assert.doesNotMatch(html, /workspace-label|workspace-dot|workspace-demo/);
  assert.doesNotMatch(liveApp, /workspaceContext|workspace-context/);
  const settings = liveApp.slice(liveApp.indexOf("function renderSettings()"), liveApp.indexOf("function startRestore("));
  assert.match(settings, /id="connection-settings"/);
  assert.match(settings, /state\.workspace\.name/);
  assert.match(settings, /state\.workspace\.subscriptionName/);
  assert.match(settings, /state\.observedAt/);
  assert.match(settings, /id="timezone"/);
  assert.doesNotMatch(liveApp, /\$\("#timezone"\)\.disabled/);
});

test("backup settings select types before scopes and tags in live and preview modes", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  for (const [source, labels] of [
    [liveApp, ["수집할 리소스 종류", "허용된 리소스 체계", "태그 조건"]],
    [demo, ["리소스 종류", "리소스 체계", "리소스 태그"]],
  ]) {
    const settings = source.slice(source.indexOf("function renderSettings()"));
    const headings = [...settings.matchAll(/class="section-number">(\d+)<\/span>([^<]+)/g)];
    assert.deepEqual(headings.map((match) => [match[1], match[2]]), labels.map((label, index) => [`0${index + 1}`, label]));
    assert.ok(settings.indexOf('class="type-grid"') < settings.indexOf('class="scope-choices"'));
    assert.ok(settings.indexOf('class="scope-choices"') < settings.indexOf('class="tag-rule"'));
  }
});

test("live settings use save-and-backup as primary and keep save-only without a competing backup button", () => {
  const settings = liveApp.slice(liveApp.indexOf("function renderSettings()"), liveApp.indexOf("function startRestore("));
  assert.match(settings, /button\("save-backup", "대상 저장 후 백업", "plus", true/);
  assert.match(settings, /button\("save-policy", "저장만", "check", false/);
  assert.doesNotMatch(settings, /button\("backup-now"/);
});

test("global errors live in a separate accessible modal outside the page layout", () => {
  assert.doesNotMatch(html + css + liveApp, /error-banner|global-error/);
  assert.match(html, /<dialog id="error-dialog"[^>]+role="alertdialog"[^>]+aria-describedby="error-message"/);
  assert.ok(html.indexOf('id="error-dialog"') > html.indexOf("</main>"));
  assert.ok(html.includes('id="app-dialog"'));
  assert.match(css, /\.error-dialog-body p \{[^}]*white-space: pre-wrap/);
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
  assert.doesNotMatch(html, /href="#history"|data-page="history"/);
  for (const source of [liveApp, demo]) {
    assert.doesNotMatch(source, /history:\s*"변경 달력"|history:\s*renderHistory/);
    assert.match(source, /function renderRestoreCalendar\(/);
    assert.match(source, /replaceState\(null, "", "#restore"\)/);
    assert.match(source, /startRestore\(record\.resourceId, record\.afterRunId, true\)/);
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
    assert.doesNotMatch(source, /백업 현황으로<\/a>/);
  }
  assert.doesNotMatch(panel, /백업 달력|백업 시점 탐색/);
  assert.match(panel, /this\.onRestore \? "" : '<div class="history-title">/);
  assert.match(panel, /const compact = this\.onRestore && this\.fixedItem;/);
  assert.match(panel, /\$\{compact \? "" : `<div class="history-toolbar">/);
  assert.match(panel, /\$\{compact \? "" : `<div class="history-overview">/);
});

test("the status page fits the viewport so only the backup table scrolls", () => {
  assert.match(liveApp, /classList\.toggle\("fit-page", ui\.page === "status"\)/);
  const fit = css.slice(css.indexOf("@media (min-height: 28em) and (min-width: 60em)"));
  assert.match(fit, /\.main-shell \{[^}]*height: 100dvh/);
  assert.match(fit, /main \{[^}]*overflow: hidden/);
  assert.match(fit, /\.status-panel > \.table-scroll \{[^}]*flex: 1 1 auto;[^}]*max-height: none/);
  const status = liveApp.slice(liveApp.indexOf("function renderStatus("), liveApp.indexOf("function loadRecentHistory("));
  assert.doesNotMatch(status, /panel-header|run-strip|latest-source-note|class="status-note"/);
  assert.equal((status.match(/id="shown-count"/g) || []).length, 1);
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
});
