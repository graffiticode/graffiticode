// Read-only: a stored artifact's provenance and state, for the v8 artifact row.
//   node provenance.mjs <invocationId>
// The artifact (api default database artifacts/{id}) with its bindings and a
// recomputed canonical content digest; whether its head still names it (so a
// view serves it); Policy's invocation and plan for it (registry version,
// pinned revisions); and the api's request log lines naming it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalDigest } from "@graffiticode/common/canonical";
const [invocationId] = process.argv.slice(2);
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
writeFileSync(new URL(`./provenance-${invocationId}.json`, import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 1));
