import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, lstat, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

function run(binary, args, env, cwd) {
  return new Promise(resolve => {
    let output = '', done = false;
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, output: '' }); }, 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { child.kill('SIGTERM'); finish({ ok: false, output: '' }); }
    });
    child.on('error', () => finish({ ok: false, output: '' }));
    child.on('exit', code => finish({ ok: code === 0, output }));
  });
}

// Runs only local parsing and a synthetic sandbox command. No model invocation,
// user auth/session reads, Supervisor calls or real protected-file reads.
export async function verifyManagedPolicy(packageDir, paths = {}) {
  let home, workspace, server, appServer;
  try {
    const profile = (await readFile(paths.profile || '/proc/self/attr/current', 'utf8')).trim();
    if (!profile.includes('codex') || !profile.endsWith('(enforce)')) {
      return { valid: false, reason: 'managed_apparmor_profile_unavailable' };
    }
    const requirements = await readFile(paths.requirements || '/etc/codex/requirements.toml', 'utf8');
    for (const path of ['/config/secrets.yaml', '/config/**/secrets.yaml', '/config/.storage']) {
      if (!requirements.includes(`"${path}"`)) throw new Error('managed_requirements_missing');
    }
    // Companion resources are part of the inventory, and must be present.
    const manifest = JSON.parse(await readFile(join(packageDir, 'codex-package.json'), 'utf8'));
    if (!manifest.version || !manifest.target) throw new Error('invalid_manifest');
    for (const relative of ['bin/codex-code-mode-host', 'codex-resources/bwrap', 'codex-path/rg']) {
      const info = await lstat(join(packageDir, relative));
      if (!info.isFile() || info.nlink !== 1 || !(info.mode & 0o111)) throw new Error('required_package_resource_missing');
    }
    home = await mkdtemp('/tmp/codex-update-home-');
    workspace = await mkdtemp(paths.workspacePrefix || '/config/.codex-update-probe-');
    await mkdir(join(home, 'codex'), { mode: 0o700 });
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, 'codex'), LANG: 'C.UTF-8' };
    const binary = join(packageDir, 'bin/codex');
    const prompt = await run(binary, ['debug', 'prompt-input', 'local update compatibility probe'], env, workspace);
    if (!prompt.ok) throw new Error('managed_config_parse_failed');
    const mcp = await run(binary, ['mcp', 'list', '--json'], env, workspace);
    if (!mcp.ok) throw new Error('managed_mcp_config_parse_failed');
    JSON.parse(mcp.output);
    const parsed = JSON.parse(prompt.output);
    const text = JSON.stringify(parsed);
    for (const path of ['/config/secrets.yaml', '/config/.storage']) {
      if (!text.includes(path)) throw new Error('managed_requirements_not_loaded');
    }
    if (!(await lstat('/config/secrets.yaml')).isFile() || !(await lstat('/config/.storage')).isDirectory()) {
      throw new Error('protected_probe_target_unavailable');
    }
    server = createServer((_request, response) => response.end('local-update-probe'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const sandbox = await run(binary, ['sandbox', '--include-managed-config',
      '-c', `permissions.update-probe={ extends = ":workspace", network = { enabled = true } }`,
      '--permission-profile', 'update-probe', '--cd', workspace,
      '/bin/bash', '-Eeuo', 'pipefail', '-c',
      'printf ordinary-write > ordinary.yaml; test "$(cat ordinary.yaml)" = ordinary-write; ' +
      // Open-only probes: never issue read() on a real protected file.
      "if /bin/bash -c 'exec 9</config/secrets.yaml' 2>/dev/null; then exit 41; fi; " +
      "if /bin/bash -c 'exec 8</config/.storage' 2>/dev/null; then exit 42; fi; " +
      `test "$(curl --fail --silent --max-time 3 http://127.0.0.1:${port}/)" = local-update-probe; ` +
      'printf CODEX_HA_POLICY_PROBE_OK'], env, workspace);
    if (!sandbox.ok || !sandbox.output.includes('CODEX_HA_POLICY_PROBE_OK')) throw new Error('managed_sandbox_probe_failed');
    // Exercise the candidate's multi-client graceful-only shutdown locally.
    const socket = join(home, 'app-server.sock');
    appServer = spawn(binary, ['app-server', '--listen', 'unix://' + socket], {env, cwd:workspace, stdio:'ignore'});
    let appError = false;
    appServer.on('error', () => { appError = true; });
    let socketReady = false;
    for (let i = 0; i < 100; i++) {
      try { socketReady = (await stat(socket)).isSocket(); } catch {}
      if (socketReady || appError || appServer.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!socketReady) throw new Error('graceful_probe_server_unavailable');
    // A listening path can appear before signal handlers finish installing.
    // Complete real RPC initialization and content-free idle verification first.
    const {inspectAppServer} = await import('./codex-runtime-manager.mjs');
    const readiness = await inspectAppServer(socket, appServer.pid, manifest.version);
    if (readiness.busy) throw new Error('graceful_probe_server_not_idle');
    const exited = new Promise(resolve => appServer.once('exit', (code, signal) => resolve(code === 0 && !signal)));
    appServer.kill('SIGHUP');
    let timer;
    const graceful = await Promise.race([exited, new Promise(resolve => { timer=setTimeout(()=>resolve(false),5000); })]);
    clearTimeout(timer);
    if (!graceful) throw new Error('graceful_probe_failed');
    return { valid: true };
  } catch (error) {
    // Fixed reason codes only; never log candidate stdout or user config.
    return { valid: false, reason: /^[a-z_]+$/.test(error.message) ? error.message : 'managed_policy_probe_failed' };
  } finally {
    if (appServer && appServer.exitCode === null) appServer.kill('SIGHUP');
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
  }
}
