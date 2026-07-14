import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

const AUTHENTICATED_MARKER =
  "HA_BROWSER_GATEWAY_AUTHENTICATED:Codex HA fixture";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEDICATED_USER_ID = "codex-browser-read-only-user";

function normalizeAddress(address) {
  return String(address ?? "").replace(/^::ffff:/, "");
}

function requestSourceIp(request) {
  return normalizeAddress(request.socket.remoteAddress);
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(value));
}

function frontendHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Home Assistant browser gateway fixture</title>
  </head>
  <body>
    <main>
      <h1>Home Assistant browser gateway fixture</h1>
      <p id="gateway-status">HA_BROWSER_GATEWAY_STARTING</p>
    </main>
    <script>
      (() => {
        const status = document.querySelector("#gateway-status");
        try {
          const tokens = JSON.parse(localStorage.getItem("hassTokens") || "null");
          if (!tokens || typeof tokens.access_token !== "string") {
            throw new Error("hassTokens did not contain an access token");
          }

          const request = new XMLHttpRequest();
          request.open("GET", "/api/config", false);
          request.setRequestHeader("Authorization", "Bearer " + tokens.access_token);
          request.send();
          if (request.status !== 200) {
            throw new Error("Core config returned HTTP " + request.status);
          }

          const config = JSON.parse(request.responseText);
          status.textContent =
            "HA_BROWSER_GATEWAY_AUTHENTICATED:" + config.location_name +
            "|source-ip:" + config.request_source_ip;
        } catch (error) {
          status.textContent = "HA_BROWSER_GATEWAY_FAILED:" + error.message;
          console.error(status.textContent);
        }
      })();
    </script>
  </body>
</html>`;
}

function tokenReflectionHtml() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Token redaction fixture</title></head>
  <body>
    <p id="token-reflection">TOKEN_REFLECTION_PENDING</p>
    <script>
      const tokens = JSON.parse(localStorage.getItem("hassTokens") || "null");
      document.querySelector("#token-reflection").textContent =
        "TOKEN_REFLECTION:" + (tokens?.access_token || "missing");
    </script>
  </body>
</html>`;
}

function hasBearerToken(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

async function probeWebSocketUpgrade(rawUrl) {
  const target = new URL(rawUrl);
  assert.equal(target.protocol, "ws:", "WebSocket probe only supports ws:// URLs");
  const port = Number(target.port || 80);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");

  await new Promise((resolve, reject) => {
    const socket = connect({ host: target.hostname, port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WebSocket upgrade timed out: ${rawUrl}`));
    }, 5_000);

    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.once("error", finish);
    socket.once("connect", () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      try {
        assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/i);
        assert.match(response, /\r\nUpgrade: websocket\r\n/i);
        const acceptHeader = response
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
        assert.equal(
          acceptHeader?.slice(acceptHeader.indexOf(":") + 1).trim(),
          expectedAccept,
        );
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });

  console.log(`WebSocket gateway upgrade passed for ${target.origin}`);
}

async function probeAuthenticatedWebSocket(rawUrl, browserToken) {
  assert(browserToken, "An access token is required for the authenticated probe");

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(rawUrl);
    let stage = "required";
    let settled = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Authenticated WebSocket probe timed out: ${rawUrl}`));
    }, 5_000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };

    socket.addEventListener("error", () => {
      finish(new Error(`Authenticated WebSocket probe failed: ${rawUrl}`));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (stage === "required") {
          assert.equal(message.type, "auth_required");
          socket.send(
            JSON.stringify({ type: "auth", access_token: browserToken }),
          );
          stage = "authenticated";
          return;
        }
        if (stage === "authenticated") {
          assert.equal(message.type, "auth_ok");
          socket.send(JSON.stringify({ id: 1, type: "auth/current_user" }));
          stage = "current_user";
          return;
        }

        assert.equal(message.id, 1);
        assert.equal(message.type, "result");
        assert.equal(message.success, true);
        assert.equal(message.result?.id, DEDICATED_USER_ID);
        assert.equal(message.result?.is_admin, false);
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });

  console.log(
    `Authenticated Core WebSocket probe passed for ${new URL(rawUrl).origin}`,
  );
}

function encodeWebSocketFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    const length = buffer.readBigUInt64BE(2);
    assert(length <= BigInt(Number.MAX_SAFE_INTEGER));
    payloadLength = Number(length);
    offset = 10;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    consumed: offset + payloadLength,
    opcode,
    payload,
  };
}

function dedicatedUser() {
  return {
    id: DEDICATED_USER_ID,
    name: "Codex browser (read only)",
    is_active: true,
    is_admin: false,
    is_owner: false,
    local_only: true,
    system_generated: false,
    group_ids: ["system-read-only"],
  };
}

function acceptWebSocket(
  request,
  socket,
  { browserToken, supervisorToken, allowSupervisor, label },
) {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.write(
    encodeWebSocketFrame({ type: "auth_required", ha_version: "2026.7.0" }),
  );

  let authenticatedAs = null;
  let buffered = Buffer.alloc(0);
  const send = (message) => socket.write(encodeWebSocketFrame(message));
  const rejectCommand = (message) => {
    send({
      id: message.id,
      type: "result",
      success: false,
      error: { code: "unauthorized", message: "Fixture command denied" },
    });
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length > 0) {
      let frame;
      try {
        frame = decodeWebSocketFrame(buffered);
      } catch {
        socket.destroy();
        return;
      }
      if (!frame) return;
      buffered = buffered.subarray(frame.consumed);

      if (frame.opcode === 0x8) {
        socket.end(encodeWebSocketFrame(frame.payload, 0x8));
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode !== 0x1) continue;

      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        socket.destroy();
        return;
      }

      if (!authenticatedAs) {
        if (message.type !== "auth") {
          send({ type: "auth_invalid", message: "Authentication required" });
          continue;
        }
        if (message.access_token === browserToken) {
          authenticatedAs = "browser";
        } else if (
          allowSupervisor &&
          message.access_token === supervisorToken
        ) {
          authenticatedAs = "supervisor";
        } else {
          send({ type: "auth_invalid", message: "Invalid access token" });
          continue;
        }
        send({ type: "auth_ok", ha_version: "2026.7.0" });
        continue;
      }

      if (message.type === "auth/current_user" && authenticatedAs === "browser") {
        console.log(`${label} accepted browser auth/current_user`);
        send({
          id: message.id,
          type: "result",
          success: true,
          result: dedicatedUser(),
        });
      } else if (
        message.type === "config/auth/list" &&
        authenticatedAs === "supervisor"
      ) {
        console.log(`${label} accepted Supervisor config/auth/list`);
        send({
          id: message.id,
          type: "result",
          success: true,
          result: [dedicatedUser()],
        });
      } else {
        rejectCommand(message);
      }
    }
  });
}

async function serveFixture() {
  const supervisorToken = process.env.GATEWAY_FIXTURE_TOKEN;
  const browserToken = process.env.GATEWAY_FIXTURE_BROWSER_TOKEN;
  assert(supervisorToken, "GATEWAY_FIXTURE_TOKEN is required");
  assert(browserToken, "GATEWAY_FIXTURE_BROWSER_TOKEN is required");

  const supervisor = createServer((request, response) => {
    if (request.url === "/core/info") {
      if (!hasBearerToken(request, supervisorToken)) {
        response.writeHead(401).end();
        return;
      }
      console.log("Gateway fixture accepted authenticated /core/info");
      jsonResponse(response, 200, {
        result: "ok",
        data: { ssl: false, port: 8123 },
      });
      return;
    }

    if (request.url === "/apps/self/info" || request.url === "/addons/self/info") {
      if (!hasBearerToken(request, supervisorToken)) {
        response.writeHead(401).end();
        return;
      }
      jsonResponse(response, 200, {
        result: "ok",
        data: { ip_address: requestSourceIp(request) },
      });
      return;
    }

    if (request.url?.startsWith("/core/api/")) {
      jsonResponse(response, 410, {
        error: "Core REST must use the direct homeassistant service",
      });
      return;
    }

    response.writeHead(404).end();
  });

  supervisor.on("upgrade", (request, socket) => {
    if (request.url !== "/core/websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    acceptWebSocket(request, socket, {
      allowSupervisor: true,
      browserToken,
      label: "Supervisor WebSocket fixture",
      supervisorToken,
    });
  });

  const homeAssistant = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://homeassistant").pathname;
    const sourceIp = requestSourceIp(request);
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(frontendHtml());
      return;
    }
    if (pathname === "/token-redaction-fixture") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(tokenReflectionHtml());
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (pathname === "/auth/providers") {
      console.log(`Core fixture observed /auth/providers from ${sourceIp}`);
      jsonResponse(response, 200, [
        { name: null, id: null, type: "homeassistant" },
      ]);
      return;
    }
    if (pathname === "/api/config") {
      if (!hasBearerToken(request, browserToken)) {
        response.writeHead(401).end();
        return;
      }
      console.log(`Core fixture accepted browser /api/config from ${sourceIp}`);
      jsonResponse(response, 200, {
        location_name: "Codex HA fixture",
        version: "2026.7.0",
        request_source_ip: sourceIp,
      });
      return;
    }

    response.writeHead(404).end();
  });

  homeAssistant.on("upgrade", (request, socket) => {
    if (request.url !== "/api/websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    acceptWebSocket(request, socket, {
      allowSupervisor: false,
      browserToken,
      label: "Core WebSocket fixture",
      supervisorToken,
    });
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.listen(80, "0.0.0.0", resolve);
    }),
    new Promise((resolve, reject) => {
      homeAssistant.once("error", reject);
      homeAssistant.listen(8123, "0.0.0.0", resolve);
    }),
  ]);

  const shutdown = () => {
    supervisor.close();
    homeAssistant.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Home Assistant browser gateway fixture ready (${AUTHENTICATED_MARKER})`);
}

const [mode, value, accessToken] = process.argv.slice(2);
if (mode === "--probe-websocket") {
  if (accessToken) await probeAuthenticatedWebSocket(value, accessToken);
  else await probeWebSocketUpgrade(value);
} else {
  assert.equal(mode, undefined, `Unknown fixture argument: ${mode}`);
  await serveFixture();
}
