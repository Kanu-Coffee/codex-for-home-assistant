# FIX_08 — 사용자 DEV 수용에 따른 Stable 0.7.4 실제 공개 배포 지시

- 작성: 2026-11-11 (Asia/Seoul), Reviewer: Codex.
- 사용자 인수: “dev 버전으로 내가 직접 설치 후 테스트 완료하였고 이상없다. 실제 0.7.4 배포를 지시하기 위한 fix를 발행하라.”
- 판정: **사용자 DEV 실기 수용 완료. 아래 최종 gate를 통과한 Stable 0.7.4의 실제 공개 배포를 Executor에게 지시한다.**
- 목표: `0.7.4` / main / 정식 GitHub Release / 공개 multi-arch GHCR image.
- 공개 설치 경로: `https://github.com/Kanu-Coffee/codex-for-home-assistant`.
- 이번 Reviewer는 FIX 발행과 진행 상태 기록만 수행한다. 실제 배포 결과는 Executor가 `FIX_08_REPORT.md`에 신규 기록한다.

## 1. 인수 자료와 현재 Git 상태

PLAN, REPORT, FIX_01~07 및 각 보고서, FIX_06_REVIEW, 현재 Git source/diff, 저장소 개발 지침을 읽고 이어서 수행한다. 기존 handoff 문서는 덮어쓰지 않는다.

작성 시점 확인:

- 작업 branch `dev`, HEAD/원격 dev: `aee4f15f48756aefa934ffb9810b8dfc2e21c9fa`. 작성 전 working tree는 clean이었다.
- 검증·게시된 DEV annotated tag `0.7.4-dev.1`의 source: `5ca726d087c571701eca68f61f970e8cbc7ea975` (PR #73 merge; 앞선 기능 PR #72 포함).
- tag 이후 HEAD까지 차이는 FIX_07_REPORT와 progress 두 문서뿐이다. 검증된 DEV 런타임의 변경은 없다.
- 원격 main: `03c572de01e4a733fd1b6d0e9da1f0bee4206ca9`, 기존 Stable 0.7.3.
- GitHub API 재조회: exact DEV source CI `42785764339`, tag Builder `42786765959` 모두 completed/success, head SHA `5ca726d…` 일치.
- DEV Release는 공개 상태 (`draft=false`, `prerelease=true`): `https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4-dev.1`.
- 원격 refs 조회에서 `0.7.4` tag는 없었다. Release·GHCR 충돌까지 번호가 예약됐다는 의미는 아니므로 실행 직전에 재조회한다.

FIX_07_REPORT의 이전 로컬 전체 suite 결과는 **337 passed / 1 skipped**이며 DEV source의 증거다. 최종 Stable source/image 검증을 대신하지 않는다. 이 Reviewer는 이번에 전체 suite나 image smoke를 다시 실행하지 않았다.

사용자가 DEV를 직접 설치·테스트했고 이상 없음을 확인한 사실을 실기 수용 근거로 기록한다. 장치 종류/architecture, 개별 테스트 항목, 장시간 예산 전이, 모바일 복원, 설치 digest까지 제공받은 것으로 확대하지 않는다. 과거 보고서의 실기 대기는 역사로 보존하고 현재 상태에서 사용자 수용으로 갱신한다.

## 2. 실행 권한과 변경 범위

이 FIX는 release 준비 branch의 commit/push, **base=main PR 생성·검증·병합**, exact main merge SHA의 annotated `0.7.4` tag push, 기존 Builder를 통한 GHCR 공개, **정식 최신 GitHub Release 게시**까지 지시한다. 통상적인 이 단계에 별도 승인 질문을 반복하지 않는다.

검증된 DEV 동작을 유지하고 Stable 메타데이터·문서·관련 계약 테스트만 전환한다. 이슈 #71 default socket proxy 귀속, update 관측·이력, 예산 12/4, legacy/시간대 경계 및 세션 보호 수정을 보존한다. bundled Codex **0.162.1**, 의존성 pin, slug와 image 경로를 유지한다. 런타임 동작 변경이 필요해지면 차이와 원인을 기록하고 영향 범위를 다시 검증한다.

`/config` RW, Supervisor `manager`, 민감 경로 차단, token 상속 제거와 AppArmor 정책을 유지한다. admin/docker_api/full_access/host_network/AppArmor 비활성화 도입, gate 무력화, 무관한 의존성 갱신은 하지 않는다. 실제 사용자 HA 업데이트·설정 변경·데이터 이전·삭제/재설치, force push/tag 이동은 포함하지 않는다.

## 3. 사전 확인과 Stable 준비

1. AGENTS/GEMINI의 적용 지침, rules/progress, product_spec/architecture/addon_spec/security/test_plan/releasing와 workflow 원문을 확인한다. 원격 main/dev, local 변경과 DEV tag 이후 차이를 다시 대조하고 다른 작업을 보존한다.
2. 원격 tag, GitHub Release, generic/per-architecture GHCR `0.7.4` tag의 충돌을 확인한다. 기존 artifact가 있으면 source/digest/완료 상태부터 조사한다. 동일 release의 안전한 재개인지 판단하고 다른 source/digest를 덮어쓰지 않는다. **고정 목표 0.7.4를 임의로 0.7.5로 변경하지 않는다.** 충돌로 진행 불가하면 증거와 미완료를 보고한다.
3. `codex/` 접두사 release 준비 branch에서 검증된 DEV 변경을 최신 main과 통합한다. 단순히 main의 0.7.3 버전만 변경하거나 기능/test/CI를 누락하지 않는다. 충돌 해결 후 DEV tag 대비 전체 차이를 검토한다.
4. 다음 Stable 계약을 일치시킨다.
   - `codex_home_assistant/config.yaml`: version `"0.7.4"`, name `Codex for Home Assistant`, panel_title `Codex`, description의 `[DEV]` 제거, **stage 키 생략**.
   - `repository.yaml`: Stable 표시명. slug/image 경로는 유지한다.
   - Dockerfile `BUILD_VERSION=0.7.4`, OCI title/description과 `rootfs/etc/motd`의 DEV 표시 제거. image 안 app-version도 0.7.4여야 한다.
   - Playwright package.json/package-lock.json의 root version, runtime manager APP_VERSION fallback, 관련 현재 버전·채널 계약 테스트를 0.7.4에 맞춘다. 검사를 삭제하거나 skip하지 않는다.
   - CHANGELOG 첫 release heading을 실제 공개일의 `0.7.4`로 추가하고 해당 변경을 정리한다. 기존 DEV와 Stable 이력은 보존한다.
5. 한국어·영어 루트/App README와 DOCS, 관련 개발 문서의 current-version·설치 안내를 맞춘다. 오래된 releasing의 current stable 0.7.2 등도 정리한다. main의 DEV 배너를 제거하고 DEV 채널 설명·과거 기록은 보존한다. 공개 전에는 공개 완료로 기록하지 않는다.
6. Home Assistant의 시점 의존 메타데이터는 최신 [공식 App configuration](https://contributors.home-assistant.io/apps/reference/configuration/)과 다시 대조한다. image/version 일치 및 stable stage 생략을 지킨다. OpenAI 시점 의존 동작을 새로 변경/설명하면 최신 공식 문서를 확인한다.

## 4. 최종 source와 image 필수 검증

- 기존 `tests/prepare-test-binaries.sh`로 공식 fixture를 준비하고 기존 Python 환경에서 최종 source의 전체 `python -m pytest -ra`를 실행한다. 짧고 용량이 충분한 disposable basetemp를 사용한다. 다음을 연결하고 각 binary의 실제 버전을 확인한다.
  - `CODEX_WIRE_PROBE_BINARY=$PWD/.test-tmp/candidate-167/bin/codex`
  - `CODEX_HANDOVER_BASELINE=$PWD/.test-tmp/task007-baseline/bin/codex`
  - `CODEX_HANDOVER_CANDIDATE=$PWD/.test-tmp/candidate-167/bin/codex`
- real handover/default proxy/ephemeral 보호/legacy·timezone·예산 전이/status·이력 회귀가 실제 실행돼야 한다. 필수 binary 부재 skip으로 green을 만들지 않는다. 모든 skip 이름과 사유를 보고한다.
- 저장소 기존 lint와 CI gate를 따른다. 관련 Node/Bash syntax, ShellCheck, YAML/Markdown, Dockerfile/Actions lint, App linter, AppArmor parser 및 enforced-profile smoke, secret scan, `git diff --check`를 확인한다. 비밀값을 출력하지 않는다.
- 최종 Stable amd64 image와 native aarch64 CI에서 version/architecture/labels, S6·Web·SSH/remote bootstrap, bundled executable과 필요한 runtime을 확인한다. 관련 `tests/docker-smoke.sh`, `tests/mobile-ssh-smoke.py`, `tests/codex-update-smoke.sh`를 기존 invocation에 따라 수행한다.
- 실제 제품 wrapper의 pathless `--listen unix://` 및 `--sock` 생략 경로를 실제 enforced profile 아래 검증한다. `/proc/*/environ` deny를 유지한 귀속 fallback/Netlink, helpers=1/unknown=0, busy/미검증 owner/ephemeral 보호 증거를 유지한다. fixture 준비의 일시적 unconfined 실행을 제품 profile 검증으로 세지 않는다.
- **기존 Stable 0.7.3 → 최종 Stable image** persistence 회귀를 synthetic volume으로 실행한다.

```sh
bash tests/update-smoke.sh ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3 <stable-candidate-image>
```

이 script 기본 old version에 의존하지 말고 0.7.3을 명시한다. synthetic `/data`·`/config`의 auth/config/AGENTS, SSH identity, browser identity/memory 및 일반 설정 marker 보존을 확인한다. 실제 인증자료·운영 config는 사용하지 않는다. 같은 repository의 일반 image update와 DEV→main source migration을 구분한다.

## 5. main 병합과 immutable 0.7.4 게시

1. 검증한 파일을 명시해 commit/push하고 **base=main** release PR을 만든다. DEV 사용자 수용, Stable 전환, 이슈 #71 수정, 검증과 잔여 미검증을 본문에 기록한다.
2. PR exact HEAD의 CI와 non-publishing Builder를 확인한다. unit/lint/App metadata, native amd64/aarch64 build/runtime smoke, SBOM/Critical gate 등 필수 job 성공 후 main에 병합한다. 필수 검사 skip/pending을 성공으로 간주하거나 bypass하지 않는다.
3. **exact main merge SHA**와 해당 SHA의 main CI 성공을 기록한다. 런타임이 DEV 검증본과 달라진 부분은 버전 표기 외에 무엇인지 설명하고 필요한 재검증을 마친다.
4. 해당 SHA에 annotated tag **`0.7.4`**를 생성·push한다. 원격 tag dereference가 의도한 SHA인지 확인한다. 임의의 이후 HEAD를 tag하지 않는다.
5. tag Builder 성공을 확인한다. 양 architecture 빌드, scan/Critical 차단, SPDX SBOM, signing/provenance/SBOM attestation, generic manifest와 최종 immutable version tag promotion을 확인한다. 기존 workflow의 signing identity·artifact 계약을 따른다.
6. 공개 exact generic/per-architecture tag를 익명 registry 자격으로 조회·pull하고 linux/amd64·linux/arm64 digest, config label/version/source/architecture를 Builder source와 대조한다. **Stable은 새 image이므로 DEV digest를 그대로 복사해 증거로 쓰지 않는다.**
7. expected repository/workflow/tag/source SHA와 exact digest에 결합해 Cosign 및 provenance/SPDX attestation을 client에서 독립 검증한다. workflow signing step 성공과 독립 검증을 각각 기록한다. 실제 workflow의 label·증명 형식을 source of truth로 사용한다.
8. 공개된 exact Stable image에서 version과 관련 runtime/profile/SSH/update smoke를 확인한다. bundled/selected/running Codex version을 구분한다. 로컬 image의 통과만으로 공개 image의 통과를 선언하지 않는다.
9. 익명 HTTP로 main의 repository.yaml/config.yaml을 확인한다. Stable 표시, version 0.7.4, stage 생략, image 경로 및 공개 image가 일치해야 한다. 실제 App Store UI를 관측하지 않았다면 그 항목은 NOT RUN으로 남긴다.
10. tag 0.7.4의 GitHub Release를 **draft=false, prerelease=false, latest=true**로 공개하고 API로 결과를 확인한다. 이는 GitHub Release의 latest 지정이며 **GHCR mutable `latest` tag는 발행하지 않는다.** Release note에 변경사항, DEV 사용자 수용, 업데이트·재연결 주의, 알려진 검증 범위를 기재한다.

DEV branch의 표시명·채널을 이 작업으로 임의 전환하거나 branch를 삭제하지 않는다. main 설치 사용자는 일반 Stable 업데이트 경로를 사용한다. `#dev` 설치가 main으로 자동 전환되거나 `/data`가 자동 이전된다고 안내하지 않는다. 사용자 장치의 실제 전환/업데이트는 이 배포 작업에서 실행하지 않는다.

## 6. 실패 대응·완료 조건과 보고

- 실패하면 source/digest/log를 조사하고 최소 수정 후 필요한 gate를 재실행한다. 미해결 CI/security/profile 문제가 있는 상태에서 tag/Release를 강행하지 않는다.
- 부분 promotion 복구는 기존 immutable artifact 정책을 따른다. 같은 run의 failed jobs 재실행 등 허용된 복구만 사용하고, 별도 run의 다른 digest 산출물을 섞거나 기존 version/tag를 덮어쓰지 않는다. 0.7.4 소비·충돌로 완료할 수 없다면 상태를 보고하고 새 버전을 임의 선택하지 않는다.
- `FIX_08_REPORT.md`를 신규 작성하고 progress를 실제 상태로 갱신한다. 최종 source/PR HEAD/main merge/tag SHA, PR·CI·Builder URL 및 job 결론, tests/skip, generic·architecture digest, 공개 익명 pull, label/runtime/persistence smoke, 독립 signature/attestation 검증, raw metadata, Release properties와 URL을 기록한다. 실패·계획 편차·미검증도 포함한다.
- 사용자 DEV 실기 수용은 **사용자 보고**로 명시한다. Executor가 관측한 image/CI 결과, 사용자 현장 검증, 수행하지 않은 물리 ARM HAOS·세부 모바일/장시간 시나리오를 혼동하지 않는다. 이미 수용한 일반 DEV 테스트를 다시 미완료로 돌리지 않는다.
- **완료는 Stable 0.7.4 공개 image와 정식 최신 Release 및 main 설치 metadata를 검증하고 공개 설치/업데이트 경로를 전달한 시점이다.** PR 작성·tag 생성·draft Release만으로 완료 처리하지 않는다.
