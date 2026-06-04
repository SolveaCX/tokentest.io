import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

const SECRET = "server-route-test-secret";
const models = ["claude-sonnet-4-5", "claude-opus-4-8"];

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
      id: "chatcmpl-route-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "claude-opus-4-8-20251101",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage: { input_tokens: 31, output_tokens: 12, total_tokens: 43, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
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

const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), CAPTCHA_SECRET: SECRET, ENGINE_URL: "http://127.0.0.1:9" },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(port, child);
  const token = signToken("route-test", Date.now() + 60_000);

  const found = await postJson(port, "/api/models", { token, base_url: routerBase, api_key: "test-key" });
  assert.deepEqual(found.models, models);

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
  assert.deepEqual(result.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability"]);
  assert.equal(result.categories.length >= 24, true);
  assert.equal(chatCalls, 9);
  console.log("ok: server routes use local evaluator");
} finally {
  child.kill();
  router.close();
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
