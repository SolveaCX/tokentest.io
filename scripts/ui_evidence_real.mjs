import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const SECRET = "ui-evidence-captcha-secret";
const BASE_URL = process.env.MODEL_EVAL_BASE_URL || "https://router.flatkey.ai";
const API_KEY = process.env.MODEL_EVAL_API_KEY || "";
const ARTIFACT_DIR = process.env.EVIDENCE_DIR || "test/evidence-real";
const DEFAULT_PLAYWRIGHT = "/Users/nifuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const DEFAULT_BROWSERS = [
  "/Users/nifuchen/.cache/puppeteer/chrome-headless-shell/mac_arm-127.0.6533.72/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

if (!API_KEY) {
  throw new Error("MODEL_EVAL_API_KEY is required");
}

await fs.mkdir(ARTIFACT_DIR, { recursive: true });

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
const exchanges = [];
const responseTasks = [];

try {
  await waitForHealth(appPort, app);
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || DEFAULT_BROWSERS.find((candidate) => existsSync(candidate)),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const started = new WeakMap();

  page.on("request", (request) => {
    if (isEvalApi(request.url())) started.set(request, Date.now());
  });
  page.on("response", (response) => {
    if (!isEvalApi(response.url())) return;
    responseTasks.push(captureExchange(response, started, exchanges));
  });

  const appUrl = `http://127.0.0.1:${appPort}`;
  await page.goto(appUrl);
  await page.evaluate((token) => sessionStorage.setItem("tt_cap", token), signToken("ui-evidence", Date.now() + 5 * 60_000));
  await page.fill("#endpoint", BASE_URL);
  await page.fill("#apiKey", API_KEY);
  await page.screenshot({ path: `${ARTIFACT_DIR}/01-input-filled.png`, fullPage: true });

  await page.click("#discoverBtn");
  await page.waitForSelector("#chips [data-all='1']", { timeout: 30_000 });
  await page.screenshot({ path: `${ARTIFACT_DIR}/02-models-discovered.png`, fullPage: true });
  await page.click("#chips [data-all='1']");

  const selectedModels = (await page.inputValue("#models")).split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  assert.ok(selectedModels.length > 0, "model discovery should populate at least one model");

  await page.click("#runProbe");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#matrixBody tr.row")];
    return rows.length > 0 && rows.every((row) => !row.textContent.includes("probing"));
  }, undefined, { timeout: 300_000 });

  await page.locator("#matrixBody tr.row").first().click();
  await page.screenshot({ path: `${ARTIFACT_DIR}/03-report-with-details.png`, fullPage: true });

  await Promise.allSettled(responseTasks);
  const report = await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("tt_hist") || "[]");
    return history[0]?.rows || [];
  });
  assert.equal(report.length, selectedModels.length, "report should include every selected model");
  assert.ok(report.every((item) => item.verdict !== "error"), "report should not contain evaluator errors");
  assert.ok(report.every((item) => Array.isArray(item.cats) && item.cats.length >= 43), "each report row should include all merged pack categories, token integrity and performance categories");
  assert.ok(report.every((item) => item?.performance?.latency?.sample_count === 5), "each report row should include latency percentile samples");
  assert.ok(report.every((item) => item?.performance?.stream), "each report row should include streaming evidence metadata");
  assert.ok(report.every((item) => item.cats.every((cat) => !cat.key.startsWith("public_"))), "public probes should be case evidence, not categories");
  assert.ok(report.every((item) => Array.isArray(item.packs) && item.packs.length === 7), "each report row should include seven packs including token integrity and performance");
  assert.ok(report.every((item) => !item.packs.some((pack) => pack.key === "public_benchmark_lite")), "public benchmark lite should be merged into core packs");

  await fs.writeFile(`${ARTIFACT_DIR}/request-response.json`, JSON.stringify(redact(exchanges), null, 2));
  await fs.writeFile(`${ARTIFACT_DIR}/report.json`, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    status: "ok",
    app_url: appUrl,
    target_url: BASE_URL,
    model_count: selectedModels.length,
    models: report.map((item) => item.model),
    scores: report.map((item) => item.score),
    artifacts: {
      input: `${ARTIFACT_DIR}/01-input-filled.png`,
      discovered: `${ARTIFACT_DIR}/02-models-discovered.png`,
      report: `${ARTIFACT_DIR}/03-report-with-details.png`,
      request_response: `${ARTIFACT_DIR}/request-response.json`,
      report_json: `${ARTIFACT_DIR}/report.json`,
    },
  }, null, 2));
} finally {
  if (browser) await browser.close();
  app.kill();
}

async function captureExchange(response, started, out) {
  const request = response.request();
  const rawBody = request.postData() || "";
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = await response.text().catch(() => "");
  }
  out.push({
    method: request.method(),
    url: request.url(),
    status: response.status(),
    duration_ms: started.has(request) ? Date.now() - started.get(request) : null,
    request: rawBody ? JSON.parse(rawBody) : null,
    response: responseBody,
  });
}

function isEvalApi(url) {
  return /\/api\/(models|check)$/.test(new URL(url).pathname);
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    return require(process.env.PLAYWRIGHT_PACKAGE || DEFAULT_PLAYWRIGHT);
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "api_key") return [key, maskKey(String(item || ""))];
      if (key === "token") return [key, "<captcha-token-redacted>"];
      return [key, redact(item)];
    }));
  }
  if (typeof value === "string") return value.replaceAll(API_KEY, maskKey(API_KEY));
  return value;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return "<redacted>";
  return `${key.slice(0, 7)}...${key.slice(-6)}`;
}

function listen(server, host) {
  server.listen(0, host);
  return once(server, "listening");
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}
