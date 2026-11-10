---
name: ui-design-workflow
description: "Use when creating, redesigning or modifying a web page, screen, component or frontend layout in this repository, or when asked to make a UI look better, more consistent, simpler or more usable. Entry point for UI work: reads the product contract and shared components, writes a short brief, builds with existing tokens, audits the rendered result and reports what was and was not verified. 키워드: 화면 만들기, 설정 화면, UI 개선, 프론트엔드 디자인, 페이지 설계, 컴포넌트 추가, 디자인 일관성, 레이아웃 수정, 리디자인."
argument-hint: "[screen or component, and the goal]"
---

# UI design workflow

Entry point for frontend design work. Rules and evidence live in `frontend/DESIGN_GUIDELINES.md` (cited as §n); read a section only when a step needs it. The product contract `frontend/DESIGN.md` beats this skill and the guide.

Copy this checklist into your reply and tick items as you go:
- [ ] 0 Context read: contract, tokens, shared components, two similar screens
- [ ] 1 Brief and assumptions written
- [ ] 2 Concept chosen (new screen or redesign only)
- [ ] 3 Built with the state table and interaction spec
- [ ] 4 Simplified (only if needed)
- [ ] 5 Verified: rendered, inventory, audit, states, keyboard, build and e2e
- [ ] 6 Report written, including what was not verified

## 0. Context (always)
1. Read the top of `frontend/DESIGN.md` (title, 조사 기준일, the newest dated sections), then search it for the target screen's name, the request's verbs and nouns, and the sections "폰트 · 색상 테마", "설계 철학", "실행 원칙" and "시각 체계". It is a dated, newest-first log with no glossary: take terms from `statusLabel`, nav labels and page titles and list them under Assumptions. Then read the tokens in `frontend/src/themes.css` and `frontend/src/styles.css`, the exports of `frontend/src/ui.tsx`, and two existing screens similar to the target.
2. Classify the screen: content, conversion or operations workspace (§3.1). Default for this repo: operations workspace.
3. List what to reuse, in order: tokens, shared components, existing patterns. A new element needs a one-line reason.
   - Search `frontend/src` first for the requested capability (row deletion exists in `RuleWorkspacePage.tsx`, bulk deletion in `ExpiryCleanupReview.tsx`) and extend it instead of adding a second one.
   - A field, screen, action or route named in the request that the code lacks, or defines and never calls (`api.updateOperations`), is a false premise: say so, take the nearest real target as an assumption and list it first. A claim about impact ("irreversible", "applies at once") is a premise too: check it against the code and the contract (Draft write, recovery point) and set the confirmation tier from what you find. Reproduce a reported defect before designing its fix, or say you could not.
   - A shared component that lacks what the guide needs (`ConfirmDialog` has no type-to-confirm) is extended, not restyled or copied. An existing component that breaks a keyboard or accessibility rule (`RequestActionMenu` skips disabled items) is not copied: build to the rule and report the deviation.
4. Small change (copy, one colour, spacing)? Do steps 0, 5 and 6 only.
5. A control or view that reads or changes data needs a route. Find it in `frontend/src/api.ts` and `backend/src/azfirewallagent/api.py`; never invent an endpoint. If none exists, stop at the interaction spec and report that backend work is missing. Mock rows only as labelled fixtures in tests or a prototype, never in the product bundle. A server contract (a required reason, `expected_revision`) outranks wording such as "edit directly".

## 1. Brief (10 lines max)
Fill the [brief template](./assets/brief-template.md). Ask only what blocks progress, at most 3 questions: irreversible decisions (permissions, deletion, payment, personal data), conflicting requirements, or no data to design from. Everything else becomes an assumption listed first as `Assumptions:` so the user can flip it in one line.
The user's words beat the guide. If they collide with safety or accessibility, say why in one line and offer an alternative. If they need what `DESIGN.md` forbids, that is a decision: offer the nearest allowed place and change the contract only on an explicit yes (step 6).
If nobody can answer (autonomous run), take the least risky assumption (reversible, narrowest permission, Draft only), build only what the contract and the existing API allow, and put the open decision first in the report.

## 2. Concept (new screen or redesign only)
Load `ui-concept-design`. Output: chosen direction, why, and the rejected alternative. A redesign keeps what the contract fixes (areas, flow, permissions, wording).

## 3. Build
Order: structure, tokens, components, states, interaction.
- Load `ui-visual-craft` for hierarchy, type, colour, spacing, density.
- Load `ui-interaction-design` for states, forms, feedback, keyboard, motion, AI features.
- Write the state table (§5.1) and the interaction spec (§5.10) before the code. An empty cell is unimplemented.
- Reuse shared components; do not restyle them inline. A visual request never changes behaviour, permissions or data flow.
- Use realistic Korean copy and long values; never invent numbers, sources or confidence. Show success, "0 items" and "latest" only when verified: failed or unknown must not look like empty or done.

## 4. Simplify
Load `ui-simplify` when the screen grew or the user asked. Protected items (§6.3) are never removed.

## 5. Verify the rendered result
Commands, fallbacks and state-injection methods: [verify the rendered result](./references/verify-rendered.md). Do all five:
1. Serve the app (or use a running one) and look at 320, 390, 1024 and 1440 px (320 = WCAG 1.4.10 reflow; 390 and 1024 straddle the repo breakpoints 760 and 1100 px) in both themes.
2. Run the element inventory once per theme (`--theme light`, then `--theme dark`).
3. Load `ui-element-audit`, judge the eight gates, fix P0 and P1, re-run. At most 3 passes.
4. Create each server-driven state (loading, error, stale, partial, no permission) with your own mocks, then walk the keyboard path.
5. Run `npm.cmd run build --prefix frontend` and the area's e2e spec with `--workers=1`.
Your own design explanation is not evidence (§2.3). Self-critique alone did not reliably improve output; deterministic checks must also improve.

## 6. Report
If the change alters the product contract, add a dated section to `frontend/DESIGN.md` (reason, verification scope). Use the [report template](./assets/report-template.md): decisions, changes, evidence (commands, numbers), not verified, risks. "Passed" means only the checks you ran. Never claim accessibility conformance, certification or real Azure verification you did not perform.

## Routing
Review-only request ("check", "review")? Do not edit: report findings and proposals (`ui-design-review` for a whole screen or PR). Design-only request (a flow, no code)? Do steps 0 to 3 and 6.

## Never
- Change `Ariel` in the font stack to `Arial`; add CDN fonts; invent new colour, spacing or radius values outside the token scales.
- Add an npm dependency without a reason in the report; introduce a database service for UI state (persist only to Azure Storage (Blob, Table, Queue) or the browser as the repo already does).
- Remove an error, warning, unit, scope, undo path, permission reason or accessible name to look cleaner.
- Hide behind trends: glass, bento, gradients and motion need a task reason.
- Touch unrelated modified files in the working tree.
