const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const key = (value) => String(value).toLowerCase();

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
  const overrides = clone ? parseOverrides(model.overridesText, selected) : [];
  return { runId: model.runId, resourceIds: model.selected.map((id) => graph.nodes.find((node) => key(node.id) === key(id))?.id).filter(Boolean),
    includeRelated: model.includeRelated, mode: model.mode, ticket: model.ticket.trim(),
    reason: model.reason.trim(), acknowledgeExternal: true,
    ...(model.includeRelated && model.excludedRelated?.length ? { excludedRelated: model.excludedRelated } : {}),
    ...(overrides.length ? { overrides } : {}),
    ...(model.mode === "update" && model.immutableConflict === "keep-current" ? { immutableConflict: "keep-current" } : {}),
    ...(clone && model.clonePrefix ? { clonePrefix: model.clonePrefix } : {}),
    ...(clone && model.targetGroup ? { targetSubscriptionId: model.targetSubscription, targetResourceGroup: model.targetGroup } : {}) };
}

const CHANGE_LABELS = { overridden: "값 변경", renamed: "이름 변경", dropped: "제외", dynamic: "동적 배정", "kept-current": "현재 값 유지" };

export function adjustmentList(plan) {
  const rows = plan.actions.flatMap((action) => [
    ...(action.adjustments || []).map((item) => `<li title="${esc(item.reason)}"><span>${esc(action.name)} · ${esc(item.path)}</span><span class="relation-label">${esc(CHANGE_LABELS[item.change] || item.change)}</span><small>${esc(item.reason)}</small></li>`),
    ...(action.warnings || []).map((text) => `<li><span>${esc(action.name)}</span><span class="relation-label shared">주의</span><small>${esc(text)}</small></li>`),
  ]);
  return rows.length ? `<h4>복원·복제 시 달라지는 값</h4><ul class="adjustment-list">${rows.join("")}</ul>` : "";
}

export class BundlePanel {
  constructor(root, { api, state, model = null, timezone = "Asia/Seoul", run, refresh, onLogs }) {
    this.root = root; this.api = api; this.state = state; this.run = run; this.refresh = refresh;
    this.onLogs = onLogs; this.timezone = timezone;
    const defaults = { runId: "current", selected: [], includeRelated: false, excludedRelated: [], overridesText: "",
      immutableConflict: "block", query: "",
      mode: "update", clonePrefix: "copy", targetSubscription: "", targetGroup: "", ticket: "", reason: "", ack: false, confirmGroup: "", approved: false,
      plan: null, result: null, error: "", busy: false };
    this.model = model || {};
    for (const [name, value] of Object.entries(defaults)) if (!Object.hasOwn(this.model, name)) this.model[name] = value;
    this.generation = 0; this.alive = true; this.graph = null; this.diagnostics = null;
    this.controller = new AbortController();
    root.addEventListener("click", (event) => this.click(event).catch((error) => this.error(error)), { signal: this.controller.signal });
    root.addEventListener("change", (event) => this.change(event).catch((error) => this.error(error)), { signal: this.controller.signal });
    root.addEventListener("input", (event) => this.input(event), { signal: this.controller.signal });
    this.load();
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
      this.render();
    } catch (error) {
      if (!this.alive || version !== this.generation) return;
      this.model.error = error instanceof Error ? error.message : "관계 조회 실패";
      this.root.innerHTML = `<div class="notice error" role="alert">${esc(this.model.error)}</div><button class="button" data-bundle="reload">다시 조회</button>`;
    }
  }

  render() {
    if (!this.alive || !this.graph) return;
    this.wantTargets();
    const m = this.model, graph = this.graph;
    const chosen = bundleSelection(graph, m.selected, m.includeRelated, m.excludedRelated);
    const ids = new Set(chosen.map((node) => key(node.id)));
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set(m.selected.map(key));
    const leftOut = new Set(m.excludedRelated.map(key));
    const optional = m.includeRelated ? [...new Map(graph.edges
      .filter((edge) => edge.kind === "reference" && ids.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)))
      .map((edge) => [key(edge.to), edge])).values()] : [];
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
        <label class="check-label"><input id="bundle-related" type="checkbox" ${m.includeRelated ? "checked" : ""} ${locked}>연관 자원 추가</label>
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
            return `<tr class="${selected ? "bundle-chosen" : ""} backup-${health.status}" ${disabled ? "" : `data-bundle-row="${esc(node.id)}"`}><td><input type="checkbox" data-bundle-select="${esc(node.id)}" aria-label="${esc(node.name)} 선택" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""} title="${esc(implied ? "부모·연관 선택에 포함됩니다. 상위 선택을 해제하세요." : node.blockedReason)}"></td><td><div class="bundle-resource-name ${node.parentId ? "contained-resource" : ""}">${icon(node.icon)}<strong title="${esc(node.id)}">${esc(node.name)}</strong>${node.parentId ? '<span class="relation-label">포함</span>' : ""}</div><small>${esc(node.label)}${node.tags?.customer ? ` · ${esc(node.tags.customer)}` : ""}</small>${!node.restoreSupported ? `<small class="blocked-profile" title="${esc(node.blockedReason)}">${icon("alert")}복원 차단 · ${esc(node.blockedReason)}</small>` : ""}</td><td><span>${observation?.status === "present" ? "현재 있음" : observation?.status === "missing" ? "부재 확인" : "현재 미확인"}</span><small title="${esc(health.lastSuccessAt)}">${relativeTime(health.lastSuccessAt)} · ${health.label}</small><small>${status ? status === "same" ? "형상 같음" : status === "unknown" ? "비교 미확인" : "형상 차이 있음" : saved ? "수집된 ARM 형상" : "현재 ARM 조회"}</small></td><td>${node.resourceType === "microsoft.network/applicationgateways" ? `<button class="icon-button" data-bundle="diagnose" data-id="${esc(node.id)}" title="현재 백엔드 health · WAF/접속 로그" aria-label="${esc(node.name)} 백엔드 health와 WAF 로그" ${m.busy || observation?.status !== "present" ? "disabled" : ""}>${icon("pulse")}</button>` : ""}</td></tr>`;
          }).join("")}</tbody></table></div>
        </section>
        <aside class="workbench-inspector" aria-label="관계 경계와 실행 계획">
          <div class="workbench-section-title"><h2>관계 / 복원 경계</h2><span>${chosen.length}개</span></div>
          ${chosen.length ? `<div class="bundle-node-strip" role="list">${chosen.map((node) => `<span class="bundle-node" role="listitem" tabindex="0" aria-label="${esc(node.label + " · " + node.name)}" title="${esc(node.name + " · " + node.id)}">${icon(node.icon)}<span class="bundle-node-name">${esc(node.name)}</span></span>`).join("")}</div>` : '<div class="workbench-empty">왼쪽에서 자원을 선택하세요.<br>단일 선택도 포함 설정은 함께 복원합니다.</div>'}
          ${optional.length ? `<fieldset class="related-choice"><legend>연관 자원 · 함께 포함할 항목</legend>${optional.map((edge) => `<label class="check-label" title="${esc(edge.path)}"><input type="checkbox" data-bundle-related="${esc(edge.to)}" ${leftOut.has(key(edge.to)) ? "" : "checked"} ${locked}>${esc(nodes.get(key(edge.to)).name)} <small>${edge.relation === "required" ? "복제하려면 함께 필요 · 한 곳에만 연결" : "선택 · 빼면 기존 자원을 공유"}</small></label>`).join("")}</fieldset>` : ""}
          <ul class="relation-list">${edges.map((edge) => `<li title="${esc(edge.path + " · " + (edge.referenceId || edge.to))}"><span>${esc(nodes.get(key(edge.from))?.name)}</span>${icon("arrow")}<strong>${esc(nodes.get(key(edge.to))?.name || edge.to.split("/").at(-1))}</strong><span class="relation-label ${ids.has(key(edge.to)) ? "" : "shared"}">${edge.kind === "contained" ? "포함" : ids.has(key(edge.to)) ? "연관" : "공유 · 조회만"}</span></li>`).join("")}${omitted.map(({ node, item }) => `<li title="${esc(item.reason)}"><span>${esc(node.name)}</span>${icon("arrow")}<strong>${esc(item.kind === "peering" ? `피어링 ${item.name}` : `서브넷 ${item.name} 연결 ${item.count}개`)}</strong><span class="relation-label shared">${item.kind === "peering" ? "피어링 · 제외" : "연결 · 제외"}</span></li>`).join("")}${addresses.map((address) => `<li title="${esc(address.path)}"><span>${esc(nodes.get(key(address.from))?.name)}</span>${icon("arrow")}<strong>${esc(address.address)}</strong><span class="relation-label shared">주소 · 수동 검증</span></li>`).join("")}</ul>
          ${m.runId === "current" ? `<div class="workbench-footer"><button class="button primary" data-bundle="backup" ${m.busy || !chosen.length || chosen.some((node) => !node.restoreSupported) ? "disabled" : ""} title="${!chosen.length ? "먼저 왼쪽에서 자원을 선택하세요." : chosen.some((node) => !node.restoreSupported) ? "복원을 지원하지 않는 자원이 선택에 포함돼 있습니다." : ""}">${icon("layers")}선택 ${chosen.length}개 같은 시점 백업</button><small>같은 run에서 수집합니다. Azure 전체의 원자적 스냅샷은 아닙니다.</small></div>` : this.reviewForm(locked)}
        </aside>
      </div>
      ${this.resultView()}
      ${this.diagnostics ? this.diagnosticView() : ""}`;
    this.updateGates();
  }

  resultView() {
    const result = this.model.result;
    return result ? `<section class="bundle-result"><h2>${icon("check")}${result.safetyRunId ? "선택한 관리 설정 적용·사후 비교 완료" : "묶음 백업 완료"}</h2><code>${esc(result.safetyRunId || result.runId)}</code><span>안전 백업 / 작업 ID는 로그에서 추적 · 서비스·주소·업무 데이터는 별도 검증</span><button class="button small" data-bundle="logs">${icon("logs")}실행 로그</button></section>` : "";
  }

  wantTargets() {
    const m = this.model;
    if (m.mode !== "clone" || typeof this.api?.restoreTargets !== "function") return;
    const t = this.targets ||= { loading: false, loaded: false, error: "", enabled: false, currentSubscription: "", subscriptions: [], groups: {} };
    const sid = m.targetSubscription || t.currentSubscription;
    if (t.loading || t.error || (t.loaded && (!t.enabled || t.groups[sid]))) return;
    t.loading = true;
    this.api.restoreTargets(sid).then((data) => {
      if (!this.alive) return;
      Object.assign(t, { enabled: data.enabled === true, currentSubscription: data.currentSubscription || "",
        subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [], loaded: true });
      if (data.subscriptionId) t.groups[data.subscriptionId] = Array.isArray(data.resourceGroups) ? data.resourceGroups : [];
    }).catch((error) => {
      t.error = error instanceof Error ? error.message : "복제 대상을 조회하지 못했습니다.";
    }).finally(() => { t.loading = false; if (this.alive) this.render(); });
  }

  targetSubscriptionId() { return this.model.targetSubscription || this.targets?.currentSubscription || ""; }

  confirmValue() { return this.model.plan?.confirmation || this.state.workspace.scopeConfirmation || this.state.workspace.resourceGroup; }

  targetFields(locked) {
    const m = this.model, t = this.targets;
    if (!t || (t.loading && !t.loaded)) return `<div class="operation-strip" role="status"><span class="spinner"></span>복제할 수 있는 구독·리소스 그룹을 조회하고 있습니다.</div>`;
    if (t.error) return `<div class="notice error" role="alert">${esc(t.error)}</div><button class="button small" data-bundle="retarget" ${locked}>${icon("refresh")}대상 다시 조회</button>`;
    if (!t.enabled) return '<div class="notice">이 콘솔은 구성된 범위 안에서만 복제합니다. 같은 위치에 이름 접두사를 붙여 만듭니다.</div>';
    const sid = this.targetSubscriptionId(), groups = t.groups[sid];
    const names = new Map(t.subscriptions.map((item) => [item.subscriptionId.toLowerCase(), item.name]));
    return `<div class="clone-target">
      <label class="field">대상 구독<select id="bundle-target-sub" ${locked}>${t.subscriptions.map((item) => `<option value="${esc(item.subscriptionId)}" ${item.subscriptionId.toLowerCase() === sid.toLowerCase() ? "selected" : ""}>${esc(item.name)}${item.subscriptionId.toLowerCase() === t.currentSubscription.toLowerCase() ? " · 현재" : ""}</option>`).join("")}</select></label>
      <label class="field">대상 리소스 그룹<select id="bundle-target-group" ${locked || !groups ? "disabled" : ""}>${groups ? `<option value="">원본 리소스 그룹 유지 · 접두사 필수</option>${groups.map((group) => `<option value="${esc(group.name)}" ${group.name.toLowerCase() === m.targetGroup.toLowerCase() ? "selected" : ""}>${esc(group.name)}${group.location ? ` · ${esc(group.location)}` : ""}</option>`).join("")}` : "<option>불러오는 중…</option>"}</select></label>
      ${m.targetGroup ? `<small class="field-hint">${esc(names.get(sid.toLowerCase()) || sid)} / ${esc(m.targetGroup)} 에 새로 만듭니다. 대상 그룹에 쓰기 권한(예: Contributor)이 있어야 합니다.</small>` : ""}
      ${m.targetSubscription && m.targetSubscription.toLowerCase() !== t.currentSubscription.toLowerCase() ? `<div class="notice warning">다른 구독으로 복제할 때는 구독 경계를 넘는 공유 참조를 쓸 수 없습니다. 참조 자원은 “연관 자원 추가”로 함께 복제하세요.</div>` : ""}
    </div>`;
  }

  setTarget(subscription, group) {
    const current = this.targets?.currentSubscription || "";
    const other = subscription && subscription.toLowerCase() !== current.toLowerCase();
    this.model.targetSubscription = group || other ? subscription : "";
    this.model.targetGroup = group;
    this.invalidate();
  }

  reviewForm(locked) {
    const m = this.model, plan = m.plan;
    const confirmation = this.confirmValue();
    const confirmationLabel = plan?.target ? "대상 리소스 그룹 이름" : this.state.workspace.inventoryScope === "subscription" ? "구독 ID" : "RG 이름";
    return `<div class="bundle-review">
      <fieldset class="restore-choice"><legend>적용 방식 · 허용된 구독 범위</legend><label><input type="radio" name="bundle-mode" value="create" ${m.mode === "create" ? "checked" : ""} ${locked}>부재 자원 재생성</label><label><input type="radio" name="bundle-mode" value="update" ${m.mode === "update" ? "checked" : ""} ${locked}>기존 자원 업데이트</label><label><input type="radio" name="bundle-mode" value="clone" ${m.mode === "clone" ? "checked" : ""} ${locked}>독립 설정 복제</label></fieldset>
      ${m.mode === "clone" ? `${this.targetFields(locked)}<label class="field">새 이름 접두사${m.targetGroup ? " (선택)" : ""}<input type="text" id="bundle-prefix" maxlength="20" value="${esc(m.clonePrefix)}" ${locked}>${m.targetGroup ? '<small class="field-hint">비워 두면 원본 이름을 그대로 씁니다. DNS 이름이 있는 공개 IP는 접두사가 필요합니다.</small>' : ""}</label><label class="field">일부 값 바꾸기 (선택)<textarea id="bundle-overrides" rows="3" spellcheck="false" placeholder="pip-web name=pip-web-dr&#10;pip-web properties.dnsSettings.domainNameLabel=web-dr" ${locked}>${esc(m.overridesText)}</textarea><small class="field-hint">한 줄에 하나, “자원이름 경로=값”. 경로 name은 새 이름입니다. 목록 항목은 [name=이름]으로 고릅니다. ARM 참조와 Azure가 배정하는 값(IP 주소·FQDN)은 바꿀 수 없습니다.</small></label><div class="notice warning">원본 ID는 변경하지 않습니다. 선택한 ARM 참조·포함 ID와 PIP DNS 이름을 바꾸고, 정적 사설 IP·역방향 FQDN처럼 겹칠 수 있는 값은 새로 배정하거나 제외합니다. VNet 피어링·공유 Subnet·IP/FQDN 백엔드·인증서·업무 데이터는 복제하지 않습니다.</div>` : ""}
      ${m.mode === "update" ? `<label class="field">변경할 수 없는 값(위치·영역·SKU 등)이 백업과 다를 때<select id="bundle-immutable" ${locked}><option value="block" ${m.immutableConflict === "block" ? "selected" : ""}>복원 중단 (기본)</option><option value="keep-current" ${m.immutableConflict === "keep-current" ? "selected" : ""}>현재 값은 두고 나머지만 복원</option></select></label>` : ""}
      <label class="field">변경·장애 티켓<input type="text" id="bundle-ticket" maxlength="80" value="${esc(m.ticket)}" placeholder="INC / CHG 번호" ${locked}></label>
      <label class="field">복원 사유<textarea id="bundle-reason" rows="2" maxlength="500" ${locked}>${esc(m.reason)}</textarea></label>
      <label class="check-label boundary-check"><input id="bundle-ack" type="checkbox" ${m.ack ? "checked" : ""} ${locked}>공유 자원·IP/FQDN 대상·인증서·권한·업무 데이터는 복구하지 않습니다.</label>
      <button class="button" data-bundle="review" ${locked}>${icon("shield")}현재 재확인 · 계획 검토</button>
      ${plan && m.mode === "clone" ? `<div class="bundle-plan"><h3>원본 → 복제 대상 · ARM 참조 매핑</h3>${plan.target ? `<p class="clone-destination">${icon("arrow")}대상 위치 · ${esc(plan.target.subscriptionName)} / <b>${esc(plan.target.resourceGroup)}</b></p>` : ""}<ul>${plan.actions.map((action) => `<li title="${esc(action.resourceId)}">${esc(action.sourceResourceId.split("/").at(-1))} ${icon("arrow")} ${esc(action.name)}</li>`).join("")}</ul><small>공유 백엔드와 주소 참조는 원래 대상으로 유지됩니다.</small></div>` : ""}
      ${plan ? `<div class="bundle-plan"><h3>${icon("layers")}서버 확정 순서 · ${plan.actions.length}개</h3><ol>${plan.actions.map((action) => `<li><span>${esc(action.name)}</span><small>${action.wasPresent ? "업데이트" : "생성"}</small></li>`).join("")}</ol>${adjustmentList(plan)}<div class="execution-chain">${icon("shield")}전체 안전 백업${icon("arrow")}${icon("layers")}의존 순서 적용${icon("arrow")}${icon("check")}전체 사후 비교</div><small>만료 ${this.time(plan.expiresAt)} · 실패는 롤백이 아닙니다.</small><label class="field">최종 확인: ${confirmationLabel}<input type="text" id="bundle-confirm" autocomplete="off" value="${esc(m.confirmGroup)}" placeholder="${esc(confirmation)}" ${locked}></label><label class="check-label"><input id="bundle-approve" type="checkbox" ${m.approved ? "checked" : ""} ${locked}>이 계획으로 선택한 실제 자원을 변경합니다.</label><button class="button primary" data-bundle="execute" disabled>${icon("restore")}안전 백업 후 복원</button><details><summary>계획·승인 SHA</summary><code class="resource-id">${esc(plan.id)}<br>${esc(plan.approvalSha256)}</code></details></div>` : ""}
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

  updateGates() {
    const review = this.root.querySelector('[data-bundle="review"]');
    if (review) {
      try { bundleReviewInput(this.model, this.graph); review.disabled = this.model.busy; }
      catch (error) { review.disabled = true; review.title = error.message; }
    }
    const execute = this.root.querySelector('[data-bundle="execute"]');
    if (execute) execute.disabled = this.model.busy || !this.model.plan || !this.model.approved
      || this.model.confirmGroup !== this.confirmValue();
  }

  input(event) {
    const names = { "bundle-ticket": "ticket", "bundle-reason": "reason", "bundle-prefix": "clonePrefix", "bundle-overrides": "overridesText", "bundle-confirm": "confirmGroup", "bundle-query": "query" };
    const name = names[event.target.id];
    if (!name || this.model.busy) return;
    this.model[name] = event.target.value;
    if (["ticket", "reason", "clonePrefix", "overridesText"].includes(name)) this.invalidate();
    if (name === "query") {
      const start = event.target.selectionStart; this.render();
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
    if (target.id === "bundle-related") { m.includeRelated = target.checked; this.invalidate(); this.render(); this.root.querySelector("#bundle-related").focus(); }
    if (target.dataset.bundleRelated) {
      const id = target.dataset.bundleRelated;
      m.excludedRelated = target.checked ? m.excludedRelated.filter((item) => key(item) !== key(id)) : [...m.excludedRelated, id];
      this.invalidate(); this.render();
      [...this.root.querySelectorAll("[data-bundle-related]")].find((input) => input.dataset.bundleRelated === id)?.focus({ preventScroll: true });
    }
    if (target.id === "bundle-immutable") { m.immutableConflict = target.value; this.invalidate(); this.render(); this.root.querySelector("#bundle-immutable")?.focus(); }
    if (target.name === "bundle-mode") { m.mode = target.value; this.invalidate(); this.render(); this.root.querySelector(`[name="bundle-mode"][value="${m.mode}"]`).focus(); }
    if (target.id === "bundle-target-sub") {
      this.setTarget(target.value, "");
      this.render(); this.root.querySelector("#bundle-target-sub")?.focus();
    }
    if (target.id === "bundle-target-group") {
      this.setTarget(this.targetSubscriptionId(), target.value);
      this.render(); this.root.querySelector("#bundle-target-group")?.focus();
    }
    if (target.id === "bundle-ack") { m.ack = target.checked; this.invalidate(); this.render(); this.root.querySelector("#bundle-ack").focus(); }
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
    if (action === "execute" && (!m.plan || !m.approved || m.confirmGroup !== this.confirmValue())) throw new Error("최종 승인과 허용 범위 확인값을 확인하세요.");
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
