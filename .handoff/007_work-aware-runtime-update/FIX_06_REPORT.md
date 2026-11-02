# FIX_06_REPORT: Linux Kernel Netlink Direct Peer Verification, Real Server Upgrade Transaction, and Cross-Generation Turn Continuity

- **Task**: `007_work-aware-runtime-update`
- **Role**: Executor
- **Reference**: [.handoff/007_work-aware-runtime-update/FIX_06.md](file:///.handoff/007_work-aware-runtime-update/FIX_06.md)
- **Branch**: `feat/fix03-mobile-proxy-bootstrap`
- **Status**: Implemented, verified, ready for Reviewer review

---

## 1. Executive Summary

In response to Reviewer Codex's `FIX_06.md` (which demonstrated that an unrelated accepted connection on an idle managed server B could falsely promote an alias-retargeted proxy to a helper, and required verifying an actual server upgrade restart transaction and multi-turn conversation continuity across generations), this round completes:

1. **[P1] Kernel Netlink Direct Peer Verification (`codex-runtime-manager.mjs`)**:
   - Analyzed and closed the Reviewer's independent reproduction (`.test-tmp/review007-fix05/alias-unrelated.py`): proxy connected to listener A, alias subsequently repointed to idle server B which had an accepted connection from an unrelated client.
   - Replaced procfs mtime heuristics with authoritative Linux kernel Netlink `NETLINK_INET_DIAG` (`AF_UNIX`) via `getUnixPeerMap()`, directly querying the kernel for the exact connected peer socket inode of each Unix domain socket.
   - Replaced procfs directory mtime comparison with authoritative process start ticks from field 22 of `/proc/<pid>/stat` (`BigInt(ownerStart) > BigInt(proxyStart)`).
   - Enforced direct peer verification: a proxy process is admitted as a candidate server's helper IF AND ONLY IF at least one open socket inode of the proxy maps directly in the kernel peer map to an open socket inode held by that candidate server (`isDirectPeer`).
   - Maintained fail-closed security: if socket inspection fails, if Netlink query fails, or if no candidate server holds the peer socket, the proxy is classified as `kind: "unknown"` (`orphanProxy: true`), preventing update admission.
   - **Reviewer reproduction result**: changed from `helpers: 1, unknown: 0, canApply: true` to `helpers: 0, unknown: 1, canApply: false`.
   - Added formal regression test `test_proxy_target_alias_retargeted_with_unrelated_accepted_connection_held_unknown` to `tests/test_codex_update_contract.py`.

2. **[P1] Real Server Upgrade Restart Transaction & Cross-Generation Turn Continuity (`tests/test_codex_wrapper_proxy.py`, `codex-runtime-manager.mjs`, `codex-server-transaction.mjs`)**:
   - Refined `inspectAppServer`: enabled managed app servers (`options.isManaged === true`) with idle loaded threads to be admitted for restart updates (`managedIdleServers`), while preserving fail-closed behavior for unhosted/unmanaged app servers with loaded threads.
   - Refined `serverEnvironment()` in `codex-server-transaction.mjs`: inherits `process.env.CODEX_HOME` and `HOME` if present, ensuring test isolation environments function correctly.
   - Implemented `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity` in `tests/test_codex_wrapper_proxy.py`:
     1. Starts Server 1 with official binary `0.162.1` (`task007-baseline`).
     2. Connects Proxy 1, performs HTTP Upgrade (101), sends `initialize`, creates thread `th_id`.
     3. Executes Turn 1 (`turn/start`), mock provider holds response; `inspectAllSessions()` detects `core.turns.active = 1`, confirms `canApply: false`, `counts.helpers: 1`.
     4. Releases Turn 1 response, observes `turn/completed`, closes Proxy 1 cleanly.
     5. Verifies idle server state: `inspectAllSessions()` returns `canApply: true`, `counts.managedIdleServers: 1`.
     6. Executes the actual `restartServers` updater transaction upgrading Server 1 to candidate `0.166.0` (`resume-166`):
        - Server 1 receives `SIGHUP`, drains, and terminates cleanly (exit code 0).
        - Symlink `current` switches from `0.162.1` to `0.166.0`.
        - Server 2 is launched with candidate binary `0.166.0`, passes readiness checks, and is registered with new PID (new PID != old PID, version `0.166.0`).
     7. Connects Proxy 2 to Server 2, performs HTTP Upgrade (101), sends `initialize`.
     8. Calls `thread/resume` on the existing `th_id` -> Server 2 restores the persistent thread from storage.
     9. Executes Turn 2 (`turn/start` with `"Hello second turn after update"`).
     10. Mock provider receives 2nd request; asserts that request 2 contains the FULL accumulated conversation history (`"Hello first turn"`, `"Answer 1"`, and `"Hello second turn after update"`).
     11. Mock provider releases Turn 2 response, client receives `turn/completed`, Proxy 2 exits cleanly via EOF.
   - Updated `test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection` to match actual binary version metadata (`0.166.0` vs `0.162.1`).

3. **Release & Scope Compliance**:
   - Retained version `0.7.3-dev.5`.
   - No git tags, no push to remote, no DEV release deployed (Reviewer held release).

---

## 2. Changes by File

### 2.1 `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
- Added `getUnixPeerMap()`:
  - Queries Linux kernel Netlink `NETLINK_INET_DIAG` (family `AF_UNIX`, `SOCK_DIAG_BY_FAMILY`, `UDIAG_SHOW_PEER`) using standard `socket` and `struct` via python3 child process.
  - Returns a mapping `{ [socketInode]: peerSocketInode }` directly from the kernel.
- In `classifyProcesses`:
  - Collects open socket inodes for candidate proxy from `/proc/${pid}/fd`.
  - Replaced procfs mtime heuristic with `BigInt(ownerStartTicks) > BigInt(proxyStartTicks)` using `/proc/<pid>/stat` field 22.
  - Checks if candidate owner process holds the exact peer socket: `isDirectPeer = proxySocketInodes.some(sock => ownerSocketInodes.has(peerMap[sock]))`.
  - Fails closed as `kind: "unknown"` (`orphanProxy: true`) if proxy has no socket FDs, if Netlink query fails, or if candidate owner does not hold the peer socket.
- In `inspectAppServer`:
  - Added `options.isManaged` handling: allows managed app servers with idle loaded conversations to be considered restartable, while preserving the protection for unmanaged/unhosted app servers.

### 2.2 `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs`
- In `serverEnvironment()`:
  - Uses `process.env.HOME || '/data/home'` and `process.env.CODEX_HOME || '/data/codex'`, allowing test environments to provide custom config and storage paths during server launch.

### 2.3 `tests/test_codex_update_contract.py`
- Added `test_proxy_target_alias_retargeted_with_unrelated_accepted_connection_held_unknown`:
  - Models the Reviewer's exact scenario (`.test-tmp/review007-fix05/alias-unrelated.py`): Server B has an active accepted connection from an unrelated client, while proxy is connected to listener A. When alias is retargeted to B, asserts that proxy is held as `kind: "unknown"` and `canApply` is `False`.

### 2.4 `tests/test_codex_wrapper_proxy.py`
- Fixed launch record version metadata in `test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection` to match tested binary (`0.166.0` vs `0.162.1`).
- Added `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity`:
  - Tests the complete lifecycle: Turn 1 active hold, idle state recovery, real `restartServers` execution upgrading `0.162.1` to `0.166.0`, Proxy reconnect, `thread/resume`, Turn 2 dispatch, conversation context accumulation, and clean termination.

---

## 3. Verification & Evidence

### 3.1 Reviewer's Independent Reproduction Results
- **Script**: `.test-tmp/review007-fix05/alias-unrelated.py`
  - **Before Fix**: `{"proxy_connected_to": "A", "alias_now_points_to": "B", "helpers": 1, "unknown": 0, "canApply": true}`
  - **After Fix**: `{"proxy_connected_to": "A", "alias_now_points_to": "B", "helpers": 0, "unknown": 1, "canApply": false}`
- **Script**: `.test-tmp/review007-fix04/alias-owner.py`
  - **Result**: `{"proxy_connected_to": "A", "alias_now_points_to": "B", "helpers": 0, "unknown": 1, "canApply": false}`

### 3.2 Automated Test Execution
| Test Suite | Commands | Result | Time |
|---|---|---|---|
| Remote Setup Tests | `.venv/bin/python -m pytest -v tests/test_remote_setup.py` | 12 passed | 0.76s |
| Wrapper Proxy Tests | `.venv/bin/python -m pytest -v tests/test_codex_wrapper_proxy.py` | 8 passed | 8.06s |
| Update Contract Tests | `.venv/bin/python -m pytest -v tests/test_codex_update_contract.py` | 130 passed | 105.92s |
| Core Add-on & Token Tests | `.venv/bin/python -m pytest -v tests/test_addon_contract.py tests/test_token_boundary.py` | 27 passed | 0.40s |
| Total Pytest | Full run across modified areas | **150 passed** | ~115s |
| Node Syntax Check | `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs` | PASS | 0.1s |
| Git Diff Check | `git diff --check` | Clean (0 warnings) | 0.0s |
| Docker Build | `docker build -t codex-ha:test-fix06 codex_home_assistant` | SUCCESS | 4.9s |
| Mobile SSH Smoke | `IMAGE_NAME=codex-ha:test-fix06 .venv/bin/python tests/mobile-ssh-smoke.py` | PASS | 9.0s |

---

## 4. Verification Gaps (Honest Disclosure)

| Item | Status | Notes |
|---|---|---|
| Kernel Netlink peer verification & unrelated connection isolation | **PASS** | Verified via unit tests and Reviewer's independent reproductions |
| Real server upgrade transaction (0.162.1 -> 0.166.0) | **PASS** | Verified via `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity` |
| Cross-generation thread resumption & multi-turn history continuity | **PASS** | Verified Turn 2 received full Turn 1 history on upgraded server |
| Container build & Mobile SSH S6 smoke test | **PASS** | Tested on `codex-ha:test-fix06` image |
| Version bump & DEV release publish | **NOT RUN** | Held pending Reviewer approval per FIX_06 instructions |
| Real physical HAOS device installation | **NOT RUN** | Target remains isolated dev branch; production HAOS untouched |
| Real physical ARM64 hardware execution | **NOT RUN** | Validated on x86_64 host; multiarch Docker builds rely on QEMU/builder |
