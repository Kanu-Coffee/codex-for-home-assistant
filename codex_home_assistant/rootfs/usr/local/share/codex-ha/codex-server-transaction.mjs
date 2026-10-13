import { spawn, spawnSync } from 'node:child_process';
import { stat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executableMatches(proc, binary) {
  if (!proc || proc.unknown) return false;
  try {
    const expected = await stat(binary);
    const actual = await stat(`/proc/${proc.pid}/exe`);
    if (expected.dev === actual.dev && expected.ino === actual.ino) return true;
    // Verified interpreted package fixtures (and any future signed scripts)
    // must name the exact immutable entrypoint in the interpreter arguments.
    const file = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(2);
    try { await file.read(header, 0, 2, 0); } finally { await file.close(); }
    if (header.toString() !== '#!') return false;
    return proc.cmdline.includes(await realpath(binary));
  } catch { return false; }
}

function versionMatches(binary, version, env) {
  const result = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout.trim() === `codex-cli ${version}`;
}

// No ambient credentials, user shell hooks, loader variables or Node options.
export function serverEnvironment() {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/data/home', CODEX_HOME: '/data/codex',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HA_URL: 'http://supervisor/core/api', SUPERVISOR_URL: 'http://supervisor' };
}

export async function restartServers({ servers, binary, version, inspectProcess, inspectServer,
  switchToNew, switchToOld, writeRecord, removeRecord, commitAttempt }) {
  const env = serverEnvironment();
  const stopped = [], replacements = [];
  let unresolvedDrain = false;
  async function stop(identity) {
    const live = await inspectProcess(identity.pid);
    if (!live) return true;
    if (live.unknown || live.startTime !== identity.startTime) throw new Error('process_identity_changed');
    // Tagged 0.162.1 maps HUP to GracefulOnly; repeated HUP cannot force a drain.
    process.kill(identity.pid, 'SIGHUP');
    for (let i = 0; i < 50; i++) {
      await delay(100);
      const current = await inspectProcess(identity.pid);
      if (!current) return true;
      if (current.unknown || current.startTime !== identity.startTime) throw new Error('process_identity_changed');
    }
    return false;
  }
  async function launch(server, exe, expectedVersion) {
    const record = server.managedRecord;
    if (!versionMatches(exe, expectedVersion, env)) throw new Error('server_version_mismatch');
    const child = spawn(exe, record.args, { cwd: record.cwd, env, detached: true, stdio: 'ignore' });
    let error = null;
    child.on('error', err => { error = err; });
    child.unref();
    await delay(100);
    const identity = await inspectProcess(child.pid);
    if (!identity || identity.unknown || error) throw new Error('server_launch_failed');
    const launched = { ...identity, server, child };
    replacements.push(launched);
    for (let i = 0; i < 50; i++) {
      if (error || child.exitCode !== null) throw new Error('server_exited_before_ready');
      const current = await inspectProcess(child.pid);
      if (!current || current.startTime !== identity.startTime || !await executableMatches(current, exe)) {
        throw new Error('server_executable_mismatch');
      }
      const ready = await inspectServer(server.socketPath, child.pid, expectedVersion);
      if (!ready.busy) {
        await writeRecord(child.pid, { ...record, pid: child.pid, start: identity.startTime, exe, version: expectedVersion });
        return launched;
      }
      await delay(100);
    }
    throw new Error('server_readiness_failed');
  }
  try {
    // Check every old launch contract before stopping any server.
    for (const server of servers) {
      const record = server.managedRecord;
      const proc = await inspectProcess(server.pid);
      if (!record.exe || !record.version || !Array.isArray(record.args) || !record.cwd ||
          !proc || proc.unknown || proc.startTime !== server.start ||
          !await executableMatches(proc, record.exe) || !versionMatches(record.exe, record.version, env)) {
        throw new Error('invalid_managed_launch_record');
      }
      if ((await inspectServer(server.socketPath, server.pid, record.version)).busy) throw new Error('server_busy_pre_signal');
    }
    await commitAttempt();
    for (const server of servers) {
      unresolvedDrain = true;
      if (!await stop({ pid: server.pid, startTime: server.start })) throw new Error('drain_timeout');
      unresolvedDrain = false;
      stopped.push(server);
      await removeRecord(server.pid);
    }
    await switchToNew();
    for (const server of servers) await launch(server, binary, version);
    return { applied: true };
  } catch (error) {
    let allRestored = !unresolvedDrain;
    const unstoppedSockets = new Set();
    // Stop all newly launched generations before restoring the old socket owners.
    for (const replacement of replacements.splice(0)) {
      try {
        if (!await stop(replacement)) {
          allRestored = false;
          unstoppedSockets.add(replacement.server.socketPath);
        } else {
          await removeRecord(replacement.pid);
        }
      } catch {
        allRestored = false;
        unstoppedSockets.add(replacement.server.socketPath);
      }
    }
    try { await switchToOld(); } catch { allRestored = false; }
    for (const server of stopped) {
      if (unstoppedSockets.has(server.socketPath)) {
        allRestored = false;
        continue;
      }
      try {
        await launch(server, server.managedRecord.exe, server.managedRecord.version);
      } catch {
        allRestored = false;
      }
    }
    return { applied: false, reason: error.message, recovery: allRestored ? 'restored' : 'rollback_incomplete' };
  }
}
