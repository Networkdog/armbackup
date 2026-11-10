# Screen rubric (R1 to R8)

Rate each dimension 1 to 5 and write one line of evidence. Anchors: 1 fails, 3 acceptable with known issues, 5 strong. No evidence, no score.

| Dim | What it judges | 1 | 3 | 5 | Evidence to cite |
| --- | --- | --- | --- | --- | --- |
| R1 Task fit | Can the top 3 tasks be finished, and is the primary action obvious? | a top task is blocked or needs workarounds | tasks finish with detours or extra steps | tasks finish in fewer or equal steps than the baseline, no errors | task walk: steps, back-tracking, errors |
| R2 Hierarchy and scanning | Does the eye land on the primary action and key value first? | no clear first read; several competing emphases | levels exist but one region has several emphases | three levels, one emphasis per region, passes the squint test | squint test, screenshot |
| R3 Consistency and reuse | Product contract, tokens, shared components, same function same place, name and colour | many raw values, forks of shared components, mixed grammar | mostly reused; a few off-scale values or one-off patterns | tokens and shared components only; comparison table clean | inventory census, same-function table, diff |
| R4 States and recovery | Every state is designed; success is honest; errors recover | missing states; failure looks like empty or success | main states done; some edge states missing | all states in the table, input preserved, recovery paths work | injected states, tests |
| R5 Accessibility and input | Keyboard, focus, names, contrast, targets, zoom, reflow, reduced motion, both themes | keyboard blockers or sub-AA contrast on key paths | minor issues, none blocking | all checks run clean, measured values recorded | inventory flags, keyboard walk, measurements |
| R6 Content and terminology | Copy says what will happen; one concept one term; scope, units, time shown | vague or misleading copy, mixed terms | clear but inconsistent in places | verb plus object, plain errors with a fix, glossary-consistent | copy list, glossary check |
| R7 Simplicity | No needless duplicates; budgets respected; protected items intact | clutter that hides tasks, or protected items removed | some duplicates or over-budget items with reasons | lean, with before and after numbers, nothing protected lost | element counts, census, duplicate map |
| R8 Craft and distinctiveness | Alignment, spacing, polish, finished empty and error states, not a template | misaligned, uneven, generic default look | tidy but generic in places | polished in every state, choices fit the product | polish pass, uniformity check |

Ship rule: no open P0 or P1; R4 and R5 at 4 or more; no other dimension below 3. The mean is informative only.

Pitfalls: scoring from the code alone; scoring only the happy state; letting R8 taste outweigh R4 or R5; treating a clean tool run as a clean audit.
