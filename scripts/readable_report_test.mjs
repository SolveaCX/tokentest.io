#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentest-readable-report-"));
const input = path.join(tmp, "trace.json");
const output = path.join(tmp, "readable.html");

await fs.writeFile(input, JSON.stringify({
  raw_trace: true,
  base_url: "https://example.test",
  model: "claude-opus-test",
  result: {
    verdict: "suspicious",
    score: 74,
    raw_score: 86,
    requested_model: "claude-opus-test",
    resolved_model: "claude-opus-test",
    risk: {
      production_verdict: "risky",
      p0_fail_count: 0,
      p1_fail_count: 0,
      gate_reason: "",
      p1_failures: [],
    },
    pack_results: [{
      key: "channel_capability",
      name: "通道能力",
      status: "partial",
      score: 70,
      summary: "Channel checks.",
      categories: [{
        key: "channel_vision",
        name: "视觉输入通道",
        status: "fail",
        score: 15,
        max: 100,
        severity: "p2",
        detail: "vision probe failed",
      }],
    }],
    dimensions: [{
      id: "D3",
      key: "d3_channel_output",
      name: "通道与输出完整性",
      weight: 20,
      score: 15,
      status: "fail",
      summary: "Channel output failed.",
      categories: [{
        key: "channel_vision",
        name: "视觉输入通道",
        status: "fail",
        score: 15,
        max: 100,
        severity: "p2",
        detail: "vision probe failed",
      }],
      coverage: { tested: 1, pass: 0, partial: 0, fail: 1, skipped_scope: 0, skipped_infra: 0, not_tested: 0 },
    }],
    dimension_coverage: { tested: 1, pass: 0, partial: 0, fail: 1, skipped_scope: 0, skipped_infra: 0, not_tested: 0 },
    evidence: {
      probes: [{
        key: "channel_vision",
        request: {
          method: "POST",
          url: "https://example.test/v1/chat/completions",
          headers: { authorization: "Bearer sk-test-raw" },
          body: { model: "claude-opus-test", messages: [{ role: "user", content: "image probe" }] },
        },
        response: { error: { message: "Could not process image" } },
        http_status: 500,
        latency_ms: 1200,
        error: "Could not process image",
      }],
    },
  },
}, null, 2));

await execFileAsync("node", [
  path.join(root, "scripts/generate_readable_eval_report.mjs"),
  "--input", input,
  "--output", output,
], { cwd: root });

const html = await fs.readFile(output, "utf8");
assert.match(html, /TokenTest 生产接入评测报告/);
assert.match(html, /综合评分与最终判定/);
assert.match(html, /覆盖审计/);
assert.match(html, /6D 维度概览/);
assert.match(html, /D1 身份与协议完整性/);
assert.match(html, /D2 模型基础能力/);
assert.match(html, /D3 通道与输出完整性/);
assert.match(html, /D4 Token 计量可信度/);
assert.match(html, /D5 安全鲁棒性/);
assert.match(html, /D6 稳定性、可靠性与合规/);
assert.match(html, /评测维度/);
assert.match(html, /测试场景/);
assert.match(html, /<details class="dimensionPack"/);
assert.match(html, /<summary class="dimensionPackSummary"/);
assert.match(html, /<details class="dimension/);
assert.match(html, /<summary class="dimensionSummary"/);
assert.match(html, /评测目的/);
assert.match(html, /得分解释/);
assert.match(html, /证据摘要/);
assert.match(html, /Request 原文/);
assert.match(html, /Response 原文/);
assert.match(html, /Bearer sk-test-raw/);
assert.match(html, /视觉输入通道/);

console.log("readable report test passed");
