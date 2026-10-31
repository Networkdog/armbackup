# armbackup 작업 인수인계 — 대화 맥락과 다음 단계

> 범위: 2026-10-31 워크스페이스 전환 시점의 고객 요구, 사용자 결정, 설계 이유, 구현 상태와 남은 작업. 이 문서와 연결된 프로젝트 문서만으로 이전 대화나 다른 워크스페이스 없이 개발을 이어갈 수 있도록 정리한 내부 인수인계다.

**한 줄 요약** — KT용 형상 백업 초기 구현은 있으며, 실제 환경 검증과 별개로 복원 방식은 아직 미확정이라 숙고·설계가 필요하다.

## 핵심 요약 (3분)

- **최종 목표:** Azure 자원 형상을 매일 보관하고 필요한 시점으로 복구하며, 소량·대량 복제에도 재사용한다. 업무 데이터 평면은 제외한다.
- **사용자 확정:** App Service WebJob + VNet Integration + Storage Account. Discovery는 Resource Graph, 상세 형상은 REST API, 로그는 지정한 Log Analytics Workspace, 언어는 Python이다.
- **필수 제약:** KT에서 Storage Private Endpoint에 접근하지 못하는 실행기는 사용할 수 없다. Automation Cloud 작업은 제외했으며 WebJob이 최종 선택이다.
- **현재 상태:** 구현·한국어 문서·98개 로컬 테스트·타입/린트·wheel·Linux WebJob ZIP이 있다. **Azure 배포·KT 망 접속·실제 복원은 하지 않았다.**
- **가장 중요한 구분:** ARG 조회 결과 ≠ 전체 형상, REST GET 원본 ≠ 쓰기 입력, 수집 완료 ≠ 복구 검증 완료다.
- **복원 미확정:** 사용자는 2026-10-31 08:26 KST에 “복원은 어떤 방식으로 할지 숙고가 필요하다.”고 밝혔다. 현재 NSG·Route Table 코드는 검토용 초안이며 REST adapter 방식의 운영 채택을 확정한 것이 아니다.
- **최신 검토 제안:** 08:29 KST에 신규 생성과 업데이트 구분을 제안했다. [Create-only/Update-only 검토안](restore.md)에 전제·차이 검토·경합·승인 조건을 기록했으나 구현·운영 확정은 아니다.
- **웹 UI 확정 요구:** 08:33의 계층형 비교 표 요구에 이어 08:42 KST에 **개별 리소스 행 Diff의 동일 Green·다름 Red**, **UI의 App Service 호스팅·백업과 동일 App Service Plan**을 결정했다. [TreeGrid 화면·호스팅](comparison-ui.md)을 따르며 **UI·비교 API·비교 엔진은 미구현**이다.
- **첫 후속 작업:** 아래 환경값과 대표 자원을 정하고 실제 WebJob의 사설 DNS→Blob 쓰기→ARG/REST→지정 Workspace 로그를 검증한다. 예제 값을 실제 고객 값으로 오인하지 않는다.

상세 근거는 [아키텍처](architecture.md), [설정](configuration.md), [배포](deployment.md), [복원](restore.md), [이전 구현의 검증 기록](validation.md)에 있다. 이 요약은 2026-10-31 구현·대화의 스냅샷이지 고객 운영 승인이나 서비스 지원 보증이 아니다.

## 1. 과제의 배경과 실체

고객은 KT다. 최초 요청은 **Azure 관리 평면 형상을 일일 백업하고, 백업 시점의 형상으로 복구/복원하며, 필요하면 소량·대량 복제에도 쓰는 솔루션**이었다. 데이터베이스 내용·VM 디스크/OS/파일·애플리케이션 업무 데이터까지 백업하는 요청은 아니었다.

실체는 관리 API의 응답을 모으는 Python 수집기, 원본/명세를 보관하는 Blob, 이를 예약 실행하는 App Service WebJob, 실행 로그를 받는 Log Analytics의 조합이다. ≈ 서버 이미지 백업보다는 **설정 기록 + 검증된 재설치 절차**에 가깝다. “백업 파일을 만들었다”는 사실과 “그 파일로 정상 서비스까지 복구했다”는 사실을 분리하려는 설계다.

이 프로젝트의 실행·범위 정본은 [README](../README.md)와 [아키텍처](architecture.md)다. 이전 CSA 지식 워크스페이스의 운영 Q&A에도 논의를 정리했으나, 여기서 작업을 이어갈 때 그 저장소를 열어야 하는 의존성은 두지 않는다.

## 2. 사용자가 정한 것과 구현자가 선택한 기본값

### 2.1 사용자 확정 사항

| 구분 | 확정 내용 |
| --- | --- |
| 업무 목적 | 매일 관리 평면 형상 백업, 필요 시 복구/복원, 소량·대량 복제 |
| 제외 범위 | 업무 데이터 평면 |
| 네트워크 | Storage Account Private Endpoint 접근 필수 |
| 실행기 | App Service WebJob |
| 사설 연결 | App Service VNet Integration |
| 형상 저장 | Storage Account의 Blob 보관 |
| 대상 발견 | Azure Resource Graph |
| 상세 수집 | REST API |
| 로그 목적지 | 사용자가 지정할 Log Analytics Workspace |
| 웹 인터페이스 추가 요구 | 개별 리소스 행의 계층형 expand/collapse 비교. Diff 동일 Green·다름 Red |
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
| 현재 복원 초안 유형 | NSG, Route Table. 복원 방식 미확정이며 운영 채택·실행 승인 아님 |

이 표는 [설정 예제](../examples/config.example.json), [프로젝트 설정](../pyproject.toml), [배포 문서](deployment.md), [복원 문서](restore.md)를 요약한다. OS·예약·구체적인 Workspace·SKU·retention·규모별 RTO/RPO는 아직 고객 확정값이 아니다.

**UI 결정과 권장안 구분:** App Service·동일 Plan·리소스별 Green/Red는 사용자 확정이다. 같은 Plan의 별도 백업/UI Web App과 관리 ID 분리는 권장 구성이지 사용자가 앱 수까지 정한 것은 아니다. 별도 앱도 컴퓨트·스케일은 공유하며, UI의 VNet/DNS/인가와 실제 복원 executor는 추가 설계·검증 대상이다.

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

**UI 요구는 별도 후속 범위다.** 현재 웹 host는 health JSON만 제공한다. 사용자 요구인 계층형 비교 표, run 목록 열람, 현재 REST 상세 비교·정규화·인증/인가 API는 아직 없다. 상세 정의와 미선정 사항은 [comparison-ui.md](comparison-ui.md)를 따른다.

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
| 초기 지원 유형·수량·규모 | 미확정. “전 자원 GET 수집”과 “완전 복구 지원 유형”을 구분해야 함 |
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

사용자의 추가 요구는 **개별 리소스 행을 갖는 계층형 백업↔현재 비교 테이블**, **동일 Green·다름 Red**, **App Service UI·동일 App Service Plan 사용**이다. 백업 시점 선택, 펼치기/접기, 양측 합집합과 상세 속성 Diff를 설계한다. 조회 대기·미확인은 Green/Red로 억지 판정하지 않는다. 표시 헤더와 실제 ARM 부모/참조 관계를 구분한다. [UI 요구·호스팅](comparison-ui.md)의 별도 앱/신원 분리·읽기 전용 초기 범위·대량 처리·인가·인수 기준은 권장안이며 아직 코드나 화면으로 구현하지 않았다.

**지원 adapter를 늘리기 전에 복원 방식 자체를 별도로 검토한다.** 사용자 최신 의견에 따라 기존 자원 설정 원복·삭제 자원 재생성·별도 환경 복제의 요구를 나누고, 충돌 처리·의존성·권한/비밀·실패와 재개·승인·사후 검증 기준을 먼저 정한다. 현재 REST adapter 방식은 후보/초안일 뿐이며 비교 결과에 따라 대체할 수 있다. [복원 설계 상태](restore.md)를 따른다.

사용자의 추가 제안은 **신규 생성과 업데이트의 명시적 분리**다. Create-only는 target이 있으면 중단, Update-only는 target이 없으면 중단하는 방향을 검토하며 자동 upsert로 섞지 않는다. API 메서드와 모드는 구분하고 Update의 전체 원복/선택 속성 정책과 승인 이후 경합 처리를 정해야 한다. **현재 `--allow-existing`은 엄격한 Update-only가 아니고 이 분리 모드를 구현한 상태도 아니다.** 상세 비교와 공식 근거는 [복원 검토안](restore.md)을 따른다.

유형별로 반드시 복구해야 하는 설정을 정의하고 GET에 없는 필드를 조사한다. 선택한 방식에 맞는 collector·복원 구현·API/스키마 지원 행렬을 마련한 뒤 격리 환경에서 신규 생성·기존 설정 원복·별도 이름 복제를 각각 시험한다. 그 후 의존성 순서·제한 병렬도·참조/주소 매핑·실패 후 재개를 갖춘 대량 작업을 설계한다.

장기 백업은 보존 기간 안의 오래된 입력까지 회귀 시험한다. 서비스 API가 폐기되면 검증된 migration 없이는 자동 복원을 차단한다.

## 7. 아직 해소하지 못한 조사 범위

초기 전체 솔루션 조사에서 Microsoft 내부 Engineering Hub 조회가 `HTTP 403 / VPN REQUIRED`로 실패했다. 후속 기능 설명·구현은 공개 Microsoft Learn 문서와 로컬 테스트에 근거했다. **내부 설계·PG 지원 범위·로드맵·고객 운영 적용까지 확인한 것으로 보고하지 않았다.**

기능 근거를 공개 문서로 확인한 시점은 2026-10-30~31이다. 이번 문서 인수인계에서는 외부 제품 문서를 새로 조회하거나 기능의 최신 지원 상태를 다시 검증한 것은 아니다. 이후 변경이 의심되면 해당 공식 출처와 실제 환경을 재확인한다.

실제 내부 지원 판단이 필요한 별도 작업과, 현재 공개 문서/코드로 설명 가능한 기능을 구분한다. 이 인수인계에는 내부 문서 내용이나 자격증명을 복사하지 않았다.

## 8. 새 대화에서 이어갈 때 사용할 문구

아래 문구는 작업 재개용 예시이며 Azure 변경을 자동 승인하는 의미는 아니다.

> 이 워크스페이스의 README.md와 docs/handoff.md를 먼저 읽고 armbackup 개발을 이어가자. KT용 일일 관리 평면 형상 백업이며 App Service WebJob + VNet Integration + Storage Blob PE, ARG Discovery + ARM REST 상세 수집, 지정 Log Analytics Workspace, Python은 확정이다. 초기 구현과 98개 로컬 테스트가 있지만 실제 Azure 배포·KT PE 접속·복원 검증은 아직 없다. 복원 방식은 미확정이고 NSG/Route Table 구현은 검토용 초안이다. Create-only/Update-only 제안은 docs/restore.md에 있다. UI는 개별 리소스 행의 expand/collapse 비교 표이며 Diff 동일 Green·다름 Red, App Service 호스팅과 백업과 동일 App Service Plan 사용은 확정이다. docs/comparison-ui.md를 읽어라. 별도 앱/관리 ID는 권장안이고 웹 UI·비교 API·엔진은 미구현이다. 사용자 확정과 설계 제안, 수집 완료와 복구 검증을 구분해 이어가자.

원래 대화를 찾지 못하더라도 이 문서의 확정 사항·한계·다음 단계와 연결된 프로젝트 문서를 기준으로 이어갈 수 있다. 새로운 결정·실측이 생기면 해당 상세 문서를 먼저 갱신하고 이 인수인계의 날짜·상태도 함께 갱신한다.
