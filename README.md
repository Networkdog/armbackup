# armbackup — Azure 관리 평면 형상 백업

> 범위: Python 형상 수집기·예약 WebJob 패키지와 로컬/인증된 App Service MSP 테스트 콘솔. 승인된 테스트 구독 전체에서 검토한 형상을 백업·복원·복제하며 업무 데이터 평면은 백업하지 않는다. 기본 CLI는 인프라를 배포하지 않으며 이전 LAB 전용 실험 스크립트의 정리 가드는 별개다.

**한 줄 요약** — ARG로 대상을 발견하고 ARM REST로 원본 설정을 수집해 사설 Blob에 보관하며, 지정한 Log Analytics Workspace로 실행 로그를 전송한다.

**새 워크스페이스에서 작업을 이어간다면 [대화 맥락·결정·현재 상태·다음 단계 인수인계](docs/handoff.md)를 먼저 읽는다.** 이전 대화나 CSA 지식 워크스페이스 없이 사용할 수 있도록 요구사항과 미검증 항목을 정리했다.

## 실체와 선택 이유

이 프로젝트는 Python CLI와 App Service WebJob 배포 패키지다. App Service Plan에서 실행하며, VNet Integration을 통해 Storage Blob Private Endpoint에 접근한다. Storage Account·App Service·DCR 등은 운영자가 준비한다. “범용 리소스 완전 복구”를 제공하는 Azure Backup 제품이 아니다.

≈ 기존 Automation 수집 스크립트를 App Service 안의 예약 작업으로 옮기는 방식이다. Cloud Runbook과 달리 부모 앱의 VNet Integration을 이용할 수 있지만, Plan 과금·앱 재시작·이름 풀이를 관리해야 한다. AWS의 [ECS scheduled task](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduling_tasks.html)와 예약 배치라는 목적은 비슷하나 WebJob은 부모 앱 컴퓨트를 공유한다. (근거: [WebJobs](https://learn.microsoft.com/azure/app-service/overview-webjobs), [VNet Integration](https://learn.microsoft.com/azure/app-service/overview-vnet-integration))

## 구현 범위

| 구분 | 구현 |
| --- | --- |
| Discovery | 접근 가능한 Enabled 구독의 ARG 조회. Resources·ResourceContainers·AuthorizationResources·PolicyResources를 구독별 페이지 순회 |
| 상세 수집 | 유형별 ARM GET, provider API 버전 검색·명시적 override, 설정한 보완 GET·list의 `nextLink` 순회 |
| 저장 | 기존 Blob container에 원본·Discovery·명세·SHA-256·완료 표식. 덮어쓰기 방지·scope lease·사설 DNS 검사 |
| 로그 | 지정 Workspace를 가리키는 DCR을 사전 확인하고 Logs Ingestion API로 구조화 로그 전송. 전송 실패를 성공 처리하지 않음 |
| 실행 | Python 3.11+ CLI. Linux x86_64/Python 3.12 App Service용 ZIP 빌더·일일 예약·health host |
| 웹 UI | **예시 프리뷰 + 테스트 구독 전체 MSP 콘솔.** 최근 백업 실패/없음/24시간 경과는 빨강, 성공은 초록. 상대시각·10일 변경 열·체계/종류별 보기·원본 Diff·관계 작업대. [범위·화면](docs/comparison-ui.md) |
| 화면 데이터 수집 | 호스팅 웹 프로세스의 수집 스레드가 시작 시·5분마다·작업 종료 시 Blob에 화면 저장본·수집 상태 게시. UI는 저장본만 조회하고 상대 수집 시각 표시. 실패/15분 초과는 마지막 정상 데이터의 읽기 전용 화면 유지. 공개 `/health`의 `collector`로 상태 확인. [배포·운영](docs/operations.md) |
| 복원 | **설정한 단일 구독의 검토된 단일·묶음 형상.** NSG/Route Table, HTTP Application Gateway+WAF, Standard Load Balancer+독립 Pool, Front Door Standard의 포함 설정. LAB 소유 태그 불필요, 구독 확인·의존 순서·전체 안전 백업·일회 승인·사후 비교 유지. [정확한 계약·제한](docs/restore.md) |

**현재 공식 선택 항목은 Application Gateway(WAF_v2·HTTP)와 Load Balancer(Standard·공용 TCP/IP Pool) 두 종류다.** 인벤토리에서 발견한 종류나 이전 검토 프로필 전체를 공식 지원으로 취급하지 않는다. WAF Policy·Public IP·독립 Pool은 주 대상과 함께 수집한다. [지원 프로필·제외·검증 기준](docs/target-selection.md)을 확인한다.

**중요:** Discovery 전체는 “현재 신원에 보이는 구독 범위와 지원 ARG 테이블”을 뜻한다. 테넌트 전체 권한·Entra 객체·관리그룹·데이터·모든 관리 설정의 완전성을 뜻하지 않는다. 리소스 GET에서 빠지는 설정은 유형별 보완 프로필을 추가해야 한다. [범위와 복원 한계](docs/architecture.md), [설정 계약](docs/configuration.md).

## 고객의 우선 백업·복원 대상

KT Cloud 고객의 주요 목적은 **설정이 복잡하고 재구성에 시간이 많이 드는 형상 재현**이다. 우선 후보는 **Application Gateway + WAF, Load Balancer, Front Door, Route Table, Network Security Group**이다. 단순 생성과 간단한 설정으로 충분한 자원은 상세 백업·복원이 필수는 아닐 수 있다.

전체 Discovery와 실제 백업/복원 대상을 구분하며, 단순 자원도 주요 대상의 의존성이면 필요한 설정·참조·재연결 범위를 검토한다. [대상 선정 기준·현재 지원과의 차이](docs/target-selection.md)를 따른다. 콘솔은 검토한 복합 프로필을 추가했지만 일반 CLI의 기본 대상 정책·운영 지원 범위를 자동 확대하지 않는다.

## 로컬 시작

Python 3.11 이상과 별도 가상환경을 사용한다. 아래는 Windows PowerShell이다.

```powershell
Set-Location D:\Workspaces\armbackup
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item examples\config.example.json config.json
.\.venv\Scripts\python.exe -m armbackup --config config.json validate-config
```

실제 subscription·Storage·Workspace·DCR 값을 [설정 예제](examples/config.example.json)에 맞춰 수정한다. 예제의 `replace...`·0 UUID는 실제 환경이 아니다. **구문 검사 통과는 Azure 연결 검증이 아니다.**

개발 PC에서 Azure CLI 로그인 신원을 사용할 때만 `credential`을 `cli`로 바꾼다. 기본값은 `managed_identity`이며 실패 시 다른 인증 방식으로 우회하지 않는다. PE 전용 Storage와 DCR/DCE에 접근 가능한 사내망/배포 에이전트가 필요하다.

```powershell
.\.venv\Scripts\python.exe -m armbackup --config config.json backup
```

백업은 업무 리소스에 PUT/DELETE를 보내지 않는다. Blob 파일·lease와 Log Analytics 로그만 쓴다. 복원은 별도 명령이며 [복원 절차](docs/restore.md)의 명시적 승인이 필요하다.

## 문서 읽는 순서

0. [작업 인수인계·확정 결정·후속 작업](docs/handoff.md)
1. [고객 우선 대상·복잡한 형상 중심 선정 기준](docs/target-selection.md)
1. [아키텍처·수집 완전성](docs/architecture.md)
2. [설정·API 버전·수집 프로필](docs/configuration.md)
3. [웹 UI·계층형 비교 테이블 요구와 설계안](docs/comparison-ui.md)
4. [App Service·VNet·PE·Log Analytics 배포](docs/deployment.md)
5. [실행·경보·실패 처리](docs/operations.md)
6. [안전한 복원·복제와 지원 범위](docs/restore.md)
7. [검증 결과와 미검증 항목](docs/validation.md)

## 웹 인터페이스 디자인 프리뷰

```powershell
.\.venv\Scripts\python.exe -m armbackup.webui --port 8080
```

브라우저에서 **http://127.0.0.1:8080** 을 연다. 별도 웹 패키지·Node 설치 없이 실행한다. 서버는 loopback에만 바인딩하며 **로컬 디자인 검토 전용**이다. 운영 App Service 서버나 사용자 인증을 제공하지 않는다.

예시 리소스·백업·로그를 사용하며 설정과 예시 복원 결과는 이 브라우저의 `localStorage`에만 저장한다. **실제 Azure·Blob·Log Analytics·기존 CLI와 연결하지 않는다.** 복원 마법사는 날짜 선택 → 신규 생성/기존 업데이트 → 절차 확인 → 현재 예시 상태 안전 백업 → 예시 적용·재비교 순서다. 안전 백업 저장에 실패하면 적용하지 않는다. 왼쪽의 **예시 데이터 초기화**로 초기 상태로 되돌릴 수 있다.

[네 화면 설계·운영 연결 경계](docs/comparison-ui.md)와 [검증 기록](docs/validation.md)을 참고한다. 기존 CLI의 복원 안전 정책을 이 프리뷰가 변경한 것은 아니다.

## 실제 Azure에 연결하는 MSP 테스트 콘솔

```powershell
.\.venv\Scripts\python.exe -m armbackup.webui --live-config .armbackup-lab\console.local.json --port 8081
```

**http://127.0.0.1:8081** 에서 확인한다. `--live-config`를 생략하면 위의 예시 프리뷰다. 실환경이 실패했을 때 예시 데이터로 자동 전환하지 않는다. [콘솔 설정 예제](examples/console.example.json)의 기본 `inventory_scope=subscription`은 설정한 **단일 테스트 구독 전체 RG**에서 조회·백업·복원·복제를 허용한다. 별도 LAB RG나 소유 태그는 필요하지 않다. 수집 설정의 RG 하나는 기존 Storage/Workspace/DCR의 위치이며 복구 범위가 아니다. 예제 값과 Workspace GUID는 실제 환경에 맞춘다.

수집 설정에는 NSG·Route Table·VNet의 API 버전을 명시한다. 이번에 검증한 버전은 세 유형 모두 `2024-05-01`이며 다른 버전/새 필드의 지원을 추정하지 않는다. 표시 이름에는 한국어를 사용할 수 있다.

MSP 업무 프리셋은 **당직·장애 대응 / 변경 검토 / 백업 운영 / 감사·인수인계**다. 보안 역할을 부여하는 버튼이 아니라 업무별 필터다. 고객 태그로 범위를 좁히고, 미확인·프로비저닝 중 상태를 형상 차이와 구분한다. 대상 정책은 다음 콘솔 백업에 실제 적용하며 기존 예약 CLI의 설정 파일은 바꾸지 않는다. 구독 안의 모든 RG에서 검토한 형상을 복원할 수 있으며 다른 구독·미지원 유형·이미 있는 신규 대상·없어진 업데이트 대상·검토 후 변경·안전 백업 실패는 차단한다.

**복원**의 첫 화면은 기존 달력 UI를 재사용한 월~일 7행/주 단위 백업 탐색기다. 별도 변경 달력 메뉴는 없으며 1년·6개월·3개월, 고객/종류/검색으로 **날짜 → 실제 보관된 백업·자원 → 복원 검토**를 연결한다. 색은 위험도/변경량이 아니라 백업 자원 수이며, 변경 없는 백업과 명시적 안전 백업도 찾을 수 있다. 일반 백업은 ‘원본 비교’로 이전 보관 형상과 비교할 수 있다. 같은 날짜의 여러 백업도 run ID별로 구분하며 선택한 원본을 최신 백업으로 바꾸지 않는다. 현재 실환경 탐색은 화면에 불러온 최근 30개 run 한도 내이며 한도를 표시한다. [시각화·계산 계약](docs/comparison-ui.md)을 따른다.

기본 현황은 행마다 **최신 검증된 일반 백업**을 사용해, 다음 백업에 빠진 삭제 자원도 보호 목록에서 사라지지 않게 한다. 안전 백업은 기준에서 제외하며 행별 시각/원본 run을 보존한다. 과거 날짜의 단일 run 비교도 선택할 수 있다. 이는 하나의 원자적 시점 백업을 새로 만든 것이 아니다.

**현재 실험의 저장 원천을 구분한다.** 구독 정책이 테스트 Storage의 공용 접근을 차단하므로 이를 완화하지 않았다. PC 콘솔은 `archive_mode: "local"`을 **명시적으로 선택**해 로컬 검증 디스크에 백업한다. ARM·Activity Log·Log Analytics는 실제 Azure다. 기본 `blob` 모드와 수집기의 Private Endpoint 강제는 유지한다. 별도 사설 러너 검증은 디스크 검증과 분리한다. [검증 결과·한계](docs/validation.md)를 따른다.

위 로컬 모드는 loopback 전용·신뢰된 운영자 1명용이다. 별도 `--hosted` 모드는 App Service EasyAuth가 검증한 지정 tenant/operator만 허용하며 관리 ID와 사설 Blob을 사용한다. **다중 사용자 역할 분리·교차 테넌트 운영·KT 운영 인증을 제공하는 것은 아니다.** 테스트 리소스의 `expiresOn` 태그는 자동 삭제 예약이 아니다.

### App Service와 push 배포

승인된 테스트 앱은 **https://app-armbackup-dev-f4bc.azurewebsites.net/** 이다. Entra 로그인으로 보호하며 `/health`만 익명 접근을 허용한다. 앱 관리 ID는 구독 Reader·Contributor와 지정 저장소/로그 데이터 역할을 사용하며 콘솔 실행 범위는 설정한 단일 구독 전체다.

[GitHub Actions](.github/workflows/appservice.yml)는 모든 push를 검사하고 **main push만** OIDC로 배포한다. DB나 로컬 디스크를 저장 원천으로 사용하지 않는다. Blob 저장 뷰는 SHA·완료 표식·5분 TTL·입력 세대를 검증하며 live 확인 전 쓰기를 잠근다. WebJob 예약 패키지는 별도이며 UI ZIP에 예약 작업을 자동 추가하지 않는다. 구성 변수·권한·비용·검증 한계는 [배포 문서](docs/deployment.md)를 따른다.

### 승인된 RG에서만 실행하는 검증 도구

- [provision_complex_lab.py](scripts/provision_complex_lab.py): 같은 소유 RG에 HTTP Gateway/WAF·Standard LB/독립 Pool·Front Door Standard와 사설 시험 백엔드를 구성한다. Gateway·Front Door·NAT·VM은 과금될 수 있다.
- [exercise_complex_lab.py](scripts/exercise_complex_lab.py): 상세 WAF/LB 업데이트 또는 묶음 백업→삭제→재생성 후 경로·WAF·리다이렉트·LB 전달·Front Door 응답 규칙을 실제 HTTP로 검사한다. `--mode update|recreate`와 정확한 `--confirm-group`이 필요하다.
- [cleanup_complex_lab.py](scripts/cleanup_complex_lab.py): 기록된 소유 `abx-` 시험 root와 사설 VM의 확인된 disk만 정리한다. RG·기존 LAB·비소유 자원은 삭제하지 않는다.
- [provision_lab.py](scripts/provision_lab.py): 명시한 소유 RG에만 비연결 네트워크 자원·AAD Blob·Workspace/DCR을 준비한다. 기존 비소유 자원을 덮어쓰지 않는다.
- [exercise_lab.py](scripts/exercise_lab.py): 실제 생성·변경·삭제·재생성·Update-only·정책 적용·감사 로그를 검증한다. **Azure를 변경하는 도구**다.
- [verify_private_lab.py](scripts/verify_private_lab.py): 같은 RG의 일시 ACI·VNet/PE·관리 ID로 Blob·안전 백업·복원을 검증하고 임시 실행/네트워크 자원을 정리한다. 별도 조회 신원으로 감사 로그를 확인한다.
- [cleanup_lab.py](scripts/cleanup_lab.py): RG 이름·소유 태그·비소유 자원·잔존 러너를 검사한 뒤 **확인한 RG 하나만** 삭제 요청한다. 로컬 기록은 보존한다.

실험이 끝나고 보관한 백업·로그를 더 이상 사용하지 않을 때만 정리한다.

```powershell
.\.venv\Scripts\python.exe scripts\cleanup_lab.py --config .armbackup-lab\console.local.json --confirm-resource-group rg-armbackup-msp-lab-20261031
```

Storage·Log Analytics 등 보관 자원의 사용량 과금은 남을 수 있다. 정리 명령을 실행하기 전 보고서를 저장하고, 삭제 후 Azure에서 RG 부재를 확인한다. 실제 설정·백업·실험 결과는 Git에 포함하지 않는 `.armbackup-lab`에 둔다.

## WebJob 패키지

```powershell
.\.venv\Scripts\python.exe scripts\package_webjob.py --output dist\armbackup-webjob.zip --python-version 3.12 --config config.json
```

Linux용 의존성을 포함한다. `--config`를 생략하면 설정 예제만 들어간다. 프로덕션 파일은 자격증명을 포함하지 않지만 고객 리소스 ID·엔드포인트를 포함하므로 배포 산출물도 내부용으로 취급한다. `--without-dependencies`는 테스트용일 뿐 운영 배포물이 아니다. 기존 출력 파일은 덮어쓰지 않는다.

예약 기본값은 **UTC 17:00, 즉 다음 날 KST 02:00**이다. Always On·VNet Integration·Blob PE·지정 Workspace용 DCR·최소권한 신원을 준비해야 한다. 구체적인 설정은 [배포 문서](docs/deployment.md)를 따른다.

## 테스트

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check src tests scripts webjob
.\.venv\Scripts\python.exe -m mypy src
node --test tests\ui-model.test.mjs tests\live-client.test.mjs tests\change-calendar.test.mjs tests\bundle-panel.test.mjs
node --test tests\backup-view.test.mjs
```

Azure를 생성·변경하지 않는 테스트다. 마지막 명령은 UI 모델 개발 검증용이며 Node.js 22 이상을 사용한다. 프리뷰 실행이나 WebJob에는 Node.js가 필요하지 않다. 실제 KT PE·관리 ID·로그 수집·리소스 복구는 고객 환경에서 별도 검증해야 한다. 모든 기본 동작은 [소스](src/armbackup)와 [테스트](tests)에 정의한다.
