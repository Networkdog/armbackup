# S4 repo-bound trial (round 9)

Request: S4 in [trial requests](./trial-requests.md); method: scenario 4 of the [trial protocol](./trial-protocol.md). One model family generated and judged, one generation per cell, two judges with X and Y swapped: read the result as defect discovery, not proof.

## Setup (2026-11-09)
- Throwaway copies of the repository, made by script: frontend without `node_modules`, `test-results` and `artifacts`, backend, README, `node_modules` linked. A had no `.github` and no guide. B had `.github` (without `agents`), the guide and the history file.
- B's snapshot at launch: 29 skill files without `ui-guideline-maintenance`, hash 79ac76a2c0b0; guide 74e8f5c40002; instruction file fb21fab8815f. The tab, tree-grid, time, status-indicator and no-match rules were added afterwards, so this run describes the earlier set.
- Harness clock: A about 42 minutes, B about 49 minutes.

## Deterministic results
| Measure | A | B |
| --- | --- | --- |
| `npm.cmd run build --prefix frontend` | pass | pass |
| Added and removed lines in `frontend/src` and `frontend/e2e` | 42 and 7 | 22 and 6 |
| Added and removed lines with `DESIGN.md` and README | 58 and 8 | 38 and 6 |
| Raw colours, inline styles, new files added | 0, 0, 0 | 0, 0, 0 |
| Files | 3 source, 1 e2e case (20 lines), `DESIGN.md` section, README sentence | 3 source, `DESIGN.md` section, no test |
Both added an optional `onClearSearch` prop to `IpGroupCatalogSection` and said so; neither judge counted it as a new API. Extra checks of scenario 4 (shared components and tokens, no new component or route, no raw hex, applied term shown only when the search is the cause, reset with a parent-owned term, focus after the reset, build): both pass all seven.

## Blind judgements
| Judge | Prefers | Confidence | Mean A | Mean B | P0 or P1 | Reason (at most 40 words) |
| --- | --- | --- | --- | --- | --- | --- |
| S4-J1 (X = A) | A | low | 4.25 | 4.00 | none | A moves focus to the search box by ref, shows the term in quotes at 12px and adds a test. B uses `<br />`, an 11px bold term and focus found by selector. B's fallback sentence does not outweigh these. |
| S4-J2 (X = B) | A | low | 4.25 | 4.25 | none | Equal sums (34 of 40). A has block markup without `<br>`, ref focus on the owned input, a 12px term and an e2e case. B has a fallback sentence and a smaller diff, but `<br />`, an 11px term and selector-based focus. |
B minus A over both judgements: R1 0, R2 -1, R3 0, R4 +1, R5 0, R6 -1, R7 +1, R8 -2 (total -2). Both judges listed as P2 for B: `<br />` with no precedent in the code, the term at 11px without delimiters, focus sent to the list region through `[role="region"]` and `requestAnimationFrame` (typing again needs Shift+Tab), no e2e case, a broad CSS rule. P2 for A: focus handled in the parent (an implicit contract), a global class, an extra README sentence. Both: no live region, and a button name that does not say it clears the search shared by three lists. Both judges found that `--space-*` is defined but used nowhere in the existing CSS (verified: 0 uses, about 1,400 px spacing declarations).

## What each run reported (self-report, not re-run)
- A: build; Playwright on Edge against a mock API (49 checks: term shown, clear and focus, blank term, long term, partial load, 320, 390 and 1440 px, dark theme, axe); the new e2e case and two existing ones against the mock server.
- B: build; dev server and built output on Edge against a fake API (56 and 44 checks; keyboard and focus; partial, unavailable, not-loaded, empty and stale catalogs; four widths, both themes); inventory with no new flag; text contrast of 6.11 (light) and 6.5 (dark) against the 4.5 limit; its own checks failed when the code was broken on purpose. B named the 11px text and a shared Vite cache side effect as risks.
- Neither could run the repository's e2e suite (no `.venv`, no Azurite).

## Reading
The Skills did not improve the code of this bounded edit: both passed every check, no P0 or P1 appeared, and both judges preferred A at low confidence, mostly on finish (R8 -2), as in the static scenarios (guide appendix A.1 item 3). B's honest reporting of its own deviations is the visible difference, and it is not a measured gain.

## Changes made because of S4
No-match state rules (guide §5.1); repo facts that both judges and the code showed: `.empty-state p` is 11px and `--space-*` is unused (guide §14.2, §14.4 item 10, instruction file); no `<br>` for layout (`ui-visual-craft`); a case in the area's e2e spec for each new state (`verify-rendered.md`). Not done: B regenerated from the changed Skills and judged again with swapped order (protocol rule). The rules came from S4's own judge remarks, so a new repo-bound request (S5) is needed to test transfer.
