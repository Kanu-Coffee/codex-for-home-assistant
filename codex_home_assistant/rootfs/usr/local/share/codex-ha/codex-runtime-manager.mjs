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
export const APP_VERSION = "0.7.1-dev.2";
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
  if (!existsSync(optionsPath)) {
    return {
      autoUpdate: true,
      timezone: DEFAULT_TIMEZONE,
      valid: true,
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

export async function loadState() {
  const appVersion = getAppVersion();
  const bundledVersion = getBundledVersion();
  try {
    const raw = await readFile(getStateFile(), "utf-8");
    const data = JSON.parse(raw);
    return {
      appVersion,
      bundledVersion,
      selectedDigest: data.selectedDigest || null,
      selectedVersion: data.selectedVersion || bundledVersion,
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
    };
  } catch {
    return {
      appVersion,
      bundledVersion,
      selectedDigest: null,
      selectedVersion: bundledVersion,
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

export async function inspectAllSessions() {
  const busyReasons = [];
  let sessionCount = 0;
  const restartableServers = [];

  const sessionsDir = getSessionsDir();
  if (existsSync(sessionsDir)) {
    try {
      const sessionFiles = await readdir(sessionsDir);
      for (const file of sessionFiles) {
        if (!/^\d+$/.test(file)) continue;
        const pid = parseInt(file, 10);
        const filePath = join(sessionsDir, file);
        try {
          const content = JSON.parse(await readFile(filePath, "utf-8"));
          const proc = await inspectProcess(pid);
          if (!proc) {
            await unlink(filePath).catch(() => {});
            continue;
          }
          if (proc.unknown) {
            sessionCount++;
            busyReasons.push(`registered session pid ${pid} inspection failed: ${proc.error}`);
            continue;
          }
          if (proc.startTime !== content.start) {
            await unlink(filePath).catch(() => {});
            continue;
          }
          if (content.type === "app-server") {
            // App-servers are inspected in the process scan for idle state and restartability
            continue;
          }
          sessionCount++;
          busyReasons.push(`active registered session (pid ${pid})`);
        } catch {
          await unlink(filePath).catch(() => {});
        }
      }
    } catch (err) {
      return {
        isIdle: false,
        sessionCount: -1,
        busyReasons: [`Failed to inspect sessions directory: ${err.message}`],
        restartableServers: [],
      };
    }
  }

  let procEntries = [];
  try {
    procEntries = await readdir("/proc");
  } catch (err) {
    return {
      isIdle: false,
      sessionCount: -1,
      busyReasons: [`Failed to inspect /proc: ${err.message}`],
      restartableServers: [],
    };
  }

  const codexPids = [];
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    const proc = await inspectProcess(pid);
    if (!proc) continue;
    if (proc.unknown) { codexPids.push(proc); continue; }

    let hasSessionRecord = false;
    try {
      if (existsSync(join(getSessionsDir(), String(pid)))) {
        hasSessionRecord = true;
      }
    } catch {}

    const isTestEnv = !!process.env.CODEX_RUNTIME_DIR;
    const baseDir = getBaseRuntimeDir();
    const exeName = basename(proc.exe.replace(/\s+\(deleted\)$/, ""));
    const cmdStr = (proc.cmdline || []).join(" ");

    let isMatch = false;
    if (exeName !== "flock" && !cmdStr.startsWith("flock ")) {
      if (isTestEnv) {
        isMatch =
          hasSessionRecord ||
          proc.exe.startsWith(baseDir) ||
          cmdStr.includes(baseDir);
      } else {
        isMatch =
          hasSessionRecord ||
          proc.exe.startsWith(baseDir) ||
          cmdStr.includes(baseDir) ||
          exeName === "codex" ||
          exeName === "codex-real" ||
          exeName === "ha-codex" ||
          cmdStr.includes("codex-real") ||
          cmdStr.startsWith("codex ") ||
          cmdStr.includes("/bin/codex") ||
          cmdStr.includes("app-server");
      }
    }

    if (isMatch) {
      codexPids.push(proc);
    }
  }

  for (const proc of codexPids) {
    if (proc.unknown) {
      busyReasons.push(`process pid ${proc.pid} state unknown: ${proc.error}`);
      sessionCount++;
      continue;
    }

    const isAppServer = proc.cmdline.includes("app-server");
    if (!isAppServer) {
      busyReasons.push(`active codex cli process (pid ${proc.pid})`);
      sessionCount++;
      continue;
    }

    let socketPath = null;
    const listenIdx = proc.cmdline.indexOf("--listen");
    if (listenIdx !== -1 && proc.cmdline[listenIdx + 1]?.startsWith("unix://")) {
      socketPath = proc.cmdline[listenIdx + 1].slice(7);
    }

    if (!socketPath) {
      busyReasons.push(`active remote stdio app-server (pid ${proc.pid}); restart unsupported, deferred until session exits`);
      sessionCount++;
      continue;
    }

    // Verify explicit App-managed launch record in sessions directory
    const sessionsDir = getSessionsDir();
    const sessionFile = join(sessionsDir, String(proc.pid));
    let managedRecord = null;
    try {
      if (existsSync(sessionFile)) {
        managedRecord = JSON.parse(await readFile(sessionFile, "utf-8"));
      }
    } catch {}

    if (
      !managedRecord ||
      managedRecord.managed !== true ||
      managedRecord.type !== "app-server" ||
      managedRecord.socketPath !== socketPath ||
      managedRecord.pid !== proc.pid ||
      String(managedRecord.start) !== String(proc.startTime)
    ) {
      busyReasons.push(`active unmanaged app-server without verified launch record (pid ${proc.pid}); restart unsupported, deferred until session exits`);
      sessionCount++;
      continue;
    }

    // Verify socket exists and is a unix socket
    try {
      const sockStat = await stat(socketPath);
      if (!sockStat.isSocket()) {
        busyReasons.push(`app-server socket path is not a socket: ${socketPath} (pid ${proc.pid})`);
        sessionCount++;
        continue;
      }
    } catch (err) {
      busyReasons.push(`app-server socket inaccessible: ${err.message} (pid ${proc.pid})`);
      sessionCount++;
      continue;
    }

    const check1 = await inspectAppServer(socketPath, proc.pid);
    if (check1.busy) {
      busyReasons.push(`app-server busy: ${check1.reason} (pid ${proc.pid})`);
      sessionCount++;
      continue;
    }

    await new Promise((r) => setTimeout(r, 1000));
    const check2 = await inspectAppServer(socketPath, proc.pid);
    if (check2.busy) {
      busyReasons.push(`app-server busy: ${check2.reason} (pid ${proc.pid})`);
      sessionCount++;
      continue;
    }

    restartableServers.push({
      pid: proc.pid,
      start: proc.start,
      socketPath,
      proc,
      managedRecord,
    });
    sessionCount++;
  }

  const isIdle = busyReasons.length === 0 && restartableServers.length === 0;

  return {
    isIdle,
    sessionCount,
    busyReasons,
    restartableServers,
  };
}

export function fetchJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const appVersion = getAppVersion();
    const getter = url.startsWith("http://") ? httpGet : httpsGet;
    const req = getter(
      url,
      {
        headers: {
          "User-Agent": `codex-ha-updater/${appVersion} (Home Assistant App)`,
          Accept: "application/vnd.github.v3+json",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson(res.headers.location).then(resolvePromise, rejectPromise);
          return;
        }
        if (res.statusCode !== 200) {
          rejectPromise(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(data));
          } catch (e) {
            rejectPromise(e);
          }
        });
      }
    );
    req.on("error", rejectPromise);
    req.setTimeout(30000, () => {
      req.destroy();
      rejectPromise(new Error(`Timeout fetching ${url}`));
    });
  });
}

export async function downloadAndStagePackage(releaseInfo, customDownloadUrl = null) {
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

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const hasher = createHash("sha256");
      let totalBytes = 0;
      const timeoutTimer = setTimeout(() => {
        rejectPromise(new Error("Download exceeded timeout limit"));
      }, DOWNLOAD_TIMEOUT_MS);

      const downloadReq = (url) => {
        if (url.startsWith("file://")) {
          const filePath = url.slice(7);
          open(tempArchive, "w", 0o600).then((fileHandle) => {
            const outStream = fileHandle.createWriteStream();
            const inStream = createReadStream(filePath);
            inStream.on("data", (chunk) => {
              totalBytes += chunk.length;
              if (totalBytes > MAX_DOWNLOAD_BYTES) {
                clearTimeout(timeoutTimer);
                inStream.destroy();
                rejectPromise(new Error("Package size exceeded maximum allowed limit"));
                return;
              }
              hasher.update(chunk);
            });
            inStream.pipe(outStream);
            outStream.on("finish", () => {
              clearTimeout(timeoutTimer);
              const actualDigest = hasher.digest("hex");
              if (actualDigest !== expectedDigest) {
                rejectPromise(new Error(`SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`));
                return;
              }
              resolvePromise();
            });
            inStream.on("error", (err) => {
              clearTimeout(timeoutTimer);
              rejectPromise(err);
            });
            outStream.on("error", (err) => {
              clearTimeout(timeoutTimer);
              rejectPromise(err);
            });
          }).catch(rejectPromise);
          return;
        }

        const appVersion = getAppVersion();
        const getter = url.startsWith("http://") ? httpGet : httpsGet;
        getter(
          url,
          {
            headers: {
              "User-Agent": `codex-ha-updater/${appVersion} (Home Assistant App)`,
            },
          },
          (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              downloadReq(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              clearTimeout(timeoutTimer);
              rejectPromise(new Error(`HTTP ${res.statusCode} downloading package`));
              return;
            }

            open(tempArchive, "w", 0o600).then((fileHandle) => {
              const stream = fileHandle.createWriteStream();
              res.on("data", (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_DOWNLOAD_BYTES) {
                  clearTimeout(timeoutTimer);
                  res.destroy();
                  rejectPromise(new Error("Package size exceeded maximum allowed limit"));
                  return;
                }
                hasher.update(chunk);
              });

              res.pipe(stream);
              stream.on("finish", () => {
                clearTimeout(timeoutTimer);
                const actualDigest = hasher.digest("hex");
                if (actualDigest !== expectedDigest) {
                  rejectPromise(
                    new Error(
                      `SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`
                    )
                  );
                  return;
                }
                resolvePromise();
              });
              stream.on("error", (err) => {
                clearTimeout(timeoutTimer);
                rejectPromise(err);
              });
            }).catch(rejectPromise);
          }
        ).on("error", (err) => {
          clearTimeout(timeoutTimer);
          rejectPromise(err);
        });
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
    await unlink(tempArchive).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkUpdate(targetVersion = null, options = {}) {
  return withGateLock("exclusive", 15, async () => {
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
      const url = targetVersion
        ? `https://api.github.com/repos/openai/codex/releases/tags/rust-v${targetVersion}`
        : "https://api.github.com/repos/openai/codex/releases/latest";
      releaseData = await fetchJson(url);
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
        options.downloadUrl
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
  return withGateLock("exclusive", 15, async () => {
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
            state.reason = `Candidate ${state.stagedVersion} reached daily idle check limit (${MAX_IDLE_CHECKS} checks for ${state.budgetDate}); restart cooldown active until ${state.nextRestartAllowedAt}`;
            state.nextRetryAt = getNextDayFirstSlotTime(getNow(), tz).toISOString();
            await saveState(state);
            return { applied: false, reason: "paused_busy", state };
          }
        }
        state.status = "paused_restart";
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
      await saveState(state);
      return {
        applied: false,
        reason: state.status,
        busyReasons: sessions.busyReasons,
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
  const sessions = await inspectAllSessions();
  const options = await readOptions();
  const appVersion = getAppVersion();
  const bundledVersion = getBundledVersion();

  let procEntries = [];
  try {
    procEntries = await readdir("/proc");
  } catch {}

  const activeVersions = new Set();
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    const proc = await inspectProcess(pid);
    if (!proc) continue;
    const exeName = basename(proc.exe.replace(/\s+\(deleted\)$/, ""));
    if (exeName === "codex" || exeName === "codex-real") {
      if (proc.exe.includes("/data/codex-runtime/releases/")) {
        const match = proc.exe.match(/\/releases\/([^/]+)/);
        if (match) {
          const v = match[1].split("-")[0];
          activeVersions.add(v);
        }
      } else {
        activeVersions.add(bundledVersion);
      }
    }
  }

  const runningVersions = Array.from(activeVersions);
  const runningVersion = runningVersions.length === 0 ? "none" : runningVersions.join(", ");

  return {
    appVersion,
    bundledVersion,
    selectedVersion: state.selectedVersion,
    stagedVersion: state.stagedVersion,
    runningVersion,
    runningVersions,
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
    activeSessions: sessions.sessionCount,
    isIdle: sessions.isIdle,
  };
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
  Blocked/Paused:    ${status.blockedReason || (status.status === "paused_busy" ? "paused_busy (daily limit reached)" : "none")}
  Next retry at:     ${status.nextRetryAt || "n/a"}
  Active sessions:   ${status.activeSessions} (${status.isIdle ? "idle" : "busy"})
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
