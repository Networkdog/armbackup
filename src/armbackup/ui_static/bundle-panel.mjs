import { backupHealth, relativeTime } from "./backup-view.mjs";
import {
  openNetworkBindingPicker,
  openResourcePicker,
  openTargetLocationPicker,
  pickerTriggerHtml,
  resourceHierarchy,
} from "./resource-picker.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const key = (value) => String(value).toLowerCase();

const COMMON_LOCATIONS = [
  "koreacentral", "koreasouth", "japaneast", "japanwest",
  "eastasia", "southeastasia", "eastus", "eastus2", "westus2", "westeurope",
];

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

const PORTAL_TYPE_LABELS = {
  "microsoft.network/applicationgateways": "Application Gateway",
  "microsoft.network/loadbalancers": "Load Balancer",
  "microsoft.network/publicipaddresses": "Public IP",
  "microsoft.network/applicationgatewaywebapplicationfirewallpolicies": "WAF Policy",
  "microsoft.network/networksecuritygroups": "NSG",
  "microsoft.network/routetables": "Route Table",
  "microsoft.network/virtualnetworks": "Virtual Network",
  "microsoft.cdn/profiles": "Front Door",
};

function normalizeTopLevelArmResource(resourceId) {
  const raw = String(resourceId || "").trim();
  if (!raw.startsWith("/") || /[?#\\\s]/.test(raw)) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 8) return null;
  if (parts[0].toLowerCase() !== "subscriptions" || !UUID_RE.test(parts[1])) return null;
  if (parts[2].toLowerCase() !== "resourcegroups" || parts[4].toLowerCase() !== "providers") return null;
  const top = parts.slice(0, 8);
  if (top.some((seg) => seg === "." || seg === ".." || !SAFE_SEGMENT_RE.test(seg))) return null;
  const canonicalPath = [
    "",
    "subscriptions",
    top[1],
    "resourceGroups",
    encodeURIComponent(top[3]),
    "providers",
    encodeURIComponent(top[5]),
    encodeURIComponent(top[6]),
    encodeURIComponent(top[7]),
  ].join("/");
  const typeKey = `${top[5]}/${top[6]}`.toLowerCase();
  return {
    id: `/${["subscriptions", top[1], "resourceGroups", top[3], "providers", top[5], top[6], top[7]].join("/")}`,
    canonicalPath,
    name: top[7],
    typeKey,
    typeLabel: PORTAL_TYPE_LABELS[typeKey] || top[6],
  };
}

export function azurePortalResourceUrl(resourceId, tenantId = "") {
  const parsed = normalizeTopLevelArmResource(resourceId);
  if (!parsed) return "";
  const tenant = String(tenantId || "").trim();
  const tenantPrefix = UUID_RE.test(tenant) ? `@${tenant.toLowerCase()}/` : "";
  return `https://portal.azure.com/#${tenantPrefix}resource${parsed.canonicalPath}/overview`;
}

export function portalTargetLinks(result, tenantId = "") {
  if (!result || typeof result !== "object") return [];
  const rawPrimary = Array.isArray(result.primaryResourceIds) && result.primaryResourceIds.length
    ? result.primaryResourceIds
    : (result.targetId ? [result.targetId] : []);
  const rawAll = Array.isArray(result.resourceIds) && result.resourceIds.length
    ? result.resourceIds
    : rawPrimary;
  const primaryTopKeys = new Set(
    rawPrimary.map((id) => normalizeTopLevelArmResource(id)?.id.toLowerCase()).filter(Boolean),
  );
  const items = [];
  const seen = new Set();
  for (const candidate of [...rawPrimary, ...rawAll]) {
    const parsed = normalizeTopLevelArmResource(candidate);
    if (!parsed) continue;
    const k = parsed.id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({
      id: parsed.id,
      name: parsed.name,
      typeLabel: parsed.typeLabel,
      primary: primaryTopKeys.size ? primaryTopKeys.has(k) : false,
      url: azurePortalResourceUrl(parsed.id, tenantId),
    });
  }
  if (items.length && !items.some((item) => item.primary)) {
    const preferred = items.find((item) =>
      item.typeLabel === "Application Gateway" || item.typeLabel === "Load Balancer" || item.typeLabel === "Front Door",
    ) || items.at(-1);
    if (preferred) preferred.primary = true;
  }
  return items.sort((a, b) => Number(b.primary) - Number(a.primary));
}

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

export const CLONE_NAME_MODES = ["prefix", "suffix", "sequence", "direct"];

const CLONE_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CLONE_SUFFIX_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,28}[A-Za-z0-9_])?$/;

export function nextSequenceToken(baseName = "") {
  const match = /^(.*[-_.])(\d+)$/.exec(String(baseName || "").trim());
  if (match) {
    const digits = match[2];
    const nextVal = String(BigInt(digits) + 1n);
    return nextVal.padStart(Math.max(digits.length, nextVal.length), "0").slice(-8);
  }
  return "02";
}

export function stepSequenceToken(rawToken = "", delta = 1) {
  const trimmed = String(rawToken || "").trim();
  const digits = /^\d+$/.test(trimmed) ? trimmed : "02";
  const width = trimmed ? digits.length : 2;
  const cur = Number.parseInt(digits, 10);
  const nextNum = Math.max(1, (Number.isFinite(cur) ? cur : 2) + delta);
  const nextStr = String(nextNum);
  return nextStr.padStart(Math.max(width, nextStr.length), "0").slice(0, 8);
}

export function applySequenceName(baseName, seqToken) {
  const base = String(baseName || "").trim();
  const seq = String(seqToken ?? "").trim();
  if (!base || !seq) return base;
  const match = /^(.*[-_.])(\d+)$/.exec(base);
  return match ? `${match[1]}${seq}` : `${base}-${seq}`;
}

export function deriveCompanionDirectName(compNode, primaryTargetName, primaryNode = null) {
  const compName = String(compNode?.name || "").trim();
  const nextPrimary = String(primaryTargetName || "").trim();
  if (!compName) return nextPrimary.slice(0, 80);
  if (!nextPrimary) return `${compName}-copy`.slice(0, 80);
  const origPrimary = String(primaryNode?.name || "").trim();
  if (origPrimary && compName.toLowerCase().includes(origPrimary.toLowerCase()) && key(compName) !== key(origPrimary)) {
    const idx = compName.toLowerCase().indexOf(origPrimary.toLowerCase());
    const replaced = `${compName.slice(0, idx)}${nextPrimary}${compName.slice(idx + origPrimary.length)}`;
    return replaced.slice(0, 80).replace(/[-_.]+$/g, "") || `${compName}-copy`.slice(0, 80);
  }
  const rType = String(compNode?.resourceType || compNode?.type || "").toLowerCase();
  let candidate = "";
  if (rType === "microsoft.network/publicipaddresses") {
    candidate = nextPrimary.toLowerCase().startsWith("pip-") ? `${nextPrimary}-ip` : `pip-${nextPrimary}`;
  } else if (rType.includes("firewallpolicies")) {
    candidate = nextPrimary.toLowerCase().startsWith("waf-") ? `${nextPrimary}-waf` : `waf-${nextPrimary}`;
  } else {
    candidate = `${compName}-${nextPrimary}`;
  }
  return candidate.slice(0, 80).replace(/[-_.]+$/g, "") || `${compName}-copy`.slice(0, 80);
}

export function resolveCloneTargetName(node, model = {}) {
  const baseName = String(node?.name || "").trim();
  if (!baseName) return "";
  const mode = CLONE_NAME_MODES.includes(model?.cloneNameMode) ? model.cloneNameMode : "prefix";
  if (mode !== "direct") {
    const custom = String(model?.smartNames?.[key(node.id || "")] || "").trim();
    if (custom) return custom;
  }
  if (mode === "suffix") {
    const suffix = String(model?.cloneSuffix ?? "").trim();
    return suffix ? `${baseName}-${suffix}` : baseName;
  }
  if (mode === "sequence") {
    const seq = String(model?.cloneSequence ?? "").trim();
    return seq ? applySequenceName(baseName, seq) : baseName;
  }
  if (mode === "direct") {
    const directVal = String(model?.directNames?.[key(node.id || "")] ?? "").trim();
    if (directVal) return directVal;
    return model?.targetGroup ? baseName : "";
  }
  const prefix = String(model?.clonePrefix ?? "").trim();
  return prefix ? `${prefix}-${baseName}` : baseName;
}

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

function sanitizeDnsToken(raw = "") {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function finalizeDnsCandidate(candidate, base) {
  let clean = sanitizeDnsToken(candidate);
  if (!clean) return "";
  if (!/^[a-z]/.test(clean)) clean = `d-${clean}`;
  clean = clean.slice(0, 63).replace(/-+$/g, "");
  if (clean.length < 2) clean = `${clean}0`;
  if (clean === base) {
    clean = `${clean.slice(0, 60).replace(/-+$/g, "")}-02`;
  }
  return clean;
}

export function suggestCloneDnsLabel(baseLabel, model = {}, resolvedTargetName = "", originalNodeName = "") {
  const base = sanitizeDnsToken(baseLabel);
  if (!base) return "";
  const nameMode = CLONE_NAME_MODES.includes(model?.cloneNameMode) ? model.cloneNameMode : "prefix";
  if (nameMode === "prefix") {
    return suggestDnsLabel(baseLabel, model?.clonePrefix || "", model?.targetGroup || "copy");
  }
  if (nameMode === "suffix") {
    const sfx = sanitizeDnsToken(model?.cloneSuffix || "");
    if (sfx) return finalizeDnsCandidate(`${base}-${sfx}`, base);
    return suggestDnsLabel(baseLabel, "", model?.targetGroup || "copy");
  }
  if (nameMode === "sequence") {
    const seq = sanitizeDnsToken(model?.cloneSequence || "");
    if (seq) {
      const seqReplaced = /^(.*-)(\d+)$/.exec(base);
      const next = seqReplaced ? `${seqReplaced[1]}${seq}` : `${base}-${seq}`;
      return finalizeDnsCandidate(next, base);
    }
    return suggestDnsLabel(baseLabel, "", model?.targetGroup || "copy");
  }
  const targetSlug = sanitizeDnsToken(resolvedTargetName);
  const origSlug = sanitizeDnsToken(originalNodeName);
  if (targetSlug && targetSlug !== origSlug) {
    const combined = `${base.slice(0, 30).replace(/-+$/g, "")}-${targetSlug.slice(-31).replace(/^-+/g, "")}`;
    return finalizeDnsCandidate(combined, base);
  }
  return suggestDnsLabel(baseLabel, "", model?.targetGroup || "copy");
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

export function parseAgwBackendTargets(rawText, poolName = "backendPool") {
  const tokens = String(rawText ?? "")
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length > 100) throw new Error(`백엔드 풀 '${poolName}'의 대상 주소는 최대 100개까지 입력할 수 있습니다.`);
  return tokens.map((token) => {
    if (parseIpv4Int(token) !== null || (token.includes(":") && /^[0-9a-fA-F:]+$/.test(token))) {
      return { ipAddress: token };
    }
    if (/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(token) && !/^\d+(?:\.\d+)*$/.test(token)) {
      return { fqdn: token };
    }
    throw new Error(`백엔드 풀 '${poolName}'의 대상 주소 '${token}' 형식이 올바르지 않습니다 (IP 주소 또는 FQDN).`);
  });
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
  const smartAgwPools = model.smartAgwPools || {};
  const deferredMap = model.deferredPortal || {};
  const configuredCerts = model.configuredCerts || {};
  const rawBindings = model.referenceBindings || {};
  const deferredPortal = [];

  const allNodesById = new Map((graph.nodes || []).map((node) => [key(node.id), node]));
  const nodesById = new Map(selected.map((node) => [key(node.id), node]));
  const selectedIds = new Set(selected.map((node) => key(node.id)));
  for (const excludedId of model.excludedRelated || []) {
    const compKey = `companion:${key(excludedId)}`;
    if (deferredMap[compKey] && !selectedIds.has(key(excludedId))) {
      const compNode = allNodesById.get(key(excludedId));
      if (compNode) {
        deferredPortal.push({ resourceId: compNode.id, kind: "companion", target: compNode.name || "" });
      }
    }
  }
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
    if (deferredMap[`net:${sourceKey}`] && !clone) {
      continue;
    }
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

  const nameMode = CLONE_NAME_MODES.includes(model.cloneNameMode) ? model.cloneNameMode : "prefix";
  let hasBackendPools = false;
  let activeLbPools = 0;
  const placeholderIps = {};
  const seenTypeTargetNames = new Set();
  for (const node of selected) {
    if (node.parentId) continue;
    let resolvedTargetName = node.name;
    if (clone) {
      resolvedTargetName = resolveCloneTargetName(node, model);
      if (nameMode === "prefix") {
        const customName = String(smartNames[key(node.id)] || "").trim();
        if (customName && !manualKeys.has(`${key(node.id)}::name`)) {
          overrides.push({ resourceId: node.id, path: "name", value: customName });
          manualKeys.add(`${key(node.id)}::name`);
        }
      } else if (!manualKeys.has(`${key(node.id)}::name`)) {
        if (!resolvedTargetName) {
          throw new Error(`'${node.name}'의 새 리소스 이름을 입력하세요.`);
        }
        if (!CLONE_RESOURCE_NAME_RE.test(resolvedTargetName)) {
          throw new Error(`'${node.name}'의 복제 이름('${resolvedTargetName}')은 영문·숫자로 시작하는 1~80자(영문·숫자·_.-)여야 합니다.`);
        }
        if (!model.targetGroup && key(resolvedTargetName) === key(node.name)) {
          throw new Error(nameMode === "sequence"
            ? `원본과 같은 리소스 그룹에서는 '${node.name}'과 다른 일련 번호를 입력하세요.`
            : `원본과 같은 리소스 그룹에서는 '${node.name}'에 원본과 다른 새 이름을 입력하세요.`);
        }
        const typeNameKey = `${key(node.resourceType || "")}::${key(resolvedTargetName)}`;
        if (seenTypeTargetNames.has(typeNameKey)) {
          throw new Error(`복제 대상 이름이 서로 중복됩니다 ('${resolvedTargetName}').`);
        }
        seenTypeTargetNames.add(typeNameKey);
        if (resolvedTargetName !== node.name || !model.targetGroup) {
          overrides.push({ resourceId: node.id, path: "name", value: resolvedTargetName });
          manualKeys.add(`${key(node.id)}::name`);
        }
      }
    }
    const baseDns = node.cloneHints?.dnsLabel;
    if (baseDns) {
      const dnsItemKey = `dns:${key(node.id)}`;
      const dnsPath = "properties.dnsSettings.domainNameLabel";
      if (deferredMap[dnsItemKey] && model.mode !== "update") {
        deferredPortal.push({ resourceId: node.id, kind: "dns-label", target: "domainNameLabel" });
      } else {
        const customDns = String(smartDns[key(node.id)] || "").trim();
        const autoDns = clone && !customDns
          ? (nameMode === "prefix"
              ? (!model.clonePrefix && model.targetGroup ? suggestDnsLabel(baseDns, "", model.targetGroup) : "")
              : suggestCloneDnsLabel(baseDns, model, resolvedTargetName, node.name))
          : "";
        const chosenDns = customDns || autoDns;
        if (chosenDns && !manualKeys.has(`${key(node.id)}::${dnsPath}`)) {
          overrides.push({ resourceId: node.id, path: dnsPath, value: chosenDns });
          manualKeys.add(`${key(node.id)}::${dnsPath}`);
        }
      }
    }
    for (const fe of node.cloneHints?.staticFrontends || []) {
      const ipKey = `${key(node.id)}::${key(fe.name)}`;
      const ipItemKey = `ip:${ipKey}`;
      const ipPath = `properties.frontendIPConfigurations[name=${fe.name}].properties.privateIPAddress`;
      if (deferredMap[ipItemKey] && model.mode !== "update") {
        deferredPortal.push({ resourceId: node.id, kind: "private-ip", target: fe.name });
        continue;
      }
      const customIp = String(smartIps[ipKey] || "").trim();
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
      const kvKey = `${key(node.id)}::${key(certName)}`;
      const certItemKey = `cert:${kvKey}`;
      const kvPath = `properties.sslCertificates[name=${certName}].properties.keyVaultSecretId`;
      if (deferredMap[certItemKey]) {
        deferredPortal.push({ resourceId: node.id, kind: "ssl-cert", target: certName });
        continue;
      }
      const customKv = String(smartKv[kvKey] || "").trim();
      if (customKv && !manualKeys.has(`${key(node.id)}::${kvPath}`)) {
        overrides.push({ resourceId: node.id, path: kvPath, value: customKv });
        manualKeys.add(`${key(node.id)}::${kvPath}`);
      } else if (configuredCerts[kvKey] === true && !manualKeys.has(`${key(node.id)}::${kvPath}`)) {
        throw new Error(`${node.name}: SSL 인증서 '${certName}'의 Key Vault Secret URI를 입력하거나, 완료 후 포털에서 설정하려면 체크를 해제하세요.`);
      }
    }
    if (node.cloneHints?.backendPools?.length) {
      for (const pool of node.cloneHints.backendPools) {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        const poolItemKey = `lbpool:${pKey}`;
        if (deferredMap[poolItemKey]) {
          deferredPortal.push({ resourceId: node.id, kind: "lb-pool", target: pool.name });
          continue;
        }
        if (clone || model.mode === "create") {
          hasBackendPools = true;
          activeLbPools++;
          if ((model.backendPoolMode || "placeholder") === "placeholder") {
            const customPoolIp = String(smartPoolIps[pKey] || "").trim();
            if (customPoolIp) placeholderIps[pKey] = customPoolIp;
          }
        }
      }
    }
    for (const pool of node.cloneHints?.agwBackendPools || []) {
      const pKey = `${key(node.id)}::${key(pool.name)}`;
      const poolItemKey = `agwpool:${pKey}`;
      const agwPoolPath = `properties.backendAddressPools[name=${pool.name}].properties.backendAddresses`;
      if (deferredMap[poolItemKey]) {
        deferredPortal.push({ resourceId: node.id, kind: "agw-pool", target: pool.name });
        continue;
      }
      if (Object.hasOwn(smartAgwPools, pKey) && !manualKeys.has(`${key(node.id)}::${agwPoolPath}`)) {
        const parsedTargets = parseAgwBackendTargets(smartAgwPools[pKey], pool.name);
        const baselineJoined = (pool.targets || []).map((t) => String(t).trim()).filter(Boolean).join(", ");
        const currentJoined = parsedTargets.map((t) => t.ipAddress || t.fqdn).join(", ");
        if (currentJoined !== baselineJoined) {
          overrides.push({ resourceId: node.id, path: agwPoolPath, value: parsedTargets });
          manualKeys.add(`${key(node.id)}::${agwPoolPath}`);
        }
      }
    }
    if (model.mode === "update") {
      for (const gwSub of node.cloneHints?.gatewaySubnets || []) {
        const subItemKey = `subnet:${key(node.id)}::${key(gwSub.name)}`;
        if (deferredMap[subItemKey]) {
          deferredPortal.push({ resourceId: node.id, kind: "subnet-binding", target: gwSub.name });
        }
      }
    }
  }
  return { overrides, referenceBindings, hasBackendPools, activeLbPools, placeholderIps, deferredPortal };
}

export function bundleReviewInput(model, graph, subnetLookup = null) {
  if (!model.runId || model.runId === "current") throw new Error("복원 기준 백업을 먼저 선택하세요.");
  const selected = bundleSelection(graph, model.selected, model.includeRelated, model.excludedRelated);
  if (!selected.length || selected.length > 50) throw new Error("1~50개 자원을 선택하세요. 포함 자원도 한도에 포함합니다.");
  if (selected.some((node) => !node.restoreSupported)) throw new Error("차단된 복원 프로필이 선택에 포함돼 있습니다.");
  if (!["create", "update", "clone"].includes(model.mode)) throw new Error("생성·업데이트·복제를 선택하세요.");
  const nameMode = CLONE_NAME_MODES.includes(model.cloneNameMode) ? model.cloneNameMode : "prefix";
  if (model.mode === "clone") {
    if (model.targetSubscription && !model.targetGroup) throw new Error("복제할 대상 리소스 그룹을 선택하세요.");
    if (nameMode === "prefix") {
      const prefix = model.clonePrefix || "";
      if (!model.targetGroup && !prefix) throw new Error("대상 리소스 그룹을 고르지 않으면 복제 접두사가 필요합니다.");
      if (prefix && !/^[a-z][a-z0-9-]{1,19}$/.test(prefix)) throw new Error("복제 접두사는 소문자·숫자·하이픈 2~20자입니다.");
    } else if (nameMode === "suffix") {
      const suffix = String(model.cloneSuffix ?? "").trim();
      if (!model.targetGroup && !suffix) throw new Error("대상 리소스 그룹을 고르지 않으면 이름 접미사가 필요합니다.");
      if (suffix && !CLONE_SUFFIX_RE.test(suffix)) throw new Error("이름 접미사는 영문·숫자로 시작하고 끝나는 1~30자(영문·숫자·_.-)여야 합니다.");
    } else if (nameMode === "sequence") {
      const seq = String(model.cloneSequence ?? "").trim();
      if (!seq) throw new Error("복제 리소스에 붙일 일련 번호(예: 02, 001)를 입력하세요.");
      if (!/^\d{1,8}$/.test(seq)) throw new Error("일련 번호는 숫자 1~8자리(예: 2, 02, 001)로 입력하세요.");
    }
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
  const { overrides, referenceBindings, hasBackendPools, activeLbPools, placeholderIps, deferredPortal } = collectActionInputs(model, graph, selected, subnetLookup);
  const targetLocation = clone && String(model.targetLocation || "").trim() ? String(model.targetLocation).trim() : "";
  const effectivePoolMode = clone && hasBackendPools === false && deferredPortal.some((d) => d.kind === "lb-pool")
    ? "empty"
    : model.backendPoolMode;
  const poolMode = clone && effectivePoolMode && ["placeholder", "empty", "keep"].includes(effectivePoolMode)
    && ((hasBackendPools && activeLbPools > 0) || effectivePoolMode !== "placeholder")
    ? effectivePoolMode
    : "";
  return { runId: model.runId, resourceIds: model.selected.map((id) => graph.nodes.find((node) => key(node.id) === key(id))?.id).filter(Boolean),
    includeRelated: model.includeRelated, mode: model.mode, ticket,
    reason, acknowledgeExternal: true,
    ...(model.includeRelated && model.excludedRelated?.length ? { excludedRelated: model.excludedRelated } : {}),
    ...(overrides.length ? { overrides } : {}),
    ...(referenceBindings.length ? { referenceBindings } : {}),
    ...(targetLocation ? { targetLocation } : {}),
    ...(poolMode ? { backendPoolMode: poolMode } : {}),
    ...((clone || model.mode === "create") && Object.keys(placeholderIps).length ? { placeholderIps } : {}),
    ...(deferredPortal.length ? { deferredPortal } : {}),
    ...(model.mode === "update" && ["keep-current", "block"].includes(model.immutableConflict) ? { immutableConflict: model.immutableConflict } : {}),
    ...(clone && nameMode === "prefix" && model.clonePrefix ? { clonePrefix: model.clonePrefix } : {}),
    ...(clone && model.targetGroup ? { targetSubscriptionId: model.targetSubscription, targetResourceGroup: model.targetGroup } : {}) };
}

const CHANGE_LABELS = {
  overridden: "값 변경",
  renamed: "이름 변경",
  rebound: "대상 연결 변경",
  placeholder: "임시 샘플 값",
  "deferred-portal": "포털 후속 설정",
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
    (item) => item.change === "dropped" || item.change === "kept-current" || item.change === "placeholder" || item.change === "deferred-portal",
  );
}

export function adjustmentList(plan) {
  const deduped = dedupePlanAdjustments(plan);
  const rows = [
    ...deduped.map((item) => `<li title="${esc(item.reason)}"><span>${esc(item.name)} · ${esc(item.path)}</span><span class="relation-label ${item.change === "placeholder" || item.change === "deferred-portal" ? "placeholder" : ""}">${esc(CHANGE_LABELS[item.change] || item.change)}</span><small>${esc(item.reason)}</small></li>`),
    ...(plan.actions || []).flatMap((action) => (action.warnings || []).map((text) => `<li><span>${esc(action.name)}</span><span class="relation-label shared">주의</span><small>${esc(text)}</small></li>`)),
  ];
  const skipped = nonRestorableItems(plan).length;
  const heading = skipped
    ? `복원·복제 시 달라지는 값 (자동 보정·제외·유지·포털 후속 ${skipped}건 포함)`
    : "복원·복제 시 달라지는 값";
  const portalTodos = Array.isArray(plan.portalTodos) ? plan.portalTodos : [];
  const todoHtml = portalTodos.length
    ? `<div class="portal-todo-box"><h4>완료 후 Azure 포털 직접 설정 예정 (${portalTodos.length}건)</h4><ul class="portal-todo-list">${portalTodos.map((todo) => `<li><strong>${esc(todo.resource)} · ${esc(todo.title)}</strong><small>${esc(todo.portalGuide)}</small></li>`).join("")}</ul></div>`
    : "";
  return `${todoHtml}${rows.length ? `<h4>${heading}</h4><ul class="adjustment-list">${rows.join("")}</ul>` : ""}`;
}

function configItemCardHtml({ itemKey, title, subtitle = "", checked, deferredHint, bodyHtml, locked, span2 = false }) {
  return `<div class="field config-item-card ${checked ? "is-active" : "is-deferred"} ${span2 ? "field-span-2" : ""}">
    <div class="config-item-head">
      <label class="check-label config-item-toggle">
        <input type="checkbox" data-defer-toggle="${esc(itemKey)}" ${checked ? "checked" : ""} ${locked}>
        <span class="config-item-title"><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</span>
      </label>
      <span class="side-badge ${checked ? "verified" : "unverified"}">${checked ? "설정 중 입력" : "완료 후 포털 설정"}</span>
    </div>
    ${checked ? `<div class="config-item-body">${bodyHtml}</div>` : `<p class="config-item-deferred-note">${esc(deferredHint)}</p>`}
  </div>`;
}

export class BundlePanel {
  constructor(root, {
    api, state, model = null, timezone = "Asia/Seoul", run, startBackground = null, activeJob = null, refresh, onLogs,
    notify = null, writeLocked = null, embedded = false, intent = "",
    dialogElement = null, openDialog = null, closeDialog = null,
  }) {
    this.root = root; this.api = api; this.state = state; this.run = run; this.startBackground = startBackground;
    this.activeJob = activeJob; this.refresh = refresh;
    this.onLogs = onLogs; this.notify = notify; this.writeLocked = writeLocked;
    this.dialogElement = dialogElement; this.openDialog = openDialog; this.closeDialog = closeDialog;
    this.timezone = timezone; this.embedded = embedded; this.intent = intent;
    this.prefilledKeys = new Set();
    const defaults = {
      runId: "current", selected: [], includeRelated: intent === "clone", excludedRelated: [], overridesText: "",
      targetLocation: "", backendPoolMode: "placeholder", smartNames: {}, directNames: {}, smartDnsLabels: {}, smartPrivateIps: {},
      smartPoolIps: {}, smartAgwPools: {}, smartKeyVaultCerts: {}, deferredPortal: {}, configuredCerts: {},
      referenceBindings: {}, customBindingModes: {},
      immutableConflict: "keep-current", query: "",
      mode: intent === "clone" ? "clone" : "update", cloneNameMode: "prefix", clonePrefix: "copy", cloneSuffix: "copy", cloneSequence: "", targetSubscription: "", targetGroup: "",
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

  isJobRunning() {
    return ["Queued", "Running"].includes(this.activeJob?.status);
  }

  setActiveJob(job) {
    this.activeJob = job && ["Queued", "Running"].includes(job.status) ? job : null;
    if (!this.alive || !this.graph) return;
    const existing = this.root?.querySelector?.(".bundle-progress");
    const html = this.activeJobView();
    if (existing && html) {
      existing.outerHTML = html;
    } else if (existing && !html) {
      existing.remove();
    } else if (!existing && html) {
      const workspace = this.root?.querySelector?.(".restore-plan-workspace") || this.root;
      workspace?.insertAdjacentHTML?.("afterbegin", html);
    }
    this.updateGates();
  }

  setJobOutcome(job) {
    this.activeJob = null;
    this.mutating = false;
    this.model.busy = false;
    if (job?.status === "Succeeded") {
      this.model.error = "";
      this.model.result = job.result;
      if (job.action === "bundle-backup" && job.result?.runId) this.model.runId = job.result.runId;
      this.invalidate();
    } else if (job?.status === "Failed") {
      this.model.error = `${job.error || "작업 실패"}${job.safetyRunId ? ` · 안전 백업 ${job.safetyRunId}` : ""}`;
      this.invalidate();
    }
    if (this.alive && this.graph) this.render();
  }

  resetContextInputs() {
    this.model.referenceBindings = {};
    this.model.customBindingModes = {};
    this.model.smartNames = {};
    this.model.directNames = {};
    this.model.smartPrivateIps = {};
    this.model.smartDnsLabels = {};
    this.model.smartPoolIps = {};
    this.model.smartAgwPools = {};
    this.model.smartKeyVaultCerts = {};
    this.model.deferredPortal = {};
    this.model.configuredCerts = {};
    this.prefilledKeys?.clear();
    this.autoPrefilledIps?.clear();
    this.autoPrefilledDns?.clear();
    this.autoPrefilledPools?.clear();
    this.autoPrefilledAgwPools?.clear();
    this.autoPrefilledDirectNames?.clear();
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
    this.autoPrefilledAgwPools ||= new Map();
    m.deferredPortal ||= {};
    m.configuredCerts ||= {};
    m.smartAgwPools ||= {};
    const chosen = bundleSelection(this.graph, m.selected || [], m.includeRelated, m.excludedRelated);
    for (const node of chosen) {
      if (node.parentId) continue;
      for (const certName of node.cloneHints?.pfxCertificates || []) {
        const kvKey = `${key(node.id)}::${key(certName)}`;
        const certItemKey = `cert:${kvKey}`;
        if (!Object.hasOwn(m.deferredPortal, certItemKey) && !Object.hasOwn(m.configuredCerts, kvKey)) {
          const hasKv = Boolean(String(m.smartKeyVaultCerts?.[kvKey] || "").trim());
          m.deferredPortal[certItemKey] = !hasKv;
          m.configuredCerts[kvKey] = hasKv;
        }
      }
      for (const pool of node.cloneHints?.agwBackendPools || []) {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        const curTargets = m.smartAgwPools[pKey];
        if (curTargets === undefined || this.autoPrefilledAgwPools.get(pKey) === curTargets) {
          const baseline = (pool.targets || []).join(", ");
          m.smartAgwPools[pKey] = baseline;
          this.autoPrefilledAgwPools.set(pKey, baseline);
        }
      }
    }
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
      if (m.mode === "create") {
        for (const node of chosen) {
          if (node.parentId) continue;
          for (const pool of node.cloneHints?.backendPools || []) {
            const pKey = `${key(node.id)}::${key(pool.name)}`;
            if (m.smartPoolIps?.[pKey] === undefined && (pool.sampleIps?.length || pool.suggestedPlaceholderIp)) {
              const initVal = (pool.sampleIps || []).join(", ") || pool.suggestedPlaceholderIp || "";
              m.smartPoolIps ||= {};
              m.smartPoolIps[pKey] = initVal;
              this.autoPrefilledPools.set(pKey, initVal);
            }
          }
        }
      }
      return;
    }
    const { subnetLookup, vnetLookup } = this.networkLookup();
    const bindings = m.referenceBindings || {};
    this.autoPrefilledDirectNames ||= new Map();
    m.smartPrivateIps ||= {};
    m.smartDnsLabels ||= {};
    m.smartPoolIps ||= {};
    m.directNames ||= {};
    const directIds = new Set((m.selected || []).map(key));
    const topChosen = chosen.filter((node) => !node.parentId);
    const primaryNode = topChosen.find((node) => directIds.has(key(node.id))) || topChosen[0] || null;
    if (m.cloneNameMode === "sequence" && !m.cloneSequence && primaryNode) {
      m.cloneSequence = nextSequenceToken(primaryNode.name);
    }
    if (m.cloneNameMode === "direct") {
      for (const node of topChosen) {
        if (!directIds.has(key(node.id))) continue;
        const nKey = key(node.id);
        if (m.directNames[nKey] === undefined) {
          m.directNames[nKey] = `${node.name}-copy`.slice(0, 80);
        }
      }
      const primaryTarget = primaryNode ? (m.directNames[key(primaryNode.id)] || `${primaryNode.name}-copy`) : "";
      for (const node of topChosen) {
        if (directIds.has(key(node.id))) continue;
        const nKey = key(node.id);
        const curDirect = m.directNames[nKey];
        if (curDirect === undefined || this.autoPrefilledDirectNames.get(nKey) === curDirect) {
          const nextComp = deriveCompanionDirectName(node, primaryTarget, primaryNode);
          m.directNames[nKey] = nextComp;
          this.autoPrefilledDirectNames.set(nKey, nextComp);
        }
      }
    }
    for (const node of chosen) {
      if (node.parentId) continue;
      if (node.cloneHints?.dnsLabel) {
        const dKey = key(node.id);
        const curDns = m.smartDnsLabels[dKey];
        const suggestedDns = suggestCloneDnsLabel(node.cloneHints.dnsLabel, m, resolveCloneTargetName(node, m), node.name);
        if (curDns === undefined || this.autoPrefilledDns.get(dKey) === curDns) {
          if (suggestedDns) {
            m.smartDnsLabels[dKey] = suggestedDns;
            this.autoPrefilledDns.set(dKey, suggestedDns);
          }
        } else if (curDns === suggestedDns && !this.autoPrefilledDns.has(dKey)) {
          this.autoPrefilledDns.set(dKey, curDns);
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
    const locked = (m.busy || this.isJobRunning()) ? "disabled" : "";
    const gatewayNode = chosen.find((node) => node.resourceType === "microsoft.network/applicationgateways");
    const gatewayPresent = gatewayNode ? this.state.current?.[key(gatewayNode.id)]?.status : "";
    this.root.innerHTML = `<div class="restore-plan-workspace">
      ${this.activeJobView()}
      ${this.resultView()}
      ${m.error ? `<div class="notice error" role="alert">${icon("alert")}${esc(m.error)}</div>` : ""}
      <div class="restore-plan-split">
        <section class="panel restore-plan-panel restore-settings-pane" aria-label="${isClone ? "복제 설정" : "복원 설정"}">
          <div class="panel-header">
            <h2 class="panel-title">${icon(isClone ? "layers" : "restore")}${isClone ? "복제 설정" : "복원 설정"}</h2>
            ${gatewayNode && !isClone ? `<div class="panel-header-actions"><button type="button" class="button small" data-bundle="diagnose" data-id="${esc(gatewayNode.id)}" ${m.busy || this.isJobRunning() || gatewayPresent !== "present" ? "disabled" : ""}>${icon("pulse")}백엔드 · WAF 진단</button></div>` : ""}
          </div>
          <div class="panel-body restore-plan-body">
            <div class="bundle-review">${this.settingsFormHtml(locked)}</div>
          </div>
        </section>
        <section class="panel restore-plan-panel restore-plan-pane" aria-label="${isClone ? "복제 계획" : "복원 계획"}">
          ${this.planPaneInnerHtml(locked)}
        </section>
      </div>
      ${this.diagnostics ? this.diagnosticView() : ""}
    </div>`;
  }

  activeJobView() {
    const job = this.activeJob;
    if (!job || !["Queued", "Running"].includes(job.status)) return "";
    const isClone = job.operationMode === "clone";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const total = Number(job.totalCount) || steps.length || 1;
    const applied = Array.isArray(job.appliedResources) ? job.appliedResources.length : (Number(job.completedCount) || 0);
    const verified = Array.isArray(job.verifiedResources) ? job.verifiedResources.length : 0;
    const phaseWeights = { queued: 8, "safety-backup": 22, applying: 22 + Math.round((applied / total) * 58), verification: 80 + Math.round((verified / total) * 18), "persisting-audit": 99, complete: 100 };
    const pct = Math.min(99, Math.max(5, phaseWeights[job.phase] ?? 15));
    const phaseLabels = {
      queued: "서버 작업 대기열 등록됨",
      "safety-backup": "적용 전 현재 형상 안전 백업 및 무결성 확인 중",
      applying: `Azure ARM 형상 적용 및 프로비저닝 대기 중 (${applied}/${total}${job.currentResourceName ? ` · ${job.currentResourceName}` : ""})`,
      verification: `적용 후 전체 형상 비교 검증 중 (${verified}/${total}${job.currentResourceName ? ` · ${job.currentResourceName}` : ""})`,
      "persisting-audit": "영속 작업 완료 기록 저장 중",
    };
    const stepStatusLabel = {
      pending: "대기",
      applying: "ARM 적용 중",
      applied: "적용됨 · 검증 대기",
      verifying: "사후 검증 중",
      succeeded: "검증 완료",
      failed: "실패",
    };
    const stepsHtml = steps.length
      ? `<ul class="job-step-list" aria-label="리소스별 백그라운드 진행 상태">${steps.map((s) => `<li class="job-step-item status-${esc(s.status || "pending")}"><span><strong>${esc(s.name || String(s.resourceId || "").split("/").at(-1))}</strong></span><span class="relation-label ${s.status === "succeeded" || s.status === "applied" ? "placeholder" : "shared"}">${esc(stepStatusLabel[s.status] || s.status)}</span></li>`).join("")}</ul>`
      : "";
    return `<section class="bundle-progress" role="status" aria-live="polite" aria-label="서버 백그라운드 실행 현황">
      <div class="bundle-progress-head">
        <div class="bundle-progress-title"><span class="spinner" aria-hidden="true"></span><strong>${isClone ? "복제" : "복원"} 백그라운드 실행 중</strong></div>
        <span class="side-badge verified">서버 단독 수행 · 메뉴 이동 및 브라우저 종료 안전</span>
      </div>
      <progress class="job-progress-meter" value="${pct}" max="100">${pct}%</progress>
      <p class="bundle-progress-detail">${esc(phaseLabels[job.phase] || job.phase)} · 작업 ID <code>${esc(job.id)}</code>${job.safetyRunId ? ` · 안전 백업 <code>${esc(job.safetyRunId)}</code>` : ""}</p>
      ${stepsHtml}
    </section>`;
  }

  resultView() {
    const result = this.model.result;
    if (!result) return "";
    const skippedCount = Array.isArray(result.omittedOrKept) ? result.omittedOrKept.length : 0;
    const skippedText = skippedCount
      ? ` · 복원 불가/불변/포털 후속 ${skippedCount}개는 제외 또는 현재 값 유지`
      : "";
    const isClone = result.mode === "clone";
    const headingText = result.safetyRunId
      ? (isClone ? "복제 완료 · 사후 형상 비교 확인됨" : "복원 완료 · 안전 백업 및 사후 비교 확인됨")
      : "묶음 백업 완료";
    const tenantId = result.tenantId || this.state?.workspace?.tenantId || "";
    const portalItems = result.safetyRunId ? portalTargetLinks(result, tenantId) : [];
    const portalTodos = Array.isArray(result.portalTodos) ? result.portalTodos : [];
    const portalTodoHtml = portalTodos.length
      ? `<div class="portal-todo-box result-portal-todos"><h3>Azure 포털 직접 설정 항목 (${portalTodos.length}건)</h3><ul class="portal-todo-list">${portalTodos.map((todo) => `<li><strong>${esc(todo.resource)} · ${esc(todo.title)}</strong><small>${esc(todo.portalGuide)}</small></li>`).join("")}</ul></div>`
      : "";
    const portalHtml = portalItems.map((item) => item.primary
      ? `<a class="button primary small portal-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${item.id} (새 탭에서 Azure 포털 열기)`)}">${icon("external")}Azure 포털에서 열기 · ${esc(item.name)}</a>`
      : `<a class="button small portal-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${item.id} (새 탭에서 Azure 포털 열기)`)}">${icon("external")}${esc(item.name)} <span class="muted">(${esc(item.typeLabel)})</span></a>`).join("");
    return `<section class="bundle-result" aria-label="실행 완료 결과"><div class="bundle-result-head"><h2>${icon("check")}${headingText}</h2><code>${esc(result.safetyRunId || result.runId)}</code></div><span>안전 백업 / 작업 ID는 로그에서 추적${esc(skippedText)} · 서비스·주소·업무 데이터는 별도 검증</span>${portalTodoHtml}<div class="bundle-result-actions">${portalHtml}<button class="button small" type="button" data-bundle="logs">${icon("logs")}실행 로그</button></div></section>`;
  }

  wantTargets() {
    const m = this.model;
    if (m.mode !== "clone" || typeof this.api?.restoreTargets !== "function") return;
    const t = this.targets ||= { loading: false, loaded: false, error: "", enabled: false, currentSubscription: "", subscriptions: [], groups: {}, networks: {}, networkLoading: {} };
    t.networks ||= {};
    t.networkLoading ||= {};
    const sid = m.targetSubscription || t.currentSubscription || this.state?.workspace?.subscription || "";
    const needNetworks = Boolean(sid) && this.hasSharedNetworkEdges();
    if (!t.loading && !t.error && (!t.loaded || (t.enabled && sid && !t.groups[sid]))) {
      t.loading = true;
      this.api.restoreTargets(sid).then((data) => {
        if (!this.alive) return;
        Object.assign(t, { enabled: data.enabled === true, currentSubscription: data.currentSubscription || "",
          subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [], loaded: true });
        const resolvedSid = data.subscriptionId || sid;
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

  modalControls() {
    const dlg = this.dialogElement || this.root?.ownerDocument?.getElementById?.("app-dialog") || null;
    if (!dlg) return null;
    const open = this.openDialog || ((title, body, actionsHtml = "") => {
      const h2 = dlg.querySelector("#dialog-title");
      const bodyEl = dlg.querySelector("#dialog-body");
      const actEl = dlg.querySelector("#dialog-actions");
      if (h2) h2.textContent = title;
      if (bodyEl) bodyEl.innerHTML = body;
      if (actEl) actEl.innerHTML = actionsHtml;
      if (!dlg.open) dlg.showModal?.();
    });
    const close = this.closeDialog || (() => { if (dlg.open) dlg.close?.(); });
    return { dialogElement: dlg, openDialog: open, closeDialog: close };
  }

  targetContextInfo() {
    const m = this.model, t = this.targets;
    const sid = this.targetSubscriptionId();
    const groups = t?.groups?.[sid];
    const names = new Map((t?.subscriptions || []).map((item) => [item.subscriptionId.toLowerCase(), item.name]));
    const graphNodes = this.graph?.nodes || [];
    const chosen = graphNodes.length ? bundleSelection(this.graph, m.selected || [], m.includeRelated, m.excludedRelated) : [];
    const primaryNode = chosen.find((n) => !n.parentId) || chosen[0] || null;
    const sourceRg = primaryNode ? (String(primaryNode.id || "").split("/")[4] || "") : (this.state?.workspace?.resourceGroup || "");
    const sourceLocations = [...new Set(chosen.map((node) => node.location).filter((loc) => loc && loc.toLowerCase() !== "global"))];
    const groupLocations = (groups || []).map((group) => group.location).filter(Boolean);
    const locationChoices = [...new Set([...sourceLocations, ...groupLocations, ...COMMON_LOCATIONS].map((loc) => loc.toLowerCase()))];
    const defaultLocLabel = sourceLocations.length ? `원본 리전 (${sourceLocations.join(", ")})` : "원본 리전 유지";
    const subLabel = names.get(sid.toLowerCase()) || sid || "현재 구독";
    const targetRgMeta = (groups || []).find((g) => key(g.name) === key(m.targetGroup || ""));
    const effectiveRegion = m.targetLocation || targetRgMeta?.location || sourceLocations[0] || "";
    return { sid, groups, names, chosen, sourceRg, sourceLocations, locationChoices, defaultLocLabel, subLabel, effectiveRegion };
  }

  cloneNamingFieldHtml(locked) {
    const m = this.model;
    const nameMode = CLONE_NAME_MODES.includes(m.cloneNameMode) ? m.cloneNameMode : "prefix";
    const { topChosen } = this.relatedContext();
    const directIds = new Set((m.selected || []).map(key));
    const primaryNodes = topChosen.filter((node) => directIds.has(key(node.id)));
    const companionNodes = topChosen.filter((node) => !directIds.has(key(node.id)));
    const orderedNodes = [...primaryNodes, ...companionNodes];
    const modeButtons = [
      ["prefix", "접두사"],
      ["suffix", "접미사"],
      ["sequence", "일련 번호"],
      ["direct", "직접 지정"],
    ].map(([id, label]) => `<button type="button" class="segmented-choice ${nameMode === id ? "active" : ""}" data-clone-name-mode="${id}" aria-pressed="${nameMode === id}" ${locked}>${label}</button>`).join("");

    let bodyHtml = "";
    if (nameMode === "prefix") {
      bodyHtml = `<div class="smart-clone-grid"><label class="field"><span class="field-label">이름 접두사${m.targetGroup ? " (선택)" : ""}</span><input type="text" id="bundle-prefix" maxlength="20" value="${esc(m.clonePrefix || "")}" placeholder="${m.targetGroup ? "비워 두면 원본 이름 유지" : "예: copy, dr, stg"}" ${locked}></label></div>`;
    } else if (nameMode === "suffix") {
      bodyHtml = `<div class="smart-clone-grid"><label class="field"><span class="field-label">이름 접미사${m.targetGroup ? " (선택)" : ""}</span><input type="text" id="bundle-suffix" maxlength="30" value="${esc(m.cloneSuffix || "")}" placeholder="${m.targetGroup ? "비워 두면 원본 이름 유지" : "예: copy, dr, blue, v2"}" ${locked}></label></div>`;
    } else if (nameMode === "sequence") {
      bodyHtml = `<div class="smart-clone-grid"><div class="field"><label for="bundle-sequence" class="field-label">일련 번호</label><div class="sequence-input-row"><button type="button" class="button small seq-step-btn" data-seq-step="-1" aria-label="일련 번호 1 감소" ${locked}>−</button><input type="text" id="bundle-sequence" inputmode="numeric" maxlength="8" value="${esc(m.cloneSequence || "")}" placeholder="예: 02, 001" ${locked}><button type="button" class="button small seq-step-btn" data-seq-step="1" aria-label="일련 번호 1 증가" ${locked}>+</button></div><small class="field-hint">원본 이름 끝의 번호(예: -01)를 바꾸거나, 번호가 없으면 뒤에 붙입니다.</small></div></div>`;
    } else if (nameMode === "direct") {
      const directMap = m.directNames || {};
      const fields = orderedNodes.map((node) => {
        const isPrimary = directIds.has(key(node.id));
        const labelText = isPrimary
          ? (primaryNodes.length <= 1 ? `새 리소스 이름 (${node.name})` : `새 이름 · ${node.name}`)
          : `동반 리소스 새 이름 · ${node.name} (${node.label || "연관"})`;
        const val = directMap[key(node.id)] ?? "";
        return `<label class="field"><span class="field-label">${esc(labelText)}</span><input type="text" data-direct-name="${esc(node.id)}" maxlength="80" value="${esc(val)}" placeholder="${esc(m.targetGroup ? node.name : `${node.name}-copy`)}" ${locked}></label>`;
      }).join("");
      bodyHtml = `<div class="smart-clone-grid">${fields}</div>`;
    }

    return `<div class="clone-naming-block field-span-2">
      <div class="field">
        <span class="field-label">새 리소스 이름 지정 방식</span>
        <div class="segmented-choices" role="group" aria-label="새 리소스 이름 지정 방식">${modeButtons}</div>
      </div>
      ${bodyHtml}
    </div>`;
  }

  prefixFieldHtml(locked) {
    return this.cloneNamingFieldHtml(locked);
  }

  targetFields(locked, { includePrefix = true } = {}) {
    const m = this.model, t = this.targets;
    const prefixMarkup = includePrefix ? this.cloneNamingFieldHtml(locked) : "";
    if (!t || (t.loading && !t.loaded)) return `<div class="operation-strip" role="status"><span class="spinner"></span>복제할 수 있는 구독·리소스 그룹을 조회하고 있습니다.</div>${prefixMarkup}`;
    if (t.error) return `<div class="notice error" role="alert">${esc(t.error)}</div><button class="button small" data-bundle="retarget" ${locked}>${icon("refresh")}대상 다시 조회</button>${prefixMarkup}`;
    if (!t.enabled) return `${prefixMarkup}<small class="field-hint">구성된 범위 안에서 새 리소스 이름을 지정해 복제합니다.</small>`;
    const { subLabel, sourceRg, effectiveRegion } = this.targetContextInfo();
    const crossSub = Boolean(m.targetSubscription && m.targetSubscription.toLowerCase() !== t.currentSubscription.toLowerCase());
    const segments = m.targetGroup
      ? [
          { kind: "구독", value: subLabel, icon: "cloud", sub: crossSub ? "타 구독" : "현재" },
          { kind: "리소스 그룹", value: m.targetGroup, icon: "folder" },
        ]
      : [
          { kind: "구독", value: subLabel, icon: "cloud", sub: "현재" },
          sourceRg
            ? { kind: "리소스 그룹", value: sourceRg, icon: "folder", sub: "원본 유지" }
            : { kind: "리소스 그룹", value: "원본과 같은 리소스 그룹 유지", icon: "folder" },
        ];
    const regionPill = effectiveRegion
      ? `<span class="count-pill" title="배포 리전">${esc(m.targetLocation ? `리전 지정 · ${m.targetLocation}` : effectiveRegion)}</span>`
      : "";
    const pickerBar = pickerTriggerHtml({
      ariaLabel: "대상 구독 · 리소스 그룹 · 리전",
      segments,
      metaHtml: regionPill,
      buttonLabel: "대상 위치 선택",
      actionAttr: 'data-bundle="pick-target"',
      disabled: Boolean(locked),
    }, { esc, icon });
    return `<div class="clone-target">
      <div class="field"><span class="field-label">대상 구독 · 리소스 그룹 · 리전</span>${pickerBar}</div>
      ${crossSub ? `<small class="field-hint">타 구독(${esc(subLabel)}) 복제 시 구독 경계를 넘는 공유 참조는 쓸 수 없어 연관 리소스를 함께 복제하고 대상 구독 서브넷을 연결합니다.</small>` : ""}
      ${prefixMarkup}
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

  restoreConfigControlsHtml(locked) {
    const { chosen, topChosen, relatedEdges, nodes } = this.relatedContext();
    const m = this.model;
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
    const presentCompanionEdges = relatedEdges.filter(
      (edge) => this.state?.current?.[key(edge.to)]?.status !== "missing",
    );
    const companionField = this.embedded && presentCompanionEdges.length
      ? `<div class="field field-span-2"><span class="field-label">연결된 리소스 함께 되돌리기 (선택)</span><div class="companion-inline">${presentCompanionEdges.map((edge) => {
          const rNode = nodes.get(key(edge.to));
          const checked = m.includeRelated && !leftOut.has(key(edge.to));
          return `<label class="check-label companion-option ${checked ? "checked" : ""}"><input type="checkbox" data-restore-companion="${esc(edge.to)}" ${checked ? "checked" : ""} ${locked}><span class="companion-option-text"><strong>${esc(rNode?.name || edge.to)}</strong><small>(${esc(rNode?.label || "연관")})</small></span></label>`;
        }).join("")}</div></div>`
      : "";
    const immutableField = chosen.length && m.mode === "update"
      ? `<div class="field field-span-2"><span class="field-label">불변·충돌 속성 처리</span><div class="segmented-choices" role="group" aria-label="불변 및 충돌 속성 처리 방식"><button type="button" class="segmented-choice ${m.immutableConflict !== "block" ? "active" : ""}" data-immutable-choice="keep-current" aria-pressed="${m.immutableConflict !== "block"}" ${locked}>가능한 속성 복원 · 불변 항목 현재 값 유지 (권장)</button><button type="button" class="segmented-choice ${m.immutableConflict === "block" ? "active" : ""}" data-immutable-choice="block" aria-pressed="${m.immutableConflict === "block"}" ${locked}>불변·충돌 차이 시 중단</button></div></div>`
      : "";
    const alertsHtml = alerts.map((text) => `<p class="decision-alert" role="note">${icon("alert")}<span>${esc(text)}</span></p>`).join("");
    const gridHtml = companionField || immutableField
      ? `<div class="smart-clone-grid">${companionField}${immutableField}</div>`
      : "";
    return `${alertsHtml}${gridHtml}`;
  }

  smartCloneFields(locked, { prependHtml = "" } = {}) {
    const { chosen, topChosen, relatedEdges, nodes } = this.relatedContext();
    if (!chosen.length) return prependHtml ? `<div class="smart-clone-grid">${prependHtml}</div>` : "";
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

    const bindingFields = sharedNetEdges.map(({ refId, refLow, isSubnet, fromName }, idx) => {
      const boundVal = bindings[refLow] || "";
      const mustRebind = this.isCrossBoundary();
      const subHit = isSubnet && boundVal ? subnetLookup.get(key(boundVal)) : null;
      const vnetHit = !isSubnet && boundVal ? vnetLookup.get(key(boundVal)) : null;
      let segments = [];
      let metaHtml = "";
      if (boundVal) {
        if (subHit) {
          segments = [
            { kind: "RG", value: subHit.vnet.resourceGroup, icon: "folder" },
            { kind: "VNet", value: subHit.vnet.name, icon: "network" },
            { kind: "서브넷", value: subHit.sub.name },
          ];
          if (subHit.sub.addressPrefixes?.length) {
            metaHtml = `<code class="cidr-pill">${esc(subHit.sub.addressPrefixes.join(", "))}</code>`;
          }
        } else if (vnetHit) {
          segments = [
            { kind: "RG", value: vnetHit.resourceGroup, icon: "folder" },
            { kind: "VNet", value: vnetHit.name, icon: "network", sub: vnetHit.location || "" },
          ];
        } else {
          segments = [{ kind: isSubnet ? "서브넷" : "VNet", value: shortNetworkPath(boundVal), icon: "network", title: boundVal }];
        }
      } else if (!mustRebind) {
        segments = [{ kind: isSubnet ? "공유 서브넷" : "공유 VNet", value: shortNetworkPath(refId), sub: "원본 그대로 공유", icon: "network", title: refId }];
      }
      const bar = pickerTriggerHtml({
        ariaLabel: `${isSubnet ? "연결할 서브넷" : "연결할 가상 네트워크"} (${fromName})`,
        segments,
        emptyTitle: isSubnet ? "대상 환경의 서브넷을 선택하세요" : "대상 환경의 가상 네트워크를 선택하세요",
        emptyHint: "타 구독·리전 복제 시 필수",
        metaHtml,
        buttonLabel: boundVal || !mustRebind ? "네트워크 변경" : (isSubnet ? "서브넷 선택" : "네트워크 선택"),
        actionAttr: `data-bundle-pick-binding="${esc(refId)}" data-binding-mode="${isSubnet ? "subnet" : "vnet"}" data-binding-idx="${idx}"`,
        disabled: Boolean(locked),
        attention: Boolean(mustRebind && !boundVal),
      }, { esc, icon });
      return `<div class="field field-span-2"><span class="field-label">${isSubnet ? "연결할 서브넷" : "연결할 가상 네트워크"} (${esc(fromName)})${mustRebind ? " — 필수" : ""}</span>${bar}</div>`;
    }).join("");

    const shareableEdges = !this.isCrossBoundary()
      ? relatedEdges.filter((edge) => edge.relation !== "required" && edge.relationClass !== "exclusive")
      : [];
    const deferredMap = m.deferredPortal || {};
    const shareableFields = shareableEdges.map((edge) => {
      const rNode = nodes.get(key(edge.to));
      const sharedMode = !m.includeRelated || leftOut.has(key(edge.to));
      const itemKey = `companion:${key(edge.to)}`;
      return configItemCardHtml({
        itemKey,
        title: `${rNode?.label || "연관 정책"} 함께 복제·생성`,
        subtitle: rNode?.name || edge.to,
        checked: !sharedMode,
        deferredHint: "새 정책 리소스를 만들지 않고 원본 정책 공유를 유지합니다 · 완료 후 포털에서 별도 정책 생성·연결 가능",
        bodyHtml: `<div class="segmented-choices" role="group" aria-label="${esc(rNode?.name || edge.to)} 처리 방식"><button type="button" class="segmented-choice ${!sharedMode ? "active" : ""}" data-shareable-choice="clone" data-shareable-id="${esc(edge.to)}" aria-pressed="${!sharedMode}" ${locked}>새 리소스로 함께 복제</button><button type="button" class="segmented-choice ${sharedMode ? "active" : ""}" data-shareable-choice="share" data-shareable-id="${esc(edge.to)}" aria-pressed="${sharedMode}" ${locked}>원본 그대로 공유</button></div>`,
        locked,
      });
    }).join("");

    const smartPoolIps = m.smartPoolIps || {};
    const poolFields = topChosen.flatMap((node) => (node.cloneHints?.backendPools || []).map((pool) => {
      const pKey = `${key(node.id)}::${key(pool.name)}`;
      const itemKey = `lbpool:${pKey}`;
      const checked = !deferredMap[itemKey] && m.backendPoolMode !== "empty";
      const poolMode = m.backendPoolMode === "empty" ? "placeholder" : (m.backendPoolMode || "placeholder");
      const vnetMeta = vnetLookup.get(key(bindings[key(pool.vnetId || "")] || pool.vnetId || ""));
      const cidrs = (vnetMeta?.subnets || []).flatMap((s) => s.addressPrefixes || []);
      const autoIp = m.smartPoolIps?.[pKey] || suggestSampleIp(cidrs, pool.sampleIps || [], pool.sampleIps || []) || pool.suggestedPlaceholderIp || "";
      const autoLabel = autoIp && !this.isCrossBoundary() ? ` · ${autoIp}` : "";
      const ipInputHtml = poolMode === "placeholder"
        ? `<label class="field"><span class="field-label">백엔드 사설 IP 지정 (쉼표로 복수 입력 가능)</span><input type="text" data-smart-pool-ip="${esc(pKey)}" value="${esc(smartPoolIps[pKey] ?? "")}" placeholder="${esc(autoIp || "예: 10.224.0.250, 10.224.0.251")}" ${locked}></label>`
        : `<small class="field-hint">원본 백엔드 사설 IP(${esc((pool.sampleIps || []).join(", ") || `${pool.ipCount}개`)})를 그대로 유지합니다.</small>`;
      return configItemCardHtml({
        itemKey,
        title: `Load Balancer 백엔드 풀 (${pool.name})`,
        subtitle: node.name,
        checked,
        deferredHint: "빈 백엔드 풀로 먼저 생성하여 원본 NIC·서버 간섭을 방지합니다 · 완료 후 포털(백엔드 풀)에서 대상 직접 연결",
        bodyHtml: `<div class="segmented-choices" role="group" aria-label="백엔드 풀 구성 방식"><button type="button" class="segmented-choice ${poolMode === "placeholder" ? "active" : ""}" data-pool-choice="placeholder" aria-pressed="${poolMode === "placeholder"}" ${locked}>사설 IP 지정 생성 (권장${esc(autoLabel)})</button><button type="button" class="segmented-choice ${poolMode === "keep" ? "active" : ""}" data-pool-choice="keep" aria-pressed="${poolMode === "keep"}" ${locked}>원본 IP 유지</button></div>${ipInputHtml}`,
        locked,
        span2: true,
      });
    })).join("");

    const smartAgwPools = m.smartAgwPools || {};
    const agwPoolFields = topChosen.flatMap((node) => (node.cloneHints?.agwBackendPools || []).map((pool) => {
      const pKey = `${key(node.id)}::${key(pool.name)}`;
      const itemKey = `agwpool:${pKey}`;
      const checked = !deferredMap[itemKey];
      const currentVal = smartAgwPools[pKey] ?? (pool.targets || []).join(", ");
      return configItemCardHtml({
        itemKey,
        title: `Application Gateway 백엔드 풀 (${pool.name})`,
        subtitle: node.name,
        checked,
        deferredHint: "빈 백엔드 풀로 먼저 생성하여 원본 운영 서버 호출을 방지합니다 · 완료 후 포털(백엔드 풀)에서 대상 IP·FQDN 입력",
        bodyHtml: `<label class="field"><span class="field-label">대상 백엔드 서버 IP · FQDN (쉼표 구분)</span><input type="text" data-smart-agw-pool="${esc(pKey)}" value="${esc(currentVal)}" placeholder="예: 10.2.0.10, app-dr.contoso.com" ${locked}></label><small class="field-hint">원본 대상: ${esc((pool.targets || []).join(", ") || "없음")}</small>`,
        locked,
        span2: true,
      });
    })).join("");

    const dnsFields = topChosen.filter((node) => node.cloneHints?.dnsLabel).map((node) => {
      const baseDns = node.cloneHints.dnsLabel;
      const itemKey = `dns:${key(node.id)}`;
      const checked = !deferredMap[itemKey];
      const currentVal = smartDns[key(node.id)] ?? "";
      const autoHint = suggestCloneDnsLabel(baseDns, m, resolveCloneTargetName(node, m), node.name);
      return configItemCardHtml({
        itemKey,
        title: "공용 IP DNS 도메인 레이블",
        subtitle: node.name,
        checked,
        deferredHint: "DNS 이름 레이블 없이 공용 IP를 먼저 생성해 중복 충돌을 방지합니다 · 완료 후 포털(구성)에서 직접 입력",
        bodyHtml: `<label class="field"><span class="field-label">새 DNS 도메인 레이블</span><input type="text" data-smart-dns="${esc(node.id)}" maxlength="63" value="${esc(currentVal)}" placeholder="${esc(autoHint || baseDns)}" ${locked}></label><small class="field-hint">리전 전체에서 유일해야 합니다 (원본: ${esc(baseDns)}).</small>`,
        locked,
      });
    }).join("");

    const requiredIpFields = topChosen.flatMap((node) => (node.cloneHints?.staticFrontends || []).flatMap((fe) => {
      const ipKey = `${key(node.id)}::${key(fe.name)}`;
      const itemKey = `ip:${ipKey}`;
      const checked = !deferredMap[itemKey];
      const currentIp = smartIps[ipKey] ?? "";
      const subLow = key(fe.subnetId || "");
      const boundSub = String(bindings[subLow] || "").trim();
      const sameSubnet = Boolean(subLow) && (!boundSub || key(boundSub) === subLow);
      const targetSubMeta = subnetLookup.get(key(boundSub || fe.subnetId || ""));
      const cidrs = targetSubMeta?.sub?.addressPrefixes || [];
      const outOfCidr = Boolean(boundSub && cidrs.length && !ipInCidrs(fe.privateIPAddress, cidrs));
      if (!fe.requiresStatic && !sameSubnet && !outOfCidr && !currentIp && checked) return [];
      const cidrHint = cidrs.length ? cidrs.join(", ") : "대상 서브넷";
      const sampleIp = suggestSampleIp(cidrs, [fe.privateIPAddress], sameSubnet ? [fe.privateIPAddress] : []) || fe.suggestedPrivateIp || "";
      const restoreSample = !currentIp && sampleIp
        ? `<div class="sample-bar"><button type="button" class="sample-chip" data-sample-field="smartPrivateIps" data-sample-key="${esc(ipKey)}" data-sample-value="${esc(sampleIp)}" ${locked}>추천 IP 입력: ${esc(sampleIp)}</button></div>`
        : "";
      const deferredHint = fe.requiresStatic
        ? "대상 서브넷 대역의 충돌 없는 임시 정적 IP로 먼저 생성합니다 · 완료 후 포털(프런트엔드 IP 구성)에서 변경"
        : "동적(Dynamic) 사설 IP 자동 배정으로 먼저 생성합니다 · 완료 후 포털(프런트엔드 IP 구성)에서 정적 IP 지정 가능";
      return [configItemCardHtml({
        itemKey,
        title: `사설 프런트엔드 정적 IP (${fe.name})`,
        subtitle: node.name,
        checked,
        deferredHint,
        bodyHtml: `<label class="field"><span class="field-label">지정할 정적 사설 IP</span><input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(currentIp)}" placeholder="${esc(sampleIp || "예: 10.0.1.250")}" ${locked}></label>${restoreSample}<small class="field-hint">${esc(cidrHint)} 대역 · 원본 ${esc(fe.privateIPAddress)}${sameSubnet ? " 제외" : ""}</small>`,
        locked,
      })];
    })).join("");

    const pfxFields = this.pfxCertificateFields(topChosen, locked);
    const decisionBlocks = [prependHtml, bindingFields, shareableFields, poolFields, agwPoolFields, requiredIpFields, dnsFields, pfxFields].filter(Boolean);
    return decisionBlocks.length ? `<div class="smart-clone-grid">${decisionBlocks.join("")}</div>` : "";
  }

  pfxCertificateFields(topChosen, locked) {
    const m = this.model;
    const deferredMap = m.deferredPortal || {};
    const smartKv = m.smartKeyVaultCerts || {};
    const isUpdate = m.mode === "update";
    return topChosen.flatMap((node) => (node.cloneHints?.pfxCertificates || []).map((certName) => {
      const kvKey = `${key(node.id)}::${key(certName)}`;
      const itemKey = `cert:${kvKey}`;
      const checked = !deferredMap[itemKey];
      const currentKv = smartKv[kvKey] ?? "";
      const deferredHint = isUpdate
        ? "현재 게이트웨이에 등록된 인증서를 유지하고 나머지 설정을 복원합니다 · 완료 후 포털(SSL 인증서)에서 교체 가능"
        : "PFX 비밀값이 백업에 없어 호환 리스너(또는 임시 HTTP)로 먼저 생성합니다 · 완료 후 포털(SSL 인증서·수신기)에서 등록";
      return configItemCardHtml({
        itemKey,
        title: `SSL 인증서 연결 (${certName})`,
        subtitle: node.name,
        checked,
        deferredHint,
        bodyHtml: `<label class="field"><span class="field-label">Key Vault 인증서 Secret URI</span><input type="text" data-smart-kv="${esc(kvKey)}" value="${esc(currentKv)}" placeholder="https://<keyvault>.vault.azure.net/secrets/<cert>" ${locked}></label><small class="field-hint">업로드형 PFX 개인키는 백업에 포함되지 않습니다. 게이트웨이 관리 ID에 Key Vault 조회 권한이 있는 Secret URI를 입력하세요.</small>`,
        locked,
      });
    })).join("");
  }

  restorePropertyFields(locked) {
    const { topChosen } = this.relatedContext();
    if (!topChosen.length || this.model.mode === "clone") return "";
    const m = this.model;
    const deferredMap = m.deferredPortal || {};
    const bindings = m.referenceBindings || {};
    const smartIps = m.smartPrivateIps || {};
    const smartDns = m.smartDnsLabels || {};
    const smartPoolIps = m.smartPoolIps || {};
    const smartAgwPools = m.smartAgwPools || {};
    const blocks = [];

    if (m.mode === "update" && this.state?.current) {
      for (const node of topChosen) {
        const liveGwIps = this.state.current[key(node.id)]?.raw?.properties?.gatewayIPConfigurations;
        if (!Array.isArray(liveGwIps)) continue;
        for (const gwSub of node.cloneHints?.gatewaySubnets || []) {
          const liveMatch = liveGwIps.find((item) => key(item?.name || "") === key(gwSub.name));
          const liveSubId = liveMatch?.properties?.subnet?.id;
          if (liveSubId && gwSub.subnetId && key(liveSubId) !== key(gwSub.subnetId)) {
            const itemKey = `subnet:${key(node.id)}::${key(gwSub.name)}`;
            const checked = !deferredMap[itemKey];
            const curBound = bindings[key(gwSub.subnetId)] || "";
            blocks.push(configItemCardHtml({
              itemKey,
              title: `게이트웨이 서브넷 충돌 해소 (${gwSub.name})`,
              subtitle: node.name,
              checked,
              deferredHint: `현재 연결된 서브넷(${shortNetworkPath(liveSubId)})을 그대로 유지해 중단 없이 복원합니다 · 완료 후 포털에서 확인`,
              bodyHtml: `<label class="field"><span class="field-label">연결할 서브넷 ARM ID</span><input type="text" data-smart-binding-custom="${esc(gwSub.subnetId)}" value="${esc(curBound)}" placeholder="${esc(liveSubId)}" ${locked}></label><div class="sample-bar"><button type="button" class="sample-chip" data-sample-field="referenceBindings" data-sample-key="${esc(key(gwSub.subnetId))}" data-sample-value="${esc(liveSubId)}" ${locked}>현재 서브넷 유지: ${esc(shortNetworkPath(liveSubId))}</button></div><small class="field-hint">백업 서브넷(${esc(shortNetworkPath(gwSub.subnetId))})과 현재 서브넷이 다릅니다.</small>`,
              locked,
              span2: true,
            }));
          }
        }
      }
    }

    if (m.mode === "create") {
      for (const node of topChosen) {
        for (const fe of node.cloneHints?.staticFrontends || []) {
          const ipKey = `${key(node.id)}::${key(fe.name)}`;
          const itemKey = `ip:${ipKey}`;
          const checked = !deferredMap[itemKey];
          blocks.push(configItemCardHtml({
            itemKey,
            title: `사설 프런트엔드 정적 IP (${fe.name})`,
            subtitle: node.name,
            checked,
            deferredHint: fe.requiresStatic
              ? "충돌 없는 임시 정적 사설 IP로 먼저 재생성합니다 · 완료 후 포털(프런트엔드 IP 구성)에서 변경"
              : "동적(Dynamic) 사설 IP 배정으로 먼저 재생성합니다 · 완료 후 포털(프런트엔드 IP 구성)에서 변경",
            bodyHtml: `<label class="field"><span class="field-label">복원할 정적 사설 IP</span><input type="text" data-smart-ip="${esc(ipKey)}" value="${esc(smartIps[ipKey] ?? "")}" placeholder="${esc(`백업 원본: ${fe.privateIPAddress}`)}" ${locked}></label><small class="field-hint">비워 두면 백업 시점 사설 IP(${esc(fe.privateIPAddress)})로 재생성합니다.</small>`,
            locked,
          }));
        }
        if (node.cloneHints?.dnsLabel) {
          const baseDns = node.cloneHints.dnsLabel;
          const itemKey = `dns:${key(node.id)}`;
          const checked = !deferredMap[itemKey];
          blocks.push(configItemCardHtml({
            itemKey,
            title: "공용 IP DNS 도메인 레이블",
            subtitle: node.name,
            checked,
            deferredHint: "DNS 이름 레이블 없이 공용 IP를 먼저 재생성합니다 · 완료 후 포털(구성)에서 설정",
            bodyHtml: `<label class="field"><span class="field-label">복원할 DNS 도메인 레이블</span><input type="text" data-smart-dns="${esc(node.id)}" maxlength="63" value="${esc(smartDns[key(node.id)] ?? "")}" placeholder="${esc(`백업 원본: ${baseDns}`)}" ${locked}></label><small class="field-hint">비워 두면 백업 시점 DNS 레이블(${esc(baseDns)})로 재생성합니다.</small>`,
            locked,
          }));
        }
      }
    }

    for (const node of topChosen) {
      for (const pool of node.cloneHints?.backendPools || []) {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        const itemKey = `lbpool:${pKey}`;
        const checked = !deferredMap[itemKey];
        const deferredHint = m.mode === "update"
          ? "현재 연결된 백엔드 풀 멤버를 그대로 유지하고 나머지 설정만 복원합니다 · 완료 후 포털(백엔드 풀)에서 조정"
          : "빈 백엔드 풀로 먼저 재생성합니다 · 완료 후 포털(백엔드 풀)에서 VM·NIC 또는 IP 직접 연결";
        const bodyHtml = m.mode === "update"
          ? `<small class="field-hint">백업 시점 사설 IP 멤버(${esc((pool.sampleIps || []).join(", ") || `${pool.ipCount}개`)})로 복원합니다${pool.nicCount ? ` (NIC 연결 ${pool.nicCount}개는 NIC 소유여서 유지)` : ""}.</small>`
          : `<label class="field"><span class="field-label">재생성할 백엔드 사설 IP (쉼표 구분)</span><input type="text" data-smart-pool-ip="${esc(pKey)}" value="${esc(smartPoolIps[pKey] ?? "")}" placeholder="${esc((pool.sampleIps || []).join(", ") || pool.suggestedPlaceholderIp || "예: 10.0.1.4")}" ${locked}></label><small class="field-hint">${pool.nicCount ? `원본 NIC 멤버 ${pool.nicCount}개는 VM NIC에서 소유합니다. IP로 지정하거나 체크를 해제해 포털에서 연결하세요.` : `백업 원본: ${esc((pool.sampleIps || []).join(", ") || "없음")}`}</small>`;
        blocks.push(configItemCardHtml({
          itemKey,
          title: `Load Balancer 백엔드 풀 (${pool.name})`,
          subtitle: node.name,
          checked,
          deferredHint,
          bodyHtml,
          locked,
          span2: m.mode === "create",
        }));
      }
      for (const pool of node.cloneHints?.agwBackendPools || []) {
        const pKey = `${key(node.id)}::${key(pool.name)}`;
        const itemKey = `agwpool:${pKey}`;
        const checked = !deferredMap[itemKey];
        const currentVal = smartAgwPools[pKey] ?? (pool.targets || []).join(", ");
        const deferredHint = m.mode === "update"
          ? "현재 게이트웨이에 연결된 백엔드 대상 주소를 그대로 유지합니다 · 완료 후 포털(백엔드 풀)에서 직접 조정"
          : "빈 백엔드 풀로 먼저 재생성합니다 · 완료 후 포털(백엔드 풀)에서 대상 IP·FQDN 직접 입력";
        blocks.push(configItemCardHtml({
          itemKey,
          title: `Application Gateway 백엔드 풀 (${pool.name})`,
          subtitle: node.name,
          checked,
          deferredHint,
          bodyHtml: `<label class="field"><span class="field-label">복원할 대상 백엔드 IP · FQDN (쉼표 구분)</span><input type="text" data-smart-agw-pool="${esc(pKey)}" value="${esc(currentVal)}" placeholder="예: 10.1.0.5, api.contoso.com" ${locked}></label><small class="field-hint">백업 원본 대상: ${esc((pool.targets || []).join(", ") || "없음")}</small>`,
          locked,
          span2: true,
        }));
      }
    }

    const pfxHtml = this.pfxCertificateFields(topChosen, locked);
    if (!blocks.length && !pfxHtml) return "";
    return `<div class="smart-clone-grid">${blocks.join("")}${pfxHtml}</div>`;
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
    const { topChosen } = this.relatedContext();
    const smartNames = m.smartNames || {};

    const renameFields = isClone && m.cloneNameMode !== "direct" && topChosen.length
      ? topChosen.map((node) => `<label class="field"><span class="field-label">개별 이름 (${esc(node.name)})</span><input type="text" data-smart-name="${esc(node.id)}" maxlength="80" value="${esc(smartNames[key(node.id)] || "")}" placeholder="${esc(resolveCloneTargetName(node, { ...m, smartNames: {} }) || node.name)}" ${locked}></label>`).join("")
      : "";

    const immutableField = !this.embedded && m.mode === "update"
      ? `<div class="field field-span-2"><span class="field-label">불변·충돌 속성 처리</span><div class="segmented-choices" role="group" aria-label="불변 및 충돌 속성 처리 방식"><button type="button" class="segmented-choice ${m.immutableConflict !== "block" ? "active" : ""}" data-immutable-choice="keep-current" aria-pressed="${m.immutableConflict !== "block"}" ${locked}>가능한 속성 복원 · 불변 항목 현재 값 유지 (권장)</button><button type="button" class="segmented-choice ${m.immutableConflict === "block" ? "active" : ""}" data-immutable-choice="block" aria-pressed="${m.immutableConflict === "block"}" ${locked}>불변·충돌 차이 시 중단</button></div></div>`
      : "";

    const extraBundleSection = this.embedded && this.graph?.nodes
      ? (() => {
          const topNodes = [...this.graph.nodes].filter((node) => !node.parentId).sort((a, b) => String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), "en"));
          if (topNodes.length <= 1) return "";
          const segments = topChosen.slice(0, 3).map((node) => ({
            icon: node.icon || "box",
            value: node.name,
            sub: node.label || "",
          }));
          const moreCount = Math.max(0, topChosen.length - 3);
          const bar = pickerTriggerHtml({
            ariaLabel: "같은 백업 시점의 다른 리소스 함께 묶기",
            segments,
            metaHtml: moreCount ? `<span class="count-pill">외 ${moreCount}개</span>` : "",
            buttonLabel: "묶을 리소스 선택",
            actionAttr: 'data-bundle="pick-extra-resources"',
            disabled: Boolean(locked),
          }, { esc, icon });
          return `<div class="advanced-subsection"><span class="field-label">같은 백업 시점의 다른 리소스 함께 묶기</span>${bar}</div>`;
        })()
      : "";

    const hasAdvancedEdits = Boolean(
      m.overridesText
      || m.ticket
      || m.reason
      || (!this.embedded && m.immutableConflict === "block")
      || (m.selected && m.selected.length > 1)
      || Object.values(smartNames).some((v) => String(v || "").trim()),
    );

    return `<details class="advanced-overrides" ${hasAdvancedEdits ? "open" : ""}>
      <summary>${isClone ? "고급 설정 (개별 이름 · 정책 태그 · 감사 메모)" : "고급 설정 (수동 속성 · 감사 메모)"}</summary>
      <div class="advanced-body">
        ${renameFields || immutableField
          ? `<div class="smart-clone-grid">${immutableField}${renameFields}</div>`
          : ""}
        <div class="plan-fields-grid">
          <label class="field"><span class="field-label">감사 티켓 (선택)</span><input type="text" id="bundle-ticket" maxlength="80" value="${esc(m.ticket)}" placeholder="비워 두면 자동 기록 (예: CHG-101)" ${locked}></label>
          <label class="field"><span class="field-label">작업 메모 (선택)</span><input type="text" id="bundle-reason" maxlength="500" value="${esc(m.reason)}" placeholder="로그에 남길 메모" ${locked}></label>
        </div>
        <div class="field"><label for="bundle-overrides" class="field-label">고급 속성 직접 지정 (선택 · 한 줄에 “자원이름 경로=값”)</label><textarea id="bundle-overrides" rows="2" spellcheck="false" placeholder="pip-web properties.ipTags=[{&quot;ipTagType&quot;:&quot;FirstPartyUsage&quot;:&quot;/Unprivileged&quot;}]" ${locked}>${esc(m.overridesText)}</textarea>${this.overrideSampleBar(locked)}</div>
        ${extraBundleSection}
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

  settingsFormHtml(locked) {
    const m = this.model;
    const clone = m.mode === "clone";
    const modeSelector = this.intent === "clone" || this.intent === "restore"
      ? ""
      : `<fieldset class="restore-choice"><legend>적용 방식</legend><label><input type="radio" name="bundle-mode" value="create" ${m.mode === "create" ? "checked" : ""} ${locked}>부재 자원 재생성</label><label><input type="radio" name="bundle-mode" value="update" ${m.mode === "update" ? "checked" : ""} ${locked}>기존 자원 업데이트</label><label><input type="radio" name="bundle-mode" value="clone" ${m.mode === "clone" ? "checked" : ""} ${locked}>독립 설정 복제</label></fieldset>`;
    return `${modeSelector}${clone ? `${this.targetFields(locked, { includePrefix: false })}${this.smartCloneFields(locked, { prependHtml: this.prefixFieldHtml(locked) })}` : `${this.restoreConfigControlsHtml(locked)}${this.restorePropertyFields(locked)}`}${this.advancedOptionsDrawer(locked)}`;
  }

  planDraftHtml(locked) {
    const m = this.model;
    const clone = m.mode === "clone";
    const { chosen, topChosen, relatedEdges } = this.relatedContext();
    const directIds = new Set((m.selected || []).map(key));
    const prefix = m.clonePrefix || "";
    const smartNames = m.smartNames || {};
    const edgeByTarget = new Map(relatedEdges.map((edge) => [key(edge.to), edge]));
    const listHtml = topChosen.length
      ? `<ol class="plan-preview-list" aria-label="${clone ? "생성될 복제 리소스 목록" : "복원 적용 대상 목록"}">${topChosen.map((node) => {
          const childCount = chosen.filter((c) => c.parentId && key(c.parentId) === key(node.id)).length;
          if (clone) {
            const targetName = resolveCloneTargetName(node, m) || "—";
            const relEdge = edgeByTarget.get(key(node.id));
            const roleText = directIds.has(key(node.id))
              ? (childCount ? `주 리소스 · 하위 ${childCount}개` : "주 리소스")
              : (relEdge?.relation === "required" || relEdge?.relationClass === "exclusive" ? "전용 동반" : "연관 포함");
            return `<li title="${esc(node.id)}"><span class="plan-item-mapping">${esc(node.name)} ${icon("arrow")} <strong data-preview-for="${esc(key(node.id))}">${esc(targetName)}</strong></span><span class="relation-label">${esc(roleText)}</span></li>`;
          }
          const actionText = m.mode === "create"
            ? "삭제 리소스 재생성"
            : (directIds.has(key(node.id)) ? "기존 설정 업데이트" : "동반 업데이트");
          return `<li title="${esc(node.id)}"><span class="plan-item-mapping"><strong>${esc(node.name)}</strong>${childCount ? `<small class="muted">하위 ${childCount}개 포함</small>` : ""}</span><span class="relation-label">${esc(actionText)}</span></li>`;
        }).join("")}</ol>`
      : "";
    const ids = new Set(chosen.map((node) => key(node.id)));
    const hasAddresses = (this.graph?.addresses || []).some((addr) => ids.has(key(addr.from)));
    const gatewayWithAddresses = clone && hasAddresses && topChosen.some((node) => node.resourceType === "microsoft.network/applicationgateways");
    const noteText = clone
      ? (gatewayWithAddresses
          ? "원본은 변경하지 않으며, 생성 후 원본 백엔드 주소로 상태 프로브가 연결됩니다."
          : "원본은 변경하지 않습니다. 왼쪽 설정을 확인한 뒤 계획을 검토하세요.")
      : (m.mode === "create"
          ? "부재가 확인된 리소스를 원래 위치·이름으로 재생성합니다."
          : "적용 직전 현재 상태를 안전 백업으로 먼저 보관합니다.");
    return `<div class="plan-draft">
      ${listHtml}
      <p class="plan-draft-note">${esc(noteText)}</p>
      <div class="plan-review-trigger">
        <button class="button primary" type="button" data-bundle="review" ${locked}>${icon("shield")}${clone ? "복제 계획 검토" : "복원 계획 검토"}</button>
        <small class="field-hint" data-gate="review" role="status"></small>
      </div>
    </div>`;
  }

  planBodyHtml(locked) {
    const m = this.model, plan = m.plan;
    const clone = m.mode === "clone";
    if (!plan) return this.planDraftHtml(locked);
    const showDest = Boolean(clone && plan.target && (m.targetGroup || this.isCrossSubscription() || !this.embedded));
    return `<div class="bundle-plan">
      ${this.embedded ? "" : `<h3>${icon("layers")}${clone ? `복제 계획 · ${plan.actions.length}개 리소스 생성` : `복원 계획 · ${plan.actions.length}개 리소스 적용`}</h3>`}
      ${showDest ? `<p class="clone-destination">${icon("arrow")}대상 위치 · ${esc(plan.target.subscriptionName)} / <b>${esc(plan.target.resourceGroup)}</b></p>` : ""}
      <ol class="plan-action-list">${plan.actions.map((action) => {
        const srcName = String(action.sourceResourceId || action.resourceId || "").split("/").at(-1);
        const label = clone && srcName && srcName !== action.name ? `${esc(srcName)} ${icon("arrow")} <strong>${esc(action.name)}</strong>` : `<strong>${esc(action.name)}</strong>`;
        return `<li title="${esc(action.resourceId)}"><span class="plan-item-mapping">${label}</span><span class="relation-label">${action.wasPresent ? "업데이트" : "생성"}</span></li>`;
      }).join("")}</ol>
      ${adjustmentList(plan)}
      <small class="plan-expiry-note">유효 시각 ${this.time(plan.expiresAt)} · 중간 실패 시 자동 롤백하지 않으며 안전 백업이 보존됩니다.</small>
      ${clone ? "" : `<label class="check-label"><input id="bundle-approve" type="checkbox" ${m.approved ? "checked" : ""} ${locked}>복원 전 현재 상태를 안전 백업으로 먼저 보관하고, 위 계획대로 실제 리소스를 복원합니다.</label>`}
      <div class="plan-execute-row">
        <button class="button primary" type="button" data-bundle="execute" disabled>${icon(clone ? "layers" : "restore")}${clone ? "복제 실행" : "안전 백업 후 복원"}</button>
        <button class="button ghost small" type="button" data-bundle="review" ${locked}>${icon("refresh")}다시 검토</button>
        <small class="field-hint" data-gate="execute" role="status"></small>
      </div>
    </div>`;
  }

  planPaneInnerHtml(locked) {
    const m = this.model, plan = m.plan;
    const isClone = m.mode === "clone";
    const { topChosen } = this.relatedContext();
    const countLabel = plan
      ? `${plan.actions.length}개 리소스 ${isClone ? "생성" : "적용"}`
      : `${topChosen.length}개 리소스 ${isClone ? "예정" : "대상"}`;
    const stateBadge = plan
      ? '<span class="side-badge verified">검토 완료</span>'
      : '<span class="side-badge unverified">검토 전</span>';
    return `<div class="panel-header">
      <h2 class="panel-title">${icon("shield")}${isClone ? "복제 계획" : "복원 계획"} <span class="count-pill">${esc(countLabel)}</span></h2>
      <div class="panel-header-actions">${stateBadge}</div>
    </div>
    <div class="panel-body restore-plan-body">
      ${this.planBodyHtml(locked)}
    </div>`;
  }

  syncPlanPaneAfterInput(hadPlan) {
    if (this.embedded) {
      if (hadPlan && !this.model.plan) {
        const planPane = this.root?.querySelector?.(".restore-plan-pane");
        if (planPane) planPane.innerHTML = this.planPaneInnerHtml(this.model.busy ? "disabled" : "");
      }
    } else if (!this.model.plan) {
      this.root?.querySelector?.(".bundle-plan")?.remove();
    }
  }

  reviewForm(locked) {
    return `<div class="bundle-review">${this.settingsFormHtml(locked)}${this.planBodyHtml(locked)}</div>`;
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
    if (this.isJobRunning()) return "서버 백그라운드에서 진행 중인 작업이 완료된 뒤 실행할 수 있습니다.";
    if (m.busy || !m.plan) return "";
    if (this.writeLocked?.()) return "최신 ARM 수집 상태를 확인 중이거나 지연되어 실행이 잠겨 있습니다. 상단 새로고침 후 실행하세요.";
    if (m.mode !== "clone" && !m.approved) {
      return "안전 백업 보관 및 실제 리소스 복원 확인란을 선택하세요.";
    }
    return "";
  }

  executeBlocked() {
    const m = this.model;
    if (m.busy || this.isJobRunning() || !m.plan) return true;
    return Boolean(this.executeBlockedReason());
  }

  updateGates() {
    const review = this.root.querySelector('[data-bundle="review"]');
    const reviewHint = this.root.querySelector('[data-gate="review"]');
    if (review) {
      try {
        const { subnetLookup } = this.networkLookup();
        bundleReviewInput(this.model, this.graph, subnetLookup);
        review.disabled = this.model.busy || this.isJobRunning();
        review.title = this.isJobRunning() ? "서버 백그라운드 작업이 진행 중입니다." : "";
        if (reviewHint && reviewHint !== review) reviewHint.textContent = this.isJobRunning() ? "서버 백그라운드 작업이 진행 중입니다." : "";
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
    for (const node of this.graph.nodes) {
      if (node.parentId) continue;
      const targetName = resolveCloneTargetName(node, this.model);
      const chip = [...this.root.querySelectorAll("[data-preview-for]")].find((el) => el.dataset.previewFor === key(node.id));
      if (chip) {
        chip.textContent = targetName || "—";
      }
      if (node.cloneHints?.dnsLabel && this.autoPrefilledDns?.has(key(node.id))) {
        const nextDns = suggestCloneDnsLabel(node.cloneHints.dnsLabel, this.model, targetName, node.name);
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
    const hadPlan = Boolean(this.model.plan);
    if (target.dataset?.directName) {
      this.model.directNames ||= {};
      this.autoPrefilledDirectNames ||= new Map();
      const editedKey = key(target.dataset.directName);
      this.model.directNames[editedKey] = target.value;
      const directIds = new Set((this.model.selected || []).map(key));
      if (directIds.has(editedKey)) {
        const { topChosen } = this.relatedContext();
        const primaryNodes = topChosen.filter((n) => directIds.has(key(n.id)));
        if (primaryNodes.length === 1) {
          const primaryNode = primaryNodes[0];
          for (const comp of topChosen) {
            if (directIds.has(key(comp.id))) continue;
            const compKey = key(comp.id);
            const curComp = this.model.directNames[compKey];
            if (curComp === undefined || this.autoPrefilledDirectNames.get(compKey) === curComp) {
              const nextComp = deriveCompanionDirectName(comp, target.value, primaryNode);
              this.model.directNames[compKey] = nextComp;
              this.autoPrefilledDirectNames.set(compKey, nextComp);
              const compInput = [...(this.root.querySelectorAll?.("[data-direct-name]") || [])].find((el) => key(el.dataset.directName) === compKey);
              if (compInput) compInput.value = nextComp;
            }
          }
        }
      } else {
        this.autoPrefilledDirectNames.delete(editedKey);
      }
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.refreshClonePreviewChips();
      this.updateGates();
      return;
    }
    if (target.dataset?.smartName) {
      this.model.smartNames ||= {};
      this.model.smartNames[key(target.dataset.smartName)] = target.value;
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
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
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    if (target.dataset?.smartIp) {
      this.model.smartPrivateIps ||= {};
      this.model.smartPrivateIps[target.dataset.smartIp] = target.value;
      this.autoPrefilledIps?.delete(target.dataset.smartIp);
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    if (target.dataset?.smartPoolIp) {
      this.model.smartPoolIps ||= {};
      this.model.smartPoolIps[target.dataset.smartPoolIp] = target.value;
      this.autoPrefilledPools?.delete(target.dataset.smartPoolIp);
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    if (target.dataset?.smartAgwPool) {
      this.model.smartAgwPools ||= {};
      const pKey = target.dataset.smartAgwPool;
      this.model.smartAgwPools[pKey] = target.value;
      this.autoPrefilledAgwPools?.delete(pKey);
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    if (target.dataset?.smartKv) {
      this.model.smartKeyVaultCerts ||= {};
      this.model.smartKeyVaultCerts[target.dataset.smartKv] = target.value;
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    if (target.dataset?.smartBindingCustom) {
      this.model.referenceBindings ||= {};
      this.model.referenceBindings[key(target.dataset.smartBindingCustom)] = target.value;
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.updateGates();
      return;
    }
    const names = {
      "bundle-ticket": "ticket",
      "bundle-reason": "reason",
      "bundle-prefix": "clonePrefix",
      "bundle-suffix": "cloneSuffix",
      "bundle-sequence": "cloneSequence",
      "bundle-overrides": "overridesText",
      "bundle-query": "query",
    };
    const name = names[target.id];
    if (!name) return;
    this.model[name] = target.value;
    if (["ticket", "reason", "clonePrefix", "cloneSuffix", "cloneSequence", "overridesText"].includes(name)) this.invalidate();
    if (name === "query") {
      const start = target.selectionStart; this.render();
      const input = this.root.querySelector("#bundle-query"); input.focus(); input.setSelectionRange(start, start);
    } else {
      this.syncPlanPaneAfterInput(hadPlan);
      if (["clonePrefix", "cloneSuffix", "cloneSequence"].includes(name)) this.refreshClonePreviewChips();
      this.updateGates();
    }
  }

  async change(event) {
    const target = event.target, m = this.model;
    if (m.busy || this.isJobRunning()) return;
    if (target.dataset.deferToggle) {
      const itemKey = target.dataset.deferToggle;
      m.deferredPortal ||= {};
      m.configuredCerts ||= {};
      const checked = Boolean(target.checked);
      if (itemKey.startsWith("companion:")) {
        const compIdKey = itemKey.slice("companion:".length);
        const { relatedEdges } = this.relatedContext();
        const matchedEdge = relatedEdges.find((e) => key(e.to) === compIdKey);
        const compId = matchedEdge?.to || compIdKey;
        m.includeRelated = true;
        if (checked) {
          delete m.deferredPortal[itemKey];
          m.excludedRelated = (m.excludedRelated || []).filter((item) => key(item) !== compIdKey);
        } else {
          m.deferredPortal[itemKey] = true;
          m.excludedRelated = [...new Set([...(m.excludedRelated || []), compId])];
        }
      } else {
        if (checked) {
          delete m.deferredPortal[itemKey];
          if (itemKey.startsWith("cert:")) m.configuredCerts[itemKey.slice("cert:".length)] = true;
          if (itemKey.startsWith("lbpool:") && m.backendPoolMode === "empty") m.backendPoolMode = "placeholder";
        } else {
          m.deferredPortal[itemKey] = true;
          if (itemKey.startsWith("cert:")) m.configuredCerts[itemKey.slice("cert:".length)] = false;
        }
      }
      this.invalidate();
      this.render();
      [...this.root.querySelectorAll("[data-defer-toggle]")].find((input) => input.dataset.deferToggle === itemKey)?.focus({ preventScroll: true });
      return;
    }
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

  openTargetModal() {
    const modal = this.modalControls();
    const t = this.targets;
    if (!modal || !t?.enabled) return;
    const { sid, subLabel, sourceRg, locationChoices, defaultLocLabel, sourceLocations } = this.targetContextInfo();
    openTargetLocationPicker({
      ...modal,
      state: this.state,
      subscriptions: t.subscriptions,
      currentSubscription: t.currentSubscription,
      groupsBySub: t.groups,
      loadGroups: async (subId) => {
        if (t.groups[subId]) return t.groups[subId];
        const data = await this.api.restoreTargets(subId);
        const rSid = data.subscriptionId || subId;
        t.groups[rSid] = Array.isArray(data.resourceGroups) ? data.resourceGroups : [];
        return t.groups[rSid];
      },
      selectedSubscription: sid,
      selectedGroup: this.model.targetGroup || "",
      keepSameOption: {
        subscriptionId: t.currentSubscription,
        subscriptionName: t.subscriptions.find((s) => key(s.subscriptionId) === key(t.currentSubscription))?.name || subLabel,
        resourceGroup: sourceRg,
        location: sourceLocations[0] || "",
        label: "원본과 같은 리소스 그룹 유지",
        hint: "접두사·접미사·일련 번호·직접 지정으로 원본 리소스와 다른 이름으로 생성합니다",
      },
      locations: locationChoices,
      selectedLocation: this.model.targetLocation || "",
      defaultLocationLabel: defaultLocLabel,
      returnFocusSelector: '[data-bundle="pick-target"]',
      helpers: { esc, icon },
      onSelect: ({ subscriptionId, resourceGroup, location }) => {
        const prevSub = this.targetSubscriptionId();
        const prevLoc = this.model.targetLocation || "";
        this.model.targetLocation = location || "";
        if (key(subscriptionId || prevSub) !== key(prevSub) || key(this.model.targetLocation) !== key(prevLoc)) {
          this.model.referenceBindings = {};
          this.model.customBindingModes = {};
        }
        this.setTarget(subscriptionId || t.currentSubscription, resourceGroup || "");
        this.render();
      },
    });
  }

  async openBindingModal(refId, mode, idx) {
    const modal = this.modalControls();
    if (!modal) return;
    const t = this.targets;
    const { sid, subLabel, effectiveRegion } = this.targetContextInfo();
    if (t?.enabled && sid && !t.networks?.[sid] && typeof this.api?.restoreTargets === "function") {
      t.networks ||= {};
      try {
        const data = await this.api.restoreTargets(sid, { networks: true });
        const rSid = data.subscriptionId || sid;
        t.networks[rSid] = Array.isArray(data.virtualNetworks) ? data.virtualNetworks : [];
      } catch {
        t.networks[sid] = [];
      }
    }
    const vnets = t?.networks?.[sid] || [];
    const refLow = key(refId);
    openNetworkBindingPicker({
      ...modal,
      mode,
      vnets,
      subscriptionLabel: subLabel,
      selectedId: this.model.referenceBindings?.[refLow] || "",
      sourceRefId: refId,
      sourceLabel: shortNetworkPath(refId),
      allowKeepSource: !this.isCrossBoundary(),
      preferredLocation: effectiveRegion,
      returnFocusSelector: `[data-binding-idx="${idx}"]`,
      helpers: { esc, icon },
      onSelect: (chosenId) => {
        this.model.referenceBindings ||= {};
        this.model.customBindingModes ||= {};
        delete this.model.customBindingModes[refLow];
        this.model.referenceBindings[refLow] = chosenId || "";
        this.invalidate();
        this.render();
      },
    });
  }

  openExtraResourcesModal() {
    const modal = this.modalControls();
    if (!modal || !this.graph?.nodes) return;
    const m = this.model;
    const topNodes = [...this.graph.nodes].filter((node) => !node.parentId).sort((a, b) => String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), "en"));
    const items = topNodes.map((node) => {
      const stateRes = (this.state?.resources || []).find((r) => key(r.id) === key(node.id));
      return {
        node,
        resource: stateRes || {
          id: node.id,
          name: node.name,
          type: node.resourceType || "",
          typeLabel: node.label || node.resourceType || "",
          groupId: String(node.id || "").split("/").slice(0, 5).join("/"),
          tags: node.tags || {},
        },
      };
    });
    const { chosen } = this.relatedContext();
    const chosenSet = new Set(chosen.map((n) => key(n.id)));
    const directSet = new Set((m.selected || []).map(key));
    openResourcePicker({
      ...modal,
      state: this.state || { scopes: [] },
      items,
      multiple: true,
      selectedIds: m.selected || [],
      title: "함께 복원·복제할 리소스 선택",
      disabledInfo: (entry) => {
        const node = entry.node;
        const implied = chosenSet.has(key(node.id)) && !directSet.has(key(node.id));
        if (!node.restoreSupported) return { disabled: true, checked: false, badge: "지원 제외", reason: node.blockedReason || "복원을 지원하지 않는 리소스입니다" };
        if (implied) return { disabled: true, checked: true, badge: "연관 자동 포함", reason: "주 리소스의 연관 리소스로 자동 포함됩니다" };
        return null;
      },
      returnFocusSelector: '[data-bundle="pick-extra-resources"]',
      helpers: { esc, icon },
      onSelect: (nextIds) => {
        m.selected = nextIds;
        this.syncCloneConstraints();
        this.invalidate();
        this.render();
      },
    });
  }

  async click(event) {
    const nameModeBtn = event.target.closest?.("[data-clone-name-mode]");
    if (nameModeBtn?.dataset?.cloneNameMode && !nameModeBtn.disabled && !this.model.busy) {
      const nextMode = nameModeBtn.dataset.cloneNameMode;
      if (CLONE_NAME_MODES.includes(nextMode) && this.model.cloneNameMode !== nextMode) {
        const m = this.model;
        const { topChosen } = this.relatedContext();
        const directIds = new Set((m.selected || []).map(key));
        const primaryNode = topChosen.find((n) => directIds.has(key(n.id))) || topChosen[0] || null;
        for (const node of topChosen) {
          if (!node.cloneHints?.dnsLabel) continue;
          const dKey = key(node.id);
          const prevAutoDns = suggestCloneDnsLabel(node.cloneHints.dnsLabel, m, resolveCloneTargetName(node, m), node.name);
          if (m.smartDnsLabels?.[dKey] === prevAutoDns || this.autoPrefilledDns?.has(dKey)) {
            delete m.smartDnsLabels[dKey];
            this.autoPrefilledDns?.delete(dKey);
          }
        }
        if (nextMode === "direct") {
          m.directNames ||= {};
          this.autoPrefilledDirectNames ||= new Map();
          for (const node of topChosen) {
            const nKey = key(node.id);
            if (!m.directNames[nKey]) {
              const prevResolved = resolveCloneTargetName(node, m);
              const fallback = prevResolved && (m.targetGroup || key(prevResolved) !== key(node.name))
                ? prevResolved
                : `${node.name}-copy`.slice(0, 80);
              m.directNames[nKey] = fallback;
              if (!directIds.has(nKey)) this.autoPrefilledDirectNames.set(nKey, fallback);
            }
          }
        } else if (nextMode === "sequence" && !m.cloneSequence) {
          m.cloneSequence = nextSequenceToken(primaryNode?.name || "");
        } else if (nextMode === "suffix" && !m.cloneSuffix && !m.targetGroup) {
          m.cloneSuffix = "copy";
        }
        m.cloneNameMode = nextMode;
        this.invalidate();
        this.render();
      }
      this.root.querySelector?.(`[data-clone-name-mode="${nextMode}"]`)?.focus({ preventScroll: true });
      return;
    }
    const seqStepBtn = event.target.closest?.("[data-seq-step]");
    if (seqStepBtn?.dataset?.seqStep && !seqStepBtn.disabled && !this.model.busy) {
      const delta = Number(seqStepBtn.dataset.seqStep) || 0;
      const hadPlan = Boolean(this.model.plan);
      this.model.cloneSequence = stepSequenceToken(this.model.cloneSequence, delta);
      const seqInput = this.root.querySelector?.("#bundle-sequence");
      if (seqInput) seqInput.value = this.model.cloneSequence;
      this.invalidate();
      this.syncPlanPaneAfterInput(hadPlan);
      this.refreshClonePreviewChips();
      this.updateGates();
      seqStepBtn.focus?.({ preventScroll: true });
      return;
    }
    const shareChoice = event.target.closest?.("[data-shareable-choice]");
    if (shareChoice?.dataset?.shareableChoice && !shareChoice.disabled && !this.model.busy) {
      const id = shareChoice.dataset.shareableId;
      const val = shareChoice.dataset.shareableChoice;
      this.model.includeRelated = true;
      this.model.excludedRelated = val === "share"
        ? [...new Set([...(this.model.excludedRelated || []), id])]
        : (this.model.excludedRelated || []).filter((item) => key(item) !== key(id));
      this.invalidate();
      this.render();
      [...(this.root.querySelectorAll?.("[data-shareable-choice]") || [])].find((b) => b.dataset.shareableId === id && b.dataset.shareableChoice === val)?.focus({ preventScroll: true });
      return;
    }
    const poolChoice = event.target.closest?.("[data-pool-choice]");
    if (poolChoice?.dataset?.poolChoice && !poolChoice.disabled && !this.model.busy) {
      const val = poolChoice.dataset.poolChoice;
      this.model.backendPoolMode = val;
      this.invalidate();
      this.render();
      this.root.querySelector?.(`[data-pool-choice="${val}"]`)?.focus({ preventScroll: true });
      return;
    }
    const immChoice = event.target.closest?.("[data-immutable-choice]");
    if (immChoice?.dataset?.immutableChoice && !immChoice.disabled && !this.model.busy) {
      const val = immChoice.dataset.immutableChoice;
      this.model.immutableConflict = val;
      this.invalidate();
      this.render();
      this.root.querySelector?.(`[data-immutable-choice="${val}"]`)?.focus({ preventScroll: true });
      return;
    }
    const bindingBtn = event.target.closest?.("[data-bundle-pick-binding]");
    if (bindingBtn?.dataset?.bundlePickBinding && !bindingBtn.disabled && !this.model.busy) {
      await this.openBindingModal(bindingBtn.dataset.bundlePickBinding, bindingBtn.dataset.bindingMode || "subnet", bindingBtn.dataset.bindingIdx || "0");
      return;
    }
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
    if (action === "pick-target") { this.openTargetModal(); return; }
    if (action === "pick-extra-resources") { this.openExtraResourcesModal(); return; }
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
        const actionName = action === "backup" ? "bundle-backup" : "bundle-restore";
        if (typeof this.startBackground === "function") {
          const submittedJob = await this.startBackground(actionName, payload, { mode: m.mode });
          this.activeJob = submittedJob;
          m.result = null;
          this.invalidate();
          this.mutating = false;
          m.busy = false;
          if (this.alive) this.render();
          return;
        }
        const job = await this.run(actionName, payload);
        m.result = job.result; this.invalidate(); m.busy = false;
        if (action === "backup") m.runId = job.result.runId;
        else {
          const portalPrimary = portalTargetLinks(job.result, job.result?.tenantId || this.state?.workspace?.tenantId || "")[0] || null;
          const notifyActions = portalPrimary
            ? [{ label: `Azure 포털에서 열기 · ${portalPrimary.name}`, href: portalPrimary.url, external: true }]
            : [];
          if (Array.isArray(job.result?.omittedOrKept) && job.result.omittedOrKept.length) {
            const items = job.result.omittedOrKept;
            const sample = items.slice(0, 3).map((item) => `• ${item.resource} · ${item.path}`).join("\n");
            const doneTitle = m.mode === "clone"
              ? `복제 완료 · 자동 보정(임시 샘플 값) 또는 제외 항목 ${items.length}건이 함께 반영되었습니다.`
              : `가능한 설정 복원 완료 · 복원 불가/불변 속성 ${items.length}건은 제외 또는 현재 값으로 유지했습니다.`;
            this.notify?.({
              key: "bundle-partial-done",
              level: "warning",
              message: `${doneTitle}\n${sample}`,
              actions: notifyActions,
            });
          } else if (portalPrimary) {
            this.notify?.({
              key: "bundle-done",
              level: "success",
              message: m.mode === "clone"
                ? `${portalPrimary.name} 복제를 완료하고 사후 형상 일치를 확인했습니다.`
                : `${portalPrimary.name} 복원을 완료하고 안전 백업·사후 형상 일치를 확인했습니다.`,
              actions: notifyActions,
            });
          }
        }
        if (this.alive) {
          this.root.querySelector(".bundle-result")?.remove();
          this.root.insertAdjacentHTML(this.embedded ? "afterbegin" : "beforeend", this.resultView());
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
