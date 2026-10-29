import { spawn, spawnSync } from 'node:child_process';
import { stat, lstat, realpath, open } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function sendControlCommand(socketPath, cmdObj, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      try { client.destroy(); } catch {}
      reject(new Error('control_socket_timeout'));
    }, timeoutMs);

    client.on('connect', () => {
      client.write(JSON.stringify(cmdObj) + '\n');
    });
    client.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        try {
          const res = JSON.parse(buf.slice(0, idx).trim());
          try { client.destroy(); } catch {}
          resolve(res);
        } catch (e) {
          try { client.destroy(); } catch {}
          reject(e);
        }
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function verifySessionHostInspect(socketPath) {
  const socket = await lstat(socketPath).catch(() => null);
  if (!socket || !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0) {
    return { busy: true, unknown: true, error: 'unsafe_control_socket' };
  }
  const res = await sendControlCommand(socketPath, { cmd: 'inspect' });
  if (
    !res ||
    typeof res !== 'object' ||
    typeof res.busy !== 'boolean' ||
    !Number.isSafeInteger(res.inFlight) || res.inFlight < 0 ||
    !Number.isSafeInteger(res.pending) || res.pending < 0 ||
    !Number.isSafeInteger(res.activeTurns) || res.activeTurns < 0 ||
    !Array.isArray(res.loadedThreads) ||
    typeof res.version !== 'string'
  ) {
    return { busy: true, unknown: true, error: 'invalid_control_response_schema' };
  }
  if (res.unknown === true) {
    return { busy: true, unknown: true, error: res.reason || 'unknown_session_host_state' };
  }
  if (!res.busy && (res.inFlight > 0 || res.pending > 0 || res.activeTurns > 0)) {
    return { busy: true, unknown: true, error: 'inconsistent_inspect_state_active_while_not_busy' };
  }
  if (!res.workerPid || typeof res.workerPid !== 'number' || !existsSync(`/proc/${res.workerPid}`)) {
    return { busy: true, unknown: true, error: 'session_host_worker_process_missing' };
  }
  return res;
}

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

export async function verifyRelayIdentity(server, observation, inspectProcess) {
  try {
    const record = server.managedRecord;
    if (!record || record.pid !== server.pid || observation.relayPid !== server.pid ||
        record.workerPid !== observation.workerPid || !record.workerStart ||
        String(record.workerStart) !== String(observation.workerStart) ||
        record.version !== observation.version || record.exe !== observation.exe ||
        record.controlSocket !== server.controlSocket) return false;
    const relay = await inspectProcess(server.pid);
    const worker = await inspectProcess(observation.workerPid);
    if (!relay || relay.unknown || String(relay.startTime) !== String(server.start) ||
        !worker || worker.unknown || String(worker.ppid) !== String(server.pid) ||
        String(worker.startTime) !== String(record.workerStart)) return false;
    const expectedHost = await realpath(join(dirname(fileURLToPath(import.meta.url)), 'codex-session-host.mjs'));
    if (basename(relay.exe || '') !== 'node' || !relay.cmdline?.[1] ||
        await realpath(relay.cmdline[1]) !== expectedHost) return false;
    const socketFlag = relay.cmdline.indexOf('--control-socket');
    if (socketFlag < 0 || relay.cmdline[socketFlag + 1] !== server.controlSocket) return false;
    return await executableMatches(worker, record.exe);
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
  switchToNew, switchToOld, writeRecord, removeRecord, commitAttempt,
  writeJournal = async () => {}, clearJournal = async () => {},
  commitSelection = async () => {}, rollbackSelection = async () => {},
  finishSelection = async () => {}, verifyHost = verifyRelayIdentity }) {
  const env = serverEnvironment();
  const stopped = [], replacements = [];
  const switchedRelays = [];
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

  const barrieredRelays = [];
  const uncertainRelays = new Set();
  let selectionSwitched = false;
  let releaseStarted = false;
  const journal = async (phase, extra = {}) => writeJournal({
    phase, version, ...extra,
    // Paths and process identity are private recovery metadata, never status output.
    relays: servers.filter(s => s.type === 'remote-stdio' || s.controlSocket).map(s => ({
      pid: s.pid, start: s.start, socket: s.controlSocket,
    })),
  });
  const setBarrier = async (server, enabled) => {
    const res = await sendControlCommand(server.controlSocket, { cmd: 'barrier', enabled });
    if (!res || res.success !== true || res.barrier !== enabled) {
      throw new Error(enabled ? 'barrier_acquire_failed' : 'barrier_release_failed');
    }
  };

  try {
    await journal('preparing');
    // 1. Set admission barrier on all managed relays to hold new incoming client requests
    for (const server of servers) {
      if ((server.type === 'remote-stdio' || server.controlSocket) && server.controlSocket) {
        // A timeout can mean the command was accepted but its acknowledgement
        // was lost. Keep the host in the recovery set before sending it.
        uncertainRelays.add(server);
        await setBarrier(server, true);
        barrieredRelays.push(server);
        uncertainRelays.delete(server);
      }
    }

    // 2. Check every old launch contract & verify idle state while admission is held
    for (const server of servers) {
      const record = server.managedRecord;
      if (server.type === 'remote-stdio' || server.controlSocket) {
        const inspectRes = await verifySessionHostInspect(server.controlSocket);
        if (inspectRes.busy || inspectRes.unknown || inspectRes.error) {
          throw new Error('server_busy_pre_signal');
        }
        if (!await verifyHost(server, inspectRes, inspectProcess)) {
          throw new Error('session_host_identity_unverified');
        }
        continue;
      }
      const proc = await inspectProcess(server.pid);
      if (!record.exe || !record.version || !Array.isArray(record.args) || !record.cwd ||
          !proc || proc.unknown || proc.startTime !== server.start ||
          !await executableMatches(proc, record.exe) || !versionMatches(record.exe, record.version, env)) {
        throw new Error('invalid_managed_launch_record');
      }
      const inspectRes = await inspectServer(server.socketPath, server.pid, record.version);
      if (inspectRes.busy) {
        throw new Error('server_busy_pre_signal');
      }
    }
    await commitAttempt();
    await journal('draining');

    // 3. Drain and stop standard unix socket app-servers
    for (const server of servers) {
      if (server.type === 'remote-stdio' || server.controlSocket) continue;
      unresolvedDrain = true;
      if (!await stop({ pid: server.pid, startTime: server.start })) throw new Error('drain_timeout');
      unresolvedDrain = false;
      stopped.push(server);
      await removeRecord(server.pid);
    }

    // Keep admission closed until the selected link and durable state agree.
    await journal('committing');
    selectionSwitched = true;
    await switchToNew();
    await commitSelection();

    // 4. Relaunch servers (relays switch worker, unix app-servers launch & restore)
    for (const server of servers) {
      if (server.type === 'remote-stdio' || server.controlSocket) {
        await journal('switching_worker', { relayPid: server.pid });
        uncertainRelays.add(server);
        const switchRes = await sendControlCommand(server.controlSocket, {
          cmd: 'switch_worker',
          exe: binary,
          version,
          args: server.managedRecord.args,
          cwd: server.managedRecord.cwd,
          env,
          keepBarrier: true,
        });
        if (!switchRes || !switchRes.success) {
          if (switchRes?.rollbackStatus === 'restored') uncertainRelays.delete(server);
          throw new Error(switchRes?.error || 'relay_switch_failed');
        }
        const ready = await verifySessionHostInspect(server.controlSocket);
        const newRecord = { ...server.managedRecord, exe: binary, version,
          workerPid: switchRes.workerPid, workerStart: switchRes.workerStart };
        if (ready.busy || ready.unknown || ready.error || ready.relayPid !== server.pid ||
            ready.workerPid !== switchRes.workerPid || ready.version !== version ||
            !await verifyHost({ ...server, managedRecord: newRecord }, ready, inspectProcess)) {
          throw new Error('new_session_host_identity_unverified');
        }
        switchedRelays.push(server);
        uncertainRelays.delete(server);
      } else {
        const launched = await launch(server, binary, version);
        if (Array.isArray(server.loadedThreads) && server.loadedThreads.length > 0) {
          // Threads are restored onto the launched generation
        }
      }
    }
    await journal('releasing');
    // Once the first client is released, new work may begin. A subsequent
    // failure must not roll that worker back or replay its accepted input.
    releaseStarted = true;
    for (const server of switchedRelays) {
      await setBarrier(server, false);
    }
    await finishSelection();
    await clearJournal();
    return { applied: true };
  } catch (error) {
    if (releaseStarted) {
      try { await journal('release_incomplete'); } catch {}
      return { applied: false, reason: error.message, recovery: 'rollback_incomplete' };
    }
    let allRestored = !unresolvedDrain && uncertainRelays.size === 0;
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

    // Rollback switched relays
    for (const server of switchedRelays) {
      try {
        const rb = await sendControlCommand(server.controlSocket, {
          cmd: 'switch_worker',
          exe: server.managedRecord.exe,
          version: server.managedRecord.version,
          args: server.managedRecord.args,
          cwd: server.managedRecord.cwd,
          env,
          keepBarrier: true,
        });
        if (!rb || !rb.success) {
          allRestored = false;
          uncertainRelays.add(server);
        }
      } catch {
        allRestored = false;
        uncertainRelays.add(server);
      }
    }

    if (selectionSwitched) {
      try { await switchToOld(); await rollbackSelection(); } catch { allRestored = false; }
    }
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
    // Release only after every prior generation is restored. On a partial
    // rollback keep admission closed until recovery is independently verified.
    for (const server of barrieredRelays) {
      if (!allRestored || uncertainRelays.has(server)) continue;
      try { await setBarrier(server, false); } catch { allRestored = false; }
    }
    try {
      if (allRestored) await clearJournal();
      else await journal('rollback_incomplete');
    } catch { allRestored = false; }
    return { applied: false, reason: error.message, recovery: allRestored ? 'restored' : 'rollback_incomplete' };
  }
}
