import { createDemoState, resourceId } from "./demo-data.mjs";
import { ancestors } from "./view-model.mjs";

export const STORAGE_KEY = "armbackup.design-preview.v1";
export { STATUS, ancestors, visibleTree } from "./view-model.mjs";

export class DemoError extends Error {}

const clone = (value) => structuredClone(value);
const key = (value) => value.toLowerCase();
const knownTypes = new Set(createDemoState(new Date(0)).resources.map((resource) => key(resource.type)));

export function normalize(raw, type) {
  const reviewed = knownTypes.has(key(type));
  function walk(value, path = "") {
    if (Array.isArray(value)) {
      let items = value;
      const named = (key(type) === "microsoft.network/networksecuritygroups" && path === "properties.securityRules")
        || (key(type) === "microsoft.network/routetables" && path === "properties.routes");
      if (named) {
        if (value.some((item) => !item || typeof item.name !== "string")
            || new Set(value.map((item) => key(item.name))).size !== value.length) {
          throw new DemoError("이름이 누락되거나 중복된 규칙 배열은 비교할 수 없습니다.");
        }
        items = [...value].sort((a, b) => a.name.localeCompare(b.name, "en"));
      }
      return items.map((item) => walk(item, `${path}[]`));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().filter((field) => {
        if (!reviewed) return true;
        if (path === "" && ["etag", "id", "name", "type"].includes(field)) return false;
        if (field === "provisioningState" && (path === "properties" || path.endsWith("[].properties"))) return false;
        if (["etag", "id", "type"].includes(field) && /properties\.(securityRules|routes)\[\]$/.test(path)) return false;
        return true;
      }).map((field) => [field, walk(value[field], path ? `${path}.${field}` : field)]));
    }
    return value;
  }
  return walk(raw);
}

export function diffValues(before, after, path = "", beforePresent = true, afterPresent = true) {
  if (beforePresent && afterPresent && Object.is(before, after)) return [];
  const bothObjects = before && after && typeof before === "object" && typeof after === "object";
  if (beforePresent && afterPresent && bothObjects && Array.isArray(before) === Array.isArray(after)) {
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(
      Array.isArray(before) ? (a, b) => Number(a) - Number(b) : undefined,
    );
    return fields.flatMap((field) => diffValues(
      before[field], after[field],
      Array.isArray(before) ? `${path}[${field}]` : path ? `${path}.${field}` : field,
      Object.hasOwn(before, field), Object.hasOwn(after, field),
    ));
  }
  return [{ path: path || "(전체)", before, after, beforePresent, afterPresent }];
}

export function compareResource(snapshot, observation, type, runStatus = "Captured") {
  const unknown = (reason) => ({ status: "unknown", reason, diffs: [] });
  if (runStatus !== "Captured" || !snapshot?.complete || !snapshot.raw) return unknown("백업이 불완전하거나 형상이 수집되지 않았습니다.");
  if (!observation || observation.status === "pending") return unknown("현재 형상 조회 대기");
  if (observation.status === "error") return unknown(`현재 조회 실패 · ${observation.code || "원인 미확인"}`);
  if (observation.status === "missing") {
    return observation.confirmed
      ? { status: "critical", reason: "현재 리소스 부재 확인 · 예시", diffs: [{ path: "(리소스)", before: "백업에 있음", after: "현재 부재 확인", beforePresent: true, afterPresent: true }] }
      : unknown("현재 목록에 없지만 부재는 확인하지 못했습니다.");
  }
  if (observation.status !== "present" || !observation.raw) return unknown("현재 형상을 확인할 수 없습니다.");
  if (snapshot.apiVersion !== observation.apiVersion) return unknown("API 버전이 달라 비교 규칙 검증이 필요합니다.");
  if (snapshot.redacted || observation.redacted) return unknown("마스킹·미수집 필드는 동일 여부를 판정할 수 없습니다.");
  let diffs;
  try {
    diffs = diffValues(normalize(snapshot.raw, type), normalize(observation.raw, type));
  } catch (error) {
    if (!(error instanceof DemoError)) throw error;
    return unknown(error.message);
  }
  if (!diffs.length) return { status: "same", reason: "비교 범위 내 동일", diffs };
  let status = "warning";
  if (diffs.every((diff) => /^(tags(?:\.|$)|properties\.description$)/.test(diff.path))) status = "minor";
  else if (diffs.some((diff) =>
    (key(type) === "microsoft.network/networksecuritygroups" && diff.path.startsWith("properties.securityRules"))
    || /(?:publicNetworkAccess|httpsOnly|minimumTlsVersion|minTlsVersion|enablePurgeProtection|allowBlobPublicAccess)/.test(diff.path))) status = "critical";
  return { status, reason: `${diffs.length}개 속성 차이 · 예시 분류 정책`, diffs };
}

export function scopeResources(state, scopeId) {
  return state.resources.filter((resource) => ancestors(state, resource.groupId).some((scope) => scope.id === scopeId));
}

export function matchesScope(state, resource, scopeIds = state.policy.scopeIds) {
  const path = [...ancestors(state, resource.groupId).map((scope) => scope.id), resource.id].map(key);
  return scopeIds.some((id) => path.includes(key(id)));
}

export function matchesPolicy(state, resource, raw, policy = state.policy) {
  if (!matchesScope(state, resource, policy.scopeIds)) return false;
  if (!policy.types.some((type) => key(type) === key(resource.type))) return false;
  const tags = raw?.tags || {};
  return policy.tags.every((rule) => {
    const tagKey = Object.keys(tags).find((name) => key(name) === key(rule.key));
    return tagKey !== undefined && (rule.operator === "exists" || tags[tagKey] === rule.value);
  });
}

export function comparisonRows(state, runId, filters = {}) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new DemoError("선택한 백업을 찾을 수 없습니다.");
  return run.snapshots.map((snapshot) => {
    const resource = state.resources.find((item) => key(item.id) === key(snapshot.resourceId));
    if (!resource) throw new DemoError("백업의 리소스 메타데이터가 없습니다.");
    const observation = state.current[key(resource.id)];
    return { resource, snapshot, observation, ...compareResource(snapshot, observation, resource.type, run.status) };
  }).filter((row) => {
    if (filters.targetOnly && !matchesPolicy(state, row.resource, row.snapshot.raw)) return false;
    if (filters.status === "changed" && !["critical", "warning", "minor"].includes(row.status)) return false;
    if (filters.status && !["all", "changed"].includes(filters.status) && row.status !== filters.status) return false;
    if (filters.type && key(row.resource.type) !== key(filters.type)) return false;
    if (filters.query) {
      const text = [row.resource.name, row.resource.id, row.resource.type,
        ...ancestors(state, row.resource.groupId).map((scope) => scope.name)].join(" ").toLowerCase();
      if (!text.includes(filters.query.toLowerCase().trim())) return false;
    }
    return true;
  });
}

function assertState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision)
      || !Array.isArray(state.scopes) || !Array.isArray(state.resources)
      || !Array.isArray(state.runs) || !Array.isArray(state.logs) || !state.current
      || !Array.isArray(state.policy?.scopeIds) || !Array.isArray(state.policy?.types)
      || !Array.isArray(state.policy?.tags)) {
    throw new DemoError("저장된 예시 데이터 형식이 올바르지 않습니다. 프리뷰를 초기화해 주세요.");
  }
}

export class DemoStore {
  constructor(storage, now = new Date()) {
    this.storage = storage;
    const saved = storage.getItem(STORAGE_KEY);
    if (saved === null) {
      this.state = createDemoState(now);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } else {
      try {
        this.state = JSON.parse(saved);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new DemoError("저장된 예시 데이터를 읽을 수 없습니다. 프리뷰를 초기화해 주세요.");
      }
      assertState(this.state);
    }
  }

  assertFresh() {
    const saved = this.storage.getItem(STORAGE_KEY);
    if (saved === null) throw new DemoError("예시 저장소가 초기화됐습니다. 화면을 새로고침해 주세요.");
    let remote;
    try {
      remote = JSON.parse(saved);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new DemoError("예시 저장소가 손상됐습니다. 작업을 중단했습니다.");
    }
    assertState(remote);
    if (remote.revision !== this.state.revision) throw new DemoError("다른 탭에서 예시 데이터가 변경됐습니다. 새로고침 후 다시 검토해 주세요.");
  }

  commit(next) {
    this.assertFresh();
    assertState(next);
    const saved = { ...next, revision: this.state.revision + 1 };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new DemoError(`브라우저 저장에 실패해 작업을 중단했습니다. (${error.name})`);
    }
    this.state = saved;
  }
}

function event(eventName, message, resource = "", runId = "", level = "Information", now = new Date()) {
  return {
    id: `demo-${crypto.randomUUID()}`, time: now.toISOString(), level, event: eventName,
    resourceId: resource, runId, correlationId: `demo-${crypto.randomUUID()}`,
    message, source: "ArmBackup_CL · 예시",
  };
}

export function savePolicy(store, policy) {
  if (!policy.scopeIds.length || !policy.types.length) throw new DemoError("대상 범위와 리소스 종류를 각각 하나 이상 선택해 주세요.");
  if (policy.scopeIds.some((id) => !store.state.scopes.some((scope) => scope.id === id)
      && !store.state.resources.some((resource) => key(resource.id) === key(id)))
      || policy.types.some((type) => !store.state.resources.some((resource) => resource.type === type))) {
    throw new DemoError("예시 범위에 없는 대상을 선택할 수 없습니다.");
  }
  if (policy.tags.some((rule) => typeof rule.key !== "string" || !rule.key.trim()
      || !["equals", "exists"].includes(rule.operator)
      || (rule.operator === "equals" && (typeof rule.value !== "string" || !rule.value)))) {
    throw new DemoError("태그 이름과 조건 값을 확인해 주세요.");
  }
  const next = clone(store.state);
  next.policy = clone(policy);
  next.policy.scopeIds = policy.scopeIds.map((id) => next.scopes.find((scope) => scope.id === id)?.id
    ?? next.resources.find((resource) => key(resource.id) === key(id)).id);
  next.logs.unshift(event("policy_saved", "예시 백업 대상 설정을 저장했습니다. 실제 수집 설정은 변경하지 않았습니다."));
  store.commit(next);
}

export function makeTargetId(state, resource, groupId, name) {
  const group = state.scopes.find((scope) => scope.id === groupId && scope.kind === "resourceGroup");
  const subscription = group && state.scopes.find((scope) => scope.id === group.parentId);
  if (!subscription?.subscriptionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    throw new DemoError("예시 대상 RG와 리소스 이름을 확인해 주세요. 이름은 영문·숫자·점·밑줄·하이픈 1~63자입니다.");
  }
  return resourceId(subscription.subscriptionId, group.name, resource.type, name);
}

export function prepareRestore(state, input) {
  const { resourceId: sourceId, runId, mode } = input;
  if (!["create", "update"].includes(mode)) throw new DemoError("신규 생성 또는 기존 업데이트를 선택해 주세요.");
  const resource = state.resources.find((item) => key(item.id) === key(sourceId));
  const run = state.runs.find((item) => item.id === runId);
  const snapshot = run?.snapshots.find((item) => key(item.resourceId) === key(sourceId));
  if (!resource || run?.status !== "Captured" || !snapshot?.complete || !snapshot.raw || snapshot.redacted) {
    throw new DemoError("완전한 형상이 있는 백업만 예시 복원에 사용할 수 있습니다.");
  }
  const source = state.current[key(sourceId)];
  if (!source || !["present", "missing"].includes(source.status) || (source.status === "missing" && !source.confirmed)) {
    throw new DemoError("원본의 현재 상태를 확인하지 못해 안전 백업과 복원을 진행할 수 없습니다.");
  }
  const targetId = mode === "update" ? resource.id : makeTargetId(state, resource, input.groupId, input.name);
  const target = state.current[key(targetId)];
  if (mode === "update" && target?.status !== "present") throw new DemoError("업데이트 대상이 현재 존재하지 않습니다. 신규 생성을 선택해 주세요.");
  if (mode === "create" && target && !(target.status === "missing" && target.confirmed)) {
    throw new DemoError("신규 생성 대상이 이미 있거나 상태가 미확인입니다. 다른 이름을 선택해 주세요.");
  }
  if (mode === "update" && snapshot.apiVersion !== target.apiVersion) throw new DemoError("API 버전이 달라 예시 업데이트를 중단했습니다.");
  return {
    revision: state.revision, sourceId: resource.id, runId, mode, targetId,
    groupId: mode === "update" ? resource.groupId : input.groupId,
    name: mode === "update" ? resource.name : input.name,
    snapshot: clone(snapshot), resource: clone(resource),
  };
}

export async function executeRestore(store, plan, onPhase = async () => {}, now = new Date()) {
  store.assertFresh();
  if (store.state.revision !== plan.revision) throw new DemoError("검토 이후 데이터가 변경됐습니다. 복원 계획을 다시 확인해 주세요.");
  const checked = prepareRestore(store.state, {
    resourceId: plan.sourceId, runId: plan.runId, mode: plan.mode, groupId: plan.groupId, name: plan.name,
  });
  if (JSON.stringify(checked) !== JSON.stringify(plan)) throw new DemoError("검토한 복원 계획과 실행 입력이 다릅니다.");
  await onPhase("checking");
  store.assertFresh();
  if (store.state.revision !== plan.revision) throw new DemoError("안전 백업 직전 데이터가 변경돼 중단했습니다.");
  const safetyId = `demo-safety-${crypto.randomUUID()}`;
  const safety = { id: safetyId, kind: "safety", capturedAt: now.toISOString(), status: "Captured", snapshots: [], absences: [] };
  for (const id of new Set([plan.sourceId, plan.targetId])) {
    const observed = store.state.current[key(id)];
    if (observed?.status === "present") {
      safety.snapshots.push({ resourceId: id, apiVersion: observed.apiVersion, complete: true, capturedAt: now.toISOString(), raw: clone(observed.raw) });
    } else {
      safety.absences.push({ resourceId: id, observedAt: now.toISOString(), status: "ConfirmedAbsent", sampleOnly: true });
    }
  }
  const captured = clone(store.state);
  captured.runs.unshift(safety);
  captured.logs.unshift(event("pre_restore_backup_completed", "예시 복원 전 현재 형상·대상 부재 기록을 브라우저에 보관했습니다.", plan.targetId, safetyId, "Information", now));
  store.commit(captured);
  const safetyRevision = store.state.revision;
  await onPhase("safety");
  store.assertFresh();
  if (store.state.revision !== safetyRevision) throw new DemoError("안전 백업 이후 데이터가 변경돼 적용을 중단했습니다. 안전 백업은 보존했습니다.");
  const applied = clone(store.state);
  const raw = { ...clone(plan.snapshot.raw), id: plan.targetId, name: plan.name };
  applied.current[key(plan.targetId)] = {
    status: "present", observedAt: now.toISOString(), apiVersion: plan.snapshot.apiVersion,
    raw, actor: { caller: "프리뷰 사용자 · 예시", at: now.toISOString(), source: "예시 복원 이력" },
  };
  if (!applied.resources.some((resource) => key(resource.id) === key(plan.targetId))) {
    applied.resources.push({ ...plan.resource, id: plan.targetId, name: plan.name, groupId: plan.groupId });
  }
  applied.logs.unshift(event("restore_completed", `예시 ${plan.mode === "create" ? "신규 생성" : "업데이트"}를 완료했습니다. 실제 Azure 변경은 없습니다.`, plan.targetId, plan.runId, "Information", now));
  store.commit(applied);
  await onPhase("applied");
  const actual = store.state.current[key(plan.targetId)];
  if (diffValues(normalize(raw, plan.resource.type), normalize(actual.raw, plan.resource.type)).length) {
    throw new DemoError("예시 복원 후 비교가 일치하지 않습니다. 안전 백업을 보존했습니다.");
  }
  return { safetyId, targetId: plan.targetId, mode: plan.mode };
}

export function queryLogs(state, filters = {}, now = new Date()) {
  const cutoff = filters.days ? now.getTime() - filters.days * 86_400_000 : -Infinity;
  return state.logs.filter((log) => new Date(log.time).getTime() >= cutoff
    && (!filters.level || log.level === filters.level)
    && (!filters.query || `${log.event} ${log.resourceId} ${log.message} ${log.runId}`.toLowerCase().includes(filters.query.toLowerCase().trim())))
    .sort((a, b) => b.time.localeCompare(a.time));
}

export function logQueryExample(filters = {}) {
  const literal = (value) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    .replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (![0, 1, 7, 30].includes(filters.days ?? 0)
      || !["", "Information", "Warning", "Error"].includes(filters.level ?? "")) {
    throw new DemoError("지원하지 않는 예시 로그 조회 조건입니다.");
  }
  const lines = ["ArmBackup_CL"];
  if (filters.days) lines.push(`| where TimeGenerated > ago(${filters.days}d)`);
  if (filters.level) lines.push(`| where Level == '${literal(filters.level)}'`);
  if (filters.query) {
    const value = literal(filters.query);
    lines.push(`| where Event contains '${value}' or ResourceId contains '${value}' or RunId contains '${value}' or tostring(Details) contains '${value}'`);
  }
  lines.push("| order by TimeGenerated desc", "| project TimeGenerated, Level, Event, ResourceId, RunId, Status, ErrorCode, Details", "| take 200");
  return lines.join("\n");
}
