# App Service 콘솔·WebJob 배포

> 범위: 운영자가 준비할 Azure 리소스·Private Endpoint·기존 Workspace 연결과 배포 절차. 이 문서의 설정은 자동 적용되지 않는다.

**한 줄 요약** — Python App Service에 VNet Integration·Always On을 설정하고, Blob PE와 DCR/DCE 경로를 확인한 뒤 의존성을 포함한 WebJob ZIP을 배포한다.

## 승인된 LAB 콘솔 호스팅

- Korea Central의 `rg-armbackup-dev-f4bc`: Linux B1 `asp-armbackup-dev-f4bc`, 앱 `app-armbackup-dev-f4bc`. 접속: **https://app-armbackup-dev-f4bc.azurewebsites.net/**.
- `infra/main.bicep`는 신규 호스팅 RG/VNet·Blob Private Endpoint·사설 DNS를 만들고 기존 LAB Storage·Workspace·DCR을 재사용한다. Storage의 public network/shared key 차단을 유지한다. 데이터베이스는 없다.
- `--hosted`는 App Service 실행 환경·정확한 HTTPS Host/Origin·EasyAuth의 지정 tenant/operator를 요구한다. `/health` 외에는 인증을 강제한다. 이 프록시가 검증한 `X-MS-CLIENT-PRINCIPAL`만 신뢰하므로 일반 인터넷 서버에서 이 헤더를 만들어 실행하면 안 된다.
- 앱 관리 ID: 구독 **Reader**, `rg-armbackup-msp-lab-20261031`만 **Contributor**, 기존 Storage의 **Storage Blob Data Contributor**, DCR의 **Monitoring Metrics Publisher**, Workspace의 **Log Analytics Reader**. 콘솔은 MI의 Reader 범위 전체로 자동 확대하지 않는다. `console.inventory_scope=subscription`을 명시하면 현재 구독 전체 RG의 검토된 네트워크 종류를 조회·백업하며 복원·복제는 기존 LAB에만 허용한다. 기본 `lab`과 기존 저장 정책은 유지한다.
- GitHub 배포 앱은 런타임 MI와 별도다. 실제 토큰의 `repo:Networkdog@35480494/armbackup@1440352226:ref:refs/heads/main` OIDC만 허용하며 새 호스팅 RG의 **Website Contributor**를 사용한다. 이 저장소는 owner/repository ID가 포함된 immutable subject를 사용하므로 이름만 있는 예전 subject로 만들면 로그인이 실패한다. [공식 전환 안내](https://learn.microsoft.com/entra/workload-id/workload-identities-github-immutable-subjects). 저장된 Azure 배포 비밀은 없다. Entra 웹 로그인 비밀은 App Service의 보안 설정에 별도로 존재하며 만료 전에 교체해야 한다.
- [자동 배포](../.github/workflows/appservice.yml): 모든 push에서 Python/JS·lint/type 검사, main만 Oryx ZIP 배포 후 health/익명 API 차단 확인. 실제 `defaultHostName`을 조회하므로 지역/해시가 포함된 기본 호스트도 처리한다.

Repository variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_WEBAPP_NAME`, `AZURE_RESOURCE_GROUP`, `ARMBACKUP_DEPLOY_CONFIG`. 마지막 값은 `console`·`capture` JSON이며 `archive_mode=blob`, `credential=managed_identity`, `require_private_endpoint=true`가 필수다. 비밀·토큰·로컬 경로를 넣지 않는다. [패키저](../scripts/package_appservice.py)는 애플리케이션 소스/정적 자산/명시한 설정만 포함한다.

Startup: `PYTHONPATH=$PWD/src python -m armbackup.webui --hosted --port 8000 --live-config $PWD/hosted/console.json`. Oryx가 압축 배포물을 임시 실행 경로에 풀 수 있으므로 `/home/site/wwwroot/src`로 고정하지 않는다. 첫 Oryx 빌드·시작은 수 분 걸릴 수 있다. SCM/FTP 기본 인증은 최종 IaC에서도 차단하며 Actions는 Entra OIDC를 사용한다.

기본 비용 추정은 B1 $13.14 + Private Endpoint $7.30 = **약 USD20.44/월**(730시간, 확인 당시 [공식 Retail Prices API](https://prices.azure.com/api/retail/prices)의 Korea Central/Global 단가). Storage·DNS·로그·전송·Actions·세금은 별도다. B1 사전 quota는 확정하지 못했지만 실제 배포는 성공했다. [검증 기록](validation.md)과 구분해 읽는다.

아래는 별도 예약 WebJob/운영 분리 지침이다. **콘솔 ZIP에는 예약 WebJob이 들어 있지 않다.** 현재 단일 운영자 LAB의 백업/복원 실행 신원과 운영 권장 신원 분리를 혼동하지 않는다. 정리는 사용자가 필요할 때 `az group delete --name rg-armbackup-dev-f4bc --yes --no-wait`로 수행하며 기존 LAB의 백업·로그와 구독 Reader 역할, Entra 앱은 별도로 검토한다.

## 1. 인프라·신원 사전 준비

- 대상 리전: 사용자 미지정 시 Korea Central을 검토하되 **실제 구독의 App Service Python 런타임·Plan/SKU 지원과 quota를 확인**한다. 이 저장소는 리전별 배포를 실증하지 않았다.
- Linux x86_64 Python 3.12 코드 기반 App Service와 유료 App Service Plan. 앱은 백업 전용, Always On 활성화.
- 동일 리전 VNet의 App Service integration 전용 delegated subnet, Blob PE가 있는 reachable VNet·피어링·DNS.
- 기존 Storage Account의 Blob container. Public network access 차단, Blob PE 승인·사설 DNS 준비. 이 코드는 container를 만들지 않는다.
- 지정한 **기존** Log Analytics Workspace, custom table, Direct DCR 또는 DCR+사설 DCE.
- App Service의 관리 ID. 별도 Worker VM이나 Automation Account는 필요하지 않다.
- **추가 확정 요구:** 비교/복원 UI도 App Service에 호스팅하며 백업 실행기와 동일 App Service Plan을 사용한다. 승인 LAB의 단일 운영자 호스팅은 위 절을 따른다. **다중 사용자/테넌트 프로덕션 UI 인증·인가를 완성한 것은 아니다.**

기존 Plan을 사용하면 앱과 WebJob의 CPU·메모리·스케일을 공유한다. 이번 결정은 **동일 Plan 사용**이므로 UI를 위해 임의로 별도 Plan을 생성하지 않는다. 컴퓨트 격리가 필요해지면 이 결정의 변경을 별도로 검토한다. 일일 실행만 하더라도 Plan 과금은 발생한다. (근거: [Plan 자원·과금](https://learn.microsoft.com/azure/app-service/overview-hosting-plans))

### UI 앱 구성 — 운영 호스팅 권장안

같은 Plan 안에 백업 Web App과 비교/복원 UI Web App을 분리하고 관리 ID·앱 설정·배포를 나누는 안을 권장한다. **별도 앱 수와 복원 executor까지 확정한 것은 아니다.** 백업 identity에 write 권한을 추가하지 않으며 UI/복원 신원의 권한은 화면/실행 설계에 맞춰 별도로 정한다.

UI 앱도 Blob·ARG·ARM·DCR/DCE 접근에 필요한 VNet Integration·DNS·라우팅·권한을 확인한다. 같은 Plan을 지정하는 것만으로 연결이 준비됐다고 보지 않는다. UI 인바운드의 사설 연결·사용자 인증/인가·SCM 경로도 별도로 준비한다.

아래 WebJob ZIP과 실행 설정은 **백업 앱용**이다. 정적 파일이 있어도 health host가 복원 UI를 제공하지는 않는다. `python -m armbackup.webui`의 프리뷰·일반 `--live-config`는 **loopback 전용**이다. 인증된 App Service에는 위의 별도 콘솔 ZIP과 `--hosted`를 사용한다. 다중 사용자/테넌트 운영 서버는 후속 범위다. [형상 비교·MSP 화면과 호스팅 요구](comparison-ui.md)를 따른다.

### 승인된 단일 RG 실험과 고객 배포를 구분

현재 구독에서 새 소유 태그가 있는 테스트 RG 하나로 실행했다. 공용 Storage 접근을 차단하는 구독 정책을 확인했으며 이를 예외 처리하거나 완화하지 않았다. PC 콘솔은 **명시적인 로컬 디스크 검증 원천**, 실제 Blob 검증은 **같은 RG의 일시 ACI·VNet/Private Endpoint·관리 ID**를 사용했다.

사설 러너에서 Blob 원본/완료 표식과 안전 백업의 무결성, NSG 신규 생성·사후 형상 일치, 지정 DCR 로그 전송을 확인했다. **조회 신원은 수집·복원 신원과 분리**해 실제 Workspace의 해당 계획 이벤트를 읽었다. 임시 ACI·NAT·공용 IP·PE·DNS·러너 신원은 정리했다. 결과와 실패/수정 과정은 [검증 기록](validation.md)에 둔다.

이 검증은 **App Service/WebJob 프로세스에서의 실행·KT VNet/PE 경로·운영 사용자 인가 검증이 아니다.** 운영 구성은 여전히 같은 App Service Plan 요구를 유지한다. 보관용 Storage·Workspace 등은 사용량 과금이 남을 수 있고 `expiresOn` 태그만으로 삭제되지 않는다. 보고서를 보관한 뒤 [소유 RG 정리 도구](../scripts/cleanup_lab.py)를 명시적으로 실행한다.

## 2. 네트워크

| 경로 | 확인 |
| --- | --- |
| WebJob → Blob | 표준 `<account>.blob.core.windows.net`이 PE 사설 IP로 해석, 443 허용 |
| WebJob → ARG·ARM | `management.azure.com` 및 실제 ARM 출구 허용. 설정을 읽는 데 업무 데이터 PE가 필요한 것은 아님 |
| WebJob → 인증 | App Service 관리 ID 접점과 SDK에 필요한 인증 경로. 토큰·클라이언트 비밀을 파일에 넣지 않음 |
| WebJob → 로그 | 설정한 DCR/DCE ingestion endpoint 접근. 모니터링도 사설 강제라면 DCE+AMPLS·사설 DNS 구성 |
| 관리·배포 → SCM | App Service를 private-only로 운영하면 SCM DNS·PE와 사설 배포 에이전트 경로 |

VNet Integration은 아웃바운드이고 App Service PE는 인바운드다. 같은 subnet을 두 용도로 재사용하지 않는다. KT 중앙 DNS Resolver와 UDR/방화벽 통제를 적용하고, 인터넷 아웃바운드 전체 통제가 필요하면 사설 트래픽만 라우팅하는 기본값으로 끝내지 않는다. 설정한 OS·런타임에서 WebJob 프로세스 자체의 연결을 확인한다. (근거: [VNet Integration](https://learn.microsoft.com/azure/app-service/overview-vnet-integration), [App Service PE/SCM](https://learn.microsoft.com/azure/app-service/networking/private-endpoint), [Storage PE](https://learn.microsoft.com/azure/storage/common/storage-private-endpoints))

## 3. 최소권한

| 범위 | 권한 |
| --- | --- |
| Discovery·일반 ARM GET | 대상 구독/관리 범위 Reader를 출발점으로 삼고 collector별 작업 권한 대조 |
| DCR/DCE metadata | 해당 DCR과, 사용 시 DCE의 읽기 |
| Blob container | container 속성 읽기·Blob 원본 쓰기·검증 읽기·lock Blob lease에 필요한 작업 |
| DCR 수신 | **Monitoring Metrics Publisher**를 해당 DCR 범위에 부여 |
| 복원 | 다른 앱/신원에만 필요한 대상 write 부여. 백업 신원에 Contributor를 부여하지 않음 |

`Storage Blob Data Contributor`는 동작 검증에 쓰기 쉬우나 **삭제 권한도 포함**한다. 운영에서는 필요한 DataActions·lease 동작을 검토한 최소권한 역할과 retention/불변 보존을 구성한다. lock Blob은 갱신 가능한 prefix에 두어야 하므로 동일 container 전체의 WORM 설정은 lease·운영 절차와 함께 시험한다. 권한을 이 코드가 자동 부여하지 않는다.

## 4. 지정 Workspace와 DCR

기존 Workspace에 Logs Ingestion API를 받는 `ArmBackup_CL` custom table을 만든다. [logs-sample.json](../examples/logs-sample.json)을 schema 참고용으로 사용할 수 있지만 dynamic 타입은 아래 표와 대조한다.

| 열 | 타입 |
| --- | --- |
| TimeGenerated | datetime |
| RunId, Level, Event, ResourceId, Status, ErrorCode | string |
| Details | dynamic |

다음 계약으로 DCR을 준비한다.

1. Workspace·DCR·DCE는 공식 안내에 맞는 같은 리전으로 구성한다.
2. `streamDeclarations.Custom-ArmBackup.columns`를 위 열과 정확히 일치시킨다.
3. `destinations.logAnalytics`에 지정 Workspace ARM ID와 destination 이름을 넣는다.
4. `dataFlows`의 stream은 `Custom-ArmBackup`, destination은 그 이름, `transformKql`은 `source`, `outputStream`은 `Custom-ArmBackup_CL`로 연결한다.
5. Public ingestion 허용 시 Direct DCR endpoint를 사용할 수 있다. 사설 로그 전송이 필요하면 **DCE를 DCR에 연결**하고 AMPLS·PE·DNS를 구성한 뒤 DCE endpoint를 설정한다.
6. 앱 신원에 DCR metadata 읽기와 Monitoring Metrics Publisher를 부여한다.

Workspace ID만으로 custom 로그를 전송할 수는 없다. Table/DCR/DCE는 기존 고객 자원과 충돌하지 않게 승인 후 준비한다. 이 구현은 다른 stream을 수정하지 않으며 DCR이 잘못 연결돼 있으면 실패한다. (근거: [Logs Ingestion API 설정·권한·사설망](https://learn.microsoft.com/azure/azure-monitor/logs/logs-ingestion-api-overview))

## 5. 패키지·앱 설정·배포

로컬 설치 후 실제 값으로 설정한 `config.json`을 사용한다.

```powershell
.\.venv\Scripts\python.exe -m armbackup --config config.json validate-config
.\.venv\Scripts\python.exe scripts\package_webjob.py --output dist\armbackup-webjob.zip --python-version 3.12 --config config.json
```

ZIP root는 App Service 사이트 내용이다. `App_Data/jobs/triggered/armbackup/`에 Python 모듈·Linux용 의존성·실행 스크립트가 들어 있다. Windows native wheel을 재사용하지 않는다. 패키지에 기본적으로 자격증명은 없으며 사용자가 지정한 비밀 없는 구성만 포함한다.

앱에 다음을 설정한다.

| 설정 | 값 |
| --- | --- |
| OS·런타임 | Linux x86_64 / Python 3.12 |
| Startup command | `python /home/site/wwwroot/site_health.py` |
| `ARMBACKUP_CONFIG` | `/home/site/wwwroot/config.json` |
| Always On | On |
| 예약 | [settings.job](../webjob/settings.job): UTC 17:00 = 다음 날 KST 02:00 |
| 외부 공개 | KT 승인 정책에 맞게 차단; SCM 배포 경로는 따로 확보 |

ZIP을 사설망에 접근 가능한 배포 에이전트에서 App Service의 ZIP 배포 기능으로 올린다. 런타임에 인터넷으로 pip 설치하지 않는다. 배포 슬롯을 쓸 경우 staging의 예약은 `WEBJOBS_DISABLE_SCHEDULE=1`로 막고 swap 후 중복 실행을 점검한다. `WEBJOBS_IDLE_TIMEOUT`은 실제 장기 수집의 출력/idle 조건을 측정해 정하고 조용한 API 대기를 무제한으로 만들지 않는다. (근거: [WebJobs 실행](https://learn.microsoft.com/azure/app-service/webjobs-execution), [환경 설정](https://learn.microsoft.com/azure/app-service/reference-app-settings#webjobs))

## 6. 인수 시험

실제 WebJob에서 Blob DNS→사설 IP, managed identity 업로드, ARG 모든 페이지, 대표 RP GET, LA 해당 RunId 조회를 확인한다. 이어 권한 부족·Storage 차단·로그 실패·중복 실행·앱 재시작을 시험한다. 성공 run의 manifest와 완료 표식을 대조한다. **이 저장소의 로컬 테스트 통과는 KT 배포 성공을 뜻하지 않는다.**
