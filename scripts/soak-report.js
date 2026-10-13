// Soak report for the latest release of each service (TS migration plan,
// "Soak criteria"). Read-only: Cloud Logging queries only.
//
//   node scripts/soak-report.js [service ...]     default: api auth policy broker
//
// For each service, takes its newest released receipt in .gc-deploy/releases,
// and compares the released revision (promotion → now) with the whole
// service over the same weekday/hours window one week earlier:
//   volume     ≥ 300 requests, else the soak is EXTENDED, not passed (policy
//              and broker: a passed candidate verify instead; see below)
//   duration   MET once all of this has held for 24 h; PASS so far before
//   5xx rate   ≤ max(baseline × 1.1, baseline + 0.1 percentage points)
//   p95        per route (method + path): ≤ baseline × 1.1 + 50 ms for every
//              route with ≥ 20 requests in both windows. One overall p95 is
//              shown but not judged: it moves with the traffic mix (a window
//              full of 3 ms OPTIONS and bot probes vs one full of compiles)
//              even when no route got slower.
//   errors     ERROR-or-worse log signatures not seen in the baseline window
// Smoke/verify requests to the tagged candidate URL are excluded, and rates
// and latency are not judged below 100 requests. Language requests the api
// proxies to a language server (/L<lang>/...) are reported on their own line
// and not judged: their latency is the language server's (e.g. its cold
// starts), not this release's. Policy/broker audit rates
// are not computed here; read their audit logs during review.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../packages/deploy/src/process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "graffiticode";
const WEEK = 7 * 24 * 3600 * 1000;
// api and auth see a few hundred requests a day; lowered from 1,000 on
// 2026-10-02 so a day of traffic can complete their soak.
const MIN_REQUESTS = 300;
// Below this many requests, latency and 5xx comparisons are noise.
const MIN_FOR_RATES = 100;
const MIN_HOURS = 24;
// Private services with almost no production traffic (they never approach
// MIN_REQUESTS, and had none in the baseline window). Decided 2026-10-02:
// their soak is the release's passed candidate checks (verify module, as
// recorded in the receipt) plus no 5xx and no new error signatures for
// MIN_HOURS, instead of request volume.
const CANDIDATE_CHECKED = new Set(["policy", "broker"]);
// A soak window that starts later than its revision, keyed by revision so a
// later release never inherits it. api-rmuqay3ps-d046d5: its language servers
// (l0178, l0180-l0184) were pinned warm by 18:03 UTC on 2026-10-02; earlier
// requests measured their cold starts, not this release (decided that day).
const WINDOW_START = {
  "api-rmuqay3ps-d046d5": "2026-10-02T18:03:00Z",
};
const LIMIT = 50000;

const latestRelease = async service => {
  const dir = path.join(ROOT, ".gc-deploy", "releases");
  const receipts = await Promise.all((await readdir(dir)).filter(f => f.endsWith(".json"))
    .map(async f => JSON.parse(await readFile(path.join(dir, f), "utf8"))));
  return receipts.filter(r => r.service === service && r.status === "released")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
};

// The window starts at the revision's creation; smoke and verify requests
// before promotion went to the tagged candidate URL (<tag>---<service>…) and
// are dropped below, so only served traffic counts.
const revisionCreated = async revision =>
  JSON.parse(await run("gcloud", ["run", "revisions", "describe", revision, `--project=${PROJECT}`, "--region=us-central1", "--format=json"], {})).metadata.creationTimestamp;

const read = async filter => JSON.parse(await run("gcloud", ["logging", "read", filter, `--project=${PROJECT}`, `--limit=${LIMIT}`,
  "--format=json(httpRequest.status,httpRequest.latency,httpRequest.requestUrl,httpRequest.requestMethod,severity,textPayload,jsonPayload.message)"], {}));

const window = (start, end) => `timestamp>="${new Date(start).toISOString()}" AND timestamp<"${new Date(end).toISOString()}"`;

const isCandidateRequest = e => /^https:\/\/[^/]*---/.test(e?.httpRequest?.requestUrl ?? "");
const isProxiedLangRequest = e => /^\/L\d+(\/|$|\?)/.test(new URL(e?.httpRequest?.requestUrl ?? "http://x/", "http://x").pathname);

const MIN_ROUTE_REQUESTS = 20;

// Method + path with ids collapsed, so /v1/connections/abc and /v1/connections/def
// are one route. Query strings are dropped.
const routeOf = e => {
  const url = new URL(e?.httpRequest?.requestUrl ?? "http://x/", "http://x");
  const path = url.pathname.split("/").map(seg => (/^[0-9a-f-]{12,}$|^[A-Za-z0-9_-]{20,}$|^\d+$/i.test(seg) ? ":id" : seg)).join("/");
  return `${e?.httpRequest?.requestMethod ?? "?"} ${path}`;
};

const p95Of = latencies => {
  const v = [...latencies].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
};

// Per-route latency in each window: { route: [ms, ...] }.
const routeLatencies = entries => {
  const by = {};
  for (const e of entries) {
    if (!e?.httpRequest?.status || isCandidateRequest(e) || isProxiedLangRequest(e)) continue;
    const ms = parseFloat(e.httpRequest.latency) * 1000;
    if (!Number.isFinite(ms)) continue;
    (by[routeOf(e)] ||= []).push(ms);
  }
  return by;
};

const httpStats = (entries, { proxied = false } = {}) => {
  const requests = entries.filter(e => e?.httpRequest?.status && !isCandidateRequest(e) && isProxiedLangRequest(e) === proxied);
  const latencies = requests.map(e => parseFloat(e.httpRequest.latency) * 1000).filter(Number.isFinite).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;
  const errors5xx = requests.filter(e => e.httpRequest.status >= 500).length;
  return { requests: requests.length, rate5xx: requests.length ? errors5xx / requests.length : 0, errors5xx, p95, truncated: entries.length >= LIMIT };
};

const signature = e => String(e.textPayload ?? e.jsonPayload?.message ?? "").split("\n")[0]
  .replace(/[0-9a-f]{8,}/gi, "<hex>").replace(/\d+/g, "#").slice(0, 120);

const report = async service => {
  const receipt = await latestRelease(service);
  if (!receipt) return { service, verdict: "NO RELEASE", lines: ["no released receipt in .gc-deploy/releases"] };
  const created = Date.parse(await revisionCreated(receipt.revision));
  const start = Math.max(created, Date.parse(WINDOW_START[receipt.revision] ?? 0));
  const end = Date.now();
  const base = `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}"`;
  const current = (await read(`${base} AND resource.labels.revision_name="${receipt.revision}" AND ${window(start, end)}`)).filter(e => e && !isCandidateRequest(e));
  const baseline = (await read(`${base} AND ${window(start - WEEK, end - WEEK)}`)).filter(Boolean);
  const now = httpStats(current);
  const was = httpStats(baseline);
  const proxiedNow = httpStats(current, { proxied: true });
  const proxiedWas = httpStats(baseline, { proxied: true });
  const errorSigs = new Set(current.filter(e => ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(e.severity)).map(signature));
  const baseSigs = new Set(baseline.filter(e => ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(e.severity)).map(signature));
  const newSigs = [...errorSigs].filter(s => !baseSigs.has(s));

  const failures = [];
  const enough = now.requests >= MIN_FOR_RATES && was.requests >= MIN_FOR_RATES;
  if (enough && now.rate5xx > Math.max(was.rate5xx * 1.1, was.rate5xx + 0.001)) failures.push("5xx rate");
  const routesNow = routeLatencies(current);
  const routesWas = routeLatencies(baseline);
  const routeRows = [];
  const slowRoutes = [];
  for (const route of Object.keys(routesNow).sort((a, b) => routesNow[b].length - routesNow[a].length)) {
    const a = routesNow[route];
    const b = routesWas[route] ?? [];
    if (a.length < MIN_ROUTE_REQUESTS || b.length < MIN_ROUTE_REQUESTS) continue;
    const [pn, pw] = [p95Of(a), p95Of(b)];
    const slow = pn > pw * 1.1 + 50;
    if (slow) slowRoutes.push(route);
    routeRows.push(`  ${slow ? "SLOW" : "ok  "} ${route.padEnd(30)} n=${String(a.length).padStart(4)} vs ${String(b.length).padStart(4)}  p95 ${Math.round(pn)} vs ${Math.round(pw)} ms`);
  }
  if (slowRoutes.length) failures.push(`p95 latency on ${slowRoutes.join(", ")}`);
  if (newSigs.length) failures.push("new error signatures");
  const hoursUp = (end - start) / 3600000;
  const candidateChecked = CANDIDATE_CHECKED.has(service);
  if (candidateChecked && now.errors5xx) failures.push("5xx");
  if (candidateChecked && !receipt.verify?.sha256) failures.push("release has no recorded candidate verify");
  const volumeOk = candidateChecked || now.requests >= MIN_REQUESTS;
  const verdict = failures.length
    ? `INVESTIGATE (${failures.join(", ")})`
    : !volumeOk
        ? "EXTEND (too little traffic)"
        : hoursUp >= MIN_HOURS
          ? `MET${candidateChecked ? " (candidate-checked)" : ""}`
          : `PASS so far${candidateChecked ? " (candidate-checked; volume not required)" : ""}`;
  const pct = x => `${(x * 100).toFixed(2)}%`;
  const ms = x => (x === null ? "n/a" : `${Math.round(x)} ms`);
  const hours = ((end - start) / 3600000).toFixed(1);
  return {
    service,
    verdict,
    lines: [
      `release ${receipt.id} → ${receipt.revision}, ${hours} h since ${start > created ? `window start ${new Date(start).toISOString().slice(0, 16)}Z` : "revision creation"} (need ${MIN_HOURS})`,
      `requests  ${now.requests}${now.truncated ? "+" : ""} (baseline week-ago window ${was.requests}${was.truncated ? "+" : ""}; ${candidateChecked ? `candidate verify ${receipt.verify?.module ?? "MISSING"}` : `need ${MIN_REQUESTS}`})`,
      `5xx       ${pct(now.rate5xx)} (${now.errors5xx}) vs ${pct(was.rate5xx)} (${was.errors5xx})`,
      `p95       ${ms(now.p95)} vs ${ms(was.p95)} overall (not judged: moves with the traffic mix)`,
      routeRows.length
        ? `routes    judged per route (≥ ${MIN_ROUTE_REQUESTS} requests in both windows):`
        : `routes    none with ≥ ${MIN_ROUTE_REQUESTS} requests in both windows; latency not judged`,
      ...routeRows,
      ...(proxiedNow.requests || proxiedWas.requests
        ? [`proxied   ${proxiedNow.requests} /L<lang> requests, p95 ${ms(proxiedNow.p95)} vs ${ms(proxiedWas.p95)}, 5xx ${proxiedNow.errors5xx} (not judged)`]
        : []),
      `errors    ${errorSigs.size} signature(s), ${newSigs.length} new${newSigs.length ? ":" : ""}`,
      ...newSigs.slice(0, 10).map(s => `            ${s}`),
    ],
  };
};

const services = process.argv.slice(2).length ? process.argv.slice(2) : ["api", "auth", "policy", "broker"];
for (const service of services) {
  try {
    const { verdict, lines } = await report(service);
    console.log(`\n${service}: ${verdict}`);
    for (const line of lines) console.log(`  ${line}`);
  } catch (err) {
    console.log(`\n${service}: ERROR running report: ${err.message.split("\n")[0]}`);
  }
}
