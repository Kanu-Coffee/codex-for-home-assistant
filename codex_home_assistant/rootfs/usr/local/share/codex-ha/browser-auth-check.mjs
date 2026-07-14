const websocketUrl = "ws://supervisor/core/websocket";
const browserToken = process.env.HA_BROWSER_TOKEN;
const supervisorToken = process.env.SUPERVISOR_TOKEN;
const timeoutMs = 5_000;

if (!browserToken || !supervisorToken) {
  process.stderr.write(
    "Dedicated browser token validation requires both browser and Supervisor credentials\n",
  );
  process.exit(1);
}

function timeoutError(label) {
  return new Error(`Timed out while ${label}`);
}

function openSession(accessToken) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
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
  browserSession = await openSession(browserToken);
  const currentUser = await browserSession.request("auth/current_user");
  browserSession.close();
  browserSession = undefined;

  supervisorSession = await openSession(supervisorToken);
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
