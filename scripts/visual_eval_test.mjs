#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { evaluateVisualModel, visualCaseCatalog } from "../lib/visual-evaluator.js";

const VALID_KEY = "visual-test-key";
const calls = [];

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const body = await readJson(req);
      calls.push({ url: req.url, body, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
        return json(res, 401, { error: { message: "invalid API key", type: "authentication_error" } });
      }
      if (/counterfeit medicine|celebrity/i.test(body.prompt || "")) {
        return json(res, 400, { error: { message: "blocked by safety policy", type: "safety_error" } });
      }
      return json(res, 200, {
        id: `img-${calls.length}`,
        created: 1780000000,
        model: body.model,
        data: [{ url: `https://cdn.example.test/${body.model}/${calls.length}.png`, revised_prompt: body.prompt }],
        usage: { input_tokens: Math.ceil(String(body.prompt || "").length / 4), output_tokens: 0, total_tokens: Math.ceil(String(body.prompt || "").length / 4) },
      });
    }

    if (req.method === "POST" && req.url === "/v1/videos/generations") {
      const body = await readJson(req);
      calls.push({ url: req.url, body, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
        return json(res, 401, { error: { message: "invalid API key", type: "authentication_error" } });
      }
      if (/counterfeit medicine|celebrity/i.test(body.prompt || "")) {
        return json(res, 400, { error: { message: "blocked by safety policy", type: "safety_error" } });
      }
      return json(res, 200, {
        id: `vid-${calls.length}`,
        object: "video.generation",
        model: body.model,
        status: "completed",
        data: [{ url: `https://cdn.example.test/${body.model}/${calls.length}.mp4`, duration: body.duration || 4 }],
        usage: { input_tokens: Math.ceil(String(body.prompt || "").length / 4), output_tokens: 0, total_tokens: Math.ceil(String(body.prompt || "").length / 4) },
      });
    }

    json(res, 404, { error: { message: "not found" } });
  } catch (error) {
    json(res, 500, { error: { message: String(error?.message || error) } });
  }
});

await listen(server);
const base_url = `http://127.0.0.1:${server.address().port}`;

try {
  assert.ok(visualCaseCatalog.image.some((item) => item.default === true), "image catalog should mark default core cases");
  assert.ok(visualCaseCatalog.image.some((item) => item.default === false), "image catalog should expose optional cases");
  assert.ok(visualCaseCatalog.video.some((item) => item.default === true), "video catalog should mark default core cases");
  assert.ok(visualCaseCatalog.video.some((item) => item.default === false), "video catalog should expose optional cases");

  const imageCore = await evaluateVisualModel({
    base_url,
    api_key: VALID_KEY,
    model: "image-test-model",
    modality: "image",
    trace_raw: true,
  });
  assert.equal(imageCore.modality, "image");
  assert.equal(imageCore.verdict, "genuine");
  assert.equal(imageCore.risk.production_verdict, "production_reference_pass");
  assert.deepEqual(imageCore.dimensions.map((item) => item.id), ["I1", "I2", "I3", "I4"]);
  assert.equal(imageCore.categories.some((item) => item.key === "visual_asset_integrity"), true);
  assert.equal(imageCore.categories.some((item) => item.key === "visual_optional_control"), false);
  assert.equal(imageCore.evidence.probes.every((item) => item.request.body.model === "image-test-model"), true);
  assert.equal(imageCore.evidence.probes.filter((item) => item.key !== "image_safety_refusal").every((item) => item.response.data[0].url.endsWith(".png")), true);
  assert.equal(calls.length, visualCaseCatalog.image.filter((item) => item.default).length);

  const imageWithOptional = await evaluateVisualModel({
    base_url,
    api_key: VALID_KEY,
    model: "image-test-model",
    modality: "image",
    selected_case_ids: ["image_seed_consistency", "image_text_rendering"],
    trace_raw: true,
  });
  assert.equal(imageWithOptional.categories.some((item) => item.key === "visual_optional_control"), true);
  assert.equal(imageWithOptional.categories.find((item) => item.key === "visual_optional_control").cases.length, 2);
  assert.equal(calls.some((item) => /TOKEN TEST/.test(item.body.prompt)), true);

  const videoCore = await evaluateVisualModel({
    base_url,
    api_key: VALID_KEY,
    model: "video-test-model",
    modality: "video",
    trace_raw: true,
  });
  assert.equal(videoCore.modality, "video");
  assert.equal(videoCore.verdict, "genuine");
  assert.deepEqual(videoCore.dimensions.map((item) => item.id), ["V1", "V2", "V3", "V4"]);
  assert.equal(videoCore.categories.some((item) => item.key === "video_lifecycle_integrity"), true);
  assert.equal(videoCore.evidence.probes.every((item) => item.request.path.endsWith("/v1/videos/generations")), true);
  assert.equal(videoCore.evidence.probes.filter((item) => item.key !== "video_safety_refusal").every((item) => item.response.data[0].url.endsWith(".mp4")), true);

  const badAuth = await evaluateVisualModel({
    base_url,
    api_key: "bad-key",
    model: "image-test-model",
    modality: "image",
  });
  assert.equal(badAuth.risk.production_verdict, "blocked");
  assert.equal(badAuth.score <= 59, true);
  assert.equal(badAuth.categories.find((item) => item.key === "visual_protocol_compatibility").status, "fail");

  console.log("ok: visual evaluator core and optional cases");
} finally {
  server.close();
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function listen(target) {
  return new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
}
