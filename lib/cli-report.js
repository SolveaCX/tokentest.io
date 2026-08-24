const SECRET_KEYS = /(?:api[_-]?key|authorization|headers?|raw|request|response|trace[_-]?raw|captcha|token)/i;

export function sanitizeResult(value) {
  return sanitizeValue(value, "");
}

export function buildReport({ baseUrl, minScore, results = [], decisions = [], startedAt = new Date().toISOString(), deep = false } = {}) {
  const rows = results.map((result, index) => {
    const decision = decisions[index] || { ok: false, reasons: ["admission decision missing"] };
    return {
      model: result.requested_model || result.model || "",
      passed: Boolean(decision.ok),
      reasons: [...(decision.reasons || [])],
      result: sanitizeResult(result),
    };
  });
  return {
    version: 1,
    generated_at: startedAt,
    base_url: redactUrl(baseUrl),
    min_score: minScore,
    deep: Boolean(deep),
    total: rows.length,
    passed_count: rows.filter((row) => row.passed).length,
    failed_count: rows.filter((row) => !row.passed && row.result?.verdict !== "error").length,
    error_count: rows.filter((row) => row.result?.verdict === "error" || row.result?.error).length,
    passed: rows.length > 0 && rows.every((row) => row.passed),
    models: rows,
  };
}

export function formatJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSummary(report) {
  const lines = [`TokenTest ${report.passed ? "PASS" : "FAIL"} · ${report.passed_count}/${report.total} admitted · minimum score ${report.min_score}`];
  for (const row of report.models) {
    const score = row.result?.score ?? "—";
    const status = row.passed ? "PASS" : row.result?.verdict === "error" ? "ERROR" : "FAIL";
    const reasons = row.reasons.length ? ` — ${row.reasons.join("; ")}` : "";
    lines.push(`${status} ${row.model} · score ${score}${reasons}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatJunit(report) {
  const cases = report.models.map((row) => {
    const name = xml(row.model);
    const time = Number(row.result?.latency_ms) > 0 ? (Number(row.result.latency_ms) / 1000).toFixed(3) : "0";
    if (row.result?.verdict === "error" || row.result?.error) {
      return `    <testcase name="${name}" time="${time}"><error message="${xml(row.reasons.join("; "))}">${xml(row.result?.summary || row.result?.error || "evaluation error")}</error></testcase>`;
    }
    if (!row.passed) {
      return `    <testcase name="${name}" time="${time}"><failure message="${xml(row.reasons.join("; "))}">${xml(row.result?.summary || "admission failed")}</failure></testcase>`;
    }
    return `    <testcase name="${name}" time="${time}"/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="TokenTest admission" tests="${report.total}" failures="${report.failed_count}" errors="${report.error_count}">\n${cases}\n</testsuite>\n`;
}

function sanitizeValue(value, parentKey) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, parentKey));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue;
    result[key] = sanitizeValue(child, key);
  }
  return result;
}

function redactUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).replace(/\/\/[^/@\s]+:[^/@\s]+@/, "//");
  }
}

function xml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
