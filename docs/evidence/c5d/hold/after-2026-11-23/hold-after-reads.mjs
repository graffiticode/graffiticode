// C5d rollout step 4, §5.3 after-reads (read-only). Repeats the preflight's
// reads into <checkout>/docs/evidence/c5d/hold/after-2026-11-23 and compares
// each with the preflight, canonically. Prints a summary only; the token is
// read from GC_TOKEN and never written or printed.
//   GC_TOKEN=… node hold-after-reads.mjs <checkout>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2];
const HOLD = path.join(ROOT, "docs/evidence/c5d/hold");
const PRE = path.join(HOLD, "preflight-2026-11-23");
const OUT = path.join(HOLD, "after-2026-11-23");
mkdirSync(OUT, { recursive: true });
const token = process.env.GC_TOKEN;
const FS = "https://firestore.googleapis.com/v1/projects/graffiticode/databases";
const enc = encodeURIComponent;
const sha = s => createHash("sha256").update(s).digest("hex");
const CMD = "c:f54ea9f1fc642d8d6007c75bf9945ad118eef093a2a209b0af4adc6b5407133f";
const ACT = "ae946e64-dadc-4479-a38a-fc023fad0b97";
const OPID = "inv-078ca8f4-b88f-4fe3-8e04-1cc853b71aa3/s0/x:9eb94a78cb3e9aff42a8cb34cda835fe4ec7d204459a12080dd421919c60e515";
const H1 = sha(OPID);
const OCC = "s0/x:9eb94a78cb3e9aff42a8cb34cda835fe4ec7d204459a12080dd421919c60e515";
const H2 = sha(`inv-b8878442-06cb-4517-9a10-fbee816c5f42/${OCC}`);
const control = JSON.parse(readFileSync(path.join(PRE, "broker-positive-control.json"), "utf8"));
const CONTROL_OPID = control.fields.operationId.stringValue;
const CONTROL_INV = CONTROL_OPID.split("/")[0];

const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const norm = j => JSON.stringify(canon(Array.isArray(j?.documents) ? { ...j, documents: [...j.documents].sort((a, b) => a.name.localeCompare(b.name)) } : j));
const req = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, text: await res.text() };
};
const save = (name, text) => writeFileSync(path.join(OUT, name), text);
const pre = name => JSON.parse(readFileSync(path.join(PRE, name), "utf8"));
const rows = [];
const row = (ok, what, detail = "") => rows.push(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);

// Firestore REST value → plain value.
const val = v => "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue
  : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue
  : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, val(x)]))
  : "arrayValue" in v ? (v.arrayValue.values ?? []).map(val) : v;
const plain = doc => Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, x]) => [k, val(x)]));

// 1. The command: equal to the preflight read except fields.hold and updateTime.
const cmd = await req(`${FS}/policy/documents/commands/${enc(CMD)}`);
save("legacy-command.json", cmd.text);
const after = JSON.parse(cmd.text);
const before = pre("legacy-command-second-read.json");
const { hold: holdField, ...afterFields } = after.fields;
const stripped = j => ({ ...j, updateTime: undefined, fields: Object.fromEntries(Object.entries(j.fields).filter(([k]) => k !== "hold")) });
row(cmd.status === 200 && norm(stripped(after)) === norm(stripped(before)) && !("hold" in before.fields), "command equals the before read except fields.hold and updateTime");
const c = plain(after);
row(c.status === "pending" && c.phase === "admitted" && c.owner?.generation === 11, "command still pending, admitted, generation 11", `${c.status}/${c.phase}/gen ${c.owner?.generation}`);
row(c.hold?.n === 1 && c.hold?.actId === ACT && c.hold?.generation === 11, "hold field: n 1, this act, generation 11");
row(after.updateTime !== before.updateTime, "updateTime moved", `${before.updateTime} → ${after.updateTime}`);

// 2. Subcollections byte-equal (canonically) to the disposal saves; holds has exactly one.
const RUN = path.join(ROOT, "docs/evidence/c5d/drive/ad49c0ac/staging-gone-disposal");
for (const sub of ["occurrences", "reservations", "outcomes", "refusals", "ledger"]) {
  const r = await req(`${FS}/policy/documents/commands/${enc(CMD)}/${sub}?pageSize=50`);
  save(`legacy-${sub}.json`, r.text);
  const saved = readFileSync(path.join(RUN, `1-policy-${sub}.json`), "utf8");
  row(r.status === 200 && norm(JSON.parse(r.text)) === norm(JSON.parse(saved)), `${sub} unchanged`);
}
const holds = await req(`${FS}/policy/documents/commands/${enc(CMD)}/holds?pageSize=50`);
save("legacy-holds.json", holds.text);
const hdocs = JSON.parse(holds.text).documents ?? [];
const h = hdocs[0] ? plain(hdocs[0]) : {};
row(hdocs.length === 1 && hdocs[0].name.endsWith(`/holds/${ACT}`) && h.n === 1 && h.act === "apply" && h.fencing === "lease-expired" && h.appliedBy?.email === process.env.GC_OPERATOR,
  "holds: exactly one document, holds/{actId}, n 1, apply, lease-expired, appliedBy = operator", `${hdocs.length} doc(s)`);

// 3. Broker: read 2 again, unchanged.
for (const p of [`receipts/${H1}`, `receipts/${H1}/outcome/final`, `receipts/${H1}/run/state`, `active-executions/${H1}`]) {
  const r = await req(`${FS}/broker/documents/${p}`);
  row(r.status === 404, `broker ${p.replace(H1, "{H1}")} absent`, String(r.status));
}
const steps = await req(`${FS}/broker/documents/receipts/${H1}/steps?pageSize=5`);
save("legacy-broker-steps.json", steps.text);
row(norm(JSON.parse(steps.text)) === norm(pre("legacy-broker-steps.json")), "broker steps unchanged (none)");
const query = inv => ({ structuredQuery: { from: [{ collectionId: "receipts" }], where: { compositeFilter: { op: "AND", filters: [
  { fieldFilter: { field: { fieldPath: "operationId" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: `${inv}/` } } },
  { fieldFilter: { field: { fieldPath: "operationId" }, op: "LESS_THAN", value: { stringValue: `${inv}0` } } }] } } } });
const legacyQ = await req(`${FS}/broker/documents:runQuery`, { method: "POST", body: JSON.stringify(query(OPID.split("/")[0])) });
save("broker-legacy-invocation-query.json", legacyQ.text);
row(JSON.parse(legacyQ.text).every(x => !x.document), "broker legacy invocation query: no claim");
const controlQ = await req(`${FS}/broker/documents:runQuery`, { method: "POST", body: JSON.stringify(query(CONTROL_INV)) });
save("broker-control-invocation-query.json", controlQ.text);
const cdocs = JSON.parse(controlQ.text).filter(x => x.document);
const precdocs = pre("broker-control-invocation-query.json").filter(x => x.document);
row(cdocs.length >= 1 && norm(cdocs.map(x => x.document)) === norm(precdocs.map(x => x.document)), "broker control query returns its receipt, unchanged", `${cdocs.length} doc(s)`);
const pc = await req(`${FS}/broker/documents/receipts/${sha(CONTROL_OPID)}`);
save("broker-positive-control.json", pc.text);
row(pc.status === 200 && norm(JSON.parse(pc.text)) === norm(control), "broker positive control 200, unchanged");

// 4. The drop-outcome records: no outcome, one reconciliation attempt, unchanged.
const noOut = await req(`${FS}/broker/documents/receipts/${H2}/outcome/final`);
row(noOut.status === 404, "drop-outcome receipts/{H2}/outcome/final still 404", String(noOut.status));
const attempts = await req(`${FS}/broker/documents/receipts/${H2}/reconciliation-attempts?pageSize=50`);
save("drop-outcome-reconciliation-attempts.json", attempts.text);
const adocs = JSON.parse(attempts.text).documents ?? [];
row(adocs.length === 1 && norm(JSON.parse(attempts.text)) === norm(pre("drop-outcome-reconciliation-attempts.json")), "drop-outcome reconciliation attempts: 1, unchanged", `${adocs.length}`);

// 5. Due selection: the released ownableBy over the fetched document, all eight capability combinations.
const { ownableBy } = await import(pathToFileURL(path.join(ROOT, "packages/policy/dist/commands.js")).href);
const combos = [];
for (const recording of [0, 1]) for (const repairs of [0, 1]) for (const scopes of [0, 1]) combos.push({ recording, repairs, scopes, ownable: ownableBy(c, { recording, repairs, scopes }) });
save("ownable-by.json", JSON.stringify(combos, null, 2));
row(combos.length === 8 && combos.every(x => x.ownable === false), "ownableBy false at all 8 capability combinations");
// The same over the before read: shows what the hold changed.
const beforeOwnable = combos.map(({ recording, repairs, scopes }) => ownableBy(plain(before), { recording, repairs, scopes }));
row(true, "for contrast, before the hold", `ownable at ${beforeOwnable.filter(Boolean).length} of 8`);

console.log(rows.join("\n"));
const failed = rows.filter(r => r.startsWith("FAIL")).length;
console.log(`\n${rows.length - 1 - failed} checks ok, ${failed} failed; evidence in ${OUT}`);
process.exit(failed ? 1 : 0);
