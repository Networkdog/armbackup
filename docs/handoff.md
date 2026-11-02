# armbackup 작업 인수인계 — 대화 맥락과 다음 단계

> 범위: 2026-10-31 워크스페이스 전환 시점의 고객 요구, 사용자 결정, 설계 이유, 구현 상태와 남은 작업. 이 문서와 연결된 프로젝트 문서만으로 이전 대화나 다른 워크스페이스 없이 개발을 이어갈 수 있도록 정리한 내부 인수인계다.

**한 줄 요약** — MSP LAB 콘솔은 변경 달력·단일/묶음 관계 작업대·전용 프로필·전체 안전 백업·의존 순서 적용을 구현했다. 검증 결과는 [validation.md](validation.md)가 정본이며 KT 운영 적합성은 별도다.

## 후속 현재 상태 — 백업 운영 화면과 호스팅

- 행 음영은 최신 일반 백업 상태, 열 하나는 최근 10일 변경, 시각은 상대시각이다. 체계별/종류별 그룹을 선택한다. Blob의 불변 저장 뷰·완료 표식은 SHA로 검증하고 최신 포인터만 ETag로 교체한다. 5분이 지나도 읽기 전용 저장본을 먼저 표시하며 서버 공용 백그라운드 갱신 후 실행 잠금을 해제한다. 시작 시·5분마다 수집하며 DB는 사용하지 않는다.
- 승인 LAB의 Linux B1 App Service·사설 Blob PE/DNS·관리 ID 역할은 실제 배포했다. 지정 운영자의 Entra 로그인을 연결하며 구독 Reader와 기존 LAB RG만 Contributor를 부여한다. 로컬 모드와 인증된 `--hosted`를 구분한다.
- main push는 별도 OIDC 신원으로 앱을 배포한다. 예약 WebJob 패키지는 UI ZIP과 별개다. 아래의 2026-10-31 스냅샷에서 “호스팅 없음”으로 남은 항목은 이 후속 상태보다 이전 기록이다. 최신 실행 결과와 인증 후 미검증 범위는 [검증 정본](validation.md), 권한/비용/배포 변수는 [배포 문서](deployment.md)를 따른다.

## 최신 복합 자원·작업대 구현

가장 최근 전체 Gateway 검증은 고정 사설 IP VM 백엔드에서 **12개 단계·35개 HTTP**, 성공 job 4개/안전 run 3개/14개 Healthy backend를 확인했다. 원본과 별도 WAF/PIP/Gateway 복제, 원본 변경에 대한 복제 독립성, 업데이트 복원, 삭제 후 재생성까지 통과했다. 이 과정에서 related PUT의 읽기 전용 변화만 재검증하는 가드를 보완했다. 시험 자원은 정리하고 기존 RG/10개 자원·백업·로그를 유지했으며, 이전 ACI 502 원인은 미확인 이력으로 보존했다. [검증 정본](validation.md).

- 사용자 승인에 따라 같은 소유 LAB RG에서 HTTP Application Gateway/WAF, Standard LB/독립 backend pool, Front Door Standard와 포함 child를 구성했다. 복원은 원래 ARM ID의 create/update를 분리하며 공유·주소 대상·인증서·권한·업무 데이터는 자동 복구하지 않는다.
- [resource_profiles.py](../src/armbackup/resource_profiles.py)와 [생성된 계약](../src/armbackup/resource_profiles.json)은 Network 2024-05-01/CDN 2024-02-01 **14 roots/265 field nodes**와 기존 NSG/RT 투영을 사용한다. AFD Endpoint처럼 자체 태그가 빈 child도 검증된 `ownershipParent` 메타데이터로 소유/고객 태그를 표시하고 원본은 바꾸지 않는다.
- [resource_bundles.py](../src/armbackup/resource_bundles.py)/[bundle_console.py](../src/armbackup/bundle_console.py)는 포함·연관·공유/주소 경계, 최대 50개, 60분·일회 계획, 전체 안전 run, 부모가 만든 확인된 LB placeholder, 모든 child 적용 후 전체 비교와 부분 적용 ID를 관리한다.
- [bundle-panel.mjs](../src/armbackup/ui_static/bundle-panel.mjs)는 전체 폭의 선택 목록/관계 검사기·픽토그램·짧은 절차·승인/로그 흐름이다. 신규 복합 유형은 기존 NSG/RT 마법사로 보내지 않는다. Gateway 아이콘은 ARM backendhealth LRO와 지정 Workspace WAF/접속 진단을 연결한다.
- [provision_complex_lab.py](../scripts/provision_complex_lab.py), [exercise_complex_lab.py](../scripts/exercise_complex_lab.py), [cleanup_complex_lab.py](../scripts/cleanup_complex_lab.py)가 재현 도구다. 마지막 도구는 기록된 소유 `abx-` root와 검증한 사설 VM disk만 정리하며 RG 전체를 삭제하지 않는다. 실제 결과·실패/재개·정리 증거는 Git 제외 LAB 기록에 둔다.
- 복합 **13개 삭제/재생성·전체 형상 일치·6개 HTTP 기능**, 실제 작업대의 NSG 백업/안전 복원/Workspace 7건, **42개 반응형 폭**을 확인했다. 과금 `abx-` 자원·disk를 정리했으며 기존 RG/백업/로그/비소유 topic은 유지했다. 마지막 전체 Python 242개/JS 51개·lint/strict 20개와 wheel 결과는 [validation.md](validation.md)를 따른다.

아래의 초기 결정·운영 검토 기록은 위 LAB의 후속 구현/승인과 구분한다. 기존 NSG/RT CLI를 일반 대량 복구·교차 환경 복제로 확대한 것은 아니다.

## 핵심 요약 (3분)

- **최종 목표·최신 우선순위:** Azure 형상을 일일 보관·복구·복제한다. 23:07 KST의 KT Cloud 고객 설명에 따라 **Application Gateway + WAF·Load Balancer·Front Door·Route Table·NSG처럼 재구성이 어려운 설정 중심**으로 우선한다. 단순 자원은 필수가 아닐 수 있지만 의존성은 검토한다. 업무 데이터 평면 제외는 유지한다. [대상 선정](target-selection.md).
- **사용자 확정:** App Service WebJob + VNet Integration + Storage Account. Discovery는 Resource Graph, 상세 형상은 REST API, 로그는 지정한 Log Analytics Workspace, 언어는 Python이다.
- **필수 제약:** KT에서 Storage Private Endpoint에 접근하지 못하는 실행기는 사용할 수 없다. Automation Cloud 작업은 제외했으며 WebJob이 최종 선택이다.
- **현재 상태:** 초기 수집기와 문서·패키지에 더해 실제 Azure 단일 RG LAB 콘솔을 구현했다. ARM·Activity Log·Workspace 조회, 실제 사설 Blob·관리 ID 백업·안전 백업·NSG 신규 복원은 검증했다. **KT 망·App Service/WebJob 호스팅·일반 운영 복원은 아직 검증하지 않았다.** 최신 테스트 수와 반복 실험은 [검증 기록](validation.md)을 정본으로 삼는다.
- **가장 중요한 구분:** ARG 조회 결과 ≠ 전체 형상, REST GET 원본 ≠ 쓰기 입력, 수집 완료 ≠ 복구 검증 완료다.
- **복원 미확정:** 사용자는 2026-10-31 08:26 KST에 “복원은 어떤 방식으로 할지 숙고가 필요하다.”고 밝혔다. 현재 NSG·Route Table 코드는 검토용 초안이며 REST adapter 방식의 운영 채택을 확정한 것이 아니다.
- **최신 검토 제안:** 08:29 KST에 신규 생성과 업데이트 구분을 제안했다. [Create-only/Update-only 검토안](restore.md)에 전제·차이 검토·경합·승인 조건을 기록했으나 구현·운영 확정은 아니다.
- **웹 UI 최신 요구·구현:** 네 화면·Green/Red/Orange/Yellow·안전 백업 흐름과 별도 `--live-config` LAB 모드를 구현했다. 11:09 KST에 사용자가 새 테스트 RG 안의 생성/삭제/변경을 승인했다. MSP 당직·변경 검토·백업 운영·감사 업무 필터, 고객 태그·시간대·티켓·서버 계획·보고서를 제공한다. 실제 고객별 인증/테넌트와 운영 호스팅은 미구현이다. [화면·실행·경계](comparison-ui.md)를 따른다. App Service·동일 Plan 결정은 유지한다.
- **첫 후속 작업:** 아래 환경값과 대표 자원을 정하고 실제 WebJob의 사설 DNS→Blob 쓰기→ARG/REST→지정 Workspace 로그를 검증한다. 예제 값을 실제 고객 값으로 오인하지 않는다.

상세 근거는 [아키텍처](architecture.md), [설정](configuration.md), [배포](deployment.md), [복원](restore.md), [이전 구현의 검증 기록](validation.md)에 있다. 이 요약은 2026-10-31 구현·대화의 스냅샷이지 고객 운영 승인이나 서비스 지원 보증이 아니다.

## 1. 과제의 배경과 실체

고객은 KT다. 최초 요청은 **Azure 관리 평면 형상을 일일 백업하고, 백업 시점의 형상으로 복구/복원하며, 필요하면 소량·대량 복제에도 쓰는 솔루션**이었다. 데이터베이스 내용·VM 디스크/OS/파일·애플리케이션 업무 데이터까지 백업하는 요청은 아니었다.

최신 사용자 설명은 **KT Cloud 고객의 복잡한 설정·긴 재구성 시간 문제**를 중심으로 대상 선정 목적을 구체화했다. 모든 유형의 빈 자원 생성을 재현하는 도구보다 Application Gateway + WAF, Load Balancer, Front Door, Route Table, Network Security Group의 필요한 형상을 재현하는 데 우선 가치를 둔다. 이는 해당 다섯 유형의 운영 복원이 이미 지원된다는 뜻이 아니다. [현재 지원과 후속 선정 기준](target-selection.md)을 따른다.

실체는 관리 API의 응답을 모으는 Python 수집기, 원본/명세를 보관하는 Blob, 이를 예약 실행하는 App Service WebJob, 실행 로그를 받는 Log Analytics의 조합이다. ≈ 서버 이미지 백업보다는 **설정 기록 + 검증된 재설치 절차**에 가깝다. “백업 파일을 만들었다”는 사실과 “그 파일로 정상 서비스까지 복구했다”는 사실을 분리하려는 설계다.

이 프로젝트의 실행·범위 정본은 [README](../README.md)와 [아키텍처](architecture.md)다. 이전 CSA 지식 워크스페이스의 운영 Q&A에도 논의를 정리했으나, 여기서 작업을 이어갈 때 그 저장소를 열어야 하는 의존성은 두지 않는다.

## 2. 사용자가 정한 것과 구현자가 선택한 기본값

### 2.1 사용자 확정 사항

| 구분 | 확정 내용 |
| --- | --- |
| 업무 목적 | 매일 관리 평면 형상 백업, 필요 시 복구/복원, 소량·대량 복제 |
| 우선 대상 선정 목적 | 재구성이 복잡·오래 걸리는 설정 중심. Application Gateway + WAF, Load Balancer, Front Door, Route Table, NSG 우선 후보 |
| 제외 범위 | 업무 데이터 평면 |
| 네트워크 | Storage Account Private Endpoint 접근 필수 |
| 실행기 | App Service WebJob |
| 사설 연결 | App Service VNet Integration |
| 형상 저장 | Storage Account의 Blob 보관 |
| 대상 발견 | Azure Resource Graph |
| 상세 수집 | REST API |
| 로그 목적지 | 사용자가 지정할 Log Analytics Workspace |
| 웹 인터페이스 추가 요구 | 대상 설정·TreeGrid 현황·날짜별 복원·로그. 동일 Green·차이 Red/Orange/Yellow. 복원 전 현재 안전 백업 |
| UI 호스팅 | App Service 사용, 백업 WebJob 실행기와 동일 App Service Plan 이용 |
| 언어·위치 | Python, `D:\Workspaces\armbackup` |
| 산출물 | 실제 코드·테스트와 문서화 |

최종 결정의 사용자 원문은 다음과 같다.

> 그러면 App Service의 WebJob, VNet Integration, Storage Account를 사용하는 것으로 정하자. 전체 Discovery를 Resource Graph로 하고, 상세한 형상은 REST API로 파악하고, 로그는 지정한 Log Analytics workspace에 저장하는 것으로 하자.
>
> 구현은 Python으로
>
> D:\Workspaces\armbackup 워크스페이스에 해줘. 문서화 필요.

이는 구독·리소스·권한의 실제 생성/변경이나 프로덕션 복원까지 이미 승인·완료됐다는 뜻은 아니다.

### 2.2 현재 구현의 기본값 — 별도 고객 합의로 오인하지 말 것

| 항목 | 현재 구현 선택 |
| --- | --- |
| 배포 OS·런타임 | Linux x86_64 / Python 3.12 코드 기반 App Service |
| Python 소스 하한 | Python 3.11+ |
| 로컬 검증 환경 | Windows / Python 3.14.6 / 프로젝트 전용 가상환경 |
| 예약 | UTC 17:00, 즉 다음 날 KST 02:00 |
| 인증 | 기본 managed identity, 로컬 개발만 명시적 Azure CLI 인증 |
| 로그 전송 | Logs Ingestion API + DCR, 필요 시 DCE + AMPLS |
| 로그 테이블/stream | 권장 `ArmBackup_CL` / `Custom-ArmBackup` |
| 병렬도·재시도 | workers 4, retries 4, read timeout 60초 |
| 클라우드 범위 | Azure public cloud 엔드포인트만 지원 |
| 기본 리전 검토 | 별도 지정 없을 때 Korea Central을 검토하되 지원·quota는 아직 미확인 |
| 현재 복원 범위 | [검토된 단일/묶음 LAB 프로필](restore.md). 일반 운영 채택·교차 환경 복제·KT 적합성은 별도 |

이 표는 [설정 예제](../examples/config.example.json), [프로젝트 설정](../pyproject.toml), [배포 문서](deployment.md), [복원 문서](restore.md)를 요약한다. OS·예약·구체적인 Workspace·SKU·retention·규모별 RTO/RPO는 아직 고객 확정값이 아니다.

**UI 결정과 권장안 구분:** App Service·동일 Plan과 최신 Green/Red/Orange/Yellow 요구는 사용자 확정이다. 세 차이 색상의 구체적 위험 분류는 프리뷰 제안이다. 같은 Plan의 별도 백업/UI Web App과 관리 ID 분리는 권장 구성이지 사용자가 앱 수까지 정한 것은 아니다. 별도 앱도 컴퓨트·스케일은 공유하며, UI의 VNet/DNS/인가와 실제 복원 executor는 추가 설계·검증 대상이다.

## 3. 여기까지의 설계 판단과 선택 이유

### 3.1 ARG는 Discovery, REST는 상세 수집으로 분리

ARG는 구독을 가로지르는 대량 조회에 유리하지만 비동기 색인이고 지원 유형·사용 API 버전·PII 제거의 제약이 있다. 따라서 ARG JSON만 저장해 전체 관리 형상을 복원할 수 있다고 보지 않았다.

리소스 ID를 찾은 뒤 해당 Resource Provider의 REST GET을 호출하고, 필요한 하위/별도 설정은 보완 collector로 수집한다. **GET 원본도 PUT 입력은 아니므로 복원은 유형별 변환과 검증을 거친다.** 자동 ARM Export로 바꾸는 것만으로 운영용 재배포를 보장하지도 않는다. (근거: [ARG 개요](https://learn.microsoft.com/azure/governance/resource-graph/overview), [지원 유형/PII](https://learn.microsoft.com/azure/governance/resource-graph/reference/supported-tables-resources), [Export 제한](https://learn.microsoft.com/azure/azure-resource-manager/templates/export-template-portal))

현재 “전체 Discovery”의 정확한 뜻은 **신원에 보이는 Enabled 구독의 지원 테이블**이다. Entra 객체·관리그룹/테넌트 수준 객체·권한으로 보이지 않는 자원까지 자동 전수 수집한다는 뜻은 아니다. 구독 범위를 ARM으로 확인하는 것과 자원 Discovery를 ARG로 수행하는 것은 함께 사용한다.

### 3.2 API 버전은 “복원 시 최신으로 자동 교체”하지 않음

백업 시점과 복원 시점의 최신 API 버전이 달라지는 문제를 논의했다.

- 원본, 실제 수집 API, 자체 백업 schema, 복원 API, 변환기 버전을 구분한다.
- 지원 중이고 동작을 검증한 복원 API는 유지할 수 있다. 새 버전이 있다는 이유만으로 문자열만 바꾸지 않는다.
- 폐기·제한·필수 설정 변화가 있으면 명시적 migration adapter와 과거 백업 회귀 시험이 필요하다.
- 과거 백업에 없던 값을 현재 자원이나 새 API의 기본값에서 얻어 과거 값으로 날조하지 않는다.
- ARG Query API 버전은 원본 Resource Provider 수집 API 버전이 아니다.

**현재 코드는 cross-version migration을 구현하지 않았으며 버전 불일치를 차단한다.** 이 제한을 “API 버전 문제를 해결했다”로 표현하지 않는다. (근거: [ARM API 버전 권고](https://learn.microsoft.com/azure/azure-resource-manager/templates/best-practices#api-version), [실제 API 폐기 사례](https://learn.microsoft.com/azure/api-management/breaking-changes/api-version-retirement-sep-2023), [복원 제한](restore.md))

### 3.3 Automation에서 WebJob으로 결정한 이유

처음에는 일일 수집 실행기로 Automation Runbook을 검토했다. 그러나 사용자는 **Storage PE 접근이 안 되면 KT에서 사용할 수 없다**고 명확히 했다.

Automation의 Cloud 작업은 PE 전용 Storage 접근에 맞지 않는다. Hybrid Runbook Worker는 가능한 대안이지만 Worker 호스트를 운영해야 한다. 이후 사용자가 **App Service WebJob + VNet Integration**을 최종 선택했다. 현재 이를 다시 Automation으로 바꾸는 작업은 요청하지 않았다. (근거: [Automation 사설 연결 제한](https://learn.microsoft.com/azure/automation/how-to/private-link-security))

WebJob은 부모 App Service와 같은 실행 환경을 사용하고 VNet Integration으로 Blob PE에 접근하는 설계다. App Service PE는 인바운드이고 VNet Integration은 아웃바운드다. PE만 붙여서는 Blob 연결이 해결되지 않는다.

Always On, 사설 DNS, NSG/UDR/방화벽, SCM 배포 경로가 필요하다. WebJob 자체의 별도 요금이 없다는 것은 새 App Service Plan이 무료라는 뜻이 아니다. 기존 Plan을 공유하면 업무 앱과 CPU·메모리·스케일도 공유한다. (근거: [WebJobs](https://learn.microsoft.com/azure/app-service/overview-webjobs), [VNet Integration](https://learn.microsoft.com/azure/app-service/overview-vnet-integration), [Plan](https://learn.microsoft.com/azure/app-service/overview-hosting-plans))

### 3.4 로그는 지정 Workspace에 실제로 연결되는지 확인

Workspace GUID만 받는 방식이 아니라 Workspace ARM ID, DCR ARM ID, immutable ID, stream, ingestion endpoint를 명시한다. 앱이 DCR schema·destination·endpoint를 사전 확인하고 SDK로 전송한다.

사설 로그 경로까지 요구하면 linked DCE + AMPLS/PE/DNS가 필요하다. **로그도 사설 전용이어야 하는지는 아직 별도 확인 대상**이다. 전송 API가 수신했다고 해서 즉시 LA query에 나타났거나 영구 보관됐다고 단정하지 않는다. (근거: [Logs Ingestion API](https://learn.microsoft.com/azure/azure-monitor/logs/logs-ingestion-api-overview))

## 4. 구현 상태와 파일 지도

| 책임 | 실제 파일 |
| --- | --- |
| CLI·명령/종료 코드 | [cli.py](../src/armbackup/cli.py) |
| 설정 검증·보완 GET 프로필 | [config.py](../src/armbackup/config.py) |
| JSON·예외·인증·공통 계약 | [contracts.py](../src/armbackup/contracts.py) |
| ARM HTTP·재시도·URL 검증·list 페이지 | [http.py](../src/armbackup/http.py) |
| 구독/ARG Discovery·API resolver | [discovery.py](../src/armbackup/discovery.py) |
| 수집 조정·manifest·완료 표식 | [backup.py](../src/armbackup/backup.py) |
| 사설 DNS·Blob·lease | [archive.py](../src/armbackup/archive.py) |
| DCR 확인·구조화 로그 수신 API | [events.py](../src/armbackup/events.py) |
| NSG/Route Table 계획·적용·검증 | [restore.py](../src/armbackup/restore.py) |
| Linux ZIP 빌더 | [package_webjob.py](../scripts/package_webjob.py) |
| 실행·예약·최소 host | [webjob 폴더](../webjob) |
| 설정과 로그 schema 예제 | [examples 폴더](../examples) |
| 단위/통합 대체 테스트 | [tests 폴더](../tests) |
| 의존성·개발 도구 | [pyproject.toml](../pyproject.toml), [requirements.txt](../requirements.txt) |

현재 CLI는 `validate-config`, `backup`, `restore-plan`, `restore-apply`다. `--config`는 하위 명령보다 앞에 두며 환경 변수는 `ARMBACKUP_CONFIG`다. 기본 managed identity 실패를 CLI/다른 credential로 조용히 우회하지 않는다.

**예시·LAB·운영을 구분한다.** `python -m armbackup.webui --port 8080`은 예시 프리뷰다. `--live-config .armbackup-lab\console.local.json --port 8081`은 실제 ARM/Activity Log/Workspace와 제한된 복원에 연결한다. 공용 Storage를 막는 정책을 완화하지 않았으며 PC 콘솔의 명시적 디스크 원천과 별도 사설 Blob/관리 ID 검증을 분리했다. 기존 WebJob host는 health JSON만 제공한다. 운영 UI·사용자별 인가·호스팅은 후속 범위이며 CLI에는 자동 안전 백업/새 모드 옵션을 추가하지 않았다. [comparison-ui.md](comparison-ui.md)를 따른다.

### 수집 완료 계약

- 원본은 실행별 Blob에 보관하고 덮어쓰지 않는다. manifest에 API 버전·성공/실패·제외·파일 hash를 기록한다.
- 동일 container/prefix의 예약은 lease로 직렬화한다.
- ARG 잘림·반복 토큰·총수 변경·필수 GET/보완 수집 실패를 성공 처리하지 않는다.
- **유효한 manifest + `COMPLETE.json`이 있어야 운영 완료다.** 필수 실패나 로그 전송 실패 시 완료 표식을 만들지 않는다.
- `Captured`는 선언한 수집 범위의 성공이지 모든 관리 설정/복구의 검증 완료가 아니다. 저장 원본은 `restoreStatus: Unverified`다.
- `/health`는 host 생존 확인이고 오늘 백업의 성공 판정이 아니다.
- SHA-256은 서명·변조 방지 보존·별도 권한 통제를 대체하지 않는다.

### 아직 없는 기능

- 모든 Azure 서비스의 숨은 설정 자동 발견·전용 collector·유형별 완전성 카탈로그.
- 범용 재배포, cross-version migration, 모든 하위/확장 설정의 복원.
- NSG의 NIC/subnet attachment, Route Table subnet 연결, RBAC/진단 설정까지 포함한 통합 복구.
- 대량 복구/복제 orchestration·의존성 그래프·전체 rollback.
- 자동 인프라 생성·권한 부여·기존 Workspace/DCR 변경.
- KT 실제 환경의 수집 규모·시간·성공률·복원 성공률 검증.

대량 복구/복제는 **장기 요구**로 남아 있으며 현재 NSG/Route Table CLI를 그 완성품으로 표현하지 않는다. 로그 수신이 배포 후 실패하면 `restore-apply`가 실패해도 실제 자원 변경은 이미 일어났을 수 있다. 재시도 전 실제 상태를 확인한다.

## 5. 현재 로컬 환경과 검증 기준선

작업 경로는 `D:\Workspaces\armbackup`이다. 기존 `.venv`가 있으므로 먼저 재사용하고, 이 문서를 읽었다는 이유만으로 의존성 재설치나 Azure 로그인을 할 필요는 없다. 프로젝트 폴더에 `.git`은 없으며 이전 구현 작업에서 Git 초기화·commit·push를 수행하지 않았다.

이전 구현 단계의 실제 검증 기록은 [validation.md](validation.md)에 있다.

| 항목 | 이전 구현 단계의 결과 |
| --- | --- |
| pytest | 98 passed |
| Ruff | 소스·테스트·스크립트·host 통과 |
| mypy strict | 애플리케이션 소스 11개 파일 통과 |
| 추가 검사 | compileall, pip check, CLI help·설정 예제 검사 통과 |
| 패키지 | wheel·ZIP의 소스 11개 모듈 일치, Linux ELF 4개, Windows binary 없음 |
| 실행 환경의 한계 | Windows Python 3.14.6에서 테스트. Linux Python 3.12 프로세스 직접 실행은 미검증 |

Pylance는 이전 세션의 활성 워크스페이스 밖에 있는 새 프로젝트를 인식하지 못했다. 새 워크스페이스에서는 interpreter를 이 프로젝트 가상환경으로 선택하고 다시 확인할 수 있다. Pylance 검증을 통과했다고 이전 기록을 바꾸지는 않는다.

패키지 생성 도중 Windows pip가 Linux wheel 설치에도 Windows console launcher를 만드는 문제가 발견됐다. 빌더가 불필요한 dependency `bin`을 제외하고 다른 Windows binary는 거부하도록 수정·시험했다. shell LF와 실행 권한도 ZIP에서 확인했다. 단순히 Windows 가상환경을 통째로 ZIP에 복사하는 방식으로 바꾸지 않는다.

### 안전한 로컬 확인 명령

```powershell
Set-Location D:\Workspaces\armbackup
.\.venv\Scripts\python.exe -m armbackup --config examples\config.example.json validate-config
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check src tests scripts webjob
.\.venv\Scripts\python.exe -m mypy src
```

위 명령은 예제 검증과 로컬 테스트이며 실제 Azure 연결/권한을 확인하지 않는다. **이번 인수인계는 문서 추가 작업이고 애플리케이션 테스트 결과를 새 live 검증으로 승격하지 않는다.**

### 기존 산출물과 다음 빌드

[WebJob ZIP](../dist/armbackup-webjob.zip)과 [wheel](../dist/armbackup-0.1.0-py3-none-any.whl)이 있다. 정확한 hash는 [기존 검증 기록](validation.md)의 스냅샷을 따른다. **ZIP에는 고객의 실제 `config.json`이 없고 예제만 있다.**

실제 환경값을 준비한 후 새 이름으로 생성한다. 기존 출력 파일은 빌더가 덮어쓰지 않는다.

```powershell
.\.venv\Scripts\python.exe scripts\package_webjob.py `
  --output dist\armbackup-webjob-configured.zip --python-version 3.12 --config config.json
```

`--without-dependencies`는 테스트/소스 확인용이며 그대로 운영 배포하지 않는다. Linux의 실행 경로·Startup command·`ARMBACKUP_CONFIG`는 [배포 문서](deployment.md)에 있다.

## 6. 다음 작업의 우선순위

### P0. 환경·범위 값을 먼저 확정

| 필요한 입력 | 현재 상태 |
| --- | --- |
| tenant·subscription·예상 자원 범위 | 실제 값 미제공. 자동 탐색이 기대 범위 전체인지 대조 필요 |
| 초기 지원 유형·수량·규모 | 주요 후보는 Application Gateway + WAF·Load Balancer·Front Door·Route Table·NSG. 정확한 순서·필수 형상·수량·의존 대상은 미확정. 현재 LAB 지원과 구분 |
| App Service Plan·Web App·OS/SKU | UI와 백업은 동일 Plan 사용 확정. 실제 Plan/앱 ID·앱 수·공유 용량·런타임/SKU는 미확정 |
| VNet·integration subnet·Blob PE·DNS·라우팅 | 실제 값/접속 미검증 |
| Storage Account·container·retention·불변 보존 | 실제 값과 운영 정책 미확정 |
| 지정 Workspace ARM ID·table·DCR·endpoint | 실제 값 미제공. 예제의 0 UUID/`replace...`는 실제 자원이 아님 |
| 로그도 사설 전용인지 | 미확정. 필요하면 DCE/AMPLS 경로 준비 |
| 관리 ID와 최소권한·복원 별도 신원 | 실제 할당 미수행 |
| 실행 시간·형상 RPO·RTO·보관 기간·복구 대상 | 고객 기준 미확정. 일일 실행이 곧 일관된 24시간 RPO 보증은 아님 |

### P1. 실제 WebJob의 좁은 범위 인수 시험

1. 대상 런타임·Always On·SCM private 배포 경로를 확인한다.
2. 실제 WebJob 프로세스에서 표준 Blob FQDN이 PE 사설 IP로 해석되는지 확인한다.
3. 관리 ID로 작은 Blob 쓰기·읽기와 lease를 시험한다.
4. 대표 구독/유형의 ARG 페이지·RP 원본·필수 설정을 대조한다.
5. 지정 Workspace에서 동일 RunId의 로그가 실제 query되는지 확인한다.
6. 완료 manifest/표식과 일부 오류·저장 실패·로그 실패·미실행 경보를 확인한다.
7. 앱 재시작·다중 예약·slot·throttling·수집 시간과 비용을 측정한다.

자동으로 고객 전체 구독에 배포하거나 Contributor를 부여하는 것부터 시작하지 않는다. 네트워크·권한 변경과 운영 배포는 대상·영향·승인을 정한 후 진행한다.

### P2. 웹 비교 UI·복원 설계

**최신 대상 선정 방향:** 복잡한 설정을 재현하는 비용·시간을 기준으로 주요 대상과 필요한 의존/참조 대상을 선정한다. 전체 ARG Discovery를 유지하되 단순 자원은 인벤토리만/승인 제외가 될 수 있다. 기존 정책을 일괄 변경하거나 현재 LAB에 새 유형의 쓰기를 허용한 것은 아니다. [우선 후보·선정 기준](target-selection.md)을 먼저 읽는다.

최신 요구는 [MSP UI 설계](comparison-ui.md)에 반영했다. LAB은 실제 서버 비교·대상 정책·생성/업데이트 계획·안전 백업·Workspace 조회·작업 기록·보고서를 조작한다. 데이터 원천과 한계를 항상 표시하고 예시 모듈로 fallback하지 않는다. 교차 고객/테넌트·별도 앱/신원·대량 처리·사용자별 인가는 운영 후속 범위다.

**지원 adapter를 늘리기 전에 복원 방식 자체를 별도로 검토한다.** 사용자 최신 의견에 따라 기존 자원 설정 원복·삭제 자원 재생성·별도 환경 복제의 요구를 나누고, 충돌 처리·의존성·권한/비밀·실패와 재개·승인·사후 검증 기준을 먼저 정한다. 현재 REST adapter 방식은 후보/초안일 뿐이며 비교 결과에 따라 대체할 수 있다. [복원 설계 상태](restore.md)를 따른다.

LAB 복원은 **명시 모드·티켓/사유·10분 유효 계획·hash/대상 확인·일회 실행·현재 fingerprint·안전 백업 readback/완료 표식·적용 직전 만료/API 검사·사후 비교·영속 결과**를 검증한다. 부재와 미확인·프로비저닝 중을 구분한다. 일반 운영의 선택 속성 원복·RP 원자적 경합 처리는 미결이다. **기존 CLI의 `--allow-existing`은 LAB 승인과 같지 않으며 자동 안전 백업/모드 옵션도 없다.** [복원 경계](restore.md)를 따른다.

유형별로 반드시 복구해야 하는 설정을 정의하고 GET에 없는 필드를 조사한다. 선택한 방식에 맞는 collector·복원 구현·API/스키마 지원 행렬을 마련한 뒤 격리 환경에서 신규 생성·기존 설정 원복·별도 이름 복제를 각각 시험한다. 그 후 의존성 순서·제한 병렬도·참조/주소 매핑·실패 후 재개를 갖춘 대량 작업을 설계한다.

장기 백업은 보존 기간 안의 오래된 입력까지 회귀 시험한다. 서비스 API가 폐기되면 검증된 migration 없이는 자동 복원을 차단한다.

## 7. 아직 해소하지 못한 조사 범위

초기 전체 솔루션 조사에서 Microsoft 내부 Engineering Hub 조회가 `HTTP 403 / VPN REQUIRED`로 실패했다. 후속 기능 설명·구현은 공개 Microsoft Learn 문서와 로컬 테스트에 근거했다. **내부 설계·PG 지원 범위·로드맵·고객 운영 적용까지 확인한 것으로 보고하지 않았다.**

기능 근거를 공개 문서로 확인한 시점은 2026-10-30~31이다. 이번 문서 인수인계에서는 외부 제품 문서를 새로 조회하거나 기능의 최신 지원 상태를 다시 검증한 것은 아니다. 이후 변경이 의심되면 해당 공식 출처와 실제 환경을 재확인한다.

실제 내부 지원 판단이 필요한 별도 작업과, 현재 공개 문서/코드로 설명 가능한 기능을 구분한다. 이 인수인계에는 내부 문서 내용이나 자격증명을 복사하지 않았다.

## 8. 새 대화에서 이어갈 때 사용할 문구

아래 문구는 작업 재개용 예시이며 Azure 변경을 자동 승인하는 의미는 아니다.

> 이 워크스페이스의 README.md와 docs/handoff.md를 읽고 이어가자. 관리 평면 백업·WebJob/VNet/Blob PE·ARG/ARM·지정 Workspace·Python은 유지한다. 最新 목적은 KT Cloud 고객의 복잡하고 재구성 시간이 큰 형상 보존이다. Application Gateway+WAF, Load Balancer, Front Door, Route Table, NSG를 우선 후보로 보고 docs/target-selection.md의 주요/의존/인벤토리 구분을 따르자. 예시 프리뷰는 8080, 단일 소유 RG의 실제 LAB 콘솔은 --live-config .armbackup-lab\console.local.json --port 8081로 실행한다. 실제 ARM·Activity Log·Log Analytics, MSP 업무/고객 필터·티켓·안전 백업·NSG/Route Table 복원·인수인계 보고서를 구현했다. 이 LAB 성공을 새로운 우선 유형의 운영 복구 지원으로 해석하지 말자. 정책을 완화하지 않고 PC의 명시적 디스크 원천과 별도 사설 MI/Blob 검증을 분리했다. 실제 결과·실패/수정·리소스 정리는 docs/validation.md가 정본이다. 운영 다중 사용자/테넌트·App Service 호스팅·KT 환경 검증은 아직 없다. 같은 App Service Plan 요구를 유지하자.

원래 대화를 찾지 못하더라도 이 문서의 확정 사항·한계·다음 단계와 연결된 프로젝트 문서를 기준으로 이어갈 수 있다. 새로운 결정·실측이 생기면 해당 상세 문서를 먼저 갱신하고 이 인수인계의 날짜·상태도 함께 갱신한다.
