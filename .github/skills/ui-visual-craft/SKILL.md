---
name: ui-visual-craft
description: "Use when the user wants a screen to look better, more polished, less generic or more consistent, or when choosing typography, colour, spacing, density, surfaces, icons or imagery. Applies a three-level hierarchy, role tokens, measured contrast and a uniformity checklist, then a polish pass. 키워드: 심미, 시각 디자인, 타이포그래피, 색상, 여백, 위계, 다크 모드, 세련되게, 디자인 다듬기, 획일적, 밀도, 고대비·forced-colors."
argument-hint: "[screen or component to polish]"
---

# UI visual craft

Aesthetics shapes first impressions and preference; it does not repair missing states, access or function, and its measured effect on performance is small and uneven (meta-analysis g=0.29). No look is called proven without a source, so density and theme stay user-selectable. Details: `frontend/DESIGN_GUIDELINES.md` §4 and §9.

## 1. Hierarchy
| Level | Holds | Made with (one or two means) |
| --- | --- | --- |
| 1 Primary | main action, key value, current state | size, weight, contrast, position |
| 2 Decision | information needed to judge, evidence | normal size, enough contrast, alignment |
| 3 Secondary | metadata, help, navigation | small size, lower emphasis (AA kept), folding |
- One emphasis per region. Using size, weight, colour, fill and border together erases the hierarchy.
- Navigation, borders and icons never outrank the work area. Bad: a bold title, three coloured chips, a filled primary and bordered cards competing. Good: one bold title, one filled primary, the rest apart by size and spacing.
- Conversion and content first screens: the headline is clearly the biggest thing (desktop 2.5 to 3.5rem, at least 1.5 times the next heading). Operations screens, the sign-in screen included, keep the product's compact heading scale.
- Squint test: what you see first must be the primary action. If not, the hierarchy is wrong.

## 2. Typography
- Use the product font token (this repo: `--font-ui`). At most 2 families, at most 5 sizes per screen. Sizes come from the token scale.
- Line height for Korean: body 1.5 to 1.7, headings 1.25 to 1.4, dense tables 1.4 to 1.5.
- Reading text gets `max-inline-size` (start near 42rem). Tables and comparisons do not.
- Korean body: `word-break: keep-all`, plus `overflow-wrap: anywhere` for long identifiers and URLs. Short headings: `text-wrap: balance`.
- Numbers in compared columns: `font-variant-numeric: tabular-nums` (check the font ships tabular figures), `YYYY-MM-DD` dates, thousands separators, the unit beside the value; absolute times carry a UTC offset and an event label (guide §8 G5).
- Never shrink text to fit. Stop at the minimum size, truncate with an ellipsis and keep the full value reachable by focus, tooltip or detail. Required information and action labels stay at 12px or more.

## 3. Colour
- Palette: neutral scale (surface, text, border), one accent, four status colours. Components use role tokens only; measure derived hover and tint colours again.
- Contrast: 4.5:1 normal text, 3:1 large text and UI parts. Do not round (4.499:1 fails). Measure both themes; measure text over images or gradients by hand.
- Status colours have fixed meaning. Red only for impossible, blocked or error. Never use status colours for categories or decoration. A status relies on at least two of colour, shape and symbol (Carbon) plus a text label by default: a different symbol per state with text and colour, not green and red text of one shape.
- The accent colour means "action" and nothing else. Do not reuse it for status chips, step markers or decoration.
- Charts: colour-vision-safe palette (Okabe and Ito: 8 categories at most) plus shape or direct labels; avoid red plus green. Tooltip values are reachable by keyboard; a period chart shows its date range with UTC offset and tells 0 from not queried (guide §4.4).
- Dark mode is its own token set, not inverted colours; layers get lighter step by step (Carbon).
- Default text and background come from the product tokens, a notch off pure `#000` and `#FFF`. A habitual tinted near-black (`#0B0B0B`, `#111`) is a listed generated-page default (Anthropic frontend-design): use the token or add one with a reason.
- Forced colors (Windows high contrast) drops shadows and fills: boundaries use `border`, focus `outline`, status text or a symbol; check with `--forced-colors` (guide §10.1).

## 4. Space, alignment, density
- Space comes from the scale only. Same relation, same value. Related things close, groups far. Lines and blocks are separated by elements and spacing tokens, never `<br>` or empty spacers.
- Same-role titles, values and actions share an axis. Numbers align to the end, strings to the start.
- Density is a token (comfortable, compact), not ad-hoc padding.
- Touch, kiosk or mobile work (target sizes, hit areas, `pointer: coarse`, `dvh`, safe areas): [ergonomics](./references/ergonomics.md). Copy-paste CSS and HTML and the plan template for the uniformity check: [snippets](./references/snippets.md).

## 5. Surfaces
- Structure is felt, not drawn. Borders and dividers appear only where information separates.
- The work area is flat. Shadow only on truly floating layers (popover, modal), at most 2 distinct shadows. Radius from a role scale, at most 3 values.
- Translucent or glass effects only on navigation or floating controls, never over content, and always with an opaque fallback.

## 6. Icons and imagery
- One icon set, one stroke weight, one size scale. The same icon always means the same thing.
- Few icons are universally understood (home, print, search). Add text to primary or rare actions. Icon-only controls need accessible names. No emoji as icons.
- Images only when they inform. Reserve their size to keep layout shift at or below 0.1.

## 7. Restraint and signature
- One memorable place; keep the rest quiet. In operations screens the signature is consistent status expression, numeric typography, density and calm tone, not decoration.
- Conversion and content screens need one signature element from the product's own vocabulary (for example the real workflow as a diagram), never one that implies proof you do not have. A sign-in screen says what signing in opens and adds no invented badges, customers or figures (guide §5.12).
- If the brief or system already fixes the look, follow it.

## 8. Uniformity check and polish pass
Before you finish, open [checks](./references/checks.md): eight yes/no questions that tell a chosen design from a generated default (another request would give the same layout? generic blue CTA or gradient? one radius and shadow everywhere?). Run them on the plan, then on the result; three or more yes answers mean change the structure, not the colours. Then do the four-step polish pass in the same file (alignment, one grammar for focus, selected, hover and disabled, both themes at 320 and 1440 px, finished empty and error states).
