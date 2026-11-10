# Tool limits and false alarms

Flags measure a proxy. The cases below came from real pages (gov.uk, primer.style, linear.app, wikipedia.org) and a blind trial. Most have a guard in `--selftest`, so a regression fails the self-test. The strict-CSP, animation-wait, screenshot-position and `--scope` cases cannot be reproduced by the file fixture; they were checked by re-running gov.uk, linear.app (three identical runs) and wikipedia.org. The off-screen, current-page and plural cases came from cloudscape.design at 390 px.

## Handled, so do not report them as page defects
- Text a sighted user cannot see is not a visible label and is not measured: visually hidden child spans (`govuk-visually-hidden`, `sr-only`), `text-indent: -5000px` image replacement, text moved off the page or clipped by its own overflow.
- `aria-labelledby` pointing at a `display:none` element (design-system tooltips) still names the control.
- Links that differ only by a trailing slash are one destination. Repeated link text is reported once per group, with the number of different destinations.
- aria-hidden content skips name and size checks. A focusable control inside it is flagged (`A11Y-ARIA-HIDDEN-FOCUSABLE`). Text contrast and tiny text inside it drop to info: decoration and text that is part of a picture are exempt, but sighted users may still read it.
- A combobox or spin button shows its value, which is not its label, so there is no label-in-name check for it.
- Visually hidden skip links are not undersized targets. A copyright sign is not an emoji icon.
- Names built from CSS counters or quoted `::before` text are noted (`A11Y-NAME-FROM-CSS-CONTENT`), not reported as missing.
- Text over an earlier `img`, `video` or `canvas` is reported as unverifiable instead of being measured against the page background.
- Pages with a strict Content-Security-Policy work (no injected `<style>`).
- A stretched link (a `::before` or `::after` that covers its card) is sized by the card it makes clickable. The tool otherwise measures the element's own box.
- A click or key step leaves the browser's focus starting point on the control it used, so a keyboard walk after `--steps` would start mid-page. The tool tabs around until focus leaves the page first, which restores a fresh page's order (positive tabindex first).
- `--keyboard` walks forward and backward (Shift+Tab); a sticky header that only covers focus when moving backwards is flagged. With `--scope`, page-level rules (h1) and tab stops outside the scope are skipped.
- The screenshot is taken at the top of the page after the keyboard walk, so it shows the first screen.
- The tool waits up to 3 s for finite animations before measuring; infinite animations are ignored.
- A control that takes focus entirely outside the viewport (closed drawer, off-canvas menu) is reported once as `A11Y-FOCUS-OFFSCREEN` with the list of stops, not as one "covered" flag per link. A page can have dozens of such links behind one root cause: look at the first and hide the container.
- A control with `aria-current` (the current-page crumb) is not reported as disabled without a reason. Link names that differ only by a trailing "s" ("card", "cards") are one name.
- A link counts as inside a sentence (the 2.5.8 inline exception) only when text with letters or digits sits directly beside it. Links between `|` or `·` separators are a list and are measured.

## Still yours to check
- `--theme dark` only emulates `prefers-color-scheme`. A page with its own theme switch can ignore it; the run then reports `THEME-NO-CHANGE` (info). Set the switch with `--init-script <file>` (runs before the page's scripts, for example `localStorage.setItem('azfw-theme','dark')`) or restore a login with `--storage-state <json>`.
- `--steps` repeats UI actions only and gives each 5 s; a selector that matches nothing stops the run with `Step n '...' failed`. Server-driven states (loading, error, stale, no permission) need Playwright `page.route` mocks in your own script.
- `--keyboard` stops after `--max-tab` Tab presses (default 200) and says so under Tab order; controls after that are not checked for reachability. Raise the limit on long pages.
- Accessible names are approximated, focus indicators are inferred from style change, and only one state is seen at a time.
- `--forced-colors` emulates the Windows high-contrast palette (verified: colours are replaced, shadows and gradients dropped). Focus is then judged by outline style and width, border width and underline only, because focus recolours outline and border even when nothing is painted. The flag cannot tell whether a status survives without its background colour: look at the forced-colors screenshot.
- Scroll-triggered fades below the fold may be mid-animation: scroll through the page first, or run with `--reduced-motion`.
- Marketing pages that mock the product in live DOM inflate the counts. Details caps each rule at `--detail-limit` (default 10) and names the commonest colour pairs; decide once whether the mock-up counts as a picture.
- Same link text with different targets, tiny adjacent targets and sticky bars that cover focus are real findings even when the site chose them. `href="#"` is a finding only if a click does not navigate (a "top of page" link is fine).
- A focus-obscured flag only says another element covers the centre of the control. WCAG 2.4.11 (AA) fails only when the control is entirely hidden; a partly covered control passes AA and fails only the AAA criterion 2.4.12. Look at the screenshot before rating it P1.
- Visually hidden and composite controls (date inputs, media controls) appear as "not in inventory" tab stops; check them by hand.
- The report's "First screen" column counts flagged elements above the fold; weigh those first (P1 is for the first screen and the main task).
- The tool never judges position, need, wording or colour role.
- Outputs (`--out`, `--md`, screenshots) hold the page's text, values and names, possibly personal data. Keep them out of commits and issues, mask what you share, and delete them after the audit. A `--storage-state` file holds cookies and tokens, so it is a credential: keep it outside the repo and delete it when done.
