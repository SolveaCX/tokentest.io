import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

const models = ["claude-sonnet-4-5", "claude-opus-4-8"];
let chatCalls = 0;

const router = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    return json(res, { data: models.map((id) => ({ id })) });
  }
  if (req.url === "/v1/chat/completions") {
    chatCalls += 1;
    const body = await readJson(req);
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
    }
    return json(res, {
      id: "chatcmpl-mcp-test",
      created: Math.floor(Date.now() / 1000),
      model: `${body.model}-20251101`,
      choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 29, completion_tokens: 12, total_tokens: 41, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
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
  assert.deepEqual(toolNames, ["discover_models", "evaluate_batch", "evaluate_model"]);

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
  assert.equal(result.categories.length >= 29, true);
  assert.deepEqual(result.pack_results.map((item) => item.key), ["authenticity", "instruction", "reasoning_lite", "safety", "channel_capability", "public_benchmark_lite"]);
  assert.equal(chatCalls, 14);
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function listen(server, host) {
  server.listen(0, host);
  return once(server, "listening");
}
