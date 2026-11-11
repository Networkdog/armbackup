export const TODAY_LABELS = {
  disabled: "예약 꺼짐", waiting: "실행 전", due: "실행 대기", running: "실행 중", retrying: "재시도 대기",
  succeeded: "오늘 백업 완료", failed: "오늘 백업 실패", missed: "시각이 지나 오늘은 건너뜀",
};

export function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

export function scheduleDirty(admin, form) {
  const saved = admin?.schedule?.schedule;
  return !!saved && (saved.time !== form.time || saved.enabled !== form.enabled);
}

export function purgeReady(admin, form) {
  return !!admin?.purge && form.confirmGroup === admin.purge.confirmGroup
    && form.confirmPhrase === admin.purge.phrase;
}

function lastResult(last, date, esc) {
  if (!last) return "아직 예약 실행 기록이 없습니다.";
  const failed = last.status !== "Succeeded";
  return `${esc(last.day)} · ${last.attempt}회차 · ${failed ? "실패" : "성공"} · ${esc(date(last.finishedAt))}${failed && last.error ? ` · ${esc(last.error)}` : ""}`;
}

export function adminHtml(admin, form, { esc, icon, date, timezone, busy, loading, error }) {
  if (!admin) {
    return `<section class="page-heading"><h1>관리</h1></section>
      <section class="panel"><div class="panel-body">${error
        ? `<div class="notice error" role="alert">${icon("alert")}${esc(error)}</div><button class="button" data-action="admin-reload">${icon("refresh")}다시 조회</button>`
        : `<div class="operation-strip" role="status"><span class="spinner"></span><span>${loading ? "관리 설정을 불러오고 있습니다…" : "관리 설정을 확인합니다…"}</span></div>`}</div></section>`;
  }
  const schedule = admin.schedule;
  const dirty = scheduleDirty(admin, form);
  const timeOk = validTime(form.time);
  const next = schedule.nextRunAt ? `${date(schedule.nextRunAt)} ${timezone}` : "예약 꺼짐";
  const isLocal = admin.storage.archive === "local" && Boolean(admin.storage.path);
  const storage = isLocal
    ? `로컬 저장소 (${esc(admin.storage.path)})`
    : `${esc(admin.storage.account)} / ${esc(admin.storage.container)}`;
  return `<section class="page-heading"><h1>관리</h1></section>
    <section class="panel admin-panel" aria-labelledby="admin-schedule-title">
      <div class="panel-header"><h2 class="panel-title" id="admin-schedule-title">일일 백업 시각</h2><span class="panel-header-note">하루 1회 · KST</span></div>
      <div class="panel-body">
        ${admin.runnerActive ? "" : `<div class="notice warning">${icon("alert")}이 서버에서는 예약 실행기가 꺼져 있습니다. 시각을 저장해도 자동으로 실행되지 않습니다.</div>`}
        <div class="admin-form">
          <label class="field"><span>백업 시각 (KST, 24시간)</span><input type="time" id="admin-time" step="60" required value="${esc(form.time)}" ${busy ? "disabled" : ""}></label>
          <label class="check-label"><input type="checkbox" id="admin-enabled" ${form.enabled ? "checked" : ""} ${busy ? "disabled" : ""}>일일 백업 사용</label>
          <button class="button primary" data-action="admin-save-schedule" ${busy || !dirty || !timeOk ? "disabled" : ""}>${icon("check")}시각 저장</button>
        </div>
        <dl class="summary-list">
          <dt>오늘 상태</dt><dd>${esc(TODAY_LABELS[schedule.today] || schedule.today)}</dd>
          <dt>다음 실행</dt><dd>${esc(next)}</dd>
          <dt>마지막 예약 실행</dt><dd>${lastResult(schedule.last, date, esc)}</dd>
        </dl>
        <p class="small-text muted">저장한 백업 대상 정책으로 백업합니다. 실패하면 ${schedule.retryMinutes}분 뒤 다시 시도하며 하루 최대 ${schedule.maxAttempts}회입니다. 앱이 꺼져 있다가 시각 이후 ${schedule.catchUpHours}시간 안에 켜지면 바로 실행하고, 그보다 늦으면 다음 날 실행합니다. 실행은 웹 앱 프로세스가 담당합니다.</p>
      </div>
    </section>
    <section class="panel admin-panel danger-zone" aria-labelledby="admin-purge-title">
      <div class="panel-header"><h2 class="panel-title" id="admin-purge-title">백업 전체 삭제</h2><span class="panel-header-note">되돌릴 수 없음</span></div>
      <div class="panel-body">
        <div class="notice warning">${icon("alert")}${storage} 에 저장된 모든 백업(실행 기록·화면 캐시·복원 계획)을 삭제합니다. 삭제 후에는 복원·복제할 수 없습니다.</div>
        <p class="small-text muted">${isLocal ? "백업 대상 정책, 일일 백업 시각, 작업 이력과 Log Analytics 로그는 유지합니다. 로컬 디스크의 백업 실행 기록·화면 캐시·복원 계획 파일은 즉시 삭제됩니다." : "백업 대상 정책, 일일 백업 시각, 작업 이력과 Log Analytics 로그는 유지합니다. Storage의 일시 삭제·버전 관리·불변 정책 설정에 따라 Azure에 사본이 남거나 삭제가 거부될 수 있습니다."}</p>
        <div class="admin-form">
          <label class="field"><span>확인 1: 범위 값 입력 · <code>${esc(admin.purge.confirmGroup)}</code></span><input type="text" id="admin-confirm-group" autocomplete="off" value="${esc(form.confirmGroup)}" ${busy ? "disabled" : ""}></label>
          <label class="field"><span>확인 2: “${esc(admin.purge.phrase)}” 입력</span><input type="text" id="admin-confirm-phrase" autocomplete="off" value="${esc(form.confirmPhrase)}" ${busy ? "disabled" : ""}></label>
          <button class="button danger" data-action="admin-purge" ${busy || !purgeReady(admin, form) ? "disabled" : ""}>${icon("alert")}모든 백업 삭제</button>
        </div>
      </div>
    </section>`;
}
