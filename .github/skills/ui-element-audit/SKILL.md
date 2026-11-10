---
name: ui-element-audit
description: "Use when asked to check every element of a page or component: is it needed, in the right place, with the right meaning, not duplicated, with the right copy and colour. Builds an element inventory from the rendered page (script included), judges each element through gates G1-G8, assigns verdict and severity P0-P3 and re-audits. 키워드: 요소 감사, 구성요소 점검, 위치 적절성, 의미, 중복, 문구, 색상, 인벤토리, 화면 검수 기준, 라벨 점검."
argument-hint: "[URL or screen, plus state, viewport, theme]"
---

# UI element audit

The question is not "is it pretty" but "should this element exist here, with this meaning, copy and colour, exactly once?". Unit of audit: one screen in one state (viewport, theme, role, data). Elements: everything a user sees or operates. Details: `frontend/DESIGN_GUIDELINES.md` §8.

## Procedure
1. **Fix the scope:** screen, state, viewport, theme, role, data. Open each menu, toggle and disclosure once (`--steps`) and audit the opened state as its own screen.
2. **Inventory** the rendered page with [element-inventory.mjs](./scripts/element-inventory.mjs) (below). Outputs hold page text: write them to a temp folder outside the repo, then delete.
3. **Reproduce each flag by hand**, run the [behaviour probes](./references/behaviour-probes.md), then judge each element through G1 to G8 with a reason.
4. **Map duplicates** ([types](./references/duplicates.md)) and consistency with other screens (same function: same name, place, colour, order).
5. **Verdict and severity** for each finding.
6. **Fixes asked for?** Apply the smallest fix, re-run the same inventory, compare (3 passes at most). Otherwise stop at the findings table and list fixes as proposals.
7. **Page-level checks:** document `title`, `lang` and heading order, glossary, budgets, state coverage, same-function table, keyboard walk, orphans.
Every finding carries element ID, selector, evidence (measurement or screenshot), gate and source; a critique without evidence is not a finding. Use the [audit sheet](./assets/audit-sheet-template.md). Per-element checks, only the groups the page needs: [structure](./references/element-criteria-structure.md), [actions](./references/element-criteria-actions.md), [data](./references/element-criteria-data.md), [layers](./references/element-criteria-layers.md).

## Run the tool
```powershell
node .github/skills/ui-element-audit/scripts/element-inventory.mjs --url <url> --keyboard --screenshot <png> --annotate --md <md> --out <json>
node .github/skills/ui-element-audit/scripts/element-inventory.mjs --selftest
```
- Options: `--viewport`, `--theme dark` (prefers-color-scheme only; `THEME-NO-CHANGE` means the page ignored it), `--forced-colors` (Windows high contrast), `--reduced-motion`, `--scope <css>`, `--strict`, `--init-script <file>`, `--storage-state <json>` (a credential: never commit), `--steps "click:<sel>;fill:<sel>=<text>;press:<key>;hover:<sel>;wait:<ms>"` (UI actions only, 5 s each). `--help` lists them; [tool limits](./references/tool-limits.md) says what they cannot do. Server states need `page.route` (workflow step 5).
- Playwright is in `frontend/node_modules`. Start the app first. [audit-fixture.html](./assets/audit-fixture.html) and its [answer key](./assets/audit-fixture.expected.md) feed `--selftest`.

## Trust the tool less than the page
Flags measure a proxy (step 3): state a false alarm and keep the design; fix a wrong tool together with its self-test. Handled false alarms and limits: [tool limits](./references/tool-limits.md). The tool never judges position, need, wording or colour role.

## Eight gates, in order
| Gate | Ask | Pass | Failure signals |
| --- | --- | --- | --- |
| G1 Need | What can the user not do or know without it? | Answers a task, decision information, state or result, error prevention or recovery, legal need, or location | decoration, constant values, invented figures, rare feature in primary space, repeats another element |
| G2 Place | Beside what it explains or controls, in use order, same place as elsewhere? | proximity; scope-matched region; DOM, reading and tab order agree; same function same place; help in the same relative place | label far from field, filter below table, delete beside save with equal emphasis, key status below the fold |
| G3 Meaning | Do look, structure and words say what it does? | button for action, `a[href]` for navigation, proper headings, accessible name contains visible label, one concept one term | link-styled button, div button, nameless icon button, same "OK" with different meanings, status badge that looks clickable |
| G4 Duplicate | Same function, information, name or notice again? | none, or in a different moment or context with identical expression | see DUP1 to DUP10 in the reference |
| G5 Copy | Does every text element, headings included, say what will happen and only what the user needs? | verb plus object for actions, label equals outcome, noun or adjective for states, plain errors with a fix, short, user's words, one register | "Click here", generic "More", "an error occurred", error code only, a label that promises more than the control does, production-memo tone ("only X because Y was not given"), marketing words, a login or reset error that names the wrong credential or confirms the account exists, raw exception text as the main message (sign-in: never) |
| G6 Colour | Does each colour carry one role, with contrast, and not alone? | role tokens, 4.5:1 text, 3:1 large text and UI parts, icon or text beside colour, both themes | decorative status colour, red overuse, one meaning in several colours or one colour with several meanings, faint helper text (2.8:1), dark-only failures |
| G7 Form | Same kind same shape, big enough to operate? | token scales; targets 24 by 24 CSS px unless a WCAG 2.5.8 exception applies (spacing, inline, equivalent, user agent, essential), measured on the real hit area; 44 by 44 for primary, frequent and touch controls; required text 12px or more; truncation with full value reachable | off-scale sizes, tiny targets, clipped text without access |
| G8 State and access | All states, keyboard, focus, announcements? | state table complete; visible unobscured focus; async results announced; disabled, read-only and hidden told apart; no positive tabindex | missing states, focus hidden by sticky bars, keyboard trap |
G1 test: hide it; do the top 3 tasks (from the brief, else a stated assumption) still finish with the same error risk? Protected items (errors, scope, units, undo, access, audit, legal) are never removed. Tool flags cover G3 to G8 only; a clean run is not a finished audit.

## Verdicts and severity
Keep, Fix (structure, behaviour or size), Reword, Recolor, Move, Align (make copies identical), Merge, Remove, Defer (not for protected items), Split, Decide (product decision).
- **P0** misleads or endangers: wrong meaning, unclear target of a dangerous action, wrong permission or data display, key function unreachable.
- **P1** blocks a task, fails AA on the first screen or main task or blocks assistive technology, or conflicts in meaning: contrast under 4.5:1, nameless control, fully hidden focus, same name with different result, a label that overpromises.
- **P2** inconsistency, needless duplication, vague copy, AA misses elsewhere (count them; fix before claiming AA). **P3** polish. Rate a repeated pattern once and list its IDs.
Pass means no P0 or P1. Record P2; P3 is optional.

## Output
Scope line, counts per gate and severity, elements judged N of M, findings table, probe results, tool numbers before and after, residual risks, unchecked items.
