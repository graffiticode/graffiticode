// Read-only: repeat the disposal procedure's Policy and Broker reads and
// compare each with its saved response, canonically (keys sorted, documents
// sorted by name). Writes each fresh response beside this script.
//   GC_TOKEN=<operator access token> node compare.mjs <run evidence dir>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const D = process.argv[2];
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FS = "https://firestore.googleapis.com/v1/projects/graffiticode/databases";
const token = process.env.GC_TOKEN;
const enc = encodeURIComponent;
const sha = s => createHash("sha256").update(s).digest("hex");
const C1 = "c:f54ea9f1fc642d8d6007c75bf9945ad118eef093a2a209b0af4adc6b5407133f";
const C2 = "c:db80a736f58318fe6f9cb1141bd60fc7c575d922cefe6374fe35496eeeff009b";
const OCC = "s0/x:9eb94a78cb3e9aff42a8cb34cda835fe4ec7d204459a12080dd421919c60e515";
const H1 = sha(`inv-078ca8f4-b88f-4fe3-8e04-1cc853b71aa3/${OCC}`);
const H2 = sha(`inv-b8878442-06cb-4517-9a10-fbee816c5f42/${OCC}`);
const get = async url => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text() };
};
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const norm = j => JSON.stringify(canon(Array.isArray(j?.documents) ? { ...j, documents: [...j.documents].sort((a, b) => a.name.localeCompare(b.name)) } : j));

const pairs = [
  ["staging-gone-disposal/1-policy-command.json", `${FS}/policy/documents/commands/${enc(C1)}`],
  ...["occurrences", "reservations", "outcomes", "refusals", "ledger"].map(c => [`staging-gone-disposal/1-policy-${c}.json`, `${FS}/policy/documents/commands/${enc(C1)}/${c}?pageSize=50`]),
  ["teardown/4-plan2-command.json", `${FS}/policy/documents/commands/${enc(C2)}`],
  ...["occurrences", "reservations", "outcomes"].map(c => [`teardown/4-plan2-${c}.json`, `${FS}/policy/documents/commands/${enc(C2)}/${c}?pageSize=20`]),
  ["teardown/5-plan2-policy-ledger.json", `${FS}/policy/documents/commands/${enc(C2)}/ledger?pageSize=20`],
  [`teardown/4-plan2-broker-receipts-${H2}.json`, `${FS}/broker/documents/receipts/${H2}`],
  ["teardown/5-plan2-broker-resolution-final.json", `${FS}/broker/documents/receipts/${H2}/resolution/final`],
];
const lines = [];
let changed = 0;
for (const [i, [saved, url]] of pairs.entries()) {
  const fresh = await get(url);
  writeFileSync(path.join(HERE, `fresh-${i + 1}.json`), fresh.text);
  const same = norm(JSON.parse(readFileSync(path.join(D, saved), "utf8"))) === norm(JSON.parse(fresh.text));
  if (!same) changed++;
  lines.push(`${same ? "same   " : "CHANGED"} ${fresh.status} ${saved}`);
}
for (const p of ["", "/outcome/final", "/run/state", "/resolution/final"]) {
  const r = await get(`${FS}/broker/documents/receipts/${H1}${p}`);
  lines.push(`${r.status === 404 ? "absent " : "PRESENT"} ${r.status} broker receipts/{H1}${p}`);
}
const ae = await get(`${FS}/broker/documents/active-executions/${H1}`);
lines.push(`${ae.status === 404 ? "absent " : "PRESENT"} ${ae.status} broker active-executions/{H1}`);
writeFileSync(path.join(HERE, "comparison.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`changed: ${changed} of ${pairs.length}`);
if (changed) process.exitCode = 1;
