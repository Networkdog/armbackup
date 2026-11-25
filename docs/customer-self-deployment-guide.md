# Configuration Vault (armbackup) 고객사 직접 설치 가이드

이 문서는 전달받은 배포 패키지(`armbackup-deploy.zip`, `SHA256.txt`)를 이용해 고객사 구독에 Azure App Service를 직접 생성하고 배포하는 절차를 안내합니다.

앱은 기동 시점에 Storage 사설 연결, Blob 컨테이너, 로그인 해시(Key Vault 참조 포함)를 즉시 검증합니다(Log Analytics 연동은 **선택 사항**입니다). 중간 기동 실패를 막으려면 아래 **1단계부터 7단계 순서대로** 진행해 주세요.

---

## 1. 사전 준비 사항 확인

설치를 시작하기 전에 아래 리소스와 네트워크 조건이 준비되어 있는지 확인합니다.

- **전달 파일 무결성 확인**: 배포 PC에서 계산한 해시 값이 `SHA256.txt`와 일치하는지 확인합니다.
  ```powershell
  # PowerShell (Windows / macOS / Linux)
  (Get-FileHash ./armbackup-deploy.zip -Algorithm SHA256).Hash
  ```
- **Storage Account**: 공용 네트워크 접근을 차단하고, Blob 컨테이너(예: `armbackup`)를 미리 생성합니다. 앱이 연결할 VNet에서 `<계정이름>.blob.core.windows.net`이 사설 IP로 해석되도록 Blob Private Endpoint와 Private DNS 영역(`privatelink.blob.core.windows.net`)을 연결합니다.
- **Log Analytics Workspace 및 DCR (선택 사항 — 추후 수동 연결 가능)**: 당장 Log Analytics 연동이 필요하지 않다면 **2단계를 건너뛰고** Storage Account만으로 먼저 설치·운영할 수 있습니다(작업 완료 이력은 Storage에 영속 기록되며 App Service 컨테이너 로그에도 남습니다). 추후 수동으로 구성해 환경 변수만 추가하면 ZIP 재배포 없이 바로 연결됩니다(2단계 및 6.3절 참조).
- **App Service Plan**: **Linux** 기반 **Basic(B1) 이상** 플랜을 준비합니다([App Service 요금제 개요](https://learn.microsoft.com/azure/app-service/overview-hosting-plans)). 로그인 세션과 수집 스케줄러가 프로세스 메모리에서 동작하므로 **인스턴스 수는 1개로 고정**(자동 스케일 아웃 비활성화)해 주세요.
- **VNet 서브넷 2개 (App Service Plan과 동일 리전)**:
  1. **VNet Integration용 서브넷**: `Microsoft.Web/serverFarms`로 서브넷 위임(Delegation)을 설정합니다([VNet 통합 활성화](https://learn.microsoft.com/azure/app-service/configure-vnet-integration-enable)).
  2. **Private Endpoint용 서브넷**: 위임이 없는 별도 서브넷을 준비합니다([App Service 프라이빗 엔드포인트](https://learn.microsoft.com/azure/app-service/networking/private-endpoint)).
- **아웃바운드 통신 허용 (TCP 443)**: VNet 방화벽 또는 NSG를 사용하는 경우 VNet Integration 서브넷에서 아래 대상의 HTTPS(443) 통신을 허용해야 합니다.
  - Storage Blob Private Endpoint (사설 IP) 및 Key Vault 사용 시 Key Vault Private Endpoint (`privatelink.vaultcore.azure.net`)
  - Azure Resource Manager (`management.azure.com`), Microsoft Entra ID (`login.microsoftonline.com`)
  - Azure Monitor Logs Ingestion (`*.ingest.monitor.azure.com`)
  - 배포 중 Python 패키지 설치용 PyPI (`pypi.org`, `files.pythonhosted.org` — 차단된 환경에서는 Oryx 빌드가 실패합니다)

---

## 2. (선택) Log Analytics 테이블 및 DCR 수동 구성

> **당장 Log Analytics 구성이 필요하지 않다면 이 단계를 건너뛰고 3단계로 이동하세요.** 이미 배포해 운영 중인 웹앱에도 나중에 이 단계와 6.3절 환경 변수 설정만 수행하면 ZIP 재배포 없이 바로 연결할 수 있습니다.

### 방법 A — Azure Portal 화면에서 직접 구성 (ARM 템플릿·CLI 불필요)

Azure Portal의 사용자 지정 로그 생성 화면은 **데이터 수집 엔드포인트(DCE)**와 **샘플 JSON 파일**을 사용해 테이블과 DCR을 함께 만듭니다([포털 기반 Logs Ingestion API 튜토리얼](https://learn.microsoft.com/azure/azure-monitor/logs/tutorial-logs-ingestion-portal)).

1. **데이터 수집 엔드포인트(DCE) 만들기**
   - Azure Portal > **모니터(Monitor)** > 좌측 설정의 **데이터 수집 엔드포인트(Data Collection Endpoints)** > **+ 만들기(Create)** 선택
   - **엔드포인트 이름**(예: `dce-armbackup`), **리소스 그룹**, 그리고 **Log Analytics 작업 영역과 반드시 동일한 지역(Region)**(예: `Korea Central`)을 선택해 생성합니다.
   - 생성된 DCE의 **[개요(Overview)]** 화면 우측 상단에서 **로그 수집(Logs ingestion)** URL(`https://dce-armbackup-....ingest.monitor.azure.com`)을 복사해 둡니다.

2. **스키마 생성용 샘플 JSON 파일(`armbackup-sample.json`) 저장**
   - 포털이 8개 컬럼 타입(`TimeGenerated`: `datetime`, `Details`: `dynamic`, 나머지 6개: `string`)을 정확히 인식하도록 PC에서 아래 내용을 `armbackup-sample.json`(UTF-8) 파일로 저장합니다.
     ```json
     [
       {
         "TimeGenerated": "2026-11-17T00:00:00.000Z",
         "RunId": "20261117T000000Z-abcdef123456",
         "Level": "Information",
         "Event": "resource_captured",
         "ResourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example/providers/Microsoft.Network/networkSecurityGroups/example",
         "Status": "Succeeded",
         "ErrorCode": "None",
         "Details": {
           "bytes": 1024,
           "apiVersion": "2024-05-01"
         }
       }
     ]
     ```

3. **사용자 지정 테이블(`ArmBackup_CL`) 및 DCR 만들기**
   - Azure Portal > **Log Analytics 작업 영역(Log Analytics workspaces)** > 연결할 작업 영역 선택
   - 좌측 **설정(Settings) > 테이블(Tables)** > 상단 **+ 만들기(Create) > 새 사용자 지정 로그(DCR 기반) / New custom log (DCR-based)** 선택
   - **테이블 및 DCR** 탭:
     - **테이블 이름**: **`ArmBackup`** 입력 (`_CL` 접미사는 포털이 자동으로 붙여 최종 테이블 이름이 `ArmBackup_CL`이 됩니다)
     - **데이터 수집 규칙**: **새 데이터 수집 규칙 만들기** 클릭 → 구독, 리소스 그룹, 이름(예: `dcr-armbackup`) 지정 후 **완료**
     - **데이터 수집 엔드포인트**: 1번에서 만든 **`dce-armbackup`** 선택 후 **다음** 클릭
   - **스키마 및 변환** 탭:
     - **파일 찾아보기**를 눌러 2번의 `armbackup-sample.json` 파일을 업로드합니다.
     - 샘플에 이미 `TimeGenerated`가 포함되어 있으므로 **변환 편집기(Transformation editor)** 쿼리는 수정하지 않고 기본값(`source`) 그대로 둡니다(변환 쿼리를 바꾸면 앱 검증에서 거부됩니다).
     - **다음** > **만들기**를 눌러 테이블과 DCR 생성을 완료합니다.

4. **연결에 필요한 포털 값 확인**
   - **모니터 > 데이터 수집 규칙** > 방금 만든 `dcr-armbackup` 선택 > 우측 상단 **`JSON 보기(JSON View)`** 클릭:
     - 상단 `"id"`: DCR 리소스 ID (`/subscriptions/.../providers/Microsoft.Insights/dataCollectionRules/dcr-armbackup`)
     - `"properties.immutableId"`: DCR 불변 ID (`dcr-...`)
     - `"properties.streamDeclarations"` 아래 키 이름: 포털 마법사로 생성하면 **`Custom-ArmBackup_CL`**로 만들어집니다.
   - **Log Analytics 작업 영역 > 개요(Overview)**:
     - **작업 영역 ID(Workspace ID)**: GUID 값
     - 우측 상단 **`JSON 보기(JSON View)`**의 `"id"`: Workspace 리소스 ID (`/subscriptions/.../providers/Microsoft.OperationalInsights/workspaces/...`)

### 방법 B — Azure Cloud Shell 또는 Azure CLI로 생성

Azure Cloud Shell(PowerShell) 또는 `az login`을 마친 PC에서 아래 변수를 고객사 값으로 바꾸어 실행합니다.

```powershell
$SubId  = "<구독 ID>"
$LogRg  = "<Storage·Workspace가 있는 리소스 그룹 이름>"
$LawName = "<Log Analytics Workspace 이름>"
$DcrName = "dcr-armbackup"

az account set --subscription $SubId
$Law = az monitor log-analytics workspace show -g $LogRg -n $LawName `
  --query "{id:id, location:location, guid:customerId}" -o json | ConvertFrom-Json

$Columns = @(
  @{ name = "TimeGenerated"; type = "datetime" }
  @{ name = "RunId";         type = "string" }
  @{ name = "Level";         type = "string" }
  @{ name = "Event";         type = "string" }
  @{ name = "ResourceId";    type = "string" }
  @{ name = "Status";        type = "string" }
  @{ name = "ErrorCode";     type = "string" }
  @{ name = "Details";       type = "dynamic" }
)

# 1) ArmBackup_CL 사용자 지정 테이블 생성 및 완료 대기
$TableBody = @{ properties = @{ schema = @{ name = "ArmBackup_CL"; columns = $Columns } } } | ConvertTo-Json -Depth 10
$TableBody | Set-Content -Path ./armbackup-table.json -Encoding UTF8
$TableUrl = "https://management.azure.com$($Law.id)/tables/ArmBackup_CL?api-version=2022-10-01"
az rest --method put --url $TableUrl --body '@armbackup-table.json' -o none
for ($i = 0; $i -lt 12; $i++) {
  if ((az rest --method get --url $TableUrl --query properties.provisioningState -o tsv 2>$null) -eq "Succeeded") { break }
  Start-Sleep -Seconds 5
}

# 2) Direct DCR 생성 (입력 스트림 Custom-ArmBackup -> Custom-ArmBackup_CL)
$DcrId = "/subscriptions/$SubId/resourceGroups/$LogRg/providers/Microsoft.Insights/dataCollectionRules/$DcrName"
$DcrBody = @{
  location   = $Law.location
  kind       = "Direct"
  properties = @{
    streamDeclarations = @{ "Custom-ArmBackup" = @{ columns = $Columns } }
    destinations       = @{ logAnalytics = @(@{ name = "workspace"; workspaceResourceId = $Law.id }) }
    dataFlows          = @(@{
      streams      = @("Custom-ArmBackup")
      destinations = @("workspace")
      transformKql = "source"
      outputStream = "Custom-ArmBackup_CL"
    })
  }
} | ConvertTo-Json -Depth 10
$DcrBody | Set-Content -Path ./armbackup-dcr.json -Encoding UTF8
$Dcr = az rest --method put `
  --url "https://management.azure.com${DcrId}?api-version=2023-03-11" `
  --body '@armbackup-dcr.json' `
  --query "{id:id, ruleId:properties.immutableId, endpoint:properties.endpoints.logsIngestion}" -o json | ConvertFrom-Json

Remove-Item ./armbackup-table.json, ./armbackup-dcr.json -Force
Write-Host "Workspace GUID : $($Law.guid)"
Write-Host "Workspace ID   : $($Law.id)"
Write-Host "DCR ID         : $($Dcr.id)"
Write-Host "DCR Rule ID    : $($Dcr.ruleId)"
Write-Host "DCR Endpoint   : $($Dcr.endpoint)"
```

> 사설 로그 수집(DCE + AMPLS)을 강제하는 환경이라면 Direct DCR 대신 DCE를 연결한 DCR을 만들고, 해당 DCE의 `logsIngestion.endpoint` 값을 아래 3단계의 `endpoint`에 입력합니다.

---

## 3. 배포 ZIP 패키지 내 환경 설정 확인 (필요 시 갱신)

고객사 전용으로 전달받은 `armbackup-deploy.zip`에는 구독·Storage 정보가 이미 반영되어 있으므로 **그대로 4단계로 넘어가셔도 됩니다**(Log Analytics는 6.3절에서 환경 변수로 언제든 연결 가능). 만약 Storage 계정이나 대상 구독 값을 직접 바꾸어야 할 때만 아래 PowerShell로 ZIP 내부 설정을 갱신합니다.

```powershell
$SubId            = "<구독 ID>"
$StorageRg        = "<Storage 계정이 있는 리소스 그룹 이름>"
$ZipPath          = (Resolve-Path ./armbackup-deploy.zip).Path
$WorkspaceLabel   = "<화면에 표시할 고객사/환경 이름>"
$SubscriptionName = (az account show --subscription $SubId --query name -o tsv)
$StorageAccount   = "<Storage 계정 이름>"
$ContainerName    = "armbackup"
$RestoreEnabled   = $false   # 복원·복제 기능까지 열려면 $true

Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [IO.Compression.ZipFile]::Open($ZipPath, "Update")
try {
  $ConsoleDoc = [ordered]@{
    capture_config    = "capture.json"
    workspace_name    = $WorkspaceLabel
    subscription_name = $SubscriptionName
    inventory_scope   = "subscription"
    archive_mode      = "blob"
    restore_enabled   = $RestoreEnabled
    activity_days     = 2
  }
  $CaptureDoc = [ordered]@{
    subscriptions    = @($SubId)
    resource_groups  = @($StorageRg)
    discovery_tables = @("Resources")
    exclude_types    = @()
    api_versions     = [ordered]@{
      "microsoft.network/networksecuritygroups" = "2024-05-01"
      "microsoft.network/routetables"           = "2024-05-01"
      "microsoft.network/virtualnetworks"       = "2024-05-01"
    }
    collections      = @{}
    workers          = 3
    retries          = 4
    timeout_seconds  = 60
    credential       = "managed_identity"
    storage          = [ordered]@{
      account_url              = "https://$StorageAccount.blob.core.windows.net"
      container                = $ContainerName
      prefix                   = "armbackup"
      require_private_endpoint = $true
    }
  }
  foreach ($Item in @(@("hosted/console.json", $ConsoleDoc), @("hosted/capture.json", $CaptureDoc))) {
    $EntryName, $Content = $Item
    $Existing = $Archive.GetEntry($EntryName)
    if ($Existing) { $Existing.Delete() }
    $Writer = [IO.StreamWriter]::new($Archive.CreateEntry($EntryName).Open(), [Text.UTF8Encoding]::new($false))
    try { $Writer.Write(($Content | ConvertTo-Json -Depth 10)) } finally { $Writer.Dispose() }
  }
} finally {
  $Archive.Dispose()
}
```

> 사용자 할당 관리 ID(User-Assigned Managed Identity)를 사용하는 경우에만 `$CaptureDoc`에 `managed_identity_client_id = "<Client ID(UUID)>"` 항목을 추가합니다.

---

## 4. App Service 생성 및 네트워크·보안 설정

조직 정책(퍼블릭 액세스 제한 강제 정책 등)에 의해 생성이 거부되지 않도록 **Azure Portal에서 웹앱을 생성할 때 [네트워킹] 탭 설정을 함께 지정**합니다.

### 4.1 웹앱 만들기 (Azure Portal)

1. **기본 사항(Basics)**
   - **게시(Publish)**: `코드(Code)`
   - **런타임 스택(Runtime stack)**: `Python 3.12`
   - **운영 체제(Operating System)**: `Linux`
   - **요금제(Linux Plan)**: 사전 준비한 Linux App Service Plan 선택
2. **네트워킹(Networking)** — 생성 시점에 바로 설정합니다.
   - **퍼블릭 네트워크 액세스**: `선택한 가상 네트워크 및 IP 주소에서 사용(Enabled from select virtual networks and IP addresses)` 선택 (허용 규칙이 없는 동안 모든 외부 접근 차단)
   - **프라이빗 엔드포인트**: `사용(Enabled)` → Private Endpoint용 서브넷 선택, 대상 하위 리소스 `sites`, Private DNS 영역(`privatelink.azurewebsites.net`) 통합 활성화
   - **가상 네트워크 통합**: `사용(Enabled)` → `Microsoft.Web/serverFarms` 위임 서브넷 선택
3. **검토 + 만들기**를 눌러 웹앱을 생성합니다. 접속 주소는 기본 도메인(`https://<앱이름>.azurewebsites.net`)을 그대로 사용해야 하며 사용자 지정 도메인은 지원하지 않습니다.

### 4.2 생성 직후 필수 구성 (Azure Portal)

1. **관리 ID 활성화**: **[설정] > ID(Identity)** > **시스템 할당(System assigned)** 상태를 `켜기(On)`로 저장하고 표시되는 **개체(주체) ID**를 기록합니다.
2. **액세스 제한(Access restrictions) IP 등록**: **[설정] > 네트워킹 > 퍼블릭 네트워크 액세스**에서 아래 두 탭 모두에 허용할 공인 IP 대역(운영자 접속 대역 및 **7단계 코드 배포를 실행할 PC의 아웃바운드 공인 IP**)을 `Allow`로 추가합니다([App Service 액세스 제한](https://learn.microsoft.com/azure/app-service/app-service-ip-restrictions)).
   - **주 사이트(Main site)**: 허용 IP 규칙 추가, 일치하지 않는 규칙 작업 `거부(Deny)` 확인
   - **고급 도구 사이트(Advanced tool site / SCM)**: `주 사이트 규칙 사용`을 체크하거나 주 사이트와 동일한 허용 IP 규칙을 추가하고 일치하지 않는 규칙 작업을 `거부(Deny)`로 설정 (배포 PC IP가 빠지면 ZIP 배포 시 HTTP 403 오류가 발생합니다. VNet 내부 PC에서 Private Endpoint로 배포하는 경우에는 공인 IP 추가가 필요 없습니다.)
3. **App Service 자체 인증 비활성화 확인**: **[설정] > 인증(Authentication)**에서 앱 서비스 플랫폼 인증이 **사용 안 함** 상태인지 확인합니다. 플랫폼 Entra 인증이 켜져 있으면 자체 로그인 화면과 겹쳐 이중 로그인이 발생합니다.
4. **일반 설정 및 시작 명령**: **[설정] > 구성(Configuration) > 일반 설정**에서 아래 값을 설정하고 저장합니다.
   - **시작 명령(Startup Command)**:
     ```text
     PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}" python -m armbackup.webui --hosted --port 8000 --live-config "$PWD/hosted/console.json"
     ```
   - **상시 대기(Always On)**: `켜기(On)`
   - **HTTPS 전용(HTTPS Only)**: `켜기(On)`
   - **최소 인바운드 TLS 암호화**: `1.2`
   - **FTP 상태**: `사용 안 함(Disabled)`
   - **SCM 기본 인증 게시 자격 증명** / **FTP 기본 인증 게시 자격 증명**: 모두 `끄기(Off)`
5. **상태 검사(Health check)**: **[모니터링] > 상태 검사**에서 `사용`을 체크하고 경로에 `/health`를 입력해 저장합니다.

---

## 5. 관리 ID에 RBAC 권한 부여

코드 배포 전에 4.2절에서 확인한 App Service 관리 ID(주체 ID)에 아래 역할을 부여합니다.

| 대상 범위 | 부여할 역할 | 용도 |
| --- | --- | --- |
| 대상 구독 | `Reader` | 구독 내 리소스 Discovery 및 현재 형상·변경 이력 조회 |
| 대상 구독 (선택) | `Contributor` | 복원·복제(`restore_enabled: true`) 및 Application Gateway 백엔드 상태 진단 기능을 사용할 때 함께 부여 |
| 백업 Storage Account | `Storage Blob Data Contributor` | 백업 스냅샷·상태 뷰 읽기/쓰기 및 잠금(Lease) 관리 |
| Log Analytics Workspace (연동 시 선택) | `Log Analytics Reader` | 콘솔 로그 열람 화면 조회 (Log Analytics 미사용 시 생략) |
| 2단계에서 만든 DCR (연동 시 선택) | `Monitoring Metrics Publisher` | 백업·복원 작업 이벤트 로그 전송 (Log Analytics 미사용 시 생략) |
| Key Vault (Key Vault 참조 사용 시) | `Key Vault Secrets User` | 로그인 비밀번호 해시 비밀 읽기 (Key Vault가 Azure RBAC 권한 모델이어야 함) |

역할 할당이 Azure 전체에 전파되기까지 **약 5~10분**이 걸립니다.

---

## 6. 로그인 비밀번호 해시 생성 및 환경 변수 설정

### 6.1 비밀번호 해시 생성

앱은 비밀번호 원문을 저장하지 않으며 `scrypt` 해시 문자열만 환경 변수로 받습니다. 비밀번호는 **12자 이상**(24자 이상 무작위 문자열 권장)이어야 합니다. Python 3가 설치된 PC 또는 Azure Cloud Shell(Bash/PowerShell)에서 외부 패키지 설치 없이 아래 명령으로 해시를 생성합니다.

```bash
# macOS / Linux / Azure Cloud Shell (Windows PowerShell에서는 python3 대신 python 사용)
python3 -c 'import base64,getpass,hashlib,secrets; pw=getpass.getpass("Password (12+ chars): "); assert len(pw)>=12, "12+ chars required"; assert pw==getpass.getpass("Repeat: "), "mismatch"; s=secrets.token_bytes(16); b=lambda x:base64.urlsafe_b64encode(x).decode().rstrip("="); d=hashlib.scrypt(pw.encode(),salt=s,n=32768,r=8,p=3,maxmem=268435456,dklen=32); print(f"scrypt:32768:8:3:{b(s)}:{b(d)}")'
```

출력된 `scrypt:32768:8:3:...` 문자열을 그대로 앱 설정에 넣거나, Key Vault 비밀(Secret)로 저장한 뒤 버전 없는 참조 형식인 `@Microsoft.KeyVault(SecretUri=https://<키볼트이름>.vault.azure.net/secrets/<비밀이름>/)`을 사용합니다([App Service Key Vault 참조](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)).

### 6.2 환경 변수(앱 설정) 등록

Azure Portal **[설정] > 환경 변수(Environment variables) > 앱 설정**에서 아래 항목을 추가하고 **적용**을 누릅니다.

| 이름 | 값 | 필수 여부·설명 |
| --- | --- | --- |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | 필수. ZIP 배포 시 `requirements.txt` 패키지 자동 설치 |
| `ENABLE_ORYX_BUILD` | `true` | 필수. Oryx 빌드 활성화 |
| `ORYX_DISABLE_COMPRESSION` | `true` | 필수. Oryx 빌드 출력 옵션 |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` | 필수. 첫 빌드·기동 대기 시간(초) |
| `ARMBACKUP_AUTH_MODE` | `password` | 필수. 자체 ID/비밀번호 로그인 모드 |
| `ARMBACKUP_AUTH_USERNAME` | `<운영자 아이디>` | 필수. 영문·숫자·`. _ @ -` 조합 3~64자 (예: `ops.admin`) |
| `ARMBACKUP_AUTH_PASSWORD_HASH` | `scrypt:32768:8:3:...` 또는 `@Microsoft.KeyVault(SecretUri=...)` | 필수. 6.1절에서 만든 해시 또는 Key Vault 참조 |
| `ARMBACKUP_AUTH_IDLE_MINUTES` | `30` | 생략 가능. 비활성 세션 만료 시간(분, 5~480, 기본 30) |
| `ARMBACKUP_AUTH_SESSION_HOURS` | `8` | 생략 가능. 최대 세션 유지 시간(시간, 1~24, 기본 8) |
| `ARMBACKUP_AUTH_MAX_FAILURES` | `5` | 생략 가능. 클라이언트 IP당 연속 로그인 실패 허용 횟수(3~20, 기본 5) |
| `ARMBACKUP_AUTH_LOCKOUT_MINUTES` | `15` | 생략 가능. 로그인 실패 초과 시 차단 시간(분, 1~240, 기본 15) |

> **Key Vault 참조 사용 시 주의**: 앱 설정을 저장한 뒤 포털의 환경 변수 목록에서 `ARMBACKUP_AUTH_PASSWORD_HASH`의 Key Vault 참조 상태가 **초록색 확인 표시(`Resolved`)**로 바뀐 것을 반드시 확인하고 7단계 배포를 진행해 주세요. 참조를 해석하기 전에 앱이 시작하면 설정 검증 오류로 종료하고 App Service가 컨테이너를 멈춥니다. 아직 빨간색 표시라면 5단계 권한 전파를 잠시 기다린 뒤 환경 변수 화면의 **프라이빗 참조 가져오기(Pull reference values)** 또는 웹앱 **다시 시작**을 실행합니다.

### 6.3 (선택) 추후 Log Analytics 수동 연결용 환경 변수

처음 배포할 때는 아래 환경 변수를 넣지 않아도 됩니다. 추후 2단계 절차로 Log Analytics 테이블(`ArmBackup_CL`)·DCR과 5단계 권한(`Log Analytics Reader`, `Monitoring Metrics Publisher`)을 준비한 뒤, **ZIP 재배포 없이** 포털 **[설정] > 환경 변수**에 아래 5개 항목을 추가하고 **적용**하면 즉시 Log Analytics 전송·조회가 활성화됩니다.

| 이름 | 값 예시 | 설명 |
| --- | --- | --- |
| `ARMBACKUP_LOG_WORKSPACE_ID` | `/subscriptions/.../providers/Microsoft.OperationalInsights/workspaces/<이름>` | Log Analytics Workspace의 전체 ARM 리소스 ID |
| `ARMBACKUP_LOG_WORKSPACE_GUID` | `00000000-0000-0000-0000-000000000000` | Workspace 개요 화면의 작업 영역 ID(GUID) |
| `ARMBACKUP_LOG_DCR_ID` | `/subscriptions/.../providers/Microsoft.Insights/dataCollectionRules/dcr-armbackup` | DCR의 전체 ARM 리소스 ID |
| `ARMBACKUP_LOG_RULE_ID` | `dcr-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | DCR의 불변 ID(`immutableId`) |
| `ARMBACKUP_LOG_ENDPOINT` | `https://dce-....ingest.monitor.azure.com` | DCE(방법 A) 또는 Direct DCR(방법 B)의 로그 수집 엔드포인트 URL |
| `ARMBACKUP_LOG_STREAM` | 포털 생성 시 **`Custom-ArmBackup_CL`** / CLI 생성 시 `Custom-ArmBackup` | 포털 UI 마법사(방법 A)로 생성하면 스트림 이름 뒤에 `_CL`이 붙으므로 반드시 `Custom-ArmBackup_CL`로 입력 (생략 시 기본값 `Custom-ArmBackup`) |

> **장애 격리 안내**: Log Analytics Workspace·DCR·DCE 설정값에 오타가 있거나 권한(`Log Analytics Reader`, `Monitoring Metrics Publisher`)·네트워크 전파가 아직 완료되지 않았더라도 **콘솔 기동·리소스 수집·백업·복원은 멈추지 않고 정상 수행**됩니다. 문제가 있는 동안에는 콘솔 우측 상단 알림과 **로그·작업 이력** 화면에 점검 사유만 표시되며, 모든 작업 이력은 Storage **작업 완료 기록** 탭과 App Service 컨테이너 로그에 그대로 남습니다.

---

## 7. 패키지 배포 및 정상 동작 확인

### 7.1 ZIP 패키지 배포

SCM 접근이 허용된 배포 PC(또는 Private Endpoint가 연결된 VNet 내부 PC)에서 Azure CLI로 3단계에서 준비한 `armbackup-deploy.zip`을 배포합니다([az webapp deploy](https://learn.microsoft.com/cli/azure/webapp#az-webapp-deploy)).

```powershell
$AppRg   = "<App Service 리소스 그룹 이름>"
$AppName = "<App Service 이름>"

az account set --subscription $SubId
az webapp deploy `
  --resource-group $AppRg `
  --name $AppName `
  --src-path ./armbackup-deploy.zip `
  --type zip `
  --clean true `
  --restart true
```

첫 배포는 Oryx 패키지 설치와 초기 스냅샷 수집을 포함해 **약 3~7분**이 걸립니다(`--clean true` 옵션은 이전 배포의 구버전 압축 아티팩트 `output.tar.zst`가 남아 실행되는 현상을 방지합니다).

### 7.2 기동 및 보안 경계 확인

1. **상태 엔드포인트 확인**: 허용된 네트워크에서 아래 명령을 실행했을 때 `"status": "ok"`, `"azureConnected": true`가 응답으로 오고, 잠시 뒤 `"collector"`의 `"state"`가 `"Succeeded"`로 바뀌는지 확인합니다.
   ```powershell
   $Curl = if ($PSVersionTable.PSEdition -eq "Desktop" -or $IsWindows) { "curl.exe" } else { "curl" }
   $NullOut = if ($PSVersionTable.PSEdition -eq "Desktop" -or $IsWindows) { "NUL" } else { "/dev/null" }

   & $Curl -s "https://$AppName.azurewebsites.net/health"
   ```
2. **익명 API 차단 확인**: 로그인 없이 `/api/session`을 호출했을 때 HTTP `401`을 반환하는지 확인합니다.
   ```powershell
   & $Curl -s -o $NullOut -w "%{http_code}`n" "https://$AppName.azurewebsites.net/api/session"
   ```
3. **콘솔 로그인 확인**: 브라우저에서 `https://<앱이름>.azurewebsites.net/`에 접속해 `/login` 화면으로 이동하는지, 6단계에서 등록한 아이디·비밀번호로 로그인해 구독 리소스 현황이 조회되는지, 로그아웃이 정상 동작하는지 확인합니다.
4. **배포용 임시 IP 정리**: 배포를 위해 PC 공인 IP를 임시로 추가했다면 포털 **네트워킹 > 액세스 제한**에서 해당 규칙을 삭제합니다.

---

## 8. 문제 해결 점검표

| 증상 | 주요 원인 | 조치 방법 |
| --- | --- | --- |
| `az webapp deploy` 실행 시 `HTTP 403` 실패 | 배포 PC의 아웃바운드 공인 IP가 고급 도구 사이트(SCM) 허용 목록에 없음 | 포털 **네트워킹 > 액세스 제한 > 고급 도구 사이트**에 배포 PC 공인 IP를 추가하고 1분 뒤 다시 배포합니다. |
| 기동 실패 (`unresolved Key Vault reference`) | Key Vault RBAC 권한 미전파 또는 VNet에서 Key Vault 사설 DNS 미해석 | 관리 ID의 `Key Vault Secrets User` 역할과 `privatelink.vaultcore.azure.net` VNet 링크를 확인하고, 환경 변수 탭에서 참조 상태가 `Resolved`가 된 뒤 웹앱을 **시작/다시 시작**합니다. |
| 기동 실패 (`Storage DNS must resolve only to private addresses` 또는 `Blob container preflight failed`) | VNet Integration 미연결, Blob 사설 DNS 미연결, 컨테이너 미생성, 또는 Storage RBAC 누락 | VNet Integration 서브넷 연결, `privatelink.blob.core.windows.net` VNet 링크, 컨테이너 존재 여부, `Storage Blob Data Contributor` 역할을 확인합니다. |
| 콘솔 우측 상단에 `Log Analytics:` 경고 알림이 표시되거나 Log Analytics 탭에 점검 필요 표시 | `ARMBACKUP_LOG_*` 환경 변수 오타, 스트림 이름 불일치(포털 생성 DCR은 `Custom-ArmBackup_CL`), 또는 관리 ID의 `Log Analytics Reader` / `Monitoring Metrics Publisher` 권한 미전파 | 백업·복원과 Storage 작업 완료 기록은 정상 동작하므로 서비스 중단은 없습니다. 6.3절 환경 변수 6개와 5단계 RBAC 권한을 확인·수정한 뒤 웹앱을 다시 시작하면 재배포 없이 복구됩니다. |
| 접속 시 Microsoft 로그인 창이 먼저 뜨고 이후 자체 로그인 창이 또 표시됨 | App Service 자체 인증(EasyAuth)이 켜져 있음 | 포털 **[설정] > 인증**에서 플랫폼 인증을 **사용 안 함**으로 변경합니다. |
| 배포 후 컨테이너가 뜨지 않고 배포 로그에 `pip` 연결 시간 초과가 기록됨 | VNet 방화벽/NSG에서 PyPI 아웃바운드 차단 | VNet Integration 서브넷에서 `pypi.org` 및 `files.pythonhosted.org`(TCP 443) 아웃바운드를 허용한 뒤 다시 배포합니다. |

구체적인 기동 오류 메시지는 `az webapp log download -g $AppRg -n $AppName --log-file logs.zip`으로 내려받은 압축 파일 내 `LogFiles/StartupLogs/*_failure.log` 마지막 줄에서 확인할 수 있습니다.
