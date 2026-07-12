import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";

const SECRET = "server-route-test-secret";
const models = ["claude-sonnet-4-5", "claude-opus-4-8"];
const VALID_KEY = "test-key";

let chatCalls = 0;
const router = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    return json(res, { object: "list", data: models.map((id) => ({ id })) });
  }

  if (req.url === "/v1/chat/completions") {
    chatCalls += 1;
    const body = await readJson(req);
    assert.equal(body.model, "claude-opus-4-8");
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
      id: "chatcmpl-route-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "claude-opus-4-8-20251101",
      choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage,
    });
  }

  if (req.url === "/v1/images/generations") {
    const body = await readJson(req);
    if (!isValidAuth(req)) {
      return json(res, { error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key" } }, 401);
    }
    if (/counterfeit medicine|celebrity/i.test(body.prompt || "")) {
      return json(res, { error: { message: "blocked by safety policy", type: "safety_error" } }, 400);
    }
    return json(res, {
      id: "img-route-test",
      model: body.model,
      data: [{ url: `https://cdn.example.test/${body.model}/route.png`, revised_prompt: body.prompt }],
      usage: { input_tokens: Math.ceil(String(body.prompt || "").length / 4), output_tokens: 0, total_tokens: Math.ceil(String(body.prompt || "").length / 4) },
    });
  }

  if (req.url === "/v1/videos/generations") {
    const body = await readJson(req);
    if (!isValidAuth(req)) {
      return json(res, { error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key" } }, 401);
    }
    if (/counterfeit medicine|celebrity/i.test(body.prompt || "")) {
      return json(res, { error: { message: "blocked by safety policy", type: "safety_error" } }, 400);
    }
    return json(res, {
      id: "vid-route-test",
      model: body.model,
      status: "completed",
      data: [{ url: `https://cdn.example.test/${body.model}/route.mp4`, duration: body.duration || 4 }],
      usage: { input_tokens: Math.ceil(String(body.prompt || "").length / 4), output_tokens: 0, total_tokens: Math.ceil(String(body.prompt || "").length / 4) },
    });
  }

  json(res, { error: "not_found" }, 404);
});

await listen(router, "127.0.0.1");
const routerBase = `http://127.0.0.1:${router.address().port}`;

const portServer = http.createServer();
await listen(portServer, "127.0.0.1");
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));

const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentest-server-trace-"));
const oldTraceDir = path.join(traceDir, "2026-01-01");
const oldTraceFile = path.join(oldTraceDir, "old-trace.json");
await fs.mkdir(oldTraceDir, { recursive: true });
await fs.writeFile(oldTraceFile, "{}", "utf8");
const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
await fs.utimes(oldTraceFile, oldTime, oldTime);

const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    CAPTCHA_SECRET: SECRET,
    ENGINE_URL: "http://127.0.0.1:9",
    EVAL_TRACE_DIR: traceDir,
    EVAL_TRACE_RAW: "1",
    EVAL_TRACE_RETENTION_DAYS: "14",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(port, child);
  const token = signToken("route-test", Date.now() + 60_000);

  const found = await postJson(port, "/api/models", { token, base_url: routerBase, api_key: "test-key" });
  assert.deepEqual(found.models, models);

  const visualCases = await getJson(port, "/api/visual-cases");
  assert.equal(visualCases.modalities.image.some((item) => item.default), true);
  assert.equal(visualCases.modalities.video.some((item) => item.default), true);

  const result = await postJson(port, "/api/check", {
    token,
    base_url: routerBase,
    api_key: "test-key",
    model: "claude-opus-4-8",
    provider: "anthropic",
  });
  assert.equal(result.verdict, "genuine");
  assert.equal(result.requested_model, "claude-opus-4-8");
  assert.equal(result.resolved_model, "claude-opus-4-8-20251101");
  assert.deepEqual(result.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "token_integrity", "performance_reliability"]);
  assert.equal(result.categories.length >= 47, true);
  assert.equal(result.performance.latency.sample_count, 3);
  assert.equal(result.performance.stream.text_chunk_count >= 1, true);
  assert.equal(result.categories.find((item) => item.key === "latency_p95").status, "pass");
  assert.equal(result.categories.some((item) => item.key.startsWith("public_")), false);
  assert.equal(result.categories.find((item) => item.key === "instruction_constraints").cases.some((item) => item.key === "ifeval_constraints_case"), true);
  assert.equal(result.categories.find((item) => item.key === "token_input_monotonicity").status, "pass");
  assert.equal(result.categories.find((item) => item.key === "public_ceval_zh"), undefined);
  assert.equal(chatCalls, 35);
  assert.equal(result.evidence.probes.find((item) => item.key === "authenticity").request.headers.authorization, "Bearer test-key");
  assert.equal(result.evidence.probes.find((item) => item.key === "authenticity").response.model, "claude-opus-4-8-20251101");
  assert.equal(result.evidence.probes.find((item) => item.key === "authenticity").response.choices[0].message.role, "assistant");
  assert.equal(result.trace.raw_trace, true);

  const traceFiles = await listJsonFiles(traceDir);
  assert.equal(traceFiles.length, 1, "new raw trace should be saved and stale trace should be removed");
  assert.equal(traceFiles[0].includes("old-trace.json"), false);
  const savedTrace = JSON.parse(await fs.readFile(traceFiles[0], "utf8"));
  const savedAuth = savedTrace.result.evidence.probes.find((item) => item.key === "authenticity");
  assert.equal(savedTrace.raw_trace, true);
  assert.equal(savedAuth.request.headers.authorization, "Bearer test-key");
  assert.equal(savedAuth.response.model, "claude-opus-4-8-20251101");
  assert.equal(savedAuth.response.choices[0].message.content.includes("\"probe\":\"ok\""), true);

  const visualResult = await postJson(port, "/api/check-visual", {
    token,
    base_url: routerBase,
    api_key: "test-key",
    model: "image-route-model",
    modality: "image",
    selected_case_ids: ["image_text_rendering"],
  });
  assert.equal(visualResult.modality, "image");
  assert.equal(visualResult.verdict, "genuine");
  assert.deepEqual(visualResult.dimensions.map((item) => item.id), ["I1", "I2", "I3", "I4"]);
  assert.equal(visualResult.categories.find((item) => item.key === "visual_optional_control").cases.length, 1);
  assert.equal(visualResult.assets.some((item) => item.url.endsWith(".png")), true);
  assert.equal(visualResult.evidence.probes.some((item) => item.key === "image_text_rendering"), true);
  assert.equal(visualResult.trace.raw_trace, true);
  console.log("ok: server routes use local evaluator");
} finally {
  child.kill();
  router.close();
}

async function listJsonFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
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
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "claude-opus-4-8-20251101", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "claude-opus-4-8-20251101", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
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

function signToken(id, exp) {
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${text}`);
  return JSON.parse(text || "{}");
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${text}`);
  return JSON.parse(text || "{}");
}

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode != null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}
