import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

const SECRET = "http-mcp-test-secret";
const MCP_TOKEN = "remote-mcp-test-token";
const VALID_KEY = "test-key";
const models = ["claude-sonnet-4-5", "claude-opus-4-8"];
let chatCalls = 0;

const router = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    return json(res, { object: "list", data: models.map((id) => ({ id })) });
  }
  if (req.url === "/v1/chat/completions") {
    chatCalls += 1;
    const body = await readJson(req);
    assert.equal("temperature" in body, false);
    if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
      return json(res, { error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key" } }, 401);
    }
    if (body.max_tokens === "bad_value") {
      return json(res, { error: { message: "max_tokens must be an integer", type: "invalid_request_error" } }, 400);
    }
    const prompt = promptText(body);
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
      id: "chatcmpl-http-mcp-test",
      created: Math.floor(Date.now() / 1000),
      model: `${body.model}-20251101`,
      choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }],
      usage,
    });
  }
  json(res, { error: "not_found" }, 404);
});

await listen(router, "127.0.0.1");
const routerBase = `http://127.0.0.1:${router.address().port}`;

const portServer = http.createServer();
await listen(portServer, "127.0.0.1");
const appPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));

const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(appPort),
    CAPTCHA_SECRET: SECRET,
    MCP_ACCESS_TOKEN: MCP_TOKEN,
    MCP_ALLOWED_ORIGINS: "https://allowed.example",
    MCP_ALLOW_PRIVATE_BASE_URLS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(appPort, child);

  const unauthorized = await mcpPost(appPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(unauthorized.status, 401);

  const blockedOrigin = await mcpPost(appPort, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
    token: MCP_TOKEN,
    origin: "https://evil.example",
  });
  assert.equal(blockedOrigin.status, 403);

  const init = await mcpJson(appPort, { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tokentest-http-mcp-test", version: "0.0.0" } } });
  assert.equal(init.result.serverInfo.name, "tokentest-evaluator");

  const listed = await mcpJson(appPort, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ["discover_models", "evaluate_batch", "evaluate_model"]);

  const discovered = await mcpJson(appPort, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "discover_models", arguments: { base_url: routerBase, api_key: VALID_KEY } },
  });
  assert.deepEqual(JSON.parse(discovered.result.content[0].text).models, models);

  const evaluated = await mcpJson(appPort, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "evaluate_model", arguments: { base_url: routerBase, api_key: VALID_KEY, model: "claude-opus-4-8", provider: "anthropic" } },
  });
  const result = JSON.parse(evaluated.result.content[0].text);
  assert.equal(result.verdict, "genuine");
  assert.equal(result.risk.production_verdict, "production_reference_pass");
  assert.deepEqual(result.dimensions.map((item) => item.id), ["D1", "D2", "D3", "D4", "D5", "D6"]);
  assert.equal(result.dimension_coverage.tested > 0, true);
  const authEvidence = result.evidence.probes.find((item) => item.key === "authenticity").request.headers.authorization;
  assert.equal(authEvidence, "<redacted>");
  assert.equal(JSON.stringify(result).includes(VALID_KEY), false);
  assert.equal(chatCalls, 33);

  console.log("ok: remote HTTP MCP endpoint");
} finally {
  child.kill();
  router.close();
}

const productionPortServer = http.createServer();
await listen(productionPortServer, "127.0.0.1");
const productionPort = productionPortServer.address().port;
await new Promise((resolve) => productionPortServer.close(resolve));

const productionChild = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(productionPort),
    CAPTCHA_SECRET: SECRET,
    RAILWAY_ENVIRONMENT: "production",
    MCP_ACCESS_TOKEN: "",
    MCP_ALLOWED_ORIGINS: "https://allowed.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(productionPort, productionChild);
  const missingConfig = await mcpPost(productionPort, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, {
    origin: "https://allowed.example",
  });
  assert.equal(missingConfig.status, 503);
  assert.deepEqual(missingConfig.payload, { error: "mcp_access_token_required" });
} finally {
  productionChild.kill();
}

const publicPortServer = http.createServer();
await listen(publicPortServer, "127.0.0.1");
const publicPort = publicPortServer.address().port;
await new Promise((resolve) => publicPortServer.close(resolve));

const publicChild = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(publicPort),
    CAPTCHA_SECRET: SECRET,
    RAILWAY_ENVIRONMENT: "production",
    MCP_PUBLIC_MODE: "1",
    MCP_ACCESS_TOKEN: "",
    MCP_ALLOWED_ORIGINS: "https://allowed.example",
    MCP_ALLOW_PRIVATE_BASE_URLS: "1",
    MCP_PUBLIC_MAX_BATCH_MODELS: "5",
    MCP_RATE_LIMIT_MAX_REQUESTS: "120",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(publicPort, publicChild);
  const publicList = await mcpPost(publicPort, { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }, {
    origin: "https://allowed.example",
  });
  assert.equal(publicList.status, 200, JSON.stringify(publicList.payload));
  assert.deepEqual(publicList.payload.result.tools.map((tool) => tool.name).sort(), ["discover_models", "evaluate_batch", "evaluate_model"]);

  const publicBlockedOrigin = await mcpPost(publicPort, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, {
    origin: "https://evil.example",
  });
  assert.equal(publicBlockedOrigin.status, 403);

  const publicBatchTooLarge = await mcpPost(publicPort, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "evaluate_batch", arguments: { base_url: routerBase, api_key: VALID_KEY, models: ["a", "b", "c", "d", "e", "f"] } },
  }, {
    origin: "https://allowed.example",
  });
  assert.equal(publicBatchTooLarge.status, 429);
  assert.equal(publicBatchTooLarge.payload.error.message, "mcp_public_batch_limit_exceeded");
} finally {
  publicChild.kill();
}

async function mcpJson(port, body) {
  const response = await mcpPost(port, body, { token: MCP_TOKEN, origin: "https://allowed.example" });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  return response.payload;
}

async function mcpPost(port, body, { token, origin } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, headers: response.headers, payload };
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
