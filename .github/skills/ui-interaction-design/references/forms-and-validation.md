# Forms and validation

Rules for form design and validation timing. Source: `frontend/DESIGN_GUIDELINES.md` §5.3.

## Labels and fields
- Labels always visible, top-aligned by default; placeholders only for format examples.
- Mark required or optional, one way per product (most required: mark optional; mostly optional: mark required).
- Correct `type`, `inputmode` and `autocomplete`; never block paste. Korean IME: do not submit or search on Enter while `isComposing`; run character counts, live search and as-you-type checks after `compositionend`. Do not build Korean particles (을/를, 이/가) by string concatenation; use phrasings that need none ("Delete 3 rules", "Target: A").
- Do not ask again for information already given in the same process: auto-fill or let the user choose (exceptions: essential, security, no longer valid).

## Validation timing (sources differ; this is a design choice)
- Default: validate on submit, all at once. GOV.UK says not to validate when the user leaves a field, nor before the user finishes typing, unless research shows it helps.
- Add blur-time checks for fields whose format is deterministic and only decidable when complete (for example dates), as KRDS does.
- Validate while typing only where continuous feedback is the point: ID uniqueness, password rules, character counts.
- Server results also appear inline at the failed field. Client rules stay a subset of the server rules and never replace them; follow the server verdict when they differ.
- Set `novalidate`: browser bubbles cannot be styled, placed or worded to match the product. State required fields in the label and with `aria-required="true"` (GOV.UK also omits `required` and still researches the screen-reader effect).

## Errors
- Keep the input and never clear a wrongly entered value. Place each message by its field, prefix the page title and each field message (visually hidden) with "Error:" ("오류:" in Korean). Identify the field and describe the problem in text, and suggest the fix when you know it, except where the suggestion would harm security (sign-in, below).
- Focus after a failed submit (sources differ; pick one per product): with an error summary above the form, move focus to the summary (GOV.UK); with inline messages only, move focus to the first field with an error after a click or Enter submit (KRDS).
- One sentence per error type (empty, too long, too short, disallowed characters, wrong format), in plain, positive words saying what happened and how to fix it. No generic "This field is required" or "An error occurred". Do not repeat a format example that is already on screen.
- Error text covers the problem, the cause, what to do and what happens if the user does nothing; leave out what does not apply (Atlassian). If the cause is unknown, never invent one: say something went wrong and offer a next step. Raw machine errors go in an expandable detail without resource IDs, tokens or stack traces, never as the main message (sign-in: never shown). Do not write that the team was notified unless automatic reporting exists (Cloudscape).
- Permission, eligibility or service-side problems get an explanatory region with the reason and next step, not a field error.

## Saving and submitting
- One save model per form (explicit save by default; never mix with autosave). One save button per page; never disable or hide it because the form is invalid or unchanged. Exceptions: an action blocked now by a prerequisite, a permission or a product-contract lock stays visible and disabled with its reason beside it; a very simple form where no field can be missed, such as a type-to-confirm delete (Cloudscape).
- Keep submit enabled until the request starts, then show progress and block double submit. The one exception is the typed-confirmation step of a serious destructive dialog (destructive-and-async item 9).
- Warn on leaving unsaved changes; filters, search and tab switches must not lose a draft.
- Settings screens: one save model (instant switches, or inputs plus a save button, never mixed); show current value and default with a reset that is reversible or confirmed; keep risky settings in their own area. Notification settings choose channel and frequency separately and say what turning one off will miss.
- Multi-step forms: each step is a history entry, so browser Back returns to the previous step with its values kept. A failed submit keeps the draft, so a reload does not lose input. Demo or failure-injection controls sit in a thin strip or a collapsible area (a sixth of the viewport height at most) and never outrank the product flow.

## Inline edit (Atlassian)
- Use it for often-edited, low-impact values outside a form, never inside one. Edits that need a reason, server re-validation or approval (Draft rule edits in this repo) keep the existing editor row or form; if no editor exists yet for such a change, build a small form or dialog with a reason field and Save and Cancel, and when the API replaces a whole object, read the current object first and send it back with its revision. Check that the read view and the edit view match in font and box size (Atlassian says so for custom headers), and give the field a visible cue that it is editable.
- Save and cancel controls sit at the end of the field; Enter saves and Esc cancels. Long text stays in edit mode on blur, so unfinished work is neither saved nor lost by accident. Never use `placeholder` as the label.
- Atlassian saves a value when focus leaves the field by default. For high-impact values use Save and Cancel instead (design choice).

## Sign-in and session
- Sign-in, password reset and recovery failures: one generic sentence whatever the cause (wrong ID or password, no such account, locked or disabled account), with the next action beside it (try again, reset, contact). OWASP says to respond this way on all three paths and leaves the usability cost to the service's criticality; WCAG 3.3.3 exempts suggestions that would jeopardize security. Never show raw server exception text.
- Identity-provider sign-in (popup or redirect): the provider shows credential errors. Failures the app reports itself (popup blocked, window closed, network) reveal nothing about an account, so name the cause and the next step, for example "allow pop-ups and try again" (design choice, inferred from the generic sentence's purpose).
- Do not block paste or password managers, and do not make memory or puzzle solving the only way in (3.3.8).
- A session that can expire warns before it ends and offers to extend it (2.2.1). After re-authentication the user's input is still there; WCAG 2.2.5 requires this only at AAA, but work screens make it the default (design choice).
- This repo (2026-11-10): a 401 becomes `AuthRequiredError`, `App.tsx` calls `setUser(null)`, and the sign-in section replaces the page tree, so form state is lost; `reviewDirty` resets only on manual sign-out. MSAL renews silently (`loginPopup`, session storage), so the UI never knows an expiry time: warn at the first failed renewal, keep the pages mounted behind a blocking dialog with one action, and after `loginPopup` retry only the failed request (a PUT may conflict on `expected_revision`).
