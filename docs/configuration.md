# 설정·수집 프로필·API 버전

> 범위: [config.example.json](../examples/config.example.json)을 실제 고객 환경에 맞추는 방법.

**한 줄 요약** — 스코프·API·보완 조회와 로그 목적지를 명시하고, 잘못된 설정을 조용히 기본값으로 바꾸지 않는다.

## 기본 설정

알 수 없는 설정 키는 거부한다. 인증 모드는 `managed_identity` 또는 로컬 개발용 `cli`만 허용한다. 비밀키·SAS·client secret을 설정에 넣지 않는다.

| 항목 | 동작 |
| --- | --- |
| `subscriptions` | UUID 배열. 비어 있으면 신원이 읽을 수 있는 Enabled 구독 전체 |
| `discovery_tables` | Resources·ResourceContainers·AuthorizationResources·PolicyResources 중 선택. 기본 네 개 |
| `resource_groups` | 비어 있으면 전체. 지정하면 Discovery 후 해당 RG만 상세 수집하며 제외도 명세에 남김 |
| `exclude_types` | 제외할 정확한 ARM 유형. wildcard가 아님 |
| `api_versions` | 정확한 ARM 유형 → 수집 API 버전. 운영 검증된 값을 고정 |
| `collections` | 유형별 필수 추가 GET/list. 하나라도 실패하면 해당 자원 수집 실패 |
| `workers` | 상세 수집 병렬도 1..32, 기본 4. Future 대기열도 병렬도의 두 배로 제한 |
| `retries` | ARM/SDK의 일시 오류 재시도 설정 0..8, 기본 4 |
| `timeout_seconds` | ARM/SDK read timeout 1..300, 기본 60. 전체 작업 시간 상한은 아님 |
| `allow_preview` | 기본 false. 명시적 preview override/보완 API도 이 스위치가 필요 |
| `managed_identity_client_id` | user-assigned identity의 client ID. 없으면 system-assigned |

Storage `account_url`은 **표준 Blob URL**이다. PE 사설 IP나 `privatelink` 호스트를 직접 넣지 않는다. `container`는 미리 만들고, `prefix`는 단일 안전한 경로 이름으로 지정한다. 같은 prefix를 공유하는 예약은 직렬화된다.

`require_private_endpoint=true`가 기본이다. DNS 결과가 RFC1918 또는 IPv6 ULA 주소로만 구성되지 않으면 수집을 시작하지 않는다. 이는 공개 경로 오사용을 막는 사전 검사이지 PE 승인·TLS·방화벽·연결 성공의 증명은 아니다. 실제 Blob preflight도 수행한다. KT 배포 패키지는 이 옵션을 끈 설정을 거부한다.

## 대상 선정 목적과 실제 설정 변경은 구분

고객의 우선 후보는 **Application Gateway + WAF, Load Balancer, Front Door, Route Table, Network Security Group**처럼 설정 재구성에 시간이 많이 드는 자원이다. 전체 Discovery와 상세 백업/복원 지원 범위를 구분하고, 단순 자원도 의존성이면 필요한 참조·설정을 검토한다. [대상 선정 기준](target-selection.md)을 따른다.

이 목적을 기록했다고 현재 CLI의 `exclude_types`, 콘솔 정책, 지원 API나 실제 수집 범위가 바뀐 것은 아니다. 대상 정책 적용은 별도 변경으로 수행하며, 새 주요 유형·필수 의존 형상의 collector/복원 검증이 필요하다. 비대상·승인 제외·필수 미수집을 같은 상태로 다루지 않는다.

## API 버전 선택

1. `api_versions`에 있으면 해당 버전 사용.
2. 구독·RG 컨테이너는 코드의 명시적 버전 사용.
3. 나머지는 해당 구독 provider metadata의 유형별 버전 목록에서 날짜가 가장 큰 안정 버전 선택.
4. 안정 버전이 없거나 해당 유형을 찾지 못하면 실패. `allow_preview=true`일 때만 preview도 후보에 포함.

새로 발견한 유형의 동적 버전 선택은 **초기 수집을 위한 편의**다. 복구 검증이나 장기 호환성을 보증하지 않는다. 운영 수집은 representative 테스트 후 override를 고정하고 버전을 통제하는 것을 권장한다. API 재시도는 408/429/500/502/503/504 및 연결/timeout에 한정한다. 401/403/404를 성공-shaped fallback으로 처리하지 않는다.

ARG Query API 버전은 현재 `2024-04-01`이고, 그것은 원본 자원의 `captureApiVersion`과 다르다. 복원 시 최신 API로 자동 치환하지 않는다. 원본과 스키마를 유지하고 검증된 migration adapter를 별도 개발해야 한다. (근거: [ARM API 권고](https://learn.microsoft.com/azure/azure-resource-manager/templates/best-practices#api-version))

## 추가 수집 예시

```json
{
  "collections": {
    "microsoft.network/networksecuritygroups": [
      {
        "name": "securityRules",
        "path": "securityRules",
        "api_version": "2024-05-01",
        "mode": "list"
      }
    ]
  }
}
```

`path`는 원본 자원 ID 뒤에 붙이는 상대 ARM 경로다. `list`는 `value` 배열과 `nextLink`를 전부 순회하고, `object`는 JSON 객체 하나를 보관한다. 경로 이탈·외부 URL·query 삽입은 거부한다. 추가 수집은 **GET만 지원**한다.

서비스별 숨은 하위 설정이나 POST list 작업을 자동으로 알아내지는 않는다. 미수집 설정을 확인했으면 해당 유형의 업무상 복구 필수값을 먼저 정하고 명시적인 전용 collector를 구현·시험한다. 모든 API를 무작위 순회하거나 `listKeys`를 실행하면 안 된다.

## Log Analytics 설정

| 설정 | 값 |
| --- | --- |
| `workspace_resource_id` | 기존 지정 Workspace의 전체 ARM ID. GUID workspace/customer ID가 아님 |
| `dcr_resource_id` | 해당 Workspace에 연결한 DCR의 전체 ARM ID |
| `endpoint` | DCR의 `endpoints.logsIngestion` 또는 연결된 DCE의 `properties.logsIngestion.endpoint` |
| `rule_id` | DCR의 `immutableId` (`dcr-...`). ARM ID나 Workspace ID가 아님 |
| `stream` | DCR 입력 stream 이름. 예: `Custom-ArmBackup` |

실행 전에 DCR의 stream·schema·Workspace·endpoint를 실제 조회해 검사한다. DCR의 `transformKql`은 생략 또는 `source`만 허용한다. 지정 stream을 다른 Workspace로도 보내는 dataFlow는 거부한다.

로그는 Workspace의 Logs Ingestion API 호환 custom table에 저장한다. 권장 테이블명은 `ArmBackup_CL`, stream은 `Custom-ArmBackup`, output stream은 `Custom-ArmBackup_CL`이다. [배포의 DCR 설정](deployment.md)을 따른다.
