export const STATUS = {
  same: { label: "동일", short: "동일", description: "비교 범위 내 형상이 같습니다.", icon: "check" },
  critical: { label: "위험 변경", short: "위험", description: "보안 설정 변경 또는 현재 부재가 확인됐습니다.", icon: "alert" },
  warning: { label: "구성 변경", short: "주요", description: "태그 외 구성 차이가 확인됐습니다.", icon: "layers" },
  minor: { label: "경미 변경", short: "경미", description: "태그·설명만 변경됐습니다.", icon: "edit" },
  unknown: { label: "미확인", short: "미확인", description: "조회 오류·수집 범위 문제로 비교할 수 없습니다.", icon: "help" },
};

export function ancestors(state, scopeId) {
  const result = [];
  let scope = state.scopes.find((item) => item.id === scopeId);
  while (scope) {
    result.unshift(scope);
    scope = state.scopes.find((item) => item.id === scope.parentId);
  }
  return result;
}

export function policyScopeChoices(state) {
  const resources = new Set(state.resources.map((resource) => resource.id.toLowerCase()));
  const nodes = [...state.scopes, ...state.resources.map((resource) => {
    const parent = resource.id.slice(0, resource.id.lastIndexOf("/"));
    const owner = parent.slice(0, parent.lastIndexOf("/"));
    return { ...resource, kind: "resource", parentId: resources.has(owner.toLowerCase()) ? owner : resource.groupId };
  })];
  const result = [];
  function visit(parentId, depth) {
    for (const node of nodes.filter((item) => (item.parentId?.toLowerCase() ?? null) === parentId)) {
      result.push({ ...node, depth });
      visit(node.id.toLowerCase(), depth + 1);
    }
  }
  visit(null, 0);
  return result;
}

function policyScopes(state, policy) {
  return new Set(policy.scopeIds.map((id) => (
    id === "resource-group" ? state.workspace.scope
      : id === "subscription" ? `/subscriptions/${state.workspace.subscription}` : id
  ).toLowerCase()));
}

export function policyScopeState(choices, selected, identifier) {
  const id = identifier.toLowerCase();
  const node = choices.find((item) => item.id.toLowerCase() === id);
  if (selected.has(id)) return { checked: true, indeterminate: false };
  if (node?.parentId) {
    let parent = choices.find((item) => item.id.toLowerCase() === node.parentId.toLowerCase());
    while (parent) {
      if (selected.has(parent.id.toLowerCase())) return { checked: true, indeterminate: false };
      parent = choices.find((item) => item.id.toLowerCase() === parent.parentId?.toLowerCase());
    }
  }
  const children = choices.filter((item) => item.parentId?.toLowerCase() === id);
  const statuses = children.map((item) => policyScopeState(choices, selected, item.id));
  return { checked: statuses.length > 0 && statuses.every((item) => item.checked),
    indeterminate: statuses.some((item) => item.checked || item.indeterminate) && !statuses.every((item) => item.checked) };
}

export function policySelection(state, policy) {
  const choices = policyScopeChoices(state), selected = policyScopes(state, policy);
  return choices.filter((node) => node.kind !== "resource")
    .map((node) => ({ ...node, ...policyScopeState(choices, selected, node.id) }));
}

export function togglePolicyScope(state, policy, identifier, checked) {
  const choices = policyScopeChoices(state);
  const target = choices.find((node) => node.id.toLowerCase() === identifier.toLowerCase());
  if (!target) throw new Error("선택할 리소스 체계를 찾지 못했습니다. 다시 조회해 주세요.");
  const branch = new Set([target.id.toLowerCase()]);
  for (const node of choices) if (branch.has(node.parentId?.toLowerCase())) branch.add(node.id.toLowerCase());
  const path = new Set();
  let node = target;
  while (node) {
    path.add(node.id.toLowerCase());
    node = choices.find((item) => item.id.toLowerCase() === node.parentId?.toLowerCase());
  }
  function subtract(id) {
    if (branch.has(id)) return [];
    if (!path.has(id)) return [id];
    return choices.filter((item) => item.parentId?.toLowerCase() === id).flatMap((item) => subtract(item.id.toLowerCase()));
  }
  const selected = [...policyScopes(state, policy)];
  if (checked && selected.some((id) => path.has(id))) return selected;
  return [...new Set(checked
    ? [...selected.filter((id) => !branch.has(id)), target.id.toLowerCase()]
    : selected.flatMap(subtract))];
}

export function policyMatchesScope(state, resource, policy) {
  const selected = policyScopes(state, policy);
  const choices = policyScopeChoices(state);
  let node = choices.find((item) => item.id.toLowerCase() === resource.id.toLowerCase());
  while (node) {
    if (selected.has(node.id.toLowerCase())) return true;
    node = choices.find((item) => item.id.toLowerCase() === node.parentId?.toLowerCase());
  }
  return false;
}

const lower = (value) => String(value ?? "").toLowerCase();

function referencedIds(value) {
  if (Array.isArray(value)) return value.flatMap(referencedIds);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) =>
    name.toLowerCase() === "id" && typeof child === "string" ? [child.toLowerCase()] : referencedIds(child));
}

// 하위·연관 리소스를 모체 리소스에 종속시킨다. 모체는 다른 리소스의 하위가 아닌 리소스다.
// 포함: 리소스 ID가 모체 ID로 시작한다(예: Load Balancer의 Backend Pool).
// 연관: 공식 지원 프로필의 relatedTypes인 리소스를 모체의 원본 응답이 ID로 참조한다(예: Public IP, WAF Policy).
export function nestDependents(shownRows, allRows, profiles = []) {
  const byId = new Map(allRows.map((row) => [lower(row.resource.id), row]));
  const links = new Map();
  for (const id of byId.keys()) {
    for (let cut = id.lastIndexOf("/"); cut > 0; cut = id.lastIndexOf("/", cut - 1)) {
      const parent = id.slice(0, cut);
      if (byId.has(parent)) { links.set(id, { owner: parent, relation: "contained", shared: 0 }); break; }
    }
  }
  for (const [rootId, root] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    const profile = profiles.find((entry) => entry.type === lower(root.resource.type));
    if (!profile) continue;
    const references = new Set([...referencedIds(root.observation?.raw), ...referencedIds(root.snapshot?.raw)]);
    for (const id of references) {
      const related = byId.get(id);
      if (!related || id === rootId || !profile.relatedTypes.includes(lower(related.resource.type))) continue;
      const link = links.get(id);
      if (!link) links.set(id, { owner: rootId, relation: "related", shared: 0 });
      else if (link.owner !== rootId) link.shared += 1;
    }
  }
  const topOf = (id) => {
    const seen = new Set();
    while (links.has(id) && !seen.has(id)) { seen.add(id); id = links.get(id).owner; }
    return id;
  };
  const tops = [], children = new Map(), placed = new Set();
  for (const row of shownRows) {
    const id = lower(row.resource.id), top = topOf(id);
    if (!placed.has(top)) { placed.add(top); tops.push(byId.get(top) || row); }
    if (top === id) continue;
    const link = links.get(id);
    if (!children.has(top)) children.set(top, []);
    children.get(top).push({ row, relation: link.relation, shared: link.shared, owner: byId.get(link.owner)?.resource.name || "" });
  }
  return { tops, children };
}

export function resourceNodes(rows, parentId, level, expanded, children) {
  const nodes = [];
  rows.forEach((row, index) => {
    const id = row.resource.id, deps = children?.get(id.toLowerCase()) || [];
    nodes.push({ id, parentId, level, kind: "resource", row, position: index + 1, setSize: rows.length,
      deps, expandable: deps.length > 0 });
    if (deps.length && expanded.has(id)) deps.forEach((dep, i) => nodes.push({
      id: dep.row.resource.id, parentId: id, level: level + 1, kind: "resource", row: dep.row,
      position: i + 1, setSize: deps.length, dependent: dep, deps: [], expandable: false,
    }));
  });
  return nodes;
}

export function visibleTree(state, rows, expanded, forceExpand = false, dependents = null) {
  const nodes = [];
  const relevant = new Set(rows.flatMap((row) => ancestors(state, row.resource.groupId).map((scope) => scope.id)));
  function visit(parentId, level) {
    const scopes = state.scopes.filter((scope) => scope.parentId === parentId && relevant.has(scope.id));
    scopes.forEach((scope, index) => {
      const children = rows.filter((row) => ancestors(state, row.resource.groupId).some((parent) => parent.id === scope.id));
      nodes.push({ id: scope.id, parentId, level, kind: "scope", scope, count: children.length, position: index + 1, setSize: scopes.length });
      if (forceExpand || expanded.has(scope.id)) {
        visit(scope.id, level + 1);
        const leaves = rows.filter((row) => row.resource.groupId === scope.id);
        nodes.push(...resourceNodes(leaves, scope.id,         level + 1, expanded, dependents));
      }

    });
  }
  visit(null, 1);
  return nodes;
}

export function visibleTypeTree(rows, expanded, children = null) {
  const groups = [...new Set(rows.map((row) => row.resource.type))].sort((a, b) => a.localeCompare(b));
  const nodes = [];
  groups.forEach((type, index) => {
    const id = `type:${type}`, leaves = rows.filter((row) => row.resource.type === type);
    nodes.push({ id, parentId: null, level: 1, kind: "scope", count: leaves.length,
      position: index + 1, setSize: groups.length,
      scope: { id, kind: "resourceType", name: leaves[0].resource.typeLabel, resourceType: type } });
    if (expanded.has(id)) nodes.push(...resourceNodes(leaves, id, 2, expanded, children));
  });
  return nodes;
}
