# Trial requests (fixed wording)

Each request is used word for word in both conditions (A: the request only; B: the request plus "Read and follow `.github/skills/ui-design-workflow/SKILL.md` and the skills it routes to."). Never edit a request after its first use: add a new version and say so in [trial log](./trial-log.md). S4 was first used on 2026-11-09 (round 9) and is recorded in [trial S4](./trial-s4.md). S5 (a repo-bound bulk action) is fixed in [trial S5](./trial-s5.md) before its first run. The wording of the first S1, S2 and S3 requests (round 2) was not saved, so those results cannot be repeated exactly; S1.v2, S2.v2 and S3.v2 below are the saved versions. Output goes to a temporary folder outside the repository; S4 works in a throwaway copy of the repository. For static pages the state hook is the `?state=` value, so no demo controls compete with the product flow.

## S1.v2 Operations table
방화벽 규칙 검토 화면을 만들어 줘. 검토자가 신청된 규칙 30개(아래 데이터)를 표로 보고, 이름·소스·대상으로 검색하고, 상태(검토 대기·승인·반려)로 거르고, 만료일로 정렬한다. 규칙마다 승인·반려·상세 보기 동작이 있고, 여러 규칙을 선택해 한 번에 승인하거나 반려할 수도 있다. 반려에는 사유가 필요하다. 데이터를 불러오는 중, 결과 없음, 검색·필터 결과 없음, 일부만 불러옴, 오래된 데이터, 오류, 권한 없음(읽기 전용) 상태를 모두 다뤄야 하고, 주소의 `?state=` 값(loading, empty, partial, stale, error, forbidden)으로 바꿔 볼 수 있게 한다. 화면 글은 한국어이고, 외부 라이브러리와 CDN 없이 CSS와 JS를 포함한 HTML 파일 하나로 만든다.

```
ID | 이름 | 소스 | 대상 | 프로토콜/포트 | 동작 | 상태 | 신청자 | 만료일
R-2401 | web-egress-prod | 10.10.0.0/16 | *.contoso.com | TCP/443 | 허용 | 검토 대기 | 김민준 | 2026-12-31
R-2402 | sql-app-to-db | 10.20.1.0/24 | 10.30.4.10 | TCP/1433 | 허용 | 승인 | 이서연 | 2027-03-31
R-2403 | dns-forwarders | 10.10.0.0/16 | 168.63.129.16 | UDP/53 | 허용 | 승인 | 박지훈 | 2027-06-30
R-2404 | ssh-jump-host | 203.0.113.25 | 10.20.2.5 | TCP/22 | 허용 | 반려 | 최수아 | 2026-11-30
R-2405 | ntp-sync | 10.0.0.0/8 | time.windows.com | UDP/123 | 허용 | 승인 | 정도윤 | 2027-01-31
R-2406 | partner-sftp | 198.51.100.0/24 | 10.40.1.20 | TCP/22 | 허용 | 검토 대기 | 강하은 | 2026-12-15
R-2407 | block-torrent | 10.10.0.0/16 | * | TCP/6881-6889 | 거부 | 승인 | 윤서준 | 2027-12-31
R-2408 | blob-private-link | 10.20.0.0/16 | stblobprod.blob.core.windows.net | TCP/443 | 허용 | 검토 대기 | 임지우 | 2027-02-28
R-2409 | monitoring-agent | 10.0.0.0/8 | *.ods.opinsights.azure.com | TCP/443 | 허용 | 승인 | 한유진 | 2027-09-30
R-2410 | vendor-rdp | 192.0.2.40 | 10.50.3.8 | TCP/3389 | 허용 | 반려 | 오세진 | 2026-11-20
R-2411 | aks-api-egress | 10.60.0.0/20 | *.hcp.koreacentral.azmk8s.io | TCP/443 | 허용 | 검토 대기 | 신예린 | 2027-04-30
R-2412 | smtp-relay | 10.20.3.0/24 | smtp.office365.com | TCP/587 | 허용 | 승인 | 권태오 | 2027-05-31
R-2413 | deny-social-media | 10.10.0.0/16 | *.facebook.com | TCP/443 | 거부 | 승인 | 문하준 | 2027-12-31
R-2414 | legacy-ftp | 10.20.4.0/24 | 172.16.8.4 | TCP/21 | 허용 | 반려 | 배서윤 | 2026-11-25
R-2415 | acr-pull | 10.60.0.0/20 | *.azurecr.io | TCP/443 | 허용 | 검토 대기 | 송지호 | 2027-03-15
R-2416 | keyvault-access | 10.20.0.0/16 | kv-prod-kr.vault.azure.net | TCP/443 | 허용 | 승인 | 홍나연 | 2027-08-31
R-2417 | ldap-sync | 10.20.5.0/24 | 10.30.1.15 | TCP/636 | 허용 | 검토 대기 | 류현우 | 2026-12-20
R-2418 | batch-sftp-out | 10.40.2.0/24 | sftp.partner-b.example | TCP/22 | 허용 | 검토 대기 | 조민서 | 2027-01-15
R-2419 | image-cdn | 10.10.0.0/16 | *.azureedge.net | TCP/443 | 허용 | 승인 | 남도현 | 2027-06-15
R-2420 | admin-https | 203.0.113.0/28 | 10.20.9.4 | TCP/8443 | 허용 | 검토 대기 | 서은우 | 2026-12-05
R-2421 | redis-cache | 10.20.1.0/24 | 10.30.6.8 | TCP/6380 | 허용 | 승인 | 안채원 | 2027-07-31
R-2422 | block-smb-out | 10.0.0.0/8 | * | TCP/445 | 거부 | 승인 | 유지민 | 2027-12-31
R-2423 | test-env-any | 10.99.0.0/16 | * | Any | 허용 | 반려 | 고유나 | 2026-11-18
R-2424 | log-forwarder | 10.20.0.0/16 | 10.70.0.5 | UDP/514 | 허용 | 검토 대기 | 장시우 | 2027-02-10
R-2425 | gitops-egress | 10.60.0.0/20 | github.com | TCP/443 | 허용 | 승인 | 노아린 | 2027-10-31
R-2426 | payment-gateway | 10.20.7.0/24 | api.pg-vendor.example | TCP/443 | 허용 | 검토 대기 | 황준서 | 2026-12-28
R-2427 | vpn-health | 10.0.0.0/8 | 10.255.0.1 | ICMP | 허용 | 승인 | 전서아 | 2027-11-30
R-2428 | dev-db-admin | 10.99.1.0/24 | 10.99.4.10 | TCP/5432 | 허용 | 검토 대기 | 마도윤 | 2026-12-10
R-2429 | cert-ocsp | 10.10.0.0/16 | ocsp.digicert.com | TCP/80 | 허용 | 승인 | 석하린 | 2027-04-15
R-2430 | block-tor-exit | 10.10.0.0/16 | 185.220.101.0/24 | Any | 거부 | 승인 | 지서현 | 2027-12-31
```

## S2.v2 Conversion page
방화벽 규칙 신청을 한 곳에서 받는 서비스의 소개 페이지를 만들어 줘. 제안은 하나다: 규칙 신청서를 올리면 검토·승인·반영의 진행을 한 화면에서 따라갈 수 있다. 신뢰를 주는 요소와 행동 유도 하나, 거절하거나 나중에 하는 길이 있어야 한다. 수치나 고객 후기를 지어내지 마라. 실제 Azure에 연결된 상태와 데모 모드의 차이를 보여 줘야 한다. 화면 글은 한국어이고, 외부 라이브러리와 CDN 없이 HTML 파일 하나로 만든다.

## S3.v2 Multi-step form
방화벽 접속 신청서를 3단계로 만들어 줘. 1단계는 신청자(이름, 부서, 이메일, 연락처), 2단계는 규칙(출발지 IP 또는 CIDR, 대상 FQDN 또는 IP, 프로토콜과 포트, 사유, 만료일. 한 건 이상 5건까지), 3단계는 입력 검토와 제출이다. 검증은 이메일 형식, 연락처 형식(010-0000-0000), IPv4 또는 CIDR 형식, 포트 1~65535(범위 허용), 사유 10자 이상, 만료일이 오늘 이후 90일 이내인지다. 임시 저장과 이어 쓰기, 이전·다음 이동과 브라우저 뒤로가기를 지원하고, 제출 중·성공(접수번호)·네트워크 오류·서버 거절(중복 신청)을 다루며 오류에서 복구할 수 있어야 한다. 서버는 응답이 1.5초 늦는 가짜로 만들고, 주소의 `?state=` 값(success, network, duplicate)으로 결과를 고를 수 있게 한다. 화면 글은 한국어이고, 외부 라이브러리와 CDN 없이 HTML 파일 하나로 만든다.

## S4 Repository-bound change
(저장소의 던져 버릴 복사본에서, `frontend/node_modules`는 연결만 한다.) `frontend/src/IpGroupCatalog.tsx`의 `IpGroupCatalogSection`에서 검색 결과가 없을 때 보이는 빈 상태가 어떤 검색어 때문에 비었는지도, 어떻게 되돌리는지도 알려 주지 않는다. 적용된 검색어를 보여 주고 검색을 지우는 동작을 추가해줘. 새 컴포넌트나 API는 만들지 말고 기존 공용 컴포넌트와 토큰을 쓰고, 검색어를 부모가 관리하는 경우에도 동작해야 한다. 끝나면 `npm.cmd run build --prefix frontend`가 통과해야 한다.
