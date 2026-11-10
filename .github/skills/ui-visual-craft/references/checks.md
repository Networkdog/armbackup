# Uniformity check and polish pass

Source: `frontend/DESIGN_GUIDELINES.md` §4.9 and §4.10. Run the check on the plan, then on the result; do the polish pass last.

## Uniformity check: choice or default?
Defaults are fine when the brief asks for them. Check each:
1. Would another request on the same topic give the same layout (big title, three cards, bottom CTA)?
2. Generic blue CTA or purple-blue gradient without reason?
3. Every surface with the same radius and the same faint shadow?
4. The same decoration on every element of one level (uppercase eyebrow, dot-separated meta, arrow after links)?
5. Number markers (01, 02, 03) on content that has no real sequence?
6. Big number plus tiny label plus gradient with no content behind it?
7. Entry animations on every section instead of answering user actions?
8. With the product name and logo hidden, can you point to no element from this product's own vocabulary (terms, status expression)? Only colour or font tokens counts as yes. A context-free second reviewer (person or agent) makes this more reliable; report the result.

If three or more are yes, change the structure, not the colours. Run it on the plan, then on the result.

## Polish pass
1. Start and end alignment per column; icons centred with text; repeated elements share size, spacing and radius.
2. Focus ring, selected, hover and disabled use one grammar in every component.
3. Look at light and dark side by side and measure each; try 320px and 1440px, 200% zoom, long Korean, English and numeric values.
4. Loading, empty and error states look as finished as the normal state.
