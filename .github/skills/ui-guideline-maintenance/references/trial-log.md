# Trial log

Judgements and artifact hashes kept in the repository because the temporary trial folders are deleted. Method: [trial protocol](./trial-protocol.md); pass criteria: guide §11.4; each judge's ratings and reasons: [trial judgements](./trial-judgements.md). One model family generated and judged everything, and the samples are small: read the results as defect discovery, not proof.

## Setup (2026-11-09)
- Scenarios: S1 operations rule-review table, S2 one-product landing page, S3 three-step request form (wording in the protocol and `trial-requests.md`).
- Condition A: the request only. Condition B: the request plus "read and follow `ui-design-workflow` and the skills it routes to".
- B artifacts for S1 to S3 were generated between 10:27 and 11:31 from the Skills as they stood then. `ui-design-workflow`, `ui-concept-design`, `ui-interaction-design`, `ui-visual-craft`, `ui-element-audit` and `ui-design-review` were edited afterwards because of judge remarks, real-page audits and review rounds. The trial therefore measures an earlier revision, not today's set. Only S2 was regenerated from a later set (B′ below); S1 and S3 were not.
- Judges: two per scenario with X and Y swapped, blind to the condition, scoring R1 to R8 of `ui-design-review/references/screen-rubric.md`. S3 condition A was generated on the third attempt (two earlier attempts failed with model connection errors).

## Artifacts (SHA-256, first 12 hex of `index.html`)
| Scenario | A | B |
| --- | --- | --- |
| S1 | 990cbe6bd592 | a73c6e88e15e |
| S2 | 096a9a94d888 | c3b9cd3ddb8e |
| S3 | f6b835651cf0 | a2389e8c4060 |
| S2 (B′, regenerated) | 096a9a94d888 (same A) | 5f9e8b9e4996 |

## Deterministic metrics (final inventory tool, light theme)
Axe violations, horizontal overflow, console errors and inventory errors or warnings were 0 for every output. axe-core 4.13.0 through `@axe-core/playwright` with the tags wcag2a, wcag2aa, wcag21a, wcag21aa and wcag22aa; the default rule set adds one best-practice `region` hit to S1-B (`div.demo-bar`), re-measured 2026-11-09.
| Output | Elements | Font sizes | Weights | Text colours | Surface radii | Surface shadows | Tab stops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-A | 227 | 5 | 3 | 6 | 5 | 1 | 112 |
| S1-B | 215 | 4 | 3 | 8 | 4 | 0 | 95 |
| S2-A | 71 | 10 | 4 | 12 | 8 | 0 | 13 |
| S2-B | 43 | 5 | 3 | 4 | 3 | 0 | 6 |
| S3-A | 40 | 5 | 4 | 3 | 4 | 3 | 21 |
| S3-B | 43 | 5 | 3 | 3 | 3 | 0 | 11 |
| S2-B′ | 28 | 5 | 3 | 3 | 2 | 0 | 5 |

## Results
- Original six judgements: B was preferred in five, A in one (S3-J1). Four of the six are low confidence. No judge listed a P0 or P1 for B. A had P1 in S1 and S2 (false "no match" search answers, an empty-state contradiction, a CTA that opens a recipient-less mail draft).
- The Skills bought honest states, recovery paths and fewer elements and cost some finish, task convenience and visual hierarchy (dimension sums in [trial judgements](./trial-judgements.md)).

## Criteria check (guide §11.4)
| Criterion | Result |
| --- | --- |
| Deterministic metrics: B no worse than A in every scenario and better in at least two | Fails strictly: S1-B has 8 text colours against 6 in S1-A, and S3-B has 43 elements against 40. B is better on elements, font sizes, radii, shadows and Tab stops in S1; on elements, font sizes, weights, colours, radii and Tab stops in S2; on weights, radii, shadows and Tab stops in S3 (A exceeds the weight and shadow budgets there). |
| Blind judgement: B preferred in at least two of the three scenarios | Met on S1 and S2 (four of four judgements). S3 is a split at low confidence (one judge each way, equal mean in the second). |
| No scenario where B adds a P0 or P1 that A lacks | Met. B had no P0 or P1 in any of the six judgements. |

## B′: S2 regenerated from the current Skills (2026-11-09)
- Generated 14:30 to 15:01 by a fresh agent told to read and follow `ui-design-workflow` and the Skills it routes to, with the same S2 request. Skill snapshot at launch: 27 files without `ui-guideline-maintenance`, hash d6ddf485a0a6; guide hash 5df387649625. Cost, self-reported: about 31 minutes and about 130 tool calls. Condition A is the unchanged S2-A.
- Both blind judges preferred B′ (medium confidence each; means 3.38 for A, 4.00 and 4.25 for B′). A had a P1 in both judgements, B′ none. The dimension sums favour B′ everywhere except craft (R8 -1).
- Deterministic criteria for S2: B′ is no worse than A on every metric (28 elements against 71, 5 font sizes against 10, 3 text colours against 12).
- Weak spot found: the supplied fact that separates the product (real Azure versus demo mode) was a single table row; both judges called checklist item 5 partial. `ui-concept-design` and guide §3.8 now say to show such a fact with the product's own labels, marked as an example.
- Read this as a second, independent S2 sample from the Skills of that day. It does not show that S1 or S3 would improve. Round 7 changed several Skills afterwards, so B′ is stale under the protocol's staleness rule.

## Audit trial against the answer key (2026-11-09)
- A fresh agent audited `audit-fixture.html` by following `ui-element-audit` (1440x900, light, fix mode off). It was told not to read `audit-fixture.expected.md` or the tool script. About 27 minutes and 46 tool calls. Result: 34 findings (P1 12, P2 18, P3 4), verdict fail.
- Scored against the key as it stood before the trial (20 defect rows): all 20 found; 17 with gate, verdict and severity exactly as keyed. The differences: truncated text under G7 instead of G5, the aria-hidden button at P1 instead of P2, the disabled button as Decide instead of Fix. No decoy was reported as a duplicate or a defect; the per-row "삭제" buttons were rated P2 instead of an optional P3.
- Six real findings the key lacked are now keyed (skip link without target, "목차로", hidden radios, theme controls, search icons, link colours). The other extra findings restated fixture artifacts.
- The auditor reproduced every tool error and warning by hand, ruled the tool's `A11Y-NONNATIVE-CONTROL` on "맨 위로" a false alarm, measured the image text by hand (1.06:1) and found one tool defect: after `--steps "click:..."`, `--keyboard` started mid-page and reported 23 controls as unreachable by Tab. Fixed (the walk tabs around until focus leaves the page, which restores a fresh page's order, positive tabindex included) and guarded in `--selftest`; the guard fails when the fix is removed.
- Not run by the auditor: `--selftest`, the dark theme, other viewports, and the search and empty-state probes (the fixture has no search or data). One run, one model family, and the key was written by the Skill's author: read recall as the key's coverage, not as independent accuracy.

## Not recorded yet
- Required states per output (initial, loading, empty, error, partial, stale, no permission) and cost per run for A and B. Only B′ has a cost; the other runs were not timed.
- The repository-bound scenario ran once, in round 9 ([trial S4](./trial-s4.md)): both passed, A was preferred at low confidence. It has not been regenerated from the Skills changed because of it, and no second repo-bound request exists.
- S1 and S3 regenerated from the current Skills, and S3 judged again in both orders.

Limits: one model family generated and judged; three static scenarios and one repo-bound scenario; one generation per cell; B for S1 and S3 was made from an earlier Skill revision (setup above) and only S2 was regenerated (B′); four of six original judgements at low confidence; both S4 judgements at low confidence.
