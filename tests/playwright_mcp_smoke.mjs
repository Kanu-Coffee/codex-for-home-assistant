import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CONSOLE_MARKER = "PLAYWRIGHT_MCP_SMOKE_CONSOLE_ERROR";
const PAGE_ERROR_MARKER = "PLAYWRIGHT_MCP_SMOKE_UNCAUGHT_PAGE_ERROR";
const PAGE_MARKER = "Playwright MCP browser smoke";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const EXTRA_URL = process.env.PLAYWRIGHT_MCP_SMOKE_URL;
const EXTRA_EXPECT = process.env.PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT;
const EXTRA_EXPECT_SOURCE_IP =
  process.env.PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP;
const EXTRA_EXPECT_UNAUTHENTICATED =
  process.env.PLAYWRIGHT_MCP_SMOKE_EXPECT_UNAUTHENTICATED === "1";
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_MCP_SMOKE_SCREENSHOT_DIR;
const CHILD_ENV_OVERRIDES = JSON.parse(
  process.env.PLAYWRIGHT_MCP_SMOKE_CHILD_ENV ?? "{}",
);
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${PAGE_MARKER}</title>
    <link rel="stylesheet" href="/redirect.css">
  </head>
  <body>
    <main>
      <h1>${PAGE_MARKER}</h1>
      <p id="viewport" aria-live="polite"></p>
      <img src="/pixel.png" alt="loaded fixture asset">
      <img src="/missing.png" alt="intentionally missing fixture asset">
      <img src="/server-error.png" alt="intentionally failing fixture asset">
    </main>
    <script src="/fixture.js"></script>
  </body>
</html>`;
}

function fixtureScript() {
  return `(() => {
  const renderViewport = () => {
    document.querySelector('#viewport').textContent =
      'viewport:' + window.innerWidth + 'x' + window.innerHeight;
  };
  window.addEventListener('resize', renderViewport);
  renderViewport();
  console.error('${CONSOLE_MARKER}');
  fetch('/transport-failure').catch(() => {});
  setTimeout(() => {
    throw new Error('${PAGE_ERROR_MARKER}');
  }, 0);
})();`;
}

async function startFixtureServer() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    response.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixtureHtml());
      return;
    }
    if (url.pathname === "/asset-ok.css") {
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      response.end(
        "body{margin:0;background:#f4f7fb;color:#172033}" +
          "main{padding:24px}@media(max-width:600px){main{padding:8px}}",
      );
      return;
    }
    if (url.pathname === "/redirect.css") {
      response.writeHead(302, { Location: "/asset-ok.css" });
      response.end();
      return;
    }
    if (url.pathname === "/fixture.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(fixtureScript());
      return;
    }
    if (url.pathname === "/pixel.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PIXEL_PNG);
      return;
    }
    if (url.pathname === "/server-error.png") {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("intentional fixture 500");
      return;
    }
    if (url.pathname === "/transport-failure") {
      response.destroy();
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("intentional fixture 404");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    requests,
    server,
    url: `http://127.0.0.1:${address.port}/index.html`,
  };
}

function resultText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function assertToolResult(result, toolName) {
  assert(result && typeof result === "object", `${toolName} returned no result`);
  assert.equal(
    result.isError,
    undefined,
    `${toolName} returned an MCP tool error: ${resultText(result)}`,
  );
  assert(Array.isArray(result.content), `${toolName} returned no content array`);
  return result;
}

function toolProperties(tool) {
  return tool.inputSchema?.properties ?? {};
}

function chooseTool(tools, preferredName, requiredWords, excludedWords = []) {
  const exact = tools.find((tool) => tool.name === preferredName);
  if (exact) return exact;

  const candidates = tools.filter((tool) => {
    const haystack = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
    return (
      requiredWords.every((word) => haystack.includes(word)) &&
      excludedWords.every((word) => !haystack.includes(word))
    );
  });
  assert.equal(
    candidates.length,
    1,
    `Expected exactly one ${preferredName} tool, found: ${candidates
      .map((tool) => tool.name)
      .join(", ")}`,
  );
  return candidates[0];
}

function screenshotArguments(tool) {
  const properties = toolProperties(tool);
  const args = {};
  if (properties.type) args.type = "png";
  if (properties.fullPage) args.fullPage = false;
  return args;
}

function consoleArguments(tool) {
  const properties = toolProperties(tool);
  const args = {};
  if (properties.level) args.level = "debug";
  if (properties.all) args.all = true;
  return args;
}

function networkArguments(tool) {
  const properties = toolProperties(tool);
  if (properties.includeStatic) return { includeStatic: true };
  if (properties.static) return { static: true };
  return {};
}

function screenshotPngBuffer(result, label) {
  const image = (result.content ?? []).find(
    (item) => item.type === "image" && typeof item.data === "string",
  );
  assert(image, `${label} did not return an MCP image content item`);
  assert.equal(image.mimeType, "image/png", `${label} did not return PNG`);
  const data = Buffer.from(image.data, "base64");
  assert(data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  assert(data.length >= 24, `${label} PNG is truncated`);
  return data;
}

function screenshotPng(result, label) {
  const data = screenshotPngBuffer(result, label);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

async function saveScreenshot(result, filename, label) {
  if (!SCREENSHOT_DIR) return null;
  await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  const outputPath = resolve(SCREENSHOT_DIR, filename);
  await writeFile(outputPath, screenshotPngBuffer(result, label), { mode: 0o600 });
  return outputPath;
}

class StdioMcpClient {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.transcript = [];
    this.child = null;
  }

  async start() {
    assert(
      CHILD_ENV_OVERRIDES &&
        typeof CHILD_ENV_OVERRIDES === "object" &&
        !Array.isArray(CHILD_ENV_OVERRIDES) &&
        Object.values(CHILD_ENV_OVERRIDES).every(
          (value) => typeof value === "string",
        ),
      "PLAYWRIGHT_MCP_SMOKE_CHILD_ENV must contain string environment values",
    );
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...CHILD_ENV_OVERRIDES },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      const token = process.env.SUPERVISOR_TOKEN;
      assert(!token || !chunk.includes(token), "MCP stderr disclosed SUPERVISOR_TOKEN");
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.pending.size) {
        this.rejectAll(
          new Error(
            `MCP server exited early (code=${code}, signal=${signal})\n${this.stderr}`,
          ),
        );
      }
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    const initialized = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-ha-playwright-smoke", version: "1.0.0" },
    });
    assert.equal(initialized.serverInfo?.name?.length > 0, true);
    assert.equal(typeof initialized.protocolVersion, "string");
    this.notify("notifications/initialized", {});
    return initialized;
  }

  handleLine(line) {
    if (!line.trim()) return;
    const token = process.env.SUPERVISOR_TOKEN;
    assert(!token || !line.includes(token), "MCP stdout disclosed SUPERVISOR_TOKEN");

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.rejectAll(new Error(`Invalid MCP JSON line: ${line}`, { cause: error }));
      return;
    }
    this.transcript.push(message);

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `MCP request ${pending.method} failed: ${JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && typeof message.method === "string") {
      this.handleServerRequest(message);
    }
  }

  handleServerRequest(message) {
    if (message.method === "ping") {
      this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method === "roots/list") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(process.cwd()).href,
              name: "codex-ha-smoke-workspace",
            },
          ],
        },
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported client method: ${message.method}` },
    });
  }

  write(message) {
    assert(this.child?.stdin.writable, "MCP stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out after ${timeoutMs}ms: ${method}\n${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  callTool(tool, args = {}) {
    return this.request("tools/call", { name: tool.name, arguments: args });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(closeTool) {
    if (!this.child) return;
    if (closeTool && this.child.exitCode === null) {
      try {
        await this.callTool(closeTool, {});
      } catch {
        // Process shutdown below still guarantees cleanup.
      }
    }
    if (this.child.exitCode !== null) return;

    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)]);
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await Promise.race([exited, delay(1_000)]);
    }
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

async function main() {
  const commandLine = process.argv.slice(2);
  if (!commandLine.length && process.env.PLAYWRIGHT_MCP_SMOKE_COMMAND) {
    commandLine.push(process.env.PLAYWRIGHT_MCP_SMOKE_COMMAND);
  }
  if (!commandLine.length) {
    throw new Error(
      `Usage: ${process.argv[1]} <playwright-mcp-command> [args ...]`,
    );
  }
  const [command, ...args] = commandLine;
  const fixture = await startFixtureServer();
  const client = new StdioMcpClient(command, args);
  let closeTool;

  try {
    const initialized = await client.start();
    const listed = await client.request("tools/list", {});
    assert(Array.isArray(listed.tools), "tools/list returned no tools array");
    const listedNames = new Set(listed.tools.map((tool) => tool.name));
    const navigateDescription = listed.tools.find(
      (tool) => tool.name === "browser_navigate",
    )?.description;
    assert(
      navigateDescription?.includes("http://127.0.0.1:8099/"),
      "browser_navigate did not advertise the canonical Home Assistant gateway",
    );
    for (const forbiddenTool of [
      "browser_evaluate",
      "browser_file_upload",
      "browser_network_request",
      "browser_pdf_save",
      "browser_run_code",
    ]) {
      assert(
        !listedNames.has(forbiddenTool),
        `restricted MCP surface exposed ${forbiddenTool}`,
      );
    }

    const navigate = chooseTool(
      listed.tools,
      "browser_navigate",
      ["navigate", "url"],
      ["back", "forward"],
    );
    const resize = chooseTool(listed.tools, "browser_resize", ["resize"]);
    const screenshot = chooseTool(listed.tools, "browser_take_screenshot", [
      "screenshot",
    ]);
    const snapshot = chooseTool(listed.tools, "browser_snapshot", ["snapshot"]);
    const consoleMessages = chooseTool(
      listed.tools,
      "browser_console_messages",
      ["console", "message"],
    );
    const networkRequests = chooseTool(
      listed.tools,
      "browser_network_requests",
      ["network", "request"],
      ["detail", "single"],
    );
    closeTool = listed.tools.find((tool) => tool.name === "browser_close");

    await assert.rejects(
      client.callTool({ name: "browser_evaluate" }, { function: "() => 1" }),
      /not enabled: browser_evaluate/,
    );
    const escapedScreenshot =
      `/config/playwright-mcp-filename-${process.pid}.png`;
    await assert.rejects(
      client.callTool(screenshot, { filename: escapedScreenshot }),
      /filename is disabled/,
    );
    assert(
      !existsSync(escapedScreenshot),
      "filename restriction still wrote a persistent artifact",
    );

    const navigation = assertToolResult(
      await client.callTool(navigate, { url: fixture.url }),
      navigate.name,
    );
    assert(
      resultText(navigation).includes(PAGE_MARKER),
      "navigation result did not identify the fixture page",
    );

    const desktopResize = assertToolResult(
      await client.callTool(resize, DESKTOP),
      `${resize.name} desktop`,
    );
    const desktopSnapshot = assertToolResult(
      await client.callTool(snapshot, {}),
      `${snapshot.name} desktop`,
    );
    const desktopShot = assertToolResult(
      await client.callTool(screenshot, screenshotArguments(screenshot)),
      `${screenshot.name} desktop`,
    );
    const desktopPng = screenshotPng(desktopShot, "desktop screenshot");
    assert(
      (resultText(desktopResize) + resultText(desktopSnapshot)).includes(
        `viewport:${DESKTOP.width}x${DESKTOP.height}`,
      ),
      "desktop resize produced no exact DOM viewport evidence",
    );
    assert(desktopPng.width >= 1200 && desktopPng.height >= 750);
    assert(
      Math.abs(desktopPng.width / desktopPng.height - DESKTOP.width / DESKTOP.height) <
        0.01,
      "desktop screenshot aspect ratio changed unexpectedly",
    );

    const mobileResize = assertToolResult(
      await client.callTool(resize, MOBILE),
      `${resize.name} mobile`,
    );
    const mobileSnapshot = assertToolResult(
      await client.callTool(snapshot, {}),
      `${snapshot.name} mobile`,
    );
    const mobileShot = assertToolResult(
      await client.callTool(screenshot, screenshotArguments(screenshot)),
      `${screenshot.name} mobile`,
    );
    assert.deepEqual(screenshotPng(mobileShot, "mobile screenshot"), MOBILE);
    const resizeEvidence =
      resultText(mobileResize) +
      resultText(mobileSnapshot) +
      resultText(mobileShot);
    assert(
      resizeEvidence.includes(`viewport:${MOBILE.width}x${MOBILE.height}`) ||
        screenshotPng(mobileShot, "mobile screenshot").width === MOBILE.width,
      "mobile resize produced no observable viewport evidence",
    );

    const consoleResult = assertToolResult(
      await client.callTool(consoleMessages, consoleArguments(consoleMessages)),
      consoleMessages.name,
    );
    assert(
      resultText(consoleResult).includes(CONSOLE_MARKER),
      "console tool did not return the fixture console error",
    );
    assert(
      resultText(consoleResult).includes(PAGE_ERROR_MARKER),
      "console tool did not return the uncaught page error",
    );

    const networkResult = assertToolResult(
      await client.callTool(networkRequests, networkArguments(networkRequests)),
      networkRequests.name,
    );
    const networkText = resultText(networkResult);
    for (const expected of [
      "/redirect.css",
      "/asset-ok.css",
      "/pixel.png",
      "/missing.png",
      "/server-error.png",
      "/transport-failure",
    ]) {
      assert(networkText.includes(expected), `network result omitted ${expected}`);
    }
    for (const status of [200, 302, 404, 500]) {
      assert(
        networkText.includes(String(status)),
        `network result omitted HTTP ${status}`,
      );
    }
    assert(
      /(?:\bfailed\b|net::err_)/i.test(networkText),
      "network result omitted the transport failure state",
    );
    for (const expectedRequest of [
      "/missing.png",
      "/server-error.png",
      "/transport-failure",
    ]) {
      assert(
        fixture.requests.includes(expectedRequest),
        `fixture did not receive ${expectedRequest}`,
      );
    }

    let extraNavigation = null;
    if (EXTRA_URL) {
      assert(EXTRA_EXPECT, "PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT is required with a URL");
      const extraResult = assertToolResult(
        await client.callTool(navigate, { url: EXTRA_URL }),
        `${navigate.name} extra target`,
      );
      const extraDesktopResize = assertToolResult(
        await client.callTool(resize, DESKTOP),
        `${resize.name} extra target desktop`,
      );
      const extraDesktopSnapshot = assertToolResult(
        await client.callTool(snapshot, {}),
        `${snapshot.name} extra target desktop`,
      );
      const extraDesktopShot = assertToolResult(
        await client.callTool(screenshot, screenshotArguments(screenshot)),
        `${screenshot.name} extra target desktop`,
      );
      const extraDesktopPng = screenshotPng(
        extraDesktopShot,
        "extra target desktop screenshot",
      );
      assert(
        extraDesktopPng.width >= 1200 && extraDesktopPng.height >= 750,
        "extra target desktop screenshot was unexpectedly small",
      );

      const extraText =
        resultText(extraResult) +
        resultText(extraDesktopResize) +
        resultText(extraDesktopSnapshot) +
        resultText(extraDesktopShot);
      assert(
        extraText.includes(EXTRA_EXPECT),
        `extra navigation did not contain expected text: ${EXTRA_EXPECT}\n${extraText}`,
      );
      if (EXTRA_EXPECT_SOURCE_IP && !EXTRA_EXPECT_UNAUTHENTICATED) {
        assert(
          extraText.includes(`source-ip:${EXTRA_EXPECT_SOURCE_IP}`),
          `extra navigation did not prove browser source IP ${EXTRA_EXPECT_SOURCE_IP}`,
        );
      }

      const extraMobileResize = assertToolResult(
        await client.callTool(resize, MOBILE),
        `${resize.name} extra target mobile`,
      );
      const extraMobileSnapshot = assertToolResult(
        await client.callTool(snapshot, {}),
        `${snapshot.name} extra target mobile`,
      );
      const extraMobileShot = assertToolResult(
        await client.callTool(screenshot, screenshotArguments(screenshot)),
        `${screenshot.name} extra target mobile`,
      );
      const extraMobilePng = screenshotPng(
        extraMobileShot,
        "extra target mobile screenshot",
      );
      assert.deepEqual(extraMobilePng, MOBILE);
      const extraMobileText =
        resultText(extraMobileResize) +
        resultText(extraMobileSnapshot) +
        resultText(extraMobileShot);
      assert(
        extraMobileText.includes(EXTRA_EXPECT),
        "extra target mobile render lost the authenticated marker",
      );

      const extraConsoleResult = assertToolResult(
        await client.callTool(consoleMessages, consoleArguments(consoleMessages)),
        `${consoleMessages.name} extra target`,
      );
      const extraConsoleText = resultText(extraConsoleResult);
      if (EXTRA_EXPECT_UNAUTHENTICATED) {
        assert(
          extraConsoleText.includes("HA_BROWSER_GATEWAY_FAILED"),
          "extra target did not report the expected fail-closed login state",
        );
      } else {
        assert(
          !extraConsoleText.includes("HA_BROWSER_GATEWAY_FAILED"),
          `extra target reported an authentication console failure: ${extraConsoleText}`,
        );
      }

      const extraNetworkResult = assertToolResult(
        await client.callTool(networkRequests, networkArguments(networkRequests)),
        `${networkRequests.name} extra target`,
      );
      const extraNetworkText = resultText(extraNetworkResult);
      const extraOrigin = new URL(EXTRA_URL).origin;
      assert(
        extraNetworkText.includes(extraOrigin),
        `extra target network evidence omitted the document: ${extraNetworkText}`,
      );
      if (EXTRA_EXPECT_UNAUTHENTICATED) {
        assert(
          !extraNetworkText.includes(`${extraOrigin}/api/config`),
          "an inherited environment token reached the fail-closed Core API path",
        );
      } else {
        assert(
          extraNetworkText.includes("/api/config"),
          `extra target network evidence omitted the Core API: ${extraNetworkText}`,
        );
        assert(
          !extraNetworkText.includes(`${extraOrigin}/api/config => [401]`),
          "extra target Core API returned HTTP 401",
        );
      }

      const screenshots = {
        desktop: await saveScreenshot(
          extraDesktopShot,
          "home-assistant-internal-desktop.png",
          "extra target desktop screenshot",
        ),
        mobile: await saveScreenshot(
          extraMobileShot,
          "home-assistant-internal-mobile.png",
          "extra target mobile screenshot",
        ),
      };
      let exactTokenRedactionChecked = false;
      if (!EXTRA_EXPECT_UNAUTHENTICATED) {
        const redactionUrl = new URL(
          "/token-redaction-fixture",
          EXTRA_URL,
        ).href;
        const redactionNavigation = assertToolResult(
          await client.callTool(navigate, { url: redactionUrl }),
          `${navigate.name} token redaction fixture`,
        );
        const redactionSnapshot = assertToolResult(
          await client.callTool(snapshot, {}),
          `${snapshot.name} token redaction fixture`,
        );
        const redactionText =
          resultText(redactionNavigation) + resultText(redactionSnapshot);
        assert(
          redactionText.includes(
            "TOKEN_REFLECTION:[REDACTED_HOME_ASSISTANT_TOKEN]",
          ),
          "MCP text output did not redact the exact browser token",
        );
        exactTokenRedactionChecked = true;
      }
      extraNavigation = {
        origin: extraOrigin,
        expectedText: EXTRA_EXPECT,
        expectedSourceIp: EXTRA_EXPECT_SOURCE_IP ?? null,
        expectedUnauthenticated: EXTRA_EXPECT_UNAUTHENTICATED,
        screenshots,
        screenshotPixels: {
          desktop: extraDesktopPng,
          mobile: extraMobilePng,
        },
        consoleChecked: true,
        networkChecked: true,
        exactTokenRedactionChecked,
      };
    }

    console.log(
      JSON.stringify({
        status: "passed",
        server: initialized.serverInfo,
        protocolVersion: initialized.protocolVersion,
        tools: {
          navigate: navigate.name,
          resize: resize.name,
          screenshot: screenshot.name,
          snapshot: snapshot.name,
          console: consoleMessages.name,
          network: networkRequests.name,
        },
        viewports: { desktop: DESKTOP, mobile: MOBILE },
        fixtureStatuses: [200, 302, 404, 500, "transport-failure"],
        extraNavigation,
      }),
    );
  } finally {
    await client.close(closeTool);
    await new Promise((resolve, reject) => {
      fixture.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
