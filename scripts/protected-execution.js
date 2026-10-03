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
//
// `drain` (after disable) waits until Broker reports no active writes, or until
// the maximum execution duration has passed since Broker was switched off,
// whichever comes first. It refuses while Broker is on. --max-ms overrides the
// bound (default 50000: the default limits in packages/broker/src/limits.js).
//
// Options: --project (default graffiticode), --databases (default
// policy,broker). Uses application-default credentials. A hard disable
// (PROTECTED_EXECUTION=disabled on a service) overrides whatever this writes.

import { execFileSync } from "node:child_process";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DOC = "controls/protected-execution";
const ACTIVE = "active-executions";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const parse = argv => {
  const [command, ...rest] = argv;
  const opts = { command, project: "graffiticode", databases: ["policy", "broker"], reason: null, maxMs: 50_000 };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!["--project", "--databases", "--reason", "--max-ms"].includes(key) || value === undefined) {
      throw new Error(`unknown or incomplete option ${key}`);
    }
    if (key === "--project") opts.project = value;
    if (key === "--databases") opts.databases = value.split(",").filter(Boolean);
    if (key === "--reason") opts.reason = value;
    if (key === "--max-ms") {
      opts.maxMs = Number(value);
      if (!Number.isInteger(opts.maxMs) || opts.maxMs <= 0) throw new Error("--max-ms must be a positive integer");
    }
    i++;
  }
  if (!["status", "enable", "disable", "drain"].includes(command)) throw new Error("command must be status, enable, disable or drain");
  if ((command === "enable" || command === "disable") && !opts.reason?.trim()) throw new Error(`${command} needs --reason`);
  return opts;
};

const operator = () => {
  try {
    return execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

// Active writes recorded by Broker (activity entries not yet expired).
const activeWrites = db => db.collection(ACTIVE).where("expiresAt", ">", new Date()).count().get().then(s => s.data().count);

const drain = async (broker, maxMs) => {
  const snap = await broker.doc(DOC).get();
  const flag = snap.exists ? snap.data() : null;
  if (flag?.enabled === true) throw new Error("drain refuses while Broker is on: disable first");
  const offSince = flag?.updatedAt ? Date.parse(flag.updatedAt) : Date.now();
  for (;;) {
    const count = await activeWrites(broker);
    const waited = Date.now() - offSince;
    if (count === 0) return console.log(`drained: no active writes (${Math.round(waited / 1000)} s since Broker was switched off)`);
    if (waited >= maxMs) return console.log(`drained by time: ${maxMs} ms have passed since Broker was switched off (${count} entries not yet expired)`);
    console.log(`waiting: ${count} active write(s), ${Math.round((maxMs - waited) / 1000)} s left of the bound`);
    await sleep(2000);
  }
};

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const app = initializeApp({ credential: applicationDefault(), projectId: opts.project });
  const dbs = opts.databases.map(name => ({ name, db: getFirestore(app, name) }));
  const broker = dbs.find(d => d.name === "broker")?.db;
  if (opts.command === "drain") {
    if (!broker) throw new Error("drain needs the broker database");
    return drain(broker, opts.maxMs);
  }
  if (opts.command !== "status") {
    const enabled = opts.command === "enable";
    const doc = { enabled, reason: opts.reason, updatedAt: new Date().toISOString(), updatedBy: operator() };
    // Disable: Policy (issuance) before Broker (execution); enable: the reverse.
    const order = enabled ? [...dbs].reverse() : dbs;
    for (const { name, db } of order) {
      await db.doc(DOC).set(doc);
      console.log(`${opts.project}/${name}: ${DOC} enabled=${enabled}`);
    }
  }
  if (broker) console.log(`${opts.project}/broker: ${await activeWrites(broker)} active write(s)`);
  for (const { name, db } of dbs) {
    const snap = await db.doc(DOC).get();
    const data = snap.exists ? snap.data() : null;
    const state = data?.enabled === true ? "ON" : "OFF";
    console.log(`${opts.project}/${name}: ${state}${data ? ` (by ${data.updatedBy} at ${data.updatedAt}: ${data.reason})` : " (no flag document: fails closed)"}`);
  }
};

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
