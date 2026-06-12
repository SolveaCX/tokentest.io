#!/usr/bin/env node
import { callTool, serverInfo, tools } from "./lib/mcp-tools.js";

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
