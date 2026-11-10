# S5 repo-bound bulk action (round 10)

Fixed on 2026-11-10 before the first run. Method: scenario 4 of the [trial protocol](./trial-protocol.md), as in [trial S4](./trial-s4.md). One model family generates and judges, one generation per cell, two judges with X and Y swapped: read the result as defect discovery, not proof. S5 tests transfer: its rules (bulk selection, per-item results, confirmation naming count and impact) were written from reviewer and S4 remarks, not from this request.

## Request (word for word, both conditions)
(저장소의 던져 버릴 복사본에서, `frontend/node_modules`는 연결만 한다.) `frontend/src/ChangeOperationsPage.tsx`의 '복구 지점' 탭에서 운영자가 복구 지점을 여러 개 골라 한꺼번에 복구 Draft로 되돌리고, 건마다 진행 상황을 볼 수 있게 해줘. 새 API 경로는 만들지 말고 기존 공용 컴포넌트와 토큰을 써줘. 끝나면 `npm.cmd run build --prefix frontend`가 통과해야 한다.

A adds: "Do not read `.github` or `frontend/DESIGN_GUIDELINES*.md`." (those folders are absent from its copy). B adds: "Read and follow `.github/skills/ui-design-workflow/SKILL.md` and the skills it routes to."

## What the code already fixes (checked 2026-11-10, so the request has a trap)
- The backend has one plan route and one restore route per point (`/recovery-points/{id}/plan`, `/restore`) and no batch route.
- A restore command needs `command_id`, `plan_hash` and `reason`; the plan hash belongs to one point's plan.
- The page lets one restore job run at a time (`jobId` disables the other buttons), and creating a restore Draft needs the Administrator role.
- The existing single flow is: review the scope (before and after), enter a reason, confirm in `ConfirmDialog`, then poll the job.

## Extra checks (fixed with the request)
- E1 No API path outside the routes in `backend/src/azfirewallagent/api.py`; no new route.
- E2 Each selected point's plan is fetched and shown before its restore, and each restore call carries that point's own `plan_hash`, a new `command_id` and a reason.
- E3 The confirmation names the number of selected points and the effect (a restore Draft is created).
- E4 Each point shows its own state (waiting, running, done, failed with the reason); only the failed ones can be retried.
- E5 Shared components and tokens are reused: no new raw colour, no new component file, spacing and radius from tokens.
- E6 `npm.cmd run build --prefix frontend` passes.
- E7 The report lists assumptions and what was not verified, and says what the contract forced (no batch route, one job at a time, administrator only).
Pass: B meets at least as many of E1 to E7 as A, both judges do not prefer A with medium or high confidence, and B has no P0 or P1 that A lacks. Read a failure as a failure.

## Setup
Throwaway copies made by a setup script that is not kept in the repository (A without `.github` and the guide, B with them but without `ui-guideline-maintenance`, a third untouched copy as the base for the diff). B's snapshot at launch (2026-11-10): 29 skill files, hash 406802864c2e; guide 02f9dbf13dc2; instruction file a81dd0118844. A Skill, guide or instruction change after this point makes the run stale.

## Results
Not run yet.
