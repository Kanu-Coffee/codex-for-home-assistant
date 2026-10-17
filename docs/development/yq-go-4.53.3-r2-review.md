# yq-go 4.53.3-r2 바이너리 검토 — 2026-10-17

## 변경과 검토 범위

`0.7.2-dev.1` 후보의 [Builder 39010525417](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/39010525417)에서 Alpine `yq-go`가 기존 검토본 `4.53.3-r1`에서 `4.53.3-r2`로 바뀌었다. Preflight는 미검토 bytes/module을 정상적으로 거부하고 예외 없는 검사로 폴백했으며 Critical gate가 게시를 차단했다. 실패 결과를 PASS로 바꾸거나 기존 run을 게시에 재사용하지 않는다.

[공식 Alpine recipe](https://raw.githubusercontent.com/alpinelinux/aports/3.24-stable/community/yq-go/APKBUILD)는 upstream `v4.53.3` 소스, package revision 2와 `go build`를 사용한다. Recipe에는 별도 패치나 신규 서버 실행 경로가 없다. 기존 검토와 upstream 버전·CLI 용도는 같고 실제 artifact의 stdlib는 `go1.26.9`, `golang.org/x/net`은 기존과 같은 `v0.55.0`이다. 두 architecture의 Builder SPDX에서 이를 각각 확인했다.

## 출처와 byte 검증

Alpine v3.24 community의 x86_64/aarch64 APK를 공식 CDN에서 HTTPS로 가져와 이미지에 포함된 architecture별 Alpine 공개키로 `apk verify`를 실행했다. 양쪽 모두 OK이며 아래 binary SHA256은 Builder SPDX의 실제 파일 해시와 일치한다. amd64는 실제 로컬 이미지의 파일 해시와도 일치한다. ARM 바이너리는 실행하지 않고 서명 확인 후 추출·hash만 수행했다. `--allow-untrusted`를 사용하지 않았다. 최초 ARM index 조회는 기본 x86 공개키로 실패했으며, 공식 APK 직접 조회와 이미지에 동봉된 aarch64 공개키를 사용해 검증했다.

| File | amd64 SHA256 | arm64 SHA256 |
| --- | --- | --- |
| `/usr/bin/yq` r2 | e729542bf14c1de1e09df51d61e875f8322d7ca04c5d9375fc01cbf780e1722d | 3455c1838dd3d8cc5a7e6847f8a84bae279d2c56f543815f3be8f6a828baf272 |
| `/usr/local/bin/gh` 2.97.0 (기존과 동일) | 141507c337e8b202ad398550c3b73d72f5af92e86f71665214538a81efd4c409 | ccbb0f14178faefac1cb0f336a853071fa63a1d0df23ef5ab7a304fe3859e082 |

## 적용 가능성 판단과 변경한 검사 조건

[Go 공식 GO-2026-6612](https://pkg.go.dev/vuln/GO-2026-6612)는 HTTP/2 **서버**의 flow-control 환급 처리 문제다. 공식 advisory는 Go 1.26.9의 stdlib 수정과 x/net v0.60.0의 수정을 구분한다. yq의 새 stdlib는 수정본이므로 기존 yq stdlib waiver 2개를 제거한다. x/net v0.55.0이 수정됐다고 주장하지 않는다.

남아 있는 yq x/net의 기존 적용 불가 판단은 유지한다. [해당 upstream CLI entrypoint](https://raw.githubusercontent.com/mikefarah/yq/v4.53.3/cmd/root.go)는 데이터 파일 평가 CLI이며, 같은 버전의 Alpine recipe에도 HTTP/2 서버를 시작하는 변경이 없다. 이는 기존 CLI-only 검토를 새 signed rebuild의 동일 upstream 소스에 연결한 판단이다. 네트워크 서버 코드 전체가 바이너리에 없다는 보장은 아니다. gh의 기존 binary bytes·module·client/loopback callback 용도는 변경하지 않는다.

- 갱신 대상은 yq stdlib의 **정확한** 예상 버전과 architecture별 검토 해시다.
- 생성되는 좁은 규칙은 기존 gh 3개와 yq x/net 1개, 총 4개다. 수정된 yq stdlib에는 suppression을 발급하지 않는다.
- 새로운 취약점 ID나 임의 버전 허용을 추가하지 않는다. Root `.grype.yaml`의 빈 ignore와 Critical 차단 threshold, 실제 이미지 파일 해시·SBOM 매핑·image identity 검증은 유지한다.
- 다음 package/binary/module 변경은 여전히 미검토로 처리되고 raw scan으로 폴백한다. 서명 또는 metadata 모순은 계속 fail closed한다.

## 검증과 한계

Focused preflight 회귀와 metadata/hash 변조 음성 대조, 실제 scanner의 gated/raw 대조 및 이후 exact PR/tag CI 결과는 `progress.md`에 기록한다. 현 문서는 이미지가 패치되지 않은 모든 취약점에서 안전하다는 선언이나 게시 gate 면제가 아니다. SBOM 파일 해시만 신뢰하지 않고 다음 Builder도 actual Docker image 파일과 재대조해야 게시할 수 있다.
