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
// One Google auth client (GoogleAuth, the operator's application-default
// credentials) is built here. Its access token is the one token-info
// verifies, before any Firestore call and again before the act, and Policy's
// database is opened with that same client as its `auth`, never from ambient
// credentials (firebase-admin 11 would let its Firestore find ADC on its own).
// The token is never printed or written.
// Each new act writes its intent file once, before it is first sent; a retry
// re-sends that file (`--intent`), and a committed act answers
// `replayed: true` and writes nothing. The rules live in
// scripts/lib/command-hold.js; the transaction in @graffiticode/policy/holds.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import gax from "google-gax";
import firestore from "@google-cloud/firestore";
import { createFirestoreHolds } from "@graffiticode/policy/holds";
import { HoldRefused, createAuthClient, parse, policyFirestore, runAct } from "./lib/command-hold.js";

const { GoogleAuth } = gax;
const { Firestore } = firestore;

const ROOT = new URL("..", import.meta.url).pathname;

const gcloudAccount = () => execFileSync("gcloud", ["config", "get-value", "account"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const main = async () => {
  const opts = parse(process.argv.slice(2));
  const auth = createAuthClient({ GoogleAuth, projectId: opts.project });
  if (opts.command === "status") {
    const found = await createFirestoreHolds(policyFirestore({ Firestore, projectId: opts.project, auth })).status(opts.commandId);
    if (!found) throw new HoldRefused("command-not-found", `${opts.commandId} not found`);
    const { command, hold, history } = found;
    console.log(JSON.stringify({ commandId: opts.commandId, status: command.status, phase: command.phase, generation: command.owner?.generation, leaseExpiresAt: command.owner?.leaseExpiresAt, hold, history }, null, 2));
    return;
  }
  const out = await runAct(opts, {
    root: ROOT,
    fs,
    auth,
    Firestore,
    projectId: opts.project,
    createHolds: createFirestoreHolds,
    fetch: globalThis.fetch,
    gcloudAccount,
  });
  console.log(JSON.stringify({ intent: out.intentPath, appliedBy: out.appliedBy, ...out.result }, null, 2));
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(err => {
    console.error(err instanceof HoldRefused ? `refused (${err.reason}): ${err.message}` : err.message);
    process.exitCode = 1;
  });
}
