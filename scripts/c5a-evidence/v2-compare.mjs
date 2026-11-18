// The v2 plan digest row (owner's review of r36074e): plan construction at
// the pre-C5a and current Policy commits over identical recorded inputs.
//   node v2-compare.mjs <inputs.json> <before.json> <after.json> <before commit> <after commit> <out.json>
// inputs.json from v2-extract-inputs.mjs; before/after from v2-construct.mjs
// run against each commit's build. Writes the row's record and observation
// ({ before: [digests], after: [digests] }); exits 1 unless every plan agrees.
import { readFileSync, writeFileSync } from "node:fs";
import { v2DigestProblems } from "../lib/c5a-evidence-checks.js";
const [inputsFile, beforeFile, afterFile, beforeCommit, afterCommit, outFile] = process.argv.slice(2);
if (!outFile) throw new Error("usage: v2-compare.mjs <inputs.json> <before.json> <after.json> <before commit> <after commit> <out.json>");
const read = f => JSON.parse(readFileSync(f, "utf8"));
const inputs = read(inputsFile);
const before = read(beforeFile);
const after = read(afterFile);
const cases = inputs.plans.map((rec, i) => ({ recorded: { digest: rec.digest, plan: rec.planDoc.plan, invocationId: rec.planDoc.invocationId, recordedAt: rec.planDoc.createdAt, revisions: rec.planDoc.revisions }, before: before[i], after: after[i] }));
const problems = v2DigestProblems(cases);
const out = {
  row: "v2PlanDigest", at: new Date().toISOString(), commits: { before: beforeCommit, after: afterCommit },
  plans: cases.map(c => ({ ...c.recorded, plan: undefined, before: { registryVersion: c.before?.registryVersion, planDigest: c.before?.planDigest ?? null, refusal: c.before?.refusal ?? null }, after: { registryVersion: c.after?.registryVersion, planDigest: c.after?.planDigest ?? null, refusal: c.after?.refusal ?? null } })),
  problems, ok: problems.length === 0,
  observation: { before: cases.map(c => c.before?.planDigest ?? null), after: cases.map(c => c.after?.planDigest ?? null) },
};
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
for (const p of out.plans) console.log(`${p.digest.slice(0, 12)} (${p.recordedAt}): before ${p.before.planDigest?.slice(0, 12)} (registry ${p.before.registryVersion}), after ${p.after.planDigest?.slice(0, 12)} (registry ${p.after.registryVersion})`);
console.log(problems.length ? `v2 plan digest: DIFFERS: ${problems.join("; ")}` : "v2 plan digest: identical");
process.exitCode = problems.length ? 1 : 0;
