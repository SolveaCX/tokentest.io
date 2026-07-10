import dns from "node:dns/promises";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { discoverModels, evaluateBatch, evaluateModel } from "./evaluator.js";
import { evaluateVisualModel, visualCaseCatalog } from "./visual-evaluator.js";

export const serverInfo = { name: "tokentest-evaluator", version: "0.2.0" };

const discoverInputSchema = {
  type: "object",
  required: ["base_url", "api_key"],
  additionalProperties: false,
  properties: {
    base_url: { type: "string", description: "Router base URL, with or without /v1." },
    api_key: { type: "string", description: "Bearer API key for the router." },
  },
};

const evaluateModelInputSchema = {
  type: "object",
  required: ["base_url", "api_key", "model"],
  additionalProperties: false,
  properties: {
    base_url: { type: "string", description: "Router base URL, with or without /v1." },
    api_key: { type: "string", description: "Bearer API key for the router." },
    model: { type: "string", description: "Model id to evaluate." },
    provider: { type: "string", description: "Optional provider hint, such as anthropic or openai." },
    deep: { type: "boolean", description: "Run deeper prompts where supported." },
  },
};

const evaluateBatchInputSchema = {
  type: "object",
  required: ["base_url", "api_key", "models"],
  additionalProperties: false,
  properties: {
    base_url: { type: "string", description: "Router base URL, with or without /v1." },
    api_key: { type: "string", description: "Bearer API key for the router." },
    models: { type: "array", items: { type: "string" }, description: "Model ids to evaluate." },
    provider: { type: "string", description: "Optional provider hint." },
    deep: { type: "boolean", description: "Run deeper prompts where supported." },
  },
};

const visualCasesInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    modality: { type: "string", enum: ["image", "video"], description: "Optional modality filter." },
  },
};

const evaluateVisualInputSchema = {
  type: "object",
  required: ["base_url", "api_key", "model"],
  additionalProperties: false,
  properties: {
    base_url: { type: "string", description: "Router base URL, with or without /v1." },
    api_key: { type: "string", description: "Bearer API key for the router." },
    model: { type: "string", description: "Image or video generation model id to evaluate." },
    selected_case_ids: { type: "array", items: { type: "string" }, description: "Optional additional visual case ids. Default core cases always run." },
  },
};

export const tools = [
  {
    name: "discover_models",
    description: "Discover model ids advertised by an OpenAI-compatible router.",
    inputSchema: discoverInputSchema,
  },
  {
    name: "evaluate_model",
    description: "Run TokenTest's six-dimensional production-reference evaluation for one model. Output includes dimensions, dimension_coverage, risk gates, usage evidence and redacted probe evidence.",
    inputSchema: evaluateModelInputSchema,
  },
  {
    name: "evaluate_batch",
    description: "Run TokenTest's six-dimensional production-reference evaluation for multiple models. Each result includes D1-D6 dimensions and coverage audit fields.",
    inputSchema: evaluateBatchInputSchema,
  },
  {
    name: "list_visual_cases",
    description: "List TokenTest image/video evaluation cases. Default core cases are cost-controlled; optional cases can be selected explicitly.",
    inputSchema: visualCasesInputSchema,
  },
  {
    name: "evaluate_image_model",
    description: "Run TokenTest's first-version image generation evaluation. Output includes I1-I4 dimensions, selected case evidence, raw request/response evidence and asset URLs/base64 metadata.",
    inputSchema: evaluateVisualInputSchema,
  },
  {
    name: "evaluate_video_model",
    description: "Run TokenTest's first-version video generation evaluation. Output includes V1-V4 dimensions, selected case evidence, raw request/response evidence and asset URLs/base64 metadata.",
    inputSchema: evaluateVisualInputSchema,
  },
];

const zodSchemas = {
  discover_models: {
    base_url: z.string().min(1),
    api_key: z.string().min(1),
  },
  evaluate_model: {
    base_url: z.string().min(1),
    api_key: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().optional(),
    deep: z.boolean().optional(),
  },
  evaluate_batch: {
    base_url: z.string().min(1),
    api_key: z.string().min(1),
    models: z.array(z.string().min(1)).min(1),
    provider: z.string().optional(),
    deep: z.boolean().optional(),
  },
  list_visual_cases: {
    modality: z.enum(["image", "video"]).optional(),
  },
  evaluate_image_model: {
    base_url: z.string().min(1),
    api_key: z.string().min(1),
    model: z.string().min(1),
    selected_case_ids: z.array(z.string().min(1)).optional(),
  },
  evaluate_video_model: {
    base_url: z.string().min(1),
    api_key: z.string().min(1),
    model: z.string().min(1),
    selected_case_ids: z.array(z.string().min(1)).optional(),
  },
};

export async function callTool(name, args, { remote = false, publicMode = false, maxBatchModels = 2 } = {}) {
  if (name === "discover_models") {
    const input = normalizeDiscoverArgs(args);
    if (remote) await assertRemoteBaseUrlAllowed(input.base_url);
    return discoverModels(input);
  }
  if (name === "evaluate_model") {
    const input = normalizeEvaluateModelArgs(args);
    if (publicMode) input.deep = false;
    if (remote) await assertRemoteBaseUrlAllowed(input.base_url);
    return evaluateModel(input);
  }
  if (name === "evaluate_batch") {
    const input = normalizeEvaluateBatchArgs(args);
    if (publicMode) {
      if (input.models.length > maxBatchModels) throw new Error("mcp_public_batch_limit_exceeded");
      input.deep = false;
    }
    if (remote) await assertRemoteBaseUrlAllowed(input.base_url);
    return evaluateBatch(input);
  }
  if (name === "list_visual_cases") {
    const modality = args?.modality ? String(args.modality) : "";
    return modality ? { [modality]: visualCaseCatalog[modality] || [] } : visualCaseCatalog;
  }
  if (name === "evaluate_image_model" || name === "evaluate_video_model") {
    const input = normalizeEvaluateVisualArgs(args, name === "evaluate_image_model" ? "image" : "video");
    if (remote) await assertRemoteBaseUrlAllowed(input.base_url);
    return evaluateVisualModel(input);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createSdkMcpServer({ remote = false, publicMode = false, maxBatchModels = 2 } = {}) {
  const server = new McpServer(serverInfo, {
    instructions: publicMode
      ? "TokenTest evaluates OpenAI-compatible LLM routers. This public MCP endpoint is rate-limited; deep evaluation is disabled and batch size is capped. Evaluated router API keys are supplied per tool call and are not stored by the MCP server."
      : "TokenTest evaluates OpenAI-compatible LLM routers. Evaluation results use the D1-D6 production-reference report schema. API keys are supplied per tool call and are not stored by the MCP server.",
  });
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: zodSchemas[tool.name],
    }, async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await callTool(tool.name, args, { remote, publicMode, maxBatchModels }), null, 2) }],
    }));
  }
  return server;
}

function normalizeDiscoverArgs(args = {}) {
  return {
    base_url: String(args.base_url || ""),
    api_key: String(args.api_key || ""),
  };
}

function normalizeEvaluateModelArgs(args = {}) {
  return {
    base_url: String(args.base_url || ""),
    api_key: String(args.api_key || ""),
    model: String(args.model || ""),
    provider: args.provider ? String(args.provider) : undefined,
    deep: Boolean(args.deep),
    trace_raw: false,
  };
}

function normalizeEvaluateBatchArgs(args = {}) {
  return {
    base_url: String(args.base_url || ""),
    api_key: String(args.api_key || ""),
    models: Array.isArray(args.models) ? args.models.map((item) => String(item)) : [],
    provider: args.provider ? String(args.provider) : undefined,
    deep: Boolean(args.deep),
    trace_raw: false,
  };
}

function normalizeEvaluateVisualArgs(args = {}, modality) {
  return {
    base_url: String(args.base_url || ""),
    api_key: String(args.api_key || ""),
    model: String(args.model || ""),
    modality,
    selected_case_ids: Array.isArray(args.selected_case_ids) ? args.selected_case_ids.map((item) => String(item)) : [],
    trace_raw: false,
  };
}

async function assertRemoteBaseUrlAllowed(baseUrl) {
  if (/^(1|true|yes|on)$/i.test(String(process.env.MCP_ALLOW_PRIVATE_BASE_URLS || ""))) return;
  const url = new URL(String(baseUrl || ""));
  if (!/^https?:$/i.test(url.protocol)) throw new Error("base_url must be http(s)");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("remote MCP does not allow localhost base_url");
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("remote MCP does not allow private-network base_url");
    return;
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("base_url hostname did not resolve");
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("remote MCP does not allow private-network base_url");
  }
}

function isPrivateAddress(address) {
  if (address.includes(":")) {
    const text = address.toLowerCase();
    return text === "::1" || text.startsWith("fc") || text.startsWith("fd") || text.startsWith("fe80:") || text.startsWith("::ffff:127.") || text.startsWith("::ffff:10.") || text.startsWith("::ffff:192.168.");
  }
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}
