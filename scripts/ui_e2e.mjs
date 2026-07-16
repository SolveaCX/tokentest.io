import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
const VALID_KEY = "test-key-visible-in-ui";

const mockModels = ["claude-sonnet-4-5", "claude-opus-4-8"];
let chatCalls = 0;
let activeChatCalls = 0;
let maxConcurrentChatCalls = 0;
let router;
let routerBase = REAL_BASE_URL;

if (!USE_REAL) {
  router = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      return json(res, { object: "list", data: mockModels.map((id) => ({ id })) });
    }
    if (req.url === "/v1/chat/completions") {
      chatCalls += 1;
      activeChatCalls += 1;
      maxConcurrentChatCalls = Math.max(maxConcurrentChatCalls, activeChatCalls);
      res.on("finish", () => { activeChatCalls -= 1; });
      const body = await readJson(req);
      await sleep(25);
      assert.equal("temperature" in body, false);
      if (!isValidAuth(req)) {
        return json(res, { error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key" } }, 401);
      }
      if (body.max_tokens === "bad_value") {
        return json(res, { error: { message: "max_tokens must be an integer", type: "invalid_request_error" } }, 400);
      }
      const prompt = body.messages?.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\n") || "";
      const nonce = prompt.match(/"nonce":"([^"]+)"/)?.[1] || "missing";
      let content = JSON.stringify({ probe: "ok", answer: 42, nonce });
      let toolCalls = null;
      let finishReason = "stop";
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
      } else if (prompt.includes("TT_PUBLIC_IFEVAL_PACK")) {
        content = JSON.stringify({ format: "pass", language: "zh-CN", codes: ["R2", "R7", "R11"], checksum: 20, decision: "review" });
      } else if (prompt.includes("TT_PUBLIC_GSM8K_PACK")) {
        content = JSON.stringify({ answer: 59 });
      } else if (prompt.includes("TT_PUBLIC_TRUTHFULQA_PACK")) {
        content = JSON.stringify({ answer: "unknown", should_refuse: true });
      } else if (prompt.includes("TT_PUBLIC_CODE_PACK")) {
        content = JSON.stringify({ result: 3, tests: "pass" });
      } else if (prompt.includes("TT_PUBLIC_CODE_FILTER_REDUCE_PACK")) {
        content = JSON.stringify({ result: 20, tests: "pass" });
      } else if (prompt.includes("TT_PUBLIC_CODE_STRING_PIPELINE_PACK")) {
        content = JSON.stringify({ result: 20, tests: "pass" });
      } else if (prompt.includes("TT_PUBLIC_CODE_OBJECT_ENTRIES_PACK")) {
        content = JSON.stringify({ result: "a2|b5", tests: "pass" });
      } else if (prompt.includes("TT_ADVANCED_CONSTRAINT_PACK")) {
        content = JSON.stringify({ schedule: "B=Mon,A=Tue,C=Wed,D=Thu", conflict: "none" });
      } else if (prompt.includes("TT_ADVANCED_TABLE_PACK")) {
        content = JSON.stringify({ refund_total: 48, restock_units: 4, owner: "shared" });
      } else if (prompt.includes("TT_ADVANCED_COUNTERFACTUAL_PACK")) {
        content = JSON.stringify({ changed: ["C"], unchanged: ["A", "B"] });
      } else if (prompt.includes("TT_ADVANCED_PROOF_PACK")) {
        content = JSON.stringify({ first_bad_step: 3, corrected_total: 42 });
      } else if (prompt.includes("TT_TOKEN_OUTPUT_PACK")) {
        content = Array.from({ length: 50 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}: token integrity evidence`).join("\n");
      } else if (prompt.includes("TT_TOKEN_TRUNCATION_PACK")) {
        content = "1\n2\n3\n4\n";
        finishReason = "length";
      } else if (prompt.includes("TT_TOKEN_SHORT_INPUT_PACK") || prompt.includes("TT_TOKEN_LONG_INPUT_PACK")) {
        content = JSON.stringify({ token_probe: "ok" });
      } else if (prompt.includes("TT_TOKEN_CACHE_PACK")) {
        content = JSON.stringify({ cache_probe: "ok" });
      } else if (prompt.includes("TT_STREAM_SSE_PACK")) {
        content = "stream-ok";
      } else if (prompt.includes("TT_INSTRUCTION_PACK")) {
        content = JSON.stringify({ verdict: "pass", locale: "zh-CN", priority_order: ["security", "billing", "latency"], checksum: 10, escalation: true });
      } else if (prompt.includes("TT_REASONING_PACK")) {
        content = JSON.stringify({ arithmetic: 30, logic: "Bo=Tue,Cy=Wed,Ana=Thu", code: 39 });
      } else if (prompt.includes("TT_SAFETY_PACK")) {
        content = JSON.stringify({ public_docs: "allowed", system_prompt: "refused", secret: "refused", credential_theft: "refused" });
      }
      const usage = usageFor(body, prompt, content, finishReason);
      if (body.stream) return streamJson(res, body, content, usage);
      return json(res, {
        id: `chatcmpl-ui-${chatCalls}`,
        created: Math.floor(Date.now() / 1000),
        model: `${body.model}-20251101`,
        choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }],
        usage,
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
const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentest-ui-trace-"));

const app = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(appPort), CAPTCHA_SECRET: SECRET, EVAL_TRACE_DIR: traceDir, EVAL_TRACE_RAW: "1" },
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
  const manualResponse = await fetch(`${appUrl}/manual.html`);
  assert.equal(manualResponse.status, 200, "product manual page should be served");
  const manualHtml = await manualResponse.text();
  for (const expected of ["TokenTest Product Manual", "How to run an evaluation", "D1", "MCP usage", "evaluate_model"]) {
    assert.ok(manualHtml.includes(expected), `manual should include ${expected}`);
  }
  const githubHref = await page.locator("a[href='https://github.com/SolveaCX/tokentest.io']").count();
  assert.equal(githubHref, 1, "GitHub navigation should point to SolveaCX/tokentest.io");
  const manualLinkCount = await page.locator("a[href='/manual.html']").count();
  assert.ok(manualLinkCount >= 1, "top navigation should include product manual entry");
  const flatKeyLinkCount = await page.locator("a[href='https://flatkey.ai/']").count();
  assert.equal(flatKeyLinkCount, 1, "homepage should include one FlatKey CTA link");
  assert.equal(await page.locator("header.hero > a[href='https://flatkey.ai/']").count(), 0, "FlatKey CTA should not sit in the hero");
  assert.equal(await page.locator(".results .reportCta[href='https://flatkey.ai/']").count(), 0, "FlatKey CTA should not render as a report card/banner");
  assert.equal(await page.locator(".console .flatkeyStrip a[href='https://flatkey.ai/']").count(), 1, "FlatKey CTA should be a compact text strip above Evaluation Run");
  const flatKeyStripText = await page.locator(".console .flatkeyStrip").innerText();
  assert.ok(/buy|connect|选购|接入/i.test(flatKeyStripText), "FlatKey strip should guide users to model purchase and production connection");
  const flatKeyText = await page.locator("a[href='https://flatkey.ai/']").innerText();
  assert.ok(/FlatKey/i.test(flatKeyText), "FlatKey CTA should keep the FlatKey link visible");
  assert.equal(await page.inputValue("#models"), "", "target model input should be empty by default");

  const errorReport = {
    v: 1,
    ts: Date.now(),
    rows: [
      { model: "working-model", provider: "openai", verdict: "genuine", score: 80, raw_score: 80, risk: { production_verdict: "production_reference_pass" }, summary: "ok" },
      { model: "timeout-model", provider: "openai", verdict: "error", score: 0, raw_score: null, error: "model_eval_timeout", summary: "timed out" },
    ],
  };
  await page.goto(`${appUrl}/?error-report-test=1#report=${b64u(JSON.stringify(errorReport))}`);
  await page.waitForFunction(() => document.querySelector("#resSum")?.textContent.includes("2/2"), undefined, { timeout: 10_000 });
  const errorReportText = await page.locator(".results").innerText();
  assert.ok(errorReportText.includes("avg 80"), `error rows should be excluded from average score: ${errorReportText}`);
  assert.ok(errorReportText.includes("No score"), `error rows should show no score instead of zero: ${errorReportText}`);
  assert.ok(!errorReportText.includes("avg 40"), `error score=0 should not pull down average: ${errorReportText}`);
  await page.goto(appUrl);

  const firstScreen = await page.locator("header.hero").innerText();
  assert.ok(!firstScreen.includes("Three steps") && !firstScreen.includes("三步"), "three-step guidance should be removed from the first screen");
  assert.equal(await page.locator("#how").count(), 0, "three-step how section should be removed");
  assert.equal(await page.locator("#btnShare").count(), 0, "share button should be removed");
  assert.equal(await page.locator("#btnHistory").count(), 0, "history button should be removed");
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
    const reports = [...document.querySelectorAll("#reportList .modelReport")];
    return reports.length > 0 && reports.every((row) => !row.textContent.includes("probing"));
  }, undefined, { timeout: USE_REAL ? 300_000 : 45_000 });

  const report = await page.evaluate(() => window.compactReport().rows || []);
  assert.ok(report.length >= 1, "report should contain evaluated models");
  assert.ok(report.every((item) => item && typeof item.score === "number"), "each report row should have a score");
  assert.ok(report.every((item) => item && typeof item.raw_score === "number"), "each report row should have a raw score");
  assert.ok(report.every((item) => item?.risk?.production_verdict), "each report row should have a production risk verdict");
  assert.ok(report.every((item) => Array.isArray(item.dimensions) && item.dimensions.length === 6), "each report row should expose six user-visible dimensions");
  assert.ok(report.every((item) => item.dimensions.map((dimension) => dimension.id).join(",") === "D1,D2,D3,D4,D5,D6"), "six dimensions should be ordered D1-D6");
  assert.ok(report.every((item) => item?.dimension_coverage?.tested > 0), "each report row should include 6D coverage audit");
  assert.ok(report.every((item) => Array.isArray(item.cats) && item.cats.length >= 47), "each report row should have all merged pack categories, advanced reasoning, token integrity and performance categories");
  assert.ok(report.every((item) => item?.performance?.latency?.sample_count === 3), "each report row should include compact latency percentile samples in quick mode");
  assert.ok(report.every((item) => item?.performance?.stream?.text_chunk_count >= 1), "each report row should include streaming TTFT evidence");
  assert.ok(report.every((item) => item.cats.every((cat) => !cat.key.startsWith("public_"))), "public probes should be case evidence, not categories");
  assert.ok(report.every((item) => item.cats.some((cat) => cat.key === "reasoning_arithmetic" && (cat.cases || []).some((testCase) => testCase.key === "gsm8k_arithmetic_case"))), "GSM8K-style probe should be merged into arithmetic cases");
  assert.ok(report.every((item) => item.cats.some((cat) => cat.key === "reasoning_code" && (cat.cases || []).some((testCase) => testCase.key === "code_filter_reduce_case"))), "expanded code probes should be merged into code-understanding cases");
  assert.ok(report.every((item) => item.cats.some((cat) => cat.key === "token_input_monotonicity" && cat.status === "pass")), "token monotonicity should be scored");
  assert.ok(report.every((item) => Array.isArray(item.packs) && item.packs.length === 7), "each report row should have seven packs including token integrity and performance");
  assert.ok(report.every((item) => !item.packs.some((pack) => pack.key === "public_benchmark_lite")), "public benchmark lite should be merged into core packs");

  if (!USE_REAL) {
    assert.equal(report.length, mockModels.length);
    assert.equal(chatCalls, mockModels.length * 35);
    assert.ok(maxConcurrentChatCalls >= 2, `batch evaluation should run multiple models concurrently, got max ${maxConcurrentChatCalls}`);
    assert.ok(report.every((item) => item.verdict === "genuine"), "mock models should retain compatible genuine verdict");
    assert.ok(report.every((item) => item.risk.production_verdict === "production_reference_pass"), "mock models should pass production reference gate");
  } else {
    const externalError = report.find((item) => isExternalQuotaOrAuth(item));
    if (externalError) {
      console.log(JSON.stringify({ status: "external_limit_or_auth", report }, null, 2));
      process.exitCode = 2;
    } else {
      assert.ok(report.every((item) => item.verdict !== "error"), `real report has project-level errors: ${JSON.stringify(report, null, 2)}`);
    }
  }

  const collapsedReportText = await page.locator("#reportList .modelReport").first().innerText();
  assert.ok(!collapsedReportText.toLowerCase().includes("assessment detail table"), "multiple-model report cards should be collapsed by default");
  await page.locator("#reportList .modelReportHeaderButton").first().click();
  const firstDetail = page.locator("#reportList .modelReport").first();
  const detailText = await firstDetail.innerText();
  const normalizedDetail = detailText.toLowerCase();
  for (const label of ["Production verdict", "Raw score", "Risk gate", "6D dimension overview", "Assessment detail table", "Test item", "Priority", "Status", "Score", "Test method", "Scoring standard", "Case evidence", "D1 Identity & Protocol", "D2 Model Core", "D3 Channel & Output", "D4 Token Usage", "D5 Safety & Robustness", "D6 Stability & Compliance", "P50 latency", "P95 latency", "P99 latency", "TTFT", "LLM fingerprint", "Auth compatibility", "Token usage audit", "Input token monotonicity", "Stream SSE channel", "Tool channel", "GSM8K-style case"]) {
    assert.ok(normalizedDetail.includes(label.toLowerCase()), `detail should include ${label}`);
  }
  assert.ok(!normalizedDetail.includes("coverage audit"), "detail should not render the coverage audit block");
  assert.equal(await page.locator(".detailFacts").count(), 0, "detailFacts blocks should be removed from report details");
  const desktopLayout = await page.evaluate(() => {
    const consoleBox = document.querySelector(".console")?.getBoundingClientRect();
    const runCardBox = document.querySelector(".evalGrid")?.getBoundingClientRect();
    const resultsBox = document.querySelector(".results")?.getBoundingClientRect();
    const reportHeadText = document.querySelector(".modelReportHead")?.innerText.toLowerCase() || "";
    const dimSummary = document.querySelector(".dimSummary")?.getBoundingClientRect();
    const dimSummaryTitle = document.querySelector(".dimSummary h4")?.getBoundingClientRect();
    const detailPanel = document.querySelector(".detailPanel")?.getBoundingClientRect();
    return {
      consoleWidth: consoleBox?.width || 0,
      runCardWidth: runCardBox?.width || 0,
      resultsWidth: resultsBox?.width || 0,
      cardDelta: Math.abs((runCardBox?.width || 0) - (resultsBox?.width || 0)),
      dimSummaryLeftDelta: Math.abs((dimSummaryTitle?.left || 0) - (dimSummary?.left || 0)),
      detailPanelWidth: detailPanel?.width || 0,
      reportHeadText,
    };
  });
  assert.ok(desktopLayout.resultsWidth > 1100, `desktop results should use wide report width: ${JSON.stringify(desktopLayout)}`);
  assert.ok(desktopLayout.cardDelta <= 2, `run configuration and report cards should align in width: ${JSON.stringify(desktopLayout)}`);
  assert.ok(desktopLayout.dimSummaryLeftDelta <= 24, `collapsed dimension summaries should stay left aligned: ${JSON.stringify(desktopLayout)}`);
  assert.ok(desktopLayout.reportHeadText.includes("score"), "model summary should show score");
  assert.ok(desktopLayout.reportHeadText.includes("production verdict"), "model summary should show production verdict");
  assert.ok(desktopLayout.reportHeadText.includes("reason"), "model summary should show reason overview");
  assert.ok(!desktopLayout.reportHeadText.includes("resolved"), "model summary should not repeat resolved model");
  assert.ok(!desktopLayout.reportHeadText.includes("latency"), "model summary should not repeat latency");
  assert.ok(!/\\d+%/.test(desktopLayout.reportHeadText), "model summary scores should not include percent signs");

  assert.equal(await page.locator("#btnHtml").count(), 1, "HTML export button should be available");
  const csvDownloadPromise = page.waitForEvent("download");
  await page.click("#btnCsv");
  const csvDownload = await csvDownloadPromise;
  const csvPath = path.join("test", "ui-e2e-export.csv");
  await csvDownload.saveAs(csvPath);
  const csvText = await fs.readFile(csvPath, "utf8");
  for (const expected of ["dimension_id", "dimension", "test_item", "case_name", "scoring_standard", "result_evidence", "D1 Identity & Protocol", "GSM8K-style case", "code_filter_reduce_case"]) {
    assert.ok(csvText.includes(expected), `CSV export should include detailed field: ${expected}`);
  }
  assert.ok(csvText.split("\n").length > report.length * 20, "CSV export should contain per-dimension and per-case detail rows");

  const htmlDownloadPromise = page.waitForEvent("download");
  await page.click("#btnHtml");
  const htmlDownload = await htmlDownloadPromise;
  const htmlPath = path.join("test", "ui-e2e-export.html");
  await htmlDownload.saveAs(htmlPath);
  const htmlText = await fs.readFile(htmlPath, "utf8");
  for (const expected of ["<!doctype html>", "TokenTest Evaluation Report", "6D dimension overview", "Assessment detail", "D1 Identity &amp; Protocol", "GSM8K-style case", "code_filter_reduce_case"]) {
    assert.ok(htmlText.includes(expected), `HTML export should include detailed report content: ${expected}`);
  }

  await page.click("#langBtn");
  const zhCsvDownloadPromise = page.waitForEvent("download");
  await page.click("#btnCsv");
  const zhCsvDownload = await zhCsvDownloadPromise;
  const zhCsvPath = path.join("test", "ui-e2e-export-zh.csv");
  await zhCsvDownload.saveAs(zhCsvPath);
  const zhCsvText = await fs.readFile(zhCsvPath, "utf8");
  for (const expected of ["模型", "维度ID", "维度", "评测项", "判定标准", "结果证据", "Case 名称"]) {
    assert.ok(zhCsvText.includes(expected), `Chinese CSV export should use current-language header: ${expected}`);
  }
  const zhHtmlDownloadPromise = page.waitForEvent("download");
  await page.click("#btnHtml");
  const zhHtmlDownload = await zhHtmlDownloadPromise;
  const zhHtmlPath = path.join("test", "ui-e2e-export-zh.html");
  await zhHtmlDownload.saveAs(zhHtmlPath);
  const zhHtmlText = await fs.readFile(zhHtmlPath, "utf8");
  for (const expected of ["TokenTest 评测报告", "6D 维度概览", "评估明细", "D1 身份与协议完整性"]) {
    assert.ok(zhHtmlText.includes(expected), `Chinese HTML export should use current-language content: ${expected}`);
  }

  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(100);
  const mobileTableLayout = await page.evaluate(() => {
    const panel = document.querySelector(".detailPanel")?.getBoundingClientRect();
    const tables = [...document.querySelectorAll(".dimTable")].map((table) => {
      const wrap = table.closest(".dimTableWrap")?.getBoundingClientRect();
      const box = table.getBoundingClientRect();
      const rowHeights = [...table.querySelectorAll("tbody tr")].map((row) => row.getBoundingClientRect().height);
      return { tableWidth: box.width, wrapWidth: wrap?.width || 0, maxRowHeight: Math.max(...rowHeights, 0) };
    });
    const mobileCards = [...document.querySelectorAll(".dimMobileCard")].map((card) => {
      const box = card.getBoundingClientRect();
      return { width: box.width, height: box.height, visible: box.width > 0 && box.height > 0 };
    });
    return {
      panelWidth: panel?.width || 0,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      resultsOverflow: getComputedStyle(document.querySelector(".results")).overflow,
      resultListDisplay: getComputedStyle(document.querySelector("#reportList")).display,
      reportCount: document.querySelectorAll("#reportList .modelReport").length,
      dimensionColumns: getComputedStyle(document.querySelector(".packGrid")).gridTemplateColumns.split(" ").length,
      tables,
      mobileCards,
    };
  });
  assert.ok(mobileTableLayout.panelWidth > 0, "mobile detail panel should be measurable");
  assert.ok(mobileTableLayout.reportCount >= 1, "results should render model report cards");
  assert.ok(mobileTableLayout.scrollHeight > mobileTableLayout.clientHeight, `mobile detail page should be vertically scrollable: ${JSON.stringify(mobileTableLayout)}`);
  assert.equal(mobileTableLayout.resultsOverflow, "visible", "results container should not clip report content");
  assert.ok(mobileTableLayout.tables.length >= 6, "mobile detail should still render six dimension tables");
  assert.equal(mobileTableLayout.dimensionColumns, 2, `mobile 6D overview should use two columns: ${JSON.stringify(mobileTableLayout)}`);
  assert.ok(mobileTableLayout.pageWidth <= mobileTableLayout.viewportWidth + 2, `mobile detail should not create page-level horizontal overflow: ${JSON.stringify(mobileTableLayout)}`);
  assert.ok(mobileTableLayout.tables.some((item) => item.tableWidth > item.wrapWidth + 2), `mobile detail tables should be horizontally scrollable inside their own wrapper: ${JSON.stringify(mobileTableLayout)}`);
  assert.ok(mobileTableLayout.tables.every((item) => item.maxRowHeight <= 360), `mobile detail rows should not leave large blank space: ${JSON.stringify(mobileTableLayout)}`);
  assert.ok(!normalizedDetail.includes("authenticity"), "detail should not use legacy pack names as the primary report structure");
  assert.ok(!normalizedDetail.includes("public lite"), "detail should not show Public Lite as a top-level pack");
  assert.ok(!normalizedDetail.includes("public_gsm8k"), "detail should not expose public probe keys as dimensions");

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

function isValidAuth(req) {
  return req.headers.authorization === `Bearer ${VALID_KEY}`;
}

function promptText(body) {
  return body.messages?.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\n") || "";
}

function usageFor(body, prompt = promptText(body), content = "", finishReason = "stop") {
  const inputTokens = Math.max(8, Math.ceil(prompt.length / 4));
  const outputTokens = finishReason === "length" ? Number(body.max_tokens) || 8 : Math.max(4, Math.ceil(String(content).length / 4));
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    completion_tokens_details: { reasoning_tokens: 2 },
  };
  if (prompt.includes("TT_TOKEN_CACHE_PACK") && prompt.includes("CACHE_CALL_1")) usage.prompt_tokens_details = { cache_creation_tokens: 128 };
  if (prompt.includes("TT_TOKEN_CACHE_PACK") && prompt.includes("CACHE_CALL_2")) usage.prompt_tokens_details = { cached_tokens: 128 };
  return usage;
}

function streamJson(res, body, content, usage) {
  const id = `chatcmpl-stream-${body.model}`;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of ["stream", "-", "ok"]) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: `${body.model}-20251101`, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: `${body.model}-20251101`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signToken(id, exp) {
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function b64u(value) {
  return Buffer.from(value, "utf8").toString("base64url");
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
