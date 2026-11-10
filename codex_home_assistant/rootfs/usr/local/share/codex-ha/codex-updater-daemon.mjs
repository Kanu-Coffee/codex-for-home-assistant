import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  applyUpdate,
  appendHistoryRecord,
  checkUpdate,
  getCurrentSlotInfo,
  getNow,
  initRuntime,
  loadState,
  readOptions,
  reconcileDailyBudget,
  reconcileLegacyPausedState,
  updateState,
  MAX_IDLE_CHECKS,
  MAX_LOW_FREQUENCY_CHECKS,
} from "./codex-runtime-manager.mjs";

delete process.env.SUPERVISOR_TOKEN;

let isRunning = true;
const PENDING_RETRY_INTERVAL_MS = 300 * 1000; // 5 minutes
let wakeSleep = null;
let activeAbortController = null;
let testSleepHook = null;
let testPolicyProbe = null;
let testCheckOptions = null;
let testCheckHook = null;

export function setTestSleepHook(hook) {
  testSleepHook = hook;
}

export function setTestPolicyProbe(probe) {
  testPolicyProbe = probe;
}

export function setTestCheckOptions(opts) {
  testCheckOptions = opts;
}

export function setTestCheckHook(hook) {
  testCheckHook = hook;
}

// Between slot checks the loop can sleep up to an hour. A pending signal must
// shorten that wait instead of only flipping a flag the sleeping process will
// observe up to 3600s later, which made every stop escalate to SIGKILL.
function sleepBeforeNextPass(ms) {
  if (typeof testSleepHook === "function") {
    return testSleepHook(ms);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    wakeSleep = null;
  });
}

function log(event, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  console.log(JSON.stringify(payload));
}

export async function loop() {
  log("updater_started");

  try {
    await initRuntime();
  } catch (err) {
    log("init_error", { error: err.message });
  }

  while (isRunning) {
    let sleepMs = 60 * 1000;

    try {
      const options = await readOptions();
      if (!options.valid) {
        log("options_invalid", { error: options.error });
        await updateState((s) => {
          s.status = "blocked_options";
          s.reason = `Add-on options invalid: ${options.error}`;
        });
        sleepMs = 60 * 1000;
      } else if (!options.autoUpdate) {
        log("auto_update_disabled");
        const nextSlot = getCurrentSlotInfo(getNow(), options.timezone);
        sleepMs = Math.min(nextSlot.msUntilNextSlot, 3600 * 1000);
      } else {
        const slotInfo = getCurrentSlotInfo(getNow(), options.timezone);
        let state = await loadState();

        // Automatic migration for 0.7.3 paused state lacking nextLowFrequencyRetryAt
        if (
          state.status === "paused_busy" &&
          state.stagedVersion &&
          !state.blockedReason &&
          (state.idleCheckCount || 0) >= MAX_IDLE_CHECKS &&
          (state.lowFrequencyCheckCount || 0) < MAX_LOW_FREQUENCY_CHECKS &&
          !state.nextLowFrequencyRetryAt
        ) {
          state = await reconcileLegacyPausedState();
        }

        // Automatic recovery on genuine date rollover while daemon runs continuously
        await updateState((s) => {
          reconcileDailyBudget(s, options.timezone, "scheduled", getNow());
        });

        if (state.lastCheckSlot !== slotInfo.slotKey) {
          log("slot_check_start", {
            slot: slotInfo.slotKey,
            timezone: slotInfo.timezone,
          });

          activeAbortController = new AbortController();
          try {
            const checkRes = testCheckHook
              ? await testCheckHook(slotInfo, activeAbortController.signal)
              : await checkUpdate(null, {
                  slotKey: slotInfo.slotKey,
                  signal: activeAbortController.signal,
                  ...(testCheckOptions || {}),
                });

            if (!checkRes.upToDate && !checkRes.blocked && !checkRes.paused) {
              log("update_staged", {
                staged: checkRes.stagedVersion,
                current: checkRes.currentVersion,
              });

              const applyRes = await applyUpdate({
                signal: activeAbortController.signal,
                policyProbe: testPolicyProbe || undefined,
              });
              if (applyRes.applied) {
                log("update_applied", { version: applyRes.version });
              } else {
                log("apply_deferred", {
                  reason: applyRes.reason,
                  busy: applyRes.busyReasons,
                });
              }
            } else if (checkRes.blocked) {
              log("update_blocked", { reason: checkRes.blockedReason });
            } else if (checkRes.paused) {
              log("update_paused", { reason: "daily_idle_budget_exhausted" });
            } else {
              log("up_to_date", { current: checkRes.currentVersion });
            }
          } catch (err) {
            log("check_error", { error: err.message });
            if (isRunning) {
              await updateState((s) => {
                s.lastError = err.message;
                s.lastCheckSlot = slotInfo.slotKey; // prevent tight loop failure
              });
            }
          } finally {
            activeAbortController = null;
          }
        } else if (state.stagedVersion && !state.blockedReason && state.status !== "paused_busy") {
          log("pending_apply_check");
          activeAbortController = new AbortController();
          try {
            const applyRes = await applyUpdate({
              signal: activeAbortController.signal,
              policyProbe: testPolicyProbe || undefined,
            });
            if (applyRes.applied) {
              log("update_applied", { version: applyRes.version });
            } else {
              log("apply_deferred", {
                reason: applyRes.reason,
                busy: applyRes.busyReasons,
              });
            }
          } catch (err) {
            log("apply_error", { error: err.message });
          } finally {
            activeAbortController = null;
          }
        } else if (
          state.stagedVersion &&
          !state.blockedReason &&
          state.status === "paused_busy" &&
          (state.lowFrequencyCheckCount || 0) < MAX_LOW_FREQUENCY_CHECKS &&
          state.nextLowFrequencyRetryAt &&
          getNow().getTime() >= new Date(state.nextLowFrequencyRetryAt).getTime()
        ) {
          log("low_frequency_apply_check", {
            attempt: (state.lowFrequencyCheckCount || 0) + 1,
            maxAttempts: MAX_LOW_FREQUENCY_CHECKS,
          });
          activeAbortController = new AbortController();
          try {
            const applyRes = await applyUpdate({
              isLowFrequency: true,
              signal: activeAbortController.signal,
              policyProbe: testPolicyProbe || undefined,
            });
            if (applyRes.applied) {
              log("update_applied", { version: applyRes.version });
            } else {
              log("low_frequency_deferred", {
                reason: applyRes.reason,
                busy: applyRes.busyReasons,
              });
            }
          } catch (err) {
            log("low_frequency_error", { error: err.message });
          } finally {
            activeAbortController = null;
          }
        }
      }

      const refreshedState = await loadState();
      const nextSlot = getCurrentSlotInfo(getNow(), options.timezone);
      const defaultSlotSleep = Math.min(nextSlot.msUntilNextSlot, 3600 * 1000);

      if (refreshedState.stagedVersion && !refreshedState.blockedReason && refreshedState.status !== "paused_busy") {
        sleepMs = Math.min(PENDING_RETRY_INTERVAL_MS, defaultSlotSleep);
      } else if (
        refreshedState.stagedVersion &&
        !refreshedState.blockedReason &&
        refreshedState.status === "paused_busy" &&
        (refreshedState.lowFrequencyCheckCount || 0) < MAX_LOW_FREQUENCY_CHECKS &&
        refreshedState.nextLowFrequencyRetryAt
      ) {
        const msUntilLowFreq = new Date(refreshedState.nextLowFrequencyRetryAt).getTime() - getNow().getTime();
        const lowFreqSleep = msUntilLowFreq > 0 ? msUntilLowFreq : 5000;
        // Never miss the 03:00 rollover slot check while sleeping for low-frequency retry
        sleepMs = Math.min(lowFreqSleep, defaultSlotSleep);
      } else {
        sleepMs = defaultSlotSleep;
        if (refreshedState.nextRetryAt) {
          const msUntilRetry = new Date(refreshedState.nextRetryAt).getTime() - getNow().getTime();
          if (msUntilRetry > 0) {
            sleepMs = Math.min(sleepMs, msUntilRetry);
          }
        }
      }
    } catch (err) {
      log("loop_error", { error: err.message });
      sleepMs = 60 * 1000;
    }

    if (!isRunning) break;
    await sleepBeforeNextPass(Math.max(5000, sleepMs));
  }

  log("updater_stopped");
}

export function stopOnSignal() {
  isRunning = false;
  if (activeAbortController) {
    activeAbortController.abort();
  }
  if (wakeSleep) wakeSleep();
}

process.on("SIGTERM", stopOnSignal);
process.on("SIGINT", stopOnSignal);

export { isRunning };

if (!process.env.CODEX_TEST_DAEMON_NO_AUTO_START) {
  loop();
}
