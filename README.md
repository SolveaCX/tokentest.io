# TokenTest

TokenTest is a black-box production-reference evaluator for AI routers and model endpoints. It checks model identity, protocol behavior, token usage, safety boundaries, and channel reliability without storing the upstream API key.

## CI admission with `npx tokentest`

The package exposes an `evaluate` command that can run locally or in CI. The key is read into the process for the duration of the evaluation and is never written to a report or TokenTest storage.

```bash
TOKENTEST_BASE_URL="https://api.example.com/v1" \
TOKENTEST_API_KEY="$MODEL_API_KEY" \
TOKENTEST_MODELS="model-a,model-b" \
npx tokentest evaluate --min-score 80 --format junit --output tokentest.junit.xml
```

Command-line options override environment variables:

- `--base-url`, `TOKENTEST_BASE_URL`: OpenAI-compatible router base URL.
- `--api-key`, `TOKENTEST_API_KEY`: upstream router/model key.
- `--model` (repeatable or comma-separated), `TOKENTEST_MODELS`: models to evaluate.
- `--provider openai|anthropic`, `TOKENTEST_PROVIDER`: optional protocol hint.
- `--min-score 0..100`, `TOKENTEST_MIN_SCORE`: minimum score, default `80`.
- `--deep`: run deeper evaluation coverage.
- `--format summary|json|junit`, `TOKENTEST_FORMAT`: output format, default `summary`.
- `--output <file>`, `TOKENTEST_OUTPUT`: write the report to a file.

Admission is intentionally strict. Every model must meet the score threshold, receive `production_reference_pass`, avoid P0/P1 gates and critical identity/authentication/token evidence failures, and complete without an evaluator error.

Exit codes are suitable for release gates:

- `0`: every model passed strict admission;
- `1`: evaluation completed but at least one model failed admission;
- `2`: invalid or missing configuration/output settings;
- `3`: evaluation could not complete or a model returned an evaluator error.

JSON and JUnit reports are sanitized before output. Authorization values, API keys, raw request/response evidence, and captcha data are removed. The browser UI keeps completed report history only in local browser storage and provides local export and deletion; it does not sync history to the server.
