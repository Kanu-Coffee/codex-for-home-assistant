import {
  applyUpdate,
  checkUpdate,
  getCurrentSlotInfo,
  getNow,
  initRuntime,
  loadState,
  readOptions,
  updateState,
} from "./codex-runtime-manager.mjs";

delete process.env.SUPERVISOR_TOKEN;

let isRunning = true;
const PENDING_RETRY_INTERVAL_MS = 300 * 1000; // 5 minutes
let wakeSleep = null;
let activeAbortController = null;

// Between slot checks the loop can sleep up to an hour. A pending signal must
// shorten that wait instead of only flipping a flag the sleeping process will
// observe up to 3600s later, which made every stop escalate to SIGKILL.
function sleepBeforeNextPass(ms) {
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

async function loop() {
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
        const state = await loadState();

        // Automatic recovery on date rollover while daemon runs continuously
        if (state.budgetDate && state.budgetDate !== slotInfo.slotDate) {
          await updateState((s) => {
            s.budgetDate = slotInfo.slotDate;
            s.idleCheckCount = 0;
            if (s.status === "paused_busy") {
              s.status = "ready_to_apply";
              s.reason = "New day budget initialized; resuming candidate apply";
            }
          });
        }

        if (state.lastCheckSlot !== slotInfo.slotKey) {
          log("slot_check_start", {
            slot: slotInfo.slotKey,
            timezone: slotInfo.timezone,
          });

          activeAbortController = new AbortController();
          try {
            const checkRes = await checkUpdate(null, {
              slotKey: slotInfo.slotKey,
              signal: activeAbortController.signal,
            });

            if (!checkRes.upToDate && !checkRes.blocked && !checkRes.paused) {
              log("update_staged", {
                staged: checkRes.stagedVersion,
                current: checkRes.currentVersion,
              });

              const applyRes = await applyUpdate({ signal: activeAbortController.signal });
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
            const applyRes = await applyUpdate({ signal: activeAbortController.signal });
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
        }
      }

      const refreshedState = await loadState();
      if (refreshedState.stagedVersion && !refreshedState.blockedReason && refreshedState.status !== "paused_busy") {
        sleepMs = PENDING_RETRY_INTERVAL_MS;
      } else {
        const nextSlot = getCurrentSlotInfo(getNow(), options.timezone);
        sleepMs = Math.min(nextSlot.msUntilNextSlot, 3600 * 1000);
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

function stopOnSignal() {
  isRunning = false;
  if (activeAbortController) {
    activeAbortController.abort();
  }
  if (wakeSleep) wakeSleep();
}

process.on("SIGTERM", stopOnSignal);
process.on("SIGINT", stopOnSignal);

loop();
