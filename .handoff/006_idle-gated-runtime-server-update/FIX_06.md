# FIX_06 — 시작 출력 유실 및 dev 배포 전 잔여 조건

## 1. 판정과 사용자 요청

- Reviewer: Codex, 2026-10-28 (Asia/Seoul). 기준은 HEAD `5529c66` 위 현재 working tree, PLAN/REPORT 및 FIX_01~05와 대응 REPORT다.
- **REQUEST CHANGES / task 006 미완료 / 현재 후보 dev 배포 지시 보류**. 제품 코드를 수정하지 않았다. 다음 Executor는 이 correction을 수행하고 `FIX_06_REPORT.md`를 신규 작성한다.
- 사용자는 더 처리할 것이 없으면 dev 버전으로 배포를 지시하여 직접 실기기에서 설치·시험하기를 요청했다. 이 요청은 완료 후 dev 배포 단계의 근거이며, 현존 결함이나 핵심 기능 미구현을 수용했다는 뜻은 아니다. 보완·재리뷰 후 dev 설치 가능 상태로 전달하는 단계를 누락하지 않는다. Stable 승격과 사용자 운영 장치의 직접 업데이트·재시작은 별도다.

## 2. FIX_05 대응 확인

- server/client 부분 문자열과 decoder의 미완성 UTF-8을 busy로 처리하고, drain의 조기 반환을 포함해 cleanup을 통일한 개선을 확인했다.
- 단순 PTY 마이그레이션 불가 주장은 정정됐다. stable endpoint는 frontend/PTY를 보존한다는 설명은 PLAN과 일치한다.
- 그러나 stdout의 generation 검증에서 시작 직후 정상 출력을 버리는 새 회귀가 있다(L1). 기존 K2의 제품 경로·자동 recovery는 구현되지 않았다(L2).
- 독립 전체 `.venv/bin/python -m pytest -q` → **261 passed, 1 skipped in 109.83s**. JS 3개 각각 `node --check`, wrapper `shellcheck`, `git diff --check` PASS. 이번 리뷰의 합성 probe/로그는 Git 제외 `.test-tmp/review006-fix05/`에 있다.
- 공식 package pair와 Docker/AppArmor·native ARM·HAOS/mobile·실모델·장기 시험은 이번 Reviewer가 실행하지 않았다. 보고서의 **261 passed, 1 skipped**는 아래 독립 결과와 별도로 Executor 제공 결과다.

## 3. 필수 correction

### L1 — [P2] 새 worker가 시작 직후 내보낸 stdout까지 구 세대 출력으로 폐기

**위치:** `codex-session-host.mjs:529-568`.

`activeGeneration`은 spawn 전에 새 세대로 바꾸지만 `this.child = child`는 50ms timer 안에서만 실행한다. stdout listener는 `this.child !== child`일 때 즉시 반환하므로 실제 새 child가 그 50ms 안에 출력한 모든 바이트를 폐기한다. 최초 시작과 후보/rollback 기동 모두 같은 구조다. 기존 세대의 지연 출력 차단과 새 세대의 startup 출력을 구분하지 못한다.

**독립 실제 child 재현 (`startup-output.mjs`):** `/bin/sh -c`로 시작 즉시 다음 정상 JSON notification을 한 줄 출력한 뒤 `exec cat`으로 살아 있는 합성 worker를 생성한다.

```json
{"method":"thread/status/changed","params":{"threadId":"synthetic-thread","status":{"type":"active","activeFlags":[]}}}
```

`StdioRelay.start({attachStdio:false})` 뒤 충분히 기다려 inspect하면 실제 결과는 `forwarded:''`, `busy:false`, `activeTurns:0`, `serverBuffer:''`다. 새 worker의 이벤트가 출력·상태 원장 모두에서 사라졌다. FIX_05 이전 실제 child 부분 프레임 probe를 그대로 실행해도 `serverBuffer:''`, `busy:false`, switch success로 바뀌었다. 이는 부분 프레임을 정상 처리한 결과가 아니라 startup prefix가 먼저 폐기된 결과다.

이 재현은 production relay와 실제 합성 child 기준이며 공식 Codex가 시작 50ms 내 이 이벤트를 보낸다는 주장이나 실기 장애 재현은 아니다. 다만 transport가 신세대 정상 출력을 조용히 버리는 코드 결함은 명확하며 live gate와 무관하게 기본 stdio 경로에서도 존재한다. 새 계약 테스트는 start 완료 후 `_handleServerData`를 직접 호출하므로 이 구간을 검증하지 못한다.

**수정:** child/generation 소유권을 stdout을 받기 전에 확정하거나, 기동 readiness 대기 중의 새 child 출력을 보존·처리한다. 50ms 실패 확인 대기 자체와 현재 child 식별을 분리할 수 있다. 조기 exit/spawn 실패 시 stale identity가 남지 않게 하고, old 세대의 지연 바이트 차단과 단일 writer 보호는 유지한다. 수신한 신세대 바이트를 조용히 폐기해 startup 실패를 숨기지 않는다.

**수용:** 실제 child가 spawn 직후 완성 notification/서버 요청, partial JSON, 한글 UTF-8을 출력하는 시험을 추가한다. 첫 바이트부터 순서대로 전달·추적되고 partial 상태에서는 전환을 보류해야 한다. 정상 old 종료와 candidate/rollback 기동·조기 exit·늦은 old stdout을 교차시켜 정상 initialize 및 같은 연결의 다음 요청을 확인한다.

### L2 — [P1, 이월] 사용자 실기기에서 시험하려는 유휴 자동 전환이 제품 경로에 없음

**위치:** `codex-runtime-manager.mjs:2352-2367`, 일반 CLI wrapper direct exec 경로, transaction recovery.

현재 모든 restartable live server는 유휴라도 `compatibility_unverified`로 반환한다. CLI/TUI는 backend 분리가 연결되지 않았으며, 자동 transaction recovery와 authoritative background/goal 관측도 미완료다. 이 상태를 dev로 게시해도 사용자는 ‘열린 CLI/TUI·Remote stdio를 그대로 두고 유휴일 때 기존 backend가 업데이트되는지’를 성공 경로로 시험할 수 없다. 문서화와 안전 보류는 필요하지만 기능 구현을 대체하지 않는다.

**다음 작업:** K2와 PLAN의 잔여 구현을 수행한다. 검증된 pair/capability에 한해 frontend/연결/대화를 보존하는 backend 전환을 실제 scheduler 경로에 연결하고, busy/queued/approval/background 보호 및 작업 종료 후 유휴 해소를 검증한다. 실패·부분 release·ACK 유실·재시작에서 host별 실제 phase/identity를 확인해 recovery를 완료하는 경로를 제공한다. 미저장/ephemeral thread 및 config/subscription 인계가 제약이면 버전별 schema/source·정확한 실패 절차와 최소 upstream/adapter 변경을 기록한다. 해당 제약이 목표 전체의 불가능성인지 검증되지 않은 부분을 구별한다.

gate를 무조건 제거하거나 새 빈 대화로 교체해 성공 처리하지 않는다. 기술 blocker가 남으면 새 REPORT에서 미완료와 사용자가 dev에서 시험할 수 있는 범위를 명확히 남긴다. 이번 사용자 조건을 이유로 핵심 요구를 임의 축소하지 않는다.

## 4. 보완 후 dev 배포 인계

1. L1 및 L2 보완·재리뷰에서 배포 가능한 범위를 확정한다. 미구현 기능을 정상 동작한다고 표시하지 않는다. 기존 task 005·006 이력은 보존한다.
2. 더 처리할 correction이 없다고 Reviewer가 확인하면 후속 Executor에게 **실기기 시험용 dev 배포를 지시**한다. 기존 dev branch/공개 App 저장소 방식과 CI/Builder를 사용하고, remote의 기존 version/tag/image를 확인해 아직 사용하지 않은 dev 버전을 고른다. Stable 0.7.2와 기존 immutable tag/image를 덮어쓰지 않는다.
3. dev metadata·버전·양언어 문서/changelog를 일치시키고, 해당 commit의 CI/native build·이미지 게시 검증을 마친 뒤 공개 dev App 저장소에서 새 버전이 보이는 것까지 확인한다. package 이름·권한·데이터 경로는 기존 저장소 규칙을 따른다.
4. 설치 가능한 정확한 dev 버전·저장소 주소·이미지/commit 및 사용자 시험 시나리오를 전달한다. Web/SSH/Remote의 유휴 대화, active 요청·approval·background 보류, 같은 대화의 후속 turn, 재시작 후 인증/데이터 보존을 구별한다. 실제 사용자 장치 조작과 stable 승격은 자동으로 수행하지 않는다.

이 문서 자체는 dev 게시 승인 완료나 게시 결과가 아니다. 현시점에는 L1/L2 때문에 사용자의 조건이 충족되지 않았다.
