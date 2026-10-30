import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

delete process.env.SUPERVISOR_TOKEN;

class SetupError extends Error {}

function entryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function secure(path, directory = false) {
  const info = lstatSync(path);
  if (info.uid !== process.getuid() || info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (info.mode & 0o077)) throw new SetupError('Unsafe mobile key storage permissions or links');
}

function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function sshPublic(key) {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new SetupError('Mobile key must be ECDSA P-256');
  const field = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const blob = Buffer.concat([field('ecdsa-sha2-nistp256'), field('nistp256'), field(point)]);
  return { line: `ecdsa-sha2-nistp256 ${blob.toString('base64')} codex-ha-mobile`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}

// The CLI always uses /data/ssh; injectable storage is for isolated tests only.
export function mobileStorage(sshDirectory) {
  secure(sshDirectory, true);
  const directory = join(sshDirectory, 'mobile');
  if (!entryExists(directory)) mkdirSync(directory, { mode: 0o700 });
  secure(directory, true);
  const privatePath = join(directory, 'private.pem');
  const authorizedPath = join(directory, 'authorized_keys');
  function load() {
    if (!entryExists(privatePath)) return null;
    secure(privatePath);
    const key = createPrivateKey(readFileSync(privatePath));
    sshPublic(key); // Reject unsupported algorithms before use or export.
    return key;
  }
  function sync() {
    const key = load();
    if (entryExists(authorizedPath)) secure(authorizedPath);
    atomic(authorizedPath, key ? `${sshPublic(key).line}\n` : '');
    return key ? 1 : 0;
  }
  return {
    setup() {
      let key = load();
      if (!key) {
        key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
        atomic(privatePath, key.export({ type: 'pkcs8', format: 'pem' }));
      }
      sync();
      return sshPublic(key);
    },
    sync,
    status() {
      const key = load();
      return key ? sshPublic(key) : null;
    },
    pem(format) {
      if (!['pkcs8', 'sec1'].includes(format)) throw new SetupError('Use --format pkcs8 or --format sec1');
      const key = load();
      if (!key) throw new SetupError('Run ha-codex-remote setup first');
      return key.export({ type: format, format: 'pem' });
    },
    revoke() {
      if (entryExists(authorizedPath)) secure(authorizedPath);
      atomic(authorizedPath, ''); // Revoke first, even if removing the private copy fails.
      if (entryExists(privatePath)) { secure(privatePath); unlinkSync(privatePath); }
    },
  };
}

export function main(args = process.argv.slice(2)) {
  let command = args.shift() || 'help';
  if (command === '--help') command = 'help';
  let format = 'pkcs8';
  if (['setup', 'show'].includes(command) && args.length === 2 && args[0] === '--format' && ['pkcs8', 'sec1'].includes(args[1])) {
    format = args[1]; args = [];
  }
  if (args.length || !['help', 'setup', 'show', 'status', 'revoke', 'sync'].includes(command)) {
    throw new SetupError('Usage: ha-codex-remote setup|show [--format pkcs8|sec1] | status | revoke');
  }
  if (command === 'help') {
    console.log('ha-codex-remote setup  : create/register one persistent mobile key and show PKCS#8 PEM\nha-codex-remote show --format sec1 : show the SAME key as SEC1 PEM\nha-codex-remote status : non-secret key fingerprint and connection guidance\nha-codex-remote revoke : revoke the mobile key (existing SSH connections may continue)\nRun setup/show yourself in the Web UI terminal; never put the private key in chat or logs.');
    return;
  }
  // Private-key display is deliberately available only to an interactive human.
  if (['setup', 'show'].includes(command) && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new SetupError('Run setup/show directly in the interactive Web UI terminal; key output cannot be redirected');
  }
  const storage = mobileStorage('/data/ssh');
  if (command === 'sync') { console.log(storage.sync()); return; }
  if (command === 'revoke') {
    storage.revoke();
    console.log('Mobile key revoked. Existing SSH connections may continue. Run setup for a new key.');
    return;
  }
  if (command === 'setup') {
    storage.setup();
    const marker = '/run/codex-ha/ssh-disabled';
    if (existsSync(marker)) {
      unlinkSync(marker);
      const service = spawnSync('/command/s6-svc', ['-t', '/run/service/sshd'], { stdio: 'ignore', timeout: 5000 });
      if (service.error || service.status !== 0) console.log('Public key registered. Restart this App to start SSH.');
      else console.log('Public key registered; SSH service start requested.');
    } else console.log('Public key registered. App restart is not normally required.');
  }
  const info = storage.status();
  console.log(`Mobile key: ${info ? info.fingerprint : 'not configured'}\nHost: your HA address reachable from the phone\nPort: App Network host port (default 2223; Ingress URL is not the SSH address)\nUser: root\nProject: /config`);
  console.log('Enable the SSH host port in App Network settings. This helper does not change the host port.');
  console.log('If PEM is rejected before connecting: try the other format and update the mobile app. Valid PEM can still be rejected by an app bug.\nIf connection fails after accepting PEM: check Network port, VPN/reachability and App SSH logs.');
  if (['setup', 'show'].includes(command)) {
    console.log(`\nCopy ONLY the following ${format.toUpperCase()} block, including both BEGIN/END lines, into the phone private-key field.\n개인키 블록 전체만 복사하세요. 이 키는 terminal scrollback에 남습니다. 채팅·로그에 공유하지 마세요.\n`);
    process.stdout.write(storage.pem(format));
    console.log('\nPublic key is already registered; do not paste this private key into authorized_keys.\nAlternate format: ha-codex-remote show --format sec1 (or pkcs8)\nTo remove access: ha-codex-remote revoke');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof SetupError ? error.message : 'Mobile SSH setup failed: invalid or inaccessible private storage. No key data is logged.'); process.exitCode = 1; }
}
