// Read-only: the captures phase's command records and reservations (Policy's
// database, operator credentials), to explain the observations.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const state = JSON.parse(readFileSync(`${dir}state.json`, "utf8"));
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const decode = v => {
  if (!v) return null;
  for (const k of ["stringValue", "booleanValue", "timestampValue"]) if (k in v) return v[k];
  if ("integerValue" in v) return Number(v.integerValue);
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return null;
};
const get = async path => {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/policy/documents/${path}?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const j = await res.json();
  if (j.documents) return j.documents.map(d => decode({ mapValue: d }));
  return decode({ mapValue: j });
};
const names = ["owner", "composition", "mixed", ...Array.from({ length: 13 }, (_, i) => `anon${i + 1}`)];
for (const [i, id] of state.commands.entries()) {
  const c = await get(`commands/${encodeURIComponent(id)}`);
  const r0 = await get(`commands/${encodeURIComponent(id)}/reservations`); const res = Array.isArray(r0) ? r0 : [];
  console.log(JSON.stringify({ n: names[i], id: id.slice(0, 14), status: c?.status, uid: c?.uid, created: c?.createdAt ?? c?.created ?? null, refusal: c?.admissionRefusal ?? null, failure: c?.failure?.reason ?? c?.result?.reason ?? null, reservations: res.map(r => ({ item: r.item, seq: r.captureSequence, publicCapture: r.publicCapture ?? null, state: r.state ?? r.status ?? null })) }));
}
const ic = await get("item-captures/wbyfys3akpc4yEGFrnuu");
console.log("item-captures public:", JSON.stringify({ next: ic?.nextCaptureSequence, publicCaptures: (ic?.publicCaptures ?? []).length }));
