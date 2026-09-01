<div align="center">

<p align="right">
   <strong>English</strong> | <a href="./.github/README.cn.md">中文</a> | <a href="./.github/README.jp.md">日本語</a>
</p>

# TokenTest

### Prove the model, route, usage, and safety before production.

Black-box model verification for AI routers, procurement teams, and CI pipelines.

[Website](https://tokentest.io) · [Product Manual](https://tokentest.io/manual.html) · [Remote MCP](https://tokentest.io/docs/remote-mcp.md) · [GitHub](https://github.com/SolveaCX/tokentest.io)

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-supported-6e56cf)
![License](https://img.shields.io/badge/license-source--available-lightgrey)

<br>

🚀 **[Run TokenTest online →](https://tokentest.io)**

</div>

TokenTest is the production-reference evaluation layer for AI middle-layer buyers. It tests an OpenAI-compatible or Anthropic-style router from the outside, compares the model you requested with the model you actually received, audits token usage, probes safety and channel behavior, and turns the evidence into a production admission decision.

It is deliberately different from an AI gateway: TokenTest does not proxy your application traffic, manage provider keys, or claim to improve an upstream SLA. It helps you decide whether a route is trustworthy before you put it behind your gateway.

<div align="center">
  <img src="./assets/preview-run.png" width="760" alt="TokenTest evaluation console showing a production-reference report" />
</div>

## What can you do with TokenTest?

- Evaluate one model or a batch of models through the web console.
- Discover models exposed by an OpenAI-compatible `/models` endpoint.
- Detect silent model downgrades, protocol mismatches, suspicious usage numbers, and endpoint-level failures.
- Review six production-reference dimensions in one report: identity, deterministic output, channels, tokens, safety, and stability.
- Gate deployments from CI with `npx tokentest evaluate` and strict exit codes.
- Connect Claude Desktop, Cursor, VS Code, or another MCP client to `discover_models`, `evaluate_model`, and `evaluate_batch`.
- Export JSON, CSV, HTML, or JUnit evidence for procurement, release review, and incident follow-up.
- Keep browser history locally, with API keys and raw authorization evidence excluded from saved reports.

## Quickstart

### 1. Open the evaluation console

Visit [tokentest.io](https://tokentest.io), enter a router endpoint, a test-only upstream key, and one or more model IDs. You can click **discover models** when the router exposes `/models`, then start a quick or deep evaluation.

The browser sends probes to your configured router. TokenTest does not need a TokenTest account, and completed history stays in your browser's local storage.

### 2. Run a CI admission check

After publishing this package, run it directly with `npx`:

```bash
TOKENTEST_BASE_URL="https://api.example.com/v1" \
TOKENTEST_API_KEY="$MODEL_API_KEY" \
TOKENTEST_MODELS="model-a,model-b" \
npx tokentest evaluate \
  --min-score 80 \
  --format junit \
  --output tokentest.junit.xml
```

The command evaluates every requested model and applies strict admission. It exits `0` only when every model passes the score threshold, has `production_reference_pass`, has no critical identity/authentication/token gate failure, and completes without an evaluator error.

### 3. Run TokenTest locally

```bash
git clone https://github.com/SolveaCX/tokentest.io.git
cd tokentest.io
npm install
npm start
```

The console is available at `http://localhost:8080`. The local MCP server runs over stdio:

```bash
npm run mcp
```

## CLI reference

Command-line options override environment variables:

| Option | Environment variable | Description |
| --- | --- | --- |
| `--base-url <url>` | `TOKENTEST_BASE_URL` | Router base URL. |
| `--api-key <key>` | `TOKENTEST_API_KEY` | Upstream router/model key. Used in memory for this run only. |
| `--model <id>` | `TOKENTEST_MODELS` | Repeatable or comma-separated target model IDs. |
| `--provider openai\|anthropic` | `TOKENTEST_PROVIDER` | Optional protocol hint. |
| `--min-score 0..100` | `TOKENTEST_MIN_SCORE` | Minimum score; defaults to `80`. |
| `--deep` | — | Enable deeper coverage probes. |
| `--format summary\|json\|junit` | `TOKENTEST_FORMAT` | Output format; defaults to `summary`. |
| `--output <file>` | `TOKENTEST_OUTPUT` | Write the report to a file instead of stdout. |

Exit codes are designed for release gates:

| Code | Meaning |
| ---: | --- |
| `0` | Every requested model passed strict admission. |
| `1` | Evaluation completed, but one or more models failed admission. |
| `2` | Invalid or missing configuration, argument, format, or output path. |
| `3` | Evaluation could not complete, or a model returned an evaluator error. |

Reports are sanitized before they are printed or written. API keys, authorization headers, raw request/response payloads, and captcha tokens are not included.

## GitHub Actions

Use a repository or environment secret for the upstream key. JUnit output can be uploaded to the CI test-report UI; the non-zero exit code blocks the job when a model is not production-ready.

```yaml
name: model-admission

on:
  pull_request:
  workflow_dispatch:

jobs:
  verify-model-route:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Evaluate model route
        env:
          TOKENTEST_BASE_URL: ${{ secrets.MODEL_BASE_URL }}
          TOKENTEST_API_KEY: ${{ secrets.MODEL_API_KEY }}
          TOKENTEST_MODELS: claude-sonnet-4-6,gpt-4o-mini
        run: npx tokentest@latest evaluate --min-score 80 --format junit --output tokentest.junit.xml
      - name: Upload TokenTest evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: tokentest-evidence
          path: tokentest.junit.xml
```

## Six production-reference dimensions

The text evaluator scores six weighted dimensions. A high total score cannot override a production gate: P0/P1 failures and missing critical evidence remain visible in the risk verdict.

| Dimension | Weight | What it checks |
| --- | ---: | --- |
| **D1 · Identity & Protocol Integrity** | 30% | Requested vs resolved model, response shape, model registry, nonce replay, header provenance, and authentication compatibility. |
| **D2 · Output Discipline & Deterministic Tasks** | 30% | Strict JSON, multi-constraint following, language format, arithmetic, logic, code, tables, counterfactuals, and proof checks. |
| **D3 · Channel & Output Integrity** | 5% | Tool calls, vision, documents, web search, long output, streaming SSE, delta granularity, thinking fields, and stop signals. |
| **D4 · Token Usage Integrity** | 15% | Usage presence, total consistency, input monotonicity, output reasonableness, stop-limit linkage, stream usage, and cache evidence. |
| **D5 · Safety & Robustness** | 10% | Benign allow, prompt-injection resistance, secret protection, harmful-code boundaries, incomplete safety output, and error leakage. |
| **D6 · Stability, Reliability & Compliance** | 10% | Endpoint generation risks, P50/P95/P99 latency, TTFT, and short-run success rate. |

The result separates three related but different questions:

1. **Is this the model that was requested?** — identity and authenticity evidence.
2. **Can this endpoint be trusted for production workflows?** — compatibility score and risk gates.
3. **What should we do next?** — a concise reason, weak dimensions, evidence, and an admission verdict.

## Reports and evidence

Every completed run can be inspected in the console and exported:

- **JSON** — machine-readable report for downstream analysis and artifact storage.
- **CSV** — flattened dimension, category, case, scoring-standard, and evidence rows.
- **HTML** — portable report for procurement and review meetings.
- **JUnit** — one testcase per model for CI test-report integrations.

Reports distinguish an unscored evaluation error from a low model score. A timeout, authentication failure, network error, or unavailable endpoint is not silently converted into a `0` capability score.

## MCP Gateway integration

TokenTest exposes the same evaluator core through local stdio MCP and remote Streamable HTTP MCP.

### Available tools

- `discover_models` — list model IDs advertised by an OpenAI-compatible router.
- `evaluate_model` — return one model's D1-D6 dimensions, risk gates, coverage audit, usage evidence, and redacted probe evidence.
- `evaluate_batch` — evaluate several models and return per-model results plus a batch summary.

### Remote MCP smoke test

```bash
curl -sS https://tokentest.io/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <MCP_ACCESS_TOKEN>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Production deployments can require `MCP_ACCESS_TOKEN` or intentionally enable public, rate-limited mode with `MCP_PUBLIC_MODE=1`. Public mode caps batch size, disables deep evaluation, blocks private-network URLs by default, and redacts authorization evidence. See [docs/remote-mcp.md](docs/remote-mcp.md) for the complete policy and tool schema.

## Supported routes and modalities

| Area | Current support |
| --- | --- |
| Text protocol | OpenAI-compatible `/chat/completions`; Anthropic-style message protocol through the evaluator's provider selection. |
| Model discovery | OpenAI-compatible `GET /models`. |
| Streaming | SSE response and stream usage checks where the upstream route supports them. |
| Tools | Function/tool-call capability probes. |
| Vision | Image input capability probes in the visual evaluator. |
| Documents | Inline document/context probes. |
| Image and video | Dedicated web-console visual evaluation flows with core and optional cases. |
| Providers | Provider hints for `openai` and `anthropic`; model IDs are evaluated through the configured router rather than hard-coded provider credentials. |

TokenTest is compatible with gateways and relays that expose these behaviors. It does not require the upstream provider to be hosted by TokenTest.

## Architecture

```mermaid
flowchart LR
  A[Web Console] --> B[TokenTest HTTP API]
  C[\`npx tokentest\`] --> D[Evaluator Core]
  E[MCP stdio / HTTP] --> D
  B --> D
  D --> F[Configured Router]
  D --> G[6D Scoring + Risk Gates]
  G --> H[JSON / CSV / HTML / JUnit]
  A --> I[Browser-local history]
```

The evaluator core is shared by the browser API, MCP tools, and CLI. The CLI does not proxy through Express, so CI can run the same probes without a TokenTest account or server-side report storage.

## Privacy and security

- Upstream API keys are supplied per run and are not written to browser history or CLI reports.
- Standard remote MCP evidence redacts authorization values before returning traces.
- Public MCP mode applies origin checks, request limits, tool limits, batch caps, and private-network URL blocking.
- Browser history is local-only and supports export or deletion; there is no server sync in the MVP.
- For self-hosted deployments, keep `EVAL_TRACE_RAW=0` in production unless raw traces are explicitly required and the trace directory is access-controlled.
- Use a test-only upstream key whenever possible and apply the upstream provider's own spending and network policies.

## Roadmap

The current product is an evaluation and admission layer. The following gateway-adjacent capabilities are intentionally future work rather than implied functionality:

- scheduled regression runs and long-term trend dashboards;
- provider pricing and cost-aware route comparison;
- configurable fallback/retry recommendations based on observed evidence;
- team workspaces, RBAC, and shared report storage;
- policy packs and organization-specific admission rules;
- richer audio/realtime coverage and provider-specific adapters.

## Development

```bash
npm install
npm start                 # web console + HTTP API on :8080
npm run mcp              # local stdio MCP server

npm run test:evaluator
npm run test:server
npm run test:mcp
npm run test:http-mcp
npm run test:e2e
npm run test:visual
```

The CLI and local-history contracts can also be run directly:

```bash
node scripts/cli_contract_test.mjs
node scripts/cli_report_test.mjs
node scripts/cli_e2e_test.mjs
node scripts/local_history_test.mjs
```

## Contributing

Issues and pull requests are welcome. When changing scoring behavior, add or update a deterministic fixture and explain whether the change affects authenticity, production compatibility, or optional channel evidence. Do not include real API keys, raw authorization headers, or provider customer data in fixtures, reports, screenshots, or pull requests.

Before opening a pull request, run the relevant evaluator, server, MCP, CLI, and UI tests and include the results in the description.

## License

This repository is currently source-available. A formal license file and contribution policy will be added before publishing a public package release.
