#!/usr/bin/env node
import assert from "node:assert/strict";
import { runCli } from "../bin/tokentest.js";

const passing = await runCli(["evaluate", "--base-url", "https://router.example/v1", "--api-key", "SECRET", "--model", "good", "--format", "json"], {}, {
  evaluateBatch: async () => ({ results: [{ requested_model: "good", score: 91, verdict: "genuine", risk: { production_verdict: "production_reference_pass" }, summary: "pass" }] }),
  write: () => {},
});
assert.equal(passing.exitCode, 0);
assert.ok(!passing.output.includes("SECRET"));
assert.equal(JSON.parse(passing.output).passed, true);

const rejected = await runCli(["evaluate", "--base-url", "https://router.example/v1", "--api-key", "SECRET", "--model", "bad", "--format", "json"], {}, {
  evaluateBatch: async () => ({ results: [{ requested_model: "bad", score: 70, verdict: "suspicious", risk: { production_verdict: "needs_review" }, summary: "review" }] }),
  write: () => {},
});
assert.equal(rejected.exitCode, 1);
assert.equal(JSON.parse(rejected.output).passed, false);

const invalid = await runCli(["evaluate", "--format", "xml"], {}, { write: () => {} });
assert.equal(invalid.exitCode, 2);

const unavailable = await runCli(["evaluate", "--base-url", "http://127.0.0.1:1/v1", "--api-key", "SECRET", "--model", "bad", "--format", "summary"], {}, {
  evaluateBatch: async () => { throw new Error("fetch failed"); },
  write: () => {},
});
assert.equal(unavailable.exitCode, 3);

console.log("ok: tokentest cli exit codes and execution");
