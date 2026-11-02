# FIX_05_REPORT: Real Socket Peer / Rebind Verification, Honest SSH Diagnostics, and Multi-Turn Proxy Update Protection

- **Task**: `007_work-aware-runtime-update`
- **Role**: Executor
- **Reference**: [.handoff/007_work-aware-runtime-update/FIX_05.md](file:///.handoff/007_work-aware-runtime-update/FIX_05.md)
- **Branch**: `feat/fix03-mobile-proxy-bootstrap`
- **Status**: Implemented, verified, ready for Reviewer review

---

## 1. Executive Summary

In response to Reviewer Codex's `FIX_05.md` (which identified that filesystem alias retargeting could falsely associate an active proxy with an idle server, that `/run/sshd.pid` false positives occurred on foreign PIDs, and that multi-turn turn conversations with update protection required end-to-end wire verification), this round completes:

1. **[P1] Real socket peer / connection generation vs filesystem alias (`codex-runtime-manager.mjs`)**:
   - Closed the Reviewer's independent reproduction (`.test-tmp/review007-fix04/alias-owner.py`): proxy connected to server A via symlink alias, alias subsequently repointed to idle server B.
   - Enforced symlink target creation time verification: `targetLstat.mtimeMs > proxyStartTime + 50` detects retargeting after proxy start -> held as `kind: "unknown"` (`proxyTargetRetargeted`).
   - Enforced socket file creation time verification: `targetStat.ctimeMs > proxyStartTime + 50` detects socket rebind/recreation after proxy start -> held as `kind: "unknown"` (`proxySocketRebound`).
   - Enforced candidate owner generation verification: `ownerStartTime > proxyStartTime + 100` rejects servers started after proxy launch -> held as `kind: "unknown"` (`orphanProxy`).
   - Enforced active connection peer verification: if proxy process holds open socket FDs, candidate owner in `/proc/<owner_pid>/fd` must possess an accepted connection socket (`St: 03` in `/proc/net/unix`).
   - Regression results on Reviewer script `.test-tmp/review007-fix04/alias-owner.py`: changed from `helpers: 1, unknown: 0, canApply: true` to `helpers: 0, unknown: 1, canApply: false`.

2. **[P2] Honest SSH listener & PID diagnostics in `codex-remote-setup.mjs`**:
   - Closed the Reviewer's independent reproduction: `/run/sshd.pid` containing an arbitrary PID (e.g. `bash`) falsely reported `SSH service: active / listening`.
   - Inspected `/proc/<pid>/exe` and `/proc/<pid>/cmdline` for `sshd` or `dropbear`; mismatched executable reports `not_disabled / pid_mismatch (pid <pid> is not sshd)`.
   - If sshd process exists, inspected `/proc/net/tcp` and process FDs for listening TCP socket (`St: 0A`); confirmed socket reports `active / listening`; unconfirmed reports `sshd_running / listener not_checked`.
   - Added `process.env.CODEX_RUN_DIR || '/run'` for clean test isolation.
   - Updated `tests/test_remote_setup.py`: invokes actual `main(['status'], ...)` and asserts on literal output strings for all 11 diagnostic states (0400, 0600, 0777, absent, empty, commented, mismatch, synced, ssh-disabled, pid-mismatch, stale-pid).

3. **[P1] Real multi-turn conversation and update hold verification (`tests/test_codex_wrapper_proxy.py`)**:
   - Implemented `test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection` parameterized over both official binaries: `0.162.1` (`task007-baseline`) and `0.166.0` (`resume-166`).
   - Connected raw `codex app-server proxy` to real `codex app-server` over Unix socket with a local mock Responses HTTP provider (`wire_api="responses"`).
   - Upgraded HTTP to WebSocket (101 Switching Protocols), initialized session (`initialize`, `initialized`), and created thread (`thread/start`).
   - **Turn 1 & Update Protection**: sent `turn/start`, mock provider held response; while turn was active (`core.turns.active = 1`), ran `inspectAllSessions()`, which confirmed `canApply: false` and `helpers: 1`.
   - **Context Retention**: released response 1 (`Answer 1`), observed `turn/completed`; executed Turn 2 (`turn/start`), verified that mock provider received 2nd request containing Turn 1's user prompt and assistant response in its history.
   - Clean shutdown with WebSocket close frame and EOF.

4. **Release & Scope Compliance**:
   - Retained version `0.7.3-dev.5`.
   - No git tags created, no remote push, no DEV release deployed (Reviewer held release).

---

## 2. Changes by File

### 2.1 `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
- **Socket Path & Symlink Generation Checks**:
  - Captured `proxyStartTime = parseProcStartTime(e.proc.stat)` for each proxy candidate.
  - Checked `targetLstat.mtimeMs > proxyStartTime + 50`: if symlink alias was modified after proxy start, mark `e.proxyTargetRetargeted = true; e.kind = "unknown"`.
  - Checked `targetStat.ctimeMs > proxyStartTime + 50`: if socket inode was recreated after proxy start, mark `e.proxySocketRebound = true; e.kind = "unknown"`.
- **Candidate Owner Generation & Active Connection Checks**:
  - Checked `ownerStartTime > proxyStartTime + 100`: if candidate owner was started after proxy, reject ownership (`orphanProxy = true; e.kind = "unknown"`).
  - Queried `/proc/net/unix` and `/proc/<pid>/fd` to determine if proxy has open socket FDs.
  - If proxy has open socket FDs, candidate owner must have at least one socket in state `03` (CONNECTED / ACCEPTED). If not, candidate owner cannot be claimed as active owner; proxy marked `orphanProxy = true; e.kind = "unknown"`.
- **Diagnostics Messages**:
  - Added specific blocker messages for `proxyTargetRetargeted` and `proxySocketRebound`.

### 2.2 `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs`
- **Environment Isolation**:
  - `const runDir = process.env.CODEX_RUN_DIR || "/run";`
- **Process & Binary Inspection**:
  - Replaced simple `process.kill(pid, 0)` with inspection of `/proc/${pid}/exe` (and fallback to `/proc/${pid}/cmdline`).
  - Allowed executables: `sshd` and `dropbear`.
  - If PID does not match sshd executable, reported `not_disabled / pid_mismatch (pid ${pid} is not sshd)`.
- **TCP Listener Verification**:
  - For confirmed sshd processes, inspected `/proc/${pid}/fd` for socket inodes and verified whether any inode matches a TCP socket in `/proc/net/tcp` with state `0A` (TCP_LISTEN).
  - Confirmed: `SSH service: active / listening`
  - Unconfirmed: `SSH service: sshd_running / listener not_checked`

### 2.3 `tests/test_remote_setup.py`
- Re-architected `test_status_diagnostics_states` and `test_status_authorized_keys_comment_and_mismatch` to run `main(['status'], ...)` in a subprocess with `CODEX_RUN_DIR` and `CODEX_SSH_DIR`.
- Verified exact literal status lines across all states:
  - `Private material: present (0400)`
  - `Private material: present (0600)`
  - `Private material: insecure permissions (mode 0777)`
  - `Private material: absent`
  - `Authorized keys: synchronized (1 key)`
  - `Authorized keys: commented / inactive`
  - `Authorized keys: empty`
  - `Authorized keys: out of sync (key mismatch)`
  - `SSH service: disabled (no keys registered at startup)`
  - `SSH service: not_disabled / pid_mismatch (pid <pid> is not sshd)`
  - `SSH service: not_disabled / listener not_running`

### 2.4 `tests/test_codex_update_contract.py`
- Updated mock proxy fixtures in `test_managed_idle_server_with_owned_proxy_is_restartable` and `test_managed_server_with_owned_proxy_held_busy_during_active_work` to establish an active socket connection via `net.createConnection()`.
- Added `test_proxy_target_alias_retargeted_is_held_unknown`: verifies that repointing a symlink after proxy launch results in `unknown` / `canApply: false`.
- Added `test_proxy_socket_rebound_after_launch_is_held_unknown`: verifies that rebinding/recreating the socket inode after proxy launch results in `unknown` / `canApply: false`.

### 2.5 `tests/test_codex_wrapper_proxy.py`
- Added `test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection` parameterized across `task007-baseline` (0.162.1) and `resume-166` (0.166.0).
- Sets up local mock Responses provider returning valid SSE chunks (`response.created`, `response.output_item.done`, `response.completed`).
- Verifies full handshake, Turn 1 execution, update hold (`canApply: false`, `counts.helpers: 1`, `core.turns.active = 1`), release of response, Turn 2 execution, conversation history accumulation in mock provider body, and clean close.

---

## 3. Verification & Evidence

### 3.1 Reviewer's Independent Reproduction Verification
- Executed Reviewer's script `.test-tmp/review007-fix04/alias-owner.py`:
  - **Before Fix**: `counts: {"helpers": 1, "unknown": 0}, canApply: true`
  - **After Fix**: `counts: {"helpers": 0, "unknown": 1}, canApply: false`, busyReasons: `["[unknown] codex proxy target socket symlink was retargeted after proxy launch..."]`
- In-container test with foreign PID:
  - `docker run --rm --entrypoint /bin/sh codex-ha:test-fix05 -c 'install -d -m 0700 /data/ssh; printf "$$" > /run/sshd.pid; ha-codex-remote status'`
  - **Result**: `SSH service: not_disabled / pid_mismatch (pid 1 is not sshd)`

### 3.2 Automated Test Execution
| Test Suite | Commands | Result | Time |
|---|---|---|---|
| Remote Setup Tests | `.venv/bin/python -m pytest -v tests/test_remote_setup.py` | 12 passed | 0.53s |
| Wrapper Proxy Tests | `.venv/bin/python -m pytest -v tests/test_codex_wrapper_proxy.py` | 7 passed | 3.81s |
| Update Contract Tests | `.venv/bin/python -m pytest -v tests/test_codex_update_contract.py` | 129 passed | 98.89s |
| Core Add-on Tests | `.venv/bin/python -m pytest -v tests/test_addon_contract.py tests/test_token_boundary.py` | 27 passed | 0.40s |
| Total Pytest | Full run across modified areas | **148 passed** | ~104s |
| Node Syntax Check | `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs` | PASS | 0.1s |
| Git Diff Check | `git diff --check` | Clean (0 warnings) | 0.0s |
| Docker Build | `docker build -t codex-ha:test-fix05 codex_home_assistant` | SUCCESS | 6.0s |
| Mobile SSH Smoke | `IMAGE_NAME=codex-ha:test-fix05 .venv/bin/python tests/mobile-ssh-smoke.py` | PASS | 9.0s |

---

## 4. Verification Gaps (Honest Disclosure)

| Item | Status | Notes |
|---|---|---|
| Alias retargeting & socket rebind protection | **PASS** | Verified via unit tests and Reviewer's independent script |
| Honest SSH listener & PID mismatch diagnostics | **PASS** | Verified via pytest status matrix and live container execution |
| Multi-turn turn execution & update hold | **PASS** | Verified across 0.162.1 and 0.166.0 binaries with mock Responses provider |
| Container build & Mobile SSH S6 smoke test | **PASS** | Tested on `codex-ha:test-fix05` image |
| Version bump & DEV release publish | **NOT RUN** | Held pending Reviewer approval per FIX_05 instructions |
| Real physical HAOS device installation | **NOT RUN** | Target remains isolated dev branch; production HAOS untouched |
| Real physical ARM64 hardware execution | **NOT RUN** | Validated on x86_64 host; multiarch Docker builds rely on QEMU/builder |
