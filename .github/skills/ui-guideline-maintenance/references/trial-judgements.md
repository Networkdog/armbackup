# Trial judgements

Ratings, P0 and P1 lists and reasons of each blind judge, kept apart from the [trial log](./trial-log.md) so that both files stay small. Ratings use R1 to R8 of `ui-design-review/references/screen-rubric.md`. Every pair was judged twice with X and Y swapped.

## Original six judgements (A = request only, B = with Skills, generated 10:27 to 11:31)
| Judge | Prefers | Confidence | Mean A | Mean B | P0 or P1 in A | P0 or P1 in B | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-J1 | B | low | 3.88 | 4.25 | Empty state says "no rules" while chips still show counts | none | B has no P0 or P1 and is cleaner on state honesty, accessibility, mobile and search. A has stronger triage features but an empty-state contradiction, dead nav items and 11px text. |
| S1-J2 | B | medium | 3.50 | 4.12 | Searching a visible DNAT translated address (for example 10.30.4.15) answers "no matching rules" (7 of 140 visible addresses); the empty state keeps old counts | none | B finds all visible addresses, labels every state honestly and has no P0 or P1. A is richer but gives false no-match answers; accuracy outweighs breadth for a firewall team. |
| S2-J1 | B | medium | 3.50 | 4.50 | The primary CTA opens a mail draft with no recipient (three places); label promises more than the outcome | none | B finishes every action in one click, CTA and decline are equal in size, no defect from 320 to 1920 px. A looks more polished but its CTA is dishonest and a panel button overflows at 320 px. |
| S2-J2 | B | low | 3.88 | 4.13 | none listed | none listed | B has no measured defects and an honest CTA. A has better finish and Korean tone but implies an unsupported "demo access request", opens a recipient-less draft and overflows at 320 px. |
| S3-J1 | A | low | 4.25 | 4.13 | none | none | A never dropped a click, maps browser Back to the previous step and auto-saves the draft on a failed submit; its stepper and hierarchy are clearer. B is better on failure semantics (uncertain timeout with idempotent resubmit, multi-tab conflict) and precise copy but its simulation block fills the top third at 1440. |
| S3-J2 | B | low | 4.25 | 4.25 | none | none | Equal sums (34 of 40). B gives cause-specific address errors, "confirm receipt" after a timeout with the same request number, multi-tab conflict and corrupted-draft recovery. A has more input convenience (protocol picker, duplicate rule, quick expiry, status-coloured stepper) and finish, but generic address errors and no uncertain-timeout state. |

Dimension sums of B minus A over the six judgements: R4 states and recovery +6, R7 simplicity +6, R6 content +4, R3 consistency +3, R5 accessibility +3, R1 task fit -1, R2 hierarchy -1, R8 craft -3. By scenario: S1 +8, S2 +10, S3 -1 in total points (sum 17, equal to the dimension sums; an earlier version of this line said +10, +11 and +1, which did not add up). The Skills bought honest states, recovery paths and fewer elements and cost some finish, task convenience and visual hierarchy. Both S2 judges and both S3 judges called A the more polished page.

## B′ judgements (S2 regenerated from the current Skills, 2026-11-09)
| Judge | Prefers | Confidence | Mean A | Mean B′ | P0 or P1 in A | P0 or P1 in B′ | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S2p-J1 | B′ | medium | 3.38 | 4.00 | The primary CTA opens a mail draft with no recipient (three places) | none | B′ keeps every action one click, survives clipboard failure, decline, 200% text and 320 px, and has no open P1. A is more polished and explains real versus demo mode better, but its CTA promises a request it cannot send. |
| S2p-J2 | B′ | medium | 3.38 | 4.25 | The same CTA, and it presupposes a demo-access channel that is not among the five facts | none | B′'s label matches its behaviour and it uses only the five facts. A is richer but 3.2 times longer, repeats itself and breaks with a larger root font. Real versus demo mode is better in A, shallow in B′. |

B′ minus A over the two judgements by dimension: R1 +2, R2 +1, R3 +2, R4 +2, R5 +2, R6 +2, R7 +2, R8 -1 (total +12; the first B scored +10 on S2). Checklist item 5, real Azure versus demo mode, was "partial" for B′ in both judgements (one table row, not on the first screen at 390 px, no visual) and passed for A. Both judges also listed a repeated CTA block on the first screen and a refusal that does not survive a reload as P2 for B′. The font stack's `Ariel`, which one judge called a typo, is the product contract.
