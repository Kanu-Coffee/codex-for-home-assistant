# FIX_03 Execution Report: Codex Auto-Update Hardening & Managed Server Lifecycle

- **Task**: `002_codex-auto-update`
- **Role**: Executor
- **Input Document**: [.handoff/002_codex-auto-update/FIX_03.md](file:///home/lee/projects/codex_for_HA/.handoff/002_codex-auto-update/FIX_03.md)
- **Status**: COMPLETE
- **Date**: 2026-10-13

---

## 1. Executive Summary

In response to `.handoff/002_codex-auto-update/FIX_03.md`, all requested safety, integrity, and test issues have been resolved:
1. **Allowed Package Roots & Tree Validation (Issue 1)**: Staging extract paths (`staging/.extract-*`) are explicitly authorized alongside canonical release paths (`releases/`, `baseline/`). Hardlink checks, setuid/setgid rejections, and manifest version/target validations now protect both staging and canonical trees without false rejections.
2. **Immutable Release Preservation & Pre-Extraction Inspection (Issue 2)**: Package archives undergo strict `tar -tvzf` pre-extraction scans (entry limit <= 500, size limit <= 128MB, unsafe paths/file types rejected). Existing release destinations (`releases/${version}-${target}`) are reused cleanly if valid, preserving live inodes instead of invoking recursive directory deletions.
3. **Daily Idle Budget & Next-Day Recovery Contract Test (Issue 3)**: Contract tests for daily idle budget exhaustion and next-day recovery now inject test time (`CODEX_TEST_CLOCK`) into runtime date/slot calculations (`getNow()`, `getNextDayFirstSlotTime()`) and verify state unpausing to `ready_to_apply`.
4. **Managed Server Detection & Safe Restart Transaction (Issue 4)**: Process inspection scopes candidates to runtime/sessions boundaries, completely filtering out internal locking tools (`flock`) and external host processes. Managed local app-servers require verified launch records in `sessions/<pid>`. The restart sequence includes pre-flight validation, 5-second graceful SIGTERM drain, atomic symlink switch, unshared environment spawning, readiness polling, and automatic symlink rollback with previous service restoration on failure.
5. **Full Verification**: 20/20 contract tests pass in `tests/test_codex_update_contract.py`, and all 134 pytest tests across the entire repository pass without regressions. Linters (`shellcheck`, `hadolint`, `actionlint`, `git diff --check`) passed cleanly.

---

## 2. Detailed Implementation

### 2.1 Package Root & Candidate Tree Validation (`codex-runtime-manager.mjs`)
- **`isAllowedPackageRoot(targetPath)`**:
  - Implemented to authorize canonical runtime paths (`releases/`, `baseline/`) as well as updater staging directories (`staging/.extract-*`).
  - Distinguishes canonical runtime paths via `isCanonicalRuntimePath()` while allowing candidate package trees extracted into staging to pass tree containment checks.
- **`validateCandidatePackageTree(packageDir, options)`**:
  - Disallows un-authorized roots unless `options.allowAnyRoot: true` is passed.
  - Recursively inspects all files:
    - Rejects special files (block, char, FIFO, socket).
    - Enforces `st.nlink <= 1` (rejects external and internal hardlinks).
    - Checks `(st.mode & 0o6000) === 0` (rejects setuid/setgid).
    - Rejects symlinks pointing outside the candidate root.
  - Checks executable permissions on `bin/codex`.
  - Validates `codex-package.json` manifest schema, ensuring `version` and `target` match expected values (`options.expectedVersion`, `options.expectedTarget`).

### 2.2 Archive Pre-Extraction Validation & Immutable Release Reuse
- **`downloadAndStagePackage`**:
  - Pre-extraction safety validation via `tar -tvzf`:
    - Checks archive entry count (`<= 500`).
    - Validates total uncompressed size (`<= 128 MB`).
    - Rejects entries with unsafe types (`h` hardlinks, `b` block, `c` char, `p` FIFO).
    - Rejects symlink targets that are absolute or contain `..`.
    - Rejects path traversal in file paths (`/`, `../`, `..\\`).
  - Immutable destination reuse:
    - If `destDir` (`releases/${version}-${target}`) already exists and passes `validateCandidatePackageTree`, it is reused cleanly without `rm(recursive)`.
    - Preserves running executable inodes from deletion while keeping downloads idempotent.
  - Added HTTP protocol support (`httpGet`) alongside HTTPS and `file://` protocols for local test harnesses.

### 2.3 Clock Injection & Date Helpers
- **`getNow()`**:
  - Honors `process.env.CODEX_TEST_CLOCK` for deterministic test time advancement.
  - Used in `getCurrentSlotInfo()`, `getNextDayFirstSlotTime()`, `checkUpdate()`, `applyUpdate()`, and state journal timestamp recordings.
- **`getNextDayFirstSlotTime(now, timezone)`**:
  - Computes the ISO 8601 timestamp for 03:00 (Slot 0) of the subsequent calendar day in the configured timezone.

### 2.4 Managed Server Lifecycle & Restart Transaction
- **Process Inspection & Candidate Scoping (`inspectAllSessions`)**:
  - In `sessionsDir` scan: skips marking `content.type === "app-server"` as generic blocking CLI sessions, deferring them to dedicated app-server evaluation.
  - In `/proc` scan: candidates are scoped to the current runtime instance (`hasSessionRecord || proc.exe.startsWith(baseDir) || cmdStr.includes(baseDir)`).
  - Explicitly excludes `flock` child processes created by gate locks and unrelated external host processes.
  - Strictly requires an active launch record in `sessions/<pid>` with `managed: true`, `type: "app-server"`, matching PID, matching start time, and verified unix socket.
  - Unmanaged servers or processes without launch records remain classified as `busyReasons` and defer updates until exit.
- **Restart Transaction (`applyUpdate`)**:
  - Pre-flight checks: verifies staged package tree integrity and runs `--version` test on candidate binary before issuing any signals.
  - Re-verifies PID identity, start time, and idle diagnostic gauges of each server immediately before signal.
  - Records restart attempt in state journal (`lastRestartAt`, `nextRestartAllowedAt`, `restartAttemptCount`) before signaling.
  - Sends `SIGTERM` and waits up to 5 seconds for graceful exit (no `SIGKILL`).
  - Atomically switches `current` symlink.
  - Spawns new server with safe environment (`SUPERVISOR_TOKEN` deleted) and resilient working directory fallback (`server.managedRecord.cwd -> /config -> process.cwd()`).
  - Verifies readiness via WebSocket diagnostics: if readiness fails or times out, automatically rolls back symlink to `previousTarget` and respawns the previous server.
  - On success: registers updated session record for new PID, unlinks `staged` link, sets `previous` symlink, updates state to `applied`, and invokes `cleanupOldReleases()`.

---

## 3. Verification & Evidence

### 3.1 Contract Tests (`tests/test_codex_update_contract.py`)
All 20 contract tests executed and passed:
```
$ .venv/bin/pytest tests/test_codex_update_contract.py
============================= test session starts ==============================
platform linux -- Python 3.13.15, pytest-8.4.1, pluggy-1.6.0
rootdir: /home/lee/projects/codex_for_HA
collected 20 items

tests/test_codex_update_contract.py ....................                 [100%]

============================== 20 passed in 7.87s ==============================
```

Tests cover:
- Architecture resolution (amd64 / aarch64 musl mapping).
- Options file parsing and fail-closed validation.
- Symlink containment and path escaping rejection.
- Slot calculation across IANA timezones and clock advancement.
- Pre-extraction tar inspection, SHA-256 verification, and immutable destination reuse.
- Candidate package tree validation (hardlinks, setuid/setgid, escaping symlinks, schema mismatches).
- Daily idle check budget (12 checks) with `paused_busy` and next-day recovery.
- Full server graceful restart transaction with fixture process (pre-flight checks, SIGTERM drain, symlink switch, readiness polling, rollback on failure, and 24h cooldown).

### 3.2 Full Repository Test Suite
All 134 pytest test cases passed with zero failures:
```
$ .venv/bin/pytest
============================= test session starts ==============================
platform linux -- Python 3.13.15, pytest-8.4.1, pluggy-1.6.0
rootdir: /home/lee/projects/codex_for_HA
collected 134 items

tests/test_addon_contract.py ..................                          [ 13%]
tests/test_api_client.py ..........                                      [ 20%]
tests/test_browser_contract.py ............                              [ 29%]
tests/test_browser_user_provisioning_contract.py .......                 [ 35%]
tests/test_codex_update_contract.py ....................                 [ 50%]
tests/test_feedback_contract.py ...........                              [ 58%]
tests/test_memory_contract.py ..........                                 [ 65%]
tests/test_multiarch_contract.py .......                                 [ 70%]
tests/test_runtime_contract.py ..........                                [ 78%]
tests/test_secret_scan.py ..                                             [ 79%]
tests/test_sensitive_path_policy.py .................                    [ 92%]
tests/test_token_boundary.py ......                                      [ 97%]
tests/test_user_files_update_contract.py ....                            [100%]

============================= 134 passed in 13.34s =============================
```

### 3.3 Linters & Code Quality
- **`shellcheck`**:
  ```
  $ shellcheck codex_home_assistant/rootfs/usr/local/bin/codex codex_home_assistant/rootfs/usr/local/bin/ha-codex-update codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/codex-updater/run
  (Clean, exit code 0)
  ```
- **`actionlint`**:
  ```
  $ actionlint .github/workflows/ci.yaml
  (Clean, exit code 0)
  ```
- **`hadolint`**:
  ```
  $ hadolint codex_home_assistant/Dockerfile
  (Clean, exit code 0)
  ```
- **`git diff --check`**:
  ```
  $ git diff --check
  (Clean, exit code 0)
  ```

---

## 4. Verification Gaps & NOT RUN Items

In accordance with repository guidelines:
1. **Docker full image rebuild & container smoke test**: NOT RUN in this iteration.
2. **Live HAOS runtime installation & acceptance**: NOT RUN. Production Home Assistant environments and external pushes remain untouched.
3. **Native aarch64 execution**: NOT RUN (tests executed in local amd64 Linux development environment).

---

## 5. Next Steps

With all Reviewer corrections in `FIX_03.md` fully implemented and verified against the expanded 20-test contract suite and 134 full test cases, the codebase is ready for Reviewer evaluation and acceptance.
