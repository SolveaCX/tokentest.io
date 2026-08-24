#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseCliArgs } from "../lib/cli-config.js";
import { assessAdmission } from "../lib/admission.js";

assert.deepEqual(parseCliArgs(["evaluate", "--model", "a,b", "--model", "c"]), {
  command: "evaluate", baseUrl: undefined, apiKey: undefined,
  models: ["a", "b", "c"], provider: undefined, minScore: 80,
  deep: false, format: "summary", output: undefined,
});

const envConfig = parseCliArgs([], {
  TOKENTEST_BASE_URL: "https://router.example/v1",
  TOKENTEST_API_KEY: "secret",
  TOKENTEST_MODELS: "env-a, env-b",
  TOKENTEST_MIN_SCORE: "72",
});
assert.equal(envConfig.baseUrl, "https://router.example/v1");
assert.deepEqual(envConfig.models, ["env-a", "env-b"]);
assert.equal(envConfig.minScore, 72);
assert.equal(parseCliArgs(["evaluate", "--base-url", "https://cli.example", "--model", "cli"], {
  TOKENTEST_BASE_URL: "https://env.example",
  TOKENTEST_MODELS: "env",
}).baseUrl, "https://cli.example");

assert.throws(() => parseCliArgs(["evaluate", "--format", "xml"]), (error) => error.exitCode === 2);
assert.throws(() => parseCliArgs(["evaluate", "--min-score", "101"]), (error) => error.exitCode === 2);

const pass = assessAdmission({ model: "a", score: 90, risk: { production_verdict: "production_reference_pass" }, verdict: "genuine" }, 80);
assert.equal(pass.ok, true);
const fail = assessAdmission({ model: "a", score: 90, risk: { production_verdict: "needs_review" }, verdict: "suspicious" }, 80);
assert.equal(fail.ok, false);
assert.match(fail.reasons.join(" "), /production_reference_pass/);
assert.equal(assessAdmission({ model: "a", score: 90, risk: { production_verdict: "production_reference_pass" }, error: "probe_failed" }, 80).ok, false);
assert.equal(assessAdmission({ model: "a", score: 79, risk: { production_verdict: "production_reference_pass" } }, 80).ok, false);

console.log("ok: cli configuration and admission contracts");
