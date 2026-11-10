# Destructive actions, async and concurrency

Source: `frontend/DESIGN_GUIDELINES.md` §5.4 and §5.5.

## Destructive actions
1. If reversible, prefer undo over a confirm dialog (a design choice; Vercel allows either confirmation or undo, NN/g asks for undo where possible).
2. If irreversible, the dialog names target, count, impact and "cannot be undone". Avoid a vague "Are you sure?".
3. Confirm button = a verb plus object ("Delete 3 rules" and "Keep"), not Yes or No; OK only in purely informational alerts (Apple HIG). Start focus on the least destructive choice: a focused web button runs on Enter and some actions are hard to reverse (design choice; Apple HIG makes Cancel never the default, this guide differs).
4. Danger colour is secondary; the words must carry the danger.
5. Bulk actions state scope (page, filter result, all) and count first.
6. Never hide cancel, unsubscribe or exit paths; no pre-selected options that favour the provider; no repeated nagging (Korean FTC dark-pattern guideline for e-commerce). No fake urgency (countdowns, scarcity) and no guilt-tripping refusal copy (design choice).
7. For legal commitments, financial transactions and changes or deletions of user data, at least one of these must hold (WCAG 3.3.4): reversible, input checked with a chance to correct, or review and confirmation before finalising.
8. After a confirmed delete the trigger often no longer exists (a deleted row). APG returns focus to the invoking element unless it no longer exists, then to another element that fits the workflow. Default (design choice): the next row's first control, else the previous row's, else the table heading; announce the result in a `role=status` region so focus is never lost to the page top.
9. Match the confirmation to the risk (Cloudscape). Easy to recreate and no effect on running systems: act at once, undo first. Hard to recreate but unlikely to break running systems: confirm in a modal. Serious, irreversible or cascading: also require typing a confirmation text, and the confirm button may stay disabled until it matches (the one disabled-submit exception). Criteria: severity, count, cost to recreate, prerequisites.
10. A checkbox selection covers only the rows visible on the current page; sorting, paging, display settings and rows leaving the view clear it. Filter-wide or all-rows actions are a separate explicit control ("select all N matching"), never a hidden selection. Exception: where the product contract saves the selection with a review approval (the expiry-cleanup review), it survives paging and filtering and its count stays visible (guide §5.4 item 9).
11. A bulk action shows a summary and a result. The header checkbox is `mixed` (`aria-checked="mixed"`) when only some rows are selected, and the selected count is announced in a `role=status` region. After the run, show each item's result (done or failed, with the reason) and retry only the failed ones. A request for "bulk" never removes a review step each item must pass (guide §5.4 item 10, §6.3).

## Async and concurrency
- Old responses must not overwrite newer search or selection results. Prevent double submit.
- Optimistic updates only for reversible, low-risk actions; on failure restore and say so.
- Distinguish cancelling the wait from cancelling server work; never show an unconfirmed server cancel as success.
- A network failure does not prove the server did not run. Design retry with duplicate-run risk and a way to check the result.
- Conflicts keep the user's draft and show a comparison with the latest value.
