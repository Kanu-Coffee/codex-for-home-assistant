import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

const installedModule =
  "file:///usr/local/share/codex-ha/ha-memory-ha-client.mjs";
const sourceModule = new URL(
  "../codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-memory-ha-client.mjs",
  import.meta.url,
).href;
const NO_RESPONSE = Symbol("NO_RESPONSE");
const RAW_RESPONSE = Symbol("RAW_RESPONSE");

class FakeWebSocket {
  static commandHandler = () => ({ success: true, result: [] });
  static connectHandler = (socket) => socket.emit("message", {
    data: JSON.stringify({ type: "auth_required" }),
  });
  static authHandler = (socket) => socket.emit("message", {
    data: JSON.stringify({ type: "auth_ok", ha_version: "test" }),
  });
  static lastInstance = null;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.lastInstance = this;
    queueMicrotask(() => FakeWebSocket.connectHandler(this));
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }

  send(payload) {
    const message = JSON.parse(payload);
    if (message.type === "auth") {
      queueMicrotask(() => FakeWebSocket.authHandler(this, message));
      return;
    }
    const response = FakeWebSocket.commandHandler(message);
    if (response === NO_RESPONSE) return;
    if (response && Object.hasOwn(response, RAW_RESPONSE)) {
      queueMicrotask(() => this.emit("message", {
        data: response[RAW_RESPONSE],
      }));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ id: message.id, type: "result", ...response }),
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

const {
  fetchHomeAssistantSnapshot,
  HomeAssistantUnavailableError,
} = await import(
  process.env.HA_MEMORY_INSTALLED_TEST === "1" ? installedModule : sourceModule
);

function resetFakeWebSocket() {
  FakeWebSocket.commandHandler = () => ({ success: true, result: [] });
  FakeWebSocket.connectHandler = (socket) => socket.emit("message", {
    data: JSON.stringify({ type: "auth_required" }),
  });
  FakeWebSocket.authHandler = (socket) => socket.emit("message", {
    data: JSON.stringify({ type: "auth_ok", ha_version: "test" }),
  });
  FakeWebSocket.lastInstance = null;
}

function fetchWithFake(options = {}) {
  return fetchHomeAssistantSnapshot({
    token: "test-token",
    timeoutMs: 1_000,
    webSocketFactory: (url, socketOptions) =>
      new FakeWebSocket(url, socketOptions),
    ...options,
  });
}

function baseResponse(command) {
  if (command.type === "config/area_registry/list") return [];
  if (command.type === "config/device_registry/list") return [];
  if (command.type === "config/entity_registry/list") {
    return [
      { entity_id: "automation.partial" },
      {
        entity_id: "automation.disabled",
        disabled_by: "user",
        name: "Disabled registry-only automation",
      },
    ];
  }
  if (command.type === "get_states") {
    return [{
      entity_id: "automation.partial",
      state: "on",
      attributes: { friendly_name: "Partial fixture" },
    }];
  }
  if (command.type === "search/related") {
    assert.equal(command.item_type, "automation");
    assert.equal(command.item_id, "automation.partial");
    return {};
  }
  return null;
}

test("automation detail failures reject the complete snapshot", async () => {
  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return {
        success: false,
        error: { code: "automation_config_failed", message: "fixture secret" },
      };
    }
    return { success: true, result: baseResponse(command) };
  };

  await assert.rejects(
    fetchWithFake(),
    (error) =>
      error instanceof HomeAssistantUnavailableError &&
      error.code === "ha_command_automation_config_failed" &&
      /incomplete automation detail snapshot/u.test(error.message) &&
      !/fixture secret/u.test(error.message),
  );
});

test("a complete automation detail snapshot is returned", async () => {
  resetFakeWebSocket();
  const configuredEntityIds = [];
  FakeWebSocket.commandHandler = (command) => {
    const base = baseResponse(command);
    if (command.type === "automation/config") {
      configuredEntityIds.push(command.entity_id);
      return {
        success: true,
        result: {
          config: {
            id: command.entity_id.replace(/^automation\./u, ""),
            alias: `${command.entity_id} fixture`,
          },
        },
      };
    }
    return { success: true, result: base };
  };

  const snapshot = await fetchWithFake();
  assert.equal(snapshot.automations["automation.partial"].config.id, "partial");
  assert.deepEqual(
    snapshot.automations["automation.disabled"],
    { config: {}, related: {} },
    "registry-only disabled automations must be retained without pretending they are loaded",
  );
  assert.deepEqual(Object.keys(snapshot.automations), [
    "automation.partial",
    "automation.disabled",
  ]);
  assert.deepEqual(
    configuredEntityIds,
    ["automation.partial"],
    "registry-only automations are not loaded entities and must not require automation/config",
  );
  assert.deepEqual(snapshot.warnings, []);
});

test("an unavailable automation with an explicit null config remains indexable", async () => {
  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: null } };
    }
    return { success: true, result: baseResponse(command) };
  };

  const snapshot = await fetchWithFake();
  assert.deepEqual(snapshot.automations["automation.partial"], {
    config: {},
    related: {},
  });
  assert.deepEqual(snapshot.warnings, [
    "automation_config_unavailable:automation.partial",
  ]);
});

test("an observed related unknown_error preserves config-derived automation data", async () => {
  resetFakeWebSocket();
  const relatedRequests = [];
  const remoteSecret = "REMOTE_RELATED_SECRET_7f21";
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return {
        success: true,
        result: {
          config: {
            id: "partial",
            alias: "Partial fixture",
            trigger: { platform: "state", entity_id: "sensor.fixture" },
            action: {
              target: {
                area_id: "fixture_area",
                device_id: "fixture_device",
                entity_id: "light.fixture",
              },
            },
          },
        },
      };
    }
    if (command.type === "search/related") {
      relatedRequests.push(command);
      return {
        success: false,
        error: { code: "unknown_error", message: remoteSecret },
      };
    }
    return { success: true, result: baseResponse(command) };
  };

  const snapshot = await fetchWithFake();
  assert.deepEqual(relatedRequests.map(({ type, item_type, item_id }) => ({
    type,
    item_type,
    item_id,
  })), [{
    type: "search/related",
    item_type: "automation",
    item_id: "automation.partial",
  }]);
  assert.equal(snapshot.automations["automation.partial"].config.id, "partial");
  assert.deepEqual(snapshot.automations["automation.partial"].related, {});
  assert.deepEqual(snapshot.warnings, [
    "automation_related_unavailable:automation.partial",
  ]);
  assert.equal(JSON.stringify(snapshot).includes(remoteSecret), false);
});

test("related timeout and malformed results still reject the complete snapshot", async () => {
  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: {} } };
    }
    if (command.type === "search/related") return NO_RESPONSE;
    return { success: true, result: baseResponse(command) };
  };
  await assert.rejects(
    fetchWithFake({ timeoutMs: 10 }),
    (error) => error.code === "ha_command_related_failed",
  );

  for (const remoteCode of [
    "timeout",
    "unauthorized",
    "invalid_format",
    "home_assistant_error",
  ]) {
    resetFakeWebSocket();
    FakeWebSocket.commandHandler = (command) => {
      if (command.type === "automation/config") {
        return { success: true, result: { config: {} } };
      }
      if (command.type === "search/related") {
        return {
          success: false,
          error: { code: remoteCode, message: "private remote failure" },
        };
      }
      return { success: true, result: baseResponse(command) };
    };
    await assert.rejects(
      fetchWithFake(),
      (error) => error.code === "ha_command_related_failed",
    );
  }

  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: {} } };
    }
    if (command.type === "search/related") {
      return { success: "false", error: { code: "unknown_error" } };
    }
    return { success: true, result: baseResponse(command) };
  };
  await assert.rejects(
    fetchWithFake(),
    (error) => error.code === "ha_protocol_error",
  );

  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: {} } };
    }
    if (command.type === "search/related") {
      return { success: false, error: null };
    }
    return { success: true, result: baseResponse(command) };
  };
  await assert.rejects(
    fetchWithFake(),
    (error) => error.code === "ha_protocol_error",
  );

  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: {} } };
    }
    if (command.type === "search/related") {
      return { success: true, result: [] };
    }
    return { success: true, result: baseResponse(command) };
  };
  await assert.rejects(
    fetchWithFake(),
    (error) => error.code === "ha_snapshot_incomplete",
  );
});

test("null config and related unknown_error retain both bounded warnings", async () => {
  resetFakeWebSocket();
  FakeWebSocket.commandHandler = (command) => {
    if (command.type === "automation/config") {
      return { success: true, result: { config: null } };
    }
    if (command.type === "search/related") {
      return { success: false, error: { code: "unknown_error" } };
    }
    return { success: true, result: baseResponse(command) };
  };

  const snapshot = await fetchWithFake();
  assert.deepEqual(snapshot.automations["automation.partial"], {
    config: {},
    related: {},
  });
  assert.deepEqual(snapshot.warnings, [
    "automation_config_unavailable:automation.partial",
    "automation_related_unavailable:automation.partial",
  ]);
});

test("connection failures expose only bounded diagnostic codes", async () => {
  resetFakeWebSocket();
  await assert.rejects(
    fetchWithFake({ token: "" }),
    (error) =>
      error instanceof HomeAssistantUnavailableError &&
      error.code === "ha_token_unavailable",
  );

  const secret = "super-secret-token-value";
  FakeWebSocket.authHandler = (socket) => socket.emit("message", {
    data: JSON.stringify({
      type: "auth_invalid",
      message: `rejected ${secret}`,
    }),
  });
  await assert.rejects(
    fetchWithFake({ token: secret }),
    (error) =>
      error.code === "ha_auth_rejected" &&
      !error.message.includes(secret) &&
      error.message === "Home Assistant rejected App authentication",
  );

  resetFakeWebSocket();
  FakeWebSocket.connectHandler = (socket) => socket.emit("error", {
    error: { code: "ENOTFOUND", message: `lookup ${secret}` },
  });
  await assert.rejects(
    fetchWithFake({ token: secret }),
    (error) =>
      error.code === "ha_dns_failed" && !error.message.includes(secret),
  );

  resetFakeWebSocket();
  FakeWebSocket.connectHandler = (socket) => socket.emit("message", {
    data: "{invalid-json",
  });
  await assert.rejects(
    fetchWithFake(),
    (error) => error.code === "ha_protocol_error",
  );

  resetFakeWebSocket();
  FakeWebSocket.connectHandler = (socket) => socket.emit("message", {
    data: "null",
  });
  await assert.rejects(
    fetchWithFake(),
    (error) => error.code === "ha_protocol_error",
  );

  resetFakeWebSocket();
  FakeWebSocket.connectHandler = () => {};
  await assert.rejects(
    fetchWithFake({ timeoutMs: 10 }),
    (error) => error.code === "ha_timeout",
  );
});

test("closing after a parallel command failure clears every pending timer", async () => {
  resetFakeWebSocket();
  const timeoutCount = () => process.getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
  const before = timeoutCount();
  FakeWebSocket.commandHandler = (command) =>
    command.type === "config/area_registry/list"
      ? {
          success: false,
          error: { code: "fixture_failure" },
        }
      : NO_RESPONSE;

  await assert.rejects(
    fetchWithFake({ timeoutMs: 1_000 }),
    (error) => error.code === "ha_command_areas_failed",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutCount(), before);
});

test("a malformed command frame preserves the protocol reason and clears peers", async () => {
  resetFakeWebSocket();
  const timeoutCount = () => process.getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
  const before = timeoutCount();
  FakeWebSocket.commandHandler = (command) =>
    command.type === "config/area_registry/list"
      ? { [RAW_RESPONSE]: "null" }
      : NO_RESPONSE;

  await assert.rejects(
    fetchWithFake({ timeoutMs: 1_000 }),
    (error) => error.code === "ha_protocol_error",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutCount(), before);
});

test("the production endpoint cannot be redirected through HA_WS_URL", async () => {
  resetFakeWebSocket();
  const previous = process.env.HA_WS_URL;
  const previousToken = process.env.SUPERVISOR_TOKEN;
  process.env.HA_WS_URL = "ws://attacker.invalid/collect";
  process.env.SUPERVISOR_TOKEN = "environment-supervisor-secret";
  try {
    await fetchWithFake();
    assert.equal(
      FakeWebSocket.lastInstance.url,
      "ws://supervisor/core/websocket",
    );
    assert.deepEqual(FakeWebSocket.lastInstance.options, {
      timeoutMs: 1_000,
      maxMessageBytes: 32 * 1024 * 1024,
    });
    await assert.rejects(
      fetchHomeAssistantSnapshot({
        url: "ws://attacker.invalid/collect",
        timeoutMs: 1_000,
        webSocketFactory: () => {
          throw new Error("must not connect");
        },
      }),
      (error) => error.code === "ha_token_unavailable",
    );
  } finally {
    if (previous === undefined) delete process.env.HA_WS_URL;
    else process.env.HA_WS_URL = previous;
    if (previousToken === undefined) delete process.env.SUPERVISOR_TOKEN;
    else process.env.SUPERVISOR_TOKEN = previousToken;
  }
});

if (process.env.HA_MEMORY_INSTALLED_TEST === "1") {
  test("the installed ws transport completes a Supervisor-style snapshot", async (t) => {
    const { WebSocketServer } = await import(
      "/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs"
    );
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/core/websocket",
      perMessageDeflate: false,
    });
    t.after(async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    });

    let authenticatedToken = null;
    const relatedRequests = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "auth_required",
        ha_version: "2026.7.2-test",
      }));
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "auth") {
          authenticatedToken = message.access_token;
          socket.send(JSON.stringify({
            type: "auth_ok",
            ha_version: "2026.7.2-test",
          }));
          return;
        }
        let result;
        let response;
        if (message.type === "config/area_registry/list") result = [];
        else if (message.type === "config/device_registry/list") result = [];
        else if (message.type === "config/entity_registry/list") {
          result = [
            { entity_id: "automation.unavailable" },
            { entity_id: "automation.related_failure" },
          ];
        } else if (message.type === "get_states") {
          result = [
            {
              entity_id: "automation.unavailable",
              state: "unavailable",
              attributes: { friendly_name: "Unavailable fixture" },
            },
            {
              entity_id: "automation.related_failure",
              state: "on",
              attributes: { friendly_name: "Related failure fixture" },
            },
          ];
        } else if (message.type === "automation/config") {
          result = message.entity_id === "automation.unavailable"
            ? { config: null }
            : { config: { alias: "Related failure fixture" } };
        } else if (message.type === "search/related") {
          relatedRequests.push({
            item_type: message.item_type,
            item_id: message.item_id,
          });
          if (message.item_id === "automation.related_failure") {
            response = {
              success: false,
              error: {
                code: "unknown_error",
                message: "installed remote response must stay private",
              },
            };
          } else {
            result = {};
          }
        } else throw new Error(`Unexpected fixture command: ${message.type}`);
        response ??= { success: true, result };
        socket.send(JSON.stringify({
          id: message.id,
          type: "result",
          ...response,
        }));
      });
    });
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");

    const snapshot = await fetchHomeAssistantSnapshot({
      url: `ws://127.0.0.1:${address.port}/core/websocket`,
      token: "installed-test-token",
      timeoutMs: 2_000,
    });
    assert.equal(authenticatedToken, "installed-test-token");
    assert.equal(snapshot.haVersion, "2026.7.2-test");
    assert.deepEqual(snapshot.automations["automation.unavailable"], {
      config: {},
      related: {},
    });
    assert.deepEqual(snapshot.automations["automation.related_failure"], {
      config: { alias: "Related failure fixture" },
      related: {},
    });
    assert.deepEqual(relatedRequests.sort((left, right) =>
      left.item_id.localeCompare(right.item_id)), [
      {
        item_type: "automation",
        item_id: "automation.related_failure",
      },
      {
        item_type: "automation",
        item_id: "automation.unavailable",
      },
    ]);
    assert.deepEqual(snapshot.warnings, [
      "automation_related_unavailable:automation.related_failure",
      "automation_config_unavailable:automation.unavailable",
    ]);
  });
}
