// Read-only: a stored artifact's provenance and state, for the v8 artifact row.
//   node v8-provenance.mjs <invocationId> <out.json>
// The artifact (api default database artifacts/{id}) with its bindings and a
// recomputed canonical content digest; whether its head still names it (so a
// view serves it); Policy's invocation and plan for it (registry version,
// pinned revisions); the api's request log lines naming it; and each api
// revision's serving window (release receipts in .gc-deploy/releases, the
// Cloud Run revision list) with its commit's REGISTRY_VERSION. Judged by
// v8ProvenanceProblems.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { v8ProvenanceProblems } from "../lib/c5a-evidence-checks.js";
const [invocationId, outFile] = process.argv.slice(2);
if (!outFile) throw new Error("usage: v8-provenance.mjs <invocationId> <out.json>");
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const H = { Authorization: `Bearer ${token}` };
const plain = v => v == null ? v : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(plain) : "mapValue" in v ? fields(v.mapValue.fields) : v;
const fields = f => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, plain(v)]));
const get = async (db, p) => {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/${db}/documents/${p}`, { headers: H });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${db}/${p}: ${res.status}`);
  return { fields: fields((await res.json()).fields), updateTime: null };
};
const raw = await (await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/(default)/documents/artifacts/${invocationId}`, { headers: H })).json();
const artifact = fields(raw.fields);
const content = JSON.parse(artifact.content);
const BINDING = ["uid", "ownerUid", "connectionId", "taskId", "invocationId", "seq", "registryVersion"];
const head = await get("(default)", `artifact-heads/${createHash("sha256").update(JSON.stringify([artifact.uid, artifact.taskId, artifact.connectionId])).digest("hex")}`);
const invocation = await get("policy", `invocations/${invocationId}`);
const plan = invocation?.fields.planDigest ? await get("policy", `plans/${invocation.fields.planDigest}`) : null;
const logs = JSON.parse(execFileSync("gcloud", ["logging", "read", `resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND textPayload:"${invocationId}"`, "--project=graffiticode", "--limit=20", "--freshness=30d", "--format=json"]).toString());
const out = {
  invocationId,
  readAt: new Date().toISOString(),
  artifact: { ...Object.fromEntries(BINDING.map(f => [f, artifact[f]])), form: artifact.form ?? "envelope", createdAt: artifact.createdAt, contentDigest: artifact.contentDigest, recomputedDigest: canonicalDigest(content), updateTime: raw.updateTime, createTime: raw.createTime },
  head: head ? { invocationId: head.fields.invocationId, seq: head.fields.seq } : null,
  invocation: invocation ? (({ createdAt, contract, planDigest, protocol, seq, taskId, connectionId }) => ({ createdAt, contract, planDigest, protocol, seq, taskId, connectionId }))(invocation.fields) : null,
  plan: plan ? { registryVersion: plan.fields.plan.registryVersion, revisions: plan.fields.revisions, stages: plan.fields.plan.stages.map(s => ({ lang: s.lang, revision: s.revision, registryVersion: s.registryVersion })) } : null,
  apiLogs: logs.map(e => ({ at: e.timestamp, revision: e.resource.labels.revision_name, line: (e.textPayload ?? "").replace(/Bearer [^ "]+/g, "Bearer <redacted>").slice(0, 200) })),
};
// Each api release's serving window: from its promotion to the next one's.
const releases = new URL("../../.gc-deploy/releases/", import.meta.url).pathname;
const registryOf = commit => {
  for (const f of ["packages/common/src/protected-registry.ts", "packages/common/src/protected-registry.js"]) {
    try {
      const m = execFileSync("git", ["show", `${commit}:${f}`], { stdio: ["ignore", "pipe", "ignore"] }).toString().match(/export const REGISTRY_VERSION(?:: number)? = (\d+)/);
      if (m) return Number(m[1]);
    } catch { /* the next spelling */ }
  }
  return null;
};
const promoted = readdirSync(releases).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(`${releases}${f}`, "utf8")))
  .filter(r => /^api-rmw/.test(r.revision ?? "") && r.status === "released" && r.commit)
  .map(r => ({ revision: r.revision, commit: r.commit, at: JSON.stringify(r).match(/20\d\d-\d\d-\d\dT[\d:.]+Z/g).at(-1) }))
  .sort((x, y) => x.at.localeCompare(y.at));
out.apiWindows = promoted.map((r, i) => ({ revision: r.revision, commit: r.commit, registryVersion: registryOf(r.commit), from: r.at, until: promoted[i + 1]?.at ?? null }));
out.apiRevisionsCreated = JSON.parse(execFileSync("gcloud", ["run", "revisions", "list", "--service=api", "--region=us-central1", "--project=graffiticode", "--format=json"]).toString())
  .map(r => ({ revision: r.metadata.name, created: r.metadata.creationTimestamp, commit: r.metadata.labels?.["commit-sha"] ?? null }));
out.problems = v8ProvenanceProblems({ provenance: out, apiWindows: out.apiWindows });
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ artifact: out.artifact, head: out.head, plan: out.plan, serving: out.apiWindows.filter(w => w.from <= out.artifact.createdAt && (!w.until || out.artifact.createdAt < w.until)), problems: out.problems }, null, 1));
process.exitCode = out.problems.length ? 1 : 0;
