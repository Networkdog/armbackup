const TOOLTIP_ID = "action-tooltip";
const HIDE_DELAY_MS = 120;
const initializedDocs = new WeakSet();

let activeDoc = null;
let tooltipElement = null;
let activeAnchor = null;
let hideTimer = 0;
let pointerInAnchor = false;
let pointerInTooltip = false;

function clearHideTimer() {
  if (hideTimer) {
    globalThis.clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

function addDescribedBy(element, id) {
  if (!element?.getAttribute || !element?.setAttribute) return;
  const tokens = (element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  if (!tokens.includes(id)) {
    tokens.push(id);
    element.setAttribute("aria-describedby", tokens.join(" "));
  }
}

function removeDescribedBy(element, id) {
  if (!element?.getAttribute || !element?.setAttribute) return;
  const tokens = (element.getAttribute("aria-describedby") || "").split(/\s+/).filter((token) => token && token !== id);
  if (tokens.length) element.setAttribute("aria-describedby", tokens.join(" "));
  else element.removeAttribute("aria-describedby");
}

function positionTooltip() {
  if (!tooltipElement || !activeAnchor || !activeDoc) return;
  if (!activeAnchor.isConnected) {
    hideTooltip();
    return;
  }
  const rect = activeAnchor.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) {
    hideTooltip();
    return;
  }
  tooltipElement.style.setProperty("--tooltip-left", "0px");
  tooltipElement.style.setProperty("--tooltip-top", "0px");
  const tipRect = tooltipElement.getBoundingClientRect();
  const vw = activeDoc.documentElement?.clientWidth || globalThis.innerWidth || 1024;
  const vh = activeDoc.documentElement?.clientHeight || globalThis.innerHeight || 768;
  const margin = 12;
  const gap = 8;
  const spaceAbove = rect.top - margin;
  const spaceBelow = vh - rect.bottom - margin;
  const placeAbove = spaceAbove >= tipRect.height + gap || spaceAbove >= spaceBelow;
  const top = placeAbove
    ? Math.max(margin, rect.top - tipRect.height - gap)
    : Math.min(Math.max(margin, vh - tipRect.height - margin), rect.bottom + gap);
  const centerX = rect.left + rect.width / 2;
  const preferredLeft = tipRect.width <= rect.width ? centerX - tipRect.width / 2
    : centerX > vw * 0.6 ? rect.right - tipRect.width
      : centerX < vw * 0.4 ? rect.left
        : centerX - tipRect.width / 2;
  const left = Math.max(margin, Math.min(Math.max(margin, vw - tipRect.width - margin), preferredLeft));
  tooltipElement.dataset.placement = placeAbove ? "above" : "below";
  tooltipElement.style.setProperty("--tooltip-left", `${Math.round(left)}px`);
  tooltipElement.style.setProperty("--tooltip-top", `${Math.round(top)}px`);
}

export function hideTooltip() {
  clearHideTimer();
  if (activeAnchor) removeDescribedBy(activeAnchor, TOOLTIP_ID);
  activeAnchor = null;
  pointerInAnchor = false;
  pointerInTooltip = false;
  if (!tooltipElement) return;
  try { tooltipElement.hidePopover?.(); } catch { /* fallback without Popover API */ }
  tooltipElement.hidden = true;
}

function showTooltipFor(anchor) {
  const text = anchor?.getAttribute?.("data-tooltip")?.trim() || "";
  if (!text || !tooltipElement) {
    if (activeAnchor === anchor) hideTooltip();
    return;
  }
  clearHideTimer();
  if (activeAnchor && activeAnchor !== anchor) removeDescribedBy(activeAnchor, TOOLTIP_ID);
  activeAnchor = anchor;
  tooltipElement.textContent = text;
  tooltipElement.hidden = false;
  try {
    if (!tooltipElement.matches?.(":popover-open")) tooltipElement.showPopover?.();
  } catch { /* fallback via fixed z-index */ }
  addDescribedBy(anchor, TOOLTIP_ID);
  positionTooltip();
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = globalThis.setTimeout(() => {
    hideTimer = 0;
    if (!pointerInAnchor && !pointerInTooltip) hideTooltip();
  }, HIDE_DELAY_MS);
}

export function syncTooltipTarget(element) {
  if (!element || activeAnchor !== element) return;
  const text = element.getAttribute?.("data-tooltip")?.trim() || "";
  if (!text) hideTooltip();
  else showTooltipFor(element);
}

export function initActionTooltips(doc = globalThis.document) {
  if (!doc?.body || initializedDocs.has(doc)) return;
  initializedDocs.add(doc);
  activeDoc = doc;
  tooltipElement = doc.getElementById(TOOLTIP_ID);
  if (!tooltipElement) {
    tooltipElement = doc.createElement("div");
    tooltipElement.id = TOOLTIP_ID;
    tooltipElement.className = "action-tooltip";
    tooltipElement.setAttribute("role", "tooltip");
    tooltipElement.setAttribute("popover", "manual");
    tooltipElement.hidden = true;
    doc.body.append(tooltipElement);
  }

  doc.addEventListener("pointerover", (event) => {
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest(`#${TOOLTIP_ID}`)) {
      pointerInTooltip = true;
      clearHideTimer();
      return;
    }
    const candidate = target.closest("[data-tooltip]");
    if (candidate) {
      pointerInAnchor = true;
      showTooltipFor(candidate);
    }
  });

  doc.addEventListener("pointerout", (event) => {
    const target = event.target;
    if (!target?.closest) return;
    const related = event.relatedTarget;
    if (target.closest(`#${TOOLTIP_ID}`) && (!related || !tooltipElement.contains(related))) {
      pointerInTooltip = false;
      if (activeAnchor && related && activeAnchor.contains?.(related)) {
        pointerInAnchor = true;
        clearHideTimer();
      } else {
        scheduleHide();
      }
      return;
    }
    const fromAnchor = target.closest("[data-tooltip]");
    if (fromAnchor && fromAnchor === activeAnchor && (!related || !activeAnchor.contains(related))) {
      pointerInAnchor = false;
      if (related && tooltipElement.contains(related)) {
        pointerInTooltip = true;
        clearHideTimer();
      } else {
        scheduleHide();
      }
    }
  });

  doc.addEventListener("focusin", (event) => {
    const candidate = event.target?.closest?.("[data-tooltip]");
    if (candidate && !candidate.hasAttribute?.("data-quiet-focus")) {
      showTooltipFor(candidate);
    }
  });

  doc.addEventListener("focusout", (event) => {
    if (activeAnchor && event.target === activeAnchor && !pointerInAnchor && !pointerInTooltip) {
      hideTooltip();
    }
  });

  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tooltipElement && !tooltipElement.hidden) {
      hideTooltip();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const disabledControl = event.target?.closest?.('[aria-disabled="true"]');
      if (disabledControl) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (disabledControl.getAttribute?.("data-tooltip")) showTooltipFor(disabledControl);
      }
    }
  }, true);

  doc.addEventListener("click", (event) => {
    const disabledControl = event.target?.closest?.('[aria-disabled="true"]');
    if (disabledControl) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (disabledControl.getAttribute?.("data-tooltip")) showTooltipFor(disabledControl);
      return;
    }
    if (tooltipElement && !tooltipElement.hidden && !tooltipElement.contains(event.target)) {
      hideTooltip();
    }
  }, true);

  doc.addEventListener("scroll", () => {
    if (activeAnchor) positionTooltip();
  }, true);

  doc.defaultView?.addEventListener("resize", () => {
    if (activeAnchor) positionTooltip();
  });

  doc.defaultView?.addEventListener("hashchange", () => {
    hideTooltip();
  });
}
