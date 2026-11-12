export const SIDEBAR_STORAGE_KEY = "armbackup.sidebar-collapsed";

export function readCollapsed(storage) {
  try { return storage?.getItem(SIDEBAR_STORAGE_KEY) === "1"; }
  catch { return false; }
}

export function writeCollapsed(storage, collapsed) {
  try { storage?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0"); }
  catch { /* 보관하지 못해도 이번 화면에서는 접힌 상태를 유지한다. */ }
}

// 접힌 상태에서는 글자 없이 아이콘만 남으므로 이름을 마우스 힌트로 보여 준다.
export function applyCollapsed(doc, collapsed) {
  doc.body.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = doc.querySelector("#sidebar-toggle");
  if (toggle) {
    const label = collapsed ? "메뉴 펼치기" : "메뉴 접기";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", label);
    const text = toggle.querySelector(".side-label");
    if (text) text.textContent = label;
  }
  for (const text of doc.querySelectorAll("#sidebar .side-label")) {
    const owner = text.closest("a, button, .sidebar-user");
    if (!owner || owner.classList.contains("brand")) continue;
    if (collapsed) owner.title = text.firstChild?.textContent?.trim() || text.textContent.trim();
    else owner.removeAttribute("title");
  }
}

export function initSidebarCollapse(doc = document, storage = window.localStorage) {
  const toggle = doc.querySelector("#sidebar-toggle");
  if (!toggle) return;
  let collapsed = readCollapsed(storage);
  applyCollapsed(doc, collapsed);
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    applyCollapsed(doc, collapsed);
    writeCollapsed(storage, collapsed);
  });
}
