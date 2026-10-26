import { verifyManagedPolicy } from './codex-policy-probe.mjs';
import { restartServers } from './codex-server-transaction.mjs';
import { packageInventory, recordPackage, verifyPackage, durableJson } from './codex-package-integrity.mjs';
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

export const BASELINE_VERSION = "0.162.1";
export const APP_VERSION = "0.7.2";
export const DEFAULT_TIMEZONE = "Asia/Seoul";
export const UPDATE_SLOTS = [3, 9, 15, 21];
export const MAX_IDLE_CHECKS = 12;
export const MAX_RESTART_ATTEMPTS = 1;

export function getBaseRuntimeDir() { return process.env.CODEX_RUNTIME_DIR || "/data/codex-runtime"; }
export function getBaselineDir() { return process.env.CODEX_BASELINE_DIR || "/usr/local/lib/codex-ha/codex-baseline"; }
export function getMaintenanceDir() { return process.env.CODEX_MAINTENANCE_DIR || "/run/codex-ha/codex-maintenance"; }
export function getOptionsPath() { return process.env.CODEX_HA_OPTIONS_FILE || "/data/options.json"; }
export function getReleasesDir() { return join(getBaseRuntimeDir(), "releases"); }
export function getStagingDir() { return join(getBaseRuntimeDir(), "staging"); }
export function getCurrentLink() { return join(getBaseRuntimeDir(), "current"); }
export function getPreviousLink() { return join(getBaseRuntimeDir(), "previous"); }
export function getStagedLink() { return join(getBaseRuntimeDir(), "staged"); }
export function getStateFile() { return join(getBaseRuntimeDir(), "state.json"); }
export function getGateLockFile() { return join(getMaintenanceDir(), "gate.lock"); }
export function getSessionsDir() { return join(getMaintenanceDir(), "sessions"); }

export function getAppVersion() {
  const bakedPath = process.env.CODEX_HA_APP_VERSION_FILE || "/usr/local/share/codex-ha/app-version";
  try {
    if (existsSync(bakedPath)) {
      const v = readFileSync(bakedPath, "utf-8").trim();
      if (v) return v;
    }
  } catch {}
  return APP_VERSION;
}

export function getBundledVersion() {
  const manifestPath = join(getBaselineDir(), "codex-package.json");
  try {
    if (existsSync(manifestPath)) {
      const data = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (data.version) return data.version;
    }
  } catch {}
  return BASELINE_VERSION;
}

const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const DOWNLOAD_TIMEOUT_MS = 600 * 1000;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function parseSemver(v) {
  if (typeof v !== "string") return null;
  const match = v.trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function getNow() {
  if (process.env.CODEX_TEST_CLOCK) {
    const t = new Date(process.env.CODEX_TEST_CLOCK).getTime();
    if (!isNaN(t)) return new Date(t);
  }
  return new Date();
}

export function zonedDateTimeToUtc(year, month, day, hour, minute, second, tz) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const m = {};
    for (const p of parts) m[p.type] = parseInt(p.value, 10);
    const asLocalMs = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = targetMs - asLocalMs;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function shiftCalendarDate(year, month, day, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function getNextDayFirstSlotTime(now = getNow(), timezone = DEFAULT_TIMEZONE) {
  const tz = isValidTimezone(timezone) ? timezone.trim() : DEFAULT_TIMEZONE;
  const slotInfo = getCurrentSlotInfo(now, tz);
  const [sYear, sMonth, sDay] = slotInfo.slotDate.split("-").map(Number);
  const nextDate = shiftCalendarDate(sYear, sMonth, sDay, 1);
  return zonedDateTimeToUtc(nextDate.year, nextDate.month, nextDate.day, 3, 0, 0, tz);
}

export function resolveTargetArchitecture(machine) {
  const m = machine || process.arch;
  if (m === "x64" || m === "x86_64") return "x86_64-unknown-linux-musl";
  if (m === "arm64" || m === "aarch64") return "aarch64-unknown-linux-musl";
  throw new Error(`Unsupported architecture: ${m}`);
}

export function getCurrentSlotInfo(date = getNow(), timezone = DEFAULT_TIMEZONE) {
  const tz = isValidTimezone(timezone) ? timezone.trim() : DEFAULT_TIMEZONE;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  const hour = parseInt(map.hour, 10);

  let activeSlotHour;
  let slotYear = year;
  let slotMonth = month;
  let slotDay = day;

  if (hour >= 21) {
    activeSlotHour = 21;
  } else if (hour >= 15) {
    activeSlotHour = 15;
  } else if (hour >= 9) {
    activeSlotHour = 9;
  } else if (hour >= 3) {
    activeSlotHour = 3;
  } else {
    activeSlotHour = 21;
    const prevDate = shiftCalendarDate(year, month, day, -1);
    slotYear = prevDate.year;
    slotMonth = prevDate.month;
    slotDay = prevDate.day;
  }

  const slotDate = `${slotYear}-${String(slotMonth).padStart(2, "0")}-${String(slotDay).padStart(2, "0")}`;
  const slotKey = `${slotDate}T${String(activeSlotHour).padStart(2, "0")}:00`;

  let nextSlotHour;
  let nextSlotYear = year;
  let nextSlotMonth = month;
  let nextSlotDay = day;

  if (hour < 3) {
    nextSlotHour = 3;
  } else if (hour < 9) {
    nextSlotHour = 9;
  } else if (hour < 15) {
    nextSlotHour = 15;
  } else if (hour < 21) {
    nextSlotHour = 21;
  } else {
    nextSlotHour = 3;
    const nextDate = shiftCalendarDate(year, month, day, 1);
    nextSlotYear = nextDate.year;
    nextSlotMonth = nextDate.month;
    nextSlotDay = nextDate.day;
  }

  const nextSlotUtc = zonedDateTimeToUtc(nextSlotYear, nextSlotMonth, nextSlotDay, nextSlotHour, 0, 0, tz);
  const msUntilNextSlot = Math.max(1000, nextSlotUtc.getTime() - date.getTime());

  return {
    timezone: tz,
    activeSlotHour,
    slotKey,
    slotDate,
    nextSlotTime: nextSlotUtc,
    msUntilNextSlot,
  };
}

export function isCanonicalRuntimePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const res = resolve(targetPath);
  const baselineCanonical = resolve(getBaselineDir());
  const releasesCanonical = resolve(getReleasesDir());

  if (res === baselineCanonical) return true;
  if (res.startsWith(releasesCanonical + "/")) {
    const rel = res.slice(releasesCanonical.length + 1);
    if (!rel.includes("..") && !rel.startsWith("/")) return true;
  }
  return false;
}

export function isAllowedPackageRoot(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const res = resolve(targetPath);
  if (isCanonicalRuntimePath(res)) return true;
  const stagingCanonical = resolve(getStagingDir());
  if (res.startsWith(stagingCanonical + "/") && !res.includes("/..")) return true;
  return false;
}

export async function validateCandidatePackageTree(packageDir, options = {}) {
  try {
    if (!packageDir || typeof packageDir !== "string") {
      return { valid: false, error: "Package directory is null or empty" };
    }
    const resolvedPkg = resolve(packageDir);
    if (!options.allowAnyRoot && !isAllowedPackageRoot(resolvedPkg)) {
      return { valid: false, error: "Package path is not canonical releases, baseline, or staging root" };
    }
    if (!existsSync(resolvedPkg)) {
      return { valid: false, error: "Package directory does not exist: " + resolvedPkg };
    }

    const pkgStat = await lstat(resolvedPkg);
    if (!pkgStat.isDirectory() && !pkgStat.isSymbolicLink()) {
      return { valid: false, error: "Package path is neither directory nor symlink" };
    }

    // Recursive walk
    async function walk(currentDir) {
      const entries = await readdir(currentDir);
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const st = await lstat(fullPath);

        if (st.isBlockDevice() || st.isCharacterDevice() || st.isFIFO() || st.isSocket()) {
          return { valid: false, error: `Unsafe special file in package: ${entry}` };
        }

        if (!st.isDirectory() && !st.isSymbolicLink() && st.nlink > 1) {
          return { valid: false, error: `Unsafe hardlink in package: ${entry} (nlink=${st.nlink})` };
        }

        if ((st.mode & 0o6000) !== 0) {
          return { valid: false, error: `Unsafe setuid/setgid permissions in package: ${entry}` };
        }

        if (st.isSymbolicLink()) {
          const rawTarget = await readlink(fullPath);
          const resolvedTarget = resolve(currentDir, rawTarget);
          if (!resolvedTarget.startsWith(resolvedPkg + "/") && resolvedTarget !== resolvedPkg) {
            return { valid: false, error: `Escaping symlink in package: ${entry} -> ${rawTarget}` };
          }
          if (existsSync(resolvedTarget)) {
            const real = await realpath(resolvedTarget);
            if (!real.startsWith(resolvedPkg + "/") && real !== resolvedPkg) {
              return { valid: false, error: `Symlink target realpath escapes package: ${entry} -> ${real}` };
            }
          }
        } else if (st.isDirectory()) {
          const sub = await walk(fullPath);
          if (!sub.valid) return sub;
        }
      }
      return { valid: true };
    }

    const walkRes = await walk(resolvedPkg);
    if (!walkRes.valid) return walkRes;

    // Check bin/codex
    const binCodex = join(resolvedPkg, "bin/codex");
    if (!existsSync(binCodex)) {
      return { valid: false, error: "Package is missing bin/codex executable" };
    }
    const binStat = await lstat(binCodex);
    if (!binStat.isSymbolicLink() && binStat.nlink > 1) {
      return { valid: false, error: `bin/codex has unsafe hardlink (nlink=${binStat.nlink})` };
    }
    if (binStat.isSymbolicLink()) {
      const rawTarget = await readlink(binCodex);
      const resolvedTarget = resolve(join(resolvedPkg, "bin"), rawTarget);
      if (!resolvedTarget.startsWith(resolvedPkg + "/") && resolvedTarget !== resolvedPkg) {
        return { valid: false, error: `bin/codex is an escaping symlink: ${rawTarget}` };
      }
      const real = await realpath(binCodex);
      if (!real.startsWith(resolvedPkg + "/") && real !== resolvedPkg) {
        return { valid: false, error: `bin/codex realpath escapes package: ${real}` };
      }
    }
    const realBinStat = await stat(binCodex);
    if ((realBinStat.mode & 0o111) === 0) {
      return { valid: false, error: "bin/codex is not executable" };
    }

    // Check codex-package.json
    const manifestPath = join(resolvedPkg, "codex-package.json");
    if (!existsSync(manifestPath)) {
      return { valid: false, error: "Package is missing codex-package.json manifest" };
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      if (!manifest.version || !manifest.target || manifest.entrypoint !== "bin/codex") {
        return { valid: false, error: "codex-package.json has invalid schema or entrypoint" };
      }
      if (options.expectedVersion && manifest.version !== options.expectedVersion) {
        return { valid: false, error: `Manifest version mismatch: expected ${options.expectedVersion}, got ${manifest.version}` };
      }
      if (options.expectedTarget && manifest.target !== options.expectedTarget) {
        return { valid: false, error: `Manifest target mismatch: expected ${options.expectedTarget}, got ${manifest.target}` };
      }
    } catch (e) {
      return { valid: false, error: "codex-package.json is malformed JSON: " + e.message };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export async function validateSymlinkContainment(linkPath) {
  try {
    const rawTarget = await readlink(linkPath);
    const resolvedTarget = resolve(dirname(linkPath), rawTarget);
    if (!isCanonicalRuntimePath(resolvedTarget)) {
      return { valid: false, target: resolvedTarget, error: "Link points outside canonical releases or baseline" };
    }
    if (existsSync(resolvedTarget)) {
      const real = await realpath(resolvedTarget);
      if (!isCanonicalRuntimePath(real)) {
        return { valid: false, target: real, error: "Realpath escapes canonical releases or baseline" };
      }
      const treeCheck = await validateCandidatePackageTree(resolvedTarget);
      if (!treeCheck.valid) {
        return { valid: false, target: resolvedTarget, error: treeCheck.error };
      }
      if (resolve(resolvedTarget) !== resolve(getBaselineDir())) {
        const integrity = await verifyPackage(resolvedTarget, getBaseRuntimeDir());
        if (!integrity.valid) return { valid: false, target: resolvedTarget, error: integrity.error };
      }
    }
    return { valid: true, target: resolvedTarget };
  } catch (err) {
    return { valid: false, target: null, error: err.message };
  }
}

export async function withGateLock(mode = "exclusive", timeoutSec = 15, fn = async () => {}) {
  await mkdir(getMaintenanceDir(), { recursive: true, mode: 0o700 });
  const lockFile = getGateLockFile();

  let flockAvailable = true;
  try {
    const probe = spawnSync("flock", ["--help"], { stdio: "ignore" });
    if (probe.error || (probe.status !== 0 && probe.status !== 1)) flockAvailable = false;
  } catch {
    flockAvailable = false;
  }

  if (!flockAvailable) {
    throw new Error("flock utility is not available; gate lock acquisition failed");
  }

  const flag = mode === "shared" ? "-s" : "-x";
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("flock", [flag, lockFile, "sh", "-c", "echo LOCKED; read line"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let acquired = false;
    let errOutput = "";

    const timer = setTimeout(() => {
      if (!acquired) {
        proc.kill("SIGTERM");
        rejectPromise(new Error(`Timeout acquiring ${mode} gate lock after ${timeoutSec}s`));
      }
    }, timeoutSec * 1000);

    proc.stdout.on("data", async (chunk) => {
      if (chunk.toString().includes("LOCKED") && !acquired) {
        acquired = true;
        clearTimeout(timer);
        try {
          const result = await fn();
          try { proc.stdin.end(); } catch {}
          proc.kill("SIGTERM");
          resolvePromise(result);
        } catch (err) {
          try { proc.stdin.end(); } catch {}
          proc.kill("SIGTERM");
          rejectPromise(err);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      errOutput += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!acquired) rejectPromise(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!acquired) {
        rejectPromise(new Error(`Failed to acquire ${mode} gate lock (exit ${code}): ${errOutput.trim()}`));
      }
    });
  });
}

export async function readOptions() {
  const optionsPath = getOptionsPath();
  try {
    const st = await lstat(optionsPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1048576) {
      return {
        autoUpdate: false,
        timezone: DEFAULT_TIMEZONE,
        valid: false,
        error: "Options file is not a regular file or exceeds size limit",
      };
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        autoUpdate: true,
        timezone: DEFAULT_TIMEZONE,
        valid: true,
      };
    }
    return {
      autoUpdate: false,
      timezone: DEFAULT_TIMEZONE,
      valid: false,
      error: `Options file inaccessible: ${err.message}`,
    };
  }

  try {
    const content = await readFile(optionsPath, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return {
        autoUpdate: false,
        timezone: DEFAULT_TIMEZONE,
        valid: false,
        error: `Options JSON parse error: ${e.message}`,
      };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        autoUpdate: false,
        timezone: DEFAULT_TIMEZONE,
        valid: false,
        error: "Options root must be a JSON object",
      };
    }

    if (parsed.codex_auto_update !== undefined && typeof parsed.codex_auto_update !== "boolean") {
      return {
        autoUpdate: false,
        timezone: DEFAULT_TIMEZONE,
        valid: false,
        error: "Invalid option type: codex_auto_update must be boolean",
      };
    }

    let tz = DEFAULT_TIMEZONE;
    if (parsed.codex_auto_update_timezone !== undefined) {
      if (typeof parsed.codex_auto_update_timezone !== "string" || !isValidTimezone(parsed.codex_auto_update_timezone)) {
        return {
          autoUpdate: false,
          timezone: DEFAULT_TIMEZONE,
          valid: false,
          error: `Invalid option value: codex_auto_update_timezone '${parsed.codex_auto_update_timezone}' is not a valid IANA timezone`,
        };
      }
      tz = parsed.codex_auto_update_timezone.trim();
    }

    return {
      autoUpdate: parsed.codex_auto_update !== false,
      timezone: tz,
      valid: true,
    };
  } catch (err) {
    return {
      autoUpdate: false,
      timezone: DEFAULT_TIMEZONE,
      valid: false,
      error: `Could not read options file: ${err.message}`,
    };
  }
}

export const LAST_BLOCKER_CODES = Object.freeze([
  "cli", "remote_stdio", "unmanaged_server", "bad_socket", "socket_inaccessible",
  "server_busy", "unknown", "inspection_failed", "daily_budget_exhausted",
  "restart_cooldown",
]);

function sanitizeLastBlocker(value) {
  return typeof value === "string" && LAST_BLOCKER_CODES.includes(value) ? value : null;
}

export async function loadState() {
  const appVersion = getAppVersion();
  const bundledVersion = getBundledVersion();
  try {
    const stateFile = getStateFile();
    const st = await lstat(stateFile);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1048576) {
      throw new Error("State file is not a regular file or exceeds size limit");
    }
    const raw = await readFile(stateFile, "utf-8");
    const data = JSON.parse(raw);
    return {
      appVersion,
      bundledVersion,
      selectedDigest: data.selectedDigest || null,
      selectedVersion: typeof data.selectedVersion === "string" ? data.selectedVersion : null,
      stagedVersion: data.stagedVersion || null,
      candidateVersion: data.candidateVersion || null,
      candidateDigest: data.candidateDigest || null,
      budgetDate: data.budgetDate || null,
      idleCheckCount: typeof data.idleCheckCount === "number" ? data.idleCheckCount : 0,
      restartAttemptCount: typeof data.restartAttemptCount === "number" ? data.restartAttemptCount : 0,
      lastRestartAt: data.lastRestartAt || null,
      nextRestartAllowedAt: data.nextRestartAllowedAt || null,
      nextRetryAt: data.nextRetryAt || null,
      blockedReason: data.blockedReason || null,
      lastCheckAt: data.lastCheckAt || null,
      lastCheckSlot: data.lastCheckSlot || null,
      lastApplyAt: data.lastApplyAt || null,
      status: data.status || "idle",
      reason: data.reason || null,
      lastError: data.lastError || null,
      lastBlocker: sanitizeLastBlocker(data.lastBlocker),
    };
  } catch {
    return {
      appVersion,
      bundledVersion,
      selectedDigest: null,
      selectedVersion: null,
      stagedVersion: null,
      candidateVersion: null,
      candidateDigest: null,
      budgetDate: null,
      idleCheckCount: 0,
      restartAttemptCount: 0,
      lastRestartAt: null,
      nextRestartAllowedAt: null,
      nextRetryAt: null,
      blockedReason: null,
      lastCheckAt: null,
      lastCheckSlot: null,
      lastApplyAt: null,
      status: "idle",
      reason: null,
      lastError: null,
      lastBlocker: null,
    };
  }
}

export async function saveState(state) {
  await mkdir(getBaseRuntimeDir(), { recursive: true, mode: 0o700 });
  const appVersion = getAppVersion();
  const bundledVersion = getBundledVersion();
  const sanitized = {
    appVersion,
    bundledVersion,
    selectedDigest: state.selectedDigest || null,
    selectedVersion: state.selectedVersion || bundledVersion,
    stagedVersion: state.stagedVersion || null,
    candidateVersion: state.candidateVersion || null,
    candidateDigest: state.candidateDigest || null,
    budgetDate: state.budgetDate || null,
    idleCheckCount: typeof state.idleCheckCount === "number" ? state.idleCheckCount : 0,
    restartAttemptCount: typeof state.restartAttemptCount === "number" ? state.restartAttemptCount : 0,
    lastRestartAt: state.lastRestartAt || null,
    nextRestartAllowedAt: state.nextRestartAllowedAt || null,
    nextRetryAt: state.nextRetryAt || null,
    blockedReason: state.blockedReason || null,
    lastCheckAt: state.lastCheckAt || null,
    lastCheckSlot: state.lastCheckSlot || null,
    lastApplyAt: state.lastApplyAt || null,
    status: state.status || "idle",
    reason: typeof state.reason === "string" ? state.reason.slice(0, 256) : null,
    lastError: typeof state.lastError === "string" ? state.lastError.slice(0, 256) : null,
    lastBlocker: sanitizeLastBlocker(state.lastBlocker),
  };
  await durableJson(getStateFile(), sanitized);
}

export async function updateState(updaterFn) {
  return withGateLock("exclusive", 15, async () => {
    const state = await loadState();
    if (typeof updaterFn === "function") {
      updaterFn(state);
    } else if (updaterFn && typeof updaterFn === "object") {
      Object.assign(state, updaterFn);
    }
    await saveState(state);
    return state;
  });
}

export async function initRuntime() {
  return withGateLock("exclusive", 15, async () => {
    await mkdir(getBaseRuntimeDir(), { recursive: true, mode: 0o700 });
    await mkdir(getReleasesDir(), { recursive: true, mode: 0o700 });
    await mkdir(getStagingDir(), { recursive: true, mode: 0o700 });
    await mkdir(getMaintenanceDir(), { recursive: true, mode: 0o700 });
    await mkdir(getSessionsDir(), { recursive: true, mode: 0o700 });

    const currentCheck = await validateSymlinkContainment(getCurrentLink());
    if (!currentCheck.valid || !existsSync(currentCheck.target)) {
      try {
        await unlink(getCurrentLink());
      } catch {}
      if (existsSync(getBaselineDir())) {
        await symlink(getBaselineDir(), getCurrentLink());
      }
    }

    const stagedCheck = await validateSymlinkContainment(getStagedLink());
    if (!stagedCheck.valid) {
      try {
        await unlink(getStagedLink());
      } catch {}
    }

    const prevCheck = await validateSymlinkContainment(getPreviousLink());
    if (!prevCheck.valid) {
      try {
        await unlink(getPreviousLink());
      } catch {}
    }

    const state = await loadState();
    let currentVersion = getBundledVersion();
    try {
      const pkgJson = JSON.parse(await readFile(join(getCurrentLink(), "codex-package.json"), "utf-8"));
      if (pkgJson.version) currentVersion = pkgJson.version;
    } catch {}

    state.selectedVersion = currentVersion;
    if (!currentCheck.valid && existsSync(getBaselineDir())) {
      state.selectedDigest = null;
      state.status = "recovered_baseline";
      state.reason = "Invalid or missing selected runtime; using image baseline";
    }
    await saveState(state);
    return state;
  });
}

// Package entrypoints that are genuine Codex task processes or owned helper
// companions. Identity is the /proc exe link or a shebang script named in the
// interpreter argv, never a substring of the command line.
export const PACKAGE_EXECUTABLE_ROLES = Object.freeze({
  "bin/codex": "primary",
  "bin/codex-code-mode-host": "companion",
  "codex-resources/bwrap": "companion",
  "codex-path/rg": "companion",
  "codex-resources/voice/bin/codex-voice-host": "companion",
  "codex-resources/zsh/bin/zsh": "companion",
});

const INTERPRETER_BASENAMES = new Set([
  "node", "deno", "bun", "env", "sh", "bash", "dash", "zsh",
  "python", "python3", "perl", "ruby",
]);

function withinCanonicalRoot(candidatePath, rootPath) {
  if (typeof candidatePath !== "string" || !candidatePath.startsWith(rootPath + "/")) return null;
  const relative = candidatePath.slice(rootPath.length + 1);
  if (!relative || relative.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  return relative;
}

// Canonical boundary test independent of the role allowlist: any path inside
// the baseline or a single release generation is a managed package path even
// when its role is not yet known.
export function packageBoundary(candidatePath) {
  if (typeof candidatePath !== "string") return null;
  const clean = candidatePath.replace(/\s+\(deleted\)$/, "");
  const baselineRelative = withinCanonicalRoot(clean, getBaselineDir());
  if (baselineRelative) {
    return {
      relative: baselineRelative,
      generation: getBaselineDir(),
      role: PACKAGE_EXECUTABLE_ROLES[baselineRelative] || null,
    };
  }
  const releasesRelative = withinCanonicalRoot(clean, getReleasesDir());
  if (releasesRelative) {
    const segments = releasesRelative.split("/");
    if (segments.length < 2) return null;
    const relative = segments.slice(1).join("/");
    return {
      relative,
      generation: join(getReleasesDir(), segments[0]),
      role: PACKAGE_EXECUTABLE_ROLES[relative] || null,
    };
  }
  return null;
}

export function canonicalPackageRole(candidatePath) {
  const boundary = packageBoundary(candidatePath);
  if (!boundary || !boundary.role) return null;
  return { role: boundary.role, relative: boundary.relative, generation: boundary.generation };
}

export async function executableEntrypoint(proc) {
  const rawExe = proc.exe || "";
  const cleanExe = rawExe.replace(/\s+\(deleted\)$/, "");
  const exeBoundary = packageBoundary(cleanExe);
  if (exeBoundary) return { ...exeBoundary, path: cleanExe, argvIndex: 0, deleted: cleanExe !== rawExe };
  if (!cleanExe || !INTERPRETER_BASENAMES.has(basename(cleanExe))) return null;
  const argv = proc.cmdline || [];
  for (let k = 1; k <= 2; k++) {
    const candidate = argv[k];
    if (typeof candidate !== "string" || !candidate.startsWith("/")) continue;
    const boundary = packageBoundary(candidate);
    if (!boundary) continue;
    try {
      const real = await realpath(candidate);
      const realBoundary = packageBoundary(real);
      if (!realBoundary || realBoundary.relative !== boundary.relative || realBoundary.generation !== boundary.generation) continue;
      const fd = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(2);
        const { bytesRead } = await fd.read(header, 0, 2, 0);
        if (bytesRead === 2 && header.toString() === "#!") {
          return { ...boundary, path: real, argvIndex: k };
        }
      } finally {
        await fd.close();
      }
    } catch {}
  }
  return null;
}

// Mirrors the option-aware skip in /usr/local/bin/codex. The first positional
// token before '--' is the subcommand; option values are never subcommands.
export function parseCodexInvocation(cmdline, startIndex = 1) {
  // Value-taking global options verified against the real bundled 0.162.1
  // `codex --help`; mirror of the wrapper's case list. Unknown or unclear
  // syntax falls through conservatively (extra positional => still busy CLI).
  const OPTION_WITH_VALUE = new Set([
    "-m", "--model", "-c", "--config", "-C", "--cd", "--profile", "-p", "--color",
    "-s", "--sandbox", "-a", "--ask-for-approval", "--enable", "--disable",
    "--remote", "--remote-auth-token-env", "--local-provider", "-i", "--image",
    "--add-dir", "--listen",
  ]);
  let subcommand = null;
  let listenSocket = null;
  let optionsEnded = false;
  for (let i = startIndex; i < cmdline.length; i++) {
    const token = cmdline[i];
    if (typeof token !== "string") continue;
    if (!optionsEnded) {
      if (token === "--") { optionsEnded = true; continue; }
      if (token.startsWith("--") && token.includes("=")) {
        if (token.startsWith("--listen=")) {
          const value = token.slice("--listen=".length);
          if (value.startsWith("unix://")) listenSocket = value.slice(7);
        }
        continue;
      }
      if (token.startsWith("-") && token !== "-") {
        if (OPTION_WITH_VALUE.has(token)) {
          const value = cmdline[i + 1];
          if (token === "--listen" && typeof value === "string" && value.startsWith("unix://")) {
            listenSocket = value.slice(7);
          }
          i++;
        }
        continue;
      }
      if (subcommand === null) subcommand = token;
    }
  }
  return { subcommand, listenSocket };
}

async function ancestorPids(pid, maxDepth = 32) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    let statStr;
    try {
      statStr = await readFile(`/proc/${current}/stat`, "utf-8");
    } catch {
      break;
    }
    const lastParen = statStr.lastIndexOf(")");
    if (lastParen === -1) break;
    const parts = statStr.slice(lastParen + 1).trim().split(/\s+/);
    const ppid = parseInt(parts[1], 10);
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    chain.push(ppid);
    if (ppid === 1) break;
    current = ppid;
  }
  return chain;
}

export async function inspectProcess(pid) {
  try {
    const statStr = await readFile(`/proc/${pid}/stat`, "utf-8");
    const lastParen = statStr.lastIndexOf(")");
    if (lastParen === -1) return null;
    const parts = statStr.slice(lastParen + 1).trim().split(/\s+/);
    const state = parts[0];
    const startTime = parts[19];
    if (state === "Z") return null;

    let exe = "";
    try {
      exe = await readlink(`/proc/${pid}/exe`);
    } catch {}

    let cmdline = [];
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      cmdline = raw.toString().split("\0").filter(Boolean);
    } catch {}

    return {
      pid,
      state,
      start: startTime,
      startTime,
      ppid: parts[1],
      exe,
      cmdline,
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    return {
      pid,
      unknown: true,
      error: err.message,
    };
  }
}

export class MinimalWebSocketClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
  }

  async connect() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket = createConnection({ path: this.socketPath });
      this.socket.setTimeout(8000);

      const cleanup = () => {
        this.socket.removeAllListeners("data");
        this.socket.removeAllListeners("error");
        this.socket.removeAllListeners("timeout");
      };

      this.socket.on("error", (err) => {
        cleanup();
        rejectPromise(err);
      });

      this.socket.on("timeout", () => {
        cleanup();
        this.socket.destroy();
        rejectPromise(new Error("RPC socket handshake timeout"));
      });

      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      const request =
        "GET / HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n";

      this.socket.write(request);

      let handshakeBuffer = Buffer.alloc(0);
      const onHandshakeData = (chunk) => {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
          const headerText = handshakeBuffer.slice(0, headerEnd).toString();
          this.buffer = handshakeBuffer.slice(headerEnd + 4);
          cleanup();

          const lines = headerText.split("\r\n");
          const statusLine = lines[0] || "";
          if (!statusLine.includes(" 101 ")) {
            this.socket.destroy();
            rejectPromise(new Error(`Invalid WebSocket HTTP upgrade status: ${statusLine}`));
            return;
          }

          let acceptHeaderVal = null;
          for (const line of lines.slice(1)) {
            const idx = line.indexOf(":");
            if (idx !== -1) {
              const hName = line.slice(0, idx).trim().toLowerCase();
              if (hName === "sec-websocket-accept") {
                acceptHeaderVal = line.slice(idx + 1).trim();
              }
            }
          }

          if (acceptHeaderVal !== expectedAccept) {
            this.socket.destroy();
            rejectPromise(new Error("Invalid or missing Sec-WebSocket-Accept handshake header"));
            return;
          }

          this.socket.on("data", (d) => {
            if (this.buffer.length + d.length > 10 * 1024 * 1024) {
              this.socket.destroy();
              return;
            }
            this.buffer = Buffer.concat([this.buffer, d]);
          });

          this.call("initialize", {
            clientInfo: { name: "ha_codex_updater", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          })
            .then(() => {
              this.sendJson({ method: "initialized" });
              resolvePromise();
            })
            .catch(rejectPromise);
        }
      };

      this.socket.on("data", onHandshakeData);
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  sendFrame(opcode, data) {
    const size = data.length;
    let header;
    if (size < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | size]);
    } else if (size < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(size, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(size), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      masked[i] = data[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendJson(obj) {
    this.sendFrame(1, Buffer.from(JSON.stringify(obj)));
  }

  async readExact(count) {
    const deadline = Date.now() + 8000;
    while (this.buffer.length < count) {
      if (Date.now() > deadline) throw new Error("RPC readExact timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
    const res = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return res;
  }

  async receive() {
    const chunks = [];
    while (true) {
      const header = await this.readExact(2);
      const opcode = header[0] & 0x0f;
      let len = header[1] & 0x7f;
      if (len === 126) {
        const ext = await this.readExact(2);
        len = ext.readUInt16BE(0);
      } else if (len === 127) {
        const ext = await this.readExact(8);
        len = Number(ext.readBigUInt64BE(0));
      }
      const body = await this.readExact(len);
      if (opcode === 8) throw new Error("WebSocket closed by server");
      if (opcode === 9) {
        this.sendFrame(10, body);
        continue;
      }
      if (opcode === 10) continue;
      chunks.push(body);
      if (header[0] & 0x80) {
        const full = Buffer.concat(chunks).toString("utf-8");
        return JSON.parse(full);
      }
    }
  }

  async call(method, params = {}) {
    this.nextId += 1;
    const reqId = this.nextId;
    this.sendJson({ id: reqId, method, params });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const msg = await this.receive();
      if (msg.id === reqId) {
        if (msg.error) {
          throw new Error(`${method}: RPC error ${msg.error.code || JSON.stringify(msg.error)}`);
        }
        return msg.result || {};
      }
    }
    throw new Error(`${method} timed out`);
  }
}

export async function inspectAppServer(socketPath, expectedPid) {
  let client = null;
  try {
    client = new MinimalWebSocketClient(socketPath);
    await client.connect();

    const diag = await client.call("server/diagnostics", {});
    if (!diag || typeof diag !== "object" || Object.keys(diag).length === 0) {
      return { busy: true, reason: "Diagnostics returned empty or malformed object" };
    }

    const diagPid = diag.process?.id;
    if (typeof diagPid !== "number") {
      return { busy: true, reason: "Diagnostics process.id is missing or non-numeric" };
    }

    if (expectedPid && diagPid !== expectedPid) {
      return { busy: true, reason: `Socket owner PID mismatch (expected ${expectedPid}, got ${diagPid})` };
    }

    if (!Array.isArray(diag.gauges) || diag.gauges.length === 0) {
      return { busy: true, reason: "Diagnostics gauges is missing, not an array, or empty" };
    }

    const requiredGauges = ["app.requests.in_flight", "app.requests.queued", "core.turns.active"];
    for (const reqName of requiredGauges) {
      const g = diag.gauges.find((x) => x && x.name === reqName);
      // The diagnostics protocol registers gauges on first increment. Fresh
      // servers legitimately omit queue/turn gauges. Diagnostics itself must
      // register in_flight; that gauge remains mandatory on every version.
      if (!g && reqName !== "app.requests.in_flight") continue;
      if (!g || typeof g.value !== "number" || !Number.isFinite(g.value) || g.value < 0) {
        return { busy: true, reason: `Missing or non-finite required gauge: ${reqName}` };
      }
      // Diagnostics is itself an in-flight request in tagged 0.162.1.
      // Official suite/v2/server_diagnostics.rs asserts >=1 for that request.
      const idleValue = reqName === "app.requests.in_flight" ? 1 : 0;
      if (g.value > idleValue) {
        return { busy: true, reason: `Active gauge ${reqName} = ${g.value}` };
      }
    }

    const threadsRes = await client.call("thread/loaded/list", { limit: 100 });
    if (!threadsRes || typeof threadsRes !== "object" || !Array.isArray(threadsRes.data)) {
      return { busy: true, reason: "Malformed thread/loaded/list response" };
    }

    if (threadsRes.data.length > 0) {
      return { busy: true, reason: `${threadsRes.data.length} conversation(s) loaded` };
    }

    return { busy: false, pid: diagPid };
  } catch (err) {
    return { busy: true, reason: `App-server inspection failed: ${err.message}` };
  } finally {
    if (client) client.close();
  }
}

export async function inspectAllSessions(options = {}) {
  const readOnly = Boolean(options.readOnly);
  const busyReasons = [];
  const blockers = [];
  const restartableServers = [];
  const entries = new Map();

  const counts = {
    cli: 0,
    helpers: 0,
    managedIdleServers: 0,
    remoteStdio: 0,
    unmanagedAppServers: 0,
    unknown: 0,
  };

  const failClosed = (message) => ({
    isIdle: false,
    canApply: false,
    sessionCount: -1,
    busyReasons: [message],
    blockers: [{ type: "inspection_failed", pid: null, detail: message }],
    counts: { ...counts },
    restartableServers: [],
  });

  const addBusy = (type, pid, detail) => {
    blockers.push({ type, pid, detail });
    busyReasons.push(`[${type}] ${detail} (pid ${pid})`);
  };

  // Pass 1: registered session records. PID+start-time identity decides whether
  // the record is current, a reused slot, or already gone.
  const sessionsDir = getSessionsDir();
  if (existsSync(sessionsDir)) {
    try {
      const sessionFiles = await readdir(sessionsDir);
      for (const file of sessionFiles) {
        if (!/^\d+$/.test(file)) continue;
        const pid = parseInt(file, 10);
        const filePath = join(sessionsDir, file);
        try {
          const st = await lstat(filePath).catch(() => null);
          if (!st || !st.isFile() || st.isSymbolicLink() || st.size > 65536) {
            if (!readOnly) await unlink(filePath).catch(() => {});
            continue;
          }
          const content = JSON.parse(await readFile(filePath, "utf-8"));
          const proc = await inspectProcess(pid);
          if (!proc) {
            if (!readOnly) await unlink(filePath).catch(() => {});
            continue;
          }
          if (proc.unknown) {
            entries.set(pid, { proc, kind: "unknown", registered: true });
            continue;
          }
          if (String(proc.startTime) !== String(content.start)) {
            if (!readOnly) await unlink(filePath).catch(() => {});
            continue;
          }
          entries.set(pid, { proc, record: content });
        } catch {
          if (!readOnly) await unlink(filePath).catch(() => {});
        }
      }
    } catch (err) {
      return failClosed(`Failed to inspect sessions directory: ${err.message}`);
    }
  }

  // Pass 2: /proc inventory. The same classification rules run in production
  // and in fixtures; there is no test-only matching branch.
  let procEntries = [];
  try {
    procEntries = await readdir("/proc");
  } catch (err) {
    return failClosed(`Failed to inspect /proc: ${err.message}`);
  }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid || entries.has(pid)) continue;
    const proc = await inspectProcess(pid);
    if (!proc) continue;
    if (proc.unknown) {
      entries.set(pid, { proc, kind: "unknown" });
      continue;
    }
    const exeName = basename((proc.exe || "").replace(/\s+\(deleted\)$/, ""));
    const cmdStr = (proc.cmdline || []).join(" ");
    if (exeName === "flock" || cmdStr.startsWith("flock ")) continue;
    // Command-line strings such as "/bin/codex" or "app-server" that only
    // appear as data never create identity here.
    const identity = await executableEntrypoint(proc);
    if (!identity) continue;
    entries.set(pid, { proc, identity });
  }

  // Pass 3: classify each inventory entry from its actual entrypoint and the
  // positional subcommand, not from argv substrings.
  for (const [pid, e] of entries) {
    if (e.kind === "unknown") continue;
    const record = e.record || null;
    const identity = e.identity || await executableEntrypoint(e.proc);
    const invocation = parseCodexInvocation(e.proc.cmdline || [], identity ? identity.argvIndex + 1 : 1);
    if (identity) e.identity = identity;
    const serverByArgv = identity && identity.role === "primary" && invocation.subcommand === "app-server";
    const serverByRecord = record && record.type === "app-server" &&
      (!invocation.subcommand || invocation.subcommand === "app-server");
    if (serverByArgv || serverByRecord) {
      e.kind = "app-server";
      e.socketPath = invocation.listenSocket;
    } else if (!record && identity && identity.role === "companion") {
      e.kind = "companion";
    } else if (!record && identity && identity.role !== "primary" && identity.role !== "companion") {
      e.kind = "unknown";
      e.unrecognized = true;
    } else {
      e.kind = "cli";
    }
  }

  // Pass 4: companions and helpers attach to a verified live owner. An
  // orphaned companion that cannot be attributed is held as unknown; it is
  // never counted as an independent Codex conversation.
  const ownerPids = new Set();
  for (const [pid, e] of entries) {
    if (e.kind === "cli" || e.kind === "app-server") ownerPids.add(pid);
  }
  for (const [pid, e] of entries) {
    if (e.kind !== "companion") continue;
    const chain = await ancestorPids(pid);
    const owner = chain.find((a) => ownerPids.has(a));
    if (owner) {
      e.kind = "helper";
      e.owner = owner;
    } else {
      e.kind = "unknown";
      e.orphanCompanion = true;
    }
  }

  // Pass 5: aggregate. App-servers keep the existing verified managed
  // transaction preconditions: launch record, unix socket, and two idle
  // diagnostics one second apart.
  for (const [pid, e] of entries) {
    if (e.kind === "unknown") {
      counts.unknown++;
      if (e.proc.unknown) {
        addBusy("inspection_failed", pid, `process state unknown: ${e.proc.error}`);
      } else if (e.orphanCompanion) {
        addBusy("unknown", pid, "codex package companion without verifiable owner; held for manual review");
      } else if (e.unrecognized) {
        addBusy("unknown", pid, "unrecognized executable inside managed codex package; held until identity is verified");
      } else {
        addBusy("unknown", pid, "process identity could not be classified");
      }
      continue;
    }
    if (e.kind === "helper") {
      counts.helpers++;
      continue;
    }
    if (e.kind === "cli") {
      counts.cli++;
      if (e.registered) {
        addBusy("cli", pid, "active registered session");
      } else {
        addBusy("cli", pid, "active codex cli process");
      }
      continue;
    }

    // kind === app-server
    const socketPath = e.socketPath || null;
    if (!socketPath) {
      counts.remoteStdio++;
      addBusy("remote_stdio", pid,
        "active remote stdio app-server; restart unsupported, deferred until session exits");
      continue;
    }

    // Verify explicit App-managed launch record in sessions directory
    const sessionFile = join(sessionsDir, String(pid));
    let managedRecord = e.record || null;
    if (!managedRecord) {
      try {
        if (existsSync(sessionFile)) {
          managedRecord = JSON.parse(await readFile(sessionFile, "utf-8"));
        }
      } catch {}
    }

    if (
      !managedRecord ||
      managedRecord.managed !== true ||
      managedRecord.type !== "app-server" ||
      managedRecord.socketPath !== socketPath ||
      managedRecord.pid !== pid ||
      String(managedRecord.start) !== String(e.proc.startTime)
    ) {
      counts.unmanagedAppServers++;
      addBusy("unmanaged_server", pid,
        "active unmanaged app-server without verified launch record; restart unsupported, deferred until session exits");
      continue;
    }

    try {
      const sockStat = await stat(socketPath);
      if (!sockStat.isSocket()) {
        counts.unmanagedAppServers++;
        addBusy("bad_socket", pid, `app-server socket path is not a socket: ${socketPath}`);
        continue;
      }
    } catch (err) {
      counts.unmanagedAppServers++;
      addBusy("socket_inaccessible", pid, `app-server socket inaccessible: ${err.message}`);
      continue;
    }

    const check1 = await inspectAppServer(socketPath, pid);
    if (check1.busy) {
      counts.unmanagedAppServers++;
      addBusy("server_busy", pid, `app-server busy: ${check1.reason}`);
      continue;
    }

    await new Promise((r) => setTimeout(r, 1000));
    const check2 = await inspectAppServer(socketPath, pid);
    if (check2.busy) {
      counts.unmanagedAppServers++;
      addBusy("server_busy", pid, `app-server busy: ${check2.reason}`);
      continue;
    }

    counts.managedIdleServers++;
    restartableServers.push({
      pid,
      start: e.proc.start,
      socketPath,
      proc: e.proc,
      managedRecord,
    });
  }

  const sessionCount =
    counts.cli + counts.managedIdleServers + counts.remoteStdio +
    counts.unmanagedAppServers + counts.unknown;

  return {
    isIdle: busyReasons.length === 0 && restartableServers.length === 0,
    canApply: busyReasons.length === 0,
    sessionCount,
    busyReasons,
    blockers,
    counts: { detectedProcesses: entries.size, ...counts },
    restartableServers,
  };
}

export function fetchJson(url, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const signal = options.signal;
    let req = null;
    let res = null;
    let timer = null;
    let settled = false;
    let hop = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const reject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      res?.destroy();
      req?.destroy();
      rejectPromise(error);
    };
    const onAbort = () => reject(new Error("Operation aborted"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    // One wall-clock budget covers the entire redirect chain.
    timer = setTimeout(() => reject(new Error(`Total timeout fetching ${url}`)), options.totalTimeoutMs || 30000);
    const request = (currentUrl) => {
      if (settled) return;
      if (++hop > 10) { reject(new Error("Too many release redirects")); return; }
      const thisHop = hop;
      const fail = (error) => { if (thisHop === hop) reject(error); };
      try {
        const getter = currentUrl.startsWith("http://") ? httpGet : httpsGet;
        req = getter(currentUrl, {
          headers: {
            "User-Agent": `codex-ha-updater/${getAppVersion()} (Home Assistant App)`,
            Accept: "application/vnd.github.v3+json",
          },
        }, (response) => {
          if (settled || thisHop !== hop) { response.destroy(); return; }
          res = response;
          response.on("error", fail);
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            const nextUrl = new URL(response.headers.location, currentUrl).href;
            // A redirect body can continue indefinitely; close it before
            // transferring ownership to the next request and abort listener.
            response.destroy();
            req.destroy();
            req = null;
            res = null;
            request(nextUrl);
            return;
          }
          if (response.statusCode !== 200) { fail(new Error(`HTTP ${response.statusCode} from ${currentUrl}`)); return; }
          let data = "";
          response.on("data", (chunk) => { data += chunk; });
          response.on("end", () => {
            if (settled) return;
            try {
              const value = JSON.parse(data);
              settled = true;
              cleanup();
              resolvePromise(value);
            } catch (error) { fail(error); }
          });
        });
        req.on("error", fail);
        req.setTimeout(options.socketTimeoutMs || 30000, () => fail(new Error(`Timeout fetching ${currentUrl}`)));
      } catch (error) { fail(error); }
    };
    request(url);
  });
}

export async function downloadAndStagePackage(releaseInfo, customDownloadUrl = null, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
  const version = releaseInfo.version;
  const target = resolveTargetArchitecture();
  const packageName = `codex-package-${target}.tar.gz`;

  let asset = null;
  if (Array.isArray(releaseInfo.assets)) {
    asset = releaseInfo.assets.find((a) => a.name === packageName);
  }

  const expectedDigest = asset?.digest?.startsWith("sha256:")
    ? asset.digest.slice(7)
    : releaseInfo.expectedSha256;

  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error(`Missing or invalid SHA-256 digest for official asset ${packageName}`);
  }

  const downloadUrl =
    customDownloadUrl ||
    asset?.browser_download_url ||
    `https://github.com/openai/codex/releases/download/rust-v${version}/${packageName}`;

  await mkdir(getStagingDir(), { recursive: true, mode: 0o700 });
  const tempArchive = join(getStagingDir(), `.download-${process.pid}-${Date.now()}.tar.gz`);
  const extractDir = join(getStagingDir(), `.extract-${process.pid}-${Date.now()}`);
  const pendingOpens = [];

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const hasher = createHash("sha256");
      let totalBytes = 0;
      let activeReq = null;
      let activeRes = null;
      let activeInStream = null;
      let activeOutStream = null;
      let onAbort = null;
      let settled = false;
      let generation = 0;

      const timeoutTimer = setTimeout(() => {
        safeReject(new Error("Download exceeded timeout limit"));
      }, DOWNLOAD_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };

      const safeReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (activeReq) { try { activeReq.destroy(); } catch {} }
        if (activeRes) { try { activeRes.destroy(); } catch {} }
        if (activeInStream) { try { activeInStream.destroy(); } catch {} }
        if (activeOutStream) { try { activeOutStream.destroy(); } catch {} }
        rejectPromise(err);
      };

      const safeResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise();
      };

      if (signal) {
        onAbort = () => {
          safeReject(new Error("Operation aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const downloadReq = (url) => {
        if (settled) return;
        const thisGeneration = ++generation;
        if (generation > 10) { safeReject(new Error("Too many package redirects")); return; }
        const fail = (error) => { if (thisGeneration === generation) safeReject(error); };
        if (signal?.aborted) {
          safeReject(new Error("Operation aborted"));
          return;
        }
        if (url.startsWith("file://")) {
          const filePath = url.slice(7);
          pendingOpens.push(open(tempArchive, "w", 0o600).then(async (fileHandle) => {
            if (settled || signal?.aborted) {
              await fileHandle.close().catch(() => {});
              safeReject(new Error("Operation aborted"));
              return;
            }
            activeOutStream = fileHandle.createWriteStream();
            activeInStream = createReadStream(filePath);
            activeInStream.on("data", (chunk) => {
              totalBytes += chunk.length;
              if (totalBytes > MAX_DOWNLOAD_BYTES) {
                safeReject(new Error("Package size exceeded maximum allowed limit"));
                return;
              }
              hasher.update(chunk);
            });
            activeInStream.pipe(activeOutStream);
            activeOutStream.on("finish", () => {
              const actualDigest = hasher.digest("hex");
              if (actualDigest !== expectedDigest) {
                safeReject(new Error(`SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`));
                return;
              }
              safeResolve();
            });
            activeInStream.on("error", safeReject);
            activeOutStream.on("error", safeReject);
          }).catch(safeReject));
          return;
        }

        const appVersion = getAppVersion();
        const getter = url.startsWith("http://") ? httpGet : httpsGet;
        activeReq = getter(
          url,
          {
            headers: {
              "User-Agent": `codex-ha-updater/${appVersion} (Home Assistant App)`,
            },
          },
          (res) => {
            if (settled || thisGeneration !== generation) { res.destroy(); return; }
            activeRes = res;
            res.on("error", fail);
            if (signal?.aborted) {
              safeReject(new Error("Operation aborted"));
              return;
            }
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const nextUrl = new URL(res.headers.location, url).href;
              res.destroy();
              activeReq.destroy();
              activeReq = null;
              activeRes = null;
              downloadReq(nextUrl);
              return;
            }
            if (res.statusCode !== 200) {
              safeReject(new Error(`HTTP ${res.statusCode} downloading package`));
              return;
            }

            pendingOpens.push(open(tempArchive, "w", 0o600).then(async (fileHandle) => {
              if (settled || signal?.aborted) {
                await fileHandle.close().catch(() => {});
                safeReject(new Error("Operation aborted"));
                return;
              }
              activeOutStream = fileHandle.createWriteStream();
              res.on("data", (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_DOWNLOAD_BYTES) {
                  safeReject(new Error("Package size exceeded maximum allowed limit"));
                  return;
                }
                hasher.update(chunk);
              });

              res.pipe(activeOutStream);
              activeOutStream.on("finish", () => {
                const actualDigest = hasher.digest("hex");
                if (actualDigest !== expectedDigest) {
                  safeReject(
                    new Error(
                      `SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`
                    )
                  );
                  return;
                }
                safeResolve();
              });
              activeOutStream.on("error", safeReject);
            }).catch(safeReject));
          }
        ).on("error", fail);
      };

      downloadReq(downloadUrl);
    });

    await mkdir(extractDir, { recursive: true, mode: 0o700 });

    const listProc = spawnSync("tar", ["-tvzf", tempArchive], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (listProc.status !== 0) {
      throw new Error(`tar list failed: ${listProc.stderr || "exit " + listProc.status}`);
    }

    const tarLines = listProc.stdout.split("\n").filter(Boolean);
    if (tarLines.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Package archive exceeds maximum allowed entry count: ${tarLines.length} > ${MAX_ARCHIVE_ENTRIES}`);
    }

    let totalExtractedSize = 0;
    for (const tline of tarLines) {
      const parts = tline.trim().split(/\s+/);
      const perms = parts[0] || "";
      const fileType = perms[0];
      if (fileType === "h" || fileType === "b" || fileType === "c" || fileType === "p") {
        throw new Error(`Unsafe entry type (${fileType}) in package archive: ${tline}`);
      }

      const sizeCol = parseInt(parts[2], 10);
      if (!isNaN(sizeCol) && sizeCol > 0) {
        totalExtractedSize += sizeCol;
        if (totalExtractedSize > MAX_EXTRACTED_BYTES) {
          throw new Error(`Extracted archive size exceeds limit: ${totalExtractedSize} > ${MAX_EXTRACTED_BYTES}`);
        }
      }

      if (tline.includes(" -> ")) {
        const linkTarget = tline.split(" -> ")[1]?.trim() || "";
        if (linkTarget.startsWith("/") || linkTarget.startsWith("../") || linkTarget.includes("/../") || linkTarget.includes("\\")) {
          throw new Error(`Unsafe symlink target in archive: ${linkTarget}`);
        }
      }

      const entryName = parts[parts.length - 1];
      if (entryName.startsWith("/") || entryName.startsWith("../") || entryName.includes("/../") || entryName.includes("\\")) {
        throw new Error(`Unsafe path in package tar archive: ${entryName}`);
      }
    }

    const extractProc = spawnSync("tar", ["--no-same-owner", "-xzf", tempArchive, "-C", extractDir], {
      encoding: "utf-8",
    });
    if (extractProc.status !== 0) {
      throw new Error(`tar extract failed: ${extractProc.stderr || "exit " + extractProc.status}`);
    }

    // Validate complete extracted package tree with expected version and target
    const treeCheck = await validateCandidatePackageTree(extractDir, {
      expectedVersion: version,
      expectedTarget: target,
    });
    if (!treeCheck.valid) {
      throw new Error(`Package tree validation failed: ${treeCheck.error}`);
    }

    const binCodex = join(extractDir, "bin/codex");
    await chmod(binCodex, 0o755);

    // Multi-step compatibility verification in isolated HOME
    const verifyHome = join(getStagingDir(), `.verify-${process.pid}-${Date.now()}`);
    await mkdir(verifyHome, { recursive: true, mode: 0o700 });
    try {
      const vProc = spawnSync(binCodex, ["--version"], {
        env: { PATH: process.env.PATH, HOME: verifyHome, TMPDIR: verifyHome },
        timeout: 5000,
        encoding: "utf-8",
      });
      if (vProc.status !== 0 || !vProc.stdout.includes(`codex-cli ${version}`)) {
        throw new Error(
          `Executable failed version test: ${vProc.stderr || vProc.stdout || "exit " + vProc.status}`
        );
      }

      const hProc = spawnSync(binCodex, ["--help"], {
        env: { PATH: process.env.PATH, HOME: verifyHome, TMPDIR: verifyHome },
        timeout: 5000,
        encoding: "utf-8",
      });
      if (hProc.status !== 0) {
        throw new Error(
          `Executable failed help test: ${hProc.stderr || hProc.stdout || "exit " + hProc.status}`
        );
      }

      const cProc = spawnSync(binCodex, ["-c", 'approval_policy="on-request"', "--help"], {
        env: { PATH: process.env.PATH, HOME: verifyHome, TMPDIR: verifyHome },
        timeout: 5000,
        encoding: "utf-8",
      });
      if (cProc.status !== 0) {
        throw new Error(
          `Executable failed config parameter test: ${cProc.stderr || cProc.stdout || "exit " + cProc.status}`
        );
      }
    } finally {
      await rm(verifyHome, { recursive: true, force: true }).catch(() => {});
    }

    const destDir = join(getReleasesDir(), `${version}-${target}`);
    const inventory = await packageInventory(extractDir);
    if (existsSync(destDir)) {
      const existing = await packageInventory(destDir);
      if (JSON.stringify(existing) !== JSON.stringify(inventory)) {
        throw new Error("Existing release differs from verified archive; refusing to replace generation");
      }
      // Never delete a generation, even if it is damaged or appears unreferenced.
      // The independently verified extract authorizes recording its inventory.
    } else {
      await rename(extractDir, destDir);
    }
    await recordPackage(destDir, getBaseRuntimeDir(), expectedDigest, inventory);

    const tempStaged = join(getBaseRuntimeDir(), `.staged-${process.pid}-${Date.now()}`);
    await symlink(destDir, tempStaged);
    await rename(tempStaged, getStagedLink());

    return {
      version,
      target,
      path: destDir,
    };
  } finally {
    // An abort can beat an asynchronous open. Wait for it to close before
    // unlinking, otherwise it could recreate the archive after cleanup.
    await Promise.allSettled(pendingOpens);
    await unlink(tempArchive).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkUpdate(targetVersion = null, options = {}) {
  if (options.signal?.aborted) {
    throw new Error("Operation aborted");
  }
  return withGateLock("exclusive", 15, async () => {
    if (options.signal?.aborted) {
      throw new Error("Operation aborted");
    }
    const state = await loadState();
    const currentVersion = state.selectedVersion || getBundledVersion();

    const optionsObj = await readOptions();
    const tz = optionsObj.timezone || DEFAULT_TIMEZONE;
    const slotInfo = getCurrentSlotInfo(getNow(), tz);
    const currentDate = slotInfo.slotDate;

    if (options.slotKey) {
      state.lastCheckSlot = options.slotKey;
    }

    // Reset daily budget when date changes
    if (state.budgetDate !== currentDate) {
      state.budgetDate = currentDate;
      state.idleCheckCount = 0;
      if (state.status === "paused_busy") {
        state.status = "ready_to_apply";
        state.reason = "New day budget initialized; resuming candidate apply";
      }
    }

    let releaseData;
    if (options.fixtureRelease) {
      releaseData = options.fixtureRelease;
    } else {
      const url =
        options.releaseUrl ||
        (targetVersion
          ? `https://api.github.com/repos/openai/codex/releases/tags/rust-v${targetVersion}`
          : "https://api.github.com/repos/openai/codex/releases/latest");
      releaseData = await fetchJson(url, options);
    }

    if (releaseData.prerelease || releaseData.draft) {
      state.status = "up_to_date";
      state.reason = "Latest release is draft or prerelease; skipped";
      await saveState(state);
      return { upToDate: true, currentVersion, state };
    }

    const tagName = releaseData.tag_name || releaseData.name || "";
    const versionMatch = tagName.match(/^rust-v?([0-9]+\.[0-9]+\.[0-9]+)$/);
    if (!versionMatch) {
      throw new Error(`Release tag ${tagName} is not a valid production stable release`);
    }
    const latestVersion = versionMatch[1];

    if (compareSemver(latestVersion, currentVersion) < 0) {
      state.status = "up_to_date";
      state.reason = `Upstream release ${latestVersion} would downgrade current ${currentVersion}`;
      await saveState(state);
      return { upToDate: true, currentVersion, targetVersion: latestVersion, state };
    }

    if (latestVersion === currentVersion) {
      state.status = "up_to_date";
      state.reason = `Already running latest stable version ${currentVersion}`;
      state.lastCheckAt = getNow().toISOString();
      await saveState(state);
      return { upToDate: true, currentVersion, state };
    }

    const targetArch = resolveTargetArchitecture();
    const targetAsset = releaseData.assets?.find((a) => a.name === `codex-package-${targetArch}.tar.gz`);
    const expectedDigest = targetAsset?.digest?.startsWith("sha256:")
      ? targetAsset.digest.slice(7)
      : options.expectedSha256 || releaseData.expectedSha256;

    if (state.candidateVersion === latestVersion) {
      if (state.candidateDigest && expectedDigest && state.candidateDigest !== expectedDigest) {
        state.status = "failed";
        state.blockedReason = "candidate_digest_mismatch";
        state.reason = `Candidate digest changed unexpectedly for version ${latestVersion}`;
        await saveState(state);
        return { upToDate: false, stagedVersion: state.stagedVersion, blocked: true, blockedReason: state.blockedReason, state };
      }

      if (state.blockedReason && !options.isManualRetry) {
        await saveState(state);
        return { upToDate: false, stagedVersion: state.stagedVersion, blocked: true, blockedReason: state.blockedReason, state };
      }

      if (options.isManualRetry) {
        state.idleCheckCount = 0;
        state.blockedReason = null;
        if (state.status === "paused_busy" || state.status === "failed") {
          state.status = "ready_to_apply";
        }
      } else if (state.status === "paused_busy") {
        await saveState(state);
        return { upToDate: false, stagedVersion: state.stagedVersion, paused: true, state };
      }
    } else {
      state.candidateVersion = latestVersion;
      state.candidateDigest = expectedDigest;
      state.idleCheckCount = 0;
      state.restartAttemptCount = 0;
      state.blockedReason = null;
      state.budgetDate = currentDate;
    }

    const stagedCheck = await validateSymlinkContainment(getStagedLink());
    if (!stagedCheck.valid || state.stagedVersion !== latestVersion) {
      await downloadAndStagePackage(
        {
          version: latestVersion,
          assets: releaseData.assets,
          expectedSha256: expectedDigest,
        },
        options.downloadUrl,
        options
      );
    }

    state.stagedVersion = latestVersion;
    state.lastCheckAt = getNow().toISOString();
    state.status = "ready_to_apply";
    state.reason = `Staged version ${latestVersion}; waiting for idle sessions`;
    await saveState(state);

    return {
      upToDate: false,
      stagedVersion: latestVersion,
      currentVersion,
      state,
    };
  });
}

export async function applyUpdate(options = {}) {
  if (options.signal?.aborted) {
    throw new Error("Operation aborted");
  }
  return withGateLock("exclusive", 15, async () => {
    if (options.signal?.aborted) {
      throw new Error("Operation aborted");
    }
    const isManual = options.isManual === true;
    const state = await loadState();

    const opts = await readOptions();
    const tz = opts.timezone || DEFAULT_TIMEZONE;
    const slotInfo = getCurrentSlotInfo(getNow(), tz);
    const currentDate = slotInfo.slotDate;

    if (state.budgetDate !== currentDate) {
      state.budgetDate = currentDate;
      state.idleCheckCount = 0;
      if (state.status === "paused_busy") {
        state.status = "ready_to_apply";
        state.reason = "New day budget initialized; resuming candidate apply";
      }
    }

    if (!isManual) {
      if (!opts.valid) {
        state.status = "blocked_options";
        state.reason = `Options validation failed: ${opts.error}`;
        await saveState(state);
        return { applied: false, reason: "options_invalid", state };
      }
      if (!opts.autoUpdate) {
        state.status = "auto_update_disabled";
        state.reason = "Auto update is disabled in add-on options";
        await saveState(state);
        return { applied: false, reason: "auto_update_disabled", state };
      }
    }

    const stagedCheck = await validateSymlinkContainment(getStagedLink());
    if (!stagedCheck.valid || !existsSync(stagedCheck.target)) {
      if (state.stagedVersion) {
        state.status = "failed";
        state.blockedReason = "blocked_integrity";
        state.reason = "Staged package failed integrity verification";
        await saveState(state);
        return { applied: false, reason: "blocked_integrity", state };
      }
      state.status = "up_to_date";
      state.reason = "No staged update available to apply";
      await saveState(state);
      return { applied: false, reason: "no_staged_update", state };
    }
    const stagedTarget = stagedCheck.target;

    if (!isManual && state.blockedReason) {
      return { applied: false, reason: state.blockedReason, state };
    }

    if (isManual) {
      if (state.blockedReason) {
        state.blockedReason = null;
      }
      state.idleCheckCount = 0;
      if (state.status === "paused_busy") {
        state.status = "ready_to_apply";
      }
    }

    if (!isManual && state.idleCheckCount >= MAX_IDLE_CHECKS) {
      // Skipped before inspection: keep the last inspected process blocker.
      // Budget exhaustion itself is visible in status/idleCheckCount/nextRetryAt.
      state.status = "paused_busy";
      state.reason = `Daily idle check budget exhausted for ${state.budgetDate}`;
      state.nextRetryAt = getNextDayFirstSlotTime(getNow(), tz).toISOString();
      await saveState(state);
      return { applied: false, reason: "paused_busy", state };
    }

    const sessions = await inspectAllSessions();

    let previousTarget = null;
    try {
      previousTarget = await readlink(getCurrentLink());
    } catch {}

    const stagedPkgJson = JSON.parse(
      await readFile(join(stagedTarget, "codex-package.json"), "utf-8")
    );
    const newVersion = stagedPkgJson.version;
    const integrity = await verifyPackage(stagedTarget, getBaseRuntimeDir(), state.candidateDigest);
    if (!state.candidateDigest || state.candidateVersion !== newVersion || !integrity.valid) {
      state.status = "failed";
      state.blockedReason = "blocked_integrity";
      state.reason = "Candidate bytes or digest do not match verified journal";
      await saveState(state);
      return { applied: false, reason: "blocked_integrity", state };
    }

    // Check if we have only restartable servers (no active CLI sessions, only idle unix app-servers)
    const canAttemptRestart =
      sessions.restartableServers &&
      sessions.restartableServers.length > 0 &&
      sessions.busyReasons.length === 0;

    if (canAttemptRestart) {
      const now = getNow().getTime();
      const cooldownActive =
        state.nextRestartAllowedAt &&
        new Date(state.nextRestartAllowedAt).getTime() > now;

      if (cooldownActive) {
        if (!isManual) {
          state.idleCheckCount = (state.idleCheckCount || 0) + 1;
          if (state.idleCheckCount >= MAX_IDLE_CHECKS) {
            state.status = "paused_busy";
            state.lastBlocker = "daily_budget_exhausted";
            state.reason = `Candidate ${state.stagedVersion} reached daily idle check limit (${MAX_IDLE_CHECKS} checks for ${state.budgetDate}); restart cooldown active until ${state.nextRestartAllowedAt}`;
            state.nextRetryAt = getNextDayFirstSlotTime(getNow(), tz).toISOString();
            await saveState(state);
            return { applied: false, reason: "paused_busy", state };
          }
        }
        state.status = "paused_restart";
        state.lastBlocker = "restart_cooldown";
        state.reason = `Restart cooldown active until ${state.nextRestartAllowedAt}; waiting for session exit (${state.idleCheckCount}/${MAX_IDLE_CHECKS} checks for ${state.budgetDate})`;
        state.nextRetryAt = state.nextRestartAllowedAt;
        await saveState(state);
        return { applied: false, reason: "restart_cooldown", state };
      }
    } else if (!sessions.isIdle) {
      if (!isManual) {
        state.idleCheckCount = (state.idleCheckCount || 0) + 1;
        if (state.idleCheckCount >= MAX_IDLE_CHECKS) {
          state.status = "paused_busy";
          state.reason = `Candidate ${state.stagedVersion} reached daily idle check limit (${MAX_IDLE_CHECKS} checks for ${state.budgetDate}). Fast checks paused until next scheduled date or run 'ha-codex-update apply' manually.`;
          state.nextRetryAt = getNextDayFirstSlotTime(getNow(), tz).toISOString();
        } else {
          state.status = "pending_busy";
          state.reason = `Deferred (${state.idleCheckCount}/${MAX_IDLE_CHECKS} checks for ${state.budgetDate}): ${sessions.busyReasons.join(", ")}`;
        }
      } else {
        state.status = "pending_busy";
        state.reason = `Deferred: ${sessions.busyReasons.join(", ")}`;
      }
      state.lastBlocker = sessions.blockers[0]?.type || "unknown";
      await saveState(state);
      return {
        applied: false,
        reason: state.status,
        busyReasons: sessions.busyReasons,
        blockerTypes: sessions.blockers.map((b) => b.type),
        state,
      };
    }

    // Sessions are either completely idle OR restartable with expired cooldown.
    // Run candidate managed policy probe right before applying!
    const policy = await (options.policyProbe || verifyManagedPolicy)(stagedTarget);
    if (!policy.valid) {
      state.status = "blocked_policy";
      state.blockedReason = "blocked_policy";
      state.reason = policy.reason || "managed_policy_probe_failed";
      await saveState(state);
      return { applied: false, reason: "blocked_policy", state };
    }

    if (canAttemptRestart) {
      const now = getNow().getTime();
      // Pre-flight compatibility & policy verification of candidate BEFORE sending signal
      const targetArch = resolveTargetArchitecture();
      const treeCheck = await validateCandidatePackageTree(stagedTarget, {
        expectedVersion: newVersion,
        expectedTarget: targetArch,
      });
      if (!treeCheck.valid) {
        state.status = "failed";
        state.blockedReason = "blocked_policy";
        state.reason = `Pre-restart candidate package validation failed: ${treeCheck.error}`;
        await saveState(state);
        return { applied: false, reason: "pre_restart_validation_failed", state };
      }

      // Pre-apply version check on candidate binary
      const testPre = spawnSync(join(stagedTarget, "bin/codex"), ["--version"], {
        env: { PATH: process.env.PATH },
        timeout: 5000,
        encoding: "utf-8",
      });
      if (testPre.status !== 0 || !testPre.stdout.includes(`codex-cli ${newVersion}`)) {
        state.status = "failed";
        state.blockedReason = "blocked_verification";
        state.reason = "Staged executable failed pre-apply version test";
        await saveState(state);
        return { applied: false, reason: "verification_failed", state };
      }

      const replaceLink = async (target) => {
        if (!target) throw new Error("Missing previous package for rollback");
        const temp = join(getBaseRuntimeDir(), `.switch-${process.pid}-${Date.now()}`);
        await symlink(target, temp);
        await rename(temp, getCurrentLink());
      };
      const transaction = await restartServers({
        servers: sessions.restartableServers,
        binary: join(stagedTarget, "bin/codex"), version: newVersion,
        inspectProcess, inspectServer: inspectAppServer,
        switchToNew: () => replaceLink(stagedTarget),
        switchToOld: () => replaceLink(previousTarget),
        writeRecord: (pid, record) => durableJson(join(getSessionsDir(), String(pid)), record),
        removeRecord: pid => rm(join(getSessionsDir(), String(pid)), { force: true }),
        commitAttempt: async () => {
          state.lastRestartAt = getNow().toISOString();
          state.nextRestartAllowedAt = new Date(now + 24 * 3600 * 1000).toISOString();
          state.restartAttemptCount = (state.restartAttemptCount || 0) + 1;
          await saveState(state);
        },
      });
      if (!transaction.applied) {
        state.status = "failed";
        state.blockedReason = "blocked_restart";
        state.reason = `Server replacement failed: ${transaction.reason}; recovery: ${transaction.recovery}`;
        await saveState(state);
        return { applied: false, reason: transaction.recovery === "rollback_incomplete" ? "rollback_incomplete" : transaction.reason, state };
      }

      // Success
      if (previousTarget) {
        const tempPrev = join(getBaseRuntimeDir(), `.prev-${process.pid}-${Date.now()}`);
        await symlink(previousTarget, tempPrev);
        await rename(tempPrev, getPreviousLink());
      }
      if (existsSync(getStagedLink())) {
        await rm(getStagedLink(), { force: true });
      }

      state.currentVersion = newVersion;
      state.selectedVersion = newVersion;
      state.selectedDigest = integrity.digest;
      state.stagedVersion = null;
      state.candidateVersion = null;
      state.candidateDigest = null;
      state.lastApplyAt = getNow().toISOString();
      state.lastBlocker = null;
      state.status = "applied";
      state.reason = `Successfully applied ${newVersion} with graceful server restart`;
      state.nextRetryAt = null;
      await saveState(state);
      await cleanupOldReleases(newVersion, previousTarget);
      return { applied: true, version: newVersion, state };
    }

    // Completely idle; no servers running. Verify binary and switch symlink
    const testPre = spawnSync(join(stagedTarget, "bin/codex"), ["--version"], {
      env: { PATH: process.env.PATH },
      timeout: 5000,
      encoding: "utf-8",
    });
    if (testPre.status !== 0 || !testPre.stdout.includes(`codex-cli ${newVersion}`)) {
      state.status = "failed";
      state.blockedReason = "blocked_verification";
      state.reason = "Staged executable failed pre-apply version test";
      await saveState(state);
      return { applied: false, reason: "verification_failed", state };
    }

    const tempCurrent = join(getBaseRuntimeDir(), `.current-${process.pid}-${Date.now()}`);
    await symlink(stagedTarget, tempCurrent);
    await rename(tempCurrent, getCurrentLink());

    const testProc = spawnSync(join(getCurrentLink(), "bin/codex"), ["--version"], {
      env: { PATH: process.env.PATH },
      timeout: 5000,
      encoding: "utf-8",
    });

    if (testProc.status !== 0 || !testProc.stdout.includes(`codex-cli ${newVersion}`)) {
      if (previousTarget && existsSync(resolve(getBaseRuntimeDir(), previousTarget))) {
        const rollbackLink = join(getBaseRuntimeDir(), `.rollback-${process.pid}`);
        await symlink(previousTarget, rollbackLink);
        await rename(rollbackLink, getCurrentLink());
      }
      state.status = "failed";
      state.blockedReason = "blocked_verification";
      state.reason = "New version verification failed; rolled back to previous";
      await saveState(state);
      return { applied: false, reason: "verification_failed", state };
    }

    if (previousTarget) {
      try {
        await unlink(getPreviousLink());
      } catch {}
      await symlink(previousTarget, getPreviousLink());
    }

    try {
      await unlink(getStagedLink());
    } catch {}

    state.selectedVersion = newVersion;
      state.selectedDigest = integrity.digest;
    state.stagedVersion = null;
    state.candidateVersion = null;
    state.candidateDigest = null;
    state.idleCheckCount = 0;
    state.restartAttemptCount = 0;
    state.blockedReason = null;
    state.lastApplyAt = getNow().toISOString();
    state.lastBlocker = null;
    state.status = "applied";
    state.reason = `Successfully applied stable Codex version ${newVersion}`;
    state.nextRetryAt = null;
    await saveState(state);

    await cleanupOldReleases(newVersion, previousTarget);

    return {
      applied: true,
      version: newVersion,
      state,
    };
  });
}

export async function cleanupOldReleases(currentVersion, previousTarget) {
  try {
    const releasesDir = resolve(getReleasesDir());
    let realReleasesDir = releasesDir;
    try {
      realReleasesDir = await realpath(releasesDir);
    } catch {}

    const baseDir = resolve(getBaseRuntimeDir());
    const entries = await readdir(releasesDir);
    const keepNames = new Set([basename(currentVersion)]);

    const matchRelease = (targetPath) => {
      if (!targetPath) return null;
      if (targetPath.startsWith(releasesDir + "/")) {
        return targetPath.slice(releasesDir.length + 1).split("/")[0];
      }
      if (targetPath.startsWith(realReleasesDir + "/")) {
        return targetPath.slice(realReleasesDir.length + 1).split("/")[0];
      }
      return null;
    };

    if (previousTarget) {
      keepNames.add(basename(previousTarget));
      const resPrev = resolve(baseDir, previousTarget);
      const rel = matchRelease(resPrev);
      if (rel) keepNames.add(rel);
    }

    // Protect current, previous, and staged symlink targets
    for (const linkPath of [getCurrentLink(), getPreviousLink(), getStagedLink()]) {
      try {
        const rawTarget = await readlink(linkPath);
        const resolvedTarget = resolve(baseDir, rawTarget);
        const rel = matchRelease(resolvedTarget);
        if (rel) keepNames.add(rel);
        try {
          const realTarget = await realpath(resolvedTarget);
          const realRel = matchRelease(realTarget);
          if (realRel) keepNames.add(realRel);
        } catch {}
      } catch {}
    }

    const procDir = process.env.CODEX_PROC_DIR || "/proc";
    let procEntries = [];
    try {
      procEntries = await readdir(procDir);
    } catch {
      // Abort GC fail-closed if procDir cannot be read
      return { deleted: [], deferred: true, reason: "proc_unreadable" };
    }

    const isExitRace = (err) => err && (err.code === "ENOENT" || err.code === "ESRCH");
    const isAccessDenied = (err) => err && (err.code === "EACCES" || err.code === "EPERM");

    const referencedDirs = new Set();
    let hasInspectionError = false;

    for (const p of procEntries) {
      if (!/^\d+$/.test(p)) continue;

      // 1. Check exe
      try {
        const exe = await readlink(`${procDir}/${p}/exe`);
        const rel = matchRelease(exe);
        if (rel) referencedDirs.add(rel);
      } catch (err) {
        if (isAccessDenied(err) || !isExitRace(err)) {
          hasInspectionError = true;
          break;
        }
      }

      // 2. Check cwd
      try {
        const cwd = await readlink(`${procDir}/${p}/cwd`);
        const rel = matchRelease(cwd);
        if (rel) referencedDirs.add(rel);
      } catch (err) {
        if (isAccessDenied(err) || !isExitRace(err)) {
          hasInspectionError = true;
          break;
        }
      }

      // 3. Check open file descriptors (fd/*)
      try {
        const fds = await readdir(`${procDir}/${p}/fd`);
        for (const fd of fds) {
          try {
            const fdTarget = await readlink(`${procDir}/${p}/fd/${fd}`);
            const rel = matchRelease(fdTarget);
            if (rel) referencedDirs.add(rel);
          } catch (err) {
            if (isAccessDenied(err) || !isExitRace(err)) {
              hasInspectionError = true;
              break;
            }
          }
        }
        if (hasInspectionError) break;
      } catch (err) {
        if (isAccessDenied(err) || !isExitRace(err)) {
          hasInspectionError = true;
          break;
        }
      }

      // 4. Check memory mappings (maps)
      try {
        const maps = await readFile(`${procDir}/${p}/maps`, "utf-8");
        for (const line of maps.split("\n")) {
          for (const prefix of [releasesDir + "/", realReleasesDir + "/"]) {
            const idx = line.indexOf(prefix);
            if (idx !== -1) {
              const rel = line.slice(idx + prefix.length).split("/")[0]?.split(" ")[0];
              if (rel) referencedDirs.add(rel);
            }
          }
        }
      } catch (err) {
        if (isAccessDenied(err) || !isExitRace(err)) {
          hasInspectionError = true;
          break;
        }
      }

      // 5. Check cmdline
      try {
        const raw = await readFile(`${procDir}/${p}/cmdline`);
        const cmdParts = raw.toString().split("\0");
        for (const part of cmdParts) {
          const rel = matchRelease(part);
          if (rel) referencedDirs.add(rel);
        }
      } catch (err) {
        if (isAccessDenied(err) || !isExitRace(err)) {
          hasInspectionError = true;
          break;
        }
      }
    }

    if (hasInspectionError) {
      // Abort GC fail-closed: process inspection was denied or uncertain.
      // Releases remain preserved on disk.
      return { deleted: [], deferred: true, reason: "process_inspection_uncertain" };
    }

    const deleted = [];
    for (const entry of entries) {
      if (keepNames.has(entry)) continue;
      if (referencedDirs.has(entry)) continue;
      if (entry.startsWith(currentVersion)) continue;
      if (previousTarget && entry.startsWith(basename(previousTarget))) continue;

      const entryPath = join(releasesDir, entry);
      await rm(entryPath, { recursive: true, force: true }).catch(() => {});
      deleted.push(entry);
    }
    return { deleted, deferred: false };
  } catch {}
}

export async function getStatus() {
  const state = await loadState();
  const sessions = await inspectAllSessions({ readOnly: true });
  const options = await readOptions();
  const appVersion = getAppVersion();
  const bundledVersion = getBundledVersion();

  let procEntries = [];
  let procInspectionFailed = false;
  try {
    procEntries = await readdir("/proc");
  } catch {
    procInspectionFailed = true;
  }

  const activeVersions = new Set();
  let hasUnrecognizedOrUnknown =
    (sessions.counts && sessions.counts.unknown > 0) ||
    (Array.isArray(sessions.blockers) &&
      sessions.blockers.some((b) => b.type === "unknown" || b.type === "inspection_failed"));

  if (!procInspectionFailed) {
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      if (pid === process.pid) continue;
      const proc = await inspectProcess(pid);
      if (!proc) continue;
      if (proc.unknown) {
        hasUnrecognizedOrUnknown = true;
        continue;
      }
      const identity = await executableEntrypoint(proc);
      if (!identity || identity.role !== "primary") continue;
      if (identity.generation === getBaselineDir()) {
        activeVersions.add(bundledVersion);
      } else {
        const match = identity.generation.match(/\/releases\/([^/]+)$/);
        if (match) activeVersions.add(match[1].split("-")[0]);
      }
    }
  }

  const sessionInspectionIncomplete =
    procInspectionFailed ||
    sessions.sessionCount === -1 ||
    hasUnrecognizedOrUnknown;

  let runningVersions = null;
  let runningVersion = "unobserved";
  let runningObservation = "unobserved";

  if (!sessionInspectionIncomplete) {
    runningVersions = Array.from(activeVersions).sort();
    runningVersion = runningVersions.length === 0 ? "none" : runningVersions.join(", ");
    runningObservation = "complete";
  } else if (activeVersions.size > 0) {
    runningVersions = Array.from(activeVersions).sort();
    runningVersion = runningVersions.join(", ") + " (partial)";
    runningObservation = "partial";
  }

  // Cross-reference selectedVersion with actual current symlink and release package metadata
  let verifiedSelectedVersion = null;
  try {
    const currentLink = getCurrentLink();
    if (existsSync(currentLink)) {
      const currentCheck = await validateSymlinkContainment(currentLink);
      if (currentCheck.valid && existsSync(currentCheck.target)) {
        const resolvedTarget = resolve(currentCheck.target);
        if (resolvedTarget === resolve(getBaselineDir())) {
          if (state.selectedVersion && state.selectedVersion === bundledVersion) {
            verifiedSelectedVersion = bundledVersion;
          }
        } else {
          const pkgPath = join(resolvedTarget, "codex-package.json");
          const st = await lstat(pkgPath).catch(() => null);
          if (st && st.isFile()) {
            const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8"));
            if (typeof pkgJson.version === "string" && pkgJson.version.trim()) {
              const ver = pkgJson.version.trim();
              if (state.selectedVersion === ver) {
                verifiedSelectedVersion = ver;
              }
            }
          }
        }
      }
    }
  } catch {}

  return {
    appVersion,
    bundledVersion,
    selectedVersion: verifiedSelectedVersion,
    stagedVersion: state.stagedVersion,
    runningVersion,
    runningVersions,
    runningObservation,
    autoUpdate: options.autoUpdate,
    optionsValid: options.valid,
    timezone: options.timezone,
    budgetDate: state.budgetDate || null,
    idleCheckCount: state.idleCheckCount || 0,
    maxIdleChecks: MAX_IDLE_CHECKS,
    restartAttemptCount: state.restartAttemptCount || 0,
    maxRestartAttempts: MAX_RESTART_ATTEMPTS,
    blockedReason: state.blockedReason || null,
    nextRetryAt: state.nextRetryAt || null,
    nextRestartAllowedAt: state.nextRestartAllowedAt || null,
    lastCheckAt: state.lastCheckAt,
    lastCheckSlot: state.lastCheckSlot,
    lastApplyAt: state.lastApplyAt,
    status: state.status,
    reason: state.reason,
    lastBlocker: state.lastBlocker || null,
    // Compatibility field: unique live Codex task processes (CLI/TUI,
    // managed servers, remote/unmanaged/unknown holders). This is a process
    // count, not a conversation count; owned helper companions are excluded.
    activeSessions: sessions.sessionCount,
    isIdle: sessions.isIdle,
    // Compatibility field: session-level predicate indicating whether live
    // task/session blockers are absent (sessions.canApply).
    // Note: This evaluates only live process blockers; it does not check
    // autoUpdate toggle, staged candidate availability, daily check budget,
    // or restart cooldown. For automated daemon readiness, see autoApplyReady.
    canApply: sessions.canApply,
    autoApplyReady: Boolean(
      options.valid &&
      options.autoUpdate &&
      state.stagedVersion &&
      !state.blockedReason &&
      state.status !== "paused_busy" &&
      (state.idleCheckCount || 0) < MAX_IDLE_CHECKS &&
      sessions.canApply &&
      (sessions.isIdle || !(state.reason === "restart_cooldown" || (state.nextRestartAllowedAt && new Date(state.nextRestartAllowedAt).getTime() > getNow().getTime())))
    ),
    blockerTypes: sessions.blockers.map((b) => b.type),
    processSummary: sessions.counts,
  };
}

export function formatSessionReady(status) {
  if (!status.canApply) {
    return "no (waiting for real sessions or unverifiable processes to exit)";
  }
  if (status.isIdle) {
    return "yes (no Codex processes; manual apply can run now)";
  }
  return "yes (idle managed server(s) eligible for restart; manual apply can restart now if cooldown allows)";
}

export function formatAutoApplyReady(status) {
  if (!status.optionsValid) {
    return "blocked (configuration options invalid)";
  }
  if (!status.autoUpdate) {
    return "disabled (auto-update disabled; manual apply only)";
  }
  if (!status.stagedVersion) {
    return "no (no staged update waiting to apply)";
  }
  if (status.blockedReason) {
    return `blocked (${status.blockedReason})`;
  }
  if (status.status === "paused_busy" || (status.idleCheckCount || 0) >= status.maxIdleChecks) {
    return `paused (daily check budget exhausted; waiting for scheduled retry at ${status.nextRetryAt || "next window"}; manual apply can re-check immediately)`;
  }
  if (!status.canApply) {
    return "deferred (waiting for active sessions or unverifiable processes to clear)";
  }
  const nowMs = getNow().getTime();
  const cooldownActive = Boolean(
    !status.isIdle &&
    (status.reason === "restart_cooldown" || (status.nextRestartAllowedAt && new Date(status.nextRestartAllowedAt).getTime() > nowMs))
  );
  if (cooldownActive) {
    return `waiting (restart cooldown active until ${status.nextRestartAllowedAt || "next window"}; manual apply also respects cooldown)`;
  }
  return "yes (ready for next automatic apply check)";
}

function printApplyGuidance(res) {
  const types = res.blockerTypes || [];
  console.log("  Automatic apply waits until every blocker clears and the next allowed re-check; a manual apply re-checks now and never force-stops sessions.");
  if (types.includes("remote_stdio")) {
    console.log("  A Remote stdio session holds the current version: save your work and close the connection normally; the next check can apply after the process exits.");
  }
  if (types.includes("unknown") || types.includes("inspection_failed")) {
    console.log("  Some processes could not be attributed; they are held conservatively and are never killed automatically.");
  }
  if (types.includes("server_busy")) {
    console.log("  A managed server still has loaded conversations or in-flight work; it must drain before replacement.");
  }
  if (res.reason === "restart_cooldown") {
    console.log("  Only restartable idle managed server(s) remain; replacement waits for the rolling 24-hour restart cooldown.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || "status";

  if (action === "--help" || action === "-h" || action === "help") {
    console.log(`Home Assistant Codex Runtime Manager
Usage: ha-codex-update [COMMAND] [OPTIONS]

Commands:
  status        Show current App, bundled, and active versions, update state, and active sessions
  check         Check official GitHub releases and stage available stable updates
  apply         Apply staged update if active sessions are idle
  update        Perform check and apply in sequence
  init          Ensure runtime directories and symlinks are initialized

Options:
  --json        Output result in JSON format (for status)
  --banner      Output concise one-line status banner
  -h, --help    Show this help message`);
    process.exit(0);
  }

  try {
    if (action === "resolve") {
      const check = await validateSymlinkContainment(getCurrentLink());
      if (!check.valid || !existsSync(check.target)) throw new Error("Selected package integrity check failed");
      const state = await loadState();
      if (resolve(check.target) !== resolve(getBaselineDir())) {
        const integrity = await verifyPackage(check.target, getBaseRuntimeDir(), state.selectedDigest);
        if (!state.selectedDigest || !integrity.valid) throw new Error("Selected package digest missing or invalid");
      }
      console.log(join(check.target, "bin/codex"));
    } else if (action === "init") {
      const state = await initRuntime();
      console.log(JSON.stringify(state, null, 2));
    } else if (action === "status") {
      const status = await getStatus();
      if (args.includes("--json")) {
        console.log(JSON.stringify(status, null, 2));
      } else if (args.includes("--banner")) {
        console.log(`Codex Runtime: bundled ${status.bundledVersion} | selected ${status.selectedVersion} | running ${status.runningVersion} | auto-update ${status.autoUpdate ? "on" : "off"}`);
      } else {
        console.log(`Codex Runtime Status:
  App version:       ${status.appVersion}
  Bundled version:   ${status.bundledVersion}
  Selected version:  ${status.selectedVersion}
  Staged version:    ${status.stagedVersion || "none"}
  Running version:   ${status.runningVersion}
  Auto-update:       ${status.autoUpdate ? "enabled" : "disabled"}${status.optionsValid ? "" : " (options invalid)"}
  Timezone:          ${status.timezone}
  Daily idle checks: ${status.idleCheckCount}/${status.maxIdleChecks} (date: ${status.budgetDate || "n/a"})
  Restart attempts:  ${status.restartAttemptCount}/${status.maxRestartAttempts} (next allowed: ${status.nextRestartAllowedAt || "immediate"})
  Blocked/Paused:    ${status.blockedReason || (status.lastBlocker ? status.status + " (" + status.lastBlocker + ")" : status.status === "paused_busy" ? "paused_busy (daily limit reached)" : "none")}
  Next retry at:     ${status.nextRetryAt || "n/a"}
  Codex processes:   ${status.activeSessions} unique task process(es), ${status.processSummary.helpers} helper(s) owned [CLI/TUI ${status.processSummary.cli}, managed idle server(s) ${status.processSummary.managedIdleServers}, remote stdio ${status.processSummary.remoteStdio}, unmanaged ${status.processSummary.unmanagedAppServers}, unknown ${status.processSummary.unknown}]
  Session ready:     ${formatSessionReady(status)}
  Auto-apply ready:  ${formatAutoApplyReady(status)}
  Status:            ${status.status}
  Reason:            ${status.reason || "none"}
  Last checked:      ${status.lastCheckAt || "never"}
  Last applied:      ${status.lastApplyAt || "never"}`);
      }
    } else if (action === "check") {
      const res = await checkUpdate(null, { isManualRetry: true });
      if (res.upToDate) {
        console.log(`Codex is up to date (${res.currentVersion}).`);
      } else if (res.blocked) {
        console.log(`Codex update blocked: ${res.blockedReason} (${res.state?.reason || ""})`);
      } else {
        console.log(`Successfully staged Codex update: ${res.stagedVersion} (current: ${res.currentVersion})`);
      }
    } else if (action === "apply") {
      const res = await applyUpdate({ isManual: true });
      if (res.applied) {
        console.log(`Successfully applied Codex update: ${res.version}`);
      } else {
        console.log(`Cannot apply update: ${res.reason}`);
        if (res.busyReasons?.length) {
          console.log(`  Reasons: ${res.busyReasons.join(", ")}`);
        }
        printApplyGuidance(res);
      }
    } else if (action === "update") {
      if (args.length > 1 && !args.includes("--json")) {
        console.error(`Unknown option for update: ${args[1]}`);
        process.exit(1);
      }
      const checkRes = await checkUpdate(null, { isManualRetry: true });
      if (checkRes.upToDate) {
        console.log(`Codex is up to date (${checkRes.currentVersion}).`);
      } else if (checkRes.blocked) {
        console.log(`Codex update blocked: ${checkRes.blockedReason}`);
      } else {
        console.log(`Staged update: ${checkRes.stagedVersion}. Checking idle sessions to apply...`);
        const applyRes = await applyUpdate({ isManual: true });
        if (applyRes.applied) {
          console.log(`Successfully applied Codex update: ${applyRes.version}`);
        } else {
        console.log(`Update staged but apply deferred: ${applyRes.reason}`);
        if (applyRes.busyReasons?.length) {
          console.log(`  Reasons: ${applyRes.busyReasons.join(", ")}`);
        }
        printApplyGuidance(applyRes);
        }
      }
    } else {
      console.error(`Unknown command: ${action}. Run with --help for available commands.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || "")) {
  main();
}
