# FIX_07 — 유휴 자동 전환 제품 경로 구현

## 1. 재리뷰 판정

- Reviewer: Codex, 2026-10-29 (Asia/Seoul). 기준: HEAD `5529c66` 위 현재 working tree, PLAN/REPORT, FIX_01~06 및 대응 REPORT.
- **L1 수정 수용 / L2 미해결 / REQUEST CHANGES / task 006 미완료**.
- Reviewer는 제품 코드를 수정하지 않았다. 기존 handoff와 취소된 task 005를 보존하고, 다음 Executor는 이 문서를 수행한 뒤 `FIX_07_REPORT.md`를 신규 작성한다.

시작 stdout 버퍼링으로 이전 L1 재현이 해소됐다. 독립 실제 합성 child 시험에서 시작 직후 `thread/status/changed(active)`가 client 출력으로 전달됐고 `busy:true`, `activeTurns:1`이었다. 이전 실제 child의 부분 서버 프레임도 `serverBuffer`에 보존되어 `busy:true`, `worker_busy`로 전환을 거부했다. 이 두 결함을 다시 수정 대상으로 남기지 않는다.

이번 재리뷰에서 추가로 입증한 새로운 차단 결함은 없다. 남은 P1은 이전부터 미해결인 **사용자 목표의 제품 구현 자체**다. 안전 gate 유지 사실을 반복 기록하는 것으로 이 correction을 수행한 것이 되지는 않는다.

## 2. 남은 P1: 기존 idle backend 자동 업데이트가 실행되지 않음

**위치:** `codex-runtime-manager.mjs:2352-2367`, `/usr/local/bin/codex` 일반 CLI direct exec 경로 및 transaction recovery.

- `canAttemptRestart`가 true면 항상 `compatibility_unverified`로 반환하여 아래 restart transaction은 도달할 수 없다.
- CLI/TUI는 frontend를 유지하는 관리형 backend 경로로 연결되지 않았다.
- authoritative background/goal 관측과 journal 자동 recovery도 미완료다.
- FIX_06_REPORT는 이 상태와 dev에서 핵심 성공 시나리오를 시험할 수 없다는 사실을 정확히 명시했다. 보고의 정직성은 인정하지만 기능을 인수할 수는 없다.

### 다음 Executor의 실행 범위

1. PLAN의 stable endpoint 설계를 실제 CLI/TUI launch 경로에 연결한다. 기존 frontend/PTY·SSH/stdio 연결과 같은 대화 ID를 보존하며 backend만 전환한다. 단순히 새 실행의 selected version만 바꾸지 않는다.
2. 정확한 공식 baseline/후보 pair에서 검증한 capability와 복원 가능한 상태에 한해 scheduler→idle 검사→admission barrier→worker 전환→상태 commit→입력 재개를 실제 제품 경로로 연결한다. 확인되지 않은 세션·버전 조합은 구체적인 이유로 보류한다. blanket gate를 단순 삭제하지 않는다.
3. 미저장/ephemeral 대화, thread config/policy·subscriptions와 background/goal의 상태 계약을 검증한다. 지원되지 않는 상태는 safe unknown으로 남기되 지원 가능한 정상 경로까지 항상 비활성화하는 것으로 구현 완료 처리하지 않는다. 사용자 대화를 새 빈 대화로 대체하지 않는다.
4. host별 실제 phase/identity를 확인하는 transaction recovery를 구현한다. timeout·late ACK·부분 release·updater 재시작에서 현재 작업을 종료/중복 실행하지 않고 복구하거나 명확한 미완료 상태를 유지한다. journal 존재만으로 신규 launch를 영구 차단하는 것은 자동 복구 구현이 아니다.
5. 실제 기술 blocker 때문에 구현할 수 없는 부분은 정확한 version/digest, source/schema, 재현 코드·명령·입출력, 필요한 최소 upstream/adapter 변경을 제시한다. 현재 프로젝트에서 아직 구현하지 않은 부분과 upstream이 제공하지 않는 부분을 구별한다. 같은 gate를 유지했다는 설명만 추가하여 L2를 수행 완료로 표시하지 않는다.

### 수용 기준

최소 하나의 검증된 공식 pair에서 CLI/TUI와 Remote stdio 모두 다음을 production 경로에서 보여야 한다.

- 열린 idle 대화와 frontend를 유지한 상태에서 실제 scheduler가 기존 backend를 바꾸고, 같은 대화의 다음 요청을 신규 backend가 처리한다.
- active turn/tool/child agent·queued request·approval/입력 대기·background 작업 중에는 전환하지 않고, 종료 후 다음 허용 검사에서 실제 idle이 해소된다.
- 실패·ACK 유실·부분 host 전환·재시작에서 actual phase와 identity에 맞게 recovery하고 허위 applied/restored와 입력 손실/중복이 없다.

공식 pair의 로컬 합성 모델 시험과 실제 HAOS/mobile 수용은 구별한다. 실환경 변경이나 실제 모델 credential 사용을 자동으로 확대하지 않는다. 남은 blocker를 검토·인수할 수는 있지만 그 경우 task와 dev 시험의 제한을 그대로 유지한다.

## 3. 검증 근거와 이번 범위

- 실제 child probe 결과: `.test-tmp/review006-fix06/startup-output.log`, `server-generation.log` (Git 제외).
- 독립 pytest에서 production stdio·rollback 보호·journal 보류·상태 중복·preflight 종료 관련 선택 회귀 **9 passed, 110 deselected in 12.15s**. JS 3개 각각 `node --check`, wrapper `shellcheck`, `git diff --check` PASS.
- 전체 **262 passed, 1 skipped**는 Executor 보고 결과다. 이번 Reviewer는 전체 suite·공식 pair·Docker/AppArmor·native ARM·HAOS/mobile·실모델·장기 시험을 재실행하지 않았다.

## 4. dev 배포 인계 조건

사용자의 ‘더 처리할 것이 없으면 dev 배포를 지시’ 요청은 유지한다. 현재는 L2가 남아 조건이 충족되지 않았다. 기능이 비활성인 dev를 게시해 핵심 자동 전환의 실기기 시험이 가능해졌다고 안내하지 않는다.

위 구현과 재리뷰를 인수하면 FIX_06 §4의 기존 dev branch·새 immutable dev version·CI/native Builder·공개 이미지/설치 표면 확인 절차로 배포를 지시한다. 설치 가능한 정확한 버전·저장소 주소와 시험 절차를 사용자에게 전달하는 것까지 배포 단계의 산출물로 삼는다. Stable 0.7.2 승격 또는 사용자 장치의 업데이트·재시작을 자동 수행하지 않는다.
