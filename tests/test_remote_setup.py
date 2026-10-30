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
