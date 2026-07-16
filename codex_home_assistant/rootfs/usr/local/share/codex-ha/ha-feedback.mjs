import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const SCHEMA_VERSION = "1";
const TARGET_REPOSITORY = "Kanu-Coffee/codex-for-home-assistant";
const PRIVATE_VULNERABILITY_URL =
  "https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new";
const DEFAULT_REPORT_ROOT = "/config/codex-workspace/feedback";
const DEFAULT_GH_CONFIG_DIR = "/data/github-cli";
const DEFAULT_GH_BIN = "/usr/local/bin/gh";
const DEFAULT_PREVIEW_ROOT = "/run/codex-ha/ha-feedback-previews";
const SAFE_OPTIONS_PATH = "/run/codex-ha/ha-feedback-options.json";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const CHECK_STATUSES = new Set([
  "PASS",
  "FAIL",
  "NOT_TESTED",
  "NOT_RUN",
]);
const SAFE_OPTION_KEYS = new Set([
  "web_terminal_auto_start_codex",
  "codex_approval_policy",
  "codex_sandbox_mode",
  "browser_approval_policy",
  "codex_user_files_update_mode",
  "home_assistant_browser_auto_auth",
]);
const COMMON_DRAFT_KEYS = new Set([
  "affected_feature",
  "summary",
  "expected_behavior",
  "actual_behavior",
  "checks",
  "evidence",
  "unverified_scope",
  "security_issue",
  "environment",
  "reproduction_steps",
  "cause_candidates",
  "problem_statement",
  "user_scenarios",
  "current_workaround",
  "existing_capability",
  "alternatives",
  "acceptance_criteria",
  "compatibility_security_impact",
  "validation_plan",
]);

class FeedbackError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "FeedbackError";
    this.exitCode = exitCode;
  }
}

function testOverride(name, fallback) {
  if (process.env.HA_FEEDBACK_TEST_MODE !== "1") return fallback;
  return process.env[name] || fallback;
}

function trustedOwnerUid() {
  if (process.platform === "win32") return null;
  if (
    process.env.HA_FEEDBACK_TEST_MODE === "1" &&
    typeof process.getuid === "function"
  ) {
    return process.getuid();
  }
  return 0;
}

function assertTrustedOwner(stat, label) {
  const expectedUid = trustedOwnerUid();
  if (expectedUid === null || stat.uid === expectedUid) return;
  const expectedOwner = expectedUid === 0 ? "root" : "the test runtime user";
  fail(`${label} must be owned by ${expectedOwner}`, 65);
}

function reportRoot() {
  return path.resolve(testOverride("HA_FEEDBACK_REPORT_ROOT", DEFAULT_REPORT_ROOT));
}

function ghConfigDir() {
  return path.resolve(testOverride("HA_FEEDBACK_GH_CONFIG_DIR", DEFAULT_GH_CONFIG_DIR));
}

function ghBinary() {
  return testOverride("HA_FEEDBACK_GH_BIN", DEFAULT_GH_BIN);
}

function previewRoot() {
  return path.resolve(testOverride("HA_FEEDBACK_PREVIEW_ROOT", DEFAULT_PREVIEW_ROOT));
}

function fail(message, exitCode = 1) {
  throw new FeedbackError(message, exitCode);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a JSON object`, 64);
  }
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains an unsupported field`, 64);
    }
  }
}

function normalizeLine(value, label, maxLength = 300, allowEmpty = false) {
  if (typeof value !== "string") {
    fail(`${label} must be a string`, 64);
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!allowEmpty && normalized.length === 0) {
    fail(`${label} must not be empty`, 64);
  }
  if (normalized.length > maxLength) {
    fail(`${label} is too long`, 64);
  }
  return normalized;
}

function normalizeSingleLine(value, label, maxLength = 200) {
  const normalized = normalizeLine(value, label, maxLength);
  if (normalized.includes("\n")) {
    fail(`${label} must be one line`, 64);
  }
  return normalized;
}

function normalizeStringArray(value, label, maxItems = 30, maxLength = 1200) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must be an array with at most ${maxItems} items`, 64);
  }
  return value.map((item, index) =>
    normalizeLine(item, `${label}[${index}]`, maxLength),
  );
}

function normalizeRequiredStringArray(
  value,
  label,
  maxItems = 30,
  maxLength = 1200,
) {
  const normalized = normalizeStringArray(value, label, maxItems, maxLength);
  if (normalized.length === 0) fail(`${label} must contain at least one item`, 64);
  return normalized;
}

function normalizeChecks(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    fail("checks must contain between 1 and 50 checks", 64);
  }
  return value.map((check, index) => {
    assertPlainObject(check, `checks[${index}]`);
    assertOnlyKeys(
      check,
      new Set(["name", "status", "evidence"]),
      `checks[${index}]`,
    );
    const status = normalizeSingleLine(
      check.status,
      `checks[${index}].status`,
      20,
    );
    if (!CHECK_STATUSES.has(status)) {
      fail(`checks[${index}].status is not an allowed status`, 64);
    }
    return {
      name: normalizeSingleLine(check.name, `checks[${index}].name`, 200),
      status,
      evidence: normalizeLine(
        check.evidence,
        `checks[${index}].evidence`,
        1500,
      ),
    };
  });
}

function normalizeVersion(value, label) {
  if (value === null || value === undefined || value === "") {
    return "NOT_COLLECTED";
  }
  const normalized = normalizeSingleLine(String(value), label, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+ -]{0,79}$/.test(normalized)) {
    fail(`${label} contains unsupported characters`, 64);
  }
  return normalized;
}

function normalizeAppOptions(value) {
  if (value === undefined || value === null) {
    return {};
  }
  assertPlainObject(value, "environment.app_options");
  const options = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!SAFE_OPTION_KEYS.has(key)) {
      fail("environment.app_options contains a non-allowlisted option", 64);
    }
    if (typeof rawValue !== "boolean" && typeof rawValue !== "string") {
      fail("environment.app_options values must be strings or booleans", 64);
    }
    const normalizedValue =
      typeof rawValue === "string"
        ? normalizeSingleLine(rawValue, `environment.app_options.${key}`, 64)
        : rawValue;
    options[key] = normalizedValue;
  }
  return options;
}

function normalizeEnvironment(value = {}) {
  assertPlainObject(value, "environment");
  assertOnlyKeys(
    value,
    new Set([
      "app_version",
      "codex_version",
      "core_version",
      "supervisor_version",
      "os_version",
      "arch",
      "app_options",
    ]),
    "environment",
  );
  return {
    app_version: normalizeVersion(value.app_version, "environment.app_version"),
    codex_version: normalizeVersion(
      value.codex_version,
      "environment.codex_version",
    ),
    core_version: normalizeVersion(
      value.core_version,
      "environment.core_version",
    ),
    supervisor_version: normalizeVersion(
      value.supervisor_version,
      "environment.supervisor_version",
    ),
    os_version: normalizeVersion(value.os_version, "environment.os_version"),
    arch: normalizeVersion(value.arch, "environment.arch"),
    app_options: normalizeAppOptions(value.app_options),
  };
}

function normalizeDraft(kind, input) {
  if (!new Set(["bug", "feature"]).has(kind)) {
    fail("kind must be bug or feature", 64);
  }
  assertPlainObject(input, "input");
  assertOnlyKeys(input, COMMON_DRAFT_KEYS, "input");
  const common = {
    affected_feature: normalizeSingleLine(
      input.affected_feature,
      "affected_feature",
      160,
    ),
    summary: normalizeSingleLine(input.summary, "summary", 180),
    expected_behavior: normalizeLine(
      input.expected_behavior,
      "expected_behavior",
      3000,
    ),
    actual_behavior: normalizeLine(
      input.actual_behavior,
      "actual_behavior",
      3000,
    ),
    checks: normalizeChecks(input.checks),
    evidence: normalizeStringArray(input.evidence ?? [], "evidence", 30, 1800),
    unverified_scope: normalizeStringArray(
      input.unverified_scope ?? [],
      "unverified_scope",
      30,
      1200,
    ),
    security_issue: input.security_issue,
    environment: normalizeEnvironment(input.environment ?? {}),
  };

  if (typeof input.security_issue !== "boolean") {
    fail("security_issue must be a boolean", 64);
  }

  if (kind === "bug") {
    return {
      ...common,
      reproduction_steps: normalizeRequiredStringArray(
        input.reproduction_steps,
        "reproduction_steps",
        30,
        1200,
      ),
      cause_candidates: normalizeRequiredStringArray(
        input.cause_candidates,
        "cause_candidates",
        20,
        1200,
      ),
    };
  }

  return {
    ...common,
    problem_statement: normalizeLine(
      input.problem_statement,
      "problem_statement",
      3000,
    ),
    user_scenarios: normalizeRequiredStringArray(
      input.user_scenarios,
      "user_scenarios",
      30,
      1200,
    ),
    current_workaround: normalizeLine(
      input.current_workaround,
      "current_workaround",
      2000,
    ),
    existing_capability: normalizeLine(
      input.existing_capability,
      "existing_capability",
      2000,
    ),
    alternatives: normalizeRequiredStringArray(
      input.alternatives,
      "alternatives",
      30,
      1200,
    ),
    acceptance_criteria: normalizeRequiredStringArray(
      input.acceptance_criteria,
      "acceptance_criteria",
      30,
      1200,
    ),
    compatibility_security_impact: normalizeLine(
      input.compatibility_security_impact,
      "compatibility_security_impact",
      2500,
    ),
    validation_plan: normalizeRequiredStringArray(
      input.validation_plan,
      "validation_plan",
      30,
      1200,
    ),
  };
}

const PRIVACY_PATTERNS = [
  ["control_character", /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/u],
  ["ansi_escape", /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/u],
  ["format_control", /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u],
  ["authorization_or_cookie", /\b(?:authorization|cookie)["']?\s*[:=]/iu],
  ["session_cookie", /\b(?:session(?:id)?|csrf|xsrf)[_-]?(?:token|id)?["']?\s*[:=]\s*["']?\S+/iu],
  ["assigned_secret", /\b(?:(?:access|refresh|client|github|supervisor|home[_ -]?assistant)[_ -]?(?:token|secret)|token|password|secret|api[_ -]?key)["']?\s*[:=]\s*["']?\S+/iu],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["api_token", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ["cloud_service_token", /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9]{24,})\b/u],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u],
  ["private_or_ssh_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{20,}/u],
  ["base64_blob", /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{64,}={0,2}(?:$|[^A-Za-z0-9+/])/u],
  ["base64url_blob", /(?:^|[^A-Za-z0-9_-])(?=[A-Za-z0-9_-]{64,}(?:$|[^A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[-_])[A-Za-z0-9_-]{64,}(?:$|[^A-Za-z0-9_-])/u],
  ["url", /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>()]+|\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d+)?(?:\/[^\s<>()]*)?|\bmailto:[^\s<>()]+/iu],
  ["hostname_or_url", /\b(?:(?:localhost|supervisor|homeassistant)(?::\d{1,5}|\/[^\s<>()]+)|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|home|invalid)(?::\d{1,5})?(?:\/[^\s<>()]*)?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5}|\/[^\s<>()]+))/iu],
  ["ipv4", /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u],
  ["ipv6", /(?:\b(?:[A-Fa-f0-9]{1,4}:){3,}[A-Fa-f0-9:]{1,39}\b|(?<!:):{2}[A-Fa-f0-9:]*\b)/u],
  ["email_or_user_identifier", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["at_user_handle", /(?:^|[^A-Za-z0-9_@])@[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,37}[A-Za-z0-9_])?\b/u],
  ["username_assignment", /\b(?:username|user_name|login|account)["']?\s*[:=]\s*["']?\S+/iu],
  ["ha_identifier_assignment", /\b(?:entity|device|area|user)_id["']?\s*[:=]\s*["']?[A-Za-z0-9_.:-]+/iu],
  ["device_identifier_assignment", /\b(?:serial(?:_number)?|imei|imsi|eui(?:64)?|mac(?:_address)?|device_identifier)["']?\s*[:=]\s*["']?\S+/iu],
  ["ha_entity_identifier", /\b(?:ai_task|air_quality|alarm_control_panel|assist_satellite|automation|binary_sensor|button|calendar|camera|climate|conversation|counter|cover|date|datetime|device_tracker|event|fan|geo_location|group|humidifier|image|image_processing|input_boolean|input_button|input_datetime|input_number|input_select|input_text|lawn_mower|light|lock|media_player|notify|number|person|plant|proximity|remote|scene|schedule|script|select|sensor|siren|stt|sun|switch|text|time|timer|todo|tts|update|vacuum|valve|wake_word|water_heater|weather|zone)\.[a-z0-9_]+\b/iu],
  ["device_identifier", /\b(?:(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}|(?:[0-9A-F]{2}[:-]){7}[0-9A-F]{2}|[0-9A-F]{12}|[0-9A-F]{16})\b/iu],
  ["uuid_identifier", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu],
  ["sensitive_path", /(?:^|[\\/])(?:auth\.json|\.storage|secrets\.ya?ml|home-assistant_v2\.db|backups?)(?:$|[\\/\s])/iu],
];

function walkStringValues(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStringValues(item, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) walkStringValues(item, visit);
  }
}

function privacyFindings(value) {
  const findings = new Set();
  walkStringValues(value, (text) => {
    for (const [name, pattern] of PRIVACY_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) findings.add(name);
    }
    for (const match of text.matchAll(/\b[1-4]\d{9}\b/gu)) {
      const numeric = Number(match[0]);
      if (numeric <= 4_294_967_295) findings.add("decimal_ipv4");
    }
  });
  return [...findings].sort();
}

function assertPrivacy(value) {
  const findings = privacyFindings(value);
  if (findings.length > 0) {
    fail(
      `privacy validation blocked the report (${findings.join(", ")}); remove or generalize the flagged data`,
      65,
    );
  }
}

function readRegularPrivateFile(filePath, maxBytes, label) {
  let initialStat;
  try {
    initialStat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is not readable`, 66);
  }
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.nlink !== 1) {
    fail(`${label} must be a regular single-link file`, 65);
  }
  assertTrustedOwner(initialStat, label);
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch {
    fail(`${label} is not readable without following links`, 65);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== initialStat.dev ||
      stat.ino !== initialStat.ino
    ) {
      fail(`${label} changed or is not a regular single-link file`, 65);
    }
    if (stat.size > maxBytes) fail(`${label} is too large`, 65);
    assertTrustedOwner(stat, label);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      fail(`${label} must use private mode 0600`, 65);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(candidate, includeFinal = true) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  const limit = includeFinal ? parts.length : Math.max(parts.length - 1, 0);
  for (let index = 0; index < limit; index += 1) {
    cursor = path.join(cursor, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      fail("managed path could not be inspected safely", 65);
    }
    if (stat.isSymbolicLink()) fail("managed path contains a symbolic link", 65);
    if (index < limit - 1 && !stat.isDirectory()) {
      fail("managed path contains a non-directory component", 65);
    }
  }
}

function readJsonInput(filePath) {
  if (filePath === "-") fail("collect input must be a private 0600 file, not stdin", 64);
  const absolute = path.resolve(filePath);
  assertNoSymlinkComponents(absolute);
  const source = readRegularPrivateFile(
    absolute,
    MAX_INPUT_BYTES,
    "input file",
  );
  try {
    return JSON.parse(source);
  } catch {
    fail("input is not valid JSON", 65);
  }
}

function assertPathInside(candidate, parent, label) {
  const relative = path.relative(parent, candidate);
  if (relative === "" || relative === ".") return;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail(`${label} escapes the managed directory`, 65);
  }
}

function ensureDirectoryNoLinks(directory, mode = 0o700) {
  const absolute = path.resolve(directory);
  assertNoSymlinkComponents(absolute);
  const missing = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail("managed directory has no existing parent", 65);
    cursor = parent;
  }
  const ancestor = fs.lstatSync(cursor);
  if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
    fail("managed directory parent is unsafe", 65);
  }
  for (const target of missing.reverse()) {
    fs.mkdirSync(target, { mode });
    const created = fs.lstatSync(target);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      fail("managed directory creation was unsafe", 65);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("managed path must be a real directory", 65);
  }
  assertTrustedOwner(stat, "managed directory");
  fs.chmodSync(absolute, mode);
  assertNoSymlinkComponents(absolute);
  return absolute;
}

function writeExclusivePrivate(filePath, contents) {
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, flags, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    );
    fs.fsyncSync(descriptor);
  } catch {
    fail("managed directory state could not be made durable", 65);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function replacePrivateFile(filePath, contents) {
  let stat = null;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("managed output file cannot be inspected safely", 65);
  }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail("managed output file is unsafe", 65);
    }
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  writeExclusivePrivate(temporary, contents);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original error is more useful and contains no report content.
    }
    throw error;
  }
}

function writePrivateNewAtomically(filePath, contents) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  writeExclusivePrivate(temporary, contents);
  try {
    // A hard link supplies no-replace semantics that renameSync lacks. The
    // temporary name is removed before the managed file is accepted, leaving
    // the final receipt as a single-link private file.
    fs.linkSync(temporary, filePath);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original error; the caller keeps the uncertainty claim.
    }
    throw error;
  }
  const persisted = readRegularPrivateFile(
    filePath,
    MAX_REPORT_BYTES,
    path.basename(filePath),
  );
  if (persisted !== contents) {
    fail("managed output did not persist exactly", 65);
  }
}

function safeReadSmallFile(filePath, maxBytes = 4096) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function readSafeOptions() {
  // The init service writes only the six allowlisted, non-secret values here.
  // The collector never opens the original App options file.
  try {
    fs.lstatSync(SAFE_OPTIONS_PATH);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    fail("allowlisted App option snapshot cannot be inspected safely", 65);
  }
  const raw = readRegularPrivateFile(
    SAFE_OPTIONS_PATH,
    16 * 1024,
    "allowlisted App option snapshot",
  ).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const selected = {};
    for (const key of SAFE_OPTION_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" || typeof value === "boolean") {
        selected[key] = value;
      }
    }
    return normalizeAppOptions(selected);
  } catch {
    return {};
  }
}

function readCodexVersion() {
  try {
    const output = childProcess.execFileSync(
      "/usr/local/libexec/codex-real",
      ["--version"],
      {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 4096,
        env: {
          HOME: "/data/home",
          CODEX_HOME: "/data/codex",
          LANG: "C.UTF-8",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      },
    ).trim();
    const match = /^codex-cli\s+([A-Za-z0-9._+-]+)$/u.exec(output);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function supervisorRequest(endpoint) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || /[\r\n]/u.test(token)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = http.request(
      {
        protocol: "http:",
        hostname: "supervisor",
        port: 80,
        path: endpoint,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: 1500,
      },
      (response) => {
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 1024 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (size > 1024 * 1024 || response.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed?.result === "ok" && isPlainObject(parsed.data) ? parsed.data : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
}

async function collectEnvironment(fallback) {
  // Query one read-only endpoint and retain only the allowlisted version/arch
  // fields below. Diagnostics, logs, registries, and user config are not read.
  const systemInfo = await supervisorRequest("/info");
  const localAppVersion = safeReadSmallFile(
    "/usr/local/share/codex-ha/app-version",
    128,
  );
  const detectedArch = process.arch === "x64" ? "amd64" : process.arch;
  return normalizeEnvironment({
    app_version: localAppVersion || fallback.app_version,
    codex_version: readCodexVersion() || fallback.codex_version,
    core_version: systemInfo?.homeassistant || fallback.core_version,
    supervisor_version: systemInfo?.supervisor || fallback.supervisor_version,
    os_version: systemInfo?.hassos || fallback.os_version,
    arch: systemInfo?.arch || detectedArch || fallback.arch,
    app_options: {
      ...fallback.app_options,
      ...readSafeOptions(),
    },
  });
}

function overallAssessment(checks) {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.every((check) => check.status === "NOT_RUN")) return "NOT_RUN";
  if (checks.some((check) => check.status !== "PASS")) return "PARTIAL";
  return "PASS";
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#!~])/gu, "\\$1")
    .replace(/^([ \t]*)([-+.])(?=\s)/gmu, "$1\\$2")
    .replace(/^([ \t]*\d+)\.(?=\s)/gmu, "$1\\.")
    .replace(/^([ \t]*)=(?==*[ \t]*$)/gmu, "$1\\=");
}

function tableValue(value) {
  return escapeMarkdown(value).replaceAll("|", "\\|").replace(/\s*\n\s*/gu, " ");
}

function renderList(items, emptyText = "- None reported / 보고 없음") {
  if (items.length === 0) return emptyText;
  return items.map((item) => `- ${escapeMarkdown(item)}`).join("\n");
}

function githubTitle(report) {
  const prefix = report.kind === "bug" ? "[Bug]" : "[Feature]";
  return `${prefix} ${report.summary}`.slice(0, 220);
}

function renderReport(report) {
  const environmentRows = [
    ["App", report.environment.app_version],
    ["Codex", report.environment.codex_version],
    ["Home Assistant Core", report.environment.core_version],
    ["Supervisor", report.environment.supervisor_version],
    ["Home Assistant OS", report.environment.os_version],
    ["Architecture", report.environment.arch],
  ];
  const optionRows = Object.entries(report.environment.app_options).map(
    ([key, value]) => [key, String(value)],
  );
  const checkRows = report.checks
    .map(
      (check) =>
        `| ${check.status} | ${tableValue(check.name)} | ${tableValue(check.evidence || "-")} |`,
    )
    .join("\n");
  const lines = [
    `# ${escapeMarkdown(githubTitle(report))}`,
    "",
    `<!-- ha-feedback schema=${report.schema_version} report_id=${report.report_id} -->`,
    "",
    `- Report ID / 보고서 ID: \`${report.report_id}\``,
    `- Created (UTC) / 생성 시각: \`${report.created_at}\``,
    `- Overall assessment / 전체 판정: **${overallAssessment(report.checks)}**`,
    "- Privacy validation / 개인정보 검사: **PASS** (final human review still required / 최종 사용자 검토 필요)",
    "",
    "## Affected feature / 영향 기능",
    "",
    escapeMarkdown(report.affected_feature),
    "",
    "## Summary / 요약",
    "",
    escapeMarkdown(report.summary),
    "",
    "## Environment / 환경",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...environmentRows.map(([key, value]) => `| ${key} | ${tableValue(value)} |`),
    "",
    "### Safe App options / 공개 가능한 App 옵션",
    "",
    optionRows.length > 0
      ? ["| Option | Value |", "| --- | --- |", ...optionRows.map(([key, value]) => `| ${key} | ${tableValue(value)} |`)].join("\n")
      : "- NOT_COLLECTED",
    "",
    "## Expected behavior / 기대 동작",
    "",
    escapeMarkdown(report.expected_behavior),
    "",
    "## Actual behavior / 실제 동작",
    "",
    escapeMarkdown(report.actual_behavior),
    "",
  ];

  if (report.kind === "bug") {
    lines.push(
      "## Cause candidates / 원인 후보",
      "",
      renderList(report.cause_candidates),
      "",
      "## Reproduction steps / 재현 단계",
      "",
      report.reproduction_steps
        .map((step, index) => `${index + 1}. ${escapeMarkdown(step)}`)
        .join("\n"),
      "",
    );
  } else {
    lines.push(
      "## Problem statement / 문제 정의",
      "",
      escapeMarkdown(report.problem_statement),
      "",
      "## User scenarios / 사용자 시나리오",
      "",
      renderList(report.user_scenarios),
      "",
      "## Current workaround / 현재 우회법",
      "",
      escapeMarkdown(report.current_workaround),
      "",
      "## Existing capability check / 기존 기능 확인",
      "",
      escapeMarkdown(report.existing_capability),
      "",
      "## Alternatives considered / 검토한 대안",
      "",
      renderList(report.alternatives),
      "",
      "## Acceptance criteria / 수용 기준",
      "",
      renderList(report.acceptance_criteria),
      "",
      "## Compatibility and security impact / 호환성·보안 영향",
      "",
      escapeMarkdown(report.compatibility_security_impact),
      "",
      "## Validation plan / 검증 계획",
      "",
      renderList(report.validation_plan),
      "",
    );
  }

  lines.push(
    "## Checks performed / 수행 검사",
    "",
    "| Status | Check | Evidence |",
    "| --- | --- | --- |",
    checkRows,
    "",
    "## Evidence / 증거",
    "",
    renderList(report.evidence),
    "",
    "## Unverified scope / 미검증 범위",
    "",
    renderList(report.unverified_scope),
    "",
    "## Submission declarations / 제출 확인",
    "",
    "- [x] The report was generated with the read-only `$ha-feedback` workflow or equivalent manual checks.",
    "- [x] Logs and screenshots are not included by default and no file is uploaded automatically.",
    "- [x] Automated privacy validation passed; the submitter must review this exact body again before publication.",
    `- [${report.security_issue ? " " : "x"}] This is not a security vulnerability.`,
    "",
  );
  if (report.security_issue) {
    lines.push(
      "> Public submission is blocked because this report is marked as a possible security issue. Follow the private vulnerability reporting route in SECURITY.md.",
      "",
    );
  }
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function validateGeneratedReport(value) {
  assertPlainObject(value, "report");
  const baseKeys = new Set([
    "schema_version",
    "report_id",
    "kind",
    "created_at",
    "affected_feature",
    "summary",
    "environment",
    "expected_behavior",
    "actual_behavior",
    "checks",
    "evidence",
    "unverified_scope",
    "privacy",
    "security_issue",
  ]);
  if (value.kind === "bug") {
    baseKeys.add("reproduction_steps");
    baseKeys.add("cause_candidates");
  }
  if (value.kind === "feature") {
    for (const key of [
      "problem_statement",
      "user_scenarios",
      "current_workaround",
      "existing_capability",
      "alternatives",
      "acceptance_criteria",
      "compatibility_security_impact",
      "validation_plan",
    ]) baseKeys.add(key);
  }
  assertOnlyKeys(value, baseKeys, "report");
  if (value.schema_version !== SCHEMA_VERSION) fail("unsupported report schema", 65);
  if (!/^hf_[a-f0-9]{16}$/u.test(value.report_id)) fail("invalid report ID", 65);
  if (!new Set(["bug", "feature"]).has(value.kind)) fail("invalid report kind", 65);
  if (Number.isNaN(Date.parse(value.created_at))) fail("invalid report timestamp", 65);
  if (new Date(value.created_at).toISOString() !== value.created_at) {
    fail("report timestamp must use canonical UTC ISO format", 65);
  }
  assertPlainObject(value.privacy, "privacy");
  assertOnlyKeys(
    value.privacy,
    new Set(["status", "findings", "review_required"]),
    "privacy",
  );
  if (
    value.privacy.status !== "PASS" ||
    !Array.isArray(value.privacy.findings) ||
    value.privacy.findings.length !== 0 ||
    value.privacy.review_required !== true
  ) {
    fail("report privacy decision is not publishable", 65);
  }
  const draftInput = {
    affected_feature: value.affected_feature,
    summary: value.summary,
    expected_behavior: value.expected_behavior,
    actual_behavior: value.actual_behavior,
    checks: value.checks,
    evidence: value.evidence,
    unverified_scope: value.unverified_scope,
    security_issue: value.security_issue,
    environment: value.environment,
    ...(value.kind === "bug"
      ? {
          reproduction_steps: value.reproduction_steps,
          cause_candidates: value.cause_candidates,
        }
      : {
          problem_statement: value.problem_statement,
          user_scenarios: value.user_scenarios,
          current_workaround: value.current_workaround,
          existing_capability: value.existing_capability,
          alternatives: value.alternatives,
          acceptance_criteria: value.acceptance_criteria,
          compatibility_security_impact: value.compatibility_security_impact,
          validation_plan: value.validation_plan,
        }),
  };
  const normalized = normalizeDraft(value.kind, draftInput);
  const report = {
    schema_version: SCHEMA_VERSION,
    report_id: value.report_id,
    kind: value.kind,
    created_at: new Date(value.created_at).toISOString(),
    affected_feature: normalized.affected_feature,
    summary: normalized.summary,
    environment: normalized.environment,
    expected_behavior: normalized.expected_behavior,
    actual_behavior: normalized.actual_behavior,
    checks: normalized.checks,
    evidence: normalized.evidence,
    unverified_scope: normalized.unverified_scope,
    privacy: { status: "PASS", findings: [], review_required: true },
    security_issue: normalized.security_issue,
    ...(value.kind === "bug"
      ? {
          reproduction_steps: normalized.reproduction_steps,
          cause_candidates: normalized.cause_candidates,
        }
      : {
          problem_statement: normalized.problem_statement,
          user_scenarios: normalized.user_scenarios,
          current_workaround: normalized.current_workaround,
          existing_capability: normalized.existing_capability,
          alternatives: normalized.alternatives,
          acceptance_criteria: normalized.acceptance_criteria,
          compatibility_security_impact: normalized.compatibility_security_impact,
          validation_plan: normalized.validation_plan,
        }),
  };
  assertPrivacy(report);
  return report;
}

async function collectCommand(kind, inputPath) {
  const draft = normalizeDraft(kind, readJsonInput(inputPath));
  assertPrivacy({ ...draft, environment: undefined });
  const environment = await collectEnvironment(draft.environment);
  const now = new Date();
  const reportId = `hf_${crypto.randomBytes(8).toString("hex")}`;
  const report = validateGeneratedReport({
    schema_version: SCHEMA_VERSION,
    report_id: reportId,
    kind,
    created_at: now.toISOString(),
    affected_feature: draft.affected_feature,
    summary: draft.summary,
    environment,
    expected_behavior: draft.expected_behavior,
    actual_behavior: draft.actual_behavior,
    checks: draft.checks,
    evidence: draft.evidence,
    unverified_scope: draft.unverified_scope,
    privacy: { status: "PASS", findings: [], review_required: true },
    security_issue: draft.security_issue,
    ...(kind === "bug"
      ? {
          reproduction_steps: draft.reproduction_steps,
          cause_candidates: draft.cause_candidates,
        }
      : {
          problem_statement: draft.problem_statement,
          user_scenarios: draft.user_scenarios,
          current_workaround: draft.current_workaround,
          existing_capability: draft.existing_capability,
          alternatives: draft.alternatives,
          acceptance_criteria: draft.acceptance_criteria,
          compatibility_security_impact: draft.compatibility_security_impact,
          validation_plan: draft.validation_plan,
        }),
  });
  const root = ensureDirectoryNoLinks(reportRoot());
  const directory = path.join(
    root,
    `${compactTimestamp(now)}-${kind}-${reportId}`,
  );
  assertPathInside(directory, root, "report directory");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const reportPath = path.join(directory, "report.json");
  const publicPath = path.join(directory, "public-report.md");
  writeExclusivePrivate(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeExclusivePrivate(publicPath, renderReport(report));
  return {
    report_id: reportId,
    kind,
    privacy: "PASS",
    security_issue: report.security_issue,
    report_directory: directory,
    report_json: reportPath,
    public_report: publicPath,
  };
}

function resolveReport(inputPath) {
  const root = ensureDirectoryNoLinks(reportRoot());
  const absoluteInput = path.resolve(inputPath);
  assertNoSymlinkComponents(absoluteInput);
  let reportPath = absoluteInput;
  let inputStat;
  try {
    inputStat = fs.lstatSync(absoluteInput);
  } catch {
    fail("report path does not exist", 66);
  }
  if (inputStat.isDirectory() && !inputStat.isSymbolicLink()) {
    reportPath = path.join(absoluteInput, "report.json");
  }
  assertNoSymlinkComponents(reportPath);
  let realRoot;
  let realReport;
  try {
    realRoot = fs.realpathSync(root);
    realReport = fs.realpathSync(reportPath);
  } catch {
    fail("managed report.json does not exist or cannot be resolved safely", 66);
  }
  assertPathInside(realReport, realRoot, "report path");
  const reportDirectory = path.dirname(realReport);
  if (path.dirname(reportDirectory) !== realRoot) {
    fail("report bundle must be a direct child of the managed report root", 65);
  }
  assertNoSymlinkComponents(reportDirectory);
  const directoryStat = fs.lstatSync(reportDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("report directory is unsafe", 65);
  }
  assertTrustedOwner(directoryStat, "report directory");
  if (process.platform !== "win32" && (directoryStat.mode & 0o777) !== 0o700) {
    fail("report directory must use private mode 0700", 65);
  }
  const source = readRegularPrivateFile(realReport, MAX_REPORT_BYTES, "report.json");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("report.json is not valid JSON", 65);
  }
  const report = validateGeneratedReport(parsed);
  const expectedDirectoryName = `${compactTimestamp(new Date(report.created_at))}-${report.kind}-${report.report_id}`;
  if (path.basename(reportDirectory) !== expectedDirectoryName) {
    fail("report directory name does not match the immutable report identity", 65);
  }
  return {
    report,
    reportDirectory,
    reportPath: realReport,
    publicPath: path.join(reportDirectory, "public-report.md"),
    submissionPath: path.join(reportDirectory, "submission.json"),
    claimPath: path.join(reportDirectory, ".submission.lock"),
  };
}

function validateCommand(inputPath) {
  const resolved = resolveReport(inputPath);
  const expected = renderReport(resolved.report);
  const current = readRegularPrivateFile(
    resolved.publicPath,
    MAX_REPORT_BYTES,
    "public-report.md",
  );
  if (current !== expected) fail("public-report.md does not match report.json", 65);
  return {
    valid: true,
    report_id: resolved.report.report_id,
    kind: resolved.report.kind,
    privacy: "PASS",
    public_report: resolved.publicPath,
  };
}

function renderCommand(inputPath) {
  const resolved = resolveReport(inputPath);
  replacePrivateFile(resolved.publicPath, renderReport(resolved.report));
  return {
    rendered: true,
    report_id: resolved.report.report_id,
    public_report: resolved.publicPath,
  };
}

function secureGhConfigTree(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("GitHub CLI config directory is unsafe", 65);
  assertTrustedOwner(stat, "GitHub CLI config directory");
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink()) fail("GitHub CLI config contains a symbolic link", 65);
    assertTrustedOwner(targetStat, "GitHub CLI config entry");
    if (targetStat.isDirectory()) {
      secureGhConfigTree(target);
    } else if (targetStat.isFile() && targetStat.nlink === 1) {
      fs.chmodSync(target, 0o600);
    } else {
      fail("GitHub CLI config contains an unsafe file", 65);
    }
  }
}

function ensureGhConfig() {
  const directory = ensureDirectoryNoLinks(ghConfigDir());
  secureGhConfigTree(directory);
  return directory;
}

function cleanGhEnvironment() {
  return {
    HOME: "/data/home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    GH_CONFIG_DIR: ensureGhConfig(),
    NO_COLOR: "1",
  };
}

function runGhCaptured(arguments_, timeout = 15_000, input = undefined) {
  const result = childProcess.spawnSync(ghBinary(), arguments_, {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    env: cleanGhEnvironment(),
    input,
  });
  if (result.error) {
    return { status: 127, stdout: "", stderr: "GitHub CLI execution failed" };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function githubStatus() {
  const result = runGhCaptured(["auth", "status", "--hostname", "github.com"]);
  return {
    authenticated: result.status === 0,
    hostname: "github.com",
    config_directory: ghConfigDir(),
    credential_storage: "opt-in persistent App data; may be included in App backups",
  };
}

async function confirmationQuestion(prompt, bypass) {
  if (bypass) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("interactive confirmation is required (or pass the documented explicit confirmation flag)", 64);
  }
  const interface_ = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await interface_.question(`${prompt} [y/N] `)).trim().toLowerCase();
    if (!new Set(["y", "yes"]).has(answer)) fail("operation cancelled", 2);
  } finally {
    interface_.close();
  }
}

async function githubLogin(confirmed) {
  await confirmationQuestion(
    "GitHub CLI credentials will be stored under /data/github-cli and may be included in Home Assistant App backups. Continue with browser/device login?",
    confirmed,
  );
  const result = childProcess.spawnSync(
    ghBinary(),
    [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--skip-ssh-key",
      "--insecure-storage",
    ],
    { stdio: "inherit", env: cleanGhEnvironment() },
  );
  secureGhConfigTree(ghConfigDir());
  if (result.error || result.status !== 0) fail("GitHub CLI login did not complete", 69);
  return githubStatus();
}

async function githubLogout(confirmed) {
  await confirmationQuestion(
    "Remove the persisted github.com login from /data/github-cli?",
    confirmed,
  );
  const result = childProcess.spawnSync(
    ghBinary(),
    ["auth", "logout", "--hostname", "github.com"],
    { stdio: "inherit", env: cleanGhEnvironment() },
  );
  secureGhConfigTree(ghConfigDir());
  if (result.error || result.status !== 0) fail("GitHub CLI logout did not complete", 69);
  return githubStatus();
}

function webFallback(resolved) {
  if (resolved.report.security_issue) {
    return {
      blocked: true,
      reason: "possible_security_vulnerability",
      private_reporting_url: PRIVATE_VULNERABILITY_URL,
    };
  }
  const template =
    resolved.report.kind === "bug" ? "bug_report.yml" : "feature_request.yml";
  const parameters = new URLSearchParams({
    template,
    title: githubTitle(resolved.report),
    app_version: resolved.report.environment.app_version,
    verification_route:
      "Codex 검증 Skill 완료 / Codex verification Skill completed",
  });
  if (resolved.report.kind === "bug") {
    parameters.set(
      "home_assistant_version",
      `Core ${resolved.report.environment.core_version}, OS ${resolved.report.environment.os_version}`,
    );
  } else {
    parameters.set(
      "environment",
      `Core ${resolved.report.environment.core_version}; OS ${resolved.report.environment.os_version}; arch ${resolved.report.environment.arch}`,
    );
  }
  return {
    url: `https://github.com/${TARGET_REPOSITORY}/issues/new?${parameters.toString()}`,
    template,
    copy_report_from: resolved.publicPath,
    note: "The long report is intentionally not placed in the URL; review and paste public-report.md into the Issue Form.",
  };
}

function sanitizedCandidateTitle(candidate) {
  const raw = typeof candidate.title === "string" ? candidate.title : "";
  if (raw.length === 0 || privacyFindings(raw).length > 0) {
    return `Possible matching issue #${candidate.number}`;
  }
  return raw.replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 200);
}

function issueCandidates(report) {
  const words = `${report.summary} ${report.affected_feature}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length >= 2)
    .slice(0, 6);
  const search = `${words.join(" ") || "feedback"} in:title`;
  const result = runGhCaptured([
    "issue",
    "list",
    "--repo",
    TARGET_REPOSITORY,
    "--state",
    "all",
    "--search",
    search,
    "--limit",
    "5",
    "--json",
    "number,title,url,state,updatedAt",
  ]);
  if (result.status !== 0) return { available: false, issues: [] };
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { available: false, issues: [] };
    const issues = parsed.slice(0, 5).flatMap((candidate) => {
      if (
        !Number.isInteger(candidate.number) ||
        !new RegExp(
          `^https://github\\.com/${TARGET_REPOSITORY.replace("/", "\\/")}/issues/${candidate.number}$`,
          "u",
        ).test(candidate.url)
      ) return [];
      return [{
        number: candidate.number,
        title: sanitizedCandidateTitle(candidate),
        url: candidate.url,
        state: candidate.state === "CLOSED" ? "CLOSED" : "OPEN",
        updated_at: Number.isNaN(Date.parse(candidate.updatedAt))
          ? "NOT_COLLECTED"
          : new Date(candidate.updatedAt).toISOString(),
      }];
    });
    return { available: true, issues };
  } catch {
    return { available: false, issues: [] };
  }
}

function submissionDigest(report, body, label) {
  return crypto
    .createHash("sha256")
    .update(TARGET_REPOSITORY)
    .update("\0")
    .update(githubTitle(report))
    .update("\0")
    .update(label)
    .update("\0")
    .update(body)
    .digest("hex");
}

function previewStatePath(resolved) {
  const root = ensureDirectoryNoLinks(previewRoot());
  const statePath = path.join(root, `${resolved.report.report_id}.json`);
  assertPathInside(statePath, root, "preview state");
  return statePath;
}

function createConfirmationPreview(resolved, body, label) {
  const token = `hfp_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
  const state = {
    report_id: resolved.report.report_id,
    payload_digest: submissionDigest(resolved.report, body, label),
    token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  replacePrivateFile(
    previewStatePath(resolved),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return { token, expires_at: state.expires_at };
}

function consumeConfirmationPreview(resolved, suppliedToken) {
  const statePath = previewStatePath(resolved);
  const consumedPath = path.join(
    path.dirname(statePath),
    `.${resolved.report.report_id}.${crypto.randomBytes(6).toString("hex")}.consuming`,
  );
  try {
    fs.renameSync(statePath, consumedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("a fresh, unconsumed submission preview is required", 65);
    }
    fail("submission preview state cannot be consumed safely", 65);
  }

  try {
    let state;
    try {
      state = JSON.parse(
        readRegularPrivateFile(
          consumedPath,
          16 * 1024,
          "submission preview state",
        ),
      );
    } catch (error) {
      if (error instanceof FeedbackError) throw error;
      fail("submission preview state is invalid", 65);
    }
    assertPlainObject(state, "submission preview state");
    assertOnlyKeys(
      state,
      new Set([
        "report_id",
        "payload_digest",
        "token_hash",
        "created_at",
        "expires_at",
      ]),
      "submission preview state",
    );
    if (
      state.report_id !== resolved.report.report_id ||
      !/^[a-f0-9]{64}$/u.test(state.payload_digest) ||
      !/^[a-f0-9]{64}$/u.test(state.token_hash) ||
      Number.isNaN(Date.parse(state.created_at)) ||
      Number.isNaN(Date.parse(state.expires_at))
    ) {
      fail("submission preview does not match the current payload", 65);
    }
    const createdAt = Date.parse(state.created_at);
    const expiresAt = Date.parse(state.expires_at);
    if (
      new Date(createdAt).toISOString() !== state.created_at ||
      new Date(expiresAt).toISOString() !== state.expires_at ||
      expiresAt - createdAt !== PREVIEW_TTL_MS ||
      createdAt > Date.now() + 60_000
    ) {
      fail("submission preview timestamps are invalid", 65);
    }
    if (expiresAt <= Date.now()) {
      fail("submission preview expired; generate and confirm a fresh preview", 65);
    }
    if (!/^hfp_[A-Za-z0-9_-]{43}$/u.test(suppliedToken)) {
      fail("confirmation token is invalid; generate and confirm a fresh preview", 65);
    }
    const suppliedHash = crypto.createHash("sha256").update(suppliedToken).digest();
    const expectedHash = Buffer.from(state.token_hash, "hex");
    if (!crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      fail("confirmation token does not match the latest preview", 65);
    }
    return { payload_digest: state.payload_digest };
  } finally {
    try {
      fs.unlinkSync(consumedPath);
    } catch {
      // The state has already been atomically removed from the active path.
    }
  }
}

function pathEntry(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("managed submission state cannot be inspected safely", 65);
  }
}

function alreadySubmitted(resolved) {
  if (!pathEntry(resolved.submissionPath)) return false;
  const source = readRegularPrivateFile(
    resolved.submissionPath,
    16 * 1024,
    "submission.json",
  );
  let receipt;
  try {
    receipt = JSON.parse(source);
  } catch {
    fail("submission.json is invalid; direct resubmission is blocked", 65);
  }
  const keys = isPlainObject(receipt) ? Object.keys(receipt).sort() : [];
  if (
    keys.join("\0") !== ["issue_number", "issue_url", "submitted_at"].join("\0") ||
    !Number.isSafeInteger(receipt.issue_number) ||
    receipt.issue_number <= 0 ||
    receipt.issue_url !==
      `https://github.com/${TARGET_REPOSITORY}/issues/${receipt.issue_number}` ||
    typeof receipt.submitted_at !== "string" ||
    Number.isNaN(Date.parse(receipt.submitted_at)) ||
    new Date(receipt.submitted_at).toISOString() !== receipt.submitted_at
  ) {
    fail("submission.json does not match the successful receipt schema; direct resubmission is blocked", 65);
  }
  return true;
}

function submissionClaimPresent(resolved) {
  if (!pathEntry(resolved.claimPath)) return false;
  readRegularPrivateFile(resolved.claimPath, 16 * 1024, "submission lock");
  return true;
}

function acquireSubmissionClaim(resolved) {
  if (submissionClaimPresent(resolved)) {
    fail("submission is already in progress or has an uncertain external result", 73);
  }
  const claim = {
    report_id: resolved.report.report_id,
    started_at: new Date().toISOString(),
  };
  try {
    writeExclusivePrivate(
      resolved.claimPath,
      `${JSON.stringify(claim, null, 2)}\n`,
    );
    fsyncDirectory(resolved.reportDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("submission is already in progress or has an uncertain external result", 73);
    }
    throw error;
  }
}

function releaseSubmissionClaim(resolved) {
  let removed = false;
  try {
    fs.unlinkSync(resolved.claimPath);
    removed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (removed) fsyncDirectory(resolved.reportDirectory);
}

function exactExistingReport(reportId) {
  const result = runGhCaptured([
    "issue",
    "list",
    "--repo",
    TARGET_REPOSITORY,
    "--state",
    "all",
    "--search",
    `${reportId} in:body`,
    "--limit",
    "1",
    "--json",
    "number,url",
  ]);
  if (result.status !== 0) return { available: false, issue: null };
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > 1) {
      return { available: false, issue: null };
    }
    if (parsed.length === 0) return { available: true, issue: null };
    const candidate = parsed[0];
    if (
      !Number.isInteger(candidate.number) ||
      !new RegExp(
        `^https://github\\.com/${TARGET_REPOSITORY.replace("/", "\\/")}/issues/${candidate.number}$`,
        "u",
      ).test(candidate.url)
    ) {
      return { available: false, issue: null };
    }
    return {
      available: true,
      issue: { number: candidate.number, url: candidate.url },
    };
  } catch {
    return { available: false, issue: null };
  }
}

function githubPreview(resolved) {
  if (resolved.report.security_issue) return webFallback(resolved);
  if (submissionClaimPresent(resolved)) {
    return {
      action: "web_fallback",
      reason: "submission_result_uncertain_no_retry",
      repository: TARGET_REPOSITORY,
      report_preserved: true,
      fallback: webFallback(resolved),
    };
  }
  if (alreadySubmitted(resolved)) fail("this report ID has already been submitted", 73);
  const body = readRegularPrivateFile(
    resolved.publicPath,
    MAX_REPORT_BYTES,
    "public-report.md",
  );
  const expected = renderReport(resolved.report);
  if (body !== expected) fail("public-report.md must be rendered and validated before submission", 65);
  const auth = githubStatus();
  const label = resolved.report.kind === "bug" ? "bug" : "enhancement";
  if (!auth.authenticated) {
    return {
      action: "web_fallback",
      reason: "github_cli_not_authenticated",
      repository: TARGET_REPOSITORY,
      title: githubTitle(resolved.report),
      label,
      body_file: resolved.publicPath,
      fallback: webFallback(resolved),
      login_command: "ha-feedback github login",
    };
  }
  const candidates = issueCandidates(resolved.report);
  if (!candidates.available) {
    return {
      action: "web_fallback",
      reason: "issue_candidate_search_unavailable",
      repository: TARGET_REPOSITORY,
      title: githubTitle(resolved.report),
      label,
      body_file: resolved.publicPath,
      candidates,
      fallback: webFallback(resolved),
    };
  }
  const confirmation = createConfirmationPreview(resolved, body, label);
  return {
    action: "confirmation_required",
    repository: TARGET_REPOSITORY,
    title: githubTitle(resolved.report),
    label,
    body_file: resolved.publicPath,
    candidates,
    confirmation_token: confirmation.token,
    confirmation_expires_at: confirmation.expires_at,
    fallback: webFallback(resolved),
  };
}

function githubSubmit(resolved, suppliedToken) {
  if (!suppliedToken) return githubPreview(resolved);
  if (resolved.report.security_issue) fail("public submission is blocked for a possible security issue", 65);
  if (submissionClaimPresent(resolved)) {
    fail("submission is already in progress or has an uncertain external result", 73);
  }
  if (alreadySubmitted(resolved)) fail("this report ID has already been submitted", 73);
  const confirmation = consumeConfirmationPreview(resolved, suppliedToken);
  acquireSubmissionClaim(resolved);
  let retainClaim = false;
  try {
    const body = readRegularPrivateFile(
      resolved.publicPath,
      MAX_REPORT_BYTES,
      "public-report.md",
    );
    const label = resolved.report.kind === "bug" ? "bug" : "enhancement";
    if (
      body !== renderReport(resolved.report) ||
      confirmation.payload_digest !==
        submissionDigest(resolved.report, body, label)
    ) {
      fail("submission preview does not match the current rendered payload", 65);
    }
    const status = githubStatus();
    if (!status.authenticated) {
      return {
        action: "web_fallback",
        reason: "github_cli_not_authenticated",
        report_preserved: true,
        fresh_preview_required: true,
        fallback: webFallback(resolved),
      };
    }
    const duplicate = exactExistingReport(resolved.report.report_id);
    if (!duplicate.available) {
      return {
        action: "web_fallback",
        reason: "duplicate_check_unavailable_no_create",
        report_preserved: true,
        fresh_preview_required: true,
        fallback: webFallback(resolved),
      };
    }
    if (duplicate.issue) {
      fail("an issue containing this report ID already exists", 73);
    }

    retainClaim = true;
    const result = runGhCaptured(
      [
        "issue",
        "create",
        "--repo",
        TARGET_REPOSITORY,
        "--title",
        githubTitle(resolved.report),
        "--body-file",
        "-",
        "--label",
        label,
      ],
      30_000,
      body,
    );
    if (result.status !== 0) {
      return {
        action: "web_fallback",
        reason: "github_issue_create_failed_no_retry",
        report_preserved: true,
        submission_locked_as_uncertain: true,
        fallback: webFallback(resolved),
      };
    }
    const match = new RegExp(
      `^https://github\\.com/${TARGET_REPOSITORY.replace("/", "\\/")}/issues/(\\d+)\\s*$`,
      "u",
    ).exec(result.stdout.trim());
    if (!match) fail("GitHub CLI returned an unexpected issue location; report was preserved and resubmission was locked", 69);
    const receipt = {
      issue_number: Number(match[1]),
      issue_url: result.stdout.trim(),
      submitted_at: new Date().toISOString(),
    };
    writePrivateNewAtomically(
      resolved.submissionPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    alreadySubmitted(resolved);
    retainClaim = false;
    return {
      action: "submitted",
      report_id: resolved.report.report_id,
      ...receipt,
      submission_receipt: resolved.submissionPath,
    };
  } finally {
    if (!retainClaim) releaseSubmissionClaim(resolved);
  }
}

function parseSingleOption(arguments_, optionName) {
  const index = arguments_.indexOf(optionName);
  if (index < 0) return null;
  if (index + 1 >= arguments_.length) fail(`${optionName} requires a value`, 64);
  if (arguments_.indexOf(optionName, index + 1) >= 0) fail(`${optionName} may appear only once`, 64);
  const value = arguments_[index + 1];
  arguments_.splice(index, 2);
  return value;
}

function printHelp() {
  process.stdout.write(`ha-feedback ${SCHEMA_VERSION}\n\n`);
  process.stdout.write("Usage:\n");
  process.stdout.write("  ha-feedback collect bug|feature --input <0600-json-file>\n");
  process.stdout.write("  ha-feedback validate <report.json|report-directory>\n");
  process.stdout.write("  ha-feedback render <report.json|report-directory>\n");
  process.stdout.write("  ha-feedback github status\n");
  process.stdout.write("  ha-feedback github login [--confirm-backup-risk]\n");
  process.stdout.write("  ha-feedback github logout [--confirm]\n");
  process.stdout.write("  ha-feedback github url <report.json|report-directory>\n");
  process.stdout.write("  ha-feedback github submit <report.json|report-directory> [--confirm <preview-token>]\n");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const command = arguments_.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "collect") {
    const kind = arguments_.shift();
    const input = parseSingleOption(arguments_, "--input");
    if (!input || arguments_.length > 0) fail("collect requires kind and exactly one --input", 64);
    printJson(await collectCommand(kind, input));
    return;
  }
  if (command === "validate" || command === "render") {
    if (arguments_.length !== 1) fail(`${command} requires one managed report path`, 64);
    printJson(command === "validate" ? validateCommand(arguments_[0]) : renderCommand(arguments_[0]));
    return;
  }
  if (command !== "github") fail("unknown command", 64);
  const githubCommand = arguments_.shift();
  if (githubCommand === "status") {
    if (arguments_.length !== 0) fail("github status accepts no arguments", 64);
    printJson(githubStatus());
    return;
  }
  if (githubCommand === "login") {
    const confirmed = arguments_.length === 1 && arguments_[0] === "--confirm-backup-risk";
    if (arguments_.length > (confirmed ? 1 : 0)) fail("github login received an unsupported argument", 64);
    printJson(await githubLogin(confirmed));
    return;
  }
  if (githubCommand === "logout") {
    const confirmed = arguments_.length === 1 && arguments_[0] === "--confirm";
    if (arguments_.length > (confirmed ? 1 : 0)) fail("github logout received an unsupported argument", 64);
    printJson(await githubLogout(confirmed));
    return;
  }
  if (githubCommand === "url") {
    if (arguments_.length !== 1) fail("github url requires one managed report path", 64);
    printJson(webFallback(resolveReport(arguments_[0])));
    return;
  }
  if (githubCommand === "submit") {
    const confirmation = parseSingleOption(arguments_, "--confirm");
    if (arguments_.length !== 1) fail("github submit requires one managed report path", 64);
    printJson(githubSubmit(resolveReport(arguments_[0]), confirmation));
    return;
  }
  fail("unknown github command", 64);
}

try {
  await main();
} catch (error) {
  if (error instanceof FeedbackError) {
    process.stderr.write(`ha-feedback: ${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write("ha-feedback: unexpected internal error; no report or submission was completed\n");
    process.exitCode = 70;
  }
}
