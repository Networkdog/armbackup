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

export function visibleTree(state, rows, expanded, forceExpand = false) {
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
        leaves.forEach((row, leafIndex) => nodes.push({
          id: row.resource.id, parentId: scope.id, level: level + 1, kind: "resource", row,
          position: leafIndex + 1, setSize: leaves.length,
        }));
      }

    });
  }
  visit(null, 1);
  return nodes;
}

export function visibleTypeTree(rows, expanded) {
  const groups = [...new Set(rows.map((row) => row.resource.type))].sort((a, b) => a.localeCompare(b));
  const nodes = [];
  groups.forEach((type, index) => {
    const id = `type:${type}`, leaves = rows.filter((row) => row.resource.type === type);
    nodes.push({ id, parentId: null, level: 1, kind: "scope", count: leaves.length,
      position: index + 1, setSize: groups.length,
      scope: { id, kind: "resourceType", name: leaves[0].resource.typeLabel, resourceType: type } });
    if (expanded.has(id)) leaves.forEach((row, i) => nodes.push({
      id: row.resource.id, parentId: id, level: 2, kind: "resource", row,
      position: i + 1, setSize: leaves.length,
    }));
  });
  return nodes;
}
