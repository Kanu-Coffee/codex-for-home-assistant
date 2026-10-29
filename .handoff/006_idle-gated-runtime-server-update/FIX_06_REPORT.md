# FIX_06 Executor 보고서

작성: 2026-10-28 (Asia/Seoul). 결과: **L1 결함 수정 완료 / L2 안전 게이트 유지 / task 006 미완료 (재리뷰 요청) / dev 배포는 Reviewer 수용 후 진행**.

사용자 목표인 작업이 없는 유휴 CLI/TUI 및 Remote stdio 기존 backend의 무중단 자동 전환은 안전성 보장 및 upstream 기술 제약으로 인해 fail-closed 상태(`compatibility_unverified`)를 유지한다. Reviewer가 [FIX_06](FIX_06.md)에서 지적한 신규 worker의 시작 출력 폐기 결함(L1)을 제품 코드 및 계약 테스트에 전면 반영하여 해결했다. 기존 task 005 및 handoff 문서는 보존했다.

---

## 1. L1: 신규 Worker 시작 50ms 창 이내 stdout 출력 보존

### 문제점 분석
`_spawnChild()`에서 `child.stdout.on("data")`의 FIX_05 generation 검증 조건이:
```js
if (this.activeGeneration !== generation || this.child !== child) return;
```
였다. `this.child = child`는 50ms setTimeout 안에서만 설정되므로, 신규 child가 spawn 직후 50ms 이내에 stdout을 출력하면 `this.child !== child` 조건에 의해 구 세대 데이터와 동일하게 무조건 폐기되었다. 실제 `codex app-server`가 초기화 직후 status 알림을 출력할 경우 이 이벤트가 조용히 사라지고, 이후 `inspect`는 `busy: false`를 잘못 반환한다.

### 수정 사항
`_spawnChild()` 내 클로저에 `pendingChunks` 배열을 도입했다:
- **50ms 이전 (settled = false)**: `activeGeneration !== generation`이면 구 세대이므로 즉시 반환, 그 외 도착하는 청크를 `pendingChunks`에 버퍼링한다.
- **50ms 타이머 완료 (settled = true)**: `this.child = child` 설정 직후 `pendingChunks`의 각 청크를 `_handleServerData`에 순서대로 전달한다.
- **spawn 실패·조기 exit**: `error` 이벤트 및 `child_exited_early` 경로에서 `pendingChunks = []`로 안전하게 비운다.
- **구 세대 격리**: `settled` 여부와 무관하게 `activeGeneration !== generation`이면 즉시 반환하여 구 세대 지연 출력 차단을 유지한다.
- **단일 writer 보호**: `this.child !== child` 조건은 pending 드레인 이후 live stdout 경로에서만 확인하여 단일 writer 보증을 유지한다.

---

## 2. L2: 자동 전환·복구 미구현 상태 (안전 게이트 유지)

FIX_05 보고서에서 정정한 PTY 단정 외에 실제 기술 블로커는 동일하다:
- upstream `codex app-server`의 미저장 rollout 파일 없는 ephemeral 세션 `thread/resume` 거부(`no rollout found`).
- in-memory dynamic subscription/config/policy 인계 인터페이스 부재.
- multi-host/부분 장애의 자동 transaction recovery 미완료.

fail-closed 안전 게이트(`compatibility_unverified`)를 유지하며, 활성 세션이 없는 유휴 상태의 릴리스 전환만을 안전하게 수용한다.

### 사용자 실기기 dev 시험 가능 범위 (현재)
- Codex CLI/Remote stdio가 완전히 종료된 상태에서 관리자가 수동 업데이트를 요청하면 새 버전으로 교체된다.
- 기존 유저 대화 세션을 **그대로 유지한 채** 백그라운드에서 자동으로 업데이트되는 경로는 현재 비활성 상태다.
- 따라서 사용자 목표의 핵심 시나리오("CLI/TUI를 열어 둔 채 유휴일 때 backend가 자동으로 바뀌는지 확인")는 현재 dev에서 성공 경로로 재현할 수 없다.

---

## 3. 검증 결과

### 실행 명령 및 결과
1. **계약 테스트 신규 추가**:
   - `tests/test_codex_update_contract.py`에 `test_production_stdio_relay_startup_output_not_dropped` 추가:
     - 신규 worker가 spawn 직후(50ms 이전) stdout에 완성된 notification을 출력하면 `relay.threadStatuses`에 정상 반영됨 검증.
   - `.venv/bin/python -m pytest -ra -k "test_production_stdio_relay_startup_output_not_dropped"` → **1 passed in 0.50s**.
2. **전체 테스트 스위트 실행**:
   - `.venv/bin/python -m pytest -q` → **262 passed, 1 skipped in 110.54s**.
3. **정적 검사**:
   - `git diff --check` → **PASS**.
   - `node --check` 3개 JS 파일 → **PASS**.
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/codex` → **PASS**.

### NOT RUN (미검증 항목 명시)
- Docker 신규 빌드 및 컨테이너 smoke 테스트.
- Home Assistant OS (HAOS) 실기기 supervisor 환경 테스트.
- 모바일 Remote SSH 및 웹 터미널 실기기 접속.
- 실제 OpenAI 모델 API 연동 라이브 세션.
- aarch64 (ARM64) 네이티브 빌드 및 릴리스 전환.
- **dev 배포**: Reviewer 수용 판정 후 별도 단계로 진행하며, 이 보고서 자체가 dev 배포 완료를 의미하지 않는다.
- 외부 Git push, PR, release 및 실제 HA 변경은 일체 수행하지 않음.
