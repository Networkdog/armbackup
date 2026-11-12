// 재사용 계층 표(TreeGrid)의 고정 제목 로직이다. azfirewallagent의 TreeGrid.tsx를 DOM 코드로 옮겼다.
//
// 계약: 계층 제목 행의 `td[data-tree-depth]`가 포함 관계의 유일한 기준이다. 제목 행과 그 하위 행은
// 형제 <tbody>라서 CSS sticky만으로는 구간이 끝난 제목을 놓지 못하므로, 스크롤마다 고정 대상을 계산해
// `data-tree-pinned`와 `top`을 쓴다.

const HEADING_SELECTOR = "tbody:not([hidden])>tr:not([hidden])>td[data-tree-depth]";
const MAX_FROZEN_RATIO = 0.5;

// 제목 행은 칸 하나가 전체 폭을 차지하거나 열마다 칸이 있을 수 있으므로 행 전체를 고정한다.
const rowCells = (cell) => [...cell.parentElement.children].filter((item) => item instanceof HTMLElement);

function scrollable(container) {
  const table = container.querySelector("table");
  return ["auto", "scroll"].includes(getComputedStyle(container).overflowY) && (!table || getComputedStyle(table).display === "table");
}

function release(cell) {
  cell.removeAttribute("data-tree-pinned");
  cell.removeAttribute("data-tree-pinned-last");
  cell.style.removeProperty("top");
}

function clearPins(container) {
  for (const cell of container.querySelectorAll("[data-tree-pinned]")) release(cell);
}

// 접힌 제목을 누르면 사용자가 제목에서 멀리 떨어진 곳에 남으므로, 먼저 제목을 자기 자리로 가져온다.
function alignFrozenHeading(container, cell) {
  const box = container.getBoundingClientRect();
  const natural = cell.parentElement.getBoundingClientRect().top - box.top - container.clientTop + container.scrollTop;
  container.scrollTo({ top: Math.max(0, natural - (Number.parseFloat(cell.style.top) || 0)), behavior: "instant" });
}

// 머리글 아래에 첫 번째 보이는 행을 포함하는 제목을 깊이 순서대로 고정한다. 정리 함수를 돌려준다.
export function freezeTreeGrid(container) {
  let headings = [];
  let header = 0;
  let frame = 0;

  function measure() {
    if (!scrollable(container)) {
      headings = [];
      clearPins(container);
      container.style.removeProperty("scroll-padding-top");
      return;
    }
    const box = container.getBoundingClientRect();
    header = container.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    headings = [...container.querySelectorAll(HEADING_SELECTOR)].map((cell) => ({
      cell,
      depth: Number(cell.dataset.treeDepth),
      top: cell.parentElement.getBoundingClientRect().top - box.top - container.clientTop + container.scrollTop,
      height: cell.offsetHeight,
    }));
    const tallest = new Map();
    for (const heading of headings) tallest.set(heading.depth, Math.max(tallest.get(heading.depth) ?? 0, heading.height));
    const reserve = [...tallest.values()].reduce((total, height) => total + height, 0);
    container.style.scrollPaddingTop = `${Math.ceil(header + Math.min(reserve, container.clientHeight * MAX_FROZEN_RATIO))}px`;
    apply();
  }

  function apply() {
    if (!headings.length) {
      if (container.querySelector("[data-tree-pinned]")) clearPins(container);
      return;
    }
    const scrollTop = container.scrollTop;
    let stack = [];
    // 맨 위에서는 아무것도 고정하지 않는다. 첫 제목은 제 자리에 있을 뿐이다.
    for (const heading of scrollTop < 1 ? [] : headings) {
      const parents = stack.filter((item) => item.depth < heading.depth);
      const offset = header + parents.reduce((total, item) => total + item.height, 0);
      if (heading.top > scrollTop + offset + 0.5) break;
      stack = [...parents, heading];
    }
    // 같은 깊이 이상의 다음 제목이 자리에 닿으면 이전 제목을 풀어, 오래된 상위 제목이 남지 않게 한다.
    let slot = header;
    const kept = [];
    for (const item of stack) {
      const next = headings.slice(headings.indexOf(item) + 1).find((other) => other.depth <= item.depth);
      if (next && next.top - scrollTop < slot - 0.5) break;
      kept.push(item);
      slot += item.height;
    }
    stack = kept;
    const budget = container.clientHeight * MAX_FROZEN_RATIO;
    while (stack.length > 1 && stack.reduce((total, item) => total + item.height, 0) > budget) stack.shift();
    const pinned = new Set(stack.flatMap((item) => rowCells(item.cell)));
    for (const cell of container.querySelectorAll("[data-tree-pinned]")) if (!pinned.has(cell)) release(cell);
    let top = header;
    stack.forEach((item, index) => {
      const value = `${top}px`;
      for (const cell of rowCells(item.cell)) {
        if (cell.dataset.treePinned !== "true") cell.dataset.treePinned = "true";
        if (cell.style.top !== value) cell.style.top = value;
        if (index === stack.length - 1) cell.dataset.treePinnedLast = "true"; else cell.removeAttribute("data-tree-pinned-last");
      }
      top += item.height;
    });
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  if (container.firstElementChild) resize.observe(container.firstElementChild);
  const mutation = new MutationObserver(schedule);
  mutation.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  const align = (event) => {
    const toggle = event.target.closest?.(".tree-toggle");
    const cell = toggle?.closest("td[data-tree-pinned]");
    if (cell && cell.parentElement.getAttribute("aria-expanded") === "true") alignFrozenHeading(container, cell);
  };
  container.addEventListener("scroll", apply, { passive: true });
  container.addEventListener("click", align, true);
  measure();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    container.removeEventListener("scroll", apply);
    container.removeEventListener("click", align, true);
    clearPins(container);
    container.style.removeProperty("scroll-padding-top");
  };
}
