# UI change report template

Keep it short. Evidence is commands, numbers and screens, not the design rationale.

```
Scope: screen / state / viewport / theme / role

Decisions
- what was chosen and why (one line each); rejected alternative

Changes
- files and the behaviour that changed (or "visual only, behaviour unchanged")

Evidence
- command -> result (build, e2e spec, validator)
- inventory before -> after: errors, warnings, element count, font sizes, colours
- screens inspected: viewport, theme, states injected, keyboard path walked

Not verified
- what could not be run or checked, and why

Risks and follow-ups
- anything a reviewer should look at first
```

Rules
- "Passed" means only the checks listed under Evidence.
- Do not claim accessibility conformance, certification, performance targets met or real Azure verification unless you ran that check.
- A failed or skipped check stays in the report.
