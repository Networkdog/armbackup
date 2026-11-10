---
name: ui-design-review
description: "Use when asked to review, critique, evaluate or score an existing screen, a pull request that touches frontend UI, or a design proposal, or to decide whether a UI change is ready to ship. Runs rendered-page checks, rates eight screen-level dimensions with evidence, and returns prioritised, reproducible findings with fixes and a re-check. 키워드: 디자인 리뷰, UI 검수, 평가, 비평, 점수, 출시 전 점검, UX 리뷰, PR 디자인 검토, 화면 품질."
argument-hint: "[screen, URL, PR or proposal to review]"
---

# UI design review

A review judges a whole screen or change and says whether it can ship. Element-by-element judgement is `ui-element-audit`; this skill adds screen-level dimensions, evidence discipline and a ship decision. Details: `frontend/DESIGN_GUIDELINES.md` §11.

## Procedure
1. **Scope and context.** Identify what is reviewed: live screen, pull request (diff plus screenshots), or proposal. Read `frontend/DESIGN.md` for the area, the brief or PR description, and name the top 3 user tasks.
2. **Render and measure** (skip nothing that can be run):
   - Open the screen at 320, 390, 1024 and 1440 px (add 768 px and the low heights of guide §11.1 for a full review) in both themes; look at screenshots.
   - `node .github/skills/ui-element-audit/scripts/element-inventory.mjs --url <url> --keyboard --screenshot <png> --annotate` for flags, census and tab order.
   - Walk the keyboard path; inject each state (loading, empty, error, partial, stale, no permission).
   - Zoom to 200% and test 320 px width; try long Korean, English and numeric values; try reduced motion.
   - For a PR: build, then render only the changed screens; compare behaviour before and after for visual-only changes.
3. **Audit suspicious regions** with `ui-element-audit` (do not audit everything unless asked).
4. **Rate the eight dimensions** in the [screen rubric](./references/screen-rubric.md), 1 to 5, each with one line of evidence.
5. **List findings by severity** P0 to P3 (severity definitions as in `ui-element-audit`). Each finding has: where (element ID, selector or screenshot region), evidence (measured value or reproduced steps), guide section, fix, and effort (S, M, L).
6. **Decide.** Ship only when no P0 or P1 is open, R4 and R5 are 4 or more, and no other dimension is below 3. Report the mean but do not ship on the mean. Open P2 AA misses do not block shipping; they do block any claim of AA conformance.
7. **If asked to fix:** apply the smallest fix, re-run the same checks, show the numbers before and after (at most 3 passes).
Report with the [review template](./assets/review-report-template.md).

## Evidence rules
- No score and no finding without evidence: a measurement, a screenshot region, a reproduced step or a failing test. Critique that is grounded in examples and element locations is what improved LLM judgement in studies (UICrit); copy that discipline.
- Separate **observed**, **inferred** and **preference**. Taste is not a defect; label it and never let it block shipping.
- The designer's or the model's explanation of why a design is good is not evidence (the stated rationale was often unimplemented).
- Cite the rule source type: standard, research, practice, house choice. House choices are labelled as such.
- Never average away a P0 or P1. Never claim accessibility conformance, certification or performance targets met unless measured. Real-user metrics (LCP 2.5 s, INP 200 ms, CLS 0.1 at the 75th percentile) cannot be claimed from one local run.
- Say what you could not check and why.

## PR checklist (frontend UI diffs)
- Visual-only PR: behaviour, permissions and data flow unchanged? Any protected item removed (errors, scope, units, undo, accessible names, audit records)?
- Colours, spacing, radii, fonts from tokens only? New token justified?
- New component duplicating a shared one? Same function same name, place and colour as elsewhere?
- New or changed copy: verb plus object, plain errors with a fix, one term per concept, register matches the product?
- All states handled; keyboard path and focus verified; targets 24 px or more; contrast measured in both themes?
- Tests and screenshots updated; DESIGN.md updated when the contract changed.

## Release checklist
Users, screen type and top tasks are clear · existing shell, tokens and components reused · all elements pass the eight gates with no P0 or P1 · contrast measured in both themes · targets, keyboard, focus, zoom, text spacing and drag alternatives checked · loading, empty, failed, partial, stale and conflict states distinguished · essential warnings, units, scope and source never only in tooltips or truncated text · unsaved input, selection, filters and return context preserved as the contract says · risky actions show target, impact and timing · AI output separated from verification, approval and execution and can be edited or rejected · verified and not-verified items written apart.
