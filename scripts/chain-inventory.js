#!/usr/bin/env node
// The protected-chain inventory (scripts/lib/chain-inventory.js): dated
// evidence that every chain compiled through a connection in the window has
// stages only in pinnable languages (deploy.json `pinnable`: L0000, L0176).
// Run it before CHAIN_ADMISSION=all (docs/protected-execution.md).
//
//   node scripts/chain-inventory.js [--days 30 | --since <ISO>] [--until <ISO>] [--project graffiticode] [--out <file>]
//
// Reads, with the operator's application-default credentials: Policy's
// `invocations` (database `policy`, from Policy's POLICY_FIRESTORE_DB) and
// api's `tasks` (the default database). Read-only. Writes the evidence to
// --out (default .gc-deploy/inventory/chain-inventory-<until>.json) whatever
// the verdict, and exits non-zero unless it passes: incomplete evidence is a
// failure, never a pass.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { buildChainInventory } from "./lib/chain-inventory.js";

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = message => {
  console.error(message);
  process.exit(2);
};
const parseDate = (value, name) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${name} must be an ISO date, not ${value}`);
  return d;
};

const project = flag("--project") ?? "graffiticode";
const until = flag("--until") ? parseDate(flag("--until"), "--until") : new Date();
const days = flag("--days") ? Number(flag("--days")) : 30;
if (!flag("--since") && !(Number.isInteger(days) && days > 0)) fail("--days must be a positive whole number");
const since = flag("--since") ? parseDate(flag("--since"), "--since") : new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
if (!(since < until)) fail("the window must start before it ends");

const ROOT = new URL("..", import.meta.url).pathname;
const deploy = JSON.parse(await readFile(path.join(ROOT, "deploy.json"), "utf8")).services;
const pinnable = Object.values(deploy).filter(s => s.pinnable?.lang).map(s => s.pinnable.lang);
const policyDatabase = deploy.policy?.env?.POLICY_FIRESTORE_DB;
if (!policyDatabase) fail("deploy.json names no POLICY_FIRESTORE_DB for policy");
const out = flag("--out") ?? path.join(ROOT, ".gc-deploy", "inventory", `chain-inventory-${until.toISOString().slice(0, 10)}.json`);

const app = initializeApp({ credential: applicationDefault(), projectId: project });
const policyDb = getFirestore(app, policyDatabase);
const apiDb = getFirestore(app);

// Invocations record createdAt as ISO text, so the window compares as text.
const inWindow = ({ since, until }) => policyDb.collection("invocations")
  .where("createdAt", ">=", since.toISOString())
  .where("createdAt", "<", until.toISOString());
const PAGE = 500;
const invocations = {
  count: async window => (await inWindow(window).count().get()).data().count,
  async * scan(window) {
    let last = null;
    for (;;) {
      let query = inWindow(window).orderBy("createdAt").limit(PAGE);
      if (last) query = query.startAfter(last);
      const page = await query.get();
      for (const doc of page.docs) {
        const { taskId, createdAt } = doc.data();
        yield { taskId, createdAt };
      }
      if (page.size < PAGE) return;
      last = page.docs[page.docs.length - 1];
    }
  },
};
const taskLang = async taskId => {
  const doc = await apiDb.doc(`tasks/${taskId}`).get();
  return doc.exists ? (doc.get("lang") ?? undefined) : null;
};

console.log(`chain inventory for ${project}: ${since.toISOString()} to ${until.toISOString()}, pinnable ${pinnable.join(", ")}`);
const evidence = await buildChainInventory({ invocations, taskLang, pinnable, since, until });
const record = { ...evidence, source: { project, policyDatabase, invocations: "invocations", apiDatabase: "(default)", tasks: "tasks" } };
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);

const { coverage, totals } = evidence;
console.log(`  invocations: ${coverage.invocationsScanned} scanned of ${coverage.invocationsCounted ?? "?"} counted${coverage.complete ? "" : " (INCOMPLETE)"}; ${coverage.distinctChains} distinct chains`);
for (const row of evidence.bySignature) console.log(`  ${row.langs.join(" <- ")}: ${row.chains} chains, ${row.invocations} invocations`);
console.log(`  supported ${totals.supported}, unsupported ${totals.unsupported}, unreadable ${totals.unreadable}`);
for (const c of evidence.unsupported) console.log(`  UNSUPPORTED ${c.langs.join(" <- ")} (${c.invocations} invocations, last ${c.lastSeen}): ${c.chainId}`);
for (const c of evidence.unreadable) console.log(`  UNREADABLE ${c.reason} (${c.invocations} invocations, last ${c.lastSeen}): ${c.chainId}`);
console.log(`${evidence.verdict === "pass" ? "inventory passed" : `inventory FAILED: ${evidence.reasons.join(", ")}`}; evidence in ${path.relative(process.cwd(), out)}`);
process.exit(evidence.verdict === "pass" ? 0 : 1);
