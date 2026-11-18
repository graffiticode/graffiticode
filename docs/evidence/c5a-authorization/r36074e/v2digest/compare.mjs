// The v2 plan digest row: plan construction at the pre-C5a and current Policy
// commits over identical recorded inputs. Each must admit, construct exactly
// the recorded plan (canonical JSON) and digest, and the two must agree.
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const inputs = JSON.parse(readFileSync(`${dir}inputs.json`, "utf8"));
const COMMITS = { before: { policy: "2ce1433542edc995787dede3683a5527a5218171", release: "policy-rmwfh9fjc-7e95a3 (last before C5a)" }, after: { policy: "f6132821c5a654c2bfd3fce10ca7b5a5e328bdc2", release: "policy-rmwl4or99-166557 (serving)" } };
const run = c => JSON.parse(readFileSync(`${dir}construct-${c.policy.slice(0, 8)}.json`, "utf8"));
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
const before = run(COMMITS.before);
const after = run(COMMITS.after);
// Which Policy recorded each plan: the release serving when it was written
// (policy-rmwfh9fjc-7e95a3, 2ce14335, promoted 2026-11-13T21:27:52Z; the C5a
// policy-rmwjyqeto-b2be2b, 6918feca, promoted 2026-11-17T00:46:11Z).
const recordedBy = at => (at < "2026-11-13T21:27:52Z" ? "a Policy before 2ce14335" : at < "2026-11-17T00:46:11Z" ? "policy-rmwfh9fjc-7e95a3 (2ce14335, pre-C5a)" : "policy-rmwjyqeto-b2be2b (6918feca, C5a) or later");
const plans = inputs.plans.map((rec, i) => {
  const b = before[i];
  const a = after[i];
  const checks = {
    bothAdmitted: b.admitted === true && a.admitted === true,
    beforeIsRecorded: b.planDigest === rec.digest && canon(b.plan) === canon(rec.planDoc.plan),
    afterIsRecorded: a.planDigest === rec.digest && canon(a.plan) === canon(rec.planDoc.plan),
    digestsRecomputed: b.recomputed === b.planDigest && a.recomputed === a.planDigest,
    sameInvocation: b.invocationId === rec.planDoc.invocationId && a.invocationId === rec.planDoc.invocationId,
  };
  return { recordedDigest: rec.digest, recordedAt: rec.planDoc.createdAt, recordedBy: recordedBy(rec.planDoc.createdAt), invocationId: rec.planDoc.invocationId, revisions: rec.planDoc.revisions, stages: rec.planDoc.plan.stages.map(s => ({ lang: s.lang, revision: s.revision, registryVersion: s.registryVersion })), before: { registryVersion: b.registryVersion, planDigest: b.planDigest ?? null, refusal: b.refusal ?? null }, after: { registryVersion: a.registryVersion, planDigest: a.planDigest ?? null, refusal: a.refusal ?? null }, checks, ok: Object.values(checks).every(Boolean) };
});
const ok = plans.every(p => p.ok);
const out = { row: "v2PlanDigest", commits: COMMITS, at: new Date().toISOString(), plans, ok, observation: { before: plans.map(p => p.before.planDigest), after: plans.map(p => p.after.planDigest) } };
writeFileSync(`${dir}v2-digest.json`, `${JSON.stringify(out, null, 2)}\n`);
for (const p of plans) console.log(`${p.ok ? "ok    " : "FAILED"} ${p.recordedDigest.slice(0, 12)} (${p.recordedAt}, ${p.recordedBy}): before ${p.before.planDigest?.slice(0, 12)} reg ${p.before.registryVersion}, after ${p.after.planDigest?.slice(0, 12)} reg ${p.after.registryVersion} ${JSON.stringify(p.checks)}`);
console.log(ok ? "v2 plan digest: identical" : "v2 plan digest: DIFFERS");
process.exitCode = ok ? 0 : 1;
