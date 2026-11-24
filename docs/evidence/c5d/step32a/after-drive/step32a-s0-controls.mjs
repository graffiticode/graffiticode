// Step 32a §0, the parts beyond the comparator (read-only): the hold field,
// Broker's control query and positive control (canonically equal to the
// private post-hold after-reads), and the released ownableBy over the fetched
// command for all eight capability combinations.
//   node step32a-s0-controls.mjs <private after-2026-11-23 dir> <policy checkout (built)> <out dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [AFTER, CHECKOUT, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const FS = "https://firestore.googleapis.com/v1/projects/graffiticode/databases";
const CMD = "c:f54ea9f1fc642d8d6007c75bf9945ad118eef093a2a209b0af4adc6b5407133f";
const ACT = "ae946e64-dadc-4479-a38a-fc023fad0b97";
const sha = s => createHash("sha256").update(s).digest("hex");
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const req = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } });
  return { status: res.status, text: await res.text() };
};
const rows = [];
const row = (ok, what, detail = "") => rows.push(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
const val = v => "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue
  : "booleanValue" in v ? v.booleanValue : "nullValue" in v ? null : "timestampValue" in v ? v.timestampValue
  : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, val(x)]))
  : "arrayValue" in v ? (v.arrayValue.values ?? []).map(val) : v;
const plain = doc => Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, x]) => [k, val(x)]));

// The hold.
const cmd = await req(`${FS}/policy/documents/commands/${encodeURIComponent(CMD)}`);
if (cmd.status !== 200) throw new Error(`command read ${cmd.status}`);
const c = plain(JSON.parse(cmd.text));
row(c.hold?.actId === ACT && c.hold?.n === 1 && c.hold?.generation === 11, "fields.hold names this act, n 1, generation 11");
row(c.status === "pending" && c.phase === "admitted" && c.owner?.generation === 11, "command pending, admitted, generation 11", `${c.status}/${c.phase}/${c.owner?.generation}`);
const holds = await req(`${FS}/policy/documents/commands/${encodeURIComponent(CMD)}/holds?pageSize=50`);
const hdocs = JSON.parse(holds.text).documents ?? [];
row(holds.status === 200 && hdocs.length === 1 && hdocs[0].name.endsWith(`/holds/${ACT}`) && !JSON.parse(holds.text).nextPageToken, "holds: exactly that one document", `${hdocs.length}`);

// Broker's controls, against the post-hold after-reads.
const control = JSON.parse(readFileSync(path.join(AFTER, "broker-positive-control.json"), "utf8"));
const CONTROL_OPID = control.fields.operationId.stringValue;
const inv = CONTROL_OPID.split("/")[0];
const query = { structuredQuery: { from: [{ collectionId: "receipts" }], where: { compositeFilter: { op: "AND", filters: [
  { fieldFilter: { field: { fieldPath: "operationId" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: `${inv}/` } } },
  { fieldFilter: { field: { fieldPath: "operationId" }, op: "LESS_THAN", value: { stringValue: `${inv}0` } } }] } } } };
const q = await req(`${FS}/broker/documents:runQuery`, { method: "POST", body: JSON.stringify(query) });
writeFileSync(path.join(OUT, "broker-control-invocation-query.json"), q.text);
const qj = JSON.parse(q.text);
const docsOf = arr => JSON.stringify(canon(arr.filter(x => x.document).map(x => x.document).sort((a, b) => a.name.localeCompare(b.name))));
const savedQ = JSON.parse(readFileSync(path.join(AFTER, "broker-control-invocation-query.json"), "utf8"));
row(q.status === 200 && Array.isArray(qj) && qj.filter(x => x.document).length >= 1 && docsOf(qj) === docsOf(savedQ), "control query returns its receipt, unchanged", `${Array.isArray(qj) ? qj.filter(x => x.document).length : "?"} doc(s)`);
const pc = await req(`${FS}/broker/documents/receipts/${sha(CONTROL_OPID)}`);
writeFileSync(path.join(OUT, "broker-positive-control.json"), pc.text);
row(pc.status === 200 && JSON.stringify(canon(JSON.parse(pc.text))) === JSON.stringify(canon(control)), "positive control 200, unchanged");

// ownableBy, the released Policy's (dist at the release commit).
const { ownableBy } = await import(pathToFileURL(path.join(CHECKOUT, "packages/policy/dist/commands.js")).href);
const combos = [];
for (const recording of [0, 1]) for (const repairs of [0, 1]) for (const scopes of [0, 1]) combos.push({ recording, repairs, scopes, ownable: ownableBy(c, { recording, repairs, scopes }) });
writeFileSync(path.join(OUT, "ownable-by.json"), JSON.stringify(combos, null, 2));
row(combos.length === 8 && combos.every(x => x.ownable === false), "ownableBy false at all 8 capability combinations");

console.log(rows.join("\n"));
const failed = rows.filter(r => r.startsWith("FAIL")).length;
console.log(`\n${rows.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
