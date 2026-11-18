// Read-only: a recorded v2 plan's admission inputs, exactly as Policy stored
// them, for re-running plan construction at two Policy commits.
//   node extract-inputs.mjs <planDigest>... > inputs.json
// Reads Policy's plans/{digest} and invocations/{id}, the revisions database's
// approval record of each pinned revision, and the connection's non-secret
// fields (ownerUid, backend, status, ownerPermissions; never credentials).
import { execFileSync } from "node:child_process";
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const plain = v => v == null ? v : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(plain) : "mapValue" in v ? fields(v.mapValue.fields) : v;
const fields = f => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, plain(v)]));
const get = async (db, path, mask = null) => {
  const q = mask ? `?${mask.map(m => `mask.fieldPaths=${m}`).join("&")}` : "";
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/${db}/documents/${path}${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${db}/${path}: ${res.status}`);
  return fields((await res.json()).fields);
};
const out = { extractedAt: new Date().toISOString(), plans: [] };
for (const digest of process.argv.slice(2)) {
  const planDoc = await get("policy", `plans/${digest}`);
  const invocation = await get("policy", `invocations/${planDoc.invocationId}`);
  const approvals = [];
  for (const st of planDoc.plan.stages) approvals.push(await get("revisions", `languages/${st.lang}/revisions/${st.revision}`));
  const connection = await get("policy", `connections/${encodeURIComponent(planDoc.plan.connectionId)}`, ["ownerUid", "backend", "status", "ownerPermissions"]);
  out.plans.push({ digest, planDoc, invocation, approvals, connection: { connectionId: planDoc.plan.connectionId, ...connection } });
}
console.log(JSON.stringify(out, null, 2));
