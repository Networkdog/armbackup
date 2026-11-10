# Trigger queries

Tests whether skill descriptions load the right skill. Method follows the Agent Skills guidance on optimizing descriptions: about 20 queries (8 to 10 should trigger, 8 to 10 should not, with near-misses), each run 3 times, trigger rate = fraction of runs that loaded the skill, pass when the rate is above 0.5 for should-trigger and below 0.5 for should-not. Tune descriptions only from train failures, then check the validation split. Do not paste query wording into descriptions.

How to run: fresh session with the skills installed (Copilot CLI: `/skills reload`, `/skills info <name>`); send the query; record which `SKILL.md` files were read. Log results in [trigger results](./trigger-results.md). Queries 44 and later are in [the held-out file](./trigger-queries-heldout.md).

| # | Query | Expected | Type | Split |
| --- | --- | --- | --- | --- |
| 1 | 신청서 검토 화면 위에 필터 칩이랑 일괄 승인 버튼 좀 달아줘. 지금 너무 밋밋함 | `ui-design-workflow` | should trigger | train |
| 2 | 대시보드가 너무 복잡해 ㅠㅠ 덜어내서 깔끔하게 정리해줘 | `ui-simplify` | should trigger | train |
| 3 | 설정 페이지 새로 만들려고 하는데 어떤 방향이 좋을지 시안 두세 개 비교해줘 | `ui-concept-design` | should trigger | train |
| 4 | 페이지가 다 비슷비슷한 템플릿처럼 보여. 타이포랑 색, 여백 좀 세련되게 다듬어줘 | `ui-visual-craft` | should trigger | validation |
| 5 | 삭제 확인 대화상자랑 실패했을 때 복구 흐름, 로딩과 빈 상태까지 설계해줘 | `ui-interaction-design` | should trigger | validation |
| 6 | 이 화면의 버튼·라벨·배지가 제자리에 있는지, 중복되는 건 없는지 요소별로 하나씩 점검해줘 | `ui-element-audit` | should trigger | train |
| 7 | 이 PR의 프런트엔드 UI 변경을 리뷰하고 점수 매겨서 출시해도 되는지 알려줘 | `ui-design-review` | should trigger | validation |
| 8 | Add loading, empty and error states to the rules table and make sure keyboard focus works | `ui-interaction-design` | should trigger | train |
| 9 | dark mode contrast looks broken in some badges, can you check and fix the colors? | `ui-visual-craft` or `ui-element-audit` | should trigger | validation |
| 10 | can you review this page's accessibility and consistency before we ship | `ui-design-review` | should trigger | validation |
| 11 | 백엔드에서 규칙 중복 제거 로직 버그 고쳐줘 | none | should not | train |
| 12 | pytest가 실패하는데 원인 좀 찾아줘 | none | should not | train |
| 13 | README에 로컬 실행 방법 추가해줘 | none | should not | validation |
| 14 | Azure Storage 큐 메시지 재시도 로직을 리팩터링해줘 | none | should not | validation |
| 15 | 프런트엔드 빌드가 TypeScript 타입 오류로 실패해. 고쳐줘 | none | near-miss | train |
| 16 | 이 React 컴포넌트에 단위 테스트를 작성해줘 | none | near-miss | validation |
| 17 | API 응답 JSON 스키마를 문서로 정리해줘 | none | near-miss | train |
| 18 | 랜딩 문구의 맞춤법과 띄어쓰기만 교정해줘 | none | near-miss | validation |
| 19 | UI 라이브러리를 최신 버전으로 업그레이드하고 breaking change만 고쳐줘 | none | near-miss | train |
| 20 | 디자인 가이드 문서를 새 자료로 재평가하고 개선 라운드를 돌려줘 | none (manual only: `/ui-guideline-maintenance`) | should not auto-load | validation |

Notes
- Queries 1, 7, 9 and 10 name the need without naming the skill's domain. Queries 4 and 8 are casual or mixed-language. Vary phrasing when adding queries.
- `ui-guideline-maintenance` sets `disable-model-invocation: true`, so query 20 must not load it automatically.
- Several skills can fit one query (for example 9). Count a pass if any listed skill loads and no unrelated skill does.

## Set 2 (round 4): written without reusing description words
| # | Query | Expected | Type |
| --- | --- | --- | --- |
| 21 | 폰으로 보면 버튼이 너무 작고 다닥다닥 붙어 있어서 자꾸 잘못 눌러요 | `ui-design-workflow` or `ui-visual-craft` | should trigger |
| 22 | 버튼을 두 번 눌러도 API가 한 번만 호출되게 재시도 횟수를 환경 변수로 빼줘 | none | near-miss |
| 23 | 폼에서 잘못 입력했을 때 에러가 어떻게 보여야 하는지 기준 좀 잡아줘 | `ui-interaction-design` | should trigger |
| 24 | vite 빌드가 너무 느려서 설정을 최적화하고 싶어 | none | should not |
| 25 | 관리자 첫 화면에 무엇을 먼저 보여줘야 할지 감이 안 와. 구성부터 같이 고민해줘 | `ui-concept-design` | should trigger |
| 26 | 차트 막대 안쪽 라벨이 서로 겹쳐. D3로 해결해줘 | none of ours (`dataviz-typography` belongs to another plugin) | near-miss |
| 27 | 같은 안내 문구가 화면 세 군데에 반복돼서 거슬려 | `ui-simplify` or `ui-element-audit` | should trigger |
| 28 | PR에 달린 리뷰 코멘트 내용을 반영해줘 | none of ours (`address-pr-comments`) | near-miss |
| 29 | 다크 모드로 바꾸면 글씨가 안 보이는 곳이 있어 | `ui-visual-craft` or `ui-element-audit` | should trigger |
| 30 | 이 함수에 JSDoc 주석을 달아줘 | none | should not |
| 31 | 이번 UI 변경 머지해도 되는지 한번 봐줘 | `ui-design-review` | should trigger |
| 32 | 새 브랜치에서 PR 만들어줘 | none of ours (`create-pull-request`) | near-miss |
| 33 | 요청 목록 화면을 하나 새로 추가해줘. 디자인도 신경 써서 | `ui-design-workflow` (with `ui-visual-craft`) | should trigger |
| 34 | i18n 키를 추출해서 번역 파일로 만들어줘 | none | near-miss |

## Set 3 (round 6): written after the description keywords changed, in words the descriptions do not use
| # | Query | Expected | Type |
| --- | --- | --- | --- |
| 35 | 비밀번호를 잘못 넣었을 때 뜨는 안내가 사용자한테 어떻게 보여야 하는지 점검해줘 | `ui-interaction-design` or `ui-element-audit` | should trigger |
| 36 | 규칙 목록에서 항목 하나를 지우는 기능을 붙여줘 | `ui-design-workflow` (with `ui-interaction-design`) | should trigger |
| 37 | 다크 테마로 열면 이 페이지가 어색해. 어두운 환경에서도 읽히게 해줘 | `ui-visual-craft` or `ui-design-workflow` | should trigger |
| 38 | 한참 두면 자동으로 로그아웃되는데 쓰던 내용이 날아가요. 어떻게 설계하는 게 좋아? | `ui-interaction-design` | should trigger |
| 39 | 로그인 API가 401을 돌려줘. 토큰 갱신 로직을 고쳐줘 | none | near-miss |
| 40 | 비활성 상태의 버튼이 왜 안 눌리는지 사용자한테 알려주고 싶어. 키보드로도 닿게 | `ui-interaction-design` | should trigger |

## Set 4 (round 8): behaviours the descriptions name only as keywords
| # | Query | Expected | Type |
| --- | --- | --- | --- |
| 41 | 표 셀을 바로 편집할 수 있게 해줘 | `ui-interaction-design` (with `ui-design-workflow`) | should trigger |
| 42 | 행마다 '더보기' 메뉴를 추가해줘 | `ui-interaction-design` (with `ui-design-workflow`) | should trigger |
| 43 | AI가 방화벽 규칙을 제안하는 패널을 추가해줘 | `ui-design-workflow` (with `ui-interaction-design`) | should trigger |

