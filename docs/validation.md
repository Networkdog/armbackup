# 구현 검증 결과

> 범위: 2026-10-31 로컬 구현의 실제 검증 기록과 고객 환경에서 남은 검증. Azure 운영 적용 완료 기록이 아니다.

**한 줄 요약** — 아래는 MSP·사설 Blob·달력·복합 LAB와 후속 App Service의 구분된 검증 기록이다. **KT 환경·예약 WebJob 실행·일반 운영 복구 인증은 아니다.**

## 후속 화면·저장 뷰·App Service 검증

### 2026-11-09 첫 접속의 "화면 모듈을 불러오지 못했습니다" — 프록시 구간의 간헐적 HTTP 500

- **증상:** 배포 직후 로그인하면 `Failed to fetch dynamically imported module: …/live-app.mjs` 모달이 뜨고 화면이 비어 있다. 자동 새로고침 1회로도 자주 반복된다.
- **직접 확인(로그인한 Edge + CDP):** `live-app.mjs` 자체는 200이지만 그 하위 모듈(`backup-calendar.mjs`, `change-calendar.mjs` 등) 중 **무작위 1개**가 HTTP 500(본문 0바이트, `text/plain`, `x-ms-middleware-request-id` 헤더)으로 실패하고, 모듈 하나만 실패해도 import 전체가 실패한다. 한 번의 화면 로드에 모듈 요청이 약 10~12개라 요청당 6~16% 실패가 곧 화면 로드의 절반 안팎 실패다.
- **범위 좁히기:** 500은 앱이 아니라 App Service 인증 미들웨어가 만든 응답이다. ① 인증 제외 경로 `/health`도 같은 비율로 실패한다(인증 판정 문제가 아님). ② 미들웨어가 자체 처리하는 `/.auth/me`는 0/120이다. ③ 순차 요청은 0/60이고 병렬 12건에서만 발생한다. ④ 앱 컨테이너 로그에는 **성공한 요청 수만큼만** 기록된다(60건 중 54건, 96건 중 90건). 실패 요청은 Python 프로세스에 도달하지 않았고 예외·오류 로그도 없다.
- **기각한 가설:** `http.server` 기본 listen 백로그(5)를 128로 올려 배포했지만 새 컨테이너에서도 96건 중 6건이 실패했다.
- **원인(측정과 효과로 확정, 프록시 내부는 직접 관측하지 못함):** `http.server`가 HTTP/1.0으로 응답하고 매 응답 뒤 소켓을 닫는다. 인증 프록시가 업스트림 연결을 재사용하는 동안 이미 닫히는 소켓에 다음 요청을 써서 앱에 도달하기 전에 500으로 응답한다(Node `keepAliveTimeout`과 같은 계열).
- **조치:** 서버를 HTTP/1.1 지속 연결로 전환하고(유휴 650초, 플랫폼 한도보다 길게) 백로그를 128로 유지했다. 재사용되는 연결에서는 읽지 않은 본문이 다음 요청으로 해석되어 요청 밀수가 되므로, POST 외 요청의 본문·chunked 본문·중복 `Content-Length`·본문을 읽기 전에 거절한 POST는 `Connection: close`로 응답하고 연결을 닫는다.
- **배포 게이트의 결함도 수정:** 배포 단계는 새 컨테이너가 교체되기 전에 끝나서 기존 게이트가 *이전 컨테이너*를 검사했다(이번에도 그 때문에 첫 두 실행이 실패로 기록됐다). 패키저가 `hosted/build.json`에 커밋 SHA를 넣고 `/health`가 `build`(12자)를 노출하며, 게이트는 방금 배포한 빌드가 응답할 때까지 기다린 뒤 동시 12건×5회가 모두 200인지 검사한다.
- **실환경 결과(2026-11-09, 커밋 `484f0ad`):** 수정 전 `/health` 병렬 60~96건 중 6~10%가 500이었고, 수정 후 병렬 **288건 모두 200**이었다. 로그인한 Edge에서 캐시 없이 페이지를 **15회 로드해 오류 모달 0·HTTP 오류 0**, 목록과 `저장본 · N분 전 수집`이 표시됐다. 전체 Python·JS 테스트, Ruff, strict mypy를 통과했다. 지속 연결·밀수 방지·동시 클라이언트·빌드 표식 시험을 추가했다.
- **남은 위험:** `alwaysOn`은 이 앱 소유 범위 밖의 외부 주체가 `false`로 되돌리는 이력이 있다. 유휴 후 첫 요청은 컨테이너 시작(약 25~60초)을 기다릴 수 있다. 이는 위 500과 별개이며 이번에 변경하지 않았다.

### 2026-11-09 호스팅 화면 오류 원인 — 화면 수집 WebJob이 배포되지 않음

- **증상:** 호스팅 화면이 계속 오류/읽기 전용(수집 지연·변경 이력 없음)으로 표시된다. 컨테이너 로그에는 Python 예외가 없었고 11/6~11/8에는 페이지만 로드되고 `/api/*`가 한 건도 없었다.
- **원인 1(확정):** 2026-11-04에 넣은 `App_Data/jobs/triggered/armbackup-snapshot`은 배포 ZIP에는 있었지만 Oryx 빌드(`CompressDestinationDir="true"`)가 ZIP 전체를 `/home/site/wwwroot/output.tar.zst`로 압축했다. 아카이브를 내려받아 `./App_Data/jobs/triggered/armbackup-snapshot/…`가 들어 있음을 확인했으나, SCM에서 `/home/site/wwwroot/App_Data/jobs`는 404이고 WebJob API는 409("not configured to run the web job")였다. 컨테이너는 이 아카이브를 임시 경로에 풀 뿐이라 Kudu가 WebJob을 보지 못한다. 수집이 한 번도 실행되지 않아 저장본은 11/5 이후 갱신되지 않았고 15분 초과로 실행이 잠겼다.
- **원인 2(확정):** `alwaysOn`이 다시 `false`였다. 활동 로그에서 11/5 15:37(UTC) PATCH가 다른 테넌트(`975f013f-…`)의 앱 전용 주체(앱 ID `a1a9c5b6-…`, 클라이언트 IP `20.171.234.109`)에서 온 것을 확인했다. 이 앱 소유 범위 밖이라 되돌리는 주체를 막을 수 없다. WebJob 예약은 Always On에 의존하므로 이 설계는 부적합했다.
- **조치:** 화면 수집을 웹 프로세스의 독립 수집 스레드로 옮기고 WebJob 패키징과 Always On 배포 게이트를 제거했다. `/health`에 수집 상태를 노출해 로그인 없이 확인한다.
- **검증:** 전체 Python **360개**·JS **115개**, Ruff 전체 범위와 strict mypy **23개 모듈**을 통과했다. 스케줄러의 브라우저 없는 최초 게시·실패 후 지속·작업 중 지연과 즉시 재수집·`/health` 상태 노출·ZIP에 `App_Data/` 부재를 시험했다.
- **실환경 확인(2026-11-09, 커밋 `62e1cdd`, Actions run #11 validate·deploy 성공):** 새 컨테이너가 시작 직후 사설 Blob·관리 ID로 약 12초 만에 첫 저장본을 게시했다(`/health`의 `collector.state=Succeeded`, `observedAt 12:44:05Z`). 5분 뒤 12:49:17에 두 번째 수집이 자동 시작돼 12:49:44에 성공했다. 컨테이너 로그에 `snapshot_published`가 5분 간격으로 2건, Traceback/`snapshot_collection_failed`는 0건이었다. 로그인 없이 `/health`만으로 확인했다.
- **미확인:** Conditional Access 때문에 자동화 브라우저가 로그인하지 못해 **로그인 후 실제 호스팅 화면의 렌더링·오류 문구 소멸은 직접 보지 못했다.** 화면 동작은 모의 환경 브라우저 시험(저장본 표시·실패 시 유지·최초 대기 화면)과 단위 시험으로만 확인했다. 운영자가 로그인한 화면에서 `저장본 · N분 전 수집` 배지와 백업 버튼 활성 여부를 확인해야 한다.

### 2026-11-04 화면 수집 WebJob과 저장본 조회 분리 (WebJob 부분은 위 2026-11-09 항목으로 대체)

- 호스팅 시작/상태 조회에서 ARM 사전 조회와 프로세스 수집을 제거했다. 예약 `armbackup-snapshot`은 5분마다 화면·변경 이력·관계 그래프를 Blob에 게시한다. 수집 상태도 별도 ETag 포인터로 기록하며 실패 시 마지막 정상 뷰를 유지한다.
- 관련 Python **244개**, 전체 JS **115개**, Ruff 전체 범위와 strict mypy **23개 모듈**을 통과했다. 예약 수집 성공/실패·최초 미수집·캐시 손상·Blob 상태 영속성과 조건부 교체·수집 재요청 거부·호스팅 ZIP의 WebJob/설정/의존성 포함을 검증했다.
- 실제 브라우저에서 모의 ARM 수집 후 **독자의 ARM 호출과 수집 시작을 예외로 차단**했다. 첫 화면 요청은 `session`·`state`뿐이며 변경 달력 오류 없이 표시됐다. 새로고침은 `state`, 관계 화면은 저장본 기반 `relations`만 요청했다. 실패 응답 주입 시 마지막 자원 유지/오류/백업 잠금, 첫 실패 시 스피너 없는 명시적 대기 화면을 확인했다. 390×844에서 가로 넘침이 없었다.
- 이 결과는 로컬 모의 환경 검증이다. **이번 변경의 Azure 재배포·Linux WebJob 실행·사설 Blob 예약 갱신·로그인 후 실제 호스팅 UI는 아직 검증하지 않았다.** 배포 후 Always On과 WebJob 첫 게시/이후 예약 이력을 확인해야 한다. 기존 일일 원본 백업 예약은 변경하지 않았다.

### 2026-11-04 변경 달력을 복원에 통합

- 별도 변경 달력 메뉴를 제거하고 복원 첫 화면에 기존 7행/주 단위 달력을 재사용했다. 날짜→실제 백업 자원→정확한 `runId + resourceId`로 복원 검토를 연결한다. 변경 없는 백업/첫 백업/안전 run도 탐색하며 불완전·현재 조회 미확인·지원하지 않는 형상은 이유와 함께 차단한다.
- 복원 달력 색상은 변경량이 아니라 **보관된 백업 자원 건수**다. 고객·종류·검색·시간대 필터가 날짜 집계와 목록에 동일하게 적용된다. 기존 `#history` 주소는 `#restore`로 이동한다. 현황 선택·10일 셀·관계 작업대의 날짜 탐색도 복원으로 연결했다. 일반 백업은 ‘원본 비교’를 유지하고 안전 run을 일반 변경 비교의 원천으로 섞지 않는다.
- 독립 Edge에서 예시/live 프런트엔드를 각각 검증했다. live는 모의 ARM 서버를 사용했다. 변경 달력 메뉴 0개·월~일 7행·이전 주소 리디렉션·과거 NSG 백업 선택·원본 비교·Gateway의 같은 복원 메뉴 내 묶음 검토와 정확한 과거 run 전달을 확인했다. 1920×1080/1366×768/390×844 각 모드 3개 레이아웃에 가로 넘침과 콘솔 오류가 없었다.
- 브라우저 검증 중 Gateway 선택이 `latest` 집계로 전달되는 문제를 발견해 고쳤고 정확한 원본 run을 별도로 전달하는 회귀 테스트를 추가했다. 날짜 목록은 저장 state의 불러온 최근 30개 run 한도 내이며 한도를 명시한다. 원본 백업 변경이나 새로운 Azure 복원 작업은 수행하지 않았다.
- 전체 Python **345개**·JS **110개**, Ruff·strict mypy 22개 모듈과 JS 구문 검사를 통과했다. 백업 원본/필터·시간대·불완전 차단·페이지네이션·과거 run 선택·기존 안전 복원 회귀를 포함한다. 로그인 이후 실제 호스팅 UI/복원 실행 검증을 대신하는 결과는 아니다.
- 기존 App Service에 코드만 배포했다. 배포 ID `7cb72656-1cad-4195-b139-5fccd264251f`, 응답의 `complete=true`, status 4와 build_summary errors 0개를 확인했다. 런타임/Plan·인증·RBAC·백업 원본은 변경하지 않았다. 배포 직후 호스팅 브라우저/실행 health 검증은 이 기록에 포함하지 않는다.

### 2026-11-03 공식 선택 목록과 선택 전용 백업 현황

- `수집할 리소스 종류`는 인벤토리 대신 공통 `resource-support.json`의 **Application Gateway(WAF_v2·공용 IPv4·HTTP)**와 **Load Balancer(Standard·공용 IPv4·TCP·IP Pool)**만 표시한다. 인스턴스가 없어도 두 선택지는 유지한다. WAF Policy/Public IP/독립 Pool은 주 대상의 관련 설정이며 독립 공식 선택 항목은 아니다.
- 기존 비공식 종류 정책·백업 원본은 삭제하지 않는다. 기존 정책에 비공식 종류가 있으면 알리고, 운영자가 공식 종류를 선택해 저장할 때만 전환한다. 새 일반 백업은 SKU/프로토콜/API/필드·프로비저닝 상태를 검사하고 관련 자원 누락/수집 중 참조 변경이 있으면 완료 표식을 만들지 않는다. 이전 CLI·명시적 검증 러너는 기존 프로필 검증을 위해 별도로 유지한다.
- 실제 Gateway 검증의 최초 실행과 영속 근거 기반 재개를 합쳐 **20개 통과 단계·HTTP 55건·진단 조회 11회**, 성공 영속 job 6개·검증된 안전 run 5개를 확인했다. 원본 `20261103T065644Z-e6b17ae38f67`의 Gateway/WAF/PIP 3개를 최신 공식 검증기로도 확인했다. 경로·포트·WAF header/admin 차단·redirect·독립 복제·원본 불변·반복 변경/업데이트 복원·삭제 후 재생성을 시험했다. 최초 실행 중단 상태를 전체 성공으로 기록하지 않고 재개 기록을 별도로 보존했다.
- Gateway 재개 결과는 `Passed`, 시험 자원 정리도 `Passed`다. 정리 직후 ARM 목록에 WAF 2개가 남아 보였지만 해당 목록 ID로 직접 GET하면 둘 다 404였다. 목록 전파 지연을 실제 자원 잔존으로 판정하지 않았고 기존 비소유 자원은 삭제하지 않았다. 중간 완료 대기 한도 초과도 검증 실패로 바꾸거나 같은 쓰기를 재제출하지 않고 실제 프로세스/영속 결과를 확인했다.
- Standard LB는 별도 임시 RG `rg-armbackup-cert-lb-d8e47254`에서 **15개 단계·HTTP 8건**, 안전 run 4개를 통과했다. TCP/HTTP probe 변경을 포함한 두 번의 설정 drift/복원, 독립 Pool PUT, 원본을 보존한 복제와 삭제 후 재생성/복제본 가용성을 확인했다. 일반 공식 정책 경로에서도 LB만 선택해 Pool/PIP까지 3개가 보관되는 run `20261103T074722Z-7b9bf068169a`를 검증했다. seed의 독립 Pool 정의 누락으로 중단된 첫 시험은 정리 후 러너를 수정해 재실행했다. 두 LB 시험의 과금 자원과 임시 RG는 모두 정리했다.
- 백업 현황의 행 선택은 선택 상태와 복원 진입만 갱신하고 하단 형상/Diff 패널을 생성하지 않는다. 예시 UI와 live UI를 각각 독립 로컬 Edge로 실행해 **공식 종류 2개·선택 행 1개·하단 패널 0개·콘솔 오류 0개**를 확인했다. live UI 시험은 모의 ARM 서버를 사용했으며 로그인 후 호스팅 UI 시험으로 표현하지 않는다. 형상 Diff는 변경 달력/복원 검토에 남긴다.
- 전체 Python **321개**·JS **88개**, Ruff·strict mypy 22개 모듈을 통과했다. 공식 주 대상 없이 child Pool만 새 일반 백업으로 선택하는 경우도 차단했다. 실제 Gateway/LB 쓰기·HTTP 시험은 PC CLI 신원/명시적 디스크 원천에서 실행했으며 App Service MI 신원이나 KT 운영 인증의 검증을 대체하지 않는다. TLS·다른 SKU·NIC Pool·outbound/NAT rule·업무 데이터는 이 공식 프로필에 포함하지 않는다.
- 소스를 기존 App Service에 배포해 complete/status 4를 확인했다. 최종 child-only 차단 보완을 포함한 배포 ID는 `0520d9b2-35f8-4a52-9cba-f475af0ada12`이며, ARM 배포 기록의 complete/status 4와 `/health` HTTP 200/`azureConnected=true`, 테스트 구독 전체 scope와 익명 `/api/session` 401을 재확인했다. 운영자 로그인 후 호스팅 화면·실제 복원 동작은 별도 대화형 검증이 필요하다.

### 2026-11-03 Blob 우선 표시·변경 시 화면 교체

- 기존 Blob 직접 읽기/무결성/만료 저장본 재사용을 유지하면서 `contentSha256`을 추가했다. 조회 시작/완료 시각만 제외하며 실제 형상·존재/오류 상태·변경자/변경 시각·백업·정책·경고는 변경 판정에 포함한다. 기존 캐시는 검증한 DTO에서 내용 hash를 계산해 그대로 읽는다.
- 브라우저는 저장본을 먼저 렌더링하고 공용 Azure 갱신 결과를 주기적으로 확인한다. 내용이 같으면 DOM 전체를 다시 그리지 않고 관측 시각/실행 잠금만 갱신한다. 변경이 있으면 선택·접기·검색·미저장 정책을 유지하고 스크롤/초점을 복구한다. 입력 또는 모달이 열려 있으면 교체를 종료 후로 미룬다.
- 실제 프런트엔드 갱신 함수의 VM 테스트에서 느린 Azure 결과 전에 저장본 렌더링, 동일 내용 no-render, 변경 시 한 번 교체, 입력/모달 중 반영 대기, 스크롤/초점 복구, 실패 시 저장본/쓰기 잠금 유지, 다른 작업 오류 보존을 확인했다. 이 검증은 실제 로그인한 호스팅 브라우저의 성능 실측이 아니다.
- 전체 Python **291개**·JS **83개**, Ruff·strict mypy 21개 모듈과 JS 구문 검사 통과. Blob 어댑터의 직접 읽기 3회/목록 열거 0회와 기존 손상 복구·권한 실패 보호 테스트도 유지했다.
- 실제 App Service 런타임 설정에서 `alwaysOn=false`를 확인하고 기존 B1에서 `true`로 복구했다. 기존 IaC의 `alwaysOn=true`와 일치시키며 새로운 Plan/DB/Storage는 생성하지 않았다.
- 현재 소스를 기존 managed identity/private Blob 설정으로 재배포했다. 배포 `87a3be8d-3a41-47d4-9cbc-c963f4e52094` complete/status 4, `/health` HTTP 200/`azureConnected=true`, 구독 scope와 익명 `/api/session` 401, 실제 `alwaysOn=true`를 확인했다. 최초부터 Blob 저장본이 없다면 한 번의 수집은 필요하며 사이트 재시작/플랫폼 장애/Blob 네트워크 지연을 0으로 보장하지 않는다.

### 2026-11-02 승인된 테스트 구독 전체 복원·복제

- 사용자 승인에 따라 기본 `inventory_scope=subscription`을 조회·백업뿐 아니라 복원·복제에도 적용했다. 특정 LAB RG 이름과 `armbackupLab`/`armbackupWorkload` 태그는 요구하지 않는다. 기존 `lab` 값은 명시적 이전 설정 호환용이다. 다른 구독 거부·검토된 필드·계획 hash/만료/일회 승인·안전 백업·사후 형상 검증은 유지한다.
- App Service 시스템 관리 ID에 구독 전체 Contributor를 실제 할당하고 IaC와 같은 결정적 역할 ID `407860d2-020a-57a3-a43b-9f437b090ef3`로 정렬했다. 기존 LAB RG의 중복 Contributor만 제거했다. 구독 Reader와 지정 Storage Blob Data Contributor/DCR Monitoring Metrics Publisher/Workspace Log Analytics Reader는 유지했다.
- 이전 LAB 밖 임시 RG `rg-armbackup-scope-e58c2cc3`에 LAB 태그 없이 NSG·Route Table을 만들었다. 표준 정책 저장→2개 백업→두 설정 변경→묶음 업데이트 복원→독립 2개 복제→원본 삭제→2개 재생성을 모두 통과했다. 백업 `20261102T073744Z-6e1a477d12af`, 안전 run 3개를 완료 표식/SHA로 검증했다. 정책을 원복하고 시험 자원 4개와 임시 RG를 정리했다. 증거는 Git 제외 `subscription-scope-e58c2cc3.local.json`에 남겼다.
- 위 쓰기 실험은 PC의 CLI 신원/명시적 디스크 원천에서 실행했다. App Service MI 신원으로 복원 실행한 것으로 표현하지 않는다. 관리 ID의 실제 구독 역할은 별도로 조회했고 실제 앱 `/health`에서 구독 scope·`azureConnected=true`를 확인했다.
- 현재 소스를 명시적 `inventory_scope=subscription`, managed identity/private Blob 설정으로 기존 App Service에 코드 재배포했다. 배포 ID `d0012ef3-2ecc-453c-ae54-89a7cbe8e0bc`, complete/status 4를 확인했다. `/health` HTTP 200의 scope는 `/subscriptions/76d397e2-496f-4ad2-9f86-3871040bfb91`, 익명 `/api/session`은 401이다. EasyAuth 지정 운영자 제한은 유지했다.
- GitHub의 비밀 없는 `ARMBACKUP_DEPLOY_CONFIG`도 전체 구독 설정으로 갱신하고 readback을 검증해 다음 push에서 좁은 범위로 돌아가지 않게 했다. **로그인 이후 호스팅 UI/복원 실행과 로그인 403 해소 자체는 여전히 대화형 검증이 필요하다.**
- 전체 Python 289개·JS 74개, Ruff·strict mypy 21개 모듈과 Bicep compile을 통과했다. 이후 기본 설정·다른 RG의 공유 참조 보완은 관련 Python 111개·JS 34개로 재검증했다. 여러 RG의 태그 없는 묶음 업데이트·복제·재생성, 구독 ID 확인값, 다른 구독 쓰기 차단을 회귀 테스트했다. Bicep의 기존 API 유형/미사용 파라미터 경고는 남았다. 이전 절의 “아직 재배포하지 않음”은 이 배포 전 시점의 기록이다.

### 2026-11-02 호스팅 접근 오류·16:9 밀도·손상 캐시 복구

- 실제 App Service는 Running, Resource Health Available, `/health` HTTP 200이었다. 익명 `Accept: application/json` API 요청이 **빈 401**을 반환하는 것을 재현했다. 이전 클라이언트는 이 응답을 JSON 파싱 오류로 오인했다. 새 클라이언트를 실제 익명 엔드포인트에 연결해 JSON 파싱 오류가 아닌 HTTP 401로 분류함을 확인했다. JSON 여부와 무관하게 401/403/게이트웨이 오류를 구분하고 인증 복구 동작을 표시한다.
- cookie POST 403의 가능한 출처 검사 문제를 보완하기 위해 `https://app-armbackup-dev-f4bc.azurewebsites.net`만 EasyAuth 외부 redirect 허용 출처로 실제 등록하고 IaC에도 반영했다. 인증 필수·지정 운영자 목록·HTTPS·익명 API 차단은 유지했으며 CORS wildcard나 AllowAnonymous를 추가하지 않았다. AppLens의 인증/프록시 진단은 구체적인 로그인 403 경로를 입증하지 못했다. **운영자 브라우저 로그인이 불가해 실제 로그인 후 403 해소는 아직 미검증**이다.
- 1920×1080/1366×768 예시 화면에서 상단 높이 81→50px, 제목 영역 106→44px, 첫 설정 패널 시작 위치 305/300→121px를 확인했다. 본문 16.25px·버튼 13.75px는 유지했다. 실환경 설정도 첫 패널 122px·선택 42개를 확인했다. 5개 예시 화면×3개 화면 크기의 15개 레이아웃은 가로 넘침이 없었다. 모바일은 버튼을 줄바꿈한다.
- 손상/누락/불완전 업로드·다른 scope 참조·동시 정상 포인터 교체·권한 오류를 시험했다. 해당 중간 캐시만 조건부 삭제한 뒤 재수집하고 원본 manifest/정책을 보존했다. Storage 403에서는 삭제 호출이 없음을 확인했다. 정상 캐시의 직접 읽기 경로는 목록 열거 없이 유지한다.
- 전체 Python **287개**·JS **73개**, Ruff·strict mypy 21개 모듈과 Bicep compile을 통과했다. 마지막 캐시 시각 검증 보완도 해당 Python 92개·Ruff·strict mypy로 재검증했다. 기존 preview API/미사용 파라미터 관련 Bicep 경고는 남았다. Azure 인증 출처 설정은 실제 반영했지만 최신 프런트엔드/UI·캐시 복구 코드는 아직 App Service에 재배포하지 않았다.

### 2026-11-02 저장본 우선 입장·공용 백그라운드 수집

- 기존 만료 후 입장 API는 **44.748초**, 새 저장본 API 3회는 **0.050/0.036/0.028초**였다. 동시 8회는 **0.064~0.180초**였고 모두 같은 갱신 ID를 사용했다. 비교 대상은 관측/과거 백업을 포함한 150개 자원이다. **PC의 명시적 로컬 원천 수치이며 App Service/사설 Blob 실측이 아니다.**
- 새 cache identity의 첫 요청은 HTTP 202/`statePending`을 **0.411초**에 반환했다. 최초 공용 수집은 **33.389초**였고 이후 저장본을 재사용했다. 저장본이 전혀 없거나 구성 identity를 바꾸면 한 번의 수집은 필요하다.
- 실제 브라우저 3회 새로고침의 데이터 표시 확인은 **2.049/1.693/2.130초**였다. 갱신 실패를 주입해도 42개 선택 행을 유지하고 쓰기를 잠갔으며, 갱신 진행 중에도 현황으로 이동해 150개 행을 읽을 수 있음을 확인했다. 주입한 응답은 제거하고 정상 화면으로 복귀했다.
- Blob SDK 어댑터 모의 테스트에서 포인터/완료 marker/객체 직접 다운로드 호출 3회, Blob 목록 열거 0회, ETag 조건부 교체, 경합 거부, 인증 실패의 명시적 오류와 원본 불변 저장을 확인했다. 큰 객체의 SDK 분할 요청이나 실제 Azure 네트워크 성능 검증은 아니다. 만료/구성 변경/수집 중 입력 변경/손상/공용 갱신 병합/주기적 갱신·종료/HTTP 202와 polling을 시험했다.
- 전체 Python **274개**·JS **71개**, Ruff·strict mypy 21개 모듈을 통과했다. 마지막 읽기 탐색 허용 UI 보완도 관련 JS 31개와 실제 브라우저로 재검증했다. 로컬 콘솔에 반영했으며 App Service에는 아직 재배포하지 않았다.

### 2026-11-02 공통 워크스페이스 정보 영역 제거

- 실환경 상단 연결 정보 띠와 실환경/예시 사이드바 워크스페이스 카드를 제거했다. 관련 정보는 설정의 접힌 `연결 정보`에 모았고 KST/UTC 선택도 설정으로 옮겼다.
- 실제 브라우저에서 두 공통 영역 0개, 설정의 연결 정보, UTC 관측 시각 표시, 현황 페이지의 시간대 컨트롤 0개와 화면 오류 없음을 확인했다. 시간대는 시험 뒤 KST로 되돌렸다.
- 전체 UI 69개·해당 Python HTTP/콘솔 63개·Ruff·strict mypy를 통과했다. 로컬 화면 반영이며 App Service에 재배포한 결과는 아니다.

### 2026-11-02 설정 목록·안내 영역 간소화

- 실환경 선택 목록은 관리 그룹 2개·구독 1개·RG 39개, 총 42개 행으로 줄였다. 개별 자원 행은 0개이며 기존 개별 선택 정책·부분 선택·예상 대상 수를 유지한다. 예시 화면도 체계 6개 행만 표시한다.
- 실환경 상시 범위 배너와 반복 설명 카드를 제거했다. 시작 안내 모달→확인 기록→동일 탭 새로고침 시 생략→상단 안내 아이콘으로 재열기를 실제 브라우저에서 확인했다. 범위·저장 원천·복원 활성화 변경은 재안내하며 저장 거부는 확인 완료로 간주하지 않는다.
- 실제 오류·쓰기 잠금·실행 직전 경고와 서버의 LAB 복원 경계는 유지했다. 390/768/1440/1920px에서 가로 넘침 없이 42개 선택 행을 확인했다. 전체 JS 68개, 해당 Python HTTP/콘솔 63개, Ruff·strict mypy를 통과했다. App Service에 재배포한 결과는 아니다.

### 2026-11-02 화면 배율·구독 전체 조회

- 브라우저 100%에서 기존 대비 글자·아이콘·여백 1.25배를 적용했다. 예시 5개 화면의 표본 글꼴 배율과 390/768/950/951/1440/1920px의 30개 레이아웃을 확인했고 문서 전체의 가로 넘침은 없었다. 큰 표는 자체 스크롤한다.
- PC 실환경에서 실제 `Tenant Root Group → CONTOSO-MG → 구독 → RG`를 확인했다. 관리 그룹 2개·RG 39개·검토된 종류의 현재 자원 134개를 조회했다. 과거 백업에만 있는 자원을 포함한 현황은 148개다. 일반 Azure 종류 전체에 복원 지원을 추가한 결과는 아니다.
- 조회·백업은 명시적으로 현재 구독까지 확대하고 복원·복제는 기존 소유 LAB에 제한했다. 관리 그룹/구독 체크박스, 상위 선택·하위 제외·부분 선택, 기존 LAB 정책 보존, 범위별 캐시 무효화와 LAB 밖 복원 거부를 검증했다.
- 범위 확대 시점에는 실제 관리 그룹 선택 시 기존 종류 조건의 예상 대상 115개, NSG 하나 해제 후 114개와 상위 부분 선택 표시를 확인했다. 이후 위 후속 변경으로 선택 목록을 RG까지만 간소화했다. inline style 없이 기존 CSP를 유지하며 시험 후 미저장 선택은 취소했다.
- LAB 밖 기존 NSG를 표준 정책 저장→백업 API로 읽어 `20261102T012300Z-7e4b656fa004`에 1개 보관했고 완료 marker/manifest/snapshot SHA를 확인했다. 해당 run으로 LAB 밖 복원 review가 HTTP 400으로 거부됐다. 시험 후 기존 정책을 다시 저장했으며 기존 Azure 자원은 생성·수정·삭제하지 않았다. RG별 Activity Log는 `Available`로 확인했다.
- 실제 AKS Load Balancer의 미검토 `allocationPolicy` 속성은 비교/복원 미확인으로 남긴다. 검토 없이 replay를 허용하지 않는다. 이 절의 PC 조회와 로컬 디스크 백업 검증은 App Service의 실제 로그인 이후 UI 검증이나 사설 Blob 쓰기 검증을 대체하지 않는다.

- 전체 서버 회귀: **Python 287개**, 최신 전체 UI 회귀 **JS 73개**. Ruff 통과, strict mypy 21개 모듈 통과 후 해당 후속 변경도 위와 같이 재검증했다.
- 브라우저의 실제 20행·행당 10일 셀·날짜 기록→원본 Diff·상대시각·체계/종류별 접기/펼치기·8개 당직 필터를 확인했다. 768px 요약 줄바꿈을 수정했다. 6개 MSP 장애 시나리오는 모델링 검증이며 실제 사용자 연구가 아니다.
- 실패 attempt/미백업 현재 자원/안전 run 제외를 검증했다. 저장 뷰의 미완료 객체·SHA 변조·TTL·입력 세대 변경을 시험했다. PC의 명시적 로컬 원천에서 cold **25.151초**, saved **0.290초**를 측정했다. **App Service/사설 Blob 성능 수치가 아니다.**
- 승인 구독 Korea Central에 Linux B1 App Service·VNet·승인된 Blob PE·사설 DNS를 실제 배포했다. MI의 구독 Reader, 기존 LAB만 Contributor, Storage/DCR/Workspace data role의 실제 범위를 확인했다. 기존 Storage의 public access/shared key 차단을 유지했다.
- 최초 Oryx ZIP 배포의 완료 status 4와 `/health`의 **HTTP 200, `azureConnected=true`, `mode=live-lab`, `productionReady=false`**를 확인했다. CLI의 시작 추적이 끝나지 않아 Kudu 완료와 실제 health 확인 후 추적 프로세스만 종료했다.
- 익명 API 차단, 실제 EasyAuth v2 인증 강제·운영자 허용 목록·`/health`만 예외를 확인했다. 최초 직접 401 화면을 자동 Entra 로그인 이동으로 바꾸고 브라우저에서 Microsoft 로그인 페이지 도달을 확인했다.
- [실제 push 워크플로](https://github.com/Networkdog/armbackup/actions/runs/41367266416)는 Linux/Python 3.12 검사와 OIDC 앱 배포·health/인증 경계를 통과했다. 최초 로그인은 이름 기반 FIC와 실제 immutable token subject가 달라 실패했으며, owner/repository ID가 포함된 정확한 subject로 수정한 재실행은 성공했다. SCM/FTP 기본 인증을 끈 상태에서 배포했다. 최종 IaC에서도 두 기본 인증을 차단한다.
- **허용 운영자의 실제 로그인 완료 후 UI·Blob 저장 뷰 속도·호스팅 앱에서 복원 실행은 미검증**이다. 브라우저에 로그인 세션이 없고 정식 운영자 API 토큰에도 대화형 동의가 필요했다. 인증을 끄거나 헤더를 위조해 우회하지 않았다. 기존 사설 러너의 Blob/복원 성공과 구분한다.

## 복합 자원·관계 작업대의 후속 검증

### 추가 Gateway/WAF 상세 설정·독립 복제 시험

#### 최신 전체 실환경 검증 — 고정 사설 IP VM 백엔드

후속 승인으로 같은 소유 LAB에서 전체 순서를 새로 실행했고 **12개 단계·35개 HTTP 검사**를 통과했다. 원본 baseline→Gateway/WAF/PIP 3개 백업→독립 3개 복제→원본 구성 보존→원본 backend port 80→8080 및 admin WAF Block→Log 변경→복제본 불변 확인→안전 백업 후 원본 업데이트 복원→원본 3개 삭제/재생성→복제본 통신 유지까지 확인했다.

- source `20261101T050328Z-362d697d5cc3`: 원본 3개 완료 표식·SHA 검증. 영속 성공 job 4개, 안전 run 3개를 재조회해 모두 검증했다.
- 각 단계에서 원본/복제본의 실제 ARM backendhealth를 저장했다. 7회 조회의 normal/api backend **14개 상태가 모두 Healthy**였고 WAF/접속 diagnostics를 지정 Workspace에 연결했다. backend health만으로 성공을 판정하지 않고 포트·path·403/200·301 HTTP도 확인했다.
- related WAF/PIP 쓰기가 Gateway의 읽기 전용 상태를 바꾸면 이전 raw fingerprint와 달라질 수 있다. **이 계획이 관련 참조 대상을 이미 적용했고 현재 writable configuration hash가 검토값과 같을 때만** 재검증을 허용한다. 관련 쓰기와 무관한 변화·외부 writable/tag 변경은 계속 거부하며 두 경우를 회귀 테스트했다.
- 시험 백엔드는 공용 IP/SSH 없이 `Standard_B1s` VM의 고정 private IP `10.85.3.4`를 사용했다. 이전 ACI 502의 정확한 원인이 해결/확정됐다는 뜻은 아니다. **VM 기반 구성 복제·복원·재생성의 실환경 성공**과 ACI 경로의 미확인 원인을 구분한다.
- 기록된 원본·복제본·VM/NIC·확인된 OS disk·시험 네트워크를 정리했다. ARM 재조회에서 `abx-` 0개·기존 RG 및 기존 자원 10개 유지 확인. 원본·안전 백업·진단·이전 실패 자료는 남긴다.
- 전체 회귀: Python **248개**, JS **52개**, Ruff·strict mypy 20개 모듈 통과. TLS/Key Vault·identity/RBAC·업무 데이터·다른 고객/KT 운영 망·공유 백엔드까지 독립 복제는 이 결과의 범위가 아니다.

아래 기록은 이전 ACI 기반 시도와 비교 보완의 이력이다. 최신 VM 기반 전체 성공과 합치거나 이전 실패를 없었던 일로 취급하지 않는다.

같은 소유 LAB에서 WAF_v2/OWASP 3.2 Prevention·요청 본문 검사·헤더 Block(우선순위 10)·`/admin` Block(20), HTTP 80/8081/8082 listener, API path의 8080 backend, normal 80 backend, `LabAffinity` cookie 설정, health probe·redirect·HTTP2를 구성했다. 원본 5개 HTTP 체크와 Gateway/WAF/PIP 3개 완료 표식·SHA 검증을 확인했다.

복제 prefix `abx-twin`으로 원본과 별도의 WAF/PIP/Gateway를 만들었다. 실제 사후 비교에서 발견한 두 차이는 PIP의 DNS label로 계산되는 FQDN과 WAF ARM `id`의 대소문자였다. FQDN은 PUT 재현 대상으로 취급하지 않고, ARM `id` 참조만 대소문자 무관하게 정규화한다. opaque tag 값은 그대로 보존한다. 수정 후 복제본의 세 관리 설정이 검토한 매핑과 일치하는 것을 확인했다.

**통신 복제 성공은 아직 확인하지 못했다.** 복제본 `/health`가 HTTP 502를 반환했다. 당시 실패 원인을 나타내는 backend health를 삭제 전에 확보하지 못했으므로 ACI·동일 Subnet·플랫폼 동작 중 어느 원인인지 단정하지 않는다. 원본 삭제가 진행 중인 상태를 재개 과정에서 원본 변경으로 오인하는 시험기 문제도 수정했으며, 실제 변경/복원/재생성 전체 루프는 추가 검증 대상이다.

이 확장 후 전체 회귀는 Python **246개**, JS **52개**, Ruff/strict mypy **20개 모듈**을 통과했다. 생성된 복제 WAF/PIP/Gateway의 매핑된 관리 설정 일치, 원본 Gateway의 검증된 백업을 통한 재생성, UI의 복제 선택/접두사 거부/3개 연관 선택을 확인했다. 실패한 HTTP 단계를 성공으로 처리하지 않았다. 증거에 기록한 소유 대상은 `--cleanup-only`로 정리했고 마지막 목록에 잔류한 WAF 2개는 직접 ARM GET에서 모두 404 `NotFound`임을 확인했다. 원본 백업·안전 run·영속 실패 작업·기존 RG는 유지했다.

[재현 시험기](../scripts/exercise_gateway_lab.py)는 기록된 증거에서 재개하고, 이전 provisioning/deletion이 완료되지 않으면 쓰지 않는다. 실패/중단한 실험을 성공으로 덮어쓰지 않으며 `--cleanup-only`는 같은 scope의 기록된 소유 대상만 정리한다. 독립 복제 UI의 접두사 가드와 원본/대상 매핑은 제공하지만 이는 서비스 독립 복구·TLS/Key Vault·RBAC·업무 데이터·교차 RG 복제 보증이 아니다.

최종 범위는 **Python 242개 / JS 51개**, 전체 Ruff·strict mypy **20개 모듈**이다. 과거 표의 숫자와 합산하지 않는다.

최종 wheel은 Python 20개 모듈·정적 자산 13개·14 roots/265 field nodes의 계약 JSON을 포함하며 현재 소스와 모든 바이트가 일치한다. SHA-256: `88ef39739a184e42d1b730b96ffa924445f274afc04fd977c6375699a5c339e2`.

- **삭제 후 재생성:** 원래 13개를 모두 삭제·부재 확인한 뒤 같은 검증 source로 재생성했다. 부분 실패의 안전 run을 보존하고 기존 9개의 적용 상태를 확인한 후, LB/Pool 업데이트와 Origin/Rule/Route 생성을 별도로 재승인했다. 최종 13개 형상 전부 `same`, 6개 HTTP 체크 모두 통과.
- **Front Door 준비 조건:** 실제 400 응답이 Origin Group에 최소 1개 enabled Origin을 요구했다. Route의 ARM ID 참조뿐 아니라 Origin/Rule의 설정 준비 순서도 위상 그래프에 반영했다. 7개 FDR child/root의 엄격한 회귀 시나리오를 추가했다.
- **외부 전파:** 관리 설정 일치 후 원래 기본 주소의 HTTP 404가 더 오래 관측됐다. 후속 검증에서 원래 주소와 별도 진단 주소 모두 200/원래 응답 규칙을 확인했다. Null 생략·canonical 입력·새 주소 실험이 정확한 원인을 입증한 것으로 표현하지 않으며, 그 실험을 기본 복원 정책으로 채택하지 않았다. FD 기능 검사만 유한 45분 대기를 허용하고 실제 HTTP로 판정한다.
- **UI 종단간:** 작업대에서 NSG 1개 실제 백업→현재 동일성 확인→비라우팅 시험 태그 1개 변경→티켓/사유/경계/그룹명 승인→안전 백업/복원→전체 `same`을 검증했다. 안전 원본에는 변경된 시험 태그가 남고 현재에는 태그가 제거됐다. 영속 완료 작업과 `LAB-BUNDLE-UI` Workspace 로그 7건을 확인했다.
- **반응형·선택:** 6개 화면 × 320/390/768/1024/1440/1920/2560px의 **42개 폭**에 루트 가로 넘침 없음. 1920px에서 작업대 폭 1675px, 2560px에서 main 폭 2363~2378px. Front Door 단일 선택은 포함 7개, 직접 root 3개+연관은 13개로 확장되며 공유/주소와 승인 가드를 확인했다. [현재 작업대 캡처](images/complex-workbench.png)는 시험 종료 후 부재가 된 소유 자원의 원본 검토 화면이다.
- **조회 지연:** CLI 신원에서 ARM 현황 조회 96.9초를 관측했다. 선언된 Azure Identity의 `get_bearer_token_provider`를 사용한 표준 토큰 캐시·만료 갱신으로 변경했고 후속 측정은 22.5초였다. 3개 요청의 유효 토큰 취득 1회·만료 시 재취득과, 느린 전체 갱신 전에 영속 완료 결과 표시를 회귀 테스트했다.
- **정리:** 기록된 `abx-` root 14개와 소유 VM에 연결된 OS disk 1개를 삭제했다. 포함 child와 별도 진단 endpoint/route도 parent 삭제로 정리됐다. Azure 재조회에서 `abx-` 0개, RG/기존 LAB 자원과 비소유 Event Grid system topic 유지, RG 내 남은 자원 10개를 확인했다. Storage/Workspace 등 기존 보관 자원과 로컬 원본·실험 기록은 유지한다.

- 실제 **13개** edge 원본/포함 설정을 같은 run에서 수집·hash/완료 표식 검증했다. HTTP WAF_v2의 normal/path listener·redirect·probe, 별도 WAF 규칙, Standard LB/독립 IP pool, Front Door Standard의 endpoint/origin group/origin/route/rule set/rule을 포함한다.
- WAF custom action 변경→단일 안전 백업/업데이트, LB backend port 변경→부모/pool 묶음 안전 백업/업데이트를 검증했다. 전후 정상 200·WAF 시험 헤더 403·301 redirect·path의 8080 backend·LB의 80 backend·Front Door 응답 헤더를 검사한 **17개 체크**가 통과했다.
- Root/child 순서·모드 반대 조건·current/source/API/승인 hash·검토 후 변경·공유 fingerprint·부모 소유/주소 경계·전체 안전 저장/로그 실패·일회 실행·부분 적용 ID·모든 child 이후 전체 비교를 회귀 테스트한다.
- 실제 WAF/접속 로그 수신과 고정 resource-scoped 쿼리를 확인했다. WAF 차단 우선 최대 100건과 최신 접속 최대 100건을 구분한다. custom `BlockLabHeader`의 403 메시지는 실제 로그로 확인했으며 다른 초기 403의 정확한 규칙을 임의 추정하지 않는다.

### 실제 데이터에서 수정한 핵심 문제

1. **LB IP backend:** [공식 제한](https://learn.microsoft.com/en-us/azure/load-balancer/backend-pool-management)에 따라 ACI 대신 공용 IP/SSH 없는 단기 B1s VM을 사용했다. 부모 LB PUT은 주소를 재현하지 않는 실제 동작을 확인해 **독립 backendAddressPools PUT**·포함 snapshot·부모 placeholder와 전체 후검증을 연결했다.
2. **AFD 액션:** 공식 `x-ms-discriminator-value`를 반영해 rule의 `ModifyResponseHeader`/parameter 변형을 투영한다.
3. **응답 전용 필드:** LB address id/type/etag/provisioningState, AGW own backlink 등을 정확한 경계 안에서 제외한다. 켜진 미검토 LB/HTTP3/managed bypass 값은 실패로 드러낸다.
4. **ARM health LRO:** 실제 `202` + JSON `null` + `Location`을 관측했다. 신뢰된 ARM URL만 polling하며 실패/알 수 없는 status/유한 대기 한도를 검증한다. 일반 JSON `null`을 성공 객체로 대체하지 않는다.
5. **Windows 동시 저장:** 디렉터리 생성 중 `Path.resolve()`가 `\\?\` 접두사를 남기는 반환값을 재현했다. 동일 경로의 표현만 정규화하며 원래 경로 이탈·symlink·덮어쓰기 검사를 유지한다. 동시 64건 및 회귀 검증을 추가했다.
6. **삭제 중 조회:** child collection 404는 해당 부모 GET이 확인된 부재일 때만 인벤토리에서 제외한다. 현재 백업 행은 유지하고 403/부모 미확인은 오류 상태로 남긴다.
7. **빈 Endpoint 태그:** 삭제 후 실제 재생성 검토가 차단되는 증상을 재현했다. 원본 `{}` 태그는 보존하고 검증된 부모 메타데이터를 묶음 소유·현황·고객 달력 필터에 일관되게 사용한다. 같은 삭제 전 검증 source로 새 계획을 검토하는 명시적 재개 경로를 제공한다.

일반 TLS/Key Vault 입력·identity/RBAC·Front Door 운영 WAF/Private Link·고객 데이터 평면을 검증한 결과로 확대 해석하지 않는다. 별도 통합 브라우저의 `ERR_NETWORK_IO_SUSPENDED`는 서버의 HTTP 200과 분리해 확인했으며, 최종 UI 실행은 독립 Playwright 탭에서 검증했다.

## 실제 Azure LAB 검증 — 2026-10-31

사용자는 구독 안에 새 RG 하나를 만들고 그 안에서 생성·삭제·변경을 시험하도록 승인했다. `rg-armbackup-msp-lab-20261031` 한 곳에만 소유/실험 표식을 적용했으며 기존 다른 RG의 자원은 변경하지 않았다. `customer-alpha`/`customer-beta`는 가상 고객 태그다.

### 일별 변경 달력 추가 검증

후속 시각화 작업에서 현재 전체 **Python 198개**, **JS 45개**, Ruff/strict mypy **17개 모듈**을 확인했다. 아래 이전 LAB의 테스트 수와 추가 합산하지 않는다.

- 실제 검증된 일반 run **7개**, 관측 기록 **29개**: 첫 관측 4·변화 없음 18·형상 변경 4·목록 추가 2·목록 제외 1. 안전 백업 제외.
- 2026-10-31 셀: **변경 자원 5개**, **속성 변화 4개**, **형상/목록 변동 기록 7개**. 이 값은 관측 간 차이이며 실제 발생 사건 수가 아니다.
- 고객 필터·13주/26주/53주·두 색상 지표·날짜 선택·원본 Diff·키보드·미관측 날짜·500 run 한도·범위 변화/불완전/API 차이·변경 원복을 테스트했다.
- 월/연도 경계·윤년·KST/UTC 일자 차이·하루 같은 자원 중복 제거·첫 기록을 변화로 세지 않음·목록 변동을 생성/삭제로 확정하지 않음을 검증했다.
- 실제 날짜 클릭 후 이전/이후 원본 hash 재검증·상세 Diff 확인. 서로 다른 화면/선택 뒤 늦은 응답을 덮어쓰지 않도록 상세 요청 세대를 구분한다.
- 320·390·768·1024·1440px에서 페이지 가로 넘침 없이 7행을 유지하고 내부 달력 스크롤을 확인했다. in-shape 숫자/배지의 실제 색상 쌍 **4.5:1 이상**과 정해진 음영을 테스트했다.
- LAB의 장기 데이터는 아직 없으므로 실제 화면의 과거 칸은 미관측이다. 별도 예시 모드만 요일 패턴을 가진 명시적 가상 데이터를 사용한다.

시각화 검증을 위해 Azure 리소스를 생성·변경하지 않았으며 [실제/예시 캡처](comparison-ui.md)에 원천과 제한을 함께 남겼다.

### 관찰한 결과

| 항목 | 실제 결과 |
| --- | --- |
| 현재 검증 환경 | Windows / Python 3.14.6 / Node.js 26.13.0. 사설 경로는 Azure ACI의 별도 관리 ID |
| 전체 Python | `pytest -q` — **178 passed** |
| JS | `node --test tests\ui-model.test.mjs tests\live-client.test.mjs` — **32 passed** |
| Ruff·mypy | 전체 소스/테스트/스크립트/host lint 통과, strict **16개 모듈 오류 없음** |
| wheel | 최종 wheel의 **Python 16개 모듈·정적 자산 9개**가 현재 소스와 바이트 일치 |
| MSP 실험 | [exercise_lab.py](../scripts/exercise_lab.py) — **16개 시나리오 통과**, 실제 NSG/RT 변경·복원·신규 생성·삭제·재생성·정책 수집·감사/보고서 |
| 안전 백업 | MSP 루프에서 **5개** 완료 표식/원본 hash 검증. 브라우저 실제 복원 2건도 각각 별도 안전 백업 검증 |
| 브라우저 실행 | 실제 지금 백업, 과거 시점 선택·Update-only 1건·Create-only 1건, 티켓/사유/대상명 승인, 결과·안전 백업·영속 작업 기록 확인 |
| 삭제 추적 | 새 일반 백업에서 없어진 자원도 **리소스별 최신 검증된 일반 백업** 뷰에 유지됨. 실제 UI 백업 후 보호 행 6개와 삭제 행 유지 확인 |
| 형상 비교 | 화면 캡처 당시 검토 기준에 동일 1·위험 2·구성 변경 1·경미 1. 마지막 재조회에서는 추가 VNet 참조 변경을 감지해 위험 3·구성 변경 1·경미 1로 갱신됨. 비교 시각과 실제 차이를 표시 |
| Activity Log | 해당 기간의 최신 성공 관리 작업 표시. NSG 규칙/RT 경로/VNet subnet 자식 작업의 부모 대응과 형제·진단 작업 제외도 회귀 테스트 |
| 실제 Workspace | 브라우저의 `LAB-UI` 티켓 조회 **13건**, 조회/송신 원천 구분. 실제 dynamic `Details`의 JSON 문자열을 해석함 |
| 보고서 | UI에서 다운로드한 JSON의 SHA-256 일치, 자원 5개·작업 21개·관측 구간·티켓·데이터 평면 제외 확인 |
| 반응형 | 네 화면 × 320·390·768·1024·1440px = **20개 폭 검증**. 페이지 전체 가로 넘침 없음, 큰 표의 내부 스크롤 유지 |
| 접근성 주요 동작 | TreeGrid 키보드 이동/펼침·단일 선택, 메뉴 `inert`/Escape, 종류 체크박스 재렌더 뒤 포커스 보존, 색+텍스트/아이콘 |
| 범위/실패 가드 | 다른 RG/구독, 미지원 유형, 불완전/변조, 403/프로비저닝 중, 새 대상 존재/업데이트 대상 부재, 검토 후 변경, 만료/API 변경, NoChange, 안전 백업/로그 실패, 일회 계획 재사용 차단 |

보고서/메타데이터와 실험 설정·백업은 Git에 넣지 않는 `.armbackup-lab`에 있다. 화면 캡처는 [MSP 화면 설계](comparison-ui.md)에 연결했다. 전체 접근성 인증·모든 브라우저·대량 부하 적합성을 보장하는 검증은 아니다.

### 사설 Blob·관리 ID 종단간 검증

PC의 Blob GET이 403으로 실패했다. 실제 ARM 설정은 `publicNetworkAccess: Disabled`, Activity Log에는 정책 `modify/action`이 관측됐다. **구독 정책을 완화하거나 예외를 만들지 않았다.** PC 콘솔에는 로컬 디스크 원천을 명시했고, 아래 별도 경로로 실제 Blob을 검증했다.

[verify_private_lab.py](../scripts/verify_private_lab.py)는 같은 RG의 일시 VNet/PE/DNS·ACI·관리 ID를 사용했다.

- Private DNS만 허용하는 기존 검사와 실제 Blob container preflight 통과.
- 관리 ID로 **4개 자원의 원본·명세·완료 표식** 저장·검증.
- 복원 직전 원본 1개와 신규 대상 부재 기록을 별도 Blob에 보관하고 hash/완료 표식 검증.
- NSG 신규 생성 뒤 전체 검토 프로파일 **same**, 로그 송신 **Accepted**.
- 조회 신원은 수집·복원 신원과 분리. 로컬 조회 신원이 해당 계획의 안전 백업·복원 완료를 포함한 **3개 실제 Workspace 이벤트** 확인.
- 시험 복제본 삭제 확인. 임시 **ACI·NAT·공용 IP·PE·DNS link/zone·러너 신원과 역할 할당** 정리.

이 성공은 **사설 ACI 경로**의 증거이며 App Service VNet Integration/WebJob이나 KT 사설망에서 시험한 결과가 아니다. PC의 디스크 저장도 사설 Blob 검증을 대신하지 않는다.

### 반복 중 찾고 수정한 문제

1. **Storage 공용 접근 차단:** 정책과 Resource Health/권한을 분리해 확인하고 정책을 유지했다. 명시적 디스크 LAB과 사설 검증 경로를 구분했다.
2. **Private DNS 생성 직후 GET 404:** 나중의 정상 GET을 확인한 뒤 생성 대기에만 제한된 재조회 적용. 일반 형상 조회의 403을 삭제로 바꾸지 않았다.
3. **러너 명령 길이/정리 순서:** Linux argument 크기 오류를 재현하고 불필요한 중첩 인코딩을 제거했다. DNS zone group·PE 등 의존 순서로 임시 자원을 정리했다.
4. **관리 ID의 Workspace query 403:** 실패를 숨기지 않았다. 수집·복원 신원에 조회 역할을 넓히는 대신 별도 조회 신원으로 실제 이벤트를 확인했다. 403의 세부 원인을 확정한 것은 아니다.
5. **투영 결과의 입력 별칭:** 투영을 수정하면 메모리의 백업 입력 태그/배열도 바뀌는 재현 테스트가 실패했다. 저장된 원본과 실제 NSG 복원은 일치함을 따로 확인했고, 투영을 독립 복사로 바꿨다. 전체 실험을 재실행해 16개 통과.
6. **최신 단일 run의 삭제 행 소실:** 다음 백업에 없는 자원도 마지막 검증된 일반 백업을 유지하도록 바꿨다. 안전 백업은 기준에서 제외하고 실제 source run ID와 서로 다른 시각을 보존한다. 새 백업 파일을 합성해 저장하지 않는다.
7. **영속 완료/인터럽트 상태:** 완료 기록 저장 전 성공을 반환하지 않으며, 요청만 있고 종료 기록이 없으면 미확인으로 표시한다. 승인 후 만료/API/현재 변화와 안전 원본 readback도 차단한다.
8. **모바일 전체 가로 넘침:** 숨김 접근성 텍스트의 absolute 위치가 스크롤 밖으로 확장되는 문제를 좁혀 확인했다. 표 스크롤을 올바른 containing block으로 만든 뒤 20개 폭과 내부 스크롤을 재검증했다.

### 남겨둔 검토 사례·비용·정리

UI를 다시 검토할 수 있도록 **LAB에만** NSG 규칙 차이·RT 구성 차이·담당 태그 차이·백업된 삭제 자원·이후 생성 자원을 남겼다. 이는 운영 장애가 아니다. `MSP handover baseline`을 선택하면 위 색상 사례를 볼 수 있고, 기본 뷰는 행별 최신 검증된 일반 백업이다.

임시 러너 정리 직후에는 NSG 3개·RT 1개·VNet 1개·Storage·Workspace·DCR, 총 8개를 조회했다. 마지막 재조회에는 소유 태그가 있는 `vnet-msp-lab-workload-nsg-koreacentral`이 추가되어 **9개**다. VNet의 workload subnet NSG 참조가 백업과 달라진 사실도 실제 Diff에 표시됐다. 이 추가 변경의 실행 주체/원인을 추정해 확정하지 않았으며 되돌리지 않았다.

임시 실행/PE/NAT 자원은 없다. Storage의 공용 접근과 shared key는 차단된 상태를 확인했다. **보관/수집 사용량 과금은 남을 수 있으며 실제 청구액을 조회한 것은 아니다.** `expiresOn` 태그는 자동 삭제 예약이 아니다.

보고서를 보관한 뒤 [정리 도구](../scripts/cleanup_lab.py)에 정확한 RG 이름을 입력해 삭제 요청한다. 도구는 소유 변경·비소유 자원·잔존 러너를 확인하고 로컬 기록은 보존한다. 현재 작업에서는 대화형 검토를 위해 RG 전체를 삭제하지 않았다.

## 웹 디자인 프리뷰 추가 검증

| 항목 | 관찰 결과 |
| --- | --- |
| Python 관련 회귀 테스트 | `pytest -q tests\test_webui.py tests\test_restore_package_cli.py` — **31 passed**. 새 HTTP 프리뷰와 기존 CLI/패키징 경계 |
| JS 모델 | `node --test tests\ui-model.test.mjs` — **21 passed**, Node.js 26.13.0 |
| JS 문법 | `node --check src\armbackup\ui_static\app.mjs` 통과 |
| Ruff·mypy | 새 Python 서버·테스트 린트, `mypy src\armbackup\webui.py` strict 통과 |
| wheel | 격리 빌드 성공. 프리뷰 모듈과 HTML/CSS/3개 JS 모듈/SVG 포함 |
| HTTP | 실제 loopback HTTP 200, health의 `azureConnected: false`, 비공개 파일·임의 API 경로 404, 복원 POST 없음 |
| 초기 데이터 | 최종 백업 행 **12개**, 동일 6·위험 2·주요 2·경미 1·미확인 1. 현재에만 있는 자원 1개는 별도 목록 |
| 실제 브라우저 | TreeGrid 접기/펼치기·조상 보존 검색·상태 필터·키보드 이동·단일 선택·속성 차이·403 복원 차단 |
| 대상 설정 | 4단계 계층·상위 부분 선택·개별 Resource 선택·종류·태그 AND·저장/새로고침 보존·미저장 상태 초기화 |
| 예시 복원 | 날짜 선택, 업데이트, 신규 생성, 기존 대상 Create 차단, 최종 확인 전 비활성화, 안전 백업이 적용보다 먼저 저장됨 |
| 실패 경계 | 저장소 용량 오류를 브라우저에서 재현해 미적용·오류 표시 확인. 모델에서 적용 저장 실패·검토 후 변경·다른 탭 변경·불완전/마스킹/API 불일치도 확인 |
| 로그 | 기간/수준/문자열 필터, 빈 결과 안내, 상세·상관관계 ID, 10건 페이지 이동, 기존 DCR 열을 사용하는 KQL 예시 |
| 반응형 | 네 화면에서 320·390·768·1024·1440px 폭, 문서 전체 가로 넘침과 화면 오류 없음. 큰 표는 내부 가로 스크롤 |
| 네트워크 | 프리뷰 정적 파일만 요청. 브라우저의 외부 리소스·Azure API 요청 없음 |

브라우저 검증 중 미저장 설정의 초기화와 `beforeunload` 경고가 충돌하는 현상을 재현해 수정하고 같은 시나리오를 재검증했다. 이 기록은 로컬 예시 동작 검증이다. **실제 Workspace 조회·Activity Log 조회·Blob 안전 백업·ARM 복원·사용자 인증/인가를 검증한 것은 아니다.** 전체 접근성 인증·부하·모든 브라우저 호환성도 별도다. 화면과 실행 방법은 [UI 설계](comparison-ui.md)를 따른다.

아래는 첫 프리뷰 작업 당시의 기록이다. 현재 작업에서는 상단의 전체 178개 suite로 초기 수집기 테스트도 다시 실행했다. 이 표의 과거 부분 테스트 수를 현재 수에 추가 합산하지 않는다.

## 기존 수집기 구현 검증 기록

| 항목 | 관찰 결과 |
| --- | --- |
| 로컬 런타임 | Windows / Python 3.14.6 / 프로젝트 전용 가상환경 |
| pytest | **98 passed** |
| Ruff | 소스·테스트·패키지 스크립트·host 전체 통과 |
| mypy strict | 애플리케이션 소스 11개 파일 오류 없음 |
| compileall | Python 소스·패키지 스크립트·host 문법 검사 통과 |
| pip check | 의존성 충돌 없음 |
| CLI | help와 설정 예제 `validate-config` 실행 성공. Azure 연결 검증은 아님 |
| wheel | `armbackup-0.1.0-py3-none-any.whl` 빌드·11개 모듈 현재 소스 일치 |
| WebJob ZIP | Linux x86_64/Python 3.12용 고정 dependency wheel을 포함해 생성 |
| ZIP binary 검사 | 네이티브 라이브러리 4개 ELF 확인, Windows `.exe/.dll/.pyd` 없음 |
| ZIP 실행 진입점 | `run.sh` LF·실행 권한·예약 설정 확인, 현재 Python 소스 11개 모듈 일치 |
| health host | 실제 로컬 HTTP 200과 설정 파일 경로 404 확인 후 서버 종료 |

재실행 명령은 [README](../README.md)의 테스트 절차를 따른다. Pylance 도구는 활성 편집기 워크스페이스 밖의 새 프로젝트 파일을 인식하지 못해 실행되지 않았고, 이 프로젝트 가상환경의 mypy·compileall·pytest를 검증 근거로 사용했다. **Linux Python 3.12 프로세스에서 직접 실행한 결과는 아니다.**

## 테스트한 경계

- ARG 2,501개 결과의 3페이지 순회, 반복 토큰·중복·총수 변경·페이지 누락·타 구독 ID 거부.
- 구독 접근 누락, 비활성 구독·명시 제외, 안정 API 선택·preview opt-in, 필수 보완 수집 실패.
- 원본·manifest·완료 표식의 SHA-256, 변조 탐지, 원본 저장 실패·수집 일부 실패·로그 전송 실패 시 성공 표식 부재.
- ARM 429/timeout 제한 재시도, 403 재시도 금지, 외부 `nextLink`·인증정보를 포함할 수 있는 오류 본문 노출 방지.
- 사설 IP만 허용하는 Storage DNS 검사, Blob 경로 이탈 방지·덮어쓰기 방지·scope lease 취득/해제.
- DCR 입력 schema·지정 Workspace·linked DCE 확인, 로그를 삭제하는 변환과 잘못된 endpoint 거부.
- NSG·Route Table의 명시적 복원 투영·계획 hash 승인·기존 대상 보호·API 버전 변경 차단·참조 매핑·PUT 후 설정 비교.
- CLI backup 통합 경로, 실패 종료 코드, 배포 패키지의 runtime dependencies·LF·실행 권한·Windows pip console launcher 제외.

Azure API·Blob·Logs Ingestion을 호출하는 테스트는 실제 고객 환경 대신 fake/mock을 사용한다. 따라서 SDK/네트워크/서비스 동작의 live 검증과 구분한다.

## 생성한 배포물

[armbackup-webjob.zip](../dist/armbackup-webjob.zip)은 7,119,686 bytes이며, 이번 생성본의 SHA-256은 다음과 같다. 재빌드하면 ZIP timestamp 등으로 hash가 달라질 수 있다.

```text
ec924925f7728c0a6a0a845183d0e644d1c58b358e90f28a1c3a7dac7f5c47a1
```

실제 `config.json`은 포함하지 않았고 설정 예제만 넣었다. 고객의 실제 값으로 설정한 뒤 `--config` 옵션을 사용해 별도 패키지를 만들어야 한다. 자격증명은 구성에 넣지 않는다.

## 고객 환경의 미완료 검증

1. 실제 구독·Plan·Python 런타임·Always On·SCM private 배포 가능성.
2. 실제 WebJob 프로세스의 Blob 사설 DNS·PE 경로·관리 ID 쓰기와 lease 갱신.
3. 신원의 기대 구독·ARG·REST 권한·유형별 필수 형상 완전성.
4. 지정 Workspace의 table/DCR/DCE·AMPLS·로그 수신·실제 KQL query 결과.
5. 수집 소요 시간·throttling·로그/스토리지 비용·정시 실행·재시작·다중 예약 충돌.
6. 격리 환경의 create/원위치 변경/clone 시험과 실제 애플리케이션·네트워크 동작.
7. 미지원 유형·보완 설정의 collector/restore adapter, API migration 및 대량 복구 orchestration.

이 초기 수집기 구현 당시에는 Azure 생성/배포/실제 복원을 실행하지 않았다. 현재 승인된 LAB 실험은 상단 기록과 구분한다. 기존 고객 Workspace나 KT 환경은 변경하지 않았으며 내부 지원 계약·KT 운영 승인을 주장하지 않는다.
