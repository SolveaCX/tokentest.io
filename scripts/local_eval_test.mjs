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

const requests = [];
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(res, 200, { data: models.map((id) => ({ id })) });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJson(req);
      requests.push(body);
      if (/opus-4-[78]/.test(body.model) && Object.hasOwn(body, "temperature")) {
        return json(res, 400, {
          error: {
            message: "`temperature` is deprecated for this model.",
            type: "invalid_request_error",
          },
        });
      }
      const prompt = body.messages?.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\n") || "";
      let content = "{\"probe\":\"ok\",\"answer\":42}";
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
      } else if (prompt.includes("TT_PUBLIC_IFEVAL_PACK")) {
        content = JSON.stringify({ format: "pass", language: "zh", items: ["alpha", "beta"], count: 2 });
      } else if (prompt.includes("TT_PUBLIC_GSM8K_PACK")) {
        content = JSON.stringify({ answer: 12 });
      } else if (prompt.includes("TT_PUBLIC_TRUTHFULQA_PACK")) {
        content = JSON.stringify({ answer: "unknown", should_refuse: true });
      } else if (prompt.includes("TT_PUBLIC_CODE_PACK")) {
        content = JSON.stringify({ result: 11, tests: "pass" });
      } else if (prompt.includes("TT_PUBLIC_CEVAL_PACK")) {
        content = JSON.stringify({ answer: "B", subject: "economics" });
      } else if (prompt.includes("TT_INSTRUCTION_PACK")) {
        content = JSON.stringify({ verdict: "pass", items: ["red", "green", "blue"], count: 3, language: "en" });
      } else if (prompt.includes("TT_REASONING_PACK")) {
        content = JSON.stringify({ arithmetic: 37, logic: "B", code: 7 });
      } else if (prompt.includes("TT_SAFETY_PACK")) {
        content = JSON.stringify({ system_prompt: "refused", secret: "refused", harmful_code: "refused" });
      } else {
        const nonce = prompt.match(/"nonce":"([^"]+)"/)?.[1] || "";
        content = JSON.stringify({ probe: "ok", answer: 42, nonce });
      }
      return json(res, 200, {
        id: `chatcmpl-${body.model}`,
        object: "chat.completion",
        model: returnedModel(body.model),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: body.model.includes("opus-4-8") ? 50 : 33,
          completion_tokens: body.model.includes("haiku") ? 17 : 12,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
          output_tokens: body.model.includes("haiku") ? 0 : undefined,
          total_tokens: body.model.includes("opus-4-8") ? 66 : 45,
        },
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
    assert.deepEqual(single.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "public_benchmark_lite"]);
    assert.equal(single.categories.length >= 29, true);
    assert.equal(single.pack_results.every((item) => item.score >= 80), true);
    assert.equal(single.categories.find((item) => item.key === "channel_tool_use").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "channel_vision").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "channel_web_search").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "public_gsm8k").status, "pass");
    assert.equal(single.categories.find((item) => item.key === "shulex_support_policy"), undefined);
    assert.equal(single.usage.output_tokens, 168);

    const haiku = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    });
    assert.equal(haiku.usage.output_tokens, 238, "completion_tokens should be used when output_tokens is zero");
    assert.equal(haiku.categories.find((item) => item.key === "token_audit").status, "pass");
    assert.equal(haiku.pack_results.find((item) => item.key === "instruction").categories.length >= 3, true);

    const batch = await evaluateBatch({
      base_url: baseUrl,
      api_key: "test-key",
      models,
    });
    assert.equal(batch.results.length, 7);
    assert.equal(batch.results.every((item) => item.verdict === "genuine"), true);
    assert.equal(batch.summary.total_models, 7);
    assert.equal(batch.summary.error_count, 0);

    const opus47 = requests.filter((item) => item.model === "claude-opus-4-7");
    assert.equal(opus47.length, 14, "opus 4.7 should run core, channel and public probes");
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
