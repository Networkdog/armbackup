# 일일 운영·로그·장애 대응

> 범위: 수집 완료 확인, Log Analytics 관제, 재실행·보존·오류 처리.

**한 줄 요약** — WebJob 성공 상태만 보지 말고 `COMPLETE.json`·manifest·Workspace 로그를 함께 확인한다.

## 작업 결과

CLI 종료 코드는 `0` 정상, `2` 수집 불완전, `1` 설정/통신/저장/로그/복원 실패다. argparse 사용 오류도 `2`이므로 원인을 stderr와 명세에서 확인한다.

정상 수집에는 `discovery.json`, 모든 Captured resource blob, `manifest.json`, `COMPLETE.json`이 있다. 명세의 `configurationSha256`, `captureApiVersion`, code version, hash를 확인한다. 완료 표식의 manifest hash는 실제 바이트와 일치해야 한다.

- 명세가 `Captured`여도 `COMPLETE.json`이 없으면 운영 완료가 아니다.
- `Excluded`는 성공 수집과 구분한다. 범위 제외·승인 여부를 주기적으로 점검한다.
- `Incomplete`는 남은 원본의 삭제를 뜻하지 않는다. 장애 원인 확인 후 새 run ID로 재실행한다.
- 로그 수신 장애가 있으면 비밀을 제거한 오류를 stderr에도 남기지만 성공으로 우회하지 않는다.
- `/health`는 앱 host가 요청을 받을 수 있다는 뜻일 뿐 오늘 백업의 성공을 의미하지 않는다.

## 화면 조회 수집

호스팅 웹 프로세스의 수집 스레드가 시작 직후와 이후 5분마다(백업·복원 작업 종료 시 즉시) 화면 조회용 DTO를 Blob에 게시한다. 일일 원본 백업과 별개이며 백업 run을 생성하지 않는다. UI는 이 저장본만 읽고 새 수집을 요청하지 않는다. WebJob이 아니므로 Portal의 WebJobs 화면에는 나타나지 않는다.

- 공개 `GET /health`의 `collector.state`로 확인한다. `Succeeded`와 최근 `finishedAt`이면 정상이다. `Failed`면 `errorCode`를 보고 App Service 로그의 `snapshot_collection_failed` 줄·로그인한 화면의 최근 수집 실패 문구로 원인을 찾는다. `Starting`/`Running`이 계속되면 프로세스 재시작 직후이거나 Azure 호출이 지연되는 것이다.
- 수집 상태는 같은 archive의 `console/views/status/{key}.json`에 Running/Succeeded/Failed로 저장한다. 성공 뷰 포인터·객체·완료 표식과 함께 대조한다.
- 실패하면 마지막 정상 뷰를 유지하고 오류를 표시한다. 15분 초과 시 화면은 읽기 전용이다. 원본/현재 형상의 개별 수집 오류·Activity Log 경고도 화면 DTO에 남긴다.
- 첫 저장본이 없거나 구성이 바뀌면 미수집/수집 중/실패 화면이 정상이다. 브라우저 새로고침은 수집을 대신하지 않는다.
- Storage 자체에 접근하지 못하거나 강제 종료되면 Failed 기록이 없을 수 있다. 오래된 Running·수집 시각·App Service 로그를 확인한다. `/health` 200만으로 수집 성공이라 간주하지 않고 `collector` 값을 함께 본다.
- Always On이 꺼져 있어도 동작한다(상태 검사 요청이 프로세스를 유지). 외부 자동화가 `alwaysOn`을 `false`로 되돌리는 이력이 있다([배포](deployment.md)).
- DB·Table·브라우저 캐시에 운영 데이터를 추가하지 않는다. 정책·수동 백업/복원 결과는 작업 종료 후 곧바로 재수집하며 제출한 작업은 기존 작업 ID로 즉시 확인한다.

## Log Analytics 조회

테이블을 다른 이름으로 만들었으면 쿼리를 수정한다. 이 프로젝트는 raw 형상이나 토큰을 로그에 넣지 않지만 ResourceId·구독 범위는 내부 정보다.

```kusto
ArmBackup_CL
| where TimeGenerated > ago(2d)
| summarize LastEvent=max(TimeGenerated), Events=count(),
    Errors=countif(Level == "Error") by RunId
| order by LastEvent desc
```

```kusto
ArmBackup_CL
| where TimeGenerated > ago(2d)
| where Event in ("capture_failed", "capture_version_failed",
    "discovery_failed", "subscription_container_missing", "command_failed")
| project TimeGenerated, RunId, Event, ResourceId, ErrorCode, Details
| order by TimeGenerated desc
```

```kusto
ArmBackup_CL
| where TimeGenerated > ago(26h)
| where Event == "capture_finished"
| project TimeGenerated, RunId, Status, Details
```

경보는 다음을 구분해 만든다.

1. 수집 오류·`Incomplete`·WebJob 실패.
2. 예정 시간+운영 여유를 지났는데 **`run_started` 또는 `capture_finished`가 없는 경우**.
3. 완료 Blob 자체가 없는 경우. 로그가 있어도 marker 저장에 실패할 수 있다.
4. DCR 수신·변환 오류·LA 수집 지연. API 수신 허용과 query에서 관찰한 실제 결과는 다르다.

`capture_finished` 로그는 **수집 종료 이벤트**다. 그 뒤 manifest/완료 표식 저장이 실패할 수도 있으므로 최종 상태는 Blob과 대조한다. LA가 전면 장애면 LA 내부 경보도 신뢰할 수 없으므로 App Service 작업 상태·별도 운영 경로에서 미실행/미완료를 감시한다.

## 장애별 처리

| 증상 | 확인·처리 |
| --- | --- |
| Storage DNS public 경로 거부 | WebJob 프로세스 DNS, 중앙 Resolver, Blob PE 승인·zone forwarding. 보안을 끄지 않음 |
| 401/403 | 실제 관리 ID와 대상 범위·DCR·Blob RBAC 확인. 전역 Contributor로 우회하지 않음 |
| 429/5xx 반복 | API 별 제한·작업량·workers 감소·허용 재시도·작업 분할 검토 |
| API 검색 실패 | 해당 유형 metadata·지원 API를 확인하고 검증한 override 지정 |
| DCR 검증 실패 | immutable ID·stream 열·destination Workspace·endpoint·`source` 변환 대조 |
| lease 취득 실패 | 동일 prefix의 기존 실행 상태 확인. 실행 중인 lock을 임의 해제하지 않음 |
| 앱 재시작·idle 중지 | WebJob 이력·Always On·idle 설정·배포/스케일 이벤트. 새 run ID로 재실행 |
| 일부 형상 누락 | 해당 리소스의 필수 설정을 정의하고 GET 보완 프로필/전용 collector 추가 |

ARM 재시도는 제한적이며 `Retry-After` 대기는 최대 60초로 제한한다. 지속 장애는 실패로 남긴다. 파일 이름·명세는 실행별로 독립이라 재실행이 기존 원본을 덮어쓰지 않는다. 원자적 시점 backup은 아니므로 여러 run의 원본을 섞어 한 시점인 것처럼 표시하지 않는다.

## 보존·변경 관리

일일 원본·명세와 API 고정값을 보존 정책에 맞게 관리한다. 삭제는 백업 앱이 아니라 승인된 별도 lifecycle/운영 신원으로 수행한다. restore 신원도 수집 앱과 분리한다.

새 API·유형·collector·라이브러리로 바꿀 때 representative 수집과 실패 시험을 수행하고, 보존 중 가장 오래된 샘플을 복원 regression에 포함한다. 앱 코드·의존성과 고객 구성 ZIP은 내부 배포 자산으로 관리한다.
