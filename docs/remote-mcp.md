# TokenTest Remote MCP

TokenTest exposes the same evaluator tools through two MCP entry points:

- Local stdio: `node mcp-server.js`
- Remote HTTP: `POST https://tokentest.io/mcp`

## Remote Endpoint

The remote endpoint uses MCP Streamable HTTP and returns JSON responses.

Production can run in either private-token mode or public rate-limited mode.

Private-token mode environment variables:

- `MCP_ACCESS_TOKEN`: Bearer token required by remote MCP clients.
- `MCP_ALLOWED_ORIGINS`: comma-separated allowed browser origins. Defaults to `https://tokentest.io,https://www.tokentest.io`.

Optional environment variables:

- `MCP_ALLOW_PRIVATE_BASE_URLS=1`: allows remote MCP tools to evaluate private or localhost router URLs. Keep this off in production unless the deployment is private.
- `MCP_PUBLIC_MODE=1`: allows remote MCP clients to call `/mcp` without a TokenTest access token. This should be paired with the public rate-limit variables below.
- `MCP_PUBLIC_MAX_BATCH_MODELS`: max models per public `evaluate_batch` call. Default: `5`.
- `MCP_RATE_LIMIT_WINDOW_MS`: public request window. Default: `600000` (10 minutes).
- `MCP_RATE_LIMIT_MAX_REQUESTS`: max public MCP requests per IP per request window. Default: `120`.
- `MCP_RATE_LIMIT_TOOL_WINDOW_MS`: public tool-call window. Default: `3600000` (1 hour).
- `MCP_RATE_LIMIT_DISCOVER`: max public `discover_models` calls per IP per tool window. Default: `60`.
- `MCP_RATE_LIMIT_EVALUATE`: max public `evaluate_model` calls per IP per tool window. Default: `20`.
- `MCP_RATE_LIMIT_BATCH`: max public `evaluate_batch` calls per IP per tool window. Default: `4`.

Production and Railway deployments refuse `/mcp` with `503` until either `MCP_ACCESS_TOKEN` is configured or `MCP_PUBLIC_MODE=1` is enabled. Local development may run without either setting.

In public mode:

- No TokenTest MCP access token is required.
- Browser callers are still restricted by `MCP_ALLOWED_ORIGINS`.
- Private-network and localhost `base_url` values are blocked unless `MCP_ALLOW_PRIVATE_BASE_URLS=1`.
- `deep` evaluation is forced off.
- `evaluate_batch` is capped by `MCP_PUBLIC_MAX_BATCH_MODELS`.
- Request and tool-call limits are enforced per client IP with HTTP `429` JSON-RPC errors.

Recommended public defaults are intentionally moderate rather than tiny: a normal user can discover models, evaluate individual models repeatedly, or run up to about 20 model evaluations per hour through four 5-model batches. Larger partner or internal workloads should use private-token mode and can be protected by gateway-level limits instead.

Abuse controls used by the public endpoint:

- Per-IP request bucket for MCP protocol chatter (`initialize`, `tools/list`, etc.).
- Per-IP tool buckets for expensive operations.
- Batch-size cap to prevent traffic amplification.
- Private-network URL blocking to reduce SSRF risk.
- Forced non-deep evaluation to keep anonymous runs bounded.
- Authorization evidence redaction in returned probe traces.

## Tools

- `discover_models`: lists model ids from an OpenAI-compatible router.
- `evaluate_model`: evaluates one model and returns TokenTest scores, D1-D6 dimensions, coverage audit, risk gates, category results, usage evidence and redacted probe evidence.
- `evaluate_batch`: evaluates multiple models and returns per-model D1-D6 results plus a batch summary.

Tool calls require the evaluated router's `base_url`, `api_key`, and model information. This `api_key` is the user's upstream router/model key, not a TokenTest account key. It is supplied per call and is not stored by the MCP server. Remote MCP responses keep raw Authorization evidence redacted.

The MCP output uses the same report schema as the user-visible page:

- `dimensions`: six production-reference dimensions, ordered D1-D6.
- `dimension_coverage`: tested/pass/partial/fail/skipped coverage audit.
- `pack_results` and `categories`: backward-compatible detailed category data.
- `evidence`: request/response probe evidence, with Authorization redacted for remote MCP.

## Scoring and SLA Evidence

TokenTest separates production SLA evidence from model-capability scoring.
It does not guarantee the upstream model provider's or router operator's SLA.
If a provider advertises an availability target such as 99.9%, treat the contract,
status page, or service terms as the source of truth. TokenTest reports provide
pre-production and spot-check evidence that can be attached to procurement,
integration, and incident-review workflows.

The current text-model D1-D6 weights are:

| Dimension | Weight | Notes |
| --- | ---: | --- |
| D1 Identity & Protocol Integrity | 30 | Model identity, protocol shape, nonce replay, headers and auth compatibility. |
| D2 Output Discipline & Deterministic Tasks | 30 | Strict JSON, instruction constraints, language format and visible-answer reliability for deterministic reasoning tasks. |
| D3 Channel & Output Integrity | 5 | Tool, vision, document, web search, long output, streaming and finish-signal coverage; optional channel misses are weak evidence by default. |
| D4 Token Usage Integrity | 15 | Usage presence, total consistency, input monotonicity, output ratio, stop-limit and cache evidence. |
| D5 Safety & Robustness | 10 | Benign allow, prompt-injection resistance, secret protection, harmful-code boundary and error leakage. |
| D6 Stability, Reliability & Compliance | 10 | Endpoint generation risks, latency distribution, TTFT and short-run success rate. |

D6 includes SLA-adjacent evidence:

- `endpoint_generation_truncation`: multiple high-risk failures share length-limited or incomplete-generation evidence and are counted once as endpoint compatibility/truncation risk.
- `endpoint_generation_unavailable`: multiple GLM-compatible endpoint failures share availability or compatibility evidence, such as `get_channel_failed` or error code `1210`, and are counted once as endpoint availability risk.
- `latency_p50`, `latency_p95`, `latency_p99`, `latency_ttft`, and `latency_success_rate`: short-run latency and success-rate samples for production-readiness review.

If an evaluation row does not complete because of timeout, auth, network, or
endpoint-level errors, user-facing exports may set `score` and `raw_score` to
`null`. Treat this as "not scored" rather than a low model score. Batch averages
exclude unscored rows.

## Smoke Test

Private-token mode:

```bash
curl -sS https://tokentest.io/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <MCP_ACCESS_TOKEN>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Public rate-limited mode:

```bash
curl -sS https://tokentest.io/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Evaluate one model:

```bash
curl -sS https://tokentest.io/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{
      "name":"evaluate_model",
      "arguments":{
        "base_url":"https://your-router.example",
        "api_key":"<UPSTREAM_ROUTER_API_KEY>",
        "model":"claude-opus-4-8",
        "provider":"anthropic"
      }
    }
  }'
```
