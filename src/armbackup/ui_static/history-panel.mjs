import {
  WEEKDAYS, HISTORY_KINDS, CALENDAR_FILLS, calendarWeeks, dateKey, summarizeHistory,
  dayLabel, isMutation, navigateCalendar,
} from "./change-calendar.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const errorMessage = (error) => error instanceof Error ? error.message : "변경 이력을 읽지 못했습니다.";
const find = (selector, root) => root.querySelector(selector);

export class HistoryPanel {
  constructor(root, { load, detail, timezone = "Asia/Seoul", mode = "live-lab", onCurrent = null, initial = null }) {
    this.root = root; this.load = load; this.detail = detail; this.timezone = timezone;
    this.mode = mode; this.onCurrent = onCurrent;
    this.weeks = 53; this.metric = "resources"; this.filters = { customer: "", type: "", query: "" };
    this.selectedDate = ""; this.selectedEvent = null; this.showAll = false; this.page = 0;
    if (initial) {
      this.weeks = initial.weeks; this.metric = initial.metric; this.filters = { ...initial.filters };
      this.selectedDate = initial.selectedDate; this.showAll = initial.showAll;
    }
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
    return { weeks: this.weeks, metric: this.metric, filters: { ...this.filters },
      selectedDate: this.selectedDate, showAll: this.showAll };
  }

  async reload(force = false) {
    const version = ++this.generation;
    this.detailGeneration++;
    this.root.innerHTML = '<div class="history-loading" role="status"><span class="spinner"></span>검증된 일반 백업의 이전·이후 형상을 읽고 있습니다. 실제 Azure 현재값을 과거 날짜에 넣지 않습니다.</div>';
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

  render() {
    this.summaries = summarizeHistory(this.data, this.timezone, this.filters);
    const today = dateKey(this.data.generatedAt, this.timezone);
    this.columns = calendarWeeks(today, this.weeks, this.summaries, this.metric);
    this.cells = this.columns.flatMap((column) => column.days);
    const visible = this.cells.filter((cell) => !cell.future);
    if (!visible.some((cell) => cell.date === this.selectedDate)) {
      this.selectedDate = [...visible].reverse().find((cell) => cell.value > 0)?.date
        || [...visible].reverse().find((cell) => cell.summary?.records.length)?.date || today;
    }
    const chosen = this.cells.find((cell) => cell.date === this.selectedDate);
    this.focusIndex = chosen?.index ?? visible.at(-1).index;
    const values = visible.filter((cell) => cell.value > 0);
    const changed = new Set(values.flatMap((cell) => cell.summary.records.filter(isMutation).map((record) => record.resourceId.toLowerCase())));
    const observations = visible.filter((cell) => cell.summary?.records.length);
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
    this.root.innerHTML = `
      <div class="history-title"><h2>변경 달력</h2><button class="button" data-history="reload">이력 새로고침</button></div>
      <div class="history-toolbar"><label>기간<select data-history-field="weeks" aria-label="변경 달력 기간"><option value="53" ${this.weeks === 53 ? "selected" : ""}>최근 1년 · 53주</option><option value="26" ${this.weeks === 26 ? "selected" : ""}>최근 6개월 · 26주</option><option value="13" ${this.weeks === 13 ? "selected" : ""}>최근 3개월 · 13주</option></select></label><label>색상 기준<select data-history-field="metric" aria-label="변경 달력 색상 기준"><option value="resources" ${this.metric === "resources" ? "selected" : ""}>변경 자원 수</option><option value="properties" ${this.metric === "properties" ? "selected" : ""}>속성 변경 발생 수</option></select></label>
      <select data-history-field="customer" aria-label="변경 이력 고객 필터"><option value="">모든 고객 태그</option>${customers.map((customer) => `<option ${this.filters.customer === customer ? "selected" : ""}>${esc(customer)}</option>`).join("")}</select><select data-history-field="type" aria-label="변경 이력 종류 필터"><option value="">모든 리소스 종류</option>${types.map(([type, label]) => `<option value="${esc(type)}" ${this.filters.type === type ? "selected" : ""}>${esc(label)}</option>`).join("")}</select><input type="search" data-history-field="query" aria-label="변경 이력 검색" placeholder="자원·고객 이름 검색" value="${esc(this.filters.query)}"></div>
      <div class="history-overview"><span><strong>${values.length}</strong> 변화가 감지된 날</span><span><strong>${changed.size}</strong> 서로 다른 변경 자원</span><span><strong>${observations.length}</strong> 필터 대상 관측일</span><span class="history-source">${esc(this.mode === "design-preview" ? "명시적 예시 데이터" : this.data.source)} · ${this.timezone === "UTC" ? "UTC" : "KST"}</span></div>
      <div class="calendar-scroll" tabindex="-1"><table class="activity-matrix" role="grid" aria-label="일별 형상 변경 달력" aria-rowcount="7" aria-colcount="${this.weeks + 1}"><thead><tr aria-hidden="true"><th></th>${monthly.map((month) => `<th colspan="${month.span}">${esc(month.text)}</th>`).join("")}</tr></thead><tbody>${WEEKDAYS.map((weekday, row) => `<tr role="row" aria-rowindex="${row + 1}"><th scope="row" role="rowheader" aria-colindex="1" class="weekday-label">${weekday}</th>${this.columns.map((column) => {
        const cell = column.days[row];
        const classes = cell.future ? "future" : cell.state === "unobserved" ? "unobserved" : cell.state === "baseline" ? "baseline" : `heat-${cell.level} ${cell.state === "partial" ? "partial" : ""}`;
        return `<td role="gridcell" aria-colindex="${column.column + 2}"><button class="day-cell ${classes} ${cell.date === this.selectedDate ? "selected" : ""}" data-calendar-index="${cell.index}" data-date="${cell.date}" tabindex="${cell.index === this.focusIndex ? 0 : -1}" aria-label="${esc(dayLabel(cell, this.metric))}" aria-pressed="${cell.date === this.selectedDate}" title="${esc(dayLabel(cell, this.metric))}" ${cell.future ? "disabled" : ""}></button></td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="calendar-preview" aria-live="polite">${esc(dayLabel(chosen, this.metric))}</div>
      <div class="calendar-legend"><span><i class="day-cell unobserved"></i>미관측</span><span><i class="day-cell baseline"></i>첫 관측만</span><span><i class="day-cell heat-0"></i>비교했으나 0건</span><span><i class="day-cell partial"></i>일부 미확인</span><span class="heat-scale">적음 ${CALENDAR_FILLS.slice(1).map((_, index) => `<i class="day-cell heat-${index + 1}"></i>`).join("")} 많음 <small>1 / 2–3 / 4–7 / 8+</small></span></div>
      <div class="history-method"><strong>백업 관측 기준</strong> 변경은 이전·이후 백업 사이에 일어난 사실만 확인합니다. 셀의 날짜는 이후 백업의 관측일이며 실제 변경 시각을 확정하지 않습니다. 같은 자원이 하루 여러 번 바뀌어도 ‘자원 수’에서는 1개입니다.</div>
      ${this.data.historyLimited ? `<div class="notice warning">최근 ${this.data.runLimit}개 run만 읽었습니다. 더 오래된 날짜의 미관측 칸을 변화 없음으로 해석하지 마세요.</div>` : ""}
      ${this.data.warnings.length ? `<details class="history-warnings"><summary>미검증 백업 ${this.data.warnings.length}개 · 수집/비교 누락 확인</summary><ul>${this.data.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul></details>` : ""}
      <div class="history-day-root"></div><div class="history-detail-root"></div>`;
    this.renderDay();
    const scroller = find(".calendar-scroll", this.root);
    scroller.scrollLeft = scroller.scrollWidth;
  }

  renderDay() {
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
      root.innerHTML = `<section class="history-inspector"><div class="history-inspector-heading"><h3>${esc(data.name)} · ${HISTORY_KINDS[record.kind]}</h3><button class="icon-button" data-history="close-detail" aria-label="날짜 변경 상세 닫기">×</button></div><p class="small-text muted">현재값이 아닌 두 백업 원본의 비교입니다. 색상 위험도와 복원 승인을 뜻하지 않습니다.</p><code class="resource-id">${esc(data.resourceId)}</code><div class="history-provenance"><div><span>이전 백업</span><strong>${esc(data.beforeAt || "이전 기록 없음")}</strong><code>${esc(data.beforeRunId || "—")}</code><small>API ${esc(data.beforeApiVersion || "미확인")}</small></div><div><span>이후 관측</span><strong>${esc(data.afterAt)}</strong><code>${esc(data.afterRunId)}</code><small>API ${esc(data.afterApiVersion || "미확인")}</small></div></div>
        ${comparison.diffs.length ? `<div class="table-scroll"><table class="diff-table"><thead><tr><th>속성 경로</th><th>이전 백업 값</th><th>이후 백업 값</th></tr></thead><tbody>${comparison.diffs.map((diff) => `<tr><td class="mono">${esc(diff.path)}</td><td class="diff-before mono">${esc(value(diff, "before"))}</td><td class="diff-after mono">${esc(value(diff, "after"))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="notice">${esc(comparison.reason)}</div>`}
        ${comparison.truncated ? '<div class="notice warning">처음 200개 차이만 표시합니다. 전체 차이가 이보다 많을 수 있습니다.</div>' : ""}
        ${record.observationGap ? '<p class="small-text muted">이전 관측과의 간격이 있습니다. 중간에 변경·원복됐던 횟수나 정확한 변경 시각은 확인하지 못합니다.</p>' : ""}
        ${this.onCurrent ? '<button class="button" data-history="current-resource">백업 현황에서 현재 형상 보기</button>' : ""}</section>`;
    } catch (error) {
      if (version !== this.detailGeneration || this.controller.signal.aborted) return;
      root.innerHTML = `<div class="notice error" role="alert">${esc(errorMessage(error))}</div><button class="button" data-history="retry-detail">선택 원본 다시 확인</button>`;
    }
  }

  selectDate(cell) {
    this.selectedDate = cell.date; this.focusIndex = cell.index; this.selectedEvent = null; this.page = 0;
    this.detailGeneration++;
    this.root.querySelectorAll("[data-calendar-index]").forEach((button) => {
      const selected = button.dataset.date === cell.date;
      button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", selected);
      button.tabIndex = Number(button.dataset.calendarIndex) === cell.index ? 0 : -1;
    });
    find(".calendar-preview", this.root).textContent = dayLabel(cell, this.metric);
    find(".history-detail-root", this.root).replaceChildren();
    this.renderDay();
  }

  click(event) {
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
        && (action === "previous-change" ? cell.date < this.selectedDate : cell.date > this.selectedDate));
      const target = action === "previous-change" ? candidates.at(-1) : candidates[0];
      if (target) this.selectDate(target);
      else find(".calendar-preview", this.root).textContent = "선택한 기간에 더 이상 변화가 감지된 날짜가 없습니다.";
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
    const button = event.target.closest("[data-calendar-index]");
    if (button) find(".calendar-preview", this.root).textContent = dayLabel(this.cells[Number(button.dataset.calendarIndex)], this.metric);
  }
  resetPreview(event) {
    if (!event.target.closest("[data-calendar-index]")) return;
    if (event.relatedTarget?.closest?.(".activity-matrix")) return;
    const chosen = this.cells.find((cell) => cell.date === this.selectedDate);
    if (chosen) find(".calendar-preview", this.root).textContent = dayLabel(chosen, this.metric);
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
