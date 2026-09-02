import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const secret = "server-ssrf-test-secret";
const port = 54321 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), CAPTCHA_SECRET: secret, RAILWAY_ENVIRONMENT: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(port, child);
  const token = signToken("ssrf-test", Date.now() + 60_000);
  const requests = [
    ["/api/models", { token, base_url: "http://127.0.0.1:9/v1", api_key: "test-key" }],
    ["/api/check", { token, base_url: "http://169.254.169.254/latest", api_key: "test-key", model: "test-model" }],
    ["/api/check-visual", { token, base_url: "http://192.168.1.10/v1", api_key: "test-key", model: "test-model", modality: "image" }],
  ];
  for (const [route, body] of requests) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `${route} must reject private base_url`);
    assert.equal((await response.json()).error, "private_base_url_forbidden");
  }
  console.log("ok: production Web APIs reject private base URLs");
} finally {
  child.kill();
}

function signToken(id, exp) {
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function waitForHealth(targetPort, process) {
  let stderr = "";
  process.stderr.on("data", (data) => { stderr += data.toString(); });
  for (let i = 0; i < 80; i += 1) {
    if (process.exitCode != null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${stderr}`);
}
