# TokenTest CLI Admission and Local History Design

## Goal

Extend TokenTest from a browser-based black-box evaluation console into a lightweight model-admission workflow for two MVP audiences:

- procurement and platform teams deciding whether a router/model can enter production;
- developers and CI systems preventing model, routing, protocol, or usage regressions from reaching production.

The product remains privacy-first: API keys are used only during an evaluation and are never persisted by TokenTest. Browser history remains local to the browser.

## Scope

This MVP adds:

- a publishable `tokentest` CLI executable, usable through `npx tokentest` after the package is published;
- an `evaluate` command for one or more models;
- environment-variable configuration suitable for CI secrets;
- JSON, JUnit XML, and concise human-summary output;
- a strict admission policy with deterministic process exit codes;
- browser-local, redacted evaluation history with export and deletion.

It does not add accounts, server-side report storage, hosted scheduling, provider routing, gateway proxying, RBAC, or a new billing system.

## Architecture

`lib/evaluator.js` remains the sole evaluation core. Its existing public functions, including `evaluateModel`, `evaluateBatch`, and model discovery, continue to power the HTTP routes and MCP tools.

The CLI is a thin adapter around that core. It parses configuration, invokes the evaluator directly without Express, applies the admission policy, formats the result, and assigns an exit code. This ensures browser, MCP, and CI assessments use the same probes and scoring model.

The browser stores only sanitized completed report data in `localStorage`. The browser history layer removes API keys, authorization headers, raw headers, and raw request/response evidence before persistence. It does not change the server's no-storage behavior.

## Command Interface

The public command is:

```bash
npx tokentest evaluate \
  --base-url "$MODEL_BASE_URL" \
  --api-key "$MODEL_API_KEY" \
  --model claude-sonnet-4-6 \
  --min-score 80 \
  --format json
```

Options:

| Option | Meaning |
| --- | --- |
| `--base-url <url>` | Router base URL. Required unless supplied by `TOKENTEST_BASE_URL`. |
| `--api-key <key>` | Upstream router key. Required unless supplied by `TOKENTEST_API_KEY`. It is never rendered in reports. |
| `--model <id>` | Target model. Repeatable and comma-separated values are supported. Required unless `TOKENTEST_MODELS` is supplied. |
| `--provider <openai|anthropic>` | Optional protocol override. Otherwise the evaluator's existing provider behavior is retained. |
| `--min-score <0-100>` | Minimum score for every target. Defaults to `80`; `TOKENTEST_MIN_SCORE` supplies a default. |
| `--deep` | Enables the evaluator's deeper coverage probes. |
| `--format <summary|json|junit>` | Output type. Defaults to `summary`. |
| `--output <file>` | Writes formatted output to a file instead of standard output. |

Command-line options override environment variables. The documented CI variables are `TOKENTEST_BASE_URL`, `TOKENTEST_API_KEY`, `TOKENTEST_MODELS`, and `TOKENTEST_MIN_SCORE`.

## Admission Policy

The MVP uses strict admission only. Every evaluated model must satisfy all conditions:

1. its numeric score is at least `min_score`;
2. `risk.production_verdict` equals `production_reference_pass`;
3. the evaluator result is not an error or interrupted result;
4. it contains no evaluator-produced critical blocker, including identity mismatch, authentication bypass, or missing/inconsistent token-usage evidence.

The CLI reports each failed predicate and the evaluator's available primary reasons. A batch passes only when every model passes. This deliberately favors a safe release gate over a permissive comparison score.

## Output Contract

Every format represents the same normalized admission result, containing the evaluation timestamp, configuration safe to disclose, configured threshold, per-model evaluator results, admission decision, and failure reasons. API keys, authorization values, and sensitive raw evidence are removed before formatting.

- `summary` is a compact console table/list for engineers.
- `json` is a stable machine-readable object for artifact storage and downstream automation.
- `junit` emits a `testsuite` whose test cases map one-to-one to target models. Admission failures are `<failure>` elements; evaluator execution failures are `<error>` elements.

Writing to `--output` creates or replaces exactly the named report file. Standard output is reserved for the selected report format; diagnostics go to standard error.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Every requested model passed strict admission. |
| `1` | Evaluation completed, but one or more models failed strict admission. |
| `2` | Invalid or missing command configuration, such as a malformed URL, absent key, model list, invalid score, or unsupported format. |
| `3` | Evaluation could not complete, such as an upstream network failure, authentication failure, or timeout. |

## Browser-local History

After a completed browser run, TokenTest adds a redacted report summary to a bounded `localStorage` history collection. The user can reopen a prior report, export it as JSON, or clear all local history. The UI explicitly identifies this as browser-local data and never offers a server sync.

History contains report content already safe for display, plus timestamp and requested model labels. It excludes API keys, endpoints with embedded credentials, authorization headers, captcha tokens, raw probe inputs, and raw probe outputs. Existing direct report links continue to work independently of local history.

## Error Handling

- CLI validation fails before any upstream request when required configuration is absent or invalid.
- Any evaluated model producing an evaluator error makes the process exit `3`, while still emitting a report for completed model results where possible.
- Output write failures surface as configuration/runtime diagnostics and never print a partial report as if it succeeded.
- The browser treats unavailable or malformed local history as empty and permits the current evaluation to continue.

## Verification

New deterministic tests will cover:

- command parsing, repeated/comma-separated model values, and CLI-over-environment precedence;
- strict admission predicates and batch-level decisions;
- JSON and JUnit report shape, XML escaping, and exit codes;
- key and raw-evidence redaction;
- browser local-history write, read, export, bounded retention, and deletion behavior.

Existing evaluator, server, MCP, HTTP MCP, report, and browser UI tests remain regression gates. No live upstream key is necessary for automated verification. A user-provided key is only needed for an optional final manual smoke test against a real router.
