# Behaviour probes

The inventory reads structure and computed styles. It does not know what a control does, whether search finds what is visible, or whether an empty state agrees with itself. Blind trials found three defects of exactly this kind and no flag showed them. Run these probes on every audit and record them in the sheet's probe table.

1. **Outcome probe (G3, G5).** Press each primary action once, at most 5, and write what actually happens: navigation, dialog, mail draft, copy, request, or nothing. A label that promises more than the outcome is P1. Example: a "Request access" button that only opens a mail draft with no recipient.
2. **Search probe (G1, G3).** Take 5 values that are visible in the table, derived ones included (translated addresses, aliases, names shown in tags), and search each one. Zero results for a visible value is P1.
3. **Empty-state probe (G5, G8).** Force the empty state (filter to nothing, or no data). Message, counts and chips must agree: no "0 items" beside a filled list, no chip that contradicts the heading.
4. **Click probe (G3).** Click each non-link element that looks interactive (cards, badges, hover-styled cells, arrows). Nothing happening is an orphan; record it as P2, or P1 if it hides a needed action.
5. **Squint probe (G2).** Blur the 1440 px screenshot (`filter: blur(6px)`) and name what stands out first. It must be the main task. If not, the hierarchy is wrong.

State which probe produced which finding. A probe you could not run goes under "unchecked items".
