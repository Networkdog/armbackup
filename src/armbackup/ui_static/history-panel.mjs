import {
  WEEKDAYS, HISTORY_KINDS, CALENDAR_FILLS, calendarWeeks, dateKey, summarizeHistory,
  dayLabel, isMutation, navigateCalendar,
} from "./change-calendar.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const errorMessage = (error) => error instanceof Error ? error.message : "변경 이력을 읽지 못했습니다.";
const find = (selector, root) => root.querySelector(selector);

function formatDiffValue(diff, side) {
  if (!diff[`${side}Present`]) return "필드 없음";
  const value = diff[side];
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return JSON.stringify(value);
}

function diffSummaryText(record) {
  const comp = record?.currentComparison;
  const obs = record?.currentObservation;
  if (!comp) return record?.restoreAllowed ? "복원·복제 가능" : (record?.restoreReason || "상태 확인");
  if (obs?.status === "missing" && obs.confirmed) return "현재 리소스 부재";
  if (comp.status === "same") return "현재와 차이 없음";
  if (comp.status === "unknown") return "현재 비교 미확인";
  return `현재와 Diff ${comp.diffs.length}${comp.truncated ? "+" : ""}개`;
}

function shortDiffBadge(record) {
  const comp = record?.currentComparison;
  const obs = record?.currentObservation;
  if (!comp) return record?.restoreAllowed ? "선택 가능" : "제한";
  if (obs?.status === "missing" && obs.confirmed) return "현재 부재";
  if (comp.status === "same") return "차이 0";
  if (comp.status === "unknown") return "미확인";
  return `Diff ${comp.diffs.length}${comp.truncated ? "+" : ""}`;
}

function comparisonStatusLabel(comp, obs) {
  if (obs?.status === "missing" && obs.confirmed) return "현재 부재 확인";
  if (!comp || comp.status === "unknown") return "비교 미확인";
  if (comp.status === "same") return "현재와 형상 동일";
  return `변경 속성 ${comp.diffs.length}${comp.truncated ? "+" : ""}개`;
}

export class HistoryPanel {
  constructor(root, {
    load, detail, timezone = "Asia/Seoul", mode = "live-lab", onCurrent = null,
    initial = null, onRestore = null, onSelectBackup = null, fixedItem = false, busy = false,
  }) {
    this.root = root; this.load = load; this.detail = detail; this.timezone = timezone;
    this.mode = mode; this.onCurrent = onCurrent; this.fixedItem = fixedItem;
    this.onRestore = onRestore; this.onSelectBackup = onSelectBackup; this.busy = busy;
    this.weeks = 53; this.metric = "resources"; this.filters = { customer: "", type: "", query: "" };
    this.selectedDate = ""; this.selectedRecordId = ""; this.selectedRunId = "";
    this.activeAction = ""; this.hoverDate = ""; this.hoverRecordId = "";
    this.selectedEvent = null; this.showAll = false; this.page = 0;
    if (initial) {
      if (initial.weeks) this.weeks = initial.weeks;
      if (initial.metric) this.metric = initial.metric;
      if (initial.filters) this.filters = { ...this.filters, ...initial.filters };
      if (initial.selectedDate) this.selectedDate = initial.selectedDate;
      if (initial.selectedRecordId) this.selectedRecordId = initial.selectedRecordId;
      if (initial.selectedRunId) this.selectedRunId = initial.selectedRunId;
      if (initial.activeAction) this.activeAction = initial.activeAction;
      if (initial.showAll !== undefined) this.showAll = initial.showAll;
    }
    if (this.onRestore) this.metric = "backups";
    this.generation = 0; this.detailGeneration = 0; this.controller = new AbortController();
    root.addEventListener("click", (event) => this.click(event), { signal: this.controller.signal });
    root.addEventListener("change", (event) => this.change(event), { signal: this.controller.signal });
    root.addEventListener("input", (event) => this.input(event), { signal: this.controller.signal });
    root.addEventListener("keydown", (event) => this.key(event), { signal: this.controller.signal });
    root.addEventListener("mouseover", (event) => this.preview(event), { signal: this.controller.signal });
    root.addEventListener("focusin", (event) => this.preview(event), { signal: this.controller.signal });
    root.addEventListener("mouseout", (event) => this.resetPreview(event), { signal: this.controller.signal });
    root.addEventListener("focusout", (event) => this.resetPreview(event), { signal: this.controller.signal });
    this.reload();
  }

  destroy() { this.generation++; this.detailGeneration++; this.controller.abort(); }
  snapshot() {
    return {
      weeks: this.weeks, metric: this.metric, filters: { ...this.filters },
      selectedDate: this.selectedDate, selectedRecordId: this.selectedRecordId,
      selectedRunId: this.selectedRecord()?.afterRunId || this.selectedRunId || "",
      activeAction: this.activeAction, showAll: this.showAll,
    };
  }

  tzLabel() { return this.timezone === "UTC" ? "UTC" : "KST"; }

  formatClock(value) {
    if (!value) return "미확인";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: this.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
  }

  formatDateTime(value) {
    if (!value) return "미확인";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  selectedRecord() {
    if (!this.data || !this.selectedDate) return null;
    const records = this.summaries?.get(this.selectedDate)?.records || [];
    if (!records.length) return null;
    if (this.selectedRecordId) {
      const exact = records.find((item) => item.id === this.selectedRecordId);
      if (exact) return exact;
    }
    return records.find((item) => item.restoreAllowed || item.cloneAllowed) || records[0];
  }

  setActiveAction(action) {
    this.activeAction = action || "";
    this.root?.querySelectorAll?.("[data-restore-intent]").forEach((btn) => {
      const active = btn.dataset.restoreIntent === this.activeAction;
      btn.setAttribute("aria-pressed", String(active));
      btn.classList.toggle("active-choice", active);
      if (btn.dataset.restoreIntent === "restore") {
        btn.classList.toggle("primary", active || !this.activeAction);
      } else {
        btn.classList.toggle("primary", active);
      }
    });
  }

  async reload(force = false) {
    const version = ++this.generation;
    this.detailGeneration++;
    this.root.innerHTML = `<div class="history-loading" role="status"><span class="spinner"></span>${this.onRestore ? "날짜별 백업 목록을 준비하고 있습니다…" : "검증된 일반 백업의 이전·이후 형상을 읽고 있습니다. 실제 Azure 현재값을 과거 날짜에 넣지 않습니다."}</div>`;
    try {
      const data = await this.load(force);
      if (version !== this.generation) return;
      if (!Array.isArray(data.records) || !Array.isArray(data.observations)) throw new Error("변경 이력 데이터 형식이 올바르지 않습니다.");
      this.data = data;
      this.selectedEvent = null;
      this.render();
    } catch (error) {
      if (version !== this.generation) return;
      this.root.innerHTML = `<div class="notice error" role="alert">${esc(errorMessage(error))}</div><button class="button" data-history="reload">이력 다시 읽기</button>`;
    }
  }

  resolveInitialSelection(visible) {
    if (!this.onRestore) {
      if (!visible.some((cell) => cell.date === this.selectedDate)) {
        const today = visible.at(-1)?.date || "";
        this.selectedDate = [...visible].reverse().find((cell) => cell.value > 0)?.date
          || [...visible].reverse().find((cell) => cell.summary?.records.length)?.date || today;
      }
      return;
    }
    if (this.selectedRecordId) {
      const record = this.data.records.find((item) => item.id === this.selectedRecordId);
      if (record) {
        const d = dateKey(record.at, this.timezone);
        if (visible.some((cell) => cell.date === d)) {
          this.selectedDate = d;
          return;
        }
      }
      this.selectedRecordId = "";
    }
    if (this.selectedRunId) {
      const record = this.data.records.find((item) => item.afterRunId === this.selectedRunId);
      if (record) {
        const d = dateKey(record.at, this.timezone);
        if (visible.some((cell) => cell.date === d)) {
          this.selectedDate = d;
          this.selectedRecordId = record.id;
          return;
        }
      }
      this.selectedRunId = "";
    }
    if (this.selectedDate && visible.some((cell) => cell.date === this.selectedDate)) {
      const rec = this.selectedRecord();
      this.selectedRecordId = rec?.id || "";
      return;
    }
    this.selectedDate = "";
    this.selectedRecordId = "";
  }

  previewDetailText(record) {
    if (!record) return "";
    const status = record.restoreAllowed ? "복원·복제 가능" : (record.restoreReason || "실행 제한");
    return `${this.formatClock(record.capturedAt || record.at)} ${this.tzLabel()} · ${record.label} · ${diffSummaryText(record)} · ${status}`;
  }

  previewHtml(cell) {
    if (!this.onRestore) {
      return esc(cell ? dayLabel(cell, this.metric) : "");
    }
    if (!cell) {
      return `<div class="calendar-preview-row"><span class="calendar-preview-hint">네모칸에 마우스를 올리면 해당 날짜의 백업 시점 정보가 여기에 표시됩니다. 네모칸을 클릭해 백업 시점을 선택하세요.</span><span class="calendar-preview-tz">${this.tzLabel()}</span></div>`;
    }
    if (cell.future) {
      return `<div class="calendar-preview-row"><strong>${esc(cell.date)}</strong><span class="muted">아직 관측할 수 없는 미래 날짜</span><span class="calendar-preview-tz">${this.tzLabel()}</span></div>`;
    }
    const records = cell.summary?.records || [];
    const weekday = `${WEEKDAYS[cell.row]}요일`;
    const failedNote = cell.summary?.failedRuns ? ` · 미검증 백업 ${cell.summary.failedRuns}개` : "";
    if (!records.length) {
      return `<div class="calendar-preview-row"><strong>${esc(cell.date)} ${weekday}</strong><span class="muted">보관된 백업 없음${esc(failedNote)}</span><span class="calendar-preview-tz">${this.tzLabel()}</span></div>`;
    }
    const activeRecord = (this.hoverRecordId && records.find((item) => item.id === this.hoverRecordId))
      || (cell.date === this.selectedDate ? this.selectedRecord() : null)
      || records.find((item) => item.restoreAllowed || item.cloneAllowed)
      || records[0];
    if (records.length === 1) {
      const rec = records[0];
      const chosen = cell.date === this.selectedDate && this.selectedRecord()?.id === rec.id;
      return `<div class="calendar-preview-row"><strong>${esc(cell.date)} ${weekday}</strong><span class="preview-record-detail">${esc(this.previewDetailText(rec))}${esc(failedNote)}</span>${chosen ? '<span class="preview-selected-pill">선택됨</span>' : ""}<span class="calendar-preview-tz">${this.tzLabel()}</span></div>`;
    }
    return `<div class="calendar-preview-row multi-run"><span class="preview-day-title"><strong>${esc(cell.date)} ${weekday}</strong><span class="multi-backup-badge">하루 ${records.length}회 백업</span></span><div class="day-run-chips" role="group" aria-label="${esc(cell.date)} 백업 시점 선택">${records.map((rec) => {
      const isSelected = cell.date === this.selectedDate && this.selectedRecord()?.id === rec.id;
      return `<button type="button" class="day-run-chip ${isSelected ? "active" : ""}" data-select-record="${esc(rec.id)}" aria-pressed="${isSelected}" title="${esc(this.previewDetailText(rec))}"><time>${esc(this.formatClock(rec.capturedAt || rec.at))}</time><span>${esc(rec.label)}</span><em>${esc(shortDiffBadge(rec))}</em></button>`;
    }).join("")}</div><span class="preview-record-detail">${esc(this.previewDetailText(activeRecord))}${esc(failedNote)}</span><span class="calendar-preview-tz">${this.tzLabel()}</span></div>`;
  }

  render() {
    this.summaries = summarizeHistory(this.data, this.timezone, this.filters);
    const today = dateKey(this.data.generatedAt, this.timezone);
    this.columns = calendarWeeks(today, this.weeks, this.summaries, this.metric);
    this.cells = this.columns.flatMap((column) => column.days);
    const visible = this.cells.filter((cell) => !cell.future);
    this.resolveInitialSelection(visible);
    const chosen = this.selectedDate ? this.cells.find((cell) => cell.date === this.selectedDate) : null;
    const defaultFocusCell = chosen
      || [...visible].reverse().find((cell) => cell.value > 0)
      || visible.at(-1);
    this.focusIndex = defaultFocusCell.index;
    const values = visible.filter((cell) => cell.value > 0);
    const changed = new Set(values.flatMap((cell) => cell.summary.records.filter(isMutation).map((record) => record.resourceId.toLowerCase())));
    const customers = [...new Set(this.data.records.flatMap((record) => record.customers))].sort();
    const types = [...new Map(this.data.records.map((record) => [record.resourceType, record.typeLabel])).entries()];
    const monthly = [];
    for (const column of this.columns) {
      const monthCell = column.days.find((cell) => !cell.future && cell.date.endsWith("-01")) || column.days[0];
      const month = monthCell.date.slice(0, 7);
      const previous = monthly.at(-1);
      if (!previous || previous.month !== month) monthly.push({ month, text: `${Number(month.slice(5))}월`, span: 1 });
      else previous.span++;
    }
    const compact = this.onRestore && this.fixedItem;
    this.root.innerHTML = `
      ${this.onRestore ? "" : '<div class="history-title"><h2>변경 달력</h2><button class="button" data-history="reload">이력 새로고침</button></div>'}
      ${compact ? "" : `<div class="history-toolbar"><label>기간<select data-history-field="weeks" aria-label="달력 기간"><option value="53" ${this.weeks === 53 ? "selected" : ""}>최근 1년 · 53주</option><option value="26" ${this.weeks === 26 ? "selected" : ""}>최근 6개월 · 26주</option><option value="13" ${this.weeks === 13 ? "selected" : ""}>최근 3개월 · 13주</option></select></label>${this.onRestore ? "" : `<label>색상 기준<select data-history-field="metric" aria-label="변경 달력 색상 기준"><option value="resources" ${this.metric === "resources" ? "selected" : ""}>변경 자원 수</option><option value="properties" ${this.metric === "properties" ? "selected" : ""}>속성 변경 발생 수</option></select></label>`}
      ${this.fixedItem ? "" : `<select data-history-field="customer" aria-label="변경 이력 고객 필터"><option value="">모든 고객 태그</option>${customers.map((customer) => `<option ${this.filters.customer === customer ? "selected" : ""}>${esc(customer)}</option>`).join("")}</select><select data-history-field="type" aria-label="변경 이력 종류 필터"><option value="">모든 리소스 종류</option>${types.map(([type, label]) => `<option value="${esc(type)}" ${this.filters.type === type ? "selected" : ""}>${esc(label)}</option>`).join("")}</select><input type="search" data-history-field="query" aria-label="변경 이력 검색" placeholder="자원·고객 이름 검색" value="${esc(this.filters.query)}">`}${this.onRestore ? '<button class="button history-reload" data-history="reload">목록 새로고침</button>' : ""}</div>`}
      ${compact ? "" : `<div class="history-overview"><span><strong>${values.length}</strong> ${this.onRestore ? "백업이 있는 날" : "변화가 감지된 날"}</span>${this.fixedItem ? "" : `<span><strong>${this.onRestore ? new Set(visible.flatMap((cell) => (cell.summary?.records || []).map((record) => record.resourceId.toLowerCase()))).size : changed.size}</strong> ${this.onRestore ? "백업 자원" : "서로 다른 변경 자원"}</span>`}<span class="history-source">${esc(this.mode === "design-preview" ? "명시적 예시 데이터" : this.data.source)} · ${this.tzLabel()}</span></div>`}
      <div class="calendar-zone">
        <div class="calendar-preview" aria-live="polite">${this.previewHtml(chosen)}</div>
        <div class="calendar-scroll" tabindex="-1"><table class="activity-matrix" role="grid" aria-label="${this.onRestore ? "복원할 백업 날짜 선택 격자" : "일별 형상 변경 달력"}" aria-rowcount="7" aria-colcount="${this.weeks + 1}"><thead><tr aria-hidden="true"><th></th>${monthly.map((month) => `<th colspan="${month.span}">${esc(month.text)}</th>`).join("")}</tr></thead><tbody>${WEEKDAYS.map((weekday, row) => `<tr role="row" aria-rowindex="${row + 1}"><th scope="row" role="rowheader" aria-colindex="1" class="weekday-label">${weekday}</th>${this.columns.map((column) => {
        const cell = column.days[row];
        const classes = cell.future ? "future" : cell.state === "unobserved" ? "unobserved" : cell.state === "baseline" && !this.onRestore ? "baseline" : `heat-${cell.level} ${cell.state === "partial" ? "partial" : ""} ${this.onRestore && cell.value >= 2 ? "multi-day" : ""}`;
        const cellLabel = this.onRestore && cell.value > 0
          ? `${cell.date} ${WEEKDAYS[cell.row]}요일 · 백업 ${cell.value}회 (${(cell.summary?.records || []).map((r) => this.formatClock(r.capturedAt || r.at)).join(", ")})`
          : dayLabel(cell, this.metric);
        return `<td role="gridcell" aria-colindex="${column.column + 2}"><button type="button" class="day-cell ${classes} ${cell.date === this.selectedDate ? "selected" : ""}" data-calendar-index="${cell.index}" data-date="${cell.date}" ${this.onRestore && cell.value >= 2 ? `data-backup-count="${cell.value}"` : ""} tabindex="${cell.index === this.focusIndex ? 0 : -1}" aria-label="${esc(cellLabel)}" aria-pressed="${cell.date === this.selectedDate}" ${cell.future ? "disabled" : ""}></button></td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>
      </div>
      <div class="calendar-legend"><span><i class="day-cell unobserved"></i>${this.onRestore ? "백업 없음" : "미관측"}</span>${this.onRestore ? "" : '<span><i class="day-cell baseline"></i>첫 관측만</span><span><i class="day-cell heat-0"></i>비교했으나 0건</span>'}<span><i class="day-cell partial"></i>일부 미확인</span><span class="heat-scale">${this.onRestore ? "하루 백업 횟수" : "적음"} ${CALENDAR_FILLS.slice(1).map((_, index) => `<i class="day-cell heat-${index + 1}"></i>`).join("")} 많음 <small>${this.onRestore ? "1 / 2–3 / 4–7 / 8+회" : "1 / 2–3 / 4–7 / 8+"}</small></span></div>
      ${this.onRestore ? "" : '<div class="history-method"><strong>백업 관측 기준</strong> 변경은 이전·이후 백업 사이에 일어난 사실만 확인합니다. 셀의 날짜는 이후 백업의 관측일이며 실제 변경 시각을 확정하지 않습니다. 같은 자원이 하루 여러 번 바뀌어도 ‘자원 수’에서는 1개입니다.</div>'}
      ${this.data.historyLimited ? `<div class="notice warning" data-persist>최근 ${this.data.runLimit}개 백업만 읽었습니다. ${this.onRestore ? "더 오래된 백업은 이 탐색 목록에 포함되지 않습니다." : "더 오래된 날짜의 미관측 칸을 변화 없음으로 해석하지 마세요."}</div>` : ""}
      ${this.data.warnings.length ? `<details class="history-warnings"><summary>미검증 백업 ${this.data.warnings.length}개 · 수집/비교 누락 확인</summary><ul>${this.data.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul></details>` : ""}
      <div class="history-day-root"></div><div class="history-detail-root"></div>`;
    this.renderDay();
    const scroller = find(".calendar-scroll", this.root);
    scroller.scrollLeft = scroller.scrollWidth;
  }

  renderDay() {
    if (this.onRestore) { this.renderBackups(); return; }
    const summary = this.summaries.get(this.selectedDate);
    const root = find(".history-day-root", this.root);
    const records = (summary?.records || []).filter((record) => this.showAll || isMutation(record) || record.kind === "unknown");
    const pages = Math.max(1, Math.ceil(records.length / 12));
    this.page = Math.min(this.page, pages - 1);
    const rows = records.slice(this.page * 12, (this.page + 1) * 12);
    root.innerHTML = `<section class="history-day"><div class="history-day-heading"><div><p class="heading-eyebrow">DAY EXPLORER</p><h3>${esc(this.selectedDate)} <span>${WEEKDAYS[(new Date(`${this.selectedDate}T00:00:00Z`).getUTCDay() + 6) % 7]}요일</span></h3></div><div class="history-day-nav"><button class="button small" data-history="previous-change">이전 변화일</button><button class="button small" data-history="next-change">다음 변화일</button></div></div>
      <div class="day-metrics"><div><strong>${summary?.changedResources || 0}</strong><span title="변경 자원 · 중복 제외">변경 자원 · 중복 제외</span></div><div><strong>${summary?.properties || 0}${summary?.truncated ? "+" : ""}</strong><span title="속성 변경 발생 수">속성 변경 발생 수</span></div><div><strong>${summary?.occurrences || 0}</strong><span title="형상/목록 변동 기록">형상/목록 변동 기록</span></div><div><strong>${summary?.comparedResources || 0}</strong><span title="이전 형상과 비교한 자원">이전 형상과 비교한 자원</span></div></div>
      ${summary?.failedRuns || summary?.unknownResources ? `<div class="notice warning">미검증 백업 ${summary.failedRuns}개 · 비교 미확인 자원 ${summary.unknownResources}개가 있습니다. 빈 값이나 0건을 전체 변화 없음으로 단정하지 마세요.</div>` : ""}
      ${summary?.observations.some((observation) => observation.scopeChanged) ? '<div class="notice warning">이날 수집 대상/정책 범위가 바뀌었습니다. 목록에서 빠진 자원을 자동 삭제로 판정하지 않았습니다.</div>' : ""}
      <div class="history-list-toolbar"><span>${records.length}개 기록 · 시간순 탐색</span><label class="check-label"><input type="checkbox" data-history-field="showAll" ${this.showAll ? "checked" : ""}>변화 없는 관측·첫 기록도 보기</label></div>
      ${rows.length ? `<div class="history-events">${rows.map((record) => `<button class="history-event ${record.id === this.selectedEvent?.id ? "active" : ""}" data-history-event="${esc(record.id)}"><span class="event-kind ${record.kind}">${HISTORY_KINDS[record.kind]}</span><span class="history-event-name"><strong>${esc(record.name)}</strong><small>${esc(record.typeLabel)} · ${esc(record.customers.join(" / ") || "고객 태그 없음")}</small></span><span class="history-event-count">${record.propertyCount}${record.truncated ? "+" : ""}<small>속성</small></span><time>${new Intl.DateTimeFormat("en-GB", { timeZone: this.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(record.at))}</time><span class="event-arrow" aria-hidden="true">→</span></button>`).join("")}</div>` : `<div class="history-empty">${!summary?.records.length ? "이 날짜에는 필터 대상의 백업 관측 기록이 없습니다." : summary.state === "baseline" ? "첫 관측만 있어 이전 형상과 비교할 수 없습니다. ‘모든 관측’에서 기준 기록을 확인하세요." : "표시한 백업 비교에서 변화가 감지되지 않았습니다. 기록되지 않은 시점의 변화까지 없었다는 뜻은 아닙니다."}</div>`}
      <div class="history-pagination"><button class="button ghost small" data-history="previous-page" ${this.page === 0 ? "disabled" : ""}>이전</button><span>${this.page + 1} / ${pages}</span><button class="button ghost small" data-history="next-page" ${this.page + 1 >= pages ? "disabled" : ""}>다음</button></div></section>`;
  }

  renderBackups() {
    const dayRoot = find(".history-day-root", this.root);
    if (!dayRoot) return;
    if (!this.selectedDate) {
      dayRoot.innerHTML = "";
      return;
    }
    const dayRecords = this.summaries.get(this.selectedDate)?.records || [];
    const rec = this.selectedRecord();
    if (!rec) {
      dayRoot.innerHTML = `<div class="restore-selection-prompt"><strong>${esc(this.selectedDate)}</strong>에는 보관된 백업이 없습니다. 색상이 칠해진 백업 시점 네모칸을 선택하세요.</div>`;
      return;
    }
    const comp = rec.currentComparison || { status: "unknown", reason: "비교 데이터 없음", diffs: [], truncated: false };
    const obs = rec.currentObservation;
    const tz = this.tzLabel();
    const restoreAllowed = Boolean(rec.restoreAllowed);
    const cloneAllowed = Boolean(rec.cloneAllowed ?? rec.restoreAllowed);
    const currentStateText = obs?.status === "present" ? "현재 있음"
      : obs?.status === "missing" && obs.confirmed ? "현재 부재 확인 (삭제됨)"
        : "현재 상태 미확인";
    const actorText = obs?.actor
      ? `최근 변경: ${obs.actor.caller} (${this.formatDateTime(obs.actor.at)})`
      : obs?.code ? `조회 상태: ${obs.code}` : "최근 변경 주체 미확인";
    const switcher = dayRecords.length > 1
      ? `<div class="intra-day-switcher" role="group" aria-label="${esc(this.selectedDate)} 다른 백업 시점"><span>이날 ${dayRecords.length}회 백업</span>${dayRecords.map((item) => `<button type="button" class="day-run-chip small ${item.id === rec.id ? "active" : ""}" data-select-record="${esc(item.id)}" aria-pressed="${item.id === rec.id}"><time>${esc(this.formatClock(item.capturedAt || item.at))}</time><span>${esc(item.label)}</span></button>`).join("")}</div>`
      : "";
    const diffHtml = comp.diffs.length
      ? `<div class="table-scroll restore-diff-scroll"><table class="diff-table restore-diff-table" aria-label="선택한 백업 시점과 현재 시점의 Diff 속성"><thead><tr><th>변경 속성 (Diff · ${comp.diffs.length}${comp.truncated ? "+" : ""}개)</th><th>선택한 백업 값</th><th>현재 시점 값</th></tr></thead><tbody>${comp.diffs.map((diff) => `<tr><td class="mono">${esc(diff.path)}</td><td class="diff-before mono">${esc(formatDiffValue(diff, "before"))}</td><td class="diff-after mono">${esc(formatDiffValue(diff, "after"))}</td></tr>`).join("")}</tbody></table></div>${comp.truncated ? '<div class="notice warning" data-persist>차이가 많아 처음 200개 Diff 속성만 표시합니다.</div>' : ""}`
      : comp.status === "same"
        ? '<div class="diff-empty-state">선택한 백업 시점과 현재 시점의 검토 범위 속성이 동일합니다 (Diff 없음).</div>'
        : `<div class="diff-empty-state unconfirmed">비교 미확인 · ${esc(comp.reason || "백업 무결성 또는 현재 조회 상태를 확인해 주세요.")}</div>`;
    const actionHint = !restoreAllowed && !cloneAllowed
      ? esc(rec.restoreReason || "이 백업 시점은 복원·복제를 실행할 수 없습니다.")
      : "작업을 선택하면 이 페이지 아래에 작업 계획 입력 폼이 표시됩니다.";
    dayRoot.innerHTML = `<section class="restore-comparison" aria-label="선택한 백업과 현재 시점 비교">
      <div class="comparison-sides">
        <div class="comparison-side backup-side">
          <div class="comparison-side-head"><span class="side-eyebrow">선택한 백업 시점</span><span class="side-badge ${rec.complete ? "verified" : "unverified"}">${rec.complete ? "무결성 검증됨" : "미검증"}</span></div>
          <div class="comparison-side-main"><strong>${esc(this.formatDateTime(rec.capturedAt || rec.at))} ${tz}</strong><span>${esc(rec.label)}</span></div>
          ${switcher}
          <small class="mono">Run ${esc(rec.afterRunId)}${rec.apiVersion ? ` · API ${esc(rec.apiVersion)}` : ""}</small>
        </div>
        <div class="comparison-side current-side">
          <div class="comparison-side-head"><span class="side-eyebrow">현재 시점</span><span class="side-badge status-${esc(comp.status)}">${esc(comparisonStatusLabel(comp, obs))}</span></div>
          <div class="comparison-side-main"><strong>${esc(currentStateText)}</strong>${obs?.observedAt ? `<span>${esc(this.formatDateTime(obs.observedAt))} ${tz} 관측</span>` : ""}</div>
          <small>${esc(actorText)}${obs?.apiVersion ? ` · API ${esc(obs.apiVersion)}` : ""}</small>
        </div>
      </div>
      ${diffHtml}
      <div class="comparison-actions">
        <span class="comparison-action-hint ${!restoreAllowed && !cloneAllowed ? "blocked" : ""}">${actionHint}</span>
        <div class="comparison-action-buttons">
          <button type="button" class="button ${this.activeAction === "restore" ? "primary active-choice" : this.activeAction === "clone" ? "" : "primary"}" data-restore-backup="${esc(rec.id)}" data-restore-intent="restore" aria-pressed="${this.activeAction === "restore"}" ${restoreAllowed && !this.busy ? "" : "disabled"} title="${esc(rec.restoreReason || "")}">복원</button>
          <button type="button" class="button ${this.activeAction === "clone" ? "primary active-choice" : ""}" data-restore-backup="${esc(rec.id)}" data-restore-intent="clone" aria-pressed="${this.activeAction === "clone"}" ${cloneAllowed && !this.busy ? "" : "disabled"} title="${esc(rec.cloneReason || rec.restoreReason || "")}">복제</button>
        </div>
      </div>
    </section>`;
  }

  async selectEvent(record) {
    this.selectedEvent = record;
    const version = ++this.detailGeneration;
    this.renderDay();
    const root = find(".history-detail-root", this.root);
    root.innerHTML = `<div class="history-loading" role="status"><span class="spinner"></span>${this.mode === "design-preview" ? "선택한 예시 변경을 읽습니다…" : "선택한 이전·이후 원본의 완료 표식과 hash를 다시 확인합니다…"}</div>`;
    try {
      const data = await this.detail(record);
      if (version !== this.detailGeneration || this.controller.signal.aborted) return;
      const comparison = data.comparison;
      const value = (diff, side) => diff[`${side}Present`] ? JSON.stringify(diff[side]) : "필드 없음";
      root.innerHTML = `<section class="history-inspector"><div class="history-inspector-heading"><h3>${esc(data.name)} · ${this.onRestore ? "백업 원본 비교" : HISTORY_KINDS[record.kind]}</h3><button class="icon-button" data-history="close-detail" aria-label="날짜 변경 상세 닫기"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div><p class="small-text muted">현재값이 아닌 두 백업 원본의 비교입니다. 색상 위험도와 복원 승인을 뜻하지 않습니다.</p><code class="resource-id">${esc(data.resourceId)}</code><div class="history-provenance"><div><span>이전 백업</span><strong>${esc(data.beforeAt || "이전 기록 없음")}</strong><code>${esc(data.beforeRunId || "—")}</code><small>API ${esc(data.beforeApiVersion || "미확인")}</small></div><div><span>이후 관측</span><strong>${esc(data.afterAt)}</strong><code>${esc(data.afterRunId)}</code><small>API ${esc(data.afterApiVersion || "미확인")}</small></div></div>
        ${comparison.diffs.length ? `<div class="table-scroll"><table class="diff-table"><thead><tr><th>속성 경로</th><th>이전 백업 값</th><th>이후 백업 값</th></tr></thead><tbody>${comparison.diffs.map((diff) => `<tr><td class="mono">${esc(diff.path)}</td><td class="diff-before mono">${esc(value(diff, "before"))}</td><td class="diff-after mono">${esc(value(diff, "after"))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="notice">${esc(comparison.reason)}</div>`}
        ${comparison.truncated ? '<div class="notice warning">처음 200개 차이만 표시합니다. 전체 차이가 이보다 많을 수 있습니다.</div>' : ""}
        ${record.observationGap ? '<p class="small-text muted">이전 관측과의 간격이 있습니다. 중간에 변경·원복됐던 횟수나 정확한 변경 시각은 확인하지 못합니다.</p>' : ""}
        ${this.onCurrent ? '<button class="button" data-history="current-resource">백업 현황에서 현재 형상 보기</button>' : ""}</section>`;
    } catch (error) {
      if (version !== this.detailGeneration || this.controller.signal.aborted) return;
      root.innerHTML = `<div class="notice error" role="alert">${esc(errorMessage(error))}</div><button class="button" data-history="retry-detail">선택 원본 다시 확인</button>`;
    }
  }

  syncSelectedMatrixCells(date, index) {
    this.root.querySelectorAll("[data-calendar-index]").forEach((button) => {
      const selected = Boolean(date) && button.dataset.date === date;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.tabIndex = Number(button.dataset.calendarIndex) === index ? 0 : -1;
    });
  }

  selectRecord(record) {
    if (!record) return;
    const targetDate = dateKey(record.at, this.timezone);
    const cell = this.cells.find((item) => item.date === targetDate);
    this.selectedDate = targetDate;
    this.selectedRecordId = record.id;
    this.selectedRunId = record.afterRunId;
    if (cell) {
      this.focusIndex = cell.index;
      this.syncSelectedMatrixCells(targetDate, cell.index);
    }
    const previewCell = this.hoverDate ? this.cells.find((item) => item.date === this.hoverDate) : cell;
    const previewEl = find(".calendar-preview", this.root);
    if (previewEl) previewEl.innerHTML = this.previewHtml(previewCell || cell);
    this.renderDay();
    this.onSelectBackup?.(record);
  }

  selectDate(cell) {
    this.selectedDate = cell.date; this.focusIndex = cell.index; this.selectedEvent = null; this.page = 0;
    this.detailGeneration++;
    const records = cell.summary?.records || [];
    const defaultRec = records.find((item) => item.restoreAllowed || item.cloneAllowed) || records[0] || null;
    this.selectedRecordId = defaultRec?.id || "";
    this.selectedRunId = defaultRec?.afterRunId || "";
    this.syncSelectedMatrixCells(cell.date, cell.index);
    const previewEl = find(".calendar-preview", this.root);
    if (previewEl) {
      if (this.onRestore) previewEl.innerHTML = this.previewHtml(cell);
      else previewEl.textContent = dayLabel(cell, this.metric);
    }
    find(".history-detail-root", this.root)?.replaceChildren();
    this.renderDay();
    if (this.onRestore) this.onSelectBackup?.(defaultRec);
  }

  click(event) {
    const chip = event.target.closest("[data-select-record]");
    if (chip && !chip.disabled && chip.dataset?.selectRecord) {
      const record = this.data?.records.find((item) => item.id === chip.dataset.selectRecord);
      if (record) this.selectRecord(record);
      return;
    }
    const backup = event.target.closest("[data-restore-backup]");
    if (backup && backup.dataset?.restoreBackup) {
      if (!backup.disabled) {
        const record = this.data.records.find((item) => item.id === backup.dataset.restoreBackup);
        const intent = backup.dataset.restoreIntent || "restore";
        const allowed = intent === "clone" ? (record?.cloneAllowed ?? record?.restoreAllowed) : record?.restoreAllowed;
        if (record && allowed) {
          this.setActiveAction(intent);
          this.onRestore(record, intent);
        }
      }
      return;
    }
    const day = event.target.closest("[data-calendar-index]");
    if (day && !day.disabled) { this.selectDate(this.cells[Number(day.dataset.calendarIndex)]); return; }
    const row = event.target.closest("[data-history-event]");
    if (row) { this.selectEvent(this.data.records.find((record) => record.id === row.dataset.historyEvent)); return; }
    const control = event.target.closest("[data-history]");
    if (!control || control.disabled) return;
    const action = control.dataset.history;
    if (action === "reload") this.reload(true);
    if (action === "previous-page" || action === "next-page") { this.page += action === "previous-page" ? -1 : 1; this.renderDay(); }
    if (action === "close-detail") { this.selectedEvent = null; this.detailGeneration++; find(".history-detail-root", this.root).replaceChildren(); this.renderDay(); }
    if (action === "retry-detail") this.selectEvent(this.selectedEvent);
    if (action === "current-resource") this.onCurrent(this.selectedEvent.resourceId);
    if (action === "previous-change" || action === "next-change") {
      const candidates = this.cells.filter((cell) => !cell.future && cell.value > 0
        && (!this.selectedDate || (action === "previous-change" ? cell.date < this.selectedDate : cell.date > this.selectedDate)));
      const target = action === "previous-change" ? candidates.at(-1) : candidates[0];
      if (target) this.selectDate(target);
      else find(".calendar-preview", this.root).textContent = this.onRestore ? "선택한 기간에 더 이상 백업이 있는 날짜가 없습니다." : "선택한 기간에 더 이상 변화가 감지된 날짜가 없습니다.";
    }
  }

  change(event) {
    const field = event.target.dataset.historyField;
    if (!field) return;
    if (field === "showAll") { this.showAll = event.target.checked; this.page = 0; this.renderDay(); return; }
    if (field === "weeks") this.weeks = Number(event.target.value);
    else if (field === "metric") this.metric = event.target.value;
    else if (field !== "query") this.filters[field] = event.target.value;
    this.page = 0; this.selectedEvent = null; this.detailGeneration++;
    this.render();
    find(`[data-history-field="${field}"]`, this.root)?.focus();
  }

  input(event) {
    if (event.target.dataset.historyField !== "query") return;
    this.filters.query = event.target.value;
    const caret = event.target.selectionStart;
    this.page = 0; this.selectedEvent = null; this.detailGeneration++;
    this.render();
    const field = find("[data-history-field='query']", this.root);
    field.focus(); field.setSelectionRange(caret, caret);
  }

  preview(event) {
    const chip = event.target.closest?.("[data-select-record]");
    if (chip && this.onRestore) {
      const record = this.data?.records.find((item) => item.id === chip.dataset.selectRecord);
      if (record) {
        this.hoverRecordId = record.id;
        const detailEl = find(".calendar-preview .preview-record-detail", this.root);
        if (detailEl) detailEl.textContent = this.previewDetailText(record);
      }
      return;
    }
    const button = event.target.closest?.("[data-calendar-index]");
    if (!button) return;
    const cell = this.cells[Number(button.dataset.calendarIndex)];
    if (!cell) return;
    this.hoverDate = cell.date;
    this.hoverRecordId = "";
    const previewEl = find(".calendar-preview", this.root);
    if (!previewEl) return;
    if (this.onRestore) previewEl.innerHTML = this.previewHtml(cell);
    else previewEl.textContent = dayLabel(cell, this.metric);
  }

  resetPreview(event) {
    if (!event.target.closest?.(".calendar-zone, [data-calendar-index]")) return;
    if (event.relatedTarget?.closest?.(".calendar-zone")) return;
    this.hoverDate = "";
    this.hoverRecordId = "";
    const chosen = this.selectedDate ? this.cells.find((cell) => cell.date === this.selectedDate) : null;
    const previewEl = find(".calendar-preview", this.root);
    if (!previewEl) return;
    if (this.onRestore) previewEl.innerHTML = this.previewHtml(chosen);
    else if (chosen) previewEl.textContent = dayLabel(chosen, this.metric);
  }

  key(event) {
    const button = event.target.closest("[data-calendar-index]");
    if (!button) return;
    const target = navigateCalendar(Number(button.dataset.calendarIndex), event.key, this.columns, event.ctrlKey || event.metaKey);
    if (target === null) return;
    event.preventDefault();
    this.root.querySelectorAll("[data-calendar-index]").forEach((control) => { control.tabIndex = Number(control.dataset.calendarIndex) === target ? 0 : -1; });
    find(`[data-calendar-index="${target}"]`, this.root).focus();
  }
}
