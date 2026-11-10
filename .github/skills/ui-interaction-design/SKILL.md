---
name: ui-interaction-design
description: "Use when designing or changing behaviour: states, loading and empty views, forms and validation, inline cell editing, row action menus, bulk selection, refresh, sign-in errors and sessions, destructive actions, async and concurrency, keyboard and focus, motion, notifications, or AI-generated suggestions. Produces a state table and an interaction spec, then verifies each state by injecting it. 키워드: 상호작용, 상태 설계, 로딩, 빈 상태, 폼 검증, 확인 대화상자, 행 삭제, 인라인 셀 편집, 더보기·행 작업 메뉴, 일괄 선택·일괄 작업, 새로 고침, 로그인 실패 문구, 세션 만료, 키보드, 포커스, 모션, 토스트·배너 알림, 비동기, AI 제안."
argument-hint: "[component or flow]"
---

# UI interaction design

AI-built UIs implement interactions less completely than static layout, and weakest on subtle ones. So write the state table and interaction spec first, build them, then run each state. Details: `frontend/DESIGN_GUIDELINES.md` §5 and §7. Arrived here directly for a new screen, tab or control? Do `ui-design-workflow` step 0 first (contract, tokens, `ui.tsx`, two similar screens, and item 5, the route check for anything that reads or changes data).

Read the deeper rules only when the work touches them:
- Forms, validation timing, errors, saving, inline edit, sign-in and session: [forms and validation](./references/forms-and-validation.md)
- Destructive actions, async, concurrency: [destructive and async](./references/destructive-and-async.md)
- Disabled versus hidden, error boundaries, refresh, banners, empty values, row menus, tabs, times, motion: [states and feedback](./references/states-and-feedback.md)
- AI suggestions and generated UI: [AI features](./references/ai-features.md)

## 1. States of every data region (write the table before coding)
| State | Show | Avoid |
| --- | --- | --- |
| Initial, not queried | that nothing was queried; the start action | fake 0 or fake success |
| First loading | target, progress cue, content placeholder | endless bare spinner |
| Re-fetching | that shown results are the previous ones | old data shown as new |
| Normal result | scope, refresh time, real data | confident summary without scope or time |
| Truly empty | the successful query scope and "none" | permission error or failure shown as 0 |
| No search or filter match | applied conditions, reset and edit path | claiming there is no data |
| Partial success | succeeded, not queried, failed scopes; retry | claiming everything is fresh and complete |
| Stale | observation time, failed refresh, usable range | "latest" or "verified" badge |
| Error or offline | cause, preserved input, recovery action | empty list or success toast |
| Read-only or no permission | what is visible and what is not allowed | assuming invisible means absent |
| Saving | target, duplicate-run guard, real progress | marking saved first |
| Save conflict | the conflict, current draft, resolution path | silently overwriting the user's change |
Components define the applicable ones of: default, hover, focus-visible, pressed, selected, disabled, loading, error. Focus and selection differ; keyboard position and selection must stay distinguishable.
Tell apart disabled (temporarily unusable, prerequisite unmet), read-only (readable, not editable, no hover or underline affordance) and hidden (looks absent). A temporarily disabled action never vanishes, states its reason nearby and stays reachable by keyboard: prefer `aria-disabled="true"` on the button. The `ActionButton` wrapper is a `tabIndex=0` span with no role or name, so do not copy it until a screen reader reads its name and role; native `disabled` leaves the Tab order.

## 2. Waiting and feedback
- Under 1 s: no loading indicator. Over that, match the pattern to the wait: a spinner for a 1 to 3 s wait or for one module up to 10 s, a skeleton that mirrors the layout for a full-screen load under 10 s, a determinate progress bar for processes (upload, download, convert) and anything over 10 s (Primer and NN/g differ in the 3 to 10 s band, so use progress whenever it is measurable). Run waits over 10 s as background tasks that do not block other work.
- Never use a frame-only skeleton (header and footer, empty body).
- Failure says what happened and what to do next; offer retry when possible. Compute progress only from measurable real progress.
- Response limits 0.1 s, 1 s, 10 s are Nielsen's synthesis. "Doherty threshold 400 ms" is unverified.

## 3. Keyboard and focus
- Everything works by keyboard; focus order follows reading and task order; focus is visible and never obscured by sticky bars.
- Modal: Tab cycles inside, Esc closes unless busy, focus returns to the trigger. If the trigger no longer exists (a deleted row), focus the next row's first control, else the previous row's, else the table heading, and announce the result in a `role=status` region. Use native `<dialog>` where possible.
- Shortcuts are an auxiliary path: keep the normal entry point and show shortcuts in menus or tooltips. A letter, digit or symbol key alone must be switchable off, remappable or focus-only (WCAG 2.1.4); never override standard shortcuts.
- Command menu (`role=menu`): Up and Down move between items, Tab closes it, disabled items stay focusable. Toolbar: 3 or more controls, one Tab stop, arrows inside. Editable table cells: grid pattern (guide §5.6).
- Drag always has a click, tap or value-entry alternative. Hover content can be dismissed, hovered over and persists.
- A custom control built on a hidden native input (radio, checkbox) must show focus on its visible label.
- Filter, tab, page and expand state belongs in the URL when it should survive refresh and sharing.

## 4. Motion
Explain change only; honour `prefers-reduced-motion`; never `transition: all`. Scale and easing: see states and feedback above.

## 5. Notification channels (one event, one channel)
Inline for field or panel errors; banner for lasting limits or outages (one at a time, stays until resolved); toast for brief completion only (never the only error notice, never steals focus); modal only when progress must stop; `role="status"` or `aria-live` for async results to assistive tech. A toast starts at 8 s, stays open while hovered or focused, and never auto-closes if it holds an action or reports an error or risk; repeat its result near the action or in history (guide §5.8).

## 6. Empty states and help
Three different empties: first use, no search or filter result, error. Each states cause and next action in one line. First-use empties explain the feature's purpose kindly; error empties use a warning mark, not playful art. An empty-state action is a secondary button. Help appears at the point of need; recognition beats recall.

## 7. Interaction spec (empty cell = unimplemented)
| Region or element | Trigger | Result | Feedback and timing | Error and recovery | Keyboard |
| --- | --- | --- | --- | --- | --- |
Then run each state and the keyboard path; record what you ran.

## 8. Sign-in errors and sessions
Sign-in, reset and recovery failures get one generic sentence; a session that can expire warns first and keeps the user's input. Rules and this repo's 401 flow: [forms and validation](./references/forms-and-validation.md), "Sign-in and session".
