# Audit fixture: answer key

Scores an audit of [audit-fixture.html](./audit-fixture.html); it does not teach the tool. Recall: defect rows found with the right gate, verdict and severity. A finding the key does not list is checked by hand: a real one counts as found and belongs in this key, a fixture artifact is neutral, anything else is a false alarm, and every decoy reported as a defect counts against precision. A tool flag is a hint, so a defect can have none. Identify elements by selector or visible text; ids shift when the fixture changes. Gates, verdicts and severities are those of `SKILL.md`.

## Defects
| Element | Gate | Verdict | Severity | Tool flag |
| --- | --- | --- | --- | --- |
| icon-only circle button in `main`, no accessible name | G3 | Fix | P1 | A11Y-NO-NAME |
| `button[aria-label="Submit"]` showing "저장" | G3 | Fix | P1 | A11Y-LABEL-IN-NAME |
| `a > button` "중첩된 상호작용" | G3 | Fix | P1 | A11Y-NESTED-INTERACTIVE |
| `p.muted`, #9a9a9a on #ffffff, 2.81:1 | G6 | Recolor | P1 | COLOR-TEXT-CONTRAST |
| `button.tiny` "이전" and "다음", 16 by 16 px and adjacent | G7 | Fix | P1 | SIZE-TARGET-24 |
| nav "자세히" twice, to `/a` and `/b` | G4 DUP3, G5 | Reword | P1 | DUP-SAME-NAME-DIFF-TARGET, COPY-GENERIC-LINK |
| controls that sit under the fixed bar when focused: the footer controls, and on the first screen "보이지 않는 단추" and "카드 전체 링크" (the bar covers 836 to 900 px at 1440x900); Tab to them and look | G8 | Fix | P1 on the first screen or for a main-task control; P2 below the first screen | A11Y-FOCUS-OBSCURED |
| "이미지 위의 흰 글자": #f7f8f8 on white (the placeholder image is transparent), about 1.1:1 | G6 | Recolor | P2 (below the first screen) | COLOR-CONTRAST-UNVERIFIABLE; measure by hand |
| nav "보고서" and "리포트", same destination | G4 DUP4 | Align | P2 | DUP-SAME-TARGET-DIFF-NAME |
| three buttons showing "저장": two in `main`, one in the footer | G4 DUP1, G2 | Merge | P2 | none |
| `div[role=button]` "div 버튼" | G3 | Fix | P2 | A11Y-NONNATIVE-CONTROL |
| `a[href="#"][role=button]` | G3 | Fix | P2 | A11Y-NONNATIVE-CONTROL |
| `input[placeholder="이메일"]` with no label | G3 | Fix | P2 | A11Y-PLACEHOLDER-LABEL |
| `button[tabindex="3"]` | G8 | Fix | P2 | A11Y-TABINDEX-POSITIVE |
| `h3` straight after `h1` | G3 | Fix | P2 | A11Y-HEADING-SKIP |
| `span.truncate`, clipped with no full value | G5 or G7 | Fix | P2 | COPY-TRUNCATED-NO-FALLBACK |
| focusable button inside `div[aria-hidden]` | G8 | Fix | P1 or P2 | A11Y-ARIA-HIDDEN-FOCUSABLE |
| `button[disabled]` "비활성" with no reason | G8 | Fix or Decide | P2 | DISABLED-NO-REASON |
| "🚀 시작하기" | G5 | Reword | P3 | COPY-EMOJI-ICON |
| `button.fade`, `transition: all` | G8 | Fix | P3 | MOTION-TRANSITION-ALL |
| skip link `a.sr-only[href="#main"]`: no element has `id="main"`, and it is the 24th Tab stop | G8 | Fix | P1 | none |
| `a[href="#"]` "목차로": there is no table of contents; it scrolls to the top like "맨 위로" | G5 | Reword or Merge | P1 | none; A11Y-NONNATIVE-CONTROL also fires on the legitimate "맨 위로", which is a false alarm |
| visually hidden density radios: no visible focus or selection cue | G8 | Fix | P1 or P2 | A11Y-HIDDEN-FOCUS-TARGET (info) |
| theme controls: "어두운 화면으로 전환" button and the "테마" combobox | G4 DUP1 | Merge | P2 | none |
| search icon buttons "검색 열기" and "찾기" side by side | G4 DUP1 | Merge | P2 | none |
| links in two colours: nav #0b57d0, the others #0000ee | G6 | Align | P2 | none |
| `label` "이름" wrapping `input[placeholder="이름"]`: label and placeholder say the same | G4 DUP7, G5 | Reword | P3 | COPY-PLACEHOLDER-REPEATS-LABEL (info) |
| `a.cite[href="#n1"]`: no text, its name is the CSS content "가", and no element has `id="n1"` | G3, G8 | Fix | P2 | A11Y-NAME-FROM-CSS-CONTENT (info) |
| closed drawer link `nav.drawer a` "서랍 항목" (`position: fixed; left: -400px`): still in the Tab order, so focus lands outside the viewport | G8 | Fix | P1 or P2 | A11Y-FOCUS-OFFSCREEN |

## Decoys (not defects)
- `div[role=treeitem][aria-level=1]` "트리 항목": a tree level, not a heading. It must not count as a second h1.
- "삭제" in each table row: a collection repeat (DUP9). Adding the target to the accessible name is an optional P3.
- "보고서" in the nav and the footer: two identical copies are allowed (DUP10). "가이드" at `/guide` and `/guide/` is one destination.
- Visually hidden text (`sr-only` child, `text-indent` label): not visible text, so it is neither measured nor a label mismatch.
- `button[aria-label="저장하기"]` showing "저장": the name contains the label. "© 저작권 안내": not an emoji icon.
- The two radio groups: one Tab stop each, arrows move inside. The fieldset radios show their control; the density radios do not (see defects).
- "현재 위치" (`aria-current="page"`, `aria-disabled`): the current page is not an action, so a missing reason for being disabled is no defect. "card" and "cards" to `/cards`: one name in two forms, not two names.
- "이용 약관" inside a sentence: the inline exception of WCAG 2.5.8, so it has no size flag. "이전 글" and "다음 글" around a "|" are a list, not a sentence: the tool measures them and reports `SIZE-TARGET-24` as info (spacing exception), which is no defect.

## Fixture artifacts (count neither way)
The page has no script and no form: buttons do nothing, no search or empty state can be built, and some names describe their own defect ("div 버튼", "양수 탭 순서"). Findings that only restate this (no-op buttons, production-memo copy, missing states) are neutral.
