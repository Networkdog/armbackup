import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/armbackup/ui_static/styles.css", import.meta.url), "utf8");
const liveApp = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
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
