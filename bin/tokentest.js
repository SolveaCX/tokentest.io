#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateBatch as defaultEvaluateBatch } from "../lib/evaluator.js";
import { parseCliArgs, validateCliConfig } from "../lib/cli-config.js";
import { assessBatch } from "../lib/admission.js";
import { buildReport, formatJson, formatJunit, formatSummary } from "../lib/cli-report.js";

export async function runCli(argv = process.argv.slice(2), env = process.env, deps = {}) {
  let config;
  try {
    config = validateCliConfig(parseCliArgs(argv, env));
  } catch (error) {
    return { exitCode: error.exitCode || 2, output: "", error: error.message };
  }

  let batch;
  try {
    const evaluateBatch = deps.evaluateBatch || defaultEvaluateBatch;
    batch = await evaluateBatch({
      base_url: config.baseUrl,
      api_key: config.apiKey,
      models: config.models,
      provider: config.provider,
      deep: config.deep,
      trace_raw: false,
    });
  } catch (error) {
    return { exitCode: 3, output: "", error: String(error?.message || error) };
  }

  const results = Array.isArray(batch?.results) ? batch.results : [];
  const admission = assessBatch(results, config.minScore);
  const decisions = admission.models.map((item) => item.admission);
  const report = buildReport({ baseUrl: config.baseUrl, minScore: config.minScore, results, decisions, deep: config.deep });
  const output = config.format === "json" ? formatJson(report) : config.format === "junit" ? formatJunit(report) : formatSummary(report);
  try {
    if (config.output) fs.writeFileSync(config.output, output, "utf8");
    else if (deps.write) deps.write(output);
  } catch (error) {
    return { exitCode: 2, output: "", error: `could not write output: ${error.message}` };
  }
  const hasEvaluationError = results.some((result) => result?.verdict === "error" || result?.error);
  return { exitCode: hasEvaluationError ? 3 : report.passed ? 0 : 1, output, report };
}

const invokedPath = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedPath) {
  const result = await runCli();
  if (result.output && !result.error && !process.argv.some((arg) => arg === "--output" || arg.startsWith("--output="))) process.stdout.write(result.output);
  if (result.error) process.stderr.write(`TokenTest: ${result.error}\n`);
  process.exitCode = result.exitCode;
}
