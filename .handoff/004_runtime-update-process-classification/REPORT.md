# REPORT — task 004 Executor 실행 결과

- 작성: Executor, 2026-10-17 (Asia/Seoul).
- 입력: 같은 디렉터리 `PLAN.md`(Planner, 2026-10-17). 기준 HEAD `11b8839`, branch `main`.
- 범위: PLAN §5 A~C 구현·로컬 검증, §D 격리 관측. 버전 상승·배포·외부 Git 작업·실제 HAOS 변경은 수행하지 않았다. 커밋은 하지 않았다(작은 파일 단위로 미커밋 working tree에 유지; push/PR 없음).

## 1. 변경 파일

| 파일 | 변경 |
| --- | --- |
| `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` | 분류·집계·적용 판정·status/output 재작성(아래 §2). 신규 export: `PACKAGE_EXECUTABLE_ROLES`, `canonicalPackageRole`, `executableEntrypoint`, `parseCodexInvocation`. `inspectProcess`에 ppid 추가. |
| `codex_home_assistant/rootfs/usr/local/bin/codex` | session record용 subcommand/`--listen` 판별을 positional option-skip 루프로 교체(runtime `parseCodexInvocation`과 규칙 공유; `--listen=unix://` 대응, option 값의 `app-server` 문자열 무시다. 기존 `update` 라우팅 루프는 시험 호환 유지 위해 그대로). |
| `tests/test_codex_update_contract.py` | 분류 회귀 fixture 9개 추가(§4). |
| `docs/development/{rules,product_spec,architecture,test_plan,progress}.md` | 변경된 분류 동작과 유지된 보호 조건 기록. progress는 Planner·사용자 기존 항목 보존 후 실행 항목 추가. |
| `codex_home_assistant/DOCS.md`, `DOCS.en.md`, 루트 `README.md`, `README.en.md` | 세션 수≒프로세스 수 오독 방지, helper/companion 귀속, Remote 정상 종료 안내, unknown 보수 보류 설명. |

미변경(계획대로): `codex-server-transaction.mjs`, `codex-updater-daemon.mjs`, 일별 12회 예산·5분 재검사·일 4회 network·rolling 24h cooldown·loaded conversation 보호·fail-closed·권한 불변조건. `CHANGELOG.md`는 버전 미상승으로 수정하지 않았다(배포 준비 시 Reviewer 판단).

## 2. 분류 기준(구현 내용)

1. **정체성 우선, 문자열 금지.** 세션 후보는 (a) `/proc/<pid>/exe`가 baseline·`releases/<1 segment>` 정확 경계의 허용 상대 경로(`bin/codex` primary; `bin/codex-code-mode-host`, `codex-resources/bwrap`, `codex-path/rg`, `codex-resources/voice/bin/codex-voice-host`, `codex-resources/zsh/bin/zsh` companion — 2026-10-17 공식 `rust-v0.162.1` amd64 package 실물 열거로 확정 allowlist), 또는 (b) PID+start-time이 유효한 등록 record. shebang interpreter 실행(격리 fixture·향후 signed script)은 exe basename이 interpreter set에 속하고 argv[1..2]의 정확한 위치가 해당 entrypoint realpath이며 파일 header가 `#!`일 때만 정체성 인정. prefix가 아닌 segment 경계라 `/data/codex-runtime-evil` 같은 형제 경로 오매칭이 없고, `(deleted)` exe는 suffix 정화 후 경계 판정. argv에 `/bin/codex`·`app-server`·runtime 경로가 **데이터로만** 들어간 프로세스는 어떤 분기도 통과하지 않는다.
2. **단일 inventory.** registry records와 `/proc` scan을 한 Map(pid)에서 합쳐 등록 CLI의 중복 계상을 제거했다. record는 start-time 불일치 시 제거(PID 재사용·정상 소멸), registry에서 제거되고 미식별 프로세스는 계상되지 않는다. `/proc`·record 디렉터리 읽기 실패는 기존대로 `sessionCount:-1` fail closed.
3. **역할 귀속.** companion은 조상 chain(`/proc` ppid, depth 32)에 식별된 cli/app-server owner가 있으면 helper로 귀속되어 독립 blocker·세션 수가 되지 않는다(owner busy면 이미 보류). owner를 증명 못한 companion/신원 불명 프로세스는 `unknown` blocker로 보수 보류하며 CLI/대화라고 단정하지 않는다. release cleanup은 기존 exe/fd/cwd/mmap 참조 보존 로직 그대로라 live old helper가 old generation을 지우지 않는다; owner 교체 후 잔류 companion도 정리·종료하지 않고 관측만 한다.
4. **idle과 apply eligibility 분리.** `isIdle`(blocker+서버 없음), `canApply`(blocker 없음; 검증된 idle 관리형 unix app-server 단독이면 cooldown 허용 시 replacement transaction 진행), `counts`(detectedProcesses/cli/helpers/managedIdleServers/remoteStdio/unmanagedAppServers/unknown), 타입 있는 `blockers`·`blockerTypes`, `state.lastBlocker`(cli/remote_stdio/unknown/server_busy/unmanaged_server/bad_socket/socket_inaccessible/daily_budget_exhausted/restart_cooldown)를 추가. 관리형 서버 요건(launch record 일치+socket 실체+1초 간격 두 번 idle 진단)과 signal 직전 재검사·graceful drain·rollback은 무변경.
5. **wrapper/parser parity.** subcommand는 option-skip 후 첫 positional, `--` 이후는 prompt(data)로 취급, `--listen`과 `--listen=` 양형식, injected `-c`/`--add-dir` pair가 script position을 침범하지 않음을 shell 블록 추출 실행 테스트와 node 단위 테스트가 같은 입력 벡터로 함께 검증.
6. **노출 정책.** status JSON/text는 정제된 count·type·reason과 pid만 노출. argv 원문·cwd·socket 원문·prompt·thread ID·인증값을 새로 넣지 않았다(`SUPERVISOR_TOKEN` scrub 회귀 테스트 통과). 기존 JSON key는 삭제하지 않고 `activeSessions`(프로세스 수 의미 문서화)·`isIdle`을 유지했다.

## 3. production 재현 경로

테스트 전용 분기를 폐기했다: `CODEX_RUNTIME_DIR` 설정 여부와 무관하게 동일한 `canonicalPackageRole`/`executableEntrypoint`/`parseCodexInvocation`과 같은 inventory 코드가 실행된다. fixture는 baseline dir과 `releases/<segment>` layout·shebang entrypoint까지 실제 package shape를 모방하고 실제 subprocess·실제 unix socket을 사용한다. 이미지 내 확인은 §5.

## 4. 명령과 실제 결과

| 검사 | 결과 |
| --- | --- |
| 수정 전 실패 fixture(8개 분류 test) | 8/8 FAILED(재현: argv-data decoy busy, 등록 CLI 2중 계상, companion 독립 blocker, `--listen=` remote 오인, orphan companion CLI 오분류 라벨, `processSummary` 부재) |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py` | 통과(구현 후 110 collected 영역 전부) |
| `.venv/bin/pytest -q`(전체) | **226 passed, 2 skipped**(skip: apparmor_parser·Grype 미설치의 기존 환경 항목) |
| `node --check` 변경 mjs / `bash -n`·`shellcheck -x` wrapper | PASS |
| `markdownlint-cli2@0.23.0` 전체(기존 CI 설정) | 0 errors |
| `git diff --check`, diff secret scan(키워드 후 수동 확인) | CLEAN(식별된 `token`은 전부 argv 파싱 지역변수) |

## 5. 실제 바이너리 격리 검증(amd64, unconfined 컨테이너)

`docker build --platform linux/amd64 -t codex-ha:004-test codex_home_assistant` 성공(exit 0) 후 사용자 `/data`·`/config`·인증 volume 없이 임시 컨테이너에서:

- 실제 wrapper `codex app-server --listen unix:///tmp/004-smoke.sock` → record `{type: app-server, managed: true, socketPath: /tmp/004-smoke.sock, version: 0.162.1, exe: …/codex-baseline/bin/codex}` 정확 등록.
- `inspectAllSessions()`(production 코드, env override 없음): `restartable=[pid 27]`, `busyReasons: []`, `canApply: true`, `sessionCount: 1`, `managedIdleServers: 1` — 실제 0.162.1 서버의 실 diagnostics 양쪽 idle 통과.
- 동시 decoy(`bash -c 'cd /data/codex-runtime && echo /usr/local/bin/codex app-server codex-real && sleep 30'`, `python3 -c … /usr/local/bin/codex app-server /data/codex-runtime/releases/...`) → `detectedProcesses: 1` 유지, busy 0. helper 계상·독립 blocker 없음.
- `ha-codex-update status` text에 `Codex processes: … [CLI/TUI 0, managed idle server(s) 1, …]`·`Auto-apply ready` 신규 행 노출 확인, `getStatus()` JSON에 `processSummary/blockerTypes/lastBlocker` 확인.
- 서버 SIGHUP → graceful exit 확인. 컨테이너·임시 file 정리 완료; 이미지 `codex-ha:004-test`는 Reviewer 재검증용으로 보존(운영 태그 미변경).

## 6. §D Remote stdio 관측 결과

실제 0.162.1 stdio app-server를 파이프 stdin으로 격리 실행:

- writer 생존 중: `blockerTypes: ["remote_stdio"]`, busy reason "restart unsupported, deferred until session exits" — **보류 유지(보호 불변)**.
- stdin EOF(writer 종료 = 연결 정상 종료 유사): 프로세스가 **스스로 종료**하고 이후 inspect가 idle(detectedProcesses 0). 잔류·고아 없음.

판정: **지원 가능 = "사용자의 정상 연결 종료 후 다음 재확인부터 적용"**까지이며 text/guidance·DOCS에 그대로 기록했다. **지원 불가/미검증 = 업데이터가 기존 SSH stdio 연결을 보존한 채 서버 generation만 교체·재연결** — 업데이터가 그 transport를 재연결할 근거가 없고 stdin/stdout 진단 삽입은 금지 규약대로 하지 않았다. age/PPID로 stale 증명 시도 금지 유지. 연결 보존 교체·unknown 원격 프록시는 이 버그 수정에 섞지 않았고, 필요 시 다음 번호 handoff 제안으로 남긴다.

## 7. helper-only 성공과 Remote 동시 존재를 구분한 기록

- helper/companion·argv-data만으로 보류하던 상황: §4 fixture + §5 실이미지 observation에서 해소 확인(helper-only idle → `canApply: true`, 교체 경로 유효 — 교체 자체는 002 회귀 transaction이 커버, 본 실행에서 재사용 확인).
- 실제 Remote stdio가 살아 있는 상태: 여전히 정상 보류(`remote_stdio` blocker)하며 사유·해소 조건이 노출된다. **장기 Remote가 있는 모든 설치의 자동 적용이 해결됐다고 주장하지 않는다**(PLAN §5D 완료 정의 준수).

## 8. PLAN 대비 조정(materials)

1. wrapper의 `update` 라우팅 루프에는 `--add-dir`을 추가하지 않았다(record subcommand 루프에만 추가). 기존 `update` intercept 계약 test가 정확한 case-list 문자열을 고정하고 있어서이며, user-arg `--add-dir X update` 시나리오는 어느 쪽이든 busy/defer 안전 동작이다. runtime parser는 injected `--add-dir`를 skip한다.
2. blocker type 명명: `unknown`(PLAN 문구의 "unknown blocker"), diagnostic 실패는 `inspection_failed`, socket/서버 세부 실패는 `bad_socket`/`socket_inaccessible`/`unmanaged_server`/`server_busy`로 분리 — status·guidance 문구가 구분한다.
3. `state.lastBlocker`를 신설해 "12회 소진 vs cooldown vs current blocker" 구분 요구를 충족했다(PLAN §C의 reason code 최소 구현).
4. companion allowlist에 `codex-voice-host`·`zsh` 포함 — 실 package 열거 결과(§2-1)에 근거. 미지의 package 내 executable은 allowlist에 없어 계속 `unknown` 보수 보류다.
5. 신규 옵션·버전 상승·metadata 변경 없음(PLAN 기본 범위 준수). 커밋 없음: 작업트리가 사용자 진행 변경(progress.md)과 섞여 있어 Reviewer diff 검토 후 커밋 승인이 safer하다고 판단 — 명시적 commit 요청 시 의미 단위(`fix: classify runtime-update processes by executable identity`)로 나눠 수행 가능.

## 9. 남은 검증·위험(NOT RUN)

- `bash tests/codex-update-smoke.sh <image>` 전편과 `tests/apparmor-boot-smoke.sh`: 이 머신에 `apparmor_parser`가 없어 enforced profile을 로드할 수 없었다(policy probe가 enforce profile을 요구) — **NOT RUN**. §5 검증은 의도적으로 unconfined이며 policy probe·실제 symlink replacement transaction 부분은 002/003의 VM/enforced 증거에 의존한다. enforced smoke 재현은 HAOS VM(003 방식)에서 Reviewer 승인 하에 필요.
- 실사용자 HAOS 재진단(`hf_ac764d25d7a492e5` 장비 포함)에서의 helper 실소유 구조, paused 상태 해소, 실 CLI/TUI busy 보호 재확인: **NOT RUN**(설비 재접속 없음).
- Remote 종료 후 실환경 재검사 적용·`lastApplyAt` 관측, 활성 대화·approval 대기 중 무교체, 관리형 idle 서버 단독 실교체(cooldown 경계): fixture/container 증거만 확보, HAOS 수용 **NOT RUN**.
- aarch64 native: 분류 로직은 arch-중립이고 amd64만 실행 — ARM 실실행 **NOT RUN**.
- 관측 중 프로세스 종료·PID 재사용 race: start-time 재확인으로 정상 소멸/검사 실패를 구분하는 경로를 유지했고 transaction의 signal 직전 재검사 불변이나, 실시간 race 재현은 fixture 수준.
- `cat <package-entry>`류 argv-파일노출 false-positive: interpreter가 아니면 정체성 불인정이라 ignore 되며, interpreter가 정확 위치에서 package entry를 참조하는 경우는 보수적 busy 방향으로만 동작(완전 차단 오인의 잔존 가능 지점).

## 10. 다음 행동(Reviewer)

- §2 판별 규칙과 §8 조정한계의 수용 여부, §9의 enforced smoke·HAOS 수용 공백에 대한 배포 게이트 요구를 검토하고, 필요 시 `FIX_01.md` 작성. 미요구 시 승격 판정 후 commit과 DEV 발행 범위를 명시적으로 승인해 주세요.
