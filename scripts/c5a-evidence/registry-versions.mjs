// Read-only: the canary command's stored plan, for the gate's registry-versions
// row (canary.l0185RegistryVersion, canary.l0176RegistryVersion).
//   node registry-versions.mjs <commandId> <out.json>
// Reads Policy's commands/{id} and plans/{admission.planDigest}, and checks the
// stored plan digests to the command's planDigest.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { planDigest } from "@graffiticode/common/contract";
import { registryVersionsObservation } from "../lib/c5a-evidence-checks.js";
const [commandId, outFile] = process.argv.slice(2);
if (!outFile) throw new Error("usage: registry-versions.mjs <commandId> <out.json>");
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const plain = v => v == null ? v : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(plain) : "mapValue" in v ? fields(v.mapValue.fields) : v;
const fields = f => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, plain(v)]));
const get = async p => {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/policy/documents/${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`policy/${p}: ${res.status}`);
  return fields((await res.json()).fields);
};
const record = await get(`commands/${encodeURIComponent(commandId)}`);
const command = { commandId, idempotencyKey: record.idempotencyKey, status: record.status, createdAt: record.createdAt, admission: { planDigest: record.admission?.planDigest ?? null } };
const planDoc = command.admission.planDigest ? await get(`plans/${command.admission.planDigest}`) : null;
const observation = registryVersionsObservation({ command, planDoc, digest: planDoc ? planDigest(planDoc.plan) : null });
const out = { row: "registryVersions", at: new Date().toISOString(), command: { commandId, idempotencyKey: command.idempotencyKey, status: command.status, createdAt: command.createdAt }, ...observation };
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 1));
process.exitCode = observation.problems.length ? 1 : 0;
