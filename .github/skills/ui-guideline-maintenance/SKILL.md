---
name: ui-guideline-maintenance
description: "Use when updating, auditing or re-evaluating frontend/DESIGN_GUIDELINES.md and the ui-* skills against new external sources, or when asked to run the design-guideline improvement loop. Covers source selection, evidence grading, gap analysis, with-vs-without-skill trials, validation and stop criteria. 키워드: 디자인 가이드 평가, 가이드 개선 반복, 근거 갱신, 외부 소스 검증, 스킬 품질 평가."
argument-hint: "[round focus, or sources to evaluate against]"
disable-model-invocation: true
---

# Design guideline maintenance loop

Keeps `frontend/DESIGN_GUIDELINES.md` and the `ui-*` skills accurate, lean and effective. One round = evaluate against fresh external sources, fix what the evaluation finds, validate. Repeat until the stop rule is met.

## Ground rules
- Every claim added must come from a primary page you fetched this round (standard, paper, official design-system page). No memory, no search snippets, no third-party summaries. Record URL, date and evidence type.
- Label what a source supports: standard, peer-reviewed, vendor guideline, editorial, or house choice. Never present a vendor opinion or a trend as evidence of effect.
- Quote at most 15 consecutive words from any source.
- Never delete failed trials, contradicting evidence or earlier scores. Append to the evaluation log.
- Size budgets: `SKILL.md` ≤ 150 lines; every `SKILL.md` and reference file ≤ 8,000 bytes as stored on disk; instruction file ≤ 45 lines; guide stays layered (one-page summary first). Adding content means removing or merging something.
- A rule is written once. Other places point to it with `§n`; a repeat has to add a condition or an example the original lacks. Split bullets that carry more than one rule.

## Round procedure
1. **Baseline.** Run the [validator](./scripts/validate-design-docs.mjs): `node .github/skills/ui-guideline-maintenance/scripts/validate-design-docs.mjs`. Read the evaluation log (`frontend/DESIGN_GUIDELINES_HISTORY.md`, H.1) to see which sources earlier rounds used.
2. **Source panel.** Pick 4–6 sources not used before, covering different types (see [source panel](./references/source-panel.md)). Include at least one source likely to disagree with the guide.
3. **Gap analysis.** For each source extract up to 10 testable claims. Compare each with the guide and skills and classify: ADD, REVISE, REMOVE, NOTE (already covered), or CONFLICT (sources disagree; record both and decide with evidence grade).
4. **Edit.** Apply ADD/REVISE/REMOVE to the guide and to the skill that operationalises it. Keep numbers identical in both. Mark house choices as design choices.
5. **Trial** (at least every second round). Run the with-vs-without-skill comparison in [trial protocol](./references/trial-protocol.md) and the description checks in [trigger queries](./references/trigger-queries.md) (results in [trigger results](./references/trigger-results.md)). Judge the generated screens blind with the screen rubric of `ui-design-review`. Keep judgements and artifact hashes in the [trial log](./references/trial-log.md) and [trial judgements](./references/trial-judgements.md); the request wording is fixed in [trial requests](./references/trial-requests.md); the repo-bound S4 run is in [trial S4](./references/trial-s4.md) and the S5 run in [trial S5](./references/trial-s5.md). Held-out routing queries are in [the held-out file](./references/trigger-queries-heldout.md).
6. **Score** the guide and the skill set with the [rubric](./references/rubric.md), using trial and dry-run evidence for D3 and D7.
7. **Validate.** Re-run the validator; add `--links` once per round to catch dead URLs. Fix every error. The [numbers ledger](./scripts/numbers-ledger.json) snapshots every number, pointer, id, citation key and rule id in the prose, and a digest of each Skill description: when it reports a change you made on purpose, read the diff, then run the validator once with `--update-ledger --reason "<why>"` (the reason is kept in the ledger). A changed description also needs the routing queries rerun first, because routing cannot be checked offline. After changing the validator, or a value it guards (its `FACTS` table), run the [mutation test](./scripts/mutation-test.mjs): with its built-in list (written with the validator, so in-sample), with `--mutants` and the [round-8 list](./scripts/mutants-independent.json), [round-9 list](./scripts/mutants-independent-r9.json) and [round-10 list](./scripts/mutants-independent-r10.json) (reviewers' lists that the validator was then extended from, so in-sample too), and with a fresh list that someone writes each round without opening the validator. Record every rate; only the fresh one is evidence, and none is a score to tune toward. Fix stale find strings. The ledger and the mutants are tripwires: the round-10 fresh list (435 harmful edits) caught 73.6%, and only 39% of edits that change meaning without changing a number or a guarded term. A PASS means no known drift, not no drift.
8. **Record.** Append a round entry to the history file `frontend/DESIGN_GUIDELINES_HISTORY.md` (H.1): date, sources, counts per class, rubric scores, trial result, main changes. Open problems stay in the guide's appendix A.
9. **Decide.** Apply the stop rule below.
10. **Schedule.** Write the next review date in the guide header: about 90 days out (design choice), or earlier when WCAG, the Agent Skills specification, Copilot's Skill loading or a cited design system changes. A guide past its date is stale: say so before relying on it.

## Stop rule
Stop only when all hold:
- Two consecutive rounds, each with a fresh source panel, yielded no substantive ADD, REVISE, REMOVE or CONFLICT (cosmetic and NOTE only).
- Rubric mean ≥ 4.5 and no dimension below 4.
- Validator reports PASS with no unresolved warnings you cannot justify.
- The latest trial meets its pass criteria.

Otherwise run another round. Cap at 5 rounds per session unless the user asks to continue until the stop rule holds; report what remains after every round.

## Output of a round
A short table (source, claim, class, action) followed by the log entry. Do not claim the guide is "complete"; report the evidence for stopping.
