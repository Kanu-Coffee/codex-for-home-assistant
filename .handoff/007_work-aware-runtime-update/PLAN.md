# PLAN — 실제 작업 기준 Codex 업데이트·재시작

- 작성: 2026-10-30, Planner: Codex
- 요청 범위: 운영 호스트의 업데이트 체크를 참고한 원인 검토와 구현 계획. 이번에는 제품 코드·운영 서비스·HA를 변경하지 않는다.
- 기준: `dev` HEAD `fb15cd3`, App `0.7.3-dev.3`의 0.7.2 복원 런타임. 시작 시 `docs/development/progress.md`에 있던 미커밋 기록은 보존한다.
- 새 작업 번호: 기존 최대 `006` 다음 `007`. 과거 handoff는 이력이며 현재 구현으로 간주하지 않는다.

## 1. 목표와 결론

사용자의 보류 기준은 **실제 작업의 존재**다. 채팅창, SSH/stdio 연결, CLI 프로세스, 로드된 대화가 남아 있다는 이유로 보류하지 않는다. 진행 요청, 대기 요청, tool 실행, 승인·사용자 응답 대기와 실제 후속 작업이 있으면 보호한다. 작업이 없으면 기존 HA 스케줄과 제한에 따라 업데이트·Codex 실행 서버 재시작을 수행하고 다음 요청을 정상 처리한다.

운영 호스트의 **작업 상태 판정은 재사용 가능**하다. 그러나 그 Python/systemd 구현을 HA에 그대로 복사하는 것으로 CLI·Remote stdio 문제가 해결되지는 않는다. 호스트는 이미 Unix 소켓 서버를 관측·교체하며, 현재 HA wrapper는 직접 CLI 또는 stdio worker를 실행한다. 따라서 다음 순서로 진행한다.

1. 운영 호스트와 같은 실제 작업 판정기를 만든다.
2. 공식 Codex daemon/Unix transport/proxy/TUI 기능으로 CLI·stdio의 실제 실행 서버를 관측·교체할 수 있는지 검증한다.
3. 검증된 최소 구조를 기존 HA scheduler와 restart transaction에 연결한다.
4. 실제 공식 바이너리의 scheduler → 교체 → 후속 요청까지 통과한 뒤 구현 완료로 판단한다.

현재 증거로 판정 개선의 방향은 확정할 수 있지만, HA baseline과 후보의 CLI·stdio 자동 복구까지 가능하다고 확정하지 않는다. 2단계의 기능 실험을 먼저 완료해야 한다.

## 2. 현재 코드에서 확인한 문제

| 위치 | 현재 동작 | 개선할 점 |
| --- | --- | --- |
| `codex-runtime-manager.mjs:inspectAllSessions()` | CLI는 살아 있으면 `cli` blocker | 프로세스 신원과 실제 작업 상태를 분리 |
| 같은 함수의 socket 없는 app-server 분기 | `remote_stdio`, 종료 전까지 보류 | stdio의 작업 관측 및 자동 backend 교체 경로 필요 |
| `inspectAppServer()` | 요청/queue/turn gauge 확인 후 `thread/loaded/list.data.length > 0`이면 busy | loaded 목록은 상태를 검사할 대상으로 사용 |
| 같은 함수 | `app.server_requests.pending`, thread별 상태·background 조회 없음 | 승인 대기·독립 background 등 보완 |
| `/usr/local/bin/codex` | 등록 후 실제 바이너리로 `exec`; launch lock만 사용 | 기존 연결에서 들어오는 요청과 restart의 경합은 별도 해결 |
| `codex-server-transaction.mjs:restartServers()` | 검증된 idle Unix 서버만 SIGHUP 후 재기동 | loaded 대화 복원·stdio 수명 유지·실제 후속 요청은 현재 계약 밖 |
| `tests/test_codex_update_contract.py` | 등록 CLI의 존재를 blocker로 기대 | 식별 회귀를 유지하면서 실제 작업 기준 수용시험 추가 |
| FR-021·architecture §13 | loaded idle 대화도 busy라는 문서 | 구현과 함께 사용자 기준으로 수정 |

프로세스 검증과 helper 귀속 자체는 필요하다. 이를 없애서 검사 대상이 사라지는 방식으로 해결하지 않는다. loaded 검사를 삭제하거나 current symlink만 바꾸는 변경도 불충분하다. 기존 프로세스는 계속 구버전으로 동작하며 stdio의 단순 재기동은 SSH 입출력 파이프를 복구하지 못한다.

## 3. 운영 호스트에서 확인한 참고 구현과 증거

### 3.1 읽은 로컬 자료

- `~/.local/lib/codex-maintenance/codex_stable_maintenance.py`
  - `inspect_server()` 약 279행: 실제 작업 판정.
  - `discover_servers()` 약 244행: 관리하는 Unix 서버 2개와 소유자 확인.
  - `install_update()` 약 337행: 공식 stable 검증·설치·선택과 재시작 분리.
  - `restart_daily()` 약 470행: 두 차례 검사, 신원 재확인, graceful drain, 새 서버 버전 검증.
- `~/.config/systemd/user/codex-stable-update.{service,timer}`
- `~/.config/systemd/user/codex-idle-restart.{service,timer}`
- `~/.config/systemd/user/librechat-codex-app-server.service.d/50-codex-safe-stop.conf`

이 파일들은 개발 호스트의 참고 자료다. Executor 환경에 없을 수 있으므로 아래 동작 계약을 구현의 근거로 남긴다. 스크립트·서비스·운영 상태는 변경하지 않았다.

### 3.2 재사용할 판정 계약

운영 스크립트는 다음을 검사한다.

- `server/diagnostics.process.id`가 예상 서버 PID인지 확인한다.
- `app.requests.in_flight > 1`: 진단 요청 자체의 1건을 제외한 진행 요청.
- `app.requests.queued > 0`: 대기 요청.
- `app.server_requests.pending > 0`: 서버가 client 응답을 기다리는 요청.
- `core.turns.active > 0`: 진행 turn.
- `thread/loaded/list` 전체 pagination 후 각 ID의 `thread/read(includeTurns=false)` 상태 조회. `idle`/`notLoaded`는 busy로 만들지 않는다.
- loaded thread별 `thread/backgroundTerminals/list` 전체 pagination으로 실행 중 background terminal 확인.
- 두 차례 snapshot과 process identity 확인 후 SIGHUP graceful drain. 종료 확인 전 신버전을 시작하지 않는다. timeout을 강제 kill로 해결하지 않는다.
- 교체 뒤 실제 실행 바이너리 버전과 diagnostics PID를 확인한다.

운영 구현을 무비판적으로 복사하지 않는다. 선택 gauge가 없으면 0으로 읽는 동작은 HA의 버전별 schema 검증으로 보강한다. `/proc`의 단순 argv 검색과 환경 전체 재상속도 HA의 검증된 package identity·최소 환경 계약을 대체하지 않는다. background 목록에는 명령·cwd가 포함될 수 있으므로 수량만 사용하고 원문을 기록하지 않는다.

### 3.3 확인한 결과와 범위

- 운영 타이머 2개는 `systemctl --user list-timers`에서 다음 실행이 예약되어 있었다. 호스트는 KST 01~05시 매시간, restart는 날짜별 시도 제한을 사용한다.
- 정제한 local state와 journal에서 2026-10-29 01:00 KST의 `0.164.0 → 0.165.0` 설치 및 약 5초 뒤 restart `completed`를 확인했다.
- 같은 기간의 journal에는 `blocked` 기록도 있었다. 성공 기록 하나를 모든 조건에서 무결점이라는 증거로 쓰지 않는다.
- 운영 Python의 `inspect_server` 함수만 AST로 추출해 합성 RPC로 검사했다. loaded idle은 보류하지 않고, active·queue·pending approval·background·unknown status는 보류하는 **6개 사례 PASS**다. 운영 서버에 요청하거나 재시작한 시험이 아니다.
- 설치 단계는 restart와 분리되어 있고 실행 중 npm package resource 보호 조건도 있다. 따라서 호스트의 모든 업데이트 단계가 오직 작업 여부 하나만으로 결정된다고 단순화하지 않는다.
- 로컬 공식 `codex-cli 0.165.0`의 `--help`, `app-server --help`, `app-server proxy --help`에서 Unix transport, TUI `--remote`, shared daemon 관련 명령, stdio proxy `--sock`을 확인했다. **help 확인은 재연결·대화 복원·HA baseline 지원의 증거가 아니다.** proxy는 실제 연결을 열지 않았다.

호스트의 시간대·npm 설치·systemd·공유 서버 2개라는 가정은 이식하지 않는다. HA의 기존 S6 scheduler와 immutable package 설치를 유지한다.

## 4. 공식 문서와 버전 실험

2026-10-30 [OpenAI App Server 공식 문서](https://learn.chatgpt.com/docs/app-server)를 열어 확인했다. 문서는 loaded 목록과 runtime status를 구분하며 `thread/read`, status notification, `thread/resume`, Unix/stdio transport 및 experimental background terminal 조회를 설명한다. 이 설명만으로 서버 교체 시 기존 client가 자동 복구한다고 보장할 수 없다.

Executor는 이미지 baseline `0.162.1`과 구현 시점 공식 stable 후보를 **정확한 version/target/digest로 고정**하고 다음 기능표를 작성한다. 최신 docs와 로컬 `0.165.0` 기능을 baseline에 자동 적용하지 않는다.

| 실험 | 확인 사항 | 다음 결정 |
| --- | --- | --- |
| 작업 관측 | 진단 gauge의 등록 시점·범위, 별도 client에서도 원래 client의 queue/wait/turn이 보이는지, thread/background pagination | authoritative 관측 범위 확정 |
| CLI/TUI | baseline/후보의 shared daemon 또는 `--remote unix://...`, resume·fork·옵션·tmux·PTY·Ctrl-C | 공식 frontend/backend 분리 우선 |
| Remote stdio | 공식 `app-server proxy --sock` 지원, SSH bootstrap의 실제 명령·인자·capability | 검증된 공식 proxy 우선 |
| 재시작 | idle SIGHUP, 검사 직후 새 turn, reconnect/initialize/subscribe/resume | reconnect·복원 책임 확정 |
| 상태 보존 | persistent·빈 ephemeral·내용 있는 ephemeral, model/cwd/policy, 미전송 입력, 구독 | 복원 또는 필요한 adapter 범위 확정 |
| 호환성 | old frontend/new backend, 정책 probe, CODEX_HOME migration·rollback | 지원 가능한 정확한 조합 확정 |

기능 실험은 disposable CODEX_HOME·합성 데이터로 수행한다. 유료 inference가 필요하면 승인된 시험 경로만 사용하며 운영 인증·대화·HA 구성을 복사하지 않는다. baseline 변경이 필수면 근거·검증 영향과 함께 ADR에 명시하고 별도 변경 단위로 다룬다.

## 5. 작업 상태 모델

process inventory와 activity를 별도 값으로 둔다. 세션 수가 0이어야 idle이라는 조건을 만들지 않는다.

| 관측 | 상태 | 처리 |
| --- | --- | --- |
| 열린 창·연결·프로세스·loaded 대화, 실제 작업 없음 | `idle` | 기존 허용 스케줄에서 자동 적용·재시작 |
| 진행 요청·turn·tool·미완료 command/process | `busy` | 기존 서버 유지 |
| 대기 요청·입력 queue·steer·예약되어 실행을 기다리는 작업 | `busy` | 실행/취소가 확정될 때까지 유지 |
| 승인·elicitation·사용자 입력을 기다리는 미완료 요청 | `busy` | 응답 대기 중 강제 종료 금지 |
| detached background terminal·실행 중 child agent·자동 재개될 goal 작업 | `busy` | 실제 작업과 producer까지 확인 |
| 관측 실패·미지원 schema·신원 불일치·유실·불완전 pagination | `unknown` | 관측 오류로 구분, 재검사·복구 |
| 작업은 없지만 복원 기능이 미지원인 조합 | `idle`, transition 불가 | `unsupported_transition` 표시, busy로 오표시 금지 |

`unknown`과 복원 미지원은 실제 작업이 있다는 뜻이 아니다. 정상 지원 경로가 계속 이 상태여서 사용자가 모든 창을 닫아야 한다면 목표 미달이다. 단순 goal record·paused goal·완료된 tool·유휴 MCP helper 존재는 busy 근거가 아니다. CPU·stdout·JSONL mtime·경과 시간만으로 idle을 추정하지 않는다.

진단 자체의 in-flight는 버전에서 검증한 만큼만 제외한다. 관측 호출·다른 client 요청이 섞였는데 일괄 차감하지 않는다. 관측 결과에는 completeness/freshness와 reason을 담는다. request가 ACK된 뒤 실행이 계속되는 command/process도 완료 이벤트까지 추적한다.

## 6. 최소 구현 방향

### 6.1 공식 실행 구조 우선

공식 shared daemon/Unix 서버를 HA가 소유하고, TUI와 stdio client가 공식 연결 경로를 이용하는 구성을 우선한다. HA는 안전한 launch·관측·drain·restart를 담당하고 protocol 중계는 가능한 한 upstream에 맡긴다. 관리 서버 공유 시 여러 client의 cwd·model·policy·approval·동시 작업 격리가 보존되는지 검증한다. 공유가 부적합하면 client별 관리형 worker를 사용한다.

현재 요청의 필수 결과는 사용자가 수동으로 종료하지 않아도 idle에서 자동 갱신하고 **기존 사용 흐름의 다음 요청을 정상 처리하는 것**이다. 모든 내부 FD를 영구 유지하는 별도 요구를 추가하지 않는다. 공식 자동 reconnect/resume으로 달성할 수 있다면 우선 사용한다. 다만 SSH EOF·Broken pipe로 끝나 사용자가 직접 다시 실행해야 하는 것은 완료가 아니다. 잠깐의 자동 reconnect가 발생한다면 지연·입력·대화 보존을 시험하고 사용자 문서에 정확히 쓴다.

공식 proxy가 reconnect 없이 종료하거나 대화 복구를 제공하지 않으면, 그 사실을 재현하고 필요한 최소 adapter를 설계한다. **task 006 session-host 전체를 복원하는 것을 시작점으로 삼지 않는다.** 새 adapter가 필요할 때만 client 연결 수명, request ID, handshake·subscription·thread 복원, bounded framing·backpressure·timeout을 책임지게 한다. 임의 raw RPC 주입이나 성공 응답 합성은 금지한다.

### 6.2 판정과 교체를 함께 연결

1. 기존 stable 조회·SHA-256·package integrity·policy 검증 후 후보 staging.
2. 모든 실제 실행 서버의 작업 상태 관측. 하나라도 busy이면 기존 실행과 current를 유지.
3. 새 process launch gate와 기존 client request admission을 함께 확보하고 재검사. 두 번 검사만으로 경쟁 조건이 사라진다고 가정하지 않는다.
4. barrier 전에 수락된 요청은 기존 서버에서 완료하거나 전환을 취소. stop 직후 도착한 입력은 검증된 reconnect/adapter 경로에서 유실·중복 없이 처리.
5. 정확한 PID/start-time의 서버에 graceful drain. 늦게 시작한 작업은 종료까지 보호. timeout·관측 실패에서 강제 kill하지 않는다.
6. 이전 서버 종료 확인 후 후보 시작. 초기화·같은 대화 복원·실제 exe/version·정책·readiness 확인.
7. 전체 대상 성공 뒤 상태 commit 및 입력 재개. selected version과 running backend version을 구분.
8. 실패 시 기존 generation·대화로 복구. 부분 교체·crash는 journal로 남기고 허위 `applied` 금지. 비가역 DB migration 가능 조합은 사전 차단.

기존 lock 아래에서 backend와 current의 전환 순서를 일관되게 정한다. 관측되지 않는 내부 producer나 외부 연결이 있으면 이를 해결한 후 교체한다. 실행 중 generation과 resource를 GC하지 않는다.

### 6.3 스케줄·불변조건 유지

- HA는 지정 IANA timezone의 03/09/15/21시 조회, pending 5분 로컬 재검사, 일별 12회 검사 예산과 날짜 회복, rolling 24시간 restart cooldown을 유지한다.
- idle이어도 예산·cooldown으로 기다릴 수 있다. 이를 `busy`라고 설명하지 않고 `nextRetryAt`과 제한 사유를 표시한다. 무조건 즉시 적용한다고 약속하지 않는다.
- 자동 OFF 및 수동 경로의 기존 정책을 유지하고, manual도 실제 작업 보호를 우회하지 않는다.
- `/config` RW, manager API, workspace-write+network, 민감 경로 deny, credential 비상속과 인증·SSH·browser·memory 영속성을 유지한다.
- App 전체 restart·systemd 도입·외부 포트·추가 host 권한·user-file refresh로 문제를 우회하지 않는다.
- legacy 직접 실행 session의 관측/교체 한계는 명시한다. 개선 App 적용 뒤 새로 시작되는 정상 CLI·Remote 경로는 모두 목표를 충족해야 한다.

## 7. 구현 순서와 인계 파일

| 단계 | 변경/산출물 | 완료 조건 |
| --- | --- | --- |
| A | baseline/후보 capability·공식 구조 실험과 ADR | CLI·stdio 각각 관측·재시작·후속 요청 가능성 입증. 실패는 구체적 blocker 기록 |
| B | `codex-runtime-manager.mjs`의 공통 activity 판정, 관련 tests | loaded idle 허용, queue/wait/tool/background 보호, unknown 분리 |
| C | `/usr/local/bin/codex`, 필요한 최소 launcher/S6/private Unix 설정 | 공식 TUI·proxy 경로 및 단발 명령·exec/review 라우팅 정상. 인자·exit code 보존 |
| D | `codex-server-transaction.mjs`, 필요한 admission/복구 보완 | 실제 backend 교체, 같은 대화 다음 요청, race·실패 복구 |
| E | `codex-updater-daemon.mjs`, `ha-codex-update` status 연계 | scheduler와 manual 모두 같은 판정 사용, 예산/cooldown/OFF 보존 |
| F | 문서·실제 package/컨테이너 회귀 | 양쪽 transport와 native architecture 검증 및 미검증 항목 명시 |

B단계의 관측만 고쳐 idle loaded 서버를 즉시 종료 가능하게 만들지 않는다. 복원 준비 전에는 관측 결과만 노출하고 적용 경로는 안전하게 유지한다. A~E를 통과해도 실제 후속 요청 증거 전에는 제품 목표 달성이라고 하지 않는다.

관련 문서: `rules.md` R-403, `product_spec.md` FR-021/수용 기준, `architecture.md` §13, `addon_spec.md`, `security.md`, `test_plan.md`, `progress.md`, 루트/App 한국어·영어 README, `DOCS.md`/`DOCS.en.md`, `CHANGELOG.md`. 구현이 없는 이번 planning에서 사용자 문서에 개선 완료를 표시하지 않는다.

## 8. 필수 수용시험

| 사례 | 기대 결과 |
| --- | --- |
| CLI·Remote stdio 연결과 loaded idle 대화 유지 | 사용자가 종료하지 않아도 다음 허용 검사에서 실제 backend 갱신·재시작, 같은 대화 다음 요청 정상 |
| 두 transport 중 하나에 active turn/tool/queue/approval/elicitation | 전체 적용 보류, 작업과 응답 보호. 해소 뒤 다음 허용 검사에서 자동 진행 |
| turn은 idle이나 detached command/process·child agent·goal 후속 작업 존재 | 미완료 작업을 놓치지 않고 보류 |
| 여러 페이지의 loaded/background 목록·다중 client | 마지막 페이지와 다른 client의 작업까지 관측 |
| 관측 직후·barrier 전후·SIGHUP 직전에 요청 도착 | 손실·중복 실행 없음, 허위 applied 없음 |
| 신원 변경·PID 재사용·unknown gauge/status·timeout·stale/누락 관측 | 명시적 unknown, 종료·선택 금지, 복구 후 정상 판정 |
| persistent·빈 ephemeral·내용 있는 ephemeral·resume/fork | 기록·문맥 보존. 새 빈 대화로 임의 대체 금지. 미지원은 미완료로 보고 |
| TUI 편집 입력·resize·Ctrl-C·tmux 재접속 / mobile SSH stdio handshake | 입력·종료 코드·protocol 정상, 수동 재실행 요구 없음 |
| 대형 JSONL·UTF-8 split·복수 frame burst·느린 client | 정상 메시지로 crash 없음, backpressure·한도 초과 오류 정제, 입력 폐기 없음 |
| 후보 시작/정책/복원 실패·단계별 crash·일부 서버만 교체 | 구버전 복구 또는 명시적 rollback_incomplete, journal 재기동 복구 |
| 예산 11/12/소진·날짜/시간대·cooldown·OFF·manual | 기존 스케줄과 제한 보존, 실제 작업과 제한 사유 구분 |
| version/help/completion·exec/review·legacy data·GC | 불필요 backend 실행 없음, bounded 작업 보호, 사용 중 generation 보존 |
| 보호 정책·인증·SSH key·browser·memory | 기존 기능·비밀 비노출·권한 계약 회귀 없음 |

구현 검증은 기존 `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py` 후 전체 pytest, 바뀐 shell의 ShellCheck와 JS syntax, 문서 lint·secret 검사·`git diff --check`를 사용한다. 기존 `tests/codex-update-smoke.sh`, `tests/update-smoke.sh`와 필요한 full/policy smoke를 재사용한다. 신규 의존성을 단순 편의로 추가하지 않는다.

최소 하나의 실제 공식 baseline→후보 조합에서 **생산 wrapper → scheduler → running backend 변경 → 동일 대화 후속 요청**을 CLI와 stdio 모두 입증한다. fake worker나 selected symlink 변경만으로 대체하지 않는다. 양 아키텍처 native CI와 AppArmor·HAOS/mobile 실기 결과는 분리하며, 실행하지 않은 것은 NOT RUN으로 남긴다. 현재 요청은 실제 HA 변경·배포를 승인하지 않는다.

## 9. task 006 이력에서 반드시 반영할 점

task 006은 광범위한 session-host를 구현한 뒤 사용자 요청으로 롤백됐다. 과거 test/CI 통과는 현재 코드의 지원 증거가 아니다. 특히 FIX_01/08의 관측·capability·실제 경로 미연결, FIX_12/15의 ephemeral 복원, FIX_17의 정상 대형 JSONL relay crash와 단발 명령 문제를 새 회귀 조건으로 사용한다.

이번에는 공식 구조 실험을 선행하고, 관측만 성공한 단계에서 배포 가능한 완료로 간주하지 않는다. 기능 실험에서 목표 달성이 막히면 소요 범위·필요 upstream 기능을 REPORT에 기록한다. 생존 프로세스 blanket blocker를 그대로 두거나 검사만 제거하는 방식으로 목표를 축소하지 않는다.

## 10. Planner 검증과 Executor 보고

Planner는 현재 구현·spec·과거 rollback 이력, 운영 스크립트·타이머·정제 완료 기록, 공식 문서 및 로컬 공식 CLI help를 확인했다. 운영 판정 함수의 합성 6사례를 실행했다. 제품 수정·새 서버 시작·운영 RPC·설치·restart·inference·Docker/HAOS 시험은 수행하지 않았다.

문서 lint·관련 기존 회귀·diff 검사 결과는 `docs/development/progress.md`에 기록한다. 기존 테스트의 통과는 현행 동작 확인이며 개선 구현 통과를 의미하지 않는다.

Executor는 이 PLAN과 최신 Git·지침을 읽은 뒤 구현·검증하여 같은 디렉터리의 `REPORT.md`를 새로 작성한다. exact version/target/digest, 기능표, 공식 구조 선택 근거, 실제 CLI·stdio 후속 요청·race·rollback 결과, 계획 변경과 NOT RUN을 포함한다. Reviewer correction은 새 `FIX_NN.md`/대응 보고서로 이어가며 과거 task 문서를 수정하지 않는다. 별도 세션 handoff 문서만 준비하며 이번 planning에서 sub-agent를 실행하지 않는다.
