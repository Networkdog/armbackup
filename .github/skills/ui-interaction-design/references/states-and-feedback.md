# States, feedback, menus and motion

Source: `frontend/DESIGN_GUIDELINES.md` §4.4, §5.1, §5.2, §5.6 to §5.9, §8 G5, §14.2, §14.4. Moved out of the SKILL so it stays under its size cap.

## States and feedback
- No-match state (search or filter): show the applied term as typed (trimmed) next to a clear button. A blank-only term or an empty catalog is not a search miss: keep the plain empty state and, when the load is incomplete or partial, the "empty does not mean none" warning. A parent-owned term is cleared through a callback prop; without one, show a sentence instead of a dead button. The button disappears on use, so move focus to the search input with a ref (not to the results, not through `querySelector` and `requestAnimationFrame`). `EmptyState` text is 12px (`.empty-state p`): put the term in a `.small-text` element. Layout comes from elements and spacing tokens, never `<br>`.
- Disabled versus hidden: a temporarily disabled action stays visible with its reason. Hide a disabled item only when it is unnecessary on the screen and nobody can enable it (Cloudscape); never hide a permission-limit reason (guide §6.3). A review step that is only read shows plain text, not read-only controls.
- Render failures: error boundaries at page level and section level (charts, drawers, split panels) catch, log and show a fallback with report and reload options. `frontend/src` has none (2026-11-09 search): propose an app-shell boundary in the report and add it only when asked.
- Refresh (manual button or automatic interval): keep the old data visible and usable meanwhile and show the refresh time. After 3 s (Cloudscape says 1 to 10 s) or on a partial failure add a pending or warning status with retry beside the button. Put the manual button in the table or list header; add no other refresh button unless one refreshes only part of the screen. Announce a changed refresh time in a `role="status"` region; the button needs an accessible name and a progress indicator (Cloudscape).
- Banner: lasting limits or outages, one at a time, not dismissible (Atlassian). Its `alert` role is noisy for assistive technology, so use it only for very important messages.
- Empty value: one mark for a missing value, distinct from an error and from 0. This repo mixes `-` (table cells), `없음` (details and lists) and `미지정` (assignee): use `-` in new table cells and propose a cleanup in the report. `DateValue` has no empty-mark prop: add an optional `empty` prop whose default stays `미제공`.

## Menus
- Row actions stay visible in the row; an overflow menu holds only rare or destructive items, and a destructive item still gets its confirmation tier. Name the trigger by its object (`<rule name> 작업 메뉴`), never a bare "더보기" (guide §5.6).

## Tabs and tree grids
- Tabs (APG): arrows move focus and wrap, Tab leaves the tab list for the panel, and a panel with no focusable content, or whose first content is not focusable, gets `tabindex="0"`. Each tab has `aria-controls`, each panel `role="tabpanel"` with `aria-labelledby`, the active tab `aria-selected="true"`. Activate on focus only when the panel shows without delay; otherwise on Enter or Space.
- The shared `TabBar` accepts `id` and `panelId` and sets `aria-controls`, so a screen can tie its `tabpanel` to it. Use `TabBar` (workflow step 0 item 3) instead of building a second tab set. Its one user, `ChangeOperationsPage.tsx`, passes `panelId` and renders a `tabpanel`, like the screens with their own tabs.
- Tree grid (editable, hierarchical): with focus on a row, Right expands a collapsed row and Left collapses an expanded one; with focus on a cell, the arrows move between cells and Enter on the first `aria-expanded` cell toggles. `aria-expanded` sits only on rows with children. The repo's `TreeGrid` is a `table` with disclosure buttons, not `role=treegrid`: do not apply this to it.

## Times
- The label names the event ("규칙 만료됨", "마지막 갱신"), without the words date or time. Approval, audit, expiry and recovery times are absolute with a UTC offset (UTC as `UTC+0:00`). A relative time sits in `<time datetime="<ISO 8601>" title="<absolute time>">`; `datetime` is never prose.
- `DateValue` shows local time without a zone and `미제공` for a missing value. For a new screen that needs a zone, add optional props whose defaults keep today's output and say so in the report; do not format dates inline.

## Motion
- Purpose: explain change (direction, relation, result); minimise it in frequent interactions.
- Scale (design choice): instant feedback 100 ms, component transition 200 ms, large panel 300 to 400 ms; never 450 ms or more in operations screens. Easing `cubic-bezier(0.2, 0, 0, 1)`, exits `cubic-bezier(0.3, 0, 1, 1)`.
- Animate `transform` and `opacity` in preference to layout properties (`width`, `height`, `top`, `left`); never `transition: all`; stay interruptible.
- Honour `prefers-reduced-motion`; convey completion, failure and position statically too; give a pause control for auto motion over 5 s.
