import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LAYOUT_KEY, WIDTH_KEY, bindTreePane, buildPaneNodes, createPaneState, paneRows, rowsInScope, scopeBarHtml, treePaneHtml, treePath,
} from "../src/armbackup/ui_static/tree-pane.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<svg data-icon="${name}"></svg>`;
const state = { scopes: [
  { id: "mg", parentId: null, kind: "managementGroup", name: "Contoso <MG>" },
  { id: "sub", parentId: "mg", kind: "subscription", name: "Prod" },
  { id: "rg1", parentId: "sub", kind: "resourceGroup", name: "rg-a" },
  { id: "rg2", parentId: "sub", kind: "resourceGroup", name: "rg-b" },
  { id: "unused", parentId: "mg", kind: "subscription", name: "Unused" },
] };
const row = (id, groupId, type, typeLabel) => ({ resource: { id, groupId, type, typeLabel } });
const rows = [row("/a", "rg1", "vnet", "Virtual Network"), row("/b", "rg1", "nsg", "NSG"), row("/c", "rg2", "vnet", "Virtual Network")];
const attention = (item) => item.resource.id === "/b";
const memory = () => {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("the tree keeps the Management Group › Subscription › Resource Group hierarchy and drops scopes without resources", () => {
  const nodes = buildPaneNodes(state, rows, { attention });
  assert.deepEqual(nodes.map((node) => [node.key, node.parent, node.count, node.attention]),
    [["mg", null, 3, 1], ["sub", "mg", 3, 1], ["rg1", "sub", 2, 1], ["rg2", "sub", 1, 0]]);
  assert.deepEqual(treePath(nodes, "rg2").map((node) => node.label), ["Contoso <MG>", "Prod", "rg-b"]);
});

test("type grouping is a flat list of resource types", () => {
  const nodes = buildPaneNodes(state, rows, { grouping: "type", attention });
  assert.deepEqual(nodes.map((node) => [node.key, node.label, node.count, node.attention, node.parent]),
    [["type:nsg", "NSG", 1, 1, null], ["type:vnet", "Virtual Network", 2, 0, null]]);
});

test("a scope selects its own and nested resources, and no scope selects everything", () => {
  assert.equal(rowsInScope(state, rows, "hierarchy", null), rows);
  assert.deepEqual(rowsInScope(state, rows, "hierarchy", "rg1").map((item) => item.resource.id), ["/a", "/b"]);
  assert.deepEqual(rowsInScope(state, rows, "hierarchy", "sub").map((item) => item.resource.id), ["/a", "/b", "/c"]);
  assert.deepEqual(rowsInScope(state, rows, "type", "type:vnet").map((item) => item.resource.id), ["/a", "/c"]);
});

test("collapsing a tree node hides its descendants from keyboard navigation", () => {
  const nodes = buildPaneNodes(state, rows);
  assert.deepEqual(paneRows(nodes, new Set()).map((entry) => entry.node?.key ?? "root"), ["root", "mg", "sub", "rg1", "rg2"]);
  assert.deepEqual(paneRows(nodes, new Set(["sub"])).map((entry) => entry.node?.key ?? "root"), ["root", "mg", "sub"]);
  assert.equal(paneRows(nodes, new Set()).find((entry) => entry.node?.key === "sub").expandable, true);
  assert.equal(paneRows(nodes, new Set()).find((entry) => entry.node?.key === "rg1").expandable, false);
});

test("the layout and width are remembered and an open tree is the default", () => {
  const storage = memory();
  assert.equal(createPaneState(storage).open, true);
  storage.setItem(LAYOUT_KEY, "full");
  storage.setItem(WIDTH_KEY, "9999");
  const pane = createPaneState(storage);
  assert.equal(pane.open, false);
  assert.equal(pane.width, 560);
  assert.equal(createPaneState({ getItem() { throw new Error("blocked"); } }).open, true);
});

test("an open tree exposes tree semantics and a collapsed one is a labelled rail", () => {
  const nodes = buildPaneNodes(state, rows, { attention });
  const pane = createPaneState(memory());
  pane.scope = "rg1";
  const open = treePaneHtml({ nodes, pane, rootCount: 3, rootAttention: 1 }, { esc, icon });
  assert.match(open, /role="tree"/);
  assert.match(open, /data-pane-key="rg1"[^>]*aria-selected="true"/);
  assert.match(open, /data-pane-key="sub"[^>]*aria-expanded="true"/);
  assert.doesNotMatch(open, /data-pane-key="rg1"[^>]*aria-expanded/);
  assert.match(open, /Contoso &lt;MG&gt;/);
  assert.match(open, /aria-label="백업 문제 1개"/);
  assert.match(open, /data-pane-resizer/);
  assert.doesNotMatch(open, /\sstyle="/);
  pane.open = false;
  const rail = treePaneHtml({ nodes, pane, rootCount: 3 }, { esc, icon });
  assert.doesNotMatch(rail, /role="tree"/);
  assert.match(rail, /aria-expanded="false"/);
  assert.match(rail, /rg-a/);
});

test("a narrow tree opens only as an overlay and offers a way back to heading rows", () => {
  const nodes = buildPaneNodes(state, rows);
  const pane = createPaneState(memory());
  pane.narrow = true;
  assert.doesNotMatch(treePaneHtml({ nodes, pane, rootCount: 3 }, { esc, icon }), /role="tree"/);
  pane.peek = true;
  const html = treePaneHtml({ nodes, pane, rootCount: 3 }, { esc, icon });
  assert.match(html, /role="tree"/);
  assert.match(html, /data-pane-action="compact"/);
  assert.doesNotMatch(html, /data-pane-resizer/);
});

test("the scope bar repeats the selected path and clears it", () => {
  const nodes = buildPaneNodes(state, rows);
  assert.equal(scopeBarHtml({ nodes, scope: null, count: 3 }, { esc, icon }), "");
  const html = scopeBarHtml({ nodes, scope: "rg1", count: 2 }, { esc, icon });
  assert.match(html, /role="status"/);
  assert.match(html, /<li aria-current="true"><span>Resource Group<\/span> <strong>rg-a<\/strong>/);
  assert.match(html, /data-pane-action="clear"/);
});

function harness() {
  const listeners = {};
  const root = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const storage = memory();
  const ui = { pane: createPaneState(storage) };
  ui.pane.nodes = buildPaneNodes(state, rows);
  let renders = 0;
  bindTreePane(root, ui, () => { renders++; });
  const click = (matches) => listeners.click({ target: { closest: (selector) => matches[selector] ?? null } });
  return { ui, storage, click, renders: () => renders, listeners };
}

test("choosing a tree item scopes the table and the twisty only folds the tree", () => {
  const { ui, click, renders } = harness();
  click({ "[data-pane-key]": { dataset: { paneKey: "rg1" } } });
  assert.equal(ui.pane.scope, "rg1");
  assert.equal(renders(), 1);
  click({ "[data-pane-key]": { dataset: { paneKey: "sub" } }, "[data-pane-twisty]": {} });
  assert.deepEqual([...ui.pane.collapsed], ["sub"]);
  assert.equal(ui.pane.scope, "rg1");
  click({ "[data-pane-key]": { dataset: { paneKey: "" } } });
  assert.equal(ui.pane.scope, null);
});

test("collapsing the tree switches to heading rows, clears the scope and remembers the layout", () => {
  const { ui, storage, click } = harness();
  ui.pane.scope = "rg2";
  click({ "[data-pane-action]": { dataset: { paneAction: "toggle" } } });
  assert.equal(ui.pane.open, false);
  assert.equal(ui.pane.scope, null);
  assert.equal(storage.getItem(LAYOUT_KEY), "full");
  click({ "[data-pane-action]": { dataset: { paneAction: "toggle" } } });
  assert.equal(ui.pane.open, true);
  assert.equal(storage.getItem(LAYOUT_KEY), "tree");
});

test("on a narrow screen the toggle only peeks and choosing a scope returns to the tree layout", () => {
  const { ui, storage, click } = harness();
  ui.pane.narrow = true;
  ui.pane.open = false;
  click({ "[data-pane-action]": { dataset: { paneAction: "toggle" } } });
  assert.equal(ui.pane.peek, true);
  assert.equal(ui.pane.open, false);
  click({ "[data-pane-key]": { dataset: { paneKey: "rg1" } } });
  assert.equal(ui.pane.peek, false);
  assert.equal(ui.pane.open, true);
  assert.equal(ui.pane.scope, "rg1");
  assert.equal(storage.getItem(LAYOUT_KEY), "tree");
  click({ "[data-pane-action]": { dataset: { paneAction: "compact" } } });
  assert.equal(ui.pane.open, false);
  assert.equal(ui.pane.scope, null);
});

test("keyboard navigation follows the tree pattern", () => {
  const { ui, listeners, renders } = harness();
  const element = { dataset: { paneKey: "sub" }, closest: (selector) => (selector === "[data-pane-key]" ? element : null) };
  const press = (key) => {
    const event = { key, target: element, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.keydown(event);
    return event;
  };
  assert.equal(press("ArrowLeft").prevented, true);
  assert.deepEqual([...ui.pane.collapsed], ["sub"]);
  assert.equal(renders(), 1);
  press("ArrowRight");
  assert.deepEqual([...ui.pane.collapsed], []);
  press("Enter");
  assert.equal(ui.pane.scope, "sub");
});

test("both status screens mount the shared tree grid and pane and register the modules for serving", () => {
  const live = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
  const demo = readFileSync(new URL("../src/armbackup/ui_static/app.mjs", import.meta.url), "utf8");
  for (const source of [live, demo]) {
    assert.match(source, /from "\.\/tree-pane\.mjs"/);
    assert.match(source, /bindTreePane\(\$\("#main"\)/);
    assert.match(source, /mountTreeArea\(\$\("#tree-area"\)/);
    assert.match(source, /data-tree-depth="\$\{node\.level - 1\}"/);
    assert.match(source, /unmountTreeArea\?\.\(\)/);
    assert.doesNotMatch(source, /<tbody>\$\{body\}<\/tbody>/);
  }
  const server = readFileSync(new URL("../src/armbackup/webui.py", import.meta.url), "utf8");
  assert.match(server, /"\/tree-grid\.mjs"/);
  assert.match(server, /"\/tree-pane\.mjs"/);
});
