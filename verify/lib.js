// Shared helpers for candidate verify modules (deploy.json `verify.module`).
//
// Verify modules run on the deployer's machine, loaded from the release's
// source snapshot, so they may import only Node built-ins and other files in
// the repo (never node_modules). Every check that expects a denial asserts the
// status AND the message, so an authentication failure can never pass for an
// authorization check.

import { createPublicKey } from "node:crypto";

export class VerifyError extends Error {}

export const check = (condition, message) => {
  if (!condition) throw new VerifyError(message);
};

// A candidate's tag URL is created seconds before verify runs, and Google's
// front end learns new tag routes gradually: until then a request can be
// answered by the front end itself with an HTML "Error: Page not found" 404
// that never reached the container. That one response is retried briefly;
// anything the service itself returns (JSON, or any other status) is not.
const isRoutingNotFound = (status, text) => status === 404 && /Error: Page not found/.test(text) && /<html/i.test(text);
const ROUTING_RETRIES = 6;
const ROUTING_DELAY_MS = 2000;

// One request against the candidate. Never follows redirects; times out.
export const request = async ({ fetch, base, path, method = "GET", headers = {}, body, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const url = new URL(path, base);
  check(url.origin === base.origin, `verify request must stay on the candidate origin: ${path}`);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (isRoutingNotFound(response.status, text) && attempt < ROUTING_RETRIES) {
      await sleep(ROUTING_DELAY_MS);
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, attempts: attempt + 1 };
  }
};

export const expectError = (label, res, status, message) => {
  check(res.status === status && res.json?.error?.message === message,
    `${label}: expected ${status} "${message}", got ${res.status} ${JSON.stringify(res.json?.error ?? res.text.slice(0, 200))}`);
};

// A Google-signed ID token for an impersonated service account. The deployer
// must be allowed to impersonate it (the same grant private smoke checks use).
export const identityToken = async (cloud, account, audience) =>
  String(await cloud(["auth", "print-identity-token", `--impersonate-service-account=${account}`, `--audiences=${audience}`, "--include-email"], { json: false })).trim();

// The public JWK (kty/crv/x/y) of a KMS key version, read with the deployer's
// credentials.
export const kmsPublicJwk = async (cloud, keyVersionName) => {
  const m = /^projects\/[^/]+\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/(\d+)$/.exec(keyVersionName);
  check(m, `not a KMS key version name: ${keyVersionName}`);
  const [, location, keyring, key, version] = m;
  const pem = await cloud(["kms", "keys", "versions", "get-public-key", version, `--key=${key}`, `--keyring=${keyring}`, `--location=${location}`, "--output-file=/dev/stdout"], { json: false });
  const { kty, crv, x, y } = createPublicKey(String(pem)).export({ format: "jwk" });
  return { kty, crv, x, y };
};

// Both private services identify the caller before anything else
// (packages/policy/src/caller.js): a request with no X-Caller-Identity is 401,
// and a valid Google-signed identity that is not in the callers map is 403
// "unknown caller". deploy-smoke is never a registered caller, so these prove
// the candidate verifies real tokens and loaded its callers map, without
// granting the verifier any authority.
export const callerDenials = async ({ fetch, candidateUrl: base, headers, config, cloud, log }, { path, audience, body }) => {
  const missing = await request({ fetch, base, path, method: "POST", headers, body });
  expectError(`${path} without X-Caller-Identity`, missing, 401, "missing X-Caller-Identity");
  const callerIdentity = await identityToken(cloud, config.smokeServiceAccount, audience);
  const unknown = await request({ fetch, base, path, method: "POST", headers: { ...headers, "X-Caller-Identity": callerIdentity }, body });
  expectError(`${path} as unregistered ${config.smokeServiceAccount}`, unknown, 403, "unknown caller");
  log(`  ${path}: 401 without caller identity, 403 for an unregistered caller`);
};

// The candidate's protected-execution switch (@graffiticode/policy
// maintenance.js): it must answer, and when the operator sets
// GC_VERIFY_PROTECTED_EXECUTION to "on" or "off" the state must match, so both
// states can be verified on a candidate during a release window.
export const protectedExecutionState = async ({ fetch, candidateUrl: base, headers, log }, expected = process.env.GC_VERIFY_PROTECTED_EXECUTION) => {
  check(expected === undefined || expected === "" || expected === "on" || expected === "off",
    `GC_VERIFY_PROTECTED_EXECUTION must be on or off, not ${JSON.stringify(expected)}`);
  const res = await request({ fetch, base, path: "/v1/protected-execution", headers });
  check(res.status === 200 && typeof res.json?.enabled === "boolean" && typeof res.json?.source === "string",
    `/v1/protected-execution: expected { enabled, source }, got ${res.status}`);
  const { enabled, source } = res.json;
  if (expected === "on" || expected === "off") {
    check(enabled === (expected === "on"), `/v1/protected-execution: expected ${expected}, got ${enabled ? "on" : "off"} (${source})`);
  }
  log(`  /v1/protected-execution: ${enabled ? "on" : "off"} (${source})`);
  return { enabled, source };
};
