# FIX_02 — 재리뷰: 기간별 자동 복구와 남은 배포 차단 결함

## 판정·범위·우선순위

- Reviewer: 2026-10-13, Asia/Seoul. 판정 **CHANGES REQUESTED**. 현재 후보는 DEV에도 발행하지 않는다.
- 기준: PLAN, REPORT, FIX_01, FIX_01_REPORT, `feat/codex-auto-update` HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1` 및 tracked/untracked working tree. 기존 문서는 수정하지 않는다. Executor는 이 문서를 실행하고 `FIX_02_REPORT.md`를 새로 작성한다.
- 최신 사용자 요청: 인수 가능할 때 DEV 배포 후 사용자가 실제 HAOS에서 설치·시험한다. 제한이 일/턴/영구 중 무엇인지 확인하고 자동 업데이트의 영구 데드엔드를 없앤다.
- **정책 정정**: FIX_01의 후보 수명 전체 12회/1회와 busy 영구 차단 요구는 이번 사용자 요청에 따라 아래 기간별 정책으로 대체한다. 이전 Reviewer 요구 자체가 busy 데드엔드를 허용했음을 인정한다. 무결성·보안 실패의 fail-closed 요구는 유지한다.
- 외부 배포 승인은 인수 가능한 수정본의 DEV에 한정된다. 안정판 main/tag는 변경하지 않는다. 사용자의 운영 HA 설치·시험은 사용자가 수행한다.

## 실제 독립 검증

| 검사 | 결과 |
| --- | --- |
| `.venv/bin/python -m pytest -q` | **129 passed in 7.25s** |
| wrapper, manual helper, S6 run ShellCheck | PASS |
| manager/daemon `node --check` | PASS |
| Dockerfile Hadolint, 3개 workflow actionlint, `git diff --check` | PASS |
| 기존 로컬 image inspect | `sha256:34f1874cbb1266d8429e82fda4cd1249a79920bb012844620725d121e1809019` 존재 확인. 이번 리뷰에서 build/전체 smoke/VM은 NOT RUN |
| 임시 runtime + 실제 등록 fixture PID로 apply 12회 | `blocked_busy`, `idleCheckCount=12` 재현 |
| 위 state에서 다음 날 slot과 같은 공식 형식 release fixture로 check | `blocked:true`, `lastCheckSlot`은 전날 값 그대로. 날짜 변경 자동 복구 없음 |
| canonical candidate 안의 `bin/codex`가 root 밖 fixture를 가리킴 | `validateSymlinkContainment(staged)`가 `valid:true` 반환 |
| PATH에서 flock을 찾을 수 없게 한 lock fixture | `withGateLock`이 잠금 없이 callback 실행 (`enteredWithoutFlock:true`) |

Fixture는 private temporary directory에서 실행·정리했고 실제 auth/token/session 본문과 proc environ을 읽지 않았다. 이미지 존재는 전체 런타임/HAOS 수용 PASS가 아니다.

## 1. P1 — busy 영구 차단 및 슬롯 반복 조회

근거: manager `1199-1200`, `1275-1295`; daemon `53-61`, `90-109`.

현재 한도는 **일 단위도 대화 턴 단위도 아닌 candidateVersion별 누적 12회**다. 다음 날/컨테이너 재시작/세션 종료에도 자동 재개되지 않는다. 수동 apply 또는 새 버전만 풀린다. 또한 같은 후보 blocked 반환에서 `lastCheckSlot`을 기록하지 않아 현재 slot에 조회했다는 사실이 남지 않는다. daemon은 blocked 상태에서 최대 한 시간 뒤 다시 조회하므로 하루 4회 계약도 깨진다.

요구:

- 기본 정책을 **설정 timezone의 날짜별 idle 검토 최대 12회**, **동일 후보 자동 restart transaction 최대 1회/24시간**으로 명확히 한다. 대화 턴 수와 무관하다. 날짜 경계 직전/직후 연속 restart를 피하도록 `nextRestartAllowedAt`도 유지한다.
- `budgetDate`, count, 마지막 시도/다음 재개 시각을 영속화한다. 같은 날짜의 daemon/App 재시작과 OFF/ON으로 budget을 초기화하지 않는다. 날짜 변경은 daemon이 실행 중인 상태와 재부팅 상태 양쪽에서 처리한다.
- busy 상한은 `paused_busy` 등 일시 보류로 분류한다. 당일 빠른 5분 검토를 멈추고 **다음 날짜의 첫 예약 슬롯에 동일 후보도 자동 재개**한다. 수동 명령 없이 장기 busy → 세션 종료 → 다음 날짜 적용까지 이어져야 한다. OFF일 때 재개하지 않는다.
- 후보 성공 후 같은 candidate 재적용/restart를 반복하지 않는다. 검증/무결성/정책 비호환은 busy와 구분해 자동 적용을 계속 차단하고, 이유와 복구 방법을 표시한다. 같은 버전 digest 변경을 자동 정상화하지 않는다. 전역 업데이터가 멈추지 않도록 하루 4회 최신 조회와 새 정상 후보 처리 경로는 유지한다.
- 모든 정상/blocked/prerelease 조회 결과의 `lastCheckSlot`을 같은 transaction으로 기록한다. 같은 slot의 daemon 반복·병렬 수동 호출에서 예약 조회가 중복되지 않게 한다. 다음 날까지 건너뛰거나 시간당 재조회하지 않는다.
- status에 한도 기준, 사용 횟수, pause/block 이유와 `nextRetryAt`/`nextRestartAllowedAt`을 노출하고 ko/en 문서에 정확히 설명한다.

## 2. P1 — 재시작 1회 기능 미구현

근거: manager `28-29`, `846`, `1205`, `1212`, `1367`. `MAX_RESTART_ATTEMPTS`는 선언만 있고 조건 비교·증가가 없다. signal은 gate helper 종료용 SIGTERM뿐이며 Codex server restart 경로는 없다. 유휴 Unix app-server도 항상 `restart unsupported`로 busy 처리한다. FIX_01_REPORT의 “재시작 1회 실패 후 blocked_restart”는 현 소스와 일치하지 않는다.

요구:

- 실제 App 소유권·PID/start identity·transport·공식 graceful semantics를 확인할 수 있는 서버에만 drain/restart transaction을 구현한다. signal 전 durable count/시각을 기록하고, 세션 재확인→안전 전환→새 PID/실제 executable version/socket readiness를 검증한다. 실패/부분 성공의 rollback·cooldown을 명확히 한다.
- 전체 App/Core restart나 강제 kill로 대체하지 않는다. unknown/Remote stdio는 자연 종료까지 보류한다. 자동 재시작을 지원하지 않는 대상은 사실대로 미지원으로 표시한다.
- 서버가 없을 때는 안전한 다음 launch 경로 검증으로 적용 완료 가능하다. 구버전 프로세스를 남기고 적용/재시작 완료를 보고하지 않는다.
- 실제 fixture process의 signal 수를 검증한다. 24시간 이내 반복 호출/daemon 재시작/OFF→ON/자정 경계에서 1회를 넘지 않고, cooldown 이후 정상 복구해야 한다. source 상수 assertion으로 대체하지 않는다.

## 3. P1 — 실행 tree 검증과 적용 전 정책 호환성 누락

근거: manager `187-210`, `1035-1110`, `1310-1349`; wrapper `139-142`.

최상위 target 경로만 검사하므로 candidate 안 `bin/codex`의 escaping symlink는 통과한다. `lstat`는 import만 있고 사용되지 않는다. wrapper는 baseline 경로에 `*`를 붙여 유사 prefix까지 허용한다. archive는 이름 검사 후 실제 추출하고 나서 symlink만 확인하며 hardlink/type/추출 총 크기 검사가 없다. 기존 destination이 있으면 검증한 새 extract를 버리고 기존 tree를 선택한다. 후보 실행 검증은 여전히 `--version`뿐이다.

요구:

- top-level link뿐 아니라 manifest/bin/companion과 중간 directory의 realpath, owner/mode/type/link count를 검증한다. baseline은 정확한 경로만 허용한다. wrapper와 manager가 같은 검증 결과/immutable generation을 사용한다.
- 추출 전 archive type/link target/경로와 추출 자원 한도를 검증한다. 추출 후 검사만으로 외부 쓰기를 막았다고 표현하지 않는다. destination 재사용 시 실제 bytes·manifest·tree를 다시 검증하거나 거부한다.
- 적용 전 isolated HOME에서 실제 새 binary의 managed config/requirements/MCP parsing, bwrap/AppArmor 민감 경로 deny·일반 RW·필수 resource/companion 호환성을 확인한다. 확인할 수 없으면 선택 전환을 차단한다. `--version` 성공만으로 future stable을 자동 신뢰하지 않는다.
- 정상 candidate와 bin/manifest/중간 symlink·hardlink·device·기존 destination 변조·비호환 candidate 음성 회귀를 추가한다.

## 4. P1 — 잠금·세션 검사 오류가 여전히 fail-open

근거: manager `224-230`, `479-511`, `777-808`, `736-746`; wrapper `133-150`.

flock 부재 시 callback을 무잠금 실행한다. wrapper는 registry 기록 실패를 무시하고 lock 실패 시 미등록 baseline을 실행한다. proc/registry 읽기 실패는 빈 목록/삭제로 처리한다. diagnostics의 필수 gauge가 없어도 `?? 0`으로 idle이 될 수 있다. 현재 Unix 서버 전체 보류가 일부 위험을 가릴 뿐, restart 구현의 안전 근거가 되지 않는다.

요구:

- lock 획득 불가 시 updater transaction은 실행하지 않는다. CLI 복구 fallback을 유지하려면 미등록 실행 중에도 updater가 idle이라고 판단할 수 없도록 안전한 오류 상태/프로세스 추적을 보장한다.
- `/proc`·registry 읽기 실패와 실제 종료를 구분해 unknown을 busy/blocked로 보존한다. companion/background도 포함한다. 로그에 사용자 본문/민감 경로 원문을 넣지 않는다.
- gauge 필수 이름·finite numeric 타입·범위와 pending 요청을 strict하게 확인한다. 빈 배열/누락/문자열/NaN은 idle이 아니다. 실제 PID/socket identity와 해당 tagged protocol을 확인한다.
- 병렬 launch/apply, 외부 flock 경합, registry 쓰기 실패, proc 읽기 실패, malformed RPC를 실제 함수/프로세스로 시험한다.

## 5. P2 — 보고서·테스트·현재 문서 증거 정합성

- FIX_01_REPORT가 열거한 `test_retry_caps_blocked_busy_and_restart`, `test_sec_websocket_accept_validation`, `test_archive_max_size_limit` 등의 이름은 현 파일에 없다. 실제 15개 updater 테스트 중 candidate 시험은 digest mismatch만 확인한다. malformed 시험은 존재하지 않는 socket 접속뿐이다. gate 시험은 `contentionFailed`를 계산하지만 assert하지 않고, 600ms hold에 1초 timeout이라 timeout 입증도 아니다. wrapper 시험은 복사한 parser를 실행한다.
- 기존 보고서는 보존하고 FIX_02_REPORT에서 정확한 실제 test 이름·명령·assert 범위를 정정한다. 미실행은 NOT RUN이다. VM의 임시 fixture container 성공을 Supervisor 설치/Config UI/실제 release 다운로드 PASS로 확대하지 않는다.
- `product_spec.md:289-291`에는 아직 `/data/codex-runtime/versions/<ver>`와 `current -> versions/<ver>`가 남아 있다. FIX_01_REPORT의 “전체 0건”을 정정하고 현재 구조로 고친다. 과거 changelog/progress/ADR의 버전 이력은 보존한다.
- progress에 이번 correction의 실제 상태·한계·배포 가능 여부를 기록한다.

## 재리뷰·DEV 전달 기준

1. 위 P1 수정, 날짜/slot/cooldown frozen-clock 회귀와 실제 signal/launch/package 음성 시험을 통과한다.
2. 후보 image ID와 full runtime/updater/0.7.0→후보 persistence smoke의 실제 명령/exit를 기록한다. 기존 이미지 존재만으로 PASS 처리하지 않는다.
3. 개발 VM 증거는 실제 수행 범위와 재현 명령을 기록한다. 사용자의 운영 HAOS 설치·UI·mobile 테스트는 DEV 발행 후 사용자 수용으로 명확히 남길 수 있다. native ARM build/runtime는 CI 또는 실제 실행 증거와 NOT RUN을 구분한다.
4. 안전한 후보를 Reviewer가 인수한 뒤 `docs/development/releasing.md`대로 미사용 `0.7.1-dev.N` metadata/DEV identity를 맞춰 dev CI·tag builder·GHCR 발행을 검증한다. main/stable은 변경하지 않는다. 설치할 DEV 버전과 공개 image를 확인해야 배포 완료다.
