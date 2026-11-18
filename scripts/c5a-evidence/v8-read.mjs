// LIVE (held for the owner's review): the v8 artifact row. Reads a registry-8
// artifact (v8-provenance.mjs) through today's production api as its owner,
// the canary account, through its connection, and checks it is served, its
// bindings and content are unchanged, and nothing was dispatched.
//   node v8-read.mjs <provenance.json> <out.json>
// A view never runs the program (packages/api/src/read.js). For L0176 it
// allocates a read invocation (key read.<artifact invocation>) and has the
// compiler re-sign the stored activity: a Policy invocation record and a
// Broker `sign` step, never a dispatch. Needs Secret Manager `canary-api-key`
// and the operator's credentials for the artifact and Broker's audit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { createCanaryEnv, http } from "../lib/canary-env.js";
import { v8ReadProblems, addedFields } from "../lib/c5a-evidence-checks.js";
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
await new Promise(r => setTimeout(r, 20_000));
const after = await state();
const filter = `resource.type="cloud_run_revision" AND (resource.labels.service_name="broker" OR resource.labels.service_name="broker-faults") AND jsonPayload.logName="security_audit" AND timestamp>="${startedAt}"`;
const broker = JSON.parse(execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", "--limit=200", "--format=json"]).toString())
  .map(e => ({ at: e.timestamp, service: e.resource.labels.service_name, event: e.jsonPayload.event, outcome: e.jsonPayload.outcome, purpose: e.jsonPayload.purpose ?? null, step: e.jsonPayload.step ?? null, op: e.jsonPayload.op ?? e.jsonPayload.operation ?? null }));
const served = { status: res.status, body: res.json };
const problems = v8ReadProblems({ before, after, stored: before.content, served, broker });
const strip = s => ({ binding: s.binding, contentDigest: s.contentDigest, recomputed: s.recomputed, updateTime: s.updateTime, head: s.head });
const out = { row: "v8Artifact", at: startedAt, api: API, invocationId, before: strip(before), after: strip(after), served: { status: res.status, errors: res.json?.data?.errors ?? null, servedDataDigest: res.json?.data?.data ? canonicalDigest(res.json.data.data) : null, added: addedFields(before.content, served) }, broker, problems, observation: { served: problems.length === 0 } };
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(problems.length ? `v8 artifact: FAILED: ${problems.join("; ")}` : `v8 artifact: served unchanged, ${broker.length} Broker record(s), no dispatch`);
process.exitCode = problems.length ? 1 : 0;
