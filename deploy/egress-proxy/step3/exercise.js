#!/usr/bin/env node
// ISOLATE-01 rollout step 3: exercises a staged compiler candidate (no traffic, on the compiler
// network) along each of its outbound paths, so the proxy's log shows everything it reaches
// and refusals.js lists everything it was refused. Plan: ~/.claude/plans/
// isolate-01-compiler-egress.md, step 3.
//
//   node deploy/egress-proxy/step3/exercise.js --url <candidate tag URL> --lang 0000 \
//     --cases languages/l0000/crates/core/tests/conformance/cases.json [--proxy http://10.8.0.2:3128] [--limit N]
//
// With the operator's gcloud credentials:
//   - /, /lexicon.js, and /egress (the bootstrap installed, with the expected proxy);
//   - /compile for each conformance case, as the verify account (verify-api-key, exchanged at
//     auth): auth.graffiticode.org token verification, and the schema fetch from
//     api.graffiticode.org;
//   - /preflight as the gateway (an api-run ID token for urn:graffiticode:<lang>, minted with
//     the IAM Credentials API): Google's certs from www.googleapis.com, and Policy.
// Prints one JSON summary, with the run's window for `refusals.js --since`.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const base = arg("--url");
const lang = String(arg("--lang", "")).replace(/^L/i, "").padStart(4, "0");
const casesFile = arg("--cases");
const proxy = arg("--proxy", "http://10.8.0.2:3128");
const limit = Number(arg("--limit", "0")) || Infinity;
if (!base || !casesFile || !/^\d{4}$/.test(lang)) {
  console.error("usage: exercise.js --url <candidate URL> --lang <NNNN> --cases <cases.json> [--proxy URL] [--limit N]");
  process.exit(2);
}

const gcloud = (...a) => execFileSync("gcloud", a, { encoding: "utf8" }).trim();
const authUrl = "https://auth.graffiticode.org";
const startedAt = new Date().toISOString();
const result = { url: base, lang, startedAt, checks: {} };
const record = (name, ok, detail = {}) => { result.checks[name] = { ok, ...detail }; };

async function http(method, path, { headers = {}, body } = {}) {
  const res = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 1. Health and the bootstrap.
for (const p of ["/", "/lexicon.js"]) {
  const r = await http("GET", p);
  record(`GET ${p}`, r.status === 200, { status: r.status });
}
{
  const r = await http("GET", "/egress");
  const ok = r.status === 200 && r.json?.installed === true && (r.json.httpsProxy ?? r.json.httpProxy) === proxy;
  record("GET /egress", ok, { status: r.status, report: r.json });
}

// 2. The verify account's token (auth.graffiticode.org), then the corpus.
const key = gcloud("secrets", "versions", "access", "latest", "--secret=verify-api-key", "--project=graffiticode");
const exchange = await fetch(`${authUrl}/authenticate/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: key }) });
const token = (await exchange.json())?.data?.accessToken;
record("verify token", Boolean(token), { status: exchange.status });

const cases = JSON.parse(await readFile(casesFile, "utf8")).slice(0, limit);
let matched = 0; let answered = 0; let failed = 0;
const failures = [];
for (const [i, c] of cases.entries()) {
  const r = await http("POST", "/compile", { headers: token ? { Authorization: token } : {}, body: { code: c.ast, data: c.data ?? {} } });
  if (r.status !== 200) { failed++; if (failures.length < 5) failures.push({ case: i, status: r.status, body: r.text.slice(0, 200) }); continue; }
  answered++;
  const got = r.json?.data !== undefined ? r.json.data : r.json;
  if (c.expect && "data" in c.expect && JSON.stringify(got) === JSON.stringify(c.expect.data)) matched++;
}
record("POST /compile corpus", failed === 0, { cases: cases.length, answered, matchedExpected: matched, failed, failures });

// 3. Preflight as the gateway: an api-run ID token for this language's audience.
const operator = gcloud("auth", "print-access-token");
const mint = await fetch("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/api-run@graffiticode.iam.gserviceaccount.com:generateIdToken", {
  method: "POST",
  headers: { Authorization: `Bearer ${operator}`, "content-type": "application/json" },
  body: JSON.stringify({ audience: `urn:graffiticode:${lang}`, includeEmail: true }),
});
const gatewayToken = (await mint.json())?.token;
record("gateway token", Boolean(gatewayToken), { status: mint.status });
if (gatewayToken) {
  const r = await http("POST", "/preflight", { headers: { "X-Caller-Identity": gatewayToken }, body: { stage: "s1", lang, code: cases[0].ast } });
  record("POST /preflight (gateway)", r.status === 200 && r.json?.status === "success", { status: r.status, body: r.text.slice(0, 300) });
}

result.endedAt = new Date().toISOString();
result.passed = Object.values(result.checks).every(c => c.ok);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
