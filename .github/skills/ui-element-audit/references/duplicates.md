# Duplicate types (G4)

Duplication is the burden of deciding whether two things are the same or which one to use. Source: `frontend/DESIGN_GUIDELINES.md` §8.5.

| Type | Example | Decision |
| --- | --- | --- |
| DUP1 Function | two "Save" buttons, same result | merge if same moment; one save button per page |
| DUP2 Information | header badge and body sentence give the same status; the same fact in the headline, lead, flow diagram and card | keep if summary versus detail; else delete one |
| DUP3 Homonym | same name, different result ("Delete" row or all) | most dangerous; put the target in the name |
| DUP4 Synonym | "report" and "리포트" for one function; one set called "dependencies", "inhabited territories" and "territory" across title, caption and lead | unify in a glossary; check headings, captions, lead text and link text for near-synonyms, not only equal strings |
| DUP5 Feedback | toast plus banner plus field error plus modal | one channel per event |
| DUP6 Structure | title, h1, last crumb, selected tab, card title all equal | reduce when three or more |
| DUP7 Guidance | label equals placeholder equals tooltip equals help | one label; help says something else; no on-screen format example repeated in the error |
| DUP8 Encoding | colour plus icon plus text for one status | allowed on purpose |
| DUP9 Collection | same "Delete" in each table row | normal; put the target in the accessible name |
| DUP10 Link block | menu, body and footer carry the same link set | two copies at most, with identical labels and members; align any copy that differs |

Order of decision
1. Same result, moment and target? Merge.
2. Different moment, target or region (top and bottom of a long page, row versus bulk, main versus footer)? Keep, with the same name (or the same noun with a context verb) and destination; the place differs by definition.
3. Deliberate for access or recovery? Keep and record why.
4. Same name, different result? Rename.

Also count repeated disclaimers ("no figures shown" in three places) as DUP2. Rate a repeated pattern once: one finding with the count and IDs, not one per copy.
