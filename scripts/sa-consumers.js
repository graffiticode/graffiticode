#!/usr/bin/env node
// Key retirement checklist, step 4 (docs/capability-policy-iam-review.md,
// Step 11): check a service account for remaining consumers and record the
// coverage. Read-only: it only lists, describes and analyzes. See
// scripts/lib/sa-consumers.js for the checks and their statuses.
//
//   node scripts/sa-consumers.js [--account <email>] [--key <key id>] [--project graffiticode]
//                                [--accept <check>=<reason>]... [--out <file>]
//
// Defaults to firebase-adminsdk-qflje and its key 6bfb0894…. `--accept` records
// the operator's reason for accepting one INCOMPLETE check; it never changes a
// FOUND. Writes the evidence, including the full Analyzer response, to --out
// (default .gc-deploy/iam/sa-consumers-<time>.json), and exits 0 only on PASS.
// It prints resource names, principals and dates; never key material.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  workloadChecks, assetSearch, analyzeImpersonation, authentications, disableWindow, activityFilter, keyEventsFilter, verdict,
  IMPERSONATION_PERMISSIONS, NOT_COVERED,
} from "./lib/sa-consumers.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const project = flag("--project", "graffiticode");
const account = flag("--account", `firebase-adminsdk-qflje@${project}.iam.gserviceaccount.com`);
const keyId = flag("--key", "6bfb0894a4dbec57f2f4d7c9749a9031fe0e7b8b");
const accept = {};
args.forEach((a, i) => {
  if (a !== "--accept") return;
  const [check, ...reason] = String(args[i + 1] ?? "").split("=");
  if (!check || !reason.join("=").trim()) {
    console.error("--accept needs <check>=<reason>");
    process.exit(2);
  }
  accept[check] = reason.join("=").trim();
});
const startedAt = new Date().toISOString();
const ROOT = new URL("..", import.meta.url).pathname;
const out = flag("--out", path.join(ROOT, ".gc-deploy", "iam", `sa-consumers-${startedAt.replace(/[:.]/g, "-")}.json`));

// Never throws: a failure is a result.
const gcloud = gcloudArgs => new Promise(resolve => {
  execFile("gcloud", [...gcloudArgs, `--project=${project}`, "--quiet"], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});
const queryJson = async (gcloudArgs, what) => {
  const r = await gcloud([...gcloudArgs, "--format=json"]);
  if (r.code !== 0) return { incomplete: `${what}: exit ${r.code}: ${r.stderr.trim().split("\n")[0]}` };
  try {
    return { value: JSON.parse(r.stdout || "null") };
  } catch (e) {
    return { incomplete: `${what}: unparseable output: ${e.message}` };
  }
};

console.log(`step 4 for ${account} (key ${keyId.slice(0, 8)}…) in ${project}, ${startedAt}`);
const results = [];

// 4a. Workloads running as it.
for (const check of workloadChecks(gcloud, account)) results.push(await check());
const supplementary = await assetSearch(gcloud, account, project);

// 4b. Who can act as it: the project's Owners (the operators) and the account
// itself are expected; anyone else is FOUND.
const policy = await queryJson(["projects", "get-iam-policy", project], "projects get-iam-policy");
const owners = policy.incomplete ? null : (policy.value?.bindings ?? []).filter(b => b.role === "roles/owner" && !b.condition).flatMap(b => b.members);
const saResource = `//iam.googleapis.com/projects/${project}/serviceAccounts/${account}`;
const analysis = await queryJson([
  "asset", "analyze-iam-policy", `--full-resource-name=${saResource}`,
  `--permissions=${IMPERSONATION_PERMISSIONS.join(",")}`,
  "--expand-groups", "--analyze-service-account-impersonation", "--show-response",
], "asset analyze-iam-policy");
if (!owners) results.push({ check: "who-can-act-as-it", status: "INCOMPLETE", incomplete: [policy.incomplete] });
else if (analysis.incomplete) results.push({ check: "who-can-act-as-it", status: "INCOMPLETE", incomplete: [analysis.incomplete] });
else results.push(analyzeImpersonation(analysis.value, { allowed: [...owners, `serviceAccount:${account}`] }));
const keys = await queryJson(["iam", "service-accounts", "keys", "list", `--iam-account=${account}`, "--managed-by=user"], "keys list");
results.push(keys.incomplete
  ? { check: "user-managed-keys-disabled", status: "INCOMPLETE", incomplete: [keys.incomplete] }
  : (() => {
      const enabled = keys.value.filter(k => !k.disabled).map(k => k.name.split("/").pop());
      return { check: "user-managed-keys-disabled", status: enabled.length ? "FOUND" : "PASS", keys: keys.value.map(k => `${k.name.split("/").pop().slice(0, 8)}… ${k.disabled ? "disabled" : "ENABLED"}`), ...(enabled.length ? { found: enabled.map(k => `${k.slice(0, 8)}… is enabled`) } : {}) };
    })());

// 4c. Its authentications since the key was disabled: the key's disables and
// enables (successful ones only decide the window), then every entry made as
// the account, or minting a credential for it, since.
const describe = await queryJson(["iam", "service-accounts", "describe", account], "service-accounts describe");
const uniqueId = describe.incomplete ? null : describe.value?.uniqueId;
const keyEvents = await queryJson(["logging", "read", keyEventsFilter({ project, keyId }), "--freshness=90d", "--limit=50"], "logging read (key disable)");
const window = keyEvents.incomplete ? { disabledAt: null } : disableWindow(keyEvents.value);
const { disabledAt } = window;
const entries = disabledAt
  ? await queryJson(["logging", "read", activityFilter({ account, uniqueId, disabledAt, project }), "--freshness=90d", "--limit=500"], "logging read (activity)")
  : { incomplete: keyEvents.incomplete ?? "no successful disable of the key found, so no window to read" };
const lastAuth = async (type, check, matches) => {
  const r = await queryJson(["policy-intelligence", "query-activity", `--activity-type=${type}`], `query-activity ${type}`);
  if (r.incomplete) return { check, incomplete: r.incomplete };
  const hit = (r.value ?? []).find(a => matches(String(a.fullResourceName ?? "")));
  return { check, last: hit?.activity?.lastAuthenticatedTime ?? null };
};
const analyzer = [
  uniqueId
    ? await lastAuth("serviceAccountLastAuthentication", "analyzer-account-last-auth", n => n.endsWith(`/serviceAccounts/${account}`) || n.endsWith(`/serviceAccounts/${uniqueId}`))
    : { check: "analyzer-account-last-auth", incomplete: describe.incomplete },
  await lastAuth("serviceAccountKeyLastAuthentication", "analyzer-key-last-auth", n => n.endsWith(`/keys/${keyId}`)),
];
results.push(...authentications({
  disabledAt,
  disableIncomplete: keyEvents.incomplete ?? (disabledAt ? null : "no successful disable of the key in the audit logs"),
  reenabled: window.reenabled ?? [],
  entries,
  analyzer,
  account,
  keyId,
}));

const decided = verdict(results, accept);
const evidence = {
  startedAt,
  finishedAt: new Date().toISOString(),
  project,
  account,
  key: `${keyId.slice(0, 8)}…`,
  verdict: decided.status,
  checks: decided.checks,
  ...(decided.unusedAcceptances ? { unusedAcceptances: decided.unusedAcceptances } : {}),
  supplementary,
  notCovered: NOT_COVERED,
  raw: { impersonationAnalysis: analysis.value ?? null, owners },
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);

for (const c of decided.checks) {
  console.log(`  ${c.status.padEnd(10)} ${c.check}${c.scanned !== undefined ? ` (${c.scanned} scanned)` : ""}`);
  for (const f of c.found ?? []) console.log(`             found: ${typeof f === "string" ? f : `${f.identity} via ${f.via.join("; ")}`}`);
  for (const i of c.incomplete ?? []) console.log(`             incomplete: ${i}`);
  if (c.acceptedBecause) console.log(`             accepted: ${c.acceptedBecause}`);
}
console.log(`  supplementary asset search: ${supplementary.incomplete ? `incomplete: ${supplementary.incomplete[0]}` : `${supplementary.resources.length} resources`}`);
for (const r of supplementary.resources ?? []) console.log(`             ${r}`);
console.log(`verdict ${decided.status}; evidence in ${path.relative(process.cwd(), out)}`);
process.exit(decided.status === "PASS" ? 0 : 1);
