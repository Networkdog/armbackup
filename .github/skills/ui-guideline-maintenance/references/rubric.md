# Evaluation rubric for the guide and the skill set

Score each dimension 1–5 using the anchors. Give a one-line evidence note per score (file/section or trial artifact). Target: mean ≥ 4.5, no dimension < 4.

| # | Dimension | 1 (poor) | 3 (adequate) | 5 (excellent) |
| --- | --- | --- | --- | --- |
| D1 | Evidence integrity | Claims unsourced or overstated; myths repeated | Most claims sourced; some vendor opinion read as evidence | Every non-trivial claim traceable to a primary source with date and grade; myths corrected; limits stated |
| D2 | Coverage | Misses whole areas (concept, interaction, visual, brevity, review, a11y, i18n, AI features) | All areas present, some shallow | All areas present with procedures, thresholds and examples; covers data-dense and marketing contexts |
| D3 | Operability for Copilot | Descriptions vague; steps ambiguous; tools assumed | Triggers mostly work; some steps need guessing | Descriptions trigger on English and Korean phrasing; each step has an input, an action and an exit criterion; tool use realistic |
| D4 | Signal density | Verbose, repeated, buried rules | Some redundancy | Layered (summary, procedure, reference); no duplicated rules; skills within size budget |
| D5 | Consistency | Numbers, terms or labels conflict across files | Minor drift | One vocabulary and one set of constants; validator clean |
| D6 | Actionability | Principles only | Checklists without thresholds or examples | Templates, thresholds labelled by evidence grade, good/bad examples, copy-paste snippets |
| D7 | Verifiability | No way to check output | Manual checklist only | Rubric, deterministic checks, render-and-inspect loop, loop caps and stop criteria |
| D8 | Currency | Outdated or undated sources | Mixed ages, some dated | 2024–2026 sources where they exist, dated, with an update protocol and evaluation log |
| D9 | Aesthetic specificity | Generic advice ("use whitespace") | Some concrete rules | Concrete craft rules (type, colour, space, surfaces, motion), named anti-patterns, and a way to test distinctiveness |
| D10 | Safety, accessibility, ethics | Ignored or checkbox-level | Standards cited, partially applied | Standards applied with exceptions understood; dark patterns, privacy and AI transparency covered; no false assurance |

## Scoring notes
- Score the artifact as it exists, not as intended. An uncited number scores D1 down even if it is right.
- D3 and D7 need evidence from a trial or a dry run, not only reading.
- Do not average away a failure: a safety or accessibility error caps D10 at 2 until fixed.
