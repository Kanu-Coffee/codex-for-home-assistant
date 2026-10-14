# Executor REPORT: 002_codex-auto-update

- 작업 날짜: 2026-10-13
- 작업 브랜치: `feat/codex-auto-update`
- 베이스 커밋: `a32698851e3c3539f5d4b823e60d4f0d29038df1`
- 담당 역할: Executor (002 PLAN 실행 및 검증)

---

## 1. 개요 및 버전 정보

`.handoff/002_codex-auto-update/PLAN.md`에 명시된 요구사항에 따라 내장 Codex 런타임의 최신 stable 자동 업데이트(하루 4회, 유휴 세션 무중단 적용) 및 세션 보호 아키텍처를 구현하고, App 버전을 `0.7.1`로 상향했습니다.

### 버전 및 아티팩트 해시

| 구성 요소 | 이전 버전 | 변경 버전 | SHA-256 Checksum |
|---|---|---|---|
| **App Version** | `0.7.0` | `0.7.1` | - |
| **Codex Bundled Baseline (amd64)** | `0.144.1` | `0.162.1` | `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3` |
| **Codex Bundled Baseline (aarch64)** | `0.144.1` | `0.162.1` | `53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b` |
| **GitHub CLI** | `2.97.0` | `2.97.0` | 유지 (amd64 / aarch64 고정 핀) |

- 공식 패키지 출처: `https://github.com/openai/codex/releases/tag/rust-v0.162.1`
  - `codex-package-x86_64-unknown-linux-musl.tar.gz`
  - `codex-package-aarch64-unknown-linux-musl.tar.gz`

---

## 2. 변경된 파일 및 Git 상태

### 수정된 파일
- `codex_home_assistant/Dockerfile`: `BUILD_VERSION="0.7.1"`, `CODEX_VERSION="0.162.1"`, amd64/aarch64 체크섬 갱신, baseline을 `/usr/local/lib/codex-ha/codex-baseline`에 설치하고 `/usr/local/libexec/codex-real`로 심볼릭 링크.
- `codex_home_assistant/config.yaml`: 버전 `0.7.1`, 옵션 및 스키마에 `codex_auto_update: true`, `codex_auto_update_timezone: Asia/Seoul` 추가.
- `codex_home_assistant/translations/en.yaml`, `ko.yaml`: 신규 옵션 설명 추가.
- `codex_home_assistant/playwright/package.json`, `package-lock.json`: 버전 `0.7.1` 동기화.
- `codex_home_assistant/CHANGELOG.md`: `0.7.1` 변경 기록 작성.
- `codex_home_assistant/apparmor.txt`: `codex_bwrap` 프로필에 `/usr/local/lib/codex-ha/codex-baseline/** ix,`, `/data/codex-runtime/** rix,`, `deny /data/codex-runtime/** wkl,` 추가.
- `codex_home_assistant/rootfs/usr/local/bin/codex`: `update` 서브커맨드 라우팅, 실행 시 세션 등록(`/run/codex-ha/codex-maintenance/sessions/<pid>.json`) 및 gate 공유 락 획득, `/data/codex-runtime/current/bin/codex` 우선 실행 및 baseline 폴백.
- `codex_home_assistant/rootfs/usr/local/bin/codex-ha-init`: 런타임/유지보수 디렉터리 권한 초기화 및 `codex-runtime-manager.mjs init` 호출.
- `.github/workflows/ci.yaml`: CI 워크플로의 Codex 버전 assertion을 `0.162.1`로 갱신.
- `docs/development/rules.md`: R-403 개정.
- `docs/development/decisions.md`: ADR-043 추가.
- `docs/development/product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`, `releasing.md`, `references.md`, `progress.md`: 0.7.1 및 자동 업데이트 아키텍처 동기화.
- `THIRD_PARTY_NOTICES.md`: 0.162.1 라이선스 고지 갱신.
- `codex_home_assistant/DOCS.md`, `DOCS.en.md`, `README.md`, `README.en.md`, root `README.md`, `README.en.md`: 사용자 및 관리자 문서 동기화.
- `tests/docker-smoke.sh`, `tests/test_addon_contract.py`, `tests/test_multiarch_contract.py`, `tests/test_runtime_contract.py`: 계약 테스트 갱신.

### 신규 생성된 파일
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: 핵심 관리자 모듈 (스케줄 슬롯, semver, 세션 탐색, RFC 6455 웹소켓 진단, 스테이징, SHA-256 검증, tar 안전 추출, 원자적 symlink 전환, 롤백).
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-updater-daemon.mjs`: 백그라운드 주기 확인 및 pending 5분 재확인 데몬.
- `codex_home_assistant/rootfs/usr/local/bin/ha-codex-update`: 관리 CLI (`status`, `check`, `apply`, `update`, `init`).
- `codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/codex-updater/run`: S6 서비스 실행 스크립트 (`SUPERVISOR_TOKEN` 및 민감 토큰 제거 후 node 데몬 실행).
- `codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/codex-updater/type`: S6 서비스 타입 (`longrun`).
- `codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/codex-updater/dependencies`: S6 의존성 (`codex-ha-init`).
- `codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/codex-updater`: S6 사용자 번들 등록.
- `tests/test_codex_update_contract.py`: 업데이터 전용 계약 테스트 (슬롯, semver, 세션, 상태 파일, 래퍼, S6 서비스 등).

---

## 3. 서버 참고 구현 대비 채택 및 강화/제외 내용

| 영역 | 서버 참고 구현 | 본 구현 (Home Assistant App) | 근거 및 차이점 |
|---|---|---|---|
| **확인 주기** | KST 01~05시 5회 및 매시간 idle 확인 | 설정된 IANA timezone 기준 하루 4회 (03, 09, 15, 21시) 및 pending 시 5분 간격 세션 재확인 | 하루 4회 분산 확인으로 네트워크 부하 최소화 및 시간대 설정 지원 (`Asia/Seoul` 기본). Staged 상태에서는 외부 네트워크 트래픽 없이 로컬 세션 상태만 5분 간격으로 재확인. |
| **세션 감지** | 단순 세션 파일 목록 검사 | 세션 등록 레지스트리 + `/proc/*/exe` 스캔 병행 | 레지스트리 외 unmanaged / companion / background Codex 프로세스까지 포괄 감지. Zombie PID 및 PID reuse 방지. |
| **동시성 경합 (Race)** | 짧은 슬립 대기 | 커널 `flock` 기반 Admission Gate | 래퍼 실행 시 `/run/.../gate.lock` 공유 락 획득, 업데이터 전환 시 배타 락 획득으로 새 세션 시작과 심볼릭 링크 교체 간의 경합을 완벽 차단. |
| **유휴 (Idle) 판정** | active turn 검사 위주 | 보수적 판정 (loaded conversation, approval 대기, background terminal 포함) | 사용자가 열어둔 대화나 터미널 세션이 예기치 않게 리셋되는 위험을 방지하기 위해 conversation이 로드된 상태도 busy로 취급하여 pending 유지. |
| **App-Server 제어** | SIGHUP graceful reload 시도 | 자연 종료 시까지 안전 보류 (Pending) | 외부 stdio/Remote SSH 연결을 강제 종료하거나 재시작하지 않고, 자연스럽게 유휴 상태가 될 때까지 보류. |
| **보안 경계** | ambient 권한 유지 | `SUPERVISOR_TOKEN` 상속 제거 + AppArmor sandbox 쓰기 금지 | S6 서비스에서 토큰 환경 변수 제거. AppArmor `codex_bwrap` 프로필에서 `/data/codex-runtime/**` 경로에 대한 쓰기/링크를 명시적 차단(`deny wkl`). |
| **아카이브 검증** | 단순 압축 해제 | SHA-256 검증 + Path Traversal 방지 검사 | tar 아카이브 내 멤버 경로가 절대 경로이거나 `..`를 포함하는 경우 추출 전에 즉시 fail closed. |
| **복구 (Fallback)** | 롤백 디렉터리 | 번들 baseline (`/usr/local/lib/codex-ha/codex-baseline`) 영구 보존 | `/data` 런타임이 손상되거나 심볼릭 링크가 깨져도 번들 baseline으로 즉시 안전 폴백. |

---

## 4. Session / Transport 지원 및 Idle 판정 매트릭스

| Session / Transport | Idle 판정 가능 여부 | 자동 갱신 (Switch) 동작 | Pending 유지 조건 | 비고 |
|---|---|---|---|---|
| **Web UI (ttyd / tmux)** | 가능 (PID, start-time, `/proc/*/exe`) | 완전 유휴 시 원자적 symlink 전환 | 열려 있는 TUI 창, 입력 대기 중인 세션, 활성 pane 존재 시 | 기존 실행 중인 세션을 강제 종료하지 않음. 다음 새 세션부터 새 버전 적용. |
| **SSH CLI** | 가능 (PID, start-time, `/proc/*/exe`) | 완전 유휴 시 원자적 symlink 전환 | SSH 세션 내 `codex` 프로세스 실행 중일 때 | Bash 셸에서 `codex`를 빠져나와 유휴가 되면 적용 가능. |
| **Remote SSH (ChatGPT mobile)** | 가능 (PID 및 socket 매핑) | 자동 재시작 불가, 자연 종료 시까지 pending | 활성 연결 또는 stdio 프로세스 상주 시 | SSH 클라이언트 소유 stdio 스트림은 업데이터가 임의로 종료하지 않고 연결 종료 시까지 안전하게 pending 유지. |
| **Managed Unix Socket App-Server** | 가능 (RFC 6455 WebSocket diagnostics) | 유휴 시 적용, 활성 시 pending | 활성 turn, 승인 대기, 백그라운드 터미널, loaded conversation 존재 시 | Loaded idle conversation도 보수적으로 busy 판정하여 대화 문맥 유실 방지. |
| **Unmanaged / Companion Process** | 가능 (`/proc/*/exe` 스캔) | 자동 제어 불가, pending | 레지스트리 밖의 Codex 바이너리 실행 감지 시 | Unknown 상태를 idle로 간주하지 않고 안전하게 pending 유지. |

---

## 5. 보안 및 안전성 강화 세부사항

1. **AppArmor 경계 강화**:
   - `/usr/local/lib/codex-ha/codex-baseline/** ix,`
   - `/data/codex-runtime/** rix,`
   - `deny /data/codex-runtime/** wkl,`
   - `codex_bwrap` 프로필 내부에서 실행되는 샌드박스 코드는 `/data/codex-runtime` 아래의 바이너리, 심볼릭 링크, 메타데이터를 수정하거나 악성 스크립트를 삽입할 수 없습니다.
2. **최소 권한 데몬**:
   - `s6-rc.d/codex-updater/run`에서 `SUPERVISOR_TOKEN`, `HA_TOKEN`, `GITHUB_TOKEN` 등을 unset하고 독립 사용자 환경에서 실행합니다.
3. **무자격증명 상태 파일**:
   - `/data/codex-runtime/state.json`에는 오직 버전 문자열, 타임스탬프, 체크섬, 상태 enum, 슬롯 정보만 기록되며 토큰이나 프롬프트, 사용자 대화 내용은 일절 포함되지 않습니다 (`0600` 권한).
4. **공급망 및 무결성 검증**:
   - GitHub Releases API를 통해 stable 최신 버전을 조회하며, prerelease는 자동으로 제외합니다.
   - 공식 sha256 해시를 다운로드 아카이브와 대조 검증합니다.
   - tarball 추출 전 모든 파일 목록을 점검하여 상위 디렉터리 탈출(`..`)이나 절대 경로를 포함한 아카이브는 추출하지 않고 거부합니다.
   - 심볼릭 링크 전환 전 추출된 바이너리의 실행 권한(`0755`)과 `codex --version` 실행 가능 여부를 사전에 테스트합니다.

---

## 6. 검증 결과 및 증거

### A. Python Contract & Unit Tests
```bash
uv run pytest
```
- 결과: **123 passed in 10.11s**
- 신규 테스트 `tests/test_codex_update_contract.py` 포함 9개 테스트 케이스:
  - 4개 슬롯 계산 및 IANA 타임존/기본값 폴백 검증
  - Semver 파싱, 비교 및 아키텍처 매핑 검증
  - 세션 레지스트리 및 `/proc/*/exe` 탐색 검증
  - WebSocket 진단 페이로드 및 보수적 busy/idle 판정 검증
  - `state.json` 자격증명 비노출 및 sanitization 검증
  - `ha-codex-update` CLI 옵션 처리 검증
  - `codex update` 래퍼 라우팅 검증
  - S6 서비스 디렉터리 및 의존성 구조 검증

### B. 정적 분석 및 린터
1. **ShellCheck**:
   ```bash
   shellcheck codex_home_assistant/rootfs/usr/local/bin/* codex_home_assistant/rootfs/usr/local/lib/codex-ha/* tests/*.sh
   ```
   - 결과: **PASS** (경고 0개)
2. **Hadolint**:
   ```bash
   hadolint codex_home_assistant/Dockerfile
   ```
   - 결과: **PASS** (경고 0개)
3. **Actionlint**:
   ```bash
   actionlint .github/workflows/ci.yaml
   ```
   - 결과: **PASS** (경고 0개)
4. **AppArmor Parser**:
   ```bash
   apparmor_parser --skip-kernel-load --skip-cache codex_home_assistant/apparmor.txt
   ```
   - 결과: **PASS** (구문 오류 0개)
5. **Git diff check**:
   ```bash
   git diff --check
   ```
   - 결과: **PASS** (공백/EOF 오류 0개)
6. **Secret Scanning**:
   - `test_secret_scan.py` PASS.
   - 신규 구현 코드 및 설정 파일 내에 비밀값, 토큰, 자격증명 패턴 부재 확인 완료.

---

## 7. 미검증 항목 및 제약 사항 (NOT RUN)

투명성과 안전성을 위해 다음 항목은 수행하지 않았으며 `NOT RUN`으로 명시합니다:

1. **Native aarch64 하드웨어 실행 (NOT RUN)**:
   - 로컬 검증 환경은 x86_64 Linux입니다. aarch64 패키지 해시 및 아키텍처 매핑 로직은 계약 테스트로 검증했으나 실제 ARM 실기 하드웨어 실행은 수행하지 않았습니다.
2. **실제 HAOS 실기 런타임 설치 및 관측 (NOT RUN)**:
   - 실제 Home Assistant OS 장치에 대한 변경은 사용자 명시적 승인/요청 범위 밖이므로 적용하지 않았습니다.
3. **외부 Git Push / PR 생성 / GitHub Release 발행 (NOT RUN)**:
   - 승인되지 않은 외부 write 작업을 방지하기 위해 로컬 Git 브랜치 작업만 수행했습니다.
