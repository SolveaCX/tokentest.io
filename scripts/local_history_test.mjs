#!/usr/bin/env node
import assert from "node:assert/strict";
import { clearHistory, exportHistory, listHistory, removeHistory, saveHistory, sanitizeHistoryReport } from "../lib/local-history.js";

const storage = new Map();
const fakeStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
const report = { generated_at: "2026-08-24", models: [{ model: "a", result: { score: 90, api_key: "SECRET", headers: { authorization: "Bearer SECRET" }, raw: { prompt: "private" } } }] };
const safe = sanitizeHistoryReport(report);
assert.ok(!JSON.stringify(safe).includes("SECRET"));
assert.ok(!JSON.stringify(safe).includes("raw"));

for (let i = 0; i < 22; i += 1) saveHistory({ ...report, generated_at: `2026-08-${String(i + 1).padStart(2, "0")}` }, fakeStorage);
assert.equal(listHistory(fakeStorage).length, 20);
assert.equal(listHistory({ getItem: () => "bad json" }).length, 0);
const first = listHistory(fakeStorage)[0];
removeHistory(first.id, fakeStorage);
assert.equal(listHistory(fakeStorage).some((item) => item.id === first.id), false);
const exported = await exportHistory(fakeStorage, { BlobCtor: null });
assert.ok(!exported.includes("SECRET"));
clearHistory(fakeStorage);
assert.deepEqual(listHistory(fakeStorage), []);

console.log("ok: local report history redaction and retention");
