# FIX_07 — 기능 리뷰 인수 후 DEV 게시의 Critical 보안 gate 차단

## 판정과 역할

- Reviewer, 2026-10-13 Asia/Seoul. **자동 업데이트 기능 코드 인수 / DEV 설치 이미지 발행 차단**.
- FIX_06의 두 결함은 수정됐다. 추가 기능 재작성을 요구하지 않는다. 이번 correction은 실제 배포 과정에서 새로 확인한 image dependency 보안 gate 실패에 한정한다.
- PLAN/REPORT, FIX_01~06 및 보고서와 현재 Git/source/runtime 증거를 검토했다. 기존 handoff는 보존한다. 다음 Executor는 본 문서에 대응하는 `FIX_07_REPORT.md`를 새로 작성한다.

## 실제 진행한 작업과 Git 상태

- 기존 구현과 handoff를 source commit `b0a490f`로 기록했다. 루트 workspace branch는 `feat/codex-auto-update`다.
- DEV 준비 branch `codex/release-0.7.1-dev.1`, worktree **`/tmp/codex-ha-dev-release`**에서 DEV version/표시명/panel/MOTD/OCI/experimental stage/package version과 상태 fallback을 맞췄다. Stable/DEV Builder fixture는 현재 채널과 분리해 둘 다 검증하도록 정규화했다.
- Immutable handoff history는 product Markdown lint 대상에서 제외했다. 실제 product 문서 lint는 유지했다. 처음 CI의 progress 문서 빈 줄 오류 1건은 수정했다. 기존 handoff를 편집하지 않았다.
- Remote `dev`와 annotated tag `0.7.1-dev.1`의 peeled commit: **`bd080c73d458e6a1afd2c70b32e0bd674daf7d69`**.
- Remote `main`은 **`a32698851e3c3539f5d4b823e60d4f0d29038df1`** 그대로다. Stable tag/image와 운영 HA는 변경하지 않았다.
- `0.7.1-dev.1`은 **source/tag만 존재**한다. Builder가 image 최종 promotion 전에 중단했고 generic 공개 image 조회가 `not found`다. GitHub Release도 만들지 않았다. 현재 후보를 설치 가능하다고 안내하면 안 된다.
- 이미 발행한 Git tag는 삭제/이동/재사용하지 않는다. 다른 content로 수정해 발행할 때 다음 미사용 `0.7.1-dev.N`을 선택한다. 이번 번호 `dev.1`은 소비됐다.

## 검증 결과

| 항목 | 실제 결과 |
| --- | --- |
| 독립 `.venv/bin/pytest -q` | **194 passed in 62.16s** |
| FIX_06 EACCES reader 재현 | `preserved:true`, readerAlive true |
| Auckland 날짜 경계 재현 | 다음 슬롯 `2026-10-13T14:00:00Z`, 정상 |
| ShellCheck/actionlint/Hadolint/AppArmor parser/개별 Node syntax/diff | PASS |
| App와 handoff gitleaks | PASS, no leaks |
| DEV metadata/양 채널 Builder fixture 관련 19개 시험 | PASS |
| 최초 DEV CI [38346683667](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38346683667) | amd64/ARM/App config PASS, Markdown의 progress 빈 줄 1건 FAIL 후 수정 |
| 정확한 배포 commit CI [38347070912](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38347070912) | **전 job PASS**: lint/unit, HA App config, amd64 build/full smoke, native aarch64 build/full smoke |
| 위 CI의 actual AppArmor updater와 public 0.7.0→candidate persistence | **두 architecture 모두 PASS** |
| Tag Builder [38347457454](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38347457454) | metadata/양 architecture build·SBOM 생성 PASS, **양 architecture Critical gate FAIL**, multi-arch publication SKIPPED |

이번에는 수정 코드의 실제 native ARM/amd64 통합 시험 공백을 원격 CI로 해소했다. 이는 사용자의 실제 HAOS 설치/UI/mobile/model turn 수용을 대신하지 않으며 해당 실기는 계속 NOT RUN이다. 새 VM을 시작하거나 실제 HA를 변경하지 않았다.

## P1 — GH CLI/yq의 Go 구성요소로 image 게시가 차단됨

근거: `.github/workflows/build-app.yaml`의 `Enforce critical vulnerability gate` (`fail-build:true`, `severity-cutoff:critical`)가 실제로 실패했다. amd64 job `115132134162`, ARM job `115132134150` 모두 같은 단계 실패다. 보안 gate를 낮추거나 생략하지 않았다.

amd64 SBOM artifact **11789931770** 및 scan log에서 확인한 연결:

| Image executable | SBOM 구성요소 | 설치 버전 | Scanner의 수정 버전 |
| --- | --- | --- | --- |
| `/usr/local/bin/gh` (GitHub CLI 2.97.0) | stdlib | go1.26.5 | go1.26.9 (GO-2026-6612/6604) |
| 같은 gh | golang.org/x/net | v0.56.0 | v0.60.0 (GO-2026-6612) |
| `/usr/bin/yq` (Alpine yq-go 4.53.3-r1) | stdlib | go1.26.8 | go1.26.9 (GO-2026-6612/6604) |
| 같은 yq | golang.org/x/net | v0.55.0 | v0.60.0 (GO-2026-6612) |

amd64 gate가 위 조합의 Critical 6건을 보고했다. 이는 scanner 결과와 배포 차단의 증거이며, 각 CLI에서 취약 server code가 실제 reachable함을 입증한 것은 아니다.

공식 [GO-2026-6612](https://pkg.go.dev/vuln/GO-2026-6612) 및 [GO-2026-6604](https://pkg.go.dev/vuln/GO-2026-6604)를 확인했다. GO-2026-6612는 HTTP/2 server flow-control 문제이며 Go 1.26.9와 x/net 0.60.0 수정 경계가 공식 report에 명시돼 있다. Scan의 applicability/reachability와 실제 image bytes를 함께 확인해야 한다.

현재 latest upstream metadata 조회 결과는 GH CLI [v2.102.0](https://github.com/cli/cli/releases/tag/v2.102.0), yq [v4.54.1](https://github.com/mikefarah/yq/releases/tag/v4.54.1)이고 둘 다 2026-09월 발행이다. 버전 번호만 올려 10월 보안 수정이 포함됐다고 추정하지 않는다.

## Executor 수정·검증 지침

1. **실제 배포 source를 기준으로 작업한다.** `/tmp/codex-ha-dev-release`의 release branch는 DEV metadata를 포함한다. 루트 feature branch에만 수정하고 remote DEV로 반영하지 않는 누락을 피한다. 본 handoff와 기존 문서는 루트 저장소에 있다. 새 보고서도 루트 `.handoff/002_codex-auto-update/`에 작성한다.
2. SBOM에서 binary별 dependency와 scan applicability를 재확인한다. Patched official binary/package가 있으면 official source·아키텍처별 SHA-256·실제 내장 Go/module을 검증해 최소 변경한다. 단순 gh/yq 최신 version 치환만으로 해결됐다고 쓰지 않는다.
3. Official patched artifact가 없으면 재현 가능한 pinned source build 등 적절한 대안을 검토하고 변경·검증 근거를 남긴다. 기존 `yq` 사용 계약과 feedback의 pinned `gh` CLI 동작, license/third-party notice, amd64/ARM 및 rootless sandbox 실행을 유지한다. 불필요한 전역 도구 설치나 광범위한 base migration은 피한다.
4. Critical gate를 무조건 non-blocking으로 바꾸거나 CVE ID 전체를 근거 없이 무시하지 않는다. Reachability/VEX로 처리해야 한다면 해당 binary·digest·symbol·사용 형태에 묶인 근거와 명시적 정책 결정을 준비한다. 현재 사용자 승인은 정상 DEV 게시이며 Critical gate 면제 승인은 아니다.
5. 수정은 **새 미사용 `0.7.1-dev.N`**으로 준비한다. App/Dockerfile/package/manager fallback/test/changelog/DEV identity를 일치시키고 기존 tag와 image는 덮어쓰지 않는다. main/stable과 운영 HA를 변경하지 않는다.
6. 관련 pytest/lint와 native amd64/aarch64 CI의 실제 full/updater/AppArmor/0.7.0 persistence를 확인한다. Exact DEV SHA의 CI PASS 후 tag Builder를 실행하고 양 architecture의 Critical gate 및 manifest promotion PASS를 확인한다. 실패 run의 artifact를 다른 content의 release로 이어 붙이지 않는다.
7. 게시 뒤 anonymous generic/per-architecture 조회, exact App/Codex/GH version, image label/digest·서명/attestation과 prerelease 상태를 검증한다. 이 호스트의 `/usr/bin/gh`는 `gh attestation` subcommand가 없고 cosign도 PATH에 없어 이번 독립 서명 검증은 수행하지 못했다. Builder 자체가 서명 단계 전 차단됐으므로 서명 완료로 기록하지 않는다.
8. 최종 공개 image가 생긴 뒤에만 설치 가능한 DEV라고 안내한다. 사용자 수용 항목은 checkbox/OFF→ON, status의 bundled/selected/running version, 활성 세션 보류·유휴 적용, 12회 budget의 다음 날짜 재개와 24시간 restart cooldown, 기존 인증/SSH/browser 보존이다.

## 보고서와 승인 경계

- FIX_07_REPORT/progress에는 기능 코드 인수와 새 dependency release blocker를 구분한다. 이번에 확보한 actual CI PASS를 이전 NOT RUN으로 되돌리지 않는다.
- 재검토는 설정 시간대 update slotDate 기준 일일 12회, 재시작은 영속 rolling 24시간 cooldown이다. Turn별·평생 누적 차단은 아니다. 원인 해결이 필요한 integrity/policy/restart block은 manual 재검사 경로를 유지한다.
- 사용자 승인 범위는 인수 가능한 DEV의 발행이다. 이 범위의 정상 배포는 재승인을 요청하지 않고 수행할 수 있다. 보안 gate 면제·main stable 승격·실제 운영 HA 변경은 이번 승인으로 확대하지 않는다.
