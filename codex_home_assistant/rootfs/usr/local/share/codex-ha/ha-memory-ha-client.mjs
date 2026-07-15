import { readFile } from "node:fs/promises";

const DEFAULT_WEBSOCKET_URL = "ws://supervisor/core/websocket";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const INSTALLED_WS_MODULE =
  "/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs";

const HOME_ASSISTANT_ERROR_CODES = new Set([
  "ha_unavailable",
  "ha_token_unavailable",
  "ha_ws_runtime_unavailable",
  "ha_dns_failed",
  "ha_transport_failed",
  "ha_timeout",
  "ha_auth_rejected",
  "ha_protocol_error",
  "ha_ws_closed",
  "ha_command_areas_failed",
  "ha_command_devices_failed",
  "ha_command_entities_failed",
  "ha_command_states_failed",
  "ha_command_automation_config_failed",
  "ha_command_related_failed",
  "ha_command_failed",
  "ha_snapshot_incomplete",
  "ha_fixture_invalid",
  "ha_fixture_failure",
]);

const COMMAND_ERROR_CODES = new Map([
  ["config/area_registry/list", "ha_command_areas_failed"],
  ["config/device_registry/list", "ha_command_devices_failed"],
  ["config/entity_registry/list", "ha_command_entities_failed"],
  ["get_states", "ha_command_states_failed"],
  ["automation/config", "ha_command_automation_config_failed"],
  ["search/related", "ha_command_related_failed"],
]);

export class HomeAssistantUnavailableError extends Error {
  constructor(code, message, options = undefined) {
    if (typeof message !== "string") {
      options = message;
      message = code;
      code = "ha_unavailable";
    }
    super(message, options);
    this.name = "HomeAssistantUnavailableError";
    this.code = HOME_ASSISTANT_ERROR_CODES.has(code) ? code : "ha_unavailable";
  }
}

class HomeAssistantCommandRejectedError extends HomeAssistantUnavailableError {
  constructor(commandType, remoteCode) {
    super(
      commandErrorCode(commandType),
      `Home Assistant command ${commandType} failed (${remoteCode})`,
    );
    this.name = "HomeAssistantCommandRejectedError";
    this.commandType = commandType;
    this.remoteCode = remoteCode;
  }
}

export function homeAssistantErrorCode(error) {
  return error instanceof HomeAssistantUnavailableError &&
    HOME_ASSISTANT_ERROR_CODES.has(error.code)
    ? error.code
    : "ha_unavailable";
}

function sanitizeProtocolError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of [
    "SUPERVISOR_TOKEN",
    "HA_BROWSER_TOKEN",
    "HOME_ASSISTANT_TOKEN",
    "HASS_TOKEN",
  ]) {
    const secret = process.env[name];
    if (typeof secret === "string" && secret.length >= 8) {
      message = message.replaceAll(secret, "[REDACTED]");
    }
  }
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:access_)?token=)[^&\s]+/giu, "$1[REDACTED]")
    .slice(0, 500);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new HomeAssistantUnavailableError("ha_timeout", `${label} timed out`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function commandErrorCode(type) {
  return COMMAND_ERROR_CODES.get(type) ?? "ha_command_failed";
}

function transportErrorCode(event) {
  const code = event?.error?.code ?? event?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "ha_dns_failed";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "ha_timeout";
  return "ha_transport_failed";
}

async function productionWebSocketFactory(url, { timeoutMs }) {
  let WebSocketImplementation;
  try {
    ({ default: WebSocketImplementation } = await import(INSTALLED_WS_MODULE));
  } catch {
    throw new HomeAssistantUnavailableError(
      "ha_ws_runtime_unavailable",
      "The image-managed Home Assistant WebSocket runtime is unavailable",
    );
  }
  return new WebSocketImplementation(url, {
    handshakeTimeout: timeoutMs,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    rejectUnauthorized: url.startsWith("wss:") ? true : undefined,
  });
}

class HomeAssistantWebSocketClient {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.haVersion = null;
    this.closed = false;
  }

  static async connect({ url, token, timeoutMs, webSocketFactory }) {
    if (!token) {
      throw new HomeAssistantUnavailableError(
        "ha_token_unavailable",
        "SUPERVISOR_TOKEN is unavailable; Home Assistant memory refresh is disabled",
      );
    }

    let socket;
    try {
      const createdSocket = (webSocketFactory ?? productionWebSocketFactory)(url, {
        timeoutMs,
        maxMessageBytes: MAX_MESSAGE_BYTES,
      });
      socket = createdSocket && typeof createdSocket.then === "function"
        ? await createdSocket
        : createdSocket;
    } catch (error) {
      if (error instanceof HomeAssistantUnavailableError) throw error;
      throw new HomeAssistantUnavailableError(
        "ha_transport_failed",
        "Unable to initialize the Home Assistant WebSocket transport",
      );
    }
    const client = new HomeAssistantWebSocketClient(socket, timeoutMs);

    const authenticated = new Promise((resolve, reject) => {
      const fail = (error, code = "ha_protocol_error") => {
        const failure =
          error instanceof HomeAssistantUnavailableError
            ? error
            : new HomeAssistantUnavailableError(
                code,
                `Home Assistant WebSocket authentication failed: ${sanitizeProtocolError(error)}`,
              );
        // The listener remains active after authentication. Preserve the
        // original bounded reason for any requests already in flight instead
        // of letting the later close event collapse it to ha_ws_closed.
        client.handleFailure(failure);
        reject(failure);
      };

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          fail(new Error("Home Assistant WebSocket returned non-text data"));
          socket.close();
          return;
        }
        if (Buffer.byteLength(event.data, "utf8") > MAX_MESSAGE_BYTES) {
          fail(new Error("Home Assistant WebSocket response exceeded the safety limit"));
          socket.close();
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          fail(new Error("Home Assistant WebSocket returned invalid JSON"));
          socket.close();
          return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          fail(new Error("Home Assistant WebSocket returned a non-object message"));
          socket.close();
          return;
        }

        if (message.type === "auth_required") {
          try {
            socket.send(JSON.stringify({ type: "auth", access_token: token }));
          } catch {
            fail(
              new HomeAssistantUnavailableError(
                "ha_transport_failed",
                "Home Assistant WebSocket authentication could not be sent",
              ),
            );
            socket.close();
          }
          return;
        }
        if (message.type === "auth_ok") {
          client.haVersion =
            typeof message.ha_version === "string" ? message.ha_version : null;
          resolve(client);
          return;
        }
        if (message.type === "auth_invalid") {
          fail(
            new HomeAssistantUnavailableError(
              "ha_auth_rejected",
              "Home Assistant rejected App authentication",
            ),
          );
          socket.close();
          return;
        }
        client.handleMessage(message);
      });

      socket.addEventListener("error", (event) => {
        fail(
          new HomeAssistantUnavailableError(
            transportErrorCode(event),
            "Home Assistant WebSocket transport failed",
          ),
        );
        socket.close();
      });
      socket.addEventListener("close", () => {
        client.handleClose();
        if (!client.haVersion) {
          fail(
            new HomeAssistantUnavailableError(
              "ha_ws_closed",
              "Home Assistant WebSocket closed before authentication",
            ),
          );
        }
      });
    });

    try {
      return await withTimeout(authenticated, timeoutMs, "Home Assistant authentication");
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  handleMessage(message) {
    if (message.type !== "result" || !Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    if (message.success !== true && message.success !== false) {
      const failure = new HomeAssistantUnavailableError(
        "ha_protocol_error",
        "Home Assistant WebSocket returned a malformed command result",
      );
      this.handleFailure(failure);
      this.socket.close();
      return;
    }

    if (
      message.success === false &&
      (!message.error ||
        typeof message.error !== "object" ||
        Array.isArray(message.error) ||
        typeof message.error.code !== "string" ||
        !/^[A-Za-z0-9_.-]{1,80}$/u.test(message.error.code))
    ) {
      const failure = new HomeAssistantUnavailableError(
        "ha_protocol_error",
        "Home Assistant WebSocket returned a malformed command error",
      );
      this.handleFailure(failure);
      this.socket.close();
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.success === true) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new HomeAssistantCommandRejectedError(pending.type, message.error.code),
      );
    }
  }

  handleClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new HomeAssistantUnavailableError(
          "ha_ws_closed",
          `Home Assistant WebSocket closed during ${pending.type}`,
        ),
      );
    }
    this.pending.clear();
  }

  handleFailure(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(command) {
    if (this.closed) {
      return Promise.reject(
        new HomeAssistantUnavailableError(
          "ha_ws_closed",
          "Home Assistant WebSocket is closed",
        ),
      );
    }
    const id = this.nextId++;
    const type = typeof command.type === "string" ? command.type : "unknown";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HomeAssistantUnavailableError(
            commandErrorCode(type),
            `Home Assistant command ${type} timed out`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        this.socket.send(JSON.stringify({ id, ...command }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new HomeAssistantUnavailableError(
            "ha_transport_failed",
            `Home Assistant command ${type} could not be sent`,
          ),
        );
      }
    });
  }

  close() {
    // Reject and clear any parallel requests before closing the transport. The
    // subsequent close event is intentionally idempotent.
    this.handleClose();
    this.socket.close();
  }
}

function requireFixtureShape(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new HomeAssistantUnavailableError(
      "ha_fixture_invalid",
      "Memory test fixture must be a JSON object",
    );
  }
  if (fixture.error) {
    throw new HomeAssistantUnavailableError(
      "ha_fixture_failure",
      "Memory test fixture requested an API failure",
    );
  }
  for (const key of ["areas", "devices", "entities", "states"]) {
    if (!Array.isArray(fixture[key])) {
      throw new HomeAssistantUnavailableError(
        "ha_fixture_invalid",
        `Memory test fixture field ${key} must be an array`,
      );
    }
  }
  return {
    haVersion:
      typeof fixture.ha_version === "string" ? fixture.ha_version : "fixture",
    areas: fixture.areas,
    devices: fixture.devices,
    entities: fixture.entities,
    states: fixture.states,
    automations:
      fixture.automations && typeof fixture.automations === "object"
        ? fixture.automations
        : {},
    warnings: Array.isArray(fixture.warnings)
      ? fixture.warnings.filter((item) => typeof item === "string").slice(0, 50)
      : [],
  };
}

async function readTestFixture(path) {
  if (process.env.HA_MEMORY_TEST_MODE !== "1") {
    throw new HomeAssistantUnavailableError(
      "ha_fixture_invalid",
      "HA_MEMORY_TEST_FIXTURE is only accepted in explicit memory test mode",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new HomeAssistantUnavailableError(
      "ha_fixture_invalid",
      `Unable to read Home Assistant memory test fixture: ${sanitizeProtocolError(error)}`,
    );
  }
  return requireFixtureShape(parsed);
}

function automationEntityIds(items) {
  return [
    ...new Set(
      items
        .map((item) => item?.entity_id)
        .filter(
          (entityId) =>
            typeof entityId === "string" && entityId.startsWith("automation."),
        ),
    ),
  ].sort();
}

async function fetchAutomationDetails(client, entityId) {
  const [configResult, relatedResult] = await Promise.allSettled([
    client.request({ type: "automation/config", entity_id: entityId }),
    client.request({
      type: "search/related",
      item_type: "automation",
      item_id: entityId,
    }),
  ]);

  const configEnvelopeValid =
    configResult.status === "fulfilled" &&
    configResult.value &&
    typeof configResult.value === "object" &&
    !Array.isArray(configResult.value) &&
    Object.hasOwn(configResult.value, "config");
  const configValue = configEnvelopeValid ? configResult.value.config : undefined;
  // Core intentionally returns {config: null} for an unavailable automation
  // whose entity still exists. That is a complete response, not a transport or
  // snapshot failure; index the entity/related graph without persisting raw config.
  const configValid =
    configEnvelopeValid &&
    (configValue === null ||
      (typeof configValue === "object" && !Array.isArray(configValue)));
  const relatedValid =
    relatedResult.status === "fulfilled" &&
    relatedResult.value &&
    typeof relatedResult.value === "object" &&
    !Array.isArray(relatedResult.value);
  const relatedUnknownError =
    relatedResult.status === "rejected" &&
    relatedResult.reason instanceof HomeAssistantCommandRejectedError &&
    relatedResult.reason.commandType === "search/related" &&
    relatedResult.reason.remoteCode === "unknown_error";
  const relatedUsable = relatedValid || relatedUnknownError;

  let failureCode = null;
  if (!configValid && configResult.status === "rejected") {
    failureCode = homeAssistantErrorCode(configResult.reason);
  } else if (
    !relatedUsable &&
    relatedResult.status === "rejected"
  ) {
    failureCode = homeAssistantErrorCode(relatedResult.reason);
  } else if (!configValid || !relatedUsable) {
    failureCode = "ha_snapshot_incomplete";
  }

  const warnings = [];
  if (configValid && configValue === null) {
    warnings.push(`automation_config_unavailable:${entityId}`);
  }
  if (relatedUnknownError) {
    warnings.push(`automation_related_unavailable:${entityId}`);
  }

  return {
    entity_id: entityId,
    complete: Boolean(configValid && relatedUsable),
    config: configValid && configValue !== null ? configValue : {},
    related: relatedValid ? relatedResult.value : {},
    failure_code: failureCode,
    warnings,
  };
}

async function fetchAutomationDetailsBounded(client, entityIds, concurrency = 8) {
  const results = new Array(entityIds.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < entityIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fetchAutomationDetails(client, entityIds[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, entityIds.length) },
      () => worker(),
    ),
  );
  return results;
}

export async function fetchHomeAssistantSnapshot(options = {}) {
  const fixturePath =
    options.fixturePath ?? process.env.HA_MEMORY_TEST_FIXTURE ?? null;
  if (fixturePath) return readTestFixture(fixturePath);

  const timeoutMs = Number.isInteger(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  // Never accept an endpoint from the process environment: doing so could send
  // the Supervisor credential to a caller-selected host. Tests may inject an
  // explicit in-process URL without changing the production CLI surface.
  const url = options.url ?? DEFAULT_WEBSOCKET_URL;
  if (options.url !== undefined && options.token === undefined) {
    throw new HomeAssistantUnavailableError(
      "ha_token_unavailable",
      "An explicit Home Assistant WebSocket endpoint requires an explicit credential",
    );
  }
  const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
  const client = await HomeAssistantWebSocketClient.connect({
    url,
    token,
    timeoutMs,
    webSocketFactory: options.webSocketFactory,
  });

  try {
    const [areas, devices, entities, states] = await Promise.all([
      client.request({ type: "config/area_registry/list" }),
      client.request({ type: "config/device_registry/list" }),
      client.request({ type: "config/entity_registry/list" }),
      client.request({ type: "get_states" }),
    ]);

    for (const [key, value] of Object.entries({ areas, devices, entities, states })) {
      if (!Array.isArray(value)) {
        throw new HomeAssistantUnavailableError(
          "ha_snapshot_incomplete",
          `Home Assistant ${key} response was not a list`,
        );
      }
    }

    const activeAutomationIds = automationEntityIds(states);
    const allAutomationIds = automationEntityIds([...entities, ...states]);
    const details = await fetchAutomationDetailsBounded(client, activeAutomationIds);
    const incompleteDetail = details.find((detail) => !detail.complete);
    if (incompleteDetail) {
      throw new HomeAssistantUnavailableError(
        incompleteDetail.failure_code ?? "ha_snapshot_incomplete",
        "Home Assistant returned an incomplete automation detail snapshot",
      );
    }
    const automations = {};
    for (const detail of details) {
      automations[detail.entity_id] = {
        config: detail.config,
        related: detail.related,
      };
    }
    for (const entityId of allAutomationIds) {
      // Registry-only automations are disabled or otherwise not loaded into the
      // automation entity component. HA's automation/config command returns
      // not_found for them, so retain their complete registry index entry with
      // an explicitly empty detail surface instead of treating that expected
      // absence as a partial active-automation snapshot.
      automations[entityId] ??= { config: {}, related: {} };
    }

    return {
      haVersion: client.haVersion,
      areas,
      devices,
      entities,
      states,
      automations,
      warnings: details
        .flatMap((detail) => detail.warnings)
        .slice(0, 100),
    };
  } catch (error) {
    if (error instanceof HomeAssistantUnavailableError) throw error;
    throw new HomeAssistantUnavailableError(
      "ha_snapshot_incomplete",
      "Home Assistant memory refresh failed before a complete snapshot was available",
    );
  } finally {
    try {
      client.close();
    } catch {
      // The requested snapshot outcome is authoritative; close errors are not.
    }
  }
}
