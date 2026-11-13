const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const key = (value) => String(value).toLowerCase();

const COMMON_LOCATIONS = [
  "koreacentral", "koreasouth", "japaneast", "japanwest",
  "eastasia", "southeastasia", "eastus", "eastus2", "westus2", "westeurope",
];

const shortNetworkPath = (id) => {
  const parts = String(id || "").split("/");
  const vnetIdx = parts.findIndex((part) => part.toLowerCase() === "virtualnetworks");
  if (vnetIdx !== -1 && parts[vnetIdx + 1]) {
    const subIdx = parts.findIndex((part, idx) => idx > vnetIdx && part.toLowerCase() === "subnets");
    return subIdx !== -1 && parts[subIdx + 1]
      ? `${parts[vnetIdx + 1]} / ${parts[subIdx + 1]}`
      : parts[vnetIdx + 1];
  }
  return parts.at(-1) || String(id || "");
};

export function suggestDnsLabel(baseLabel, prefix = "", targetGroup = "") {
  const base = String(baseLabel || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base) return "";
  if (prefix) {
    return `${prefix.toLowerCase()}-${base}`.slice(0, 63).replace(/-+$/g, "") || "c0";
  }
  if (!targetGroup) return "";
  let groupPart = String(targetGroup).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!groupPart || !/^[a-z]/.test(groupPart)) groupPart = `rg-${groupPart}`.replace(/-+$/g, "");
  const candidate = `${groupPart.slice(0, 24).replace(/-+$/g, "")}-${base}`.slice(0, 63).replace(/-+$/g, "");
  return candidate.length >= 2 ? candidate : `${candidate}0`;
}

export function bundleSelection(graph, roots, includeRelated, excluded = []) {
  const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
  const selected = new Set(roots.map(key).filter((id) => nodes.has(id)));
  const skipped = new Set(excluded.map(key).filter((id) => !selected.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (node.parentId && selected.has(key(node.parentId)) && !selected.has(key(node.id))) {
        selected.add(key(node.id)); changed = true;
      }
    }
    if (includeRelated) {
      for (const edge of graph.edges) {
        if (selected.has(key(edge.from)) && nodes.has(key(edge.to)) && !selected.has(key(edge.to))
          && !(edge.kind === "reference" && skipped.has(key(edge.to)))) {
          selected.add(key(edge.to)); changed = true;
        }
      }
    }
  }
  return graph.nodes.filter((node) => selected.has(key(node.id)));
}

// "이름 경로=값" 한 줄이 하나의 변경입니다. 이름은 자원 이름 또는 ID이고, 값은 JSON이면 JSON으로, 아니면 문자열로 읽습니다.
export function parseOverrides(text, nodes) {
  const result = [];
  for (const [index, raw] of String(text || "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+([A-Za-z_][\w.[\]=-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`${index + 1}번째 줄: '자원이름 경로=값' 형식이어야 합니다.`);
    const found = nodes.filter((node) => key(node.id) === key(match[1]) || key(node.name) === key(match[1]));
    if (found.length !== 1) throw new Error(`${index + 1}번째 줄: '${match[1]}'에 해당하는 선택 자원이 ${found.length ? "여러 개" : "없"}습니다. 전체 ID를 쓰세요.`);
    let value = match[3];
    try { value = JSON.parse(value); } catch { /* 따옴표 없는 문자열 */ }
    result.push({ resourceId: found[0].id, path: match[2], value });
  }
  if (result.length > 100) throw new Error("변경 항목은 100줄까지입니다.");
  return result;
}

function collectSmartCloneInputs(model, graph, selected) {
  const manual = parseOverrides(model.overridesText, selected);
  const manualKeys = new Set(manual.map((entry) => `${key(entry.resourceId)}::${entry.path}`));
  const overrides = [...manual];
  const smartNames = model.smartNames || {};
  const smartDns = model.smartDnsLabels || {};
  const smartIps = model.smartPrivateIps || {};
  const rawBindings = model.referenceBindings || {};

  const nodesById = new Map(selected.map((node) => [key(node.id), node]));
  const selectedIds = new Set(selected.map((node) => key(node.id)));
  const sharedEdges = (graph.edges || []).filter(
    (edge) => selectedIds.has(key(edge.from)) && !selectedIds.has(key(edge.to)) && edge.kind === "shared",
  );
  const desiredLoc = String(model.targetLocation || "").trim().toLowerCase().replace(/\s+/g, "");
  const referenceBindings = [];
  const seenSources = new Set();
  for (const edge of sharedEdges) {
    const sourceId = edge.referenceId || edge.to;
    const sourceKey = key(sourceId);
    if (!sourceId || seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    const targetId = String(rawBindings[sourceKey] || "").trim();
    const refSub = sourceKey.startsWith("/subscriptions/") ? sourceKey.split("/")[2] : "";
    const crossSubSubnet = Boolean(model.targetSubscription && refSub && key(model.targetSubscription) !== refSub && sourceKey.includes("/subnets/"));
    const fromLoc = String(nodesById.get(key(edge.from))?.location || "").toLowerCase().replace(/\s+/g, "");
    const crossLocSubnet = Boolean(desiredLoc && fromLoc && fromLoc !== "global" && desiredLoc !== fromLoc && sourceKey.includes("/subnets/"));
    if ((crossSubSubnet || crossLocSubnet) && (!targetId || key(targetId) === sourceKey)) {
      throw new Error(`다른 구독·리전으로 복제하려면 공유 서브넷(${shortNetworkPath(sourceId)})의 연결 대상을 선택하세요.`);
    }
    if (targetId && key(targetId) !== sourceKey) {
      referenceBindings.push({ sourceId, targetId });
    }
  }

  for (const node of selected) {
    if (node.parentId) continue;
    const customName = String(smartNames[key(node.id)] || "").trim();
    if (customName && !manualKeys.has(`${key(node.id)}::name`)) {
      overrides.push({ resourceId: node.id, path: "name", value: customName });
      manualKeys.add(`${key(node.id)}::name`);
    }
    const baseDns = node.cloneHints?.dnsLabel;
    if (baseDns) {
      const dnsPath = "properties.dnsSettings.domainNameLabel";
      const customDns = String(smartDns[key(node.id)] || "").trim();
      const autoDns = !customDns && !model.clonePrefix && model.targetGroup
        ? suggestDnsLabel(baseDns, "", model.targetGroup)
        : "";
      const chosenDns = customDns || autoDns;
      if (chosenDns && !manualKeys.has(`${key(node.id)}::${dnsPath}`)) {
        overrides.push({ resourceId: node.id, path: dnsPath, value: chosenDns });
        manualKeys.add(`${key(node.id)}::${dnsPath}`);
      }
    }
    for (const fe of node.cloneHints?.staticFrontends || []) {
      const ipPath = `properties.frontendIPConfigurations[name=${fe.name}].properties.privateIPAddress`;
      const customIp = String(smartIps[`${key(node.id)}::${key(fe.name)}`] || "").trim();
      const subnetKey = key(fe.subnetId || "");
      const vnetKey = subnetKey.includes("/subnets/") ? subnetKey.split("/subnets/")[0] : "";
      const boundTarget = String(rawBindings[subnetKey] || (vnetKey ? rawBindings[vnetKey] : "") || "").trim();
      const sharedSameSubnet = Boolean(subnetKey) && (!boundTarget || key(boundTarget) === subnetKey);
      if (customIp && !manualKeys.has(`${key(node.id)}::${ipPath}`)) {
        overrides.push({ resourceId: node.id, path: ipPath, value: customIp });
        manualKeys.add(`${key(node.id)}::${ipPath}`);
      } else if (fe.requiresStatic && sharedSameSubnet && !manualKeys.has(`${key(node.id)}::${ipPath}`)) {
        throw new Error(`${node.name}: 원본(${fe.privateIPAddress})과 같은 서브넷을 공유하므로 프런트엔드 '${fe.name}'의 새 정적 사설 IP를 입력하세요.`);
      }
    }
  }
  return { overrides, referenceBindings };
}

export function bundleReviewInput(model, graph) {
  if (!model.runId || model.runId === "current") throw new Error("복원 기준 백업을 먼저 선택하세요.");
  const selected = bundleSelection(graph, model.selected, model.includeRelated, model.excludedRelated);
  if (!selected.length || selected.length > 50) throw new Error("1~50개 자원을 선택하세요. 포함 자원도 한도에 포함합니다.");
  if (selected.some((node) => !node.restoreSupported)) throw new Error("차단된 복원 프로필이 선택에 포함돼 있습니다.");
  if (!["create", "update", "clone"].includes(model.mode)) throw new Error("생성·업데이트·복제를 선택하세요.");
  if (model.mode === "clone") {
    const prefix = model.clonePrefix || "";
    if (model.targetSubscription && !model.targetGroup) throw new Error("복제할 대상 리소스 그룹을 선택하세요.");
    if (!model.targetGroup && !prefix) throw new Error("대상 리소스 그룹을 고르지 않으면 복제 접두사가 필요합니다.");
    if (prefix && !/^[a-z][a-z0-9-]{1,19}$/.test(prefix)) throw new Error("복제 접두사는 소문자·숫자·하이픈 2~20자입니다.");
  }
  if (model.ticket.trim().length < 3 || model.ticket.length > 80) throw new Error("티켓은 3~80자입니다.");
  if (model.reason.trim().length < 5 || model.reason.length > 500) throw new Error("사유는 5~500자입니다.");
  if (!model.ack) throw new Error("공유 자원·주소·업무 데이터는 복구하지 않는다는 경계를 확인하세요.");
  const clone = model.mode === "clone";
  const { overrides, referenceBindings } = clone
    ? collectSmartCloneInputs(model, graph, selected)
    : { overrides: [], referenceBindings: [] };
  const targetLocation = clone && String(model.targetLocation || "").trim() ? String(model.targetLocation).trim() : "";
  return { runId: model.runId, resourceIds: model.selected.map((id) => graph.nodes.find((node) => key(node.id) === key(id))?.id).filter(Boolean),
    includeRelated: model.includeRelated, mode: model.mode, ticket: model.ticket.trim(),
    reason: model.reason.trim(), acknowledgeExternal: true,
    ...(model.includeRelated && model.excludedRelated?.length ? { excludedRelated: model.excludedRelated } : {}),
    ...(overrides.length ? { overrides } : {}),
    ...(referenceBindings.length ? { referenceBindings } : {}),
    ...(targetLocation ? { targetLocation } : {}),
    ...(model.mode === "update" && model.immutableConflict === "keep-current" ? { immutableConflict: "keep-current" } : {}),
    ...(clone && model.clonePrefix ? { clonePrefix: model.clonePrefix } : {}),
    ...(clone && model.targetGroup ? { targetSubscriptionId: model.targetSubscription, targetResourceGroup: model.targetGroup } : {}) };
}

const CHANGE_LABELS = {
  overridden: "값 변경",
  renamed: "이름 변경",
  rebound: "대상 연결 변경",
  dropped: "제외",
  dynamic: "동적 배정",
  "kept-current": "현재 값 유지",
};

const RELATION_ROLE_TEXT = {
  contained: "부모 내부 포함 · 자동 반영",
  exclusive: "1:1 전용 (RG 노출)",
  shareable: "공유 가능 (RG 노출)",
  "shared-infra": "기반 네트워크 · 조회 검증",
};

export function adjustmentList(plan) {
  const rows = plan.actions.flatMap((action) => [
    ...(action.adjustments || []).map((item) => `<li title="${esc(item.reason)}"><span>${esc(action.name)} · ${esc(item.path)}</span><span class="relation-label">${esc(CHANGE_LABELS[item.change] || item.change)}</span><small>${esc(item.reason)}</small></li>`),
    ...(action.warnings || []).map((text) => `<li><span>${esc(action.name)}</span><span class="relation-label shared">주의</span><small>${esc(text)}</small></li>`),
  ]);
  return rows.length ? `<h4>복원·복제 시 달라지는 값</h4><ul class="adjustment-list">${rows.join("")}</ul>` : "";
}

export class BundlePanel {
  constructor(root, { api, state, model = null, timezone = "Asia/Seoul", run, refresh, onLogs, embedded = false, intent = "" }) {
    this.root = root; this.api = api; this.state = state; this.run = run; this.refresh = refresh;
    this.onLogs = onLogs; this.timezone = timezone; this.embedded = embedded; this.intent = intent;
    const defaults = {
      runId: "current", selected: [], includeRelated: intent === "clone", excludedRelated: [], overridesText: "",
      targetLocation: "", smartNames: {}, smartDnsLabels: {}, smartPrivateIps: {}, referenceBindings: {}, customBindingModes: {},
      immutableConflict: "block", query: "",
      mode: intent === "clone" ? "clone" : "update", clonePrefix: "copy", targetSubscription: "", targetGroup: "",
      ticket: "", reason: "", ack: false, confirmGroup: "", approved: false,
      plan: null, result: null, error: "", busy: false,
    };
    this.model = model || {};
    for (const [name, value] of Object.entries(defaults)) if (!Object.hasOwn(this.model, name)) this.model[name] = value;
    if (this.intent === "clone") this.model.mode = "clone";
    else if (this.intent === "restore" && this.model.mode === "clone") this.model.mode = "update";
    this.generation = 0; this.alive = true; this.graph = null; this.diagnostics = null;
    this.controller = new AbortController();
    root.addEventListener("click", (event) => this.click(event).catch((error) => this.error(error)), { signal: this.controller.signal });
    root.addEventListener("change", (event) => this.change(event).catch((error) => this.error(error)), { signal: this.controller.signal });
    root.addEventListener("input", (event) => this.input(event), { signal: this.controller.signal });
    this.load();
  }

  async setPlanContext({ runId, resourceIds, intent, defaultRestoreMode = "update" }) {
    if (!this.alive || this.model.busy) return;
    const nextMode = intent === "clone" ? "clone"
      : (this.intent === "restore" && ["create", "update"].includes(this.model.mode) ? this.model.mode : defaultRestoreMode);
    const runChanged = Boolean(runId) && runId !== this.model.runId;
    const selectionChanged = Array.isArray(resourceIds)
      && JSON.stringify(resourceIds.map(key)) !== JSON.stringify(this.model.selected.map(key));
    const modeChanged = nextMode !== this.model.mode || intent !== this.intent;
    this.intent = intent;
    this.model.mode = nextMode;
    if (nextMode === "clone") this.model.includeRelated = true;
    if (Array.isArray(resourceIds)) this.model.selected = [...resourceIds];
    if (runChanged || selectionChanged || modeChanged) {
      this.model.error = "";
      this.model.result = null;
      this.invalidate();
    }
    if (runChanged) {
      this.model.runId = runId;
      await this.load();
    } else if (this.graph) {
      this.syncCloneConstraints();
      this.render();
    }
  }

  isCrossSubscription() {
    const current = this.targets?.currentSubscription || this.state?.workspace?.subscription || "";
    const chosen = this.model?.targetSubscription || "";
    return Boolean(chosen && current && key(chosen) !== key(current));
  }

  isCrossBoundary() {
    return this.isCrossSubscription() || Boolean(String(this.model?.targetLocation || "").trim());
  }

  syncCloneConstraints() {
    if (!this.graph || this.model.mode !== "clone") return;
    const m = this.model, graph = this.graph;
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set(m.selected.map(key));
    const baseChosen = bundleSelection(graph, m.selected, true, []);
    const baseIds = new Set(baseChosen.map((node) => key(node.id)));
    const relatedEdges = graph.edges.filter(
      (edge) => edge.kind === "reference" && baseIds.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)),
    );
    const cross = this.isCrossBoundary();
    const mandatoryIds = new Set(
      relatedEdges
        .filter((edge) => edge.relation === "required" || edge.relationClass === "exclusive" || cross)
        .map((edge) => key(edge.to)),
    );
    if (mandatoryIds.size) {
      m.includeRelated = true;
      m.excludedRelated = (m.excludedRelated || []).filter((id) => !mandatoryIds.has(key(id)));
    }
  }

  snapshot() { return this.model; }
  destroy() { this.alive = false; this.generation++; this.controller.abort(); if (!this.mutating) this.model.busy = false; }
  invalidate() { this.model.plan = null; this.model.approved = false; this.model.confirmGroup = ""; }
  error(error) {
    if (!this.alive) return;
    this.model.error = error instanceof Error ? error.message : "응답을 확인하지 못했습니다.";
    if (this.alive) this.render();
  }
  time(value) {
    return value ? new Intl.DateTimeFormat("ko-KR", { timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "미확인";
  }
  async load() {
    const version = ++this.generation;
    this.graph = null;
    this.root.innerHTML = `<div class="operation-strip" role="status"><span class="spinner"></span>자원·포함 설정·ARM 참조를 읽고 있습니다.</div>`;
    try {
      const graph = await (this.model.runId === "current" ? this.api.relations() : this.api.bundle(this.model.runId));
      if (!this.alive || version !== this.generation) return;
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.addresses)) throw new Error("관계 데이터 형식이 올바르지 않습니다.");
      this.graph = graph;
      this.model.selected = this.model.selected.filter((id) => graph.nodes.some((node) => key(node.id) === key(id)));
      this.syncCloneConstraints();
      this.render();
    } catch (error) {
      if (!this.alive || version !== this.generation) return;
      this.model.error = error instanceof Error ? error.message : "관계 조회 실패";
      this.root.innerHTML = `<div class="notice error" role="alert">${esc(this.model.error)}</div><button class="button" data-bundle="reload">다시 조회</button>`;
    }
  }

  hasSharedNetworkEdges() {
    const graph = this.graph;
    if (!graph || !Array.isArray(graph.edges)) return false;
    const chosen = bundleSelection(graph, this.model.selected || [], this.model.includeRelated, this.model.excludedRelated);
    const ids = new Set(chosen.map((node) => key(node.id)));
    return graph.edges.some((edge) => ids.has(key(edge.from)) && !ids.has(key(edge.to)) && edge.kind === "shared"
      && String(edge.referenceId || edge.to).toLowerCase().includes("/microsoft.network/virtualnetworks/"));
  }

  edgeRelationBadge(edge, included) {
    if (edge.kind === "contained") return { text: "부모 내부 포함", cls: "" };
    if (included) {
      const role = edge.relationClass === "exclusive" || edge.relation === "required" ? "전용 동반" : "연관 포함";
      return { text: role, cls: "" };
    }
    return { text: RELATION_ROLE_TEXT[edge.relationClass] || "공유 · 조회만", cls: "shared" };
  }

  relatedEdgeHint(edge, isClone) {
    const isExclusive = edge.relation === "required" || edge.relationClass === "exclusive";
    if (isExclusive) {
      return isClone ? "1:1 전용 리소스 (RG 노출) · 원본과 공유할 수 없어 자동으로 함께 복제" : "1:1 전용 리소스 (RG 노출) · 해제 시 기존 리소스 유지";
    }
    if (isClone && this.isCrossBoundary()) {
      return "공유 가능 리소스 (RG 노출) · 타 구독·리전 복제 시 함께 복제 필수";
    }
    return "공유 가능 리소스 (RG 노출) · 해제 시 기존 리소스를 공유 참조";
  }

  render() {
    if (!this.alive || !this.graph) return;
    this.syncCloneConstraints();
    this.wantTargets();
    if (this.embedded) {
      this.renderEmbedded();
      this.updateGates();
      return;
    }
    const m = this.model, graph = this.graph;
    const isClone = m.mode === "clone";
    const cross = this.isCrossBoundary();
    const chosen = bundleSelection(graph, m.selected, m.includeRelated, m.excludedRelated);
    const ids = new Set(chosen.map((node) => key(node.id)));
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set(m.selected.map(key));
    const leftOut = new Set(m.excludedRelated.map(key));
    const baseChosen = bundleSelection(graph, m.selected, true, []);
    const baseIds = new Set(baseChosen.map((node) => key(node.id)));
    const relatedEdges = [...new Map(graph.edges
      .filter((edge) => edge.kind === "reference" && baseIds.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)))
      .map((edge) => [key(edge.to), edge])).values()];
    const hasMandatoryCloneRelated = isClone && relatedEdges.some(
      (edge) => edge.relation === "required" || edge.relationClass === "exclusive" || cross,
    );
    const optional = m.includeRelated ? relatedEdges : [];
    const omitted = chosen.flatMap((node) => (node.excluded || []).map((item) => ({ node, item })));
    const shown = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).filter((node) =>
      `${node.name} ${node.label} ${node.id} ${JSON.stringify(node.tags)}`.toLowerCase().includes(m.query.toLowerCase()));
    const edges = graph.edges.filter((edge) => ids.has(key(edge.from)));
    const addresses = graph.addresses.filter((address) => ids.has(key(address.from)));
    const locked = m.busy ? "disabled" : "";
    const saved = this.state.workspace.collectionMode === "scheduled-collector";
    const backups = this.state.runs.filter((run) => run.status === "Captured");
    const statuses = new Map((this.state.runs.find((run) => run.id === m.runId)?.snapshots || []).map((snapshot) => [key(snapshot.resourceId), snapshot.comparison?.status]));
    this.root.innerHTML = `
      <div class="workbench-controls">
        <label>기준<select id="bundle-source" ${locked}><option value="current">${saved ? "최근 수집본" : "현재 ARM"} · 백업 대상 선택</option>${backups.map((run) => `<option value="${esc(run.id)}" ${m.runId === run.id ? "selected" : ""}>${this.time(run.capturedAt)} · ${run.kind === "safety" ? "안전 · " : ""}${esc(run.label || run.kind)} · ${run.snapshots.length}개</option>`).join("")}</select></label>
        <label class="workbench-search">${icon("search")}<input id="bundle-query" type="search" aria-label="관계 자원 검색" placeholder="자원 · 종류 · 태그" value="${esc(m.query)}" ${locked}></label>
        <label class="check-label"><input id="bundle-related" type="checkbox" ${m.includeRelated ? "checked" : ""} ${locked || hasMandatoryCloneRelated ? "disabled" : ""}>연관 자원 추가</label>
        <button class="button small" data-bundle="reload" ${locked}>${icon("refresh")}다시 조회</button>
      </div>
      <div class="workbench-summary" role="status"><span>${icon("box")}직접 선택 <b>${m.selected.length}</b></span><span>${icon("layers")}포함·연관 추가 <b>${chosen.length - m.selected.length}</b></span><span>${icon("shield")}공유 참조 <b>${edges.filter((edge) => !ids.has(key(edge.to))).length}</b></span><span>${icon("globe")}주소 참조 <b>${addresses.length}</b></span><span class="muted">포함 자원 자동 포함 · 서버 계획이 최종 기준</span></div>
      ${m.error ? `<div class="notice error" role="alert">${icon("alert")}${esc(m.error)}</div>` : ""}
      <div class="resource-workbench">
        <section class="workbench-inventory" aria-label="단일 또는 묶음 자원 선택">
          <div class="workbench-section-title"><h2>자원 작업 목록</h2><span>${shown.length} / ${graph.nodes.length}</span><button class="text-button" data-bundle="clear" ${locked}>선택 해제</button></div>
          <div class="table-scroll"><table class="bundle-table"><thead><tr><th><span class="sr-only">선택</span></th><th>리소스 / 포함 관계</th><th>형상 / 현재</th><th><span class="sr-only">진단</span></th></tr></thead><tbody>${shown.map((node) => {
            const selected = ids.has(key(node.id)), direct = m.selected.some((id) => key(id) === key(node.id));
            const implied = selected && !direct;
            const observation = this.state.current[key(node.id)];
            const status = statuses.get(key(node.id));
            const health = backupHealth(this.state, node.id);
            const disabled = m.busy || !node.restoreSupported || implied;
            return `<tr class="${selected ? "bundle-chosen" : ""} backup-${health.status}" ${disabled ? "" : `data-bundle-row="${esc(node.id)}"`}><td><input type="checkbox" data-bundle-select="${esc(node.id)}" aria-label="${esc(node.name)} 선택" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""} title="${esc(implied ? "부모·연관 선택에 포함됩니다. 상위 선택을 해제하세요." : node.blockedReason)}"></td><td><div class="bundle-resource-name ${node.parentId ? "contained-resource" : ""}">${icon(node.icon)}<strong title="${esc(node.id)}">${esc(node.name)}</strong>${node.parentId ? '<span class="relation-label">부모 내부 포함</span>' : ""}</div><small>${esc(node.label)}${node.tags?.customer ? ` · ${esc(node.tags.customer)}` : ""}</small>${!node.restoreSupported ? `<small class="blocked-profile" title="${esc(node.blockedReason)}">${icon("alert")}복원 차단 · ${esc(node.blockedReason)}</small>` : ""}</td><td><span>${observation?.status === "present" ? "현재 있음" : observation?.status === "missing" ? "부재 확인" : "현재 미확인"}</span><small title="${esc(health.lastSuccessAt)}">${relativeTime(health.lastSuccessAt)} · ${health.label}</small><small>${status ? status === "same" ? "형상 같음" : status === "unknown" ? "비교 미확인" : "형상 차이 있음" : saved ? "수집된 ARM 형상" : "현재 ARM 조회"}</small></td><td>${node.resourceType === "microsoft.network/applicationgateways" ? `<button class="icon-button" data-bundle="diagnose" data-id="${esc(node.id)}" title="현재 백엔드 health · WAF/접속 로그" aria-label="${esc(node.name)} 백엔드 health와 WAF 로그" ${m.busy || observation?.status !== "present" ? "disabled" : ""}>${icon("pulse")}</button>` : ""}</td></tr>`;
          }).join("")}</tbody></table></div>
        </section>
        <aside class="workbench-inspector" aria-label="관계 경계와 실행 계획">
          <div class="workbench-section-title"><h2>관계 / 복원 경계</h2><span>${chosen.length}개</span></div>
          ${chosen.length ? `<div class="bundle-node-strip" role="list">${chosen.map((node) => `<span class="bundle-node" role="listitem" tabindex="0" aria-label="${esc(node.label + " · " + node.name)}" title="${esc(node.name + " · " + node.id)}">${icon(node.icon)}<span class="bundle-node-name">${esc(node.name)}</span></span>`).join("")}</div>` : '<div class="workbench-empty">왼쪽에서 자원을 선택하세요.<br>단일 선택도 포함 설정은 함께 복원합니다.</div>'}
          ${optional.length ? `<fieldset class="related-choice"><legend>연관 리소스 · 동반 처리 범위</legend>${optional.map((edge) => {
            const mandatory = isClone && (edge.relation === "required" || edge.relationClass === "exclusive" || cross);
            const checked = mandatory || !leftOut.has(key(edge.to));
            return `<label class="check-label" title="${esc(edge.path)}"><input type="checkbox" data-bundle-related="${esc(edge.to)}" ${checked ? "checked" : ""} ${locked || mandatory ? "disabled" : ""}><strong>${esc(nodes.get(key(edge.to)).name)}</strong> <small>${esc(this.relatedEdgeHint(edge, isClone))}</small></label>`;
          }).join("")}</fieldset>` : ""}
          <ul class="relation-list">${edges.map((edge) => {
            const badge = this.edgeRelationBadge(edge, ids.has(key(edge.to)));
            return `<li title="${esc(edge.path + " · " + (edge.referenceId || edge.to))}"><span>${esc(nodes.get(key(edge.from))?.name)}</span>${icon("arrow")}<strong>${esc(nodes.get(key(edge.to))?.name || shortNetworkPath(edge.referenceId || edge.to))}</strong><span class="relation-label ${badge.cls}">${esc(badge.text)}</span></li>`;
          }).join("")}${omitted.map(({ node, item }) => `<li title="${esc(item.reason)}"><span>${esc(node.name)}</span>${icon("arrow")}<strong>${esc(item.kind === "peering" ? `피어링 ${item.name}` : item.kind === "members" ? `풀 ${item.name} 멤버 NIC ${item.count}개` : `서브넷 ${item.name} 연결 ${item.count}개`)}</strong><span class="relation-label shared">${item.kind === "peering" ? "피어링 · 제외" : item.kind === "members" ? "멤버 · 제외" : "연결 · 제외"}</span></li>`).join("")}${addresses.map((address) => `<li title="${esc(address.path)}"><span>${esc(nodes.get(key(address.from))?.name)}</span>${icon("arrow")}<strong>${esc(address.address)}</strong><span class="relation-label shared">주소 · 수동 검증</span></li>`).join("")}</ul>
          ${m.runId === "current" ? `<div class="workbench-footer"><button class="button primary" data-bundle="backup" ${m.busy || !chosen.length || chosen.some((node) => !node.restoreSupported) ? "disabled" : ""} title="${!chosen.length ? "먼저 왼쪽에서 자원을 선택하세요." : chosen.some((node) => !node.restoreSupported) ? "복원을 지원하지 않는 자원이 선택에 포함돼 있습니다." : ""}">${icon("layers")}선택 ${chosen.length}개 같은 시점 백업</button><small>같은 run에서 수집합니다. Azure 전체의 원자적 스냅샷은 아닙니다.</small></div>` : this.reviewForm(locked)}
        </aside>
      </div>
      ${this.resultView()}
      ${this.diagnostics ? this.diagnosticView() : ""}`;
    this.updateGates();
  }

  renderEmbedded() {
    const m = this.model, graph = this.graph;
    const isClone = m.mode === "clone";
    const cross = this.isCrossBoundary();
    const chosen = bundleSelection(graph, m.selected, m.includeRelated, m.excludedRelated);
    const ids = new Set(chosen.map((node) => key(node.id)));
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set(m.selected.map(key));
    const leftOut = new Set(m.excludedRelated.map(key));
    const baseChosen = bundleSelection(graph, m.selected, true, []);
    const baseIds = new Set(baseChosen.map((node) => key(node.id)));
    const relatedEdges = [...new Map(graph.edges
      .filter((edge) => edge.kind === "reference" && baseIds.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)))
      .map((edge) => [key(edge.to), edge])).values()];
    const hasMandatoryCloneRelated = isClone && relatedEdges.some(
      (edge) => edge.relation === "required" || edge.relationClass === "exclusive" || cross,
    );
    const optional = m.includeRelated ? relatedEdges : [];
    const omitted = chosen.flatMap((node) => (node.excluded || []).map((item) => ({ node, item })));
    const edges = graph.edges.filter((edge) => ids.has(key(edge.from)));
    const addresses = graph.addresses.filter((address) => ids.has(key(address.from)));
    const locked = m.busy ? "disabled" : "";
    const run = this.state.runs.find((item) => item.id === m.runId);
    const topNodes = [...graph.nodes].filter((node) => !node.parentId).sort((a, b) => a.name.localeCompare(b.name, "en"));
    const gatewayNode = chosen.find((node) => node.resourceType === "microsoft.network/applicationgateways");
    const gatewayPresent = gatewayNode ? this.state.current?.[key(gatewayNode.id)]?.status : "";
    const relationRows = [
      ...edges.map((edge) => {
        const badge = this.edgeRelationBadge(edge, ids.has(key(edge.to)));
        return `<li title="${esc(edge.path + " · " + (edge.referenceId || edge.to))}"><span>${esc(nodes.get(key(edge.from))?.name)}</span>${icon("arrow")}<strong>${esc(nodes.get(key(edge.to))?.name || shortNetworkPath(edge.referenceId || edge.to))}</strong><span class="relation-label ${badge.cls}">${esc(badge.text)}</span></li>`;
      }),
      ...omitted.map(({ node, item }) => `<li title="${esc(item.reason)}"><span>${esc(node.name)}</span>${icon("arrow")}<strong>${esc(item.kind === "peering" ? `피어링 ${item.name}` : item.kind === "members" ? `풀 ${item.name} 멤버 NIC ${item.count}개` : `서브넷 ${item.name} 연결 ${item.count}개`)}</strong><span class="relation-label shared">${item.kind === "peering" ? "피어링 · 제외" : item.kind === "members" ? "멤버 · 제외" : "연결 · 제외"}</span></li>`),
      ...addresses.map((address) => `<li title="${esc(address.path)}"><span>${esc(nodes.get(key(address.from))?.name)}</span>${icon("arrow")}<strong>${esc(address.address)}</strong><span class="relation-label shared">주소 · 수동 검증</span></li>`),
    ];
    this.root.innerHTML = `<section class="panel restore-plan-panel" aria-label="${isClone ? "복제 작업 계획" : "복원 작업 계획"}">
      <div class="panel-header">
        <h2 class="panel-title">${icon(isClone ? "layers" : "restore")}${isClone ? "복제 작업 계획" : "복원 작업 계획"} <span class="count-pill">적용 대상 ${chosen.length}개</span></h2>
        <div class="panel-header-actions">
          ${run ? `<span class="panel-header-note">${this.time(run.capturedAt)} 백업 기준</span>` : ""}
          ${gatewayNode ? `<button type="button" class="button small" data-bundle="diagnose" data-id="${esc(gatewayNode.id)}" ${m.busy || gatewayPresent !== "present" ? "disabled" : ""}>${icon("pulse")}백엔드 · WAF 진단</button>` : ""}
        </div>
      </div>
      <div class="panel-body restore-plan-body">
        ${m.error ? `<div class="notice error" role="alert">${icon("alert")}${esc(m.error)}</div>` : ""}
        <div class="plan-scope-box">
          <div class="plan-scope-head">
            <span class="side-eyebrow">종속 리소스 및 관계 경계</span>
            ${relatedEdges.length ? `<label class="check-label"><input id="bundle-related" type="checkbox" ${m.includeRelated ? "checked" : ""} ${locked || hasMandatoryCloneRelated ? "disabled" : ""}>${hasMandatoryCloneRelated ? `필수·연관 리소스 포함 (${relatedEdges.length}개)` : `연관 리소스 함께 적용 (${relatedEdges.length}개)`}</label>` : '<span class="small-text muted">부모 내부 하위 구성 자동 반영</span>'}
          </div>
          ${chosen.length ? `<div class="bundle-node-strip compact-node-strip" role="list">${chosen.map((node) => `<span class="bundle-node" role="listitem" title="${esc(node.name + " · " + node.id)}">${icon(node.icon)}<span class="bundle-node-name">${esc(node.name)}</span>${node.parentId ? '<small class="relation-label">내부 포함</small>' : ""}</span>`).join("")}</div>` : '<p class="small-text muted">적용할 리소스를 하나 이상 선택하세요.</p>'}
          ${optional.length ? `<fieldset class="related-choice"><legend>${isClone ? "RG 노출 연관 리소스 · 복제 규칙" : "함께 복원할 연관 리소스"}</legend>${optional.map((edge) => {
            const mandatory = isClone && (edge.relation === "required" || edge.relationClass === "exclusive" || cross);
            const checked = mandatory || !leftOut.has(key(edge.to));
            return `<label class="check-label" title="${esc(edge.path)}"><input type="checkbox" data-bundle-related="${esc(edge.to)}" ${checked ? "checked" : ""} ${locked || mandatory ? "disabled" : ""}><strong>${esc(nodes.get(key(edge.to)).name)}</strong> <small>${esc(this.relatedEdgeHint(edge, isClone))}</small></label>`;
          }).join("")}</fieldset>` : ""}
          ${relationRows.length ? `<ul class="relation-list compact-relation-list">${relationRows.join("")}</ul>` : ""}
          ${topNodes.length > 1 ? `<details class="bundle-extra-resources"><summary>같은 백업 시점의 다른 리소스 함께 묶기 (${m.selected.length} / ${topNodes.length}개 선택)</summary><div class="bundle-extra-list">${topNodes.map((node) => {
            const selected = ids.has(key(node.id)), direct = directIds.has(key(node.id));
            const implied = selected && !direct;
            const disabled = m.busy || !node.restoreSupported || implied;
            return `<label class="check-label" title="${esc(implied ? "연관 선택으로 이미 포함됨" : node.blockedReason || node.id)}"><input type="checkbox" data-bundle-select="${esc(node.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${esc(node.name)} <small>(${esc(node.label)})</small></span></label>`;
          }).join("")}</div></details>` : ""}
        </div>
        ${this.reviewForm(locked)}
        ${this.resultView()}
        ${this.diagnostics ? this.diagnosticView() : ""}
      </div>
    </section>`;
  }

  resultView() {
    const result = this.model.result;
    return result ? `<section class="bundle-result"><h2>${icon("check")}${result.safetyRunId ? "선택한 관리 설정 적용·사후 비교 완료" : "묶음 백업 완료"}</h2><code>${esc(result.safetyRunId || result.runId)}</code><span>안전 백업 / 작업 ID는 로그에서 추적 · 서비스·주소·업무 데이터는 별도 검증</span><button class="button small" data-bundle="logs">${icon("logs")}실행 로그</button></section>` : "";
  }

  wantTargets() {
    const m = this.model;
    if (m.mode !== "clone" || typeof this.api?.restoreTargets !== "function") return;
    const t = this.targets ||= { loading: false, loaded: false, error: "", enabled: false, currentSubscription: "", subscriptions: [], groups: {}, networks: {}, networkLoading: {} };
    t.networks ||= {};
    t.networkLoading ||= {};
    const sid = m.targetSubscription || t.currentSubscription;
    const needNetworks = Boolean(sid) && this.hasSharedNetworkEdges();
    if (!t.loading && !t.error && (!t.loaded || (t.enabled && sid && !t.groups[sid]))) {
      t.loading = true;
      this.api.restoreTargets(sid).then((data) => {
        if (!this.alive) return;
        Object.assign(t, { enabled: data.enabled === true, currentSubscription: data.currentSubscription || "",
          subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [], loaded: true });
        if (data.subscriptionId) t.groups[data.subscriptionId] = Array.isArray(data.resourceGroups) ? data.resourceGroups : [];
      }).catch((error) => {
        t.error = error instanceof Error ? error.message : "복제 대상을 조회하지 못했습니다.";
      }).finally(() => { t.loading = false; if (this.alive) this.render(); });
      return;
    }
    if (t.loaded && t.enabled && needNetworks && !t.networks[sid] && !t.networkLoading[sid]) {
      t.networkLoading[sid] = true;
      this.api.restoreTargets(sid, { networks: true }).then((data) => {
        if (!this.alive) return;
        const resolvedSid = data.subscriptionId || sid;
        t.networks[resolvedSid] = Array.isArray(data.virtualNetworks) ? data.virtualNetworks : [];
      }).catch(() => {
        t.networks[sid] = [];
      }).finally(() => { t.networkLoading[sid] = false; if (this.alive) this.render(); });
    }
  }

  targetSubscriptionId() { return this.model.targetSubscription || this.targets?.currentSubscription || ""; }

  confirmValue() { return this.model.plan?.confirmation || this.state.workspace.scopeConfirmation || this.state.workspace.resourceGroup; }

  targetFields(locked) {
    const m = this.model, t = this.targets;
    if (!t || (t.loading && !t.loaded)) return `<div class="operation-strip" role="status"><span class="spinner"></span>복제할 수 있는 구독·리소스 그룹을 조회하고 있습니다.</div>`;
    if (t.error) return `<div class="notice error" role="alert">${esc(t.error)}</div><button class="button small" data-bundle="retarget" ${locked}>${icon("refresh")}대상 다시 조회</button>`;
    if (!t.enabled) return '<div class="notice" data-persist>이 콘솔은 구성된 범위 안에서만 복제합니다. 같은 위치에 이름 접두사를 붙여 만듭니다.</div>';
    const sid = this.targetSubscriptionId(), groups = t.groups[sid];
    const names = new Map(t.subscriptions.map((item) => [item.subscriptionId.toLowerCase(), item.name]));
    const graphNodes = this.graph?.nodes || [];
    const chosen = graphNodes.length ? bundleSelection(this.graph, m.selected || [], m.includeRelated, m.excludedRelated) : [];
    const sourceLocations = [...new Set(chosen.map((node) => node.location).filter((loc) => loc && loc.toLowerCase() !== "global"))];
    const groupLocations = (groups || []).map((group) => group.location).filter(Boolean);
    const locationChoices = [...new Set([...sourceLocations, ...groupLocations, ...COMMON_LOCATIONS].map((loc) => loc.toLowerCase()))];
    const defaultLocLabel = sourceLocations.length ? `원본 리전 유지 (${sourceLocations.join(", ")})` : "원본 리전 유지";
    return `<div class="clone-target">
      <div class="smart-clone-grid">
        <label class="field">대상 구독<select id="bundle-target-sub" ${locked}>${t.subscriptions.map((item) => `<option value="${esc(item.subscriptionId)}" ${item.subscriptionId.toLowerCase() === sid.toLowerCase() ? "selected" : ""}>${esc(item.name)}${item.subscriptionId.toLowerCase() === t.currentSubscription.toLowerCase() ? " · 현재" : ""}</option>`).join("")}</select></label>
        <label class="field">대상 리소스 그룹<select id="bundle-target-group" ${locked || !groups ? "disabled" : ""}>${groups ? `<option value="">원본 리소스 그룹 유지 · 접두사 필수</option>${groups.map((group) => `<option value="${esc(group.name)}" ${group.name.toLowerCase() === m.targetGroup.toLowerCase() ? "selected" : ""}>${esc(group.name)}${group.location ? ` · ${esc(group.location)}` : ""}</option>`).join("")}` : "<option>불러오는 중…</option>"}</select></label>
        ${chosen.length ? `<label class="field">대상 리전<select id="bundle-target-location" ${locked}><option value="" ${!m.targetLocation ? "selected" : ""}>${esc(defaultLocLabel)}</option>${locationChoices.map((loc) => `<option value="${esc(loc)}" ${(m.targetLocation || "").toLowerCase() === loc ? "selected" : ""}>${esc(loc)}</option>`).join("")}</select></label>` : ""}
      </div>
      ${m.targetGroup ? `<small class="field-hint">${esc(names.get(sid.toLowerCase()) || sid)} / ${esc(m.targetGroup)} 에 새로 만듭니다. 대상 그룹에 쓰기 권한(예: Contributor)이 있어야 합니다.</small>` : ""}
      ${m.targetSubscription && m.targetSubscription.toLowerCase() !== t.currentSubscription.toLowerCase() ? `<div class="notice warning" data-persist>다른 구독으로 복제할 때는 구독 경계를 넘는 공유 참조를 쓸 수 없습니다. 연관 리소스는 함께 복제하고 공유 네트워크(서브넷)는 대상 구독의 서브넷으로 연결하세요.</div>` : ""}
    </div>`;
  }

  smartCloneFields(locked) {
    const graph = this.graph;
    if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return "";
    const m = this.model;
    const chosen = bundleSelection(graph, m.selected || [], m.includeRelated, m.excludedRelated);
    if (!chosen.length) return "";
    const selectedIds = new Set(chosen.map((node) => key(node.id)));
    const topChosen = chosen.filter((node) => !node.parentId);
    const smartNames = m.smartNames || {};
    const smartDns = m.smartDnsLabels || {};
    const smartIps = m.smartPrivateIps || {};
    const bindings = m.referenceBindings || {};
    const customModes = m.customBindingModes || {};
    const prefix = m.clonePrefix || "";

    const previewChips = topChosen.map((node) => {
      const custom = String(smartNames[key(node.id)] || "").trim();
      const targetName = custom || (prefix ? `${prefix}-${node.name}` : node.name);
      return `<span class="clone-name-chip" title="${esc(node.id)}">${esc(node.name)} ${icon("arrow")} <strong data-preview-for="${esc(key(node.id))}">${esc(targetName)}</strong></span>`;
    }).join("");

    const dnsFields = topChosen.filter((node) => node.cloneHints?.dnsLabel).map((node) => {
      const baseDns = node.cloneHints.dnsLabel;
      const currentVal = smartDns[key(node.id)] ?? "";
      const autoHint = suggestDnsLabel(baseDns, prefix, m.targetGroup);
      return `<label class="field">공용 IP DNS 레이블 (${esc(node.name)})<input type="text" data-smart-dns="${esc(node.id)}" maxlength="63" value="${esc(currentVal)}" placeholder="${esc(autoHint || `새 고유 DNS 레이블 (원본: ${baseDns})`)}" ${locked}><small class="field-hint">리전 전체에서 유일해야 합니다. 비워 두면 <code>${esc(autoHint || baseDns)}</code> 값으로 생성합니다.</small></label>`;
    }).join("");

    const sid = this.targetSubscriptionId();
    const vnets = this.targets?.networks?.[sid] || [];
    const effectiveLoc = (m.targetLocation || chosen.find((n) => n.location && n.location.toLowerCase() !== "global")?.location || "").toLowerCase().replace(/\s+/g, "");
    const matchingVnets = effectiveLoc
      ? vnets.filter((v) => !v.location || v.location.toLowerCase().replace(/\s+/g, "") === effectiveLoc)
      : vnets;
    const subnetLookup = new Map();
    for (const vnet of vnets) {
      for (const sub of vnet.subnets || []) subnetLookup.set(key(sub.id), { vnet, sub });
    }

    const sharedNetEdges = [];
    const seenRefs = new Set();
    for (const edge of graph.edges || []) {
      if (!selectedIds.has(key(edge.from)) || selectedIds.has(key(edge.to)) || edge.kind !== "shared") continue;
      const refId = edge.referenceId || edge.to;
      const refLow = key(refId);
      if (!refLow.includes("/microsoft.network/virtualnetworks/") || seenRefs.has(refLow)) continue;
      const fromNode = chosen.find((n) => key(n.id) === key(edge.from));
      if (this.isCrossBoundary() && fromNode?.resourceType?.startsWith("microsoft.network/loadbalancers") && !refLow.includes("/subnets/")) {
        continue;
      }
      seenRefs.add(refLow);
      sharedNetEdges.push({ refId, refLow, isSubnet: refLow.includes("/subnets/"), fromName: fromNode?.name || "" });
    }

    const bindingFields = sharedNetEdges.map(({ refId, refLow, isSubnet, fromName }) => {
      const boundVal = bindings[refLow] || "";
      const mustRebind = this.isCrossBoundary();
      const options = isSubnet
        ? matchingVnets.flatMap((vnet) => (vnet.subnets || []).map((sub) => ({
            id: sub.id,
            label: `${vnet.resourceGroup} / ${vnet.name} › ${sub.name}${sub.addressPrefixes?.length ? ` (${sub.addressPrefixes.join(", ")})` : ""}`,
          })))
        : matchingVnets.map((vnet) => ({ id: vnet.id, label: `${vnet.resourceGroup} / ${vnet.name} (${vnet.location})` }));
      const inList = !boundVal || options.some((opt) => key(opt.id) === key(boundVal));
      const useCustom = Boolean(customModes[refLow]) || (!inList && Boolean(boundVal)) || (mustRebind && !options.length && Boolean(this.targets?.networks?.[sid]));
      return `<div class="field"><label>공유 ${isSubnet ? "서브넷" : "가상 네트워크"} 연결 (${esc(fromName)} · 원본 ${esc(shortNetworkPath(refId))})${mustRebind ? " — 필수" : ""}${options.length && !customModes[refLow] && inList ? `<select data-smart-binding="${esc(refId)}" ${locked}><option value="" ${!boundVal ? "selected" : ""}>${mustRebind ? "대상 환경의 네트워크를 선택하세요…" : `원본 그대로 공유 (${shortNetworkPath(refId)})`}</option>${options.map((opt) => `<option value="${esc(opt.id)}" ${key(opt.id) === key(boundVal) ? "selected" : ""}>${esc(opt.label)}</option>`).join("")}<option value="__custom__">직접 ARM ID 입력…</option></select>` : ""}${useCustom ? `<input type="text" data-smart-binding-custom="${esc(refId)}" value="${esc(boundVal)}" placeholder="/subscriptions/.../providers/Microsoft.Network/virtualNetworks/...${isSubnet ? "/subnets/..." : ""}" ${locked}>` : ""}</label><small class="field-hint">${mustRebind ? "타 구독·리전 복제이므로 대상 환경에 준비된 동일 리전의 네트워크로 연결합니다." : "같은 구독·리전에서는 원본 네트워크를 그대로 공유하거나 다른 서브넷으로 바꿀 수 있습니다."}</small></div>`;
    }).join("");

    const ipFields = topChosen.flatMap((node) => (node.cloneHints?.staticFrontends || []).map((fe) => {
      const ipKey = `${key(node.id)}::${key(fe.name)}`;
      const currentIp = smartIps[ipKey] ?? "";
      const subLow = key(fe.subnetId || "");
      const boundSub = String(bindings[subLow] || "").trim();
      const sameSubnet = Boolean(subLow) && (!boundSub || key(boundSub) === subLow);
      const targetSubMeta = subnetLookup.get(key(boundSub || fe.subnetId || ""));
      const cidrHint = targetSubMeta?.sub?.addressPrefixes?.length ? ` (${targetSubMeta.sub.addressPrefixes.join(", ")})` : "";
      const requiredStatic = fe.requiresStatic && sameSubnet;
      return `<label class="field">정적 사설 IP (${esc(node.name)} · ${esc(fe.name)})${requiredStatic ? " — 필수" : ""}<input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(currentIp)}" placeholder="${esc(requiredStatic ? `원본 ${fe.privateIPAddress} 외 새 사설 IP 입력${cidrHint}` : sameSubnet ? `비워 두면 자동 동적(Dynamic) 배정 (원본: ${fe.privateIPAddress})` : `비워 두면 ${fe.privateIPAddress} 유지${cidrHint}`)}" ${locked}><small class="field-hint">${requiredStatic ? `Application Gateway v2는 정적 사설 IP가 필수이며 같은 서브넷 내 원본(${esc(fe.privateIPAddress)})과 겹칠 수 없습니다.` : sameSubnet ? "같은 서브넷에서는 비워 두면 동적 배정으로 자동 전환되며, 새 IP를 입력하면 정적 배정을 유지합니다." : `대상 서브넷${esc(cidrHint)} 대역 안의 주소를 사용합니다.`}</small></label>`;
    })).join("");

    const hasCustomNames = Object.values(smartNames).some((v) => String(v || "").trim());
    const renameDrawer = topChosen.length ? `<details class="smart-renames" ${hasCustomNames ? "open" : ""}><summary>리소스별 복제 이름 개별 지정 (선택)</summary><div class="smart-clone-grid">${topChosen.map((node) => `<label class="field">${esc(node.label)} · ${esc(node.name)}<input type="text" data-smart-name="${esc(node.id)}" maxlength="80" value="${esc(smartNames[key(node.id)] || "")}" placeholder="${esc(prefix ? `${prefix}-${node.name}` : node.name)}" ${locked}></label>`).join("")}</div></details>` : "";

    return `<div class="smart-clone-section">
      ${previewChips ? `<div class="clone-name-preview" aria-label="생성될 복제 리소스 이름 미리보기">${previewChips}</div>` : ""}
      ${bindingFields}
      ${dnsFields || ipFields ? `<div class="smart-clone-grid">${dnsFields}${ipFields}</div>` : ""}
      ${renameDrawer}
    </div>`;
  }

  restoreStateHints() {
    if (!this.graph || !this.state?.current || this.model.mode !== "update") return "";
    const chosen = bundleSelection(this.graph, this.model.selected || [], this.model.includeRelated, this.model.excludedRelated);
    const notes = [];
    for (const node of chosen) {
      const obs = this.state.current[key(node.id)];
      if (!obs || obs.status !== "present") continue;
      if (node.resourceType === "microsoft.network/applicationgateways" && obs.operationalState === "Stopped") {
        notes.push(`${node.name}: 현재 중지(Stopped) 상태인 Application Gateway입니다. 복원(PUT) 적용 시 Azure 동작에 따라 자동으로 시작(Running)됩니다.`);
      }
      if (["Failed", "Canceled"].includes(obs.provisioningState)) {
        notes.push(`${node.name}: 현재 프로비저닝 ${obs.provisioningState} 상태입니다. 검증된 백업 형상을 재적용해 목표 상태 복구를 시도합니다.`);
      }
    }
    return notes.map((note) => `<div class="notice warning" data-persist>${icon("alert")}${esc(note)}</div>`).join("");
  }

  setTarget(subscription, group) {
    const current = this.targets?.currentSubscription || "";
    const other = subscription && subscription.toLowerCase() !== current.toLowerCase();
    this.model.targetSubscription = group || other ? subscription : "";
    this.model.targetGroup = group;
    this.syncCloneConstraints();
    this.invalidate();
  }

  reviewForm(locked) {
    const m = this.model, plan = m.plan;
    const clone = m.mode === "clone";
    const confirmation = this.confirmValue();
    const confirmationLabel = this.state.workspace.inventoryScope === "subscription" ? "구독 ID" : "RG 이름";
    const modeSelector = this.intent === "clone"
      ? ""
      : `<fieldset class="restore-choice"><legend>${this.intent === "restore" ? "복원 적용 방식" : "적용 방식 · 허용된 구독 범위"}</legend><label><input type="radio" name="bundle-mode" value="create" ${m.mode === "create" ? "checked" : ""} ${locked}>부재 자원 재생성</label><label><input type="radio" name="bundle-mode" value="update" ${m.mode === "update" ? "checked" : ""} ${locked}>기존 자원 업데이트</label>${this.intent === "restore" ? "" : `<label><input type="radio" name="bundle-mode" value="clone" ${m.mode === "clone" ? "checked" : ""} ${locked}>독립 설정 복제</label>`}</fieldset>`;
    return `<div class="bundle-review">
      ${modeSelector}
      ${m.mode === "clone" ? `${this.targetFields(locked)}<label class="field">새 이름 접두사${m.targetGroup ? " (선택)" : ""}<input type="text" id="bundle-prefix" maxlength="20" value="${esc(m.clonePrefix)}" ${locked}>${m.targetGroup ? '<small class="field-hint">비워 두면 원본 이름을 그대로 씁니다. 공용 IP DNS 레이블은 자동으로 충돌을 피해 제안합니다.</small>' : '<small class="field-hint">같은 리소스 그룹에 복제하므로 원본과 구분할 소문자 접두사(2~20자)를 붙입니다.</small>'}</label>${this.smartCloneFields(locked)}<details class="advanced-overrides" ${m.overridesText ? "open" : ""}><summary>고급 속성 직접 지정 (Azure Policy ipTags 등 · 선택)</summary><label class="field"><span class="sr-only">일부 값 바꾸기</span><textarea id="bundle-overrides" rows="3" spellcheck="false" placeholder="pip-web properties.ipTags=[{&quot;ipTagType&quot;:&quot;FirstPartyUsage&quot;,&quot;tag&quot;:&quot;/Unprivileged&quot;}]" ${locked}>${esc(m.overridesText)}</textarea><small class="field-hint">한 줄에 하나, “자원이름 경로=값”. 목록 항목은 [name=이름]으로 고르며 서버 배정값(IP 주소·FQDN)은 제외됩니다.</small></label></details><div class="notice warning" data-persist>원본 리소스는 변경하지 않습니다. 1:1 전용 리소스(공용 IP)는 자동 동반 복제하고, 백엔드 풀 NIC 멤버·피어링·인증서·업무 데이터는 복제하지 않습니다.</div>` : ""}
      ${m.mode === "update" ? `${this.restoreStateHints()}<label class="field">생성 후 불변 속성(위치·가용성 영역·SKU·IP 태그 등)이 백업과 다를 때<select id="bundle-immutable" ${locked}><option value="block" ${m.immutableConflict === "block" ? "selected" : ""}>복원 중단 (기본)</option><option value="keep-current" ${m.immutableConflict === "keep-current" ? "selected" : ""}>현재 불변값은 유지하고 나머지 설정만 복원</option></select></label>` : ""}
      <div class="plan-fields-grid">
        <label class="field">변경·장애 티켓<input type="text" id="bundle-ticket" maxlength="80" value="${esc(m.ticket)}" placeholder="INC / CHG 번호" ${locked}></label>
        <label class="field">${clone ? "복제 사유" : "복원 사유"}<textarea id="bundle-reason" rows="2" maxlength="500" ${locked}>${esc(m.reason)}</textarea></label>
      </div>
      <label class="check-label boundary-check"><input id="bundle-ack" type="checkbox" ${m.ack ? "checked" : ""} ${locked}>공유 자원·IP/FQDN 대상·인증서·권한·업무 데이터는 복구하지 않습니다.</label>
      <button class="button" data-bundle="review" ${locked}>${icon("shield")}현재 재확인 · 계획 검토</button>
      ${plan && m.mode === "clone" ? `<div class="bundle-plan"><h3>원본 → 복제 대상 · ARM 참조 매핑</h3>${plan.target ? `<p class="clone-destination">${icon("arrow")}대상 위치 · ${esc(plan.target.subscriptionName)} / <b>${esc(plan.target.resourceGroup)}</b></p>` : ""}<ul>${plan.actions.map((action) => `<li title="${esc(action.resourceId)}">${esc(action.sourceResourceId.split("/").at(-1))} ${icon("arrow")} ${esc(action.name)}</li>`).join("")}</ul><small>공유 백엔드와 주소 참조는 원래 대상으로 유지됩니다.</small></div>` : ""}
      ${plan ? `<div class="bundle-plan"><h3>${icon("layers")}서버 확정 순서 · ${plan.actions.length}개</h3><ol>${plan.actions.map((action) => `<li><span>${esc(action.name)}</span><small>${action.wasPresent ? "업데이트" : "생성"}</small></li>`).join("")}</ol>${adjustmentList(plan)}<div class="execution-chain">${icon("shield")}전체 안전 백업${icon("arrow")}${icon("layers")}의존 순서 적용${icon("arrow")}${icon("check")}전체 사후 비교</div><small>만료 ${this.time(plan.expiresAt)} · 실패는 롤백이 아닙니다.</small>${clone ? "" : `<label class="field">최종 확인: ${confirmationLabel}<input type="text" id="bundle-confirm" autocomplete="off" value="${esc(m.confirmGroup)}" placeholder="${esc(confirmation)}" ${locked}></label><label class="check-label"><input id="bundle-approve" type="checkbox" ${m.approved ? "checked" : ""} ${locked}>이 계획으로 선택한 실제 자원을 변경합니다.</label>`}<button class="button primary" data-bundle="execute" disabled>${icon("restore")}${clone ? "복제 실행" : "안전 백업 후 복원"}</button><details><summary>계획·승인 SHA</summary><code class="resource-id">${esc(plan.id)}<br>${esc(plan.approvalSha256)}</code></details></div>` : ""}
    </div>`;
  }

  diagnosticView() {
    const data = this.diagnostics;
    if (data.loading) return '<div class="operation-strip" role="status"><span class="spinner"></span>ARM backend health · 최근 24시간 WAF/접속 로그 조회</div>';
    if (data.error) return `<div class="notice error" role="alert">${esc(data.error)}</div>`;
    const servers = (data.health?.backendAddressPools || []).flatMap((pool) => (pool.backendHttpSettingsCollection || []).flatMap((settings) => (settings.servers || []).map((server) => ({ ...server, settings: settings.backendHttpSettings?.id?.split("/").at(-1) }))));
    const logs = data.logs?.logs || [];
    return `<section class="gateway-diagnostics"><div class="workbench-section-title"><h2>${icon("pulse")}현재 백엔드 / WAF·접속 로그</h2><span>${this.time(data.observedAt)} · 24h WAF 차단 우선 100 / 접속 최신 100</span></div><div class="backend-health">${servers.map((server) => `<span class="${server.health === "Healthy" ? "backend-healthy" : "backend-unconfirmed"}" title="${esc(server.healthProbeLog)}">${icon(server.health === "Healthy" ? "check" : "alert")}<b>${esc(server.settings)} · ${esc(server.address)}</b>${esc(server.health)}</span>`).join("")}</div>${data.logs?.error ? `<div class="notice error" role="alert">Log Analytics 미확인 · ${esc(data.logs.error)}</div>` : logs.length ? `<div class="table-scroll"><table class="logs-table"><thead><tr><th>시각</th><th>원천</th><th>상태 / 규칙</th><th>메시지</th></tr></thead><tbody>${logs.map((row) => `<tr title="${esc(row.TransactionId)}"><td>${this.time(row.TimeGenerated)}</td><td>${esc(row.Category)}</td><td>${esc(row.Status)} ${esc(row.RuleId)}</td><td>${esc(row.Detail)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="workbench-empty">최근 24시간에 수신된 진단 로그가 없습니다. 진단 설정·전송 지연·권한을 확인하세요. 정상 동작으로 판정하지 않습니다.</p>'}</section>`;
  }

  // A clone only creates new resources, so it needs no typed confirmation or approval box; a restore does.
  executeBlocked() {
    const m = this.model;
    if (m.busy || !m.plan) return true;
    return m.mode !== "clone" && (!m.approved || m.confirmGroup !== this.confirmValue());
  }

  updateGates() {
    const review = this.root.querySelector('[data-bundle="review"]');
    if (review) {
      try { bundleReviewInput(this.model, this.graph); review.disabled = this.model.busy; review.title = ""; }
      catch (error) { review.disabled = true; review.title = error.message; }
    }
    const execute = this.root.querySelector('[data-bundle="execute"]');
    if (execute) execute.disabled = this.executeBlocked();
  }

  refreshClonePreviewChips() {
    if (!this.graph || !this.root?.querySelectorAll) return;
    const prefix = this.model.clonePrefix || "";
    const smartNames = this.model.smartNames || {};
    for (const node of this.graph.nodes) {
      if (node.parentId) continue;
      const chip = [...this.root.querySelectorAll("[data-preview-for]")].find((el) => el.dataset.previewFor === key(node.id));
      if (chip) {
        const custom = String(smartNames[key(node.id)] || "").trim();
        chip.textContent = custom || (prefix ? `${prefix}-${node.name}` : node.name);
      }
    }
  }

  input(event) {
    if (this.model.busy) return;
    const target = event.target;
    if (target.dataset?.smartName) {
      this.model.smartNames ||= {};
      this.model.smartNames[key(target.dataset.smartName)] = target.value;
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.refreshClonePreviewChips();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartDns) {
      this.model.smartDnsLabels ||= {};
      this.model.smartDnsLabels[key(target.dataset.smartDns)] = target.value;
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartIp) {
      this.model.smartPrivateIps ||= {};
      this.model.smartPrivateIps[target.dataset.smartIp] = target.value;
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartBindingCustom) {
      this.model.referenceBindings ||= {};
      this.model.referenceBindings[key(target.dataset.smartBindingCustom)] = target.value;
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    const names = { "bundle-ticket": "ticket", "bundle-reason": "reason", "bundle-prefix": "clonePrefix", "bundle-overrides": "overridesText", "bundle-confirm": "confirmGroup", "bundle-query": "query" };
    const name = names[target.id];
    if (!name) return;
    this.model[name] = target.value;
    if (["ticket", "reason", "clonePrefix", "overridesText"].includes(name)) this.invalidate();
    if (name === "clonePrefix") this.refreshClonePreviewChips();
    if (name === "query") {
      const start = target.selectionStart; this.render();
      const input = this.root.querySelector("#bundle-query"); input.focus(); input.setSelectionRange(start, start);
    } else {
      if (!this.model.plan) this.root.querySelector(".bundle-plan")?.remove();
      this.updateGates();
    }
  }

  async change(event) {
    const target = event.target, m = this.model;
    if (m.busy) return;
    if (target.dataset.bundleSelect) {
      m.selected = target.checked ? [...m.selected, target.dataset.bundleSelect] : m.selected.filter((id) => key(id) !== key(target.dataset.bundleSelect));
      this.invalidate(); this.render();
      [...this.root.querySelectorAll("[data-bundle-select]")].find((input) => input.dataset.bundleSelect === target.dataset.bundleSelect)?.focus({ preventScroll: true });
    }
    if (target.id === "bundle-source") { m.runId = target.value; m.result = null; m.error = ""; this.invalidate(); await this.load(); }
    if (target.id === "bundle-related") { m.includeRelated = target.checked; this.invalidate(); this.render(); this.root.querySelector("#bundle-related")?.focus(); }
    if (target.dataset.bundleRelated) {
      const id = target.dataset.bundleRelated;
      m.excludedRelated = target.checked ? m.excludedRelated.filter((item) => key(item) !== key(id)) : [...m.excludedRelated, id];
      this.invalidate(); this.render();
      [...this.root.querySelectorAll("[data-bundle-related]")].find((input) => input.dataset.bundleRelated === id)?.focus({ preventScroll: true });
    }
    if (target.id === "bundle-immutable") { m.immutableConflict = target.value; this.invalidate(); this.render(); this.root.querySelector("#bundle-immutable")?.focus(); }
    if (target.name === "bundle-mode") {
      m.mode = target.value;
      if (m.mode === "clone") m.includeRelated = true;
      this.syncCloneConstraints();
      this.invalidate(); this.render();
      this.root.querySelector(`[name="bundle-mode"][value="${m.mode}"]`)?.focus();
    }
    if (target.id === "bundle-target-sub") {
      m.referenceBindings = {};
      m.customBindingModes = {};
      this.setTarget(target.value, "");
      this.render(); this.root.querySelector("#bundle-target-sub")?.focus();
    }
    if (target.id === "bundle-target-group") {
      this.setTarget(this.targetSubscriptionId(), target.value);
      this.render(); this.root.querySelector("#bundle-target-group")?.focus();
    }
    if (target.id === "bundle-target-location") {
      m.targetLocation = target.value;
      m.referenceBindings = {};
      this.syncCloneConstraints();
      this.invalidate(); this.render();
      this.root.querySelector("#bundle-target-location")?.focus();
    }
    if (target.dataset.smartBinding) {
      const refKey = key(target.dataset.smartBinding);
      m.referenceBindings ||= {};
      m.customBindingModes ||= {};
      if (target.value === "__custom__") {
        m.customBindingModes[refKey] = true;
        m.referenceBindings[refKey] = "";
      } else {
        delete m.customBindingModes[refKey];
        m.referenceBindings[refKey] = target.value;
      }
      this.invalidate(); this.render();
    }
    if (target.id === "bundle-ack") { m.ack = target.checked; this.invalidate(); this.render(); this.root.querySelector("#bundle-ack")?.focus(); }
    if (target.id === "bundle-approve") { m.approved = target.checked; this.updateGates(); }
  }

  async click(event) {
    if (!this.model.busy && !event.target.closest("input, button, a, label, select, textarea")) {
      const row = event.target.closest("[data-bundle-row]");
      if (row) {
        const id = row.dataset.bundleRow;
        const m = this.model;
        const has = m.selected.some((item) => key(item) === key(id));
        m.selected = has ? m.selected.filter((item) => key(item) !== key(id)) : [...m.selected, id];
        this.invalidate();
        this.render();
        [...this.root.querySelectorAll("[data-bundle-select]")].find((input) => input.dataset.bundleSelect === id)?.focus({ preventScroll: true });
        return;
      }
    }
    const target = event.target.closest("[data-bundle]");
    if (!target || target.disabled || this.model.busy) return;
    const action = target.dataset.bundle;
    if (action === "reload") { this.model.error = ""; this.invalidate(); await this.load(); return; }
    if (action === "retarget") { if (this.targets) this.targets.error = ""; this.render(); return; }
    if (action === "clear") { this.model.selected = []; this.invalidate(); this.render(); return; }
    if (action === "logs") { this.onLogs(this.model.result?.ticket || this.model.result?.runId || ""); return; }
    const m = this.model;
    if (action === "execute" && this.executeBlocked()) throw new Error("최종 승인과 허용 범위 확인값을 확인하세요.");
    this.mutating = ["backup", "execute"].includes(action);
    m.busy = true; m.error = ""; this.render();
    try {
      if (action === "review") {
        const plan = await this.api.bundleReview(bundleReviewInput(m, this.graph));
        if (this.alive) m.plan = plan;
      }
      if (action === "diagnose") {
        this.diagnostics = { loading: true }; this.render();
        const data = await this.api.diagnostics(target.dataset.id);
        if (this.alive) this.diagnostics = data;
      }
      if (["backup", "execute"].includes(action)) {
        const payload = action === "backup" ? { resourceIds: m.selected, includeRelated: m.includeRelated,
          ...(m.includeRelated && m.excludedRelated.length ? { excludedRelated: m.excludedRelated } : {}) }
          : { planId: m.plan.id, approvalSha256: m.plan.approvalSha256, confirmGroup: m.confirmGroup };
        const job = await this.run(action === "backup" ? "bundle-backup" : "bundle-restore", payload);
        m.result = job.result; this.invalidate(); m.busy = false;
        if (action === "backup") m.runId = job.result.runId;
        if (this.alive) {
          this.root.querySelector(".bundle-result")?.remove();
          this.root.insertAdjacentHTML("beforeend", this.resultView());
        }
        await this.refresh();
      }
    } catch (error) {
      if (action === "execute") this.invalidate();
      if (action === "diagnose") this.diagnostics = { error: error.message };
      throw error;
    } finally { m.busy = false; if (this.alive) this.render(); }
  }
}
import { backupHealth, relativeTime } from "./backup-view.mjs";
