# armbackup — Azure 관리 평면 형상 백업

> 범위: KT의 Private Endpoint 접근 요구에 맞춘 Python 수집기와 App Service 예약 WebJob. 업무 데이터 평면은 백업하지 않는다. Azure 배포를 자동 실행하지 않는다.

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
| 웹 UI | **요구 확정·미구현.** 개별 자원 행의 백업↔현재 Diff: 동일 Green·다름 Red. UI는 동일 App Service Plan의 App Service 사용. [화면·호스팅 설계안](docs/comparison-ui.md) 참고 |
| 복원 | **방식 미확정·별도 설계 검토 필요.** 현재 NSG·Route Table 계획/승인/PUT 코드는 검토용 초안이며 운영 채택을 확정한 것이 아님 |

**중요:** Discovery 전체는 “현재 신원에 보이는 구독 범위와 지원 ARG 테이블”을 뜻한다. 테넌트 전체 권한·Entra 객체·관리그룹·데이터·모든 관리 설정의 완전성을 뜻하지 않는다. 리소스 GET에서 빠지는 설정은 유형별 보완 프로필을 추가해야 한다. [범위와 복원 한계](docs/architecture.md), [설정 계약](docs/configuration.md).

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
1. [아키텍처·수집 완전성](docs/architecture.md)
2. [설정·API 버전·수집 프로필](docs/configuration.md)
3. [웹 UI·계층형 비교 테이블 요구와 설계안](docs/comparison-ui.md)
4. [App Service·VNet·PE·Log Analytics 배포](docs/deployment.md)
5. [실행·경보·실패 처리](docs/operations.md)
6. [안전한 복원·복제와 지원 범위](docs/restore.md)
7. [검증 결과와 미검증 항목](docs/validation.md)

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
```

Azure를 생성·변경하지 않는 테스트다. 실제 KT PE·관리 ID·로그 수집·리소스 복구는 고객 환경에서 별도 검증해야 한다. 모든 기본 동작은 [소스](src/armbackup)와 [테스트](tests)에 정의한다.
