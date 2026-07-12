import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

const models = ["claude-sonnet-4-5", "claude-opus-4-8"];
const VALID_KEY = "test-key";
let chatCalls = 0;

const router = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    return json(res, { data: models.map((id) => ({ id })) });
  }
  if (req.url === "/v1/chat/completions") {
    chatCalls += 1;
    const body = await readJson(req);
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
      id: "chatcmpl-mcp-test",
      created: Math.floor(Date.now() / 1000),
      model: `${body.model}-20251101`,
      choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }],
      usage,
    });
  }
  if (req.url === "/v1/images/generations") {
    const body = await readJson(req);
    if (!isValidAuth(req)) {
      return json(res, { error: { message: "invalid API key", type: "authentication_error" } }, 401);
    }
    if (/counterfeit medicine|celebrity/i.test(body.prompt || "")) {
      return json(res, { error: { message: "blocked by safety policy", type: "safety_error" } }, 400);
    }
    return json(res, {
      id: "img-mcp-test",
      model: body.model,
      data: [{ url: `https://cdn.example.test/${body.model}/mcp.png`, revised_prompt: body.prompt }],
      usage: { prompt_tokens: Math.ceil(String(body.prompt || "").length / 4), completion_tokens: 0, total_tokens: Math.ceil(String(body.prompt || "").length / 4) },
    });
  }
  json(res, { error: "not_found" }, 404);
});

await listen(router, "127.0.0.1");
const base_url = `http://127.0.0.1:${router.address().port}`;
const child = spawn(process.execPath, ["mcp-server.js"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});

try {
  const client = createMcpClient(child);
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tokentest-mcp-test", version: "0.0.0" },
  });
  assert.equal(init.serverInfo.name, "tokentest-evaluator");

  const listed = await client.request("tools/list", {});
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["discover_models", "evaluate_batch", "evaluate_image_model", "evaluate_model", "evaluate_video_model", "list_visual_cases"]);

  const discovered = await client.request("tools/call", {
    name: "discover_models",
    arguments: { base_url, api_key: "test-key" },
  });
  assert.deepEqual(JSON.parse(discovered.content[0].text).models, models);

  const evaluated = await client.request("tools/call", {
    name: "evaluate_model",
    arguments: { base_url, api_key: "test-key", model: "claude-opus-4-8" },
  });
  const result = JSON.parse(evaluated.content[0].text);
  assert.equal(result.verdict, "genuine");
  assert.deepEqual(result.dimensions.map((item) => item.id), ["D1", "D2", "D3", "D4", "D5", "D6"]);
  assert.deepEqual(result.dimensions.map((item) => item.key), ["d1_identity_protocol", "d2_model_core", "d3_channel_output", "d4_token_integrity", "d5_safety_robustness", "d6_stability_compliance"]);
  assert.equal(result.dimension_coverage.tested > 0, true);
  assert.equal(result.categories.length >= 47, true);
  assert.deepEqual(result.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "token_integrity", "performance_reliability"]);
  assert.equal(result.performance.latency.sample_count, 3);
  assert.equal(result.performance.stream.text_chunk_count >= 1, true);
  assert.equal(result.categories.some((item) => item.key.startsWith("public_")), false);
  assert.equal(result.categories.find((item) => item.key === "safety_secret_leakage").cases.some((item) => item.key === "truthfulqa_false_premise_case"), true);
  assert.equal(result.categories.find((item) => item.key === "token_total_consistency").status, "pass");
  assert.equal(chatCalls, 35);

  const visualCases = await client.request("tools/call", {
    name: "list_visual_cases",
    arguments: { modality: "image" },
  });
  assert.equal(JSON.parse(visualCases.content[0].text).image.some((item) => item.default), true);

  const imageEval = await client.request("tools/call", {
    name: "evaluate_image_model",
    arguments: { base_url, api_key: "test-key", model: "image-mcp-model", selected_case_ids: ["image_text_rendering"] },
  });
  const imageResult = JSON.parse(imageEval.content[0].text);
  assert.equal(imageResult.modality, "image");
  assert.deepEqual(imageResult.dimensions.map((item) => item.id), ["I1", "I2", "I3", "I4"]);
  assert.equal(imageResult.categories.find((item) => item.key === "visual_optional_control").cases.length, 1);
  assert.equal(JSON.stringify(imageResult).includes("test-key"), false);
  console.log("ok: mcp server tools");
} finally {
  child.kill();
  router.close();
}

function createMcpClient(child) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`bad MCP header: ${header}`);
      const length = Number(match[1]);
      const frameEnd = headerEnd + 4 + length;
      if (buffer.length < frameEnd) return;
      const message = JSON.parse(buffer.slice(headerEnd + 4, frameEnd).toString("utf8"));
      buffer = buffer.slice(frameEnd);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return {
    request(method, params) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 10_000);
      });
    },
  };
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
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
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
