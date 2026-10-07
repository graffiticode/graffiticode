#!/usr/bin/env node
// Operator control for the protected-execution switch (capability plan W0;
// packages/policy/src/maintenance.js). Policy and Broker each read the flag
// from their own Firestore database, so this writes both: disabling stops new
// tokens (Policy) before execution (Broker); enabling reopens execution before
// issuance.
//
//   node scripts/protected-execution.js status
//   node scripts/protected-execution.js enable  --reason "W0 release verified" [--skip-release-check]
//   node scripts/protected-execution.js disable --reason "v6 release window"
//   node scripts/protected-execution.js drain
//   node scripts/protected-execution.js canary --uid <uid> --connection <id> --reason "W0 canary"
//   node scripts/protected-execution.js canary --clear --reason "canary retired"
//
// `canary` names the one account and dedicated (sandbox) connection still
// admitted while protected execution is off, in both databases, leaving the
// on/off state as it is. It refuses the deploy-check account (VERIFY_UID).
//
// `drain` (after disable) waits until Broker reports no active writes, once the
// switch has settled (its 2 s cache plus registration time), or until the
// maximum execution duration plus the cache window has passed since Broker was
// switched off, whichever comes first. It refuses while Broker is on. --max-ms
// overrides the duration (default 50000: the default limits in
// packages/broker/src/limits.js).
//
// `enable` first runs the deploy CLI's release check for every service in
// deploy.json that retires tags or names a baseline (no stale tags, nothing
// serving below its milestone baseline), and refuses if any fails.
// --skip-release-check bypasses it and records releaseCheckSkipped: true; it is
// refused for the production project (deploy.json environments.production).
//
// Every write merges: enable/disable keep a configured canary, and canary
// keeps the switch where it is. The logic lives in scripts/lib/protected-execution.js.
//
// Options: --project (default graffiticode), --databases (default
// policy,broker). Uses application-default credentials. A hard disable
// (PROTECTED_EXECUTION=disabled on a service) overrides whatever this writes.

import { execFileSync } from "node:child_process";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { VERIFY_UID } from "../verify/auth.js";
import { readFile } from "node:fs/promises";
import { DOC, drain, enableChecked, parse, setCanary, setEnabled, status } from "./lib/protected-execution.js";
import { loadConfig, parseArgs } from "../packages/deploy/src/config.js";
import { releaseCheck } from "../packages/deploy/src/release.js";
import { run } from "../packages/deploy/src/process.js";
import { createGit } from "../packages/deploy/src/git.js";
import { createFirestoreRest, createRevisionClient } from "../packages/deploy/src/revisions.js";

const ROOT = new URL("..", import.meta.url).pathname;

// The deploy CLI's release check for each protected service (read-only).
const releaseChecks = async () => {
  const raw = JSON.parse(await readFile(new URL("../deploy.json", import.meta.url), "utf8"));
  const names = Object.entries(raw.services).filter(([, s]) => s.retireTags || s.baseline || s.baselines || s.pinnable || s.contractMinimum).map(([name]) => name);
  return Promise.all(names.map(async name => {
    const context = await loadConfig(parseArgs([name]), ROOT);
    const { config } = context;
    const cloud = async args => JSON.parse(await run("gcloud", [...args, `--project=${config.project}`, `--region=${config.region}`, "--quiet", "--format=json"], { cwd: ROOT }));
    // A pinnable service's check covers every reachable revision against the
    // approved-revisions store (capability plan W4).
    const revisions = config.pinnable
      ? createRevisionClient(config, createFirestoreRest({ project: config.project, accessToken: async () => String(await run("gcloud", ["auth", "print-access-token"])).trim() }))
      : undefined;
    return releaseCheck(context, { cloud, git: createGit(ROOT), revisions });
  }));
};

const operator = () => {
  try {
    return execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const main = async () => {
  const deployConfig = JSON.parse(await readFile(new URL("../deploy.json", import.meta.url), "utf8"));
  const opts = parse(process.argv.slice(2), { verifyUid: VERIFY_UID, productionProject: deployConfig.environments.production.project });
  const app = initializeApp({ credential: applicationDefault(), projectId: opts.project });
  const dbs = opts.databases.map(name => ({ name, db: getFirestore(app, name) }));
  const log = message => console.log(message);
  if (opts.command === "drain") {
    const broker = dbs.find(d => d.name === "broker")?.db;
    if (!broker) throw new Error("drain needs the broker database");
    await drain(broker, { maxMs: opts.maxMs, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), log });
    return;
  }
  if (opts.command === "canary") {
    const canary = opts.clear ? null : { uid: opts.uid, connectionId: opts.connection };
    await setCanary(dbs, canary, { reason: opts.reason, by: operator() });
    log(`canary ${canary ? `${canary.uid} on ${canary.connectionId}` : "cleared"} in ${opts.databases.join(", ")}`);
  } else if (opts.command === "enable") {
    await enableChecked(dbs, { reason: opts.reason, by: operator(), check: releaseChecks, skip: opts.skipReleaseCheck, log });
    log(`${DOC} enabled=true in ${opts.databases.join(", ")}${opts.skipReleaseCheck ? " (release check SKIPPED)" : ""}`);
  } else if (opts.command === "disable") {
    await setEnabled(dbs, false, { reason: opts.reason, by: operator() });
    log(`${DOC} enabled=false in ${opts.databases.join(", ")}`);
  }
  await status(dbs, { project: opts.project, log });
};

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
