# PLAN — 이슈 #71 기본 소켓 식별과 자동 업데이트 관측 개선

- 작성: 2026-11-10 (Asia/Seoul), Planner: Codex.
- 대상: [GitHub issue #71](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/71), 조회 시 OPEN, enhancement, 댓글 0개.
- GitHub 생성/수정: 2026-11-09T21:00:48Z. 본문 보고서 생성 시각과 GitHub 제출 시각은 다르다.
- 목표 버전: `0.7.4-dev.N`에서 개발·검증한 뒤 `0.7.4` Stable 반영.
- 이번 산출물: 신규 PLAN과 progress 기록만 작성. 구현·버전 변경·commit/push/PR/merge/tag/release·운영 HA 변경은 수행하지 않는다. 이후 외부 게시와 실제 HA 시험도 해당 실행 요청/승인 범위에서 수행한다.
- 번호: 기존 최대 007 다음 008. 완료된 task 007 및 FIX/REPORT를 수정하거나 재개하지 않는다.

## 1. 목적과 범위

기본 Unix 소켓 서버와 명시적 `--sock` 없는 SSH proxy가 검증 가능한 관리 세션으로 식별되게 하고, 자동 업데이트가 언제 검사·보류·재시도·예산 초기화되었는지 설명한다. 실제 작업이 없고 소유 관계와 복원 가능성이 확인된 경우에만 기존 안전한 교체 경로로 적용한다.

이슈의 수용 기준 8개를 모두 다룬다. 단순 횟수 증가, argv 문자열만으로 프로세스 인정, unknown 무시, 보호 검사 제거, 강제 종료는 해결책으로 채택하지 않는다. Home Assistant 기기·자동화 변경과 무관한 의존성 일괄 갱신은 범위 밖이다.

## 2. 기준 상태와 읽을 문서

- 시작 작업 트리 clean, 현재 브랜치 `dev`, HEAD/원격 dev `0506f7490fea09d9572bfdf8c6cd177573fc43b3`.
- main/원격 main `03c572de01e4a733fd1b6d0e9da1f0bee4206ca9`, 현재 제품 Stable `0.7.3`, bundled Codex `0.162.1`.
- dev는 main 이후 배포 기록 문서 커밋 1개가 있다. 과거 progress의 main/dev 동기화 문구만 믿지 않는다. Executor는 시작 시 Git status/log/remote refs, 새 이슈 댓글과 태그 충돌을 다시 확인한다.
- 루트 `AGENTS.md`, `docs/development/rules.md`, `progress.md`, `product_spec.md` FR-021/§11, `architecture.md` §13, `addon_spec.md`, `security.md`, `test_plan.md`, `releasing.md`를 따른다.
- task 007 `PLAN.md`, `REPORT.md`, FIX_01~09 및 각 보고서는 이전 설계·실패·수용 증거로 검토하되 현재 코드를 대체하지 않는다. 특히 FIX_06 peer 검증, FIX_07 ephemeral 보호·persistent 복원, FIX_08 CI provisioning, FIX_09 인수 경계를 보존한다.
- `releasing.md` 등 일부 current-version 설명이 0.7.2에 머물러 있다. 이번 기준은 Git/current manifest/progress의 0.7.3이며 구현·릴리스 때 관련 사용자 문서도 정리한다.

### 이슈 관측과 판단의 한계

이슈는 App 0.7.3/amd64에서 selected 0.162.1, staged 0.167.0, `paused_busy`, 12/12, restart 0, 저장된 blocker `remote_stdio`를 보고한다. 서버의 빈 소켓 기록과 기본 proxy 실행을 관측했지만 조사 환경의 `/proc/*/exe` EACCES 때문에 실제 데몬의 과거 판정을 확정하지 못했다. 상시 CLI blocker, 실제 작업 유무, 정확한 소켓 경로와 과거 일별 초기화 성공도 미확인이다. 이 관측을 재현 완료나 데이터 유실 증거로 확대하지 않는다.

### 현재 코드에서 확인한 개선 지점

아래 파일명은 `codex_home_assistant/rootfs/usr/local/` 기준이다.

| 위치 | 확인한 동작 | 계획 |
| --- | --- | --- |
| `bin/codex` 등록 분기 | `unix://` 접두어를 제거하므로 경로 생략형은 managed=true/socketPath 빈 문자열, 기본 proxy도 빈 socketPath 기록 | transport와 실제 경로를 구분해 등록 |
| `share/codex-ha/codex-runtime-manager.mjs:parseCodexInvocation()` | `unix://`를 빈 문자열로 해석, proxy 생략값은 null | 명시 Unix 기본값과 stdio/미해석을 구분 |
| `inspectAllSessions()` | proxy는 argvSock/recSock 모두 있어야 인정, socketPath 없는 서버는 stdio 분기로 이동 | 검증된 기본 소켓 resolver와 peer 대조 연계 |
| `inspectProcess()` | exe/cmdline 읽기 예외를 비워 두고 진행 | errno·검사 범위·검사 주체를 보존한 보수적 판정 |
| `loadState/saveState/getStatus` | 현재 상태·lastCheckAt·단일 blocker 중심, 회차별 이력 없음 | 호환 가능한 제한 이력과 별도 시각 제공 |
| `codex-updater-daemon.mjs:loop()` | 5분 retry, paused_busy 보류, budgetDate 전환 초기화 코드 존재 | 연속 실행·상태 재조회·예외/경합·실제 다음 기회 시험 |
| `getCurrentSlotInfo()` | 00:00~02:59는 전날 21:00 slotDate | calendar date와 budget date를 명시적으로 구분 |

위 정적 분기는 원인 후보다. 데몬과 같은 권한 경계의 격리 재현으로 영향과 수정 전후를 입증한다.

## 3. 최신 공식 근거와 선행 실험

2026-11-10 확인한 [OpenAI Codex App Server 문서](https://developers.openai.com/codex/app-server)는 `--listen unix://`와 `unix://PATH`, 기본 제어 소켓을 사용하는 transport를 설명한다. 문서는 현재 [ChatGPT Learn App Server](https://learn.chatgpt.com/docs/app-server)로 연결된다. 다만 해당 페이지에서 proxy `--sock` 기본 경로의 버전별 규칙은 확인하지 못했다. 경로를 추측해 하드코딩하지 않는다.

[Home Assistant 공식 App configuration](https://contributors.home-assistant.io/apps/reference/configuration/)에서는 image tag가 version이고 stage 기본값은 stable이다. 기존 DEV experimental/Stable stage 생략 계약을 유지한다. Executor는 구현 시 두 공식 문서와 필요한 버전별 공식 소스를 다시 확인한다.

첫 구현 단위는 disposable HOME/CODEX_HOME과 짧은 Unix 경로의 실험이다. baseline 0.162.1, 기존 시험 후보 0.166.0, 이슈 관측 버전 0.167.0의 공식 바이너리/소스/`--help`를 대조한다. 0.167.0 추가 fixture는 공식 체크섬과 architecture를 검증해 기존 provisioning에 통합한다. 설치 도중 최신 버전을 무조건 baseline으로 바꾸지 않는다. 각 버전의 지원/미지원과 실제 default path 결정 요인, proxy peer, launch 형태를 정제한 표로 남긴다.

## 4. 구현 단위

### A. 기본 소켓 해석·등록·분류

1. stdio/default invocation, explicit stdio, pathless Unix, explicit Unix, proxy explicit/default, 지원 불가 transport를 구별한다. `--listen value`/`--listen=value`, `--sock value`/`--sock=value`, 전역 옵션 값과 `--` 처리의 wrapper/manager parity를 유지한다.
2. 실제 Codex 버전·실행 사용자·검증된 실행 환경에 따른 기본 소켓 경로를 단일 계약으로 해석한다. 안전한 공식 조회가 없으면 버전별 공식 구현과 실제 관측을 대조한다. 임의 환경 경로나 다른 사용자의 소켓을 신뢰하지 않는다. resolve 자체가 서버를 새로 띄우거나 세션을 종료해서는 안 된다.
3. record에는 transport, 경로 출처(default/explicit), 검증된 실제 경로와 필요한 최소 버전/신원 정보를 저장한다. 현재 cwd/args 등 기존 private 복원 record는 목적대로 유지하되 신규 이력·로그·공개 status로 복제하지 않는다.
4. PID+proc start ticks, 실제 package executable, socket 파일·소유자·실제 listener PID, proxy의 kernel UNIX_DIAG peer와 fd inode를 함께 확인한다. alias 재지정, stale record, PID 재사용, unrelated accepted connection을 helper 인정 근거로 쓰지 않는다.
5. 검증된 proxy는 소유 서버에 한 번 귀속한다. connected만으로 busy로 세지 않고 검사 자식·companion도 검증된 소유 관계로 중복 제외한다. 미검증 소유 관계는 unknown으로 보류한다.
6. 레거시 빈 record는 읽기 호환하되 기본값을 현재 버전 기준으로 조용히 채워 managed로 승격하지 않는다. 실제 프로세스·당시 버전·소켓을 재검증해 보완할 수 없으면 재연결 필요 사유를 표시한다. 기존 live record를 비원자적으로 재작성하지 않는다.

### B. 권한 부족과 작업 보호

- exe/cmdline/fd/socket/peer/RPC 검사에서 EACCES·EPERM과 ENOENT·프로세스 종료를 구분한다. `inspection_permission_denied` 등 allowlist code와 검사 범위, daemon/status 조사 주체를 제공한다. raw errno message·전체 argv·사용자 경로는 공개하지 않는다.
- 제한된 status 실행의 현재 관측과 daemon이 저장한 마지막 판정의 시각·주체를 분리한다. status 읽기가 스케줄 카운터·저장된 daemon 판정을 덮어쓰지 않게 한다.
- 권한 불가 프로세스를 inventory에서 조용히 누락하지 않는다. 반대로 모든 무관 프로세스의 EACCES를 무조건 Codex로 계상하지 않으며 기존 record/executable 신원 경계와 불확실성 범위를 명시한다.
- in-flight/queued request, 승인·사용자 응답 대기, active turn, background terminal, double snapshot, pre-signal identity 재확인과 admission gate를 유지한다.
- nonempty ephemeral은 종료 전까지 보호한다. persistent는 실제 복원 capability/rollout 검증과 thread/resume을 유지한다. 유휴 판정 자체는 종료 권한이 아니다. 트랜잭션 실패·새 worker 실패·진단 실패는 이전 버전/안전한 복구 상태로 남기고 강제 kill하지 않는다.

### C. 제한된 이력·status 계약

- private `state.json`에 additive schema로 통합하는 것을 우선한다. 기존 durable write와 exclusive gate 아래 카운터/이력을 한 번에 저장해 CLI·daemon 경합에 따른 유실·중복을 막는다. 새로운 임의 파일이나 별도 DB는 필요 근거 없이 만들지 않는다.
- 제안 상한은 최근 100개, 최대 7일 중 더 엄격한 쪽이다. load/write 양쪽에서 길이·개수·필드 타입을 제한하고 기존 1 MiB 파일 상한을 유지한다. 부모 0700/파일 0600, unsafe path와 손상 데이터는 안전하게 처리한다.
- allowlist event: 버전 조회, 유휴 검사, 보류/적용 결과, 예산 초기화, 저빈도 재확인. 필드: UTC 시각, 당시 timezone/budgetDate, source(scheduled/pending/low-frequency/manual), event/회차 번호, budget 사용량, blocker code와 제한된 개수, outcome, 실제 nextRetryAt. 대화 ID·내용·전체 argv·원문 경로·토큰·사용자 식별자는 저장하지 않는다.
- 버전 조회 시각, 유휴 검사 시각, 예산 초기화 시각과 다음 초기화, 다음 버전 조회/적용 재시도를 구분한다. 기존 lastCheckAt 등 JSON 필드는 호환 의미를 유지하고 새 필드로 명확히 한다. 과거 12회 시각을 계산해 채워 넣지 않는다. 이전 이력 없음은 없음으로 표시한다.
- JSON/text status에서 최근 제한 이력과 정책/다음 기회를 확인할 수 있게 한다. 기존 canApply는 세션 안전성, autoApplyReady는 예산·옵션·후보·cooldown 포함 자동 실행 준비 상태라는 구분을 유지한다.
- 회차는 실제 검사 시작 때 기록한다. 완료·실패와 연결할 식별자를 두고 daemon 중단 시 미완료를 성공/무작업으로 꾸미지 않는다. idleCheckCount의 기존 의미(보류 예산)와 전체 검사 번호를 혼동하지 않는다.

### D. 일일 예산과 소진 후 기회

기본 빠른 검사 5분/12회와 03:00 기준 budget date를 유지한다. 00:00~02:59는 이전 budget date이며, 03:00에 새 budget date가 시작한다. timezone 변경, DST, 시계 역행에서도 무제한 예산 재생성이나 중복 apply가 생기지 않게 정책을 문서화하고 검증한다.

권장 정책은 **빠른 예산 소진 후 60분 간격, budget date당 최대 4회 별도 저빈도 재확인**이다. 이벤트만 의존하는 방식은 record 누락·종료 이벤트 유실을 놓치며 polling/event 동시 wake 중복 방지가 추가되므로 이번에는 제한된 저빈도 방식을 우선한다.

- 기존 12회 카운터를 조용히 늘리지 않고 별도 low-frequency 예산/다음 시각을 저장·표시한다. 최초 기회는 소진 후 최소 60분 뒤다. 새 budget date에서 양쪽 예산을 초기화한다.
- 같은 후보의 버전 조회 성공·새 예약 슬롯·daemon 재시작만으로 소진 예산을 재충전하지 않는다. 후보 교체 때의 기존 정책은 확인하고 변경 이유와 상한을 보고한다.
- 저빈도 검사도 같은 신원/작업/복원/cooldown/일일 restart 최대 1회 gate를 거친다. 4회 소진 뒤에는 다음 budget reset 또는 사용자의 수동 apply까지 대기한다.
- manual apply는 기존 명시 요청 의미를 유지하고 source와 실제 실행을 기록한다. busy/unknown/복원 불가/권한 부족을 무시하지 않는다.
- 정책 추가에 맞춰 autoApplyReady, nextRetryAt과 daemon sleep 계산을 함께 수정한다. stale state·잘못된 과거 nextRetryAt으로 tight loop가 생기지 않게 한다. autoUpdate=false/blocked recovery에서는 자동 검사·적용하지 않는다.
- 비용 실험에서 부적절하면 더 보수적인 이벤트/저빈도 대안으로 조정할 수 있으나 당일 재기회·명시 상한·재시작 후 보존은 유지하고 REPORT에 근거를 남긴다.

## 5. 관련 변경 파일

| 구분 | 경로 |
| --- | --- |
| 등록/선택 | `codex_home_assistant/rootfs/usr/local/bin/codex`, `ha-codex-update` |
| 식별·state·status·apply | `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` |
| 예약·sleep·reset | 같은 디렉터리 `codex-updater-daemon.mjs` |
| 안전한 교체 | 같은 디렉터리 `codex-session-host.mjs`, `codex-server-transaction.mjs` (필요한 범위만) |
| 회귀 | `tests/test_codex_update_contract.py`, `test_codex_update_fix03.py`, `test_codex_wrapper_proxy.py`, `test_codex_activity.py`, `test_codex_wire_probe.py`, `test_codex_live_handover.py`, `test_remote_setup.py` |
| fixture/이미지 | `tests/prepare-test-binaries.sh`, `codex-update-smoke.sh`, `mobile-ssh-smoke.py`, `update-smoke.sh`, `.github/workflows/ci.yaml` (새 시험의 누락 방지) |
| 버전/채널 | `repository.yaml`, App `config.yaml`, `Dockerfile`, Playwright `package*.json`, runtime manager APP_VERSION, MOTD 및 version contract 참조 |
| 사용자/개발 문서 | 루트/App 한국어·영어 README, App DOCS 두 언어, CHANGELOG, 개발 product_spec/architecture/addon_spec/security/test_plan/releasing/progress |

AppArmor/requirements 보호 정책과 권한은 유지한다. 진단이 불가능하다는 이유만으로 profile 예외나 privileged 권한을 추가하지 않는다.

## 6. 검증과 수용 기준

각 행은 구현 후 실제 증거를 남겨야 하는 조건이며 이번 Planner가 실행한 결과가 아니다.

| 이슈 기준 | 필수 검증 |
| --- | --- |
| 1 기본 소켓 | 공식 binary 0.162.1/0.166.0/0.167.0별 pathless/explicit Unix와 proxy default/explicit 실제 경로·listener·record 일치, 옵션 parser parity, 미지원 버전의 정확한 보류 |
| 2 proxy 귀속 | 실제 SSH proxy 1개가 owner helper 1개로 귀속, 중복 blocker 0; alias 재지정·PID reuse·위조/오래된 record·unrelated peer는 unknown/보류 |
| 3 안전한 인계 | busy→보류→idle→실제 worker exe/PID 교체→같은 persistent 대화 후속 turn 문맥 보존; ephemeral 보류; pre-signal 재활성화·복원 실패·rollback 시험 |
| 4 검사 권한 | exe/fd/socket/peer EACCES/EPERM, ENOENT 경쟁, daemon와 제한 shell의 다른 관측을 분리하고 진단·원래 보호 유지 |
| 5 이력 | 조회·idle 시각 분리, 회차/결과/다음 시각 일치, 100개/7일 제한, 금지 데이터 비노출, old state·손상·중단·동시 CLI/daemon 원자성 |
| 6 날짜 전환 | daemon 계속 실행한 채 12회 소진→날짜 전환→카운터 0 관측→새 첫 검사. 같은 프로세스의 실제 loop가 읽고 저장하는 상태와 호출 횟수를 검증 |
| 7 소진 후 | 같은 날 저빈도 4회 상한·60분 하한·idle 기회 적용·busy 보호·재시작 후 예산 보존·다음 시각 표시. 정기 슬롯/수동 호출 경합으로 중복 apply 없음 |
| 8 호환 | old empty socket record, 이전 App 실행 프로세스, baseline↔후보의 소켓 기본값 변화, 재연결 필요 사유, 0.7.3→0.7.4 같은 저장소 update의 데이터 보존 |

### 자동/컨테이너

1. 기존 fixture/provisioning을 사용해 관련 pytest부터 실행하고 전체 `python -m pytest -ra`로 회귀를 확인한다. `prepare-test-binaries.sh`의 준비 명령·실제 hash/version·skip 이유를 기록한다. 요구 버전이 빠져 핵심 시험이 skip되면 통과로 승인하지 않는다.
2. daemon은 테스트 가능한 clock/scheduler 의존성을 추출하거나 실제 loop harness를 만든다. 날짜 함수 단독 시험이나 날짜 변경 뒤 daemon 재시작만으로 연속 reset 수용을 대신하지 않는다. timezone Asia/Seoul/UTC/DST zone, 23:59→00:00→02:59→03:00, 월/연/윤일, restart, timezone 변경·시간 역행, reset 직후 stale local state, pause/abort를 포함한다. 시험용 clock override는 제품 보안 경계를 넓히지 않는다.
3. 짧은 disposable socket 경로를 사용해 AF_UNIX 길이 한도로 인한 가짜 실패를 피한다. 실제 JSON-RPC·kernel peer·작업 요청/응답으로 검증하고 boolean stub만으로 인계 성공을 주장하지 않는다.
4. Node/Bash syntax, ShellCheck, YAML/Markdown/Docker/Actions lint와 App linter, secret scan, AppArmor parse·실제 enforce smoke, managed sandbox 보호 검사를 해당 변경 범위에 실행한다.
5. amd64와 native aarch64 build/runtime 및 기존 CI 필수 smoke를 통과한다. 이미지에서 `tests/codex-update-smoke.sh <image>`, `python3 tests/mobile-ssh-smoke.py <image>`, full Docker smoke와 update persistence를 수행한다. 새 default proxy 경로도 image smoke에 포함한다.

### DEV HAOS 수용

승인된 시험 설치에서 App/Codex/HA 버전·architecture·가능한 image digest를 기록한다. Web terminal/SSH/mobile Remote 기본 bootstrap을 각각 사용해 active 작업 보호, 유휴 기본 소켓 인계, 후속 turn, 재연결 필요 여부, status 이력을 확인한다. budget rollover는 실제 overnight 관측 또는 자동 harness 증거로 구분하며 운영 장치의 시간을 바꾸지 않는다. auth/config/AGENTS, SSH host key, browser identity, memory와 일반 `/config` marker 보존을 확인한다. 실제 aarch64 HAOS·모바일 자동 reconnect를 실행하지 않았다면 NOT RUN/PARTIAL로 남기고 이번 릴리스의 명시적 위험 수용 여부를 기록한다. 0.7.0의 ARM 면제를 자동 재사용하지 않는다.

## 7. DEV 개발에서 Stable 0.7.4까지

1. 최신 dev를 기준으로 기능 브랜치에서 A~D를 작은 수직 단위로 구현한다. 목표 첫 후보 `0.7.4-dev.1`, 기존 tag/image가 있으면 다음 미사용 N을 선택한다. 이번 계획은 해당 버전 생성/게시 완료를 뜻하지 않는다.
2. DEV name/description/panel/OCI title/MOTD 및 `stage: experimental`, version metadata/contract를 맞춘다. Stable main 0.7.3을 DEV metadata로 덮지 않는다. 같은 N이나 image/tag는 덮어쓰지 않는다.
3. 로컬·PR·exact dev merge CI, native architecture, tag Builder·SBOM/Critical scan·서명/provenance와 공개 image 접근/실제 smoke를 확인하고 run URL/SHA/digest를 기록한다. 서명 step 성공과 클라이언트 독립 검증 성공을 구분한다.
4. 공개 DEV 후보의 HAOS 수용과 Reviewer 검토를 거친다. 실패가 있으면 새 N 후보에서 보완하고 시험한다. 검증되지 않은 연결 복원이나 날짜 초기화를 PASS로 쓰지 않는다.
5. 수용된 DEV runtime을 기준으로 별도 Stable 후보를 준비해 `0.7.4` version/Stable branding과 stage 생략을 반영한다. 한국어·영어 문서·changelog·releasing를 실제 상태에 맞춘다. 무관한 기능을 섞지 않으며 runtime 차이가 있으면 재검증한다.
6. 외부 반영 요청 범위에서 main PR/exact merge CI, immutable 0.7.4 tag, 양 architecture artifact·서명/SBOM/provenance·generic manifest·익명 pull·정식 Release를 새 artifact 기준으로 검증한다. DEV image PASS는 Stable exact image PASS의 대체물이 아니다.
7. 기존 Stable 사용자의 같은 저장소 0.7.3→0.7.4 일반 update를 검증한다. `#dev`와 main은 repository identity가 다르므로 `/data` 자동 이전을 약속하지 않는다. source migration·삭제/재설치·운영 데이터 이동은 별도 범위다. 실패한 Stable tag를 재사용하지 않고 새 patch 또는 승인된 복구 절차를 따른다.

## 8. 완료와 handoff 보고

Executor는 이 PLAN과 최신 Git/issue를 다시 읽고 구현·검증 후 같은 디렉터리에 새 `REPORT.md`를 작성한다. 변경 파일·커밋/후보 식별자, 위 수용 행렬별 명령/결과/증거, 계획 편차, 재연결 요구, 잔여 위험·미검증, DEV 수용/Stable 승격 가능 여부를 기록한다. 명령 성공과 실제 기능 수용을 구분하며 비밀값과 운영 원문을 첨부하지 않는다.

Reviewer는 PLAN/REPORT·기존 task 007 안전성 이력·current diff/status·실제 시험 증거를 검토하고 필요한 경우 다음 `FIX_01.md`를 새로 작성한다. Executor는 미보고 최고 FIX만 수행하고 matching report를 새로 쓴다. 과거 문서를 덮어쓰지 않는다.

기능 인수 조건은 이슈 8개 기준, 안전한 실제 인계·음성 회귀, 연속 daemon reset과 제한 이력 검증이다. Stable 완료 조건은 이에 더해 DEV 수용·0.7.4 exact artifact/배포 검증과 승인된 잔여 공백 기록이다. 이번 Planner 작업은 그 계획을 전달하는 단계다.
