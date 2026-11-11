"""Isolated image SSH/PEM acceptance; never prints generated private-key output."""
import os
import pty
import select
import subprocess
import sys
import time
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('IMAGE_NAME', 'codex-ha:remote-setup')
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
    command(['docker', 'run', '-d', '--name', name,
             '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
             '--cap-add', 'NET_ADMIN',
             '--mount', f'type=volume,src={volume},dst=/data',
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
    command(['docker', 'run', '-d', '--name', name,
             '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
             '--cap-add', 'NET_ADMIN',
             '--mount', f'type=volume,src={volume},dst=/data',
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
    command(['docker', 'run', '-d', '--name', name,
             '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
             '--cap-add', 'NET_ADMIN',
             '--mount', f'type=volume,src={volume},dst=/data',
             '--entrypoint', '/bin/bash', image, '-ec',
             'mkdir -p /config/.storage; printf "{}\\n" > /config/secrets.yaml; exec /init'])
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if execute('pgrep sshd && test ! -e /run/codex-ha/ssh-disabled', False).returncode == 0:
            if execute('ha-codex-remote status', False).stdout == identity:
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

    # Product wrapper + SSH bootstrap verification:
    # 1. Start background app-server listener inside container
    execute('/usr/local/bin/codex app-server --listen unix:///tmp/bootstrap.sock >/dev/null 2>&1 &')
    for _ in range(50):
        if execute('test -S /tmp/bootstrap.sock', False).returncode == 0:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError('App-server listener failed to create socket')

    # 2. Connect via SSH executing product wrapper codex app-server proxy
    ssh_cmd = [
        'docker', 'exec', '-i', name,
        'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/tmp/known_hosts', '-o', 'IdentitiesOnly=yes',
        '-p', '22', '-i', '/tmp/sec1.pem', 'root@127.0.0.1',
        '/usr/local/bin/codex app-server proxy --sock /tmp/bootstrap.sock'
    ]
    proc = subprocess.Popen(
        ssh_cmd,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )

    def read_exact(n, timeout=15.0):
        deadline = time.monotonic() + timeout
        buf = bytearray()
        while len(buf) < n:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError(f'Timed out waiting for {n - len(buf)} bytes from SSH proxy')
            r, _, _ = select.select([proc.stdout], [], [], rem)
            if not r:
                raise TimeoutError(f'Timed out waiting for data on SSH proxy stdout')
            chunk = os.read(proc.stdout.fileno(), n - len(buf))
            if not chunk:
                err_line = ''
                if proc.stderr:
                    r_err, _, _ = select.select([proc.stderr], [], [], 0.5)
                    if r_err:
                        lines = os.read(proc.stderr.fileno(), 1024).decode('utf-8', errors='replace').splitlines()
                        err_line = lines[0] if lines else ''
                raise EOFError(f'unexpected EOF from SSH proxy: rc={proc.poll()} err={err_line!r}')
            buf.extend(chunk)
        return bytes(buf)

    import base64, json, struct
    key = base64.b64encode(os.urandom(16))
    upgrade_req = (
        b'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
        b'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + b'\r\nSec-WebSocket-Version: 13\r\n\r\n'
    )
    proc.stdin.write(upgrade_req)
    proc.stdin.flush()

    header = bytearray()
    while not header.endswith(b'\r\n\r\n'):
        header.extend(read_exact(1, timeout=15.0))
    assert b'HTTP/1.1 101 ' in header, f'Expected HTTP 101, got {header!r}'

    def send_ws_json(obj):
        payload = json.dumps(obj).encode('utf-8')
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        length = len(payload)
        if length <= 125:
            hdr = bytes([0x81, 0x80 | length])
        elif length <= 65535:
            hdr = bytes([0x81, 0x80 | 126]) + struct.pack('!H', length)
        else:
            hdr = bytes([0x81, 0x80 | 127]) + struct.pack('!Q', length)
        proc.stdin.write(hdr + mask + masked)
        proc.stdin.flush()

    def read_ws_frame(timeout=15.0):
        b1, b2 = read_exact(2, timeout=timeout)
        opcode = b1 & 0x0F
        has_mask = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack('!H', read_exact(2, timeout=timeout))[0]
        elif length == 127:
            length = struct.unpack('!Q', read_exact(8, timeout=timeout))[0]
        mask = read_exact(4, timeout=timeout) if has_mask else None
        raw_payload = read_exact(length, timeout=timeout)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw_payload)) if mask else raw_payload
        return opcode, payload

    # 1. Send initialize
    send_ws_json({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'smoke', 'version': '1'}, 'capabilities': {'experimentalApi': True}}})
    op, payload = read_ws_frame(timeout=10.0)
    assert op == 1
    init_res = json.loads(payload.decode('utf-8'))
    assert init_res.get('id') == 1 and 'result' in init_res, f'Invalid init response: {init_res}'

    # 2. Send initialized notification
    send_ws_json({'method': 'initialized', 'params': {}})

    # 3. Subsequent request 1: server/diagnostics
    send_ws_json({'id': 2, 'method': 'server/diagnostics', 'params': {}})
    diag_res = None
    for _ in range(5):
        op, payload = read_ws_frame(timeout=10.0)
        if op == 1:
            msg = json.loads(payload.decode('utf-8'))
            if msg.get('id') == 2:
                diag_res = msg
                break
    assert diag_res and 'result' in diag_res, f'Unexpected diagnostics response: {diag_res}'

    # 4. Subsequent request 2: model/list
    send_ws_json({'id': 3, 'method': 'model/list', 'params': {}})
    models_res = None
    for _ in range(5):
        op, payload = read_ws_frame(timeout=10.0)
        if op == 1:
            msg = json.loads(payload.decode('utf-8'))
            if msg.get('id') == 3:
                models_res = msg
                break
    assert models_res and 'result' in models_res, f'Unexpected models response: {models_res}'

    # 5. Subsequent request 3: config/read verifying round-trips and continuity on same connection
    send_ws_json({'id': 4, 'method': 'config/read', 'params': {}})
    config_res = None
    for _ in range(5):
        op, payload = read_ws_frame(timeout=10.0)
        if op == 1:
            msg = json.loads(payload.decode('utf-8'))
            if msg.get('id') == 4:
                config_res = msg
                break
    assert config_res and 'result' in config_res, f'Unexpected config response: {config_res}'

    # 6. Clean client EOF termination
    peer_inventory = execute("node --input-type=module -e \"import {inspectAllSessions} from '/usr/local/share/codex-ha/codex-runtime-manager.mjs'; const r=await inspectAllSessions(); console.log(JSON.stringify({helpers:r.counts.helpers,unknown:r.counts.unknown,canApply:r.canApply}));\"")
    peer_result = json.loads(peer_inventory.stdout)
    assert peer_result['helpers'] >= 1 and peer_result['unknown'] == 0, peer_result
    print('PASS: actual image wrapper proxy mapped to kernel peer owner', peer_result)
    proc.stdin.close()
    proc.wait(timeout=5)
    assert proc.returncode == 0

    print('PASS: interactive setup, both PEM SSH auth, revoke rejection, S6 activation/restart and SSH wrapper proxy bootstrap')
finally:
    command(['docker', 'rm', '-f', name], check=False)
    command(['docker', 'volume', 'rm', '-f', volume], check=False)
