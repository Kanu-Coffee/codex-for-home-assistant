"""Regression tests for codex app-server proxy transport, framing, and updater protection."""
import base64
import json
import os
import select
import signal
import struct
import subprocess
import time
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def find_test_codex_binary() -> Path | None:
    env_bin = os.environ.get("CODEX_WIRE_PROBE_BINARY")
    if env_bin and Path(env_bin).exists():
        return Path(env_bin).resolve()
    for candidate in [
        REPOSITORY_ROOT / ".test-tmp/task007-baseline/bin/codex",
        REPOSITORY_ROOT / ".test-tmp/resume-166/package/bin/codex",
        REPOSITORY_ROOT / ".test-tmp/resume-166/bin/codex",
    ]:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    return None


@pytest.fixture
def codex_binary() -> Path:
    binary = find_test_codex_binary()
    if not binary:
        pytest.skip("No real codex binary found in test environment or CODEX_WIRE_PROBE_BINARY")
    return binary


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
    socket_path = tmp_path / "server.sock"
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
        init_req = json.dumps({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test", "version": "1"}}})
        proxy.stdin.write(make_masked_ws_text_frame(init_req))
        proxy.stdin.flush()

        opcode, payload = read_ws_frame(proxy.stdout)
        assert opcode == 1  # Text frame
        init_res = json.loads(payload.decode("utf-8"))
        assert init_res.get("id") == 1 and "result" in init_res

        # 3. Clean termination on client EOF
        proxy.stdin.close()
        assert proxy.wait(timeout=5) == 0
    finally:
        for p in (proxy, server):
            if p is not None and p.poll() is None:
                p.terminate()
                p.wait(timeout=5)


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
                p.terminate()
                p.wait(timeout=5)
