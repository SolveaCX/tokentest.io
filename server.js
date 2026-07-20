// TokenTest.io — static host + self-built slide-puzzle CAPTCHA backend.
// Pure-SVG puzzle generation (no native image deps) so Railway/Nixpacks deploys clean.
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { discoverModels, evaluateModel } from "./lib/evaluator.js";
import { evaluateVisualModel, visualCaseCatalog } from "./lib/visual-evaluator.js";
import { createSdkMcpServer } from "./lib/mcp-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString("hex");
const EVAL_TRACE_DIR = process.env.EVAL_TRACE_DIR || path.join(__dirname, "data", "eval-runs");
const EVAL_TRACE_RETENTION_DAYS = positiveInt(process.env.EVAL_TRACE_RETENTION_DAYS, 14);
const EVAL_TRACE_RAW = process.env.EVAL_TRACE_RAW == null
  ? (!process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== "production")
  : /^(1|true|yes|on)$/i.test(String(process.env.EVAL_TRACE_RAW));
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";
const MCP_REQUIRES_ACCESS_TOKEN = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
const MCP_ALLOWED_ORIGINS = splitCsv(process.env.MCP_ALLOWED_ORIGINS || "https://tokentest.io,https://www.tokentest.io");
const MCP_PUBLIC_MODE = boolEnv(process.env.MCP_PUBLIC_MODE);
const MCP_PUBLIC_MAX_BATCH_MODELS = positiveInt(process.env.MCP_PUBLIC_MAX_BATCH_MODELS, 5);
const MCP_RATE_LIMIT_WINDOW_MS = positiveInt(process.env.MCP_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000);
const MCP_RATE_LIMIT_MAX_REQUESTS = positiveInt(process.env.MCP_RATE_LIMIT_MAX_REQUESTS, 120);
const MCP_RATE_LIMIT_TOOL_WINDOW_MS = positiveInt(process.env.MCP_RATE_LIMIT_TOOL_WINDOW_MS, 60 * 60 * 1000);
const MCP_RATE_LIMIT_DISCOVER = positiveInt(process.env.MCP_RATE_LIMIT_DISCOVER, 60);
const MCP_RATE_LIMIT_EVALUATE = positiveInt(process.env.MCP_RATE_LIMIT_EVALUATE, 20);
const MCP_RATE_LIMIT_BATCH = positiveInt(process.env.MCP_RATE_LIMIT_BATCH, 4);
const BLOGGER_API_URL = (process.env.BLOGGER_API_URL || "").replace(/\/+$/, "");
const BLOGGER_ACCESS_KEY = process.env.BLOGGER_ACCESS_KEY || "";
const BLOGGER_SITE_SLUG = process.env.BLOGGER_SITE_SLUG || "tokentest";
const BLOG_LANGUAGES = [
  { key: "en", label: "English", pathPrefix: "", htmlLang: "en" },
  { key: "zh", label: "中文", pathPrefix: "/zh", htmlLang: "zh-CN" },
];
const mcpRateBuckets = new Map();

// ---- puzzle geometry ----
const W = 340, H = 180, SIZE = 48, R = 9; // board + piece size + tab radius
const TOLERANCE = 14;                      // px slack on the X landing
const TTL_MS = 2 * 60 * 1000;              // challenge lifetime
const TOKEN_TTL_MS = positiveInt(process.env.CAPTCHA_TOKEN_TTL_MS, 60 * 60 * 1000);
const challenges = new Map();              // id -> { gapX, y, seed, issued, solved }

// prune expired challenges lazily
function gc() {
  const now = Date.now();
  for (const [id, c] of challenges) if (now - c.issued > TTL_MS) challenges.delete(id);
}

// deterministic PRNG so bg + piece share identical artwork from one seed
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the jigsaw outline (square with a tab on top + a notch on the right edge)
function piecePath(s, r) {
  const m = s / 2;
  return [
    `M0 0`,
    `H${m - r}`,
    `a${r} ${r} 0 0 1 ${2 * r} 0`,         // top tab (bump out)
    `H${s}`,
    `V${m - r}`,
    `a${r} ${r} 0 0 0 0 ${2 * r}`,          // right notch (bump in)
    `V${s}`,
    `H0`,
    `Z`,
  ].join(" ");
}

// shared artwork: dark base + a few soft color blobs in the brand palette
function artwork(seed) {
  const rng = mulberry32(seed);
  const palette = ["#fb2c36", "#3080ff", "#f99c00", "#00c758", "#a855f7"];
  let blobs = "";
  const n = 5 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(rng() * W);
    const cy = Math.floor(rng() * H);
    const rr = 40 + Math.floor(rng() * 90);
    const col = palette[Math.floor(rng() * palette.length)];
    blobs += `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${col}" fill-opacity="0.${3 + Math.floor(rng() * 4)}"/>`;
  }
  return `
    <rect width="${W}" height="${H}" fill="#0a0a0a"/>
    <g filter="url(#blur)">${blobs}</g>
    <rect width="${W}" height="${H}" fill="#0a0a0a" fill-opacity="0.32"/>`;
}

function defs() {
  return `<defs><filter id="blur"><feGaussianBlur stdDeviation="26"/></filter></defs>`;
}

function bgSvg(gapX, y, seed) {
  const hole = piecePath(SIZE, R);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}${artwork(seed)}
    <g transform="translate(${gapX} ${y})">
      <path d="${hole}" fill="#000" fill-opacity="0.55"/>
      <path d="${hole}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>
    </g>
  </svg>`;
}

function pieceSvg(gapX, y, seed) {
  const p = piecePath(SIZE, R);
  // re-render the same artwork translated so the piece shows the exact hole slice
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE + 4}" height="${SIZE + 4}" viewBox="-2 -2 ${SIZE + 4} ${SIZE + 4}">
    ${defs()}
    <clipPath id="pc"><path d="${p}"/></clipPath>
    <g clip-path="url(#pc)"><g transform="translate(${-gapX} ${-y})">${artwork(seed)}</g></g>
    <path d="${p}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.5"/>
  </svg>`;
}

const dataUrl = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

// ---- API ----
app.post("/api/captcha/challenge", (req, res) => {
  gc();
  const gapX = 96 + Math.floor(Math.random() * (W - SIZE - 110));
  const y = 14 + Math.floor(Math.random() * (H - SIZE - 28));
  const seed = (Math.random() * 1e9) | 0;
  const id = crypto.randomUUID();
  challenges.set(id, { gapX, y, seed, issued: Date.now(), solved: false });
  res.json({
    challengeId: id,
    bg: dataUrl(bgSvg(gapX, y, seed)),
    piece: dataUrl(pieceSvg(gapX, y, seed)),
    y, size: SIZE, board: { w: W, h: H }, maxX: W - SIZE,
  });
});

// trail = [{x, t}] samples captured during the drag; t in ms from drag start
function trailLooksHuman(trail) {
  if (!Array.isArray(trail) || trail.length < 4) return false;
  const dur = trail[trail.length - 1].t - trail[0].t;
  if (dur < 120 || dur > 30000) return false;          // too fast / stalled
  if (trail[0].x > 24) return false;                   // must start near origin
  // velocity must vary — reject perfectly linear (scripted) motion
  const dxs = [];
  for (let i = 1; i < trail.length; i++) dxs.push(trail[i].x - trail[i - 1].x);
  const mean = dxs.reduce((a, b) => a + b, 0) / dxs.length;
  const varc = dxs.reduce((a, b) => a + (b - mean) ** 2, 0) / dxs.length;
  const totalDx = trail[trail.length - 1].x - trail[0].x;
  return totalDx > 40 && (varc > 0.08 || dxs.length >= 8);
}

function sign(id, exp) {
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

app.post("/api/captcha/verify", (req, res) => {
  gc();
  const { challengeId, x, trail } = req.body || {};
  const c = challenges.get(challengeId);
  if (!c) return res.json({ ok: false, reason: "expired" });
  if (c.solved) return res.json({ ok: false, reason: "used" });
  const within = Math.abs(Number(x) - c.gapX) <= TOLERANCE;
  const human = trailLooksHuman(trail);
  if (!within) return res.json({ ok: false, reason: "position" });
  if (!human) return res.json({ ok: false, reason: "behavior" });
  c.solved = true;
  const exp = Date.now() + TOKEN_TTL_MS;
  res.json({ ok: true, token: sign(challengeId, exp), exp });
});

// verify a token (used to gate the run / future probe proxy)
export function tokenValid(token) {
  if (typeof token !== "string") return false;
  const [id, exp, mac] = token.split(".");
  if (!id || !exp || !mac) return false;
  if (Date.now() > Number(exp)) return false;
  const expect = crypto.createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("base64url");
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}
app.post("/api/captcha/check", (req, res) => res.json({ ok: tokenValid((req.body || {}).token) }));

app.post("/api/check", async (req, res) => {
  const { token, base_url, api_key, model, provider, deep } = req.body || {};
  if (!tokenValid(token)) return res.status(401).json({ verdict: "error", score: 0, error: "captcha_required", summary: "Human verification required." });
  if (!base_url || !api_key || !model) return res.status(400).json({ verdict: "error", score: 0, error: "missing_fields" });
  try {
    const result = await evaluateModel({ base_url, api_key, model, provider, deep: !!deep, trace_raw: EVAL_TRACE_RAW });
    try {
      result.trace = await saveEvalRunTrace({ base_url, model, provider, deep: !!deep, result });
    } catch (traceError) {
      result.trace = { error: String(traceError?.message || traceError) };
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ verdict: "error", score: 0, error: String(e), summary: "Local evaluator failed." });
  }
});

app.get("/api/visual-cases", (_req, res) => {
  res.json({ modalities: visualCaseCatalog });
});

app.post("/api/check-visual", async (req, res) => {
  const { token, base_url, api_key, model, modality, selected_case_ids } = req.body || {};
  if (!tokenValid(token)) return res.status(401).json({ verdict: "error", score: 0, error: "captcha_required", summary: "Human verification required." });
  if (!base_url || !api_key || !model || !modality) return res.status(400).json({ verdict: "error", score: 0, error: "missing_fields" });
  try {
    const result = await evaluateVisualModel({ base_url, api_key, model, modality, selected_case_ids, trace_raw: EVAL_TRACE_RAW });
    try {
      result.trace = await saveEvalRunTrace({ base_url, model, provider: modality, deep: false, result });
    } catch (traceError) {
      result.trace = { error: String(traceError?.message || traceError) };
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ verdict: "error", score: 0, error: String(e), summary: "Visual evaluator failed." });
  }
});

// ---- model autodiscovery: list a router's advertised models (captcha-gated) ----
app.post("/api/models", async (req, res) => {
  const { token, base_url, api_key } = req.body || {};
  if (!tokenValid(token)) return res.status(401).json({ models: [], error: "captcha_required" });
  if (!base_url) return res.json({ models: [], error: "missing_base_url" });
  try {
    res.json(await discoverModels({ base_url, api_key }));
  } catch (e) {
    res.json({ models: [], error: String(e) });
  }
});

app.all("/mcp", async (req, res) => {
  setMcpCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!mcpOriginAllowed(req)) return res.status(403).json({ error: "mcp_origin_forbidden" });
  const access = mcpAccess(req);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const publicRejection = access.mode === "public" ? mcpPublicPolicyRejection(req) : null;
  if (publicRejection) return sendMcpLimitError(req, res, publicRejection);
  let mcpServer;
  try {
    mcpServer = createSdkMcpServer({
      remote: true,
      publicMode: access.mode === "public",
      maxBatchModels: MCP_PUBLIC_MAX_BATCH_MODELS,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: String(error?.message || error) },
        id: req.body?.id ?? null,
      });
    }
  } finally {
    if (mcpServer) await mcpServer.close().catch(() => {});
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, challenges: challenges.size }));

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function setMcpCorsHeaders(req, res) {
  const origin = req.get("origin");
  if (origin && mcpOriginAllowed(req)) res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id");
}

function mcpOriginAllowed(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  if (MCP_ALLOWED_ORIGINS.includes("*")) return true;
  return MCP_ALLOWED_ORIGINS.includes(origin);
}

function mcpAccess(req) {
  const bearer = mcpBearer(req);
  if (MCP_ACCESS_TOKEN) {
    if (bearer && timingSafeStringEqual(bearer, MCP_ACCESS_TOKEN)) return { ok: true, mode: "authenticated" };
    if (bearer) return { ok: false, status: 401, error: "mcp_unauthorized" };
    if (MCP_PUBLIC_MODE) return { ok: true, mode: "public" };
    return { ok: false, status: 401, error: "mcp_unauthorized" };
  }
  if (MCP_REQUIRES_ACCESS_TOKEN && !MCP_PUBLIC_MODE) {
    return { ok: false, status: 503, error: "mcp_access_token_required" };
  }
  return { ok: true, mode: MCP_PUBLIC_MODE ? "public" : "local" };
}

function mcpBearer(req) {
  const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function mcpPublicPolicyRejection(req) {
  const identity = mcpClientIdentity(req);
  const requestLimit = takeRate(`mcp:req:${identity}`, MCP_RATE_LIMIT_MAX_REQUESTS, MCP_RATE_LIMIT_WINDOW_MS);
  if (!requestLimit.ok) return { message: "mcp_public_rate_limited", retryAfterMs: requestLimit.retryAfterMs };

  const body = req.body || {};
  if (body.method !== "tools/call") return null;
  const tool = String(body.params?.name || "");
  const args = body.params?.arguments || {};
  if (tool === "evaluate_batch" && Array.isArray(args.models) && args.models.length > MCP_PUBLIC_MAX_BATCH_MODELS) {
    return { message: "mcp_public_batch_limit_exceeded", retryAfterMs: MCP_RATE_LIMIT_TOOL_WINDOW_MS };
  }

  const max = tool === "discover_models" ? MCP_RATE_LIMIT_DISCOVER
    : tool === "evaluate_batch" ? MCP_RATE_LIMIT_BATCH
      : tool === "evaluate_model" ? MCP_RATE_LIMIT_EVALUATE
        : MCP_RATE_LIMIT_MAX_REQUESTS;
  const toolLimit = takeRate(`mcp:tool:${tool}:${identity}`, max, MCP_RATE_LIMIT_TOOL_WINDOW_MS);
  if (!toolLimit.ok) return { message: `mcp_public_${tool || "tool"}_rate_limited`, retryAfterMs: toolLimit.retryAfterMs };
  return null;
}

function mcpClientIdentity(req) {
  const forwarded = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function takeRate(key, max, windowMs) {
  const now = Date.now();
  const existing = mcpRateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    mcpRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    pruneRateBuckets(now);
    return { ok: true, remaining: max - 1, retryAfterMs: 0 };
  }
  if (existing.count >= max) {
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }
  existing.count += 1;
  return { ok: true, remaining: max - existing.count, retryAfterMs: 0 };
}

function pruneRateBuckets(now = Date.now()) {
  if (mcpRateBuckets.size < 5000) return;
  for (const [key, bucket] of mcpRateBuckets) {
    if (now >= bucket.resetAt) mcpRateBuckets.delete(key);
  }
}

function sendMcpLimitError(req, res, rejection) {
  res.set("Retry-After", String(Math.max(1, Math.ceil((rejection.retryAfterMs || 1000) / 1000))));
  return res.status(429).json({
    jsonrpc: "2.0",
    error: { code: -32029, message: rejection.message },
    id: req.body?.id ?? null,
  });
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function saveEvalRunTrace({ base_url, model, provider, deep, result }) {
  await cleanupEvalRunTraces();
  const id = crypto.randomUUID();
  const generatedAt = new Date();
  const day = generatedAt.toISOString().slice(0, 10);
  const dir = path.join(EVAL_TRACE_DIR, day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${generatedAt.toISOString().replace(/[:.]/g, "-")}-${safeName(model)}-${id}.json`);
  const payload = {
    id,
    generated_at: generatedAt.toISOString(),
    raw_trace: EVAL_TRACE_RAW,
    retention_days: EVAL_TRACE_RETENTION_DAYS,
    base_url,
    model,
    provider: provider || null,
    deep: !!deep,
    result,
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return {
    id,
    raw_trace: EVAL_TRACE_RAW,
    retention_days: EVAL_TRACE_RETENTION_DAYS,
    file,
  };
}

async function cleanupEvalRunTraces() {
  const cutoff = Date.now() - EVAL_TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await listFiles(EVAL_TRACE_DIR).catch(() => []);
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) await fs.unlink(file);
    } catch {}
  }
  await removeEmptyDirs(EVAL_TRACE_DIR).catch(() => {});
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function removeEmptyDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  }
  const after = await fs.readdir(dir);
  if (!after.length && dir !== EVAL_TRACE_DIR) await fs.rmdir(dir);
}

function safeName(value) {
  return String(value || "model").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "model";
}

function blogLanguageFromRequest(req) {
  return req.path.startsWith("/zh/blog") ? BLOG_LANGUAGES[1] : BLOG_LANGUAGES[0];
}

function alternateBlogPath(language, slug = "") {
  const base = `${language.pathPrefix}/blog`;
  return slug ? `${base}/${slug}` : base;
}

async function bloggerFetch(endpoint) {
  if (!BLOGGER_API_URL || !BLOGGER_ACCESS_KEY) {
    const error = new Error("Blogger integration is not configured");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${BLOGGER_API_URL}${endpoint}`, {
    headers: { "X-Access-Key": BLOGGER_ACCESS_KEY },
  });
  if (!response.ok) {
    const error = new Error(`Blogger API ${response.status}`);
    error.status = response.status;
    error.detail = await response.text().catch(() => "");
    throw error;
  }
  return response.json();
}

function blogPostsPath(language, params = {}) {
  const query = new URLSearchParams({
    limit: String(params.limit || 20),
    offset: String(params.offset || 0),
    language: language.key,
  });
  if (params.category) query.set("category_slug", params.category);
  return `/api/integration/sites/${encodeURIComponent(BLOGGER_SITE_SLUG)}/posts?${query}`;
}

function blogPostPath(language, slug) {
  const query = new URLSearchParams({ language: language.key });
  return `/api/integration/sites/${encodeURIComponent(BLOGGER_SITE_SLUG)}/posts/${encodeURIComponent(slug)}?${query}`;
}

function formatDate(value, language) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(language.key === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function displayAuthor(post) {
  return post.author_display_name || post.author?.nickname || post.author?.email || "TokenTest";
}

function textEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

function attrEscape(value) {
  return textEscape(value).replace(/`/g, "&#096;");
}

function blogShell({ language, title, description, canonicalPath, body, head = "" }) {
  const canonical = `https://tokentest.io${canonicalPath}`;
  const alternateSlug = canonicalPath.match(/\/blog\/([^/]+)$/)?.[1] || "";
  const alternateLinks = BLOG_LANGUAGES.map((item) =>
    `<link rel="alternate" hreflang="${attrEscape(item.htmlLang)}" href="https://tokentest.io${alternateBlogPath(item, alternateSlug)}">`
  ).join("\n");
  return `<!doctype html>
<html lang="${attrEscape(language.htmlLang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${textEscape(title)}</title>
<meta name="description" content="${attrEscape(description)}" />
<link rel="canonical" href="${attrEscape(canonical)}" />
${alternateLinks}
${head}
<style>
  :root{--bg:#0a0a0a;--panel:#111113;--line:rgba(255,255,255,.10);--line2:rgba(255,255,255,.06);--txt:#fafafa;--mut:rgba(255,255,255,.62);--mut2:rgba(255,255,255,.42);--red:#fb2c36;--blue:#3080ff;--green:#00c758;--amber:#f99c00;--purple:#a855f7;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;--sans:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--txt);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.6}a{color:inherit;text-decoration:none}
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(620px 380px at 14% -10%,rgba(251,44,54,.16),transparent 70%),radial-gradient(560px 420px at 94% 0,rgba(48,128,255,.14),transparent 70%)}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}nav{position:sticky;top:0;z-index:20;background:rgba(10,10,10,.78);backdrop-filter:blur(12px);border-bottom:1px solid var(--line2)}
  .navIn{height:60px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:flex;align-items:center;gap:10px;font-weight:650}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--red),#b3121b);font-family:var(--mono);font-size:13px}.navLinks,.navRight{display:flex;align-items:center;gap:18px;font-size:14px;color:var(--mut)}.navLinks a:hover,.navRight a:hover{color:#fff}.active{color:#fff}.btn{border:1px solid var(--line);border-radius:8px;padding:7px 11px;background:rgba(255,255,255,.04)}
  header{padding:54px 0 26px}.eyebrow{font-family:var(--mono);font-size:12px;color:var(--red);margin-bottom:10px;text-transform:uppercase;letter-spacing:.08em}h1{font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.02em;margin:0 0 14px}.lead{max-width:780px;color:var(--mut);font-size:17px}.langSwitch{display:flex;gap:8px;margin-top:18px}.langSwitch a{font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:7px;padding:6px 10px;color:var(--mut)}.langSwitch a.active{color:#fff;border-color:rgba(251,44,54,.5);background:rgba(251,44,54,.10)}
  .postGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:10px 0 42px}.postCard{border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,var(--panel),#0c0c0d);overflow:hidden}.postCard a{display:block;height:100%}.cover{aspect-ratio:16/8;background:#090909;overflow:hidden;border-bottom:1px solid var(--line2)}.cover img{width:100%;height:100%;object-fit:cover;display:block}.postBody{padding:18px}.meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--mut2);font-family:var(--mono);font-size:11px;margin-bottom:9px}.cat{color:#8ab6ff}.postCard h2{font-size:20px;line-height:1.25;margin:0 0 8px}.excerpt{color:var(--mut);font-size:14px;margin:0}.empty,.error{border:1px dashed var(--line);border-radius:8px;padding:22px;color:var(--mut);background:rgba(255,255,255,.02);margin-bottom:42px}
  article{max-width:820px;margin:0 auto 54px}.articleHead{padding:54px 0 24px}.articleMeta{display:flex;gap:10px;flex-wrap:wrap;color:var(--mut2);font-family:var(--mono);font-size:12px}.articleCover{margin:0 0 28px;border-radius:8px;overflow:hidden;border:1px solid var(--line2)}.articleCover img{width:100%;display:block}.content{color:rgba(255,255,255,.84);font-size:17px}.content h1,.content h2,.content h3{color:#fff;line-height:1.18;margin:30px 0 10px}.content h1{font-size:34px}.content h2{font-size:26px}.content h3{font-size:20px}.content p,.content ul,.content ol{margin:0 0 18px}.content a{color:#8ab6ff;text-decoration:underline}.content pre{overflow:auto;border:1px solid var(--line2);border-radius:8px;background:#080809;padding:14px}.content code{font-family:var(--mono);color:#d8e7ff}.content blockquote{margin:0 0 18px;border-left:3px solid var(--red);padding-left:14px;color:var(--mut)}
  footer{border-top:1px solid var(--line2);padding:28px 0;color:var(--mut2);font-size:13px}
  @media(max-width:760px){.navLinks{display:none}.postGrid{grid-template-columns:1fr}.wrap{padding:0 18px}.navRight{gap:10px}h1{font-size:clamp(32px,10vw,44px)}.lead{font-size:15px}.content{font-size:16px}}
</style>
</head>
<body>
<nav><div class="wrap navIn">
  <a class="brand" href="/"><span class="mark">TT</span>TokenTest<span style="color:var(--mut)">.io</span></a>
  <div class="navLinks"><a href="/#verify">${language.key === "zh" ? "开始检测" : "Evaluate"}</a><a class="active" href="${alternateBlogPath(language)}">Blog</a><a href="/manual.html">${language.key === "zh" ? "产品手册" : "Manual"}</a></div>
  <div class="navRight"><a class="btn" href="/">${language.key === "zh" ? "返回首页" : "Home"}</a></div>
</div></nav>
${body}
<footer class="wrap">© TokenTest.io · Blog · <a href="https://flatkey.ai/" target="_blank" rel="noopener">FlatKey</a></footer>
</body>
</html>`;
}

async function renderBlogIndex(req, res) {
  const language = blogLanguageFromRequest(req);
  try {
    const posts = await bloggerFetch(blogPostsPath(language));
    const title = language.key === "zh" ? "TokenTest 博客" : "TokenTest Blog";
    const description = language.key === "zh"
      ? "TokenTest 关于模型评测、AI 中间层采购、路由协议与生产接入风险的文章。"
      : "Articles from TokenTest on model evaluation, AI middle-layer procurement, routing protocols and production-readiness risk.";
    const cards = posts.map((post) => {
      const href = alternateBlogPath(language, post.slug);
      const cover = post.cover_image_url ? `<div class="cover"><img src="${attrEscape(post.cover_image_url)}" alt=""></div>` : "";
      const category = post.category?.name ? `<span class="cat">${textEscape(post.category.name)}</span>` : "";
      return `<section class="postCard"><a href="${attrEscape(href)}">${cover}<div class="postBody">
        <div class="meta">${category}<span>${textEscape(formatDate(post.published_at || post.updated_at, language))}</span><span>${textEscape(displayAuthor(post))}</span></div>
        <h2>${textEscape(post.title)}</h2>
        <p class="excerpt">${textEscape(post.excerpt || post.meta_description || "")}</p>
      </div></a></section>`;
    }).join("");
    const body = `<header class="wrap">
      <div class="eyebrow">${language.key === "zh" ? "BLOG" : "BLOG"}</div>
      <h1>${textEscape(title)}</h1>
      <p class="lead">${textEscape(description)}</p>
      <div class="langSwitch">${BLOG_LANGUAGES.map((item) => `<a class="${item.key === language.key ? "active" : ""}" href="${alternateBlogPath(item)}">${textEscape(item.label)}</a>`).join("")}</div>
    </header>
    <main class="wrap">${cards ? `<div class="postGrid">${cards}</div>` : `<div class="empty">${language.key === "zh" ? "当前语言还没有已发布文章。" : "No published posts yet for this language."}</div>`}</main>`;
    res.send(blogShell({ language, title, description, canonicalPath: alternateBlogPath(language), body }));
  } catch (error) {
    renderBlogError(res, language, error);
  }
}

async function renderBlogPost(req, res) {
  const language = blogLanguageFromRequest(req);
  try {
    const post = await bloggerFetch(blogPostPath(language, req.params.slug));
    const title = post.meta_title || post.title;
    const description = post.meta_description || post.excerpt || "";
    const canonicalPath = alternateBlogPath(language, post.slug);
    const cover = post.cover_image_url ? `<figure class="articleCover"><img src="${attrEscape(post.cover_image_url)}" alt=""></figure>` : "";
    const imageMeta = post.cover_image_url ? `<meta property="og:image" content="${attrEscape(post.cover_image_url)}" />` : "";
    const body = `<article class="wrap">
      <header class="articleHead">
        <div class="eyebrow">${textEscape(post.category?.name || "TokenTest")}</div>
        <h1>${textEscape(post.title)}</h1>
        <div class="articleMeta"><span>${textEscape(formatDate(post.published_at || post.updated_at, language))}</span><span>${textEscape(displayAuthor(post))}</span></div>
        <div class="langSwitch">${BLOG_LANGUAGES.map((item) => `<a class="${item.key === language.key ? "active" : ""}" href="${alternateBlogPath(item, post.slug)}">${textEscape(item.label)}</a>`).join("")}</div>
      </header>
      ${cover}
      <div class="content">${post.html_content || ""}</div>
    </article>`;
    res.send(blogShell({
      language,
      title,
      description,
      canonicalPath,
      body,
      head: `<meta property="og:title" content="${attrEscape(title)}" />
<meta property="og:description" content="${attrEscape(description)}" />
<meta property="article:published_time" content="${attrEscape(post.published_at || "")}" />
<meta property="article:modified_time" content="${attrEscape(post.updated_at || "")}" />
${imageMeta}`,
    }));
  } catch (error) {
    if (error.status === 404) {
      res.status(404).send(blogShell({
        language,
        title: language.key === "zh" ? "文章未找到" : "Post not found",
        description: "",
        canonicalPath: alternateBlogPath(language, req.params.slug),
        body: `<main class="wrap"><header><div class="eyebrow">404</div><h1>${language.key === "zh" ? "文章未找到" : "Post not found"}</h1><p class="lead">${language.key === "zh" ? "这篇文章不存在，或当前语言版本还没有发布。" : "This post does not exist, or this language version has not been published yet."}</p></header></main>`,
      }));
      return;
    }
    renderBlogError(res, language, error);
  }
}

function renderBlogError(res, language, error) {
  const status = error.status || 502;
  const title = language.key === "zh" ? "博客暂不可用" : "Blog unavailable";
  const description = language.key === "zh"
    ? "Blogger 数据源暂时不可用，或部署环境尚未配置。"
    : "The Blogger data source is unavailable or the deployment is not configured yet.";
  res.status(status).send(blogShell({
    language,
    title,
    description,
    canonicalPath: alternateBlogPath(language),
    body: `<main class="wrap"><header><div class="eyebrow">${textEscape(status)}</div><h1>${textEscape(title)}</h1><p class="lead">${textEscape(description)}</p></header><div class="error">${textEscape(error.message)}</div></main>`,
  }));
}

// ---- static (cleanUrls so /blockrun resolves to blockrun.html) ----
app.get(["/blog", "/zh/blog"], renderBlogIndex);
app.get(["/blog/:slug", "/zh/blog/:slug"], renderBlogPost);
app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`TokenTest.io listening on :${PORT}`));
