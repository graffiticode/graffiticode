#!/usr/bin/env node
// RETAIN-01 check (W5 stage 2). Read-only.
//
//   node scripts/retention-check.js
//       For the policy, broker, (default) and revisions databases: no TTL
//       policy on a protected collection (only jtis, active-executions and
//       admission-leases may expire), point-in-time recovery on, and a backup
//       schedule. Exits non-zero unless every part passes; a gcloud failure is
//       "incomplete", never a pass.
//
//   node scripts/retention-check.js --compare --policy-restore <db> --broker-restore <db> \
//       --canary-connection <id>
//       The restore test: compares two scratch databases restored from backups
//       with production. The cutoff is the earlier of the two backups' exact
//       snapshot times (read from each restore's source backup) minus a
//       minute. Documents last updated before it are compared field for
//       field; documents updated since are checked for existence; the
//       idempotency key -> invocation -> plan -> receipt links are checked;
//       the canary's earlier receipts must all be present. No point-in-time
//       reads, and no timestamp is rounded.
//
// Evidence goes to .gc-deploy/retention/. Options: --project (default graffiticode).
// The logic is in scripts/lib/retention.js.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATABASES, PROTECTED, checkDatabase, configVerdict, compareDatabase, compareRelationships, cutoffFor, fixtureCheck,
} from "./lib/retention.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".gc-deploy", "retention");

export const parse = argv => {
  const opts = { project: "graffiticode", compare: false, policyRestore: null, brokerRestore: null, canaryConnections: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--compare") { opts.compare = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${key} needs a value`);
    if (key === "--project") opts.project = value;
    else if (key === "--policy-restore") opts.policyRestore = value;
    else if (key === "--broker-restore") opts.brokerRestore = value;
    else if (key === "--canary-connection") opts.canaryConnections.push(value);
    else throw new Error(`unknown option ${key}`);
  }
  if (opts.compare && (!opts.policyRestore || !opts.brokerRestore)) throw new Error("--compare needs --policy-restore and --broker-restore");
  if (opts.compare && !opts.canaryConnections.length) throw new Error("--compare needs --canary-connection (its earlier receipts are the fixtures)");
  for (const db of [opts.policyRestore, opts.brokerRestore].filter(Boolean)) {
    if (DATABASES.includes(db)) throw new Error(`${db} is a production database, not a restore`);
  }
  return opts;
};

const gcloud = args => JSON.parse(execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "null");

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const save = async (name, value) => {
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${name}-${timestamp()}.json`);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

const configuration = async opts => {
  const results = [];
  for (const database of DATABASES) results.push(await checkDatabase({ run: gcloud, project: opts.project, database }));
  for (const r of results) {
    console.log(`${r.database}`);
    for (const part of ["ttl", "pitr", "backups"]) console.log(`  ${r[part].result.toUpperCase().padEnd(10)} ${part}: ${r[part].detail}`);
  }
  const verdict = configVerdict(results);
  const file = await save("config", { project: opts.project, at: new Date().toISOString(), verdict, results });
  console.log(`verdict ${verdict}; evidence in ${path.relative(ROOT, file)}`);
  if (verdict !== "pass") process.exitCode = 1;
};

// Every document under the protected collections of one database, with its
// server create and update times.
const readDocs = async (database, project, patterns) => {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore(app, database);
  const docs = [];
  const take = snap => snap.docs.forEach(d => docs.push({ path: d.ref.path, data: d.data(), createTime: d.createTime.toMillis(), updateTime: d.updateTime.toMillis() }));
  for (const pattern of patterns) {
    const parts = pattern.split("/");
    if (parts.length === 1) take(await db.collection(pattern).get());
    else take(await db.collectionGroup(parts[parts.length - 1]).get());
  }
  // Collection groups match by name anywhere; keep only paths under the pattern.
  return docs.filter(d => patterns.some(p => {
    const q = p.split("/");
    const s = d.path.split("/");
    return s.length === q.length + 1 && q.every((seg, i) => seg === "*" || seg === s[i]);
  }));
};

// A restored database's backup snapshot time, exactly as recorded (ms).
const snapshotTimeOf = (project, database) => {
  const described = gcloud(["firestore", "databases", "describe", `--project=${project}`, `--database=${database}`, "--format=json"]);
  const backup = described?.sourceInfo?.backup?.backup;
  if (!backup) throw new Error(`${database} has no source backup recorded; is it a restore?`);
  const info = gcloud(["firestore", "backups", "describe", backup, "--format=json"]);
  const t = Date.parse(info?.snapshotTime);
  if (!Number.isFinite(t)) throw new Error(`backup ${backup} has no snapshot time`);
  return { backup, snapshotTime: info.snapshotTime, ms: t };
};

const compare = async opts => {
  const snapshots = { policy: snapshotTimeOf(opts.project, opts.policyRestore), broker: snapshotTimeOf(opts.project, opts.brokerRestore) };
  const cutoff = cutoffFor([snapshots.policy.ms, snapshots.broker.ms]);
  console.log(`cutoff ${new Date(cutoff).toISOString()} (policy backup ${snapshots.policy.snapshotTime}, broker backup ${snapshots.broker.snapshotTime}, minus 60 s)`);
  const policyProduction = await readDocs("policy", opts.project, PROTECTED.policy);
  const policyRestored = await readDocs(opts.policyRestore, opts.project, PROTECTED.policy);
  const brokerProduction = await readDocs("broker", opts.project, PROTECTED.broker);
  const brokerRestored = await readDocs(opts.brokerRestore, opts.project, PROTECTED.broker);
  const databases = [
    compareDatabase({ database: "policy", production: policyProduction, restored: policyRestored, cutoff }),
    compareDatabase({ database: "broker", production: brokerProduction, restored: brokerRestored, cutoff }),
  ];
  const relationships = compareRelationships({ policyRestored, brokerRestored, policyProduction, brokerProduction, cutoff });
  const fixtures = fixtureCheck({ brokerProduction, brokerRestored, cutoff, canaryConnections: opts.canaryConnections });
  for (const d of databases) {
    console.log(`${d.database}: ${d.reference} reference documents compared, ${d.updatedSince} updated since checked for existence, ${d.problems.length} problems`);
    for (const [p, c] of Object.entries(d.counts)) console.log(`  ${p}: ${c.restoredOfReference}/${c.reference}`);
    for (const problem of d.problems.slice(0, 20)) console.log(`  ${problem}`);
  }
  console.log(`relationships: ${relationships.length} problems`);
  for (const problem of relationships.slice(0, 20)) console.log(`  ${problem}`);
  console.log(`canary fixtures: ${fixtures.fixtures} before the cutoff, ${fixtures.missing.length} missing`);
  const ok = databases.every(d => d.problems.length === 0 && d.reference > 0) && relationships.length === 0 && fixtures.fixtures > 0 && fixtures.missing.length === 0;
  // Counts and problem paths only: no document contents leave the databases.
  const file = await save("restore", {
    project: opts.project,
    at: new Date().toISOString(),
    verdict: ok ? "pass" : "fail",
    restores: { policy: opts.policyRestore, broker: opts.brokerRestore },
    snapshots,
    cutoff: new Date(cutoff).toISOString(),
    databases: databases.map(({ database, reference, updatedSince, counts, problems }) => ({ database, reference, updatedSince, counts, problems })),
    relationships,
    fixtures,
  });
  console.log(`verdict ${ok ? "pass" : "fail"}; evidence in ${path.relative(ROOT, file)}`);
  if (!ok) process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parse(process.argv.slice(2));
  await (opts.compare ? compare(opts) : configuration(opts));
}
