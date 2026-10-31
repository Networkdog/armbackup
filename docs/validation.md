# 구현 검증 결과

> 범위: 2026-10-31 로컬 구현의 실제 검증 기록과 고객 환경에서 남은 검증. Azure 운영 적용 완료 기록이 아니다.

**한 줄 요약** — 98개 로컬 테스트·린트·타입·빌드·ZIP 형식은 확인했으며, KT의 실제 WebJob·PE·관리 ID·로그 수집·복구는 아직 시험하지 않았다.

## 실행한 검증

| 항목 | 관찰 결과 |
| --- | --- |
| 로컬 런타임 | Windows / Python 3.14.6 / 프로젝트 전용 가상환경 |
| pytest | **98 passed** |
| Ruff | 소스·테스트·패키지 스크립트·host 전체 통과 |
| mypy strict | 애플리케이션 소스 11개 파일 오류 없음 |
| compileall | Python 소스·패키지 스크립트·host 문법 검사 통과 |
| pip check | 의존성 충돌 없음 |
| CLI | help와 설정 예제 `validate-config` 실행 성공. Azure 연결 검증은 아님 |
| wheel | `armbackup-0.1.0-py3-none-any.whl` 빌드·11개 모듈 현재 소스 일치 |
| WebJob ZIP | Linux x86_64/Python 3.12용 고정 dependency wheel을 포함해 생성 |
| ZIP binary 검사 | 네이티브 라이브러리 4개 ELF 확인, Windows `.exe/.dll/.pyd` 없음 |
| ZIP 실행 진입점 | `run.sh` LF·실행 권한·예약 설정 확인, 현재 Python 소스 11개 모듈 일치 |
| health host | 실제 로컬 HTTP 200과 설정 파일 경로 404 확인 후 서버 종료 |

재실행 명령은 [README](../README.md)의 테스트 절차를 따른다. Pylance 도구는 활성 편집기 워크스페이스 밖의 새 프로젝트 파일을 인식하지 못해 실행되지 않았고, 이 프로젝트 가상환경의 mypy·compileall·pytest를 검증 근거로 사용했다. **Linux Python 3.12 프로세스에서 직접 실행한 결과는 아니다.**

## 테스트한 경계

- ARG 2,501개 결과의 3페이지 순회, 반복 토큰·중복·총수 변경·페이지 누락·타 구독 ID 거부.
- 구독 접근 누락, 비활성 구독·명시 제외, 안정 API 선택·preview opt-in, 필수 보완 수집 실패.
- 원본·manifest·완료 표식의 SHA-256, 변조 탐지, 원본 저장 실패·수집 일부 실패·로그 전송 실패 시 성공 표식 부재.
- ARM 429/timeout 제한 재시도, 403 재시도 금지, 외부 `nextLink`·인증정보를 포함할 수 있는 오류 본문 노출 방지.
- 사설 IP만 허용하는 Storage DNS 검사, Blob 경로 이탈 방지·덮어쓰기 방지·scope lease 취득/해제.
- DCR 입력 schema·지정 Workspace·linked DCE 확인, 로그를 삭제하는 변환과 잘못된 endpoint 거부.
- NSG·Route Table의 명시적 복원 투영·계획 hash 승인·기존 대상 보호·API 버전 변경 차단·참조 매핑·PUT 후 설정 비교.
- CLI backup 통합 경로, 실패 종료 코드, 배포 패키지의 runtime dependencies·LF·실행 권한·Windows pip console launcher 제외.

Azure API·Blob·Logs Ingestion을 호출하는 테스트는 실제 고객 환경 대신 fake/mock을 사용한다. 따라서 SDK/네트워크/서비스 동작의 live 검증과 구분한다.

## 생성한 배포물

[armbackup-webjob.zip](../dist/armbackup-webjob.zip)은 7,119,686 bytes이며, 이번 생성본의 SHA-256은 다음과 같다. 재빌드하면 ZIP timestamp 등으로 hash가 달라질 수 있다.

```text
ec924925f7728c0a6a0a845183d0e644d1c58b358e90f28a1c3a7dac7f5c47a1
```

실제 `config.json`은 포함하지 않았고 설정 예제만 넣었다. 고객의 실제 값으로 설정한 뒤 `--config` 옵션을 사용해 별도 패키지를 만들어야 한다. 자격증명은 구성에 넣지 않는다.

## 고객 환경의 미완료 검증

1. 실제 구독·Plan·Python 런타임·Always On·SCM private 배포 가능성.
2. 실제 WebJob 프로세스의 Blob 사설 DNS·PE 경로·관리 ID 쓰기와 lease 갱신.
3. 신원의 기대 구독·ARG·REST 권한·유형별 필수 형상 완전성.
4. 지정 Workspace의 table/DCR/DCE·AMPLS·로그 수신·실제 KQL query 결과.
5. 수집 소요 시간·throttling·로그/스토리지 비용·정시 실행·재시작·다중 예약 충돌.
6. 격리 환경의 create/원위치 변경/clone 시험과 실제 애플리케이션·네트워크 동작.
7. 미지원 유형·보완 설정의 collector/restore adapter, API migration 및 대량 복구 orchestration.

이번 작업에서는 Azure 로그인·리소스 생성·배포·권한 부여·기존 Workspace 변경·실제 복원을 실행하지 않았다. 내부 문서의 지원 계약이나 KT 승인 완료를 주장하지 않는다.
