#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { discoverModels, evaluateBatch, evaluateModel } from "../lib/evaluator.js";

const models = [
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
];

const VALID_KEY = "test-key";
const requests = [];
const failedLongInputModels = new Set();
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(res, 200, { data: models.map((id) => ({ id })) });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJson(req);
      requests.push(body);
      if (!isValidAuth(req)) {
        return json(res, 401, { error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key" } });
      }
      if (/opus-4-[78]/.test(body.model) && Object.hasOwn(body, "temperature")) {
        return json(res, 400, {
          error: {
            message: "`temperature` is deprecated for this model.",
            type: "invalid_request_error",
          },
        });
      }
      if (body.max_tokens === "bad_value") {
        if (body.model === "bad-channel-model") {
          return json(res, 500, { error: { message: "new_api_error: cannot unmarshal string into Go struct field ClaudeRequest.max_tokens of type uint" } });
        }
        return json(res, 400, { error: { message: "max_tokens must be an integer", type: "invalid_request_error" } });
      }
      const prompt = body.messages?.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\n") || "";
      if (body.model === "claude-opus-4-8" && prompt.includes("TT_TOKEN_LONG_INPUT_PACK") && !failedLongInputModels.has(body.model)) {
        failedLongInputModels.add(body.model);
        req.socket.destroy();
        return;
      }
      let content = "{\"probe\":\"ok\",\"answer\":42}";
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
        content = JSON.stringify({ result: body.model === "claude-opus-4-6" ? 9 : 3, tests: "pass" });
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
      } else {
        const nonce = prompt.match(/"nonce":"([^"]+)"/)?.[1] || "";
        content = JSON.stringify({ probe: "ok", answer: 42, nonce });
      }
      const usage = usageFor(body, prompt, content, finishReason);
      if (body.stream) return streamJson(res, body, content, usage);
      return json(res, 200, {
        id: `chatcmpl-${body.model}`,
        object: "chat.completion",
        model: returnedModel(body.model),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
            finish_reason: finishReason,
          },
        ],
        usage,
      });
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    const found = await discoverModels({ base_url: baseUrl, api_key: "test-key" });
    assert.deepEqual(found.models, models);

    const single = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-opus-4-8",
      provider: "anthropic",
      deep: false,
    });
    assert.equal(single.verdict, "genuine");
    assert.equal(single.score >= 80, true);
    assert.deepEqual(single.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "token_integrity", "performance_reliability"]);
    assert.equal(single.categories.length >= 43, true);
    assert.equal(single.pack_results.every((item) => item.score >= 80), true);
    assert.equal(single.categories.some((item) => item.key.startsWith("public_")), false);
    assert.equal(single.categories.find((item) => item.key === "model_registry").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "nonce_replay").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "header_provenance").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "auth_compatibility").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "instruction_constraints").cases.some((item) => item.key === "ifeval_constraints_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_arithmetic").cases.some((item) => item.key === "gsm8k_arithmetic_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_code").cases.some((item) => item.key === "code_benchmark_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_code").cases.some((item) => item.key === "code_filter_reduce_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_code").cases.some((item) => item.key === "code_string_pipeline_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_code").cases.some((item) => item.key === "code_object_entries_case"), true);
    assert.equal(single.categories.find((item) => item.key === "reasoning_code").cases.length >= 5, true);
    assert.equal(single.categories.find((item) => item.key === "safety_secret_leakage").cases.some((item) => item.key === "truthfulqa_false_premise_case"), true);
    assert.equal(single.categories.find((item) => item.key === "public_ceval_zh"), undefined);
    assert.equal(single.categories.find((item) => item.key === "channel_tool_use").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "channel_vision").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "channel_web_search").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "channel_stream_sse").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_audit").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_total_consistency").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_input_monotonicity").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_output_reasonableness").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_stop_limit").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "token_cache_behavior").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "latency_p50").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "latency_p95").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "latency_p99").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "latency_ttft").status, "pass");
    assert.equal(single.performance.latency.sample_count, 5);
    assert.equal(single.performance.stream.ttft_ms >= 0, true);
    assert.equal(single.performance.latency.p50_ms >= 0, true);
    assert.equal(single.performance.latency.p95_ms >= single.performance.latency.p50_ms, true);
    assert.equal(single.performance.latency.p99_ms >= single.performance.latency.p95_ms, true);
    const retriedLongInput = single.evidence.probes.find((item) => item.key === "token_long_input");
    assert.equal(retriedLongInput.retry_count, 1, "transient long input failures should retry once");
    assert.equal(retriedLongInput.attempts.length, 2, "retry evidence should retain both attempts");
    assert.equal(retriedLongInput.attempts[0].code, "probe_failed");
    assert.equal(retriedLongInput.attempts[1].http_status, 200);
    assert.equal(single.categories.find((item) => item.key === "reasoning_arithmetic").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "shulex_support_policy"), undefined);
    assert.equal(single.usage.output_tokens > 0, true);
    assert.equal(single.risk.p0_fail_count, 0);

    const haiku = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    });
    assert.equal(haiku.usage.output_tokens > 0, true, "completion_tokens should be used when output_tokens is zero");
    assert.equal(haiku.categories.find((item) => item.key === "token_audit").status, "pass");
    assert.equal(haiku.pack_results.find((item) => item.key === "instruction").categories.length >= 3, true);

    const codeSoftFail = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
    const codeCategory = codeSoftFail.categories.find((item) => item.key === "reasoning_code");
    assert.equal(codeCategory.cases.length >= 5, true, "code understanding should be scored as a multi-case group");
    assert.equal(codeCategory.cases.find((item) => item.key === "code_benchmark_case").status, "fail");
    assert.equal(codeCategory.status, "pass", "one failed code case should not make the whole dimension fail");
    assert.equal(codeCategory.severity, "p1", "aggregate code dimension remains important only when enough cases fail");
    assert.equal(codeSoftFail.risk.p1_failures.some((item) => /代码理解|code/i.test(`${item.key} ${item.name}`)), false, "one code case failure should not trigger P1 gate");
    assert.equal(codeSoftFail.risk.production_verdict, "production_reference_pass");

    const badChannel = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "bad-channel-model",
      provider: "openai",
    });
    assert.equal(badChannel.risk.p0_fail_count >= 1, true);
    assert.equal(badChannel.score <= 59, true, "P0 failures must cap production score");
    assert.notEqual(badChannel.verdict, "genuine");
    assert.equal(badChannel.categories.find((item) => item.key === "error_response_shape").status, "fail");
    assert.equal(badChannel.evidence.probes.find((item) => item.key === "channel_malformed_error").code, "http_500");
    assert.match(badChannel.evidence.probes.find((item) => item.key === "channel_malformed_error").error, /cannot unmarshal/);

    const batch = await evaluateBatch({
      base_url: baseUrl,
      api_key: "test-key",
      models,
    });
    assert.equal(batch.results.length, 7);
    assert.equal(batch.results.every((item) => item.verdict === "genuine"), true);
    assert.equal(batch.summary.total_models, 7);
    assert.equal(batch.summary.production_pass_count, 7);
    assert.equal(batch.summary.blocked_count, 0);
    assert.equal(batch.summary.error_count, 0);

    const opus47 = requests.filter((item) => item.model === "claude-opus-4-7");
    assert.equal(opus47.length, 33, "opus 4.7 should run core, protocol, channel, token, stream, malformed, latency and expanded code probes");
    assert.equal(opus47.every((item) => !Object.hasOwn(item, "temperature")), true, "probes must not send deprecated temperature");

    console.log("ok: local evaluator smoke");
  } finally {
    server.close();
  }
});

function returnedModel(model) {
  if (model === "claude-opus-4-5") return "claude-opus-4-5-20251101";
  if (model === "claude-sonnet-4-5") return "claude-sonnet-4-5-20250929";
  return model;
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
  if (body.model?.includes("haiku")) usage.output_tokens = 0;
  if (prompt.includes("TT_TOKEN_CACHE_PACK") && prompt.includes("CACHE_CALL_1")) {
    usage.prompt_tokens_details = { cache_creation_tokens: 128 };
  }
  if (prompt.includes("TT_TOKEN_CACHE_PACK") && prompt.includes("CACHE_CALL_2")) {
    usage.prompt_tokens_details = { cached_tokens: 128 };
  }
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
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: returnedModel(body.model), choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: returnedModel(body.model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const raw = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}
