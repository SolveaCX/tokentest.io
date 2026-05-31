// TokenTest.io — static host + self-built slide-puzzle CAPTCHA backend.
// Pure-SVG puzzle generation (no native image deps) so Railway/Nixpacks deploys clean.
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString("hex");

// ---- puzzle geometry ----
const W = 340, H = 180, SIZE = 48, R = 9; // board + piece size + tab radius
const TOLERANCE = 7;                       // px slack on the X landing
const TTL_MS = 2 * 60 * 1000;              // challenge lifetime
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
  if (!Array.isArray(trail) || trail.length < 6) return false;
  const dur = trail[trail.length - 1].t - trail[0].t;
  if (dur < 240 || dur > 30000) return false;          // too fast / stalled
  if (trail[0].x > 12) return false;                   // must start near origin
  // velocity must vary — reject perfectly linear (scripted) motion
  const dxs = [];
  for (let i = 1; i < trail.length; i++) dxs.push(trail[i].x - trail[i - 1].x);
  const mean = dxs.reduce((a, b) => a + b, 0) / dxs.length;
  const varc = dxs.reduce((a, b) => a + (b - mean) ** 2, 0) / dxs.length;
  return varc > 0.6;
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
  const exp = Date.now() + 5 * 60 * 1000;
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

// ---- engine proxy (captcha-gated, server-to-server: no CORS, key only transits, never stored) ----
const ENGINE = process.env.ENGINE_URL || "https://mcp-quality.flatkey.ai";

app.post("/api/check", async (req, res) => {
  const { token, base_url, api_key, model, provider, deep } = req.body || {};
  if (!tokenValid(token)) return res.status(401).json({ verdict: "error", score: 0, error: "captcha_required", summary: "Human verification required." });
  if (!base_url || !api_key || !model) return res.status(400).json({ verdict: "error", score: 0, error: "missing_fields" });
  try {
    const r = await fetch(ENGINE + "/check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_url, api_key, model, provider, deep: !!deep }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ verdict: "error", score: 0, error: String(e), summary: "Engine unreachable." });
  }
});

// ---- model autodiscovery: list a router's advertised models (captcha-gated) ----
app.post("/api/models", async (req, res) => {
  const { token, base_url, api_key } = req.body || {};
  if (!tokenValid(token)) return res.status(401).json({ models: [], error: "captcha_required" });
  if (!base_url) return res.json({ models: [], error: "missing_base_url" });
  try {
    const url = String(base_url).replace(/\/$/, "") + "/models";
    const r = await fetch(url, { headers: { authorization: "Bearer " + (api_key || "") } });
    const data = await r.json().catch(() => ({}));
    const ids = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    res.json({ models: ids });
  } catch (e) {
    res.json({ models: [], error: String(e) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, challenges: challenges.size }));

// ---- static (cleanUrls so /blockrun resolves to blockrun.html) ----
app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`TokenTest.io listening on :${PORT}`));
