# Audit sheet template

Copy this into the report. One row per finding; keep passing elements out unless the user asks for a full table.

## Scope
Screen · state · viewport · theme · role · data · date · commit or build · elements judged N of M (groups judged together)

## Tool numbers
| Run | Elements | Errors | Warnings | Notes |
| --- | --- | --- | --- | --- |
| Before | | | | |
| After pass 1 | | | | |

## Findings
| ID | Element and selector | Gate | Evidence (measure or screen) | Verdict | Severity | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| E000 | button "..." `sel` | G3 | no accessible name (flag A11Y-NO-NAME) | Fix | P1 | add label "Delete rule A" |

Verdicts: Keep, Fix, Reword, Recolor, Move, Align, Merge, Remove, Defer, Split, Decide.
Severity: P0 misleads or endangers. P1 blocks a task or assistive technology, fails AA on the first screen or in the main task, or conflicts in meaning. P2 inconsistency, needless duplicate, vague copy, AA misses elsewhere (count them; they still block an AA claim). P3 polish.

## Behaviour probes (flags cannot find these)
| Probe | What you did | What happened | Verdict |
| --- | --- | --- | --- |
| Outcome: each primary action (5 at most) | | | |
| Search: 5 visible values, derived ones included | | | |
| Empty state: message, counts and chips agree | | | |
| Click: each non-link element that looks interactive | | | |
| Squint: what the blurred 1440 px screenshot shows first | | | |

## Duplicate and consistency map
| Type (DUP1 to DUP10) | Elements | Decision |
| --- | --- | --- |

## Page-level checks
Glossary versus approved terms · budgets (font sizes, weights, colours, radii, shadows) · state coverage · same-function comparison with other screens · squint test · keyboard walk · orphan elements (always disabled, constant value, click does nothing).

## Residual risks and unchecked items
