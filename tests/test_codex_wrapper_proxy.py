"""Regression tests for codex app-server proxy transport, framing, and updater protection."""
import base64
import hashlib
import http.server
import threading
import json
import os
import select
import shutil
import signal
import struct
import subprocess
import time
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def find_all_test_codex_binaries() -> list[Path]:
    env_bin = os.environ.get("CODEX_WIRE_PROBE_BINARY")
    if env_bin and Path(env_bin).exists():
        return [Path(env_bin).resolve()]
    found = []
    seen_hashes = set()
    for candidate in [
        REPOSITORY_ROOT / ".test-tmp/task007-baseline/bin/codex",
        REPOSITORY_ROOT / ".test-tmp/resume-166/bin/codex",
    ]:
        if candidate.exists() and os.access(candidate, os.X_OK):
            h = hashlib.sha256(candidate.read_bytes()).hexdigest()
            if h not in seen_hashes:
                seen_hashes.add(h)
                found.append(candidate.resolve())
    return found


ALL_BINARIES = find_all_test_codex_binaries()


@pytest.fixture(params=ALL_BINARIES if ALL_BINARIES else [None], ids=lambda p: p.parent.parent.name if p else "none")
def codex_binary(request) -> Path:
    if request.param is None:
        pytest.skip("No real codex binary found in test environment or CODEX_WIRE_PROBE_BINARY")
    return request.param


def make_ws_upgrade_request(key: bytes | None = None) -> bytes:
    if key is None:
        key = base64.b64encode(os.urandom(16))
    return (
        b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
        b"Connection: Upgrade\r\nSec-WebSocket-Key: " + key + b"\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )


def make_masked_ws_text_frame(text: str) -> bytes:
    payload = text.encode("utf-8")
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    length = len(payload)
    if length <= 125:
        header = bytes([0x81, 0x80 | length])
    elif length <= 65535:
        header = bytes([0x81, 0x80 | 126]) + struct.pack("!H", length)
    else:
        header = bytes([0x81, 0x80 | 127]) + struct.pack("!Q", length)
    return header + mask + masked


def read_ws_frame(stream, timeout: float = 10.0) -> tuple[int, bytes]:
    deadline = time.monotonic() + timeout

    def read_exact(n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            rem = deadline - time.monotonic()
            assert rem > 0 and select.select([stream], [], [], rem)[0], "Read timed out"
            chunk = os.read(stream.fileno(), n - len(buf))
            assert chunk, "Unexpected EOF on stream"
            buf.extend(chunk)
        return bytes(buf)

    b1, b2 = read_exact(2)
    opcode = b1 & 0x0F
    has_mask = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(8))[0]
    mask = read_exact(4) if has_mask else None
    raw_payload = read_exact(length)
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw_payload))
    else:
        payload = raw_payload
    return opcode, payload


def test_proxy_transport_defect_reproduction_on_jsonl_host(repository_root: Path, tmp_path: Path) -> None:
    """Verifies that sending HTTP WebSocket Upgrade to a JSONL session host reproduces malformed_frame in jsonl."""
    session_host = repository_root / "codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs"
    ctl = tmp_path / "ctl.sock"
    proc = subprocess.Popen(
        ["node", str(session_host), "--control-socket", str(ctl), "--type", "remote-stdio", "--exe", "/bin/cat", "--"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        proc.stdin.write(make_ws_upgrade_request())
        proc.stdin.flush()
        _, err = proc.communicate(timeout=5)
        assert proc.returncode != 0
        assert "malformed_frame in jsonl" in err.decode("utf-8")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_official_proxy_wire_upgrade_and_initialize(codex_binary: Path, tmp_path: Path) -> None:
    """Verifies official app-server proxy performs HTTP Upgrade and WebSocket initialize cleanly."""
    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    socket_path = tmp_path / "s.sock"
    env = {**os.environ, "HOME": str(home), "CODEX_HOME": str(codex_home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}

    server = subprocess.Popen([str(codex_binary), "app-server", "--listen", f"unix://{socket_path}"],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy = None
    try:
        deadline = time.monotonic() + 15
        while not socket_path.exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket_path.exists(), "app-server unix socket was not created"

        proxy = subprocess.Popen([str(codex_binary), "app-server", "proxy", "--sock", str(socket_path)],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # 1. HTTP Upgrade
        proxy.stdin.write(make_ws_upgrade_request())
        proxy.stdin.flush()

        resp_header = bytearray()
        while not resp_header.endswith(b"\r\n\r\n"):
            assert select.select([proxy.stdout], [], [], 10.0)[0]
            chunk = os.read(proxy.stdout.fileno(), 1)
            assert chunk
            resp_header.extend(chunk)

        assert resp_header.startswith(b"HTTP/1.1 101 ")

        # 2. WebSocket initialize frame
        init_req = json.dumps({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}, "capabilities": {"experimentalApi": True}}})
        proxy.stdin.write(make_masked_ws_text_frame(init_req))
        proxy.stdin.flush()

        opcode, payload = read_ws_frame(proxy.stdout)
        assert opcode == 1  # Text frame
        init_res = json.loads(payload.decode("utf-8"))
        assert init_res.get("id") == 1 and "result" in init_res

        # 3. Initialized notification
        proxy.stdin.write(make_masked_ws_text_frame(json.dumps({"method": "initialized", "params": {}})))
        proxy.stdin.flush()

        # 4. Subsequent request: server/diagnostics
        proxy.stdin.write(make_masked_ws_text_frame(json.dumps({"id": 2, "method": "server/diagnostics", "params": {}})))
        proxy.stdin.flush()
        diag_res = None
        for _ in range(5):
            op, pl = read_ws_frame(proxy.stdout)
            if op == 1:
                msg = json.loads(pl.decode("utf-8"))
                if msg.get("id") == 2:
                    diag_res = msg
                    break
        assert diag_res and "result" in diag_res, f"Unexpected diagnostics response: {diag_res}"

        # 5. Subsequent request: thread/start
        proxy.stdin.write(make_masked_ws_text_frame(json.dumps({"id": 3, "method": "thread/start", "params": {"cwd": str(tmp_path)}})))
        proxy.stdin.flush()
        thread_id = None
        for _ in range(5):
            op, pl = read_ws_frame(proxy.stdout)
            if op == 1:
                msg = json.loads(pl.decode("utf-8"))
                if msg.get("id") == 3:
                    thread_id = msg.get("result", {}).get("thread", {}).get("id")
                    break
        assert thread_id, f"Failed to obtain thread id: {msg}"

        # 6. Subsequent request: thread/read verifying conversation preservation on same connection
        proxy.stdin.write(make_masked_ws_text_frame(json.dumps({"id": 4, "method": "thread/read", "params": {"threadId": thread_id}})))
        proxy.stdin.flush()
        read_res = None
        for _ in range(5):
            op, pl = read_ws_frame(proxy.stdout)
            if op == 1:
                msg = json.loads(pl.decode("utf-8"))
                if msg.get("id") == 4:
                    read_res = msg
                    break
        assert read_res and read_res.get("result", {}).get("thread", {}).get("id") == thread_id

        # 7. Clean termination on client EOF
        proxy.stdin.close()
        assert proxy.wait(timeout=5) == 0
    finally:
        for p in (proxy, server):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        try:
            provider.shutdown()
        except Exception:
            pass


def test_proxy_split_frames_and_control_frames(codex_binary: Path, tmp_path: Path) -> None:
    """Verifies that frame fragmentation, split bytes, and ping control frames are cleanly handled."""
    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    socket_path = tmp_path / "split.sock"
    env = {**os.environ, "HOME": str(home), "CODEX_HOME": str(codex_home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}

    server = subprocess.Popen([str(codex_binary), "app-server", "--listen", f"unix://{socket_path}"],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy = None
    try:
        deadline = time.monotonic() + 15
        while not socket_path.exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket_path.exists()

        proxy = subprocess.Popen([str(codex_binary), "app-server", "proxy", "--sock", str(socket_path)],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Send Upgrade header split in multiple chunks
        req_bytes = make_ws_upgrade_request()
        proxy.stdin.write(req_bytes[:20])
        proxy.stdin.flush()
        time.sleep(0.05)
        proxy.stdin.write(req_bytes[20:])
        proxy.stdin.flush()

        resp_header = bytearray()
        while not resp_header.endswith(b"\r\n\r\n"):
            assert select.select([proxy.stdout], [], [], 10.0)[0]
            chunk = os.read(proxy.stdout.fileno(), 1)
            resp_header.extend(chunk)
        assert resp_header.startswith(b"HTTP/1.1 101 ")

        # Send initialize split into byte-by-byte writes
        init_frame = make_masked_ws_text_frame(json.dumps({"id": 42, "method": "initialize", "params": {"clientInfo": {"name": "split", "version": "1"}}}))
        for i in range(len(init_frame)):
            proxy.stdin.write(init_frame[i:i+1])
            proxy.stdin.flush()

        opcode, payload = read_ws_frame(proxy.stdout)
        assert opcode == 1
        res = json.loads(payload.decode("utf-8"))
        assert res.get("id") == 42

        # Send Ping frame (opcode 0x09) with 4-byte mask
        mask = os.urandom(4)
        ping_payload = b"ping"
        masked_ping = bytes(b ^ mask[j % 4] for j, b in enumerate(ping_payload))
        ping_frame = bytes([0x89, 0x84]) + mask + masked_ping
        proxy.stdin.write(ping_frame)
        proxy.stdin.flush()

        # Read frames until Pong (opcode 0x0A) or text frames are drained
        pong_received = False
        for _ in range(5):
            opcode, frame_payload = read_ws_frame(proxy.stdout)
            if opcode == 0x0A and frame_payload == b"ping":
                pong_received = True
                break
        assert pong_received, "Did not receive Pong frame in response to Ping"

        # Drain any residual frames before termination
        while select.select([proxy.stdout], [], [], 0.1)[0]:
            chunk = os.read(proxy.stdout.fileno(), 1024)
            if not chunk:
                break

        # Client closing stdin causes proxy to exit cleanly
        proxy.stdin.close()
        assert proxy.wait(timeout=5) == 0
    finally:
        for p in (proxy, server):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        try:
            provider.shutdown()
        except Exception:
            pass

def test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection(codex_binary: Path, tmp_path: Path, repository_root: Path) -> None:
    """Verifies that actual turns execute over raw app-server proxy, context is preserved across turns, and updater holds during active turns."""
    requests = []
    allow_response = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append(json.loads(body))
            assert allow_response.wait(20), "Mock provider response wait timed out"
            turn_num = len(requests)
            events = [
                {"type": "response.created", "response": {"id": f"resp-{turn_num}"}},
                {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant",
                 "id": f"msg-{turn_num}", "content": [{"type": "output_text", "text": f"Answer {turn_num}"}]}},
                {"type": "response.completed", "response": {"id": f"resp-{turn_num}",
                 "usage": {"input_tokens": 5, "output_tokens": 5, "total_tokens": 10}}},
            ]
            res_body = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(res_body)))
            self.end_headers()
            self.wfile.write(res_body)

    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()

    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    (codex_home / "config.toml").write_text(f"""model="synthetic-test"
model_provider="synthetic"
[model_providers.synthetic]
name="Synthetic"
base_url="http://127.0.0.1:{provider.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
""")
    socket_path = tmp_path / "s.sock"
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    (maint_dir / "sessions").mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update": True}), encoding="utf-8")

    env = {**os.environ, "HOME": str(home), "CODEX_HOME": str(codex_home), "LANG": "C.UTF-8"}
    server = subprocess.Popen([str(codex_binary), "app-server", "--listen", f"unix://{socket_path}"],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy = None
    try:
        deadline = time.monotonic() + 15
        while not socket_path.exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket_path.exists(), "app-server socket not created"

        # Register server session
        version_str = "0.166.0" if "166" in str(codex_binary) else "0.162.1"
        stat_parts = Path(f"/proc/{server.pid}/stat").read_text().rsplit(")", 1)[1].split()
        (maint_dir / "sessions" / str(server.pid)).write_text(json.dumps({
            "pid": server.pid, "start": stat_parts[19], "type": "app-server", "managed": True,
            "socketPath": str(socket_path), "exe": str(codex_binary), "version": version_str,
            "cwd": str(tmp_path), "args": ["app-server", "--listen", f"unix://{socket_path}"]
        }), encoding="utf-8")

        proxy = subprocess.Popen([str(codex_binary), "app-server", "proxy", "--sock", str(socket_path)],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        p_stat = Path(f"/proc/{proxy.pid}/stat").read_text().rsplit(")", 1)[1].split()
        (maint_dir / "sessions" / str(proxy.pid)).write_text(json.dumps({
            "pid": proxy.pid, "start": p_stat[19], "type": "app-server-proxy", "managed": False,
            "socketPath": str(socket_path), "exe": str(codex_binary), "version": version_str,
            "cwd": str(tmp_path), "args": ["app-server", "proxy", "--sock", str(socket_path)]
        }), encoding="utf-8")

        # 1. HTTP Upgrade
        proxy.stdin.write(make_ws_upgrade_request())
        proxy.stdin.flush()
        hdr = bytearray()
        while not hdr.endswith(b"\r\n\r\n"):
            assert select.select([proxy.stdout], [], [], 10.0)[0]
            hdr.extend(os.read(proxy.stdout.fileno(), 1))
        assert hdr.startswith(b"HTTP/1.1 101 ")

        def send_msg(obj):
            proxy.stdin.write(make_masked_ws_text_frame(json.dumps(obj)))
            proxy.stdin.flush()

        def recv_msg():
            for _ in range(50):
                op, pl = read_ws_frame(proxy.stdout)
                if op == 1:
                    return json.loads(pl.decode("utf-8"))
            raise AssertionError("No text frame received")

        def recv_resp(req_id):
            for _ in range(50):
                m = recv_msg()
                if m.get("id") == req_id:
                    return m
            raise AssertionError(f"Response for {req_id} missing")

        # 2. initialize & initialized
        send_msg({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}, "capabilities": {"experimentalApi": True}}})
        assert recv_resp(1).get("id") == 1
        send_msg({"method": "initialized", "params": {}})

        # 3. thread/start
        send_msg({"id": 2, "method": "thread/start", "params": {"cwd": str(tmp_path)}})
        th_res = recv_resp(2)
        th_id = th_res["result"]["thread"]["id"]
        assert th_id

        # 4. Turn 1 with Updater Hold Check
        send_msg({"id": 3, "method": "turn/start", "params": {"threadId": th_id, "input": [{"type": "text", "text": "Hello first turn"}]}})
        assert recv_resp(3).get("result", {}).get("turn", {}).get("id")

        # Wait until mock provider receives request
        t0 = time.monotonic()
        while len(requests) < 1 and time.monotonic() - t0 < 10:
            time.sleep(0.05)
        assert len(requests) == 1

        # While turn is active (held in mock provider), updater MUST be held busy
        script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
        process.env.CODEX_BASELINE_DIR = '{codex_binary.parent.parent}';
        const res = await mgr.inspectAllSessions();
        console.log(JSON.stringify(res));
        """
        eval_proc = subprocess.run(["node", "--input-type=module", "-e",
            "import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';" + script],
            cwd=repository_root, capture_output=True, text=True, check=True)
        res_busy = json.loads(eval_proc.stdout.splitlines()[-1])
        assert res_busy["canApply"] is False
        assert res_busy["counts"]["helpers"] == 1

        # Release Turn 1 response and wait for turn/completed
        allow_response.set()
        turn1_done = False
        for _ in range(50):
            m = recv_msg()
            if m.get("method") == "turn/completed" and m.get("params", {}).get("turn", {}).get("status") == "completed":
                turn1_done = True
                break
        assert turn1_done, "Turn 1 did not complete"

        # 5. Turn 2: verify conversation context preservation across turns
        allow_response.clear()
        allow_response.set()
        send_msg({"id": 4, "method": "turn/start", "params": {"threadId": th_id, "input": [{"type": "text", "text": "Second turn context check"}]}})
        assert recv_resp(4).get("result", {}).get("turn", {}).get("id")
        turn2_done = False
        for _ in range(50):
            m = recv_msg()
            if m.get("method") == "turn/completed" and m.get("params", {}).get("turn", {}).get("status") == "completed":
                turn2_done = True
                break
        assert turn2_done, "Turn 2 did not complete"

        assert len(requests) == 2
        # Verify request 2 contains Turn 1 user input and Assistant Answer 1
        req2_str = json.dumps(requests[1])
        assert "Hello first turn" in req2_str
        assert "Answer 1" in req2_str
        assert "Second turn context check" in req2_str

        # 6. Clean client EOF termination
        proxy.stdin.close()
        assert proxy.wait(timeout=5) == 0
    finally:
        for p in (proxy, server):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        try:
            provider.shutdown()
        except Exception:
            pass


def test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity(repository_root: Path, tmp_path: Path) -> None:
    """Verifies full lifecycle: active turn holds updater, completion allows updater, real restart transaction upgrades server from 0.162.1 to 0.166.0, and new proxy resumes thread with full conversation context."""
    bin_162 = repository_root / ".test-tmp/task007-baseline/bin/codex"
    bin_166 = repository_root / ".test-tmp/resume-166/bin/codex"
    assert bin_162.exists() and bin_166.exists(), "Official test binaries missing"

    requests = []
    allow_response = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append(json.loads(body))
            assert allow_response.wait(20), "Mock provider response wait timed out"
            turn_num = len(requests)
            events = [
                {"type": "response.created", "response": {"id": f"resp-{turn_num}"}},
                {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant",
                 "id": f"msg-{turn_num}", "content": [{"type": "output_text", "text": f"Answer {turn_num}"}]}},
                {"type": "response.completed", "response": {"id": f"resp-{turn_num}",
                 "usage": {"input_tokens": 5, "output_tokens": 5, "total_tokens": 10}}},
            ]
            res_body = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(res_body)))
            self.end_headers()
            self.wfile.write(res_body)

    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()

    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    (codex_home / "config.toml").write_text(f"""model="synthetic-test"
model_provider="synthetic"
[model_providers.synthetic]
name="Synthetic"
base_url="http://127.0.0.1:{provider.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
""")
    socket_path = tmp_path / "s.sock"
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update": True}), encoding="utf-8")

    releases_dir = runtime_dir / "releases"
    rel_162 = releases_dir / "0.162.1-x86_64-unknown-linux-musl"
    rel_166 = releases_dir / "0.166.0-x86_64-unknown-linux-musl"
    shutil.copytree(bin_162.parent.parent, rel_162, dirs_exist_ok=True)
    shutil.copytree(bin_166.parent.parent, rel_166, dirs_exist_ok=True)

    current_link = runtime_dir / "current"
    current_link.symlink_to(rel_162)

    env = {
        **os.environ,
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "LANG": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }

    server_bin = rel_162 / "bin" / "codex"
    server1 = subprocess.Popen([str(server_bin), "app-server", "--listen", f"unix://{socket_path}"],
                               env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy1 = None
    proxy2 = None
    try:
        deadline = time.monotonic() + 15
        while not socket_path.exists() and server1.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket_path.exists(), "app-server socket not created"

        stat_parts = Path(f"/proc/{server1.pid}/stat").read_text().rsplit(")", 1)[1].split()
        server_rec = {
            "pid": server1.pid, "start": stat_parts[19], "type": "app-server", "managed": True,
            "socketPath": str(socket_path), "exe": str(server_bin), "version": "0.162.1",
            "cwd": str(tmp_path), "args": ["app-server", "--listen", f"unix://{socket_path}"]
        }
        (sessions_dir / str(server1.pid)).write_text(json.dumps(server_rec), encoding="utf-8")

        proxy1 = subprocess.Popen([str(server_bin), "app-server", "proxy", "--sock", str(socket_path)],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p1_stat = Path(f"/proc/{proxy1.pid}/stat").read_text().rsplit(")", 1)[1].split()
        (sessions_dir / str(proxy1.pid)).write_text(json.dumps({
            "pid": proxy1.pid, "start": p1_stat[19], "type": "app-server-proxy", "managed": False,
            "socketPath": str(socket_path), "exe": str(server_bin), "version": "0.162.1",
            "cwd": str(tmp_path), "args": ["app-server", "proxy", "--sock", str(socket_path)]
        }), encoding="utf-8")

        proxy1.stdin.write(make_ws_upgrade_request())
        proxy1.stdin.flush()
        hdr = bytearray()
        while not hdr.endswith(b"\r\n\r\n"):
            assert select.select([proxy1.stdout], [], [], 10.0)[0]
            hdr.extend(os.read(proxy1.stdout.fileno(), 1))
        assert hdr.startswith(b"HTTP/1.1 101 ")

        def send_msg1(obj):
            proxy1.stdin.write(make_masked_ws_text_frame(json.dumps(obj)))
            proxy1.stdin.flush()

        def recv_msg1():
            for _ in range(50):
                op, pl = read_ws_frame(proxy1.stdout)
                if op == 1:
                    return json.loads(pl.decode("utf-8"))
            raise AssertionError("No text frame received")

        def recv_resp1(req_id):
            for _ in range(50):
                m = recv_msg1()
                if m.get("id") == req_id:
                    return m
            raise AssertionError(f"Response for {req_id} missing")

        send_msg1({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}, "capabilities": {"experimentalApi": True}}})
        assert recv_resp1(1).get("id") == 1
        send_msg1({"method": "initialized", "params": {}})

        send_msg1({"id": 2, "method": "thread/start", "params": {"cwd": str(tmp_path)}})
        th_res = recv_resp1(2)
        th_id = th_res["result"]["thread"]["id"]
        assert th_id

        # Turn 1: send and hold response
        send_msg1({"id": 3, "method": "turn/start", "params": {"threadId": th_id, "input": [{"type": "text", "text": "Hello first turn"}]}})
        assert recv_resp1(3).get("result", {}).get("turn", {}).get("id")

        t0 = time.monotonic()
        while len(requests) < 1 and time.monotonic() - t0 < 10:
            time.sleep(0.05)
        assert len(requests) == 1

        # While Turn 1 is active, verify update is held
        inspect_script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
        process.env.CODEX_BASELINE_DIR = '{rel_162}';
        const res = await mgr.inspectAllSessions();
        console.log(JSON.stringify(res));
        """
        eval_proc = subprocess.run(["node", "--input-type=module", "-e",
            "import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';" + inspect_script],
            cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        res_busy = json.loads(eval_proc.stdout.splitlines()[-1])
        assert res_busy["canApply"] is False
        assert res_busy["counts"]["helpers"] == 1

        # Release response and complete Turn 1
        allow_response.set()
        turn1_done = False
        for _ in range(50):
            m = recv_msg1()
            if m.get("method") == "turn/completed" and m.get("params", {}).get("turn", {}).get("status") == "completed":
                turn1_done = True
                break
        assert turn1_done, "Turn 1 did not complete"

        # Close proxy 1
        proxy1.stdin.close()
        assert proxy1.wait(timeout=5) == 0
        (sessions_dir / str(proxy1.pid)).unlink(missing_ok=True)
        proxy1 = None

        # Verify idle server is now restartable and canApply is True
        eval_proc = subprocess.run(["node", "--input-type=module", "-e",
            "import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';" + inspect_script],
            cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        res_idle = json.loads(eval_proc.stdout.splitlines()[-1])
        assert res_idle["canApply"] is True, f"Inspection not idle: {res_idle}"
        assert res_idle["counts"]["managedIdleServers"] == 1

        # Execute real restartServers transaction upgrading to 0.166.0
        candidate_bin = rel_166 / "bin" / "codex"
        restart_script = f"""
        import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';
        import {{ restartServers }} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs';
        import fs from 'node:fs/promises';
        import path from 'node:path';

        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
        process.env.HOME = '{home}';
        process.env.CODEX_HOME = '{codex_home}';

        const serverRecord = {json.dumps(server_rec)};
        const result = await restartServers({{
            servers: [{{
                pid: {server1.pid},
                start: '{server_rec["start"]}',
                type: 'app-server',
                socketPath: '{socket_path}',
                managedRecord: serverRecord,
            }}],
            binary: '{candidate_bin}',
            version: '0.166.0',
            inspectProcess: mgr.inspectProcess,
            inspectServer: mgr.inspectAppServer,
            restoreThreads: mgr.restoreAppServerThreads,
            switchToNew: async () => {{
                await fs.unlink('{current_link}');
                await fs.symlink('{rel_166}', '{current_link}');
            }},
            switchToOld: async () => {{
                await fs.unlink('{current_link}');
                await fs.symlink('{rel_162}', '{current_link}');
            }},
            writeRecord: async (pid, record) => {{
                await fs.writeFile(path.join('{sessions_dir}', String(pid)), JSON.stringify(record));
            }},
            removeRecord: async (pid) => {{
                await fs.unlink(path.join('{sessions_dir}', String(pid))).catch(() => {{}});
            }},
            commitAttempt: async () => {{}},
        }});
        console.log(JSON.stringify(result));
        """
        restart_proc = subprocess.run(["node", "--input-type=module", "-e", restart_script],
                                      cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        res_restart = json.loads(restart_proc.stdout.splitlines()[-1])
        assert res_restart.get("applied") is True

        assert server1.poll() is not None, "Old server did not exit on SIGHUP"

        session_files = list(sessions_dir.glob("*"))
        assert len(session_files) == 1
        new_pid = int(session_files[0].name)
        assert new_pid != server1.pid
        new_server_rec = json.loads(session_files[0].read_text())
        assert new_server_rec["version"] == "0.166.0"
        assert new_server_rec["exe"] == str(candidate_bin)

        # Reconnect with proxy2 to new server (0.166.0)
        proxy2 = subprocess.Popen([str(candidate_bin), "app-server", "proxy", "--sock", str(socket_path)],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p2_stat = Path(f"/proc/{proxy2.pid}/stat").read_text().rsplit(")", 1)[1].split()
        (sessions_dir / str(proxy2.pid)).write_text(json.dumps({
            "pid": proxy2.pid, "start": p2_stat[19], "type": "app-server-proxy", "managed": False,
            "socketPath": str(socket_path), "exe": str(candidate_bin), "version": "0.166.0",
            "cwd": str(tmp_path), "args": ["app-server", "proxy", "--sock", str(socket_path)]
        }), encoding="utf-8")

        proxy2.stdin.write(make_ws_upgrade_request())
        proxy2.stdin.flush()
        hdr2 = bytearray()
        while not hdr2.endswith(b"\r\n\r\n"):
            assert select.select([proxy2.stdout], [], [], 10.0)[0]
            hdr2.extend(os.read(proxy2.stdout.fileno(), 1))
        assert hdr2.startswith(b"HTTP/1.1 101 ")

        def send_msg2(obj):
            proxy2.stdin.write(make_masked_ws_text_frame(json.dumps(obj)))
            proxy2.stdin.flush()

        def recv_msg2():
            for _ in range(50):
                op, pl = read_ws_frame(proxy2.stdout)
                if op == 1:
                    return json.loads(pl.decode("utf-8"))
            raise AssertionError("No text frame received")

        def recv_resp2(req_id):
            for _ in range(50):
                m = recv_msg2()
                if m.get("id") == req_id:
                    return m
            raise AssertionError(f"Response for {req_id} missing")

        send_msg2({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}, "capabilities": {"experimentalApi": True}}})
        assert recv_resp2(1).get("id") == 1
        send_msg2({"method": "initialized", "params": {}})

        # Resume existing thread on new server
        send_msg2({"id": 9, "method": "thread/resume", "params": {"threadId": th_id}})
        th_resume_res = recv_resp2(9)
        assert th_resume_res.get("result", {}).get("thread", {}).get("id") == th_id

        # Execute Turn 2 on existing thread
        allow_response.clear()
        allow_response.set()
        send_msg2({"id": 10, "method": "turn/start", "params": {"threadId": th_id, "input": [{"type": "text", "text": "Hello second turn after update"}]}})
        assert recv_resp2(10).get("result", {}).get("turn", {}).get("id")

        turn2_done = False
        for _ in range(50):
            m = recv_msg2()
            if m.get("method") == "turn/completed" and m.get("params", {}).get("turn", {}).get("status") == "completed":
                turn2_done = True
                break
        assert turn2_done, "Turn 2 did not complete on new server"

        # Verify mock provider request 2 contains full history from Turn 1
        assert len(requests) == 2
        req2_str = json.dumps(requests[1])
        assert "Hello first turn" in req2_str
        assert "Answer 1" in req2_str
        assert "Hello second turn after update" in req2_str

        # Clean EOF termination on proxy 2
        proxy2.stdin.close()
        assert proxy2.wait(timeout=5) == 0
    finally:
        for p in (proxy1, proxy2, server1):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        try:
            for sf in sessions_dir.glob("*"):
                pid = int(sf.name)
                os.kill(pid, 9)
        except Exception:
            pass
        try:
            provider.shutdown()
        except Exception:
            pass


def test_proxy_real_update_restart_transaction_holds_on_nonempty_ephemeral_thread(repository_root: Path, tmp_path: Path) -> None:
    """Verifies that an app-server with a nonempty ephemeral thread holds updater (canApply: false), rejects restart (applied: false), and preserves the live server process and conversation context."""
    bin_162 = repository_root / ".test-tmp/task007-baseline/bin/codex"
    bin_166 = repository_root / ".test-tmp/resume-166/bin/codex"
    assert bin_162.exists() and bin_166.exists(), "Official test binaries missing"

    requests = []
    allow_response = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append(json.loads(body))
            assert allow_response.wait(20), "Mock provider response wait timed out"
            turn_num = len(requests)
            events = [
                {"type": "response.created", "response": {"id": f"resp-{turn_num}"}},
                {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant",
                 "id": f"msg-{turn_num}", "content": [{"type": "output_text", "text": f"Answer {turn_num}"}]}},
                {"type": "response.completed", "response": {"id": f"resp-{turn_num}",
                 "usage": {"input_tokens": 5, "output_tokens": 5, "total_tokens": 10}}},
            ]
            res_body = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(res_body)))
            self.end_headers()
            self.wfile.write(res_body)

    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()

    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    (codex_home / "config.toml").write_text(f"""model="synthetic-test"
model_provider="synthetic"
[model_providers.synthetic]
name="Synthetic"
base_url="http://127.0.0.1:{provider.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
""")
    socket_path = tmp_path / "s.sock"
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update": True}), encoding="utf-8")

    releases_dir = runtime_dir / "releases"
    rel_162 = releases_dir / "0.162.1-x86_64-unknown-linux-musl"
    rel_166 = releases_dir / "0.166.0-x86_64-unknown-linux-musl"
    shutil.copytree(bin_162.parent.parent, rel_162, dirs_exist_ok=True)
    shutil.copytree(bin_166.parent.parent, rel_166, dirs_exist_ok=True)

    current_link = runtime_dir / "current"
    current_link.symlink_to(rel_162)

    env = {
        **os.environ,
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "LANG": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }

    server_bin = rel_162 / "bin" / "codex"
    server1 = subprocess.Popen([str(server_bin), "app-server", "--listen", f"unix://{socket_path}"],
                               env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy1 = None
    try:
        deadline = time.monotonic() + 15
        while not socket_path.exists() and server1.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket_path.exists(), "app-server socket not created"

        s1_stat = Path(f"/proc/{server1.pid}/stat").read_text().rsplit(")", 1)[1].split()
        server_rec = {
            "pid": server1.pid, "start": s1_stat[19], "type": "app-server", "managed": True,
            "socketPath": str(socket_path), "exe": str(server_bin), "version": "0.162.1",
            "cwd": str(tmp_path), "args": ["app-server", "--listen", f"unix://{socket_path}"]
        }
        (sessions_dir / str(server1.pid)).write_text(json.dumps(server_rec), encoding="utf-8")

        proxy1 = subprocess.Popen([str(server_bin), "app-server", "proxy", "--sock", str(socket_path)],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p1_stat = Path(f"/proc/{proxy1.pid}/stat").read_text().rsplit(")", 1)[1].split()
        (sessions_dir / str(proxy1.pid)).write_text(json.dumps({
            "pid": proxy1.pid, "start": p1_stat[19], "type": "app-server-proxy", "managed": False,
            "socketPath": str(socket_path), "exe": str(server_bin), "version": "0.162.1",
            "cwd": str(tmp_path), "args": ["app-server", "proxy", "--sock", str(socket_path)]
        }), encoding="utf-8")

        proxy1.stdin.write(make_ws_upgrade_request())
        proxy1.stdin.flush()
        hdr1 = bytearray()
        while not hdr1.endswith(b"\r\n\r\n"):
            b = proxy1.stdout.read(1)
            assert b, "EOF during proxy 1 handshake"
            hdr1.extend(b)
        assert b"101 Switching Protocols" in hdr1

        def send_msg1(obj):
            proxy1.stdin.write(make_masked_ws_text_frame(json.dumps(obj)))
            proxy1.stdin.flush()

        def recv_msg1():
            for _ in range(50):
                op, pl = read_ws_frame(proxy1.stdout)
                if op == 1:
                    return json.loads(pl.decode("utf-8"))
            raise AssertionError("No text frame received on proxy 1")

        def recv_resp1(req_id):
            for _ in range(50):
                m = recv_msg1()
                if m.get("id") == req_id:
                    return m
            raise AssertionError(f"Response for {req_id} missing")

        send_msg1({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}, "capabilities": {"experimentalApi": True}}})
        assert recv_resp1(1).get("id") == 1
        send_msg1({"method": "initialized", "params": {}})

        # Start EPHEMERAL thread
        send_msg1({"id": 2, "method": "thread/start", "params": {"cwd": str(tmp_path), "ephemeral": True}})
        th_res = recv_resp1(2)
        th_id = th_res["result"]["thread"]["id"]
        assert th_id

        # Turn 1: send and complete
        send_msg1({"id": 3, "method": "turn/start", "params": {"threadId": th_id, "input": [{"type": "text", "text": "Hello first ephemeral turn"}]}})
        assert recv_resp1(3).get("result", {}).get("turn", {}).get("id")

        t0 = time.monotonic()
        while len(requests) < 1 and time.monotonic() - t0 < 10:
            time.sleep(0.05)
        assert len(requests) == 1

        allow_response.set()
        turn1_done = False
        for _ in range(50):
            m = recv_msg1()
            if m.get("method") == "turn/completed" and m.get("params", {}).get("turn", {}).get("status") == "completed":
                turn1_done = True
                break
        assert turn1_done, "Turn 1 did not complete"

        # Close proxy 1
        proxy1.stdin.close()
        assert proxy1.wait(timeout=5) == 0
        (sessions_dir / str(proxy1.pid)).unlink(missing_ok=True)
        proxy1 = None

        # Verify inspectAllSessions refuses update due to unrestorable ephemeral thread
        inspect_script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
        process.env.CODEX_BASELINE_DIR = '{rel_162}';
        const res = await mgr.inspectAllSessions();
        console.log(JSON.stringify(res));
        """
        eval_proc = subprocess.run(["node", "--input-type=module", "-e",
            "import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';" + inspect_script],
            cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        res_idle = json.loads(eval_proc.stdout.splitlines()[-1])
        assert res_idle["canApply"] is False
        assert res_idle["counts"]["managedIdleServers"] == 0
        assert len(res_idle["restartableServers"]) == 0
        assert any("ephemeral" in b.get("detail", "") for b in res_idle.get("blockers", []))

        # Attempt restartServers transaction: MUST reject pre-signal and preserve server1
        candidate_bin = rel_166 / "bin" / "codex"
        restart_script = f"""
        import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';
        import {{ restartServers }} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs';
        import fs from 'node:fs/promises';
        import path from 'node:path';

        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
        process.env.HOME = '{home}';
        process.env.CODEX_HOME = '{codex_home}';

        const serverRecord = {json.dumps(server_rec)};
        const result = await restartServers({{
            servers: [{{
                pid: {server1.pid},
                start: '{server_rec["start"]}',
                type: 'app-server',
                socketPath: '{socket_path}',
                managedRecord: serverRecord,
            }}],
            binary: '{candidate_bin}',
            version: '0.166.0',
            inspectProcess: mgr.inspectProcess,
            inspectServer: mgr.inspectAppServer,
            restoreThreads: mgr.restoreAppServerThreads,
            switchToNew: async () => {{
                await fs.unlink('{current_link}');
                await fs.symlink('{rel_166}', '{current_link}');
            }},
            switchToOld: async () => {{
                await fs.unlink('{current_link}');
                await fs.symlink('{rel_162}', '{current_link}');
            }},
            writeRecord: async (pid, record) => {{
                await fs.writeFile(path.join('{sessions_dir}', String(pid)), JSON.stringify(record));
            }},
            removeRecord: async (pid) => {{
                await fs.unlink(path.join('{sessions_dir}', String(pid))).catch(() => {{}});
            }},
            commitAttempt: async () => {{}},
        }});
        console.log(JSON.stringify(result));
        """
        restart_proc = subprocess.run(["node", "--input-type=module", "-e", restart_script],
                                      cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        res_restart = json.loads(restart_proc.stdout.splitlines()[-1])
        assert res_restart.get("applied") is False
        assert res_restart.get("reason") == "server_busy_pre_signal"
        assert server1.poll() is None, "Old server was killed when it should have been preserved!"

        # Verify ephemeral thread and data are preserved on live server
        verify_script = f"""
        import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';
        const client = new mgr.MinimalWebSocketClient('{socket_path}');
        await client.connect();
        const r = await client.call('thread/read', {{ threadId: '{th_id}' }});
        console.log(JSON.stringify(r));
        const t2 = await client.call('turn/start', {{ threadId: '{th_id}', input: [{{ type: 'text', text: 'Second ephemeral turn' }}] }});
        console.log(JSON.stringify(t2));
        client.close();
        """
        verify_proc = subprocess.run(["node", "--input-type=module", "-e", verify_script],
                                     cwd=repository_root, env=env, capture_output=True, text=True, check=True)
        lines = [json.loads(line) for line in verify_proc.stdout.strip().splitlines() if line.startswith("{")]
        th_read = lines[0].get("thread", {})
        assert th_read.get("id") == th_id
        assert th_read.get("ephemeral") is True
        t2_res = lines[1].get("turn", {})
        assert t2_res.get("status") == "inProgress"

        # Verify second turn was received by mock provider and has full conversation history
        t0 = time.monotonic()
        while len(requests) < 2 and time.monotonic() - t0 < 10:
            time.sleep(0.05)
        assert len(requests) == 2
        req2_str = json.dumps(requests[1])
        assert "Hello first ephemeral turn" in req2_str
        assert "Answer 1" in req2_str
        assert "Second ephemeral turn" in req2_str
    finally:
        for p in (proxy1, server1):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        try:
            for sf in sessions_dir.glob("*"):
                pid = int(sf.name)
                os.kill(pid, 9)
        except Exception:
            pass
        try:
            provider.shutdown()
        except Exception:
            pass
