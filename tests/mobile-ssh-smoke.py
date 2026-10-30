#!/usr/bin/env python3
"""Isolated image SSH/PEM acceptance; never prints generated private-key output."""
import os
import pty
import select
import subprocess
import sys
import time
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else 'codex-ha:remote-setup'
name = 'codex-mobile-smoke-' + uuid.uuid4().hex[:12]
volume = name + '-data'


def command(args, check=True):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if check and result.returncode:
        raise RuntimeError('Isolated mobile SSH smoke command failed (output suppressed)')
    return result


def execute(script, check=True):
    return command(['docker', 'exec', name, 'bash', '-euc', script], check)


def start():
    command(['docker', 'run', '-d', '--name', name, '--mount', f'type=volume,src={volume},dst=/data',
             '--entrypoint', 'sleep', image, '300'])
    execute('install -d -m 0700 /data/ssh /run/codex-ha; install -d -m 0755 /run/sshd; '
            'touch /data/ssh/authorized_keys; chmod 600 /data/ssh/authorized_keys; passwd -d root >/dev/null')


def interactive_setup():
    master, slave = pty.openpty()
    process = subprocess.Popen(['docker', 'exec', '-it', name, 'ha-codex-remote', 'setup'],
                               stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
            if process.poll() is not None:
                break
        if process.wait(timeout=5) or b'BEGIN PRIVATE KEY' not in output:
            raise RuntimeError('Interactive setup failed (private output suppressed)')
    finally:
        if process.poll() is None:
            process.kill(); process.wait()
        os.close(master)
        output.clear()


try:
    start()
    # Actual human command in a PTY, including disabled-SSH startup fallback.
    execute('touch /run/codex-ha/ssh-disabled')
    interactive_setup()
    assert execute('test ! -e /run/codex-ha/ssh-disabled', False).returncode == 0
    before = execute('ha-codex-remote status').stdout
    assert b'PRIVATE KEY' not in before
    # App recreation with the same /data simulates restart/config rewrite sync.
    command(['docker', 'rm', '-f', name])
    start()
    assert execute('ha-codex-remote sync').stdout.strip() == b'1'
    assert execute('ha-codex-remote status').stdout == before
    execute("node --input-type=module -e \"import {mobileStorage} from '/usr/local/share/codex-ha/codex-remote-setup.mjs'; "
            "import {writeFileSync} from 'node:fs'; const store=mobileStorage('/data/ssh'); "
            "for(const format of ['pkcs8','sec1']) writeFileSync('/tmp/'+format+'.pem',store.pem(format),{mode:384});\"")
    execute('ssh-keygen -q -t ed25519 -N "" -f /data/ssh/ssh_host_ed25519_key; '
            'ssh-keygen -q -t rsa -b 3072 -N "" -f /data/ssh/ssh_host_rsa_key; '
            'sed -e "s/^Port 22$/Port 2222/" -e "s/ListenAddress 0.0.0.0/ListenAddress 127.0.0.1/" '
            '/etc/ssh/sshd_config > /tmp/mobile-sshd.conf; '
            '/usr/sbin/sshd -t -f /tmp/mobile-sshd.conf; '
            '/usr/sbin/sshd -f /tmp/mobile-sshd.conf -E /tmp/sshd-test.log')
    ssh = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts -o IdentitiesOnly=yes -p 2222'
    for fmt in ('pkcs8', 'sec1'):
        result = execute(f'{ssh} -i /tmp/{fmt}.pem root@127.0.0.1 "printf MOBILE_OK"')
        assert result.stdout == b'MOBILE_OK'
    execute('ha-codex-remote revoke')
    assert execute('ha-codex-remote sync').stdout.strip() == b'0'
    for fmt in ('pkcs8', 'sec1'):
        assert execute(f'{ssh} -i /tmp/{fmt}.pem root@127.0.0.1 true', False).returncode == 255
    # Boot the actual S6 stack without configured keys, then enable SSH in-place.
    execute("printf '%s' '{\"authorized_keys\":[],\"codex_auto_update\":false,\"web_terminal_auto_start_codex\":false}' > /data/options.json")
    command(['docker', 'rm', '-f', name])
    command(['docker', 'run', '-d', '--name', name, '--mount', f'type=volume,src={volume},dst=/data',
             '--entrypoint', '/bin/bash', image, '-ec',
             'mkdir -p /config/.storage; printf "{}\\n" > /config/secrets.yaml; exec /init'])
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        ready = execute('test -e /run/codex-ha/ssh-disabled && test -e /run/service/sshd/supervise/status', False)
        if ready.returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('S6 disabled SSH state did not become ready (logs suppressed)')
    interactive_setup()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if execute('pgrep sshd', False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('S6 did not start sshd after mobile setup (logs suppressed)')
    identity = execute('ha-codex-remote status').stdout
    command(['docker', 'rm', '-f', name])
    command(['docker', 'run', '-d', '--name', name, '--mount', f'type=volume,src={volume},dst=/data',
             '--entrypoint', '/bin/bash', image, '-ec',
             'mkdir -p /config/.storage; printf "{}\\n" > /config/secrets.yaml; exec /init'])
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if execute('pgrep sshd && test ! -e /run/codex-ha/ssh-disabled', False).returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('S6 did not preserve mobile SSH access after restart')
    assert execute('ha-codex-remote status').stdout == identity
    execute("node --input-type=module -e \"import {mobileStorage} from '/usr/local/share/codex-ha/codex-remote-setup.mjs'; "
            "import {writeFileSync} from 'node:fs';writeFileSync('/tmp/sec1.pem',mobileStorage('/data/ssh').pem('sec1'),{mode:384});\"")
    result = execute('ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts '
                     '-o IdentitiesOnly=yes -p 22 -i /tmp/sec1.pem root@127.0.0.1 "printf S6_OK"')
    assert result.stdout == b'S6_OK'
    print('PASS: interactive setup, both PEM SSH auth, revoke rejection, S6 activation/restart and SSH login')
finally:
    command(['docker', 'rm', '-f', name], check=False)
    command(['docker', 'volume', 'rm', '-f', volume], check=False)
