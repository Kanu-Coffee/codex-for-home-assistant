import { readFile } from "node:fs/promises";

const WEBSOCKET_URL = "ws://supervisor/core/websocket";
const AUTH_STATUS_PATH = "/run/codex-ha/browser-auth-status.json";
const BROWSER_TOKEN_PATH = "/run/codex-ha/home-assistant-browser.token";
const REQUEST_TIMEOUT_MS = 10_000;
const READ_ONLY_GROUP = "system-read-only";

class HomeAssistantSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
  }

  request(type, fields = {}) {
    const id = this.nextId++;
    const message = { id, type, ...fields };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { reject, resolve, timer, type });
      try {
        this.socket.send(JSON.stringify(message));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Unable to send ${type} to Home Assistant`));
      }
    });
  }

  receive(message) {
    if (message.type !== "result" || !Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.success === true) {
      pending.resolve(message.result);
      return;
    }

    const code =
      typeof message.error?.code === "string"
        ? message.error.code
        : "request_rejected";
    pending.reject(new Error(`Home Assistant rejected ${pending.type} (${code})`));
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

function openSession(accessToken, credentialLabel) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WEBSOCKET_URL);
    const session = new HomeAssistantSession(socket);
    let authenticated = false;
    let settled = false;

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("Timed out connecting to Home Assistant"));
    }, REQUEST_TIMEOUT_MS);

    const rejectConnection = (error) => {
      session.fail(error);
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      reject(error);
    };

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        rejectConnection(new Error("Home Assistant returned invalid WebSocket data"));
        socket.close();
        return;
      }

      if (!authenticated) {
        if (message.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: accessToken }));
          return;
        }
        if (message.type === "auth_ok") {
          authenticated = true;
          settled = true;
          clearTimeout(connectTimer);
          resolve(session);
          return;
        }
        if (message.type === "auth_invalid") {
          rejectConnection(
            new Error(`Home Assistant rejected the ${credentialLabel} credential`),
          );
          socket.close();
        }
        return;
      }

      session.receive(message);
    });

    socket.addEventListener("error", () => {
      rejectConnection(new Error("Unable to connect to the Home Assistant WebSocket"));
    });
    socket.addEventListener("close", () => {
      session.fail(new Error("Home Assistant WebSocket closed unexpectedly"));
      if (!authenticated) {
        rejectConnection(new Error("Home Assistant WebSocket closed before authentication"));
      }
    });
  });
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} must be non-empty and must not contain control line breaks`);
  }
  return value;
}

function requireCreatedUser(result) {
  const user = result?.user;
  if (
    typeof user?.id !== "string" ||
    typeof user?.name !== "string" ||
    user.is_owner !== false ||
    user.is_active !== true ||
    user.local_only !== true ||
    user.system_generated !== false ||
    !Array.isArray(user.group_ids) ||
    user.group_ids.length !== 1 ||
    user.group_ids[0] !== READ_ONLY_GROUP
  ) {
    throw new Error("Home Assistant returned an unexpected user policy");
  }
  return user;
}

function isExactReadOnlyBrowserUser(user) {
  return (
    user?.is_owner === false &&
    user?.is_active === true &&
    user?.local_only === true &&
    user?.system_generated === false &&
    Array.isArray(user?.group_ids) &&
    user.group_ids.length === 1 &&
    user.group_ids[0] === READ_ONLY_GROUP
  );
}

async function createUser(session, displayName, username) {
  const password = await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
  if (password.length === 0) throw new Error("Password must not be empty");

  const result = await session.request("config/auth/create", {
    name: displayName,
    group_ids: [READ_ONLY_GROUP],
    local_only: true,
  });
  let user;
  try {
    user = requireCreatedUser(result);
  } catch (policyError) {
    const createdUserId = result?.user?.id;
    if (typeof createdUserId !== "string") throw policyError;
    try {
      await session.request("config/auth/delete", { user_id: createdUserId });
    } catch {
      throw new Error(
        `User policy validation and automatic rollback failed; remove user ${createdUserId} manually`,
      );
    }
    throw new Error(
      `User policy validation failed and user ${createdUserId} was rolled back`,
    );
  }

  try {
    await session.request("config/auth_provider/homeassistant/create", {
      user_id: user.id,
      username,
      password,
    });
  } catch (credentialError) {
    try {
      await session.request("config/auth/delete", { user_id: user.id });
    } catch {
      throw new Error(
        `Credential creation and automatic rollback failed; remove user ${user.id} manually`,
      );
    }
    throw new Error(
      `Credential creation failed and user ${user.id} was rolled back (${credentialError.message})`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ user: { id: user.id, name: user.name, username } })}\n`,
  );
}

async function readReadyStatus(expectedUserId) {
  let status;
  try {
    status = JSON.parse(await readFile(AUTH_STATUS_PATH, "utf8"));
  } catch {
    throw new Error("Browser authentication status is unavailable or invalid");
  }

  if (status?.status !== "ready" || status?.user?.id !== expectedUserId) {
    throw new Error(
      "Browser authentication status is not ready for the requested user",
    );
  }
  return status;
}

async function removePassword(session, expectedUserId) {
  await readReadyStatus(expectedUserId);

  let browserToken;
  try {
    browserToken = await readFile(BROWSER_TOKEN_PATH, "utf8");
  } catch {
    throw new Error("Validated browser credential is unavailable");
  }
  if (browserToken.length === 0) {
    throw new Error("Validated browser credential is empty");
  }

  let browserSession = await openSession(browserToken, "dedicated browser");
  try {
    const currentUser = await browserSession.request("auth/current_user");
    if (currentUser?.id !== expectedUserId || currentUser?.is_admin !== false) {
      throw new Error("Validated browser credential does not belong to the requested user");
    }
  } finally {
    browserSession.close();
  }

  const users = await session.request("config/auth/list");
  const user = Array.isArray(users)
    ? users.find((candidate) => candidate?.id === expectedUserId)
    : undefined;
  if (!user || !isExactReadOnlyBrowserUser(user)) {
    throw new Error("The ready browser user no longer has the required read-only policy");
  }
  if (
    typeof user.username !== "string" ||
    !Array.isArray(user.credentials) ||
    !user.credentials.some((credential) => credential?.type === "homeassistant")
  ) {
    throw new Error("The ready browser user has no Home Assistant password to remove");
  }

  const username = user.username;
  await session.request("config/auth_provider/homeassistant/delete", { username });

  const updatedUsers = await session.request("config/auth/list");
  const updatedUser = Array.isArray(updatedUsers)
    ? updatedUsers.find((candidate) => candidate?.id === expectedUserId)
    : undefined;
  if (
    !isExactReadOnlyBrowserUser(updatedUser) ||
    updatedUser.username !== null ||
    updatedUser.credentials?.some((credential) => credential?.type === "homeassistant")
  ) {
    throw new Error("Home Assistant did not confirm password credential removal");
  }

  browserSession = await openSession(browserToken, "dedicated browser");
  try {
    const currentUser = await browserSession.request("auth/current_user");
    if (currentUser?.id !== expectedUserId || currentUser?.is_admin !== false) {
      throw new Error("Browser credential validation failed after password removal");
    }
  } finally {
    browserSession.close();
  }

  process.stdout.write(
    `${JSON.stringify({ user: { id: user.id, name: user.name, username } })}\n`,
  );
}

const supervisorToken = process.env.SUPERVISOR_TOKEN;
if (!supervisorToken) {
  process.stderr.write("SUPERVISOR_TOKEN is unavailable\n");
  process.exit(1);
}

const [operation, ...args] = process.argv.slice(2);
let session;
try {
  session = await openSession(supervisorToken, "Supervisor");
  if (operation === "create" && args.length === 2) {
    await createUser(
      session,
      requireText(args[0], "Display name"),
      requireText(args[1], "Username"),
    );
  } else if (operation === "remove-password" && args.length === 1) {
    await removePassword(session, requireText(args[0], "User ID"));
  } else {
    throw new Error("Invalid browser user administration request");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Browser user administration failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  session?.close();
}
