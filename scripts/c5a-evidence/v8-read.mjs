// LIVE (held for the owner's review): the v8 artifact row. Reads a registry-8
// artifact (v8-provenance.mjs) through today's production api as its owner,
// the canary account, through its connection, and checks it is served, its
// bindings and content are unchanged, and nothing was dispatched.
//   node v8-read.mjs <provenance.json> <out.json>
// A view never runs the program (packages/api/src/read.js). For L0176 it
// allocates a read invocation (key read.<artifact invocation>) and has the
// compiler re-sign the stored activity: a Policy invocation record and a
// Broker `sign` step, never a dispatch. Needs Secret Manager `canary-api-key`
// and the operator's credentials for the artifact, Policy's idempotency
// record and Broker's audit. The audit is polled (bounded) until the read
// invocation's preview signing is seen, then read once more after a settling
// period; a collection that hits its read limit is marked truncated, and one
// that never sees the signing incomplete. Either fails (the #421 review).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { createCanaryEnv, http } from "../lib/canary-env.js";
import { v8ReadProblems, addedFields, readSigningSeen } from "../lib/c5a-evidence-checks.js";
const [provenanceFile, outFile] = process.argv.slice(2);
if (!outFile) throw new Error("usage: v8-read.mjs <provenance.json> <out.json>");
const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
if (provenance.problems?.length) throw new Error(`provenance problems: ${provenance.problems.join("; ")}`);
const { invocationId, uid, taskId, connectionId } = provenance.artifact;
const API = "https://api.graffiticode.org";
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const H = { Authorization: `Bearer ${token}` };
const doc = async p => {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/(default)/documents/${p}`, { headers: H });
  if (!res.ok) throw new Error(`${p}: ${res.status}`);
  return res.json();
};
const BINDING = ["uid", "ownerUid", "connectionId", "taskId", "invocationId", "seq", "registryVersion"];
const value = v => v?.stringValue ?? (v?.integerValue !== undefined ? Number(v.integerValue) : null);
const headId = createHash("sha256").update(JSON.stringify([uid, taskId, connectionId])).digest("hex");
const state = async () => {
  const a = await doc(`artifacts/${invocationId}`);
  const h = await doc(`artifact-heads/${headId}`);
  const content = JSON.parse(a.fields.content.stringValue);
  return { binding: Object.fromEntries(BINDING.map(f => [f, value(a.fields[f])])), contentDigest: value(a.fields.contentDigest), recomputed: canonicalDigest(content), updateTime: a.updateTime, head: { invocationId: value(h.fields.invocationId), seq: value(h.fields.seq) }, content };
};
const { accessToken } = createCanaryEnv({ uid, project: "graffiticode", authUrl: "https://auth.graffiticode.org" });
const before = await state();
const startedAt = new Date().toISOString();
const res = await http({ method: "GET", url: `${API}/data?id=${encodeURIComponent(taskId)}&connection=${encodeURIComponent(connectionId)}`, headers: { Authorization: await accessToken() } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + 300_000;
// The view's read invocation: Policy's idempotency record for read.<artifact invocation>.
const keyDoc = createHash("sha256").update(JSON.stringify([uid, `read.${invocationId}`])).digest("hex");
let readInvocationId = null;
while (!readInvocationId && Date.now() < deadline) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/policy/documents/idempotency-keys/${keyDoc}`, { headers: H });
  if (r.ok) readInvocationId = (await r.json()).fields?.invocationId?.stringValue ?? null;
  if (!readInvocationId) await sleep(5_000);
}
// Broker's audit from the read's start, every record, never cut off.
const LIMIT = 1000;
const collect = () => {
  const filter = `resource.type="cloud_run_revision" AND (resource.labels.service_name="broker" OR resource.labels.service_name="broker-faults") AND jsonPayload.logName="security_audit" AND timestamp>="${startedAt}"`;
  const raw = JSON.parse(execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", `--limit=${LIMIT}`, "--format=json"]).toString());
  return {
    truncated: raw.length >= LIMIT,
    entries: raw.map(e => ({ at: e.timestamp, service: e.resource.labels.service_name, invocationId: e.jsonPayload.invocationId ?? null, connectionId: e.jsonPayload.connectionId ?? null, opid: e.jsonPayload.opid ?? null, op: e.jsonPayload.op ?? null, event: e.jsonPayload.event, outcome: e.jsonPayload.outcome, purpose: e.jsonPayload.purpose ?? null, step: e.jsonPayload.step ?? null, decisionId: e.jsonPayload.decisionId ?? null }))
      .sort((x, y) => x.at.localeCompare(y.at)),
  };
};
let collected = { entries: [], truncated: false };
let polls = 0;
let seenAt = null;
while (readInvocationId && Date.now() < deadline) {
  collected = collect();
  polls++;
  if (readSigningSeen(collected.entries, readInvocationId)) { seenAt = new Date().toISOString(); break; }
  await sleep(10_000);
}
// Settle, then the final collection: a late record (a dispatch) still counts.
if (seenAt) { await sleep(60_000); collected = collect(); polls++; }
const broker = { ...collected, complete: Boolean(seenAt) && readSigningSeen(collected.entries, readInvocationId), polls, seenAt };
const after = await state();
const served = { status: res.status, body: res.json };
const problems = v8ReadProblems({ before, after, stored: before.content, served, readInvocationId, broker });
const strip = s => ({ binding: s.binding, contentDigest: s.contentDigest, recomputed: s.recomputed, updateTime: s.updateTime, head: s.head });
const readOps = broker.entries.filter(e => e.invocationId === readInvocationId).map(e => ({ opid: e.opid, op: e.op, event: e.event, purpose: e.purpose, outcome: e.outcome, decisionId: e.decisionId }));
const out = { row: "v8Artifact", at: startedAt, api: API, invocationId, readInvocationId, readOps, before: strip(before), after: strip(after), served: { status: res.status, errors: res.json?.data?.errors ?? null, servedDataDigest: res.json?.data?.data ? canonicalDigest(res.json.data.data) : null, added: addedFields(before.content, served) }, broker, problems, observation: { served: problems.length === 0 } };
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(problems.length ? `v8 artifact: FAILED: ${problems.join("; ")}` : `v8 artifact: served unchanged; read invocation ${readInvocationId}, ${readOps.length} signing record(s); ${broker.entries.length} Broker record(s) in ${polls} poll(s), no dispatch`);
process.exitCode = problems.length ? 1 : 0;
