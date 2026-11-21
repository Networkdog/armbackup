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

function parseIpv4Int(ip) {
  const parts = String(ip || "").trim().split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return (((Number(parts[0]) << 24) >>> 0) + (Number(parts[1]) << 16) + (Number(parts[2]) << 8) + Number(parts[3])) >>> 0;
}

function formatIpv4Int(num) {
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
}

export function ipInCidrs(ip, cidrs = []) {
  const addr = parseIpv4Int(ip);
  if (addr === null || !Array.isArray(cidrs) || !cidrs.length) return false;
  for (const rawCidr of cidrs) {
    const [addrStr, prefixStr] = String(rawCidr || "").trim().split("/");
    const baseIp = parseIpv4Int(addrStr);
    const prefix = Number(prefixStr);
    if (baseIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
    const netStart = (baseIp & mask) >>> 0;
    const netEnd = (netStart | (~mask >>> 0)) >>> 0;
    if (addr >= netStart && addr <= netEnd) {
      if (prefix <= 29 && (addr === netStart || addr === netEnd)) return false;
      return true;
    }
  }
  return false;
}

export function suggestSampleIp(cidrs = [], sampleIps = [], avoidIps = []) {
  const avoid = new Set(["168.63.129.16", ...(avoidIps || []).map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean)]);
  const candidateCidrs = [...(cidrs || [])];
  if (!candidateCidrs.length) {
    const firstV4 = (sampleIps || []).find((ip) => parseIpv4Int(ip) !== null);
    if (firstV4) candidateCidrs.push(`${firstV4}/24`);
  } else if (sampleIps?.length) {
    candidateCidrs.sort((a, b) => Number(sampleIps.some((ip) => ipInCidrs(ip, [b]))) - Number(sampleIps.some((ip) => ipInCidrs(ip, [a]))));
  }
  for (const rawCidr of candidateCidrs) {
    const [addrStr, prefixStr] = String(rawCidr || "").trim().split("/");
    const baseIp = parseIpv4Int(addrStr);
    const prefix = Number(prefixStr);
    if (baseIp === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) continue;
    let effectivePrefix = prefix;
    let netStart = prefix === 0 ? 0 : (baseIp & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0;
    if (prefix < 24) {
      const matchedSample = (sampleIps || []).map(parseIpv4Int).find((n) => n !== null && ((n & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0) === netStart);
      effectivePrefix = 24;
      netStart = matchedSample !== undefined ? (matchedSample & 0xffffff00) >>> 0 : netStart;
    }
    const hostMask = effectivePrefix === 32 ? 0 : ((1 << (32 - effectivePrefix)) - 1) >>> 0;
    const netEnd = (netStart | hostMask) >>> 0;
    const firstUsable = (netStart + (effectivePrefix <= 29 ? 4 : 1)) >>> 0;
    const lastUsable = (netEnd - (effectivePrefix <= 30 ? 1 : 0)) >>> 0;
    if (firstUsable > lastUsable) continue;
    const preferredTop = Math.max(firstUsable, (netEnd - 5) >>> 0);
    for (let cur = preferredTop; cur >= firstUsable; cur--) {
      const cand = formatIpv4Int(cur);
      if (!avoid.has(cand)) return cand;
      if (cur === 0) break;
    }
    for (let cur = lastUsable; cur > preferredTop; cur--) {
      const cand = formatIpv4Int(cur);
      if (!avoid.has(cand)) return cand;
    }
  }
  return "";
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

function collectActionInputs(model, graph, selected, subnetLookup = null) {
  const clone = model.mode === "clone";
  const manual = parseOverrides(model.overridesText, selected);
  if (!clone && manual.some((entry) => entry.path === "name")) {
    throw new Error("리소스 이름(name) 변경은 복제 모드에서만 사용할 수 있습니다.");
  }
  const manualKeys = new Set(manual.map((entry) => `${key(entry.resourceId)}::${entry.path}`));
  const overrides = [...manual];
  const smartNames = model.smartNames || {};
  const smartDns = model.smartDnsLabels || {};
  const smartIps = model.smartPrivateIps || {};
  const smartKv = model.smartKeyVaultCerts || {};
  const smartPoolIps = model.smartPoolIps || {};
  const rawBindings = model.referenceBindings || {};

  const nodesById = new Map(selected.map((node) => [key(node.id), node]));
  const selectedIds = new Set(selected.map((node) => key(node.id)));
  const sharedEdges = (graph.edges || []).filter(
    (edge) => selectedIds.has(key(edge.from)) && !selectedIds.has(key(edge.to)) && edge.kind === "shared",
  );
  const desiredLoc = clone ? String(model.targetLocation || "").trim().toLowerCase().replace(/\s+/g, "") : "";
  const referenceBindings = [];
  const seenSources = new Set();
  for (const edge of sharedEdges) {
    const sourceId = edge.referenceId || edge.to;
    const sourceKey = key(sourceId);
    if (!sourceId || seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    const targetId = String(rawBindings[sourceKey] || "").trim();
    if (clone) {
      const refSub = sourceKey.startsWith("/subscriptions/") ? sourceKey.split("/")[2] : "";
      const crossSubSubnet = Boolean(model.targetSubscription && refSub && key(model.targetSubscription) !== refSub && sourceKey.includes("/subnets/"));
      const fromLoc = String(nodesById.get(key(edge.from))?.location || "").toLowerCase().replace(/\s+/g, "");
      const crossLocSubnet = Boolean(desiredLoc && fromLoc && fromLoc !== "global" && desiredLoc !== fromLoc && sourceKey.includes("/subnets/"));
      if ((crossSubSubnet || crossLocSubnet) && (!targetId || key(targetId) === sourceKey)) {
        throw new Error(`다른 구독·리전으로 복제하려면 공유 서브넷(${shortNetworkPath(sourceId)})의 연결 대상을 선택하세요.`);
      }
    }
    if (targetId && key(targetId) !== sourceKey) {
      referenceBindings.push({ sourceId, targetId });
    }
  }

  let hasBackendPools = false;
  const placeholderIps = {};
  for (const node of selected) {
    if (node.parentId) continue;
    if (clone) {
      const customName = String(smartNames[key(node.id)] || "").trim();
      if (customName && !manualKeys.has(`${key(node.id)}::name`)) {
        overrides.push({ resourceId: node.id, path: "name", value: customName });
        manualKeys.add(`${key(node.id)}::name`);
      }
    }
    const baseDns = node.cloneHints?.dnsLabel;
    if (baseDns) {
      const dnsPath = "properties.dnsSettings.domainNameLabel";
      const customDns = String(smartDns[key(node.id)] || "").trim();
      const autoDns = clone && !customDns && !model.clonePrefix && model.targetGroup
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
      const targetCidrs = subnetLookup?.get(key(boundTarget || fe.subnetId || ""))?.sub?.addressPrefixes || [];
      const outOfBoundCidr = Boolean(boundTarget && targetCidrs.length && !ipInCidrs(fe.privateIPAddress, targetCidrs));
      if (customIp && !manualKeys.has(`${key(node.id)}::${ipPath}`)) {
        overrides.push({ resourceId: node.id, path: ipPath, value: customIp });
        manualKeys.add(`${key(node.id)}::${ipPath}`);
      } else if (clone && fe.requiresStatic && (sharedSameSubnet || outOfBoundCidr) && !manualKeys.has(`${key(node.id)}::${ipPath}`)) {
        throw new Error(outOfBoundCidr
          ? `${node.name}: 대상 서브넷(${targetCidrs.join(", ")}) 대역에 맞는 프런트엔드 '${fe.name}'의 새 정적 사설 IP를 입력하세요.`
          : `${node.name}: 원본(${fe.privateIPAddress})과 같은 서브넷을 공유하므로 프런트엔드 '${fe.name}'의 새 정적 사설 IP를 입력하세요.`);
      }
    }
    for (const certName of node.cloneHints?.pfxCertificates || []) {
      const kvPath = `properties.sslCertificates[name=${certName}].properties.keyVaultSecretId`;
      const customKv = String(smartKv[`${key(node.id)}::${key(certName)}`] || "").trim();
      if (customKv && !manualKeys.has(`${key(node.id)}::${kvPath}`)) {
        overrides.push({ resourceId: node.id, path: kvPath, value: customKv });
        manualKeys.add(`${key(node.id)}::${kvPath}`);
      }
    }
    if (clone && node.cloneHints?.backendPools?.length) {
      hasBackendPools = true;
      if ((model.backendPoolMode || "placeholder") === "placeholder") {
        for (const pool of node.cloneHints.backendPools) {
          const pKey = `${key(node.id)}::${key(pool.name)}`;
          const customPoolIp = String(smartPoolIps[pKey] || "").trim();
          if (customPoolIp) placeholderIps[pKey] = customPoolIp;
        }
      }
    }
  }
  return { overrides, referenceBindings, hasBackendPools, placeholderIps };
}

export function bundleReviewInput(model, graph, subnetLookup = null) {
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
  const clone = model.mode === "clone";
  const rawTicket = String(model.ticket ?? "").trim();
  const rawReason = String(model.reason ?? "").trim();
  if (rawTicket && (rawTicket.length < 3 || String(model.ticket).length > 80)) {
    throw new Error("티켓은 비워 두거나 3~80자로 입력하세요.");
  }
  if (rawReason && (rawReason.length < 5 || String(model.reason).length > 500)) {
    throw new Error("사유는 비워 두거나 5~500자로 입력하세요.");
  }
  if (model.ack === false) throw new Error("공유 자원·주소·업무 데이터는 복구하지 않는다는 경계를 확인하세요.");
  const ticket = rawTicket || (clone ? "CLONE" : "RESTORE");
  const reason = rawReason || (clone ? "콘솔 독립 설정 복제" : "콘솔 백업 형상 복원");
  const { overrides, referenceBindings, hasBackendPools, placeholderIps } = collectActionInputs(model, graph, selected, subnetLookup);
  const targetLocation = clone && String(model.targetLocation || "").trim() ? String(model.targetLocation).trim() : "";
  const poolMode = clone && model.backendPoolMode && ["placeholder", "empty", "keep"].includes(model.backendPoolMode)
    && (hasBackendPools || model.backendPoolMode !== "placeholder")
    ? model.backendPoolMode
    : "";
  return { runId: model.runId, resourceIds: model.selected.map((id) => graph.nodes.find((node) => key(node.id) === key(id))?.id).filter(Boolean),
    includeRelated: model.includeRelated, mode: model.mode, ticket,
    reason, acknowledgeExternal: true,
    ...(model.includeRelated && model.excludedRelated?.length ? { excludedRelated: model.excludedRelated } : {}),
    ...(overrides.length ? { overrides } : {}),
    ...(referenceBindings.length ? { referenceBindings } : {}),
    ...(targetLocation ? { targetLocation } : {}),
    ...(poolMode ? { backendPoolMode: poolMode } : {}),
    ...(clone && Object.keys(placeholderIps).length ? { placeholderIps } : {}),
    ...(model.mode === "update" && ["keep-current", "block"].includes(model.immutableConflict) ? { immutableConflict: model.immutableConflict } : {}),
    ...(clone && model.clonePrefix ? { clonePrefix: model.clonePrefix } : {}),
    ...(clone && model.targetGroup ? { targetSubscriptionId: model.targetSubscription, targetResourceGroup: model.targetGroup } : {}) };
}

const CHANGE_LABELS = {
  overridden: "값 변경",
  renamed: "이름 변경",
  rebound: "대상 연결 변경",
  placeholder: "임시 샘플 값",
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

function dedupePlanAdjustments(plan) {
  const actions = plan?.actions || [];
  const poolActions = new Set(
    actions
      .filter((a) => a.resourceType === "microsoft.network/loadbalancers/backendaddresspools" || String(a.resourceId || "").toLowerCase().includes("/backendaddresspools/"))
      .flatMap((a) => [key(a.resourceId || ""), key(a.name || "")].filter(Boolean)),
  );
  return actions.flatMap((action) =>
    (action.adjustments || []).filter((item) => {
      const p = String(item.path || "");
      if (action.resourceType !== "microsoft.network/loadbalancers/backendaddresspools" && p.startsWith("properties.backendAddressPools[name=")) {
        const pname = p.split("[name=", 2)[1]?.split("]", 1)[0] || "";
        const childKey = action.resourceId ? `${key(action.resourceId)}/backendaddresspools/${key(pname)}` : key(pname);
        if (pname && (poolActions.has(childKey) || poolActions.has(key(pname)))) return false;
      }
      return true;
    }).map((item) => ({ name: action.name, ...item })),
  );
}

export function nonRestorableItems(plan) {
  return dedupePlanAdjustments(plan).filter(
    (item) => item.change === "dropped" || item.change === "kept-current" || item.change === "placeholder",
  );
}

export function adjustmentList(plan) {
  const deduped = dedupePlanAdjustments(plan);
  const rows = [
    ...deduped.map((item) => `<li title="${esc(item.reason)}"><span>${esc(item.name)} · ${esc(item.path)}</span><span class="relation-label ${item.change === "placeholder" ? "placeholder" : ""}">${esc(CHANGE_LABELS[item.change] || item.change)}</span><small>${esc(item.reason)}</small></li>`),
    ...(plan.actions || []).flatMap((action) => (action.warnings || []).map((text) => `<li><span>${esc(action.name)}</span><span class="relation-label shared">주의</span><small>${esc(text)}</small></li>`)),
  ];
  const skipped = nonRestorableItems(plan).length;
  const heading = skipped
    ? `복원·복제 시 달라지는 값 (자동 보정·제외·유지 ${skipped}건 포함)`
    : "복원·복제 시 달라지는 값";
  return rows.length ? `<h4>${heading}</h4><ul class="adjustment-list">${rows.join("")}</ul>` : "";
}

export class BundlePanel {
  constructor(root, { api, state, model = null, timezone = "Asia/Seoul", run, refresh, onLogs, notify = null, writeLocked = null, embedded = false, intent = "" }) {
    this.root = root; this.api = api; this.state = state; this.run = run; this.refresh = refresh;
    this.onLogs = onLogs; this.notify = notify; this.writeLocked = writeLocked;
    this.timezone = timezone; this.embedded = embedded; this.intent = intent;
    this.prefilledKeys = new Set();
    const defaults = {
      runId: "current", selected: [], includeRelated: intent === "clone", excludedRelated: [], overridesText: "",
      targetLocation: "", backendPoolMode: "placeholder", smartNames: {}, smartDnsLabels: {}, smartPrivateIps: {},
      smartPoolIps: {}, smartKeyVaultCerts: {}, referenceBindings: {}, customBindingModes: {},
      immutableConflict: "keep-current", query: "",
      mode: intent === "clone" ? "clone" : "update", clonePrefix: "copy", targetSubscription: "", targetGroup: "",
      ticket: "", reason: "", ack: true, confirmGroup: "", approved: false,
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

  resetContextInputs() {
    this.model.referenceBindings = {};
    this.model.customBindingModes = {};
    this.model.smartNames = {};
    this.model.smartPrivateIps = {};
    this.model.smartDnsLabels = {};
    this.model.smartPoolIps = {};
    this.model.smartKeyVaultCerts = {};
    this.prefilledKeys?.clear();
    this.autoPrefilledIps?.clear();
    this.autoPrefilledDns?.clear();
    this.autoPrefilledPools?.clear();
  }

  async setPlanContext({ runId, resourceIds, intent, defaultRestoreMode = "update" }) {
    if (!this.alive || this.model.busy) return;
    const nextMode = intent === "clone" ? "clone" : defaultRestoreMode;
    const runChanged = Boolean(runId) && runId !== this.model.runId;
    const selectionChanged = Array.isArray(resourceIds)
      && JSON.stringify(resourceIds.map(key)) !== JSON.stringify(this.model.selected.map(key));
    const modeChanged = nextMode !== this.model.mode || intent !== this.intent;
    this.intent = intent;
    this.model.mode = nextMode;
    this.model.includeRelated = nextMode === "clone";
    if (nextMode !== "clone") this.model.excludedRelated = [];
    if (Array.isArray(resourceIds)) this.model.selected = [...resourceIds];
    if (selectionChanged || modeChanged) {
      this.resetContextInputs();
    }
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
    if (!this.graph) return;
    const m = this.model, graph = this.graph;
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set((m.selected || []).map(key));
    const baseChosen = bundleSelection(graph, m.selected || [], true, []);
    const baseIds = new Set(baseChosen.map((node) => key(node.id)));
    const relatedEdges = graph.edges.filter(
      (edge) => edge.kind === "reference" && baseIds.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)),
    );
    if (m.mode === "clone") {
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
      return;
    }
    if (this.intent === "restore" && m.selected?.length === 1 && this.state?.current) {
      const rootObs = this.state.current[key(m.selected[0])];
      if (rootObs?.status === "missing") m.mode = "create";
      else if (rootObs?.status === "present") m.mode = "update";
    }
    if (this.state?.current && relatedEdges.length) {
      const missingRelated = relatedEdges
        .filter((edge) => this.state.current[key(edge.to)]?.status === "missing")
        .map((edge) => edge.to);
      if (missingRelated.length) {
        const missingKeys = new Set(missingRelated.map(key));
        if (!m.includeRelated) {
          m.includeRelated = true;
          const presentExtras = relatedEdges
            .filter((edge) => !missingKeys.has(key(edge.to)))
            .map((edge) => edge.to);
          m.excludedRelated = [...new Set([...(m.excludedRelated || []), ...presentExtras])];
        } else {
          m.excludedRelated = (m.excludedRelated || []).filter((id) => !missingKeys.has(key(id)));
        }
      }
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
    if (chosen.some((node) => node.cloneHints?.backendPools?.length)) return true;
    const ids = new Set(chosen.map((node) => key(node.id)));
    return graph.edges.some((edge) => ids.has(key(edge.from)) && !ids.has(key(edge.to)) && edge.kind === "shared"
      && String(edge.referenceId || edge.to).toLowerCase().includes("/microsoft.network/virtualnetworks/"));
  }

  networkLookup() {
    const sid = this.targetSubscriptionId();
    const vnets = this.targets?.networks?.[sid] || [];
    const subnetLookup = new Map();
    const vnetLookup = new Map();
    for (const vnet of vnets) {
      vnetLookup.set(key(vnet.id), vnet);
      for (const sub of vnet.subnets || []) subnetLookup.set(key(sub.id), { vnet, sub });
    }
    return { sid, vnets, subnetLookup, vnetLookup };
  }

  prefillSamples() {
    if (!this.graph || !Array.isArray(this.graph.nodes)) return;
    const m = this.model;
    this.prefilledKeys ||= new Set();
    this.autoPrefilledIps ||= new Map();
    this.autoPrefilledDns ||= new Map();
    this.autoPrefilledPools ||= new Map();
    if (m.mode !== "clone") {
      for (const [ipKey, autoVal] of this.autoPrefilledIps.entries()) {
        if (m.smartPrivateIps?.[ipKey] === autoVal) {
          delete m.smartPrivateIps[ipKey];
          this.prefilledKeys.delete(`ip:${ipKey}`);
        }
      }
      this.autoPrefilledIps.clear();
      for (const [dnsKey, autoVal] of this.autoPrefilledDns.entries()) {
        if (m.smartDnsLabels?.[dnsKey] === autoVal) {
          delete m.smartDnsLabels[dnsKey];
        }
      }
      this.autoPrefilledDns.clear();
      return;
    }
    const chosen = bundleSelection(this.graph, m.selected || [], m.includeRelated, m.excludedRelated);
    const { subnetLookup, vnetLookup } = this.networkLookup();
    const bindings = m.referenceBindings || {};
    m.smartPrivateIps ||= {};
    m.smartDnsLabels ||= {};
    m.smartPoolIps ||= {};
    for (const node of chosen) {
      if (node.parentId) continue;
      if (node.cloneHints?.dnsLabel) {
        const dKey = key(node.id);
        const curDns = m.smartDnsLabels[dKey];
        if (curDns === undefined || this.autoPrefilledDns.get(dKey) === curDns) {
          const suggestedDns = suggestDnsLabel(node.cloneHints.dnsLabel, m.clonePrefix || "", m.targetGroup || "copy");
          if (suggestedDns) {
            m.smartDnsLabels[dKey] = suggestedDns;
            this.autoPrefilledDns.set(dKey, suggestedDns);
          }
        }
      }
      for (const fe of node.cloneHints?.staticFrontends || []) {
        const ipKey = `${key(node.id)}::${key(fe.name)}`;
        const subLow = key(fe.subnetId || "");
        const boundSub = String(bindings[subLow] || "").trim();
        const sameSubnet = Boolean(subLow) && (!boundSub || key(boundSub) === subLow);
        const cidrs = subnetLookup.get(key(boundSub || fe.subnetId || ""))?.sub?.addressPrefixes || [];
        const outOfCidr = Boolean(boundSub && cidrs.length && !ipInCidrs(fe.privateIPAddress, cidrs));
        const needsNewIp = fe.requiresStatic && (sameSubnet || outOfCidr);
        const curIp = m.smartPrivateIps[ipKey];
        if (needsNewIp && (curIp === undefined || this.autoPrefilledIps.get(ipKey) === curIp)) {
          const avoid = sameSubnet ? [fe.privateIPAddress] : [];
          const sampleIp = suggestSampleIp(cidrs, [fe.privateIPAddress], avoid) || fe.suggestedPrivateIp || "";
          if (sampleIp) {
            m.smartPrivateIps[ipKey] = sampleIp;
            this.prefilledKeys.add(`ip:${ipKey}`);
            this.autoPrefilledIps.set(ipKey, sampleIp);
          }
        } else if (!needsNewIp && this.autoPrefilledIps.get(ipKey) === curIp) {
          delete m.smartPrivateIps[ipKey];
          this.prefilledKeys.delete(`ip:${ipKey}`);
          this.autoPrefilledIps.delete(ipKey);
        }
      }
      for (const pool of node.cloneHints?.backendPools || []) {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        const curPool = m.smartPoolIps[pKey];
        if (curPool === undefined || this.autoPrefilledPools.get(pKey) === curPool) {
          const vnetLow = key(pool.vnetId || "");
          const boundVnet = String(bindings[vnetLow] || pool.vnetId || "");
          const vnetMeta = vnetLookup.get(key(boundVnet));
          const cidrs = (vnetMeta?.subnets || []).flatMap((s) => s.addressPrefixes || []);
          const sampleIp = suggestSampleIp(cidrs, pool.sampleIps || [], pool.sampleIps || []) || pool.suggestedPlaceholderIp || "";
          if (sampleIp) {
            m.smartPoolIps[pKey] = sampleIp;
            this.prefilledKeys.add(`pool:${pKey}`);
            this.autoPrefilledPools.set(pKey, sampleIp);
          }
        }
      }
    }
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
    this.prefillSamples();
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
    const chosen = bundleSelection(graph, m.selected, m.includeRelated, m.excludedRelated);
    const topChosen = chosen.filter((node) => !node.parentId);
    const locked = m.busy ? "disabled" : "";
    const run = this.state.runs.find((item) => item.id === m.runId);
    const gatewayNode = chosen.find((node) => node.resourceType === "microsoft.network/applicationgateways");
    const gatewayPresent = gatewayNode ? this.state.current?.[key(gatewayNode.id)]?.status : "";
    const pillLabel = isClone
      ? `새 리소스 ${topChosen.length}개`
      : (m.mode === "create" ? "삭제 리소스 재생성" : "기존 설정 업데이트");
    this.root.innerHTML = `<section class="panel restore-plan-panel" aria-label="${isClone ? "복제 설정" : "복원 설정"}">
      <div class="panel-header">
        <h2 class="panel-title">${icon(isClone ? "layers" : "restore")}${isClone ? "복제 설정" : "복원 설정"} <span class="count-pill">${esc(pillLabel)}</span></h2>
        <div class="panel-header-actions">
          ${run ? `<span class="panel-header-note">${this.time(run.capturedAt)} 백업 기준</span>` : ""}
          ${gatewayNode && !isClone ? `<button type="button" class="button small" data-bundle="diagnose" data-id="${esc(gatewayNode.id)}" ${m.busy || gatewayPresent !== "present" ? "disabled" : ""}>${icon("pulse")}백엔드 · WAF 진단</button>` : ""}
        </div>
      </div>
      <div class="panel-body restore-plan-body">
        ${m.error ? `<div class="notice error" role="alert">${icon("alert")}${esc(m.error)}</div>` : ""}
        ${this.reviewForm(locked)}
        ${this.resultView()}
        ${this.diagnostics ? this.diagnosticView() : ""}
      </div>
    </section>`;
  }

  resultView() {
    const result = this.model.result;
    if (!result) return "";
    const skippedCount = Array.isArray(result.omittedOrKept) ? result.omittedOrKept.length : 0;
    const skippedText = skippedCount
      ? ` · 복원 불가/불변 속성 ${skippedCount}개는 제외 또는 현재 값 유지`
      : "";
    return `<section class="bundle-result"><h2>${icon("check")}${result.safetyRunId ? "선택한 관리 설정 적용·사후 비교 완료" : "묶음 백업 완료"}</h2><code>${esc(result.safetyRunId || result.runId)}</code><span>안전 백업 / 작업 ID는 로그에서 추적${esc(skippedText)} · 서비스·주소·업무 데이터는 별도 검증</span><button class="button small" data-bundle="logs">${icon("logs")}실행 로그</button></section>`;
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
        const resolvedSid = data.subscriptionId || sid || data.currentSubscription;
        if (resolvedSid) t.groups[resolvedSid] = Array.isArray(data.resourceGroups) ? data.resourceGroups : [];
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

  confirmValue() { return this.model.plan?.confirmation || this.state?.workspace?.scopeConfirmation || this.state?.workspace?.resourceGroup || ""; }

  targetFields(locked) {
    const m = this.model, t = this.targets;
    const prefixField = `<label class="field">이름 접두사${m.targetGroup ? " (선택)" : ""}<input type="text" id="bundle-prefix" maxlength="20" value="${esc(m.clonePrefix)}" placeholder="${m.targetGroup ? "비워 두면 원본 이름 유지" : "예: copy"}" ${locked}></label>`;
    if (!t || (t.loading && !t.loaded)) return `<div class="operation-strip" role="status"><span class="spinner"></span>복제할 수 있는 구독·리소스 그룹을 조회하고 있습니다.</div>${prefixField}`;
    if (t.error) return `<div class="notice error" role="alert">${esc(t.error)}</div><button class="button small" data-bundle="retarget" ${locked}>${icon("refresh")}대상 다시 조회</button>${prefixField}`;
    if (!t.enabled) return `<div class="smart-clone-grid">${prefixField}</div><small class="field-hint">구성된 범위 안에서 접두사를 붙여 복제합니다.</small>`;
    const sid = this.targetSubscriptionId(), groups = t.groups[sid];
    const names = new Map(t.subscriptions.map((item) => [item.subscriptionId.toLowerCase(), item.name]));
    const graphNodes = this.graph?.nodes || [];
    const chosen = graphNodes.length ? bundleSelection(this.graph, m.selected || [], m.includeRelated, m.excludedRelated) : [];
    const sourceLocations = [...new Set(chosen.map((node) => node.location).filter((loc) => loc && loc.toLowerCase() !== "global"))];
    const groupLocations = (groups || []).map((group) => group.location).filter(Boolean);
    const locationChoices = [...new Set([...sourceLocations, ...groupLocations, ...COMMON_LOCATIONS].map((loc) => loc.toLowerCase()))];
    const defaultLocLabel = sourceLocations.length ? `원본 리전 (${sourceLocations.join(", ")})` : "원본 리전 유지";
    const crossSub = Boolean(m.targetSubscription && m.targetSubscription.toLowerCase() !== t.currentSubscription.toLowerCase());
    return `<div class="clone-target">
      <div class="smart-clone-grid">
        <label class="field">대상 구독<select id="bundle-target-sub" ${locked}>${t.subscriptions.map((item) => `<option value="${esc(item.subscriptionId)}" ${item.subscriptionId.toLowerCase() === sid.toLowerCase() ? "selected" : ""}>${esc(item.name)}${item.subscriptionId.toLowerCase() === t.currentSubscription.toLowerCase() ? " · 현재" : ""}</option>`).join("")}</select></label>
        <label class="field">대상 리소스 그룹<select id="bundle-target-group" ${locked || !groups ? "disabled" : ""}>${groups ? `<option value="">같은 리소스 그룹 · 접두사 사용</option>${groups.map((group) => `<option value="${esc(group.name)}" ${group.name.toLowerCase() === m.targetGroup.toLowerCase() ? "selected" : ""}>${esc(group.name)}${group.location ? ` · ${esc(group.location)}` : ""}</option>`).join("")}` : "<option>불러오는 중…</option>"}</select></label>
        ${chosen.length ? `<label class="field">대상 리전<select id="bundle-target-location" ${locked}><option value="" ${!m.targetLocation ? "selected" : ""}>${esc(defaultLocLabel)}</option>${locationChoices.map((loc) => `<option value="${esc(loc)}" ${(m.targetLocation || "").toLowerCase() === loc ? "selected" : ""}>${esc(loc)}</option>`).join("")}</select></label>` : ""}
        ${prefixField}
      </div>
      ${crossSub ? `<small class="field-hint">타 구독(${esc(names.get(sid.toLowerCase()) || sid)}) 복제 시 구독 경계를 넘는 공유 참조는 쓸 수 없어 연관 리소스를 함께 복제하고 대상 구독 서브넷을 연결합니다.</small>` : m.targetGroup ? `<small class="field-hint">${esc(names.get(sid.toLowerCase()) || sid)} / ${esc(m.targetGroup)} 에 생성합니다 (접두사를 비우면 원본 이름 유지).</small>` : ""}
    </div>`;
  }

  relatedContext() {
    const graph = this.graph;
    if (!graph || !Array.isArray(graph.nodes)) return { chosen: [], topChosen: [], relatedEdges: [], nodes: new Map() };
    const m = this.model;
    const nodes = new Map(graph.nodes.map((node) => [key(node.id), node]));
    const directIds = new Set((m.selected || []).map(key));
    const baseChosen = bundleSelection(graph, m.selected || [], true, []);
    const baseIds = new Set(baseChosen.map((node) => key(node.id)));
    const relatedEdges = [...new Map((graph.edges || [])
      .filter((edge) => edge.kind === "reference" && baseIds.has(key(edge.from)) && nodes.has(key(edge.to)) && !directIds.has(key(edge.to)))
      .map((edge) => [key(edge.to), edge])).values()];
    const chosen = bundleSelection(graph, m.selected || [], m.includeRelated, m.excludedRelated);
    const topChosen = chosen.filter((node) => !node.parentId);
    return { chosen, topChosen, relatedEdges, nodes };
  }

  decisionSummaryHtml(locked) {
    const { chosen, topChosen, relatedEdges, nodes } = this.relatedContext();
    if (!chosen.length) return "";
    const m = this.model;
    const isClone = m.mode === "clone";
    if (isClone) {
      const prefix = m.clonePrefix || "";
      const smartNames = m.smartNames || {};
      const chips = topChosen.map((node) => {
        const custom = String(smartNames[key(node.id)] || "").trim();
        const targetName = custom || (prefix ? `${prefix}-${node.name}` : node.name);
        return `<span class="clone-name-chip" title="${esc(node.id)}">${esc(node.name)} ${icon("arrow")} <strong data-preview-for="${esc(key(node.id))}">${esc(targetName)}</strong></span>`;
      }).join("");
      const ids = new Set(chosen.map((node) => key(node.id)));
      const hasAddresses = (this.graph?.addresses || []).some((addr) => ids.has(key(addr.from)));
      const gatewayWithAddresses = hasAddresses && topChosen.some((node) => node.resourceType === "microsoft.network/applicationgateways");
      const subNote = gatewayWithAddresses
        ? "원본은 변경하지 않으며 전용 공용 IP·하위 구성은 자동 동반 생성됩니다. 생성 후 원본 백엔드 주소로 상태 프로브가 연결됩니다."
        : "원본은 변경하지 않으며 전용 공용 IP·하위 구성은 자동으로 함께 생성됩니다.";
      return `<div class="decision-summary">
        <div class="clone-name-preview" aria-label="생성될 복제 리소스 이름">${chips}</div>
        <span class="small-text muted">${esc(subNote)}</span>
      </div>`;
    }

    const alerts = [];
    for (const node of topChosen) {
      const obs = this.state?.current?.[key(node.id)];
      if (m.mode === "update" && obs?.status === "present") {
        if (node.resourceType === "microsoft.network/applicationgateways" && obs.operationalState === "Stopped") {
          alerts.push(`${node.name}: 현재 중지(Stopped) 상태입니다. 복원(PUT) 적용 시 Azure 동작에 따라 자동으로 시작(Running)됩니다.`);
        }
        if (["Failed", "Canceled"].includes(obs.provisioningState)) {
          alerts.push(`${node.name}: 현재 프로비저닝 ${obs.provisioningState} 상태입니다. 정상 백업 형상을 재적용해 복구합니다.`);
        }
      }
    }
    const leftOut = new Set((m.excludedRelated || []).map(key));
    const missingCompanions = relatedEdges
      .filter((edge) => this.state?.current?.[key(edge.to)]?.status === "missing")
      .map((edge) => nodes.get(key(edge.to))?.name)
      .filter(Boolean);
    const presentCompanionEdges = relatedEdges.filter(
      (edge) => this.state?.current?.[key(edge.to)]?.status !== "missing",
    );
    const namesText = topChosen.map((n) => n.name).join(", ");
    const headline = m.mode === "create"
      ? `삭제된 ${namesText} 리소스를 원래 위치·이름으로 다시 생성합니다.`
      : `${namesText} 설정을 선택한 백업 시점으로 되돌립니다.`;
    const subline = m.mode === "create"
      ? (missingCompanions.length ? `함께 삭제된 연결 리소스(${missingCompanions.join(", ")})도 자동으로 동반 복원합니다.` : "연결된 기존 공용 IP·네트워크는 그대로 유지하고 재연결합니다.")
      : "적용 전 현재 상태를 안전 백업으로 먼저 보관하며, 생성 후 불변 속성은 현재 값을 유지합니다.";
    const companionToggles = this.embedded && presentCompanionEdges.length
      ? `<div class="companion-inline"><span class="companion-inline-label">연결된 리소스도 백업 시점으로 되돌리기 (선택)</span>${presentCompanionEdges.map((edge) => {
          const rNode = nodes.get(key(edge.to));
          const checked = m.includeRelated && !leftOut.has(key(edge.to));
          return `<label class="check-label"><input type="checkbox" data-restore-companion="${esc(edge.to)}" ${checked ? "checked" : ""} ${locked}><span>${esc(rNode?.name || edge.to)} <small>(${esc(rNode?.label || "")})</small></span></label>`;
        }).join("")}</div>`
      : "";
    return `<div class="decision-summary">
      <strong>${esc(headline)}</strong>
      <span class="small-text muted">${esc(subline)}</span>
      ${alerts.map((text) => `<p class="decision-alert" role="note">${icon("alert")}<span>${esc(text)}</span></p>`).join("")}
      ${companionToggles}
    </div>`;
  }

  smartCloneFields(locked) {
    const { chosen, topChosen, relatedEdges, nodes } = this.relatedContext();
    if (!chosen.length) return "";
    const graph = this.graph;
    const m = this.model;
    const selectedIds = new Set(chosen.map((node) => key(node.id)));
    const leftOut = new Set((m.excludedRelated || []).map(key));
    const smartDns = m.smartDnsLabels || {};
    const smartIps = m.smartPrivateIps || {};
    const bindings = m.referenceBindings || {};
    const customModes = m.customBindingModes || {};
    const prefix = m.clonePrefix || "";

    const { sid, vnets, subnetLookup, vnetLookup } = this.networkLookup();
    const effectiveLoc = (m.targetLocation || chosen.find((n) => n.location && n.location.toLowerCase() !== "global")?.location || "").toLowerCase().replace(/\s+/g, "");
    const matchingVnets = effectiveLoc
      ? vnets.filter((v) => !v.location || v.location.toLowerCase().replace(/\s+/g, "") === effectiveLoc)
      : vnets;

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
      return `<div class="field"><label>${isSubnet ? "연결할 서브넷" : "연결할 가상 네트워크"} (${esc(fromName)})${mustRebind ? " — 필수" : ""}${options.length && !customModes[refLow] && inList ? `<select data-smart-binding="${esc(refId)}" ${locked}><option value="" ${!boundVal ? "selected" : ""}>${mustRebind ? "대상 환경의 네트워크를 선택하세요…" : `원본 그대로 공유 (${shortNetworkPath(refId)})`}</option>${options.map((opt) => `<option value="${esc(opt.id)}" ${key(opt.id) === key(boundVal) ? "selected" : ""}>${esc(opt.label)}</option>`).join("")}<option value="__custom__">직접 ARM ID 입력…</option></select>` : ""}${useCustom ? `<input type="text" data-smart-binding-custom="${esc(refId)}" value="${esc(boundVal)}" placeholder="/subscriptions/.../providers/Microsoft.Network/virtualNetworks/...${isSubnet ? "/subnets/..." : ""}" ${locked}>` : ""}</label>${mustRebind && !options.length ? '<small class="field-hint">대상 구독·리전의 서브넷 ARM ID를 입력하세요.</small>' : ""}</div>`;
    }).join("");

    const shareableEdges = !this.isCrossBoundary()
      ? relatedEdges.filter((edge) => edge.relation !== "required" && edge.relationClass !== "exclusive")
      : [];
    const shareableFields = shareableEdges.map((edge) => {
      const rNode = nodes.get(key(edge.to));
      const sharedMode = !m.includeRelated || leftOut.has(key(edge.to));
      return `<div class="field"><label>${esc(rNode?.label || "연관 정책")} 처리 (${esc(rNode?.name || edge.to)})<select data-shareable-mode="${esc(edge.to)}" ${locked}><option value="clone" ${!sharedMode ? "selected" : ""}>새 리소스로 함께 복제 (독립 운영)</option><option value="share" ${sharedMode ? "selected" : ""}>원본 리소스 그대로 공유</option></select></label></div>`;
    }).join("");

    const poolNodes = topChosen.filter((node) => node.cloneHints?.backendPools?.length);
    const poolField = poolNodes.length ? (() => {
      const poolMode = m.backendPoolMode || "placeholder";
      const autoIps = poolNodes.flatMap((node) => (node.cloneHints.backendPools || []).map((pool) => {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        if (m.smartPoolIps?.[pKey]) return m.smartPoolIps[pKey];
        const vnetMeta = vnetLookup.get(key(bindings[key(pool.vnetId || "")] || pool.vnetId || ""));
        const cidrs = (vnetMeta?.subnets || []).flatMap((s) => s.addressPrefixes || []);
        return suggestSampleIp(cidrs, pool.sampleIps || [], pool.sampleIps || []) || pool.suggestedPlaceholderIp || "";
      })).filter(Boolean);
      const autoLabel = autoIps.length && !this.isCrossBoundary() ? ` · ${autoIps[0]} 자동 배정` : "";
      return `<div class="field"><label>백엔드 풀 구성 (${esc(poolNodes.map((n) => n.name).join(", "))})<select id="bundle-pool-mode" ${locked}><option value="placeholder" ${poolMode === "placeholder" ? "selected" : ""}>임시 사설 IP로 안전 생성 (권장${esc(autoLabel)})</option><option value="empty" ${poolMode === "empty" ? "selected" : ""}>빈 백엔드 풀로 생성 (생성 후 직접 연결)</option><option value="keep" ${poolMode === "keep" ? "selected" : ""}>원본 백엔드 IP 그대로 유지 (충돌 주의)</option></select></label></div>`;
    })() : "";

    const dnsFields = topChosen.filter((node) => node.cloneHints?.dnsLabel).map((node) => {
      const baseDns = node.cloneHints.dnsLabel;
      const currentVal = smartDns[key(node.id)] ?? "";
      const autoHint = suggestDnsLabel(baseDns, prefix || "copy", m.targetGroup);
      return `<div class="field"><label>공용 IP DNS 레이블 (${esc(node.name)})<input type="text" data-smart-dns="${esc(node.id)}" maxlength="63" value="${esc(currentVal)}" placeholder="${esc(autoHint || baseDns)}" ${locked}></label><small class="field-hint">리전 전체에서 유일해야 합니다 (원본: ${esc(baseDns)}).</small></div>`;
    }).join("");

    const requiredIpFields = topChosen.flatMap((node) => (node.cloneHints?.staticFrontends || []).flatMap((fe) => {
      if (!fe.requiresStatic) return [];
      const ipKey = `${key(node.id)}::${key(fe.name)}`;
      const currentIp = smartIps[ipKey] ?? "";
      const subLow = key(fe.subnetId || "");
      const boundSub = String(bindings[subLow] || "").trim();
      const sameSubnet = Boolean(subLow) && (!boundSub || key(boundSub) === subLow);
      const targetSubMeta = subnetLookup.get(key(boundSub || fe.subnetId || ""));
      const cidrs = targetSubMeta?.sub?.addressPrefixes || [];
      const outOfCidr = Boolean(boundSub && cidrs.length && !ipInCidrs(fe.privateIPAddress, cidrs));
      if (!sameSubnet && !outOfCidr && !currentIp) return [];
      const cidrHint = cidrs.length ? cidrs.join(", ") : "대상 서브넷";
      const sampleIp = suggestSampleIp(cidrs, [fe.privateIPAddress], sameSubnet ? [fe.privateIPAddress] : []) || fe.suggestedPrivateIp || "";
      const restoreSample = !currentIp && sampleIp
        ? `<div class="sample-bar"><button type="button" class="sample-chip" data-sample-field="smartPrivateIps" data-sample-key="${esc(ipKey)}" data-sample-value="${esc(sampleIp)}" ${locked}>추천 IP 입력: ${esc(sampleIp)}</button></div>`
        : "";
      return [`<div class="field"><label>사설 프런트엔드 정적 IP (${esc(fe.name)}) — 필수<input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(currentIp)}" placeholder="${esc(sampleIp || "예: 10.0.1.250")}" ${locked}></label>${restoreSample}<small class="field-hint">Application Gateway v2는 정적 IP가 필수입니다 (${esc(cidrHint)} 대역 · 원본 ${esc(fe.privateIPAddress)} 제외).</small></div>`];
    })).join("");

    const pfxFields = this.pfxCertificateFields(topChosen, locked);
    const decisionBlocks = [bindingFields, shareableFields, poolField, requiredIpFields, dnsFields, pfxFields].filter(Boolean);
    return decisionBlocks.length ? `<div class="smart-clone-grid">${decisionBlocks.join("")}</div>` : "";
  }

  pfxCertificateFields(topChosen, locked) {
    const m = this.model;
    if (m.mode === "update") return "";
    const smartKv = m.smartKeyVaultCerts || {};
    return topChosen.flatMap((node) => (node.cloneHints?.pfxCertificates || []).map((certName) => {
      const kvKey = `${key(node.id)}::${key(certName)}`;
      const currentKv = smartKv[kvKey] ?? "";
      return `<div class="field"><label>SSL 인증서 Key Vault URI (${esc(certName)} · 선택)<input type="text" data-smart-kv="${esc(kvKey)}" value="${esc(currentKv)}" placeholder="https://<keyvault>.vault.azure.net/secrets/<cert>" ${locked}></label><small class="field-hint">PFX 비밀값은 백업에 없습니다. 비워 두면 리스너를 임시 HTTP로 생성해 라우팅 규칙을 모두 보존합니다.</small></div>`;
    })).join("");
  }

  restorePropertyFields(locked) {
    const { topChosen } = this.relatedContext();
    if (!topChosen.length || this.model.mode === "clone") return "";
    const m = this.model;
    const bindings = m.referenceBindings || {};
    const liveSubnetRebinds = [];
    if (m.mode === "update" && this.state?.current) {
      for (const node of topChosen) {
        const liveGwIps = this.state.current[key(node.id)]?.raw?.properties?.gatewayIPConfigurations;
        if (!Array.isArray(liveGwIps)) continue;
        for (const gwSub of node.cloneHints?.gatewaySubnets || []) {
          const liveMatch = liveGwIps.find((item) => key(item?.name || "") === key(gwSub.name));
          const liveSubId = liveMatch?.properties?.subnet?.id;
          if (liveSubId && gwSub.subnetId && key(liveSubId) !== key(gwSub.subnetId)) {
            const curBound = bindings[key(gwSub.subnetId)] || "";
            liveSubnetRebinds.push(`<div class="field"><label>게이트웨이 서브넷 충돌 해소 (${esc(node.name)})<input type="text" data-smart-binding-custom="${esc(gwSub.subnetId)}" value="${esc(curBound)}" placeholder="${esc(liveSubId)}" ${locked}></label><div class="sample-bar"><button type="button" class="sample-chip" data-sample-field="referenceBindings" data-sample-key="${esc(key(gwSub.subnetId))}" data-sample-value="${esc(liveSubId)}" ${locked}>현재 서브넷 유지: ${esc(shortNetworkPath(liveSubId))}</button></div><small class="field-hint">백업 서브넷(${esc(shortNetworkPath(gwSub.subnetId))})과 현재 서브넷이 다릅니다. 현재 서브넷을 유지하면 중지 없이 복원합니다.</small></div>`);
          }
        }
      }
    }
    const pfxFields = m.mode === "create" ? this.pfxCertificateFields(topChosen, locked) : "";
    if (!liveSubnetRebinds.length && !pfxFields) return "";
    return `<div class="smart-clone-grid">${liveSubnetRebinds.join("")}${pfxFields}</div>`;
  }

  overrideSampleBar(locked) {
    const { topChosen } = this.relatedContext();
    if (!topChosen.length) return "";
    const samples = [];
    const pipNode = topChosen.find((node) => node.resourceType === "microsoft.network/publicipaddresses");
    if (pipNode) {
      samples.push({
        label: `Azure Policy ipTags (${pipNode.name})`,
        line: `${pipNode.name} properties.ipTags=[{"ipTagType":"FirstPartyUsage","tag":"/Unprivileged"}]`,
      });
    }
    samples.push({
      label: `태그 추가 (${topChosen[0].name})`,
      line: `${topChosen[0].name} tags.environment="${this.model.mode === "clone" ? "clone" : "restored"}"`,
    });
    return `<div class="sample-bar">${samples.map((s) => `<button type="button" class="sample-chip" data-sample-override="${esc(s.line)}" ${locked}>${esc(s.label)}</button>`).join("")}</div>`;
  }

  advancedOptionsDrawer(locked) {
    const m = this.model;
    const isClone = m.mode === "clone";
    const { chosen, topChosen, nodes } = this.relatedContext();
    const smartNames = m.smartNames || {};
    const smartIps = m.smartPrivateIps || {};
    const smartDns = m.smartDnsLabels || {};
    const smartPoolIps = m.smartPoolIps || {};

    const renameFields = isClone && topChosen.length
      ? topChosen.map((node) => `<label class="field">개별 이름 (${esc(node.name)})<input type="text" data-smart-name="${esc(node.id)}" maxlength="80" value="${esc(smartNames[key(node.id)] || "")}" placeholder="${esc(m.clonePrefix ? `${m.clonePrefix}-${node.name}` : node.name)}" ${locked}></label>`).join("")
      : "";

    const optionalCloneIpFields = isClone
      ? [
          ...topChosen.flatMap((node) => (node.cloneHints?.staticFrontends || [])
            .filter((fe) => !fe.requiresStatic)
            .map((fe) => {
              const ipKey = `${key(node.id)}::${key(fe.name)}`;
              return `<label class="field">정적 사설 IP 직접 지정 (${esc(node.name)} · ${esc(fe.name)})<input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(smartIps[ipKey] ?? "")}" placeholder="비워 두면 자동 동적 배정" ${locked}></label>`;
            })),
          ...((m.backendPoolMode || "placeholder") === "placeholder" && !this.isCrossBoundary()
            ? topChosen.flatMap((node) => (node.cloneHints?.backendPools || []).map((pool) => {
                const pKey = `${key(node.id)}::${key(pool.name)}`;
                return `<label class="field">백엔드 풀 임시 IP (${esc(pool.name)})<input type="text" data-smart-pool-ip="${esc(pKey)}" value="${esc(smartPoolIps[pKey] ?? "")}" placeholder="${esc(pool.suggestedPlaceholderIp || "10.0.0.250")}" ${locked}></label>`;
              }))
            : []),
        ].join("")
      : "";

    const optionalRestoreIpFields = !isClone && m.mode === "create"
      ? [
          ...topChosen.flatMap((node) => (node.cloneHints?.staticFrontends || []).map((fe) => {
            const ipKey = `${key(node.id)}::${key(fe.name)}`;
            return `<label class="field">재생성 사설 IP 변경 (${esc(fe.name)})<input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(smartIps[ipKey] ?? "")}" placeholder="${esc(`기본: ${fe.privateIPAddress}`)}" ${locked}></label>`;
          })),
          ...topChosen.filter((node) => node.cloneHints?.dnsLabel).map((node) => {
            const baseDns = node.cloneHints.dnsLabel;
            return `<label class="field">재생성 DNS 레이블 변경 (${esc(node.name)})<input type="text" data-smart-dns="${esc(node.id)}" maxlength="63" value="${esc(smartDns[key(node.id)] ?? "")}" placeholder="${esc(`기본: ${baseDns}`)}" ${locked}></label>`;
          }),
        ].join("")
      : "";

    const immutableField = m.mode === "update"
      ? `<label class="field">불변·충돌 속성 처리<select id="bundle-immutable" ${locked}><option value="keep-current" ${m.immutableConflict !== "block" ? "selected" : ""}>가능한 속성만 복원하고 불변 항목은 현재 값 유지 (권장)</option><option value="block" ${m.immutableConflict === "block" ? "selected" : ""}>불변·충돌 속성이 하나라도 다르면 중단</option></select></label>`
      : "";

    const extraBundleSection = this.embedded && this.graph?.nodes
      ? (() => {
          const topNodes = [...this.graph.nodes].filter((node) => !node.parentId).sort((a, b) => a.name.localeCompare(b.name, "en"));
          if (topNodes.length <= 1) return "";
          const ids = new Set(chosen.map((n) => key(n.id)));
          const directIds = new Set((m.selected || []).map(key));
          return `<div class="advanced-subsection"><span class="side-eyebrow">같은 백업 시점의 다른 리소스 함께 묶기</span><div class="bundle-extra-list">${topNodes.map((node) => {
            const selected = ids.has(key(node.id)), direct = directIds.has(key(node.id));
            const implied = selected && !direct;
            const disabled = m.busy || !node.restoreSupported || implied;
            return `<label class="check-label" title="${esc(implied ? "연관 선택으로 이미 포함됨" : node.blockedReason || node.id)}"><input type="checkbox" data-bundle-select="${esc(node.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${esc(node.name)} <small>(${esc(node.label)})</small></span></label>`;
          }).join("")}</div></div>`;
        })()
      : "";

    const relationDetails = this.embedded && this.graph && chosen.length
      ? (() => {
          const ids = new Set(chosen.map((node) => key(node.id)));
          const edges = (this.graph.edges || []).filter((edge) => ids.has(key(edge.from)));
          const omitted = chosen.flatMap((node) => (node.excluded || []).map((item) => ({ node, item })));
          if (!edges.length && !omitted.length) return "";
          return `<ul class="relation-list compact-relation-list">${edges.map((edge) => {
            const badge = this.edgeRelationBadge(edge, ids.has(key(edge.to)));
            return `<li><span>${esc(nodes.get(key(edge.from))?.name)}</span>${icon("arrow")}<strong>${esc(nodes.get(key(edge.to))?.name || shortNetworkPath(edge.referenceId || edge.to))}</strong><span class="relation-label ${badge.cls}">${esc(badge.text)}</span></li>`;
          }).join("")}${omitted.map(({ node, item }) => `<li><span>${esc(node.name)}</span>${icon("arrow")}<strong>${esc(item.kind === "peering" ? `피어링 ${item.name}` : item.kind === "members" ? `풀 ${item.name} NIC ${item.count}개` : `서브넷 ${item.name} 연결 ${item.count}개`)}</strong><span class="relation-label shared">제외</span></li>`).join("")}</ul>`;
        })()
      : "";

    const hasAdvancedEdits = Boolean(
      m.overridesText
      || m.ticket
      || m.reason
      || m.immutableConflict === "block"
      || Object.values(smartNames).some((v) => String(v || "").trim()),
    );

    return `<details class="advanced-overrides" ${hasAdvancedEdits ? "open" : ""}>
      <summary>${isClone ? "고급 설정 (개별 이름 · 정책 태그 · 감사 메모)" : "고급 설정 (충돌 정책 · 수동 속성 · 감사 메모)"}</summary>
      <div class="advanced-body">
        ${renameFields || optionalCloneIpFields || optionalRestoreIpFields || immutableField
          ? `<div class="smart-clone-grid">${immutableField}${renameFields}${optionalCloneIpFields}${optionalRestoreIpFields}</div>`
          : ""}
        <div class="plan-fields-grid">
          <label class="field">감사 티켓 (선택)<input type="text" id="bundle-ticket" maxlength="80" value="${esc(m.ticket)}" placeholder="비워 두면 자동 기록 (예: CHG-101)" ${locked}></label>
          <label class="field">작업 메모 (선택)<input type="text" id="bundle-reason" maxlength="500" value="${esc(m.reason)}" placeholder="로그에 남길 메모" ${locked}></label>
        </div>
        <label class="field">고급 속성 직접 지정 (선택 · 한 줄에 “자원이름 경로=값”)<textarea id="bundle-overrides" rows="2" spellcheck="false" placeholder="pip-web properties.ipTags=[{&quot;ipTagType&quot;:&quot;FirstPartyUsage&quot;,&quot;tag&quot;:&quot;/Unprivileged&quot;}]" ${locked}>${esc(m.overridesText)}</textarea>${this.overrideSampleBar(locked)}</label>
        ${extraBundleSection}
        ${relationDetails}
      </div>
    </details>`;
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
    const modeSelector = this.intent === "clone" || this.intent === "restore"
      ? ""
      : `<fieldset class="restore-choice"><legend>적용 방식</legend><label><input type="radio" name="bundle-mode" value="create" ${m.mode === "create" ? "checked" : ""} ${locked}>부재 자원 재생성</label><label><input type="radio" name="bundle-mode" value="update" ${m.mode === "update" ? "checked" : ""} ${locked}>기존 자원 업데이트</label><label><input type="radio" name="bundle-mode" value="clone" ${m.mode === "clone" ? "checked" : ""} ${locked}>독립 설정 복제</label></fieldset>`;
    return `<div class="bundle-review">
      ${modeSelector}
      ${this.decisionSummaryHtml(locked)}
      ${clone ? `${this.targetFields(locked)}${this.smartCloneFields(locked)}` : this.restorePropertyFields(locked)}
      ${this.advancedOptionsDrawer(locked)}
      <div class="plan-review-trigger">
        <button class="button ${plan ? "" : "primary"}" data-bundle="review" ${locked}>${icon("shield")}${clone ? "복제 계획 검토" : "복원 계획 검토"}</button>
        <small class="field-hint" data-gate="review" role="status"></small>
      </div>
      ${plan ? `<div class="bundle-plan">
        <h3>${icon("layers")}${clone ? `복제 계획 · ${plan.actions.length}개 리소스 생성` : `복원 계획 · ${plan.actions.length}개 리소스 적용`}</h3>
        ${clone && plan.target ? `<p class="clone-destination">${icon("arrow")}대상 위치 · ${esc(plan.target.subscriptionName)} / <b>${esc(plan.target.resourceGroup)}</b></p>` : ""}
        <ol>${plan.actions.map((action) => {
          const srcName = String(action.sourceResourceId || action.resourceId || "").split("/").at(-1);
          const label = clone && srcName && srcName !== action.name ? `${esc(srcName)} ${icon("arrow")} <strong>${esc(action.name)}</strong>` : `<span>${esc(action.name)}</span>`;
          return `<li title="${esc(action.resourceId)}">${label}<small>${action.wasPresent ? "업데이트" : "생성"}</small></li>`;
        }).join("")}</ol>
        ${adjustmentList(plan)}
        <small>유효 시각 ${this.time(plan.expiresAt)} · 중간 실패 시 자동 롤백하지 않으며 안전 백업이 보존됩니다.</small>
        ${clone ? "" : `<label class="check-label"><input id="bundle-approve" type="checkbox" ${m.approved ? "checked" : ""} ${locked}>복원 전 현재 상태를 안전 백업으로 먼저 보관하고, 위 계획대로 실제 리소스를 복원합니다.</label>`}
        <div class="plan-execute-row">
          <button class="button primary" data-bundle="execute" disabled>${icon(clone ? "layers" : "restore")}${clone ? "복제 실행" : "안전 백업 후 복원"}</button>
          <small class="field-hint" data-gate="execute" role="status"></small>
        </div>
      </div>` : ""}
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

  // Clone creates new resources and needs no confirmation; restore requires one explicit safety approval check.
  executeBlockedReason() {
    const m = this.model;
    if (m.busy || !m.plan) return "";
    if (this.writeLocked?.()) return "최신 ARM 수집 상태를 확인 중이거나 지연되어 실행이 잠겨 있습니다. 상단 새로고침 후 실행하세요.";
    if (m.mode !== "clone" && !m.approved) {
      return "안전 백업 보관 및 실제 리소스 복원 확인란을 선택하세요.";
    }
    return "";
  }

  executeBlocked() {
    const m = this.model;
    if (m.busy || !m.plan) return true;
    return Boolean(this.executeBlockedReason());
  }

  updateGates() {
    const review = this.root.querySelector('[data-bundle="review"]');
    const reviewHint = this.root.querySelector('[data-gate="review"]');
    if (review) {
      try {
        const { subnetLookup } = this.networkLookup();
        bundleReviewInput(this.model, this.graph, subnetLookup);
        review.disabled = this.model.busy;
        review.title = "";
        if (reviewHint && reviewHint !== review) reviewHint.textContent = "";
      } catch (error) {
        review.disabled = true;
        review.title = error.message;
        if (reviewHint && reviewHint !== review) reviewHint.textContent = `입력 확인 · ${error.message}`;
      }
    }
    const executeHint = this.root.querySelector('[data-gate="execute"]');
    const execute = this.root.querySelector('[data-bundle="execute"]');
    const execReason = this.executeBlockedReason();
    if (executeHint && executeHint !== execute) executeHint.textContent = execReason;
    if (execute) {
      execute.disabled = this.executeBlocked();
      execute.title = execReason;
    }
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
      if (node.cloneHints?.dnsLabel && this.autoPrefilledDns?.has(key(node.id))) {
        const nextDns = suggestDnsLabel(node.cloneHints.dnsLabel, prefix, this.model.targetGroup || "copy");
        if (nextDns) {
          this.model.smartDnsLabels[key(node.id)] = nextDns;
          this.autoPrefilledDns.set(key(node.id), nextDns);
          const dnsInput = [...this.root.querySelectorAll("[data-smart-dns]")].find((el) => key(el.dataset.smartDns) === key(node.id));
          if (dnsInput) dnsInput.value = nextDns;
        }
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
      const dKey = key(target.dataset.smartDns);
      this.model.smartDnsLabels[dKey] = target.value;
      this.autoPrefilledDns?.delete(dKey);
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartIp) {
      this.model.smartPrivateIps ||= {};
      this.model.smartPrivateIps[target.dataset.smartIp] = target.value;
      this.autoPrefilledIps?.delete(target.dataset.smartIp);
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartPoolIp) {
      this.model.smartPoolIps ||= {};
      this.model.smartPoolIps[target.dataset.smartPoolIp] = target.value;
      this.autoPrefilledPools?.delete(target.dataset.smartPoolIp);
      this.invalidate();
      if (!this.model.plan) this.root.querySelector?.(".bundle-plan")?.remove();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartKv) {
      this.model.smartKeyVaultCerts ||= {};
      this.model.smartKeyVaultCerts[target.dataset.smartKv] = target.value;
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
    const names = { "bundle-ticket": "ticket", "bundle-reason": "reason", "bundle-prefix": "clonePrefix", "bundle-overrides": "overridesText", "bundle-query": "query" };
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
    if (target.dataset.restoreCompanion) {
      const id = target.dataset.restoreCompanion;
      const { relatedEdges } = this.relatedContext();
      if (!m.includeRelated && target.checked) {
        m.includeRelated = true;
        m.excludedRelated = relatedEdges.map((edge) => edge.to).filter((other) => key(other) !== key(id));
      } else if (target.checked) {
        m.excludedRelated = (m.excludedRelated || []).filter((item) => key(item) !== key(id));
      } else {
        m.excludedRelated = [...new Set([...(m.excludedRelated || []), id])];
      }
      this.syncCloneConstraints();
      this.invalidate(); this.render();
      [...this.root.querySelectorAll("[data-restore-companion]")].find((input) => input.dataset.restoreCompanion === id)?.focus({ preventScroll: true });
    }
    if (target.dataset.shareableMode) {
      const id = target.dataset.shareableMode;
      m.includeRelated = true;
      m.excludedRelated = target.value === "share"
        ? [...new Set([...(m.excludedRelated || []), id])]
        : (m.excludedRelated || []).filter((item) => key(item) !== key(id));
      this.invalidate(); this.render();
      [...this.root.querySelectorAll("[data-shareable-mode]")].find((sel) => sel.dataset.shareableMode === id)?.focus({ preventScroll: true });
    }
    if (target.id === "bundle-immutable") { m.immutableConflict = target.value; this.invalidate(); this.render(); this.root.querySelector("#bundle-immutable")?.focus(); }
    if (target.id === "bundle-pool-mode") { m.backendPoolMode = target.value; this.invalidate(); this.render(); this.root.querySelector("#bundle-pool-mode")?.focus(); }
    if (target.name === "bundle-mode") {
      const wasClone = m.mode === "clone";
      m.mode = target.value;
      if (wasClone !== (m.mode === "clone")) this.resetContextInputs();
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
    if (target.id === "bundle-approve") { m.approved = target.checked; this.updateGates(); }
  }

  async click(event) {
    const sampleOverride = event.target.closest?.("[data-sample-override]");
    if (sampleOverride?.dataset?.sampleOverride && !sampleOverride.disabled && !this.model.busy) {
      const line = sampleOverride.dataset.sampleOverride;
      const existing = String(this.model.overridesText || "").trim();
      const lines = existing ? existing.split(/\r?\n/) : [];
      if (!lines.includes(line)) lines.push(line);
      this.model.overridesText = lines.join("\n");
      this.invalidate();
      this.render();
      this.root.querySelector?.("#bundle-overrides")?.focus({ preventScroll: true });
      return;
    }
    const sampleBtn = event.target.closest?.("[data-sample-field]");
    if (sampleBtn?.dataset?.sampleField && !sampleBtn.disabled && !this.model.busy) {
      const field = sampleBtn.dataset.sampleField;
      const k = sampleBtn.dataset.sampleKey;
      const val = sampleBtn.dataset.sampleValue || "";
      if (field && k) {
        this.model[field] ||= {};
        this.model[field][k] = val;
        if (field === "smartPrivateIps") this.autoPrefilledIps?.delete(k);
        if (field === "smartDnsLabels") this.autoPrefilledDns?.delete(k);
        if (field === "referenceBindings") {
          this.model.customBindingModes ||= {};
          delete this.model.customBindingModes[k];
        }
        this.invalidate();
        this.render();
      }
      return;
    }
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
    if (action === "execute" && this.executeBlocked()) throw new Error(this.executeBlockedReason() || "실행 전 확인 조건을 점검하세요.");
    this.mutating = ["backup", "execute"].includes(action);
    m.busy = true; m.error = ""; this.render();
    try {
      if (action === "review") {
        const { subnetLookup } = this.networkLookup();
        const plan = await this.api.bundleReview(bundleReviewInput(m, this.graph, subnetLookup));
        if (this.alive) {
          m.plan = plan;
          const skipped = nonRestorableItems(plan);
          if (skipped.length) {
            const sample = skipped.slice(0, 3).map((item) => `• ${item.name} · ${item.path}: ${item.reason}`).join("\n");
            const more = skipped.length > 3 ? `\n외 ${skipped.length - 3}건은 계획의 ‘복원·복제 시 달라지는 값’에서 확인하세요.` : "";
            const title = m.mode === "clone"
              ? `복제 계획 확인 · 자동 보정(임시 샘플 값) 또는 제외 항목 ${skipped.length}건을 반영해 복제를 준비했습니다.`
              : `복원할 수 없거나 현재 값을 유지·보정하는 속성이 ${skipped.length}건 있습니다. 가능한 속성을 모두 적용합니다.`;
            this.notify?.({
              key: "bundle-partial",
              level: "warning",
              message: `${title}\n${sample}${more}`,
            });
          }
        }
      }
      if (action === "diagnose") {
        this.diagnostics = { loading: true }; this.render();
        const data = await this.api.diagnostics(target.dataset.id);
        if (this.alive) this.diagnostics = data;
      }
      if (["backup", "execute"].includes(action)) {
        const payload = action === "backup"
          ? { resourceIds: m.selected, includeRelated: m.includeRelated,
              ...(m.includeRelated && m.excludedRelated.length ? { excludedRelated: m.excludedRelated } : {}) }
          : { planId: m.plan.id, approvalSha256: m.plan.approvalSha256,
              confirmGroup: m.mode === "clone" ? "" : (m.confirmGroup || this.confirmValue()) };
        const job = await this.run(action === "backup" ? "bundle-backup" : "bundle-restore", payload);
        m.result = job.result; this.invalidate(); m.busy = false;
        if (action === "backup") m.runId = job.result.runId;
        else if (Array.isArray(job.result?.omittedOrKept) && job.result.omittedOrKept.length) {
          const items = job.result.omittedOrKept;
          const sample = items.slice(0, 3).map((item) => `• ${item.resource} · ${item.path}`).join("\n");
          const doneTitle = m.mode === "clone"
            ? `복제 완료 · 자동 보정(임시 샘플 값) 또는 제외 항목 ${items.length}건이 함께 반영되었습니다.`
            : `가능한 설정 복원 완료 · 복원 불가/불변 속성 ${items.length}건은 제외 또는 현재 값으로 유지했습니다.`;
          this.notify?.({
            key: "bundle-partial-done",
            level: "warning",
            message: `${doneTitle}\n${sample}`,
          });
        }
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
