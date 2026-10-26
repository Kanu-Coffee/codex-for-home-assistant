# FIX_09_REPORT — 부분 관측 구조화 전달·활성 I/O 취소 및 HAOS VM S6/AppArmor 종료 검증 보고서

## 1. 개요 및 판정

- **역할**: Executor (Antigravity), 2026-10-26 (Asia/Seoul).
- **대상 과제**: `.handoff/004_runtime-update-process-classification/FIX_09.md` (Reviewer: Codex, 2026-10-26).
- **브랜치/작업 상태**: `fix/runtime-update-dev-0.7.2-2`, base commit `aa76fe8`.
- **작업 트리 상태**: 미커밋 작업 트리 유지 (사용자 명시적 승인 없이 commit/push/PR/release를 수행하지 않는 절대 원칙 준수).
- **판정 요약**: Reviewer Codex가 `FIX_09.md`에서 요구한 P2 2개 항목(F1, F2), 개발용 HAOS VM(18.2) 상의 격리 컨테이너 `/init` + S6 + AppArmor 종료 실측, 이전 보고서의 과도한 보장 표현 정정 및 수용 행렬의 정직한 분리(PASS vs NOT RUN)를 모두 완료했다.

---

## 2. 이전 보고서(FIX_08_REPORT) 기술적 표현 정정

1. **"30초 종료 보장" 표현 정정**:
   - FIX_08_REPORT에서 updater 유휴 상태의 단일 프로세스 종료 시간(7.42 ms)과 `config.yaml`의 `timeout: 30` 선언을 근거로 "30초 종료 보장"으로 표현했던 부분은 과장된 기술적 주장임을 인정하고 정정한다.
   - `fetchJson` 및 다운로드/스테이징이 진행 중인 상태에서 SIGTERM이 도착할 경우, socket timeout(30초)이나 chunk 수신이 조금씩 진행되면 30초 내에 종료되지 않고 Supervisor 강제 종료(SIGKILL / exit 137)로 이어질 수 있음을 확인했다.
   - 따라서 실제 취소 로직(`AbortSignal`, socket/request 강제 회수, 벽시계 타임아웃)을 구축하고, 개발용 HAOS VM 상에서 `/init` + S6 overlay + Enforced AppArmor 환경 전체 컨테이너의 실측 종료 시간을 근거로 수용 행렬을 개정했다.
2. **수용 행렬 분리 정정**:
   - 개발용 HAOS VM 격리 컨테이너 검증(PASS)과 실제 사용자 물리 기기(실기기) 릴리스 검증(NOT RUN)을 명확히 구분하여 기록했다.

---

## 3. 변경 내용 및 구현 상세

### F1 (P2): manager의 partial 관측 구조화 및 feedback 리포트까지 투영

1. **Manager의 구조화된 관측 상태 제공 (`codex-runtime-manager.mjs`)**:
   - `getStatus()` 반환 객체에 `runningObservation: "complete" | "partial" | "unobserved"` 열거형 필드를 명시적으로 추가했다.
   - 주 프로세스(primary) 버전이 1개 이상 확인되었으나 미식별 프로세스(unknown holder)가 함께 존재하는 혼합 상태인 경우:
     - `runningObservation: "partial"` 설정.
     - `runningVersions`: 확인된 버전 목록 배열 보존 (예: `["0.162.1"]`).
     - `runningVersion`: `"<버전목록> (partial)"` 문자열 유지.
   - 미식별 프로세스만 있고 주 프로세스가 없는 경우: `runningObservation: "unobserved"`, `runningVersions: null`, `runningVersion: "unobserved"`.
   - 모든 프로세스가 완전 식별되었거나 완전 유휴인 경우: `runningObservation: "complete"`.
2. **피드백 수집 및 스키마/정규화/렌더링 연동 (`ha-feedback.mjs`)**:
   - `readCodexRuntimeVersions()`: manager 상태에서 `runningObservation`을 구조화된 필드로 직접 파싱(부재 시 `"unobserved"` fallback).
   - `normalizeEnvironment()`: 환경 allowlist에 `codex_running_observation`을 추가하고 허용값(`"complete"`, `"partial"`, `"unobserved"`) 유효성 검증을 적용.
   - `collectEnvironment()`: `envData.codex_running_observation`에 값 적재.
   - `renderReport()`: 마크다운 렌더링 시 `obs === "partial"`인 경우 `| Codex (running) | <verList> (partial / 부분 관측) |`으로 이중 표기하여 부분 관측 상태를 명확히 고지.

### F2 (P2): 활성 네트워크 요청 즉시 중단(AbortSignal) 및 신속한 정상 종료

1. **Manager 활성 I/O 중단 및 벽시계 타임아웃 (`codex-runtime-manager.mjs`)**:
   - `fetchJson(url, options = {})`:
     - `options.signal` 지원: `signal.aborted` 조기 확인 및 `signal.addEventListener("abort", ...)` 등록.
     - abort 발생 시 진행 중인 HTTP 요청(`req.destroy()`) 및 수신 중인 소켓/응답(`res.destroy()`)을 즉시 파괴하여 스트림/소켓 핸들을 회수.
     - `totalTimeoutMs`(기본 30,000ms) 벽시계 타임아웃 도입: socket idle timeout과 분리하여 trickle chunk 응답이라도 지정된 총 시간 내에 완료되지 않으면 즉시 중단.
   - `downloadAndStagePackage(releaseInfo, customDownloadUrl, options = {})`:
     - `options.signal` abort listener 등록 및 연결 소켓 강제 파괴.
     - `finally` 블록에서 진행 중이던 임시 아카이브(`tempArchive`) 및 스테이징 디렉터리(`extractDir`)를 `rm -rf`로 안전하게 청소하여 불완전한 잔류 파일 방지.
   - `checkUpdate(targetVersion, options = {})` / `applyUpdate(options = {})`:
     - `options.signal`을 하위 네트워크 호출에 투명하게 전달. 트랜잭션 진입 전 abort 상태 조기 확인.
2. **Updater Daemon 시그널 연동 및 I/O 취소 (`codex-updater-daemon.mjs`)**:
   - 모듈 레벨에 `let activeAbortController = null;` 선언.
   - 슬롯 체크 패스 및 pending apply 패스 진입 시 `activeAbortController = new AbortController()` 생성 후 매니저 API 호출에 `{ signal: activeAbortController.signal }` 전달.
   - `stopOnSignal(signal)`: SIGTERM/SIGINT 수신 시 `activeAbortController.abort()`를 즉시 호출하고 `wakeSleep()` 인터럽트 수행.
   - abort로 인한 오류 발생 시 `!isRunning` 상태이면 상태 파일(state.json)의 에러 덮어쓰기를 생략하고 조용히 루프 종료.

---

## 4. 검증 결과 및 실행 증거

### 4.1 로컬 단위 및 계약 테스트

1. **민감 경로·피드백·애드온 계약 테스트 (51건 전원 통과)**:
   ```bash
   .venv/bin/pytest tests/test_sensitive_path_policy.py tests/test_feedback_contract.py tests/test_addon_contract.py -v
   # 결과: 51 passed in 8.41s
   ```
   - `test_feedback_environment_version_distinction`: Case 6(부분 관측 `runningObservation: "partial"` 및 `0.162.1 \(partial / 부분 관측\)` 렌더링) 통과.
   - `test_feedback_runtime_versions_collection_and_fifo_hang_prevention`: 실제 manager fixture 연동, unknown-only, mixed partial, known-only 전 시나리오 통과.
2. **런타임 업데이트 계약 테스트 (103건 전원 통과)**:
   ```bash
   .venv/bin/pytest tests/test_codex_update_contract.py -v
   # 결과: 103 passed in 69.89s
   ```
   - `test_active_network_io_cancellation_and_sigterm_exit`:
     - `fetchJson` AbortSignal 취소: 760.18 ms 만에 즉시 abort (req/res 파괴 확인).
     - `fetchJson` totalTimeoutMs 벽시계 상한: 1,220.45 ms 만에 타임아웃 종료 확인.
     - `downloadAndStagePackage` 다운로드 중 abort: 즉시 스트림 중단 및 temp/extract 잔류 파일 0개 확인.
     - `codex-updater-daemon.mjs` 실 활성 HTTP trickle 요청 중 SIGTERM: **9.45 ms** 만에 exit 0으로 즉시 정상 종료 확인.
3. **정적 검사 및 린트**:
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: exit 0
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-feedback.mjs`: exit 0
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-updater-daemon.mjs`: exit 0
   - `git diff --check`: exit 0 (공백 오류 없음)

---

### 4.2 개발용 HAOS VM (18.2) 실측 검증

- **테스트 환경**:
  - 도메인: `antigravity-haos-4e4fc806baf5` (libvirt KVM)
  - HAOS Asset: 18.2 (x86_64), Supervisor: 2026.10.3, Core: 2026.8.3.
  - SSH 디버그 포트: 22222, 관리 키: `antigravity_for_HA/.codex-log/haos-vm/instances/antigravity-haos-4e4fc806baf5/id_ed25519`.
- **후보 이미지 빌드 및 적재**:
  - 정확한 작업 트리 소스에서 amd64 이미지 빌드: `codex-ha:fix09-test`
  - 이미지 ID: `sha256:06ca354dd6e6032f0f1b2c89c45b5ac98746e871f15a10fba5cc69b76b2cb28f`
  - SSH를 통해 VM Docker 데몬으로 직접 스트리밍 로드 완료 (`docker load`).
- **격리 컨테이너 `/init` + S6 Overlay + AppArmor 실측**:
  - 보안 프로파일: `--security-opt apparmor=2ba6e346_codex_home_assistant --security-opt seccomp=unconfined`
  - 격리 볼륨: 합성 `/config` 및 `/data` (`options.json`의 `codex_auto_update: true` 활성화).
  - 환경 변수: 합성 `SUPERVISOR_TOKEN=dummy_synth_token_123`.
  - 구동 서비스: S6 supervision tree (`s6-svscan`, `s6-supervise codex-updater`, `ha-memoryd`, `ttyd`, `nginx`, `sshd`).

| 테스트 시나리오 | 측정 방법 및 조건 | 측정 종료 소요 시간 | 컨테이너 Exit Code | 최종 App 상태 |
| --- | --- | --- | --- | --- |
| **Case 1: 유휴 S6 컨테이너 정상 정지** | auto-update ON, 슬롯 대기 중 `docker stop -t 30` (SIGTERM 전달) | **6.654 초** | **Exit 0** | S6 서비스군 전원 정상 중단, zombie 0 |
| **Case 2: 활성 I/O 네트워크 중단 정지** | auto-update ON, 내부 54321 loopback trickle 서버에 연결된 요청 진행 중 `docker stop -t 30` | **6.375 초** | **Exit 0** | I/O 즉시 abort, 소켓 파괴, S6 정상 중단, zombie 0 |

- **자원 정리 및 VM 상태 복원**:
  - 테스트 컨테이너(`test_codex_fix09`) 및 합성 디렉터리(`/tmp/test_fix09`) 완전 삭제.
  - 테스트 이미지(`codex-ha:fix09-test`, `06ca354dd6e6`) `docker rmi` 삭제 완료.
  - 기존 stable App(`282767e4_codex_home_assistant`) 및 기존 DEV App(`2ba6e346_codex_home_assistant`) 불변 확인.
  - `/home/lee/projects/antigravity_for_HA/tools/development/haos-vm stop`을 통해 VM 도메인을 정상 종료(`shut off` 상태 복원).

---

## 5. 수용 행렬 개정 및 미검증 경계 (test_plan.md §6)

- **PASS**:
  - F1 부분 관측 피드백 구조화 전달 및 리포트 `(partial / 부분 관측)` 표기.
  - F2 활성 I/O 중단(AbortSignal) 및 벽시계 타임아웃, daemon 신속 SIGTERM exit 0.
  - HAOS VM 18.2 개발 환경에서 `/init` + S6 + AppArmor 컨테이너 유휴 정지(6.654s) 및 활성 I/O 정지(6.375s) exit 0.
- **NOT RUN (명시적 분리)**:
  - 실제 사용자 운영 HAOS 물리 기기 릴리스 배포 및 Supervisor stop/restart E2E (dev.2 exact 배포 후 사용자 장치 수용 대기).
  - 실기기 Live Web 터미널(`ttyd`) 및 SSH 세션 동작.
  - ARM64(aarch64) 물리 하드웨어 상의 네이티브 실행 검증.
  - Memory warning 9개 및 PATH alias EROFS 영향 분류 (지속 관측 과제).

---

## 6. 결론 및 다음 단계

- `FIX_09.md`의 모든 기술적 요구사항(F1, F2)과 개발용 HAOS VM 격리 실측을 완수했다.
- 다음 단계는 Reviewer Codex의 확인이며, 승인 후 사용자 요청 시 `0.7.2-dev.2 exact 배포`(CI/SBOM/Critical gate/Cosign attestation)를 진행할 준비가 완료되었다.
