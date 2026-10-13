# FIX_03 — FIX_02 재리뷰: staging 차단과 안전하지 않은 서버 교체

## 판정과 범위

- Reviewer: 2026-10-13, Asia/Seoul. **CHANGES REQUESTED**. 현재 후보는 인수 불가이며 DEV 배포를 수행하지 않는다.
- 기준: PLAN/REPORT/FIX_01/FIX_01_REPORT/FIX_02/FIX_02_REPORT와 `feat/codex-auto-update`의 현재 tracked/untracked working tree. 기존 문서는 보존한다. 수정 결과는 새 `FIX_03_REPORT.md`에 기록한다.
- 사용자 승인 범위는 인수 가능한 후보의 DEV 전달이다. main/stable 및 운영 HA 변경은 하지 않는다. 사용자가 DEV 설치 후 실제 HAOS 수용을 수행할 예정이다.
- 구현 코드는 Reviewer가 수정하지 않았다. 날짜별 busy 재개와 flock 부재 차단, gauge 필수 검사, 현재 product_spec 경로 정정은 개선되었지만 아래 실제 실행 결함이 남았다.

## 독립 검증

| 검사 | 결과 |
| --- | --- |
| `.venv/bin/python -m pytest -q` | **133 passed in 9.12s** |
| wrapper/manual helper/S6 run ShellCheck, manager/daemon Node syntax | PASS |
| Dockerfile Hadolint, workflow actionlint, `git diff --check` | PASS |
| 정상 staging 위치의 executable+manifest fixture 검증 | `valid:false`, `Package path is not canonical releases or baseline` |
| 로컬 HTTPS의 정상 archive와 일치하는 SHA-256으로 실제 `downloadAndStagePackage` 실행 | `Package tree validation failed: Package path is not canonical releases or baseline` 재현 |
| canonical release 안 외부 hardlink 실행 파일 + 다른 version/target manifest 검증 | `validateCandidatePackageTree`가 `valid:true` 반환 |
| Docker rebuild/full smoke/HAOS/native ARM | 이번 리뷰에서 **NOT RUN**. FIX_02_REPORT도 image rebuild/full smoke 미실행을 명시함 |

재현은 private temporary directory에서만 수행했다. HTTPS fixture는 localhost ephemeral port를 사용했고, fixture 자체 서명 인증서 허용은 해당 Node child 환경에만 한정했다. 실제 인증·토큰·세션 본문·proc environ은 읽지 않았다. 테스트 후 fixture server와 임시 파일을 정리했다.

## 1. P1 — 모든 신규 package가 staging 검증에서 거부됨

근거: `codex-runtime-manager.mjs:194-203`, `1076-1078`, `1215-1218`.

`downloadAndStagePackage()`는 `/data/codex-runtime/staging/.extract-*`에 추출한 뒤 `validateCandidatePackageTree(extractDir)`를 호출한다. 이 함수는 `isCanonicalRuntimePath`로 releases 또는 정확한 baseline만 허용한다. 따라서 checksum과 tar가 정상이어도 신규 패키지는 stage되지 않는다. 현재 테스트들은 releases 아래 fixture를 직접 생성하므로 이 production 경로를 건너뛴다.

수정:

- **검사할 tree의 허용 root와 tree 내부 안전성 검사를 분리**한다. private extraction 디렉터리는 updater가 생성·소유한 정확한 임시 root로만 검증할 수 있어야 한다. current/staged/previous가 staging이나 임의 경로를 실행하도록 canonical 제한을 넓히지 않는다.
- 정상 archive의 실제 download→digest→extract→validate→stage→busy 보류→세션 종료→apply 성공 회귀를 추가한다. positive path를 production 함수로 실행하고 선택된 bytes/version/target을 assertion한다.
- 실패 archive에서는 state/current가 유지되고 임시 download/extract가 정리되는지도 검증한다.

## 2. P1 — 실행 중인 동일 version directory를 재귀 삭제하는 회귀

근거: manager `1263-1267`.

기존 destination이 있으면 무조건 `rm(... recursive:true)`하고 새 extract로 교체한다. 이는 FIX_01의 실행 resource 보존과 FIX_02의 기존 destination 재검증/거부 요구를 위반한다. CLI 또는 companion이 그 디렉터리의 라이브러리/resource를 사용 중이면 경로가 사라지거나 같은 이름의 다른 bytes로 바뀐다. 현재 staging 차단을 고치는 즉시 활성화되는 결함이다.

수정:

- release generation은 immutable하게 유지한다. 기존 destination의 manifest/digest/tree가 일치하면 안전하게 재사용하고, 다르거나 검증할 수 없으면 거부/격리한다. 활성/previous/staged/실행 참조본을 덮어쓰거나 삭제하지 않는다.
- 실행 중인 fixture process와 companion resource를 보존하면서 동일 version stage를 재호출하는 시험을 추가한다. stage와 GC 양쪽에서 bytes/inode/resource 가용성이 유지되어야 한다.

## 3. P1 — 새 서버 재시작 경로의 소유권·검증·복구 부재

근거: manager `940-998`, `1483-1589`.

- 프로세스 이름/인자와 Unix diagnostics만으로 찾은 app-server를 모두 `restartableServers`에 넣는다. App 관리 서버라는 launch record나 검증된 소유권이 없고, wrapper를 통해 시작한 서버는 등록 CLI로 busy 처리되므로 정상 관리 경로와도 어긋난다.
- signal 전 PID/start identity와 executable generation을 다시 확인하지 않는다. idle RPC 재검사는 프로세스 소유권/identity 검증을 대신하지 못한다.
- restart 분기는 no-server 분기의 pre-apply version 검증을 건너뛴다. 새 서버 readiness는 RPC idle만 확인하며 실제 executable/version을 검증하지 않는다.
- `spawn`은 updater 환경/cwd를 그대로 사용하고 lifecycle error handler가 없다. launch 실패 시 unhandled error가 daemon을 종료할 수 있다.
- readiness 실패 rollback은 symlink만 복원한다. 이미 종료시킨 구버전 서버를 다시 시작하지 않으므로 정상 서비스를 복구하지 못한다. 여러 서버 중 일부만 교체된 경우도 동일하다. 성공 분기는 previous link를 갱신하지 않고 staged link/candidate metadata를 정상 경로처럼 정리하지 않으며 `cleanupOldReleases()`에 필수 인자를 전달하지 않는다.

수정:

- 검증된 App 관리 서버만 교체한다. 현재 저장소에는 전역 Codex server S6 서비스가 없으므로 임의 발견 서버를 관리 대상으로 취급하지 않는다. unknown/Remote stdio는 자연 종료까지 보류한다. 지원 대상의 explicit launch/ownership record와 안전한 env/cwd/args 계약을 마련한다.
- 공식 tagged 구현과 실제 runtime에서 graceful signal semantics를 확인한다. PID/start/executable identity와 active/pending/background 상태를 마지막으로 확인한 뒤, 영속 cooldown journal을 기록하고 교체한다. 강제 kill/App/Core restart는 도입하지 않는다.
- package 정책 호환성 검증은 signal 전 완료한다. launch error를 처리하고 새 PID/start/executable version/socket readiness를 모두 확인한다. 실패/부분 성공 시 기존 서버 가용성과 pointer/journal을 함께 복구한다.
- success 후 current/previous/staged/candidate 상태가 일치해야 한다. GC는 정확한 보존 인자를 받고, 불확실한 참조는 삭제하지 않는다.
- 실제 `applyUpdate()`로 restart 성공/launch 실패/readiness 실패/부분 성공/PID 교체/24시간 cooldown을 실행하고 signal 수와 서비스 복구를 assertion한다.

## 4. P1 — package 무결성·적용 전 정책 호환성 검증 부족

근거: manager `194-285`, `1184-1215`, `1225-1257`; wrapper의 current 선택.

tree 검사에는 owner/mode/nlink 검사가 없고, manifest는 version/target이 truthy인지 확인할 뿐 기대 version/architecture와 비교하지 않는다. 이전의 다운로드 manifest exact 비교가 새 구현에서 사라졌다. 실제 외부 hardlink 실행 파일과 잘못된 version/target manifest 조합이 수용됐다. archive는 추출 전 type/link target/총 추출 크기를 검사하지 않는다. wrapper는 top-level target prefix만 검사한다.

`--help`, `-c 'approval_policy="safe"' --help`는 실제 config/requirements/MCP parsing이나 sandbox 실행을 입증하지 않는다. `safe`는 이 App의 승인 정책 값도 아니다. future stable을 자동 적용하기 전에 managed requirements/필수 resource와 보호 경로 deny가 작동함을 확인해야 한다.

수정:

- expected version/target/entrypoint/digest와 실제 manifest/tree를 대조한다. hardlink, owner/type/mode, 중간 디렉터리/manifest/bin symlink를 검증한다. wrapper도 검증된 immutable generation을 선택한다.
- archive extraction 전에 type/link target/경로/자원 한도를 검사한다. 추출 후 tree 검증은 추가 방어로 유지한다.
- isolated HOME 및 실제 image/AppArmor에서 지원하는 config/requirements/MCP·sandbox deny/정상 RW/resource 실행을 검증한다. `--help` 성공만으로 정책 호환성을 승인하지 않는다.

## 5. P2 — 재시작/기간별 한도 테스트와 보고서 주장 정정

`test_server_graceful_restart_transaction_with_fixture_process` (`tests/test_codex_update_contract.py:673-853`)는 server fixture를 띄우지만 실제 `applyUpdate()`를 호출하지 않는다. `mockSessions`는 사용되지 않고, `withGateLock` 안에서 timestamp 비교식을 다시 구현해 true인지 확인한다. 마지막 `terminate()`는 pytest cleanup이다. 따라서 실제 graceful restart·signal 상한·rollback PASS가 아니다.

`test_daily_idle_budget_pause_and_next_day_recovery`도 clock을 움직이지 않고 `budgetDate`를 과거 값으로 직접 바꾼다. candidateVersion이 초기화되지 않아 check에서 새 후보 분기로 들어갈 수 있다. 실제 같은 후보의 다음 날짜 첫 슬롯 자동 재개와 재부팅/OFF→ON/자정 경계는 입증하지 못한다. `nextRetryAt`은 다음 슬롯으로 계산돼 당일 09시 등을 표시할 수 있으나 실제 재개 정책은 다음 날짜 첫 슬롯이다.

- 실제 clock 주입으로 동일 후보·같은 날짜·다음 날짜·컨테이너 재시작·OFF/ON·cooldown을 시험한다. count 상한은 일시적인 `status` 문자열만으로 우회되지 않아야 한다.
- `nextRetryAt`을 실제 재개 시각과 맞추고 정상 재개/성공 후 stale 값을 정리한다.
- 기존 보고서는 보존하고 FIX_03_REPORT/progress에서 완료 주장을 정정한다. 실제 사용 함수/명령/exit/image ID와 미수행 범위를 기록한다.
- 수정 후보 image를 rebuild하여 full runtime/updater/0.7.0→후보 persistence smoke를 실행한다. native ARM은 CI 또는 미수행을 구분하고, 사용자의 운영 HAOS 설치·UI/mobile 수용은 DEV 전달 후 수행 항목으로 남길 수 있다.

## 다음 단계

위 결함을 수정하고 실제 positive stage/apply/restart 경로 및 음성 회귀가 통과한 뒤 재리뷰한다. 인수 가능 시 미사용 `0.7.1-dev.N`과 DEV identity를 맞춰 dev CI/tag builder/GHCR 발행을 완료한다. 현 working tree를 그대로 배포하지 않는다.
