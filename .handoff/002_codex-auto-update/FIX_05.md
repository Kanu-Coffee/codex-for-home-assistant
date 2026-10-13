# FIX_05 — FIX_04 리뷰: 실행 참조 GC·부분 drain 복구·재검토 상한

## 판정과 범위

- Reviewer, 2026-10-13 Asia/Seoul. **CHANGES REQUESTED**, DEV 발행 보류.
- 기준: PLAN/REPORT, FIX_01~04 및 보고서, 실제 working tree. Branch `feat/codex-auto-update`, HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1`.
- 기존 handoff를 보존한다. 다음 Executor는 본 문서를 수행하고 `FIX_05_REPORT.md`를 새로 작성한다. Reviewer는 구현을 변경하지 않았고 commit/push/tag/release·운영 HA 변경도 하지 않았다.
- 개선 확인: package 전체 inventory와 receipt/journal 검증, invalid destination 보존, wrapper JSON metadata, 실제 executable/version/RPC readiness, 실제 managed sandbox policy probe, 실제 amd64 image/개발 HAOS Docker 증거가 추가됐다. 이전 help-only·변조 package 적용 결함과 동일한 문제라고 판단한 것이 아니다.

## 독립 검증

| 검사 | 결과 |
| --- | --- |
| `.venv/bin/pytest -q` | **189 passed in 43.11s** |
| 변경 wrapper/manual/S6/updater smoke ShellCheck | PASS |
| 전체 workflow actionlint, Dockerfile Hadolint, `git diff --check` | PASS |
| 실제 `applyUpdate()` + 구버전 resource의 live FD | **applied:true인데 resource 경로 삭제** |
| 실제 두 서버 + 두 번째 SIGHUP drain timeout | **첫 번째 서버 종료 후 복구 없음** |
| 실제 managed fixture + 쿨다운 중 `applyUpdate()` 13회 | **정책 probe 13회, idleCheckCount 0** |
| New York DST 슬롯 시간 계산 | **03시 대신 04시/02시 반환** |
| 새 image build/HAOS Docker/native ARM/수정 GitHub CI | 이번 Reviewer **NOT RUN**. FIX_04_REPORT의 실행 증거와 구분 |

재현은 private temporary directory, harmless Node/shell executable, synthetic socket/resource만 사용했다. Production 함수 `applyUpdate`/`restartServers`를 호출했다. GC 시험은 정책 probe만, restart 실패 시험은 RPC idle adapter만 주입했다. 실제 auth/token/session 본문이나 proc environ을 읽지 않았다. Fixture process와 임시 directory를 정리했다.

이번 리뷰 재현용 임시 실행 파일: `/tmp/codex-ha-review05-repro.py`, `/tmp/codex-ha-review05-drain.py`, `/tmp/codex-ha-review05-cooldown.py`. 재현 방법과 기대 계약은 아래에 기록하므로 임시 파일이 없어도 회귀를 구현할 수 있다.

## 1. P1 — GC가 살아 있는 companion/resource 참조를 삭제한다

근거: `codex-runtime-manager.mjs:1897-1928`, PLAN의 실행 resource 보존 및 GC 조건.

GC가 참조를 판단할 때 `/proc/*/exe`만 읽는다. Interpreter·helper의 실제 실행 파일이 Node/시스템 binary이고 구버전 package의 resource를 FD/mmap/cwd 등으로 사용하는 경우는 보호하지 않는다. `/proc` 조회 실패도 빈 결과로 취급해 삭제할 수 있다. Staging 단계의 invalid destination 보존 시험은 이 별도 GC 경로를 검증하지 않는다.

재현: baseline 0.162.1과 candidate 0.163.0을 만들고, current/previous가 가리키지 않는 0.160.0 resource를 별도 Node process가 open한 채 유지한다. 경로는 stdin으로 전달해 cmdline에 포함되지 않는다. Candidate는 기존 fixture 방식의 receipt/digest로 seal하고 staged/state를 설정한다. 실제 `applyUpdate({policyProbe:...})` 호출 결과:

```json
{"applied":true,"idle":true,"resourceExists":false,"referencedFdDeleted":true,"readerAlive":true}
```

수정:

- GC에서 current/previous/staged와 실행·companion/resource 참조를 보존한다. Relative pointer는 runtime root 기준으로 해석한다. 필요한 제한된 process metadata를 검사하되 비밀 본문/environ은 읽지 않는다.
- 참조 없음이 확인되지 않으면 삭제를 보류한다. 안전한 참조 판정을 구현하기 어렵다면 자동 recursive GC를 일단 비활성화하고 보관/디스크 부족 상태를 명시하는 좁은 수정도 가능하다.
- 실제 apply가 호출하는 GC에서 live executable, interpreted entrypoint, FD/resource/mapping, relative pointer, 검사 실패를 검증한다. 참조 종료 뒤에만 삭제 가능해야 한다. Unlinked inode가 FD로 읽힌다는 사실은 resource 경로/후속 open의 가용성 보장을 대신하지 않는다.

## 2. P2 — 뒤 서버의 drain 실패가 앞 서버의 복구까지 막는다

근거: `codex-server-transaction.mjs:93-118`.

두 번째 old server가 HUP 후 종료하지 않으면 `unresolvedDrain=true`이고 catch의 `restored=false`가 된다. `if (restored)`가 이미 정상 종료한 첫 번째 서버의 복구까지 모두 건너뛴다. 두 서버는 서로 다른 socket인데도 첫 서버의 가용성을 불필요하게 잃는다. `rollback_incomplete` 표시는 정확하지만 가능한 서비스 복구가 누락됐다.

재현: 두 개의 실제 Node Unix server를 같은 old executable로 시작한다. 첫 서버는 HUP 후 정상 종료하고, 두 번째는 HUP을 기록하되 살아 있게 한다. Launch contract/preflight는 실제 PID/start/executable/version을 확인하고 RPC adapter만 idle로 주입한다. 결과:

```json
{"result":{"applied":false,"reason":"drain_timeout","recovery":"rollback_incomplete"},"attempt":1,"live":["2"],"launches":2}
```

- 전체 rollback 성공 여부와 각 socket의 복구 가능 여부를 분리한다. 살아 있는/identity 불명 서버의 socket을 중복 점유하지 않으면서 종료가 확인된 서버는 개별적으로 이전 executable/version/readiness/record를 복구한다.
- 미완료 서버에는 반복 HUP/강제 kill을 하지 않는다. 전체 결과가 incomplete여도 안전한 복구 시도는 수행한다. 쿨다운은 유지한다.
- 회귀는 두 번째 old server의 drain timeout/identity 검사 실패와 일부 replacement의 drain 실패를 포함한다. Socket별 실제 PID/version/record, 정상 복구된 서비스, signal 상한을 assertion한다.

## 3. P2 — 쿨다운 상태의 재검토와 정책 실행에 일일 상한이 없다

근거: manager `1694-1721`, daemon `103-120`.

`paused_restart`도 daemon의 5분 pending apply 대상이다. `applyUpdate()`는 쿨다운을 검사하기 전에 전체 integrity/session 검사와 managed policy probe를 실행한다. 이 경로는 idleCheckCount를 증가시키지 않는다. 따라서 재시작 자체는 24시간 차단돼도 여러 Codex/sandbox/probe app-server를 띄우는 재검토는 5분마다 계속된다. 사용자가 요청한 무한 재검토 방지와 일일 12회 설명이 이 상태에는 적용되지 않는다.

재현: 기존 `test_server_graceful_restart_transaction_with_fixture_process`의 성공 후 staged candidate를 유지하는 부분에서 두 번째 apply를 13번 반복하고 injected policyProbe 호출 수를 센다. 기존 성공/쿨다운 assertion도 통과했다:

```json
{"probeCount":13,"reason":"restart_cooldown","idleCheckCount":0,"restartAttemptCount":1}
```

- 쿨다운 중에는 불가능한 restart를 위한 정책 probe를 반복하지 않는다. 일일 재검토 budget과 `nextRetryAt`을 실제 daemon 분기에 연결한다. 다음 예약 날짜/쿨다운 만료 시 정상 재개하도록 한다.
- 세션이 자연 종료되면 signal 없이 선택 전환할 수 있는 동작은 유지한다. 이를 위해 가벼운 세션 검사를 하더라도 명확한 상한과 재개 시각을 정한다.
- 시계 주입으로 daemon의 실제 반복 흐름을 검증한다. 같은 날짜 13번째 검사, 재부팅/OFF→ON, 자정/다음 슬롯, cooldown 만료 및 세션 자연 종료를 포함한다. 정책 probe 횟수와 signal 횟수는 별도 assertion한다.

## 4. P2 — IANA timezone의 DST 전환에서 슬롯 시각이 틀린다

근거: manager `133-135`, `201-205`.

지역 시각의 시간 차에 고정 3600초를 곱하므로 UTC offset이 바뀌는 밤을 처리하지 못한다. `getCurrentSlotInfo()`의 next timestamp를 계산하면:

- `America/New_York`, `2026-03-08T01:30:00-05:00`: 다음 03시는 `07:00Z`인데 `08:00Z`(현지 04시).
- 같은 timezone, `2026-11-01T00:30:00-04:00`: 다음 03시는 `08:00Z`인데 `07:00Z`(현지 02시).

Daemon의 시간별 재계산이 일부 오차를 줄일 수 있지만 봄 전환의 예약 확인이 늦어질 수 있고, `nextRetryAt`도 같은 방식으로 틀린다.

- 목표 지역 calendar date/hour를 먼저 정하고 해당 timezone의 실제 UTC instant로 변환한다. next-slot과 budget 재개 계산에 같은 계약을 사용한다. 03시 이전의 '다음 날짜'가 slotDate 기준인지 calendar date 기준인지도 명확히 한다.
- 서울/UTC 정상 경로와 봄/가을 DST, 자정 경계, 다음 날짜 budget 재개를 회귀 검증한다. 새 dependency 설치 없이 기존 runtime의 기능으로 해결할 수 있다.

## 한도·옵션·버전 검토와 다음 단계

- 현재 busy 한도는 timezone의 slotDate 기준 **일일 12회**, restart 한도는 영속 timestamp의 **rolling 24시간 1회**다. Turn별·평생 누적 차단은 아니다. 단, 3번의 쿨다운 재검토 누락을 수정해야 한다.
- 실패한 integrity/policy/restart의 blockedReason은 날짜가 지나면 무조건 풀리는 구조가 아니다. 원인 해결 뒤 명시적 manual apply/update가 복구 경로이며, 무한 자동 재시작을 피하려는 의도다. 복구 가능한 서비스 자체를 잃는 2번은 별도 수정해야 한다.
- HA bool schema와 ko/en 옵션 번역이 추가됐고 상태는 bundled/selected version을 구분한다. App/config/Dockerfile/package metadata는 0.7.1, baseline은 0.162.1이다. 0.7.0 안정판/이전 update source와 0.144.1 과거 fixture를 무조건 치환하지 않는다.
- README의 현재 0.7.1 설치 안내에 이어지는 Native ARM 통과 문구는 이번 runtime의 결과와 과거 0.7.0 결과를 구분하도록 보완한다. FIX_04_REPORT는 현재 ARM NOT RUN을 올바르게 구분한다.
- 공식 [HA options/version 명세](https://developers.home-assistant.io/docs/apps/configuration/)와 [Codex tagged app-server source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/lib.rs)를 다시 확인했다. HUP graceful-only와 bool 옵션은 유지한다.
- 위 수정 후 full pytest, 관련 lint, 실제 image updater/full runtime/0.7.0 persistence를 위험에 맞게 재검증하고 정확한 image ID·명령·결과·NOT RUN을 FIX_05_REPORT/progress에 남긴다. Native ARM은 수정 CI의 실제 run 결과와 구분한다.
- 인수 가능하면 기존 사용자 승인대로 미사용 `0.7.1-dev.N`의 DEV identity/branch/tag/Builder/GHCR 발행을 진행한다. Main/stable은 변경하지 않는다. 운영 HAOS 설치/UI/mobile 수용은 DEV 전달 후 사용자가 수행한다.
