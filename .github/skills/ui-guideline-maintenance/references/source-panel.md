# Source panel

Pick 4 to 6 sources per round that earlier rounds did not use (read the round log H.1 in `frontend/DESIGN_GUIDELINES_HISTORY.md` first). Mix types and always include one source likely to disagree with the guide.

## Slots
| Slot | Draw from | Extract |
| --- | --- | --- |
| Standard | WCAG 2.2 Understanding pages not yet cited (for example 3.3.1 Error Identification, 3.3.2 Labels or Instructions, 3.3.3 Error Suggestion, 3.3.7 Redundant Entry, 3.2.6 Consistent Help, 1.4.5 Images of Text); WAI-ARIA APG patterns (button, tabs, combobox, grid, disclosure, alert dialog, tooltip); COGA | requirement, conditions, exceptions |
| Research | CHI, UIST, DIS, ASSETS, TOCHI papers; arXiv HCI; meta-analyses | sample size, method, effect size, stated limits |
| Design system | Primer, Carbon, Material 3, Fluent 2, Atlassian, Shopify, GOV.UK, Apple HIG, KRDS (Korean government design system), Toss, Naver and Kakao design or writing docs | rule, rationale, stated exceptions |
| Practice | NN/g, Baymard, web.dev, Vercel guidelines, Anthropic skill-authoring best practices, VS Code and GitHub Copilot docs | tested claims, procedures |
| AI and design | benchmarks and studies on LLM UI generation, LLM judges, design-skill evaluations | failure modes, controls |
| Counter-view | a study or vendor rule that contradicts a rule in the guide | the disagreement and its scope |

Backlog of names to find and open in-round (no URL is trusted until fetched; rounds 0 to 9 already used Anthropic skill authoring, GOV.UK, Primer, Carbon buttons, tables and status indicators, Cloudscape delete, table view, empty states, refresh and timestamps, Atlassian inline edit, banner and messages, Apple alerts and entering data, WCAG Understanding pages for 2.1.4, 2.5.2, 2.4.1 and 2.4.2, APG menu, toolbar, grid, tabs and treegrid, PAIR errors and explainability, the HTML Standard's time element): Carbon notification patterns; Material 3 expressive guidance; Fluent 2 content design; NN/g on dashboards; W3C WAI forms and page-structure tutorials; Cloudscape card view, split view, filtering and density; APG combobox and listbox; Korean UX-writing guides (Naver, Kakao); 2026 papers on LLM UI generation and on human review of AI suggestions.

## Fetching
- Use `web_fetch` to read pages. Use `web_search` only to find URLs; it is rate limited. For paywalled papers read the abstract through Crossref or OpenAlex and label the source "abstract".
- Quote at most 15 consecutive words; paraphrase otherwise.
- Record URL, date, evidence type and verification level: full text, abstract or report.
- Claims from search snippets or sub-agent reports stay "report" until you have read the page. Never put a report-level claim into the guide as a general rule.

## Claim extraction (up to 10 claims per source)
| # | Source | Testable claim | Where in guide or skill | Class | Action |
| --- | --- | --- | --- | --- | --- |
Class: ADD (new, missing), REVISE (guide is wrong, vague or over-general), REMOVE (unsupported or obsolete), NOTE (already covered), CONFLICT (sources disagree: record both, decide with evidence grade, label house choice).

## Hygiene each round
- Re-open 3 earlier cited URLs at random and re-check the quoted numbers.
- Re-check time-sensitive claims: WCAG 3.0 status, design-token spec version, Core Web Vitals thresholds, Korea FTC guideline, Primer and Carbon page structure.
- Run the validator with `--links` once.
- Check every `§n` reference in edited text still points to the right section.
