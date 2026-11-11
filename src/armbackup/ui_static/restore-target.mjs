const key = (value) => String(value).toLowerCase();
const customerOf = (resource) => resource.tags?.customer || "";

export function backupItems(state) {
  const items = new Map();
  const resources = new Map(state.resources.map((resource) => [key(resource.id), resource]));
  for (const run of state.runs) {
    if (run.status !== "Captured") continue;
    for (const snapshot of run.snapshots) {
      const resource = resources.get(key(snapshot.resourceId));
      if (!resource) continue;
      const item = items.get(key(resource.id)) || { resource, count: 0, latestAt: "" };
      item.count++;
      const at = snapshot.capturedAt || run.capturedAt || "";
      if (at > item.latestAt) item.latestAt = at;
      items.set(key(resource.id), item);
    }
  }
  return [...items.values()].sort((a, b) => a.resource.name.localeCompare(b.resource.name, "en"));
}

export function filterBackupItems(items, query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return items;
  return items.filter(({ resource }) =>
    `${resource.name} ${resource.id} ${resource.typeLabel || resource.type} ${customerOf(resource)}`.toLowerCase().includes(text));
}

export function restoreItem(state, resourceId) {
  const resource = state.resources.find((item) => key(item.id) === key(resourceId));
  if (!resource) return null;
  return { ...(backupItems(state).find((item) => key(item.resource.id) === key(resourceId)) || { count: 0, latestAt: "" }), resource };
}

const currentLabel = (status) => status === "present" ? "있음" : status === "missing" ? "없음" : "미확인";

export function backupItemListHtml(items, query, { esc, icon, relativeTime }) {
  const shown = filterBackupItems(items, query);
  if (!items.length) return '<div class="restore-item-empty">검증된 백업이 있는 항목이 없습니다. 백업 현황에서 백업을 만든 뒤 다시 선택하세요.</div>';
  if (!shown.length) return '<div class="restore-item-empty">검색 결과가 없습니다.</div>';
  return shown.map(({ resource, count, latestAt }) => `<button class="restore-item-option" data-action="pick-restore-item" data-id="${esc(resource.id)}" title="${esc(resource.id)}">${icon("network")}<span class="restore-item-name"><strong>${esc(resource.name)}</strong><small>${esc(resource.typeLabel || resource.type)}${customerOf(resource) ? ` · ${esc(customerOf(resource))}` : ""}</small></span><span class="restore-item-meta">백업 ${count}회<small>${esc(relativeTime(latestAt))}</small></span></button>`).join("");
}

export function restoreTargetHtml(state, targetId, query, helpers) {
  const { esc, icon, relativeTime, symbol, busy = false } = helpers;
  const info = targetId ? restoreItem(state, targetId) : null;
  if (!info) {
    const items = backupItems(state);
    return `<section class="panel restore-picker" aria-label="복원·복제할 백업 항목 선택"><div class="panel-header"><h2 class="panel-title">복원·복제할 백업 항목을 선택하세요</h2><span class="panel-header-note">${items.length}개 항목</span></div>
      <div class="panel-body"><label class="restore-item-search">${icon("search")}<input id="restore-item-query" type="search" aria-label="백업 항목 검색" placeholder="이름 · 종류 · 고객 태그" value="${esc(query || "")}" autocomplete="off"></label>
      <div id="restore-item-list" class="restore-item-list">${backupItemListHtml(items, query, helpers)}</div></div></section>`;
  }
  const { resource, count, latestAt } = info;
  const current = state.current[key(resource.id)]?.status;
  return `<section class="restore-context restore-item" aria-label="선택한 백업 항목">${symbol(resource)}<div class="restore-context-main"><strong>${esc(resource.name)}</strong><span class="table-sub">${esc(resource.typeLabel || resource.type)}${customerOf(resource) ? ` · ${esc(customerOf(resource))}` : ""}</span><code class="resource-id">${esc(resource.id)}</code></div>
    <dl class="restore-item-facts"><div><dt>백업</dt><dd>${count}회${latestAt ? ` · 마지막 ${esc(relativeTime(latestAt))}` : ""}</dd></div><div><dt>현재 Azure</dt><dd>${currentLabel(current)}</dd></div></dl>
    <button class="button" data-action="clear-restore" ${busy ? "disabled" : ""}>항목 변경</button></section>`;
}
