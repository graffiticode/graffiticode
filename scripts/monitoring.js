#!/usr/bin/env node
// Security-audit monitoring (capability plan W3; spec AUDIT-01): log-based
// metrics counting each kind of failure once, alert policies for
// authorization outages and uncertain writes, and a check that their email
// really arrives. Runbook: docs/protected-execution.md, "Monitoring".
//
//   node scripts/monitoring.js [--email <operator address>]            dry run (default)
//   node scripts/monitoring.js --apply --email <operator address>
//   node scripts/monitoring.js --verify-alert --email <operator address>
//
// The dry run checks every metric's filter against deployed entries (default:
// the last 7 days, --days N) and prints what --apply would create or update;
// it writes nothing. --apply refuses if a filter check fails, and is
// idempotent: a second run changes nothing. --verify-alert writes one test
// record per alert (log security_audit_test; the alerts match it, the metrics
// never do), asks for the nonce from each email, and records the result in
// .gc-deploy/monitoring/alert-verification.json.
//
// Options: --project (default graffiticode). Uses the gcloud account's access
// token. The logic lives in scripts/lib/monitoring.js.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { CAP, apply, checkFilters, plan, verifyAlerts } from "./lib/monitoring.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 3600 * 1000;

export const parse = argv => {
  const opts = { project: "graffiticode", email: null, days: 7, apply: false, verifyAlert: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--apply") { opts.apply = true; continue; }
    if (key === "--verify-alert") { opts.verifyAlert = true; continue; }
    const value = argv[++i];
    if (!["--project", "--email", "--days"].includes(key) || value === undefined) throw new Error(`unknown or incomplete option ${key}`);
    if (key === "--project") opts.project = value;
    if (key === "--email") opts.email = value;
    if (key === "--days") opts.days = Number(value);
  }
  if (opts.apply && opts.verifyAlert) throw new Error("--apply and --verify-alert are separate runs");
  if ((opts.apply || opts.verifyAlert) && !opts.email) throw new Error("--email is required with --apply and --verify-alert");
  if (opts.email && !/^[^@\s]+@[^@\s]+$/.test(opts.email)) throw new Error("--email must be an address");
  if (!(opts.days > 0)) throw new Error("--days must be positive");
  return opts;
};

const gcloud = args => execFileSync("gcloud", args, { encoding: "utf8" }).trim();

const googleApi = () => {
  const token = gcloud(["auth", "print-access-token"]);
  return async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
    return { status: res.status, json };
  };
};

const record = async results => {
  const dir = path.join(ROOT, ".gc-deploy", "monitoring");
  const file = path.join(dir, "alert-verification.json");
  await mkdir(dir, { recursive: true });
  const earlier = await readFile(file, "utf8").then(JSON.parse, () => []);
  let operator = "unknown";
  try { operator = gcloud(["config", "get-value", "account"]) || "unknown"; } catch {}
  await writeFile(file, `${JSON.stringify([...earlier, ...results.map(r => ({ ...r, operator }))], null, 2)}\n`);
  return file;
};

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const api = googleApi();
  const log = message => console.log(message);
  const { project, email } = opts;

  if (opts.verifyAlert) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const results = await verifyAlerts({ api, project, email, prompt: q => rl.question(q), log });
      const file = await record(results);
      for (const r of results) log(`  ${r.delivered ? "DELIVERED" : "NOT CONFIRMED"} ${r.alert}`);
      log(`Recorded in ${file}`);
      if (!results.every(r => r.delivered)) process.exitCode = 1;
    } finally {
      rl.close();
    }
    return;
  }

  const since = new Date(Date.now() - opts.days * DAY).toISOString();
  log(`Filter check against deployed entries since ${since}:`);
  const checks = await checkFilters({ api, project, since });
  const n = count => count >= CAP ? `${CAP}+` : String(count);
  for (const c of checks) log(`  ${c.problem ? "FAIL" : "ok  "} ${c.name}: ${n(c.matched)} matching, of ${n(c.base)} records it draws from${c.problem ? ` (${c.problem})` : ""}`);
  const failed = checks.filter(c => c.problem);

  if (!opts.apply) {
    const { steps } = await plan({ api, project, email });
    log(`\nDry run: --apply${email ? "" : " (with --email for the channel and alert policies)"} would make:`);
    for (const s of steps) log(`  ${s.action} ${s.kind} ${s.name}`);
    if (failed.length) process.exitCode = 1;
    return;
  }
  if (failed.length) throw new Error(`refusing to apply: ${failed.map(c => c.name).join(", ")} failed the filter check`);
  log("\nApplying:");
  const steps = await apply({ api, project, email, log });
  if (steps.every(s => s.action === "unchanged")) log("  nothing to change");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
