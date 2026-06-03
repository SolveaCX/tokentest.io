#!/usr/bin/env node
import { discoverModels, evaluateBatch, evaluateModel } from "./lib/evaluator.js";

const serverInfo = { name: "tokentest-evaluator", version: "0.2.0" };
const tools = [
  {
    name: "discover_models",
    description: "Discover model ids advertised by an OpenAI-compatible router.",
    inputSchema: {
      type: "object",
      required: ["base_url", "api_key"],
      properties: {
        base_url: { type: "string", description: "Router base URL, with or without /v1." },
        api_key: { type: "string", description: "Bearer API key for the router." },
      },
    },
  },
  {
    name: "evaluate_model",
    description: "Run TokenTest's local multi-dimensional text evaluation for one model.",
    inputSchema: {
      type: "object",
      required: ["base_url", "api_key", "model"],
      properties: {
        base_url: { type: "string" },
        api_key: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        deep: { type: "boolean" },
      },
    },
  },
  {
    name: "evaluate_batch",
    description: "Run TokenTest's local evaluation for multiple models.",
    inputSchema: {
      type: "object",
      required: ["base_url", "api_key", "models"],
      properties: {
        base_url: { type: "string" },
        api_key: { type: "string" },
        models: { type: "array", items: { type: "string" } },
        provider: { type: "string" },
        deep: { type: "boolean" },
      },
    },
  },
];

let buffer = Buffer.alloc(0);
process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const message = readFrame();
    if (!message) return;
    await handleMessage(message);
  }
});

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (!("id" in message)) return;

  try {
    if (message.method === "initialize") {
      return sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo,
      });
    }

    if (message.method === "tools/list") {
      return sendResult(message.id, { tools });
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return sendResult(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    }

    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, String(error?.message || error));
  }
}

async function callTool(name, args) {
  if (name === "discover_models") return discoverModels(args);
  if (name === "evaluate_model") return evaluateModel(args);
  if (name === "evaluate_batch") return evaluateBatch(args);
  throw new Error(`Unknown tool: ${name}`);
}

function readFrame() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString("utf8");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    buffer = Buffer.alloc(0);
    throw new Error(`Invalid MCP frame header: ${header}`);
  }
  const length = Number(match[1]);
  const frameEnd = headerEnd + 4 + length;
  if (buffer.length < frameEnd) return null;
  const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
  buffer = buffer.slice(frameEnd);
  return JSON.parse(body);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}
