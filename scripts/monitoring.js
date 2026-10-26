#!/usr/bin/env node
// Security-audit monitoring (capability plan W3; spec AUDIT-01): log-based
// metrics counting each kind of failure once, alert policies for
// authorization outages, uncertain and partial writes, artifact storage outages,
// permission denials and plan/contract refusals outside the canary and the
// system preview signing limit,
// an hourly threshold on system signings, and checks that their email really
// arrives. Runbook: docs/protected-execution.md, "Monitoring".
//
//   node scripts/monitoring.js [--email <operator address>]            dry run (default)
//   node scripts/monitoring.js --apply --email <operator address> --canary-connection <id>
//   node scripts/monitoring.js --verify-alert --email <operator address> --canary-connection <id>
//   node scripts/monitoring.js --confirm <nonce> [<nonce> ...] [--settle]
//   node scripts/monitoring.js --verify-threshold --email <operator address> [--threshold N] [--apply]
//   node scripts/monitoring.js --verify-threshold --cleanup [--apply]
//
// The dry run checks every metric's filter against deployed entries (default:
// the last 7 days, --days N) and prints what --apply would create or update;
// it writes nothing. --apply refuses if a filter check fails, and is
// idempotent: a second run changes nothing. --verify-alert writes one test
// record per alert (log security_audit_test; the alerts match it, the metrics
// never do) and keeps their nonces in .gc-deploy/monitoring/pending.json.
// Once the emails arrive, --confirm takes the nonce from each one; an alert
// whose nonce isn't given is not confirmed. The result is appended to
// .gc-deploy/monitoring/alert-verification.json. Neither run prompts, so both
// work from a non-interactive shell.
//
// --verify-threshold checks the metric-threshold path, which a test record
// on a log-match alert never exercises: a scratch log-based metric and a
// scratch threshold policy (default threshold 5, the real policy's window,
// aligner, reducer and comparison) whose documentation holds a fresh nonce,
// then test records under the threshold, a hold, and more well past it. It prints the
// nonce and the crossing time and adds the nonce to pending.json, so
// --confirm records it like the others; an email with the nonce dated
// before the crossing is a failure. Without --apply it prints what it would
// create and write, and writes nothing. --cleanup removes the scratch
// metrics and policy (also dry unless --apply); run it after --confirm.
//
// --canary-connection (repeatable) names the canary's connection, which the
// denial and contract alerts leave out; it is required with --apply and --verify-alert, so
// the alert policy compared and written is always the same one.
//
// Options: --project (default graffiticode). Uses the gcloud account's access
// token. The logic lives in scripts/lib/monitoring.js.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAP, SCRATCH_POLICY, SCRATCH_THRESHOLD, scratchConditionName, apply, checkFilters, cleanupThreshold, confirmDelivery, plan, verifyThreshold, writeTestRecords } from "./lib/monitoring.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 3600 * 1000;

export const parse = argv => {
  const opts = { project: "graffiticode", email: null, days: 7, apply: false, verifyAlert: false, verifyThreshold: false, cleanup: false, settle: false, threshold: SCRATCH_THRESHOLD, confirm: null, canaryConnections: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--confirm") {
      opts.confirm = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.confirm.push(argv[++i]);
      continue;
    }
    if (key === "--apply") { opts.apply = true; continue; }
    if (key === "--verify-alert") { opts.verifyAlert = true; continue; }
    if (key === "--verify-threshold") { opts.verifyThreshold = true; continue; }
    if (key === "--cleanup") { opts.cleanup = true; continue; }
    if (key === "--settle") { opts.settle = true; continue; }
    const value = argv[++i];
    if (!["--project", "--email", "--days", "--canary-connection", "--threshold"].includes(key) || value === undefined) throw new Error(`unknown or incomplete option ${key}`);
    if (key === "--threshold") opts.threshold = Number(value);
    if (key === "--canary-connection") {
      if (!/^conn-[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error("--canary-connection must be a connection id");
      opts.canaryConnections.push(value);
    }
    if (key === "--project") opts.project = value;
    if (key === "--email") opts.email = value;
    if (key === "--days") opts.days = Number(value);
  }
  // --verify-threshold takes --apply as the dry-run switch; it is its own run.
  if ([opts.verifyAlert, opts.verifyThreshold, opts.confirm !== null].filter(Boolean).length > 1) throw new Error("--verify-alert, --verify-threshold and --confirm are separate runs");
  if (opts.apply && (opts.verifyAlert || opts.confirm !== null)) throw new Error("--apply, --verify-alert and --confirm are separate runs");
  if (opts.cleanup && !opts.verifyThreshold) throw new Error("--cleanup goes with --verify-threshold");
  if (opts.settle && opts.confirm === null) throw new Error("--settle goes with --confirm");
  if (!(Number.isInteger(opts.threshold) && opts.threshold > 0 && opts.threshold <= 100)) throw new Error("--threshold must be an integer from 1 to 100");
  if (opts.verifyThreshold && !opts.cleanup && !opts.email) throw new Error("--email is required with --verify-threshold");
  if ((opts.apply || opts.verifyAlert) && !opts.verifyThreshold && !opts.email) throw new Error("--email is required with --apply and --verify-alert");
  if (opts.email && !/^[^@\s]+@[^@\s]+$/.test(opts.email)) throw new Error("--email must be an address");
  if ((opts.apply || opts.verifyAlert) && !opts.verifyThreshold && !opts.canaryConnections.length) throw new Error("--canary-connection is required with --apply and --verify-alert");
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

const MONITORING_DIR = path.join(ROOT, ".gc-deploy", "monitoring");
const PENDING = path.join(MONITORING_DIR, "pending.json");
const VERIFIED = path.join(MONITORING_DIR, "alert-verification.json");

const record = async results => {
  const earlier = await readFile(VERIFIED, "utf8").then(JSON.parse, () => []);
  let operator = "unknown";
  try { operator = gcloud(["config", "get-value", "account"]) || "unknown"; } catch {}
  await writeFile(VERIFIED, `${JSON.stringify([...earlier, ...results.map(r => ({ ...r, operator }))], null, 2)}\n`);
};

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const api = opts.confirm === null ? googleApi() : null;
  const log = message => console.log(message);
  const { project, email } = opts;

  if (opts.confirm !== null) {
    const written = await readFile(PENDING, "utf8").then(JSON.parse, () => null);
    if (!written) throw new Error("no test records are pending; run --verify-alert first");
    const { results, remaining, unknown } = confirmDelivery(written, opts.confirm, { settle: opts.settle });
    if (results.length) await record(results);
    if (remaining.length) await writeFile(PENDING, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600 });
    else await rm(PENDING, { force: true });
    for (const r of results) log(`  ${r.delivered ? "DELIVERED" : "NOT CONFIRMED"} ${r.alert}`);
    for (const r of remaining) log(`  still pending: ${r.alert} (written ${r.writtenAt})`);
    if (unknown.length) log(`  matched no alert: ${unknown.join(", ")}`);
    if (results.length) log(`Recorded in ${VERIFIED}`);
    if (remaining.length) log("Confirm them when their emails arrive, or add --settle to record them not confirmed.");
    if (unknown.length || !results.every(r => r.delivered)) process.exitCode = 1;
    return;
  }

  if (opts.verifyThreshold && opts.cleanup) {
    const { steps } = await cleanupThreshold({ api, project, apply: opts.apply, log });
    if (!steps.length) log("No scratch metric or policy to remove.");
    else if (!opts.apply) {
      log("Dry run: --verify-threshold --cleanup --apply would:");
      for (const s of steps) log(`  ${s}`);
    }
    return;
  }

  if (opts.verifyThreshold) {
    const run = await verifyThreshold({ api, project, email, apply: opts.apply, threshold: opts.threshold, log });
    if (!run.applied) {
      log(`Dry run: --verify-threshold --apply would (nonce ${run.nonce}, run ${run.runId}):`);
      for (const s of run.steps) log(`  ${s}`);
      log(`\nScratch metric:\n${JSON.stringify(run.scratch.metric, null, 2)}`);
      log(`\nScratch policy:\n${JSON.stringify(run.scratch.policy, null, 2)}`);
      log("\nNothing was written. A real run makes a new nonce.");
      return;
    }
    const earlier = await readFile(PENDING, "utf8").then(JSON.parse, () => []);
    await mkdir(MONITORING_DIR, { recursive: true });
    await writeFile(PENDING, `${JSON.stringify([...earlier, { alert: SCRATCH_POLICY, nonce: run.nonce, writtenAt: run.crossedAt }], null, 2)}\n`, { mode: 0o600 });
    log(`\nThe threshold was crossed at ${run.crossedAt}. Look for an email to ${email} whose Condition line reads:`);
    log(`  ${scratchConditionName(run.nonce)}`);
    log(`It should arrive within about 5 minutes, dated after ${run.crossedAt}. One dated before it means the condition opened at the threshold: don't confirm it.`);
    log(`When it arrives: node scripts/monitoring.js --confirm ${run.nonce}`);
    log("Then remove the scratch metric and policy: node scripts/monitoring.js --verify-threshold --cleanup --apply");
    return;
  }

  if (opts.verifyAlert) {
    const written = await writeTestRecords({ api, project, email, canaryConnections: opts.canaryConnections, log });
    await mkdir(MONITORING_DIR, { recursive: true });
    await writeFile(PENDING, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
    log(`Each alert's email should reach ${email} within about 5 minutes. Its nonce is the log entry's extracted label "nonce" (shown with the alert's labels, or at the end of its text).`);
    log("When they arrive: node scripts/monitoring.js --confirm <nonce> <nonce>");
    log("(An alert whose email doesn't arrive: leave its nonce out; it is recorded as not confirmed.)");
    return;
  }

  const since = new Date(Date.now() - opts.days * DAY).toISOString();
  log(`Filter check against deployed entries since ${since}:`);
  const checks = await checkFilters({ api, project, since });
  const n = count => count >= CAP ? `${CAP}+` : String(count);
  for (const c of checks) log(`  ${c.problem ? "FAIL" : "ok  "} ${c.name}: ${n(c.matched)} matching, of ${n(c.base)} records it draws from${c.problem ? ` (${c.problem})` : ""}`);
  const failed = checks.filter(c => c.problem);

  if (!opts.apply) {
    const { steps } = await plan({ api, project, email, canaryConnections: opts.canaryConnections });
    log(`\nDry run: --apply${email ? "" : " (with --email for the channel and alert policies)"} would make:`);
    for (const s of steps) log(`  ${s.action} ${s.kind} ${s.name}`);
    if (failed.length) process.exitCode = 1;
    return;
  }
  if (failed.length) throw new Error(`refusing to apply: ${failed.map(c => c.name).join(", ")} failed the filter check`);
  log("\nApplying:");
  const steps = await apply({ api, project, email, canaryConnections: opts.canaryConnections, log });
  if (steps.every(s => s.action === "unchanged")) log("  nothing to change");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
