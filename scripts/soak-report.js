// Soak report for the latest release of each service (TS migration plan,
// "Soak criteria"). Read-only: Cloud Logging queries only.
//
//   node scripts/soak-report.js [service ...]     default: api auth policy broker
//
// For each service, takes its newest released receipt in .gc-deploy/releases,
// and compares the released revision (promotion → now) with the whole
// service over the same weekday/hours window one week earlier:
//   volume     ≥ 1000 requests, else the soak is EXTENDED, not passed (policy
//              and broker: a passed candidate verify instead; see below)
//   duration   MET once all of this has held for 72 h; PASS so far before
//   5xx rate   ≤ max(baseline × 1.1, baseline + 0.1 percentage points)
//   p95        ≤ baseline × 1.1 + 50 ms
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
const MIN_REQUESTS = 1000;
// Below this many requests, latency and 5xx comparisons are noise.
const MIN_FOR_RATES = 100;
const MIN_HOURS = 72;
// Private services with almost no production traffic (they never approach
// MIN_REQUESTS, and had none in the baseline window). Decided 2026-10-02:
// their soak is the release's passed candidate checks (verify module, as
// recorded in the receipt) plus no 5xx and no new error signatures for
// MIN_HOURS, instead of request volume.
const CANDIDATE_CHECKED = new Set(["policy", "broker"]);
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
  "--format=json(httpRequest.status,httpRequest.latency,httpRequest.requestUrl,severity,textPayload,jsonPayload.message)"], {}));

const window = (start, end) => `timestamp>="${new Date(start).toISOString()}" AND timestamp<"${new Date(end).toISOString()}"`;

const isCandidateRequest = e => /^https:\/\/[^/]*---/.test(e?.httpRequest?.requestUrl ?? "");
const isProxiedLangRequest = e => /^\/L\d+(\/|$|\?)/.test(new URL(e?.httpRequest?.requestUrl ?? "http://x/", "http://x").pathname);

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
  const start = Date.parse(await revisionCreated(receipt.revision));
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
  if (enough && now.p95 !== null && was.p95 !== null && now.p95 > was.p95 * 1.1 + 50) failures.push("p95 latency");
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
      `release ${receipt.id} → ${receipt.revision}, ${hours} h since revision creation (need ${MIN_HOURS})`,
      `requests  ${now.requests}${now.truncated ? "+" : ""} (baseline week-ago window ${was.requests}${was.truncated ? "+" : ""}; ${candidateChecked ? `candidate verify ${receipt.verify?.module ?? "MISSING"}` : `need ${MIN_REQUESTS}`})`,
      `5xx       ${pct(now.rate5xx)} (${now.errors5xx}) vs ${pct(was.rate5xx)} (${was.errors5xx})`,
      `p95       ${ms(now.p95)} vs ${ms(was.p95)}${enough ? "" : ` (not judged below ${MIN_FOR_RATES} requests)`}`,
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
