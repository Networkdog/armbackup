# Trigger queries: round 9 and held-out set

Continues [trigger queries](./trigger-queries.md). Sets 1 to 4 were written by the skill designer, and set 4 repeats keywords of the descriptions it tests, so none of them is held-out evidence. Set 5 is: requests 52 to 56 come from an independent reviewer's dry runs, written without the descriptions in view, and 57 to 66 were written without looking at the descriptions' keywords. Expected results were fixed from each skill's purpose before any run. Same method and pass rule as the first file.

## Set 4b (round 9): written while tuning, so not held-out
| # | Query | Expected | Type |
| --- | --- | --- | --- |
| 44 | 표 헤더를 눌러서 정렬되게 해줘 | `ui-interaction-design` (with `ui-design-workflow`) | should trigger |
| 45 | 상태 배지 옆에 아이콘을 붙여서 색을 못 보는 사람도 구별되게 해줘 | `ui-visual-craft` | should trigger |
| 46 | 탭 화면에서 키보드로 탭 전환이 안 돼 | `ui-interaction-design` | should trigger |
| 47 | 마지막 갱신 시각을 '5분 전'처럼 보여줘 | `ui-interaction-design` (with `ui-design-workflow`) | should trigger |
| 48 | 빈 목록 화면 문구를 더 친절하게 바꿔줘 | `ui-interaction-design` | should trigger |
| 49 | 이 컴포넌트 렌더링이 느려서 useMemo로 최적화해줘 | none | near-miss |
| 50 | Playwright e2e 테스트가 간헐적으로 실패해. 원인을 찾아줘 | none | near-miss |
| 51 | 이 화면 CSS에서 쓰지 않는 규칙을 정리해줘 | none | near-miss |

## Set 5 (round 9): held-out
| # | Query | Expected | Type |
| --- | --- | --- | --- |
| 52 | 요청 목록 표에 체크박스로 여러 행을 골라 일괄 승인·반려하는 기능을 붙여줘 | `ui-design-workflow` (with `ui-interaction-design`) | should trigger |
| 53 | 변경·복구 화면의 탭 아래에 마지막 갱신 시각과 새로 고침 버튼을 넣어줘 | `ui-design-workflow` or `ui-interaction-design` | should trigger |
| 54 | 다크 모드에서 상태 배지 몇 개가 구별이 안 돼 | `ui-visual-craft` or `ui-element-audit` | should trigger |
| 55 | 신청서 상세 화면의 담당자 칸을 바로 수정할 수 있게 해줘 | `ui-design-workflow` or `ui-interaction-design` | should trigger |
| 56 | AI가 만든 방화벽 규칙 제안을 사용자가 검토하고 Draft에 반영하는 패널을 만들어줘 | `ui-design-workflow` (with `ui-interaction-design`) | should trigger |
| 57 | 신청서 화면 맨 위 문구가 너무 길고 설명조야. 뜻은 두고 한 줄로 줄여줘 | `ui-simplify` | should trigger |
| 58 | 같은 신청서를 여는 링크가 카드와 표 두 군데에 있는데 하나로 합쳐도 되는지 봐줘 | `ui-element-audit` or `ui-simplify` | should trigger |
| 59 | 설정 화면을 새로 만들 건데 저장 방식과 초기화 버튼 위치까지 같이 정해줘 | `ui-design-workflow` (with `ui-interaction-design`) | should trigger |
| 60 | 불러오는 동안 표가 깜빡이면서 내용이 사라져. 어떻게 보이는 게 맞아? | `ui-interaction-design` | should trigger |
| 61 | 이 PR의 프런트엔드 변경을 접근성 관점에서만 평가해줘 | `ui-design-review` or `ui-element-audit` | should trigger |
| 62 | 버튼 색을 브랜드 색으로 통일하게 토큰 값을 정리해줘 | `ui-visual-craft` | should trigger |
| 63 | npm audit이 알려 준 취약점을 고쳐줘 | none | near-miss |
| 64 | 백엔드 응답에 필드를 하나 더하고 프런트 타입을 맞춰줘 | none | near-miss |
| 65 | 이 마크다운 문서의 목차를 자동으로 만들어줘 | none | near-miss |
| 66 | 운영 화면의 첫 화면을 어떤 구성으로 할지 두 가지 안으로 비교해줘 | `ui-concept-design` | should trigger |

Query 65 is a near-miss for `ui-guideline-maintenance`, which loads only by hand.
