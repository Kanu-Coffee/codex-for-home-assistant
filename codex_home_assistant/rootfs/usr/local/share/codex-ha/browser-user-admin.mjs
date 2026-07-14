import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import WebSocket from "/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs";

const SUPERVISOR_WEBSOCKET_URL = "ws://supervisor/core/websocket";
const AUTH_STATUS_PATH = "/run/codex-ha/browser-auth-status.json";
const BROWSER_TOKEN_PATH = "/run/codex-ha/home-assistant-browser.token";
const MANAGED_AUTH_DIRECTORY = "/data/browser-auth";
const MANAGED_STATE_PATH = `${MANAGED_AUTH_DIRECTORY}/managed-user.json`;
const MANAGED_TOKEN_PATH = `${MANAGED_AUTH_DIRECTORY}/managed-token`;
const REQUEST_TIMEOUT_MS = 10_000;
const READ_ONLY_GROUP = "system-read-only";
const MANAGED_CLIENT_ID = "http://127.0.0.1:8099/";
const MANAGED_CLIENT_NAME_PREFIX = "Codex for Home Assistant browser";
const MANAGED_DISPLAY_NAME_PREFIX = "Codex Browser (managed)";
const MANAGED_STATE_VERSION = 1;
const LONG_LIVED_TOKEN_DAYS = 3_650;
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const PRIVATE_TEMP_NAME_PATTERN = /^\.[A-Za-z0-9_-]{16}\.tmp$/u;

class ManagedSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class AuthenticationRejectedError extends Error {
  constructor(message, definitive = false) {
    super(message);
    this.definitive = definitive;
  }
}

class HomeAssistantRequestError extends Error {
  constructor(type, code) {
    super(`Home Assistant rejected ${type} (${code})`);
    this.code = code;
  }
}

function setupError(code, message) {
  return new ManagedSetupError(code, message);
}

function randomUrlSafe(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

async function safeUnlink(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function ensureManagedDirectory() {
  await mkdir(MANAGED_AUTH_DIRECTORY, { mode: 0o700, recursive: true });
  const stat = await lstat(MANAGED_AUTH_DIRECTORY);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid()
  ) {
    throw setupError(
      "managed_storage_unsafe",
      "Managed browser authentication storage is not a private directory",
    );
  }
  await chmod(MANAGED_AUTH_DIRECTORY, 0o700);
}

async function syncManagedDirectory() {
  const directoryHandle = await open(
    MANAGED_AUTH_DIRECTORY,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function cleanupPrivateTemporaryFiles() {
  const names = await readdir(MANAGED_AUTH_DIRECTORY);
  let removed = false;
  for (const name of names) {
    if (!PRIVATE_TEMP_NAME_PATTERN.test(name)) continue;

    const path = `${MANAGED_AUTH_DIRECTORY}/${name}`;
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.nlink !== 1 ||
        openedStat.uid !== process.getuid() ||
        (openedStat.mode & 0o777) !== 0o600 ||
        openedStat.size > MAX_HTTP_RESPONSE_BYTES
      ) {
        throw setupError(
          "managed_storage_unsafe",
          "A managed browser authentication temporary file is unsafe",
        );
      }
      const pathStat = await lstat(path);
      if (
        pathStat.dev !== openedStat.dev ||
        pathStat.ino !== openedStat.ino ||
        pathStat.isSymbolicLink()
      ) {
        throw setupError(
          "managed_storage_unsafe",
          "A managed browser authentication temporary file changed during validation",
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code === "ELOOP") {
        throw setupError(
          "managed_storage_unsafe",
          "A managed browser authentication temporary file is a symbolic link",
        );
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    await unlink(path);
    removed = true;
  }
  if (removed) await syncManagedDirectory();
}

async function writePrivateFile(path, value) {
  const temporaryPath = `${MANAGED_AUTH_DIRECTORY}/.${randomUrlSafe(12)}.tmp`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncManagedDirectory();
  } catch (error) {
    await handle?.close().catch(() => {});
    await safeUnlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readPrivateFile(path) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw setupError(
        "managed_storage_unsafe",
        "Managed browser authentication data is a symbolic link",
      );
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.size > MAX_HTTP_RESPONSE_BYTES
    ) {
      throw setupError(
        "managed_storage_unsafe",
        "Managed browser authentication data is not a private regular file",
      );
    }
    await handle.chmod(0o600);
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function validOpaqueId(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    !/[\r\n\0]/u.test(value)
  );
}

async function readManagedState() {
  const raw = await readPrivateFile(MANAGED_STATE_PATH);
  if (raw === null) return null;

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw setupError(
      "managed_state_invalid",
      "Managed browser authentication state is invalid",
    );
  }
  if (
    state?.version !== MANAGED_STATE_VERSION ||
    !validOpaqueId(state.operation_id) ||
    typeof state.display_name !== "string" ||
    state.display_name !== managedDisplayName(state.operation_id) ||
    typeof state.client_name !== "string" ||
    state.client_name !== managedClientName(state.operation_id) ||
    !["creating", "provisioning", "ready"].includes(state.phase) ||
    (state.phase !== "creating" && !validOpaqueId(state.user_id)) ||
    (state.temporary_username !== undefined &&
      (!validOpaqueId(state.temporary_username) ||
        !state.temporary_username.startsWith("codex-browser-")))
  ) {
    throw setupError(
      "managed_state_invalid",
      "Managed browser authentication state has an unsupported format",
    );
  }
  return state;
}

function managedDisplayName(operationId) {
  return `${MANAGED_DISPLAY_NAME_PREFIX} ${operationId.slice(0, 16)}`;
}

function managedClientName(operationId) {
  return `${MANAGED_CLIENT_NAME_PREFIX} ${operationId}`;
}

async function writeManagedState(state) {
  await writePrivateFile(
    MANAGED_STATE_PATH,
    `${JSON.stringify({
      version: MANAGED_STATE_VERSION,
      ...state,
    })}\n`,
  );
}

function requestBuffer({
  body,
  headers = {},
  hostname,
  method,
  path,
  port,
  protocol,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const requestImpl = protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestImpl(
      {
        headers: {
          "Cache-Control": "no-store",
          ...headers,
        },
        hostname,
        method,
        path,
        port,
        rejectUnauthorized: protocol === "https:" ? true : undefined,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_HTTP_RESPONSE_BYTES) {
            const error = setupError(
              "core_response_too_large",
              "Home Assistant authentication response was too large",
            );
            finish(reject, error);
            request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(resolve, {
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const error = setupError(
        "core_request_timeout",
        "Timed out while calling Home Assistant authentication",
      );
      finish(reject, error);
      request.destroy(error);
    });
    request.on("error", (error) => finish(reject, error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function requestJson(options, expectedStatuses = [200]) {
  const response = await requestBuffer(options);
  if (!expectedStatuses.includes(response.status)) {
    throw setupError(
      "core_request_rejected",
      `Home Assistant authentication request returned HTTP ${response.status}`,
    );
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw setupError(
      "core_response_invalid",
      "Home Assistant authentication returned invalid JSON",
    );
  }
}

async function coreEndpoint(supervisorAccessToken) {
  const info = await requestJson({
    headers: { Authorization: `Bearer ${supervisorAccessToken}` },
    hostname: "supervisor",
    method: "GET",
    path: "/core/info",
    port: 80,
    protocol: "http:",
  });
  const port = Number(info?.data?.port ?? 8123);
  const protocol = info?.data?.ssl === true ? "https:" : "http:";
  if (
    info?.result !== "ok" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw setupError(
      "core_endpoint_invalid",
      "Supervisor did not return a valid Home Assistant frontend endpoint",
    );
  }
  return { hostname: "homeassistant", port, protocol };
}

function coreWebSocketUrl(endpoint) {
  const protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//homeassistant:${endpoint.port}/api/websocket`;
}

function jsonRequest(endpoint, method, path, value) {
  const body = JSON.stringify(value);
  return requestJson({
    ...endpoint,
    body,
    headers: {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json",
    },
    method,
    path,
  });
}

async function ensureHomeAssistantProvider(endpoint) {
  let response;
  try {
    response = await requestJson({
      ...endpoint,
      method: "GET",
      path: "/auth/providers",
    });
  } catch {
    throw setupError(
      "homeassistant_provider_unavailable",
      "The Home Assistant local authentication provider could not be confirmed; managed browser authentication was not changed",
    );
  }
  const providers = Array.isArray(response?.providers)
    ? response.providers.filter(
        (provider) =>
          provider?.type === "homeassistant" && provider?.id === null,
      )
    : [];
  if (providers.length !== 1) {
    throw setupError(
      "homeassistant_provider_unavailable",
      "The Home Assistant local authentication provider is unavailable; managed browser authentication was not changed",
    );
  }
}

function formRequest(endpoint, path, value) {
  const body = new URLSearchParams(value).toString();
  return requestJson({
    ...endpoint,
    body,
    headers: {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    path,
  });
}

async function postForm(endpoint, path, value) {
  const body = new URLSearchParams(value).toString();
  const response = await requestBuffer({
    ...endpoint,
    body,
    headers: {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    path,
  });
  if (response.status !== 200) {
    throw setupError(
      "core_request_rejected",
      `Home Assistant authentication request returned HTTP ${response.status}`,
    );
  }
}

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
    pending.reject(new HomeAssistantRequestError(pending.type, code));
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

function openSession(
  accessToken,
  credentialLabel,
  websocketUrl = SUPERVISOR_WEBSOCKET_URL,
) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, {
      handshakeTimeout: REQUEST_TIMEOUT_MS,
      maxPayload: MAX_HTTP_RESPONSE_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: websocketUrl.startsWith("wss:") ? true : undefined,
    });
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
          const definitive =
            message.message === "Invalid access token or password";
          rejectConnection(
            new AuthenticationRejectedError(
              `Home Assistant rejected the ${credentialLabel} credential`,
              definitive,
            ),
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

function isExactManagedUser(user, state) {
  return (
    isExactReadOnlyBrowserUser(user) &&
    user?.is_owner === false &&
    user?.name === state.display_name
  );
}

function homeAssistantCredentials(user) {
  return Array.isArray(user?.credentials)
    ? user.credentials.filter((credential) => credential?.type === "homeassistant")
    : [];
}

function hasOnlyExpectedTemporaryCredential(user, state) {
  return (
    validOpaqueId(state.temporary_username) &&
    user?.username === state.temporary_username &&
    Array.isArray(user?.credentials) &&
    user.credentials.length === 1 &&
    homeAssistantCredentials(user).length === 1
  );
}

async function listUsers(session) {
  const users = await session.request("config/auth/list");
  if (!Array.isArray(users)) {
    throw setupError(
      "user_list_invalid",
      "Home Assistant returned an invalid user list",
    );
  }
  return users;
}

async function findManagedUser(session, state) {
  const users = await listUsers(session);
  if (validOpaqueId(state.user_id)) {
    return users.find((candidate) => candidate?.id === state.user_id);
  }

  const candidates = users.filter(
    (candidate) =>
      candidate?.name === state.display_name &&
      isExactReadOnlyBrowserUser(candidate),
  );
  if (candidates.length > 1) {
    throw setupError(
      "managed_user_ambiguous",
      "More than one user matches the interrupted managed setup",
    );
  }
  return candidates[0];
}

async function validateManagedToken(token, state, websocketUrl) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    /[\r\n\0]/u.test(token)
  ) {
    throw setupError(
      "managed_token_invalid",
      "Managed browser credential has an invalid format",
    );
  }

  const browserSession = await openSession(
    token,
    "managed browser",
    websocketUrl,
  );
  try {
    const currentUser = await browserSession.request("auth/current_user");
    if (
      currentUser?.id !== state.user_id ||
      currentUser?.is_admin !== false ||
      currentUser?.is_owner !== false
    ) {
      throw setupError(
        "managed_token_owner_mismatch",
        "Managed browser credential belongs to an unexpected user",
      );
    }

    const refreshTokens = await browserSession.request("auth/refresh_tokens");
    const currentToken = Array.isArray(refreshTokens)
      ? refreshTokens.find((candidate) => candidate?.is_current === true)
      : undefined;
    if (
      !Array.isArray(refreshTokens) ||
      refreshTokens.length !== 1 ||
      currentToken?.type !== "long_lived_access_token" ||
      currentToken?.client_name !== state.client_name
    ) {
      throw setupError(
        "managed_token_metadata_mismatch",
        "Managed browser credential metadata is unexpected",
      );
    }
    return { currentUser, refreshTokens };
  } finally {
    browserSession.close();
  }
}

async function loginWithTemporaryCredential(endpoint, username, password) {
  const flow = await jsonRequest(endpoint, "POST", "/auth/login_flow", {
    client_id: MANAGED_CLIENT_ID,
    handler: ["homeassistant", null],
    redirect_uri: MANAGED_CLIENT_ID,
    type: "authorize",
  });
  if (!validOpaqueId(flow?.flow_id)) {
    throw setupError(
      "login_flow_unavailable",
      "Home Assistant local login flow is unavailable",
    );
  }

  const completed = await jsonRequest(
    endpoint,
    "POST",
    `/auth/login_flow/${encodeURIComponent(flow.flow_id)}`,
    {
      client_id: MANAGED_CLIENT_ID,
      username,
      password,
    },
  );
  if (
    completed?.type !== "create_entry" ||
    typeof completed.result !== "string" ||
    completed.result.length < 8
  ) {
    throw setupError(
      "login_flow_rejected",
      "Home Assistant did not complete the managed local login flow",
    );
  }

  const tokens = await formRequest(endpoint, "/auth/token", {
    client_id: MANAGED_CLIENT_ID,
    code: completed.result,
    grant_type: "authorization_code",
  });
  if (
    typeof tokens?.access_token !== "string" ||
    tokens.access_token.length < 20 ||
    typeof tokens?.refresh_token !== "string" ||
    tokens.refresh_token.length < 20
  ) {
    throw setupError(
      "token_exchange_invalid",
      "Home Assistant returned invalid temporary login credentials",
    );
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

async function revokeTemporaryRefreshToken(endpoint, refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken.length < 20) return;
  await postForm(endpoint, "/auth/revoke", { token: refreshToken });
}

async function listRefreshTokens(userSession) {
  const tokens = await userSession.request("auth/refresh_tokens");
  if (!Array.isArray(tokens)) {
    throw setupError(
      "refresh_token_list_invalid",
      "Home Assistant returned invalid refresh token metadata",
    );
  }
  return tokens;
}

async function prepareTemporaryRefreshToken(userSession) {
  const tokens = await listRefreshTokens(userSession);
  const current = tokens.find((candidate) => candidate?.is_current === true);
  if (
    current?.type !== "normal" ||
    current?.client_id !== MANAGED_CLIENT_ID ||
    current?.auth_provider_type !== "homeassistant" ||
    !validOpaqueId(current?.id)
  ) {
    throw setupError(
      "temporary_token_metadata_mismatch",
      "Temporary managed login token metadata is unexpected",
    );
  }
  for (const token of tokens) {
    if (
      token?.is_current !== true &&
      validOpaqueId(token?.id)
    ) {
      await userSession.request("auth/delete_refresh_token", {
        refresh_token_id: token.id,
      });
    }
  }
  const remaining = await listRefreshTokens(userSession);
  if (
    remaining.length !== 1 ||
    remaining[0]?.is_current !== true ||
    remaining[0]?.id !== current.id
  ) {
    throw setupError(
      "temporary_token_cleanup_failed",
      "Home Assistant did not confirm temporary token cleanup",
    );
  }
}

async function removeManagedTokensByClientName(userSession, clientName) {
  const tokens = await listRefreshTokens(userSession);
  for (const token of tokens) {
    if (
      token?.type === "long_lived_access_token" &&
      token?.client_name === clientName &&
      validOpaqueId(token?.id)
    ) {
      await userSession.request("auth/delete_refresh_token", {
        refresh_token_id: token.id,
      });
    }
  }
  const remaining = await listRefreshTokens(userSession);
  if (
    remaining.some(
      (token) =>
        token?.type === "long_lived_access_token" &&
        token?.client_name === clientName,
    )
  ) {
    throw setupError(
      "managed_token_cleanup_failed",
      "Home Assistant did not confirm managed browser token cleanup",
    );
  }
}

async function enforceSingleManagedToken(userSession, clientName) {
  let tokens = await listRefreshTokens(userSession);
  let current = tokens.find((candidate) => candidate?.is_current === true);
  if (
    current?.type !== "long_lived_access_token" ||
    current?.client_name !== clientName ||
    !validOpaqueId(current?.id)
  ) {
    throw setupError(
      "managed_token_metadata_mismatch",
      "Managed browser credential metadata is unexpected",
    );
  }
  for (const token of tokens) {
    if (token?.id !== current.id && validOpaqueId(token?.id)) {
      await userSession.request("auth/delete_refresh_token", {
        refresh_token_id: token.id,
      });
    }
  }
  tokens = await listRefreshTokens(userSession);
  current = tokens.find((candidate) => candidate?.is_current === true);
  if (
    tokens.length !== 1 ||
    current?.type !== "long_lived_access_token" ||
    current?.client_name !== clientName
  ) {
    throw setupError(
      "managed_token_cleanup_failed",
      "Home Assistant did not confirm the single managed browser token invariant",
    );
  }
}

async function confirmCredentialRejected(accessToken, websocketUrl) {
  let verificationSession;
  try {
    verificationSession = await openSession(
      accessToken,
      "revoked managed browser",
      websocketUrl,
    );
  } catch (error) {
    if (
      error instanceof AuthenticationRejectedError &&
      error.definitive === true
    ) {
      return;
    }
    throw error;
  }
  verificationSession.close();
  throw setupError(
    "managed_token_revocation_failed",
    "Home Assistant still accepts the managed browser credential after revocation",
  );
}

async function removeCurrentManagedToken(
  userSession,
  accessToken,
  websocketUrl,
) {
  const tokens = await listRefreshTokens(userSession);
  const current = tokens.find((candidate) => candidate?.is_current === true);
  if (!validOpaqueId(current?.id)) {
    throw setupError(
      "managed_token_metadata_mismatch",
      "The current managed browser credential metadata is unavailable",
    );
  }
  try {
    await userSession.request("auth/delete_refresh_token", {
      refresh_token_id: current.id,
    });
  } catch {
    // Home Assistant closes a WebSocket as soon as its current refresh token
    // is deleted, so the command response is not a reliable success signal.
  }
  await confirmCredentialRejected(accessToken, websocketUrl);
}

async function revokeStoredManagedTokenIfOwned(state, websocketUrl) {
  if (!validOpaqueId(state?.user_id)) return;
  const storedToken = await readPrivateFile(MANAGED_TOKEN_PATH);
  if (storedToken === null) return;

  const storedSession = await openSession(
    storedToken,
    "stored managed browser",
    websocketUrl,
  );
  try {
    const currentUser = await storedSession.request("auth/current_user");
    const tokens = await storedSession.request("auth/refresh_tokens");
    const current = Array.isArray(tokens)
      ? tokens.find((candidate) => candidate?.is_current === true)
      : undefined;
    if (
      currentUser?.id !== state.user_id ||
      current?.type !== "long_lived_access_token" ||
      current?.client_name !== state.client_name
    ) {
      throw setupError(
        "managed_token_metadata_mismatch",
        "Stored managed browser credential metadata is unexpected",
      );
    }
    await removeCurrentManagedToken(storedSession, storedToken, websocketUrl);
  } finally {
    storedSession.close();
  }
}

async function disableStoredManagedTokenAtEndpoint(state, websocketUrl) {
  const storedToken = await readPrivateFile(MANAGED_TOKEN_PATH);
  if (storedToken === null) return;
  try {
    await revokeStoredManagedTokenIfOwned(state, websocketUrl);
  } catch (error) {
    if (
      error instanceof AuthenticationRejectedError &&
      error.definitive === true
    ) {
      await safeUnlink(MANAGED_TOKEN_PATH);
      return;
    }
    // auth_invalid can also mean a local_only source-policy rejection. Without
    // an authenticated self-session, revocation cannot be proven.
    throw setupError(
      "managed_token_revocation_failed",
      "The stored managed browser credential could not be safely revoked",
    );
  }
  await safeUnlink(MANAGED_TOKEN_PATH);
}

async function disableStoredManagedToken(state, supervisorAccessToken) {
  try {
    const endpoint = await coreEndpoint(supervisorAccessToken);
    await disableStoredManagedTokenAtEndpoint(
      state,
      coreWebSocketUrl(endpoint),
    );
  } catch (error) {
    if (
      error instanceof ManagedSetupError &&
      error.code === "managed_token_revocation_failed"
    ) {
      throw error;
    }
    throw setupError(
      "managed_token_revocation_failed",
      "The managed browser user changed and its stored token could not be safely revoked",
    );
  }
}

function sanitizedManagedResult(status, user, reused = false) {
  return {
    source: "managed",
    status,
    reused,
    user: {
      group_ids: [READ_ONLY_GROUP],
      id: user.id,
      is_admin: false,
      local_only: true,
      name: user.name,
    },
  };
}

async function createManagedUser(session, state) {
  const result = await session.request("config/auth/create", {
    name: state.display_name,
    group_ids: [READ_ONLY_GROUP],
    local_only: true,
  });
  try {
    const user = requireCreatedUser(result);
    if (user.name !== state.display_name) {
      throw setupError(
        "managed_user_policy_mismatch",
        "Home Assistant created the managed user with an unexpected name",
      );
    }
    return user;
  } catch (error) {
    if (validOpaqueId(result?.user?.id)) {
      try {
        await session.request("config/auth/delete", { user_id: result.user.id });
      } catch {
        throw setupError(
          "rollback_incomplete",
          "Managed user policy validation failed and rollback needs review",
        );
      }
    }
    throw error;
  }
}

async function confirmManagedUserHasNoCredentials(session, state) {
  const user = await findManagedUser(session, state);
  if (
    !user ||
    !isExactManagedUser(user, state) ||
    user.username !== null ||
    !Array.isArray(user.credentials) ||
    user.credentials.length !== 0
  ) {
    throw setupError(
      "temporary_credential_removal_failed",
      "Home Assistant did not confirm temporary credential removal",
    );
  }
  return user;
}

async function reconcileJournaledTemporaryCredential(session, state, user) {
  const username = state.temporary_username;
  const users = await listUsers(session);
  if (
    users.some(
      (candidate) =>
        candidate?.id !== user.id && candidate?.username === username,
    )
  ) {
    throw setupError(
      "temporary_username_claimed",
      "The interrupted managed setup username is now linked to another user",
    );
  }

  try {
    await session.request("config/auth_provider/homeassistant/delete", {
      username,
    });
    return;
  } catch {
    // A crash can leave either no provider auth or an unlinked provider auth.
    // Creating the same journaled username and then deleting it converges both
    // states without persisting the reconciliation password.
  }

  try {
    await session.request("config/auth_provider/homeassistant/create", {
      password: randomUrlSafe(32),
      user_id: user.id,
      username,
    });
  } catch {
    // If the provider auth already existed, creation is expected to fail. The
    // following delete is still the authoritative cleanup operation.
  }
  try {
    await session.request("config/auth_provider/homeassistant/delete", {
      username,
    });
  } catch {
    throw setupError(
      "temporary_credential_reconciliation_failed",
      "Interrupted temporary credential cleanup could not be confirmed",
    );
  }
}

async function setupManagedBrowserAuth(session, supervisorAccessToken) {
  await ensureManagedDirectory();
  await cleanupPrivateTemporaryFiles();
  const endpoint = await coreEndpoint(supervisorAccessToken);
  const websocketUrl = coreWebSocketUrl(endpoint);
  let state = await readManagedState();
  if (!state || state.phase !== "ready") {
    await ensureHomeAssistantProvider(endpoint);
  }
  if (!state) {
    const operationId = randomUrlSafe(24);
    state = {
      client_name: managedClientName(operationId),
      display_name: managedDisplayName(operationId),
      operation_id: operationId,
      phase: "creating",
    };
    await writeManagedState(state);
  }

  let user = await findManagedUser(session, state);
  let createdThisRun = false;
  let temporaryCredentialAttempted = false;
  let temporaryUsername;
  let temporaryRefreshToken;
  let temporarySession;
  let managedSession;
  let managedToken;
  let managedTokenCleanupAuthorized = false;
  let managedTokenCreationAttempted = false;
  let pendingStoredToken = false;
  let temporaryTokenCleanupRequired = false;
  let journalCleanupRequired = state.temporary_username !== undefined;

  try {
    if (!user) {
      if (state.temporary_username !== undefined) {
        throw setupError(
          "orphaned_temporary_credential",
          "The managed user disappeared during temporary credential setup; private recovery state was preserved for manual review",
        );
      }
      await safeUnlink(MANAGED_TOKEN_PATH);
      state = {
        client_name: state.client_name,
        display_name: state.display_name,
        operation_id: state.operation_id,
        phase: "creating",
      };
      await writeManagedState(state);
      user = await createManagedUser(session, state);
      createdThisRun = true;
    }

    if (!isExactManagedUser(user, state)) {
      throw setupError(
        "managed_user_policy_changed",
        "The managed browser user was changed; automatic repair is disabled",
      );
    }

    if (state.phase === "creating" || state.user_id !== user.id) {
      state = {
        client_name: state.client_name,
        display_name: state.display_name,
        operation_id: state.operation_id,
        phase: "provisioning",
        user_id: user.id,
      };
      await writeManagedState(state);
    }

    if (state.phase !== "ready") {
      pendingStoredToken =
        (await readPrivateFile(MANAGED_TOKEN_PATH)) !== null;
    }

    if (state.phase === "ready") {
      if (
        user.username !== null ||
        !Array.isArray(user.credentials) ||
        user.credentials.length !== 0
      ) {
        throw setupError(
          "managed_user_credential_changed",
          "The managed browser user has an unexpected credential; automatic repair is disabled",
        );
      }
      const storedToken = await readPrivateFile(MANAGED_TOKEN_PATH);
      if (storedToken !== null) {
        try {
          await validateManagedToken(storedToken, state, websocketUrl);
          process.stdout.write(
            `${JSON.stringify(sanitizedManagedResult("ready", user, true))}\n`,
          );
          return;
        } catch (error) {
          if (
            (error instanceof AuthenticationRejectedError &&
              error.definitive === true) ||
            (error instanceof ManagedSetupError &&
              error.code === "managed_token_invalid")
          ) {
            await safeUnlink(MANAGED_TOKEN_PATH);
            await ensureHomeAssistantProvider(endpoint);
          } else if (
            error instanceof ManagedSetupError &&
            [
              "managed_token_metadata_mismatch",
              "managed_token_owner_mismatch",
            ].includes(error.code)
          ) {
            // A metadata mismatch can still represent an active credential.
            // Revoke only after proving that it belongs to this managed user;
            // otherwise retain the sole local copy for a safe retry.
            await ensureHomeAssistantProvider(endpoint);
            await disableStoredManagedTokenAtEndpoint(state, websocketUrl);
          } else {
            throw setupError(
              "managed_token_validation_unavailable",
              "Managed browser credential validation is temporarily unavailable; the stored credential was preserved",
            );
          }
        }
      }
      if (storedToken === null) {
        await ensureHomeAssistantProvider(endpoint);
      }
      state = { ...state, phase: "provisioning" };
      await writeManagedState(state);
    }

    if (state.temporary_username !== undefined) {
      if (!Array.isArray(user.credentials)) {
        throw setupError(
          "managed_user_credential_changed",
          "The interrupted managed browser setup has incomplete credential metadata",
        );
      }
      if (user.credentials.length === 0 && user.username !== null) {
        throw setupError(
          "managed_user_credential_changed",
          "The interrupted managed browser setup has inconsistent credential metadata",
        );
      }
      if (
        user.credentials.length > 0 &&
        !hasOnlyExpectedTemporaryCredential(user, state)
      ) {
        throw setupError(
          "managed_user_credential_changed",
          "The interrupted managed browser setup has an unexpected credential",
        );
      }
      if (user.credentials.length > 0) {
        await session.request("config/auth_provider/homeassistant/delete", {
          username: state.temporary_username,
        });
      } else {
        await reconcileJournaledTemporaryCredential(session, state, user);
      }
      user = await confirmManagedUserHasNoCredentials(session, state);
    } else if (
      !Array.isArray(user.credentials) ||
      user.credentials.length !== 0 ||
      user.username !== null
    ) {
      throw setupError(
        "managed_user_credential_changed",
        "The managed browser user has unexpected credential metadata",
      );
    }

    temporaryUsername = `codex-browser-${randomBytes(18).toString("hex")}`;
    const temporaryPassword = randomUrlSafe(32);
    state = { ...state, temporary_username: temporaryUsername };
    await writeManagedState(state);
    journalCleanupRequired = true;
    temporaryCredentialAttempted = true;
    await session.request("config/auth_provider/homeassistant/create", {
      password: temporaryPassword,
      user_id: user.id,
      username: temporaryUsername,
    });

    // A token exchange can take effect even if its HTTP response is lost. Keep
    // the journal until a later authenticated token listing proves cleanup.
    temporaryTokenCleanupRequired = true;
    const temporaryLogin = await loginWithTemporaryCredential(
      endpoint,
      temporaryUsername,
      temporaryPassword,
    );
    temporaryRefreshToken = temporaryLogin.refreshToken;
    temporarySession = await openSession(
      temporaryLogin.accessToken,
      "temporary managed browser",
      websocketUrl,
    );
    const temporaryCurrentUser = await temporarySession.request("auth/current_user");
    if (
      temporaryCurrentUser?.id !== user.id ||
      temporaryCurrentUser?.is_admin !== false ||
      temporaryCurrentUser?.is_owner !== false
    ) {
      throw setupError(
        "temporary_login_owner_mismatch",
        "Temporary managed login belongs to an unexpected user",
      );
    }

    await prepareTemporaryRefreshToken(temporarySession);
    if (pendingStoredToken) {
      // The temporary session has just confirmed that every non-current token
      // was deleted, including any LLAT journaled by an interrupted attempt.
      await safeUnlink(MANAGED_TOKEN_PATH);
      pendingStoredToken = false;
    }
    managedTokenCreationAttempted = true;
    managedToken = await temporarySession.request(
      "auth/long_lived_access_token",
      {
        client_name: state.client_name,
        lifespan: LONG_LIVED_TOKEN_DAYS,
      },
    );
    if (
      typeof managedToken !== "string" ||
      managedToken.length < 20 ||
      /[\r\n\0]/u.test(managedToken)
    ) {
      throw setupError(
        "managed_token_creation_invalid",
        "Home Assistant returned an invalid managed browser credential",
      );
    }

    managedSession = await openSession(
      managedToken,
      "managed browser",
      websocketUrl,
    );
    const managedCurrentUser = await managedSession.request("auth/current_user");
    if (
      managedCurrentUser?.id !== user.id ||
      managedCurrentUser?.is_admin !== false ||
      managedCurrentUser?.is_owner !== false
    ) {
      throw setupError(
        "managed_token_owner_mismatch",
        "Managed browser credential belongs to an unexpected user",
      );
    }
    const managedRefreshTokens = await managedSession.request("auth/refresh_tokens");
    const currentManagedRefreshToken = Array.isArray(managedRefreshTokens)
      ? managedRefreshTokens.find((candidate) => candidate?.is_current === true)
      : undefined;
    if (
      currentManagedRefreshToken?.type !== "long_lived_access_token" ||
      currentManagedRefreshToken?.client_name !== state.client_name
    ) {
      throw setupError(
        "managed_token_metadata_mismatch",
        "Managed browser credential metadata is unexpected",
      );
    }
    managedTokenCleanupAuthorized = true;
    // Persist the LLAT while state remains provisioning. Runtime activation
    // accepts only a ready state, but a hard crash can now be recovered without
    // losing the sole raw credential needed to revoke the token safely.
    await writePrivateFile(MANAGED_TOKEN_PATH, managedToken);

    // Confirm that the new LLAT is the only refresh token before removing the
    // password credential or its crash-recovery journal. This deletes the
    // temporary normal token through the authenticated WebSocket and then
    // re-reads the token list to prove the invariant.
    await enforceSingleManagedToken(managedSession, state.client_name);
    temporaryTokenCleanupRequired = false;
    temporaryRefreshToken = undefined;
    temporarySession.close();
    temporarySession = undefined;

    await session.request("config/auth_provider/homeassistant/delete", {
      username: temporaryUsername,
    });
    user = await confirmManagedUserHasNoCredentials(session, state);
    const clearedJournalState = {
      client_name: state.client_name,
      display_name: state.display_name,
      operation_id: state.operation_id,
      phase: "provisioning",
      user_id: state.user_id,
    };
    await writeManagedState(clearedJournalState);
    state = clearedJournalState;
    journalCleanupRequired = false;
    temporaryCredentialAttempted = false;

    await validateManagedToken(managedToken, state, websocketUrl);
    await writePrivateFile(MANAGED_TOKEN_PATH, managedToken);
    state = { ...state, phase: "ready" };
    await writeManagedState(state);
    process.stdout.write(
      `${JSON.stringify(sanitizedManagedResult("ready", user, false))}\n`,
    );
  } catch (error) {
    const rollbackErrors = [];
    let preservePersistentState =
      pendingStoredToken ||
      (error instanceof ManagedSetupError &&
        [
          "homeassistant_provider_unavailable",
          "managed_token_revocation_failed",
          "managed_token_validation_unavailable",
        ].includes(error.code));
    const preserveUncertainManagedToken = async () => {
      if (!managedToken) return;
      try {
        await writePrivateFile(MANAGED_TOKEN_PATH, managedToken);
        preservePersistentState = true;
      } catch {
        rollbackErrors.push("managed token recovery file");
      }
    };
    if (
      !managedSession &&
      error instanceof ManagedSetupError &&
      [
        "managed_user_policy_changed",
        "managed_user_credential_changed",
      ].includes(error.code)
    ) {
      try {
        await disableStoredManagedTokenAtEndpoint(state, websocketUrl);
      } catch {
        rollbackErrors.push("stored managed token");
        preservePersistentState = true;
      }
    }
    if (
      managedSession &&
      managedTokenCleanupAuthorized &&
      temporaryTokenCleanupRequired
    ) {
      try {
        await enforceSingleManagedToken(managedSession, state.client_name);
        temporaryTokenCleanupRequired = false;
        temporaryRefreshToken = undefined;
        temporarySession?.close();
        temporarySession = undefined;
      } catch {
        // Fall through to the raw refresh-token revocation path below. If
        // neither path can prove cleanup, the journal remains for retry.
      }
    }
    if (managedTokenCreationAttempted && !managedSession && temporarySession) {
      try {
        await removeManagedTokensByClientName(
          temporarySession,
          state.client_name,
        );
        managedToken = undefined;
        managedTokenCreationAttempted = false;
      } catch {
        rollbackErrors.push("new managed token");
        await preserveUncertainManagedToken();
      }
    }
    if (managedSession) {
      try {
        await removeCurrentManagedToken(managedSession, managedToken, websocketUrl);
        managedToken = undefined;
      } catch {
        rollbackErrors.push("managed token");
        await preserveUncertainManagedToken();
      }
    }
    if (temporaryTokenCleanupRequired && temporaryRefreshToken) {
      try {
        await revokeTemporaryRefreshToken(endpoint, temporaryRefreshToken);
        temporaryRefreshToken = undefined;
        temporaryTokenCleanupRequired = false;
      } catch {
        rollbackErrors.push("temporary refresh token");
      }
    } else if (temporaryTokenCleanupRequired && !temporaryRefreshToken) {
      rollbackErrors.push("unconfirmed temporary refresh token");
    }
    if (temporaryCredentialAttempted && temporaryUsername) {
      let credentialRemovalConfirmed = false;
      const journalState = {
        client_name: state.client_name,
        display_name: state.display_name,
        operation_id: state.operation_id,
        phase: "provisioning",
        temporary_username: temporaryUsername,
        user_id: state.user_id,
      };
      try {
        await reconcileJournaledTemporaryCredential(
          session,
          journalState,
          user,
        );
        credentialRemovalConfirmed = true;
      } catch {
        rollbackErrors.push("temporary credential");
      }
      if (credentialRemovalConfirmed) {
        try {
          user = await confirmManagedUserHasNoCredentials(
            session,
            journalState,
          );
          if (temporaryTokenCleanupRequired) {
            state = journalState;
            journalCleanupRequired = true;
          } else {
            const clearedJournalState = {
              client_name: state.client_name,
              display_name: state.display_name,
              operation_id: state.operation_id,
              phase: "provisioning",
              user_id: user.id,
            };
            await writeManagedState(clearedJournalState);
            state = clearedJournalState;
            journalCleanupRequired = false;
          }
          temporaryCredentialAttempted = false;
        } catch {
          rollbackErrors.push("temporary credential confirmation");
        }
      }
    }
    const preserveJournalState =
      journalCleanupRequired ||
      temporaryTokenCleanupRequired ||
      (error instanceof ManagedSetupError &&
        [
          "orphaned_temporary_credential",
          "temporary_credential_reconciliation_failed",
          "temporary_username_claimed",
        ].includes(error.code));
    if (preservePersistentState) {
      // A Core restart, DNS failure, or TLS outage must not destroy the only
      // local copy of a still-valid long-lived credential.
    } else if (preserveJournalState || temporaryCredentialAttempted) {
      await safeUnlink(MANAGED_TOKEN_PATH).catch(() => {
        rollbackErrors.push("managed token file");
      });
    } else if (createdThisRun) {
      try {
        await session.request("config/auth/delete", { user_id: user.id });
        await safeUnlink(MANAGED_STATE_PATH);
        await safeUnlink(MANAGED_TOKEN_PATH);
      } catch {
        rollbackErrors.push("managed user");
      }
    } else if (user && validOpaqueId(user.id)) {
      try {
        await safeUnlink(MANAGED_TOKEN_PATH);
        if (!temporaryCredentialAttempted) {
          await writeManagedState({
            client_name: state.client_name,
            display_name: state.display_name,
            operation_id: state.operation_id,
            phase: "provisioning",
            user_id: user.id,
          });
        }
      } catch {
        rollbackErrors.push("managed state");
      }
    }
    if (rollbackErrors.length > 0) {
      throw setupError(
        "rollback_incomplete",
        `Managed browser setup failed and rollback needs review (${rollbackErrors.join(", ")})`,
      );
    }
    throw error;
  } finally {
    temporarySession?.close();
    managedSession?.close();
  }
}

async function removeManagedBrowserAuth(session, supervisorAccessToken) {
  await ensureManagedDirectory();
  await cleanupPrivateTemporaryFiles();
  const state = await readManagedState();
  if (!state) {
    process.stdout.write(
      `${JSON.stringify({ source: "managed", status: "not_configured" })}\n`,
    );
    return;
  }

  let user = await findManagedUser(session, state);
  if (!user) {
    if (state.temporary_username !== undefined) {
      throw setupError(
        "orphaned_temporary_credential",
        "The managed user disappeared during temporary credential cleanup; private recovery state was preserved for manual review",
      );
    }
    await safeUnlink(MANAGED_TOKEN_PATH);
    await safeUnlink(MANAGED_STATE_PATH);
    process.stdout.write(
      `${JSON.stringify({ source: "managed", status: "removed" })}\n`,
    );
    return;
  }
  if (!isExactManagedUser(user, state)) {
    await disableStoredManagedToken(state, supervisorAccessToken);
    throw setupError(
      "managed_user_policy_changed",
      "The managed browser user was changed; automatic deletion is disabled",
    );
  }

  if (state.temporary_username !== undefined) {
    if (
      !Array.isArray(user.credentials) ||
      (user.credentials.length === 0 && user.username !== null) ||
      (user.credentials.length > 0 &&
        !hasOnlyExpectedTemporaryCredential(user, state))
    ) {
      await disableStoredManagedToken(state, supervisorAccessToken);
      throw setupError(
        "managed_user_credential_changed",
        "The managed browser user has an unexpected credential; automatic deletion is disabled",
      );
    }
    if (user.credentials.length > 0) {
      await session.request("config/auth_provider/homeassistant/delete", {
        username: state.temporary_username,
      });
    } else {
      await reconcileJournaledTemporaryCredential(session, state, user);
    }
    user = await confirmManagedUserHasNoCredentials(session, {
      ...state,
      user_id: user.id,
    });
    await writeManagedState({
      client_name: state.client_name,
      display_name: state.display_name,
      operation_id: state.operation_id,
      phase: "provisioning",
      user_id: user.id,
    });
  } else if (
    !Array.isArray(user.credentials) ||
    user.credentials.length !== 0 ||
    user.username !== null
  ) {
    await disableStoredManagedToken(state, supervisorAccessToken);
    throw setupError(
      "managed_user_credential_changed",
      "The managed browser user has inconsistent credential metadata",
    );
  }

  await session.request("config/auth/delete", { user_id: user.id });
  const remaining = await listUsers(session);
  if (remaining.some((candidate) => candidate?.id === user.id)) {
    throw setupError(
      "managed_user_removal_failed",
      "Home Assistant did not confirm managed browser user removal",
    );
  }
  await safeUnlink(MANAGED_TOKEN_PATH);
  await safeUnlink(MANAGED_STATE_PATH);
  process.stdout.write(
    `${JSON.stringify({ source: "managed", status: "removed" })}\n`,
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

async function removePassword(session, expectedUserId, websocketUrl) {
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

  let browserSession = await openSession(
    browserToken,
    "dedicated browser",
    websocketUrl,
  );
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

  browserSession = await openSession(
    browserToken,
    "dedicated browser",
    websocketUrl,
  );
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

const [operation, ...args] = process.argv.slice(2);
const supervisorToken = process.env.SUPERVISOR_TOKEN;
let session;
try {
  if (operation === "cleanup-temp" && args.length === 0) {
    await ensureManagedDirectory();
    await cleanupPrivateTemporaryFiles();
  } else {
    if (!supervisorToken) {
      throw new Error("SUPERVISOR_TOKEN is unavailable");
    }
    session = await openSession(supervisorToken, "Supervisor");
  }
  if (operation === "cleanup-temp" && args.length === 0) {
    // The cleanup-only operation intentionally needs no Home Assistant session.
  } else if (operation === "create" && args.length === 2) {
    await createUser(
      session,
      requireText(args[0], "Display name"),
      requireText(args[1], "Username"),
    );
  } else if (operation === "remove-password" && args.length === 1) {
    const endpoint = await coreEndpoint(supervisorToken);
    await removePassword(
      session,
      requireText(args[0], "User ID"),
      coreWebSocketUrl(endpoint),
    );
  } else if (operation === "auto-setup" && args.length === 0) {
    await setupManagedBrowserAuth(session, supervisorToken);
  } else if (operation === "auto-remove" && args.length === 0) {
    await removeManagedBrowserAuth(session, supervisorToken);
  } else {
    throw new Error("Invalid browser user administration request");
  }
} catch (error) {
  const code = error instanceof ManagedSetupError ? ` (${error.code})` : "";
  process.stderr.write(
    `${error instanceof Error ? error.message : "Browser user administration failed"}${code}\n`,
  );
  process.exitCode = 1;
} finally {
  session?.close();
}
