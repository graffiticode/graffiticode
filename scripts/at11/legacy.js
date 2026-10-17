#!/usr/bin/env node
/* eslint-disable camelcase -- Learnosity's security fields are snake_case */
// AT-11, the legacy-key check (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "AT-11" and rollout step 6). The shared Learnosity consumer that L0158 and L0176 once held
// was retired at the provider on 2026-10-15. This is the evidence for "legacy provider
// credentials invalidated at the provider": requests signed with the retired consumer key
// and secret must be refused by Learnosity itself.
//
//   node scripts/at11/legacy.js --consumer <retired key> --secret-file <file> --domain <domain> [--out dir]
//
// Run once, by the operator, from a checkout with Broker's dependencies installed (it signs with
// learnosity-sdk-nodejs, as Broker does). Consumer, secret and domain have no defaults, and the
// secret is never written to evidence. Each request is a read, or a write of nothing, so if
// Learnosity wrongly accepted the key, nothing would change.

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeEvidence, parseArgs } from "./lib.js";

const DATA_API = "https://data.learnosity.com/v2025.2.LTS";

export const LEGACY_CASES = [
  { id: "data-read-items", route: "/itembank/items", action: "get", request: { limit: 1 } },
  { id: "data-read-sessions", route: "/sessions/responses", action: "get", request: { limit: 1 } },
  { id: "data-write-items", route: "/itembank/items", action: "set", request: { items: [] } },
];

// Learnosity's own refusal: its envelope with meta.status false, on an authentication status
// or naming the consumer, signature or credentials. Anything else (a network error, a 5xx, a
// 404 from a wrong route, an accepted request) proves nothing or is a failure.
export function judgeLegacy(response) {
  if (response.error) return { passed: false, why: `no answer (${response.error}): proves nothing` };
  const meta = response.body?.meta;
  if (meta?.status === true) return { passed: false, why: `ACCEPTED (${response.status}): the retired key still works` };
  if (meta?.status !== false) return { passed: false, why: `no Learnosity answer (${response.status}): proves nothing` };
  const message = String(meta.message ?? "");
  if ([401, 403].includes(response.status) || /consumer|signature|auth|credential|permission|key/i.test(message)) {
    return { passed: true, refusal: message || String(response.status) };
  }
  return { passed: false, why: `refused for another reason (${response.status} ${message}): proves nothing about the key` };
}

const sign = (sdk, { consumer, secret, domain }, request, action) =>
  sdk.init("data", { consumer_key: consumer, domain, user_id: `at11-${randomUUID()}` }, secret, request, action);

export async function runLegacy(creds, { sdk, doFetch = fetch } = {}) {
  for (const k of ["consumer", "secret", "domain"]) if (!creds?.[k]) throw new Error(`the legacy check needs ${k}`);
  if (!sdk) throw new Error("the legacy check needs Learnosity's SDK");
  const rows = [];
  for (const c of LEGACY_CASES) {
    const signed = sign(sdk, creds, c.request, c.action);
    let response;
    try {
      const res = await doFetch(`${DATA_API}${c.route}`, { method: "POST", body: new URLSearchParams(signed), signal: AbortSignal.timeout(15000) });
      let body = null;
      try { body = await res.json(); } catch {}
      response = { status: res.status, body: { meta: body?.meta } };
    } catch (e) {
      response = { error: e?.name ?? String(e) };
    }
    rows.push({ id: c.id, response, ...judgeLegacy(response) });
  }
  return { probe: "legacy", passed: rows.every(r => r.passed), rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--consumer", "--secret-file", "--domain", "--out"]);
  if (!args["--consumer"] || !args["--secret-file"] || !args["--domain"]) {
    throw new Error("usage: legacy.js --consumer <retired key> --secret-file <file> --domain <domain> [--out dir]");
  }
  const { default: LearnositySDK } = await import("learnosity-sdk-nodejs").catch(() => {
    throw new Error("learnosity-sdk-nodejs isn't installed: run from a checkout with Broker's dependencies (npm ci at the root)");
  });
  const creds = { consumer: args["--consumer"], secret: (await readFile(args["--secret-file"], "utf8")).trim(), domain: args["--domain"] };
  const result = { at: new Date().toISOString(), consumer: creds.consumer, ...(await runLegacy(creds, { sdk: new LearnositySDK() })) };
  const file = await writeEvidence(args["--out"], "legacy", "legacy", result);
  for (const r of result.rows) console.log(`${r.passed ? "refused" : "FAIL   "} ${r.id}${r.why ? ` — ${r.why}` : ""}`);
  console.log(`${result.passed ? "PASSED" : "FAILED"}; evidence: ${file}`);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
