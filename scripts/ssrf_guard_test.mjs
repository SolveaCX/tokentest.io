import assert from "node:assert/strict";
import { assertRemoteBaseUrlAllowed } from "../lib/mcp-tools.js";

for (const baseUrl of [
  "http://127.0.0.1:8080/v1",
  "http://169.254.169.254/latest",
  "http://192.168.1.10/v1",
]) {
  await assert.rejects(
    () => assertRemoteBaseUrlAllowed(baseUrl),
    /does not allow private-network base_url|does not allow localhost base_url/,
    `${baseUrl} must be rejected by the SSRF guard`,
  );
}

await assert.rejects(
  () => assertRemoteBaseUrlAllowed("file:///etc/passwd"),
  /base_url must be http\(s\)/,
);

console.log("ok: SSRF guard rejects private and non-http base URLs");
