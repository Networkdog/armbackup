const key = (value) => String(value ?? "").toLowerCase();
const resourceOf = (entry) => entry?.resource ?? entry;
const customerOf = (resource) => resource?.tags?.customer || "";

const SCOPE_META = {
  managementGroup: { label: "관리 그룹", icon: "layers" },
  subscription: { label: "구독", icon: "cloud" },
  resourceGroup: { label: "리소스 그룹", icon: "folder" },
  virtualNetwork: { label: "가상 네트워크", icon: "network" },
  subnet: { label: "서브넷", icon: "network" },
};

function restoreTriggerFocus(dialogElement, returnFocusSelector) {
  if (!returnFocusSelector || !dialogElement?.ownerDocument) return;
  const doc = dialogElement.ownerDocument;
  const focusNow = () => {
    if (dialogElement.open) return;
    doc.querySelector(returnFocusSelector)?.focus({ preventScroll: true });
  };
  focusNow();
  setTimeout(focusNow, 0);
}

function bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector) {
  let closed = false;
  const finish = (afterClose = null) => {
    if (closed) return;
    closed = true;
    controller.abort();
    delete dialogElement.dataset.modalKind;
    closeDialog();
    if (typeof afterClose === "function") afterClose();
    restoreTriggerFocus(dialogElement, returnFocusSelector);
  };
  dialogElement.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    controller.abort();
    delete dialogElement.dataset.modalKind;
    restoreTriggerFocus(dialogElement, returnFocusSelector);
  }, { once: true });
  dialogElement.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }, { signal: controller.signal });
  return finish;
}

export function pickerTriggerHtml({
  label = "",
  ariaLabel = "",
  segments = [],
  emptyTitle = "",
  emptyHint = "",
  metaHtml = "",
  buttonLabel = "선택 변경",
  actionAttr = "",
  disabled = false,
  attention = false,
}, { esc, icon }) {
  const regionLabel = ariaLabel || label || buttonLabel;
  const contentHtml = segments.length
    ? `<ol class="restore-hierarchy picker-summary-trail" aria-label="${esc(regionLabel)}">${segments.map((seg) => `<li ${seg.title ? `title="${esc(seg.title)}"` : ""}>${seg.icon ? `<span class="picker-seg-icon">${icon(seg.icon)}</span>` : ""}${seg.kind ? `<span class="hierarchy-kind">${esc(seg.kind)}</span>` : ""}<strong>${esc(seg.value)}</strong>${seg.sub ? `<span class="hierarchy-type">${esc(seg.sub)}</span>` : ""}</li>`).join("")}</ol>`
    : `<div class="restore-context-empty">${icon(attention ? "alert" : "layers")}<strong>${esc(emptyTitle || "선택된 항목이 없습니다")}</strong>${emptyHint ? `<span>${esc(emptyHint)}</span>` : ""}</div>`;
  return `<div class="picker-trigger-bar ${attention ? "attention" : ""}" role="group" aria-label="${esc(regionLabel)}">
    ${label ? `<span class="picker-trigger-label">${esc(label)}</span>` : ""}
    ${contentHtml}
    <div class="restore-context-side">
      ${metaHtml ? `<div class="picker-trigger-meta">${metaHtml}</div>` : ""}
      <button class="button ${attention ? "primary" : ""} small" type="button" ${actionAttr} ${disabled ? "disabled" : ""}>${esc(buttonLabel)}</button>
    </div>
  </div>`;
}

function scopeChain(state, groupId) {
  const scopes = state?.scopes || [];
  const byId = new Map();
  for (const scope of scopes) {
    if (!byId.has(key(scope.id))) byId.set(key(scope.id), scope);
  }
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
  const seenScopes = new Set();
  for (const scope of scopes) {
    const scopeId = key(scope.id);
    if (!members.has(scopeId) || seenScopes.has(scopeId)) continue;
    seenScopes.add(scopeId);
    const rawParent = scope.parentId ? key(scope.parentId) : "";
    const parentKey = rawParent && rawParent !== scopeId && members.has(rawParent) ? rawParent : "";
    const siblings = byParent.get(parentKey) || [];
    siblings.push(scope);
    byParent.set(parentKey, siblings);
  }
  const nodes = [];
  const visited = new Set();
  const visit = (parentKey) => {
    for (const scope of byParent.get(parentKey) || []) {
      const id = key(scope.id);
      if (visited.has(id)) continue;
      visited.add(id);
      const meta = SCOPE_META[scope.kind] || { label: scope.kind, icon: "folder" };
      nodes.push({
        key: id,
        scopeId: scope.id,
        parent: parentKey || null,
        kind: scope.kind,
        kindLabel: meta.label,
        icon: meta.icon,
        label: scope.name,
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

export function filterPickerItems(state, items, { scopeKey = "", query = "", typeFilter = "" } = {}) {
  const normalizedScope = key(scopeKey);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const normalizedType = key(typeFilter);
  return items.filter((entry) => {
    const resource = resourceOf(entry);
    if (normalizedType && key(resource.type) !== normalizedType) {
      return false;
    }
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

export function resourcePickerListHtml(
  {
    state, items, nodes = [], selectedId = "", selectedIds = null, multiple = false,
    disabledInfo = null, scopeKey = "", query = "", typeFilter = "", emptyMessage = "", renderMeta = null,
  },
  helpers,
) {
  const { esc, icon, symbol } = helpers;
  if (!items.length) {
    return `<div class="picker-empty">${esc(emptyMessage || "선택할 수 있는 리소스가 없습니다.")}</div>`;
  }
  const shown = filterPickerItems(state, items, { scopeKey, query, typeFilter });
  const trail = pickerScopeTrail(nodes, scopeKey);
  const scopeStrip = trail.length
    ? `<div class="picker-scope-bar" role="status" aria-label="선택한 계층 범위"><ol>${trail.map((node, idx) => `<li ${idx === trail.length - 1 ? 'aria-current="true"' : ""}><span>${esc(node.kindLabel)}</span><strong>${esc(node.label)}</strong></li>`).join("")}</ol><span class="picker-scope-count">${shown.length}개</span><button type="button" class="tree-scope-clear" data-picker-action="clear-scope">${icon("close")}<span>전체</span></button></div>`
    : "";
  if (!shown.length) {
    return `${scopeStrip}<div class="picker-empty"><p>검색어 또는 선택한 필터에 일치하는 리소스가 없습니다.</p><button type="button" class="button small" data-picker-action="reset-filters">검색·필터 초기화</button></div>`;
  }
  const activeSet = multiple
    ? new Set((selectedIds || []).map(key))
    : new Set(selectedId ? [key(selectedId)] : []);
  const listHtml = shown.map((entry) => {
    const resource = resourceOf(entry);
    const rKey = key(resource.id);
    const hierarchy = resourceHierarchy(state, resource);
    const lockInfo = typeof disabledInfo === "function" ? disabledInfo(entry, resource) : null;
    const isLocked = Boolean(lockInfo?.disabled);
    const chosen = Boolean(lockInfo?.checked) || activeSet.has(rKey);
    const customer = customerOf(resource);
    const scopeSummary = [
      ...(hierarchy.managementGroup ? [hierarchy.managementGroup] : []),
      hierarchy.subscription,
      hierarchy.resourceGroup,
    ].join(" › ");
    const visual = typeof symbol === "function" ? symbol(resource) : `<span class="resource-symbol network">${icon("network")}</span>`;
    const metaHtml = typeof renderMeta === "function" ? renderMeta(entry, resource) : "";
    if (multiple) {
      return `<label class="picker-item picker-check-item ${chosen ? "selected" : ""} ${isLocked ? "locked" : ""}" title="${esc(lockInfo?.reason || resource.id)}"><input type="checkbox" data-picker-check="${esc(resource.id)}" ${chosen ? "checked" : ""} ${isLocked ? "disabled" : ""}>${visual}<span class="picker-item-main"><span class="picker-item-head"><strong>${esc(resource.name)}</strong>${lockInfo?.badge ? `<span class="picker-current-badge">${esc(lockInfo.badge)}</span>` : ""}</span><small class="picker-item-type">${esc(resource.typeLabel || resource.type)}${customer ? ` · ${esc(customer)}` : ""}</small><small class="picker-item-scope">${esc(lockInfo?.reason || scopeSummary)}</small></span>${metaHtml ? `<span class="picker-item-meta">${metaHtml}</span>` : ""}</label>`;
    }
    return `<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-picker-select="${esc(resource.id)}" aria-current="${chosen ? "true" : "false"}" ${isLocked ? "disabled" : ""} title="${esc(lockInfo?.reason || resource.id)}">${visual}<span class="picker-item-main"><span class="picker-item-head"><strong>${esc(resource.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}</span><small class="picker-item-type">${esc(resource.typeLabel || resource.type)}${customer ? ` · ${esc(customer)}` : ""}</small><small class="picker-item-scope">${esc(scopeSummary)}</small></span>${metaHtml ? `<span class="picker-item-meta">${metaHtml}</span>` : ""}</button>`;
  }).join("");
  return `${scopeStrip}<div class="picker-items" role="group" aria-label="리소스 목록">${listHtml}</div>`;
}

export function resourcePickerTreeHtml({ nodes, totalCount, scopeKey = "", collapsed = new Set(), focusKey = "", rootLabel = "전체 계층" }, { esc, icon }) {
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
      + `<span class="tree-pane-label"><strong>${esc(node ? node.label : rootLabel)}</strong>${node ? `<small>${esc(node.kindLabel)}</small>` : ""}</span>`
      + `<span class="tree-pane-meta"><span class="tree-pane-count" aria-label="항목 ${count}개">${count}</span></span></div>`;
  }).join("");
}

function attachPickerKeyboard(dialogElement, { getNodes, getCollapsed, getFocusState, onSelectScope, onUpdate, optionSelector }, signal) {
  const treeItems = () => [...dialogElement.querySelectorAll("[data-picker-scope]")];
  const focusTreeItem = (targetKey) => {
    getFocusState().focusKey = targetKey;
    for (const el of treeItems()) el.tabIndex = el.dataset.pickerScope === targetKey ? 0 : -1;
    const target = treeItems().find((el) => el.dataset.pickerScope === targetKey);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  };
  dialogElement.addEventListener("keydown", (event) => {
    if (event.target.id === "resource-picker-query" && event.key === "ArrowDown") {
      const firstOption = dialogElement.querySelector(optionSelector);
      if (firstOption) {
        event.preventDefault();
        firstOption.focus({ preventScroll: true });
      }
      return;
    }
    const scopeItem = event.target.closest?.("[data-picker-scope]");
    if (scopeItem) {
      const all = treeItems();
      const idx = all.indexOf(scopeItem);
      if (idx === -1) return;
      const rowKey = scopeItem.dataset.pickerScope;
      const expanded = scopeItem.getAttribute("aria-expanded");
      const collapsed = getCollapsed();
      if (event.key === "ArrowDown") { event.preventDefault(); focusTreeItem(all[Math.min(idx + 1, all.length - 1)].dataset.pickerScope); }
      else if (event.key === "ArrowUp") { event.preventDefault(); focusTreeItem(all[Math.max(idx - 1, 0)].dataset.pickerScope); }
      else if (event.key === "Home") { event.preventDefault(); focusTreeItem(all[0].dataset.pickerScope); }
      else if (event.key === "End") { event.preventDefault(); focusTreeItem(all.at(-1).dataset.pickerScope); }
      else if (event.key === "ArrowRight" && expanded !== null) {
        event.preventDefault();
        if (expanded === "false") { collapsed.delete(rowKey); onUpdate(); focusTreeItem(rowKey); }
        else if (all[idx + 1]) focusTreeItem(all[idx + 1].dataset.pickerScope);
      } else if (event.key === "ArrowLeft" && rowKey) {
        event.preventDefault();
        if (expanded === "true") { collapsed.add(rowKey); onUpdate(); focusTreeItem(rowKey); }
        else {
          const parent = getNodes().find((node) => node.key === rowKey)?.parent ?? "";
          focusTreeItem(parent);
        }
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectScope(rowKey);
        focusTreeItem(rowKey);
      }
      return;
    }
    const option = event.target.closest?.(".picker-item");
    if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const options = [...dialogElement.querySelectorAll(optionSelector)];
      const currentCtrl = option.matches(optionSelector) ? option : option.querySelector(optionSelector);
      const idx = options.indexOf(currentCtrl);
      if (idx === -1) return;
      event.preventDefault();
      const next = options[event.key === "ArrowDown" ? Math.min(idx + 1, options.length - 1) : Math.max(idx - 1, 0)];
      next?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest" });
    }
  }, { signal });
}

function resourceTypeChipsHtml(items, typeFilter, esc) {
  const counts = new Map();
  const labels = new Map();
  for (const entry of items) {
    const r = resourceOf(entry);
    if (!r?.type) continue;
    const tKey = key(r.type);
    counts.set(tKey, (counts.get(tKey) || 0) + 1);
    if (!labels.has(tKey)) labels.set(tKey, r.typeLabel || r.type.split("/").at(-1) || r.type);
  }
  if (counts.size < 2) return "";
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return `<div class="picker-filter-chips" role="group" aria-label="리소스 종류 필터">
    <button type="button" class="picker-chip ${!typeFilter ? "active" : ""}" data-picker-type="" aria-pressed="${!typeFilter}">전체 <em>${items.length}</em></button>
    ${entries.map(([tKey, cnt]) => `<button type="button" class="picker-chip ${key(typeFilter) === tKey ? "active" : ""}" data-picker-type="${esc(tKey)}" aria-pressed="${key(typeFilter) === tKey}">${esc(labels.get(tKey))} <em>${cnt}</em></button>`).join("")}
  </div>`;
}

export function resourcePickerModalHtml(options, helpers) {
  const {
    state, items, selectedId = "", selectedIds = null, multiple = false, disabledInfo = null,
    scopeKey = "", collapsed = new Set(), focusKey = "", query = "", typeFilter = "",
    emptyMessage = "", renderMeta = null,
  } = options;
  const { esc, icon } = helpers;
  const nodes = buildPickerNodes(state, items);
  const shownCount = filterPickerItems(state, items, { scopeKey, query, typeFilter }).length;
  const chipsHtml = resourceTypeChipsHtml(items, typeFilter, esc);
  return `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="리소스 검색" placeholder="리소스 · 종류 · 관리 그룹 · 구독 · 리소스 그룹 · 태그 검색" value="${esc(query)}" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${shownCount} / ${items.length}개</span>
    </div>
    ${chipsHtml ? `<div class="picker-subtoolbar" id="resource-picker-chips">${chipsHtml}</div>` : ""}
    <div class="picker-body ${nodes.length ? "" : "picker-body-flat"}">
      ${nodes.length ? `<aside class="picker-tree-pane" aria-label="관리 그룹 · 구독 · 리소스 그룹 계층"><div class="picker-pane-head">관리 그룹 · 구독 · 리소스 그룹</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="리소스 계층" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes, totalCount: items.length, scopeKey, collapsed, focusKey }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${resourcePickerListHtml({ state, items, nodes, selectedId, selectedIds, multiple, disabledInfo, scopeKey, query, typeFilter, emptyMessage, renderMeta }, helpers)}</div>
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
  selectedIds = null,
  multiple = false,
  disabledInfo = null,
  title = "리소스 선택",
  emptyMessage = "선택할 수 있는 리소스가 없습니다.",
  renderMeta = null,
  returnFocusSelector = "",
  onSelect,
  helpers,
}) {
  const nodes = buildPickerNodes(state, items);
  const draftSelected = new Set((selectedIds || (selectedId ? [selectedId] : [])).map((id) => {
    const exact = items.map(resourceOf).find((r) => key(r.id) === key(id));
    return exact ? exact.id : id;
  }));
  const model = { scopeKey: "", query: "", typeFilter: "", collapsed: new Set(), focusKey: "" };
  const bodyHtml = resourcePickerModalHtml({
    state, items, selectedId, selectedIds: [...draftSelected], multiple, disabledInfo, ...model, emptyMessage, renderMeta,
  }, helpers);
  const renderActionsHtml = () => multiple
    ? `<span class="picker-footer-summary" role="status">선택된 리소스 <strong>${draftSelected.size}</strong>개</span><button class="button" type="button" data-picker-action="cancel">취소</button><button class="button primary" type="button" data-picker-action="apply" ${draftSelected.size ? "" : "disabled"}>선택 적용</button>`
    : '<span class="picker-footer-summary muted">계층을 탐색하거나 검색해 리소스를 선택하세요</span><button class="button" type="button" data-picker-action="cancel">취소</button>';

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, renderActionsHtml());

  const controller = new AbortController();
  const finishModal = bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector);

  const updateFooter = () => {
    const actionsEl = dialogElement.querySelector("#dialog-actions");
    if (actionsEl && multiple) actionsEl.innerHTML = renderActionsHtml();
  };

  const updateResults = () => {
    const count = filterPickerItems(state, items, { scopeKey: model.scopeKey, query: model.query, typeFilter: model.typeFilter }).length;
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${count} / ${items.length}개`;
    const chipsWrap = dialogElement.querySelector("#resource-picker-chips");
    if (chipsWrap) chipsWrap.innerHTML = resourceTypeChipsHtml(items, model.typeFilter, helpers.esc);
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) {
      const scroll = treeEl.scrollTop;
      treeEl.innerHTML = resourcePickerTreeHtml({ nodes, totalCount: items.length, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey }, helpers);
      treeEl.scrollTop = scroll;
    }
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) {
      resultsEl.innerHTML = resourcePickerListHtml({
        state, items, nodes, selectedId, selectedIds: [...draftSelected], multiple, disabledInfo,
        scopeKey: model.scopeKey, query: model.query, typeFilter: model.typeFilter, emptyMessage, renderMeta,
      }, helpers);
    }
    updateFooter();
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

  dialogElement.addEventListener("change", (event) => {
    const check = event.target.closest?.("[data-picker-check]");
    if (!check || check.disabled) return;
    const id = check.dataset.pickerCheck;
    for (const existing of [...draftSelected]) {
      if (key(existing) === key(id)) draftSelected.delete(existing);
    }
    if (check.checked) draftSelected.add(id);
    check.closest(".picker-item")?.classList.toggle("selected", check.checked);
    updateFooter();
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const typeBtn = event.target.closest("[data-picker-type]");
    if (typeBtn) {
      model.typeFilter = typeBtn.dataset.pickerType || "";
      updateResults();
      return;
    }
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.pickerAction;
      if (action === "cancel") {
        finishModal();
      } else if (action === "apply" && multiple && draftSelected.size) {
        const result = [...draftSelected];
        finishModal(() => onSelect(result));
      } else if (action === "clear-scope") {
        model.scopeKey = "";
        model.focusKey = "";
        updateResults();
        dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
      } else if (action === "reset-filters") {
        model.scopeKey = "";
        model.query = "";
        model.typeFilter = "";
        model.focusKey = "";
        const qInput = dialogElement.querySelector("#resource-picker-query");
        if (qInput) qInput.value = "";
        updateResults();
        qInput?.focus({ preventScroll: true });
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
    if (picked && !picked.disabled) {
      const chosenId = picked.dataset.pickerSelect;
      finishModal(() => onSelect(chosenId));
    }
  }, { signal: controller.signal });

  dialogElement.addEventListener("keydown", (event) => {
    if (event.target.id === "resource-picker-query" && event.key === "ArrowDown") {
      const firstOption = dialogElement.querySelector("[data-picker-select]:not([disabled]), [data-picker-check]:not([disabled])");
      if (firstOption) {
        event.preventDefault();
        firstOption.focus({ preventScroll: true });
      }
      return;
    }
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
    const option = event.target.closest?.("[data-picker-select], .picker-check-item");
    if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const options = [...dialogElement.querySelectorAll("[data-picker-select]:not([disabled]), [data-picker-check]:not([disabled])")];
      const currentCtrl = option.matches("[data-picker-select]") ? option : option.querySelector("[data-picker-check]");
      const idx = options.indexOf(currentCtrl);
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

function subscriptionAncestry(state, subscriptionId, subscriptionName = "") {
  const scopes = Array.isArray(state?.scopes) ? state.scopes : [];
  if (!scopes.length) return [];
  const byId = new Map(scopes.map((s) => [key(s.id), s]));
  const subLow = key(subscriptionId);
  const subMatch = scopes.find((s) => s.kind === "subscription" && (
    key(s.id) === subLow
    || key(s.id) === `/subscriptions/${subLow}`
    || key(s.detail || "").includes(subLow)
    || (subscriptionName && key(s.name) === key(subscriptionName))
  ));
  if (!subMatch) return [];
  const chain = [];
  const visited = new Set();
  let cur = subMatch.parentId ? byId.get(key(subMatch.parentId)) : null;
  while (cur && !visited.has(key(cur.id))) {
    visited.add(key(cur.id));
    if (cur.kind === "managementGroup") {
      chain.unshift({ id: cur.id, name: cur.name, kind: "managementGroup" });
    }
    cur = cur.parentId ? byId.get(key(cur.parentId)) : null;
  }
  return chain;
}

export function buildTargetHierarchyNodes(state, subscriptions = [], groupsBySub = {}) {
  const nodes = new Map();
  const childrenByParent = new Map();
  const linkChild = (parentKey, childKey) => {
    if (parentKey === childKey) return;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    const list = childrenByParent.get(parentKey);
    if (!list.includes(childKey)) list.push(childKey);
  };

  for (const sub of subscriptions) {
    const sid = sub.subscriptionId || sub.id || "";
    if (!sid) continue;
    const sKey = `sub:${key(sid)}`;
    const mgChain = subscriptionAncestry(state, sid, sub.name);
    const groupCount = Array.isArray(groupsBySub[sid])
      ? groupsBySub[sid].length
      : (Array.isArray(groupsBySub[key(sid)]) ? groupsBySub[key(sid)].length : null);
    let parentKey = "";
    let depth = 0;
    for (const mg of mgChain) {
      const mgKey = `mg:${key(mg.id)}`;
      if (!nodes.has(mgKey)) {
        nodes.set(mgKey, {
          key: mgKey,
          rawId: mg.id,
          parent: parentKey,
          depth,
          kind: "managementGroup",
          kindLabel: SCOPE_META.managementGroup.label,
          icon: SCOPE_META.managementGroup.icon,
          label: mg.name,
          count: 0,
          hasChildren: true,
        });
      }
      nodes.get(mgKey).count += groupCount ?? 1;
      linkChild(parentKey, mgKey);
      parentKey = mgKey;
      depth += 1;
    }
    nodes.set(sKey, {
      key: sKey,
      rawId: sid,
      parent: parentKey,
      depth,
      kind: "subscription",
      kindLabel: SCOPE_META.subscription.label,
      icon: SCOPE_META.subscription.icon,
      label: sub.name || sid,
      isCurrent: Boolean(sub.isCurrent),
      count: groupCount ?? "…",
      hasChildren: false,
    });
    linkChild(parentKey, sKey);
  }

  const ordered = [];
  const emitted = new Set();
  const walk = (parentKey) => {
    for (const childKey of childrenByParent.get(parentKey) || []) {
      if (emitted.has(childKey)) continue;
      emitted.add(childKey);
      const node = nodes.get(childKey);
      node.hasChildren = (childrenByParent.get(childKey) || []).length > 0;
      ordered.push(node);
      walk(childKey);
    }
  };
  walk("");
  return ordered;
}

export function targetLocationListHtml({
  state,
  subscriptions = [],
  currentSubscription = "",
  groupsBySub = {},
  loadingSubId = "",
  loadError = "",
  scopeKey = "",
  query = "",
  selectedSubscription = "",
  selectedGroup = "",
  keepSameOption = null,
}, helpers) {
  const { esc, icon } = helpers;
  const q = String(query || "").trim().toLowerCase();
  const subByKey = new Map();
  for (const sub of subscriptions) {
    const sid = sub.subscriptionId || sub.id || "";
    if (!sid) continue;
    subByKey.set(key(sid), {
      id: sid,
      name: sub.name || sid,
      isCurrent: Boolean(currentSubscription && key(sid) === key(currentSubscription)),
      mgChain: subscriptionAncestry(state, sid, sub.name),
    });
  }

  let activeSubMeta = null;
  if (scopeKey.startsWith("sub:")) {
    activeSubMeta = subByKey.get(scopeKey.slice(4)) || null;
  }

  if (activeSubMeta && loadingSubId && key(loadingSubId) === key(activeSubMeta.id)) {
    return `<div class="picker-empty" role="status"><span class="spinner"></span><p>${esc(activeSubMeta.name)} 구독의 리소스 그룹을 조회하고 있습니다…</p></div>`;
  }
  if (activeSubMeta && loadError) {
    return `<div class="picker-empty" role="alert"><p>${esc(loadError)}</p><button type="button" class="button small" data-target-action="retry-sub" data-sub-id="${esc(activeSubMeta.id)}">${icon("refresh")}다시 시도</button></div>`;
  }

  const cards = [];
  const sameChosen = !selectedGroup && (!selectedSubscription || (currentSubscription && key(selectedSubscription) === key(currentSubscription)));
  if (keepSameOption) {
    const keepSubLow = key(keepSameOption.subscriptionId || currentSubscription || "");
    const matchesScope = !scopeKey
      || (scopeKey.startsWith("sub:") && scopeKey.slice(4) === keepSubLow)
      || (scopeKey.startsWith("mg:") && (subByKey.get(keepSubLow)?.mgChain || []).some((m) => `mg:${key(m.id)}` === scopeKey));
    const keepSearch = [keepSameOption.label, keepSameOption.resourceGroup, keepSameOption.subscriptionName, keepSameOption.location, "원본 같은 리소스 그룹 유지"].join(" ").toLowerCase();
    if (matchesScope && (!q || keepSearch.includes(q))) {
      cards.push(`<button type="button" class="picker-item ${sameChosen ? "selected" : ""}" data-target-keep-same="true" aria-current="${sameChosen ? "true" : "false"}">
        <span class="resource-symbol storage">${icon("folder")}</span>
        <span class="picker-item-main">
          <span class="picker-item-head"><strong>${esc(keepSameOption.label || "원본과 같은 리소스 그룹에 복제")}</strong><span class="picker-current-badge">${sameChosen ? "선택됨" : "빠른 선택"}</span></span>
          <small class="picker-item-type">${esc(keepSameOption.hint || "이름 접두사로 원본 리소스와 구분해 안전하게 생성합니다")}</small>
          ${keepSameOption.resourceGroup ? `<small class="picker-item-scope">${esc([keepSameOption.subscriptionName, keepSameOption.resourceGroup].filter(Boolean).join(" › "))}</small>` : ""}
        </span>
        ${keepSameOption.location ? `<span class="picker-item-meta"><span class="count-pill">${esc(keepSameOption.location)}</span></span>` : ""}
      </button>`);
    }
  }

  const unloadedSubs = [];
  for (const sub of subByKey.values()) {
    if (scopeKey.startsWith("sub:") && key(sub.id) !== scopeKey.slice(4)) continue;
    if (scopeKey.startsWith("mg:") && !sub.mgChain.some((m) => `mg:${key(m.id)}` === scopeKey)) continue;
    const groups = groupsBySub[sub.id] ?? groupsBySub[key(sub.id)];
    if (!Array.isArray(groups)) {
      unloadedSubs.push(sub);
      continue;
    }
    const mgNames = sub.mgChain.map((m) => m.name);
    for (const rg of groups) {
      const rgId = rg.id || rg.name;
      const trail = [...mgNames, sub.name].join(" › ");
      const searchable = [rg.name, rg.location, sub.name, sub.id, ...mgNames].join(" ").toLowerCase();
      if (q && !searchable.includes(q)) continue;
      const chosen = Boolean(selectedGroup)
        && key(selectedGroup) === key(rgId)
        && (!selectedSubscription || key(selectedSubscription) === key(sub.id));
      cards.push(`<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-target-rg="${esc(rgId)}" data-target-sub="${esc(sub.id)}" aria-current="${chosen ? "true" : "false"}" title="${esc(`${sub.name} / ${rg.name}`)}">
        <span class="resource-symbol network">${icon("folder")}</span>
        <span class="picker-item-main">
          <span class="picker-item-head"><strong>${esc(rg.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}${sub.isCurrent ? '<span class="relation-label shared">현재 구독</span>' : ""}</span>
          <small class="picker-item-scope">${esc(trail)}</small>
        </span>
        ${rg.location ? `<span class="picker-item-meta"><span class="count-pill">${esc(rg.location)}</span></span>` : ""}
      </button>`);
    }
  }

  const unloadedBanner = !scopeKey && unloadedSubs.length
    ? `<div class="picker-load-more">${unloadedSubs.map((s) => `<button type="button" class="sample-chip" data-target-load-sub="${esc(s.id)}">${icon("cloud")}${esc(s.name)} 리소스 그룹 불러오기</button>`).join("")}</div>`
    : "";

  if (!cards.length && !unloadedBanner) {
    return `<div class="picker-empty"><p>일치하는 리소스 그룹이 없습니다.</p>${q || scopeKey ? '<button type="button" class="button small" data-picker-action="reset-filters">검색·필터 초기화</button>' : ""}</div>`;
  }
  return `${unloadedBanner}<div class="picker-items" role="group" aria-label="대상 리소스 그룹 목록">${cards.join("")}</div>`;
}

export function openTargetLocationPicker({
  dialogElement,
  openDialog,
  closeDialog,
  state = null,
  subscriptions = [],
  currentSubscription = "",
  groupsBySub = {},
  loadGroups = null,
  selectedSubscription = "",
  selectedGroup = "",
  keepSameOption = null,
  locations = [],
  selectedLocation = "",
  defaultLocationLabel = "원본 리전 유지",
  title = "대상 구독 · 리소스 그룹 선택",
  returnFocusSelector = "",
  onSelect,
  helpers,
}) {
  const { esc, icon } = helpers;
  const localGroups = { ...groupsBySub };
  const initialSub = selectedSubscription || currentSubscription || subscriptions[0]?.subscriptionId || subscriptions[0]?.id || "";
  const model = {
    scopeKey: initialSub && subscriptions.length > 1 ? `sub:${key(initialSub)}` : "",
    query: "",
    collapsed: new Set(),
    focusKey: "",
    subId: initialSub,
    group: selectedGroup || "",
    location: selectedLocation || "",
    loadingSubId: "",
    loadError: "",
  };

  const buildNodes = () => buildTargetHierarchyNodes(
    state,
    subscriptions.map((s) => ({
      ...s,
      isCurrent: Boolean(currentSubscription && key(s.subscriptionId || s.id) === key(currentSubscription)),
    })),
    localGroups,
  );

  const countTotalGroups = () => {
    let sum = keepSameOption ? 1 : 0;
    for (const sub of subscriptions) {
      const sid = sub.subscriptionId || sub.id;
      const list = localGroups[sid] ?? localGroups[key(sid)];
      if (Array.isArray(list)) sum += list.length;
    }
    return sum;
  };

  const locationBarHtml = () => {
    if (!locations.length) return "";
    return `<div class="picker-filter-chips" role="group" aria-label="배포 리전 선택">
      <span class="picker-chip-label">${icon("globe")}배포 리전</span>
      <button type="button" class="picker-chip ${!model.location ? "active" : ""}" data-target-loc="" aria-pressed="${!model.location}">${esc(defaultLocationLabel)}</button>
      ${locations.map((loc) => `<button type="button" class="picker-chip ${key(model.location) === key(loc) ? "active" : ""}" data-target-loc="${esc(loc)}" aria-pressed="${key(model.location) === key(loc)}">${esc(loc)}</button>`).join("")}
    </div>`;
  };

  const footerHtml = () => {
    const subObj = subscriptions.find((s) => key(s.subscriptionId || s.id) === key(model.subId));
    const summary = model.group
      ? `${subObj?.name || model.subId} › ${model.group}${model.location ? ` (${model.location})` : ""}`
      : (keepSameOption ? `원본 리소스 그룹 유지${model.location ? ` (${model.location})` : ""}` : "리소스 그룹을 선택하세요");
    const canApply = Boolean(model.group || keepSameOption);
    return `<span class="picker-footer-summary" role="status">${esc(summary)}</span><button class="button" type="button" data-picker-action="cancel">취소</button><button class="button primary" type="button" data-picker-action="apply" ${canApply ? "" : "disabled"}>선택 적용</button>`;
  };

  const nodes0 = buildNodes();
  const bodyHtml = `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="구독 및 리소스 그룹 검색" placeholder="관리 그룹 · 구독 · 리소스 그룹 · 리전 검색" value="" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${countTotalGroups()}개</span>
    </div>
    ${locations.length ? `<div class="picker-subtoolbar" id="target-location-chips">${locationBarHtml()}</div>` : ""}
    <div class="picker-body ${nodes0.length ? "" : "picker-body-flat"}">
      ${nodes0.length ? `<aside class="picker-tree-pane" aria-label="관리 그룹 · 구독 계층"><div class="picker-pane-head">관리 그룹 · 구독</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="구독 계층" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes: nodes0, totalCount: countTotalGroups(), scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 구독" }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${targetLocationListHtml({
        state, subscriptions, currentSubscription, groupsBySub: localGroups,
        loadingSubId: model.loadingSubId, loadError: model.loadError,
        scopeKey: model.scopeKey, query: model.query,
        selectedSubscription: model.subId, selectedGroup: model.group, keepSameOption,
      }, helpers)}</div>
    </div>
  </div>`;

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, footerHtml());

  const controller = new AbortController();
  let disposed = false;
  const baseFinish = bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector);
  dialogElement.addEventListener("close", () => { disposed = true; }, { once: true });
  const finishModal = (afterClose = null) => {
    disposed = true;
    baseFinish(afterClose);
  };

  const updateView = () => {
    if (disposed) return;
    const curNodes = buildNodes();
    const total = countTotalGroups();
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${total}개`;
    const locWrap = dialogElement.querySelector("#target-location-chips");
    if (locWrap) locWrap.innerHTML = locationBarHtml();
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) {
      const scroll = treeEl.scrollTop;
      treeEl.innerHTML = resourcePickerTreeHtml({ nodes: curNodes, totalCount: total, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 구독" }, helpers);
      treeEl.scrollTop = scroll;
    }
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) {
      resultsEl.innerHTML = targetLocationListHtml({
        state, subscriptions, currentSubscription, groupsBySub: localGroups,
        loadingSubId: model.loadingSubId, loadError: model.loadError,
        scopeKey: model.scopeKey, query: model.query,
        selectedSubscription: model.subId, selectedGroup: model.group, keepSameOption,
      }, helpers);
    }
    const actionsEl = dialogElement.querySelector("#dialog-actions");
    if (actionsEl) actionsEl.innerHTML = footerHtml();
  };

  const ensureSubLoaded = async (sid) => {
    if (!sid || typeof loadGroups !== "function") return;
    if (Array.isArray(localGroups[sid]) || Array.isArray(localGroups[key(sid)])) return;
    model.loadingSubId = sid;
    model.loadError = "";
    updateView();
    try {
      const loaded = await loadGroups(sid);
      localGroups[sid] = Array.isArray(loaded) ? loaded : [];
      model.loadError = "";
    } catch (err) {
      model.loadError = err instanceof Error ? err.message : "리소스 그룹 목록을 조회하지 못했습니다.";
    } finally {
      model.loadingSubId = "";
      updateView();
    }
  };

  if (initialSub && !Array.isArray(localGroups[initialSub]) && !Array.isArray(localGroups[key(initialSub)])) {
    ensureSubLoaded(initialSub);
  }

  dialogElement.addEventListener("input", (event) => {
    if (event.target.id !== "resource-picker-query") return;
    model.query = event.target.value;
    updateView();
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const locBtn = event.target.closest("[data-target-loc]");
    if (locBtn) {
      model.location = locBtn.dataset.targetLoc || "";
      updateView();
      return;
    }
    const loadSubBtn = event.target.closest("[data-target-load-sub]");
    if (loadSubBtn) {
      ensureSubLoaded(loadSubBtn.dataset.targetLoadSub);
      return;
    }
    const retryBtn = event.target.closest('[data-target-action="retry-sub"]');
    if (retryBtn) {
      ensureSubLoaded(retryBtn.dataset.subId);
      return;
    }
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.pickerAction;
      if (action === "cancel") {
        finishModal();
      } else if (action === "apply") {
        const payload = { subscriptionId: model.group ? model.subId : (currentSubscription || model.subId), resourceGroup: model.group, location: model.location };
        finishModal(() => onSelect(payload));
      } else if (action === "reset-filters") {
        model.scopeKey = "";
        model.query = "";
        const qInput = dialogElement.querySelector("#resource-picker-query");
        if (qInput) qInput.value = "";
        updateView();
        qInput?.focus({ preventScroll: true });
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
        updateView();
        return;
      }
      model.scopeKey = scopeKey;
      model.focusKey = scopeKey;
      if (scopeKey.startsWith("sub:")) {
        const chosenSub = subscriptions.find((s) => key(s.subscriptionId || s.id) === scopeKey.slice(4));
        if (chosenSub) ensureSubLoaded(chosenSub.subscriptionId || chosenSub.id);
      }
      updateView();
      return;
    }
    const keepBtn = event.target.closest("[data-target-keep-same]");
    if (keepBtn) {
      const payload = { subscriptionId: currentSubscription || "", resourceGroup: "", location: model.location };
      finishModal(() => onSelect(payload));
      return;
    }
    const rgBtn = event.target.closest("[data-target-rg]");
    if (rgBtn) {
      const payload = {
        subscriptionId: rgBtn.dataset.targetSub || model.subId,
        resourceGroup: rgBtn.dataset.targetRg || "",
        location: model.location,
      };
      finishModal(() => onSelect(payload));
    }
  }, { signal: controller.signal });

  attachPickerKeyboard(dialogElement, {
    getNodes: buildNodes,
    getCollapsed: () => model.collapsed,
    getFocusState: () => model,
    onSelectScope: (rowKey) => {
      model.scopeKey = rowKey;
      if (rowKey.startsWith("sub:")) {
        const chosenSub = subscriptions.find((s) => key(s.subscriptionId || s.id) === rowKey.slice(4));
        if (chosenSub) ensureSubLoaded(chosenSub.subscriptionId || chosenSub.id);
      }
      updateView();
    },
    onUpdate: updateView,
    optionSelector: "[data-target-keep-same], [data-target-rg]",
  }, controller.signal);

  dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
}

export function buildNetworkHierarchyNodes(vnets = [], mode = "subnet") {
  const nodes = new Map();
  const childrenByParent = new Map();
  const linkChild = (parentKey, childKey) => {
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    const list = childrenByParent.get(parentKey);
    if (!list.includes(childKey)) list.push(childKey);
  };

  for (const vnet of vnets) {
    const rgName = vnet.resourceGroup || "기본 리소스 그룹";
    const rgKey = `rg:${key(rgName)}`;
    const itemCount = mode === "subnet" ? (vnet.subnets || []).length : 1;
    if (!nodes.has(rgKey)) {
      nodes.set(rgKey, {
        key: rgKey,
        rawId: rgName,
        parent: "",
        depth: 0,
        kind: "resourceGroup",
        kindLabel: SCOPE_META.resourceGroup.label,
        icon: SCOPE_META.resourceGroup.icon,
        label: rgName,
        count: 0,
        hasChildren: mode === "subnet",
      });
    }
    nodes.get(rgKey).count += itemCount;
    linkChild("", rgKey);

    if (mode === "subnet") {
      const vKey = `vnet:${key(vnet.id)}`;
      nodes.set(vKey, {
        key: vKey,
        rawId: vnet.id,
        parent: rgKey,
        depth: 1,
        kind: "virtualNetwork",
        kindLabel: SCOPE_META.virtualNetwork.label,
        icon: SCOPE_META.virtualNetwork.icon,
        label: vnet.name,
        count: itemCount,
        hasChildren: false,
      });
      linkChild(rgKey, vKey);
    }
  }

  const ordered = [];
  const walk = (parentKey) => {
    for (const childKey of childrenByParent.get(parentKey) || []) {
      const node = nodes.get(childKey);
      node.hasChildren = (childrenByParent.get(childKey) || []).length > 0;
      ordered.push(node);
      walk(childKey);
    }
  };
  walk("");
  return ordered;
}

export function openNetworkBindingPicker({
  dialogElement,
  openDialog,
  closeDialog,
  mode = "subnet",
  vnets = [],
  subscriptionLabel = "",
  selectedId = "",
  sourceRefId = "",
  sourceLabel = "",
  allowKeepSource = false,
  preferredLocation = "",
  title = mode === "subnet" ? "연결할 서브넷 선택" : "연결할 가상 네트워크 선택",
  returnFocusSelector = "",
  onSelect,
  helpers,
}) {
  const { esc, icon } = helpers;
  const normLoc = (loc) => String(loc || "").toLowerCase().replace(/\s+/g, "");
  const prefLoc = normLoc(preferredLocation);
  const hasMultipleRegions = Boolean(prefLoc) && vnets.some((v) => v.location && normLoc(v.location) !== prefLoc);
  const allKnownIds = new Set(
    mode === "subnet"
      ? vnets.flatMap((v) => (v.subnets || []).map((s) => key(s.id)))
      : vnets.map((v) => key(v.id)),
  );
  const initialCustom = Boolean(selectedId && !allKnownIds.has(key(selectedId)));

  const model = {
    scopeKey: "",
    query: "",
    onlyMatchingRegion: Boolean(prefLoc),
    customOpen: initialCustom || (!vnets.length && !allowKeepSource),
    customValue: initialCustom ? selectedId : "",
    collapsed: new Set(),
    focusKey: "",
  };

  const filteredVnets = () => (model.onlyMatchingRegion && prefLoc
    ? vnets.filter((v) => !v.location || normLoc(v.location) === prefLoc)
    : vnets);

  const renderListHtml = () => {
    const q = String(model.query || "").trim().toLowerCase();
    const list = filteredVnets();
    const cards = [];

    if (allowKeepSource && !model.scopeKey) {
      const keepSearch = ["원본 그대로 공유", sourceLabel, sourceRefId].join(" ").toLowerCase();
      if (!q || keepSearch.includes(q)) {
        const chosen = !selectedId;
        cards.push(`<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-net-select="" aria-current="${chosen ? "true" : "false"}">
          <span class="resource-symbol storage">${icon("network")}</span>
          <span class="picker-item-main">
            <span class="picker-item-head"><strong>원본 네트워크 그대로 공유</strong><span class="picker-current-badge">${chosen ? "선택됨" : "기본값"}</span></span>
            <small class="picker-item-scope">${esc(sourceLabel || sourceRefId)}</small>
          </span>
        </button>`);
      }
    }

    for (const vnet of list) {
      const rgKey = `rg:${key(vnet.resourceGroup || "기본 리소스 그룹")}`;
      const vKey = `vnet:${key(vnet.id)}`;
      if (model.scopeKey.startsWith("rg:") && model.scopeKey !== rgKey) continue;
      if (model.scopeKey.startsWith("vnet:") && model.scopeKey !== vKey) continue;

      if (mode === "vnet") {
        const searchable = [vnet.name, vnet.resourceGroup, vnet.location, vnet.id].join(" ").toLowerCase();
        if (q && !searchable.includes(q)) continue;
        const chosen = Boolean(selectedId) && key(selectedId) === key(vnet.id);
        cards.push(`<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-net-select="${esc(vnet.id)}" aria-current="${chosen ? "true" : "false"}" title="${esc(vnet.id)}">
          <span class="resource-symbol network">${icon("network")}</span>
          <span class="picker-item-main">
            <span class="picker-item-head"><strong>${esc(vnet.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}</span>
            <small class="picker-item-scope">${esc([subscriptionLabel, vnet.resourceGroup, vnet.location].filter(Boolean).join(" › "))}</small>
          </span>
          <span class="picker-item-meta"><span class="count-pill">서브넷 ${(vnet.subnets || []).length}개</span></span>
        </button>`);
      } else {
        for (const sub of vnet.subnets || []) {
          const cidrs = (sub.addressPrefixes || []).join(", ");
          const searchable = [sub.name, cidrs, vnet.name, vnet.resourceGroup, vnet.location, sub.id].join(" ").toLowerCase();
          if (q && !searchable.includes(q)) continue;
          const chosen = Boolean(selectedId) && key(selectedId) === key(sub.id);
          cards.push(`<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-net-select="${esc(sub.id)}" aria-current="${chosen ? "true" : "false"}" title="${esc(sub.id)}">
            <span class="resource-symbol network">${icon("network")}</span>
            <span class="picker-item-main">
              <span class="picker-item-head"><strong>${esc(sub.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}</span>
              <small class="picker-item-type">${esc(vnet.name)}${vnet.location ? ` · ${esc(vnet.location)}` : ""}</small>
              <small class="picker-item-scope">${esc([subscriptionLabel, vnet.resourceGroup].filter(Boolean).join(" › "))}</small>
            </span>
            ${cidrs ? `<span class="picker-item-meta"><code class="cidr-pill">${esc(cidrs)}</code></span>` : ""}
          </button>`);
        }
      }
    }

    const customHtml = model.customOpen
      ? `<div class="picker-custom-box">
          <label class="field">외부·타 구독 ${mode === "subnet" ? "서브넷" : "가상 네트워크"} ARM ID 직접 입력
            <input type="text" id="network-picker-custom-id" value="${esc(model.customValue)}" placeholder="/subscriptions/.../providers/Microsoft.Network/virtualNetworks/...${mode === "subnet" ? "/subnets/..." : ""}" autocomplete="off">
          </label>
          <button type="button" class="button primary small" data-net-action="apply-custom" ${model.customValue.trim() ? "" : "disabled"}>직접 입력한 ID 적용</button>
        </div>`
      : "";

    if (!cards.length) {
      return `${customHtml}<div class="picker-empty"><p>${vnets.length ? "조건에 일치하는 네트워크가 없습니다." : "조회된 가상 네트워크가 없습니다. 위 입력란에 ARM ID를 직접 지정할 수 있습니다."}</p>${q || model.scopeKey || model.onlyMatchingRegion ? '<button type="button" class="button small" data-picker-action="reset-filters">검색·필터 초기화</button>' : ""}</div>`;
    }
    return `${customHtml}<div class="picker-items" role="group" aria-label="네트워크 목록">${cards.join("")}</div>`;
  };

  const renderSubbar = () => `<div class="picker-filter-chips" role="group" aria-label="네트워크 필터">
    ${hasMultipleRegions ? `<button type="button" class="picker-chip ${model.onlyMatchingRegion ? "active" : ""}" data-net-region="match" aria-pressed="${model.onlyMatchingRegion}">대상 리전 일치 (${esc(preferredLocation)})</button><button type="button" class="picker-chip ${!model.onlyMatchingRegion ? "active" : ""}" data-net-region="all" aria-pressed="${!model.onlyMatchingRegion}">전체 리전</button>` : ""}
    <button type="button" class="picker-chip ${model.customOpen ? "active" : ""}" data-net-action="toggle-custom" aria-pressed="${model.customOpen}">직접 ARM ID 입력</button>
  </div>`;

  const curVnets = filteredVnets();
  const nodes0 = buildNetworkHierarchyNodes(curVnets, mode);
  const totalCount0 = mode === "subnet" ? curVnets.reduce((s, v) => s + (v.subnets || []).length, 0) : curVnets.length;

  const bodyHtml = `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="네트워크 검색" placeholder="서브넷 · 가상 네트워크 · 리소스 그룹 · CIDR(10.x) 검색" value="" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${totalCount0}개</span>
    </div>
    <div class="picker-subtoolbar" id="network-picker-chips">${renderSubbar()}</div>
    <div class="picker-body ${nodes0.length ? "" : "picker-body-flat"}">
      ${nodes0.length ? `<aside class="picker-tree-pane" aria-label="리소스 그룹 · 가상 네트워크 계층"><div class="picker-pane-head">리소스 그룹 · VNet</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="네트워크 계층" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes: nodes0, totalCount: totalCount0, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 네트워크" }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${renderListHtml()}</div>
    </div>
  </div>`;

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, '<span class="picker-footer-summary muted">클릭하면 즉시 연결 대상에 반영됩니다</span><button class="button" type="button" data-picker-action="cancel">취소</button>');

  const controller = new AbortController();
  const finishModal = bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector);

  const updateView = () => {
    const vList = filteredVnets();
    const curNodes = buildNetworkHierarchyNodes(vList, mode);
    const total = mode === "subnet" ? vList.reduce((s, v) => s + (v.subnets || []).length, 0) : vList.length;
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${total}개`;
    const chipsEl = dialogElement.querySelector("#network-picker-chips");
    if (chipsEl) chipsEl.innerHTML = renderSubbar();
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) {
      treeEl.innerHTML = resourcePickerTreeHtml({ nodes: curNodes, totalCount: total, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 네트워크" }, helpers);
    }
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) resultsEl.innerHTML = renderListHtml();
  };

  dialogElement.addEventListener("input", (event) => {
    if (event.target.id === "resource-picker-query") {
      model.query = event.target.value;
      updateView();
    } else if (event.target.id === "network-picker-custom-id") {
      model.customValue = event.target.value;
      const applyBtn = dialogElement.querySelector('[data-net-action="apply-custom"]');
      if (applyBtn) applyBtn.disabled = !model.customValue.trim();
    }
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const regBtn = event.target.closest("[data-net-region]");
    if (regBtn) {
      model.onlyMatchingRegion = regBtn.dataset.netRegion === "match";
      model.scopeKey = "";
      updateView();
      return;
    }
    const netAction = event.target.closest("[data-net-action]");
    if (netAction) {
      if (netAction.dataset.netAction === "toggle-custom") {
        model.customOpen = !model.customOpen;
        updateView();
        if (model.customOpen) dialogElement.querySelector("#network-picker-custom-id")?.focus({ preventScroll: true });
      } else if (netAction.dataset.netAction === "apply-custom" && model.customValue.trim()) {
        const val = model.customValue.trim();
        finishModal(() => onSelect(val));
      }
      return;
    }
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      if (actionBtn.dataset.pickerAction === "cancel") finishModal();
      else if (actionBtn.dataset.pickerAction === "reset-filters") {
        model.scopeKey = "";
        model.query = "";
        model.onlyMatchingRegion = false;
        const qInput = dialogElement.querySelector("#resource-picker-query");
        if (qInput) qInput.value = "";
        updateView();
      }
      return;
    }
    const scopeItem = event.target.closest("[data-picker-scope]");
    if (scopeItem) {
      const scopeKey = scopeItem.dataset.pickerScope;
      if (event.target.closest("[data-picker-twisty]")) {
        if (model.collapsed.has(scopeKey)) model.collapsed.delete(scopeKey);
        else model.collapsed.add(scopeKey);
      } else {
        model.scopeKey = scopeKey;
      }
      model.focusKey = scopeKey;
      updateView();
      return;
    }
    const netCard = event.target.closest("[data-net-select]");
    if (netCard) {
      const chosen = netCard.dataset.netSelect || "";
      finishModal(() => onSelect(chosen));
    }
  }, { signal: controller.signal });

  attachPickerKeyboard(dialogElement, {
    getNodes: () => buildNetworkHierarchyNodes(filteredVnets(), mode),
    getCollapsed: () => model.collapsed,
    getFocusState: () => model,
    onSelectScope: (rowKey) => { model.scopeKey = rowKey; updateView(); },
    onUpdate: updateView,
    optionSelector: "[data-net-select]",
  }, controller.signal);

  dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
}

export function openPolicyScopePicker({
  dialogElement,
  openDialog,
  closeDialog,
  initialDraft,
  getNodes,
  toggleNode,
  setAllNodes = null,
  countMatchedResources = null,
  title = "허용된 리소스 체계 선택 (관리 그룹 · 구독 · 리소스 그룹)",
  returnFocusSelector = "",
  onApply,
  helpers,
}) {
  const { esc, icon } = helpers;
  let draft = structuredClone(initialDraft);
  const model = {
    navScopeKey: "",
    kindFilter: "",
    query: "",
    collapsed: new Set(),
    focusKey: "",
  };

  const buildNavTree = (allNodes) => {
    const containerNodes = allNodes.filter((n) => n.kind === "managementGroup" || n.kind === "subscription");
    const byKey = new Map();
    const childrenMap = new Map();
    for (const n of containerNodes) {
      const k = key(n.id);
      const p = n.parentId && containerNodes.some((c) => key(c.id) === key(n.parentId)) ? key(n.parentId) : "";
      byKey.set(k, {
        key: k,
        rawId: n.id,
        parent: p,
        depth: n.depth || 0,
        kind: n.kind,
        kindLabel: SCOPE_META[n.kind]?.label || n.kind,
        icon: SCOPE_META[n.kind]?.icon || "folder",
        label: n.name,
        count: n.resourceCount ?? 0,
        hasChildren: false,
      });
      if (!childrenMap.has(p)) childrenMap.set(p, []);
      childrenMap.get(p).push(k);
    }
    const ordered = [];
    const walk = (p) => {
      for (const ck of childrenMap.get(p) || []) {
        const item = byKey.get(ck);
        item.hasChildren = (childrenMap.get(ck) || []).length > 0;
        ordered.push(item);
        walk(ck);
      }
    };
    walk("");
    return ordered;
  };

  const isDescendantOrSelf = (allByKey, nodeKey, ancestorKey) => {
    if (!ancestorKey) return true;
    const visited = new Set();
    let cur = allByKey.get(nodeKey);
    while (cur && !visited.has(key(cur.id))) {
      const ck = key(cur.id);
      if (ck === ancestorKey) return true;
      visited.add(ck);
      cur = cur.parentId ? allByKey.get(key(cur.parentId)) : null;
    }
    return false;
  };

  const trailText = (allByKey, node) => {
    const parts = [];
    const visited = new Set();
    let cur = node.parentId ? allByKey.get(key(node.parentId)) : null;
    while (cur && !visited.has(key(cur.id))) {
      visited.add(key(cur.id));
      parts.unshift(cur.name);
      cur = cur.parentId ? allByKey.get(key(cur.parentId)) : null;
    }
    return parts.join(" › ");
  };

  const renderKindChips = (allNodes) => {
    const counts = {
      managementGroup: allNodes.filter((n) => n.kind === "managementGroup").length,
      subscription: allNodes.filter((n) => n.kind === "subscription").length,
      resourceGroup: allNodes.filter((n) => n.kind === "resourceGroup").length,
    };
    return `<div class="picker-filter-chips" role="group" aria-label="계층 수준 필터">
      <button type="button" class="picker-chip ${!model.kindFilter ? "active" : ""}" data-scope-kind="" aria-pressed="${!model.kindFilter}">전체 <em>${allNodes.length}</em></button>
      ${counts.managementGroup ? `<button type="button" class="picker-chip ${model.kindFilter === "managementGroup" ? "active" : ""}" data-scope-kind="managementGroup" aria-pressed="${model.kindFilter === "managementGroup"}">관리 그룹 <em>${counts.managementGroup}</em></button>` : ""}
      ${counts.subscription ? `<button type="button" class="picker-chip ${model.kindFilter === "subscription" ? "active" : ""}" data-scope-kind="subscription" aria-pressed="${model.kindFilter === "subscription"}">구독 <em>${counts.subscription}</em></button>` : ""}
      ${counts.resourceGroup ? `<button type="button" class="picker-chip ${model.kindFilter === "resourceGroup" ? "active" : ""}" data-scope-kind="resourceGroup" aria-pressed="${model.kindFilter === "resourceGroup"}">리소스 그룹 <em>${counts.resourceGroup}</em></button>` : ""}
    </div>
    ${typeof setAllNodes === "function" ? `<div class="picker-bulk-actions"><button type="button" class="text-button" data-scope-bulk="all">전체 허용</button><button type="button" class="text-button" data-scope-bulk="none">전체 해제</button></div>` : ""}`;
  };

  const filterScopeNodes = (allNodes) => {
    const allByKey = new Map(allNodes.map((n) => [key(n.id), n]));
    const q = String(model.query || "").trim().toLowerCase();
    return allNodes.filter((node) => {
      if (model.kindFilter && node.kind !== model.kindFilter) return false;
      if (model.navScopeKey && !isDescendantOrSelf(allByKey, key(node.id), model.navScopeKey)) return false;
      if (!q) return true;
      const trail = trailText(allByKey, node);
      return [node.name, node.id, node.detail, trail, SCOPE_META[node.kind]?.label].join(" ").toLowerCase().includes(q);
    });
  };

  const renderScopeListHtml = (allNodes) => {
    const allByKey = new Map(allNodes.map((n) => [key(n.id), n]));
    const shown = filterScopeNodes(allNodes);
    if (!shown.length) {
      return `<div class="picker-empty"><p>조건에 맞는 관리 그룹 · 구독 · 리소스 그룹이 없습니다.</p><button type="button" class="button small" data-picker-action="reset-filters">검색·필터 초기화</button></div>`;
    }
    const itemsHtml = shown.map((node) => {
      const meta = SCOPE_META[node.kind] || SCOPE_META.resourceGroup;
      const trail = trailText(allByKey, node);
      const symbolTone = node.kind === "managementGroup" ? "cdn" : node.kind === "subscription" ? "storage" : "network";
      return `<label class="picker-item picker-check-item ${node.checked ? "selected" : ""} ${node.indeterminate ? "indeterminate" : ""}" title="${esc(node.detail || node.id)}">
        <input type="checkbox" data-modal-policy-scope="${esc(node.id)}" ${node.checked ? "checked" : ""}>
        <span class="resource-symbol ${symbolTone}">${icon(meta.icon)}</span>
        <span class="picker-item-main">
          <span class="picker-item-head">
            <strong>${esc(node.name)}</strong>
            <span class="relation-label shared">${esc(meta.label)}</span>
            ${node.indeterminate ? '<span class="picker-current-badge">일부 하위 포함</span>' : ""}
          </span>
          ${trail ? `<small class="picker-item-scope">${esc(trail)}</small>` : `<small class="picker-item-scope">${esc(node.detail || "최상위 범위")}</small>`}
        </span>
        <span class="picker-item-meta"><span class="count-pill">리소스 ${node.resourceCount ?? 0}개</span></span>
      </label>`;
    }).join("");
    return `<div class="picker-items" role="group" aria-label="리소스 체계 선택 목록">${itemsHtml}</div>`;
  };

  const syncIndeterminate = () => {
    const allNodes = getNodes(draft);
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    for (const input of dialogElement.querySelectorAll("[data-modal-policy-scope]")) {
      const node = byId.get(input.dataset.modalPolicyScope);
      input.indeterminate = Boolean(node?.indeterminate);
    }
  };

  const renderFooter = (allNodes) => {
    const checkedCount = allNodes.filter((n) => n.checked).length;
    const matchedCount = typeof countMatchedResources === "function" ? countMatchedResources(draft) : null;
    const summaryText = matchedCount !== null
      ? `선택한 체계에서 수집 대상 리소스 <strong>${matchedCount}</strong>개 매칭`
      : `선택된 항목 <strong>${checkedCount}</strong>개`;
    return `<span class="picker-footer-summary" role="status">${summaryText}</span><button class="button" type="button" data-picker-action="cancel">취소</button><button class="button primary" type="button" data-picker-action="apply">범위 적용</button>`;
  };

  const initialNodes = getNodes(draft);
  const navNodes0 = buildNavTree(initialNodes);
  const shown0 = filterScopeNodes(initialNodes);
  const bodyHtml = `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="관리 그룹·구독·리소스 그룹 검색" placeholder="관리 그룹 · 구독 · 리소스 그룹 이름 또는 ID 검색" value="" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${shown0.length} / ${initialNodes.length}개</span>
    </div>
    <div class="picker-subtoolbar picker-subtoolbar-split" id="policy-scope-chips">${renderKindChips(initialNodes)}</div>
    <div class="picker-body ${navNodes0.length ? "" : "picker-body-flat"}">
      ${navNodes0.length ? `<aside class="picker-tree-pane" aria-label="상위 관리 그룹 · 구독 탐색"><div class="picker-pane-head">상위 관리 그룹 · 구독</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="상위 체계 탐색" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes: navNodes0, totalCount: initialNodes.length, scopeKey: model.navScopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 체계" }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${renderScopeListHtml(initialNodes)}</div>
    </div>
  </div>`;

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, renderFooter(initialNodes));
  syncIndeterminate();

  const controller = new AbortController();
  const finishModal = bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector);

  const updateView = (focusScopeId = "") => {
    const allNodes = getNodes(draft);
    const navNodes = buildNavTree(allNodes);
    const shown = filterScopeNodes(allNodes);
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${shown.length} / ${allNodes.length}개`;
    const chipsEl = dialogElement.querySelector("#policy-scope-chips");
    if (chipsEl) chipsEl.innerHTML = renderKindChips(allNodes);
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) {
      const scroll = treeEl.scrollTop;
      treeEl.innerHTML = resourcePickerTreeHtml({ nodes: navNodes, totalCount: allNodes.length, scopeKey: model.navScopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 체계" }, helpers);
      treeEl.scrollTop = scroll;
    }
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) {
      const scroll = resultsEl.scrollTop;
      resultsEl.innerHTML = renderScopeListHtml(allNodes);
      resultsEl.scrollTop = scroll;
    }
    const actionsEl = dialogElement.querySelector("#dialog-actions");
    if (actionsEl) actionsEl.innerHTML = renderFooter(allNodes);
    syncIndeterminate();
    if (focusScopeId) {
      [...dialogElement.querySelectorAll("[data-modal-policy-scope]")]
        .find((el) => el.dataset.modalPolicyScope === focusScopeId)
        ?.focus({ preventScroll: true });
    }
  };

  dialogElement.addEventListener("input", (event) => {
    if (event.target.id !== "resource-picker-query") return;
    model.query = event.target.value;
    updateView();
  }, { signal: controller.signal });

  dialogElement.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-modal-policy-scope]");
    if (!input) return;
    const scopeId = input.dataset.modalPolicyScope;
    draft = toggleNode(draft, scopeId, input.checked);
    updateView(scopeId);
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const kindBtn = event.target.closest("[data-scope-kind]");
    if (kindBtn) {
      model.kindFilter = kindBtn.dataset.scopeKind || "";
      updateView();
      return;
    }
    const bulkBtn = event.target.closest("[data-scope-bulk]");
    if (bulkBtn && typeof setAllNodes === "function") {
      draft = setAllNodes(draft, bulkBtn.dataset.scopeBulk === "all");
      updateView();
      return;
    }
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      const act = actionBtn.dataset.pickerAction;
      if (act === "cancel") finishModal();
      else if (act === "apply") {
        const finalDraft = draft;
        finishModal(() => onApply(finalDraft));
      } else if (act === "reset-filters") {
        model.navScopeKey = "";
        model.kindFilter = "";
        model.query = "";
        const qInput = dialogElement.querySelector("#resource-picker-query");
        if (qInput) qInput.value = "";
        updateView();
      }
      return;
    }
    const scopeItem = event.target.closest("[data-picker-scope]");
    if (scopeItem) {
      const scopeKey = scopeItem.dataset.pickerScope;
      if (event.target.closest("[data-picker-twisty]")) {
        if (model.collapsed.has(scopeKey)) model.collapsed.delete(scopeKey);
        else model.collapsed.add(scopeKey);
      } else {
        model.navScopeKey = scopeKey;
      }
      model.focusKey = scopeKey;
      updateView();
    }
  }, { signal: controller.signal });

  attachPickerKeyboard(dialogElement, {
    getNodes: () => buildNavTree(getNodes(draft)),
    getCollapsed: () => model.collapsed,
    getFocusState: () => model,
    onSelectScope: (rowKey) => { model.navScopeKey = rowKey; updateView(); },
    onUpdate: updateView,
    optionSelector: "[data-modal-policy-scope]",
  }, controller.signal);

  dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
}

export function openSubscriptionPicker(options) {
  return openScopeEntityPicker({ ...options, targetKind: "subscription" });
}

export function openManagementGroupPicker(options) {
  return openScopeEntityPicker({ ...options, targetKind: "managementGroup" });
}

export function openScopeEntityPicker({
  dialogElement,
  openDialog,
  closeDialog,
  state = null,
  items = [],
  targetKind = "subscription",
  selectedId = "",
  title = targetKind === "managementGroup" ? "관리 그룹 선택" : "구독 선택",
  returnFocusSelector = "",
  onSelect,
  helpers,
}) {
  const { esc, icon } = helpers;
  const meta = SCOPE_META[targetKind] || SCOPE_META.subscription;
  const sourceItems = items.length
    ? items.map((item) => ({
        id: item.subscriptionId || item.id,
        name: item.name || item.subscriptionId || item.id,
        parentId: item.parentId || "",
        detail: item.detail || item.subscriptionId || item.id,
        isCurrent: Boolean(item.isCurrent),
        count: item.count ?? null,
      }))
    : (state?.scopes || []).filter((s) => s.kind === targetKind).map((s) => ({
        id: s.id,
        name: s.name,
        parentId: s.parentId || "",
        detail: s.detail || s.id,
        isCurrent: false,
        count: null,
      }));

  const mgScopes = (state?.scopes || []).filter((s) => s.kind === "managementGroup");
  const navNodes = mgScopes.map((mg) => {
    const pKey = mg.parentId && mgScopes.some((p) => key(p.id) === key(mg.parentId)) ? key(mg.parentId) : "";
    return {
      key: key(mg.id),
      rawId: mg.id,
      parent: pKey,
      depth: 0,
      kind: "managementGroup",
      kindLabel: SCOPE_META.managementGroup.label,
      icon: SCOPE_META.managementGroup.icon,
      label: mg.name,
      count: sourceItems.length,
      hasChildren: mgScopes.some((c) => key(c.parentId || "") === key(mg.id)),
    };
  });

  const model = { scopeKey: "", query: "", collapsed: new Set(), focusKey: "" };
  const filterItems = () => {
    const q = String(model.query || "").trim().toLowerCase();
    return sourceItems.filter((item) => {
      const mgs = subscriptionAncestry(state, item.id, item.name);
      if (model.scopeKey && key(item.id) !== model.scopeKey && !mgs.some((m) => key(m.id) === model.scopeKey)) {
        return false;
      }
      if (!q) return true;
      return [item.name, item.id, item.detail, ...mgs.map((m) => m.name)].join(" ").toLowerCase().includes(q);
    });
  };

  const renderList = () => {
    const shown = filterItems();
    if (!shown.length) {
      return `<div class="picker-empty"><p>일치하는 ${esc(meta.label)}이 없습니다.</p><button type="button" class="button small" data-picker-action="reset-filters">검색·필터 초기화</button></div>`;
    }
    return `<div class="picker-items" role="group" aria-label="${esc(meta.label)} 목록">${shown.map((item) => {
      const chosen = Boolean(selectedId) && key(selectedId) === key(item.id);
      const mgs = subscriptionAncestry(state, item.id, item.name);
      const trail = mgs.map((m) => m.name).join(" › ");
      return `<button type="button" class="picker-item ${chosen ? "selected" : ""}" data-entity-select="${esc(item.id)}" aria-current="${chosen ? "true" : "false"}">
        <span class="resource-symbol ${targetKind === "managementGroup" ? "cdn" : "storage"}">${icon(meta.icon)}</span>
        <span class="picker-item-main">
          <span class="picker-item-head"><strong>${esc(item.name)}</strong>${chosen ? '<span class="picker-current-badge">선택됨</span>' : ""}${item.isCurrent ? '<span class="relation-label shared">현재 구독</span>' : ""}</span>
          <small class="picker-item-scope">${esc(trail || item.detail)}</small>
        </span>
        ${item.count !== null ? `<span class="picker-item-meta"><span class="count-pill">${item.count}개</span></span>` : ""}
      </button>`;
    }).join("")}</div>`;
  };

  const shown0 = filterItems();
  const bodyHtml = `<div class="resource-picker-modal">
    <div class="picker-toolbar">
      <label class="picker-search">${icon("search")}<input id="resource-picker-query" type="search" aria-label="${esc(meta.label)} 검색" placeholder="${esc(meta.label)} 이름 또는 ID 검색" value="" autocomplete="off"></label>
      <span class="picker-count" id="resource-picker-count">${shown0.length} / ${sourceItems.length}개</span>
    </div>
    <div class="picker-body ${navNodes.length > 1 ? "" : "picker-body-flat"}">
      ${navNodes.length > 1 ? `<aside class="picker-tree-pane" aria-label="관리 그룹 계층"><div class="picker-pane-head">관리 그룹</div><div class="picker-tree" id="resource-picker-tree" role="tree" aria-label="관리 그룹 계층" aria-orientation="vertical">${resourcePickerTreeHtml({ nodes: navNodes, totalCount: sourceItems.length, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 관리 그룹" }, helpers)}</div></aside>` : ""}
      <div class="picker-list-pane" id="resource-picker-results">${renderList()}</div>
    </div>
  </div>`;

  dialogElement.dataset.modalKind = "resource-picker";
  openDialog(title, bodyHtml, '<span class="picker-footer-summary muted">항목을 클릭하면 즉시 반영됩니다</span><button class="button" type="button" data-picker-action="cancel">취소</button>');

  const controller = new AbortController();
  const finishModal = bindModalLifecycle(dialogElement, closeDialog, controller, returnFocusSelector);

  const updateView = () => {
    const shown = filterItems();
    const countEl = dialogElement.querySelector("#resource-picker-count");
    if (countEl) countEl.textContent = `${shown.length} / ${sourceItems.length}개`;
    const treeEl = dialogElement.querySelector("#resource-picker-tree");
    if (treeEl) treeEl.innerHTML = resourcePickerTreeHtml({ nodes: navNodes, totalCount: sourceItems.length, scopeKey: model.scopeKey, collapsed: model.collapsed, focusKey: model.focusKey, rootLabel: "전체 관리 그룹" }, helpers);
    const resultsEl = dialogElement.querySelector("#resource-picker-results");
    if (resultsEl) resultsEl.innerHTML = renderList();
  };

  dialogElement.addEventListener("input", (event) => {
    if (event.target.id !== "resource-picker-query") return;
    model.query = event.target.value;
    updateView();
  }, { signal: controller.signal });

  dialogElement.addEventListener("click", (event) => {
    const actionBtn = event.target.closest("[data-picker-action]");
    if (actionBtn) {
      if (actionBtn.dataset.pickerAction === "cancel") finishModal();
      else if (actionBtn.dataset.pickerAction === "reset-filters") {
        model.scopeKey = "";
        model.query = "";
        const qInput = dialogElement.querySelector("#resource-picker-query");
        if (qInput) qInput.value = "";
        updateView();
      }
      return;
    }
    const scopeItem = event.target.closest("[data-picker-scope]");
    if (scopeItem) {
      const sk = scopeItem.dataset.pickerScope;
      if (event.target.closest("[data-picker-twisty]")) {
        if (model.collapsed.has(sk)) model.collapsed.delete(sk);
        else model.collapsed.add(sk);
      } else {
        model.scopeKey = sk;
      }
      model.focusKey = sk;
      updateView();
      return;
    }
    const btn = event.target.closest("[data-entity-select]");
    if (btn) {
      const chosen = btn.dataset.entitySelect;
      finishModal(() => onSelect(chosen));
    }
  }, { signal: controller.signal });

  attachPickerKeyboard(dialogElement, {
    getNodes: () => navNodes,
    getCollapsed: () => model.collapsed,
    getFocusState: () => model,
    onSelectScope: (rowKey) => { model.scopeKey = rowKey; updateView(); },
    onUpdate: updateView,
    optionSelector: "[data-entity-select]",
  }, controller.signal);

  dialogElement.querySelector("#resource-picker-query")?.focus({ preventScroll: true });
}
