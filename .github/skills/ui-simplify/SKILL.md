---
name: ui-simplify
description: "Use when a screen feels cluttered, heavy or confusing, or when asked to simplify, declutter, shorten or reduce steps, elements or text. Measures first, applies the reduction ladder (remove, merge, default, defer, group, soften) while protecting safety-critical information, and reports before and after numbers. 키워드: 단순화, 간결하게, 덜어내기, 복잡하다, 정리, 요소 줄이기, 문구 줄이기, 미니멀, 깔끔하게."
argument-hint: "[screen or component to simplify]"
---

# UI simplify

Simplicity means fewer obstacles between the user and finishing the task. It is not fewer elements, more white space or a minimalist style. In expert tools it means a predictable structure with less noise, never hidden function. Details: `frontend/DESIGN_GUIDELINES.md` §6.

Facts to keep in mind: every extra unit of information competes with the needed ones (Nielsen heuristic 8); products degrade one feature at a time, so pruning is continuous (Linear undid creeping header actions and icons in 2026); choice overload has a mean effect near zero, so do not cut options just to cut them; neither "7 plus or minus 2" nor "about 3 to 5" caps menu size; Material 3 Expressive testing found removing text labels hurt usability.

## Protected items: hide only if a way to find them remains
- Target, scope and impact of risky actions; the reason for a permission limit.
- Errors, block reasons, unknown or stale data markers.
- Units, ranges, times, sources and evidence.
- Undo and cancel paths.
- Accessible names, focus, keyboard paths.
- Audit records and approval steps (product contract); legally required notices.

## Procedure
1. Fix the task and the one primary action. Arrived here directly? Do `ui-design-workflow` step 0 first (contract, tokens, `ui.tsx`, two similar screens).
2. Measure the baseline: element count (`element-inventory.mjs --summary-only`), word count (visible words of `document.body.innerText`; state the method), the style census (font sizes, weights, colours, radii, shadows), steps for the top 3 tasks.
3. Apply the reduction ladder from the top, recording each step:
| Step | Question | Action |
| --- | --- | --- |
| 1 Remove | No reason (gate G1)? | Delete |
| 2 Merge | Same function or information elsewhere (G4)? | Combine into one |
| 3 Default | Same choice every time? | Replace by default, inference or memory (reversible cases only) |
| 4 Defer | Needed rarely? | Move one step back (progressive disclosure); keep an entry point and an accessible name |
| 5 Group | What remains is scattered? | Group by meaning and name the group |
| 6 Soften | A secondary element leads? | Lower its visual weight |
4. Check the protected list.
5. Re-measure and walk the top 3 tasks again: step count must not grow; deferred information must be found in two actions or fewer. In the repo, rebuild and run the area's e2e spec: removed elements can break selectors and `data-field` contracts.
6. Stop when every budget row is in range or has a stated reason, no element still fails G1 or G4 (gates: `ui-element-audit`), and the top-3 step counts are at or below the baseline. Otherwise repeat from step 3 (3 passes at most).
7. Leave a before and after table.

## Starting budgets (design choices, alarms rather than limits; over budget needs a reason)
| Item | Budget |
| --- | --- |
| Font sizes | 5 or fewer |
| Font weights | 3 or fewer |
| Font families | 2 or fewer |
| Colours | 1 accent plus 4 status |
| Radii | 3 or fewer |
| Shadows | 2 or fewer |
| Primary actions per region | 1 |
| Emphasis means per region | 2 or fewer |
| Button, tab, menu names | about 12 Korean characters (flag above 40) |

## Copy diet
- Result first; one thought per sentence. Users scan.
- Pull weeds: delete words that change nothing; "can do" not "may be able to do"; delete "click". Do not repeat the same phrase on one screen.
- Read aloud and fix stiff Sino-Korean or written-style phrases.
- Use the user's words, not system terms. Say "cannot" plainly and add how to fix it.

## Failures to avoid
- Essential information hidden; success and failure made indistinguishable by simplified status.
- White space added until a table cannot be compared; labels removed so only icons remain.
- Element count lowered by adding depth (one view became three clicks).
- Features, behaviour, permissions or data flow removed or changed without being asked.

## Output
Before and after: elements, words, steps for the top tasks, census numbers; list of removed, merged, deferred items with the reason; protected items confirmed; anything you chose not to remove and why.
