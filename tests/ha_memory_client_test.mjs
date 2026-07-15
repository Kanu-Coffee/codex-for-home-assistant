import assert from "node:assert/strict";
import test from "node:test";

const installedModule =
  "file:///usr/local/share/codex-ha/ha-memory-ha-client.mjs";
const sourceModule = new URL(
  "../codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-memory-ha-client.mjs",
  import.meta.url,
).href;

class FakeWebSocket {
  static commandHandler = () => ({ success: true, result: [] });

  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ type: "auth_required" }),
    }));
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
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ type: "auth_ok", ha_version: "test" }),
      }));
      return;
    }
    const response = FakeWebSocket.commandHandler(message);
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ id: message.id, type: "result", ...response }),
    }));
  }

  close() {
    queueMicrotask(() => this.emit("close"));
  }
}

globalThis.WebSocket = FakeWebSocket;
const {
  fetchHomeAssistantSnapshot,
  HomeAssistantUnavailableError,
} = await import(
  process.env.HA_MEMORY_INSTALLED_TEST === "1" ? installedModule : sourceModule
);

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
  if (command.type === "search/related") return {};
  return null;
}

test("automation detail failures reject the complete snapshot", async () => {
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
    fetchHomeAssistantSnapshot({ token: "test-token", timeoutMs: 1_000 }),
    (error) =>
      error instanceof HomeAssistantUnavailableError &&
      /incomplete automation detail snapshot/u.test(error.message) &&
      !/fixture secret/u.test(error.message),
  );
});

test("a complete automation detail snapshot is returned", async () => {
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

  const snapshot = await fetchHomeAssistantSnapshot({
    token: "test-token",
    timeoutMs: 1_000,
  });
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
