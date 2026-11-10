---
name: ui-concept-design
description: "Use when starting a new screen or a redesign and the direction is not decided yet: writes a ten-line brief, explores two or three structurally different directions, chooses one with reasons and outputs a concept spec ready for implementation. Skip for small tweaks. 키워드: 컨셉 설계, 디자인 방향, 와이어프레임, 정보 구조, 화면 구성안, 시안 비교, 브리프, 재설계 방향."
argument-hint: "[screen purpose and users]"
---

# UI concept design

A concept is the direction of a screen: structure (information architecture and layout skeleton), interaction model (navigate, select, act) and visual tone and density. A colour variation is not a concept. Details: `frontend/DESIGN_GUIDELINES.md` §3.

## Steps
1. **Brief.** Use the brief template of `ui-design-workflow`. Guesses go under `Assumptions:`.
2. **Classify and ask the key question.**
| Screen type | Key question | Common failure |
| --- | --- | --- |
| Content | In what order is it read, where does the reader stop? | Decoration fights the text |
| Conversion | One-sentence offer, proof, action, refusal path? | Generic hero plus three cards, invented figures |
| Operations | What is compared at once, how fast is repetition, what does an error cost, how is it recovered? | Big KPI cards, hidden essentials, tables that cannot be compared |
3. **Principles.** 3 to 5 statements shaped "A over B". If nobody would argue for B, it is not a principle.
4. **Explore 2 or 3 directions with different structures.** One conventional (low risk), one bold. Fill a direction card for each.
5. **Choose.** Score 1 to 5 on task efficiency, error prevention, learning cost, consistency and reuse, accessibility, build cost, risk. Scores inform the discussion and do not decide it. Write two lines for the choice and one line per rejected option.
6. **Validate** (before any code):
   - Walk the top 3 tasks and count steps, eye movements and back-tracking. If a count grew versus the current design, justify it.
   - Name the 3 weakest elements and what is lost without them (gate G1).
   - Say the direction in one sentence. If you cannot, it is not a direction.
7. **Hand off** the concept spec below.

## Direction card
| Field | Content |
| --- | --- |
| Name, one sentence | |
| Skeleton | ASCII sketch or sentences of regions |
| Optimises | task that becomes fastest or safest |
| Gives up | task that becomes harder |
| Risk, assumption to check first | |

## Concept spec
1. Regions and hierarchy: where am I, key information, primary action, detail and evidence.
2. Layout skeleton per width and height; who owns each scroll.
3. Components: reuse, variant, new (one-line reason).
4. States: loading, empty, error, partial, stale, no permission (`ui-interaction-design`).
5. Tokens: reuse or extend (one-line reason).
6. Content: terms, voice, realistic Korean copy and data.
7. Open questions.

## Rules
- Reuse before invent. Look at the shell, tokens and two similar screens first.
- Operations screens default to productive motion and density; expressive treatment only for rare important moments (Carbon's productive versus expressive split).
- Conversion screens never invent numbers, testimonials or logos. Missing proof is a stated gap. A supplied fact that sets the product apart is shown with the product's own labels and states (copy them from the code), with any mock-up marked as an example; one line in a list does not show it (judges marked this partial in the B′ trial).
- Every call to action needs a real outcome. If the destination (URL, contact, form) is not given, ask, or label the action for what it really does (for example "Copy summary"). A button must not promise more than it does. Put the reason in the report, not on the page.
- Fewer options is not the goal. If many options are needed, name them distinctly and add search or filters.
- If the brief or the existing system already fixes the look, follow it. Freedom to choose is not a mandate to differ.
- Plan first (tokens, type, sketch), then ask whether the plan is a default that would appear on any screen. If yes, change the structure, not the colours.

## Common failures
Visuals before a brief; one direction only; copying a competitor; blank or invented data; reading "make it pretty" as permission to change behaviour, permissions or data flow.
