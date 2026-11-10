# AI features and generated UI

Source: `frontend/DESIGN_GUIDELINES.md` §7.

- Mark AI output. States: generated, needs evidence, verified (scope and time), approved (who, when), executed (result, recovery). Generated text is never a permission or validation result.
- Show source, observation time and scope; never invent sources, probabilities or confidence.
- Important changes show target, before and after, impact; the user edits or rejects. Regenerate must not overwrite the draft under review.
- Failure is stated; a kept previous result must not look new. Personalisation is disclosed and can be switched off.
- Never move core navigation or the primary action while the user works. Limit generated UI to validated components and input schemas.
- Explanations and confidence scores did not improve human-AI performance in a meta-analysis, so test whether reviewers actually catch wrong suggestions: plant one wrong suggestion in the fixtures and record whether the reviewer finds it (guide §7.1). Do not judge quality by dwell time or conversion alone; measure task accuracy, error discovery and recovery.
- PAIR: show confidence only if it helps (it is not always actionable). A suggestion can be technically right yet wrong for the user's assumptions (a context error), so show the assumption (scope, period, evidence) beside the result.
- Match review strength to risk. PAIR counts a novice reviewer, low system confidence, reduced attention (time pressure) and a narrow definition of success as higher risk; treating a hard-to-reverse change the same way is this guide's choice. Raise the confirmation tier (guide §5.4 item 8).
- A small "can make mistakes" label is not enough: NN/g notes that such a chat warning scrolls away and that confident output is often not read to the end (an analysis, not a label test). For important suggestions make compare-before-apply mandatory with no skip path. Confirm multi-item suggestions one item at a time (design choice); NN/g notes that part-by-part work suits experts who know what the parts should be, so use it with reviewers who know firewall rules.

## Suggestion card (fill every field; an empty field is unimplemented)
| Field | Content |
| --- | --- |
| State | generated, needs evidence, verified (scope, time), approved (who, when) or executed (result, recovery point) |
| Target | policy, collection and rule, in the product's labels |
| Before and after | rule diff in the compare view; Apply stays disabled, with its reason, until the diff was opened |
| Assumptions | scope, period and evidence the suggestion used |
| Checks | server validation result, shown apart from the generated text |
| Actions | Edit, Reject, Apply to Draft (`/draft-edits`), one suggestion at a time; no "apply all" |

Repo facts (2026-11-09 search): the request record has `ai_review` (`types.ts`, `contracts.py`) and `review_agent.py` returns advisory-only explanations, but no route or screen offers rule suggestions. Run the route check (workflow step 0 item 5): stop at the interaction spec, or use labelled fixtures.
