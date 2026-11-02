export class ConsoleError extends Error {}

function scopeNoticeKey(workspace) {
  return "armbackup.scope-notice.v1:" + JSON.stringify([
    workspace.readScope || workspace.scope, workspace.scope,
    workspace.archiveMode, workspace.restoreEnabled,
  ]);
}

export function scopeNoticeRequired(storage, workspace) {
  return storage.getItem(scopeNoticeKey(workspace)) !== "acknowledged";
}

export function acknowledgeScopeNotice(storage, workspace) {
  storage.setItem(scopeNoticeKey(workspace), "acknowledged");
}

export const TERMINAL = new Set(["Succeeded", "Failed"]);
export const RANK = { critical: 0, unknown: 1, warning: 2, minor: 3, same: 4 };
export const WORKFLOWS = {
  all: { name: "전체 현황", hint: "고객과 보호 상태를 함께 확인합니다.", status: "all" },
  oncall: { name: "당직·장애 대응", hint: "최근 백업 실패·백업 없음·24시간 이상 미백업을 먼저 확인합니다.", status: "attention" },
  change: { name: "변경 검토", hint: "백업 이후 달라진 속성과 최신 성공 관리 작업을 확인합니다.", status: "changed" },
  backup: { name: "백업 운영", hint: "저장한 대상 정책으로 지금 백업하고, 완료 표식과 수집 범위를 확인합니다.", status: "all" },
  audit: { name: "감사·인수인계", hint: "관측 시각·근거·티켓을 포함한 보고서와 실제 실행 로그를 확인합니다.", status: "all" },
};

export function rowsFor(state, runId, filters = {}) {
  const run = runId === "latest" ? state.latestView : state.runs.find((item) => item.id === runId);
  if (!run) return [];
  const resources = new Map(state.resources.map((resource) => [resource.id.toLowerCase(), resource]));
  const rows = run.snapshots.map((snapshot) => {
    const resource = resources.get(snapshot.resourceId.toLowerCase());
    if (!resource || !snapshot.comparison) throw new ConsoleError("서버의 비교 데이터가 불완전합니다. 다시 조회해 주세요.");
    return { resource, snapshot, observation: state.current[snapshot.resourceId.toLowerCase()], ...snapshot.comparison };
  });
  if (runId === "latest") {
    const backed = new Set(run.snapshots.map((snapshot) => snapshot.resourceId.toLowerCase()));
    for (const resource of state.resources) {
      if (!backed.has(resource.id.toLowerCase()) && state.current[resource.id.toLowerCase()]?.status === "present") {
        rows.push({ resource, observation: state.current[resource.id.toLowerCase()], status: "unknown",
          reason: "검증된 일반 백업이 없습니다.", diffs: [], profile: "unbacked-view",
          snapshot: { resourceId: resource.id, complete: false, capturedAt: null, restoreSupported: false,
            raw: {}, viewOnly: true } });
      }
    }
  }
  return rows.filter((row) => {
    if (filters.status === "attention" && !["critical", "unknown"].includes(row.status)) return false;
    if (filters.status === "changed" && !["critical", "warning", "minor"].includes(row.status)) return false;
    if (filters.status && !["all", "attention", "changed"].includes(filters.status) && row.status !== filters.status) return false;
    if (filters.customer && (row.resource.tags?.customer || row.snapshot.raw?.tags?.customer) !== filters.customer) return false;
    if (filters.type && row.resource.type !== filters.type) return false;
    if (filters.query) {
      const text = `${row.resource.name} ${row.resource.id} ${row.resource.type} ${JSON.stringify(row.snapshot.raw?.tags || {})}`.toLowerCase();
      if (!text.includes(filters.query.trim().toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => (filters.priority ? RANK[a.status] - RANK[b.status] : 0)
    || a.resource.name.localeCompare(b.resource.name, "en"));
}

export function restoreAvailability(state, row) {
  if (!state.workspace.restoreEnabled) return { allowed: false, reason: "이 서버에서 복원을 허용하지 않았습니다." };
  if (!row?.snapshot.complete) return { allowed: false, reason: "완료 표식·무결성을 검증한 백업을 선택해 주세요." };
  if (!row.snapshot.restoreSupported) return { allowed: false, reason: `이 형상은 비교만 지원합니다. ${row.snapshot.blockedReason || "검토된 복원 프로필이 없습니다."}` };
  if (row.status === "unknown") return { allowed: false, reason: "현재 형상·수집 범위가 미확인입니다. 다시 조회하고 원인을 해결해 주세요." };
  const observed = row.observation;
  if (!observed || !(observed.status === "present" || (observed.status === "missing" && observed.confirmed))) {
    return { allowed: false, reason: "현재 리소스의 존재 여부를 확인하지 못했습니다." };
  }
  return { allowed: true, reason: "단일 또는 관계 묶음을 선택하고 검토 계획·티켓·안전 백업 후 적용합니다." };
}

export function currentOnly(state, runId) {
  const run = runId === "latest" ? state.latestView : state.runs.find((item) => item.id === runId);
  const ids = new Set((run?.snapshots || []).map((snapshot) => snapshot.resourceId.toLowerCase()));
  return state.resources.filter((resource) => !ids.has(resource.id.toLowerCase())
    && state.current[resource.id.toLowerCase()]?.status === "present");
}

export function initialRun(state, preferred = "") {
  if (preferred === "latest" && state.latestView?.snapshots.length) return "latest";
  return state.runs.find((run) => run.id === preferred)?.id
    || (state.latestView?.snapshots.length ? "latest" : "")
    || state.runs.find((run) => run.status === "Captured" && run.kind !== "safety")?.id
    || (state.latestView && state.resources?.length ? "latest" : "")
    || state.runs.find((run) => run.status === "Captured")?.id
    || state.runs[0]?.id || "";
}

export function readableJob(job) {
  const actions = { backup: "백업", policy: "대상 설정 저장", restore: "복원",
    "bundle-backup": "묶음 백업", "bundle-restore": "단일·묶음 복원" };
  const phases = { queued: "대기", discovery: "ARG·현재 범위 확인", capturing: "ARM 형상 수집·지정 저장소 보관",
    "safety-backup": "현재 형상 안전 백업·무결성 확인", applying: "ARM 적용·프로비저닝 대기",
    verification: "사후 형상 검증", "persisting-audit": "영속 완료 기록 보관", complete: "완료" };
  return `${actions[job.action] || job.action} · ${phases[job.phase] || job.phase}`;
}

export function validateReview(input) {
  if (!input.resourceId || !input.runId) throw new ConsoleError("리소스와 백업을 선택해 주세요.");
  if (!["create", "update"].includes(input.mode)) throw new ConsoleError("복원 방식을 선택해 주세요.");
  if (input.mode === "create" && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(input.targetName || "")) {
    throw new ConsoleError("신규 이름은 영문·숫자·점·밑줄·하이픈 1~63자입니다.");
  }
  if (typeof input.ticket !== "string" || input.ticket.trim().length < 3 || input.ticket.length > 80) {
    throw new ConsoleError("변경·장애 티켓을 3~80자로 입력해 주세요.");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500) {
    throw new ConsoleError("복원 사유를 5~500자로 입력해 주세요.");
  }
  return { ...input, ticket: input.ticket.trim(), reason: input.reason.trim() };
}

export class LiveClient {
  constructor(fetcher = window.fetch.bind(window)) {
    this.fetcher = fetcher;
    this.session = null;
  }

  async request(path, payload) {
    const headers = { Accept: "application/json" };
    if (this.session) headers["X-Console-Token"] = this.session.sessionToken;
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetcher(path, {
        method: payload === undefined ? "GET" : "POST", headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new ConsoleError(`서버 응답을 확인하지 못했습니다. ${error.name} · 이미 제출한 작업은 재실행하지 말고 작업 ID로 확인해 주세요.`);
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ConsoleError("서버에서 올바른 JSON을 받지 못했습니다. 작업 성공을 가정하지 않습니다.");
    }
    if (!response.ok) throw new ConsoleError(data.error || `HTTP ${response.status}`);
    return data;
  }

  async connect() {
    const session = await this.request("/api/session");
    if (session.mode !== "live-lab" || !session.sessionToken || !session.workspace?.scope) {
      throw new ConsoleError("명시적인 실환경 콘솔이 아닙니다. 예시 데이터로 대체하지 않았습니다.");
    }
    this.session = session;
    return session;
  }

  async state(fresh = false) { return this.request(fresh ? "/api/state?fresh=1" : "/api/state"); }
  async refreshState(force = false, onProgress = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    let refresh = await this.request("/api/state/refresh", { force });
    for (let attempt = 0; attempt < 1200; attempt++) {
      onProgress(refresh);
      if (refresh.status === "Failed") {
        throw new ConsoleError(`현재 상태 갱신 실패: ${refresh.error || "서버 갱신 작업을 확인하세요."}`);
      }
      if (refresh.status === "Succeeded") {
        if (refresh.state?.mode !== "live-lab" || !Array.isArray(refresh.state.runs) || !Array.isArray(refresh.state.resources)) {
          throw new ConsoleError("갱신된 실환경 상태 형식이 올바르지 않습니다.");
        }
        return refresh.state;
      }
      if (refresh.status !== "Running" || !refresh.id) throw new ConsoleError("상태 갱신 작업 형식이 올바르지 않습니다.");
      await sleep(1000);
      refresh = await this.request(`/api/state/refresh?id=${encodeURIComponent(refresh.id)}`);
    }
    throw new ConsoleError("현재 상태 갱신이 지연되고 있습니다. 저장본은 최신 ARM 상태가 아닙니다.");
  }
  async review(input) { return this.request("/api/restore/review", validateReview(input)); }
  async logs(filters) { return this.request("/api/logs", filters); }
  async report(runId) { return this.request(`/api/report?runId=${encodeURIComponent(runId)}`); }
  async history() { return this.request("/api/history"); }
  async relations() { return this.request("/api/relations"); }
  async bundle(runId) { return this.request(`/api/bundle?runId=${encodeURIComponent(runId)}`); }
  async bundleReview(input) { return this.request("/api/bundle/review", input); }
  async diagnostics(resourceId) { return this.request(`/api/diagnostics?resourceId=${encodeURIComponent(resourceId)}`); }
  async historyDetail(record) {
    const query = new URLSearchParams({ beforeRunId: record.beforeRunId,
      afterRunId: record.afterRunId, resourceId: record.resourceId });
    return this.request(`/api/history/detail?${query}`);
  }

  async operation(action, payload, onProgress, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const job = await this.request(`/api/${action}`, payload);
    onProgress(job);
    return this.waitJob(job.id, onProgress, sleep);
  }

  async waitJob(identifier, onProgress, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    for (let attempt = 0, limit = 1200; attempt < limit; attempt++) {
      await sleep(1000);
      const current = await this.request(`/api/jobs/${encodeURIComponent(identifier)}`);
      if (current.action === "bundle-restore") limit = 3600;
      onProgress(current);
      if (current.status === "Failed") {
        throw new ConsoleError(`${current.error || "작업 실패"} · 작업 ${current.id}${current.safetyRunId ? ` · 안전 백업 ${current.safetyRunId}` : ""}${current.warning ? " · Azure가 변경됐을 수 있습니다. 실패는 롤백을 의미하지 않습니다." : ""}`);
      }
      if (current.status === "Succeeded") return current;
    }
    throw new ConsoleError(`작업 ${identifier}의 대기가 길어졌습니다. 다시 제출하지 말고 실행 상태를 확인해 주세요.`);
  }
}
