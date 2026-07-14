import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PLAYWRIGHT_CLI =
  "/usr/local/lib/codex-ha/playwright/node_modules/@playwright/mcp/cli.js";
const PLAYWRIGHT_CONFIG =
  "/usr/local/share/codex-ha/playwright-mcp.json";
const HOME_ASSISTANT_BROWSER_TOKEN =
  "/run/codex-ha/home-assistant-browser.token";
const REDACTED_BROWSER_TOKEN = "[REDACTED_HOME_ASSISTANT_TOKEN]";
const HOME_ASSISTANT_NAVIGATION_GUIDANCE =
  "For Home Assistant dashboards, use this image-managed Playwright MCP directly and navigate first to http://127.0.0.1:8099/. Do not first invoke or install another browser skill, and do not substitute localhost:8123 or an external Home Assistant URL.";

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
const childEnvironment = {
  HOME: "/run/codex-ha/playwright-home",
  LANG: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/tmp",
};
let browserToken = "";
if (process.env.CODEX_HA_BROWSER_TOKEN_VALIDATED === "1") {
  try {
    const token = readFileSync(HOME_ASSISTANT_BROWSER_TOKEN, "utf8");
    if (!/^[A-Za-z0-9._~-]{20,}$/u.test(token)) {
      throw new Error("Home Assistant browser token file is invalid");
    }
    browserToken = token;
    childEnvironment.HA_BROWSER_TOKEN = token;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const child = spawn(process.execPath, childArgs, {
  env: childEnvironment,
  stdio: ["pipe", "pipe", "pipe"],
});
const pendingToolLists = new Set();

function idKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function redactExactSecret(value) {
  if (!browserToken) return value;
  return value.split(browserToken).join(REDACTED_BROWSER_TOKEN);
}

function writeJson(stream, message, redact = false) {
  const serialized = JSON.stringify(message);
  stream.write(`${redact ? redactExactSecret(serialized) : serialized}\n`);
}

function rejectCall(message, code, reason) {
  if (!("id" in message)) return;
  writeJson(process.stdout, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: reason },
  });
}

function addImageManagedGuidance(tool) {
  if (tool.name !== "browser_navigate") return tool;
  const upstreamDescription =
    typeof tool.description === "string" ? tool.description : "";
  return {
    ...tool,
    description: `${HOME_ASSISTANT_NAVIGATION_GUIDANCE}\n\n${upstreamDescription}`.trim(),
  };
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
      message.result.tools = message.result.tools
        .filter((tool) => ALLOWED_TOOLS.has(tool.name))
        .map(addImageManagedGuidance);
    }
  }

  writeJson(process.stdout, message, true);
});

const childErrors = createInterface({ input: child.stderr, crlfDelay: Infinity });
childErrors.on("line", (line) => {
  process.stderr.write(`${redactExactSecret(line)}\n`);
});
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
