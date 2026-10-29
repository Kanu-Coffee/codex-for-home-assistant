"""Opt-in probe of the actual Codex Unix WebSocket proxy transport."""
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


@pytest.mark.skipif(not os.environ.get("CODEX_WIRE_PROBE_BINARY"), reason="official binary not provided")
def test_official_proxy_transports_websocket(tmp_path: Path) -> None:
    binary = Path(os.environ["CODEX_WIRE_PROBE_BINARY"]).resolve(strict=True)
    home = tmp_path / "home"
    codex_home = home / "codex"
    codex_home.mkdir(parents=True)
    socket = tmp_path / "s.sock"
    env = {"HOME": str(home), "CODEX_HOME": str(codex_home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    server = subprocess.Popen([str(binary), "app-server", "--listen", f"unix://{socket}"],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
    proxy = None
    try:
        deadline = time.monotonic() + 15
        while not socket.exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert socket.exists(), "Unix listener did not start"
        proxy = subprocess.Popen([str(binary), "app-server", "proxy", "--sock", str(socket)],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL)

        def read_exact(length: int, stage: str) -> bytes:
            result = bytearray()
            deadline = time.monotonic() + 15
            while len(result) < length:
                remaining = deadline - time.monotonic()
                assert remaining > 0 and select.select([proxy.stdout], [], [], remaining)[0], f"{stage} timed out"
                chunk = os.read(proxy.stdout.fileno(), length - len(result))
                assert chunk, f"{stage}: unexpected EOF"
                result.extend(chunk)
            return bytes(result)

        key = base64.b64encode(os.urandom(16))
        proxy.stdin.write(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                          b"Connection: Upgrade\r\nSec-WebSocket-Key: " + key +
                          b"\r\nSec-WebSocket-Version: 13\r\n\r\n")
        proxy.stdin.flush()
        header = bytearray()
        while not header.endswith(b"\r\n\r\n"):
            header.extend(read_exact(1, "WebSocket upgrade"))
            assert len(header) <= 65536
        assert header.startswith(b"HTTP/1.1 101 ")
        request = json.dumps({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "codex_ha_wire_probe", "version": "1"}}}).encode()
        mask = os.urandom(4)
        payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(request))
        proxy.stdin.write(bytes([0x81, 0xFE]) + struct.pack("!H", len(payload)) + mask + payload)
        proxy.stdin.flush()
        first, second = read_exact(2, "initialize frame")
        assert first == 0x81 and not (second & 0x80)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", read_exact(2, "initialize length"))[0]
        elif size == 127:
            size = struct.unpack("!Q", read_exact(8, "initialize length"))[0]
        assert size <= 1024 * 1024
        response = json.loads(read_exact(size, "initialize response"))
        assert response.get("id") == 1 and "result" in response
        server.send_signal(signal.SIGHUP)
        assert server.wait(timeout=15) == 0
    finally:
        for proc in (proxy, server):
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
