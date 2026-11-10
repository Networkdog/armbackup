# Copy-paste starting points

Standard CSS and HTML only. Values are starting points (design choices), not conformance numbers. Replace `var(--...)` with the product's role tokens (this repo: `frontend/src/themes.css`, `frontend/src/styles.css`).

## CSS
```css
:root { color-scheme: light dark; }

/* Visible keyboard focus. 2px is a starting value, not an AA number. */
:focus-visible { outline: 2px solid var(--focus-color); outline-offset: 2px; }

/* A sticky header must not cover the focused element (WCAG 2.4.11). */
html { scroll-padding-top: var(--sticky-header-height); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}

/* Korean reading text. Do not apply to tables and comparison views. */
.prose { word-break: keep-all; overflow-wrap: anywhere; max-inline-size: 42rem; line-height: 1.6; }

/* Numbers in comparison columns. */
td.num, th.num { font-variant-numeric: tabular-nums; text-align: end; }

h1, h2 { text-wrap: balance; }

/* Grow the hit area, not the look. Check that neighbours do not overlap (guide 10.2). */
.icon-button { position: relative; }
.icon-button::after { content: ""; position: absolute; inset: -6px; }

.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
```

## Form with an error summary (HTML)
```html
<form novalidate>
  <div id="error-summary" role="alert" tabindex="-1" hidden>
    <h2>입력을 확인해 주세요</h2>
    <ul><li><a href="#email">이메일 형식이 아닙니다.</a></li></ul>
  </div>
  <label for="email">이메일 <span>(필수)</span></label>
  <input id="email" type="email" autocomplete="email" aria-required="true" aria-invalid="true" aria-describedby="email-error">
  <p id="email-error"><span class="visually-hidden">오류:</span> 이메일 형식이 아닙니다. 예: name@company.com</p>
  <button type="submit">신청서 제출</button>
</form>
<div id="status" role="status" aria-live="polite"></div>
```
After a failed submit set `document.title` to `오류: …`, move focus to `#error-summary` (or to the first invalid field when there is no summary; pick one rule per product), keep every entered value.

## Not here on purpose
Colour, spacing and radius values come from the product tokens. Never copy a hex value from an example.

## Choosing colour, in order (design choice; guide §4.4)
1. Product tokens exist: use only them; make a token before any new colour.
2. No tokens: pick one accent. Text on a filled accent button (white or black) needs 4.5:1; the accent as text or border needs 3:1 (controls, large text) to 4.5:1 (body text) against its background. Check both themes.
3. Neutrals: 3 surface steps, 3 text steps (default, secondary, disabled), 2 border steps. Secondary text still needs 4.5:1.
4. Four status colours with fixed meanings, in hues other than the accent.
5. Put both themes side by side; the same role must keep the same contrast level.

## Choice versus default (write before coding; design choice, guide §4.9)
```
Plan: <layout in one sentence> / <type: families, sizes> / <colour: accent, neutrals, all from tokens>
Default check: would a similar request give this plan? If yes, change the structure, not the colours.
Own vocabulary: <the product's real object this design draws from, for example rule, request, approval>
```
| Default | A choice drawn from the product |
| --- | --- |
| three feature cards under a big title | the real workflow as a short diagram that uses the product's own state names |
| a row of big numbers with tiny labels | one real sample row or screen, with no invented figures |
| uppercase eyebrow above every heading | none; the heading carries the meaning |
| `→` after every link | an arrow only where it means "next" in a sequence |
