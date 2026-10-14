# FIX_09 — FIX_08 재리뷰: 같은 버전을 쓰는 미검토 바이너리도 제외됨

## 판정·배포 사실

- Reviewer, 2026-10-13 Asia/Seoul. **CHANGES REQUESTED**. 자동 업데이트 기능 코드 인수는 유지한다. 보안 제외 정책의 binary/product 경계는 여전히 미해결이다.
- 기준: PLAN/REPORT 및 FIX_01~08과 보고서, root `feat/codex-auto-update` HEAD `87ff7c27107e5f007719443a687d2e086165910b`, `/tmp/codex-ha-dev-release`의 release SHA `ce95cba9dbe3a32eea107df219d106b9573428d0`.
- Exact SHA의 [DEV CI 38357039179](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38357039179)와 [Builder 38357055889](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38357055889)는 success다. Remote main은 기존 `a32698851e3c3539f5d4b823e60d4f0d29038df1` 그대로다.
- `0.7.1-dev.4`는 실제 공개 발행돼 있다. Generic `sha256:6e3a421d8e3acca71adf1db0fd1a4a2b9101a3ae2b05f830d8c3f3dbf52e6f68`, amd64 `sha256:ad6dabb4be304f6d640cd706bb6276af6d0438bd288e9750247a5af78c41ebb6`, arm64 `sha256:f94e984fcaf2181355c58bfbd573a9b766863237eaf611e887de1455da5ffad9`를 독립 manifest 조회로 확인했다. GitHub Release는 조회 시 없었다.
- 기존 handoff/tag/image를 보존한다. 다음 Executor는 `FIX_09_REPORT.md`를 작성한다. 이번 Reviewer는 구현·외부 Git/image/운영 HA를 변경하지 않았다.

## 개선된 사항과 독립 검증

- 버전/type 조건, suppressed 결과 표시, 실제 `vex` 입력 연결, 기본 auto-update **true** 보고 정정은 확인했다. VEX가 연결되지 않았다는 이전 지적을 반복하는 것이 아니다.
- 전체 pytest: **198 passed in 62.64s**. Actionlint와 `git diff --check` PASS. 이번 Reviewer는 HAOS 설치/image full runtime/signature 독립 검증을 다시 수행하지 않았으며 CI와 Builder 증거를 구분한다.
- 설치돼 있던 Grype **0.120.1**로 동일한 private SBOM fixture를 실제 검사했다. 이전 actual SBOM의 gh/yq 경로만 `/opt/review08-http2-server`, `/opt/review08-second-server`로 변경하고 **module 이름/버전은 그대로 유지**했다. 이는 scanner의 product 경계 음성 시험이며 실제 공격 가능성 시험이 아니다.

| 동일 fixture에 적용한 정책 | exit | 미제외 Critical | 제외 수 |
| --- | --- | --- | --- |
| 빈 ignore, VEX 없음 | **2** | **6** | 0 |
| 현재 `.grype.yaml` + 현재 VEX | **0** | 0 | **6** |
| 빈 ignore + 현재 VEX만 | **0** | 0 | **6** |

VEX-only의 `appliedIgnoreRules`는 `namespace:vex`, `vex-status:not_affected`를 실제로 표시했다. 따라서 VEX 소비 자체는 정상이며, 그 **적용 제품 범위가 넓은 것**이 문제다. 결과는 `/tmp/codex-ha-review09/{retargeted.spdx.json,filtered.json,raw.json,vex-only.json}`에 저장했다. Fixture container와 DB volume은 정리했다. 비밀·실제 HA 설정/session 본문은 사용하지 않았다.

공식 [Grype filtering/VEX 명세](https://oss.anchore.com/docs/guides/vulnerability/filter-results/)도 확인했다. Version/location 등 여러 조건을 사용할 수 있고, VEX product는 검토한 container digest 및 subcomponent identity로 묶을 수 있다.

## 1. P1 — 버전 추가만으로 gh/yq binary 경계가 생기지 않는다

근거: `.grype.yaml:10-61`, `.github/security/openvex.json:12-28`.

Ignore는 CVE/name/version/type만 검사하고 binary 경로/hash/identity는 검사하지 않는다. VEX product도 검토한 image/gh/yq가 아니라 일반 stdlib/x/net PURL이다. 같은 Go 버전으로 빌드된 다른 server는 **동일한 stdlib/x/net 이름·버전**으로 탐지되므로 현재 두 경로 모두 그 finding을 제외한다. 경로만 바꾼 위 재현이 현재 정책에서도 여전히 exit 0이다.

FIX_08이 요구한 `/opt`의 다른 binary, 같은 경로의 hash 변경, 추가 server component, identity metadata 누락에 대한 fail closed가 구현되지 않았다. Version이 다른 경우만 차단하는 것은 이 요구를 대신하지 않는다. 현재 gh/yq가 실제로 HTTP/2 취약점을 실행한다는 결론을 낸 것이 아니라 **그 두 binary의 분석이 다른 binary에 승계되는 정책 결함**이다.

### 최소 해결 범위

- 가능한 patched dependency로 바꾸거나, 검토한 artifact의 identity가 맞는 경우에만 예외를 적용한다.
- 비적용 정책을 유지할 경우 선택지는 예를 들어 다음과 같다. (1) 정확한 image digest와 그 subcomponent에 묶은 VEX, 또는 (2) image 내 모든 Go binary의 allowlist·경로·hash/architecture/version을 검증하고 성공한 exact scan에만 한정 정책을 전달하는 fail-closed preflight. 구현 방식은 Executor가 선택하되 아래 결과 계약을 충족해야 한다.
- **Ignore와 VEX를 각각 좁힌다.** 둘 중 하나만 바꾸면 다른 경로가 여전히 finding을 숨긴다. Preflight를 택한다면 누락/실패 시 전역 자동 탐색 `.grype.yaml`이나 정적 generic PURL VEX로 검사를 우회하지 못하게 한다.
- SBOM에 binary location/hash가 없다면 추측으로 승인하지 않는다. 필요한 metadata를 유지하는 형식/추출 단계 또는 exact artifact identity 검증을 마련한다.
- 원본·suppressed findings와 실제 적용 근거를 유지한다. GO-2026-6604의 Linux 비적용 자체와 HTTP/2 server 실행 가능성 분석은 구분하되 예외가 검토한 제품 밖으로 번지지 않게 한다.

## 2. P2 — 새 음성 테스트가 실제 scanner와 주요 경계 조건을 검증하지 않음

근거: `tests/test_vulnerability_gate_policy.py:83-113`, FIX_08_REPORT의 negative-control 설명.

`matches_rule()`는 테스트 안에서 직접 구현한 Python 비교 함수다. Grype/VEX/preflight를 실행하지 않고 exit code도 검사하지 않는다. `stdlib`을 `github.com/example/server`로 바꾸면 실제 다른 server의 **stdlib은 여전히 stdlib**이라는 핵심 조건을 놓친다. `v0.60.0`은 수정 버전이므로 그 finding이 제외되지 않는다는 assertion 자체도 실제 vulnerable negative control과 다르다.

기존 보고서가 별도의 local Grype go1.26.7 시험을 기록한 것은 보존하지만, 자동 테스트가 다른 binary/동일 버전 경계를 검증했다는 주장으로 확대할 수 없다.

### 필수 실제 결과 계약

| 대조군 | 기대 |
| --- | --- |
| 검토한 exact artifact와 유효한 identity·근거 | 필요한 비적용 finding만 제외 가능 |
| **module 이름·버전 유지**, binary를 `/opt`의 미검토 경로로 변경 | gate/preflight 실패 |
| 같은 module 버전의 미검토 server binary 추가 | 실패 |
| 허용 경로지만 binary hash/architecture 변경 | 실패 |
| product/image identity 또는 필수 metadata 누락 | 실패 |
| raw / ignore-only / VEX-only / combined | 실제 적용 정책과 원인 확인, 어느 예외 경로도 미검토 component를 숨기지 않음 |

이 계약을 실제 Grype 또는 실제 CI preflight+Grype 경로로 검증한다. Config 문자열이나 손으로 쓴 matcher 시험만으로 통과 처리하지 않는다. 추가 server를 재현하기 위해 실제 서비스/운영 HA를 띄울 필요는 없다. Synthetic SBOM·image identity fixture로 검증할 수 있다.

## 인계·배포

- 자동 업데이트 runtime을 다시 작성할 요구가 아니다. 위 정책 경계와 실제 음성 회귀에 집중한다. Source/symbol 기반 비도달 근거는 exact artifact에 연결하고 불확실한 것은 NOT RUN으로 남긴다.
- 현재 이미지 발행 사실과 코드 리뷰 승인을 구분한다. 기존 tag/image를 덮어쓰거나 임의 회수하지 않는다. 수정 후 다음 미사용 DEV 번호를 선택하고 metadata를 일치시킨다.
- 기존 승인 범위의 정상 새 DEV 배포는 재승인을 요청하지 않고 진행할 수 있다. 정확한 SHA의 CI/native amd64/ARM와 bounded-policy scan·Builder/public manifest 검증을 수행하고 FIX_09_REPORT/progress에 기록한다.
- 실제 사용자 HAOS 설치/UI/mobile 수용은 계속 NOT RUN이며, main/stable과 운영 HA는 변경하지 않는다.
