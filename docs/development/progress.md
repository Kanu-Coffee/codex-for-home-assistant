# progress.md — 현재 상태와 할 일

> 이 파일은 프로젝트 상태의 유일한 기준이다. 에이전트는 모든 작업의 시작과 끝에 갱신한다.

## Project Status

- 상태: **amd64 MVP/M2 PASS / public 0.6.0 정확 이미지 전체 회귀 PASS / 실제 HAOS feedback live NOT RUN / 실제 HAOS `never` 14/16 승인 0회 PASS·전체 승인 행렬 PARTIAL / public 0.3.2 memory live PARTIAL(FAIL 0) / 0.5.0 자연어 memory live 수용 대기**
- 현재 마일스톤: **0.6.0 tag·GHCR·prerelease 완료 / 실제 HAOS feedback·memory 수용 대기**
- 마지막 문서 기준일: **2026-07-16**
- 저장소: public `Kanu-Coffee/codex-for-home-assistant`, default branch `main`

## 완료된 결정

- [x] Home Assistant App(구 Add-on) 형태로 개발
- [x] Codex CLI + Ingress 웹 터미널 + SSH/Remote SSH 동시 제공
- [x] `/config` 전체 RW 매핑
- [x] `homeassistant_api: true`
- [x] `hassio_api: true`, `hassio_role: manager`
- [x] 실제 서비스 호출 및 기기 테스트 허용
- [x] `admin`, Docker API, host network, full access는 사용하지 않음
- [x] Codex/SSH 인증 데이터를 `/data`에 영속화
- [x] SSH 외부 포트는 App Network 설정에서 변경
- [x] 문서 주도 개발 파일 세트 작성

## Current Work

### 2026-07-16 — HAOS Codex feedback automation 0.6.0

- 목표: HAOS 안의 Codex가 앱 버그와 기능 제안을 읽기 전용으로 조사하고, 허용된 환경 정보만 포함한 정제 보고서를 생성한 뒤 사용자의 최종 확인을 거쳐 공식 GitHub 저장소로 제출하거나 Issue Form으로 안전하게 폴백하게 한다.
- 범위: image-managed admin Skill `$ha-feedback`의 `bug`/`feature` 모드, `/usr/local/bin/ha-feedback` Node helper, Markdown/JSON 보고서와 privacy validation, opt-in `gh` 인증·제출, 한·영 preset·지원 문서, Issue Forms, runtime AGENTS/system routing, pinned GitHub CLI와 0.6.0 버전 계약을 포함한다.
- 안전 경계: 진단 중 Home Assistant 설정 수정, 서비스 호출, 재시작, 업데이트, 복구와 외부 제출을 자동 실행하지 않는다. 공개 보고서는 allowlist 환경만 사용하고 token/cookie/key/auth/storage/database/backup/URL/IP/사용자·entity·device·area 식별자와 control sequence를 fail closed로 차단한다. 보안 취약점은 공개 이슈 제출을 중단한다.
- 제출 경계: 대상은 `Kanu-Coffee/codex-for-home-assistant`로 고정한다. 인증된 사용자는 최종 제목·본문·라벨 미리보기와 확인 뒤 `gh`로 제출하고, 미인증 또는 실패 시 긴 본문을 URL에 싣지 않는 Issue Form과 복사용 `public-report.md`를 제공한다. 실제 GitHub 테스트 이슈는 별도 승인 없이는 생성하지 않는다.
- 검증 계획: Skill 정적/명시 호출, bug·feature fixture schema/render/status 경계, malicious fixture redaction/fail-closed, fake `gh` 인증·거절·성공·실패·중복·고정 repo/label, path/symlink/permission, Docker package/persistence와 public 0.5.0 update 보존 회귀를 자동화한다. HAOS live 제출은 **NOT RUN**으로 분리한다.
- [x] Skill·문서·runtime routing을 구현했다.
- [x] helper·GitHub CLI·Issue Forms와 0.6.0 packaging을 구현했다.
- [x] 자동 회귀와 Docker/update smoke를 실행하고 미검증 경계를 기록했다.
- 검증 결과: pytest **68 passed / 8 environment-dependent skipped**, Skill validator, YAML·Markdown 38 files, ShellCheck, Hadolint와 `git diff --check`가 PASS했다. Local Docker image index `sha256:9adf3fb63a78e2e6ca3410b0c28ad9ff5478392723741106acd44807734cb86f`에서 GitHub CLI 2.93.0·feedback helper, 전체 browser/gateway/Core WebSocket/ttyd/SSH, browser approval, memory, managed auth, user-file와 public `0.5.0` → local `0.6.0` update smoke가 모두 PASS했다.
- 공개 릴리스: [PR #33](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/33)을 merge commit `8404f8e61394021d0acb08a67a021cf2ca641f3b`로 병합했고, 같은 SHA의 [main CI 29498705500](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29498705500)이 PASS했다. Annotated `0.6.0` tag를 `2026-07-16T12:39:01Z`에 게시하고 [Builder 29498965561](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29498965561)로 generic/per-arch GHCR 이미지를 발행한 뒤 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.6.0)를 `2026-07-16T12:51:51Z`에 공개했다.
- 공개 이미지 증거: generic과 amd64 OCI index digest는 `sha256:5c8dd2c1a1f96c9a994178b6077d82a7ab582d946ee95bdb61575587292ed845`, linux/amd64 runtime manifest digest는 `sha256:4c4efdf797a77393f6ac2ab85d41f404b86171665c3bf583ff33943cd3708911`이다. 빈 Docker credential로 manifest 조회·pull, version/arch/source label, mutable `latest` 부재를 확인했고, 정확한 공개 이미지에서 feedback, 전체 browser/gateway/Core WebSocket/ttyd/SSH, browser approval, memory, managed auth, user-file와 public `0.5.0` → public `0.6.0` update smoke가 모두 PASS했다. 저장소 Private vulnerability reporting도 활성 상태를 확인했다.
- 미검증 경계: 실제 GitHub 이슈 생성과 실제 HAOS 설치 환경의 자연어 Skill 실행·진단·제출 흐름은 별도 명시 승인과 live 수용 전까지 **NOT RUN**이다. 자동 검증은 fake `gh`와 격리 container만 사용했으며 외부 이슈를 생성하지 않았다.

### 2026-07-16 — ChatGPT mobile Remote 직접 SSH 문서 정정

- 원인: 일반적인 desktop-host Remote 안내를 이 HA App의 실제 경로에 잘못 적용해 Mac/Windows desktop app이 SSH 중계에 필요하다고 문서화했다.
- 런타임 재확인: App 이미지가 OpenSSH와 Codex CLI를 함께 제공하고, mobile Remote가 `HA host:2223`에 공개키 SSH로 직접 연결해 login shell의 내장 `codex` app-server를 bootstrap한 뒤 `/config`를 연다.
- 정정 범위: 한·영 root/App README와 DOCS, architecture/product/security/test/reference 문서, 과거 운영 가이드와 검증 기록의 desktop 중개 전제를 제거한다.
- 경계: 일반 SSH client는 `/config` Bash를 열어 `ha-codex` 또는 `codex`를 수동 실행한다. Web UI의 공유 tmux와 mobile Remote app-server 세션은 기본적으로 별개다.
- 검증: 중개형 문구 전체 검색 결과 0건, local Markdown link/anchor, markdownlint 33 files/0 errors, pytest **57 passed / 8 jq-dependent skipped**, yamllint와 `git diff --check` PASS.

### 2026-07-16 — 사용자 중심 문서·저장소 정리

- 목표: GitHub와 Home Assistant App 표면을 개발 증거 중심 문서에서 HAOS 사용자 중심의 설치·활용·설정·보안 가이드로 재구성하고, 런타임 동작을 바꾸지 않은 채 개발 잔여물을 정리한다.
- 사전 감사: `origin/main` `2291455`, 추적 파일 131개와 두 registered worktree를 확인했다. Docker image에는 `rootfs/`와 Playwright package만 복사됨을 재확인하고 `rootfs`, Dockerfile, `config.yaml`, 번역, workflow, active runtime/contract test를 변경 범위에서 제외했다. 모든 추적 test/fixture는 CI 또는 smoke에 연결되어 있었고, 실제 로컬 잔여물은 ignored `.pytest_cache`와 `tests/__pycache__`뿐이었다.
- 사용자 문서: 한국어 기본 `README.md`, App `README.md`와 `DOCS.md`를 서비스·활용 사례 중심으로 다시 작성하고 `README.en.md`, App `README.en.md`, `DOCS.en.md`, 한·영 prompt cookbook을 추가했다. 옵션의 실제 기본값, Ingress terminal 경계, Bubble Card 미포함, mobile Remote의 직접 SSH 구조, custom `ha_memory`와 OpenAI Memories의 구분, 실제 HAOS memory 수용 공백을 구현과 일치시켰다.
- 운영 표면: `SUPPORT.md`, `.github/SECURITY.md`, `CONTRIBUTING.md`, 현재 workflow 기반 release guide와 문서 index를 추가했다. Public `0.5.0` image의 실제 ttyd/tmux 화면을 비밀 없는 격리 Docker에서 desktop/mobile로 캡처했으며, Home Assistant Ingress frame이 없는 preview라는 경계를 caption과 asset 문서에 기록했다.
- 개발 기록: 활성 계약·ADR·증거 문서를 `docs/development/`, 초기 master prompt·구현/Git 계획과 과거 `0.4.0` 운영 문서를 `docs/archive/`로 이동하고 archive warning을 추가했다. 루트 문서 14개 hash를 중복 강제하던 `MANIFEST.md`와 전용 `tests/test_manifest.py`는 제거했다. Git이 blob 무결성을 제공하고 모든 Markdown에 lint·link 검증을 적용하므로 앱 runtime/기능 test는 유지하면서 문서 수정의 불필요한 checksum 결합만 없앴다.
- 검증: 로컬 Markdown/HTML 상대 link와 heading anchor 33개 파일 전부 해석, markdownlint 33 files/0 errors, pytest **57 passed / 8 jq-dependent skipped**, `python -m yamllint`, secret scan 포함 계약 test와 `git diff --check`가 PASS했다. runtime/packaging 파일이 변경되지 않아 image rebuild와 container smoke는 실행하지 않았다.
- [x] 사용자 랜딩·설치·설정·예시·지원·보안 문서를 한·영으로 제공한다.
- [x] 개발·과거 기록을 분리하고 실제 CI test와 runtime file을 보존한다.
- [x] 과장 없이 Web UI, Remote, dashboard/automation, browser와 memory 기능 경계를 설명한다.
- [x] 실제 비밀 없는 desktop/mobile Web terminal preview와 provenance를 제공한다.

### 2026-07-16 — public 0.4.0 실제 HAOS Playwright `never` 정책 수용 결과

- 입력 증거: 사용자가 제공한 정제 보고서는 `2026-07-15T23:56:06Z`부터 `23:59:25Z`까지 public `0.4.0`의 관리형 자동 인증 `http://127.0.0.1:8099/` dashboard에서 비파괴 browser 동작을 실행했다. 실제 dashboard 이름·검색어·screenshot artifact는 저장소에 반입하지 않고 판정과 비식별 오류만 기록한다.
- 판정: **실행 완료 / PASS (검증된 `never` 범위)**. `navigate`, `tabs`, `resize`, `snapshot`, `take_screenshot`, `console_messages`, `network_requests`, `hover`, `wait_for`, `click`, `type`, `press_key`, `fill_form`, `navigate_back` 14개는 MCP 승인 요청 0회로 성공했다. `select_option`은 안전한 비변경형 대상이 없어 **NOT TESTED**, 보고서에 실행 기록이 없는 `close`도 **NOT TESTED**다.
- 렌더링·진단: desktop `1440x900`과 mobile `390x844`, 자동 인증, 검색 대화상자의 비파괴 click/type/form/key 경로가 동작했다. 사용자 지정 screenshot `filename`은 enforcement proxy가 `-32602`로 거부했고 인자 제거 후 성공했으므로 승인 실패가 아니라 의도된 artifact 경계로 판정한다. Dashboard의 legacy Bubble Card module YAML 404와 대응 console warning/error 1쌍은 남았지만 browser renderer나 `never` approval 실패로 확대하지 않는다.
- 증거 경계: 전체 E2E-019는 **PARTIAL**이다. `safe`, `always`, top-level `codex_approval_policy=never` precedence, `select_option`, `close`, 금지 도구 거부, Configuration UI option 표시/default, live App update, AppArmor 활성 여부와 사용자 config/AGENTS/browser identity 보존은 이번 보고서에서 검증하지 않았다.
- 검증 계획: README/App 문서/changelog, ADR-036, Phase 9, security와 E2E-019의 오래된 전체 `NOT RUN` 문구를 위 부분 실기 결과로 교정한다. Markdown/YAML, manifest, secret scan, pytest와 `git diff --check`를 실행하고 runtime code/image/version은 변경하지 않는다.
- [x] README/App 문서/changelog, ADR-036, Phase 9, security와 E2E-019에서 `never` 실행 완료·14/16 승인 0회 PASS와 잔여 NOT TESTED/NOT RUN 항목을 일치시켰다.
- [x] Windows Python 3.14에서 pytest **58 passed / 8 jq-dependent skipped**, YAML lint, Markdown 20 files/0 errors, manifest·secret scan과 `git diff --check`가 PASS했다. Runtime file을 바꾸지 않아 local image rebuild는 생략하고 PR Linux CI의 jq/App linter/full image smoke를 최종 회귀로 사용한다.
- [x] `never` 수용 증거 commit `9e72c22e007f9c45119d187830d5f222d53621c7`을 draft [PR #28](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/28)에 push했다. [CI 29460824707](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29460824707)의 Linux jq 포함 lint/unit, App linter, amd64 full browser approval/memory/managed-auth/user-file/public `0.3.2` update smoke와 non-publishing [Builder 29460824933](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29460824933)이 PASS했다.

### 2026-07-16 — public 0.3.2 실제 HAOS memory 재시험 증거 반영

- 입력 증거: `codex-for-home-assistant-0.3.2-live-self-audit-2026-07-15.md`는 실제 HAOS App `0.3.2`, Core `2026.7.2`, Supervisor `2026.07.3`에서 실행한 정제된 자기점검 보고서다. 실제 identifier, state, credential, raw WebSocket/config/log는 저장소에 반입하지 않는다.
- 결과: 최종 판정은 **PARTIAL, FAIL 0**이다. 실제로 재현된 automation related `unknown_error` 2/30은 config 2/2, config-derived relation 4/4와 다른 automation 28/28을 보존한 bounded warning으로 격리됐다. forced refresh/fresh revision, DB atomicity·WAL/FTS5, 실제 CLI/MCP, privacy, candidate lifecycle, restart 요청 후 fresh sync와 App restart persistence는 PASS했다.
- 증거 경계: 선택한 immutable App payload 8개는 tag와 SHA-256이 일치했지만 Supervisor App info가 실제 OCI image ref/digest를 제공하지 않아 runtime manifest 확인은 NOT RUN이고, 보고서의 설치 전체/public image byte identity 항목은 PARTIAL이다. Core restart 요청 수락, daemon 생존과 요청 후 forced fresh sync는 PASS했지만 probe에 Core 단절이나 failed refresh가 없어 disconnect/reconnect와 LKG `stale/degraded` 순간은 NOT OBSERVED다. `config:null`도 NOT OBSERVED, 운영 오류 주입과 version-tagged `0.3.1 → 0.3.2` update 검증은 NOT RUN이다.
- 개선 판단: 현재 `main`의 memory core/client/CLI/MCP/daemon은 `0.3.2` tag와 동일하고 보고서에 기능 실패가 없으므로 런타임 코드를 바꾸지 않는다. Docker API/추가 권한, 운영 장애 주입, downgrade도 도입하지 않는다. 대신 오래된 `0.3.2 live NOT RUN` 문서를 실제 결과로 교정하고, Core restart 중 stale/degraded 수용 기준은 실제 failed refresh가 관측된 경우로 조건화하며 immutable App payload 검사와 Supervisor/host runtime manifest 증거를 분리한다.
- 검증 계획: 문서 간 판정·용어·버전 경계를 대조하고 Markdown/YAML, manifest, secret scan, pytest와 `git diff --check`를 실행한다. 이 memory 증거를 `0.4.0` browser approval 실기 근거로 사용하지 않고 별도 `never` 보고서와 분리하며, 실제 device control/update PASS로 확대하지 않는다.
- [x] README/App 문서/changelog, architecture/addon/security/decision/implementation/test 계약과 M2 상태에서 오래된 `0.3.2 live NOT RUN` 표현을 실제 PARTIAL(FAIL 0) 결과로 교정했다. 선택한 immutable App payload와 actual runtime manifest 증거를 분리하고 `docker_api`/host access 금지를 유지했다.
- [x] Core restart 증거는 요청 수락·daemon process 생존·요청 후 forced fresh sync PASS와 disconnect/reconnect·LKG 상태 NOT OBSERVED로 분리했다. 독립 diff 검토에서 수치·판정·privacy·0.4.0 증거 경계를 다시 확인했다.
- [x] Windows Python 3.14에서 pytest **58 passed / 8 jq-dependent skipped**, YAML lint, Markdown 20 files/0 errors, manifest·secret scan과 `git diff --check`가 PASS했다. 런타임 파일을 바꾸지 않아 local image rebuild는 생략하고 PR Linux CI의 jq/App linter/full image smoke를 최종 회귀로 사용한다.
- [x] 증거 commit `1117b688522b1e645fa2633e67e266cd1e3e3e77`을 `agent/record-0.3.2-live-audit`에 push하고 draft [PR #28](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/28)을 열었다. PR [CI 29460043342](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29460043342)의 Linux jq 포함 lint/unit, App linter, amd64 full browser/memory/managed-auth/user-file/public `0.3.2` update smoke와 non-publishing [Builder 29460043413](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29460043413)이 PASS했다.

### 2026-07-16 — 지속 개선형 HA 메모리 사용자 흐름 재감사와 보완

- 목표 재감사: 0.4.0의 catalog, candidate authority, bounded search, fresh change verification, audit/conflict/rollback 엔진은 구현돼 있었으나 실제 사용자가 체감하는 자연어 대화 폐루프는 지침과 다중 MCP 호출에 의존했다. 특히 빈 `/data`의 daemon 첫 bootstrap, 명시 사실의 같은 요청 내 반영과 후보 후속 관리가 자동 증거에서 비어 있어 사용자 목표 기준 **PARTIAL**이었다.
- 사용자 흐름 개선: 명시적이고 비민감하며 지속적인 별칭·용도·선호·note·사용자 의미 관계는 한 MCP/CLI 호출로 받되 내부적으로 기존 `pending → verified → applied` 감사 이벤트를 모두 보존한다. 시간·불확실성 표현, transient/inference, 임의 `home:*`과 HA canonical 관계는 이 경로로 적용하지 않는다. 같은 권위의 기존 값과 충돌하면 자동 덮어쓰기 없이 conflict로 남기며 같은 correction 재시도는 기존 candidate/conflict를 반환해 중복을 만들지 않는다.
- 지속 변경 경계: 지속 HA 설정·registry·automation 변경은 지원되는 closed expectation으로 변경 전에 기록하고 변경/reload 뒤 fresh Core API로 검증한다. 단순 조회·진단·catalog refresh와 일시적 device service 시험은 제외한다. Expectation으로 표현할 수 없거나 memory가 unavailable이면 semantic memory를 갱신하지 않고 검증 불가를 사용자에게 밝힌 뒤 진행 여부를 확인한다. 현재 schema는 automation trigger/condition/action/template logic 자체를 표현하지 못하므로 `exists`/`name`으로 대체 검증하지 않으며 실제 logic 변경은 live acceptance까지 **PARTIAL**로 남긴다.
- 운영 지침: 모든 HA 요청의 bounded search, `empty/stale/degraded` 상태 고지, entity별 데이터의 AGENTS 계열 파일 비누적, 새로 배운 내용·검증 결과·미반영 conflict의 짧은 사용자 보고를 system developer instruction과 기본 AGENTS에 고정한다.
- CI 동시성 보완: draft PR의 첫 [CI 29462828043](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29462828043)은 build와 일반/browser smoke 뒤 빈 store daemon refresh와 즉시 `status`가 겹쳐 정상 FTS5 store를 `database_corrupt`로 오판한 한 건을 검출했다. Read-only preflight와 journal 설정에 5초 timeout을 적용하고, 검사 중 `data_version`이 바뀐 exact `search_fts` 범위 FTS5 진단만 bounded retry하며 안정된 일반/FTS5 손상은 계속 fail closed한다. 새/빈 schema 검사는 immediate transaction으로 직렬화한다. 동시에 재현한 WAL/SHM 보조 파일 검사 중 정상 소멸은 해당 ephemeral 파일에만 허용하고, 남아 있는 unsafe 보조 파일과 DB 본체는 계속 fail closed한다. Daemon은 local DB code를 원문 없이 구분한다.
- 자동 검증: Node/SQLite memory 10/10에는 독점 lock 대기, continuous FTS5 writer와 10회 open/status, deterministic SHM 소멸, 8 worker·320회 동시 open/status/close, non-SQLite 및 stable FTS5 corruption read-only 거부가 포함된다. Python 전체 58 PASS·8 environment skip, YAML·Markdown 20 files·ShellCheck·Hadolint와 `git diff --check` PASS. 새 amd64 image의 Docker/Playwright/ttyd/Core WebSocket smoke, browser approval, 빈 store memory daemon bootstrap·MCP remember/list/reject·새 MCP process recall·container replacement persistence, managed browser auth, user-file preserve와 public 0.4.0→0.5.0 update smoke가 모두 PASS했다.
- [x] 최종 local linux/amd64 image `sha256:7ee3db691a05ccc7a50812893481701224383ae5493a83a6789c2026955ac619`는 530,883,418 bytes, `io.hass.version=0.5.0`, `io.hass.arch=amd64`, Codex `0.144.1`, Node `24.17.0`이다. CI와 같은 6종 container smoke를 이 exact candidate에서 모두 통과했다.
- [x] 명시적 사용자 사실의 결합 remember 경로와 bounded candidate list/reject MCP를 구현했다.
- [x] 지속 변경·상태 고지·CLI fallback·AGENTS 비누적 지침과 계약 문서를 일치시켰다.
- [x] source/installed image/container 회귀와 fresh bootstrap·새 MCP recall 증거를 통과했다.
- [x] [PR #29](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/29)을 merge commit `110edf3aba42c5f33c011d75e9d05e4dd05b50f1`로 `main`에 병합했다. PR [CI 29465182662](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29465182662), non-publishing [Builder 29465182788](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29465182788)와 같은 merge SHA의 [main CI 29465342591](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29465342591)이 모두 PASS했다.
- [x] merge SHA에 annotated `0.5.0` tag를 `2026-07-16T01:59:38Z`에 게시하고 공식 [Builder 29465483772](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29465483772)로 generic/per-arch GHCR image를 발행했다. 공개 image 검증 뒤 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.5.0)를 `2026-07-16T02:13:17Z`에 공개했다. 두 OCI index digest는 `sha256:193cfc7a7b678660b99f7017b6ac0f4261af59ba57832f8bdd82356ee982956a`, linux/amd64 runtime manifest digest는 `sha256:d360419231ad1aa9140821dd95dda6c4ce74122439726c503c5f30083e682fd5`이며 익명 generic/per-arch 조회·pull, version/arch/source label과 mutable `latest` 부재를 확인했다.
- [x] 정확한 public `0.5.0` image에서 browser-policy, 전체 browser/gateway/Core WebSocket/ttyd/SSH, memory bootstrap/lifecycle/privacy/MCP/persistence, managed-auth, user-file와 public `0.4.0` → public `0.5.0` update smoke가 모두 PASS했다.
- [ ] 실제 HAOS에서 자연어 발화→same-request tool trace→새 task 회상과 안전한 persistent 설정 변경→fresh API 검증을 수행한다. Automation logic-only 변경은 현재 expectation 범위 밖임을 고지하고 semantic memory를 갱신하지 않는다.

### 2026-07-15 — Home Assistant UI의 Playwright 승인 정책과 0.4.0

- 목표: `browser_approval_policy`를 `safe` 기본, `never` full-auto, `always` full-prompt로 제공하고 현재 Playwright allowlist 16개의 MCP 승인 mode를 App 구성에서 선택한다. 사용자 config/AGENTS와 browser identity는 수정하지 않는다.
- 정책: safe는 탐색·관찰 11개 approve와 click/form/key/select/type 5개 prompt, never는 현재 16개 approve, always는 현재 16개 prompt다. server default는 prompt라 미래 도구가 자동 승인되지 않으며 proxy 금지 도구와 Home Assistant 권한은 변하지 않는다. top-level `codex_approval_policy=never`의 전역 MCP 자동 승인 precedence를 UI·문서에 공개한다.
- 구현: system fallback, 공통 helper, init 검증과 wrapper CLI override, en/ko option, invalid enum/type fail-closed, public `0.3.2` update baseline을 `0.4.0`에 반영했다.
- 검증: static helper/config/proxy parity, disposable-container fake argv와 pinned Codex parse, full/memory/managed-auth/user-file/browser-policy/update smoke, lint, CI와 Builder를 통과했다. HAOS Configuration UI/AppArmor의 실제 popup matrix는 별도 수용 항목으로 남긴다.
- [x] App option/schema/번역, safe system fallback, 공통 helper, wrapper/init과 16개 explicit per-tool override를 구현했다. `ha_memory`의 `writes` 정책, proxy allowlist, 사용자 config/AGENTS/browser identity와 App 권한은 변경하지 않았다.
- [x] Windows Python 3.14에서 pytest **58 passed / 8 jq-dependent skipped**, YAML, Markdown 20 files, ShellCheck, Hadolint와 `git diff --check`가 PASS했다. Linux main CI에서 jq-dependent pytest와 Home Assistant App linter까지 PASS했다.
- [x] local amd64 image `sha256:cce65f996a418d0ae5c61d1193fbbba39c10f2c9baeff27da9995518cf945502`는 530,874,711 bytes, `io.hass.version=0.4.0`, `io.hass.arch=amd64`, Codex `0.144.1`이다.
- [x] browser approval missing/safe/never/always, invalid enum/type 78, pinned Codex parse와 argument passthrough smoke, 전체 browser/gateway/Core WebSocket/ttyd/SSH, memory, managed-auth, user-file update와 public `0.3.2` → local `0.4.0` update smoke가 PASS했다.
- [x] [PR #26](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/26)을 merge commit `bca612661692e3d66d239c06b57b52921ea56af6`로 `main`에 병합했고, 동일 SHA의 [main CI 29408206017](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408206017)이 PASS했다.
- [x] merge SHA에 annotated `0.4.0` tag를 `2026-07-15T10:32:08Z`에 게시하고 공식 [Builder 29408467932](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408467932)로 generic/per-arch GHCR image를 발행했다. 공개 image 검증 뒤 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.4.0)를 `2026-07-15T10:42:35Z`에 공개했다. 두 OCI index digest는 `sha256:758837276c4247a304c58791bddab5912977d3445801dcd832a638f9a2af9342`, linux/amd64 runtime manifest digest는 `sha256:b586727e9a2ca724f32f8255f692cd32104aeed45bc0e65b8c12cb3cc151373b`이며 익명 generic/per-arch tag 조회·pull, version/arch/source label과 mutable `latest` 부재를 확인했다.
- [x] 정확한 public `0.4.0` image에서 browser-policy, 전체 browser/gateway/Core WebSocket/ttyd/SSH, memory, managed-auth, user-file와 public `0.3.2` → public `0.4.0` update smoke가 모두 PASS했다.
- 실제 HAOS `0.4.0`의 `never` mode는 14개 도구의 MCP 승인 0회와 desktop/mobile `127.0.0.1:8099` dashboard 경로가 **PASS (검증 범위)**했다. `select_option`과 `close`, `safe`·`always`, top-level global-never precedence, Configuration UI/default, 금지 도구, AppArmor 활성 여부, user-file/identity 보존과 live update 감지는 **NOT TESTED/NOT RUN**이므로 전체 popup 행렬은 PARTIAL이다.

### 2026-07-15 — 0.3.1 실제 `search/related` 실패와 0.3.2 patch

- 입력 증거: `codex-for-home-assistant-0.3.1-live-self-audit-2026-07-15.md`에서 공식 public `0.3.1` 설치 blob 일치, Core `2026.7.2` 연결·인증, daemon/SQLite 무결성, Core restart 뒤 재연결과 credential/raw-response 비노출은 확인됐다. 그러나 active automation 30건 중 `search/related(item_type=automation)` 2건이 Core `unknown_error`를 반환해 모든 refresh가 `ha_command_related_failed`로 중단됐고 catalog/LKG/실제 CLI·MCP 검색은 **FAIL**했다. candidate/change/App restart/update는 **NOT RUN**, `config: null` 경로는 **NOT OBSERVED**다.
- 공식 계약 대조: Home Assistant Core `2026.7.2`의 `search` 구현과 테스트에서 automation entity ID를 펼치는 요청은 `item_type=automation`이 맞다. `item_type=entity`는 해당 entity를 참조하는 역방향 관계를 찾는 다른 계약이므로, 실기에서 성공했다는 이유만으로 payload를 바꾸지 않는다. 확정 제품 결함은 선택적 related enrichment의 명시적 Core command 거부 1건도 필수 snapshot 실패로 취급해 config에서 안전하게 추출 가능한 관계와 나머지 정상 automation까지 전부 폐기하는 fail-all 정책이다.
- 구현 계획: `automation/config`과 related의 의미는 유지한다. Core가 `search/related`에 정상 result envelope의 `success:false`, `error.code=unknown_error`를 준 경우에만 해당 automation의 related를 빈 객체와 bounded warning으로 낮추고, 이미 존재하는 allowlist config scanner로 area/device/entity 관계를 정규화한다. 그 밖의 server command code, server/client timeout, unauthorized, invalid format, auth, transport, WebSocket close, protocol 오류, malformed success response와 config 실패는 계속 전체 snapshot을 fail closed한다.
- 검증 계획: 실제 `unknown_error` 응답에서 snapshot/catalog 관계가 config 기반으로 완성되는 회귀, server `timeout`/`unauthorized`/`invalid_format`/`home_assistant_error`, client timeout·connection/protocol·malformed 결과가 여전히 실패하는 negative test, null config와 related 실패의 warning 결합, installed `ws` WebSocket 회귀를 추가한다. 이후 Node/Python 계약, memory/container/full/update smoke, lint·secret scan·manifest를 실행한다.
- 전달 경계: patch version `0.3.2`와 public `0.3.1` update 기준선을 기능 브랜치/PR로 준비한 뒤 사용자의 후속 명시적 요청에 따라 main merge, annotated tag, GitHub prerelease와 generic/per-arch GHCR image까지 발행한다. 자동·공개 이미지 검증이 PASS해도 실제 HAOS `0.3.2` catalog/restart/candidate/change/privacy 재시험 전에는 실기 성공으로 기록하지 않는다.
- [x] explicit remote `search/related`의 `unknown_error`만 내부 command-rejected type과 remote code를 함께 확인해 bounded per-automation degradation으로 처리했다. Config-derived 직접 관계와 exact provenance를 유지하고, 다른 server command code, server/client timeout·unauthorized·invalid format·auth/transport/close/protocol·malformed envelope/result·config 실패는 계속 full-snapshot fail closed하도록 회귀 테스트로 고정했다. `ha-memory status`와 daemon은 대상 ID/remote body 없이 warning count만 보고한다.
- [x] 0.3.1 실기 증거와 0.3.2 문서·version/Docker/Playwright metadata, public `0.3.1` update baseline과 changelog를 일치시켰다. 공식 Core `2026.7.2` 구현·테스트·WebSocket error mapping을 `references.md`와 ADR-035에 기록했다.
- [x] final local image `sha256:20bb84c6c102df567f0467d1d6d178b098823bc17ecb98a71723270c195b6305`는 size 533,517,099 bytes, linux/amd64, `io.hass.version=0.3.2`, Codex `0.144.1`, Node `24.17.0`, `ws` `8.18.3`이다. Source Node **13 tests**, 설치 image Node **14 tests**, Windows pytest **56 passed / 8 jq-dependent skipped**, YAML, Markdown 20 files, ShellCheck 0.11.0, Hadolint 2.14.0과 `git diff --check`가 PASS했다.
- [x] local 0.3.2 image의 memory lifecycle/privacy/MCP/persistence/actual installed `ws`, 전체 browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file update smoke와 public `0.3.1` → local `0.3.2` update smoke가 모두 PASS했다. 릴리스 전 시점에는 실제 HAOS 0.3.2 재시험이 **NOT RUN**이었고 후속 결과는 아래 공개 이미지 기록과 2026-07-16 Current Work에 분리해 기록한다.
- [x] 구현 commit `24534b5`와 검증 인계 commit `1a3bd2e`를 `fix/ha-memory-related-degradation`에 push하고 [PR #24](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/24)를 열었다. PR [CI 29403106903](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29403106903)과 non-publishing [Builder 29403107117](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29403107117)가 PASS했다.
- [x] PR #24를 merge commit `5f1b28733c6b0b01fe6d3ae8f5074654812781d6`로 `main`에 병합했고 동일 SHA의 [main CI 29404524753](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29404524753)에서 lint/unit, Home Assistant App linter와 linux/amd64 전체 회귀가 PASS했다.
- [x] merge SHA에 annotated `0.3.2` tag를 게시하고 공식 [Builder 29404702270](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29404702270)으로 generic/per-arch GHCR image와 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.3.2)를 발행했다. 두 OCI index digest는 `sha256:d14bb71190be15fa6a45a19a2e981cb173c741e37ab0344c9bf941abbaab2c6b`, runtime manifest digest는 `sha256:3af26175df8c35a83e19634a0f7278f3ca3f70b08cb035e9953f2a519a9f353a`이며 익명 generic/per-arch pull, linux/amd64, version/arch/source label과 mutable `latest` 부재를 확인했다.
- [x] 정확한 public `0.3.2` image에서 actual installed `ws` 포함 memory lifecycle/privacy/MCP/persistence, browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file와 public `0.3.1` → `0.3.2` update smoke가 모두 PASS했다. 후속 실제 HAOS/Core `2026.7.2` E2E는 observed related `unknown_error` 2/30 격리, catalog/DB/CLI·MCP/privacy/candidate/restart 요청 후 fresh sync/App restart persistence를 PASS했고 runtime OCI digest NOT RUN과 Core disconnect/reconnect·LKG 상태 미관측 때문에 **PARTIAL(FAIL 0)**이다.

### 2026-07-15 — 실제 HAOS memory refresh 복구와 0.3.1 patch

- 입력 증거: `ha-memory-0.3.0-readonly-audit-2026-07-15.md`는 실제 HAOS에서 daemon retry와 MCP/SQLite는 정상이나 모든 catalog sync가 `ha_unavailable`로 실패하고, daemon이 stderr를 버려 transport/auth/protocol/command 원인을 구분할 수 없음을 확인했다. exec sandbox의 `bwrap` 실패와 Bubble Card resource 404는 memory 제품 실패와 분리한다.
- 원인 대조: 최신 공식 Home Assistant App 통신 문서와 Supervisor/Core 소스 기준으로 `ws://supervisor/core/websocket` + `SUPERVISOR_TOKEN` auth frame은 올바르다. 다만 Core는 unavailable automation에 성공 응답 `{"config": null}`을 반환할 수 있는데 0.3.0 client가 이를 불완전 snapshot으로 거부하며, production client는 image에 이미 고정·검증된 `ws` runtime 대신 Node built-in WebSocket을 사용한다. 기존 로그가 원인을 폐기했으므로 null-config를 live 원인으로 확정하지 않고 가장 근접한 호환성 결함으로 수정한다.
- 구현 계획: explicit-null automation은 빈 config와 정제된 warning으로 보존하고 entity/related 관계는 계속 index한다. production WebSocket을 고정 `ws` runtime과 32 MiB cap/handshake timeout/no compression으로 통일한다. Home Assistant unavailable 오류에는 closed machine code만 부여해 sync/change/CLI에 전달하고 daemon은 command 원문을 log하지 않은 채 allowlist reason만 기록한다.
- 검증 계획: null automation, auth/transport/protocol/command 실패 code와 secret redaction unit test, 실제 installed `ws`를 쓰는 Supervisor-style WebSocket container smoke, 기존 lifecycle/privacy/MCP/persistence/full/update 회귀, lint·manifest를 통과시킨다.
- 릴리스 계획: patch version `0.3.1`로 PR/CI/main merge 후 annotated tag, GitHub prerelease와 generic/per-arch GHCR image를 발행하고 공개 image를 다시 검증한다. 실제 HAOS catalog 성공/restart/candidate lifecycle은 새 image에서 별도 실기하기 전까지 **NOT RUN**으로 유지한다.
- [x] unavailable automation의 legal `config: null`을 bounded warning과 빈 config로 보존하고, image-pinned `ws` transport와 closed diagnostic code를 적용했다. 환경 `HA_WS_URL` credential redirection을 제거하고, non-object protocol frame은 안전하게 거부하며 병렬 command 실패 뒤 모든 pending timer를 즉시 정리한다. daemon은 CLI 원문을 메모리에만 받아 allowlist reason만 log한다.
- [x] 최종 local amd64 image `sha256:ab91cd043fcd27142a55d1afbcfaae6c77d87545abfd965a203065c30ccf7da2`는 version/arch label `0.3.1`/`amd64`, size 533,516,021 bytes다. source Node **9 tests**, 설치 image의 실제 `ws`를 포함한 Node **10 tests**, Windows pytest **56 passed / 8 jq-dependent skipped**와 Linux Python 3.13 + jq pytest **64 passed**, YAML, Markdown 20 files, ShellCheck 0.11.0, Hadolint 2.14.0, actionlint 1.7.7과 `git diff --check`가 PASS했다. Home Assistant App linter도 이어진 PR Linux CI에서 PASS했다.
- [x] local image에서 memory lifecycle/privacy/MCP/persistence와 실패 진단·last-known-good·recovery, 전체 browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file update, public `0.3.0` → local `0.3.1` update smoke가 모두 PASS했다. 릴리스 시점 실제 HAOS 0.3.1 재시험은 **NOT RUN**이었고, 이후 별도 0.3.1 실기 결과는 위 0.3.2 작업 절에 기록한 catalog FAIL/Core restart PARTIAL이다.
- [x] [PR #22](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/22)의 기능 commit `cc40f09590d7960f34cf1f1758db6465b073a9df`에서 push [CI 29391280972](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391280972), PR [CI 29391290985](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391290985)와 non-publishing [Builder 29391291097](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391291097)가 모두 PASS했다. Linux pytest+jq, Home Assistant App linter, fresh amd64 build와 memory/full/managed-auth/user-file/public `0.3.0` update smoke가 포함됐다.
- [x] PR #22를 merge commit `31003677a528d49e2132b70a1e180078136f62d1`로 `main`에 병합했고 동일 SHA의 [main CI 29391446446](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391446446)에서 lint/unit, App linter와 linux/amd64 전체 회귀가 PASS했다.
- [x] merge SHA에 annotated `0.3.1` tag를 게시하고 공식 [Builder 29391579529](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391579529)으로 generic/per-arch GHCR image와 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.3.1)를 발행했다. 두 OCI index digest는 `sha256:6e726ad1ce95714fb4d4f29dcbb51f762cdd3e7b3eeb9c1be7edcbb6ff1c0126`, runtime manifest digest는 `sha256:175c1a2b4d45897f713ab37f71c96b96c9b182e2f74340843c18aa34e7d84954`이며 익명 generic/per-arch pull, linux/amd64, version/arch/source label과 mutable `latest` 부재를 확인했다.
- [x] 정확한 public `0.3.1` image에서 실제 installed `ws` 포함 memory lifecycle/privacy/MCP/persistence와 failure/recovery, browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file와 public `0.3.0` → `0.3.1` update smoke가 모두 PASS했다. 릴리스 시점 실제 HAOS E2E는 **NOT RUN**이었고, 이후 Core `2026.7.2` 실기에서 catalog는 related `unknown_error`로 FAIL, Core restart는 PARTIAL, privacy는 PASS였다.

### 2026-07-15 — 검증 기반 지속 개선형 Home Assistant 메모리

- 목표: Home Assistant의 엔티티·장치·영역·자동화 관계를 빠르게 검색할 수 있는 영속 인덱스를 만들고, 대화에서 얻은 별칭·용도·선호·관계는 `candidate → verified → applied` 상태 전이와 출처 증거를 거쳐서만 활성 메모리에 반영한다.
- 권위 규칙: 구조·현재 존재 여부·변경 결과는 최신 Core REST/WebSocket API를 우선하고, 별칭·실제 용도·선호처럼 사용자 의미에 속하는 정보는 사용자의 명시적 설명을 우선한다. 일시 상태값과 단일 추론은 영속 메모리에 직접 저장하지 않는다.
- 저장·검색 계획: root-only `/data/codex-ha-memory/memory.sqlite3`에 정규화된 snapshot, 관계, 후보, 증거, 충돌, 변경 검증, 감사 이력을 저장한다. Codex는 전체 DB를 컨텍스트로 읽지 않고 `ha-memory search`/`show`가 반환한 제한된 관련 결과만 사용한다.
- 변경 검증 계획: Codex가 HA 설정 또는 registry를 바꾸기 전에 change record를 만들고, 변경 후 Core API snapshot과 명시적 expectation을 다시 확인한 성공 change만 메모리 후보의 검증 근거로 허용한다.
- 복구 계획: HA snapshot은 실제 HA의 캐시이므로 과거 상태로 롤백하지 않고 다음 refresh로 교정한다. 후보·적용·충돌 해결 같은 메모리 mutation은 before/after 감사 event를 남기고 현재값 precondition을 확인한 event rollback을 제공한다.
- 검증 계획: fixture 기반 Node/SQLite 동적 테스트로 초기 인덱스, 비영속 상태 제외, 후보 상태 전이, 출처 우선순위, API change verification, 관련 검색 제한, 충돌·이력·rollback을 확인한다. pytest 계약, Node/Bash syntax, YAML/Markdown, secret scan과 가능한 container smoke를 회귀 실행한다.
- [x] SQLite v1/FTS5 store, Core WebSocket allowlist client, `ha-memory` CLI와 optional STDIO MCP, 독립 `ha-memoryd`를 구현했다. area/device/entity/automation과 관계는 full snapshot transaction으로 갱신하고 state가 없는 disabled automation은 registry metadata만 index한다.
- [x] candidate의 type-specific durable schema, structured provenance/evidence, `pending → verified → applied`, fact-kind authority, open-conflict search 제외, expectation digest·exact predicate binding, history-preserving audit와 dependency-safe compensating rollback을 구현했다. transient state/raw conversation/credential fixture sentinel은 DB/WAL/SHM byte 검사에서 발견되지 않았다.
- [x] App init은 unsafe memory file/symlink를 따라가거나 mode를 바꾸지 않고 memory만 비활성화한다. 기본 `AGENTS.md`, image-owned developer instruction, Docker packaging과 S6 service를 연결하면서 기존 사용자 config/AGENTS와 App 권한 계약은 유지했다.
- [x] 제품·아키텍처·보안·테스트·사용 문서와 `0.3.0` changelog를 갱신했다. 새 memory 기능의 실제 HAOS Core/registry/restart/update E2E는 실행 환경이 없어 **NOT RUN**이며 local fixture/container 결과와 구분한다.
- [x] 최종 local image `sha256:07fecc736c43e9eb1ba2bde495e375554ee972a7c4f1ca1de787b028b1e81c9f`는 version `0.3.0`, arch `amd64`, size 533,512,546 bytes다. 설치 image 내부 memory lifecycle/schema/client, unsafe broken/valid symlink·WAL, raw-byte 비저장, MCP 실제 호출과 volume 교체 영속성 smoke가 PASS했다.
- [x] 전체 Docker browser/gateway/Core WebSocket/ttyd/SSH smoke, managed browser-auth smoke, user-file update smoke와 public `0.2.4` → local `0.3.0` update smoke가 모두 PASS했다. 로컬 source에서는 Node 4 tests, 전체 pytest **56 passed / 8 jq-dependent skipped**, Markdown 20 files, YAML, ShellCheck, Hadolint, MANIFEST와 `git diff --check`가 PASS했다.
- [x] [PR #20](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/20)의 기능 commit `4fd2f1236b11ff45ae05e3f6fe317474a4851bd9`에서 push [CI 29382194369](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29382194369), PR [CI 29382202828](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29382202828)와 non-publishing [Builder 29382202944](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29382202944)가 모두 PASS했다. Linux pytest+jq, Home Assistant App linter, fresh amd64 build, memory/기존 full smoke와 public `0.2.4` update가 포함됐다.
- [x] PR #20을 merge commit `7489ba8b86ccffaef0113599c1f9e67cb7876d9d`로 `main`에 병합했고 동일 SHA의 [main CI 29384344027](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29384344027)에서 lint/unit, App linter와 linux/amd64 memory/full/update smoke가 PASS했다.
- [x] merge SHA에 annotated `0.3.0` tag를 게시하고 공식 [Builder 29384484760](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29384484760)으로 generic/per-arch GHCR image와 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.3.0)를 발행했다. 두 OCI index digest는 `sha256:5ddb290534d45d46b34d2ef478ede83110c3b8e3a56f601ce2c6b45d5814341f`, runtime manifest digest는 `sha256:1c1e6a43cf24508e1c39c62bb2f0ab57c635208d8bd47537d4f9d09f0487f360`이며 익명 pull, linux/amd64, version/arch/source label과 mutable `latest` 부재를 확인했다.
- [x] 정확한 public `0.3.0` image에서 memory lifecycle/privacy/MCP/persistence, browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file와 public `0.2.4` → `0.3.0` update smoke가 모두 PASS했다. 새 memory의 실제 HAOS Core registry 규모, Core restart 재연결과 App update persistence E2E는 환경이 없어 **NOT RUN**이다.

### 2026-07-14 — HAOS UI/AppArmor 실기 완료 기록과 0.2.4 릴리스

- 목표: public `0.2.3`을 실제 HAOS에서 검증한 사용자 확인을 문서화하고, 런타임 기능 변경 없는 validation/evidence patch `0.2.4`를 공개한다.
- [x] Home Assistant 구성 UI와 Supervisor 일반 App 업데이트 경로: **PASS — 사용자 실기 확인**.
- [x] AppArmor 활성 상태의 인증된 `http://127.0.0.1:8099` dashboard desktop/mobile 렌더링, console, network/정적 resource와 Core WebSocket 경로: **PASS — 사용자 실기 확인**.
- 증거 한계: 사용자가 상세 실행 로그, screenshot, HAOS 버전을 제공하지 않아 이를 추정하거나 저장소 증거로 기록하지 않는다. token 음성 검색, 적대적 환경변수, 자동 인증 OFF/ON·삭제 lifecycle의 세부 음성 테스트는 자동 fixture 증거와 구분하며 이번 HAOS 확인으로 확대하지 않는다.
- 업데이트 주의: `refresh_agents` 또는 `refresh_all`을 계속 선택한 설치는 App version이 `0.2.4`로 바뀌면 선택한 target을 각각 한 번 다시 갱신한다. 재적용을 원하지 않으면 **업데이트 전** Home Assistant 구성에서 `preserve`로 저장해야 한다.
- [x] App/Docker/Playwright version 표식을 `0.2.4`로 맞추고 CI update 기준을 public `0.2.3`으로 올렸다. retained `refresh_all`의 이전-version state를 동적으로 만들어 새 version에서 두 target을 정확히 한 번 다시 갱신하고 같은-version 반복은 멱등임을 검증한다.
- [x] local amd64 image `sha256:b6badb83879799e9bb7c576751b370ef7e4600e208ca72028dafbfc3c2d2272d`는 version `0.2.4`, arch `amd64`, size 533,425,228 bytes다. user-file update, managed browser-auth와 public `0.2.3` → local `0.2.4` update smoke는 PASS했다. nested Docker driver의 full smoke는 browser/gateway/Core WebSocket까지 PASS한 뒤 Windows host-loopback ttyd에 접근할 수 없어 중단됐으므로 전체 PASS로 기록하지 않고 native Linux PR CI를 병합 게이트로 사용한다.
- [x] Windows Python 3.14에서 pytest **46 passed / 8 jq-dependent skipped**, Markdown 20개, YAML, ShellCheck/Bash syntax, Hadolint와 `git diff --check`가 PASS했다. jq-dependent 계약과 full Docker smoke는 Linux PR CI에서 다시 실행한다.
- [x] PR [#18](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/18)의 head `3b302cb`에서 push CI `29338992164`, PR CI `29339016206`와 Builder dry-run `29339012850`을 통과했고 merge commit `9a2b2298cac235c8230f7c173ad188a55b855f3e`로 `main`에 병합했다. main CI `29339330253`도 통과했다.
- [x] merge SHA `9a2b2298cac235c8230f7c173ad188a55b855f3e`에 annotated `0.2.4` tag를 게시하고 공식 Builder run [`29339603324`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29339603324)으로 generic/per-arch GHCR image와 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.2.4)를 발행했다. 두 index digest는 `sha256:3f9d70943ad68f2b7177826546227fa00c68068b57bdf7b1686edf1c3de90f26`, runtime manifest digest는 `sha256:e435844c06d7813ad527e3897dd647cc313a03d7c7c833301953b253a57658a8`이며 익명 pull, amd64/version/source label과 mutable `latest` 부재를 확인했다.
- [x] public `0.2.4` image에서 managed-auth, user-file update와 public `0.2.3` → public `0.2.4` update/MCP smoke가 PASS했다. exact public image의 Docker Desktop nested full smoke는 browser/gateway/Core WebSocket까지 PASS한 뒤 ttyd host-loopback timeout으로 전체 PASS 처리하지 않았으며, 동일 merge SHA의 native Linux main CI `29339330253`에서 전체 Docker browser/gateway/ttyd/SSH smoke가 PASS했다.

### 2026-07-14 — Home Assistant UI 선택형 Codex 사용자 파일 갱신과 0.2.3 릴리스

- 목표: Home Assistant App 구성 화면에서 사용자가 `/data/codex/config.toml`과 `AGENTS.md`의 image 기본본 갱신 범위를 선택하고, 기본값은 기존 파일 보존으로 유지한다. 선택한 정책은 새 App version의 첫 시작에 한 번만 실행하며 같은 version의 일반 재시작에서는 반복하지 않는다.
- 안전 원칙: overwrite 전에 기존 파일을 `/data/codex/backups`의 root-only 고유 디렉터리에 보존하고 새 기본본은 같은 filesystem의 임시 파일에서 원자 교체한다. refresh 대상으로 선택한 symlink·비정상 file·다중 hardlink는 따라가지 않고 fail closed한다. `auth.json`, session, `AGENTS.override.md`, SSH/browser identity, App options와 Home Assistant `/config`는 건드리지 않는다.
- [x] `codex_user_files_update_mode`의 `preserve` default와 `refresh_agents`/`refresh_all` enum, en/ko 설명, image version 표식과 init 연동을 구현했다. option이 없는 public `0.2.2`의 첫 `0.2.3` 시작은 기존 파일을 보존하고, 사용자가 구성에서 선택해 재시작한 뒤 같은 version의 target을 반복 갱신하지 않는다.
- [x] root-owned regular single-link preflight, 열린 FD 기반 mode/lock 검증, `0700` transaction과 `0600` backup/state/journal, atomic replace와 commit 전 rollback/commit 후 journal cleanup을 구현했다. runtime lock hardlink 피해 파일의 mode 불변과 symlink/hardlink/FIFO 거부를 동적 회귀로 확인했다.
- [x] 최종 local image `sha256:719f56a58c0f0dbaa4bb2967750c5dae3f95a6b89bd143de372e3b13f540e485`는 label version `0.2.3`, arch `amd64`, size 533,424,911 bytes다. user-file update smoke, managed browser-auth lifecycle smoke, full Docker browser/gateway smoke와 public `0.2.2` → local `0.2.3` preserve→opt-in refresh→same-version restart update smoke가 PASS했다.
- [x] 정적 검증은 Windows Python 3.14에서 MANIFEST를 포함한 pytest **46 passed / 8 jq-dependent skipped**, YAML, ShellCheck 0.11.0, Hadolint 2.14.0, Markdown 20개, actionlint 1.7.7, Node/Bash syntax와 `git diff --check`가 PASS했다. PR/push Linux CI는 jq-dependent 계약을 포함해 통과했다.
- [x] PR [#16](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/16)의 head `b92822f`에서 PR CI `29334410649`, push CI `29334406992`와 Builder dry-run `29334410864`을 통과했고 merge commit `370ffee`로 `main`에 병합했다. main CI `29334640150`도 통과했다.
- [x] merge SHA `370ffee8bce5e3c5591fe9b4f732044d2ff59bdc`에 annotated `0.2.3` tag를 게시하고 공식 Builder run `29334867268`로 generic/per-arch GHCR image와 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.2.3)를 발행했다. 두 index digest는 `sha256:a53c7b2006301826a52bc9d9dc3c3ec8fd5e99d73b59a028b16c78bf7628d2a1`, runtime manifest digest는 `sha256:f049e82cb3bef8b7a063dc98ea4209984a9716de566c241b1ccb0fb713f76b2e`이며 익명 pull, amd64/version/source label과 mutable `latest` 부재를 확인했다.
- [x] public `0.2.3` image에서 managed-auth, user-file update, full browser/gateway smoke가 PASS했고 public `0.2.2` → public `0.2.3` update smoke로 기본 preserve, opt-in refresh_all과 동일 version 재시작 멱등성을 확인했다.
- [x] 실제 Home Assistant 구성 UI/Supervisor 일반 update와 HAOS/AppArmor의 인증된 dashboard desktop/mobile·console·network/resource·WebSocket 경로는 **PASS — public `0.2.3` 사용자 실기 확인**.

### 2026-07-14 — 기본 ON 브라우저 자동 인증과 8099 Codex 라우팅

- 목표: App 설정에서 Home Assistant 대시보드 브라우저 자동 인증을 켜고 끌 수 있게 하고 기본값을 `true`로 두어 신규 설치와 기존 설치의 다음 시작에서 관리형 최소권한 identity를 자동 생성·재사용한다. Codex는 Home Assistant 대시보드 검사 요청을 받으면 다른 browser skill 탐색보다 image-managed Playwright MCP와 `http://127.0.0.1:8099/`를 먼저 사용한다.
- 수명주기 원칙: OFF는 다음 App/MCP 시작부터 runtime token 주입과 자동 생성을 비활성화하되 복구 가능한 `/data/browser-auth` identity는 삭제하지 않는다. 이미 열린 browser context에는 소급 적용하지 않으므로 option 저장 뒤 App을 재시작한다. 다시 ON이면 같은 identity를 재검증·재사용한다. 완전 삭제는 OFF 상태의 `ha-browser-auth-remove`로만 수행하고 ON에서는 즉시 재생성 경쟁을 막기 위해 거부한다. 수동 token option은 ON에서만 명시적 override로 유지한다.
- Codex 지침 원칙: 기존 `/data/codex/config.toml`과 사용자 `AGENTS.md`는 변경하지 않는다. 업데이트 가능한 `/etc/codex/config.toml`의 `developer_instructions`, 신규 설치용 기본 `AGENTS.md`, Playwright MCP tool 설명에 8099 우선 경로를 명시한다.
- 검증 계획: option/schema/번역 계약, default-ON 자동 생성·재시작 재사용·OFF/ON 전환·수동 override, system config와 MCP tool 설명을 unit/managed-auth/container smoke로 검증한다. desktop/mobile screenshot·console·network 회귀와 update persistence를 다시 실행하고, 실제 HAOS/AppArmor는 별도 수용 기준으로 둔다. 후자는 public `0.2.3`에서 사용자 확인 PASS로 완료됐다.
- [x] `home_assistant_browser_auto_auth` default true와 option 누락 upgrade 동작, init/MCP 자동 ensure, OFF/ON 보존·재활성화, manual override no-fallback을 구현한다.
- [x] `/etc/codex/config.toml`의 model-visible developer instruction, 신규 기본 `AGENTS.md`와 filtered `browser_navigate` 설명에 image-managed Playwright와 `http://127.0.0.1:8099/` 첫 경로를 제공하고 기존 사용자 config/AGENTS를 보존한다.
- [x] ON 상태 remove를 Home Assistant mutation 전에 거부하고 OFF 상태에서만 exact identity를 완전 삭제해 다음 ensure의 즉시 재생성 경쟁을 차단한다.
- 최종 local image 증거: image ID `sha256:a774b98e7b60852e9b005736ee52debea6ff67b140b2e9fae8cad20b6979329e`, label version `0.2.3`/arch `amd64`, size 533,414,320 bytes다.
- 최종 인증/browser/update 증거: managed-auth smoke, full Docker smoke와 public `0.2.2` → local `0.2.3` update smoke가 PASS했다. `8099` fixture는 desktop `1440x900`(전송 PNG 1389x868)·mobile `390x844`, console/network, direct Core REST/WebSocket, exact token redaction을 확인했다. 실제 HAOS/AppArmor dashboard desktop/mobile·console·network/resource·WebSocket E2E도 후속 public `0.2.3` 사용자 확인에서 **PASS**했다.
- 최종 정적 증거: Linux Python 3.13 + bash/jq에서 pytest **50 passed**, YAML, ShellCheck 0.11.0, Hadolint 2.14.0, Markdown 20개, actionlint 1.7.7, Node/Bash syntax와 `git diff --check`가 PASS했다.
- [x] 기능 commit `7709e24`를 `feat/browser-auto-auth-default-route`에 push하고 draft PR [#16](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/16)을 생성했다. feature head의 push/PR CI run `29331087866`·`29331104007`에서 lint/unit, App config, amd64 build/full/managed/update smoke가 모두 PASS했고 builder run `29331104185`의 metadata와 amd64 image build도 PASS했다.

### 2026-07-14 — 브라우저 최소권한 인증 자동 설정

- 목표: 사용자가 별도 Home Assistant 사용자로 로그인해 long-lived token을 발급하고 App 옵션에 복사하는 과정을 없애고, Web terminal에서 명시적인 1회 setup 뒤 일반 재시작·업데이트에는 안전하게 재사용되는 dashboard browser 인증을 제공한다.
- 구현 원칙: `trusted_networks`, `trusted_proxies`, 관리자/Supervisor browser token과 Home Assistant 설정 파일은 사용하지 않는다. 공식 `config/auth/*`, `config/auth_provider/homeassistant/*`, `/auth/login_flow`, `/auth/token`, `/auth/revoke`, `auth/long_lived_access_token` API만 사용하고 기존 수동 token option은 명시적 override로 보존한다.
- 수명주기 계획: App이 active·local-only·sole `system-read-only` managed user를 만들고 무작위 임시 password로 자기 자신을 인증한 뒤 10년 LLAT를 발급한다. 임시 password credential과 OAuth refresh token을 제거하고, managed token/user ID만 `/data`의 root-only 파일에 원자적으로 보존한다. 기존 managed user의 정책이 바뀌면 자동 수정하지 않고 fail closed한다.
- UX 결정: 별도 setup HTTP service와 Ingress action button은 관리자 identity 검증·CSRF 방어·새 화면 수명주기를 추가하므로 이번 변경에 넣지 않는다. 관리자 전용 기존 Web terminal에서 인자 없이 `ha-browser-auth-setup`을 한 번 실행하면 전체 transaction과 runtime 활성화가 끝나게 한다. 이후 App update/restart는 managed token을 자동 재사용하고, 기존 수동 `home_assistant_browser_token`은 명시적 override/fallback으로 유지한다.
- mutation/TLS 결정: 설치·업데이트·재시작만으로 Home Assistant user/token이나 provider 설정을 만들거나 바꾸지 않는다. 내부 Core가 HTTPS이면 image CA bundle과 `homeassistant` hostname을 엄격히 검증하고 인증서 오류를 우회하지 않는다.
- [x] Home Assistant Core 2026.7.1 source에서 필요한 admin/user WebSocket command와 login/token/revoke HTTP flow를 확인한다.
- [x] crash/retry/rollback 가능한 managed user·token bootstrap, 즉시 runtime activation과 명시적 제거 helper를 구현한다.
- [x] fixture에서 임시 credential·OAuth refresh token 제거, LLAT 소유자/정책 검증, token 비노출과 자동 복구 회귀를 구현하고 중간 managed-auth smoke를 통과한다.
- [x] config/번역/문서/changelog/version과 update persistence 계약을 `0.2.2` 후보로 갱신한다.
- [x] unit/lint, amd64 image/full smoke, rendered desktop/mobile gateway와 public `0.2.1` image update smoke를 통과한다.
- [x] 기능 commit `8a1e0a4`를 `feat/automatic-browser-auth-setup`에 push하고 draft PR [#15](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/15)에 로컬 검증과 실제 HAOS 미검증 항목을 기록했다. 원격 CI 최종 결과는 PR에서 확인한다.
- 최종 정적 증거: Linux Python 3.13 + jq에서 pytest **49 passed**, YAML, ShellCheck 0.11.0, Hadolint 2.14.0, Markdown 20개와 `git diff --check`가 PASS했다.
- 최종 image 증거: local image ID `sha256:24227a7c1e4ae97b1ff3b922d9b4cc6794bcbac50da7564058379f6c8c5abb6b`, label version `0.2.2`/arch `amd64`, size 533,413,124 bytes다.
- 최종 managed-auth smoke: 생성·재사용·App replacement·회전·제거, nonblocking kernel lock, Supervisor 없는 crash-temp cleanup, unsafe symlink 거부, provider/Core 장애, token 응답 유실, 지속 cleanup 실패 journal 복구와 정책 변조 fail-closed가 PASS했다.
- 최종 browser/update smoke: 내부 `8099` desktop `1440x900`(전송 PNG 1389x868)·mobile `390x844`, console/network, direct Core REST/WebSocket와 public `0.2.1` → local `0.2.2`의 `/data`·`/config` 보존이 PASS했다. 당시 별도 수용 항목으로 남겨 둔 실제 HAOS/AppArmor dashboard E2E는 후속 public `0.2.3` 사용자 확인에서 **PASS**했다.

### 2026-07-14 — HA browser 요청 IP와 최소권한 인증 재설계

- 목표: 실제 App browser→Core 요청 source를 확인하고, Docker 전체 대역이나 재할당 가능한 App `/32`를 신뢰하지 않으면서 비밀번호 없는 dashboard 검토 경로를 제공한다.
- 네트워크 판정: 최종 local Docker smoke의 사용자 지정 private test subnet에서 App inspect IP, App→Core socket source, Supervisor fixture self IP와 Chromium이 직접 Core API에서 받은 관측 peer가 모두 `10.253.214.3`으로 일치했다. App 제거 뒤 같은 `10.253.214.3`을 replacement container에 재할당할 수 있었고 무토큰·Supervisor token 요청은 모두 거부됐다. 이 주소는 fixture 전용이며 실제 HAOS 주소가 아니다. Supervisor 일반 App은 `172.30.33.0/24`에서 고정 예약 없이 연결되므로 persistent `/32` allowlist는 다른 App 사칭으로 이어질 수 있다.
- live 읽기 전용 확인: LAN Core `2026.7.1`의 `/auth/providers`에는 기존 `homeassistant` provider 하나만 있었다. live App 내부 주소의 정확한 마지막 octet과 `8099` screenshot은 현재 Windows 작업공간에 App SSH/Ingress session이 없어 확인하지 못했으며 PASS로 표시하지 않는다.
- 보안 결정: `configuration.yaml`, `auth_providers`, `trusted_networks`, `trusted_proxies`, `.storage`를 자동 변경하지 않는다. 기존 `homeassistant` fallback을 유지한다. App IP와 Docker 대역을 trusted proxy/network로 추가하거나 synthetic X-Forwarded-For를 사용하지 않는다.
- 대안 구현: optional password option으로 전용 long-lived token을 받고, App init과 각 MCP launch에서 `auth/current_user`와 `config/auth/list`를 교차검증해 active·local-only·non-system·non-admin·sole `system-read-only` user만 허용한다. inherited `HA_BROWSER_TOKEN`, `BASH_ENV`, `ENV`는 제거하고 실패하면 login page로 fail closed하며 Supervisor token은 Node proxy/browser child에 전달하지 않는다.
- gateway 변경: frontend/auth/API/WebSocket을 모두 direct `homeassistant:<port>`로 통일하고 X-Forwarded-For, X-Real-IP, Forwarded를 제거한다. `ha-browser-network-info`와 `ha-browser-auth-status`로 비밀 없는 runtime 진단을 제공한다.
- secret 전달 판정: Playwright `--secrets`는 입력 도구에서 secret 이름을 실제 값으로 치환하므로 사용하지 않는다. system MCP는 `env -i`로 시작하고 wrapper는 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`와 shell startup 변수를 검증 전에 제거한다. proxy/browser child에는 고정 allowlist 환경만 전달하며 재검증된 token은 loopback init script 환경에만 넣고 관리 proxy가 stdout/stderr의 exact 문자열을 직접 마스킹한다.
- [x] 공식 Core/Supervisor source와 문서에서 provider order, proxy overlap, read-only group, dynamic App IP 계약을 확인한다.
- [x] unsafe persistent trusted-network 구성을 거부하고 HA 설정을 변경하지 않는다.
- [x] dedicated user/token 경로, source-IP fixture, Docker IP 재사용 negative test와 내부 `8099` desktop/mobile screenshot·console·network smoke를 완료한다.
- [x] `0.2.1` amd64 local image build와 full Docker smoke를 통과한다. image ID는 `sha256:534330f107d4524a0c9d2abfa7b9c9b0dd8d50241cdd99d8da6e29170159cc19`, label은 version `0.2.1`/arch `amd64`, size는 533,356,868 bytes다.
- [x] public `0.2.0` → local `0.2.1` replacement smoke에서 `/data`·`/config`, Codex auth/config, AGENTS, SSH identity와 마스킹된 browser token option을 보존하고 새 MCP를 실행했다.
- [x] 최종 authenticated fixture smoke에서 `http://127.0.0.1:8099` desktop `1440x900`(전송 PNG 1389x868)과 mobile `390x844` PNG, Core REST/WebSocket, console/network와 source IP를 확인했다. token file 없이 환경변수로 browser token을 주입한 음성 fixture는 login 상태로 fail closed했다.
- [x] `--secrets` 미사용, hostile `PLAYWRIGHT_MCP_*`/`NODE_OPTIONS` 무시와 loopback token reflection fixture의 MCP text exact-value redaction을 image에서 검증했다.
- [x] Linux Python 3.13에서 pytest 44개를 모두 통과하고 YAML, ShellCheck 0.11, Hadolint 2.14, Markdown과 `git diff --check` lint를 통과했다.
- [x] 실제 HAOS update 뒤 App 내부 `8099` dashboard desktop/mobile·console·network/resource·WebSocket 경로를 확인했다 — public `0.2.3` 사용자 확인 PASS.

### 2026-07-14 — Playwright Headless Chromium 브라우저 도구

- 목표: Codex가 자신이 만든 Web UI와 Home Assistant 대시보드를 실제 브라우저로 열고 데스크톱/모바일 화면, 스크린샷, 콘솔 오류, 네트워크·리소스 상태를 직접 검사할 수 있게 한다.
- 구현 방향: App 이미지에 버전 고정한 Microsoft Playwright MCP와 Alpine `chromium-headless-shell`을 포함하고, `/etc/codex/config.toml` 시스템 계층에서 공식 STDIO MCP로 노출한다. `/data/codex/config.toml`은 수정하지 않아 기존 사용자 설정과 인증을 보존한다.
- 보안 경계: 외부 포트와 host 권한을 추가하지 않고 브라우저는 headless/isolated/no-sandbox로 컨테이너 안에서만 실행한다. 위험한 임의 코드·파일 업로드 도구는 노출하지 않고, runtime Supervisor token은 임시 0600 secrets 파일로 마스킹한다.
- HA 렌더 경로: loopback 전용 gateway가 Home Assistant frontend와 공식 Core API/WebSocket proxy를 결합하고, 현재 App token을 브라우저 localStorage에만 주입한다. token 원문은 MCP 응답·App 로그·artifact에 남기지 않는다.
- 호환성 결정: Playwright의 공식 Linux 배포 대상은 Ubuntu/Debian이지만 기존 Home Assistant Alpine runtime의 회귀 폭을 줄이기 위해 시스템 Chromium 조합을 사용한다. 최종 local image는 `@playwright/mcp 0.0.78`, lockfile의 `playwright-core 1.62.0-alpha-1783623505000`, Alpine Chromium Headless Shell 150 조합으로 실제 MCP smoke를 통과했다. 이 자동 결과와 HAOS/AppArmor 실기 증거는 분리해 기록했으며, 후자는 public `0.2.3` 사용자 확인에서 PASS했다.
- 보안 보강: 고정 stdio proxy가 raw `tools/list`와 `tools/call` 양쪽에서 Codex system config와 같은 allowlist를 강제한다. 임의 code/file upload/단일 network 상세 도구와 모든 `filename` 인수를 거부하고 wrapper의 CLI 인수도 차단한다. browser 파일은 `/run`에만 두고 init 때 지운다.
- local gateway 증거: 모의 Supervisor/Core를 전용 Docker network에 연결해 Core info, localStorage token bootstrap, 인증된 `/api/config`, frontend marker, `/api/websocket` 101 upgrade와 `8099`의 loopback 외부 접근 차단을 확인했다.
- local update 증거: public `0.1.3` image의 container만 candidate로 교체하고 같은 named `/data`·`/config` volume을 사용해 사용자 Codex config, valid auth marker, 운영 지침, Home Assistant config marker와 SSH host fingerprint가 보존되며 새 Playwright MCP smoke가 동작함을 확인했다.
- [x] image-managed Playwright MCP, Chromium, Codex system config와 HA loopback gateway를 구현한다.
- [x] 모바일/데스크톱 DOM·PNG, console/page error, 2xx/3xx/4xx/5xx/transport failure를 확인하는 실제 MCP 회귀 테스트를 추가한다.
- [x] App 업데이트 비파괴 계약, 보안 문서, 사용자 사용법과 changelog를 갱신한다.
- [x] amd64 image build와 최종 full Docker smoke를 통과한다.
- [x] Linux unit/policy test와 YAML/Shell/Dockerfile/Markdown/GitHub Actions lint를 통과한다.
- [x] 기능 commit `e26d31a`과 검증 기록 `b56263b`의 PR [#12](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/12)를 merge commit `a4afde6`으로 `main`에 병합했다. 병합 후 CI run `29299843452`의 lint/unit, App config, amd64 build/full/update smoke가 모두 PASS다.
- [x] annotated tag `0.2.0`의 공식 builder run [`29299863049`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29299863049)로 amd64 image와 generic manifest를 게시했다. generic/per-architecture tag의 인증 없는 resolve·pull, `linux/amd64`, version/arch/source label, mutable `latest` 부재를 확인했다. generic OCI digest는 `sha256:2920cabd22969b8b8ce84048bba4d42398d633500de9576f6f493464af64e769`다.
- [x] 인증 없이 pull한 정확한 public `0.2.0` image에서 Playwright MCP desktop/mobile·console·network, 모의 인증 gateway/WebSocket, ttyd/SSH/영속성 전체 Docker smoke를 통과하고 GitHub [`0.2.0` prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.2.0)를 게시했다.
- [x] 실제 HAOS에서 일반 업데이트 후 인증된 대시보드와 AppArmor Chromium 실행을 확인했다 — public `0.2.3` 사용자 확인 PASS.

### 2026-07-13 — 0.1.3 amd64 GHCR non-dev 릴리스와 HACS 검토

- 사용자 최종 실기 증거: HAOS에서 auto-start 양 모드, device-code 로그인, App 재시작 뒤 인증 유지, SSH host identity 동일성을 확인했다. `persistent_notification` 생성·dismiss Core service call은 각각 rc 0이었고 임시 알림 정리도 성공했다.
- 완료 경계: 위 결과로 제품 명세의 M1/M2 필수 실기 수용 기준은 충족한다. Supervisor/Core/App start/stop/restart 실동작은 운영 중단 위험 때문에 자동 실행하지 않으며 manager info/log/config-check와 범용 POST helper 검증 범위로 남긴다.
- 릴리스 버전: Supervisor와 같은 AwesomeVersion 25.8.0에서 `0.1.3-dev < 0.1.3`을 재현했으므로 `0.1.3`을 첫 non-dev version으로 사용한다. Home Assistant `stage: experimental`, `arch: [amd64]`는 유지하고 `0.1.4`는 필요 시 복구 릴리스용으로 남긴다.
- 배포 전환: 공식 Home Assistant builder action으로 amd64 per-arch image와 generic GHCR manifest를 게시하고 `config.yaml`은 `ghcr.io/kanu-coffee/codex-for-home-assistant`를 사용한다.
- 데이터 전환: App runtime과 `/data` 형식은 바꾸지 않는다. 기존 App을 삭제하거나 reset하지 않고 일반 업데이트로 검증한다. registry 문제가 생기면 더 높은 patch version에서 `image`를 제거해 소스 빌드로 되돌린다.
- HACS 판정: HACS는 Supervisor App 유형을 지원하지 않으므로 HACS manifest나 잘못된 repository type을 추가하지 않는다. 공식 App repository URL과 My Home Assistant 원클릭 등록 링크를 제공한다.
- [x] 사용자 실기 PASS를 Verification/M2와 사용자 문서에 반영했다.
- [x] 0.1.3 version, generic GHCR image, 공식 builder workflows와 계약 테스트를 구현했다. PR 빌드는 read-only이고 numeric version tag만 package write/OIDC 권한으로 게시한다.
- [x] 로컬 amd64 image build/full smoke, Linux pytest 31개, ShellCheck/Hadolint/YAML/Markdown/actionlint와 Git diff 검사를 통과했다. image의 `io.hass.version=0.1.3`, `io.hass.arch=amd64` label도 확인했다.
- [x] PR [#10](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/10)의 CI run `29244843174` 3개 job과 builder PR run `29244843342`의 metadata/prepare/amd64 build를 통과했다. merge commit은 `014de31`이고 main CI run `29244989052` 3개 job도 통과했다.
- [x] tag `0.1.3`의 builder run `29245085795`로 amd64 image와 generic manifest를 게시했다. 빈 Docker 인증 설정에서 generic/per-arch를 모두 조회하고 generic image를 pull했으며 manifest digest `sha256:298add07ce5d1d5fd68b867fc7b9a0c4b03e3f909d2b887c680d24ddbbd75615`, `linux/amd64`, App version/arch/source label, mutable `latest` 부재와 pulled-image full smoke를 확인했다.
- [x] public `main` 병합, annotated `0.1.3` tag와 GitHub [prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.1.3)를 완료했다.
- [ ] 사용자 HAOS에서 App Store repository를 새로고침하고 기존 `0.1.3-dev`를 `0.1.3`으로 일반 업데이트한 뒤 Web UI, Codex 인증 유지와 SSH host identity를 확인한다. App 삭제, `/data` reset, 재로그인은 요구하지 않는다.

### 2026-07-13 — 0.1.3-dev 최종 HAOS 회귀·완료 판정

- 목표: 새 HAOS 보고서와 기존 사용자 E2E 증거를 합쳐 로그 helper, Web UI 재접속, 인증·SSH 경로의 회귀 여부를 판정하고 amd64 MVP와 정식 릴리스의 남은 조건을 분리한다.
- 실기 결과: `0.1.3-dev`/amd64 보고서는 PASS 16, FAIL 0이다. Core/App 직접 로그 요청과 `ha-core-logs`/`ha-addon-logs self`가 모두 rc 0/nonempty였고, 재접속 뒤 App helper도 stderr 없이 성공했다. raw 로그나 진단 원문은 저장소에 포함하지 않는다.
- Web UI 결과: 다른 브라우저/환경으로 다시 열었을 때 이전 대화와 터미널이 복구됐고 resize와 `clear` 오류 부재를 확인했다. 사전 session ID가 없어 HAOS의 동일 ID 기계 비교는 미실행이지만, 실제 ttyd 로컬 smoke가 동일 session/pane/pid를 별도로 검증한다.
- 합산 증거: 보고서 한 회차에서 미실행한 외부 SSH/Remote와 로그인 영속성은 사용자의 기존 mobile Remote → HAOS App 직접 SSH → `/config` E2E 및 삭제 없는 연속 업데이트 뒤 인증 유지 결과로 이미 PASS다.
- 완료 판정: 새 런타임 결함은 없으며 현재 주 사용 경로는 **실사용 가능한 beta/MVP candidate**다. 그러나 저장소의 M1/M2 수용 기준상 HAOS auto-start 양 모드, device-auth·재시작 영속성, 안전한 Core POST service call이 미검증이므로 프로젝트 완료로 표시하지 않는다. 첫 non-dev 릴리스에는 인증/host identity 재시작 확인과 tag/GHCR 배포도 필요하다. Home Assistant `stage`는 M3 평가 전까지 `experimental`을 유지한다. 위험한 Core/App lifecycle 실동작은 구현 결함 증거가 없으므로 자동 실행하지 않는다.
- 데이터 전환: 이번 변경은 실기 증거와 프로젝트 상태 문서만 갱신한다. App 업데이트도 기능 반영 목적으로 필요하지 않으며 `/data` 초기화나 App 삭제·재설치는 하지 않는다. 영속성 후속 시험도 일반 App 재시작/업데이트로 수행한다.
- [x] 보고서의 PASS/FAIL/UNVERIFIED를 기존 실기·자동 검증 증거와 대조한다.
- [x] 실제 결함과 시험 절차상 미확정을 분리하고 MVP/릴리스 완료 여부를 판정한다.
- [x] `progress.md`, README, App DOCS/CHANGELOG의 실기 상태와 남은 릴리스 게이트를 실제 결과에 맞춘다.
- [x] Linux pytest 30개, manifest/secret policy, Markdown 20개와 `git diff --check`를 통과했다. App runtime은 바꾸지 않아 로컬 image rebuild를 생략하고 원격 CI의 amd64 build/smoke를 병합 게이트로 사용한다.
- [x] commit `3598798`을 `agent/live-regression-completion`에 push하고 PR [#9](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/9)을 생성했다. 최초 head CI run `29242099208`의 App linter, amd64 build/smoke, lint/unit 3개 job이 통과했다. 이 기록은 같은 PR의 public `main` 병합으로 전달하며 최종 merge/main CI는 작업 결과에서 별도로 확인한다.

### 2026-07-13 — 0.1.3-dev 라이브 회귀 수정·로고·M2 증거 반영

- 사용자 실기 증거: `0.1.2-dev` Ingress Web UI와 인증된 Codex 실행, Codex 모바일 앱의 공개키 Remote SSH 접속이 정상 동작했다. App을 삭제하지 않고 업데이트해 온 환경에서도 기존 영구 데이터와 인증 상태가 유지됐다.
- 라이브 보고서 증거: `/config` RW와 정리, Core REST 조회, Supervisor manager 조회·config-check, 직접 로그 API, SSH 공개키 전용 설정, 기본 전역 `AGENTS.md`의 비파괴 영속화는 통과했다. `ha-core-logs`와 `ha-addon-logs`만 JSON 전용 `Accept` 헤더 때문에 실패했다.
- 시험 해석: 보고서의 tmux 재접속 항목은 기존 Ingress 세션을 먼저 만든 시험이 아니어서 회귀 증거로 사용하지 않는다. 사용자 Web UI 성공은 확인됐지만 브라우저 종료 후 동일 세션 재접속은 별도 실기 항목으로 남긴다.
- 데이터 전환: 아래 변경은 이미지 계층의 헬퍼·표시 자산·문서만 바꾸며 `/data`를 초기화하거나 덮어쓰지 않는다. 일반 App 업데이트로 시험하고, 완전 삭제·재설치는 요구하지 않는다.
- [x] 로그 API가 `text/x-log`를 협상하도록 공용 API 클라이언트와 두 로그 헬퍼를 수정하고 회귀 테스트를 추가했다. media type allowlist가 CR/LF header injection도 요청 전에 거부한다.
- [x] 제공된 원본을 왜곡 없이 투명 RGBA `icon.png` 128x128과 `logo.png` 250x250으로 변환하고 README 표시·자산 계약 테스트를 추가했다.
- [x] 실제 ttyd WebSocket에서 resize와 연결 종료/재접속 뒤 동일 tmux session/pane/pid를 확인했다. 이는 같은 App 실행 중 보장이며 업데이트를 넘는 영속성 주장이 아니다.
- [x] 버전을 `0.1.3-dev`로 올리고 README, changelog, 설계·보안·테스트·운영 문서를 실제 실기 증거에 맞췄으며 `MANIFEST.md` 문서 checksum을 현재 내용으로 재생성했다.
- [x] amd64 이미지 build/full smoke, Linux 30 tests, ShellCheck/Hadolint/YAML/Markdown/App lint, secret scan과 Git diff를 검증했다.
- [x] commits `2b145e4`, `d93889d`를 `fix/live-log-logo`에 push했다. PR [#7](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/7)의 push/PR CI 6개 job이 통과했고 merge commit `e1de443`으로 public `main`에 병합했다. final main CI run `29237205318`의 3개 job도 통과했다.

### 2026-07-13 — HAOS 실기 진단 검토와 Codex 운영 가드레일

- 사용자 실기 증거: `0.1.1-dev` Web UI에서 Codex 인증·실행과 시스템 진단이 성공했다. 진단 중 실제 `/config` 파일 생성, Supervisor API의 Core/Supervisor/host/OS 정보·로그 조회, `POST /core/check` HTTP 200/`result: ok`를 확인했다.
- 범위 결정: 사용자 자동화 Repairs, 서드파티 통합/앱 경고, Core 업데이트, `/config` 인증성 파일 권한은 실제 HA 구성과 운영 판단 영역이므로 App 소스에서 자동 변경하지 않는다.
- [x] 진단 보고서를 제품·보안·테스트 계약과 대조하고 프로젝트 항목과 사용자 HA 항목을 분리한다.
- [x] 기존 사용자 설정을 보존하면서 전역 `AGENTS.md`와 override가 모두 없을 때 Home Assistant 운영 안전 지침을 생성한다.
- [x] 생성·0644·기본본 일치, 기존 base/override/빈 파일/dangling symlink의 내용·mode 보존 회귀 테스트와 운영 문서를 추가한다.
- [x] `0.1.2-dev` amd64 build와 full Docker smoke, ttyd WebSocket, ShellCheck, Hadolint, YAML/Markdown lint를 로컬 검증했다.
- [x] PR [#5](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/5)의 push/PR CI 6개 job을 통과하고 merge commit `7105bcd`로 public `main`에 병합했다. final main CI run `29225737374`도 3개 job이 통과했다.
- 다음: 사용자가 App Store 저장소를 새로고침해 `0.1.2-dev`로 업데이트하고 새 Codex 세션에서 기본 운영 지침 적용을 읽기 전용으로 확인한다.

### 2026-07-13 — HAOS Ingress terminal TERM 회귀 수정

- HAOS 실기 결과: public repository 설치와 App 시작은 성공했다. Ingress는 `/` 200, `/token` 200, `/ws` 101까지 성공했지만 ttyd child에서 `open terminal failed: terminal does not support clear`가 발생해 Web UI가 재연결 상태가 됐다.
- 로컬 재현: S6로 부팅한 amd64 이미지의 실제 ttyd WebSocket을 Chrome으로 열어 같은 오류를 재현했다. ttyd는 `TERM=xterm-256color`를 주지만 `/command/with-contenv`가 child 환경에서 `TERM`을 제거하는 것이 원인이다.
- [x] HAOS 로그의 Ingress/nginx/WebSocket 성공과 ttyd/tmux 실패 경계를 확인한다.
- [x] S6 + ttyd + Chrome에서 같은 오류를 재현하고 TERM 전달 손실을 증명한다.
- [x] web entrypoint에서 `TERM=xterm-256color`를 복원하고 tmux 내부 TERM을 보존한다.
- [x] 실제 ttyd WebSocket shell 회귀 테스트를 Docker smoke에 추가했다.
- [x] `0.1.1-dev` amd64 build, 25 unit/policy tests, full smoke, Chrome 렌더·명령 입력을 검증했다.
- [x] changelog, 사용 설명서, 아키텍처, 테스트 계획을 실제 결과에 맞췄다.
- [x] PR [#3](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/3)의 CI를 통과하고 merge commit `b9e2808`로 public `main`에 병합했다. main CI run `29222324024`도 통과했다.
- 후속 실기: 사용자가 `0.1.1-dev` Web UI와 인증된 Codex 실행을 확인했다. resize와 브라우저 종료 후 tmux reattach는 계속 미검증이다.

### 2026-07-13 — public App Store 설치 전달

- 목표: Home Assistant 웹의 App Store에서 GitHub 저장소 URL을 추가해 `codex_home_assistant`를 바로 설치할 수 있도록 public `main`에 배포한다.
- [x] 공식 App repository 구조와 `image` 선택 항목·Dockerfile 소스 빌드 방식을 재확인했다.
- [x] public 저장소 URL 설치 안내와 지속적인 `main` 병합 규칙을 문서에 반영했다.
- [x] 저장소 visibility를 public으로 전환했다.
- [x] PR #1을 ready로 바꾸고 merge commit `ce06435`로 `main`에 병합했다.
- [x] public `main`의 `repository.yaml`, App `config.yaml`, Dockerfile을 인증 없이 조회했다.
- [x] `main` GitHub Actions run `29220740986` PASS — 최초 amd64 build의 Alpine CDN TLS 오류는 failed job 재실행에서 해소됐고 build/smoke가 통과했다.

### 2026-07-13 — amd64 MVP 런타임 구현 및 GitHub 전달

- 결과: Home Assistant base `3.24`, S6 v3, Codex CLI `0.144.1`, nginx Ingress ACL, loopback ttyd, 공유 tmux, 공개키 sshd, `/config` RW, Core/Supervisor helper를 구현했다. Codex/App/SSH 데이터는 `/data`, runtime token 환경은 `/run`에 둔다.
- 보안 결과: manager/Core API 권한은 유지하고 `admin`, `docker_api`, `full_access`, `host_network`, `apparmor: false`는 사용하지 않았다. SSH 비밀번호·keyboard-interactive·reverse forwarding·agent forwarding은 차단했다.
- 배포 결과: private GitHub 저장소의 `feat/mvp-runtime`에 구현 커밋 `95bc564`를 push하고 draft PR [#1](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/1)을 생성했다. `actions/setup-python`의 cache dependency 경로 누락은 `a09301a`에서 수정했으며 해당 head의 push/PR CI 6개 job이 모두 통과했다. private GHCR pull 문제 때문에 개발판 `image` 필드는 유보하고 Local Apps source build를 문서화했다.

### Verification

- [x] `0.2.0` amd64 local image build: PASS — Home Assistant base 3.24, `@playwright/mcp 0.0.78`, Playwright core `1.62.0-alpha-1783623505000`, Chromium Headless Shell 150, Node 24.17.0, Codex CLI 0.144.1, image label version/arch 일치. local Docker image size는 533,346,012 bytes다.
- [x] 최종 full Docker smoke: PASS — Codex system MCP discovery, proxy 제한, desktop 1440x900/mobile 390x844 DOM·PNG, console/uncaught page error, 200/302/404/500/transport failure, 모의 HA gateway 인증 REST/frontend/WebSocket/loopback 격리, output cleanup과 기존 ttyd/SSH/영속성 회귀를 확인했다.
- [x] public `0.1.3` → local `0.2.0` update smoke: PASS — 같은 `/data`·`/config`에서 user config, valid auth marker, AGENTS, HA config marker와 SSH host fingerprint 보존 후 새 Playwright MCP smoke 통과.
- [x] Linux Python 3.13 `pytest`: PASS — 39 passed, 0 skipped. browser supply-chain/config/proxy/gateway/update 계약, 기존 App/API/runtime/manifest/secret regression을 포함한다.
- [x] `yamllint`, ShellCheck 0.11.0, Hadolint 2.14.0, markdownlint-cli2 0.23.0, actionlint 1.7.7, Node/Bash syntax와 `git diff --check`: PASS.
- [x] 실제 HAOS/AppArmor의 Chromium 시작, 인증된 dashboard desktop/mobile·console·network/resource·WebSocket와 Home Assistant 구성 UI/Supervisor 일반 update: PASS — public `0.2.3` 사용자 확인. 상세 로그와 HAOS 버전은 제공되지 않았다.
- [x] `docker buildx build --platform linux/amd64 --load --tag codex-ha:0.1.3-dev ...`: PASS — base `3.24`, 공식 Codex SHA-256, `codex-cli 0.144.1`, image label `0.1.3-dev`.
- [x] Linux `python -m pytest -ra`: PASS — 30 passed, 0 skipped; 문서 manifest, 자산 계약, S6/runtime, API JSON/x-log 협상·header injection 거부, token redaction, secret scan.
- [x] `tests/docker-smoke.sh codex-ha:0.1.3-dev`: PASS — S6, `/config` RW, permissions, nginx/ttyd, 동일 tmux session/pane/pid 재접속과 96x32 resize, auto-start false/true, Codex 후 Bash 복귀, 공개키 SSH, 비밀번호 거부, UTF-8 env, host-key/config 영속성, invalid/no-key degraded recovery.
- [x] `shellcheck` 0.11.0: PASS — runtime/test shell scripts, warning 이상 없음.
- [x] `hadolint` 2.14.0, `yamllint`, `markdownlint-cli2` 0.23.0: PASS.
- [x] Home Assistant App linter 2.21.0: PASS — `0.1.3-dev` config와 icon/logo 포함.
- [x] `git diff --check`: PASS.
- [x] Windows OpenSSH → local Docker sshd: PASS — `/config`, `/data/codex`, `codex --version`, `codex app-server --help`, fake token presence without output.
- [x] GitHub Actions push/PR CI at `a09301a`: PASS — unit/lint, Home Assistant App config, amd64 build/smoke 각 2회, 총 6 jobs.
- [x] Public repository/main delivery: PASS — visibility PUBLIC, PR #1 MERGED, anonymous repository/App source reads, final main CI.
- [x] Local Ingress terminal regression: PASS — actual ttyd WebSocket handshake and command returned `/config`, `TERM=tmux-256color`; Chrome rendered the shell with no console warning/error.
- [x] HAOS App repository install/start: PASS — public 저장소 설치와 App/S6 서비스 시작 로그 확인.
- [x] Ingress TERM fix delivery: PASS — PR #3 merge commit `b9e2808`, final public `main` CI run `29222324024`의 3개 job 통과.
- [x] Persistent safety guidance delivery: PASS — PR #5 merge commit `7105bcd`, final public `main` CI run `29225737374`의 lint/unit, App config, amd64 build/smoke 통과.
- [x] 실제 Ingress/WebSocket shell과 인증된 Codex 실행: PASS — 사용자 `0.1.1-dev` Web UI 실기 확인.
- [x] 실제 HAOS UI resize/browser tmux reattach: PASS — 다른 브라우저/환경에서 이전 터미널·대화 복구와 resize를 사용자 확인했고 detached `codex-ha` session을 사후 확인했다. 동일 ID 기계 비교는 로컬 실제 WebSocket smoke가 보완한다.
- [x] 실제 HAOS auto-start false/true: PASS — 두 옵션의 의도된 shell/Codex 시작 동작을 사용자 확인.
- [x] App update Codex 인증 영속성: PASS — App 삭제 없이 연속 업데이트한 환경에서 로그인 상태와 인증된 Codex 실행 유지.
- [x] device code 로그인과 App 재시작 인증 영속성: PASS — 사용자 실기 확인.
- [x] Home Assistant Network 공개키 SSH와 remote app server: PASS — 사용자 mobile Remote → HAOS App 직접 SSH → `/config` E2E 확인.
- [x] 실제 `/config` write/rollback, Core REST 조회, Supervisor 조회/direct log/config-check: PASS — `/config` 임시 변경 정리, `/config`·`/states`·`/services`, Core/App direct logs, self/info, `/core/check` 확인.
- [x] `0.1.3-dev`의 `ha-core-logs`/`ha-addon-logs`: PASS — 사용자 별도 결과와 보고서에서 모두 rc 0/nonempty이며 direct `text/x-log` 요청과 helper 사이의 불일치나 negotiation 오류 없음.
- [x] 실제 Core service call: PASS — 임시 persistent notification 생성·dismiss 각각 rc 0, 정리 확인.
- [x] Core restart: PARTIAL — 0.3.1 memory 실기에서 명시적 승인 뒤 config check, Core 복귀, daemon 생존·재연결은 PASS했지만 related 오류가 반복돼 catalog fresh 복구는 FAIL했다.
- [ ] Supervisor/App start/stop/restart: NOT RUN — manager helper와 info/log/config-check는 PASS이나 운영 중단 동작은 명시적 유지보수 승인 없이는 실행하지 않는다.
- [x] 실제 HAOS의 기본 전역 `AGENTS.md`: PASS — 0644, 이미지 기본본과 byte 동일, 사용자 override 비파괴 정책 확인.
- [x] SSH host key 업데이트/재시작 전후 동일성: PASS — 사용자 실기 확인.
- Known issues: 공식 명시 Linux 지원은 Ubuntu/Debian 중심이지만 amd64 Alpine/musl remote app server는 사용자 E2E에서 동작했다. aarch64, 향후 Codex 버전 변경과 HAOS lifecycle 영향은 별도 검증 대상이다.

## M1 — 동작 가능한 amd64 MVP

### 1. 저장소 및 기본 골격

- [x] 기존 Git 상태와 remote 확인
- [x] remote가 없으면 private GitHub repo `codex-for-home-assistant` 생성
- [x] 현재 공식 `home-assistant/apps-example` 구조 확인
- [x] `repository.yaml`, App 폴더, `config.yaml`, `Dockerfile`, `rootfs`, 문서 골격 생성
- [x] `.gitignore`, `.editorconfig`, lint 설정 추가

### 2. 컨테이너 런타임

- [x] 최신 Home Assistant base image 선택 및 근거 기록
- [x] `bash`, `curl`, `git`, `jq`, `yq`, `yamllint`, `openssh`, `ttyd`, `tmux`, `sqlite`, `ripgrep` 설치
- [x] S6 서비스/초기화 구조 구현
- [x] `/data/home`, `/data/codex`, `/data/ssh`, `/data/tmux` 초기화
- [x] 민감 파일 권한 검증

### 3. Codex CLI

- [x] amd64에서 재현 가능한 설치 방식 선택
- [x] Codex 버전 pin 및 checksum 검증
- [x] `/usr/local/bin/codex` PATH 보장
- [x] `CODEX_HOME=/data/codex` 적용
- [x] 기본 `config.toml`을 비파괴 방식으로 생성
- [x] `ha-codex`, `ha-codex-login` 구현
- [x] `codex --version` 컨테이너 테스트

### 4. 웹 터미널

- [x] `ingress: true`, `ingress_stream: true` 구성
- [x] ttyd가 Ingress 하위 경로에서 정상 동작하도록 구현 (실제 HAOS Ingress는 M2)
- [x] tmux 세션 자동 생성/재접속 구현 (browser reattach는 M2)
- [x] `/config` 시작 경로 확인
- [x] `web_terminal_auto_start_codex=false` 동작 검증
- [x] `web_terminal_auto_start_codex=true` 동작 검증
- [x] Codex 종료 후 셸 복귀 검증

### 5. SSH 및 Remote SSH

- [x] 공개키 전용 sshd 설정
- [x] SSH host key를 `/data/ssh`에 영속화
- [x] `authorized_keys` 옵션 반영 및 권한 검증
- [x] 키가 없을 때 안전한 degraded 동작
- [x] 기본 host port `2223` 노출
- [x] login shell에서 `codex`, `CODEX_HOME`, `/config` 확인
- [x] Windows OpenSSH 접속 검증 (local Docker port; HA Network는 M2)
- [x] mobile Remote 직접 SSH app-server bootstrap 검증 — 사용자 E2E

### 6. Home Assistant API 운영 기능

- [x] `SUPERVISOR_TOKEN`을 웹/SSH 셸에서 안전하게 사용할 수 있도록 런타임 환경 구성
- [x] `ha-api` 래퍼 구현
- [x] `supervisor-api` 래퍼 구현
- [x] `ha-config-check` 구현
- [x] Core 로그 조회 helper 구현
- [x] App 로그 조회 helper 구현
- [x] REST/WebSocket 사용 예시 문서화
- [x] manager 역할 endpoint 검증표 작성 및 정보/direct log/config-check HAOS 실기 확인

### 7. 품질 및 문서

- [x] `shellcheck`, `yamllint`, Docker lint 적용
- [x] 단위/컨테이너 smoke test 추가
- [x] 실제 토큰이 출력되지 않는지 테스트
- [x] `DOCS.md`, `CHANGELOG.md`, `README.md` 작성
- [x] 한국어/영어 옵션 번역 추가
- [x] 위험 경고와 복구 절차 문서화

### 8. CI, GitHub, 배포

- [x] GitHub Actions lint workflow
- [x] GitHub Actions amd64 build workflow
- [x] GHCR publish 구조 — tag-gated official builder, generic/per-arch public packages, overwrite guard
- [x] App `image` 필드 적용 시점 결정 — 첫 non-dev/public GHCR pull 경로 확정 뒤 적용
- [x] 기능 브랜치 커밋/push — `95bc564`, `feat/mvp-runtime`
- [x] draft PR 생성 및 검증 결과 기록 — [#1](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/1)
- [x] public 저장소 전환과 PR #1 `main` 병합 — `ce06435`

## M2 — HAOS 실기 검증 및 첫 non-dev 릴리스

- [x] public App repository 설치와 App 시작
- [x] Ingress 웹 터미널과 인증된 Codex 실행
- [x] auto-start false/true 동작
- [x] 장치 코드 로그인 방식 확인
- [x] App 업데이트 후 Codex 인증 유지
- [x] SSH/Remote SSH 테스트 — mobile Remote의 HAOS App 직접 SSH
- [x] `/config` 파일 수정·롤백 테스트
- [x] Core API 상태·서비스 목록 조회
- [x] 안전한 Core service call — 임시 persistent notification 생성·dismiss와 정리
- [x] Supervisor 정보·로그와 Core 설정 검사
- [ ] Supervisor/Core/App start/stop/restart 테스트
- [x] 브라우저 끊김 후 tmux 기능적 재접속과 resize
- [x] App 업데이트/재시작 후 host key fingerprint 유지
- [x] `0.1.2-dev` 기본 전역 운영 지침 생성·기본본 일치·사용자 override 보존
- [x] `0.1.3-dev` Core/App 로그 helper HAOS 회귀 확인
- [x] 첫 non-dev release/tag/GHCR publish — `0.1.3`, public anonymous linux/amd64 pull/full smoke PASS
- [ ] 기존 `0.1.3-dev` HAOS 설치의 `0.1.3` 일반 업데이트 경로 — 사용자 확인 대기, 삭제/reset 불필요
- [x] Public `0.2.3` Home Assistant 구성 UI/Supervisor 일반 업데이트 경로 — 사용자 확인 PASS
- [x] Public `0.2.3` AppArmor 활성 상태의 인증된 `8099` dashboard desktop/mobile·console·network/resource·WebSocket — 사용자 확인 PASS
- [x] `0.2.4` validation/evidence tag/GHCR/prerelease — 익명 linux/amd64 pull, 공개 이미지 회귀와 동일 merge SHA native Linux 전체 smoke PASS
- [x] `0.3.0` 검증 기반 memory tag/GHCR/prerelease — 익명 linux/amd64 pull, 정확한 공개 이미지 memory/full/update 회귀와 동일 merge SHA main CI PASS; 실제 HAOS memory E2E는 NOT RUN
- [x] `0.3.1` memory live-refresh patch tag/GHCR/prerelease — 익명 generic/per-arch pull, 정확한 공개 이미지 memory/full/update 회귀와 동일 merge SHA main CI PASS; 후속 실제 HAOS에서 catalog FAIL/Core restart PARTIAL/privacy PASS
- [x] `0.3.2` automation related 격리 patch tag/GHCR/prerelease — 익명 generic/per-arch pull, 정확한 공개 이미지 memory/full/update 회귀와 동일 merge SHA main CI PASS; 후속 실제 HAOS/Core 2026.7.2 재시험은 핵심 memory·restart 후 fresh sync PASS, runtime digest와 Core disconnect/reconnect·LKG 관측 공백으로 PARTIAL(FAIL 0)
- [x] `0.5.0` 검증형 memory 사용자 폐루프 tag/GHCR/prerelease — 익명 generic/per-arch pull, 정확한 공개 이미지 full/memory/browser-policy/managed-auth/user-file/public `0.4.0` update 회귀와 동일 merge SHA main CI PASS; 실제 HAOS 자연어 same-request 학습·새 task 회상·지속 변경 fresh 검증은 NOT RUN

## M3 — aarch64 및 안정화

- [ ] Codex CLI aarch64 바이너리/런타임 검증
- [ ] multi-arch CI
- [ ] aarch64 HAOS 실기 테스트
- [ ] `arch`에 aarch64 추가
- [ ] 설치·복구 UX 개선
- [ ] stage를 experimental에서 stable로 바꿀 조건 평가

## Open Questions / Required Spikes

| ID | 질문 | 현재 처리 |
|---|---|---|
| Q-001 | Codex standalone 바이너리가 선택한 Alpine/base image의 amd64 및 aarch64에서 안정적인가? | amd64 CLI/app-server help 로컬 PASS; aarch64는 M3 |
| Q-002 | ttyd의 Ingress base path/WebSocket 처리가 추가 플래그 없이 가능한가? | nginx/ttyd 로컬 PASS; 실제 Supervisor Ingress는 M2 |
| Q-003 | Codex `workspace-write` sandbox가 HAOS App 컨테이너에서 정상 작동하는가? | MVP는 container 내부 `danger-full-access`; 이후 비교 테스트 |
| Q-004 | `manager` 역할에서 필요한 Supervisor 엔드포인트가 모두 허용되는가? | endpoint별 통합 테스트로 확인; admin 자동 승격 금지 |
| Q-005 | 실제 사용자 HAOS 아키텍처는 무엇인가? | 최초 MVP는 amd64; 확인·검증 후 aarch64 추가 |
| Q-006 | mobile Remote 직접 SSH가 Alpine/musl 원격 app-server를 정상 시작하는가? | 사용자 E2E PASS; Codex/아키텍처 변경 시 재검증 |

## 최근 완료 기록

### 2026-07-13 — HAOS 진단 검토와 비파괴 Codex 운영 가드레일

- 진단 분류: 사용자 자동화 Repairs, 서드파티 통합/앱 경고, Core 업데이트, `/config` 파일 mode는 App 런타임 결함이 아니며 진단만으로 자동 수정하지 않기로 했다. 실환경 보고서 원문과 식별정보는 저장소에 포함하지 않았다.
- 실기 증거: `0.1.1-dev` Web UI와 인증된 Codex 실행, 실제 `/config` write, Supervisor Core/Supervisor/host/OS info·logs와 `/core/check`를 확인했다. Core REST service call, 운영 restart, 인증 영속성은 완료로 표시하지 않았다.
- 개선: 두 전역 지침 파일이 모두 없을 때만 `/data/codex/AGENTS.md`를 생성하고 기존 base/override/빈 파일/symlink의 내용과 mode를 보존한다. 진단과 변경 권한 분리, 비밀 비노출, `.storage`/DB 보호, config check, 고위험 승인 규칙을 담았다.
- 검증: `0.1.2-dev` amd64 build/full smoke, 실제 ttyd WebSocket, 기존 지침 보존 fixture, Linux 26 tests, ShellCheck/Hadolint/YAML/Markdown/App lint PASS.
- 배포: PR [#5](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/5)을 merge commit `7105bcd`로 public `main`에 병합했고 final main CI run `29225737374`가 통과했다.
- 남음: 실제 HAOS에서 `0.1.2-dev`로 업데이트한 뒤 새 Codex 세션이 기본 전역 지침을 읽는지 확인한다.

### 2026-07-13 — Ingress terminal TERM 수정 배포

- HAOS 증거: repository 설치/App 시작과 Ingress `/` 200, `/token` 200, `/ws` 101은 성공했다. tmux는 `terminal does not support clear`로 실패했다.
- 원인: ttyd의 연결별 `TERM=xterm-256color`가 S6 `with-contenv`에서 제거됐다.
- 수정: web entrypoint의 외부 TERM 복원, tmux pane TERM 보존, App `0.1.1-dev` version bump, rootfs LF 강제.
- 로컬 검증: 실패 재현 후 actual WebSocket shell `/config:tmux-256color`, Chrome 입력·출력, amd64 build/full smoke PASS.
- 배포: PR [#3](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/3)을 merge commit `b9e2808`로 public `main`에 병합했고, final main CI run `29222324024`가 통과했다.
- 후속: 사용자가 `0.1.1-dev` Web UI와 인증된 Codex 실행을 확인했다. resize/tmux reattach는 미검증이다.

### 2026-07-13 — public App repository main 배포

- 결과: 저장소를 public으로 전환하고 PR #1을 `main`에 병합해 Home Assistant App Store에 `https://github.com/Kanu-Coffee/codex-for-home-assistant`를 추가할 수 있게 했다.
- 배포 검증: public GitHub 페이지와 raw `repository.yaml`, App `config.yaml`, Dockerfile을 인증 없이 조회했다.
- 자동 검증: merge commit `ce06435`의 main CI에서 App config, lint/unit, amd64 build/smoke가 모두 PASS했다. 최초 build attempt의 Alpine CDN TLS 오류는 재실행에서 정상 통과했다.
- 미검증: 실제 HAOS 설치·시작, Ingress, device auth, Network SSH, ChatGPT mobile Remote 직접 SSH, 실제 Core/Supervisor 호출은 사용자의 M2 테스트 결과를 기다린다.
- 다음: 사용자가 amd64 HAOS App Store에서 public 저장소를 추가하고 설치·사용한 뒤 오류와 수정사항을 전달한다.

### 2026-07-13 — amd64 local MVP

- 결과: 설치 가능한 Local App source, Codex CLI, Ingress terminal runtime, 공개키 SSH, API helper, CI와 운영 문서를 구현했다.
- 로컬 검증: amd64 build, 24 unit/policy tests, full Docker smoke, App/shell/YAML/Markdown/Docker lint와 secret scan 통과.
- 미검증: 실제 HAOS Ingress, device auth/update persistence, Home Assistant Network 2223, ChatGPT mobile Remote 직접 SSH, 실제 Core/Supervisor manager API.
- 전달: 구현 커밋 `95bc564`, 전달 기록 `29c67b5`, CI 수정 `a09301a`를 private origin에 push하고 draft PR #1을 생성했다. `a09301a`의 원격 CI 6 jobs는 모두 PASS했다.
- 다음: HAOS amd64에서 M2 E2E를 수행하고 검증된 결과만 PR에 반영한다.

### 2026-07-12 — DDD baseline

- 목표: 합의된 요구사항을 구현 가능한 문서 세트로 정리
- 결과: `rules.md`, `progress.md`, 제품/아키텍처/보안/테스트/Git 문서 작성
- 검증: 문서 파일 생성 및 ZIP 무결성 검사 예정
- 다음: `master_prompt.md`로 M1 구현 시작
