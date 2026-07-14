import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createInterface } from "node:readline";

const PLAYWRIGHT_CLI =
  "/usr/local/lib/codex-ha/playwright/node_modules/@playwright/mcp/cli.js";
const PLAYWRIGHT_CONFIG =
  "/usr/local/share/codex-ha/playwright-mcp.json";
const PLAYWRIGHT_SECRETS = "/run/codex-ha/playwright-secrets.env";

// Keep the raw MCP surface as narrow as the Codex system configuration. This
// proxy is the enforcement point even when the wrapper is invoked directly.
const ALLOWED_TOOLS = new Set([
  "browser_close",
  "browser_console_messages",
  "browser_click",
  "browser_fill_form",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_press_key",
  "browser_resize",
  "browser_select_option",
  "browser_snapshot",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_type",
  "browser_wait_for",
]);

const childArgs = [PLAYWRIGHT_CLI, "--config", PLAYWRIGHT_CONFIG];
try {
  if (statSync(PLAYWRIGHT_SECRETS).size > 0) {
    childArgs.push("--secrets", PLAYWRIGHT_SECRETS);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const child = spawn(process.execPath, childArgs, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const pendingToolLists = new Set();

function idKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function writeJson(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function rejectCall(message, code, reason) {
  if (!("id" in message)) return;
  writeJson(process.stdout, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: reason },
  });
}

const clientLines = createInterface({ input: process.stdin });
clientLines.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeJson(process.stdout, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON-RPC input" },
    });
    return;
  }

  if (message.method === "tools/list" && "id" in message) {
    pendingToolLists.add(idKey(message.id));
  }

  if (message.method === "tools/call") {
    const toolName = message.params?.name;
    const toolArgs = message.params?.arguments;
    if (!ALLOWED_TOOLS.has(toolName)) {
      rejectCall(message, -32601, `Playwright tool is not enabled: ${toolName}`);
      return;
    }
    if (
      toolArgs &&
      typeof toolArgs === "object" &&
      Object.prototype.hasOwnProperty.call(toolArgs, "filename")
    ) {
      rejectCall(
        message,
        -32602,
        "filename is disabled; Playwright artifacts stay in the private runtime directory",
      );
      return;
    }
  }

  writeJson(child.stdin, message);
});

const serverLines = createInterface({ input: child.stdout });
serverLines.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("Playwright MCP emitted invalid JSON-RPC output\n");
    child.kill("SIGTERM");
    process.exitCode = 1;
    return;
  }

  if ("id" in message) {
    const key = idKey(message.id);
    if (pendingToolLists.delete(key) && Array.isArray(message.result?.tools)) {
      message.result.tools = message.result.tools.filter((tool) =>
        ALLOWED_TOOLS.has(tool.name),
      );
    }
  }

  writeJson(process.stdout, message);
});

child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`Unable to start Playwright MCP: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`Playwright MCP stopped by ${signal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

process.stdin.on("end", () => child.stdin.end());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
