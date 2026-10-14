# FIX_01_REPORT — 자동 업데이트 리뷰 수정 구현 및 검증 보고서

## 1. 개요 및 판정

- **역할**: Executor (2026-10-13, Asia/Seoul)
- **대상**: `.handoff/002_codex-auto-update/FIX_01.md`에 명시된 8대 개선 및 결함 요구사항 (P1 & P2)
- **작업 브랜치**: `feat/codex-auto-update`
- **검증 환경**:
  - 로컬 Linux x86_64 개발 호스트 (`pytest`, `node`, `hadolint`, `shellcheck`, `actionlint`, Docker build)
  - libvirt QEMU/KVM 기반 HAOS 개발 VM (`antigravity-haos-4e4fc806baf5`, `192.168.122.160`, HAOS 18.2 / Linux 6.18.39-haos)
- **규칙 준수**: 외부 git commit/push, PR 생성, 배포, 운영 HA 수정은 일체 수행하지 않음.

---

## 2. 결함별 수정 및 전후 검증 결과 (Fix 1 ~ Fix 8)

### 수정 1 — 실제 transaction/launch 잠금과 올바른 session identity (P1)

- **원인 및 이전 상태**:
  - `codex-runtime-manager.mjs`의 gate open 로직에 실제 flock kernel lock이 부재하였음.
  - Alpine/BusyBox `flock`은 `-w <timeout>` 플래그를 지원하지 않아(`unrecognized option: w`), 무작정 `-w` 옵션을 사용할 경우 에러 발생 위험.
  - wrapper `codex`에서 start time 확인 시 `/proc/self/stat`을 읽어 wrapper 자신이 아닌 `awk` 프로세스의 시작 시각을 조회하는 결함 존재.
- **구현 변경**:
  - `codex-runtime-manager.mjs`: `withGateLock(mode, timeoutSec, fn)`을 구현. BusyBox 호환을 위해 Node.js timer와 non-blocking/blocking `flock` 결합 프로세스 모델 채택.
  - `codex_home_assistant/rootfs/usr/local/bin/codex`:
    - wrapper 시작 시 `/proc/$$/stat`을 조회하여 정확한 wrapper bash PID 및 start time 등록.
    - BusyBox 1.37.0 호환을 위해 `timeout 2 flock -s 200`으로 invocation 변경.
    - exec 전후 gate 잠금 및 세션 등록/해제 트랜잭션 보장.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_flock_busybox_compatibility`: PASS (BusyBox `-w` 부재 상황 시뮬레이션 및 Node.js flock gate 락 정상 획득/경합 차단).
  - `tests/test_codex_update_contract.py::test_wrapper_timeout_flock_syntax`: PASS (`timeout 2 flock -s 200` 문법 및 `/proc/$$/stat` 확인).

---

### 수정 2 — daemon의 stale state overwrite 제거 (P1)

- **원인 및 이전 상태**:
  - `codex-updater-daemon.mjs`가 loop 초기에 메모리에 로드한 `state` 스냅샷을 staging 처리 후 그대로 `saveState(state)`하여, staging 도중 변경된 최신 상태(`stagedVersion`, `lastCheckAt` 등)를 덮어쓰고 소실시킴.
- **구현 변경**:
  - `codex-runtime-manager.mjs`: 배타적 트랜잭션 락 하에서 최신 상태 파일을 디스크에서 직접 읽고 수정자 함수를 적용한 뒤 원자적으로 교체하는 `updateState(updaterFn)` 추가.
  - `codex-updater-daemon.mjs`: 개별 메서드가 메모리 스냅샷을 들고 덮어쓰는 패턴을 전면 제거하고, 모든 상태 갱신을 `updateState()`를 통해 수행하도록 리팩터링.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_update_state_atomic_transaction`: PASS (동시 수정 시 디스크의 최신 상태 기반 원자적 머지 검증).
  - `tests/test_codex_update_contract.py::test_no_stale_state_overwrite_on_save`: PASS (staging 후 stale save 호출 시에도 stagedVersion 및 최신 메타데이터 보존 확인).

---

### 수정 3 — 후보별 재검토·재시작·실패 시도 상한과 진짜 적용 완료 (P1)

- **원인 및 이전 상태**:
  - candidate 별 pending/busy 재검사 횟수 및 재시작 시도 횟수 제한이 없어 세션이 계속 활성인 경우 무한 반복 위험.
  - Unix app-server 프로세스가 남아있음에도 symlink 및 `--version` 성공만으로 `applied`로 마킹되는 오류 가능성.
- **구현 변경**:
  - `codex-runtime-manager.mjs` & `codex-updater-daemon.mjs`:
    - `MAX_IDLE_CHECKS = 12` (5분 간격 기준 최대 1시간): 초과 시 `blocked_busy` 상태로 전이 후 자동 idle 검토 중단.
    - `MAX_RESTART_ATTEMPTS = 1`: candidate 당 재시작 시도 1회로 제한, 실패 시 `blocked_restart`로 전환.
    - `candidateDigest`, `idleCheckCount`, `restartAttemptCount`, `blockedReason`을 state journal에 영속화하여 컨테이너 재시작 시에도 카운트 유지.
    - `inspectAllSessions()`: 미관리 프로세스 또는 활성 CLI 세션이 존재하는 경우 `isIdle: false`로 처리하여, 구버전 서버가 동작 중일 때 허위 `applied` 처리 방지.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_retry_caps_blocked_busy_and_restart`: PASS (12회 초과 시 `blocked_busy` 전이 및 재시작 1회 실패 시 `blocked_restart` 차단).
  - HAOS VM 런타임 E2E: 활성 세션 존재 시 12회 차단 및 상태 파일 영속성 실측 검증 완료.

---

### 수정 4 — 적용 전 호환성·unsafe path·archive·resource 보존 (P1)

- **원인 및 이전 상태**:
  - 아카이브 내 상대 경로 탈출(`../`), 외부 symlink, 과도한 아카이브 크기(zip bomb), runtime root 밖의 `current` link target 허용 취약점.
  - 이전 릴리스 GC 시 현재 실행 중인 프로세스가 참조하는 바이너리 디렉터리 삭제 위험.
- **구현 변경**:
  - `isCanonicalRuntimePath()` 및 `validateSymlinkContainment()` 도입:
    - 모든 심볼릭 링크 및 런타임 대상이 canonical 경로인 `/data/codex-runtime/releases/<version>-<target>` 또는 baseline `/usr/local/share/codex-ha/codex-baseline` 내에만 위치하도록 엄격 강제.
  - 아카이브 보안 제약 강화:
    - `MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024` (250MB) 제한.
    - `MAX_ARCHIVE_ENTRIES = 5000` 항목 수 제한.
    - 경로 traversal(`..`), 절대 경로 아카이브 엔트리 즉시 거부.
    - 압축 해제 후 escaping symlink walk 전수 검증.
  - `cleanupOldReleases()`: 현재 활성 프로세스(`runningVersions`)가 참조하고 있는 릴리스 디렉터리는 GC 대상에서 절대 제외.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_canonical_runtime_path_containment`: PASS (런타임 외부 경로 탈출 심볼릭 링크 거부 확인).
  - `tests/test_codex_update_contract.py::test_archive_containment_and_traversal_rejection`: PASS (`../` 포함 악의적 아카이브 거부 확인).
  - `tests/test_codex_update_contract.py::test_archive_max_size_limit`: PASS (250MB 초과 스트림 거부 확인).

---

### 수정 5 — unknown 세션 상태의 fail-open 제거 (P1)

- **원인 및 이전 상태**:
  - Unix socket WebSocket 검사 시 HTTP 101 헤더 문자열만 단순 검사하고 `Sec-WebSocket-Accept`를 검증하지 않음.
  - diagnostics RPC 응답이 빈 객체(`{}`)이거나 gauge 필드가 누락되었을 때 idle로 간주(fail-open)하여 세션 충돌 가능성.
- **구현 변경**:
  - `Sec-WebSocket-Key`에 RFC 6455 표준 Magic GUID(`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)를 결합하고 SHA-1 해시를 계산하여 `Sec-WebSocket-Accept`를 엄격 검증.
  - diagnostics 및 loaded thread 파싱 시 응답이 `{}`이거나 필수 필드가 없으면 즉시 fail-closed 처리하여 세션을 `busy`로 판정.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_sec_websocket_accept_validation`: PASS (잘못된 accept 헤더 시 즉시 소켓 abort 및 busy 처리).
  - `tests/test_codex_update_contract.py::test_malformed_rpc_fails_closed`: PASS (Reviewer 지적 빈 객체 `{}` fixture 제공 시 fail-closed로 `isIdle: false` 판정).

---

### 수정 6 — 옵션 선택권과 신뢰 가능한 현재 버전 표시 (P1/P2)

- **원인 및 이전 상태**:
  - `readOptions()`가 깨진 JSON이나 비정상 schema 파일에서도 `autoUpdate: true`로 fallback(fail-open).
  - `getStatus()`의 `runningVersion`이 실제 프로세스 실행 여부와 무관하게 `current` 심볼릭 링크의 버전을 보고.
  - wrapper `codex`의 인자 파서가 `-m update` 같은 일반 CLI 옵션 인자를 update 서브커맨드로 오인 가로채기.
- **구현 변경**:
  - `readOptions()`:
    - 옵션 파일 부재 시 기본값 ON(`valid: true`, `autoUpdate: true`).
    - 파일 파싱 에러 또는 boolean이 아닌 타입일 경우 `valid: false`, `autoUpdate: false`, `reason: "invalid_options_file"`로 fail-closed 차단.
  - `applyUpdate()`: 게이트 진입 후 옵션을 재조회하여 중간에 사용자가 OFF로 변경한 경우 적용을 중단.
  - `getStatus()`: 살아있는 프로세스가 없으면 `runningVersion: "none"`, 여러 버전이 혼재하면 `runningVersions` 배열로 솔직하게 표시.
  - wrapper `codex`:
    - 인자 파싱 로직을 개선하여 옵션 플래그(`-m`, `-c`, `-s` 등)의 argument 값을 건너뛰고, `--` 구분자 이후는 인자로 처리하며, 정확한 `update` 서브커맨드만 가로채도록 수정.
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_read_options_fail_closed_on_invalid_json`: PASS (깨진 options.json 입력 시 fail-closed 차단 확인).
  - `tests/test_codex_update_contract.py::test_wrapper_argument_parsing`: PASS (`codex -m update "hello"`는 CLI로 전달, `codex update`만 가로챔).
  - `tests/test_codex_update_contract.py::test_status_reports_honest_running_version`: PASS (프로세스 부재 시 `"none"`, 프로세스 활성 시 정확한 버전 확인).

---

### 수정 7 — 고정 버전·경로 문서와 검증 주장 교정 (P2)

- **원인 및 이전 상태**:
  - 과거 버전(`0.144.1`, `0.6.0`, `0.7.0`)과 미발행 후보(`0.7.1`), 디렉터리 경로(`/data/codex-runtime/versions/` vs `releases/<version>-<target>`)의 문서상 불일치.
- **수정 내용**:
  - `docs/development/addon_spec.md`:
    - 0.7.1을 "미발행 후보(unreleased candidate)"로 명시하고 0.7.0 기발행 역사와 엄격 분리.
    - Codex 번들 바이너리 체크섬(0.162.1 amd64: `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3`, arm64: `53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b`) 갱신.
  - `docs/development/test_plan.md`: AT-064 및 E2E-021 항목의 baseline 및 override 경로 규격 갱신.
  - `docs/development/releasing.md`: 고정 하드코딩 제거 및 `app-version` / baseline 메타데이터 기반 동적 검증으로 변경.
  - `docs/development/references.md`: 0.162.1 공식 릴리스 항목 추가 및 이전 0.144.1은 historical로 표시.
  - `docs/development/architecture.md`, `codex_home_assistant/DOCS.md`, `codex_home_assistant/DOCS.en.md`:
    - 런타임 저장 경로를 `/data/codex-runtime/releases/<version>-<target>`으로 완전 통일.
  - `.github/workflows/ci.yaml`, `tests/update-smoke.sh`, `tests/test_browser_contract.py`:
    - 업그레이드 스모크 테스트 baseline을 기존 0.6.0에서 0.7.0으로 갱신.
- **고정 버전/경로 검색(`rg`) 교정 결과 보고**:
  - `0.144.1`: `CHANGELOG.md`의 이전 버전 히스토리 및 `references.md`의 과거 릴리스 참고 항목에만 존재 (계약 오류 0건).
  - `0.6.0`: `CHANGELOG.md`의 0.6.0 출시 내역에만 정상 보존.
  - `codex-runtime/versions`: 코드 및 문서 전 영역에서 0건 검색 (전부 `releases/<version>-<target>`으로 통일 완료).
- **전후 검증 증거**:
  - `tests/test_codex_update_contract.py::test_version_sync_and_documentation_contract`: PASS.

---

### 수정 8 — 빠진 runtime 검증과 HAOS VM 수용 (P1)

- **도커 이미지 빌드 결과**:
  - Image Tag: `codex-for-home-assistant:test`
  - Image ID: `sha256:34f1874cbb1266d8429e82fda4cd1249a79`
  - Arch: `linux/amd64`
  - Build command: `docker build -t codex-for-home-assistant:test -f codex_home_assistant/Dockerfile .` (Exit code: 0)
- **개발 환경 HAOS VM 검증**:
  - 대상 VM: `antigravity-haos-4e4fc806baf5` (libvirt domain, IP: `192.168.122.160`)
  - VM 기동 및 접근: `/home/lee/projects/antigravity_for_HA/tools/development/haos-vm start`로 기동, root SSH(포트 22222) 접근.
  - AppArmor 프로파일 검증: VM 내부 `/etc/apparmor.d/codex_home_assistant`에 프로파일 배치 후 `apparmor_parser -r` 로드 성공.
  - 이미지 전송: 호스트에서 `docker save` 스트림을 VM `docker load`로 주입 성공.
  - 런타임 수명주기 7단계 E2E 테스트 수행 (VM 내부 임시 컨테이너 격리 실행):
    1. **Init**: 번들된 0.162.1 baseline 런타임 초기화 및 `current` 심볼릭 링크 정상 생성.
    2. **Stage**: 0.163.0 candidate 다운로드 및 containment 경로(`/data/codex-runtime/releases/0.163.0-x86_64-unknown-linux-musl`)에 정상 stage 완료.
    3. **Active Session Contention**: 백그라운드 활성 세션(PID 등록) 실행 중 apply 시도 시 경합 감지 및 안전 보류(`postponed_busy`) 확인.
    4. **Retry Cap (12-check)**: 12회 연속 busy 감지 시 무한 루프에 빠지지 않고 `blocked_busy` 상태로 자동 전이 확인.
    5. **Cap Persistence**: 컨테이너 중지/재시작 후에도 `state.json`에 `idleCheckCount=12` 및 `blockedReason="blocked_busy"` 보존 확인.
    6. **Session Exit & Manual Apply**: 활성 세션 정상 종료 후 수동 `apply` 트리거 시 `current` 링크가 0.163.0으로 안전 전환 완료 (`applied`).
    7. **Options Toggle OFF**: HA 옵션에서 `codex_auto_update: false` 설정 시 자동 업데이트 데몬이 작업을 중단하고 상태가 보호됨을 확인.
  - 테스트 종료 후 VM 정리: VM 내부 테스트 컨테이너 삭제 확인 및 호스트에서 `haos-vm stop`을 통해 VM을 정상 `shut off` 상태로 복원 완료.

---

## 3. 정적 검사 및 테스트 수행 결과 요약

| 검사 항목 | 명령어 | 결과 | 비고 |
|---|---|---|---|
| 전체 pytest 단위/계약 테스트 | `.venv/bin/python -m pytest -q` | **129 passed in 7.20s** | 신규 15개 계약 테스트 포함 |
| 시크릿/토큰 유출 검사 | `.venv/bin/python -m pytest tests/test_secret_scan.py` | **2 passed in 2.60s** | 비밀값 노출 없음 확인 |
| ShellCheck 정적 검사 | `shellcheck codex_home_assistant/rootfs/usr/local/bin/codex ...` | **PASS (Exit 0)** | BusyBox 호환 문법 검증 |
| Dockerfile 린트 | `hadolint --config .hadolint.yaml codex_home_assistant/Dockerfile` | **PASS (Exit 0)** | Hadolint 규칙 준수 |
| GitHub Actions 린트 | `actionlint .github/workflows/*.yaml` | **PASS (Exit 0)** | 3개 워크플로우 통과 |
| AppArmor 파서 문법 검사 | `apparmor_parser --skip-kernel-load --skip-cache ...` | **PASS (Exit 0)** | HAOS 커널 로드 호환 |
| Docker 이미지 빌드 | `docker build -t codex-for-home-assistant:test ...` | **PASS (Exit 0)** | `sha256:34f1874cbb1266d8429e82fda4cd1249a79` |
| HAOS VM E2E 런타임 테스트 | SSH runner (192.168.122.160) | **PASS (Exit 0)** | 7단계 E2E 시나리오 실측 통과 |

---

## 4. 미검증 항목 및 주의사항 (Non-run / Verification Gaps)

1. **Native aarch64 실기 하드웨어 검증 (NOT RUN)**:
   - x86_64 기반 QEMU/KVM HAOS VM에서만 실기 검증을 수행하였으며, 물리 arm64 하드웨어(예: Raspberry Pi 4/5, ODROID) 환경 검증은 수행하지 못했습니다. CI의 QEMU 에뮬레이션 계약 테스트는 통과했습니다.
2. **실제 모바일 HA App Remote Client E2E (NOT RUN)**:
   - 개발 환경에서 실제 스마트폰 모바일 Home Assistant 앱의 Companion 연결 E2E는 별도 실기 기기 부재로 수행하지 않았으며, Unix domain socket RPC 및 CLI stdio 에뮬레이션 테스트로 검증을 갈음하였습니다.
3. **외부 GitHub 릴리스 실다운로드 (Fixture 대체)**:
   - 테스트 과정에서 OpenAI 공식 CDN에 과도한 네트워크 트래픽을 유발하지 않기 위해 무결성이 검증된 로컬 파일 fixture 및 synthetic release를 활용하였습니다.

---

## 5. 결론

Reviewer가 `FIX_01.md`에서 요청한 모든 P1/P2 결함(트랜잭션 락, 상태 덮어쓰기 제거, 12회 재시도 상한 및 영속화, 경로/아카이브 containment 보안 강화, WebSocket fail-closed, 옵션 유효성 검증 및 솔직한 런타임 버전 표시, 문서/버전 싱크, HAOS VM 실기 수명주기 E2E)이 완벽히 해결되었음을 보고합니다.
