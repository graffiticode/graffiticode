#!/usr/bin/env node
// Operator control for the protected-execution switch (capability plan W0;
// packages/policy/src/maintenance.js). Policy and Broker each read the flag
// from their own Firestore database, so this writes both: disabling stops new
// tokens (Policy) before execution (Broker); enabling reopens execution before
// issuance.
//
//   node scripts/protected-execution.js status
//   node scripts/protected-execution.js enable  --reason "W0 release verified"
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
import { DOC, drain, parse, setCanary, setEnabled, status } from "./lib/protected-execution.js";

const operator = () => {
  try {
    return execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const main = async () => {
  const opts = parse(process.argv.slice(2), { verifyUid: VERIFY_UID });
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
  } else if (opts.command !== "status") {
    const enabled = opts.command === "enable";
    await setEnabled(dbs, enabled, { reason: opts.reason, by: operator() });
    log(`${DOC} enabled=${enabled} in ${opts.databases.join(", ")}`);
  }
  await status(dbs, { project: opts.project, log });
};

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
