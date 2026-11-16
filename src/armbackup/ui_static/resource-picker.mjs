const key = (value) => String(value ?? "").toLowerCase();
const resourceOf = (entry) => entry?.resource ?? entry;
const customerOf = (resource) => resource?.tags?.customer || "";

const SCOPE_META = {
  managementGroup: { label: "관리 그룹", icon: "layers" },
  subscription: { label: "구독", icon: "cloud" },
  resourceGroup: { label: "리소스 그룹", icon: "folder" },
};

function scopeChain(state, groupId) {
  const scopes = state?.scopes || [];
  const byId = new Map(scopes.map((scope) => [key(scope.id), scope]));
  const chain = [];
  const seen = new Set();
  let current = groupId ? byId.get(key(groupId)) : null;
  while (current && !seen.has(key(current.id))) {
    seen.add(key(current.id));
    chain.unshift(current);
    current = current.parentId ? byId.get(key(current.parentId)) : null;
  }
  return chain;
}

function parseArmSegments(resourceId) {
  const match = /^\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\//i.exec(String(resourceId || ""));
  return match ? { subscriptionId: match[1], resourceGroup: match[2] } : { subscriptionId: "", resourceGroup: "" };
}

export function resourceHierarchy(state, resource) {
  const parsed = parseArmSegments(resource?.id);
  const fallbackGroupId = resource?.groupId || (parsed.subscriptionId && parsed.resourceGroup
    ? `/subscriptions/${parsed.subscriptionId}/resourcegroups/${parsed.resourceGroup}` : "");
  const chain = scopeChain(state, fallbackGroupId);
  const managementGroups = chain.filter((scope) => scope.kind === "managementGroup").map((scope) => scope.name);
  const subScope = chain.find((scope) => scope.kind === "subscription")
    || (state?.scopes || []).find((scope) => scope.kind === "subscription"
      && parsed.subscriptionId && key(scope.subscriptionId || scope.detail) === key(parsed.subscriptionId));
  const rgScope = chain.find((scope) => scope.kind === "resourceGroup");
  const workspaceSubMatches = parsed.subscriptionId
    && key(state?.workspace?.subscription) === key(parsed.subscriptionId);
  const subscription = subScope?.name
    || (workspaceSubMatches ? state?.workspace?.subscriptionName : "")
    || parsed.subscriptionId
    || "미확인";
  const resourceGroup = rgScope?.name || parsed.resourceGroup || "미확인";
  return {
    chain,
    managementGroups,
    managementGroup: managementGroups.at(-1) || "",
    managementGroupPath: managementGroups.join(" › "),
    subscription,
    subscriptionDetail: subScope?.subscriptionId || subScope?.detail || parsed.subscriptionId || "",
    resourceGroup,
  };
}

export function buildPickerNodes(state, items) {
  const scopes = state?.scopes || [];
  if (!scopes.length) return [];
  const members = new Map();
  for (const entry of items) {
    const resource = resourceOf(entry);
    const { chain } = resourceHierarchy(state, resource);
    for (const scope of chain) {
      const id = key(scope.id);
      const list = members.get(id) || [];
      list.push(entry);
      members.set(id, list);
    }
  }
  const byParent = new Map();
  for (const scope of scopes) {
    if (!members.has(key(scope.id))) continue;
    const parentKey = scope.parentId && members.has(key(scope.parentId)) ? key(scope.parentId) : "";
    const siblings = byParent.get(parentKey) || [];
    siblings.push(scope);
    byParent.set(parentKey, siblings);
  }
  const nodes = [];
  const visit = (parentKey) => {
    for (const scope of byParent.get(parentKey) || []) {
      const meta = SCOPE_META[scope.kind] || { label: scope.kind, icon: "folder" };
      const id = key(scope.id);
      nodes.push({
        key: id,
        scopeId: scope.id,
        parent: parentKey || null,
        kind: scope.kind,
        kindLabel: meta.label,
        label: scope.name,
        icon: meta.icon,
        count: (members.get(id) || []).length,
      });
      visit(id);
    }
  };
  visit("");
  return nodes;
}

export function pickerTreeRows(nodes, collapsed = new Set()) {
  const children = new Map();
  for (const node of nodes) {
    const parent = node.parent ?? "";
    const list = children.get(parent) || [];
    list.push(node);
    children.set(parent, list);
  }
  const rows = [{ node: null, level: 1, expandable: false }];
  const walk = (parent, level) => {
    for (const node of children.get(parent) || []) {
      const kids = children.get(node.key) || [];
      rows.push({ node, level, expandable: kids.length > 0 });
      if (kids.length && !collapsed.has(node.key)) walk(node.key, level + 1);
    }
  };
  walk("", 2);
  return rows;
}

export function pickerScopeTrail(nodes, scopeKey) {
  if (!scopeKey) return [];
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const trail = [];
  for (let current = byKey.get(key(scopeKey)); current; current = current.parent ? byKey.get(current.parent) : null) {
    trail.unshift(current);
  }
  return trail;
}

export function filterPickerItems(state, items, { scopeKey = "", query = "" } = {}) {
  const normalizedScope = key(scopeKey);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  return items.filter((entry) => {
    const resource = resourceOf(entry);
    const hierarchy = resourceHierarchy(state, resource);
    if (normalizedScope && !hierarchy.chain.some((scope) => key(scope.id) === normalizedScope)) {
      return false;
    }
    if (!normalizedQuery) return true;
    const tagValues = Object.entries(resource?.tags || {}).flatMap(([k, v]) => [k, v]).join(" ");
    const searchable = [
      resource.name,
      resource.typeLabel,
      resource.type,
      resource.id,
      hierarchy.managementGroupPath,
      hierarchy.subscription,
      hierarchy.resourceGroup,
      customerOf(resource),
      tagValues,
    ].join(" ").toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

export function resourcePickerListHtml({ state, items, nodes = [], selectedId = "", scopeKey = "", query = "", emptyMessage = "", renderMeta = null }, helpers) {
  const { esc, icon, symbol } = helpers;
  if (!items.length) {
    return `<div class="picker-empty">${esc(emptyMessage || "선택할 수 있는 리소스가 없습니다.")}</div>`;
  }
  const shown = filterPickerItems(state, items, { scopeKey, query });
  const trail = pickerScopeTrail(nodes, scopeKey);
  const scopeStrip = trail.length
    ? `<div class="picker-scope-bar" role="status" aria-label="선택한 계층 범위"><ol>${trail.map((node, idx) => `<li ${idx === trail.length - 1 ? 'aria-current="true"' : ""}><span>${esc(node.kindLabel)}</span><strong>${esc(node.label)}</strong></li>`).join("")}</ol><span class="picker-scope-count">${shown.length}개</span><button type="button" class="tree-scope-clear" data-picker-action="clear-scope">${icon("close")}<span>전체</span></button></div>`
    : "";
  if (!shown.length) {
    return `${scopeStrip}<div class="picker-empty">검색어 또는 선택한 계층 범위에 일치하는 리소스가 없습니다.</div>`;
  }
  const activeKey = key(selectedId);
  const listHtml = shown.map((entry) => {
    const resource = resourceOf(entry);
    const hierarchy = resourceHierarchy(state, resource);
    const chosen = Boolean(activeKey) && key(resource.id) === activeKey;
    const customer = customerOf(resource);
    const scopeSummary = [
      ...(hierarchy.managementGroup ? [hierarchy.managementGroup] : []),
      hierarchy.subscription,
      hierarchy.resourceGroup,
    ].join(" › ");
    const visual = typeof symbol === "function" ? symbol(resource) : `<span class="resource-symbol network">${icon("network")}</span>`;
    const metaHtml = typeof renderMeta === "function" ? renderMeta(entry, resource) : "";
    return `<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-picker-select="${esc(resource.id)}" aria-current="${chosen ? "true" : "false"}" title="${esc(resource.id)}">${visual}<span class="picker-item-main"><span class="picker-item-head"><strong>${esc(resource.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}</span><small class="picker-item-type">${esc(resource.typeLabel || resource.type)}${customer ? ` · ${esc(customer)}` : ""}</small><small class="picker-item-scope">${esc(scopeSummary)}</small></span>${metaHtml ? `<span class="picker-item-meta">${metaHtml}</span>` : ""}</button>`;
  }).join("");
  return `${scopeStrip}<div class="picker-items" role="group" aria-label="리소스 목록">${listHtml}</div>`;
}

export function resourcePickerTreeHtml({ nodes, totalCount, scopeKey = "", collapsed = new Set(), focusKey = "" }, { esc, icon }) {
  const rows = pickerTreeRows(nodes, collapsed);
  const selectedKey = key(scopeKey);
  const currentFocus = rows.some((row) => (row.node?.key ?? "") === focusKey) ? focusKey : selectedKey;
  return rows.map(({ node, level, expandable }) => {
    const rowKey = node?.key ?? "";
    const isCollapsed = node ? collapsed.has(node.key) : false;
    const count = node ? node.count : totalCount;
    return `<div role="treeitem" class="tree-pane-item" data-picker-scope="${esc(rowKey)}" data-level="${Math.min(level, 6)}" aria-level="${level}" aria-selected="${selectedKey === rowKey}" ${expandable ? `aria-expanded="${!isCollapsed}"` : ""} tabindex="${currentFocus === rowKey ? 0 : -1}" ${node ? `title="${esc(`${node.kindLabel} · ${node.label}`)}"` : ""}>`
      + `<span class="tree-pane-twisty" ${expandable ? "data-picker-twisty" : ""}>${expandable ? `<span class="tree-pane-chevron ${isCollapsed ? "" : "open"}">${icon("chevron")}</span>` : ""}</span>`
      + `${node?.icon ? `<span class="tree-pane-icon">${icon(node.icon)}</span>` : ""}`
      + `<span class="tree-pane-label"><strong>${esc(node ? node.label : "전체 계층")}</strong>${node ? `<small>${esc(node.kindLabel)}</small>` : ""}</span>`
      + `<span class="tree-pane-meta"><span class="tree-pane-count" aria-label="리소스 ${count}개">${count}</span></span></div>`;
  }).join("");
}

export function resourcePickerModalHtml(options, helpers) {
  const { state, items, selectedId = "", scopeKey = "", collapsed = new Set(), focusKey = "", query = "", emptyMessage = "", renderMeta = null } = options;
  const { esc, icon } = helpers;
  const nodes = buildPickerNodes(state, items);
  const shownCount = filterPickerItems(state, items, { scopeKey, query }).length;
  return `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="리소스 검색" placeholder="리소스 · 종류 · 관리 그룹 · 구독 · 리소스 그룹 · 태그 검색" value="${esc(query)}" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${shownCount} / ${items.length}개</span>
    </div>
    <div class="picker-body ${nodes.length ? "" : "picker-body-flat"}">
      ${nodes.length ? `<aside class="picker-tree-pane" aria-label="관리 그룹 · 구독 · 리소스 그룹 계층"><div class="picker-pane-head">관리 그룹 · 구독 · 리소스 그룹</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="리소스 계층" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes, totalCount: items.length, scopeKey, collapsed, focusKey }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${resourcePickerListHtml({ state, items, nodes, selectedId, scopeKey, query, emptyMessage, renderMeta }, helpers)}</div>
    </div>
  </div>`;
}

export function openResourcePicker({
  dialogElement,
  openDialog,
  closeDialog,
  state,
  items,
  selectedId = "",
  title = "리소스 선택",
  emptyMessage = "선택할 수 있는 리소스가 없습니다.",
  renderMeta = null,
  onSelect,
  helpers,
}) {
  const nodes = buildPickerNodes(state, items);
  const model = { scopeKey: "", query: "", collapsed: new Set(), focusKey: "" };
  const bodyHtml = resourcePickerModalHtml({ state, items, selectedId, ...model, emptyMessage, renderMeta }, helpers);
  const actionsHtml = '<button class="button" type="button" data-picker-action="cancel">취소</button>';

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, actionsHtml);

  const controller = new AbortController();
  const cleanup = () => {
    controller.abort();
    delete dialogElement.dataset.modalKind;
  };
  dialogElement.addEventListener("close", cleanup, { once: true });

  const updateResults = () => {
    const count = filterPickerItems(state, items, { scopeKey: model.scopeKey, query: model.query }).length;
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${count} / ${items.length}개`;
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) {
      const scroll = treeEl.scrollTop;
      treeEl.innerHTML = resourcePickerTreeHtml({ nodes, totalCount: items.length, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey }, helpers);
      treeEl.scrollTop = scroll;
    }
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) {
      resultsEl.innerHTML = resourcePickerListHtml({ state, items, nodes, selectedId, scopeKey: model.scopeKey, query: model.query, emptyMessage, renderMeta }, helpers);
    }
  };

  const treeItems = () => [...dialogElement.querySelectorAll("[data-picker-scope]")];
  const focusTreeItem = (targetKey) => {
    model.focusKey = targetKey;
    for (const el of treeItems()) el.tabIndex = el.dataset.pickerScope === targetKey ? 0 : -1;
    const target = treeItems().find((el) => el.dataset.pickerScope === targetKey);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  };

  dialogElement.addEventListener("input", (event) => {
    if (event.target.id !== "resource-picker-query") return;
    model.query = event.target.value;
    updateResults();
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.pickerAction;
      if (action === "cancel") {
        closeDialog();
      } else if (action === "clear-scope") {
        model.scopeKey = "";
        model.focusKey = "";
        updateResults();
        dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
      }
      return;
    }
    const scopeItem = event.target.closest("[data-picker-scope]");
    if (scopeItem) {
      const scopeKey = scopeItem.dataset.pickerScope;
      if (event.target.closest("[data-picker-twisty]")) {
        if (model.collapsed.has(scopeKey)) model.collapsed.delete(scopeKey);
        else model.collapsed.add(scopeKey);
        model.focusKey = scopeKey;
        updateResults();
        focusTreeItem(scopeKey);
        return;
      }
      model.scopeKey = scopeKey;
      model.focusKey = scopeKey;
      updateResults();
      focusTreeItem(scopeKey);
      return;
    }
    const picked = event.target.closest("[data-picker-select]");
    if (picked) {
      const chosenId = picked.dataset.pickerSelect;
      closeDialog();
      onSelect(chosenId);
    }
  }, { signal: controller.signal });

  dialogElement.addEventListener("keydown", (event) => {
    const scopeItem = event.target.closest?.("[data-picker-scope]");
    if (scopeItem) {
      const all = treeItems();
      const idx = all.indexOf(scopeItem);
      if (idx === -1) return;
      const rowKey = scopeItem.dataset.pickerScope;
      const expanded = scopeItem.getAttribute("aria-expanded");
      if (event.key === "ArrowDown") { event.preventDefault(); focusTreeItem(all[Math.min(idx + 1, all.length - 1)].dataset.pickerScope); }
      else if (event.key === "ArrowUp") { event.preventDefault(); focusTreeItem(all[Math.max(idx - 1, 0)].dataset.pickerScope); }
      else if (event.key === "Home") { event.preventDefault(); focusTreeItem(all[0].dataset.pickerScope); }
      else if (event.key === "End") { event.preventDefault(); focusTreeItem(all.at(-1).dataset.pickerScope); }
      else if (event.key === "ArrowRight" && expanded !== null) {
        event.preventDefault();
        if (expanded === "false") { model.collapsed.delete(rowKey); updateResults(); focusTreeItem(rowKey); }
        else if (all[idx + 1]) focusTreeItem(all[idx + 1].dataset.pickerScope);
      } else if (event.key === "ArrowLeft" && rowKey) {
        event.preventDefault();
        if (expanded === "true") { model.collapsed.add(rowKey); updateResults(); focusTreeItem(rowKey); }
        else {
          const parent = nodes.find((node) => node.key === rowKey)?.parent ?? "";
          focusTreeItem(parent);
        }
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        model.scopeKey = rowKey;
        model.focusKey = rowKey;
        updateResults();
        focusTreeItem(rowKey);
      }
      return;
    }
    const option = event.target.closest?.("[data-picker-select]");
    if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const options = [...dialogElement.querySelectorAll("[data-picker-select]")];
      const idx = options.indexOf(option);
      if (idx === -1) return;
      event.preventDefault();
      const next = options[event.key === "ArrowDown" ? Math.min(idx + 1, options.length - 1) : Math.max(idx - 1, 0)];
      next?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest" });
    }
  }, { signal: controller.signal });

  const searchInput = dialogElement.querySelector("#resource-picker-query");
  searchInput?.focus({ preventScroll: true });
}
