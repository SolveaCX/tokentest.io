const CRITICAL_CATEGORY_KEYS = new Set([
  "llm_fingerprint", "model_registry", "auth_compatibility", "token_audit", "token_total_consistency",
]);

export function assessAdmission(result = {}, minScore = 80) {
  const reasons = [];
  if (result.error || result.verdict === "error") reasons.push(`evaluation error: ${result.error || "unknown error"}`);
  const score = Number(result.score);
  if (!Number.isFinite(score)) reasons.push("score is missing");
  else if (score < minScore) reasons.push(`score ${score} is below minimum ${minScore}`);
  if (result.risk?.production_verdict !== "production_reference_pass") {
    reasons.push(`risk production_verdict must be production_reference_pass (got ${result.risk?.production_verdict || "missing"})`);
  }
  if (Number(result.risk?.p0_fail_count) > 0) reasons.push(`${result.risk.p0_fail_count} P0 gate failure(s)`);
  if (Number(result.risk?.p1_fail_count) > 0) reasons.push(`${result.risk.p1_fail_count} P1 gate failure(s)`);
  for (const category of result.categories || []) {
    if (CRITICAL_CATEGORY_KEYS.has(category.key) && category.status === "fail") reasons.push(`critical evidence failed: ${category.key}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function assessBatch(results = [], minScore = 80) {
  const models = results.map((result) => ({ model: result.requested_model || result.model || "", admission: assessAdmission(result, minScore) }));
  return { ok: models.every((item) => item.admission.ok), models };
}
