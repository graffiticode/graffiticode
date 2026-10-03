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
//
// Options: --project (default graffiticode), --databases (default
// policy,broker). Uses application-default credentials. A hard disable
// (PROTECTED_EXECUTION=disabled on a service) overrides whatever this writes.

import { execFileSync } from "node:child_process";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DOC = "controls/protected-execution";

const parse = argv => {
  const [command, ...rest] = argv;
  const opts = { command, project: "graffiticode", databases: ["policy", "broker"], reason: null };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!["--project", "--databases", "--reason"].includes(key) || value === undefined) {
      throw new Error(`unknown or incomplete option ${key}`);
    }
    if (key === "--project") opts.project = value;
    if (key === "--databases") opts.databases = value.split(",").filter(Boolean);
    if (key === "--reason") opts.reason = value;
    i++;
  }
  if (!["status", "enable", "disable"].includes(command)) throw new Error("command must be status, enable or disable");
  if (command !== "status" && !opts.reason?.trim()) throw new Error(`${command} needs --reason`);
  return opts;
};

const operator = () => {
  try {
    return execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const app = initializeApp({ credential: applicationDefault(), projectId: opts.project });
  const dbs = opts.databases.map(name => ({ name, db: getFirestore(app, name) }));
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
