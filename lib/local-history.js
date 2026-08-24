export const HISTORY_STORAGE_KEY = "tokentest.local-history.v1";
const MAX_HISTORY = 20;
const SECRET_KEYS = /^(?:api[_-]?key|authorization|headers?|raw|request|response|trace[_-]?raw|captcha)$/i;

export function sanitizeHistoryReport(report = {}) {
  const safe = sanitize(report);
  return {
    generated_at: safe.generated_at || new Date().toISOString(),
    base_url: safe.base_url,
    min_score: safe.min_score,
    deep: Boolean(safe.deep),
    total: safe.total,
    passed_count: safe.passed_count,
    failed_count: safe.failed_count,
    error_count: safe.error_count,
    passed: Boolean(safe.passed),
    models: Array.isArray(safe.models) ? safe.models : [],
  };
}

export function listHistory(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

export function saveHistory(report, storage = globalThis.localStorage) {
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...sanitizeHistoryReport(report) };
  const entries = [entry, ...listHistory(storage)].slice(0, MAX_HISTORY);
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  return entry;
}

export function removeHistory(id, storage = globalThis.localStorage) {
  const entries = listHistory(storage).filter((item) => item.id !== id);
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  return entries;
}

export function clearHistory(storage = globalThis.localStorage) {
  storage.removeItem(HISTORY_STORAGE_KEY);
}

export async function exportHistory(storage = globalThis.localStorage, { BlobCtor = globalThis.Blob } = {}) {
  const text = `${JSON.stringify(listHistory(storage), null, 2)}\n`;
  if (BlobCtor) return new BlobCtor([text], { type: "application/json" });
  return text;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, child]) => [key, sanitize(child)]));
}
