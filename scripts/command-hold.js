#!/usr/bin/env node
// The durable command hold, an Owner's act (C5d, docs/c5d-refusal-and-hold-plan.md
// decisions 6–11).
//
//   node scripts/command-hold.js status <commandId>
//   node scripts/command-hold.js apply <commandId> --reason <slug> --note <text> --decision <ref> --operator <email>
//   node scripts/command-hold.js lift <commandId> --lifts <actId> --reason <slug> --note <text> --decision <ref> --operator <email>
//   node scripts/command-hold.js apply|lift --intent <file> --operator <email>      (a retry)
//
// Options: --decided-by <name> (default "owner"), --intent-dir <dir> (default
// docs/evidence/command-holds; C5d's acts use docs/evidence/c5d/hold),
// --project <id> (default graffiticode).
//
// A held command is refused to every worker, takeover and renewal; nothing
// else on it changes, and a lift restores it. Apply is refused while the
// command's lease is live or within 100 s of it, by Firestore's clock.
//
// One application-default credential (the operator's) is built here, and is
// both the Firestore client's and the one whose access token token-info
// verifies before any Firestore call. The token is never printed or written.
// Each new act writes its intent file once, before it is first sent; a retry
// re-sends that file (`--intent`), and a committed act answers
// `replayed: true` and writes nothing. The rules live in
// scripts/lib/command-hold.js; the transaction in @graffiticode/policy/holds.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createFirestoreHolds } from "@graffiticode/policy/holds";
import { HoldRefused, parse, runAct } from "./lib/command-hold.js";

const ROOT = new URL("..", import.meta.url).pathname;

const gcloudAccount = () => execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const credential = applicationDefault();
  const app = initializeApp({ credential, projectId: opts.project });
  const holds = () => createFirestoreHolds(getFirestore(app, "policy"));
  if (opts.command === "status") {
    const found = await holds().status(opts.commandId);
    if (!found) throw new HoldRefused("command-not-found", `${opts.commandId} not found`);
    const { command, hold, history } = found;
    console.log(JSON.stringify({ commandId: opts.commandId, status: command.status, phase: command.phase, generation: command.owner?.generation, leaseExpiresAt: command.owner?.leaseExpiresAt, hold, history }, null, 2));
    return;
  }
  const out = await runAct(opts, {
    root: ROOT,
    fs,
    getAccessToken: () => credential.getAccessToken(),
    fetch: globalThis.fetch,
    gcloudAccount,
    openHolds: holds,
  });
  console.log(JSON.stringify({ intent: out.intentPath, appliedBy: out.appliedBy, ...out.result }, null, 2));
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(err => {
    console.error(err instanceof HoldRefused ? `refused (${err.reason}): ${err.message}` : err.message);
    process.exitCode = 1;
  });
}
