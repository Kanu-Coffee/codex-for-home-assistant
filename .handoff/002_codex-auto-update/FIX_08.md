# FIX_08 — FIX_07 리뷰: 발행된 DEV의 보안 제외 범위와 근거 연결

## 판정과 실제 배포 상태

- Reviewer, 2026-10-13 Asia/Seoul. **CHANGES REQUESTED — 자동 업데이트 기능 인수는 유지, 새로운 보안 제외 정책은 미인수**.
- 기준: 002 PLAN/REPORT, FIX_01~07과 보고서, 루트 `feat/codex-auto-update` HEAD `84b51dde795c01bc78f288c536162bceaf48e990`, release worktree `/tmp/codex-ha-dev-release`의 `68e8ac0d3eb314844598fdb1694e7b60c0dd2815`.
- `0.7.1-dev.2`는 **실제로 발행됐다**. Remote dev/tag SHA, CI [38351187818](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38351187818), Builder [38351197855](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38351197855)의 success를 독립 확인했다. 이전 dev.1의 미발행 상태와 혼동하지 않는다.
- 공개 generic digest `sha256:8d8ff89452b72b36e7a2248692ee8d6a41eb02494412229a6aafb4873c908fab`, amd64 `sha256:32c2d075a2b7e0a00b3b5ce2d173715a81a5c1f174995eb67927f0b1f6dc7bd6`, arm64 `sha256:0fece9f9512c228b590fda833f3bce1e287aed2534dc37d3e4b1fff942390a9d`를 manifest 조회로 확인했다.
- Main은 `a32698851e3c3539f5d4b823e60d4f0d29038df1` 그대로다. GitHub Release `0.7.1-dev.2`는 조회 시 **없었다**. Tag/image 발행과 GitHub prerelease 생성을 구분한다. 이번 Reviewer는 외부 수정·추가 발행·삭제/회수·운영 HA 변경을 하지 않았다.
- 기존 handoff와 tag/image는 보존한다. 다음 Executor는 `FIX_08_REPORT.md`를 새로 작성한다. 수정된 content를 dev.2에 덮어쓰지 말고 다음 미사용 번호를 사용한다.

## 독립 검증

- 전체 pytest: **194 passed in 61.47s**. Actionlint/Hadolint/diff PASS.
- 양 architecture의 exact CI/Builder success와 published manifest는 확인했다. 이번 Reviewer는 실제 HAOS 설치나 image full runtime을 다시 실행하지 않았으며 CI의 runtime 증거와 구분한다.
- `.grype.yaml`, OpenVEX와 workflow를 읽고 pinned [scan-action input 명세](https://raw.githubusercontent.com/anchore/scan-action/e1165082ffb1fe366ebaf02d8526e7c4989ea9d2/action.yml), [Grype filter/VEX 공식 문서](https://oss.anchore.com/docs/guides/vulnerability/filter-results/), [공식 GO-2026-6612](https://pkg.go.dev/vuln/GO-2026-6612)를 확인했다.
- 설치돼 있던 `anchore/grype:latest`(실제 **0.120.1**)로 private SBOM fixture를 검사했다. 이전 actual SBOM에서 `/usr/local/bin/gh`, `/usr/bin/yq` 경로를 `/opt/review08-http2-server`, `/opt/review08-second-server`로 치환했다. 이는 **규칙 스코프 음성 시험이며 실제 HTTP/2 server 실행/공격 시험이 아니다**.
- OpenVEX 파일을 전달하지 않고 현재 `.grype.yaml`만 전달해도 exit **0**, unsuppressed Critical **0**, `ignoredMatches`에 해당 **6건**이 들어갔다. 적용 규칙에는 CVE ID/package name만 있고 경로/버전/architecture/digest 조건은 없다. Raw scan과 filtered 결과를 동일한 것으로 표현하면 안 된다. Scanner는 Go function symbol이 없어 module 단위 matching으로 fallback했다고 경고했다.
- 동일 fixture에 `ignore: []` 대조 config를 적용하면 exit **2**, Critical **6건**(GO-2026-6612/6604)이다. 두 검사를 끝내고 임시 container/DB volume을 정리했다.
- 재현 파일: `/tmp/codex-ha-review08/{retargeted.spdx.json,policy.yaml,empty.yaml,filtered.json,unfiltered.json}`. 결과를 전체 출력하지 않고 필요한 필드만 확인했다. 실제 credential/config/session 본문은 사용하지 않았다.

## 1. P1 — 검토한 gh/yq를 넘어 모든 동명 Go 구성요소를 영구 제외함

근거: `.grype.yaml:5-16`, `.github/workflows/build-app.yaml:120-138`.

Rule의 유일한 조건은 취약점 ID와 `stdlib`/`golang.org/x/net` 이름이다. Reason에 gh/yq를 적어도 scanner matching 조건이 되지 않는다. 따라서 다른 경로·다른 버전의 실제 HTTP/2 server가 같은 module을 포함해도 GO-2026-6612가 숨겨질 수 있다. 위 retargeted SBOM에서 6건이 모두 제외된 것으로 재현했다. 같은 config가 Critical gate뿐 아니라 비차단 보고에도 쓰여 제외 사실이 기본 table 출력에서 보이지 않는다. Workflow는 DEV에만 제한된 정책도 아니다.

FIX_07은 binary/digest/symbol/사용 형태에 묶인 비적용 근거를 요구했다. 현재 구현은 그 범위를 충족하지 않는다. Windows-only 취약점의 Linux 비적용 방향을 부정하거나 현재 gh/yq의 실제 취약성·악용 가능성을 입증했다고 주장하는 것이 아니다. 검토 범위를 벗어난 component까지 제외하는 정책의 결함이다.

수정:

- 가능한 patched dependency의 최소 변경을 우선 검토한다. 비적용 정책을 유지한다면 exact reviewed image/binary·architecture·package version/location과 검증한 source/symbol 근거에 묶는다. Identity나 필요한 SBOM metadata가 없으면 제외를 적용하지 않는다. 새로운 binary/version/platform은 자동 승계하지 않는다.
- 최소 음성 회귀: 검토된 binary는 근거에 따라 처리하되, `/opt`의 다른 binary, 변경된 version/hash/platform, 추가 server component, metadata 누락에는 Critical gate가 계속 실패해야 한다. 실제 Grype/CI 실행으로 검증한다. 단순 config 문자열 assertion만으로 대신하지 않는다.
- 원본 findings와 제외된 findings/reason을 auditable artifact 또는 `--show-suppressed`/JSON `ignoredMatches`로 남긴다. '0 critical'은 필터 후 결과임을 분명히 하고 patched/원본 0건과 구분한다.

## 2. P2 — OpenVEX가 검사에 연결되지 않았고 제품별 비적용 근거가 부족함

근거: `.github/security/openvex.json:12-28`, workflow `127/138`.

Workflow는 `config`만 전달한다. Config에 `vex-documents`가 없고 action의 `vex` input도 사용하지 않아 OpenVEX는 scanner에 입력되지 않는다. CI success는 VEX product 매칭이나 justification 검증 결과가 아니다. 현재 VEX product는 image/binary가 아니라 일반 stdlib/x/net PURL이므로, 그대로 소비하도록 연결하는 것만으로도 제품별 경계 문제가 해결되지 않는다.

- 적절한 product/subcomponent identity를 사용하고 실제 scanner가 VEX를 소비하는지 증명한다. 또는 수동 검토 문서로만 유지한다면 이를 솔직히 표시하고 실제 policy의 좁은 경계를 별도로 검증한다. 연결하지 않은 VEX를 gate 통과의 증거로 쓰지 않는다.
- HTTP/2 server 비도달 결론은 exact binary/source 및 지원되는 gh 실행 경로에 근거를 남긴다. 'CLI client/파일 parser이므로 원천 unreachable'이라는 설명과 module 단위 scan PASS만으로 function reachability 검증을 완료했다고 쓰지 않는다. OS-specific 비적용도 actual Linux image에 묶는다.
- Raw/filtered/VEX-only 대조군으로 어떤 정책이 어떤 finding을 제외했는지 assertion한다. VEX 파일 누락·잘못된 product identity·추가 component가 조용히 전역 ignore로 통과해서는 안 된다.

## 보고서 정정·다음 배포

- FIX_07_REPORT의 사용자 시험 안내는 auto-update 기본값을 `false`라고 적었으나 실제 dev.2 config는 **true**다. 원본 보고서는 보존하고 새 보고서와 progress/사용자 안내에서 정정한다. 문서 맞추기만을 위해 승인된 기본값을 임의로 바꾸지 않는다.
- GitHub prerelease, exact public image label/App/Codex/GH version 및 독립 signature/attestation 검증 상태도 별도로 기록한다. Builder의 sign success와 독립 signature verification을 혼동하지 않는다.
- 위 정책 수정 뒤 새 DEV의 exact SHA CI, native amd64/ARM smoke, raw 및 bounded-policy scan, tag Builder/manifest/public 조회를 검증한다. 자동 업데이트 기능 자체를 재작성할 필요는 없다.
- 이미 게시한 dev.2를 임의로 삭제/덮어쓰지 않는다. 정상적인 새 DEV 게시에 대한 기존 사용자 승인은 유지하되 광범위한 보안 gate 면제로 확대하지 않는다. 사용자 실제 HAOS 수용은 계속 NOT RUN이다.
