# Trial protocol: with versus without the skills

Question: does following `ui-design-workflow` (and the skills it routes to) improve generated UI over the bare request? The pass criteria are in `frontend/DESIGN_GUIDELINES.md` §11.4. Samples are small, so treat results as defect discovery, not proof. Re-run when the model changes.

## Scenarios (fixed; keep wording identical across conditions)
1. **Operations table:** a Korean rule-review screen with a table of 30 rows, search and filter, row actions, bulk approve and reject, and every data state.
2. **Conversion page:** a one-product landing page with a single offer, proof, call to action and a way to decline. No invented figures or testimonials.
3. **Multi-step form:** a 3-step request form with validation, save and a review step, in Korean, with error recovery.
4. **Repo-bound change (when feasible):** in a throwaway copy of the repository (link `frontend/node_modules`, do not copy it), fix a data screen whose no-result or error state lacks the applied condition or a recovery path; the saved request is S4. Extra checks: shared components and tokens reused, no new component or route, no new raw hex or off-scale px, the applied condition shown, a reset that also works when the parent owns the query, focus handled after the reset, `npm.cmd run build --prefix frontend` passes. Judge the diff and the build, not a rendered page.
Each request is one paragraph, written once and saved in [trial requests](./trial-requests.md) before the first run. Content is realistic Korean; data is supplied in the request.

## Conditions
- **A (bare):** the request only.
- **B (skills):** the request plus "Read and follow `.github/skills/ui-design-workflow/SKILL.md` and the skills it routes to."
Run each cell 2 times if budget allows. Use the same model and settings for all. Skills act as additions to a model, so repeat the trial with one smaller and one larger model tier when the team uses both; a skill that only works on the strongest model is fragile.

## Isolation
- Work in a temporary folder outside the repository; the output is a single static HTML file with CSS (and optional JS), or a minimal Vite project.
- A must not read `.github/skills` or the design guide. Say so in the prompt and check the transcript for reads of those paths. B may read only the skills and the guide.
- Keep generated artifacts out of the repository. Before deleting the temporary folder, copy each judgement (ratings, P0/P1 list, a reason of at most 40 words) and each artifact's SHA-256 into [trial log](./trial-log.md), and record which Skill files changed between generation and the end of the round.
- After any Skill or guide change made because of a judge remark, regenerate B for that scenario from the current Skills and re-judge it with swapped order.
- **Staleness:** a result describes the Skills as they were when the output was generated. Record the Skill and guide hashes at generation. After any change to a Skill the run read, label the result stale in the log and do not cite it as current evidence until it is regenerated.

## Deterministic metrics (run the same way on every output)
- `element-inventory.mjs --url <file> --keyboard --summary-only`: errors, warnings, element count, census (font sizes, weights, colours, radii, shadows).
- axe-core violation count when available from `frontend/node_modules`.
- Required states present (initial, loading, empty, error, partial, stale, no permission) by injection or inspection.
- Cost: tokens or time used per run (the skills should not make output heavier than the value they add).

## Blind judgement
- Render each output to a screenshot at 1440 px (and 390 px).
- A judge that does not know the condition scores R1 to R8 of the screen rubric (`.github/skills/ui-design-review/references/screen-rubric.md`) for each output and states a preference per scenario.
- Randomise the order. Judge twice with positions swapped to reduce position bias. Use a different model from the generator when possible.

## Pass criteria
Declare pass or fail against each line; do not average a failure away.
- Deterministic metrics: B is no worse than A in every scenario and better in at least two. Count font sizes, weights, text colours, surface radii, surface shadows, elements and Tab stops.
- Blind judgement: B preferred in at least two of the three static scenarios; the repo-bound scenario, when run, passes its extra checks.
- No scenario where B introduces a P0 or P1 that A lacks.

## Report
Table per scenario: metrics for A and B, judge scores and preference, cost. Then limitations (small N, one model, judge bias, scenario choice), failures kept in the log, and the changes made to skills or guide because of it. Append the summary to the history file `frontend/DESIGN_GUIDELINES_HISTORY.md` (H.3); never delete a failed trial.
