import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DATA_DIRECTORY = "/data/codex";
const OPTIONS_PATH = "/data/options.json";
const APP_VERSION_PATH = "/usr/local/share/codex-ha/app-version";
const DEFAULT_AGENTS_PATH = "/usr/local/share/codex-ha/AGENTS.md";
const CONFIG_PATH = join(DATA_DIRECTORY, "config.toml");
const AGENTS_PATH = join(DATA_DIRECTORY, "AGENTS.md");
const AGENTS_OVERRIDE_PATH = join(DATA_DIRECTORY, "AGENTS.override.md");
const STATE_PATH = join(DATA_DIRECTORY, ".user-files-update-state.json");
const JOURNAL_PATH = join(DATA_DIRECTORY, ".user-files-update-journal.json");
const BACKUPS_DIRECTORY = join(DATA_DIRECTORY, "backups");
const USER_BACKUPS_DIRECTORY = join(BACKUPS_DIRECTORY, "user-files");
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_USER_FILE_BYTES = 16 * 1024 * 1024;
const STATE_SCHEMA = 1;
const VALID_MODES = new Set(["preserve", "refresh_agents", "refresh_all"]);
const VALID_SCOPES = new Set(["config", "agents"]);

class FatalUpdateError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function inspectPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function assertRootOwnedRegular(path, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${path} must be a regular file and not a symbolic link`);
  }
  if (stats.uid !== 0 || stats.nlink !== 1) {
    throw new Error(`${path} must be root-owned with exactly one hard link`);
  }
}

async function readBounded(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new Error("File is larger than the supported size limit");
  }
  return Buffer.concat(chunks, total);
}

async function readSafeSnapshot(path, maxBytes = MAX_USER_FILE_BYTES) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    if (opened.size > maxBytes) {
      throw new Error(`${path} is larger than the supported size limit`);
    }
    const content = await readBounded(handle, maxBytes);
    const after = await handle.stat();
    assertRootOwnedRegular(path, after);
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${path} changed while it was read`);
    }
    return { content, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function readSafeFile(path, maxBytes = MAX_USER_FILE_BYTES) {
  return (await readSafeSnapshot(path, maxBytes))?.content;
}

async function chmodSafeRegular(path, mode) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    await handle.chmod(mode);
    const current = await inspectPath(path);
    if (
      !current ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error(`${path} changed while its mode was secured`);
    }
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path, value, mode) {
  const parent = dirname(path);
  let handle;
  let opened;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (opened) {
      const current = await inspectPath(path).catch(() => undefined);
      if (
        current &&
        current.dev === opened.dev &&
        current.ino === opened.ino
      ) {
        await unlink(path).catch(() => {});
      }
    }
    throw error;
  }
}

async function writeAtomic(path, value, mode) {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await writeAtomic(path, `${JSON.stringify(value)}\n`, 0o600);
}

async function removeSafeRegular(path) {
  const stats = await inspectPath(path);
  if (!stats) return;
  assertRootOwnedRegular(path, stats);
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function securePrivateDirectory(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== 0) {
    throw new Error(`${path} must be a root-owned directory and not a symbolic link`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.uid !== 0 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`${path} changed during directory validation`);
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await securePrivateDirectory(path);
}

async function readJson(path, optional = false) {
  const content = await readSafeFile(path, MAX_CONTROL_FILE_BYTES);
  if (content === undefined && optional) return undefined;
  if (content === undefined) throw new Error(`${path} is missing`);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

function emptyState() {
  return {
    schema: STATE_SCHEMA,
    applied: {
      agents: [],
      config: [],
    },
  };
}

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(
      value,
    )
  ) {
    throw new Error("The image App version is invalid");
  }
  return value;
}

function validateScopes(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((scope) => !VALID_SCOPES.has(scope))
  ) {
    throw new Error("The user-file update scope is invalid");
  }
  return value;
}

function validateState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    value.applied === null ||
    typeof value.applied !== "object" ||
    Array.isArray(value.applied)
  ) {
    throw new Error("The user-file update state is invalid");
  }
  for (const scope of VALID_SCOPES) {
    const versions = value.applied[scope];
    if (
      !Array.isArray(versions) ||
      new Set(versions).size !== versions.length
    ) {
      throw new Error("The user-file update version history is invalid");
    }
    versions.forEach(validateVersion);
  }
  return value;
}

function validateJournal(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    typeof value.transaction !== "string" ||
    !/^refresh-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u.test(value.transaction)
  ) {
    throw new Error("The user-file update journal is invalid");
  }
  validateVersion(value.app_version);
  validateScopes(value.scopes);
  return value;
}

function validateMetadata(value, journal) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    value.app_version !== journal.app_version ||
    JSON.stringify(value.scopes) !== JSON.stringify(journal.scopes) ||
    value.files === null ||
    typeof value.files !== "object" ||
    Array.isArray(value.files)
  ) {
    throw new Error("The user-file update transaction metadata is invalid");
  }
  for (const scope of journal.scopes) {
    const file = value.files[scope];
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof file.existed !== "boolean" ||
      !Number.isInteger(file.original_mode) ||
      file.original_mode < 0 ||
      file.original_mode > 0o777 ||
      typeof file.candidate_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.candidate_sha256) ||
      (file.existed &&
        (typeof file.before_sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(file.before_sha256)))
    ) {
      throw new Error("The user-file update file metadata is invalid");
    }
  }
  return value;
}

async function loadState() {
  const value = await readJson(STATE_PATH, true);
  return value === undefined ? emptyState() : validateState(value);
}

async function loadJournal() {
  const value = await readJson(JOURNAL_PATH, true);
  return value === undefined ? undefined : validateJournal(value);
}

function targetForScope(scope) {
  return scope === "config" ? CONFIG_PATH : AGENTS_PATH;
}

function candidateName(scope) {
  return `${scope}.image-default`;
}

function backupName(scope) {
  return `${scope}.before`;
}

async function loadTransaction(journal) {
  await ensurePrivateDirectory(BACKUPS_DIRECTORY);
  await ensurePrivateDirectory(USER_BACKUPS_DIRECTORY);
  const transactionDirectory = join(USER_BACKUPS_DIRECTORY, journal.transaction);
  await securePrivateDirectory(transactionDirectory);
  const metadata = validateMetadata(
    await readJson(join(transactionDirectory, "metadata.json")),
    journal,
  );
  return { metadata, transactionDirectory };
}

async function readVerifiedTransactionFile(path, expectedHash) {
  const content = await readSafeFile(path);
  if (content === undefined || sha256(content) !== expectedHash) {
    throw new Error("A user-file update transaction file failed verification");
  }
  return content;
}

function versionApplied(state, scope, version) {
  return state.applied[scope].includes(version);
}

async function verifyInstalledTargets(transactionDirectory, metadata) {
  for (const scope of metadata.scopes) {
    const target = targetForScope(scope);
    const targetContent = await readSafeFile(target);
    if (
      targetContent === undefined ||
      sha256(targetContent) !== metadata.files[scope].candidate_sha256
    ) {
      throw new Error("A committed user-file update target failed verification");
    }
    await readVerifiedTransactionFile(
      join(transactionDirectory, candidateName(scope)),
      metadata.files[scope].candidate_sha256,
    );
  }
}

async function rollbackTransaction(transactionDirectory, metadata) {
  const prepared = {};
  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    const targetStats = await inspectPath(target);
    if (targetStats) assertRootOwnedRegular(target, targetStats);
    if (file.existed) {
      const current = await readSafeFile(target);
      if (current === undefined) {
        throw new Error("An existing update target disappeared before recovery");
      }
      const currentHash = sha256(current);
      if (
        currentHash !== file.before_sha256 &&
        currentHash !== file.candidate_sha256
      ) {
        throw new Error("An update target changed before recovery");
      }
      prepared[scope] = await readVerifiedTransactionFile(
        join(transactionDirectory, backupName(scope)),
        file.before_sha256,
      );
    } else if (targetStats) {
      const current = await readSafeFile(target);
      if (sha256(current) !== file.candidate_sha256) {
        throw new Error("A newly created update target changed before recovery");
      }
    }
  }

  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    if (file.existed) {
      await writeAtomic(target, prepared[scope], file.original_mode);
    } else {
      await removeSafeRegular(target);
    }
  }
}

async function recoverPendingTransaction(state) {
  let journal;
  try {
    journal = await loadJournal();
  } catch (error) {
    throw new FatalUpdateError(
      `Pending user-file update journal is unsafe: ${error.message}`,
    );
  }
  if (!journal) return "none";
  try {
    const committed = journal.scopes.every((scope) =>
      versionApplied(state, scope, journal.app_version),
    );
    if (committed) {
      await removeSafeRegular(JOURNAL_PATH);
      return "committed";
    }
    const transaction = await loadTransaction(journal);
    await rollbackTransaction(
      transaction.transactionDirectory,
      transaction.metadata,
    );
    await removeSafeRegular(JOURNAL_PATH);
    return "rolled_back";
  } catch (error) {
    throw new FatalUpdateError(`Pending user-file update recovery failed: ${error.message}`);
  }
}

async function createTransactionDirectory() {
  await ensurePrivateDirectory(BACKUPS_DIRECTORY);
  await ensurePrivateDirectory(USER_BACKUPS_DIRECTORY);
  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const name = `refresh-${timestamp}-${randomBytes(6).toString("hex")}`;
    const path = join(USER_BACKUPS_DIRECTORY, name);
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(USER_BACKUPS_DIRECTORY);
      return { name, path };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("A unique user-file backup directory could not be allocated");
}

async function preflightRefreshTargets(scopes) {
  const result = {};
  for (const scope of scopes) {
    const target = targetForScope(scope);
    const snapshot = await readSafeSnapshot(target);
    result[scope] = snapshot
      ? { existed: true, ...snapshot }
      : { existed: false, mode: scope === "config" ? 0o600 : 0o644 };
  }
  return result;
}

async function prepareTransaction(scopes, appVersion, defaults) {
  const targetInfo = await preflightRefreshTargets(scopes);
  const transaction = await createTransactionDirectory();
  const metadata = {
    schema: STATE_SCHEMA,
    app_version: appVersion,
    scopes,
    files: {},
  };

  for (const scope of scopes) {
    const file = {
      existed: targetInfo[scope].existed,
      original_mode: targetInfo[scope].mode,
      before_sha256: null,
      candidate_sha256: sha256(defaults[scope]),
    };
    if (file.existed) {
      const current = targetInfo[scope].content;
      file.before_sha256 = sha256(current);
      await writeAtomic(
        join(transaction.path, backupName(scope)),
        current,
        0o600,
      );
      const backup = await readSafeFile(join(transaction.path, backupName(scope)));
      if (sha256(backup) !== file.before_sha256) {
        throw new Error("A user-file backup failed verification");
      }
    }
    await writeAtomic(
      join(transaction.path, candidateName(scope)),
      defaults[scope],
      0o600,
    );
    metadata.files[scope] = file;
  }
  await writePrivateJson(join(transaction.path, "metadata.json"), metadata);
  return { metadata, transaction };
}

async function installTransaction(transactionDirectory, metadata) {
  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    const current = await readSafeFile(target);
    if (
      (file.existed &&
        (current === undefined || sha256(current) !== file.before_sha256)) ||
      (!file.existed && current !== undefined)
    ) {
      throw new Error("A user-file update target changed after backup");
    }
  }

  for (const scope of metadata.scopes) {
    const candidate = await readVerifiedTransactionFile(
      join(transactionDirectory, candidateName(scope)),
      metadata.files[scope].candidate_sha256,
    );
    await writeAtomic(
      targetForScope(scope),
      candidate,
      scope === "config" ? 0o600 : 0o644,
    );
  }
  await verifyInstalledTargets(transactionDirectory, metadata);
}

async function performRefresh(scopes, appVersion, defaults, state) {
  let journalWritten = false;
  let prepared;
  try {
    prepared = await prepareTransaction(scopes, appVersion, defaults);
    const journal = {
      schema: STATE_SCHEMA,
      app_version: appVersion,
      scopes,
      transaction: prepared.transaction.name,
    };
    await writePrivateJson(JOURNAL_PATH, journal);
    journalWritten = true;
    await installTransaction(prepared.transaction.path, prepared.metadata);
    for (const scope of scopes) {
      state.applied[scope].push(appVersion);
    }
    await writePrivateJson(STATE_PATH, state);
    await removeSafeRegular(JOURNAL_PATH);
    return prepared.transaction.path;
  } catch (error) {
    if (journalWritten) {
      try {
        const recovery = await recoverPendingTransaction(await loadState());
        if (recovery === "committed") return prepared.transaction.path;
      } catch (recoveryError) {
        throw new FatalUpdateError(recoveryError.message);
      }
    }
    throw new Error(`User-file update was not applied: ${error.message}`);
  }
}

function parseOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App options must be a JSON object");
  }
  const mode = value.codex_user_files_update_mode ?? "preserve";
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    throw new Error("codex_user_files_update_mode is invalid");
  }
  const approvalPolicy = value.codex_approval_policy ?? "on-request";
  if (!new Set(["untrusted", "on-request", "never"]).has(approvalPolicy)) {
    throw new Error("codex_approval_policy is invalid");
  }
  const sandboxMode = value.codex_sandbox_mode ?? "danger-full-access";
  if (!new Set(["workspace-write", "danger-full-access"]).has(sandboxMode)) {
    throw new Error("codex_sandbox_mode is invalid");
  }
  return { approvalPolicy, mode, sandboxMode };
}

function defaultConfig(approvalPolicy, sandboxMode) {
  return Buffer.from(
    [
      `approval_policy = "${approvalPolicy}"`,
      `sandbox_mode = "${sandboxMode}"`,
      'cli_auth_credentials_store = "file"',
      "check_for_update_on_startup = false",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function ensureFreshDefaults(defaults) {
  const created = [];
  const warnings = [];
  try {
    await writeExclusive(CONFIG_PATH, defaults.config, 0o600);
    created.push("config");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      await chmodSafeRegular(CONFIG_PATH, 0o600);
    } catch {
      warnings.push("Existing config.toml is non-regular or linked and was preserved without chmod");
    }
  }

  const overrideStats = await inspectPath(AGENTS_OVERRIDE_PATH);
  if (!overrideStats) {
    try {
      await writeExclusive(AGENTS_PATH, defaults.agents, 0o644);
      created.push("agents");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (overrideStats) {
    warnings.push("AGENTS.override.md was preserved and takes precedence over the base AGENTS.md");
  }
  return { created, warnings };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("user-files-update.mjs does not accept command-line arguments");
  }
  await ensurePrivateDirectory(DATA_DIRECTORY);
  const appVersionFile = await readSafeFile(APP_VERSION_PATH, 128);
  if (appVersionFile === undefined) {
    throw new FatalUpdateError("The image App version file is missing");
  }
  const appVersion = validateVersion(
    appVersionFile.toString("utf8").trim(),
  );
  const options = parseOptions(await readJson(OPTIONS_PATH));
  let state;
  try {
    state = await loadState();
  } catch (error) {
    if (await inspectPath(JOURNAL_PATH)) {
      throw new FatalUpdateError(
        `Pending user-file update state is unsafe: ${error.message}`,
      );
    }
    throw error;
  }
  const recovery = await recoverPendingTransaction(state);
  const recovered = recovery !== "none";
  if (recovered) state = await loadState();

  const defaults = {
    agents: await readSafeFile(DEFAULT_AGENTS_PATH),
    config: defaultConfig(options.approvalPolicy, options.sandboxMode),
  };
  if (defaults.agents === undefined) {
    throw new FatalUpdateError("The image default AGENTS.md is missing");
  }

  const requestedScopes =
    options.mode === "refresh_all"
      ? ["config", "agents"]
      : options.mode === "refresh_agents"
        ? ["agents"]
        : [];
  const scopes = requestedScopes.filter(
    (scope) => !versionApplied(state, scope, appVersion),
  );
  const backupDirectory =
    scopes.length > 0
      ? await performRefresh(scopes, appVersion, defaults, state)
      : null;
  const defaultsResult = await ensureFreshDefaults(defaults);

  process.stdout.write(
    `${JSON.stringify({
      app_version: appVersion,
      backup_directory: backupDirectory,
      created: defaultsResult.created,
      mode: options.mode,
      recovered,
      refreshed: scopes,
      warnings: defaultsResult.warnings,
    })}\n`,
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown user-file update failure";
  process.stderr.write(`Codex user-file update error: ${message}\n`);
  process.exitCode = error instanceof FatalUpdateError ? 30 : 20;
});
