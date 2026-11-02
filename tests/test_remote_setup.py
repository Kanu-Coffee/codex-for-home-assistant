"""Mobile PEM generation, persistence, revocation and secret-output boundaries."""
import json
import os
from pathlib import Path
import subprocess

import pytest

MODULE = 'codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs'


def node(root, script):
    return subprocess.run(['node', '--input-type=module', '-e', script], cwd=root,
                          capture_output=True, text=True, check=True, timeout=20)


def test_mobile_key_exports_match_registered_public_key(repository_root, tmp_path):
    os.chmod(tmp_path, 0o700)
    configured = tmp_path / 'authorized_keys'
    configured.write_text('existing-config-key\n')
    result = node(repository_root, f"""
import {{mobileStorage}} from './{MODULE}';
import {{writeFileSync}} from 'node:fs';
const directory={json.dumps(str(tmp_path))};
const store=mobileStorage(directory);
const first=store.setup();
writeFileSync(directory+'/pkcs8.pem',store.pem('pkcs8'),{{mode:0o600}});
writeFileSync(directory+'/sec1.pem',store.pem('sec1'),{{mode:0o600}});
const second=mobileStorage(directory).setup();
console.log(JSON.stringify({{same:first.fingerprint===second.fingerprint,count:store.sync()}}));
""")
    assert json.loads(result.stdout) == {'same': True, 'count': 1}
    public = (tmp_path / 'mobile/authorized_keys').read_text().split()[:2]
    for fmt, header in [('pkcs8', 'PRIVATE KEY'), ('sec1', 'EC PRIVATE KEY')]:
        key = tmp_path / f'{fmt}.pem'
        assert key.read_text().startswith('-----BEGIN ' + header + '-----')
        derived = subprocess.run(['ssh-keygen', '-y', '-f', str(key)], capture_output=True, text=True, check=True)
        assert derived.stdout.split()[:2] == public
        assert key.stat().st_mode & 0o077 == 0
    assert configured.read_text() == 'existing-config-key\n'
    assert (tmp_path / 'mobile').stat().st_mode & 0o077 == 0
    assert (tmp_path / 'mobile/private.pem').stat().st_mode & 0o077 == 0
    assert (tmp_path / 'mobile/authorized_keys').stat().st_mode & 0o077 == 0


def test_revocation_survives_sync_and_next_setup_rotates(repository_root, tmp_path):
    os.chmod(tmp_path, 0o700)
    result = node(repository_root, f"""
import {{mobileStorage}} from './{MODULE}';
const store=mobileStorage({json.dumps(str(tmp_path))});
const first=store.setup(); store.revoke();
const count=store.sync(); const empty=store.status()===null;
const second=store.setup();
console.log(JSON.stringify({{count,empty,rotated:first.fingerprint!==second.fingerprint}}));
""")
    assert json.loads(result.stdout) == {'count': 0, 'empty': True, 'rotated': True}


@pytest.mark.parametrize('unsafe', ['directory', 'permissions', 'symlink', 'hardlink', 'algorithm'])
def test_mobile_storage_rejects_unsafe_state(repository_root, tmp_path, unsafe):
    os.chmod(tmp_path, 0o700)
    result = node(repository_root, f"""
import {{mobileStorage}} from './{MODULE}';
import {{chmodSync,symlinkSync,linkSync,unlinkSync,writeFileSync}} from 'node:fs';
import {{generateKeyPairSync}} from 'node:crypto';
const dir={json.dumps(str(tmp_path))}, problem={json.dumps(unsafe)};
let store=mobileStorage(dir);store.setup();
const file=dir+'/mobile/private.pem';
if(problem==='directory') chmodSync(dir+'/mobile',0o755);
if(problem==='permissions') chmodSync(file,0o644);
if(problem==='symlink') {{unlinkSync(file);symlinkSync(dir+'/absent',file);}}
if(problem==='hardlink') linkSync(file,dir+'/second-link');
if(problem==='algorithm') writeFileSync(file,generateKeyPairSync('ec',{{namedCurve:'secp384r1'}}).privateKey.export({{type:'pkcs8',format:'pem'}}));
let rejected=false;try {{store=mobileStorage(dir);store.sync();}} catch {{rejected=true;}}
console.log(JSON.stringify({{rejected}}));
""")
    assert json.loads(result.stdout)['rejected'] is True


@pytest.mark.parametrize('command', ['setup', 'show'])
def test_private_key_commands_refuse_redirected_output(repository_root, command):
    result = subprocess.run(['node', MODULE, command], cwd=repository_root, capture_output=True, text=True)
    assert result.returncode == 1
    assert 'interactive' in result.stderr
    assert 'PRIVATE KEY' not in result.stdout + result.stderr


def test_boot_and_sshd_use_separate_persistent_mobile_keys(rootfs):
    config = (rootfs / 'etc/ssh/sshd_config').read_text()
    assert 'AuthorizedKeysFile /data/ssh/authorized_keys /data/ssh/mobile/authorized_keys' in config
    assert 'PasswordAuthentication no' in config
    init = (rootfs / 'usr/local/bin/codex-ha-init').read_text()
    assert 'mobile_key_count=$(/usr/local/bin/ha-codex-remote sync)' in init
    assert 'valid_key_count=$((valid_key_count + mobile_key_count))' in init


def test_status_diagnostics_states(repository_root, tmp_path):
    os.chmod(tmp_path, 0o700)
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    result = node(repository_root, f"""
import {{main, mobileStorage}} from './{MODULE}';
import {{writeFileSync, chmodSync, mkdirSync, unlinkSync}} from 'node:fs';

process.env.CODEX_SSH_DIR = {json.dumps(str(tmp_path))};
process.env.CODEX_RUN_DIR = {json.dumps(str(run_dir))};

function runStatus() {{
  let output = '';
  const originalLog = console.log;
  try {{
    console.log = (...args) => {{ output += args.join(' ') + '\\n'; }};
    main(['status'], {json.dumps(str(tmp_path))});
  }} finally {{
    console.log = originalLog;
  }}
  return output;
}}

// 1. Initial state: absent files
const out1 = runStatus();

// 2. Configured and synced key (simulate setup)
const store = mobileStorage({json.dumps(str(tmp_path))});
store.setup();
const out2 = runStatus();

// 3. Private key chmod 0400: present (0400)
const privFile = {json.dumps(str(tmp_path / 'mobile' / 'private.pem'))};
chmodSync(privFile, 0o400);
const out3 = runStatus();

// 4. Insecure private key chmod 0777: insecure permissions
chmodSync(privFile, 0o777);
const out4 = runStatus();
chmodSync(privFile, 0o600);

// 5. Disabled marker in runDir: disabled (no keys registered at startup)
const markerDir = {json.dumps(str(run_dir / 'codex-ha'))};
mkdirSync(markerDir, {{recursive: true}});
const markerFile = {json.dumps(str(run_dir / 'codex-ha' / 'ssh-disabled'))};
writeFileSync(markerFile, '');
const out5 = runStatus();
unlinkSync(markerFile);

// 6. Fake non-sshd PID in sshd.pid (e.g. current process pid): pid_mismatch
const pidFile = {json.dumps(str(run_dir / 'sshd.pid'))};
writeFileSync(pidFile, String(process.pid));
const out6 = runStatus();

// 7. Stale PID in sshd.pid (e.g. pid 999999): stale_pid
writeFileSync(pidFile, '999999');
const out7 = runStatus();

console.log(JSON.stringify({{
  out1_not_running: out1.includes('SSH service: not_disabled / listener not_running'),
  out1_unverified_auth: out1.includes('SSH auth: not_checked (confirm Accepted publickey in App logs)'),
  out1_bootstrap: out1.includes('Codex bootstrap: not_checked (verified when client connects)'),
  out1_absent_priv: out1.includes('Private material: absent'),
  out1_absent_auth: out1.includes('Authorized keys: absent'),

  out2_synced_auth: out2.includes('Authorized keys: synchronized (1 key)'),
  out2_priv_0600: out2.includes('Private material: present (0600)'),

  out3_priv_0400: out3.includes('Private material: present (0400)'),
  out4_priv_insecure: out4.includes('Private material: insecure permissions (0777)'),

  out5_ssh_disabled: out5.includes('SSH service: disabled (no keys registered at startup)'),
  out6_pid_mismatch: out6.includes('SSH service: not_disabled / pid_mismatch'),
  out7_stale_pid: out7.includes('SSH service: not_disabled / stale_pid (process not_running)'),
}}));
""")
    data = json.loads(result.stdout)
    for k, v in data.items():
        assert v is True, f"Condition {k} failed"


def test_status_authorized_keys_comment_and_mismatch(repository_root, tmp_path):
    os.chmod(tmp_path, 0o700)
    result = node(repository_root, f"""
import {{main, mobileStorage}} from './{MODULE}';
import {{writeFileSync}} from 'node:fs';

process.env.CODEX_SSH_DIR = {json.dumps(str(tmp_path))};

const store = mobileStorage({json.dumps(str(tmp_path))});
const pub = store.setup();
const authFile = {json.dumps(str(tmp_path / 'mobile' / 'authorized_keys'))};

function runStatus() {{
  let output = '';
  const originalLog = console.log;
  try {{
    console.log = (...args) => {{ output += args.join(' ') + String.fromCharCode(10); }};
    main(['status'], {json.dumps(str(tmp_path))});
  }} finally {{
    console.log = originalLog;
  }}
  return output;
}}

// 1. Comment out the key
writeFileSync(authFile, '# ' + pub.line + String.fromCharCode(10));
const outComment = runStatus();

// 2. Unrelated/mismatched key
writeFileSync(authFile, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG... other' + String.fromCharCode(10));
const outMismatch = runStatus();

// 3. Empty authorized_keys file
writeFileSync(authFile, '   ' + String.fromCharCode(10));
const outEmpty = runStatus();

// 4. Normal synchronized key
writeFileSync(authFile, pub.line + String.fromCharCode(10));
const outSync = runStatus();

console.log(JSON.stringify({{
  comment_has_commented: outComment.includes('Authorized keys: commented / inactive'),
  mismatch_has_out_of_sync: outMismatch.includes('Authorized keys: out of sync'),
  empty_has_empty: outEmpty.includes('Authorized keys: empty'),
  sync_has_synced: outSync.includes('Authorized keys: synchronized (1 key)'),
}}));
""")
    data = json.loads(result.stdout)
    assert data["comment_has_commented"] is True
    assert data["mismatch_has_out_of_sync"] is True
    assert data["empty_has_empty"] is True
    assert data["sync_has_synced"] is True
