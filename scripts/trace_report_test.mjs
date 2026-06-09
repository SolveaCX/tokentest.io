#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentest-trace-report-"));
const input = path.join(tmp, "trace.json");
const output = path.join(tmp, "report.html");

await fs.writeFile(input, JSON.stringify({
  id: "trace-test",
  generated_at: "2026-06-08T00:00:00.000Z",
  raw_trace: true,
  base_url: "https://example.test",
  model: "claude-opus-test",
  result: {
    verdict: "needs_review",
    score: 70,
    requested_model: "claude-opus-test",
    resolved_model: "claude-opus-test",
    pack_results: [{
      key: "authenticity",
      name: "Authenticity",
      status: "pass",
      score: 100,
      categories: [{
        key: "llm_fingerprint",
        name: "LLM fingerprint",
        status: "pass",
        score: 100,
        max: 100,
      }],
    }],
    evidence: {
      probes: [{
        key: "authenticity",
        request: {
          method: "POST",
          url: "https://example.test/v1/chat/completions",
          headers: { authorization: "Bearer sk-test-raw" },
          body: { model: "claude-opus-test" },
        },
        response: { id: "chatcmpl-test", model: "claude-opus-test", choices: [] },
        http_status: 200,
      }],
    },
  },
}, null, 2));

await execFileAsync("node", [
  path.join(root, "scripts/generate_case_trace_report.mjs"),
  "--input", input,
  "--output", output,
], { cwd: root });

const html = await fs.readFile(output, "utf8");
assert.match(html, /claude-opus-test/);
assert.match(html, /Bearer sk-test-raw/);
assert.match(html, /raw_response_saved/);
assert.match(html, /true/);
assert.doesNotMatch(html, /API key 已省略/);

console.log("trace report wrapper test passed");
