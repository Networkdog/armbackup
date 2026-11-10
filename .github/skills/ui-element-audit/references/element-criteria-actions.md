# Element criteria: actions and input (C09 to C16)

Extra checks for actions and form controls, on top of the eight gates. Source: `frontend/DESIGN_GUIDELINES.md` §8.4. Where this file and the guide differ, the guide wins; where the guide and `frontend/DESIGN.md` differ, the product contract wins. Other groups: [structure and navigation](./element-criteria-structure.md), [data and content](./element-criteria-data.md), [layers, state and work](./element-criteria-layers.md).

Columns: Place · Semantics and markup · Copy · Colour · Red flags (duplicate or risk signals).

| ID | Element | Place | Semantics | Copy | Colour | Red flags |
| --- | --- | --- | --- | --- | --- | --- |
| C09 | Button, link, icon button | beside the affected target; primary action at the end of the flow (one product rule); destructive set apart | action `button`, navigation `a[href]`, name required | verb plus object; same action same name; the label says what the result is | only 1 `action.primary`, used for actions and nothing else; `danger` for destructive; equal choices (accept and reject) share one style | two buttons with one result; link-looking button; same name different result; label and outcome differ (a "request" button that only opens an empty mail draft); the action colour reused for status chips or decoration; a decorative arrow or circle that looks clickable but sits outside the link |
| C10 | Text, number input | label above (or left), help and error right below | `label for`; correct `type`, `autocomplete`, `inputmode` | noun label, example as placeholder | boundary 3:1; error: `danger` plus text | label, placeholder and tooltip say the same sentence |
| C11 | Checkbox, radio, switch | group in `fieldset` and `legend`; label beside control | native `input`; switch only for instant apply | positive option names | selected: `action`; disabled distinguishable | switch that needs saving; label area not clickable |
| C12 | Select, combobox | field position; search for large sets | native `select` for small fixed sets | noun items; default stated | neutral | only "Select..." item; long items clipped |
| C13 | Date, time, range | start before end; format example | format, time zone, inclusivity stated; typing allowed | `YYYY-MM-DD`, time zone (UTC offset), a label that names the event (§8) | neutral | unclear format; locale mismatch; absolute time without a time zone |
| C14 | Slider, stepper | beside the value display | keyboard, non-drag alternative, direct entry | unit shown | active range only `action` | drag is the only way |
| C15 | Upload, drop | file button always present | `button` plus `input[type=file]` | allowed types, size, failure reason | dashed drop boundary | drop-only; no failure reason |
| C16 | Form, field group, validation | related fields close; error summary above the form | `fieldset`, `legend`; errors linked by `aria-describedby` | cause plus fix | `danger` plus icon plus text | same error as toast, banner and field |
