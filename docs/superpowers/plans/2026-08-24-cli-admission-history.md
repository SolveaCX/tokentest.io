# CLI Admission and Local History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-preserving `tokentest evaluate` CLI with strict admission gates, JSON/JUnit/summary output, deterministic CI exit codes, and browser-local redacted report history while keeping `lib/evaluator.js` as the shared evaluation core.

**Architecture:** Add focused, dependency-free modules for CLI configuration, admission decisions, report formatting, and redaction. A small executable adapter invokes existing evaluator functions directly and never routes through Express. The existing browser script receives a localStorage history adapter and calls it only after completed runs.

**Tech Stack:** Node.js 20 ESM, existing evaluator and Express app, Node built-ins (`fs`, `path`, `process`), browser `localStorage`/`Blob`, Node test runner via existing `.mjs` scripts.

---

### Task 1: Define CLI configuration and admission policy contracts

**Files:**
- Create: `lib/cli-config.js`
- Create: `lib/admission.js`
- Test: `scripts/cli_contract_test.mjs`

- [ ] **Step 1: Write failing contract tests**

```js
import assert from "node:assert/strict";
import { parseCliArgs } from "../lib/cli-config.js";
import { assessAdmission } from "../lib/admission.js";

assert.deepEqual(parseCliArgs(["evaluate", "--model", "a,b", "--model", "c"]), {
  command: "evaluate", baseUrl: undefined, apiKey: undefined,
  models: ["a", "b", "c"], provider: undefined, minScore: 80,
  deep: false, format: "summary", output: undefined,
});

const pass = assessAdmission({ model: "a", score: 90, risk: { production_verdict: "production_reference_pass" }, verdict: "genuine" }, 80);
assert.equal(pass.ok, true);
const fail = assessAdmission({ model: "a", score: 90, risk: { production_verdict: "needs_review" }, verdict: "suspicious" }, 80);
assert.equal(fail.ok, false);
assert.match(fail.reasons.join(" "), /production_reference_pass/);
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `node scripts/cli_contract_test.mjs`

Expected: FAIL because `lib/cli-config.js` and `lib/admission.js` do not exist.

- [ ] **Step 3: Implement minimal configuration parsing and policy**

`parseCliArgs(argv, env = process.env)` must support `evaluate`, repeatable/comma-separated `--model`, command-line precedence over `TOKENTEST_*`, numeric `--min-score` in `0..100`, `--deep`, `--format summary|json|junit`, and `--output`. Throw an error with `exitCode = 2` for invalid configuration.

`assessAdmission(result, minScore)` returns `{ ok, reasons }`; reject evaluator errors, non-numeric/below-threshold scores, non-`production_reference_pass` risk verdicts, and critical evidence failures identified in `result.risk`, `result.compatibility`, `result.authenticity`, `result.usage`, or `result.error`.

- [ ] **Step 4: Run the contract test and verify it passes**

Run: `node scripts/cli_contract_test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the contract modules**

```bash
git add lib/cli-config.js lib/admission.js scripts/cli_contract_test.mjs
git commit -m "feat: add cli configuration and admission policy"
```

### Task 2: Add redaction and report formatters

**Files:**
- Create: `lib/cli-report.js`
- Test: `scripts/cli_report_test.mjs`

- [ ] **Step 1: Write failing formatter tests**

Test a normalized report containing a fake API key, `Authorization` header, raw probe evidence, one passing result, one admission failure, and one evaluator error. Assert JSON contains no secret, summary contains model/status/score, JUnit escapes `&`, `<`, and `>`, and failures/errors map to the correct elements.

- [ ] **Step 2: Run the formatter test and verify it fails**

Run: `node scripts/cli_report_test.mjs`

Expected: FAIL because `lib/cli-report.js` does not exist.

- [ ] **Step 3: Implement formatter and sanitizer**

Export `sanitizeResult`, `buildReport`, `formatSummary`, `formatJson`, and `formatJunit`. Sanitization recursively removes keys matching `api_key`, `authorization`, `headers`, `raw`, `request`, `response`, `trace_raw`, and secret-bearing endpoint credentials. Keep score, verdict, risk, usage summaries, dimensions, categories, and reasons needed for CI review. JUnit must produce one testcase per model and valid XML escaping.

- [ ] **Step 4: Run the formatter test and verify it passes**

Run: `node scripts/cli_report_test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit report formatting**

```bash
git add lib/cli-report.js scripts/cli_report_test.mjs
git commit -m "feat: add redacted cli report formats"
```

### Task 3: Add the executable CLI

**Files:**
- Create: `bin/tokentest.js`
- Modify: `package.json`
- Test: `scripts/cli_e2e_test.mjs`

- [ ] **Step 1: Write failing CLI tests with a local mock router**

Start an ephemeral HTTP server that implements `/v1/chat/completions` and returns deterministic evaluator-compatible responses. Spawn `node bin/tokentest.js evaluate ... --format json`, assert stdout parses, no key appears, and exit code is `0` for a passing fixture. Add a failing fixture asserting exit `1`, invalid arguments exit `2`, and an unreachable endpoint exit `3`.

- [ ] **Step 2: Run the CLI test and verify it fails**

Run: `node scripts/cli_e2e_test.mjs`

Expected: FAIL because the executable and package `bin` mapping do not exist.

- [ ] **Step 3: Implement the CLI adapter**

`bin/tokentest.js` must parse args, validate `evaluate`, call `evaluateBatch({ base_url, api_key, models, provider, deep, trace_raw: false })`, assess every result, build a sanitized report, write the selected format to `--output` or stdout, and set exit codes `0/1/2/3` exactly as specified. Never log the key. Set package metadata to publishable name/version and add `"bin": { "tokentest": "bin/tokentest.js" }` while preserving existing scripts.

- [ ] **Step 4: Run CLI tests and package checks**

Run: `node scripts/cli_e2e_test.mjs && npm pack --dry-run`

Expected: PASS and the dry-run includes `bin/tokentest.js`, evaluator modules, and package metadata without local research artifacts.

- [ ] **Step 5: Commit the executable**

```bash
git add bin/tokentest.js package.json scripts/cli_e2e_test.mjs
git commit -m "feat: add tokentest evaluate cli"
```

### Task 4: Add browser-local redacted history

**Files:**
- Create: `lib/local-history.js`
- Modify: `index.html`
- Test: `scripts/local_history_test.mjs`

- [ ] **Step 1: Write failing history tests**

Use a fake storage object and assert `saveHistory` stores at most 20 entries, strips API keys/headers/raw evidence, `listHistory` tolerates malformed JSON, `removeHistory` deletes one entry, `clearHistory` empties storage, and `exportHistory` returns a JSON Blob/string with no secret.

- [ ] **Step 2: Run the history test and verify it fails**

Run: `node scripts/local_history_test.mjs`

Expected: FAIL because the history module does not exist.

- [ ] **Step 3: Implement the storage adapter**

Export `HISTORY_STORAGE_KEY`, `sanitizeHistoryReport`, `listHistory`, `saveHistory`, `removeHistory`, `clearHistory`, and `exportHistory`. Accept a storage implementation and optional Blob constructor so Node tests do not require a browser. Preserve only display-safe report fields and timestamp/model labels.

- [ ] **Step 4: Integrate history controls into the existing UI**

In `index.html`, import the module through the existing browser-compatible script strategy (or inline the small adapter if module loading is incompatible), save only completed sanitized `BATCH` data after a run, render a local-history section with reopen, JSON export, and clear actions, and ensure API-key input is never included in saved objects. Keep current report links and language behavior intact.

- [ ] **Step 5: Run history and existing UI tests**

Run: `node scripts/local_history_test.mjs && npm run test:server && npm run test:e2e`

Expected: PASS; existing UI behavior remains intact.

- [ ] **Step 6: Commit local history**

```bash
git add lib/local-history.js index.html scripts/local_history_test.mjs
git commit -m "feat: add browser-local report history"
```

### Task 5: Full verification and documentation

**Files:**
- Modify: `README.md` (create if absent; otherwise add a concise CLI section)
- Modify: `docs/remote-mcp.md` only if shared report/redaction behavior needs clarification

- [ ] **Step 1: Add CLI usage documentation**

Document environment variables, strict admission semantics, output formats, exit codes, and the fact that `TOKENTEST_API_KEY` is read only by the process and never persisted.

- [ ] **Step 2: Run all regression tests**

Run: `npm test --if-present; node scripts/cli_contract_test.mjs; node scripts/cli_report_test.mjs; node scripts/cli_e2e_test.mjs; node scripts/local_history_test.mjs; npm run test:evaluator; npm run test:server; npm run test:mcp; npm run test:http-mcp; npm run test:trace-report; npm run test:readable-report`

Expected: every configured test exits `0`; if a pre-existing script is unavailable, record that fact rather than changing unrelated tooling.

- [ ] **Step 3: Inspect the final diff for secrets and scope**

Run: `git diff --check` and `rg -n "sk-[A-Za-z0-9]|Authorization:|TOKENTEST_API_KEY=.*" bin lib scripts README.md`.

Expected: no real credentials and no accidental persistence path.

- [ ] **Step 4: Commit documentation and verified final state**

```bash
git add README.md docs/remote-mcp.md
git commit -m "docs: document tokentest ci admission"
```
