import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const SECRET = "ui-e2e-captcha-secret";
const DEFAULT_PLAYWRIGHT = "/Users/nifuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const DEFAULT_BROWSERS = [
  "/Users/nifuchen/.cache/puppeteer/chrome-headless-shell/mac_arm-127.0.6533.72/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const REAL_BASE_URL = process.env.MODEL_EVAL_BASE_URL || "";
const REAL_API_KEY = process.env.MODEL_EVAL_API_KEY || "";
const USE_REAL = Boolean(REAL_BASE_URL && REAL_API_KEY);

const mockModels = ["claude-sonnet-4-5", "claude-opus-4-8"];
let chatCalls = 0;
let router;
let routerBase = REAL_BASE_URL;

if (!USE_REAL) {
  router = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      return json(res, { object: "list", data: mockModels.map((id) => ({ id })) });
    }
    if (req.url === "/v1/chat/completions") {
      chatCalls += 1;
      const body = await readJson(req);
      assert.equal("temperature" in body, false);
      const prompt = body.messages?.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\n") || "";
      const nonce = prompt.match(/"nonce":"([^"]+)"/)?.[1] || "missing";
      let content = JSON.stringify({ probe: "ok", answer: 42, nonce });
      let toolCalls = null;
      if (body.tools?.[0]?.function?.name === "tt_record_capability") {
        toolCalls = [{ id: "call-tool", type: "function", function: { name: "tt_record_capability", arguments: "{\"capability\":\"tool_use\",\"status\":\"pass\"}" } }];
        content = "";
      } else if (body.tools?.[0]?.function?.name === "web_search") {
        toolCalls = [{ id: "call-web", type: "function", function: { name: "web_search", arguments: "{\"query\":\"TokenTest channel capability\"}" } }];
        content = "";
      } else if (prompt.includes("TT_VISION_PACK")) {
        content = JSON.stringify({ vision: "pass", color: "red" });
      } else if (prompt.includes("TT_DOCUMENT_PACK")) {
        content = JSON.stringify({ document: "pass", answer: "TokenTest" });
      } else if (prompt.includes("TT_LONG_OUTPUT_PACK")) {
        content = JSON.stringify({ marker: "TT_LONG_OUTPUT", items: Array.from({ length: 90 }, (_, i) => i + 1) });
      } else if (prompt.includes("TT_INSTRUCTION_PACK")) {
        content = JSON.stringify({ verdict: "pass", items: ["red", "green", "blue"], count: 3, language: "en" });
      } else if (prompt.includes("TT_REASONING_PACK")) {
        content = JSON.stringify({ arithmetic: 37, logic: "B", code: 7 });
      } else if (prompt.includes("TT_SAFETY_PACK")) {
        content = JSON.stringify({ system_prompt: "refused", secret: "refused", harmful_code: "refused" });
      }
      return json(res, {
        id: `chatcmpl-ui-${chatCalls}`,
        created: Math.floor(Date.now() / 1000),
        model: `${body.model}-20251101`,
        choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: "stop" }],
        usage: { input_tokens: 34, output_tokens: 12, total_tokens: 46, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
      });
    }
    json(res, { error: "not_found" }, 404);
  });
  await listen(router, "127.0.0.1");
  routerBase = `http://127.0.0.1:${router.address().port}`;
}

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const appUrl = `http://127.0.0.1:${appPort}`;

  await page.goto(appUrl);
  await page.evaluate((token) => sessionStorage.setItem("tt_cap", token), signToken("ui-e2e", Date.now() + 5 * 60_000));
  await page.fill("#endpoint", routerBase);
  await page.fill("#apiKey", USE_REAL ? REAL_API_KEY : "test-key-visible-in-ui");
  await page.click("#discoverBtn");
  await page.waitForSelector("#chips [data-all='1']", { timeout: 25_000 });
  await page.click("#chips [data-all='1']");

  const selectedModels = (await page.inputValue("#models")).split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  assert.ok(selectedModels.length >= 1, "discover should add at least one model");

  if (USE_REAL && process.env.MODEL_EVAL_MAX_MODELS) {
    const max = Math.max(1, Number(process.env.MODEL_EVAL_MAX_MODELS));
    await page.fill("#models", selectedModels.slice(0, max).join(", "));
  }

  await page.click("#runProbe");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#matrixBody tr.row")];
    return rows.length > 0 && rows.every((row) => !row.textContent.includes("probing"));
  }, undefined, { timeout: USE_REAL ? 300_000 : 45_000 });

  const report = await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("tt_hist") || "[]");
    return history[0]?.rows || [];
  });
  assert.ok(report.length >= 1, "report should contain evaluated models");
  assert.ok(report.every((item) => item && typeof item.score === "number"), "each report row should have a score");
  assert.ok(report.every((item) => Array.isArray(item.cats) && item.cats.length >= 24), "each report row should have all pack categories");
  assert.ok(report.every((item) => Array.isArray(item.packs) && item.packs.length === 5), "each report row should have five packs");

  if (!USE_REAL) {
    assert.equal(report.length, mockModels.length);
    assert.equal(chatCalls, mockModels.length * 9);
    assert.ok(report.every((item) => item.verdict === "genuine"), "mock models should be genuine");
  } else {
    const externalError = report.find((item) => isExternalQuotaOrAuth(item));
    if (externalError) {
      console.log(JSON.stringify({ status: "external_limit_or_auth", report }, null, 2));
      process.exitCode = 2;
    } else {
      assert.ok(report.every((item) => item.verdict !== "error"), `real report has project-level errors: ${JSON.stringify(report, null, 2)}`);
    }
  }

  const firstDetail = page.locator("#matrixBody tr.row").first();
  await firstDetail.click();
  const detailText = await page.locator("#detin-0").innerText();
  for (const label of ["Authenticity", "Instruction", "Reasoning", "Safety", "Channel", "LLM fingerprint", "Token usage audit", "Tool channel"]) {
    assert.ok(detailText.includes(label), `detail should include ${label}`);
  }

  await fs.mkdir("test", { recursive: true });
  await fs.writeFile("test/ui-e2e-report.json", JSON.stringify(report, null, 2));
  await page.screenshot({ path: "test/ui-e2e-report.png", fullPage: true });
  console.log(JSON.stringify({
    status: "ok",
    app_url: appUrl,
    target_url: routerBase,
    models: report.map((item) => item.model),
    scores: report.map((item) => item.score),
    report_json: "test/ui-e2e-report.json",
    screenshot: "test/ui-e2e-report.png",
  }, null, 2));
} finally {
  if (browser) await browser.close();
  app.kill();
  if (router) router.close();
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    return require(process.env.PLAYWRIGHT_PACKAGE || DEFAULT_PLAYWRIGHT);
  }
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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

function isExternalQuotaOrAuth(item) {
  const text = `${item?.error || ""} ${item?.summary || ""}`.toLowerCase();
  return /quota|insufficient|balance|credit|billing|payment|required|limit exceeded|rate limit|unauthorized|forbidden|invalid api key|authentication|permission/.test(text);
}
