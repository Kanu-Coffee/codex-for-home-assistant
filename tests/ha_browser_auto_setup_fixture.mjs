import { createHash } from "node:crypto";
import { createServer } from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_REQUEST_BYTES = 1024 * 1024;
const READ_ONLY_GROUP = "system-read-only";
const SUPERVISOR_USER_ID = "fixture-supervisor-user";
const MANAGED_CLIENT_ID = "http://127.0.0.1:8099/";

const supervisorToken =
  process.env.AUTO_SETUP_FIXTURE_SUPERVISOR_TOKEN ??
  process.env.GATEWAY_FIXTURE_TOKEN ??
  "fixture-supervisor-token-not-for-production";
const adminToken = process.env.AUTO_SETUP_FIXTURE_ADMIN_TOKEN ?? "";
const tokenPrefix =
  process.env.AUTO_SETUP_FIXTURE_TOKEN_PREFIX ?? "fixtureAutoSetupToken";

let state;

function nowIso() {
  return new Date().toISOString();
}

function normalizeAddress(address) {
  return String(address ?? "").replace(/^::ffff:/, "");
}

function requestSourceIp(request) {
  return normalizeAddress(request.socket.remoteAddress);
}

function resetState() {
  state = {
    providerAvailable: true,
    forcedUserAuthInvalidMessage: null,
    coreInfo: { result: "ok", data: { ssl: false, port: 8123 } },
    failAlways: new Set(),
    failNext: new Set(),
    calls: Object.create(null),
    lastSourceIp: Object.create(null),
    users: new Map(),
    loginFlows: new Map(),
    authorizationCodes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    nextUser: 1,
    nextFlow: 1,
    nextCode: 1,
    nextOAuth: 1,
    nextLongLived: 1,
    revokedOauthTokens: 0,
    deletedRefreshTokens: 0,
  };
}

resetState();

function recordCall(name, request) {
  state.calls[name] = (state.calls[name] ?? 0) + 1;
  if (request) state.lastSourceIp[name] = requestSourceIp(request);
}

function consumeFailure(name) {
  if (state.failAlways.has(name)) return true;
  if (!state.failNext.has(name)) return false;
  state.failNext.delete(name);
  return true;
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function emptyResponse(response, status = 200) {
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}

function errorResponse(response, status, message) {
  jsonResponse(response, status, { message });
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Fixture request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request) {
  const raw = await readRequestBody(request);
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Fixture request body is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function readFormBody(request) {
  return new URLSearchParams(await readRequestBody(request));
}

function publicCurrentUser(user) {
  return {
    id: user.id,
    name: user.name,
    is_owner: user.is_owner,
    is_admin: user.is_admin,
    credentials: user.credential
      ? [{ auth_provider_type: "homeassistant", auth_provider_id: null }]
      : [],
    mfa_modules: [],
  };
}

function publicConfigUser(user) {
  return {
    id: user.id,
    username: user.credential?.username ?? null,
    name: user.name,
    is_owner: user.is_owner,
    is_active: user.is_active,
    local_only: user.local_only,
    system_generated: user.system_generated,
    group_ids: [...user.group_ids],
    credentials: user.credential ? [{ type: "homeassistant" }] : [],
  };
}

function supervisorUser() {
  return {
    id: SUPERVISOR_USER_ID,
    name: "Supervisor fixture",
    is_owner: false,
    is_admin: true,
    is_active: true,
    local_only: true,
    system_generated: true,
    group_ids: ["system-admin"],
    credential: null,
  };
}

function createFixtureUser(input = {}) {
  const id =
    typeof input.id === "string"
      ? input.id
      : `fixture-managed-browser-user-${String(state.nextUser++).padStart(4, "0")}`;
  const user = {
    id,
    name:
      typeof input.name === "string"
        ? input.name
        : "Codex Browser (managed)",
    is_owner: input.is_owner === true,
    is_admin: input.is_admin === true,
    is_active: input.is_active !== false,
    local_only: input.local_only !== false,
    system_generated: input.system_generated === true,
    group_ids: Array.isArray(input.group_ids)
      ? [...input.group_ids]
      : [READ_ONLY_GROUP],
    credential: null,
  };
  state.users.set(id, user);
  return user;
}

function findUserByUsername(username) {
  for (const user of state.users.values()) {
    if (user.credential?.username === username) return user;
  }
  return undefined;
}

function activeRefreshTokensForUser(userId) {
  return [...state.refreshTokens.values()].filter(
    (record) => record.userId === userId && !record.revoked,
  );
}

function revokeRefreshToken(record) {
  if (!record || record.revoked) return;
  record.revoked = true;
  for (const accessToken of record.accessTokens) {
    const access = state.accessTokens.get(accessToken);
    if (access) access.revoked = true;
  }
}

function revokeUserTokens(userId) {
  for (const record of state.refreshTokens.values()) {
    if (record.userId === userId) revokeRefreshToken(record);
  }
}

function redactedState() {
  const users = [...state.users.values()].map((user) => ({
    ...publicConfigUser(user),
    credential_configured: Boolean(user.credential),
  }));
  const activeRefresh = [...state.refreshTokens.values()].filter(
    (record) => !record.revoked,
  );
  return {
    provider_available: state.providerAvailable,
    core_info: structuredClone(state.coreInfo),
    fail_always: [...state.failAlways].sort(),
    fail_next: [...state.failNext].sort(),
    calls: { ...state.calls },
    last_source_ip: { ...state.lastSourceIp },
    users,
    pending_login_flows: [...state.loginFlows.values()].filter(
      (flow) => !flow.completed,
    ).length,
    unused_authorization_codes: [...state.authorizationCodes.values()].filter(
      (code) => !code.used,
    ).length,
    oauth: {
      active_access_tokens: [...state.accessTokens.values()].filter(
        (token) => !token.revoked && token.kind === "oauth",
      ).length,
      active_refresh_tokens: activeRefresh.filter(
        (token) => token.type === "normal",
      ).length,
      revoked_refresh_tokens: state.revokedOauthTokens,
    },
    long_lived: {
      issued: [...state.refreshTokens.values()].filter(
        (token) => token.type === "long_lived_access_token",
      ).length,
      active: activeRefresh.filter(
        (token) => token.type === "long_lived_access_token",
      ).length,
      deleted: state.deletedRefreshTokens,
    },
    active_refresh_tokens_total: activeRefresh.length,
  };
}

function fixtureAdminAuthorized(request) {
  if (adminToken === "") return true;
  return request.headers.authorization === `Bearer ${adminToken}`;
}

const allowedUserPatchKeys = new Set([
  "name",
  "is_owner",
  "is_admin",
  "is_active",
  "local_only",
  "system_generated",
  "group_ids",
]);

async function handleFixtureAdmin(request, response, pathname) {
  if (!fixtureAdminAuthorized(request)) {
    emptyResponse(response, 401);
    return true;
  }

  if (pathname === "/__fixture/state" && request.method === "GET") {
    recordCall("fixture/state", request);
    jsonResponse(response, 200, redactedState());
    return true;
  }

  if (pathname === "/__fixture/reset" && request.method === "POST") {
    await readRequestBody(request);
    resetState();
    recordCall("fixture/reset", request);
    jsonResponse(response, 200, redactedState());
    return true;
  }

  if (pathname === "/__fixture/mutate" && request.method === "POST") {
    const mutation = await readJsonBody(request);
    if (typeof mutation.provider_available === "boolean") {
      state.providerAvailable = mutation.provider_available;
    }
    if (
      Object.hasOwn(mutation, "user_auth_invalid_message") &&
      (mutation.user_auth_invalid_message === null ||
        typeof mutation.user_auth_invalid_message === "string")
    ) {
      state.forcedUserAuthInvalidMessage =
        mutation.user_auth_invalid_message;
    }
    if (mutation.core_info && typeof mutation.core_info === "object") {
      const result =
        typeof mutation.core_info.result === "string"
          ? mutation.core_info.result
          : state.coreInfo.result;
      const ssl =
        typeof mutation.core_info.ssl === "boolean"
          ? mutation.core_info.ssl
          : state.coreInfo.data.ssl;
      const port =
        Number.isInteger(mutation.core_info.port)
          ? mutation.core_info.port
          : state.coreInfo.data.port;
      state.coreInfo = { result, data: { ssl, port } };
    }
    if (mutation.clear_failures === true) {
      state.failAlways.clear();
      state.failNext.clear();
    }
    const persistentFailures = Array.isArray(mutation.fail_always)
      ? mutation.fail_always
      : typeof mutation.fail_always === "string"
        ? [mutation.fail_always]
        : [];
    for (const failure of persistentFailures) {
      if (typeof failure === "string" && failure.length > 0) {
        state.failAlways.add(failure);
      }
    }
    const failures = Array.isArray(mutation.fail_next)
      ? mutation.fail_next
      : typeof mutation.fail_next === "string"
        ? [mutation.fail_next]
        : [];
    for (const failure of failures) {
      if (typeof failure === "string" && failure.length > 0) {
        state.failNext.add(failure);
      }
    }
    if (mutation.delete_users === true) {
      for (const user of state.users.values()) revokeUserTokens(user.id);
      state.users.clear();
    }
    if (mutation.seed_user && typeof mutation.seed_user === "object") {
      const user = createFixtureUser(mutation.seed_user);
      if (mutation.seed_user.credential === true) {
        user.credential = {
          username: `fixture-seeded-user-${state.nextUser}`,
          password: `fixture-seeded-password-${state.nextUser}`,
        };
      }
    }
    if (mutation.seed_normal_refresh === true) {
      const user = mutation.user_id
        ? state.users.get(mutation.user_id)
        : state.users.values().next().value;
      if (!user) {
        errorResponse(response, 404, "Fixture user not found");
        return true;
      }
      createOAuthSession(user, MANAGED_CLIENT_ID, "fixture-admin");
    }
    if (mutation.user_patch && typeof mutation.user_patch === "object") {
      const user = mutation.user_id
        ? state.users.get(mutation.user_id)
        : state.users.values().next().value;
      if (!user) {
        errorResponse(response, 404, "Fixture user not found");
        return true;
      }
      for (const [key, value] of Object.entries(mutation.user_patch)) {
        if (!allowedUserPatchKeys.has(key)) continue;
        if (key === "group_ids") {
          if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            user.group_ids = [...value];
          }
        } else if (key === "name") {
          if (typeof value === "string") user.name = value;
        } else if (typeof value === "boolean") {
          user[key] = value;
        }
      }
    }
    if (["oauth", "long_lived", "all"].includes(mutation.revoke)) {
      for (const token of state.refreshTokens.values()) {
        if (
          mutation.revoke === "all" ||
          (mutation.revoke === "oauth" && token.type === "normal") ||
          (mutation.revoke === "long_lived" &&
            token.type === "long_lived_access_token")
        ) {
          revokeRefreshToken(token);
        }
      }
    }
    recordCall("fixture/mutate", request);
    jsonResponse(response, 200, redactedState());
    return true;
  }

  return false;
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
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Fixture WebSocket frame is too large");
    }
    payloadLength = Number(length);
    offset = 10;
  }
  if (payloadLength > MAX_REQUEST_BYTES) {
    throw new Error("Fixture WebSocket frame is too large");
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
  return { consumed: offset + payloadLength, opcode, payload };
}

function authenticateAccessToken(accessToken, allowSupervisor, allowUser) {
  if (allowSupervisor && accessToken === supervisorToken) {
    return {
      kind: "supervisor",
      user: supervisorUser(),
      refreshTokenId: null,
    };
  }
  if (!allowUser) return null;
  const access = state.accessTokens.get(accessToken);
  if (!access || access.revoked) return null;
  const refresh = state.refreshTokens.get(access.refreshTokenId);
  const user = state.users.get(access.userId);
  if (!refresh || refresh.revoked || !user || !user.is_active) return null;
  return {
    kind: access.kind,
    user,
    refreshTokenId: refresh.id,
  };
}

function sendWebSocketError(send, message, code, text) {
  send({
    id: message.id,
    type: "result",
    success: false,
    error: { code, message: text },
  });
}

function refreshTokenMetadata(record, currentRefreshTokenId) {
  return {
    auth_provider_type:
      record.type === "normal" ? "homeassistant" : null,
    client_icon: null,
    client_id: record.clientId,
    client_name: record.clientName,
    created_at: record.createdAt,
    expire_at: record.expireAt,
    id: record.id,
    is_current: record.id === currentRefreshTokenId,
    last_used_at: record.lastUsedAt,
    last_used_ip: record.lastUsedIp,
    type: record.type,
  };
}

function createLongLivedToken(user, message, sourceIp) {
  const sequence = state.nextLongLived++;
  const refreshTokenId = `fixture-long-lived-refresh-id-${String(sequence).padStart(4, "0")}`;
  const accessToken = `${tokenPrefix}.long_lived.${String(sequence).padStart(4, "0")}.secret`;
  const lifespan = Number(message.lifespan);
  const expireAt = Number.isInteger(lifespan)
    ? new Date(Date.now() + lifespan * 86_400_000).toISOString()
    : null;
  const record = {
    id: refreshTokenId,
    rawToken: null,
    userId: user.id,
    type: "long_lived_access_token",
    clientId: null,
    clientName:
      typeof message.client_name === "string"
        ? message.client_name
        : "Fixture long-lived token",
    createdAt: nowIso(),
    expireAt,
    lastUsedAt: null,
    lastUsedIp: sourceIp,
    revoked: false,
    accessTokens: new Set([accessToken]),
  };
  state.refreshTokens.set(record.id, record);
  state.accessTokens.set(accessToken, {
    userId: user.id,
    refreshTokenId: record.id,
    kind: "long_lived_access_token",
    revoked: false,
  });
  return accessToken;
}

function handleAuthenticatedWebSocketMessage(
  request,
  socket,
  send,
  session,
  message,
) {
  const sourceIp = requestSourceIp(request);
  const command = message.type;
  recordCall(command, request);
  if (consumeFailure(command)) {
    sendWebSocketError(send, message, "fixture_failure", "Injected fixture failure");
    return;
  }

  if (command === "auth/current_user") {
    send({
      id: message.id,
      type: "result",
      success: true,
      result: publicCurrentUser(session.user),
    });
    return;
  }

  if (command === "config/auth/list" && session.kind === "supervisor") {
    send({
      id: message.id,
      type: "result",
      success: true,
      result: [...state.users.values()].map(publicConfigUser),
    });
    return;
  }

  if (command === "config/auth/create" && session.kind === "supervisor") {
    if (
      typeof message.name !== "string" ||
      !Array.isArray(message.group_ids) ||
      typeof message.local_only !== "boolean"
    ) {
      sendWebSocketError(send, message, "invalid_format", "Invalid create request");
      return;
    }
    const user = createFixtureUser({
      name: message.name,
      group_ids: message.group_ids,
      local_only: message.local_only,
    });
    send({
      id: message.id,
      type: "result",
      success: true,
      result: { user: publicConfigUser(user) },
    });
    return;
  }

  if (command === "config/auth/delete" && session.kind === "supervisor") {
    const user = state.users.get(message.user_id);
    if (!user) {
      sendWebSocketError(send, message, "not_found", "User not found");
      return;
    }
    revokeUserTokens(user.id);
    state.users.delete(user.id);
    send({ id: message.id, type: "result", success: true, result: null });
    return;
  }

  if (
    command === "config/auth_provider/homeassistant/create" &&
    session.kind === "supervisor"
  ) {
    if (!state.providerAvailable) {
      sendWebSocketError(send, message, "provider_not_found", "Provider not found");
      return;
    }
    const user = state.users.get(message.user_id);
    if (
      !user ||
      typeof message.username !== "string" ||
      message.username !== message.username.trim().toLowerCase() ||
      typeof message.password !== "string" ||
      message.password.length === 0 ||
      findUserByUsername(message.username)
    ) {
      sendWebSocketError(send, message, "invalid_auth", "Credential creation failed");
      return;
    }
    user.credential = {
      username: message.username,
      password: message.password,
    };
    if (
      consumeFailure(
        "config/auth_provider/homeassistant/create_after_auth",
      )
    ) {
      sendWebSocketError(
        send,
        message,
        "fixture_partial_failure",
        "Injected partial credential failure",
      );
      return;
    }
    send({ id: message.id, type: "result", success: true, result: null });
    return;
  }

  if (
    command === "config/auth_provider/homeassistant/delete" &&
    session.kind === "supervisor"
  ) {
    if (!state.providerAvailable) {
      sendWebSocketError(
        send,
        message,
        "provider_failure",
        "Local authentication provider unavailable",
      );
      return;
    }
    const user = findUserByUsername(message.username);
    if (!user) {
      sendWebSocketError(
        send,
        message,
        "provider_failure",
        "Credential deletion failed",
      );
      return;
    }
    user.credential = null;
    send({ id: message.id, type: "result", success: true, result: null });
    return;
  }

  if (command === "auth/long_lived_access_token" && session.kind !== "supervisor") {
    if (
      typeof message.client_name !== "string" ||
      !Number.isInteger(message.lifespan)
    ) {
      sendWebSocketError(send, message, "invalid_format", "Invalid token request");
      return;
    }
    const token = createLongLivedToken(session.user, message, sourceIp);
    if (consumeFailure("auth/long_lived_access_token_after_create")) {
      sendWebSocketError(
        send,
        message,
        "fixture_partial_failure",
        "Injected post-creation token failure",
      );
      return;
    }
    send({
      id: message.id,
      type: "result",
      success: true,
      result: token,
    });
    return;
  }

  if (command === "auth/refresh_tokens" && session.kind !== "supervisor") {
    const tokens = activeRefreshTokensForUser(session.user.id).map((record) =>
      refreshTokenMetadata(record, session.refreshTokenId),
    );
    send({
      id: message.id,
      type: "result",
      success: true,
      result: tokens,
    });
    return;
  }

  if (command === "auth/delete_refresh_token" && session.kind !== "supervisor") {
    const record = state.refreshTokens.get(message.refresh_token_id);
    if (!record || record.revoked || record.userId !== session.user.id) {
      sendWebSocketError(send, message, "invalid_token_id", "Invalid token ID");
      return;
    }
    const deletingCurrent = record.id === session.refreshTokenId;
    revokeRefreshToken(record);
    state.deletedRefreshTokens += 1;
    if (deletingCurrent) {
      // Core closes the current session through its refresh-token revoke
      // callback before a command result can be relied upon.
      socket.end();
    } else {
      send({ id: message.id, type: "result", success: true, result: {} });
    }
    return;
  }

  sendWebSocketError(send, message, "unauthorized", "Fixture command denied");
}

function acceptWebSocket(
  request,
  socket,
  { allowSupervisor, allowUser, label },
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
    encodeWebSocketFrame({ type: "auth_required", ha_version: "2026.7.1" }),
  );

  let session = null;
  let buffered = Buffer.alloc(0);
  const send = (message) => socket.write(encodeWebSocketFrame(message));
  recordCall(label, request);

  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_REQUEST_BYTES + 14) {
      socket.destroy();
      return;
    }
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

      if (!session) {
        if (message.type !== "auth" || typeof message.access_token !== "string") {
          send({ type: "auth_invalid", message: "Authentication required" });
          continue;
        }
        session = authenticateAccessToken(
          message.access_token,
          allowSupervisor,
          allowUser,
        );
        if (!session) {
          send({
            type: "auth_invalid",
            message: "Invalid access token or password",
          });
          socket.end();
          return;
        }
        if (
          session.kind !== "supervisor" &&
          typeof state.forcedUserAuthInvalidMessage === "string"
        ) {
          send({
            type: "auth_invalid",
            message: state.forcedUserAuthInvalidMessage,
          });
          socket.end();
          return;
        }
        const refresh = session.refreshTokenId
          ? state.refreshTokens.get(session.refreshTokenId)
          : null;
        if (refresh) {
          refresh.lastUsedAt = nowIso();
          refresh.lastUsedIp = requestSourceIp(request);
        }
        send({ type: "auth_ok", ha_version: "2026.7.1" });
        continue;
      }

      handleAuthenticatedWebSocketMessage(
        request,
        socket,
        send,
        session,
        message,
      );
    }
  });
}

async function handleSupervisorHttp(request, response) {
  const target = new URL(request.url ?? "/", "http://supervisor");
  if (await handleFixtureAdmin(request, response, target.pathname)) return;

  if (target.pathname === "/core/info" && request.method === "GET") {
    recordCall("supervisor/core/info", request);
    if (request.headers.authorization !== `Bearer ${supervisorToken}`) {
      emptyResponse(response, 401);
      return;
    }
    if (consumeFailure("supervisor/core/info")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    jsonResponse(response, 200, state.coreInfo);
    return;
  }

  emptyResponse(response, 404);
}

function loginForm(flowId, errors = {}) {
  return {
    type: "form",
    flow_id: flowId,
    handler: ["homeassistant", null],
    step_id: "init",
    data_schema: [
      { name: "username", required: true, type: "string" },
      { name: "password", required: true, type: "string" },
    ],
    errors,
  };
}

function createOAuthSession(user, clientId, sourceIp) {
  const sequence = state.nextOAuth++;
  const refreshToken = `${tokenPrefix}.oauth_refresh.${String(sequence).padStart(4, "0")}.secret`;
  const accessToken = `${tokenPrefix}.oauth_access.${String(sequence).padStart(4, "0")}.secret`;
  const refreshTokenId = `fixture-oauth-refresh-id-${String(sequence).padStart(4, "0")}`;
  const refresh = {
    id: refreshTokenId,
    rawToken: refreshToken,
    userId: user.id,
    type: "normal",
    clientId,
    clientName: null,
    createdAt: nowIso(),
    expireAt: null,
    lastUsedAt: nowIso(),
    lastUsedIp: sourceIp,
    revoked: false,
    accessTokens: new Set([accessToken]),
  };
  state.refreshTokens.set(refresh.id, refresh);
  state.accessTokens.set(accessToken, {
    userId: user.id,
    refreshTokenId: refresh.id,
    kind: "oauth",
    revoked: false,
  });
  return { accessToken, refreshToken, refresh };
}

function refreshOAuthAccess(record) {
  const sequence = state.nextOAuth++;
  const accessToken = `${tokenPrefix}.oauth_access.${String(sequence).padStart(4, "0")}.secret`;
  record.accessTokens.add(accessToken);
  state.accessTokens.set(accessToken, {
    userId: record.userId,
    refreshTokenId: record.id,
    kind: "oauth",
    revoked: false,
  });
  return accessToken;
}

async function handleCoreHttp(request, response) {
  const target = new URL(request.url ?? "/", "http://homeassistant");
  if (await handleFixtureAdmin(request, response, target.pathname)) return;

  if (target.pathname === "/auth/providers" && request.method === "GET") {
    recordCall("auth/providers", request);
    if (consumeFailure("auth/providers")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    jsonResponse(response, 200, {
      providers: state.providerAvailable
        ? [{ name: null, id: null, type: "homeassistant" }]
        : [],
      preselect_remember_me: true,
    });
    return;
  }

  if (target.pathname === "/auth/login_flow" && request.method === "POST") {
    recordCall("auth/login_flow/start", request);
    if (consumeFailure("auth/login_flow/start")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    const input = await readJsonBody(request);
    if (
      !state.providerAvailable ||
      !Array.isArray(input.handler) ||
      input.handler[0] !== "homeassistant" ||
      input.handler[1] !== null ||
      typeof input.client_id !== "string" ||
      typeof input.redirect_uri !== "string"
    ) {
      errorResponse(response, 400, "Invalid login flow request");
      return;
    }
    const sequence = state.nextFlow++;
    const flowId = `fixture-login-flow-${String(sequence).padStart(4, "0")}`;
    state.loginFlows.set(flowId, {
      id: flowId,
      clientId: input.client_id,
      redirectUri: input.redirect_uri,
      sourceIp: requestSourceIp(request),
      completed: false,
    });
    jsonResponse(response, 200, loginForm(flowId));
    return;
  }

  const continuation = target.pathname.match(/^\/auth\/login_flow\/([^/]+)$/u);
  if (continuation && request.method === "POST") {
    recordCall("auth/login_flow/continue", request);
    if (consumeFailure("auth/login_flow/continue")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    const flow = state.loginFlows.get(decodeURIComponent(continuation[1]));
    const input = await readJsonBody(request);
    if (
      !flow ||
      flow.completed ||
      input.client_id !== flow.clientId ||
      requestSourceIp(request) !== flow.sourceIp
    ) {
      errorResponse(response, 400, "Invalid login flow");
      return;
    }
    const user = findUserByUsername(input.username);
    if (
      !user ||
      !user.is_active ||
      user.credential?.password !== input.password
    ) {
      jsonResponse(response, 200, loginForm(flow.id, { base: "invalid_auth" }));
      return;
    }
    flow.completed = true;
    const sequence = state.nextCode++;
    const code = `${tokenPrefix}.authorization_code.${String(sequence).padStart(4, "0")}.secret`;
    state.authorizationCodes.set(code, {
      userId: user.id,
      clientId: flow.clientId,
      used: false,
    });
    jsonResponse(response, 200, {
      type: "create_entry",
      flow_id: flow.id,
      handler: ["homeassistant", null],
      result: code,
      title: "Home Assistant",
      version: 1,
    });
    return;
  }

  if (target.pathname === "/auth/token" && request.method === "POST") {
    recordCall("auth/token", request);
    if (consumeFailure("auth/token")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    const form = await readFormBody(request);
    if (form.get("action") === "revoke") {
      const record = [...state.refreshTokens.values()].find(
        (candidate) => candidate.rawToken === form.get("token"),
      );
      if (record && !record.revoked) {
        revokeRefreshToken(record);
        state.revokedOauthTokens += 1;
      }
      emptyResponse(response);
      return;
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = state.authorizationCodes.get(form.get("code"));
      if (!code || code.used || form.get("client_id") !== code.clientId) {
        jsonResponse(response, 400, { error: "invalid_request" });
        return;
      }
      const user = state.users.get(code.userId);
      if (!user || !user.is_active) {
        jsonResponse(response, 403, { error: "access_denied" });
        return;
      }
      code.used = true;
      const issued = createOAuthSession(
        user,
        code.clientId,
        requestSourceIp(request),
      );
      jsonResponse(response, 200, {
        access_token: issued.accessToken,
        expires_in: 1800,
        refresh_token: issued.refreshToken,
        token_type: "Bearer",
        ha_auth_provider: "homeassistant",
      });
      return;
    }
    if (form.get("grant_type") === "refresh_token") {
      const record = [...state.refreshTokens.values()].find(
        (candidate) => candidate.rawToken === form.get("refresh_token"),
      );
      if (
        !record ||
        record.revoked ||
        record.type !== "normal" ||
        (form.has("client_id") && form.get("client_id") !== record.clientId)
      ) {
        jsonResponse(response, 400, { error: "invalid_grant" });
        return;
      }
      jsonResponse(response, 200, {
        access_token: refreshOAuthAccess(record),
        expires_in: 1800,
        token_type: "Bearer",
      });
      return;
    }
    jsonResponse(response, 400, { error: "unsupported_grant_type" });
    return;
  }

  if (target.pathname === "/auth/revoke" && request.method === "POST") {
    recordCall("auth/revoke", request);
    if (consumeFailure("auth/revoke")) {
      errorResponse(response, 500, "Injected fixture failure");
      return;
    }
    const form = await readFormBody(request);
    const record = [...state.refreshTokens.values()].find(
      (candidate) => candidate.rawToken === form.get("token"),
    );
    if (record && !record.revoked) {
      revokeRefreshToken(record);
      state.revokedOauthTokens += 1;
    }
    emptyResponse(response);
    return;
  }

  emptyResponse(response, 404);
}

const supervisorServer = createServer((request, response) => {
  handleSupervisorHttp(request, response).catch((error) => {
    if (!response.headersSent) {
      errorResponse(response, error?.statusCode ?? 500, "Fixture request failed");
    } else {
      response.destroy();
    }
  });
});

supervisorServer.on("upgrade", (request, socket) => {
  const pathname = new URL(request.url ?? "/", "http://supervisor").pathname;
  if (pathname !== "/core/websocket") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  acceptWebSocket(request, socket, {
    allowSupervisor: true,
    allowUser: false,
    label: "supervisor/websocket",
  });
});

const coreServer = createServer((request, response) => {
  handleCoreHttp(request, response).catch((error) => {
    if (!response.headersSent) {
      errorResponse(response, error?.statusCode ?? 500, "Fixture request failed");
    } else {
      response.destroy();
    }
  });
});

coreServer.on("upgrade", (request, socket) => {
  const pathname = new URL(request.url ?? "/", "http://homeassistant").pathname;
  if (pathname !== "/api/websocket") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  acceptWebSocket(request, socket, {
    allowSupervisor: false,
    allowUser: true,
    label: "core/websocket",
  });
});

await Promise.all([
  new Promise((resolve, reject) => {
    supervisorServer.once("error", reject);
    supervisorServer.listen(80, "0.0.0.0", resolve);
  }),
  new Promise((resolve, reject) => {
    coreServer.once("error", reject);
    coreServer.listen(8123, "0.0.0.0", resolve);
  }),
]);

const shutdown = () => {
  supervisorServer.close();
  coreServer.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Home Assistant browser auto-setup fixture ready");
