#!/usr/bin/env node
// Operator control for approved compiler revisions (capability plan W4,
// section A; runbook: docs/protected-execution.md, "Approved revisions").
//
//   node scripts/revisions.js status <service>
//   node scripts/revisions.js retire <service> --release <release-id> [--confirm-unrecoverable]
//   node scripts/revisions.js retire <service> --release <release-id> --resume
//   node scripts/revisions.js retire <service> --release <release-id> --cancel
//
// Releases of a pinnable service (deploy.json `pinnable`) are recorded as
// approved by the deploy CLI; admitted plans pin them, and their tags are kept.
// `retire` is the only way to stop a revision being pinnable:
//   1. marks it `retiring` (no new plan pins it; its snapshots are refused),
//   2. fences admissions in flight (invalidates their leases),
//   3. reports the plans that still need it to recover (uncertain or
//      unfinished writes, unstored artifacts), from fresh reads,
//   4. without --confirm-unrecoverable and with anything reported, cancels
//      itself (approved again); otherwise marks it `retired`, waits 15 min for
//      proofs issued before then, and removes its tag.
// An interrupted retire leaves `retiring` (release-check flags it): --resume
// continues, --cancel restores `approved`.
//
// Uses application-default credentials (the operator) for Firestore, and
// gcloud for the tag. The logic lives in @graffiticode/policy/revisions.

import { execFileSync } from "node:child_process";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, parseArgs as parseDeployArgs } from "../packages/deploy/src/config.js";
import { readReceipt } from "../packages/deploy/src/release.js";
import { recoveryReport, retireRevision, revisionRef } from "@graffiticode/policy/revisions";

const ROOT = new URL("..", import.meta.url).pathname;

export const parse = argv => {
  const [command, service, ...rest] = argv;
  if (!["status", "retire"].includes(command) || !service || service.startsWith("--")) {
    throw new Error("usage: revisions.js status <service> | retire <service> --release <id> [--confirm-unrecoverable | --resume | --cancel]");
  }
  const opts = { command, service, release: null, confirmUnrecoverable: false, resume: false, cancel: false };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === "--confirm-unrecoverable") opts.confirmUnrecoverable = true;
    else if (key === "--resume") opts.resume = true;
    else if (key === "--cancel") opts.cancel = true;
    else if (key === "--release" && rest[i + 1] && /^[a-z0-9-]+$/.test(rest[i + 1])) opts.release = rest[++i];
    else throw new Error(`unknown or incomplete option ${key}`);
  }
  if (command === "retire") {
    if (!opts.release) throw new Error("retire requires --release <release-id>");
    if ([opts.confirmUnrecoverable, opts.resume, opts.cancel].filter(Boolean).length > 1 && !(opts.resume && opts.confirmUnrecoverable)) {
      throw new Error("--cancel stands alone; --confirm-unrecoverable may go with --resume");
    }
  }
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
  const { config } = await loadConfig(parseDeployArgs([opts.service]), ROOT);
  if (!config.pinnable) throw new Error(`${opts.service} is not pinnable in deploy.json`);
  const lang = config.pinnable.lang;
  const app = initializeApp({ credential: applicationDefault(), projectId: config.project });
  const revisionsDb = getFirestore(app, config.pinnable.database ?? "revisions");
  const log = message => console.log(message);

  if (opts.command === "status") {
    const snap = await revisionsDb.collection("languages").doc(lang).collection("revisions").get();
    const records = snap.docs.map(d => d.data()).sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)));
    for (const r of records) log(`${r.status.padEnd(9)} ${r.revision}  tag ${r.tag}  ${String(r.commit).slice(0, 12)}${r.status === "retiring" ? `  (since ${r.retiringSince} by ${r.retiringBy}: resume or cancel)` : ""}`);
    if (!records.length) log(`No recorded revisions for ${opts.service} (${lang}).`);
    return;
  }

  const receipt = await readReceipt(ROOT, opts.release);
  if (receipt.service !== opts.service || !receipt.revision) throw new Error(`release ${opts.release} is not a ${opts.service} revision`);
  const record = (await revisionRef(revisionsDb, lang, receipt.revision).get()).data();
  if (!opts.cancel && record?.status === "approved") {
    const service = JSON.parse(execFileSync("gcloud", ["run", "services", "describe", opts.service, `--project=${config.project}`, `--region=${config.region}`, "--format=json"], { encoding: "utf8" }));
    if (Object.prototype.hasOwnProperty.call(Object.fromEntries((service.status?.traffic ?? []).filter(t => t.percent).map(t => [t.revisionName, t.percent])), receipt.revision)) {
      throw new Error(`${receipt.revision} is serving traffic; promote another revision before retiring it`);
    }
  }
  const policyDb = getFirestore(app, "policy");
  const brokerDb = getFirestore(app, "broker");
  const apiDb = getFirestore(app);
  const removeTag = async tag => {
    execFileSync("gcloud", ["run", "services", "update-traffic", opts.service, `--remove-tags=${tag}`, `--project=${config.project}`, `--region=${config.region}`, "--quiet"], { stdio: "inherit" });
  };
  const result = await retireRevision(
    { revisionsDb, policyDb, report: revision => recoveryReport({ policyDb, brokerDb, apiDb }, revision), removeTag, log },
    { lang, revision: receipt.revision, by: operator(), confirmUnrecoverable: opts.confirmUnrecoverable, resume: opts.resume, cancel: opts.cancel },
  );
  if (result.report?.length) {
    log("Plans that need this revision to recover:");
    for (const item of result.report) {
      log(`  ${item.planDigest}  invocation ${item.invocationId ?? "?"}  uncertain ${item.uncertainReceipts}  unfinished ${item.unfinishedReceipts}  artifact ${item.artifactStored ? "stored" : "missing"}`);
    }
  }
  if (result.outcome === "cancelled" && result.report?.length) process.exitCode = 1;
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
