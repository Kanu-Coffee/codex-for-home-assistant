import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

const AUTHENTICATED_MARKER =
  "HA_BROWSER_GATEWAY_AUTHENTICATED:Codex HA fixture";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
            "HA_BROWSER_GATEWAY_AUTHENTICATED:" + config.location_name;
        } catch (error) {
          status.textContent = "HA_BROWSER_GATEWAY_FAILED:" + error.message;
          console.error(status.textContent);
        }
      })();
    </script>
  </body>
</html>`;
}

function hasBearerToken(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

async function probeWebSocket(rawUrl) {
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
      response += chunk.toString("utf8");
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

async function serveFixture() {
  const token = process.env.GATEWAY_FIXTURE_TOKEN;
  assert(token, "GATEWAY_FIXTURE_TOKEN is required");

  const supervisor = createServer((request, response) => {
    if (request.url === "/core/info") {
      if (!hasBearerToken(request, token)) {
        response.writeHead(401).end();
        return;
      }
      console.log("Gateway fixture accepted authenticated /core/info");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ result: "ok", data: { ssl: false, port: 8123 } }),
      );
      return;
    }

    if (request.url === "/core/api/config") {
      if (!hasBearerToken(request, token)) {
        response.writeHead(401).end();
        return;
      }
      console.log("Gateway fixture accepted authenticated /core/api/config");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({ location_name: "Codex HA fixture", version: "2026.7.0" }),
      );
      return;
    }

    response.writeHead(404).end();
  });

  supervisor.on("upgrade", (request, socket) => {
    if (request.url !== "/core/websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
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
    setTimeout(() => socket.end(), 250);
  });

  const homeAssistant = createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(frontendHtml());
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
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

const [mode, value] = process.argv.slice(2);
if (mode === "--probe-websocket") {
  await probeWebSocket(value);
} else {
  assert.equal(mode, undefined, `Unknown fixture argument: ${mode}`);
  await serveFixture();
}
