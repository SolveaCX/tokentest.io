#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const match = html.match(/const MODEL_TIMEOUT_MS\s*=\s*\{([^}]+)\}/);
assert.ok(match, "index.html should define MODEL_TIMEOUT_MS");

const values = Object.fromEntries([...match[1].matchAll(/(\w+)\s*:\s*(\d+)/g)].map((item) => [item[1], Number(item[2])]));

assert.equal(values.quick >= 600_000, true, "quick text evaluations should wait at least 10 minutes per model");
assert.equal(values.truth >= 900_000, true, "truth/deep evaluations should wait at least 15 minutes per model");
assert.equal(values.cost >= 600_000, true, "cost evaluations should wait at least 10 minutes per model");

console.log("ok: frontend timeout config");
