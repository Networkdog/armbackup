import { resourceHierarchy } from "./resource-picker.mjs";

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

export function filterBackupItems(items, query, state = null) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return items;
  return items.filter(({ resource }) => {
    const hierarchy = state ? resourceHierarchy(state, resource) : null;
    const scopeText = hierarchy
      ? `${hierarchy.managementGroupPath} ${hierarchy.subscription} ${hierarchy.resourceGroup}`
      : "";
    return `${resource.name} ${resource.id} ${resource.typeLabel || resource.type} ${customerOf(resource)} ${scopeText}`
      .toLowerCase().includes(text);
  });
}

export function restoreItem(state, resourceId) {
  if (!resourceId) return null;
  const resource = state.resources.find((item) => key(item.id) === key(resourceId));
  if (!resource) return null;
  return { ...(backupItems(state).find((item) => key(item.resource.id) === key(resourceId)) || { count: 0, latestAt: "" }), resource };
}

const currentLabel = (status) => status === "present" ? "있음" : status === "missing" ? "없음" : "미확인";

export function restorePickerMetaHtml(state, entry, { esc, relativeTime }) {
  const current = state?.current?.[key(entry.resource.id)]?.status;
  return `<strong>백업 ${entry.count}회</strong><small>${entry.latestAt ? `${esc(relativeTime(entry.latestAt))} · ` : ""}현재 ${currentLabel(current)}</small>`;
}

export function restoreTargetHtml(state, targetId, queryOrHelpers, maybeHelpers) {
  const helpers = (maybeHelpers ?? queryOrHelpers) || {};
  const { esc, icon, relativeTime, symbol, busy = false } = helpers;
  const info = targetId ? restoreItem(state, targetId) : null;
  const items = backupItems(state);
  if (!info) {
    const empty = !items.length;
    return `<section class="restore-context restore-item restore-item-unselected" aria-label="선택한 백업 항목"><span class="resource-symbol network">${icon("layers")}</span><div class="restore-context-empty"><strong>${empty ? "검증된 백업이 있는 리소스가 없습니다" : "선택된 리소스가 없습니다"}</strong><span>${empty ? "백업 현황에서 백업을 먼저 실행한 뒤 다시 확인하세요." : "‘항목 변경’을 눌러 관리 그룹 · 구독 · 리소스 그룹에서 대상을 선택하세요."}</span></div><button class="button primary small" type="button" data-action="open-resource-picker" ${busy || empty ? "disabled" : ""}>항목 변경</button></section>`;
  }
  const { resource, count, latestAt } = info;
  const hierarchy = resourceHierarchy(state, resource);
  const current = state.current?.[key(resource.id)]?.status;
  const customer = customerOf(resource);
  const mgLabel = hierarchy.managementGroup || "미확인";
  const mgTitle = hierarchy.managementGroupPath || mgLabel;
  return `<section class="restore-context restore-item" aria-label="선택한 백업 항목"><ol class="restore-hierarchy" aria-label="선택한 리소스 계층"><li><span class="hierarchy-kind">관리 그룹</span><strong title="${esc(mgTitle)}">${esc(mgLabel)}</strong></li><li><span class="hierarchy-kind">구독</span><strong title="${esc(hierarchy.subscriptionDetail || hierarchy.subscription)}">${esc(hierarchy.subscription)}</strong></li><li><span class="hierarchy-kind">리소스 그룹</span><strong>${esc(hierarchy.resourceGroup)}</strong></li><li class="hierarchy-resource" title="${esc(resource.id)}">${symbol(resource)}<span class="hierarchy-resource-text"><span class="hierarchy-kind">리소스</span><strong>${esc(resource.name)}</strong><span class="hierarchy-type">${esc(resource.typeLabel || resource.type)}${customer ? ` · ${esc(customer)}` : ""}</span></span></li></ol><div class="restore-context-side"><dl class="restore-item-facts"><div><dt>백업</dt><dd>${count}회${latestAt ? ` · ${esc(relativeTime(latestAt))}` : ""}</dd></div><div><dt>현재</dt><dd>${currentLabel(current)}</dd></div></dl><button class="button small" type="button" data-action="open-resource-picker" ${busy ? "disabled" : ""}>항목 변경</button></div></section>`;
}
