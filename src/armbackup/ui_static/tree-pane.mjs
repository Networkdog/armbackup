// 마스터-디테일 계층 탐색(TreePane)이다. azfirewallagent의 TreePane.tsx를 DOM 코드로 옮겼다.
//
// 왼쪽 트리가 계층을 맡으므로 오른쪽 표에는 제목 행이 없고 모든 행이 잎이다(E 형). 트리를 접으면 표가
// 계층마다 제목 행을 하나씩 가진 전체 제목 행 배치(A 형)로 바뀐다. 접힌 상태가 곧 배치를 정한다.
//  - 넓은 화면: 너비를 끌어 조절하는 인라인 패널과 접기 버튼
//  - 좁은 화면: 폭이 좁은 레일이 되고 패널은 표 위에 겹쳐 열리며, 선택하면 닫힌다
import { freezeTreeGrid } from "./tree-grid.mjs";
import { ancestors } from "./view-model.mjs";

export const LAYOUT_KEY = "armbackup.status-layout";
export const WIDTH_KEY = "armbackup.status-tree-width";
export const ROOT = "";
export const NARROW_BELOW = 820;
const MIN_WIDTH = 168;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 240;
const SCOPE_KINDS = {
  managementGroup: { label: "Management Group", icon: "layers" },
  subscription: { label: "Subscription", icon: "cloud" },
  resourceGroup: { label: "Resource Group", icon: "folder" },
};

const clampWidth = (value) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(value) || DEFAULT_WIDTH));
function read(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}
function write(storage, key, value) {
  try { storage?.setItem(key, value); } catch { /* 보관하지 못해도 이번 화면에서는 선택을 유지한다. */ }
}

// layout은 'tree'(E 형, 기본)와 'full'(A 형)뿐이다.
export function createPaneState(storage = globalThis.localStorage) {
  return {
    storage, open: read(storage, LAYOUT_KEY) !== "full", scope: null, collapsed: new Set(),
    width: clampWidth(read(storage, WIDTH_KEY)), narrow: false, peek: false, focusKey: ROOT, nodes: [],
  };
}

// 트리에 보일 계층 노드를 만든다. 표가 보이는 행(rows)에 속한 범위만 남기고 개수는 그 행 기준이다.
export function buildPaneNodes(state, rows, { grouping = "hierarchy", attention = () => false } = {}) {
  if (grouping === "type") {
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.resource.type) ?? { label: row.resource.typeLabel, rows: [] };
      group.rows.push(row);
      groups.set(row.resource.type, group);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([type, group]) => ({
      key: `type:${type}`, parent: null, kind: "리소스 종류", label: group.label, icon: "box",
      count: group.rows.length, attention: group.rows.filter(attention).length,
    }));
  }
  const members = new Map();
  for (const row of rows) {
    for (const scope of ancestors(state, row.resource.groupId)) members.set(scope.id, [...(members.get(scope.id) ?? []), row]);
  }
  const nodes = [];
  const visit = (parentId) => {
    for (const scope of state.scopes.filter((item) => item.parentId === parentId && members.has(item.id))) {
      const kind = SCOPE_KINDS[scope.kind] ?? { label: scope.kind, icon: "folder" };
      const inside = members.get(scope.id);
      nodes.push({ key: scope.id, parent: parentId, kind: kind.label, label: scope.name, icon: kind.icon,
        count: inside.length, attention: inside.filter(attention).length, title: `${kind.label} ${scope.name}` });
      visit(scope.id);
    }
  };
  visit(null);
  return nodes;
}

export function rowsInScope(state, rows, grouping, key) {
  if (key === null || key === undefined) return rows;
  if (grouping === "type") return rows.filter((row) => `type:${row.resource.type}` === key);
  return rows.filter((row) => ancestors(state, row.resource.groupId).some((scope) => scope.id === key));
}

export function treePath(nodes, key) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const path = [];
  for (let node = key === null ? undefined : byKey.get(key); node; node = node.parent === null ? undefined : byKey.get(node.parent)) path.unshift(node);
  return path;
}

export function paneRows(nodes, collapsed) {
  const children = new Map();
  for (const node of nodes) children.set(node.parent ?? ROOT, [...(children.get(node.parent ?? ROOT) ?? []), node]);
  const list = [{ node: null, level: 1, expandable: false }];
  const walk = (parent, level) => {
    for (const node of children.get(parent) ?? []) {
      const kids = children.get(node.key) ?? [];
      list.push({ node, level, expandable: kids.length > 0 });
      if (kids.length && !collapsed.has(node.key)) walk(node.key, level + 1);
    }
  };
  walk(ROOT, 2);
  return list;
}

const isOpen = (pane) => (pane.narrow ? pane.peek : pane.open);

export function treePaneHtml({ nodes, pane, rootCount, rootAttention = 0, rootLabel = "전체", label = "리소스 계층" }, { esc, icon }) {
  const open = isOpen(pane);
  const path = treePath(nodes, pane.scope);
  const railLabel = path.length ? path.map((node) => node.label).join(" › ") : rootLabel;
  const rows = paneRows(nodes, pane.collapsed);
  if (!rows.some((row) => (row.node?.key ?? ROOT) === pane.focusKey)) pane.focusKey = pane.scope ?? ROOT;
  const selectedKey = pane.scope ?? ROOT;
  const toggleName = open ? `${label} 접기` : `${label} 펼치기`;
  const rail = `<div class="tree-pane-rail"><button type="button" class="tree-pane-toggle" data-pane-action="toggle" aria-expanded="${open}" ${open ? 'aria-controls="tree-pane-panel"' : ""} aria-label="${toggleName}" title="${open ? toggleName : `${toggleName} · 현재 ${esc(railLabel)}`}">${icon(open ? "panel-close" : "panel-open")}</button>${open ? "" : `<span class="tree-pane-rail-label" aria-hidden="true">${esc(railLabel)}</span>`}</div>`;
  if (!open) return rail;
  const items = rows.map(({ node, level, expandable }) => {
    const key = node?.key ?? ROOT;
    const collapsed = node ? pane.collapsed.has(node.key) : false;
    const attention = node?.attention ?? rootAttention;
    const count = node?.count ?? rootCount;
    return `<div role="treeitem" class="tree-pane-item" data-pane-key="${esc(key)}" data-level="${Math.min(level, 6)}" aria-level="${level}" aria-selected="${selectedKey === key}" ${expandable ? `aria-expanded="${!collapsed}"` : ""} tabindex="${pane.focusKey === key ? 0 : -1}" ${node ? `title="${esc(node.title ?? `${node.kind} ${node.label}`)}"` : ""}>`
      + `<span class="tree-pane-twisty" ${expandable ? "data-pane-twisty" : ""}>${expandable ? `<span class="tree-pane-chevron ${collapsed ? "" : "open"}">${icon("chevron")}</span>` : ""}</span>`
      + `${node?.icon ? `<span class="tree-pane-icon">${icon(node.icon)}</span>` : ""}`
      + `<span class="tree-pane-label"><strong>${esc(node?.label ?? rootLabel)}</strong>${node ? `<small>${esc(node.kind)}</small>` : ""}</span>`
      + `<span class="tree-pane-meta">${attention > 0 ? `<em class="tree-pane-attention" title="백업 문제" aria-label="백업 문제 ${attention}개">${attention}</em>` : ""}<span class="tree-pane-count" aria-label="리소스 ${count}개">${count}</span></span></div>`;
  }).join("");
  return `${rail}<div class="tree-pane-panel" id="tree-pane-panel">`
    + `<div class="tree-pane-head"><strong>${esc(label)}</strong>${pane.narrow ? '<button type="button" class="tree-pane-compact" data-pane-action="compact">제목 행 보기</button>' : ""}<button type="button" class="tree-pane-close" data-pane-action="toggle" aria-label="${toggleName}" title="${toggleName}">${icon("panel-close")}</button></div>`
    + `<div class="tree-pane-tree" role="tree" aria-label="${esc(label)}" aria-orientation="vertical">${items}</div>`
    + `${pane.narrow ? "" : `<div class="tree-pane-resizer" data-pane-resizer role="separator" tabindex="0" aria-orientation="vertical" aria-label="${esc(label)} 너비 조절" aria-valuemin="${MIN_WIDTH}" aria-valuemax="${MAX_WIDTH}" aria-valuenow="${pane.width}"></div>`}</div>`;
}

// 선택한 범위를 표 위에 다시 보여 주어, 트리를 접어도 맥락이 남게 한다.
export function scopeBarHtml({ nodes, scope, count }, { esc, icon }) {
  const path = treePath(nodes, scope);
  if (!path.length) return "";
  return `<div class="tree-scope-bar" role="status" aria-label="선택한 계층 범위"><ol>${path.map((node, index) => `<li ${index === path.length - 1 ? 'aria-current="true"' : ""}><span>${esc(node.kind)}</span> <strong>${esc(node.label)}</strong></li>`).join("")}</ol>`
    + `<span class="tree-scope-count">${count}개</span>`
    + `<button type="button" class="tree-scope-clear" data-pane-action="clear" aria-label="계층 범위 해제 · 전체 보기">${icon("close")}<span>전체</span></button></div>`;
}

export function renderTreePane(slot, model, helpers) {
  const scroll = slot.querySelector(".tree-pane-tree")?.scrollTop ?? 0;
  slot.innerHTML = treePaneHtml(model, helpers);
  const tree = slot.querySelector(".tree-pane-tree");
  if (tree) tree.scrollTop = scroll;
  slot.toggleAttribute("data-open", isOpen(model.pane));
  slot.toggleAttribute("data-narrow", model.pane.narrow);
  slot.style.setProperty("--tree-pane-width", `${model.pane.width}px`);
}

// 상호작용은 #main 하나에 위임한다. 트리를 다시 그려도 리스너는 그대로이고, 상태는 ui.pane에 있다.
export function bindTreePane(root, ui, rerender) {
  const items = () => [...root.querySelectorAll("[data-pane-key]")];
  const itemFor = (key) => items().find((item) => item.dataset.paneKey === key);
  function focusItem(key) {
    ui.pane.focusKey = key;
    for (const item of items()) item.tabIndex = item.dataset.paneKey === key ? 0 : -1;
    itemFor(key)?.focus({ preventScroll: true });
    itemFor(key)?.scrollIntoView({ block: "nearest" });
  }
  function choose(key) {
    const pane = ui.pane;
    pane.scope = key === ROOT ? null : key;
    pane.focusKey = key;
    if (pane.narrow) {
      pane.peek = false;
      if (!pane.open) { pane.open = true; write(pane.storage, LAYOUT_KEY, "tree"); }
    }
    rerender();
    focusItem(key);
  }
  function toggleOpen() {
    const pane = ui.pane;
    if (pane.narrow) {
      pane.peek = !pane.peek;
      rerender();
      if (pane.peek) focusItem(pane.focusKey);
      else root.querySelector(".tree-pane-toggle")?.focus();
      return;
    }
    pane.open = !pane.open;
    write(pane.storage, LAYOUT_KEY, pane.open ? "tree" : "full");
    // 접으면 모든 계층을 제목 행으로 보이므로 트리 범위는 해제한다.
    if (!pane.open) pane.scope = null;
    rerender();
    root.querySelector(pane.open ? ".tree-pane-close" : ".tree-pane-toggle")?.focus();
  }
  function setWidth(width, persist) {
    ui.pane.width = clampWidth(width);
    const aside = root.querySelector(".tree-pane");
    aside?.style.setProperty("--tree-pane-width", `${ui.pane.width}px`);
    root.querySelector("[data-pane-resizer]")?.setAttribute("aria-valuenow", String(ui.pane.width));
    if (persist) write(ui.pane.storage, WIDTH_KEY, String(ui.pane.width));
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!target.closest) return;
    const action = target.closest("[data-pane-action]");
    if (action) {
      const name = action.dataset.paneAction;
      if (name === "toggle") toggleOpen();
      else if (name === "clear") { ui.pane.scope = null; rerender(); focusItem(ROOT); }
      else if (name === "compact") {
        ui.pane.peek = false; ui.pane.open = false; ui.pane.scope = null;
        write(ui.pane.storage, LAYOUT_KEY, "full");
        rerender();
        root.querySelector(".tree-pane-toggle")?.focus();
      }
      return;
    }
    const item = target.closest("[data-pane-key]");
    if (!item) return;
    const key = item.dataset.paneKey;
    if (target.closest("[data-pane-twisty]")) {
      if (ui.pane.collapsed.has(key)) ui.pane.collapsed.delete(key); else ui.pane.collapsed.add(key);
      ui.pane.focusKey = key;
      rerender();
      focusItem(key);
      return;
    }
    choose(key);
  });

  root.addEventListener("keydown", (event) => {
    const pane = ui.pane;
    if (event.key === "Escape" && pane.narrow && pane.peek && event.target.closest?.(".tree-pane")) {
      event.preventDefault();
      pane.peek = false;
      rerender();
      root.querySelector(".tree-pane-toggle")?.focus();
      return;
    }
    if (event.target.closest?.("[data-pane-resizer]")) {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      setWidth(pane.width + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 32 : 8), true);
      return;
    }
    const element = event.target.closest?.("[data-pane-key]");
    if (!element || event.target !== element) return;
    const rows = paneRows(pane.nodes, pane.collapsed);
    const keyOf = (row) => row.node?.key ?? ROOT;
    const index = Math.max(0, rows.findIndex((row) => keyOf(row) === element.dataset.paneKey));
    const current = rows[index];
    let next;
    if (event.key === "ArrowDown") next = keyOf(rows[Math.min(rows.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") next = keyOf(rows[Math.max(0, index - 1)]);
    else if (event.key === "Home") next = ROOT;
    else if (event.key === "End") next = keyOf(rows.at(-1));
    else if (event.key === "ArrowRight" && current.expandable) {
      if (pane.collapsed.has(current.node.key)) { pane.collapsed.delete(current.node.key); event.preventDefault(); rerender(); focusItem(current.node.key); return; }
      next = keyOf(rows[index + 1]);
    } else if (event.key === "ArrowLeft" && current.node) {
      if (current.expandable && !pane.collapsed.has(current.node.key)) { pane.collapsed.add(current.node.key); event.preventDefault(); rerender(); focusItem(current.node.key); return; }
      next = current.node.parent ?? ROOT;
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(keyOf(current)); return; }
    else return;
    event.preventDefault();
    focusItem(next);
  });

  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest?.("[data-pane-resizer]");
    if (!handle) return;
    event.preventDefault();
    const origin = event.clientX, start = ui.pane.width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("tree-pane-dragging");
    const move = (next) => setWidth(start + next.clientX - origin, false);
    const stop = (next) => {
      document.body.classList.remove("tree-pane-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setWidth(start + next.clientX - origin, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
  root.addEventListener("dblclick", (event) => {
    if (event.target.closest?.("[data-pane-resizer]")) setWidth(DEFAULT_WIDTH, true);
  });
}

// 표 영역을 붙인다. 계층 제목 고정과 좁은 화면 판정을 맡고, 정리 함수를 돌려준다.
export function mountTreeArea(area, scroll, ui, rerender) {
  const narrow = () => area.clientWidth < NARROW_BELOW;
  ui.pane.narrow = narrow();
  if (!ui.pane.narrow) ui.pane.peek = false;
  const unfreeze = freezeTreeGrid(scroll);
  const observer = new ResizeObserver(() => {
    if (narrow() === ui.pane.narrow) return;
    ui.pane.narrow = narrow();
    ui.pane.peek = false;
    rerender();
  });
  observer.observe(area);
  return () => { observer.disconnect(); unfreeze(); };
}
