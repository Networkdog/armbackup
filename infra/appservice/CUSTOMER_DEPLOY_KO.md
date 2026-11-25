# Configuration Vault (armbackup) — 간편 배포 가이드

`armbackup-customer-kit.zip` 하나만 압축 해제하면 **Azure CLI(`az`)만으로** KT 공용 환경(`azfirewallagent`와 동일한 공용 리소스 공간)에 즉시 배포할 수 있습니다(Docker·Node.js·Python·Bicep 별도 설치 및 외부 PyPI 통신 불필요).

---

## 1. 빠른 실행 (3단계)

1. 작업 PC에서 Azure CLI 로그인을 완료합니다.
   ```bash
   az login
   ```
2. `armbackup-customer-kit.zip`의 압축을 풀고 설정 파일을 복사합니다(KT STG-CloudWiz MSP 공용 환경 기본값이 이미 기입되어 있어 별도 수정 없이 바로 사용할 수 있습니다).
   ```powershell
   # PowerShell (Windows / macOS / Linux)
   Copy-Item .\deploy.config.example.json .\deploy.config.json
   ```
   ```bash
   # Bash (Linux / macOS)
   cp ./deploy.config.example.json ./deploy.config.json
   ```
3. 압축을 푼 폴더에서 인자 없이 스크립트를 실행합니다.
   ```powershell
   # PowerShell (사전 변경 점검만 수행할 때는 .\Deploy-AppService.ps1 -WhatIfPreview)
   .\Deploy-AppService.ps1
   ```
   ```bash
   # Bash (사전 변경 점검만 수행할 때는 ./deploy-appservice.sh --what-if)
   chmod +x deploy-appservice.sh && ./deploy-appservice.sh
   ```

---

## 2. 공용 리소스 공유 및 격리 원칙 (`azfirewallagent` 동시 운영 기준)

이 키트는 `azfirewallagent`(Firewall Desk)와 동일한 공용 호스팅 공간을 충돌 없이 공유하도록 설계되어 있습니다.

| 공용 / 전용 구분 | 리소스 | 격리·공유 방식 |
| --- | --- | --- |
| **전용 앱 리소스 그룹** | `rg-az01-og084902-stg-cloudwiz-msp-configvault-01`<br>`app-az01-stg-cloudwiz-msp-configvault-01`<br>`id-app-az01-stg-cloudwiz-msp-configvault-01` *(또는 지정 UAMI)*<br>`pe-sites-app-az01-stg-cloudwiz-msp-configvault-01` | 프로젝트별 단독 리소스(Linux Web App, **User Assigned Managed Identity**, 인바운드 `sites` Private Endpoint, Diagnostic Settings)는 모두 전용 RG 안에 생성. **System Assigned Managed Identity는 기본 비활성화(`Off`)** 되며 모든 ARM·Storage·Monitor 호출은 User Assigned Managed Identity만 사용 |
| **공용 App Service Plan** | `asp-az01-stg-cloudwiz-msp-web-01` (`common-01`) | 기존 Linux Plan과 이미 연결된 VNet 통합 서브넷(`Microsoft.Web/serverFarms`)을 자동 감지·재사용 |
| **공용 Storage Account** | `staz01stgcloudwizmsp01` (`common-01`) | **`Public Network Access = Disabled` 전용** (다른 값 설정 불가, 배포자 PC의 Data Plane 접근·IP 허용 없음). App Service 기동 시 Startup 코드(`bootstrap_storage`)가 VNet 통합 → Blob PE 사설 경로로 전용 컨테이너(`az01-stg-cloudwiz-msp-configvault-01-backups`) 및 초기 시드 데이터를 자동 생성·저장 |
| **임시 로그인 인증 (Key Vault 미사용)** | App Service 환경 변수 (`ARMBACKUP_AUTH_USERNAME`, `ARMBACKUP_AUTH_PASSWORD_HASH`) | Entra ID 인증 적용 전까지 **Key Vault Secret을 사용하지 않고** App Settings에 솔트 적용 단방향 `scrypt` 해시를 직접 설정해 즉시 로그인 (`Key Vault Secrets User` 권한 불필요) |
| **공용 Log Analytics** | `law-az01-stg-cloudwiz-msp` (`common-01`) | App Service 진단 설정(`diag-app-...`) 자동 연결. 사용자 지정 테이블(`ArmBackup_CL`)·DCR·DCE는 **선택 사항**이며 미구성·권한 전파 전에도 앱 기동·수집·백업이 절대 중단되지 않음 |
| **내장 Linux 패키지** | `armbackup.zip` (`.python_packages`) | Linux `manylinux` 바이너리 wheel이 ZIP 내부에 사전 번들되어 있어 폐쇄망 VNet에서 PyPI 아웃바운드나 Oryx 원격 빌드가 전혀 필요 없음 |

---

## 2-1. App Service 3단계 네트워크 설정 및 배포 순서 (자동 수행)

`Deploy-AppService.ps1` / `deploy-appservice.sh` 실행 시 아래 지침이 순서대로 자동 수행됩니다.

1. **1단계 — `Disabled` 상태로 생성**: `azuredeploy.json`을 통해 App Service를 **`Public Network Access = Disabled`** 상태로 최초 생성합니다.
2. **2단계 — 선택 네트워크 및 허용 IP(`211.47.20.25`, `211.47.20.26`) 전환·검증**: App Service 생성이 완료되면 `Public Network Access`를 **`Enabled from select virtual networks and IP addresses`**로 변경하고, 주 사이트와 SCM 사이트 모두에 **`211.47.20.25/32`, `211.47.20.26/32` 허용(`Allow`)** 및 **`Unmatched rule action = Deny`**를 설정한 뒤 ARM 반영을 검증합니다.
3. **3단계 — 코드 배포 시작 및 Startup Storage 초기화**: 허용 IP 규칙이 정상 반영·전파된 것이 확인된 시점부터 Kudu(`/api/publish`)로 `armbackup.zip` 배포를 시작합니다. 배포자 PC는 Storage Data Plane에 일체 접근하지 않으며, 컨테이너 기동 시 `startup.sh` → `armbackup.webui`의 Startup 코드(`bootstrap_storage`)가 사설망(VNet Integration → Blob PE)을 통해 전용 컨테이너 생성 및 초기 데이터 적재를 수행합니다(패키지 빌더 실행 시 `infra/appservice/storage_seed/` 폴더에 파일을 두면 기동 시 자동 적재).

---

## 3. 사전 확인 사항

- **배포 계정 권한 (`Contributor` 전용 · Storage 직접 쓰기 없음)**:
  - 배포 템플릿과 스크립트는 기본값에서 Role Assignment 작업을 일체 수행하지 않으며, **배포자가 Storage Account에 파일 업로드나 컨테이너 쓰기를 수행하지 않습니다** (앱 기동 후 Web App의 Managed Identity가 전용 컨테이너를 자동 생성).
  - 앱 RG(`rg-az01-og084902-stg-cloudwiz-msp-configvault-01`), 공용 RG(`...-common-01`), 네트워크 RG(`...-network-01`)에 대한 `Contributor` 권한만으로 전체 배포가 완료됩니다.
- **실행 위치 및 중단 후 재실행(Resume) 안전성**:
  - 허용 IP(`211.47.20.25`, `211.47.20.26`) 대역의 배포 PC 또는 사내망/Jumpbox에서는 설정된 규칙을 통해 Kudu에 직접 업로드하며, 그 외 외부 망에서 실행하더라도 스크립트가 Kudu SCM에만 배포자 `/32` 공인 IP를 일시 추가(`DefaultAction: Deny`, KT 정책 준수)해 업로드한 뒤 즉시 기존 허용 IP(`211.47.20.25/32`, `211.47.20.26/32`) + `Unmatched: Deny` 상태로 복원합니다.
  - 배포 도중 중단되더라도 **동일한 명령을 다시 실행하면 이미 생성된 Web App, 허용 IP 규칙, Private Endpoint, Key Vault 비밀번호, VNet 통합을 충돌 없이 그대로 유지한 채 이어서 완료**됩니다.
- **파일 전달 시 참고**: `@kt.com` 메일로 키트를 보낼 때는 스크립트(`.ps1`/`.sh`) 필터링을 피하기 위해 암호 압축으로 전달하거나 Teams/SharePoint를 이용합니다.

---

## 4. 배포 완료 후 권한 관리자(Owner / RBAC 관리자) 요청 사항

배포가 완료되면 화면에 **User Assigned Managed Identity의 Object(Principal) ID 및 Client ID**와 전용 컨테이너 이름이 출력됩니다(App Service의 `System Assigned Managed Identity`는 기본 비활성화되며, 기존에 포털에서 할당해 둔 UAMI가 있으면 자동으로 감지·유지하고 `ARMBACKUP_MANAGED_IDENTITY_CLIENT_ID`까지 자동 구성합니다). 권한 관리자가 해당 **User Assigned Managed Identity**에 아래 역할을 부여한 뒤 앱을 한 번 재시작(`az webapp restart`)하면 전용 컨테이너 자동 생성 및 구독 형상 수집이 즉시 활성화됩니다.

| 대상 리소스 | 부여할 역할(Role) | 권장 스코프 |
| --- | --- | --- |
| 공용 Storage (`staz01stgcloudwizmsp01`) | `Storage Blob Data Contributor` | Storage Account 스코프 (앱이 기동 시 전용 `<namespace>-backups` 컨테이너를 자동 생성하여 격리 사용) 또는 사전 생성한 단일 컨테이너 스코프 |
| 백업 대상 구독 (`sub-az01-og084902-stg-cloudwiz`) | `Reader` | 조회·형상 백업할 대상 구독 스코프 |
| 백업 대상 구독 *(복원·복제 사용 시 선택)* | `Contributor` | `restoreEnabled: true`로 ARM 복원·복제 기능까지 활성화할 때만 추가 부여 |
| Log Analytics / DCR *(선택 사항)* | `Log Analytics Reader` (LAW)<br>`Monitoring Metrics Publisher` (DCR) | `ArmBackup_CL` 사용자 지정 테이블/DCR을 연동할 때만 부여 (미부여 시에도 Storage 작업 완료 기록 탭으로 정상 운영) |

- **로그인 정보 (Key Vault Secret 미사용)**: Entra ID 전환 전까지 App Settings(`ARMBACKUP_AUTH_USERNAME=admin`, `ARMBACKUP_AUTH_PASSWORD_HASH`)만으로 즉시 로그인되므로 Key Vault 권한(`Key Vault Secrets User`)은 필요하지 않습니다.

---

## 5. `deploy.config.json` 주요 항목 요약

모든 항목의 상세 설명은 `deploy.config.example.json` 하단 `_fieldReference`에서도 확인할 수 있습니다.

| 구분 | 항목 | 설명 |
| --- | --- | --- |
| **Required** | `resourceGroup` | Web App 및 앱 PE(`pe-sites-*`)를 생성할 리소스 그룹 이름 |
| **Required** | `webAppName` | 생성할 Linux App Service 이름 |
| **Optional** *(공용 환경 유지)* | `subscriptionId`, `appServicePlan`, `storageAccount`, `keyVault`, `privateEndpointSubnetId` | KT 공용 호스팅 리소스 지정값 (`azfirewallagent`와 동일 기본값 유지) |
| **Optional** | `logAnalyticsWorkspace` | App Service 진단 로그를 전송할 공용 Log Analytics Workspace |
| **Optional** | `vnetIntegrationSubnetId` | 비워 두면 공용 App Service Plan 또는 동일 VNet의 `Microsoft.Web/serverFarms` 위임 서브넷을 자동 감지 |
| **Optional** | `webAppPublicNetworkAccess`, `allowedIpCidrs` | 생성 시 `"Disabled"` 고정 후, 생성 직후 `"Enabled"`(선택 네트워크 및 IP) + `["211.47.20.25/32", "211.47.20.26/32"]` 허용 + `Unmatched = Deny` 반영 검증 뒤 배포 시작 |
| **Optional** | `targetSubscriptionId`, `targetSubscriptionName`, `restoreEnabled` | 백업 대상 구독 지정 및 복원·복제 허용 여부(기본 `false`) |
| **Optional** | `storageNamespace`, `storageContainerName` | 비워 두면 `<namespace>-backups` 전용 컨테이너 이름으로 자동 격리 |
| **Optional** | `logWorkspaceGuid`, `logDcrId`, `logRuleId`, `logEndpoint`, `logStream` | 선택적 `ArmBackup_CL` DCR/DCE 연동 값 (미입력 시 미사용, 오류 시에도 비차단) |
| **Optional** | `tags` | 리소스 거버넌스 태그 병합 (대상 RG 태그 자동 상속) |

---

## 6. 업데이트 재배포

새 버전의 `armbackup-customer-kit.zip`을 풀고 기존 `deploy.config.json`을 유지한 채 동일한 명령(`.\Deploy-AppService.ps1` 또는 `./deploy-appservice.sh`)을 다시 실행하면 기존 비밀번호·Private Endpoint·백업 Blob 데이터를 그대로 보존하며 업데이트됩니다.
