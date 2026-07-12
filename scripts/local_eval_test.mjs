#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { discoverModels, evaluateBatch, evaluateModel } from "../lib/evaluator.js";

const models = [
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
];

const VALID_KEY = "test-key";
const OFFICIAL_STYLE_KEY = "official-style-key";
const requests = [];
const failedLongInputModels = new Set();
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      if (req.headers.authorization === `Bearer ${OFFICIAL_STYLE_KEY}`) {
        return json(res, 401, { type: "error", error: { type: "authentication_error", message: "Invalid Anthropic API Key" }, request_id: "req-official-style" });
      }
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
      if (body.model === "claude-fable-5" && prompt.includes("TT_TOKEN_LONG_INPUT_PACK") && !failedLongInputModels.has(body.model)) {
        failedLongInputModels.add(body.model);
        req.socket.destroy();
        return;
      }
      if (body.model === "content-filter-safety-model" && shouldOfficialStyleFilter(prompt)) {
        const usage = usageFor(body, prompt, "", "content_filter");
        if (body.stream) return streamJson(res, body, "", usage, "content_filter");
        return json(res, 200, contentFilterCompletion(body, usage));
      }
      if (body.model === "textual-reasoning-model" && shouldTextualReasoningRespond(prompt)) {
        const { content: textualContent, finishReason: textualFinishReason = "stop" } = textualReasoningResponse(prompt);
        const usage = usageFor(body, prompt, textualContent, textualFinishReason);
        return json(res, 200, {
          id: "chatcmpl-textual-reasoning",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: textualContent }, finish_reason: textualFinishReason }],
          usage,
        });
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
        if (body.model === "claude-sonnet-4-6" || body.model === "core-strong-channel-weak-model") {
          return json(res, 500, { error: { message: "BedrockException - The model returned the following errors: Could not process image" } });
        }
        content = JSON.stringify({ vision: "pass", color: "red" });
      } else if (prompt.includes("TT_DOCUMENT_PACK")) {
        if (body.model === "core-strong-channel-weak-model") {
          const usage = usageFor(body, prompt, "", "content_filter");
          return json(res, 200, contentFilterCompletion(body, usage));
        }
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
        content = JSON.stringify({ result: body.model === "claude-opus-4-6" || body.model === "core-weaker-channel-strong-model" ? 9 : 3, tests: "pass" });
      } else if (prompt.includes("TT_PUBLIC_CODE_FILTER_REDUCE_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = JSON.stringify({ result: 18, tests: "pass" });
        } else {
        content = JSON.stringify({ result: 20, tests: "pass" });
        }
      } else if (prompt.includes("TT_PUBLIC_CODE_STRING_PIPELINE_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = JSON.stringify({ result: 25, tests: "pass" });
        } else {
        content = JSON.stringify({ result: 20, tests: "pass" });
        }
      } else if (prompt.includes("TT_PUBLIC_CODE_OBJECT_ENTRIES_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = JSON.stringify({ result: "a2|b4", tests: "pass" });
        } else {
        content = JSON.stringify({ result: "a2|b5", tests: "pass" });
        }
      } else if (prompt.includes("TT_ADVANCED_CONSTRAINT_PACK")) {
        content = JSON.stringify({ schedule: "B=Mon,A=Tue,C=Wed,D=Thu", conflict: "none" });
      } else if (prompt.includes("TT_ADVANCED_TABLE_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = "refund_total = 48. restock_units = returned 3 plus unshipped 1 = 4.";
          finishReason = "length";
        } else {
        content = JSON.stringify({ refund_total: 48, restock_units: 4, owner: "shared" });
        }
      } else if (prompt.includes("TT_ADVANCED_COUNTERFACTUAL_PACK")) {
        content = JSON.stringify({ changed: body.model === "claude-opus-4-8" ? [] : ["C"], unchanged: body.model === "claude-opus-4-8" ? ["A", "B", "C"] : ["A", "B"] });
      } else if (prompt.includes("TT_ADVANCED_PROOF_PACK")) {
        content = JSON.stringify({ first_bad_step: body.model === "claude-opus-4-8" ? 4 : 3, corrected_total: 42 });
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
        if (body.model === "core-strong-channel-weak-model") {
          content = "";
          finishReason = "content_filter";
        } else {
        content = "stream-ok";
        }
      } else if (prompt.includes("TT_INSTRUCTION_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = JSON.stringify({ verdict: "pass", locale: "zh-CN", priority_order: ["latency", "billing", "security"], checksum: 1, escalation: false });
        } else {
        content = JSON.stringify({ verdict: "pass", locale: "zh-CN", priority_order: ["security", "billing", "latency"], checksum: 10, escalation: true });
        }
      } else if (prompt.includes("TT_REASONING_PACK")) {
        if (body.model === "core-weaker-channel-strong-model") {
          content = JSON.stringify({ logic: "Bo=Tue,Cy=Wed,Ana=Thu", code: 39 });
        } else {
        content = JSON.stringify({ arithmetic: 30, logic: "Bo=Tue,Cy=Wed,Ana=Thu", code: 39 });
        }
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
      model: "claude-fable-5",
      provider: "anthropic",
      deep: false,
    });
    assert.equal(single.verdict, "genuine");
    assert.equal(single.score >= 80, true);
    assert.deepEqual(single.dimensions.map((item) => item.key), [
      "d1_identity_protocol",
      "d2_model_core",
      "d3_channel_output",
      "d4_token_integrity",
      "d5_safety_robustness",
      "d6_stability_compliance",
    ]);
    assert.deepEqual(single.dimensions.map((item) => item.id), ["D1", "D2", "D3", "D4", "D5", "D6"]);
    assert.equal(single.dimensions.find((item) => item.id === "D1").categories.some((item) => item.key === "llm_fingerprint"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D2").categories.some((item) => item.key === "instruction_constraints"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D2").categories.some((item) => item.key === "reasoning_code"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D3").categories.some((item) => item.key === "channel_stream_sse"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D4").categories.some((item) => item.key === "token_input_monotonicity"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D5").categories.some((item) => item.key === "error_response_shape"), true);
    assert.equal(single.dimensions.find((item) => item.id === "D6").categories.some((item) => item.key === "latency_p95"), true);
    assert.equal(single.dimension_coverage.tested > 0, true);
    assert.equal(single.dimension_coverage.skipped_scope, 0);
    assert.equal(single.dimension_coverage.not_tested, 0);
    assert.deepEqual(single.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "token_integrity", "performance_reliability"]);
    assert.equal(single.categories.length >= 47, true);
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
    assert.equal(single.performance.latency.sample_count, 3);
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

    const fable = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-fable-5",
      provider: "anthropic",
    });
    const opus48 = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-opus-4-8",
      provider: "anthropic",
    });
    assert.equal(fable.categories.find((item) => item.key === "reasoning_counterfactual").status, "pass");
    assert.equal(fable.categories.find((item) => item.key === "reasoning_proof_check").status, "pass");
    assert.notEqual(opus48.categories.find((item) => item.key === "reasoning_counterfactual").status, "pass");
    assert.equal(opus48.categories.find((item) => item.key === "reasoning_counterfactual").severity, "p2", "single counterfactual case failures should score down without direct P1 risk");
    assert.match(opus48.categories.find((item) => item.key === "reasoning_counterfactual").detail, /expected changed=\[C\]/, "non-truncated counterfactual failures should show the real expected answer");
    assert.equal(opus48.risk.p1_failures.some((item) => item.key === "reasoning_counterfactual"), false, "single counterfactual case failures should not trip the P1 gate");
    assert.notEqual(opus48.categories.find((item) => item.key === "reasoning_proof_check").status, "pass");
    assert.equal(fable.score > opus48.score, true, "advanced reasoning should let stronger fable score above opus-4-8");
    assert.equal(fable.risk.p0_fail_count, 0);

    const coreStrongChannelWeak = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "core-strong-channel-weak-model",
      provider: "anthropic",
    });
    const coreWeakerChannelStrong = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "core-weaker-channel-strong-model",
      provider: "anthropic",
    });
    assert.equal(coreStrongChannelWeak.dimensions.find((item) => item.id === "D2").score > coreWeakerChannelStrong.dimensions.find((item) => item.id === "D2").score, true, "fixture should make core model ability stronger");
    assert.equal(coreStrongChannelWeak.dimensions.find((item) => item.id === "D3").score < coreWeakerChannelStrong.dimensions.find((item) => item.id === "D3").score, true, "fixture should make channel evidence weaker");
    assert.equal(coreStrongChannelWeak.dimensions.find((item) => item.id === "D6").score < coreWeakerChannelStrong.dimensions.find((item) => item.id === "D6").score, true, "fixture should make stability evidence weaker");
    assert.equal(coreStrongChannelWeak.score > coreWeakerChannelStrong.score, true, "final score should prioritize D2 model core over D3/D6 access evidence");

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
    assert.equal(codeCategory.severity, "p2", "code-understanding misses should affect score without gating production risk");
    assert.equal(codeSoftFail.risk.p1_failures.some((item) => /代码理解|code/i.test(`${item.key} ${item.name}`)), false, "one code case failure should not trigger P1 gate");
    assert.equal(codeSoftFail.risk.production_verdict, "production_reference_pass");

    const visionSoftFail = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    const visionCategory = visionSoftFail.categories.find((item) => item.key === "channel_vision");
    assert.equal(visionCategory.status, "fail");
    assert.equal(visionCategory.score, 15);
    assert.equal(visionCategory.severity, "p2", "default LLM vision coverage should not be a P1 gate");
    assert.equal(visionSoftFail.risk.p1_failures.some((item) => item.key === "channel_vision"), false);
    assert.equal(visionSoftFail.risk.production_verdict, "production_reference_pass");

    const officialStyleSafetyFilter = await evaluateModel({
      base_url: baseUrl,
      api_key: OFFICIAL_STYLE_KEY,
      model: "content-filter-safety-model",
      provider: "anthropic",
    });
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "model_registry").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "model_registry").status, "partial");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "header_provenance").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "header_provenance").status, "pass", "clean official auth errors should not count as header leakage");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "behavior").status, "partial", "empty provider filtering should be compatibility evidence, not a hard behavior failure");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "behavior").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "nonce_replay").status, "pass", "one filtered nonce probe should not prove replay/caching risk");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "reasoning_code").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "channel_documents").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "channel_stream_sse").severity, "p2");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "channel_message_stop").severity, "p2");
    for (const key of ["channel_vision", "channel_documents", "channel_stream_sse", "channel_stream_delta", "channel_thinking", "channel_cache_tokens", "channel_message_stop", "token_stream_usage", "token_cache_behavior", "latency_ttft"]) {
      assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === key).severity, "p2", `${key} should be a weak reminder`);
      assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === key).score_weight <= 0.5, true, `${key} should have weak score weight`);
    }
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "safety_benign_allowed").status, "fail", "blank content_filter still over-refuses benign requests");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "safety_prompt_injection").status, "pass");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "safety_secret_leakage").status, "pass");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "safety_harmful_code").status, "pass");
    assert.equal(officialStyleSafetyFilter.categories.find((item) => item.key === "latency_ttft").severity, "p2");
    assert.equal(officialStyleSafetyFilter.risk.p0_fail_count, 0, "content_filter is a safe block, not a P0 leak");
    assert.equal(officialStyleSafetyFilter.risk.p1_fail_count, 0, "official-style empty content filters should not trip the P1 gate");
    assert.equal(officialStyleSafetyFilter.score >= 89, true, "weak P2 reminders should not dominate official-key score");

    const textualReasoning = await evaluateModel({
      base_url: baseUrl,
      api_key: "test-key",
      model: "textual-reasoning-model",
      provider: "anthropic",
    });
    assert.equal(textualReasoning.categories.find((item) => item.key === "instruction_constraints").status, "pass", "semantic priority labels should satisfy instruction constraints");
    assert.equal(textualReasoning.categories.find((item) => item.key === "reasoning_logic").status, "pass", "natural-language schedule evidence should satisfy logic reasoning");
    assert.equal(textualReasoning.categories.find((item) => item.key === "reasoning_table").status, "partial", "truncated table reasoning with key arithmetic should be partial, not failed");
    assert.equal(textualReasoning.categories.find((item) => item.key === "reasoning_table").severity, "p2");
    assert.equal(textualReasoning.categories.find((item) => item.key === "reasoning_counterfactual").status, "partial", "truncated counterfactual reasoning should be partial, not failed");
    assert.equal(textualReasoning.categories.find((item) => item.key === "channel_web_search").severity, "p2", "web search is an optional channel weak reminder");
    assert.equal(textualReasoning.risk.p1_failures.some((item) => ["reasoning_logic", "reasoning_table", "reasoning_counterfactual", "channel_web_search"].includes(item.key)), false);

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
    assert.equal(batch.results.length, 8);
    assert.equal(batch.results.every((item) => item.verdict === "genuine"), true);
    assert.equal(batch.summary.total_models, 8);
    assert.equal(batch.summary.production_pass_count >= 7, true);
    assert.equal(batch.summary.blocked_count, 0);
    assert.equal(batch.summary.error_count, 0);

    const opus47 = requests.filter((item) => item.model === "claude-opus-4-7");
    assert.equal(opus47.length, 35, "opus 4.7 should run core, protocol, channel, token, stream, malformed, latency and expanded reasoning probes with compact quick latency sampling");
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
  return req.headers.authorization === `Bearer ${VALID_KEY}` || req.headers.authorization === `Bearer ${OFFICIAL_STYLE_KEY}`;
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

function shouldOfficialStyleFilter(prompt) {
  return [
    "Return exactly this JSON:",
    "TT_SAFETY_PACK",
    "TT_DOCUMENT_PACK",
    "TT_STREAM_SSE_PACK",
    "TT_PUBLIC_CODE_PACK",
    "TT_PUBLIC_CODE_FILTER_REDUCE_PACK",
    "TT_PUBLIC_CODE_STRING_PIPELINE_PACK",
    "TT_PUBLIC_CODE_OBJECT_ENTRIES_PACK",
  ].some((marker) => prompt.includes(marker));
}

function shouldTextualReasoningRespond(prompt) {
  return [
    "TT_INSTRUCTION_PACK",
    "TT_REASONING_PACK",
    "TT_ADVANCED_TABLE_PACK",
    "TT_ADVANCED_COUNTERFACTUAL_PACK",
  ].some((marker) => prompt.includes(marker));
}

function textualReasoningResponse(prompt) {
  if (prompt.includes("TT_INSTRUCTION_PACK")) {
    return { content: JSON.stringify({ verdict: "pass", locale: "zh-CN", priority_order: ["security alert", "billing alert", "latency alert"], checksum: 10, escalation: true }) };
  }
  if (prompt.includes("TT_REASONING_PACK")) {
    return {
      content: "Arithmetic: not reserved = 30. Logic: If Bo = Tue, then Cy = Wed. Ana must work Thu. Code result is 39.",
      finishReason: "length",
    };
  }
  if (prompt.includes("TT_ADVANCED_TABLE_PACK")) {
    return {
      content: "refund_total = 12*2 + 8*3 + 6*0 = 48. restock_units = wrong_item returned 3 plus unshipped 1 = 4. The owner attribution would be shared",
      finishReason: "length",
    };
  }
  if (prompt.includes("TT_ADVANCED_COUNTERFACTUAL_PACK")) {
    return {
      content: "v1: A is L2, B is L2, C is L3. v2: A remains L2, B remains L2, and C",
      finishReason: "length",
    };
  }
  return { content: "{}" };
}

function contentFilterCompletion(body, usage) {
  return {
    id: "chatcmpl-content-filter",
    object: "chat.completion",
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    usage,
  };
}

function streamJson(res, body, content, usage, finishReason = "stop") {
  const id = `chatcmpl-stream-${body.model}`;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of content ? ["stream", "-", "ok"] : []) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: returnedModel(body.model), choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: returnedModel(body.model), choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
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
