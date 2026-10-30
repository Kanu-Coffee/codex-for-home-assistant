# FIX_02 — resume·모바일 SSH 개선을 새 DEV로 검증·배포

작성일: 2026-10-30 (Asia/Seoul)
역할: Reviewer / 다음 실행자: 별도 Executor
상태: **READY FOR EXECUTOR — 배포 절차 발행, 실행 전**
예정 버전: **0.7.3-dev.5**

## 1. 사용자 요청과 실행 범위

사용자는 새 DEV 배포를 준비하되 현재 세션에서는 직접 실행하지 말고 FIX에 절차를 기록하라고 요청했다. 이 문서 발행자는 버전 변경·commit·push·PR·merge·tag·release·HA 설치를 실행하지 않는다. 다음 Executor가 사용자의 실행 지시를 받아 아래 절차를 수행하고 `FIX_02_REPORT.md`를 새로 작성한다.

Executor의 목표는 준비된 두 개선을 DEV 채널에 공개하고 사용자가 HAOS에서 업데이트할 수 있는 상태까지 확인하는 것이다. DEV 대상 commit/push/PR/merge/tag/image 게시와 GitHub 사전 릴리스를 절차 범위로 삼는다. Stable `main` 승격과 사용자 HAOS 설치·재시작·키 생성·운영 설정 변경은 범위 밖이다. 사용자가 나중에 범위를 바꾸면 그 지시를 따른다.

제품 권한, 공개키 전용 SSH, 민감 경로 보호, 기존 자동 업데이트 스케줄을 유지한다. 실패를 해결하기 위해 비밀번호 로그인, `admin`, Docker API, full access, host network, AppArmor 비활성화를 도입하지 않는다. 별도 agent나 세션 생성은 필요하지 않다.

## 2. 현재 상태와 읽을 자료

먼저 루트 AGENTS와 `docs/development/rules.md`, `progress.md`, 관련 product_spec/architecture/addon_spec/security/test_plan을 읽는다. 이 디렉터리의 PLAN·REPORT·FIX_01·FIX_01_REPORT를 읽되, 당시의 미완료 판정을 현재 코드 상태로 대체하지 않는다. 과거 문서는 수정하지 않는다. 이후 구축·게시·사용자 운영 확인은 progress와 Git이 기준이다. FIX_01_REPORT가 이미 있으므로 FIX_01을 반복 실행하지 않는다.

발행 시점 Git 상태:

- 브랜치: `codex/fix-resume-picker`.
- HEAD: `a95dd85` (dev.4 게시 결과 문서 커밋). 새로운 제품 수정은 **미커밋 working tree와 untracked 파일**에 있다.
- 공개 DEV 기준: `0.7.3-dev.4`, payload tag commit `c420d93f7d3d5a83785afcad5e2966369f1eb099`.
- dev.4 배포 결과 문서는 PR #63으로 DEV에 병합됐다. Executor가 fetch 후 실제 원격 HEAD와 추가 변경을 다시 확인한다.
- 현재 config, Docker BUILD_VERSION, Playwright package의 루트 버전은 아직 `0.7.3-dev.4`다. 로컬 이미지도 dev.4 label을 사용한 시험본이므로 새 릴리스의 exact-image 검증을 대신하지 않는다.
- 실제 mobile 앱 수용, 새 기능의 HAOS/custom AppArmor/native ARM 수용은 아직 완료하지 않았다. 기존 dev.4 자동 업데이트 정상 확인은 사용자가 제공한 운영 증거다.

## 3. 배포에 반드시 포함할 변경

### A. resume 선택 후 shell 복귀 수정

`codex-session-host.mjs`의 관리형 TUI 연결 수명과 재초기화 처리를 포함한다. 세션 picker가 연결을 교체해도 host를 종료하지 않고 소유 frontend process 종료까지 유지한다. 호환 capabilities와 미완료 RPC가 없는 경우에만 초기화 응답을 재사용한다. 초기화 실패 후 요청 우회와 이전 socket close가 새 연결 상태를 지우는 경우를 차단한다. 외부 WebSocket의 기존 종료 계약은 유지한다.

회귀는 `tests/test_codex_update_fix03.py`, 실제 picker→Enter→복원→같은 대화 후속 응답은 `tests/test_codex_live_handover.py`의 `tui_resume`에 있다. 종료만 막으면 `Already initialized`가 발생하므로 두 부분을 함께 배포한다.

### B. 모바일 SSH 간편 설정

아래 **untracked 신규 파일을 빠뜨리지 않는다**.

- `codex_home_assistant/rootfs/usr/local/bin/ha-codex-remote`
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs`
- `tests/test_remote_setup.py`
- `tests/mobile-ssh-smoke.py`

명령은 `setup`, `show --format pkcs8|sec1`, `status`, `revoke`다. P-256 전용 키와 자동 공개키 등록, 동일 키의 PKCS#8/SEC1 전환, 기존 키 재사용, 폐기를 제공한다. `/data/ssh/mobile`은 디렉터리 0700·파일 0600이며 wrapper flock으로 작업을 직렬화한다. 일반 구성 authorized_keys와 별도 파일을 사용하고 init sync 시 두 출처의 공개키를 합산한다. 양쪽에 키가 없을 때만 SSH를 비활성화한다. 이전 비활성 상태에는 S6 시작을 요청하고 실패하면 App 재시작을 안내한다.

연관된 sshd_config, codex-ha-init, Dockerfile, CI native 양쪽의 mobile smoke, 한국어·영어 README/DOCS, changelog, 개발 문서 변경도 함께 포함한다. 실제 파일 목록은 `git diff --name-only`와 `git ls-files --others --exclude-standard`로 다시 확인한다.

이 기능은 모바일 클라이언트 자체 파서 오류를 해결하지 않는다. 유효 PEM 거부 [#52417](https://github.com/openai/codex/issues/52417)와 키 수락 후 호스트 인증서 협상 실패 [#38264](https://github.com/openai/codex/issues/38264)를 구분해 문서·릴리스 노트에 남긴다. 실사용 키나 auth를 테스트에 사용하지 않는다. 키 표시를 확인하는 시험에서도 개인키·terminal 캡처를 보고서나 로그에 출력하지 않는다.

## 4. 단계 1 — 작업 보존·원격 상태·버전 확정

1. `git status --short --branch`, `git diff`, 신규 파일, remote와 GitHub 인증 상태를 확인한다. 다른 작업자 변경이 있으면 소유 범위를 구분한다. `reset --hard`, `clean`, 기존 변경 삭제나 과거 handoff 덮어쓰기를 사용하지 않는다.
2. `git fetch origin`으로 DEV 최신 상태를 확인한다. 미커밋 작업이 있는 상태에서 무리하게 branch 전환·merge하지 않는다. 명시적 파일 목록으로 로컬 체크포인트 커밋을 만든 뒤 필요하면 최신 `origin/dev`를 병합한다. 충돌은 의도와 현재 제품 코드를 대조해 해결하고 회귀를 재실행한다.
3. 원격 Git tag, GitHub release, GHCR image에 `0.7.3-dev.5`가 이미 있는지 확인한다. 이미 할당된 버전을 덮어쓰지 않는다. 사용자가 특정 버전을 고정하지 않았으므로 충돌 시 같은 `0.7.3-dev.N` 계열의 다음 미할당 번호를 선정하고 근거를 보고한다. 이 문서의 dev.5 절차를 확정 버전으로 치환한다.
4. 최신 Home Assistant App 설정·Codex 관련 공식 문서를 다시 확인한다. upstream 이슈 상태가 바뀌었으면 문구를 갱신하되 모바일 수용을 추정해서 PASS로 바꾸지 않는다.

## 5. 단계 2 — 릴리스 메타데이터와 문서 정리

다음 버전을 `0.7.3-dev.5` 또는 확정 버전으로 일치시킨다.

- `codex_home_assistant/config.yaml`의 version.
- Dockerfile의 기본 `ARG BUILD_VERSION`.
- `playwright/package.json` 루트 version과 `package-lock.json` 루트·packages[""] version. 의존성 버전을 불필요하게 갱신하지 않는다.
- CHANGELOG의 `Pending` 변경을 최신 `[버전] - 실제 날짜` 항목으로 옮긴다. 과거 dev.4 기록을 새 릴리스로 덮어쓰지 않는다.
- 한국어·영어 루트/App README·DOCS의 현재 버전과 “다음 배포/로컬 구현/dev.4에는 미포함” 안내를 새 버전 기준으로 정리한다. 게시 전에는 준비 완료로 표현하고, 공개 성공은 실제 결과를 확인한 뒤 기록한다.
- `docs/development/progress.md` 상단의 DEV 현재 작업 상태·지원 경계와 `runtime-handover.md`를 검토한다. “현재 공개 DEV는 dev.4” 같은 시점 의존 문구를 그대로 남기지 않는다.

App 이름 `Codex for Home Assistant (DEV)`, panel `Codex DEV`, `stage: experimental`, DEV repository metadata, MOTD·OCI labels를 유지한다. Bundled Codex `0.162.1`과 기존 updater 정책은 이번 배포 때문에 변경하지 않는다. 사용자 운영 selected version `0.166.0`을 App version이나 bundled version으로 혼동하지 않는다.

## 6. 단계 3 — 최종 소스·이미지 검증

발행 전 세션의 증거는 재현 참고이며 새 버전·최종 commit의 PASS를 대체하지 않는다.

| 기존 증거 | 결과 | 한계 |
| --- | --- | --- |
| `.test-tmp/remote-full-suite.log` | 299 passed, 6 skipped / 110.04초 | 버전 확정 전 소스 |
| `.test-tmp/r166.log`, `r166final.log` | 실제 공식 binary handover 4 passed, 최종 resume 1 passed | mock provider, 임시 HOME |
| `.test-tmp/remote-ssh-smoke-final.log` | 두 PEM 실제 SSH 인증, revoke 거부, S6 활성화·재시작 후 SSH PASS | 로컬 amd64, HAOS/custom profile 아님 |
| `.test-tmp/remote-build-final.log` | 로컬 amd64 image build PASS | dev.4 label 시험본 |

실행 예시:

```bash
.venv/bin/pytest -q
node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs
node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs
shellcheck codex_home_assistant/rootfs/usr/local/bin/ha-codex-remote codex_home_assistant/rootfs/usr/local/bin/codex-ha-init
hadolint codex_home_assistant/Dockerfile
actionlint .github/workflows/ci.yaml
docker build --build-arg BUILD_VERSION=0.7.3-dev.5 -t codex-ha:0.7.3-dev.5-test codex_home_assistant
python3 tests/mobile-ssh-smoke.py codex-ha:0.7.3-dev.5-test
git diff --check
```

- 확정 버전이 다르면 명령도 맞춘다. 도구가 없으면 기존 프로젝트 대체 수단을 사용한다. 새 전역 의존성을 무단 설치하지 않는다.
- YAML/변경 Markdown lint와 변경·신규 파일 secret scan도 수행한다. 기존 Markdown CLI는 config의 전체 glob을 추가하므로 `.test-tmp`/node_modules를 대량 스캔하지 않게 범위를 명시하거나 동일 config의 library lint를 사용한다. 테스트에 필요한 node_modules를 삭제한 채 실제 transport 시험을 실행하지 않는다.
- 라이브 통합 시험은 공식 checksum 검증한 패키지와 임시 HOME으로 실행한다. `CODEX_HANDOVER_BASELINE`, `CODEX_HANDOVER_CANDIDATE`에 `bin/codex` 절대 경로를 지정하고 `tests/test_codex_live_handover.py` 4 transport를 실행한다. 로컬 후보 경로 참고: `.test-tmp/task007-baseline/bin/codex`, `.test-tmp/resume-166/package/bin/codex`. 없으면 공식 배포본을 검증해 확보한다. 패키지 시험 복사본의 소유권·권한을 맞추고 Unix socket 경로는 짧게 유지한다. 시험 fixture를 고치기 위해 제품 무결성 검증을 약화하지 않는다.
- mobile smoke는 Docker의 임시 volume/container에서 키를 생성한다. 출력 억제를 유지하며 실패 시 비밀키가 포함될 수 있는 PTY 원문을 공개하지 않는다. 일반 root shell의 권한을 제품 sandbox 완화로 오해하지 않는다.
- `sshd -t`, 키 0600/0700, 키 재사용·형식 일치·revoke·재시작 보존, 미설정 SSH 비활성, 기존 구성 키 공존을 확인한다. 실제 custom AppArmor의 helper·sshd 사용도 native CI smoke와 필요 시 격리 시험으로 확인한다. 불가하면 정확히 NOT RUN으로 남긴다.

## 7. 단계 4 — DEV PR·CI·merge

1. 최종 diff를 검토하고 신규 4개 파일까지 포함해 커밋한다. `.test-tmp`, 개인키, auth, 실제 HA 데이터는 커밋하지 않는다.
2. 작업 브랜치를 push하고 **base `dev`** PR을 생성한다. PR에는 resume 원인/수정, 새 명령, 검증 범위와 모바일 파서 한계·실기 NOT RUN을 기록한다. 다중행 본문은 파일로 작성하고 `gh ... --body-file`로 전달한다.
3. PR CI와 비게시 Builder를 **끝까지 기다린다**. App config, lint/unit, native amd64/aarch64 build/full smoke와 새 mobile smoke, 양쪽 이미지 비게시 빌드를 확인한다. UI의 merge 가능 여부만 보고 진행 중인 checks를 건너뛰지 않는다. `--admin`/검사 우회는 사용하지 않는다.
4. 실패하면 원인을 해결하고 영향을 받는 검사를 재실행한다. native ARM 빌드 실패를 amd64 성공으로 대체하거나 실패 상태에서 플랫폼 선언을 몰래 줄이지 않는다.
5. 검사가 성공한 exact PR HEAD를 DEV에 병합한다. 최종 merge SHA를 기록하고 해당 SHA의 DEV push CI도 성공한 뒤 tag 단계로 진행한다. merge 이후 다른 변경이 들어왔어도 임의 최신 HEAD를 tag하지 않는다.

## 8. 단계 5 — immutable tag·게시·독립 확인

1. 선택한 DEV merge SHA에 버전 annotated tag를 만들고 해당 tag만 push한다. 기존 tag를 강제로 이동하지 않는다. `git ls-remote`의 tag dereference가 의도한 SHA인지 검증한다.
2. tag push가 실행한 Builder 전체를 기다린다. 현재 workflow는 PR에서 비게시 build, tag push에서 게시한다. amd64/aarch64 build와 검사, 취약점 gate, multiarch manifest, signing/attestation, 최종 version tag promotion이 성공했는지 확인한다. 완료 전 GitHub release로 성공을 먼저 선언하지 않는다.
3. GHCR의 버전 tag를 **익명 자격**으로 조회한다. 짧은 anonymous registry bearer token은 명령 출력·보고서에 남기지 않는다. manifest digest와 linux/amd64·linux/arm64 하위 digest, 이미지 label의 App version을 기록한다. GitHub UI만 보거나 로컬 로그인 상태에서 pull 성공한 것을 공개 접근 증거로 삼지 않는다.
4. workflow 결과와 별개로 가능한 공식 도구로 exact digest의 signature/provenance·SPDX attestation을 검증한다. expected repository/workflow/source tag·SHA/identity를 확인한다. 도구가 불가하면 수행한 workflow 검증과 미수행 독립 검증을 구분한다. 임의로 “서명 독립 검증 PASS”라고 기록하지 않는다.
5. 익명 HTTP로 DEV의 `repository.yaml`, `codex_home_assistant/config.yaml`에 접근해 DEV 이름·새 버전·image를 확인한다. 필요하면 exact 공개 이미지로 version·새 명령·sshd 설정·mobile smoke를 재확인한다.
6. 기존 exact tag를 사용해 **prerelease이며 draft가 아닌** GitHub release를 만든다. 명시적으로 DEV target을 설정하고 Stable latest로 지정하지 않는다. 릴리스 노트에 사용법과 검증 공백을 기재한다.
7. `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev` 설치 경로를 보고한다. 실제 사용자 장치에서 App Store 새 버전 노출이나 업데이트를 보지 못했다면 “장치 업데이트 완료”라고 표현하지 않는다. 원격 HAOS를 임의로 조작하지 않는다.

## 9. 실패·되돌림 원칙

- PR 단계 실패는 feature branch에서 수정한다. 게시 전 CI 실패를 release로 우회하지 않는다.
- tag 게시 중 일부 단계가 실패하면 digest·공개 상태를 먼저 조사한다. 동일 SHA의 같은 workflow 재실행은 기존 workflow의 immutable-tag 검증을 유지한 채 수행할 수 있다. 소스 수정이 필요하면 새 DEV 번호로 진행한다. 기존 버전 tag/image를 다른 내용으로 덮어쓰지 않는다.
- 게시 후 중대 결함은 새 DEV 수정/되돌림 버전과 명확한 노트로 처리한다. Stable/main을 자동 변경하지 않는다. `/data`를 삭제하지 않으며 rollback으로 이미 실행한 migration이 되돌아간다고 보장하지 않는다.
- 전체 검사 실패, 공급망 검증 오류, 실제 보호 정책 회귀, image 공개 불가 상태를 성공 보고로 덮지 않는다. 실패 단계·원인·가능한 다음 조치를 보고한다. 키 파서의 upstream 한계는 별도로 명시하며 비밀번호 SSH로 우회하지 않는다.

## 10. Executor 보고와 완료 기준

다음 내용을 포함하는 `FIX_02_REPORT.md`를 새로 작성하고 progress를 갱신한다. 기존 handoff 문서는 보존한다.

- 확정 App version, 코드 commit, PR URL, DEV merge SHA, immutable tag의 dereference SHA.
- 실행한 명령과 실제 결과, 최종 source/label을 사용한 로컬 검증과 CI/Builder URL·결론.
- 익명 registry/DEV source 검증, multiarch·하위 image digest, label, 독립 signature/attestation 검증 여부.
- prerelease URL 및 draft/prerelease/latest 상태, DEV 설치 경로.
- 최종 릴리스 노트/문서가 게시 상태와 일치하는지, 문서 갱신용 추가 PR이 있다면 그 결과.
- HAOS/mobile/custom AppArmor/native ARM의 PASS/PARTIAL/NOT RUN 범위를 정확히 구분한다. CI native ARM 성공을 실제 ARM HAOS 성공으로 바꾸지 않는다.
- 사용자 인계: `ha-codex-remote setup`, 거절 시 `show --format sec1`, `status`, `revoke`; 실제 모바일 오류가 남으면 앱 버전·정제된 오류만 요청하고 키는 요청하지 않는다.

완료는 **새 DEV 버전의 검사 통과·immutable image 게시·익명 접근·DEV source 새 버전·GitHub prerelease·정확한 보고**를 충족한 상태다. 사용자 장치 설치나 모바일 앱 parser 수용을 완료 조건으로 거짓 표시하지 않는다. 문서만 작성하거나 PR만 열고 공개 DEV 배포 완료로 보고하지 않는다.
