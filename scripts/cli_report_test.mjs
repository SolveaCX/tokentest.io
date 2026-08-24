#!/usr/bin/env node
import assert from "node:assert/strict";
import { assessAdmission } from "../lib/admission.js";
import { buildReport, formatJson, formatJunit, formatSummary } from "../lib/cli-report.js";

const results = [
  {
    requested_model: "good&model", score: 92, verdict: "genuine", risk: { production_verdict: "production_reference_pass" },
    summary: "passed", headers: { authorization: "Bearer SECRET" }, api_key: "SECRET", raw: { prompt: "private" },
  },
  { requested_model: "bad<model>", score: 40, verdict: "suspicious", risk: { production_verdict: "needs_review" }, summary: "needs review" },
  { requested_model: "offline", score: 0, verdict: "error", error: "probe_failed", summary: "failed" },
];
const decisions = results.map((result) => assessAdmission(result, 80));
const report = buildReport({ baseUrl: "https://router.example/v1", minScore: 80, results, decisions, startedAt: "2026-08-24T00:00:00.000Z" });
const json = formatJson(report);
assert.equal(JSON.parse(json).passed, false);
assert.ok(!json.includes("SECRET"));
assert.ok(!json.includes('"raw"'));

const summary = formatSummary(report);
assert.match(summary, /good&model/);
assert.match(summary, /92/);
assert.match(summary, /FAIL|failed/i);

const junit = formatJunit(report);
assert.match(junit, /testsuite/);
assert.match(junit, /good&amp;model/);
assert.match(junit, /bad&lt;model&gt;/);
assert.match(junit, /<failure/);
assert.match(junit, /<error/);
assert.ok(!junit.includes("SECRET"));

console.log("ok: cli report formats and redaction");
