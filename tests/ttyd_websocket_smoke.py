"""Dependency-free ttyd WebSocket smoke test."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
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


def connect(
    url: str, columns: int = 100, rows: int = 30
) -> tuple[socket.socket, str]:
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
    init = json.dumps({"AuthToken": token, "columns": columns, "rows": rows})
    send_frame(stream, 1, init.encode("utf-8"))
    return stream, token


def send_resize(stream: socket.socket, columns: int, rows: int) -> None:
    payload = b"1" + json.dumps({"columns": columns, "rows": rows}).encode("utf-8")
    send_frame(stream, 2, payload)


def query_tmux_state(stream: socket.socket) -> tuple[str, str, int, int, int, int, int]:
    marker = f"__CODEX_HA_TMUX_{secrets.token_hex(8)}__"
    tmux_format = (
        "#{session_id}|#{pane_id}|#{pane_pid}|#{client_width}|"
        "#{client_height}|#{pane_width}|#{pane_height}"
    )
    command = (
        f"0printf '\\n{marker}%s|%s|%s\\n' "
        f'"$(tmux display-message -p \'{tmux_format}\')" '
        '"$PWD" "$TERM"\r'
    ).encode("utf-8")
    pattern = re.compile(
        re.escape(marker)
        + r"(?P<session>\$\d+)\|(?P<pane>%\d+)\|(?P<pid>\d+)\|"
        + r"(?P<client_width>\d+)\|(?P<client_height>\d+)\|"
        + r"(?P<pane_width>\d+)\|(?P<pane_height>\d+)\|"
        + r"/config\|(?P<term>[A-Za-z0-9._-]+)"
    )
    output = bytearray()
    deadline = time.monotonic() + 8
    send_frame(stream, 2, command)
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
        if opcode not in (1, 2) or not payload:
            continue
        output.extend(payload[1:] if payload[:1] in b"01234567" else payload)
        decoded = output.decode("utf-8", "replace")
        decoded = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", decoded)
        match = pattern.search(decoded)
        if match:
            if match.group("term") == "dumb":
                raise RuntimeError("ttyd child TERM unexpectedly resolved to dumb")
            return (
                match.group("session"),
                match.group("pane"),
                int(match.group("pid")),
                int(match.group("client_width")),
                int(match.group("client_height")),
                int(match.group("pane_width")),
                int(match.group("pane_height")),
            )
    decoded = output.decode("utf-8", "replace")
    raise RuntimeError(f"tmux state marker not found; output={decoded!r}")


def assert_geometry(
    state: tuple[str, str, int, int, int, int, int], columns: int, rows: int
) -> None:
    _, _, _, client_width, client_height, pane_width, pane_height = state
    if (client_width, client_height) != (columns, rows):
        raise RuntimeError(
            "ttyd resize did not reach tmux client: "
            f"expected={columns}x{rows} actual={client_width}x{client_height}"
        )
    if pane_width != columns or not 1 <= pane_height <= rows:
        raise RuntimeError(
            "tmux pane geometry is inconsistent with its client: "
            f"client={columns}x{rows} pane={pane_width}x{pane_height}"
        )


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} ws://HOST:PORT/ws", file=sys.stderr)
        return 64
    first_stream, _ = connect(sys.argv[1])
    try:
        send_resize(first_stream, 120, 40)
        first_state = query_tmux_state(first_stream)
        assert_geometry(first_state, 120, 40)
    finally:
        first_stream.close()

    time.sleep(0.5)
    second_stream, _ = connect(sys.argv[1], columns=88, rows=28)
    try:
        second_state = query_tmux_state(second_stream)
        assert_geometry(second_state, 88, 28)
        if second_state[:3] != first_state[:3]:
            raise RuntimeError(
                "ttyd reconnect attached a different tmux pane: "
                f"before={first_state[:3]} after={second_state[:3]}"
            )

        send_resize(second_stream, 96, 32)
        resized_state = query_tmux_state(second_stream)
        assert_geometry(resized_state, 96, 32)
        if resized_state[:3] != first_state[:3]:
            raise RuntimeError("tmux pane identity changed during resize")
    finally:
        second_stream.close()

    print(
        "ttyd WebSocket shell passed: "
        f"session={first_state[0]} pane={first_state[1]} pid={first_state[2]} "
        "reconnect=same resize=96x32 cwd=/config"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
