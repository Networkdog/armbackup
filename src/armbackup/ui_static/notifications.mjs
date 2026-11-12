const LEVELS = {
  info: { icon: "info", label: "정보", ttl: 6000 },
  success: { icon: "check", label: "완료", ttl: 6000 },
  warning: { icon: "alert", label: "경고", ttl: 9000 },
  error: { icon: "alert", label: "오류", ttl: 12000 },
  progress: { icon: "refresh", label: "진행 중", ttl: 0 },
};
const MAX_VISIBLE = 4;
const HISTORY_LIMIT = 50;
const QUIET_MS = 5 * 60 * 1000;
const RESUME_MS = 3000;

const svg = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clock = (time) => new Date(time).toLocaleTimeString("en-GB");

// Every message that is not part of the page content goes through one notifier:
// popups in the top-right corner that expire after a few seconds, plus a bell list that keeps them.
export function createNotifications(doc = document, { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const region = doc.querySelector("#notification-region");
  const bell = doc.querySelector("#notification-bell");
  const badge = doc.querySelector("#notification-count");
  const panel = doc.querySelector("#notification-panel");
  const list = doc.querySelector("#notification-list");
  const clearButton = doc.querySelector("#notification-clear");
  const shown = new Map();
  const quiet = new Map();
  const dismissedErrors = new Set();
  const history = [];
  let unread = 0;

  function lift() {
    if (typeof region.showPopover !== "function" || !doc.querySelector("dialog[open]")) return;
    try { region.hidePopover(); region.showPopover(); } catch { /* the region is already on top */ }
  }
  function renderBadge() {
    if (!badge) return;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = unread === 0;
    bell?.setAttribute("aria-label", unread ? `알림 ${unread}개 · 알림 목록 열기` : "알림 목록 열기");
  }
  function renderHistory() {
    if (!list) return;
    list.replaceChildren(...(history.length ? history.map((item) => {
      const row = doc.createElement("li");
      row.className = `notification-item ${item.level}`;
      const mark = doc.createElement("span");
      mark.className = "notification-mark";
      mark.innerHTML = svg(LEVELS[item.level].icon);
      const body = doc.createElement("span");
      body.className = "notification-body";
      const text = doc.createElement("span");
      text.className = "notification-text";
      text.textContent = item.message;
      const time = doc.createElement("time");
      time.textContent = `${LEVELS[item.level].label} · ${clock(item.at)}`;
      body.append(text, time);
      row.append(mark, body);
      return row;
    }) : [Object.assign(doc.createElement("li"), { className: "notification-empty", textContent: "새 알림이 없습니다." })]));
    if (clearButton) clearButton.disabled = history.length === 0;
  }
  function record(level, message) {
    if (level === "progress") return;
    history.unshift({ level, message, at: now() });
    history.length = Math.min(history.length, HISTORY_LIMIT);
    if (panel?.hidden !== false) unread++;
    renderBadge();
    renderHistory();
  }
  function remove(entry, user = false) {
    clearTimer(entry.timer);
    entry.element.remove();
    shown.delete(entry.key);
    if (user && entry.level === "error") dismissedErrors.add(entry.message);
  }
  function arm(entry) {
    clearTimer(entry.timer);
    entry.timer = entry.ttl > 0 ? setTimer(() => remove(entry), entry.ttl) : null;
  }
  function build(entry) {
    const { level, message, actions } = entry;
    const element = doc.createElement("div");
    element.className = `notification ${level}`;
    element.setAttribute("role", level === "error" ? "alert" : "status");
    const mark = doc.createElement("span");
    mark.className = level === "progress" ? "notification-mark spinner" : "notification-mark";
    if (level !== "progress") mark.innerHTML = svg(LEVELS[level].icon);
    const body = doc.createElement("div");
    body.className = "notification-body";
    const text = doc.createElement("p");
    text.className = "notification-text";
    text.textContent = message;
    body.append(text);
    if (actions.length) {
      const row = doc.createElement("div");
      row.className = "notification-actions";
      row.append(...actions.map((action) => {
        const control = doc.createElement(action.href ? "a" : "button");
        control.className = "button small";
        control.textContent = action.label;
        if (action.href) control.href = action.href;
        else {
          control.type = "button";
          control.addEventListener("click", () => { remove(entry, true); action.run(); });
        }
        return control;
      }));
      body.append(row);
    }
    const close = doc.createElement("button");
    close.className = "icon-button notification-close";
    close.type = "button";
    close.setAttribute("aria-label", "알림 닫기");
    close.innerHTML = svg("close");
    close.addEventListener("click", () => remove(entry, true));
    element.append(mark, body, close);
    const pause = () => clearTimer(entry.timer);
    const resume = () => { if (entry.ttl > 0) entry.timer = setTimer(() => remove(entry), Math.max(RESUME_MS, entry.ttl / 2)); };
    element.addEventListener("mouseenter", pause);
    element.addEventListener("focusin", pause);
    element.addEventListener("mouseleave", resume);
    element.addEventListener("focusout", resume);
    return element;
  }

  function notify({ key, level = "info", message, actions = [], ttl, dedupe = false }) {
    const text = String(message ?? "").trim();
    if (!text) return null;
    const id = key || `${level}:${text}`;
    const current = shown.get(id);
    if (current && current.message === text && current.level === level) {
        if (!dedupe && level !== "progress") arm(current);
      return id;
    }
    const last = quiet.get(id);
    if (dedupe && !current && last && last.message === text && now() - last.at < QUIET_MS) return id;
    if (current) remove(current);
    const entry = { key: id, level, message: text, actions, ttl: ttl ?? LEVELS[level].ttl, timer: null };
    entry.element = build(entry);
    shown.set(id, entry);
    quiet.set(id, { message: text, at: now() });
    region.append(entry.element);
    while (shown.size > MAX_VISIBLE) {
      const oldest = [...shown.values()].find((item) => item.level !== "progress" && item !== entry);
      if (!oldest) break;
      remove(oldest);
    }
    arm(entry);
    record(level, text);
    lift();
    return id;
  }
  function dismiss(key) {
    const entry = shown.get(key);
    if (entry) remove(entry);
  }
  function adopt(root) {
    const notices = [...root.querySelectorAll(".notice")].filter((element) => !element.closest("dialog, [data-persist]"));
    for (const element of notices) {
      const level = ["error", "warning", "success"].find((name) => element.classList.contains(name)) || "info";
      element.querySelectorAll("br").forEach((lineBreak) => lineBreak.replaceWith("\n"));
      const message = element.textContent.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      element.remove();
      notify({ level, message, dedupe: true });
    }
  }
  function watch(root) {
    adopt(root);
    if (typeof MutationObserver !== "function") return null;
    const observer = new MutationObserver(() => adopt(root));
    observer.observe(root, { childList: true, subtree: true });
    return observer;
  }

  bell?.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
    if (open) { unread = 0; renderBadge(); }
  });
  clearButton?.addEventListener("click", () => {
    history.length = 0;
    unread = 0;
    renderBadge();
    renderHistory();
  });
  doc.addEventListener?.("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) { panel.hidden = true; bell?.setAttribute("aria-expanded", "false"); bell?.focus(); }
  });
  doc.addEventListener?.("click", (event) => {
    if (panel && !panel.hidden && !event.target.closest?.("#notification-panel, #notification-bell")) {
      panel.hidden = true;
      bell?.setAttribute("aria-expanded", "false");
    }
  });
  renderBadge();
  renderHistory();
  try { region.showPopover?.(); } catch { /* an unsupported popover keeps the fixed-position fallback */ }

  return {
    notify, dismiss, adopt, watch,
    get open() { return [...shown.values()].some((entry) => entry.level === "error"); },
    // The recovery API the error screens already use: literal text plus optional actions.
    show(message, recovery = [], { background = false } = {}) {
      if (background && dismissedErrors.has(message)) return;
      notify({ level: "error", message, actions: recovery, dedupe: background });
    },
    clear() {
      dismissedErrors.clear();
      for (const [key, entry] of [...shown]) if (entry.level === "error") { remove(entry); quiet.delete(key); }
    },
  };
}
