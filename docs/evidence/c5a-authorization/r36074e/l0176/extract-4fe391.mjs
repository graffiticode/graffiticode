// Read-only: the 4fe391 round-trip's Broker evidence, for the revised verdict.
// Reads the RECORD line of roundtrip-output.txt, then, with the operator's
// credentials: each of the four operations' Broker receipt (claim, steps,
// attempts, run state, final outcome) and Broker's security_audit entries.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const dir = new URL(".", import.meta.url).pathname;
const line = readFileSync(`${dir}roundtrip-output.txt`, "utf8").split("\n").find(l => l.startsWith("RECORD "));
const record = JSON.parse(line.slice(7));
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const base = "https://firestore.googleapis.com/v1/projects/graffiticode/databases/broker/documents";
const get = async p => {
  const res = await fetch(`${base}/${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
};
const list = async p => {
  const res = await fetch(`${base}/${p}?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`LIST ${p}: ${res.status}`);
  return (await res.json()).documents ?? [];
};
const plain = v => v == null ? v : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(plain) : "mapValue" in v ? fields(v.mapValue.fields) : v;
const fields = f => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, plain(v)]));
const receipts = {};
for (const [label, opid] of Object.entries(record.opids)) {
  const id = createHash("sha256").update(opid).digest("hex");
  const claim = await get(`receipts/${id}`);
  const outcome = await get(`receipts/${id}/outcome/final`);
  const run = await get(`receipts/${id}/run/state`);
  const steps = claim ? (await list(`receipts/${id}/steps`)).map(d => fields(d.fields)) : [];
  const attempts = claim ? (await list(`receipts/${id}/attempts`)).map(d => fields(d.fields)) : [];
  const c = claim ? fields(claim.fields) : null;
  receipts[label] = {
    opid, claim: c ? { operationId: c.operationId, claimedAt: c.claimedAt } : null,
    outcome: outcome ? (({ status, steps, at }) => ({ status, steps, at }))(fields(outcome.fields)) : null,
    run: run ? fields(run.fields) : null, steps: steps.map(s => ({ n: s.n, step: s.step })), attempts: attempts.length,
  };
}
const filter = `resource.type="cloud_run_revision" AND (resource.labels.service_name="broker" OR resource.labels.service_name="broker-faults") AND jsonPayload.logName="security_audit" AND (${Object.values(record.opids).map(o => `jsonPayload.opid="${o}"`).join(" OR ")}) AND timestamp>="${record.startedAt}"`;
const entries = JSON.parse(execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", "--limit=500", "--format=json"]).toString());
const audit = entries.map(e => ({ at: e.timestamp, service: e.resource.labels.service_name, opid: e.jsonPayload.opid, event: e.jsonPayload.event, outcome: e.jsonPayload.outcome, reason: e.jsonPayload.reason ?? null, purpose: e.jsonPayload.purpose ?? null, step: e.jsonPayload.step ?? null })).sort((a, b) => a.at.localeCompare(b.at));
const out = { run: record.run, target: { api: "production", revision: record.revision, url: record.staged }, extractedAt: new Date().toISOString(), opids: record.opids, original: record.original, repair: { commandId: record.repair.commandId, invocationId: record.repair.invocationId, status: record.repair.status, selection: record.repair.selection }, receipts, audit, receiptListing: record.receipts };
writeFileSync(`${dir}evidence-4fe391.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ receipts, audit }, null, 1));
