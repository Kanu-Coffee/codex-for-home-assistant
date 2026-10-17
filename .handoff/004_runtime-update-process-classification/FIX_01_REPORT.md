# FIX_01_REPORT — task 004 수정 라운드 Executor 결과

- 작성: Executor, 2026-10-17 (Asia/Seoul).
- 입력: 같은 디렉터리 `FIX_01.md`(Reviewer/Codex, 2026-10-17). 기준: `main`, HEAD `11b8839`, Reviewer 검토 시점의 미커밋 working tree.
- 처리: highest-numbered 미실행 fix(FIX_01)의 F1(P1)·F2(P2)·F3(P2)와 추가 검증 요구를 수행했다. `PLAN.md`/`REPORT.md`/`FIX_01.md`와 사용자·Planner·이전 Executor 변경은 덮어쓰지 않았다. 커밋/push/HAOS/ARM/버전 상승은 수행하지 않았다(범위 외).

## 1. F1 — package 경계 내부 미식별 executable의 unknown 보류

수정(전): 경계 판정(`packageBoundary()`)과 역할 allowlist 판정(`canonicalPackageRole()`)을 분리했다. `/proc/<pid>/exe`가 정확히 baseline 또는 단일 release generation 내부면 role allowlist 유무와 무관하게 inventory에 남고, role을 확인 못한 경계 내부 executable은 분류 결과에 `unrecognized`으로 남아 blocker type `unknown`("unrecognized executable inside managed codex package; held until identity is verified")이 된다. interpreter 실행 branch도 같은 boundary를 사용해 realpath+shebang 확인 후 role 확인 여부를 보존한다. allowed companion의 owner 귀속은 실제 allowlist role을 확인한 경우에만 유지하고, orphan은 이전처럼 `unknown`이다. broad substring 매칭은 되살리지 않았다.

회귀(`test_unrecognized_package_executable_is_held_unknown`): 실제 ELF(node 바이너리 copy; `/bin/sleep`은 argv[0] dispatch라 사용 불가)를 baseline과 release 양쪽 경계 내부에 배치해 2개 `unknown` blocker와 `canApply false` 확인, release 쪽은 exec 후 unlink해 `(deleted)` exe에서도 동일 보류, canonical 형제 경로(`<runtime>-sibling/releases/...`)는 무시 유지, 프로세스 종료 후 재 inspect에서 idle/canApply 해소 확인. 수정 전 실패(blockers 빈 배열) → 수정 후 통과.

실환경 관측: 재빌드 `codex-ha:004-test` 안에서 baseline bin 사본 `codex-future-x`를 `app-server --listen unix://`로 실행 → `types:["unknown"]`, `busy:[ "[unknown] unrecognized executable …(pid 31)" ]`, `canApply false`; 종료 후 `isIdle true`. 미식별 binary가 app-server처럼 동작해도 restartable로 취급하지 않는다.

## 2. F2 — lastBlocker 영속화와 예산/cooldown 의미 구분

수정: `LAST_BLOCKER_CODES`(cli, remote_stdio, unmanaged_server, bad_socket, socket_inaccessible, server_busy, unknown, inspection_failed, daily_budget_exhausted, restart_cooldown)를 export하고 `loadState()` 정상/실패 default와 `saveState()` sanitize에 연결했다. allowlist 밖 문자열은 sanitize되어 null로 저장되며 임의 원문·경로는 state.json에 남지 않는다. 구버전 state에는 필드가 없어 null로 읽힌다. 의미 확정:

- busy 검사를 실제로 수행한 시도(`pending_busy`/검사 중 예산 소진)에서는 `lastBlocker` = 그 검사의 첫 process blocker type. 12회째 전환에서도 `cli`/`remote_stdio` 등 프로세스 원인이 유지되고, 예산 소진은 `status paused_busy`·`idleCheckCount 12/12`·`nextRetryAt`(다음 날)과 reason 문자열로 구분된다.
- 검사 이전에 스킵하는 경로는 기록을 덮지 않는다: 12회 도달 후 재진입하는 pre-inspection 분기에서 기존 `daily_budget_exhausted` 대입을 제거했다(이전값이 process blocker면 유지). cooldown+budget 분기는 blockers가 비어 있는 검사 결과이므로 `daily_budget_exhausted`/`restart_cooldown`이 유효하다.
- 적용 성공 시 null 초기화(양쪽 경로).

검증: `test_last_blocker_round_trips_and_sanitizes` — updateState→loadState, **별도 Node 프로세스의 `status --json`**에서 `remote_stdio` 유지, state.json에 lastBlocker 존재, 임의 문자열 시도 시 load null + 파일에 원문 부재(non-leak), null로 초기화. `test_budget_paused_busy_keeps_process_blocker_type` — 13회 시도에서 `lastBlocker`가 계속 `cli`, 12번째 `paused_busy` 전환도 `cli`, 13번째(reason `paused_busy`)도 덮어쓰지 않음. 문서(DOCS.md/DOCS.en.md status 안내)와 출력 필드 의미를 정렬했다. 수정 전 실패(status null round trip, 13th `daily_budget_exhausted`) → 통과.

## 3. F3 — 실제 bundled 버전의 값 있는 global option 정합

근거 조사(실행 버전 기준): `docker run --rm --network none --entrypoint /usr/local/libexec/codex-real codex-ha:004-test --help`로 0.162.1의 global option면을 확인했다. 값 소비 확인: `-m/--model`, `-c/--config`, `-C/--cd`, `-p/--profile`, `-s/--sandbox`, `-a/--ask-for-approval`, `--enable`, `--disable`, `--remote`, `--remote-auth-token-env`, `--local-provider`, `-i/--image`(다중값; 첫 값만 소모 — 미소비 잔여는 positional로 보수 처리), `--add-dir`, `--listen`(앱 고유), `--profile` attached(`-pVALUE`)·`--opt=value` form. 거대한 parser를 만들지 않고 이 최소 set을 양쪽에 추가하고, 불명확 syntax는 첫 positional 잔여로 남아 CLI busy로 보류되는 보수 방향을 택했다.

수정: `parseCodexInvocation()` OPTION_WITH_VALUE 확장, wrapper의 session-record subcommand 루프 value-option case 확장, `codex update` 라우팅 루프에도 같은 value-skip과 attached form을 반영(`-p home update`, `-a never update`, `--remote … update`가 실제 업데이터로 라우팅되도록; 기존 bash case-list 문자열 test는 실제 동작 회귀로 갱신). 두 구현의 공통 버그를 잡기 위해 벡터를 실도움말 기준으로 삼았고, mock 통합(`test_managed_server_with_global_option_prefix_is_restartable`: `-p home app-server --listen unix://…` + 실레코드 → restartable/`canApply true`), wrapper 블록 추출 실행, update 라우팅 추출 실행 test를 추가했다.

실환경 주의점(정정 포함): 실 app-server 런타임은 `-p/--profile`를 거부한다("Error: --profile only applies to runtime commands and `codex mcp` …", 실이미지에서 관측). 따라서 Reviewer 재현 벡터 `-p home app-server --listen unix://`는 실제 서버 기동까지 가지 않으며, 실그림 통합 증명은 app-server가 허용하는 `--enable web_search app-server --listen unix://…`로 확인했다(record `type app-server`/`managed true`, restartable). `-p` 벡터는 argv 문법 파싱·record 수준 회귀로만 검증했고 "실서버 restartable"로 주장하지 않는다.

## 4. companion·replacement 통합(Reviewer 추가 요구)

`test_companion_server_real_replacement_preserves_old_generation_while_helper_lives`: 관리형 idle unix 서버가 `bin/codex-code-mode-host` 실제 child를 거느린 상태에서 `applyUpdate()`를 실행했다. 확인 항목: 검사 전 busy 0·restartable 1(실 pid), 정책 probe injection 없는 integrity/tree/version preflight 통과, 적용 성공(`applied true`, `version/selectedVersion 0.163.0`, `lastBlocker null`), 구 서버 pid의 graceful 종료(reaped), 동일 socket을 새 executable이 승계(`afterRestartable` 1, pid 상이, 새 server는 mock companion non-respawn), 생존한 old-generation helper는 owner 상실로 `unknown` 단독 blocker(독립 CLI 계상 금지, `canApply false`), old release generation은 helper의 실 exe 참조로 cleanup에서 보존(디렉터리 존재 확인). old helper가 완전히 종료되면 해소 경로는 F1 test에서 별도 검증한다.

## 5. 실행한 명령과 실제 결과

| 명령 | 결과 |
| --- | --- |
| FIX_01 신규 fixture 7개, 수정 전 | 7/7 FAILED(재현 근거 §1~§3의 각 실패 지점) |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py`(파일 전체, FIX 후) | 97 passed |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py`(FIX 후) | 109 passed |
| `.venv/bin/pytest -q`(전체, FIX 후·문서 수정 후 2회) | **233 passed, 2 skipped**(skip: apparmor_parser·Grype 미설치의 기존 환경 항목) |
| `node --check` / `bash -n`+`shellcheck -x`(wrapper) | PASS |
| `markdownlint-cli2@0.23.0`(CI 동일 설정) | 0 errors |
| `git diff --check`, diff secret scan | CLEAN |
| 이미지 재빌드 + 실Codex 관측 | §1 unknown 보류/해소, §3 `--enable` 벡터 record+restartable, 컨테이너 즉시 삭제, 사용자 volume 미연결 |

수치 정정(Reviewer 지적): 첫 `REPORT.md`의 "전체 pytest 226 passed, 2 skipped"는 9개 fixture와 wrapper parity test 추가 이후 시점의 정확한 결과였고, `progress.md`의 "225"는 wrapper parity test 추가 직전 전체 실행, Reviewer의 pair 102는 시점 차이(90 update + 12 runtime)다. 처음 REPORT §4의 pair "101 passed"는 89 update + 12 runtime당시의 정합 값이었으나 "110 collected 영역"이라는 본문 표현은 부정확했다. 명령·대상·시점(`-q <pair>`, `-q <file>`, `-q <all>`)이 위 표로 통일되며 증거 없는 수치는 승계하지 않는다. 현재 기준: file 96 / pair 109 / 전체 233.

## 6. 기존 REPORT 주장 정정

- REPORT §2-4의 "미지의 package executable은 계속 `unknown` 보수 보류"는 구현상 사실이 아니었다(allowlist 밖 경계 내부가 조용히 제외됨). F1에서 실제로 구현·검증했다.
- REPORT §2-6/§8의 lastBlocker 기록은 파일 영속화 전에 동일 프로세스에서만 관찰되는 미완 상태였다(F2). 현재 status 명령 간 round trip이 동작하며 의미 정의는 §2와 DOCS에 정렬했다.
- REPORT §8-5 "helper-only 교체 경로 확인"은 inspect 단계의 restartable 판정까지였다. §4의 실교체 통합 test로 replacement/new executable/rollback 경계(old helper 잔류 시 unknown 보류+generation 보존)까지 확인했다.
- REPORT §5 실wrapper observation은 plain `app-server` 벡터만 수행했다. F3로 global-option prefix 벡터(`--enable` 실 확인, `-p` record 수준)를 보완했다.

## 7. changelog 처리 근거(Reviewer 요구 기록)

App/bundled 버전 상승과 배포가 요구 범위가 아니어서 `codex_home_assistant/CHANGELOG.md`는 수정하지 않았다. Supervisor UI가 version block만 렌더하는 파일에 Unreleased 항목을 미리 넣으면 이미지 발행 전 사용자 화면에 왜곡 노출될 수 있어, 이번 변경 의미는 DOCS.md/DOCS.en.md의 자동 업데이트 섹션과 progress.md·handoff에 기록했고, 실제 배포 준비(버전 상승) 시 Reviewer 판단으로 changelog 항목으로 승격한다.

## 8. 남은 검증(NOT RUN)

- enforced AppArmorprofile 아래 `tests/codex-update-smoke.sh` 전편과 boot gate: 호스트에 `apparmor_parser` 부재로 **NOT RUN**(probe 요구 약화 없음).
- 실제 사용자 HAOS의 helper 실수명·소유 구조, paused 상태 해소, Remote 종료 후 적용, 실busy CLI 보호, 모바일 Remote 수용: **NOT RUN**.
- aarch64 native 실행: **NOT RUN**(amd64 관측만).
- 실app-server `-p` 거부 동작은 확인했지만, 거부되는 option combination을 통한 server state는 검증 대상이 아니며 §3의 record-level 회귀로만 보존한다.
- working tree는 미커밋 상태 유지(12+개 tracked 변경과 `.handoff/004_*` untracked). 커밋·push·PR은 사용자 승인 범위.

## 9. 다음 행동(Reviewer)

- F1~F3과 §4 통합 증거의 수용 여부 판정. 인수 시 배포 준비 범위(버전·changelog·Builder·GHCR·HAOS 수용)를 명시적으로 분리 승인하고, 미흡 시 `FIX_02.md`로 회신 바란다.
