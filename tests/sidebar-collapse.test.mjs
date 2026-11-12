import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SIDEBAR_STORAGE_KEY, applyCollapsed, readCollapsed, writeCollapsed } from "../src/armbackup/ui_static/sidebar-collapse.mjs";

const css = readFileSync(new URL("../src/armbackup/ui_static/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/armbackup/ui_static/index.html", import.meta.url), "utf8");

function fakeDocument() {
  const labels = [];
  const owner = (name) => {
    const attributes = new Map();
    return {
      title: "", classList: { contains: () => name === "brand" },
      removeAttribute(key) { attributes.delete(key); if (key === "title") this.title = ""; },
    };
  };
  const make = (name, text) => {
    const element = owner(name);
    const label = { get firstChild() { return { textContent: this.textContent }; }, textContent: text, closest: () => element };
    labels.push({ element, label });
    return label;
  };
  make("brand", "armbackup");
  make("a", "백업 현황");
  const toggleText = make("button", "메뉴 접기");
  const attributes = {};
  const toggle = { setAttribute: (key, value) => { attributes[key] = value; }, querySelector: () => toggleText };
  const classes = new Set();
  return {
    labels, attributes, classes, toggleText,
    body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
    querySelector: () => toggle,
    querySelectorAll: () => labels.map((item) => item.label),
  };
}

test("the collapsed state is remembered and tolerates unavailable storage", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readCollapsed(storage), false);
  writeCollapsed(storage, true);
  assert.equal(values.get(SIDEBAR_STORAGE_KEY), "1");
  assert.equal(readCollapsed(storage), true);
  const blocked = { getItem() { throw new DOMException("blocked"); }, setItem() { throw new DOMException("blocked"); } };
  assert.equal(readCollapsed(blocked), false);
  assert.doesNotThrow(() => writeCollapsed(blocked, true));
});

test("collapsing keeps accessible names through titles and the toggle label", () => {
  const doc = fakeDocument();
  applyCollapsed(doc, true);
  assert.ok(doc.classes.has("sidebar-collapsed"));
  assert.equal(doc.attributes["aria-expanded"], "false");
  assert.equal(doc.attributes["aria-label"], "메뉴 펼치기");
  assert.equal(doc.labels[0].element.title, "", "the brand link keeps its own title");
  assert.equal(doc.labels[1].element.title, "백업 현황");
  assert.equal(doc.labels[2].element.title, "메뉴 펼치기");
  applyCollapsed(doc, false);
  assert.ok(!doc.classes.has("sidebar-collapsed"));
  assert.equal(doc.attributes["aria-expanded"], "true");
  assert.equal(doc.labels[1].element.title, "");
});

test("the sidebar collapses to an icon rail on wide screens only and the profile lives in one place", () => {
  assert.match(html, /id="sidebar-toggle"[^>]*aria-controls="sidebar"/);
  assert.doesNotMatch(html, /topbar-divider|avatar small/);
  const wide = css.slice(css.indexOf("@media not all and (max-width: 59.375em)"));
  assert.match(wide, /body\.sidebar-collapsed \.sidebar \{ width: 4\.25rem;/);
  assert.match(wide, /body\.sidebar-collapsed \.main-shell \{ margin-left: 4\.25rem;/);
  assert.match(wide, /body\.sidebar-collapsed \.side-label \{ position: absolute;/);
  assert.match(css, /\.sidebar-toggle \{ display: none; \}/);
});
