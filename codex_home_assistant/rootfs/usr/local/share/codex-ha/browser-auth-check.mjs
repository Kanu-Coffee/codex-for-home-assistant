import WebSocket from "/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs";

const supervisorWebsocketUrl = "ws://supervisor/core/websocket";
const browserToken = process.env.HA_BROWSER_TOKEN;
const supervisorToken = process.env.SUPERVISOR_TOKEN;
const expectedManagedUserId = process.env.HA_BROWSER_EXPECTED_USER_ID;
const expectedManagedClientName = process.env.HA_BROWSER_EXPECTED_CLIENT_NAME;
const expectedManagedDisplayName = process.env.HA_BROWSER_EXPECTED_DISPLAY_NAME;
const timeoutMs = 5_000;
const maxResponseBytes = 1024 * 1024;

if (!browserToken || !supervisorToken) {
  process.stderr.write(
    "Dedicated browser token validation requires both browser and Supervisor credentials\n",
  );
  process.exit(1);
}
if (
  new Set([
    Boolean(expectedManagedUserId),
    Boolean(expectedManagedClientName),
    Boolean(expectedManagedDisplayName),
  ]).size !== 1 ||
  (expectedManagedUserId && /[\r\n\0]/u.test(expectedManagedUserId)) ||
  (expectedManagedClientName && /[\r\n\0]/u.test(expectedManagedClientName)) ||
  (expectedManagedDisplayName && /[\r\n\0]/u.test(expectedManagedDisplayName))
) {
  process.stderr.write("Managed browser authentication metadata is invalid\n");
  process.exit(1);
}

function timeoutError(label) {
  return new Error(`Timed out while ${label}`);
}

async function discoverCoreWebsocketUrl() {
  const response = await fetch("http://supervisor/core/info", {
    headers: { Authorization: `Bearer ${supervisorToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Supervisor Core info returned HTTP ${response.status}`);
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxResponseBytes) {
    throw new Error("Supervisor Core info response was too large");
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new Error("Supervisor Core info returned invalid JSON");
  }
  const port = Number(info?.data?.port ?? 8123);
  if (
    info?.result !== "ok" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Supervisor Core info returned an invalid endpoint");
  }
  return `${info?.data?.ssl === true ? "wss" : "ws"}://homeassistant:${port}/api/websocket`;
}

function openSession(accessToken, websocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, {
      handshakeTimeout: timeoutMs,
      maxPayload: maxResponseBytes,
      perMessageDeflate: false,
      rejectUnauthorized: websocketUrl.startsWith("wss:") ? true : undefined,
    });
    const queue = [];
    const waiters = [];
    let closed = false;

    const rejectAll = (error) => {
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };

    const nextMessage = (label) => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(new Error("WebSocket closed unexpectedly"));
      return new Promise((messageResolve, messageReject) => {
        const waiter = {
          reject: messageReject,
          resolve: messageResolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            messageReject(timeoutError(label));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    };

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        rejectAll(new Error("Home Assistant returned invalid WebSocket data"));
        socket.close();
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    });
    socket.addEventListener("close", () => {
      closed = true;
      rejectAll(new Error("Home Assistant WebSocket closed unexpectedly"));
    });
    socket.addEventListener("error", () => {
      rejectAll(new Error("Unable to connect to the Home Assistant WebSocket"));
    });

    const connectTimer = setTimeout(() => {
      socket.close();
      reject(timeoutError("connecting to Home Assistant"));
    }, timeoutMs);

    socket.addEventListener(
      "open",
      async () => {
        try {
          const required = await nextMessage("waiting for authentication");
          if (required.type !== "auth_required") {
            throw new Error("Home Assistant did not request WebSocket authentication");
          }
          socket.send(JSON.stringify({ type: "auth", access_token: accessToken }));
          const authResult = await nextMessage("authenticating to Home Assistant");
          if (authResult.type !== "auth_ok") {
            throw new Error("Home Assistant rejected a browser credential");
          }
          clearTimeout(connectTimer);
          let nextId = 1;
          resolve({
            async request(type) {
              const id = nextId++;
              socket.send(JSON.stringify({ id, type }));
              const response = await nextMessage(`waiting for ${type}`);
              if (response.id !== id || response.type !== "result") {
                throw new Error(`Home Assistant returned an unexpected ${type} response`);
              }
              if (response.success !== true) {
                throw new Error(`Home Assistant denied ${type}`);
              }
              return response.result;
            },
            close() {
              closed = true;
              socket.close();
            },
          });
        } catch (error) {
          clearTimeout(connectTimer);
          socket.close();
          reject(error);
        }
      },
      { once: true },
    );
  });
}

let browserSession;
let supervisorSession;
try {
  const coreWebsocketUrl = await discoverCoreWebsocketUrl();
  browserSession = await openSession(browserToken, coreWebsocketUrl);
  const currentUser = await browserSession.request("auth/current_user");
  let refreshTokens;
  let currentRefreshToken;
  if (expectedManagedUserId) {
    refreshTokens = await browserSession.request("auth/refresh_tokens");
    currentRefreshToken = Array.isArray(refreshTokens)
      ? refreshTokens.find((candidate) => candidate?.is_current === true)
      : undefined;
  }
  browserSession.close();
  browserSession = undefined;

  supervisorSession = await openSession(
    supervisorToken,
    supervisorWebsocketUrl,
  );
  const users = await supervisorSession.request("config/auth/list");
  supervisorSession.close();
  supervisorSession = undefined;

  const user = Array.isArray(users)
    ? users.find((candidate) => candidate?.id === currentUser?.id)
    : undefined;
  if (!user) throw new Error("Dedicated browser user was not found");

  const groupIds = Array.isArray(user.group_ids) ? user.group_ids : [];
  const isExactReadOnly =
    currentUser.is_admin === false &&
    user.is_active === true &&
    user.local_only === true &&
    user.system_generated === false &&
    groupIds.length === 1 &&
    groupIds[0] === "system-read-only";
  if (!isExactReadOnly) {
    throw new Error(
      "Dedicated browser user must be active, local-only, non-system, and in only system-read-only",
    );
  }
  if (
    expectedManagedUserId &&
    (currentUser.id !== expectedManagedUserId ||
      user.name !== expectedManagedDisplayName ||
      user.username !== null ||
      !Array.isArray(user.credentials) ||
      user.credentials.length !== 0 ||
      !Array.isArray(refreshTokens) ||
      refreshTokens.length !== 1 ||
      currentRefreshToken?.type !== "long_lived_access_token" ||
      currentRefreshToken?.client_name !== expectedManagedClientName)
  ) {
    throw new Error("Managed browser credential metadata did not match its private state");
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      user: {
        id: user.id,
        name: user.name,
        group_ids: groupIds,
        local_only: true,
        is_admin: false,
      },
    })}\n`,
  );
} catch (error) {
  browserSession?.close();
  supervisorSession?.close();
  process.stderr.write(`${error instanceof Error ? error.message : "Browser authentication validation failed"}\n`);
  process.exitCode = 1;
}
