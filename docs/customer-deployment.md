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

## 4. 패키지 만들기 — `deploy-config.json` 작성

`deploy-config.json`은 **`console`**(콘솔 표시·범위)과 **`capture`**(수집·저장·로그 목적지) 두 섹션을 가진 JSON이다. 비밀·토큰·로컬 경로를 넣지 않는다(ZIP에 그대로 들어간다). 시작은 [deploy-config.example.json](../examples/deploy-config.example.json)을 복사해 고객 값으로 바꾸는 것이다. **한 줄씩 설명과 필수/생략 가능 표시가 달린 참고본은 [deploy-config.annotated.jsonc](../examples/deploy-config.annotated.jsonc)**이다(JSON은 주석을 허용하지 않으므로 참고용이며 그대로 쓰면 안 된다. 두 파일은 테스트로 같은 값을 유지하고, 표시한 필수/생략 가능이 실제 코드 동작과 맞는지도 검사한다).

```powershell
Copy-Item examples\deploy-config.example.json deploy-config.local.json   # *.local.json은 Git에서 제외된다
```

### 바꿔야 하는 값 (고객마다 다름)

| 위치 | 값 | 어디서 구하나 |
| --- | --- | --- |
| `console.workspace_name` | 화면에 표시할 이름(1~100자, 제어문자 없음) | 임의 |
| `console.subscription_name` | 구독 표시 이름 | `az account show --query name -o tsv` |
| `console.workspace_guid` | Log Analytics **Workspace GUID**(ARM ID가 아님) | `az monitor log-analytics workspace show -g <RG> -n <이름> --query customerId -o tsv` |
| `capture.subscriptions` | 대상 구독 ID **정확히 1개** | `az account show --query id -o tsv` |
| `capture.resource_groups` | **Storage·Workspace·DCR이 있는 RG 정확히 1개**. 이름은 소문자로 저장된다 | 아래 제약 참고 |
| `capture.storage.account_url` | `https://<스토리지 이름>.blob.core.windows.net` (끝에 `/` 없음, 표준 호스트. `privatelink`나 사설 IP를 넣지 않는다) | 스토리지 계정 이름 |
| `capture.storage.container` | **미리 만들어 둔** 컨테이너 이름(소문자·숫자·`-`, 3~63자, `--` 불가) | 고객이 생성. 이 코드는 만들지 않는다 |
| `capture.storage.prefix` | 컨테이너 안의 경로 이름 하나(영문·숫자·`_`·`-`). 같은 prefix를 쓰는 예약은 직렬화된다 | 임의(기본 `armbackup`) |
| `capture.logging.workspace_resource_id` | Workspace의 전체 ARM ID | `az monitor log-analytics workspace show ... --query id -o tsv` |
| `capture.logging.dcr_resource_id` | DCR의 전체 ARM ID | DCR 리소스 ID |
| `capture.logging.rule_id` | DCR의 **immutableId**(`dcr-…`). ARM ID나 Workspace ID가 아님 | 아래 명령 |
| `capture.logging.endpoint` | `https://….ingest.monitor.azure.com`(경로 없음). DCR의 `endpoints.logsIngestion` 또는 연결된 DCE의 `logsIngestion.endpoint` | 아래 명령 |
| `capture.logging.stream` | `Custom-`로 시작하는 DCR 입력 stream 이름 | 보통 `Custom-ArmBackup` |

`rule_id`·`endpoint`·`stream`은 확장 설치 없이 `az rest`로 한 번에 구한다(2026-11-12 이 저장소의 테스트 구독에서 확인).

```powershell
az rest --method get --url "https://management.azure.com/subscriptions/<구독 ID>/resourceGroups/<RG>/providers/Microsoft.Insights/dataCollectionRules/<DCR 이름>?api-version=2023-03-11" `
  --query "[properties.immutableId, properties.endpoints.logsIngestion, properties.dataFlows[0].streams[0]]" -o tsv
```

(`az monitor data-collection rule show`는 `monitor-control-service` 확장을 설치하라고 물어 자동화에 적합하지 않다.)

### 그대로 두는 값 (필수·권장)

| 값 | 이유 |
| --- | --- |
| `console.archive_mode: "blob"` | 호스팅 콘솔은 Blob만 허용한다 |
| `console.inventory_scope: "subscription"` | 구독 전체 RG를 조회·백업한다(`"lab"`은 표식 태그가 있는 LAB 전용) |
| `console.restore_enabled: false` | `true`면 콘솔에서 복원·복제가 열린다. 승인된 범위·권한이 준비된 뒤에만 켠다 |
| `console.activity_days: 2` | 변경 이력 조회 일수, 1~7 |
| `capture.credential: "managed_identity"` | `cli`는 로컬 개발용이며 패키저가 거부한다. 사용자 할당 ID를 쓸 때만 `managed_identity_client_id`(UUID)를 추가한다 |
| `capture.storage.require_private_endpoint: true` | `false`면 패키저가 거부한다. Blob이 사설 IP로 해석되지 않으면 수집이 시작되지 않는다 |
| `capture.api_versions` | NSG·Route Table·VNet 세 유형의 버전은 **반드시** 있어야 한다(없으면 콘솔이 시작하지 않는다) |
| `capture.discovery_tables: ["Resources"]` | 키를 **생략**하면 기본 네 개 테이블 전체이고, 빈 배열 `[]`은 거부된다. 테스트 구독 검증은 `["Resources"]`로 했다 |
| `capture.workers` / `retries` / `timeout_seconds` | 병렬도 1..32 / 재시도 0..8 / 읽기 시간 제한 1..300초(기본 4/4/60) |

`exclude_types`, `collections`, `allow_preview`처럼 이 표에 없는 키는 [configuration.md](configuration.md)에서 정한다. **모르는 키는 거부된다**(오타 방지).

### 제약과 흔한 실수
- **구독 1개·RG 1개**: 콘솔은 구독 하나와 "저장·로그 RG" 하나만 받는다. 이 RG는 수집 범위를 제한하는 값이 아니라 **Workspace·DCR이 들어 있어야 하는 RG**다(`inventory_scope=subscription`이면 조회·백업은 구독 전체). Storage가 다른 RG에 있어도 `account_url`만 맞으면 된다.
- **Workspace와 DCR은 같은 RG**여야 한다. 다르면 "Logging resources must be inside the configured storage/logging group"으로 거부된다.
- `workspace_guid`와 `rule_id`를 서로 바꿔 넣거나 ARM ID를 넣는 실수가 가장 많다(`rule_id`는 `dcr-…`, `workspace_guid`는 GUID).
- 설정이 틀리면 **앱이 시작하지 않는다**(조용히 기본값으로 바꾸지 않는다). 사전 확인은 아래 "검증"을 쓴다.

### 검증

ZIP을 만들기 전에 패키저가 필수 값(blob·관리 ID·사설 Blob)을 검사하고, 콘솔 형식까지 확인하려면 만든 ZIP의 `hosted/console.json`을 앱의 로더로 읽어 본다.

```powershell
scripts\build-package.cmd .\deploy-config.local.json
# 만들어진 폴더의 ZIP 압축을 풀어 hosted\console.json을 로더로 확인(오류가 없으면 아무것도 출력하지 않는다)
.\.venv\Scripts\python.exe -c "from pathlib import Path; from armbackup.console import ConsoleConfig; ConsoleConfig.load(Path(r'<압축 푼 폴더>\hosted\console.json'))"
```

예시 파일은 이 로더로 읽히는지 자동 테스트(`tests/test_hosted_package.py`)가 검사한다.

### 수동으로 ZIP 만들기

`build-package.cmd` 대신 직접 만들려면 다음을 쓴다(환경 변수 `ARMBACKUP_DEPLOY_CONFIG`·`GITHUB_SHA`도 계속 지원한다).

```powershell
python scripts\package_appservice.py --config .\deploy-config.local.json --build (git rev-parse HEAD) --output deploy.zip
```

ZIP에는 소스·정적 파일·위 설정만 들어가며 비밀은 들어가지 않는다.

## 5. 배포 절차

> 아래 수동 CLI 절차는 각 단계가 무엇을 하는지 설명하는 참고용이다. 같은 일을 한 번에 수행하는 스크립트는 §7을 쓴다. **수동 절차의 `az webapp create`는 앱을 열린 상태로 만들므로 KT 네트워크 거버넌스(생성 시점의 select networks·VNet Integration, Private Endpoint)를 만족하지 못한다. 실제 배포는 §7의 스크립트를 쓴다.**
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

1. **KT 네트워크 거버넌스(생성 요청 한 번에 적용, 열린 상태가 없다)**: Web App을 ARM 한 번의 요청으로 만들면서 ① 퍼블릭 액세스 *Enabled from select virtual networks and IP addresses*(기본 동작 Deny, SCM은 별도 명시적 Deny) ② `-VnetSubnetId`로 VNet Integration ③ HTTPS 강제를 함께 설정한다. 시스템 관리 ID도 이때 만든다.
2. 사이트 설정(Always On·TLS 1.2·FTPS 끔·`/health` 상태 검사·시작 명령), SCM·FTP 기본 인증 차단
3. **Private Endpoint(`sites`) 생성과 DNS integration(Private DNS 영역 그룹)**: `-PrivateEndpointSubnetId`에 만들고 `privatelink.azurewebsites.net` 영역을 연결한다. `-PrivateDnsZoneId`를 주면 그 영역(예: 허브의 중앙 DNS 영역)을 쓰고, 없으면 앱 RG에 영역을 만들어 PE의 VNet에 연결한다.
4. 앱 설정(`ARMBACKUP_AUTH_MODE` 등)과 로그인 방식에 맞는 App Service 인증 설정(`password`는 끔, `entra`는 켬). 반대 모드의 남은 설정은 삭제한다
5. 관리 ID에 역할 부여: 구독 Reader·Contributor, Storage Blob Data Contributor, Log Analytics Reader, Monitoring Metrics Publisher, (선택) Key Vault Secrets User
6. 패키징 → ZIP 배포 → `/health`·익명 접근 차단 확인

**사전 조건**: Azure CLI 로그인, 대상 RG 존재, Plan은 Linux(Basic 이상, Private Endpoint 지원), **서브넷 2개**: VNet Integration용(`Microsoft.Web/serverFarms`에 위임, Plan과 같은 리전)과 Private Endpoint용(위임 없음). 두 서브넷은 서로 달라야 한다. 스크립트가 **앱을 만들기 전에** 서브넷의 위임·리전·중복을 검사하고 맞지 않으면 중단한다. Blob Private Endpoint·사설 DNS 준비(스크립트는 만들지 않는다), 배포 계정에 RG의 Contributor와 역할 부여 권한(Owner 또는 User Access Administrator). 리소스는 **리소스 ID**로 받으므로 서로 다른 RG에 있어도 된다.

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
  -AppServicePlanId "<Plan 리소스 ID>" `
  -VnetSubnetId "<VNet Integration 서브넷 ID>" -PrivateEndpointSubnetId "<Private Endpoint 서브넷 ID>" `
  -AuthMode password -Username ops.admin `
  -PasswordHash '@Microsoft.KeyVault(SecretUri=https://kv-acme.vault.azure.net/secrets/armbackup-hash/)' `
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
| `-SkipVerify` | `/health` 확인을 건너뛴다(배포 PC가 허용 IP가 아닐 때). 허용되지 않은 PC에서 403이 계속되면 스크립트가 알아서 확인을 건너뛰고 경고한다 |
| `-AllowedClientIps` | 허용할 공인 IP(CIDR) 목록. **앱과 SCM의 IP 규칙을 이 목록으로 교체한다.** 생략하면 기존 규칙(운영자가 포털에서 추가한 IP)을 유지한다 |
| `-AllowCurrentIp` | 이 PC의 공인 IP를 `-AllowedClientIps`에 추가한다(배포 PC가 허용 목록에 없을 때). 제거하려면 포털에서 규칙을 지운다 |
| `-PrivateEndpointName` / `-PrivateDnsZoneId` | PE 이름(기본 `pe-<앱 이름>`) / 이미 있는 `privatelink.azurewebsites.net` 영역의 ID(기본: 앱 RG에 만들어 사용) |
| `-PackagePath` | 미리 만든 배포 ZIP을 올린다. 소스·git·Python이 없는 PC용(§8) |

**네트워크 운영 방법(KT 거버넌스)**
- 앱은 허용 IP 없이(전부 거부) 만들어진다. **허용 IP는 운영자가 포털에서 직접 추가한다.** Networking > Access restrictions에서 주 사이트에 규칙을 추가한 뒤, SCM("Advanced tool site")은 *Use main site rules*를 선택하거나 같은 IP를 따로 추가한다.
- SCM에 명시적 Deny를 두는 이유: *Use main site rules*를 켠 채 주 사이트 규칙이 비어 있으면 플랫폼이 SCM(배포 엔드포인트)을 **열어 둔다**(실제 앱에서 확인, 주 사이트는 403인데 SCM은 401 응답). 그래서 새 앱은 SCM을 별도 Deny로 만든다. 주 사이트에 Allow 규칙이 있고 *Use main site rules*가 켜진 기존 앱은 그대로 둔다.
- 허용 IP가 없으면 **코드 배포(SCM)도 막힌다.** 스크립트는 앱을 모두 만든 뒤 "이 PC는 거부된다"는 안내와 함께 중단하며, IP를 추가하고 **같은 명령을 다시 실행**하면 이어서 진행한다(멱등). 첫 실행부터 끝내려면 `-AllowCurrentIp` 또는 `-AllowedClientIps`를 준다. Private Endpoint로 접속하는 VNet 안의 PC는 IP 규칙의 영향을 받지 않는다.

**주의**
- 같은 값으로 다시 실행해도 안전하다(멱등). 앱 설정은 스크립트 값이 기준이라 포털에서 바꾼 값은 다음 실행에 되돌려진다. IP 규칙은 `-AllowedClientIps`를 줄 때만 교체되므로, 운영자가 포털에서 추가한 IP는 이 옵션 없이 다시 실행해도 유지된다.
- Bicep 방식([infra/main.bicep](../infra/main.bicep))은 테스트 구독 전체를 만드는 용도이며, 고객 배포는 이 스크립트를 쓴다.
- 소요 시간: 처음부터 약 6~7분(Oryx 빌드 약 2분, 첫 기동·수집 포함). `az webapp deploy`의 자체 상태 추적은 10분에서 "실패"로 오판할 수 있어 스크립트는 `--track-status false`로 배포하고 `/health`로 직접 확인한다(최대 20분 대기). 플랫폼이 사이트를 중지시켰다면 대기 중에 자동으로 시작한다.
- 앱이 시작하지 않으면 `az webapp log download`로 받은 `LogFiles\StartupLogs\*_failure.log` 끝줄에 원인이 나온다(예: `Console server could not start: ...`).
- 2026-11-12 이 저장소의 테스트 구독(Korea Central, 기존 B1 Plan·VNet·Blob PE·Storage·Workspace·DCR 재사용, Vault는 공용 접근 차단+PE)에서 **앱을 삭제한 뒤 처음부터 1회 실행으로 성공**을 확인했다(Key Vault 권한 전파 대기 포함 387~887초). 확인한 것: 익명 `/`는 `/login`으로 302, 잘못된 비밀번호 401, 5회 실패 후 429+`Retry-After`, 로그인 성공 시 `__Host-` 쿠키 발급, 로그인 후 `/api/state`에서 구독 리소스 172개와 저장본 읽기, 로그아웃 후 401, Key Vault 참조 `Resolved`, 부여된 역할 6건, SCM·FTP 기본 인증 차단.
- **네트워크 거버넌스 검증(같은 날, 새 앱)**: `publicNetworkAccess=Enabled`+기본 동작 Deny(규칙은 Deny all뿐), VNet Integration(`appservice` 서브넷), PE `sites` 상태 Approved(`private-endpoints` 서브넷), DNS 영역 그룹 `privatelink.azurewebsites.net`과 A 레코드 2개(앱·`.scm`) 생성, 허용되지 않은 PC에서 주 사이트 403·SCM 403(명시적 SCM Deny 적용 후), 코드 배포 차단 시 안내 메시지와 중단, `-AllowCurrentIp`로 같은 명령을 다시 실행해 배포·`/health` 통과. **고객 환경(KT)에서 실제 정책으로 시험한 것은 아니다.** `-AuthMode entra`의 실제 Entra 로그인도 시험하지 않았다.

## 8. 소스 코드가 없는 PC에서 배포

배포 PC에는 **소스, git, Python이 필요 없다.** 코드를 아는 PC(개발 PC)에서 배포 ZIP을 한 번 만들고, 배포 PC에는 **스크립트 1개 + ZIP 1개**만 옮긴다.

### 1) 개발 PC: 배포 묶음 만들기

고객 값(비밀 없는 JSON)으로 ZIP을 만든다. `deploy-config.json`은 §4의 `ARMBACKUP_DEPLOY_CONFIG` 내용이며 ZIP 안의 `hosted/console.json`·`hosted/capture.json`이 된다. 고객 Storage·Workspace·DCR 값이 ZIP에 들어가므로 **고객마다 ZIP을 따로 만든다.** 설정 파일에는 비밀을 넣지 않는다(ZIP에 그대로 들어간다).

```cmd
scripts\build-package.cmd .\deploy-config.json              :: 결과: dist\armbackup-<커밋>\
scripts\build-package.cmd .\acme.json D:\bundles            :: 출력 폴더 지정
```

[build-package.cmd](../scripts/build-package.cmd) 한 번으로 `dist\armbackup-<커밋 7자리>\`에 다음 3개가 만들어진다(같은 커밋을 다시 만들면 덮어쓴다).

| 파일 | 내용 |
| --- | --- |
| `armbackup-deploy.zip` | 소스·정적 파일·설정 JSON·빌드 커밋. 비밀·토큰·로컬 경로 없음 |
| `deploy-customer.ps1` | 배포 스크립트 |
| `SHA256.txt` | ZIP의 SHA-256. 배포 PC에서 `Get-FileHash`와 대조한다 |

- 필요한 것: 이 저장소, Python 3.12 이상(`.venv`가 있으면 그것을 우선 사용), git(없으면 커밋 표식 없이 만들고 경고한다).
- 폴더 이름의 `-dirty`는 `src\`·`requirements.txt`·`pyproject.toml`에 **커밋하지 않은 변경**이 ZIP에 포함됐다는 뜻이다. 고객에게 전달하는 묶음은 커밋한 뒤 `-dirty` 없이 만든다.
- 설정이 `archive_mode=blob`, `credential=managed_identity`, `require_private_endpoint=true`가 아니면 패키저가 거부하고 배치도 오류로 끝난다.
- 같은 일을 수동으로 하려면 `python scripts\package_appservice.py --config .\deploy-config.json --build <커밋 SHA> --output dist\armbackup-deploy.zip`을 쓴다(환경 변수 `ARMBACKUP_DEPLOY_CONFIG`·`GITHUB_SHA`도 계속 지원하며 GitHub Actions가 이를 쓴다).

묶음 폴더 전체가 배포 묶음이다. 전달 방법(사내 공유 폴더, 암호화 USB, 승인된 파일 전송 등)은 고객 정책을 따른다.

### 2) 배포 PC: 준비물

| 항목 | 내용 |
| --- | --- |
| PowerShell 7 | 7.6에서 시험했다. Windows PowerShell 5.1은 시험하지 않았다 |
| Azure CLI | 2.92에서 시험했다. `az login`으로 대상 구독에 로그인(역할 부여 권한 필요, §7 사전 조건) |
| `curl.exe` | Windows 10/11에 기본 포함 |
| 네트워크 | Azure Resource Manager와 앱의 `*.scm.azurewebsites.net` 접근. 앱은 허용 IP만 받으므로 **이 PC의 공인 IP가 앱·SCM 규칙에 있거나**(`-AllowCurrentIp`) 앱 VNet 안의 PC여야 코드 배포가 된다 |

### 3) 배포 PC: 실행

```powershell
(Get-FileHash .\armbackup-deploy.zip -Algorithm SHA256).Hash     # 전달받은 값과 같은지 확인
az login
.\deploy-customer.ps1 `
  -SubscriptionId <구독 ID> -ResourceGroup <RG> -AppName <앱 이름> `
  -AppServicePlanId <Plan ID> -VnetSubnetId <VNet Integration 서브넷 ID> -PrivateEndpointSubnetId <PE 서브넷 ID> `
  -AuthMode password -Username ops.admin -PasswordHash '@Microsoft.KeyVault(SecretUri=...)' `
  -AllowCurrentIp `
  -StorageAccountId <ID> -WorkspaceId <ID> -DcrId <ID> -KeyVaultId <ID> `
  -PackagePath .\armbackup-deploy.zip -WhatIf
```

`-WhatIf`를 빼면 실제로 배포한다. 스크립트는 ZIP에 `requirements.txt`, `src/armbackup/webui.py`, `hosted/console.json`, `hosted/capture.json`이 있는지 Azure를 호출하기 **전에** 검사하고, 다른 ZIP이면 중단한다. ZIP 안의 커밋(`hosted/build.json`)을 읽어 배포 후 `/health`의 `build`와 대조한다.

### 주의
- **Oryx 빌드는 Azure에서 실행되어 `requirements.txt`의 패키지를 PyPI에서 받는다.** 고객이 App Service의 PyPI 아웃바운드를 막았다면 빌드가 실패한다. 이 경우 개발 PC에서 의존성을 포함한 ZIP을 만들어야 하며, 이 방식은 시험하지 않았다.
- IP 제한을 켠 앱은 허용되지 않은 PC의 배포가 SCM에서 HTTP 403으로 거부된다. 스크립트가 배포 전에 이를 확인하고 해결 방법을 알려 준다. 접근 제한 변경이 반영되는 데 1분가량 걸린다.
- 2026-11-12 저장소 밖의 빈 폴더에 스크립트와 ZIP만 두고 실행해 기존 앱에 재배포하고 `/health`의 `build` 일치까지 확인했다(143초). 잘못된 ZIP은 Azure 호출 전에 거부됐고, 허용 목록에 없는 PC는 안내 메시지와 함께 중단됐으며 `-AllowCurrentIp`로 통과했다. git과 Python이 **없는** PC에서 실제로 돌려 본 것은 아니다(스크립트는 두 도구를 호출하지 않는다).
