# FIX_06_REPORT — FIX_06 구현 및 검증 보고서

## 1. 개요 및 역할

- **작성 주체**: Executor
- **일시**: 2026-10-13 Asia/Seoul
- **대상 작업**: `.handoff/002_codex-auto-update/FIX_06.md`에 지시된 2가지 경계 결함(P1: GC 프로세스 검사 실패를 무참조로 취급하는 문제, P2: UTC 정오 anchor 및 timezone format에 따른 calendar 날짜 밀림 문제) 전수 해결 및 회귀 검증.
- **원칙 준수**: 기존 handoff 파일 보존, git commit/push/tag/release 미수행, 운영 Home Assistant 변경 없음.

---

## 2. 세부 변경 사항

### 2.1 P1 — GC 프로세스 검사 실패 시 fail-closed 보존 (`codex-runtime-manager.mjs`)
- **원인 분석**:
  - 기존 `cleanupOldReleases`는 개별 프로세스의 `/proc/<pid>/exe`, `/proc/<pid>/cwd`, `/proc/<pid>/fd/*`, `/proc/<pid>/maps`, `/proc/<pid>/cmdline` 열람 실패를 빈 `catch {}` 블록으로 무시하였음.
  - 이로 인해 `PR_SET_DUMPABLE=0`이나 AppArmor/권한 제한으로 `/proc/<pid>/fd` 열람 시 `EACCES`/`EPERM`이 발생하더라도, 해당 프로세스에 참조가 없는 것으로 간주하고 구버전 릴리스 디렉터리를 삭제하는 심각한 안전성 결함이 발생했음.
- **구현 내용**:
  - `isExitRace(err)` (`ENOENT`, `ESRCH`)와 `isAccessDenied(err)` (`EACCES`, `EPERM`)를 구분하는 헬퍼 함수 정의.
  - 프로세스 검사 루프(`exe`, `cwd`, `fd`, `maps`, `cmdline`)에서:
    - 프로세스 종료에 따른 자연스러운 레이스(`ENOENT`, `ESRCH`)는 정상 진행으로 처리.
    - 접근 거부(`EACCES`, `EPERM`) 또는 기타 예기치 않은 열람 실패 발생 시 즉시 `hasInspectionError = true`로 플래그를 설정하고 루프 중단.
  - `hasInspectionError === true`인 경우 삭제를 즉시 보류(fail-closed)하고 `{ deleted: [], deferred: true, reason: "process_inspection_uncertain" }`를 반환하여 구버전 릴리스를 디스크에 온전히 보존.
  - 프로세스 파일시스템 검사 환경 격리 및 단위 테스트 재현을 위해 `process.env.CODEX_PROC_DIR` 환경 변수 지원 (`/proc` 기본값).
- **검증 및 회귀 테스트**:
  - Reviewer의 독립 재현 스크립트(`/tmp/codex-ha-review06-gc.py`) 검증:
    - `prctl(PR_SET_DUMPABLE, 0)`로 비공개 reader 프로세스 구동 후 `cleanupOldReleases` 호출 시 `inspectionError: "EACCES"` 감지, `preserved: true`, `readerAlive: true` 확인.
  - `tests/test_codex_update_contract.py`에 다음 4종 회귀 테스트 구현 및 통과:
    1. `test_cleanup_old_releases_preserves_live_fd_and_resource_references`: reader가 리소스를 열고 있는 동안 `0.160.0` 보존 (`existsWhileOpen: true`), reader 종료 후 안전한 정리 (`existsAfterClose: false`).
    2. `test_cleanup_old_releases_aborts_on_eacces_inspection_error`: `prctl(PR_SET_DUMPABLE, 0)` 상태에서 `EACCES` 발생 시 `deferred: true`, `reason: "process_inspection_uncertain"`, `preserved: true` 실증.
    3. `test_cleanup_old_releases_handles_process_exit_race`: `readdir` 후 검사 전 사라진 프로세스(dangling link `ENOENT`)를 종료 레이스로 정상 수용하고 잔여 미참조 릴리스 삭제 성공 확인.
    4. `test_cleanup_old_releases_preserves_live_cwd_and_mmap`: 프로세스의 `cwd` 또는 `maps`가 구버전을 가리키는 경우 정상 보존 확인.

### 2.2 P2 — 순수 Calendar 산술 기반 Timezone 날짜 경계 및 롤오버 수정 (`codex-runtime-manager.mjs`, `codex-updater-daemon.mjs`)
- **원인 분석**:
  - `getNextDayFirstSlotTime` 및 `getCurrentSlotInfo`에서 날짜를 1일 이동할 때 `Date.UTC(..., 12, 0, 0)` 정오 anchor를 생성한 뒤 대상 timezone으로 다시 format하였음.
  - UTC+12 이상(예: `Pacific/Auckland` UTC+13, `Pacific/Kiritimati` UTC+14)에서는 UTC 12:00가 현지 시각으로 이미 다음 날짜가 되어 day 이동이 이중으로 누적되는 오류 발생 (10/13 22시 입력 시 다음 슬롯이 10/15로 하루 더 밀림, 10/13 01시 입력 시 slotDate가 미래의 10/13T21시로 산출).
  - `codex-updater-daemon.mjs`의 line 49, 52에 `new Date()` 직접 호출이 남아 있어 deterministic clock 주입 일관성이 저해됨.
- **구현 내용**:
  - 순수 calendar 날짜 산술 함수 `shiftCalendarDate(year, month, day, deltaDays)` 도입:
    - UTC Date의 내부 산술(`d.setUTCDate(d.getUTCDate() + deltaDays)`)을 사용하되, 결과는 순수 연/월/일(`getUTCFullYear()`, `getUTCMonth() + 1`, `getUTCDate()`)로만 추출하고 timezone 재변환을 일절 배제.
  - `getNextDayFirstSlotTime` 및 `getCurrentSlotInfo`:
    - 순수 calendar 날짜 산술로 목표 연/월/일을 먼저 확정.
    - 확정된 현지 연/월/일/시/분을 `zonedDateTimeToUtc`를 통해 단 1회만 정확한 UTC instant로 변환.
    - `getCurrentSlotInfo` 반환 객체에 `nextSlotTime`을 명시적으로 포함하여 일일 budget 롤오버와 동기화.
  - `codex-updater-daemon.mjs`:
    - line 49, line 52의 `new Date()`를 주입 가능한 `getNow()`로 전면 교체하여 일관된 clock abstraction 확보.
- **검증 및 회귀 테스트**:
  - `tests/test_codex_update_contract.py`의 `test_timezone_and_slot_calculations`를 확장하여 다음 전수 검증 통과:
    - America/New_York의 봄(Spring Forward) / 가을(Fall Back) DST 전환 시 슬롯 및 UTC instant 일치.
    - Pacific/Auckland (UTC+13) 22:00 입력: nextSlotTime이 현지 10/14 03:00 (10/13 14:00Z)로 정확히 산출.
    - Pacific/Auckland (UTC+13) 01:00 입력: slotDate가 2026-10-12, slotKey가 2026-10-12T21:00, nextSlotTime이 현지 10/13 03:00 (10/12 14:00Z)로 정확히 산출.
    - Pacific/Kiritimati (UTC+14) 및 Etc/GMT+12 (UTC-12)의 극단 시간대 경계 정상 산출.
    - 2026-12-31 23:00 연말/연초 롤오버 시 2027-01-01 03:00 슬롯 산출.

---

## 3. 검증 결과 및 증거

| 검사 항목 | 실행 명령 | 결과 |
| --- | --- | --- |
| **전체 계약 테스트** | `.venv/bin/pytest -q` | **194 passed in 61.17s** |
| **신규/확장 계약 테스트** | `.venv/bin/pytest tests/test_codex_update_contract.py` | **80 passed in 55.77s** |
| **개별 Node 문법 검증** | `for f in .../*.mjs; do node -c "$f"; done` | **14개 전체 파일 PASS** (각 파일 개별 호출) |
| **셸 스크립트 정적 검사** | `shellcheck codex_home_assistant/rootfs/usr/local/bin/* ... tests/*.sh` | **PASS (경고/에러 0)** |
| **Dockerfile Hadolint** | `hadolint codex_home_assistant/Dockerfile` | **PASS** |
| **GitHub Actions lint** | `actionlint .github/workflows/*.yaml` | **PASS** |
| **Git diff 공백/포맷 검사**| `git diff --check` | **PASS** |
| **Reviewer EACCES 재현** | `python3 /tmp/codex-ha-review06-gc.py` | `{"inspectionError":"EACCES","preserved":true}`, `readerAlive:true` |
| **후보 Docker 이미지 재빌드**| `docker build -t codex-for-home-assistant:fix06-test codex_home_assistant` | **성공** (ID: `sha256:6e43314a481de5b35afc2d9e88dcdd15dba17709b2d256ab8660bcae55a7b39e`) |
| **컨테이너 내부 런타임 점검**| `docker run --rm --entrypoint /bin/sh codex-for-home-assistant:fix06-test -c '...'` | Bundled: 0.162.1, Slot: 2026-10-13T09:00 정상 점검 |

---

## 4. 계획 대비 편차 (Deviations)

- 없음. FIX_06에서 요청된 2가지 경계 결함(P1: GC 검사 실패 fail-closed 보존, P2: UTC 정오 timezone formatting 배제 및 순수 calendar 산술 도입)을 지침에 따라 엄격히 구현함.

---

## 5. 미검증 항목 및 잔여 위험 (Verification Gaps)

- **NOT RUN**:
  - **Docker 통합 smoke 스크립트 실행 제한**: 호스트 환경 커널에 `codex_home_assistant` AppArmor 프로필이 등록되어 있지 않고, 비특권 Docker 실행 환경의 bubblewrap loopback netlink(`RTM_NEWADDR`) 권한 제한으로 인해 `tests/codex-update-smoke.sh` 및 `tests/update-smoke.sh`의 완전 컨테이너 E2E 실행은 이번 호스트에서는 NOT RUN으로 남김 (실제 HAOS VM 또는 GitHub CI runner 환경에서 실행 필요).
  - **Native ARM / aarch64 실기 검증**: Raspberry Pi 등 물리 aarch64 실기 검증 및 수정 GitHub Actions의 실제 원격 trigger는 NOT RUN (문서화된 갭 유지).
  - **Git 배포/발행**: 외부 Git commit, push, tag 및 GitHub Releases / GHCR 배포는 일절 수행하지 않음 (Reviewer 인수 후 사용자 승인 범위에서 진행).

---

## 6. 다음 단계 권고

- Reviewer가 본 보고서와 working tree의 2가지 수정 사항 및 증거를 독립 검증하고 인수 판정을 내릴 수 있습니다.
- 인수 완료 시 기존 승인 범위에 따라 `0.7.1-dev.N`의 DEV identity 부여 및 dev 브랜치/태그 발행 단계로 진행 가능합니다.
