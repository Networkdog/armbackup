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

test("status selection never appends a lower shape panel while restore and history remain available", () => {
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  for (const source of [liveApp, demo]) {
    assert.doesNotMatch(source, /resource-detail|function renderDetail\(/);
    assert.match(source, /select-resource/);
    assert.match(source, /function renderRestore\(/);
    assert.match(source, /function renderHistory\(/);
  }
  assert.match(liveApp, /function diffTable\(/);
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
