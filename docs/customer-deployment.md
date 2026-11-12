# 고객사 App Service 배포·환경 변수·로그인 설정

> 범위: 고객 구독의 App Service에 콘솔을 올리는 절차. 인프라 전제(VNet·Blob PE·DCR·권한)는 [deployment.md](deployment.md)를 따른다. 이 문서의 명령은 자동 적용되지 않는다.

**한 줄 요약** — 패키지를 만들고, 앱 설정(환경 변수)으로 로그인 방식(현재는 `password`만 사용 가능)을 고른 뒤, ZIP을 배포하고, 익명 접근이 막히는지 확인한다.

> **Entra 로그인은 임시로 비활성화되어 있다.** App Registration을 아직 사용할 수 없으므로 `ARMBACKUP_AUTH_MODE`의 기본값이 `password`이고, `entra`로 지정하면 앱이 시작하지 않는다. Bicep(`authMode`)과 `deploy-customer.ps1`(`-AuthMode`)도 `entra`를 거부한다. 다시 켜려면 [auth.py](../src/armbackup/auth.py)의 `ENTRA_ENABLED`를 `True`로 바꾸고, Bicep `authMode`의 `@allowed`와 `deploy-customer.ps1`의 `entra` 거부 코드를 되돌린다.

## 1. 로그인 방식 선택 — `ARMBACKUP_AUTH_MODE`

| 값 | 로그인 | 필요한 것 |
| --- | --- | --- |
| `password` (기본값) | 앱이 제공하는 로그인 화면(`/login`). 아이디 1개+비밀번호 | App Registration 불필요. 앱 설정 `ARMBACKUP_AUTH_USERNAME`·`ARMBACKUP_AUTH_PASSWORD_HASH`, **App Service 인증은 끔** |
| `entra` (**임시 비활성화**) | App Service 인증(EasyAuth)+Microsoft Entra ID. 지정한 1명(object ID)·테넌트만 허용 | App Registration, 앱 설정 `ARMBACKUP_OPERATOR_ID`·`ARMBACKUP_TENANT_ID`·`MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` |

값이 없거나 잘못되면 앱이 시작하지 않는다(보안 설정은 실패 시 열리지 않는다). 방식을 바꾸려면 앱 설정과 App Service 인증 상태를 함께 바꾸고 앱을 재시작한다(§6).

### 비밀번호 방식의 구현 — 무엇이 안전한가

- 비밀번호 원문은 어디에도 저장하지 않는다. 앱 설정에는 **salt가 있는 scrypt 해시**(OWASP 권장 파라미터 N=2^15, r=8, p=3)만 둔다. 해시는 콜론(`:`)으로만 구성되어 셸·앱 설정에서 이스케이프가 필요 없다.
- 로그인 성공 시 무작위 256비트 세션 토큰을 서버 메모리에 두고, 브라우저에는 `__Host-armbackup-session` 쿠키(`Secure; HttpOnly; SameSite=Strict; Path=/`)만 준다. 비활성 30분·최대 8시간 후 만료하고, 로그아웃·재시작·설정 변경 시 즉시 무효화된다.
- 아이디/비밀번호 중 무엇이 틀렸는지 알려 주지 않고, 항상 해시를 계산해 응답 시간 차이를 줄인다. 클라이언트 IP당 5회, 전체 50회 실패 시 15분간 로그인을 막는다(HTTP 429). 실패·차단은 `auth_login_failed`·`auth_login_blocked`(클라이언트 IP만, 입력한 아이디 제외)로 App Service 로그에 남는다.
- 로그인 이후의 모든 API·화면은 기존 보호(정확한 Host·Origin 검사, 요청별 `X-Console-Token`, CSP)를 그대로 적용한다. 로그인 화면과 정적 파일(`/login`, `/login.mjs`, `/styles.css`, `/favicon.svg`)과 `/health`만 로그인 전에 열려 있다.
- 세션이 메모리에 있으므로 **인스턴스를 1개로 유지**한다(이 앱의 수집 스레드도 단일 인스턴스를 전제한다). 스케일 아웃하지 않는다.

**한계(고객에게 그대로 알린다):** 비밀번호 방식은 MFA·조건부 액세스·개별 감사 추적이 없고 계정이 1개다. 이를 보완하려면 아래를 함께 적용한다.

1. 비밀번호는 `--generate`로 만든 무작위 값(≥24자)을 비밀번호 관리자에 보관한다. 최소 12자 미만은 해시 생성이 거부된다.
2. **접근 제한(Access Restrictions)으로 고객 사무실/VPN의 고정 IP만 허용**하거나 Private Endpoint로 인바운드를 사설화한다. 인터넷 전체에 로그인 화면을 노출하지 않는 것이 가장 큰 방어다.
3. 가능하면 해시를 Key Vault 참조(`@Microsoft.KeyVault(SecretUri=…)`)로 둔다. 이 경우 앱 관리 ID에 Key Vault Secrets User 권한과 Key Vault 접근 경로가 필요하다.
4. 담당자 변경·유출 의심 시 즉시 해시를 교체한다(§6). 정기 교체 주기를 정한다.
5. Entra App Registration이 가능해지면 `entra`로 전환한다.

## 2. 환경 변수(앱 설정) 목록

앱 설정은 App Service 구성 > 환경 변수(포털) 또는 `az webapp config appsettings set`으로 넣는다. 값 변경은 앱을 재시작한다.

### 공통(필수)

| 이름 | 값 |
| --- | --- |
| `ARMBACKUP_AUTH_MODE` | `password` (`entra`는 임시 비활성화) |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` (Oryx가 `requirements.txt` 설치) |
| `ENABLE_ORYX_BUILD` | `true` |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` (첫 빌드·시작 대기) |

시작 명령(구성 > 일반 설정 > Startup Command): `PYTHONPATH=$PWD/src python -m armbackup.webui --hosted --port 8000 --live-config $PWD/hosted/console.json`. 이 앱은 `WEBSITE_SITE_NAME`·`WEBSITE_HOSTNAME`이 있는 App Service에서만 `--hosted`로 시작하며, 호스트 이름은 `*.azurewebsites.net`이어야 한다(사용자 지정 도메인은 지원하지 않는다).

### `entra`일 때 (임시 비활성화 — 현재 사용 불가)

| 이름 | 값 |
| --- | --- |
| `ARMBACKUP_OPERATOR_ID` | 허용할 운영자의 Entra object ID(GUID) |
| `ARMBACKUP_TENANT_ID` | 테넌트 ID(GUID) |
| `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` | App Registration client secret(만료 전 교체) |

### `password`일 때

| 이름 | 값 | 기본값·범위 |
| --- | --- | --- |
| `ARMBACKUP_AUTH_USERNAME` | 로그인 아이디. 영문·숫자·`. _ @ -` 3~64자 | 선택. 아이디와 해시를 **둘 다 비우면** 임시 기본 계정 `admin` / `password`로 시작하고 경고 로그를 남긴다. 하나만 넣으면 시작하지 않는다. 운영 전에 반드시 교체한다 |
| `ARMBACKUP_AUTH_PASSWORD_HASH` | §3에서 만든 `scrypt:…` 값 | 선택(위 기본 계정 규칙 참고) |
| `ARMBACKUP_AUTH_IDLE_MINUTES` | 비활성 만료(분) | 30 (5~480) |
| `ARMBACKUP_AUTH_SESSION_HOURS` | 최대 세션 시간 | 8 (1~24) |
| `ARMBACKUP_AUTH_MAX_FAILURES` | IP당 연속 실패 허용 횟수(전체 한도는 ×10) | 5 (3~20) |
| `ARMBACKUP_AUTH_LOCKOUT_MINUTES` | 차단 시간(분) | 15 (1~240) |

`ARMBACKUP_OPERATOR_ID`·`MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`은 `password` 모드에서 쓰지 않으므로 제거해도 된다.

## 3. 비밀번호 해시 만들기 (`password` 모드)

로컬에서 실행한다(서버에 비밀번호를 보내지 않는다).

```powershell
.\.venv\Scripts\python.exe -m armbackup.auth hash-password --generate
```

화면에 비밀번호(한 번만 표시)와 `ARMBACKUP_AUTH_PASSWORD_HASH=scrypt:…`이 출력된다. 비밀번호는 비밀번호 관리자에 저장하고 터미널 기록은 지운다. 직접 정한 비밀번호를 쓰려면 `--generate` 없이 실행해 두 번 입력한다.

## 4. 패키지 만들기

`ARMBACKUP_DEPLOY_CONFIG`는 `console`·`capture` 두 키를 가진 JSON(비밀·토큰·로컬 경로 없음)이다. 필수 값은 `console.archive_mode=blob`, `capture.credential=managed_identity`, `capture.storage.require_private_endpoint=true`이며 나머지 키는 [configuration.md](configuration.md)와 [console.example.json](../examples/console.example.json)·[config.example.json](../examples/config.example.json)을 고객 값으로 채운다.

```powershell
$env:ARMBACKUP_DEPLOY_CONFIG = Get-Content .\deploy-config.json -Raw
$env:GITHUB_SHA = (git rev-parse HEAD)   # 선택: /health의 build 값으로 배포 확인
.\.venv\Scripts\python.exe scripts\package_appservice.py --output deploy.zip
```

ZIP에는 소스·정적 파일·위 설정만 들어가며 비밀은 들어가지 않는다.

## 5. 배포 절차

> 아래 수동 CLI 절차는 각 단계가 무엇을 하는지 설명하는 참고용이다. 같은 일을 한 번에 수행하는 스크립트는 §7을 쓴다.
변수를 먼저 정의한다: `$RG`, `$APP`(앱 이름), `$PLAN`, `$SUB`. 앱·Plan·VNet Integration·Blob PE·역할 부여는 [deployment.md](deployment.md) §1~§4를 따른다. [infra/main.bicep](../infra/main.bicep)에 쓰인 리소스 이름·테넌트·LAB RG는 **테스트 구독 상수**이므로 고객 배포에 그대로 쓰지 않는다. 고객 값으로 고치거나 아래 CLI로 구성한다.

1. **관리 ID와 권한**

   ```powershell
   az webapp identity assign -g $RG -n $APP
   ```

   관리 ID에 구독 Reader·Contributor(또는 합의한 범위), Storage Blob Data Contributor, DCR Monitoring Metrics Publisher, Workspace Log Analytics Reader를 부여한다([deployment.md §3](deployment.md#3-최소권한)).

2. **HTTPS·TLS·FTP·SCM 기본 인증**

   ```powershell
   az webapp update -g $RG -n $APP --https-only true
   az webapp config set -g $RG -n $APP --min-tls-version 1.2 --ftps-state Disabled --always-on true
   ```

   포털 모니터링 > 상태 검사(Health check)에서 경로를 `/health`로 지정한다. SCM·FTP 기본 인증은 Entra 토큰 배포를 쓰도록 끈다. `basic-auth-off.json` 파일에 `{"properties":{"allow":false}}`를 저장한 뒤 `scm`과 `ftp` 각각에 적용한다.

   ```powershell
   foreach ($policy in "scm", "ftp") {
     az rest --method put --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/basicPublishingCredentialsPolicies/${policy}?api-version=2023-12-01" --body '@basic-auth-off.json'
   }
   ```

3. **시작 명령과 환경 변수**

   ```powershell
   az webapp config set -g $RG -n $APP --startup-file 'PYTHONPATH=$PWD/src python -m armbackup.webui --hosted --port 8000 --live-config $PWD/hosted/console.json'
   ```

   - `entra`:

     ```powershell
     az webapp config appsettings set -g $RG -n $APP --settings ARMBACKUP_AUTH_MODE=entra ARMBACKUP_OPERATOR_ID=<objectId> ARMBACKUP_TENANT_ID=<tenantId> MICROSOFT_PROVIDER_AUTHENTICATION_SECRET=<secret> SCM_DO_BUILD_DURING_DEPLOYMENT=true ENABLE_ORYX_BUILD=true WEBSITES_CONTAINER_START_TIME_LIMIT=1800
     ```

     이어서 App Service 인증(Entra, 허용 주체 1명, `/health` 제외, `RedirectToLoginPage`)을 구성한다. 파라미터는 [app-service.bicep](../infra/modules/app-service.bicep)의 `authsettingsV2`를 참고한다.

   - `password`:

     ```powershell
     az webapp auth update -g $RG -n $APP --enabled false
     az webapp config appsettings set -g $RG -n $APP --settings ARMBACKUP_AUTH_MODE=password ARMBACKUP_AUTH_USERNAME=<아이디> ARMBACKUP_AUTH_PASSWORD_HASH='<§3의 scrypt:… 값>' SCM_DO_BUILD_DURING_DEPLOYMENT=true ENABLE_ORYX_BUILD=true WEBSITES_CONTAINER_START_TIME_LIMIT=1800
     ```

     포털에서 입력하면 명령 기록에 남지 않는다. CLI를 쓴다면 완료 후 터미널 기록을 정리한다.

4. **접근 제한(`password` 모드에서 사실상 필수)**

   ```powershell
   az webapp config access-restriction add -g $RG -n $APP --rule-name customer-office --action Allow --ip-address <고객 고정 IP>/32 --priority 100
   ```

   Allow 규칙을 하나라도 추가하면 나머지는 차단된다. 배포를 실행하는 곳이 SCM에 접근해야 하므로 같은 IP를 `--scm-site true`로도 추가한다. GitHub 호스티드 러너는 이 제한에 막혀 [appservice.yml](../.github/workflows/appservice.yml)의 배포·`/health` 확인 단계가 실패하므로, IP 제한을 쓰면 고객망의 배포 에이전트나 수동 배포를 사용한다. 제한 적용 후 App Service 상태 검사가 정상(Healthy)인지 확인한다.

5. **배포**

   ```powershell
   az webapp deploy -g $RG -n $APP --src-path deploy.zip --type zip
   ```

   첫 Oryx 빌드·시작은 수 분 걸린다. GitHub Actions로 배포하는 경우 [appservice.yml](../.github/workflows/appservice.yml)의 저장소 변수(`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_WEBAPP_NAME`, `AZURE_RESOURCE_GROUP`, `ARMBACKUP_DEPLOY_CONFIG`)와 OIDC 연합 자격 증명을 고객 환경에 맞게 만든다. 이 워크플로의 확인 단계는 두 모드 모두 통과한다(익명 `/api/session`은 `401` 또는 `302`/`403`).

## 6. 확인과 운영

**배포 확인**

```powershell
$HOST_NAME = az webapp show -g $RG -n $APP --query defaultHostName -o tsv
curl.exe -s https://$HOST_NAME/health                       # status ok, build = 배포한 커밋 앞 12자리
curl.exe -s -o NUL -w "%{http_code}\n" https://$HOST_NAME/api/session   # password: 401, entra: 302 또는 401
curl.exe -s -o NUL -w "%{http_code} %{redirect_url}\n" https://$HOST_NAME/   # password: 302 → /login
```

브라우저로 `https://<앱>.azurewebsites.net/`에 접속해 로그인하고 화면이 로드되는지, 잘못된 비밀번호를 5회 입력하면 429 안내가 나오는지, 로그아웃 후 `/`가 다시 `/login`으로 이동하는지 확인한다. 로그는 `az webapp log tail -g $RG -n $APP`로 `auth_login_*`·`snapshot_published`를 본다.

**비밀번호 교체**: §3로 새 해시를 만들고 `ARMBACKUP_AUTH_PASSWORD_HASH`를 바꾼다. 앱이 재시작되며 기존 세션이 모두 끊긴다.

**방식 전환**
- `entra` → `password`: 위 `password` 설정을 넣고 `az webapp auth update --enabled false`.
- `password` → `entra`: App Registration과 App Service 인증(Entra)을 구성하고 `ARMBACKUP_AUTH_MODE=entra`와 Entra 설정 3개를 넣는다. 인증을 켜기 전에 앱 설정만 `entra`로 바꾸면 인증이 꺼진 상태로 모든 요청이 `403`이 되어 접근이 닫힌다(열리지 않는다).

**알려진 제약**: 단일 인스턴스, `*.azurewebsites.net` 호스트 전용, 로그인 계정 1개, 다중 사용자/RBAC 없음. 클라이언트 IP는 App Service가 붙이는 `X-Forwarded-For`의 마지막 값을 쓰므로 Front Door/Application Gateway 같은 프록시를 앞에 두면 모든 요청이 같은 IP로 보일 수 있다(전체 한도가 먼저 걸린다). 프록시를 쓰면 이 점을 다시 검토한다.

## 7. 스크립트 하나로 배포 (기존 Plan·Storage·Key Vault 재사용)

[scripts/deploy-customer.ps1](../scripts/deploy-customer.ps1) 한 파일(Azure CLI만 사용, Bicep·설정 파일 불필요)이 이미 있는 App Service Plan, VNet 서브넷, Storage, Workspace/DCR, Key Vault를 **참조만** 하고 아래를 순서대로 수행한다.

1. Web App 생성(기존 Linux Plan, Python 3.12)과 시스템 관리 ID, HTTPS 강제
2. 사이트 설정(Always On·TLS 1.2·FTPS 끔·`/health` 상태 검사·시작 명령), IP 접근 제한(앱·SCM), VNet Integration(선택), SCM·FTP 기본 인증 차단
3. 앱 설정(`ARMBACKUP_AUTH_MODE` 등)과 로그인 방식에 맞는 App Service 인증 설정(`password`는 끔, `entra`는 켬). 반대 모드의 남은 설정은 삭제한다
4. 관리 ID에 역할 부여: 구독 Reader·Contributor, Storage Blob Data Contributor, Log Analytics Reader, Monitoring Metrics Publisher, (선택) Key Vault Secrets User
5. 패키징 → ZIP 배포 → `/health`·익명 접근 차단 확인

**사전 조건**: Azure CLI 로그인, 대상 RG 존재, Plan은 Linux, 서브넷은 `Microsoft.Web/serverFarms`에 위임됨, Blob Private Endpoint·사설 DNS 준비(스크립트는 만들지 않는다), 배포 계정에 RG의 Contributor와 역할 부여 권한(Owner 또는 User Access Administrator). 리소스는 **리소스 ID**로 받으므로 서로 다른 RG에 있어도 된다.

**비밀 처리**: 아래 중 하나를 쓴다. 값은 임시 파일로만 전달하고 종료 시 삭제한다.
- Key Vault 참조: `-PasswordHash '@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)'`(버전 없는 URI). 비밀은 미리 만들어 둔다. 필요 조건:
  - Vault는 **Azure RBAC 권한 모델**이어야 한다. `-KeyVaultId`를 주면 스크립트가 Key Vault Secrets User를 부여한다.
  - 정책으로 Vault의 공용 네트워크 접근이 꺼져 있는 환경이 흔하다(2026-11 테스트 구독이 그랬다). 이 경우 앱이 VNet Integration으로 Vault에 닿도록 **Vault Private Endpoint와 `privatelink.vaultcore.azure.net` 사설 DNS 영역(앱 VNet에 연결)**이 미리 있어야 한다. 없으면 참조가 해석되지 않는다.
  - 같은 이유로 배포 PC에서 `az keyvault secret set`(데이터 평면)이 막힐 수 있다. 이때는 관리 평면으로 넣는다: `az rest --method put --url "https://management.azure.com/subscriptions/<구독>/resourceGroups/<RG>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/<name>?api-version=2023-07-01" --body '{"properties":{"value":"<scrypt 해시>"}}'` (본문은 파일로 `@file` 전달).
  - 역할 부여는 전파에 몇 분 걸린다. 스크립트는 **참조가 `Resolved`가 될 때까지 최대 15분 대기한 뒤** 코드를 배포한다. 대기하지 않으면 앱이 참조 문자열을 해시로 읽고 안전하게 종료하며, 플랫폼이 사이트를 중지시켜 저절로 복구되지 않는다.
- 환경 변수: `ARMBACKUP_AUTH_PASSWORD_HASH`(password), `ARMBACKUP_ENTRA_CLIENT_SECRET`(entra). 명령줄에 비밀을 남기지 않는다.

**실행** (`-WhatIf`로 먼저 변경 내용만 확인한다)

```powershell
$id = @{ Sub = "<구독 ID>"; Rg = "rg-armbackup" }
.\scripts\deploy-customer.ps1 `
  -SubscriptionId $id.Sub -ResourceGroup $id.Rg -AppName app-armbackup-acme `
  -AppServicePlanId "<Plan 리소스 ID>" -VnetSubnetId "<서브넷 리소스 ID>" `
  -AuthMode password -Username ops.admin `
  -PasswordHash '@Microsoft.KeyVault(SecretUri=https://kv-acme.vault.azure.net/secrets/armbackup-hash/)' `
  -AllowedClientIps 203.0.113.10/32 `
  -StorageAccountId "<Storage 리소스 ID>" -WorkspaceId "<Workspace 리소스 ID>" -DcrId "<DCR 리소스 ID>" -KeyVaultId "<Key Vault 리소스 ID>" `
  -DeployConfigFile .\deploy-config.local.json -WhatIf
```

`-WhatIf`를 빼면 실제로 배포한다. `-DeployConfigFile`은 §4의 `ARMBACKUP_DEPLOY_CONFIG` JSON 파일이다(`*.local.json`은 Git에서 제외된다). `-Username`과 `-PasswordHash`를 **둘 다 생략**하면 스크립트가 두 앱 설정을 삭제하여 앱이 임시 기본 계정 `admin` / `password`로 시작한다(기존 사용자 지정 계정도 지워진다). 운영 전에 둘 다 지정해 교체한다. `-AuthMode entra`는 임시 비활성화되어 사용할 수 없다.

| 스위치 | 용도 |
| --- | --- |
| `-WhatIf` | 모든 변경을 출력만 하고 아무것도 만들지 않는다 |
| `-SkipRoles` | 역할 부여를 다른 담당자가 한다. [deployment.md §3](deployment.md#3-최소권한)의 역할이 부여되기 전까지 앱은 동작하지 않는다 |
| `-SkipSubscriptionRoles` | 구독 Reader·Contributor만 건너뛴다(범위를 좁게 주려는 경우, 이후 직접 부여) |
| `-SkipCode` | 인프라·설정만 갱신하고 코드는 올리지 않는다 |
| `-SkipVerify` | `/health` 확인을 건너뛴다(배포 PC가 허용 IP가 아닐 때) |
| `-AllowCurrentIp` | 이 PC의 공인 IP를 허용 목록에 추가한다(IP 제한을 쓰는데 배포 PC가 목록에 없을 때). 배포 후 제거하려면 이 스위치 없이 `-SkipCode`로 다시 실행한다 |
| `-PackagePath` | 미리 만든 배포 ZIP을 올린다. 소스·git·Python이 없는 PC용(§8) |

**주의**
- `-AllowedClientIps`를 지정하면 앱과 SCM 모두 그 IP만 허용한다. 스크립트를 실행하는 PC의 공인 IP가 목록에 없으면 코드 배포·확인이 실패한다. 비워 두면 로그인 화면이 인터넷 전체에 열리며 경고를 출력한다.
- 같은 값으로 다시 실행해도 안전하다(멱등). 앱 설정·IP 제한은 스크립트 값이 기준이라 포털에서 바꾼 값은 다음 실행에 되돌려진다. 새 IP 허용 목록은 전체 목록으로 다시 넘긴다.
- Bicep 방식([infra/main.bicep](../infra/main.bicep))은 테스트 구독 전체를 만드는 용도이며, 고객 배포는 이 스크립트를 쓴다.
- 소요 시간: 처음부터 약 6~7분(Oryx 빌드 약 2분, 첫 기동·수집 포함). `az webapp deploy`의 자체 상태 추적은 10분에서 "실패"로 오판할 수 있어 스크립트는 `--track-status false`로 배포하고 `/health`로 직접 확인한다(최대 20분 대기). 플랫폼이 사이트를 중지시켰다면 대기 중에 자동으로 시작한다.
- 앱이 시작하지 않으면 `az webapp log download`로 받은 `LogFiles\StartupLogs\*_failure.log` 끝줄에 원인이 나온다(예: `Console server could not start: ...`).
- 2026-11-12 이 저장소의 테스트 구독(Korea Central, 기존 B1 Plan·VNet·Blob PE·Storage·Workspace·DCR 재사용, Vault는 공용 접근 차단+PE)에서 **앱을 삭제한 뒤 처음부터 1회 실행으로 성공**(386초)을 확인했다. 확인한 것: 익명 `/`는 `/login`으로 302, 잘못된 비밀번호 401, 5회 실패 후 429+`Retry-After`, 로그인 성공 시 `__Host-` 쿠키 발급, 로그인 후 `/api/state`에서 구독 리소스 172개와 저장본 읽기, 로그아웃 후 401, Key Vault 참조 `Resolved`, 부여된 역할 6건, SCM·FTP 기본 인증 차단. `password`→`entra` 전환은 별도 임시 앱으로 확인했다. 이 환경의 앱 IP 제한(`-AllowedClientIps`)은 배포 PC의 공인 IP로 시험했고, 다른 IP에서의 차단과 `-AuthMode entra`의 실제 Entra 로그인은 시험하지 않았다.

## 8. 소스 코드가 없는 PC에서 배포

배포 PC에는 **소스, git, Python이 필요 없다.** 코드를 아는 PC(개발 PC)에서 배포 ZIP을 한 번 만들고, 배포 PC에는 **스크립트 1개 + ZIP 1개**만 옮긴다.

### 1) 개발 PC: 배포 묶음 만들기

고객 값(비밀 없는 JSON)으로 ZIP을 만든다. `deploy-config.json`은 §4의 `ARMBACKUP_DEPLOY_CONFIG` 내용이며 ZIP 안의 `hosted/console.json`·`hosted/capture.json`이 된다. 고객 Storage·Workspace·DCR 값이 ZIP에 들어가므로 **고객마다 ZIP을 따로 만든다.**

```powershell
$env:ARMBACKUP_DEPLOY_CONFIG = Get-Content .\deploy-config.json -Raw
$env:GITHUB_SHA = (git rev-parse HEAD)          # 배포 후 /health의 build와 대조하는 용도
python scripts\package_appservice.py --output dist\armbackup-deploy.zip
Copy-Item scripts\deploy-customer.ps1 dist\
(Get-FileHash dist\armbackup-deploy.zip -Algorithm SHA256).Hash     # 전달 시 함께 알려 주는 무결성 값
```

`dist\` 의 두 파일(`deploy-customer.ps1`, `armbackup-deploy.zip`)이 배포 묶음이다. 전달 방법(사내 공유 폴더, 암호화 USB, 승인된 파일 전송 등)은 고객 정책을 따른다. ZIP에는 소스·정적 파일·위 설정 JSON만 있고 비밀·토큰·로컬 경로는 없다.

### 2) 배포 PC: 준비물

| 항목 | 내용 |
| --- | --- |
| PowerShell 7 | 7.6에서 시험했다. Windows PowerShell 5.1은 시험하지 않았다 |
| Azure CLI | 2.92에서 시험했다. `az login`으로 대상 구독에 로그인(역할 부여 권한 필요, §7 사전 조건) |
| `curl.exe` | Windows 10/11에 기본 포함 |
| 네트워크 | Azure Resource Manager와 앱의 `*.scm.azurewebsites.net` 접근. `-AllowedClientIps`를 쓰면 **이 PC의 공인 IP**가 목록에 있어야 한다 |

### 3) 배포 PC: 실행

```powershell
(Get-FileHash .\armbackup-deploy.zip -Algorithm SHA256).Hash     # 전달받은 값과 같은지 확인
az login
.\deploy-customer.ps1 `
  -SubscriptionId <구독 ID> -ResourceGroup <RG> -AppName <앱 이름> `
  -AppServicePlanId <Plan ID> -VnetSubnetId <서브넷 ID> `
  -AuthMode password -Username ops.admin -PasswordHash '@Microsoft.KeyVault(SecretUri=...)' `
  -AllowedClientIps <고객 IP>/32 -AllowCurrentIp `
  -StorageAccountId <ID> -WorkspaceId <ID> -DcrId <ID> -KeyVaultId <ID> `
  -PackagePath .\armbackup-deploy.zip -WhatIf
```

`-WhatIf`를 빼면 실제로 배포한다. 스크립트는 ZIP에 `requirements.txt`, `src/armbackup/webui.py`, `hosted/console.json`, `hosted/capture.json`이 있는지 Azure를 호출하기 **전에** 검사하고, 다른 ZIP이면 중단한다. ZIP 안의 커밋(`hosted/build.json`)을 읽어 배포 후 `/health`의 `build`와 대조한다.

### 주의
- **Oryx 빌드는 Azure에서 실행되어 `requirements.txt`의 패키지를 PyPI에서 받는다.** 고객이 App Service의 PyPI 아웃바운드를 막았다면 빌드가 실패한다. 이 경우 개발 PC에서 의존성을 포함한 ZIP을 만들어야 하며, 이 방식은 시험하지 않았다.
- IP 제한을 켠 앱은 허용되지 않은 PC의 배포가 SCM에서 HTTP 403으로 거부된다. 스크립트가 배포 전에 이를 확인하고 해결 방법을 알려 준다. 접근 제한 변경이 반영되는 데 1분가량 걸린다.
- 2026-11-12 저장소 밖의 빈 폴더에 스크립트와 ZIP만 두고 실행해 기존 앱에 재배포하고 `/health`의 `build` 일치까지 확인했다(143초). 잘못된 ZIP은 Azure 호출 전에 거부됐고, 허용 목록에 없는 PC는 안내 메시지와 함께 중단됐으며 `-AllowCurrentIp`로 통과했다. git과 Python이 **없는** PC에서 실제로 돌려 본 것은 아니다(스크립트는 두 도구를 호출하지 않는다).
