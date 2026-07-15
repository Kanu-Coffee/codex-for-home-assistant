import { readFile } from "node:fs/promises";

const DEFAULT_WEBSOCKET_URL = "ws://supervisor/core/websocket";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export class HomeAssistantUnavailableError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "HomeAssistantUnavailableError";
  }
}

function sanitizeProtocolError(error) {
  const message = error instanceof Error ? error.message : String(error);
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
        reject(new HomeAssistantUnavailableError(`${label} timed out`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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

  static async connect({ url, token, timeoutMs }) {
    if (!token) {
      throw new HomeAssistantUnavailableError(
        "SUPERVISOR_TOKEN is unavailable; Home Assistant memory refresh is disabled",
      );
    }

    const socket = new WebSocket(url);
    const client = new HomeAssistantWebSocketClient(socket, timeoutMs);

    const authenticated = new Promise((resolve, reject) => {
      const fail = (error) => {
        reject(
          error instanceof HomeAssistantUnavailableError
            ? error
            : new HomeAssistantUnavailableError(
                `Home Assistant WebSocket authentication failed: ${sanitizeProtocolError(error)}`,
              ),
        );
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

        if (message.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (message.type === "auth_ok") {
          client.haVersion =
            typeof message.ha_version === "string" ? message.ha_version : null;
          resolve(client);
          return;
        }
        if (message.type === "auth_invalid") {
          fail(new Error("Home Assistant rejected App authentication"));
          socket.close();
          return;
        }
        client.handleMessage(message);
      });

      socket.addEventListener("error", () => {
        fail(new Error("Home Assistant WebSocket transport failed"));
      });
      socket.addEventListener("close", () => {
        client.handleClose();
        if (!client.haVersion) {
          fail(new Error("Home Assistant WebSocket closed before authentication"));
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
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.success === true) {
      pending.resolve(message.result);
    } else {
      const code =
        typeof message.error?.code === "string" &&
        /^[A-Za-z0-9_.-]{1,80}$/u.test(message.error.code)
          ? message.error.code
          : "unknown_error";
      pending.reject(
        new HomeAssistantUnavailableError(
          `Home Assistant command ${pending.type} failed (${code})`,
        ),
      );
    }
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new HomeAssistantUnavailableError(
          `Home Assistant WebSocket closed during ${pending.type}`,
        ),
      );
    }
    this.pending.clear();
  }

  request(command) {
    if (this.closed) {
      return Promise.reject(
        new HomeAssistantUnavailableError("Home Assistant WebSocket is closed"),
      );
    }
    const id = this.nextId++;
    const type = typeof command.type === "string" ? command.type : "unknown";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HomeAssistantUnavailableError(`Home Assistant command ${type} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      this.socket.send(JSON.stringify({ id, ...command }));
    });
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}

function requireFixtureShape(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new HomeAssistantUnavailableError("Memory test fixture must be a JSON object");
  }
  if (fixture.error) {
    throw new HomeAssistantUnavailableError("Memory test fixture requested an API failure");
  }
  for (const key of ["areas", "devices", "entities", "states"]) {
    if (!Array.isArray(fixture[key])) {
      throw new HomeAssistantUnavailableError(
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
      "HA_MEMORY_TEST_FIXTURE is only accepted in explicit memory test mode",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new HomeAssistantUnavailableError(
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

  const configValid =
    configResult.status === "fulfilled" &&
    configResult.value &&
    typeof configResult.value === "object" &&
    !Array.isArray(configResult.value) &&
    configResult.value.config &&
    typeof configResult.value.config === "object" &&
    !Array.isArray(configResult.value.config);
  const relatedValid =
    relatedResult.status === "fulfilled" &&
    relatedResult.value &&
    typeof relatedResult.value === "object" &&
    !Array.isArray(relatedResult.value);

  return {
    entity_id: entityId,
    complete: Boolean(configValid && relatedValid),
    config: configValid ? configResult.value.config : null,
    related: relatedValid ? relatedResult.value : null,
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
  const url = options.url ?? process.env.HA_WS_URL ?? DEFAULT_WEBSOCKET_URL;
  const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
  const client = await HomeAssistantWebSocketClient.connect({
    url,
    token,
    timeoutMs,
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
          `Home Assistant ${key} response was not a list`,
        );
      }
    }

    const activeAutomationIds = automationEntityIds(states);
    const allAutomationIds = automationEntityIds([...entities, ...states]);
    const details = await fetchAutomationDetailsBounded(client, activeAutomationIds);
    if (details.some((detail) => !detail.complete)) {
      throw new HomeAssistantUnavailableError(
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
      warnings: [],
    };
  } catch (error) {
    if (error instanceof HomeAssistantUnavailableError) throw error;
    throw new HomeAssistantUnavailableError(
      `Home Assistant memory refresh failed: ${sanitizeProtocolError(error)}`,
    );
  } finally {
    client.close();
  }
}
