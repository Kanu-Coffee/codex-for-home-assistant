"""Dependency-free ttyd WebSocket smoke test."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.request
from urllib.parse import urlsplit


def read_exact(stream: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = stream.recv(length - len(data))
        if not chunk:
            raise ConnectionError("WebSocket closed unexpectedly")
        data.extend(chunk)
    return bytes(data)


def send_frame(stream: socket.socket, opcode: int, payload: bytes) -> None:
    mask = os.urandom(4)
    length = len(payload)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask)
    header.extend(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    stream.sendall(header)


def receive_frame(stream: socket.socket) -> tuple[int, bytes]:
    first, second = read_exact(stream, 2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(stream, 8))[0]
    mask = read_exact(stream, 4) if second & 0x80 else b""
    payload = read_exact(stream, length)
    if mask:
        payload = bytes(
            byte ^ mask[index % 4] for index, byte in enumerate(payload)
        )
    return opcode, payload


def fetch_token(parsed_url) -> str:
    scheme = "https" if parsed_url.scheme == "wss" else "http"
    token_url = f"{scheme}://{parsed_url.netloc}/token"
    with urllib.request.urlopen(token_url, timeout=5) as response:
        return json.load(response)["token"]


def connect(url: str) -> tuple[socket.socket, str]:
    parsed = urlsplit(url)
    if parsed.scheme != "ws":
        raise ValueError("This smoke test supports ws:// URLs only")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/ws"
    token = fetch_token(parsed)
    stream = socket.create_connection((host, port), timeout=5)
    stream.settimeout(1)
    websocket_key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parsed.netloc}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {websocket_key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: tty\r\n"
        f"Origin: http://{parsed.netloc}\r\n\r\n"
    )
    stream.sendall(request.encode("ascii"))
    response = bytearray()
    while b"\r\n\r\n" not in response:
        response.extend(stream.recv(4096))
    header = bytes(response).split(b"\r\n\r\n", 1)[0]
    if not header.startswith(b"HTTP/1.1 101"):
        raise ConnectionError(f"WebSocket upgrade failed: {header!r}")
    expected_accept = base64.b64encode(
        hashlib.sha1(
            (websocket_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode(
                "ascii"
            )
        ).digest()
    )
    if b"sec-websocket-accept: " + expected_accept.lower() not in header.lower():
        raise ConnectionError("WebSocket accept key did not match")
    init = json.dumps({"AuthToken": token, "columns": 100, "rows": 30})
    send_frame(stream, 1, init.encode("utf-8"))
    return stream, token


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} ws://HOST:PORT/ws", file=sys.stderr)
        return 64
    stream, _ = connect(sys.argv[1])
    marker = b"__CODEX_HA_TTYD_OK__:/config:"
    command = b"0printf '__CODEX_HA_TTYD_OK__:%s:%s\\n' \"$PWD\" \"$TERM\"\r"
    output = bytearray()
    deadline = time.monotonic() + 8
    send_frame(stream, 2, command)
    try:
        while time.monotonic() < deadline:
            try:
                opcode, payload = receive_frame(stream)
            except socket.timeout:
                continue
            if opcode == 8:
                break
            if opcode == 9:
                send_frame(stream, 10, payload)
                continue
            if opcode in (1, 2) and payload:
                output.extend(payload[1:] if payload[:1] in b"01234567" else payload)
                if marker in output:
                    suffix = output.split(marker, 1)[1].splitlines()[0]
                    terminal = re.sub(
                        r"\x1b\[[0-?]*[ -/]*[@-~]",
                        "",
                        suffix.decode("utf-8", "replace"),
                    ).strip()
                    if terminal and terminal != "dumb":
                        print(
                            "ttyd WebSocket shell passed: "
                            f"cwd=/config TERM={terminal}"
                        )
                        return 0
        decoded = output.decode("utf-8", "replace")
        print(f"ttyd shell marker not found; output={decoded!r}", file=sys.stderr)
        return 1
    finally:
        stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
