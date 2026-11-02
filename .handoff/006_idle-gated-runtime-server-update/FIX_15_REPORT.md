# FIX_15_REPORT — 상태표시 정리 및 DEV 0.7.3-dev.1 배포 준비 보고

## 1. 개요 및 요약

- **작업자:** Executor (Antigravity), 2026-10-29.
- **기준 handoff:** `.handoff/006_idle-gated-runtime-server-update/FIX_15.md` (Reviewer: Codex).
- **판정 및 목표:**
  - FIX_14의 제목 thread 차단 결함 해소 및 TUI/Remote 문맥 보존 인수 확인.
  - P2 결함: `codex-runtime-manager.mjs`의 상태표시가 실제 실행 경로(`applyUpdate`의 `canAttemptRestart`)와 불일치하던 문제 수정.
  - 사전검사 자격과 복원 안전 게이트(cooldown, budget, recovery, active blocker)를 구분하는 상태표시 회귀 테스트 추가.
  - 관련 개발 문서(`rules.md`, `architecture.md`, `security.md`, `product_spec.md`)의 과거 미구현/일괄 보류 설명을 현재 구현 및 DEV 운영시험 상태로 현행화.
  - DEV 0.7.3-dev.1 릴리스를 위한 메타데이터 일치(config.yaml, Dockerfile, playwright, CHANGELOG, motd, addon contract) 완료.
  - 전체 회귀 테스트 스위트 100% 통과: **268 passed, 1 skipped in 118.52s** (0 failures).

---

## 2. P2 상태표시 정합성 수정 및 회귀 테스트

### 2.1 상태표시 로직 정합성 (`codex-runtime-manager.mjs`)

- **결함 원인:** `getStatus()`가 `sessions.canApply && sessions.restartableServers.length`만으로 `liveHandoverBlocked=true`를 생성하고, `autoApplyReady`에서도 `sessions.restartableServers.length === 0`을 요구하여 관리형 유휴 서버가 존재하기만 하면 무조건 `liveHandoverBlocked=true`, `autoApplyReady=false`, `migration unverified`로 오판함. 반면 실제 데몬이 실행하는 `applyUpdate`의 `canAttemptRestart` 분기는 관리형 유휴 서버를 정상 전환하고 있었음.
- **해결 내용:**
  - `liveHandoverBlocked`를 무조건 true로 만들던 플래그를 해소 (`liveHandoverBlocked: false`).
  - `autoApplyReady`에서 `sessions.restartableServers.length === 0` 제약을 제거하고, 관리형 유휴 서버가 있어도 쿨다운 미활성(`!cooldownActive`), 일일 예산 잔여, 스테이징 완료, 세션 유휴/재시작 가능 등의 사전조건이 충족되면 `autoApplyReady: true`로 올바르게 평가되도록 수정.
  - `formatSessionReady` 및 `formatAutoApplyReady`가 관리형 유휴 서버의 교체 적격 상태(`yes (idle managed server(s) eligible for restart; manual apply can restart now if cooldown allows)`, `yes (ready for next automatic apply check)`)를 정상 출력하도록 경로 정합성 확보.
  - 실제 안전 게이트(busy/unknown 세션 차단, 24시간 쿨다운 대기, 일일 12회 예산 제한, 트랜잭션 저널 복구 대기)는 온전히 유지.

### 2.2 상태표시 회귀 테스트 (`tests/test_codex_update_contract.py`)

신규 테스트 `test_fix15_managed_idle_server_status_reporting_and_guard_regressions` 추가 및 전수 검증:
1. **적격 관리형 유휴 서버 (Eligible):**
   - `sessionText`: `yes (idle managed server(s) eligible for restart; manual apply can restart now if cooldown allows)`
   - `autoText`: `yes (ready for next automatic apply check)`
   - `liveHandoverBlocked`: `false`
2. **쿨다운 활성 (Cooldown Active):**
   - `autoText`: `waiting (restart cooldown active until...`
3. **일일 예산 소진 (Budget Exhausted):**
   - `autoText`: `paused (daily check budget exhausted...`
4. **전환 복구 대기 (Journal Recovery Needed):**
   - `sessionText`: `no (interrupted transition requires recovery)`
5. **활성 작업 블로커 (Active Blocker Present):**
   - `sessionText`: `no (waiting for real sessions or unverifiable processes to exit)`
   - `autoText`: `deferred (waiting for active sessions or unverifiable processes to clear)`

---

## 3. 개발 문서 및 메타데이터 현행화

### 3.1 개발 사양 및 보안 문서
- `docs/development/rules.md` (R-403): 세션 복원/호환성 증거 부족으로 일괄 보류 및 CLI 미구현으로 적혀 있던 과거 설명을 관리형 세션(Remote stdio 및 CLI/TUI)의 릴레이 기반 유휴 전환(`switch_worker`) 및 DEV 운영시험 진행으로 갱신.
- `docs/development/architecture.md` (§13.4): 작업 관측과 전환 보류 항목을 관리형 세션의 유휴 전환 및 대화 상태 복원 구현으로 갱신.
- `docs/development/security.md` (§8 실기 검증 경계): 관리형 세션의 세션 릴레이 유휴 전환 지원 및 미관리 세션 종료 대기 설명으로 갱신.
- `docs/development/product_spec.md` (FR-021): "CLI/TUI의 경우 TUI 클라이언트 자동 재연결 미지원으로 정상 종료 시 적용된다"는 과거 설명을 관리형 세션 릴레이를 통한 무중단 전환으로 갱신.

### 3.2 DEV 0.7.3-dev.1 메타데이터 동기화
- `codex_home_assistant/config.yaml`:
  - `version: "0.7.3-dev.1"`
  - `name: "Codex for Home Assistant (DEV)"`
  - `panel_title: "Codex DEV"`
  - `description: "[DEV] Codex CLI with verified feedback, browser, terminal, and SSH for Home Assistant"`
  - `stage: experimental`
- `repository.yaml`: `name: "Codex for Home Assistant (DEV)"`
- `codex_home_assistant/Dockerfile`:
  - `ARG BUILD_VERSION=0.7.3-dev.1`
  - `org.opencontainers.image.title="Home Assistant App: Codex for Home Assistant (DEV)"`
  - `org.opencontainers.image.description="Development build of Codex CLI, verified feedback reports, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant"`
- `codex_home_assistant/playwright/package.json` & `package-lock.json`: `"version": "0.7.3-dev.1"`
- `codex_home_assistant/CHANGELOG.md`: `## [0.7.3-dev.1] - 2026-10-29` 릴리스 헤딩 추가
- `codex_home_assistant/rootfs/etc/motd`: `Codex for Home Assistant (DEV)` 첫 줄 반영
- `tests/test_addon_contract.py`: DEV 채널 계약 검증 갱신 (19/19 PASS)

---

## 4. 검증 결과 및 증거

1. **전체 pytest 회귀 테스트 스위트:**
   ```text
   268 passed, 1 skipped in 118.52s (0:01:58)
   ```
   (0 failures, 1 skip: 로컬 Grype 부재에 따른 policy preflight bypass)
2. **Addon 채널 계약 테스트:**
   ```text
   tests/test_addon_contract.py: 19 passed in 0.32s
   ```
3. **구문 및 정적 분석:**
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: PASS
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh`: PASS
   - `git diff --check`: PASS (공백 및 EOF 개행 정합성 완벽)
4. **리모트 태그 상태:**
   - `git ls-remote --tags origin '0.7.*'`: Stable `0.7.2`, DEV 최대 `0.7.2-dev.2`, `0.7.3-dev.1` 미사용 확인 완료.

---

## 5. 미수행 및 범위 한정 사항

- **미수행:** Docker 신규 빌드 및 multiarch push, GitHub PR 생성/머지, Tag push 및 publishing Builder 워크플로 실행, 실제 HAOS 운영 장치 조작.
- **안전 준수:** 비밀값(`SUPERVISOR_TOKEN`, `auth.json`, SSH 키 등) 노출 없음, `/config` RW 매핑 및 `manager` 권한 유지, 금지된 옵션(`admin`, `docker_api` 등) 미도입.

---

## 6. 사용자 DEV 운영시험 안내

DEV prerelease 배포 준비가 완료되었으며, 게시 후 사용자 운영시험 인수 절차는 다음과 같습니다:

1. **설치 및 시작:**
   - `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev` 저장소를 통해 `0.7.3-dev.1`로 업데이트 설치.
   - 관리형 대화형 CLI/TUI (`codex`) 또는 mobile Remote stdio 세션 시작.
2. **유휴 전환 관측:**
   - 대화 세션을 열어둔 상태에서 실제 작업(생성, 도구 실행, 입력 대기 등)이 없을 때 자동 스케줄러 슬롯 또는 `ha-codex-update apply` 실행.
   - 기존 백엔드의 running PID 및 버전이 신규 버전으로 전환되는지 확인 (`selected`뿐만 아니라 `running` 버전 변경 확인).
3. **문맥 보존 확인:**
   - 전환 후 열려 있는 동일한 세션에서 다음 입력을 보내고 이전 대화 문맥이 유지된 채 정상 응답이 생성되는지 확인.
4. **활성 작업 보호 확인:**
   - 응답 생성 중, 도구 실행 중, 승인 대기 중에는 기존 워커가 유지되고 전환이 안전하게 보류되는지 확인.
5. **데이터 보존:**
   - 인증, SSH 키, Ingress 재접속 및 App 재시작 후 데이터 보존 확인.
