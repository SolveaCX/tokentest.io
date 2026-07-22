import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const SECRET = "stop-eval-captcha-secret";
const VALID_KEY = "test-key-visible-in-ui";
const DEFAULT_PLAYWRIGHT = "/Users/nifuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const DEFAULT_BROWSERS = [
  "/Users/nifuchen/.cache/puppeteer/chrome-headless-shell/mac_arm-127.0.6533.72/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const portServer = http.createServer();
await listen(portServer, "127.0.0.1");
const appPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));

const app = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(appPort), CAPTCHA_SECRET: SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;
try {
  await waitForHealth(appPort, app);
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || DEFAULT_BROWSERS.find((candidate) => existsSync(candidate)),
  });
  const page = await browser.newPage();
  const appUrl = `http://127.0.0.1:${appPort}`;
  let checkCalls = 0;

  await page.route("**/api/check", async (route) => {
    checkCalls += 1;
    await sleep(30_000);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ verdict: "genuine", score: 90, raw_score: 90, risk: { production_verdict: "production_reference_pass" }, categories: [] }),
    }).catch(() => {});
  });

  await page.goto(appUrl);
  await page.evaluate((token) => sessionStorage.setItem("tt_cap", token), signToken("stop-e2e", Date.now() + 5 * 60_000));
  await page.fill("#endpoint", "https://router.flatkey.ai");
  await page.fill("#apiKey", VALID_KEY);
  await page.fill("#models", "slow-a, slow-b, slow-c");
  await page.evaluate(() => {
    document.querySelector("#protocol").value = "OpenAI /v1/chat/completions";
  });

  await page.click("#runProbe");
  await page.waitForFunction(() => document.querySelectorAll("#reportList .modelReport").length === 3, undefined, { timeout: 5_000 });
  for (let i = 0; i < 50 && checkCalls === 0; i += 1) await sleep(100);
  assert.ok(checkCalls > 0, "at least one evaluation request should be in flight before stopping");
  await page.locator("#stopProbe").click({ timeout: 5_000 });

  await page.waitForFunction(() => document.querySelector("#resSum")?.textContent.toLowerCase().includes("stopped"), undefined, { timeout: 5_000 });
  const resultsText = await page.locator(".results").innerText();
  assert.ok(resultsText.toLowerCase().includes("stopped"), `stopped rows should be visible: ${resultsText}`);
  assert.equal(await page.locator("#runProbe").isEnabled(), true, "run button should be re-enabled after stop");
  assert.equal(await page.locator("#stopProbe").isVisible(), false, "stop button should hide after stop");
  assert.ok(checkCalls <= 2, `stop should not dispatch queued models beyond current concurrency, got ${checkCalls}`);

  console.log(JSON.stringify({ status: "ok", checkCalls }, null, 2));
} finally {
  if (browser) await browser.close();
  app.kill();
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    return require(process.env.PLAYWRIGHT_PACKAGE || DEFAULT_PLAYWRIGHT);
  }
}

function listen(server, host) {
  server.listen(0, host);
  return once(server, "listening");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signToken(id, exp) {
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode != null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not start: ${stderr}`);
}
