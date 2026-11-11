# 복원·복제: 지원 유형과 승인 절차

> 범위: 승인된 테스트 구독 전체 RG의 검토된 단일·묶음 복원과 이전 운영 설계 검토 기록. 범용 ARM JSON PUT·자동 전체 DR은 지원하지 않는다.

**한 줄 요약** — LAB은 단일/포함/연관 자원을 하나의 계획으로 검토하고 전체 안전 백업 후 의존 순서로 적용·비교한다. 공유·주소 대상·비밀·업무 데이터와 일반 운영 복구는 별도다.

## 현재 테스트 구독 단일·묶음 계약

현재 콘솔은 `inventory_scope=subscription`을 기본으로 같은 구독의 모든 RG를 허용하며 LAB 소유 태그를 요구하지 않는다. Storage/Workspace/DCR이 있는 기존 RG는 저장 인프라 위치일 뿐 복원 경계가 아니다. 다른 구독의 원본은 복원·업데이트할 수 없다. 여러 RG의 자원을 함께 선택할 수 있고 복제본은 기본적으로 원본마다 같은 RG에 만든다. **복제**를 고르면 대상 구독과 리소스 그룹을 지정해 다른 RG·구독에 만들 수 있다([복제 위치](#복제-위치-다른-구독리소스-그룹)). 최종 묶음 실행은 **구독 ID**(다른 위치로 복제할 때는 **대상 RG 이름**)를 직접 입력해 확인한다.

| 검토한 프로필 | 적용 범위·경계 |
| --- | --- |
| NSG / Route Table | 기존 검토 투영 유지. 단일 새 이름 복제와 원래 ID 묶음 복원 구분 |
| Application Gateway + WAF | HTTP WAF_v2 listener/port/pool/settings/probe/path map/redirect/routing와 별도 WAF custom/managed 규칙·정책 참조 |
| Standard Load Balancer | frontend/rule/probe와 **독립 backendAddressPools PUT**. 부모 PUT만으로 IP backend 설정 재현을 확정하지 않음 |
| Front Door Standard | profile와 endpoint/origin group/origin/route/rule set/rule. Azure 기본 도메인의 HTTPS 전달·응답 규칙은 별도 기능 검증 |
| Public IP / VNet | 선택한 의존 PIP, 연결된 업무 자원이 없는 검토 VNet. 공용 IP 재할당 가능; attached VNet 자동 replay 차단 |

Network API **2024-05-01**, CDN API **2024-02-01**의 공식 필드 계약을 [생성기](../scripts/generate_resource_profiles.py)와 [투영기](../src/armbackup/resource_profiles.py)로 관리한다. NSG/RT는 기존 투영을 재사용한다. 미검토 필드·켜진 미문서 플래그·HTTP/3·인증서/identity·미검토 Private Link 승인은 자동 replay하지 않는다. 생성된 계약이 있다는 사실과 각 운영 구성의 실환경 검증은 다르다.

복구 경로:

1. 같은 run의 완료 표식·원본 SHA·구독 경계·API를 검증하고 1~50개 자원을 선택한다. 포함 자원도 한도에 포함한다.
2. 포함 자원은 자동으로, 다른 검토 자원 참조는 선택한 경우에만 추가한다. 공유 ARM 참조는 존재·준비 상태·검토 후 fingerprint를 확인하며 덮어쓰지 않는다. IP/FQDN 대상은 자동 발견/복원된 것으로 취급하지 않는다.
3. **Create-only / Update-only / 독립 설정 복제**를 선택한다. 복제는 기본적으로 각 원본의 RG에 명시적인 접두사로 새 ID를 만들고, 대상 구독·RG를 지정하면 그 RG에 만든다. 선택한 ARM 참조와 own/포함 ID, PIP DNS label을 매핑하고 원본 ID와 겹치면 거부한다. 공유 Subnet·IP/FQDN 대상·인증서·업무 데이터는 유지/별도 검증 대상이다.
4. **60분 유효·일회 계획**에 따라 선택 전체의 현재 원본/확인된 부재를 안전 run에 저장한다. readback·SHA·완료 표식·로그 전송이 실패하면 ARM 쓰기를 하지 않는다.
5. 의존 순서로 적용한다. LB 부모가 만든 pool placeholder는 그 부모가 만든 확인된 fingerprint에 한해 후속 child PUT을 허용한다. 다른 실행자가 만든 target을 일반 upsert하지 않는다.
6. **모든 child 적용 후 모든 selected 형상**을 다시 비교한다. 부분 실패의 적용 ID·최종 대상·안전 run·작업 ID를 남기며 자동 롤백으로 표현하지 않는다.

같은 계획의 부모/관련 참조 자원 PUT 이후 raw etag 등만 바뀐 경우는, 그 자원이 실제 적용 목록에 있고 target의 writable configuration hash가 검토값과 같을 때만 재검증한다. 실제 설정·태그가 바뀌거나 이미 적용한 관련 참조가 없으면 중단한다. 이 예외가 Portal 경합을 원자적으로 잠그는 것은 아니다.

AGW/LB의 같은 자원 내부 참조와 Front Door의 독립 child 참조를 구분한다. Front Door Route는 참조한 Origin Group의 enabled Origin과 Rule Set의 Rule 구성을 먼저 적용한다. 공유 백엔드·NIC/VM/ACI·NAT, 인증서/Key Vault 입력·RBAC·진단 설정·업무 데이터는 이 묶음이 자동 복구하지 않는다. Portal/다른 도구를 원자적으로 잠그지 못하므로 별도 변경 통제가 필요하다.

출처: [LB IP backend와 PaaS/ACI 제한](https://learn.microsoft.com/en-us/azure/load-balancer/backend-pool-management), [공식 Network 스키마](https://github.com/Azure/azure-rest-api-specs/tree/main/specification/network/resource-manager/Microsoft.Network/Network/stable/2024-05-01), [공식 CDN 스키마](https://github.com/Azure/azure-rest-api-specs/tree/main/specification/cdn/resource-manager/Microsoft.Cdn/Cdn/stable/2024-02-01).

### 복제 위치: 다른 구독·리소스 그룹

복제 방식을 고르면 **대상 구독**과 **대상 리소스 그룹** 목록이 나타난다. 서버의 관리 ID가 읽을 수 있는 Enabled 구독과 그 구독의 안정 상태 RG만 보여 주며 `GET /api/restore-targets`(`?subscriptionId=`로 RG 조회)로 읽는다. 기본값(원본 위치)에서는 지금처럼 각 원본의 RG에 접두사로 구분해 만든다.

- 대상 RG를 고르면 선택한 모든 복제본이 그 RG 한 곳에 만들어진다. 이름 접두사는 선택 사항이며 비우면 원본 이름을 그대로 쓴다. 이름이 겹치는 대상이 이미 있으면 거부한다. DNS 이름이 있는 공개 IP는 지역 안에서 고유해야 하므로 접두사가 필요하다.
- 서버는 검토 시와 실행 직전에 대상 구독·RG를 다시 조회한다. 없거나 Enabled가 아니거나 안정 상태가 아니면 쓰기 전에 중단한다. 대상 위치는 승인 SHA에 포함되며 최종 확인값은 **대상 RG 이름**이다.
- 선택한 자원끼리의 ARM 참조는 대상 위치로 다시 매핑한다. 선택하지 않은 공유 참조는 원래 대상으로 유지하며 **다른 구독으로 복제할 때는 구독 경계를 넘는 공유 참조가 있으면 거부**한다. 참조 자원을 “연관 자원 추가”로 함께 복제한다.
- 관리 ID에 **대상 RG의 쓰기 권한**(예: Contributor)이 필요하다. 검토 단계에서 쓰기 권한을 미리 확인하지는 않으므로 권한이 없으면 안전 백업 뒤 첫 PUT에서 중단된다. 다른 구독에 역할을 부여하는 것은 배포자의 변경 통제 대상이다.
- LAB 범위(`inventory_scope=lab`) 콘솔은 구성한 RG 밖으로 복제하지 않으며 위치 선택기를 보이지 않는다. 복원·업데이트의 원본은 계속 설정한 구독으로 제한한다.

아래의 초기 **운영 설계 검토**와 기존 CLI 동작은 이 LAB 구현과 구분한다. LAB 생성/변경/삭제 시험 승인은 일반 고객 운영 복원 승인이나 인증을 뜻하지 않는다.

**고객의 우선 복원 목적:** 빈 자원 생성보다 **재구성이 복잡한 설정·정책·연결의 재현**에 가치를 둔다. Application Gateway + WAF, Load Balancer, Front Door, Route Table, NSG는 우선 후보이며 현재 LAB 지원 목록과 같지 않다. 단순 의존 자원도 재연결/재생성 범위를 확인한다. [대상 선정과 현재 지원의 구분](target-selection.md)을 따른다. 이 요구를 반영해 새 유형에 일반적인 JSON PUT을 허용하지 않는다.

## 핵심 요약 (3분)

- 사용자의 최신 제안은 **신규 생성과 업데이트를 분리**하는 것이다. 아래 내용은 설계 검토안이며 운영 채택·구현 승인이 아니다.
- Create-only는 target 부재, Update-only는 target 존재를 전제로 하고 반대 상태면 중단하는 방향을 검토한다.
- API 메서드가 모드를 보장하지는 않는다. NSG의 동일 PUT도 생성/수정을 함께 수행한다. ([공식 API][modes-nsg])
- Update에서 전체 원복과 선택 속성 복구 중 무엇을 기본으로 할지, 정상 변경을 어떻게 보존할지는 아직 미정이다.
- 현재 상태 확인과 승인만으로 경합을 없앨 수 없다. 유형별 조건부 쓰기·변경 검출·자동 실행 허용 범위를 검증해야 한다. (설계상 검증 필요)
- 기존 `--allow-existing`은 엄격한 Update-only가 아니다. 현재 코드의 범위와 앞으로 구현할 안전 정책을 구분한다.

## 설계 상태 — 복원 방식 미확정

사용자는 2026-10-31에 **“복원은 어떤 방식으로 할지 숙고가 필요하다.”**고 밝혔다. 백업 실행기·수집·저장·로그 아키텍처와 **복원 기술·절차의 선정은 분리**한다. 아래 구현 설명·명령은 현재 코드의 동작 기록이지 고객 운영 복원안이나 실행 승인서가 아니다. 코드는 여전히 PUT을 수행할 수 있으므로 실제 환경에서 가볍게 시험하지 않는다.

**UI 호스팅은 별도 확정:** 비교/복원 UI는 App Service를 사용하고 백업 실행기와 동일 App Service Plan을 이용한다. 10:24 KST 추가 요구에 따라 TreeGrid는 동일 Green, 차이는 Red/Orange/Yellow, 미확인은 중립 색으로 구분한다. [UI 요구·호스팅](comparison-ui.md)을 따른다.

**예시 프리뷰·실환경 LAB·일반 운영을 구분한다.** 예시 프리뷰의 복원은 브라우저 데이터만 바꾼다. 별도 `--live-config` LAB 콘솔은 실제 ARM에 연결하며 서버의 완료 표식·SHA 검증·계획·티켓·사유·대상명 확인을 사용한다. 현재/백업이 프로비저닝 중이거나 조회·무결성이 미확인이면 실행하지 않는다.

LAB 실행은 **소유 RG/비연결 실험 자원 → 10분 유효 계획과 현재 fingerprint → 일회 승인 → 현재 형상/부재의 안전 백업 → 원본 readback·완료 표식·로그 확인 → 적용 직전 상태/API/만료 재확인 → PUT → 전체 검토 프로파일 비교·영속 완료 기록** 순서다. 신규 대상이 없으면 원본 현재 형상과 대상 부재를, 원본도 없으면 부재 기록만 보관한다. 부재 기록을 존재하는 형상 백업으로 표현하지 않는다.

안전 백업 원천은 **설정과 화면에 명시**한다. 기본은 사설 Blob이며 PC 검증은 정책을 완화하지 않고 로컬 디스크 모드를 선택했다. 디스크 동작이 Blob 접속 검증을 대신하는 것은 아니다. 같은 RG의 사설 러너 검증과 결과는 [검증 기록](validation.md)에 분리한다.

실환경 콘솔은 기존 `build_plan`·`apply_plan`의 검토한 투영·검증을 재사용하되 서버 정책을 추가한다. **기존 CLI에는 자동 안전 백업·새 모드 옵션을 추가하지 않았다.** `--allow-existing`의 옛 동작을 콘솔 승인과 동일하다고 해석하지 않는다.

lease/file lock과 사전 GET은 Portal·외부 쓰기 실행자를 원자적으로 잠그지 못한다. 연결·RBAC·진단·참조 매핑·비밀·데이터 평면과 일반 운영 경합은 여전히 별도 검증 대상이다. 지원하지 않는 유형에는 범용 JSON PUT을 제공하지 않는다.

우선 다음 시나리오를 구분해 요구와 수용 기준을 정한다. 이 표는 검토 틀이며 구현 방식을 선정한 결과는 아니다.

| 시나리오 | 먼저 정할 사항 |
| --- | --- |
| 기존 자원의 설정 원복 | 백업 이후 정상 변경과 충돌할 때 무엇을 유지·되돌릴지 |
| 삭제된 자원 재생성 | 의존 자원·권한 주체·비밀값·재할당 식별자와 데이터 평면 복구의 경계 |
| 별도 환경으로 복제 | 이름·주소·참조·리전/구독·권한 매핑과 공유 자원 재사용 여부 |

그다음 REST 유형별 적용과 선언적 배포 등 후보를 비교하고, 의존 순서·변경 차이·승인·중간 실패와 재개·사후 검증을 설계한다. **현재 adapter 방식·hash 승인만으로 충분하다고 미리 확정하지 않는다.** NSG/Route Table에 대한 기존 코드도 이 검토 결과에 따라 유지·대체·확대할 수 있다.

백업은 원본·실제 수집 API·시각·범위·명세를 보존한다. 위 LAB의 구현·실험은 [검증 기록](validation.md)에 있으며, 일반 운영 복원 설계·적합성 검증은 아직 완료하지 않았다.

## 검토안 — 신규 생성과 업데이트를 명시적으로 분리

사용자는 2026-10-31 08:29 KST에 **“신규 생성과 업데이트를 구분하면 어떨까?”**라고 제안했다. **Create-only와 Update-only를 복원 계획의 안전 정책으로 나누는 방안**을 검토한다. 기존 자원을 실수로 덮어쓰거나, 변경만 의도했는데 없어진 자원을 새로 만드는 상황을 구분하려는 목적이다. 아직 코드에 적용하거나 운영 방식으로 확정한 것은 아니다.

≈ ARM What-if의 `Create`·`Modify`·`NoChange`를 미리 보고 승인하는 접근 — 단 이 모드는 미리보기 결과를 넘어 허용할 작업을 제한하려는 자체 설계다. AWS CloudFormation ChangeSet의 `CREATE`/`UPDATE` 구분과도 가깝지만, AWS의 이 구분은 스택 단위이고 여기서는 개별 target 자원을 기준으로 검토한다. (근거: [ARM What-if][modes-what-if], [AWS ChangeSet][modes-aws])

### 모드별 전제와 금지 동작

| 검토 모드 | 대상이 없을 때 | 대상이 있을 때 | 주요 검토 항목 |
| --- | --- | --- | --- |
| **Create-only** | 신규 생성 계획 검토 | 중단; Update로 자동 전환하지 않음 | 이름·구독/RG·참조·필수값·의존 자원·권한/비밀 재연결 |
| **Update-only** | 중단; Create로 자동 전환하지 않음 | 현재값과 복원 목표의 차이를 승인 후 적용 | 변경할 속성·보존할 설정·불변 속성·현재 운영과 충돌·중단 영향 |

위 표는 설계 제안이다. 기존 시나리오와의 관계는 다음과 같다.

- 삭제된 자원 재생성은 원래 ID를 target으로 하는 Create 후보.
- 별도 환경 복제는 새 target과 명시적 참조/주소 매핑을 가진 Create 후보.
- 기존 자원 설정 원복은 Update 후보.
- 불변 속성 변경이나 삭제 후 재생성이 필요하면 일반 Update에 숨기지 않고 별도 재생성 계획·승인으로 분리.
- 동일 설정이면 `NoChange`로 기록하고 쓰기 호출을 생략하는 방향을 검토.

### API 메서드와 실행 모드를 혼동하지 않는다

**Create=PUT, Update=PATCH라고 단순 대응시키지 않는다.** NSG의 공식 API도 동일한 PUT으로 생성 또는 수정을 수행한다. 따라서 호출할 메서드는 유형별 API 계약에 따라 선택하고, Create-only/Update-only는 솔루션의 계획·검사·승인 정책으로 별도 표현해야 한다. (근거: [NSG Create Or Update][modes-nsg])

“없으면 만들고 있으면 수정”하는 **암묵적 upsert를 복원의 기본값으로 삼지 않는 방향**을 권고한다. 다만 모드 이름이나 사전 GET만으로 서버 측 경합 방지를 보장하지는 못한다.

### 공통 계획·실행 경로

다음은 구현 전 검토할 자체 workflow다.

1. **사용자가 모드를 선택:** target의 존재 여부에 따라 실행기가 모드를 자동 전환하지 않는다.
2. **RP REST로 현재 상태 확인:** ARG만으로 존재를 판정하지 않는다. 401/403·연결 실패는 부재가 아니라 오류다. 404도 대상·권한·부모 RG와 provider 오류 의미를 확인하고 “생성 가능”으로 기계적으로 처리하지 않는다.
3. **복원 계획 생성:** 모드·source run/hash·target·API 버전·현재 상태·desired state·변경 목록·의존성·제외 항목·위험을 기록한다. 현재 계획 schema에 이 필드가 모두 구현돼 있다는 뜻은 아니다.
4. **Update의 범위 합의:** 백업 전체 상태로 원복할지, 선택한 속성만 되돌릴지 명시한다. 원하지 않은 정상 변경을 보존할 규칙과 배열/규칙 삭제의 의미도 유형별로 정한다.
5. **적용 직전 재확인:** 승인 이후 현재 상태가 변했거나 target의 존재/부재 전제가 달라지면 계획을 무효화하고 다시 검토한다.
6. **유형별 쓰기·사후 검증:** 허용된 작업만 수행하고 실제 설정·의존 관계·기능을 확인한다. 일부 실패와 재개·사전 상태 보관은 별도 설계한다.

**경합은 별도 문제다.** Create 확인 뒤 다른 실행자가 같은 target을 생성하거나, Update 확인 뒤 target이 삭제될 수 있다. RP가 해당 작업에서 조건부 쓰기·ETag 등을 지원하는지 유형별로 확인해 사용하고, 지원하지 않으면 클라이언트 사전 확인을 원자적 보장으로 과장하지 않는다. 앱 내부 lease는 같은 lock을 쓰는 작업만 조정하므로 Portal·다른 배포 도구의 변경까지 차단하지 않는다. 강한 안전 조건을 보장하지 못하는 유형의 자동 실행 허용 범위는 미결 사항이다. (설계상 위험 분석·검증 필요)

**Update도 “백업에서 몇 필드를 빼면 보존된다”는 뜻이 아니다.** ARM Incremental 재배포는 자원 속성의 부분 수정이 아니며 생략한 값이 기본값으로 재설정될 수 있다. REST도 해당 유형의 PUT/PATCH 계약을 대조해 payload를 만들어야 한다. NSG 규칙처럼 배열인 설정은 추가·변경·삭제 의도를 명시한다. (근거: [ARM 배포 모드][modes-deployment]; REST 세부 동작은 유형별 검증 필요)

### 현재 코드와의 차이

현재 `restore-apply`의 기본값은 기존 target을 거부하지만, `--allow-existing`을 주면 target이 **있어도 없어도** PUT할 수 있다. 이는 **엄격한 Update-only 모드가 아니다.** 계획의 명시적 mode·현재 상태 바인딩·속성 차이 승인·조건부 쓰기·Create/Update 각각의 회귀 시험은 아직 구현하지 않았다. 현재 코드의 제약을 이 설계안의 안전성 보장으로 대신하지 않는다. (근거: [현재 apply_plan](../src/armbackup/restore.py))

**다음 결정:** 두 모드를 복원 설계의 기본 축으로 삼을지, Update의 기본 복원 범위를 어떻게 둘지, 어떤 유형에서 자동 실행을 허용할지 검토한다. 이번 변경은 공식 공개 동작을 2026-10-31 확인해 문서에 반영한 것이며 코드·CLI·Azure 설정은 바꾸지 않았다.

[modes-what-if]: https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-what-if
[modes-aws]: https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html
[modes-nsg]: https://learn.microsoft.com/rest/api/virtualnetwork/network-security-groups/create-or-update
[modes-deployment]: https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes

## 지원 범위

| 유형 | 복원 | 하지 않는 것 |
| --- | --- | --- |
| NSG | 사용자 securityRules·tags·location·수집된 flushConnection | 기본 규칙 재생성, NIC/subnet attachment, flow logs, RBAC·진단 설정 복원 |
| Route Table | routes·tags·location·수집된 disableBgpRoutePropagation | subnet 연결·효과적 라우트·BGP 상태·RBAC·진단 설정 복원 |
| 나머지 유형 | 원본 수집만 | 범용 변환·배포 |

보완 수집된 collection은 원본으로 남지만 이 버전의 복원기가 자동으로 적용하지 않는다. “NSG 규칙 복원”은 “해당 네트워크 전체 복구”와 다르다. (근거: [명시적 adapter](../src/armbackup/restore.py), [NSG API](https://learn.microsoft.com/rest/api/virtualnetwork/network-security-groups/create-or-update))

## 계획 생성

복원 전용 앱/개발 신원을 준비한다. `restore-plan`은 Blob 읽기와 DCR 사전 검사 외에 Azure 쓰기를 하지 않는다. `COMPLETE.json`과 manifest·snapshot hash를 모두 대조한다. 이 hash는 내용 무결성 확인이지 전자서명이나 변경 승인 시스템을 대체하지 않는다.

다음의 대문자 자리표시자를 실제 값으로 바꾼다. `RUN_ID`는 manifest의 run ID다.

```powershell
.\.venv\Scripts\python.exe -m armbackup --config restore.local.json restore-plan `
  --run-id RUN_ID `
  --resource-id "/subscriptions/SOURCE_SUB/resourceGroups/SOURCE_RG/providers/Microsoft.Network/networkSecurityGroups/SOURCE_NSG" `
  --target-resource-id "/subscriptions/TARGET_SUB/resourceGroups/TARGET_RG/providers/Microsoft.Network/networkSecurityGroups/TARGET_NSG" `
  --api-version "2024-05-01" `
  --output restore-plan.local.json
```

`restore.local.json`은 전체 Config 형식을 따르되 **복원 신원**과 target에 필요한 권한을 지정한다. 수집 managed identity에 write 권한을 더하지 않는다. 출력 계획은 자원 구성값을 포함하므로 안전하게 보관하며 기본적으로 기존 파일을 덮어쓰지 않는다.

복제 시 ASG 등 참조 resource ID가 있다면 모든 참조에 대한 명시적 map을 `--reference-map references.local.json`으로 제공한다. 원본 참조를 그대로 사용할 의도여도 identity map을 명시한다. 이 버전은 주소 대역·이름·리전·네트워크 주소를 자동 재설계하지 않는다. target RG·참조 자원·권한·용량은 먼저 준비한다.

## 승인·실행

계획의 target·API·사용자 규칙·라우트·외부 참조를 검토하고 실제 필요 범위와 비교한다. 콘솔이 출력한 `approvalSha256`을 승인 기록에 연결한다.

```powershell
.\.venv\Scripts\python.exe -m armbackup --config restore.local.json restore-apply `
  --plan restore-plan.local.json --confirm-sha256 APPROVED_HASH
```

기존 target이 있으면 기본적으로 거부한다. **기존 설정 덮어쓰기의 영향을 검토·승인한 경우만** `--allow-existing`을 추가한다. 리소스 DELETE는 수행하지 않는다. PUT 뒤 GET으로 provisioning 상태를 최대 약 15분 동안 확인하고 요청한 설정을 비교한다. timeout이면 실제 상태가 진행 중일 수 있으므로 즉시 재시도하지 말고 확인한다.

실제 API 호출·네트워크 연결·서비스 동작의 검증은 운영자가 수행한다. 로그 수신 장애가 배포 후 발생하면 명령은 실패해도 target 변경은 이미 일어났을 수 있다. **자동 rollback이나 “오류니까 변경되지 않았다”는 가정은 금지**한다.

## API 버전 변경

현재 구현은 snapshot의 `captureApiVersion`과 계획의 API가 **같을 때만** 복원을 허용한다. 다른 버전은 차단한다. unknown future property·미수집 규칙 배열도 조용히 버리지 않는다. 지원한 버전이라도 서비스 수명주기·SKU·quota·policy 제한으로 배포 실패가 가능하다.

필요한 전환은 다음 절차로 추가 구현한다.

1. 원본을 유지하고 source schema/API → target API별 migration adapter를 만든다.
2. 필드명·자료형·열거값·필수값·기본값·중요 의미를 명시적으로 변환한다.
3. 과거 백업에 없던 값을 최신 기본값이나 현재 리소스에서 읽어 과거 값으로 날조하지 않는다.
4. 격리 target의 create·기존 자원 복구·clone 시험을 통과한 후 adapter와 지원 버전을 릴리스한다.

단순 `api-version` 문자열 교체나 범용 PUT은 이 절차의 대안이 아니다. (근거: [API 버전 고정·속성 차이](https://learn.microsoft.com/azure/azure-resource-manager/templates/best-practices#api-version))

대량 복구/복제 오케스트레이터·의존성 그래프·전체 롤백은 이 버전에 없다. 승인한 계획을 자원별로 적용하는 CLI까지만 구현했다.
