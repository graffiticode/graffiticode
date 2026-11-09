#!/usr/bin/env node
// C6's bound measurement, the static half (docs/c6-l0176-commands-plan.md,
// decision 6): every stored L0176 program (the default database's `tasks`,
// lang 0176) that saves, with its save sites, whether a save can repeat (a
// MAP in the program), and the longest literal list in it. A save inside a
// map runs once per element, so a program whose saves repeat can make at most
// about its longest list's length per site. Read-only, operator credentials.
//
//   node scripts/c6-save-sites.js

import { execFileSync } from "node:child_process";

const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const base = "https://firestore.googleapis.com/v1/projects/graffiticode/databases/(default)/documents";
const decode = v => {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return null;
};

let cursor = null;
let scanned = 0;
const saving = [];
for (;;) {
  const page = { values: [{ referenceValue: cursor }], before: false };
  const structuredQuery = {
    from: [{ collectionId: "tasks" }],
    where: { fieldFilter: { field: { fieldPath: "lang" }, op: "EQUAL", value: { stringValue: "0176" } } },
    select: { fields: [{ fieldPath: "code" }] },
    orderBy: [{ field: { fieldPath: "__name__" } }],
    limit: 500,
    ...(cursor ? { startAt: page } : {}),
  };
  const res = await fetch(`${base}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery }) });
  if (!res.ok) throw new Error(`runQuery: ${res.status} ${await res.text()}`);
  const docs = (await res.json()).filter(r => r.document).map(r => r.document);
  for (const d of docs) {
    scanned++;
    const code = decode(d.fields?.code) ?? {};
    const nodes = Object.values(code).filter(n => n && typeof n === "object" && typeof n.tag === "string");
    const saves = nodes.filter(n => n.tag === "SAVE_TO_ITEMBANK").length;
    if (!saves) continue;
    const lists = nodes.filter(n => n.tag === "LIST").map(n => (Array.isArray(n.elts) ? n.elts.length : 0));
    saving.push({ task: d.name.split("/").at(-1), saves, maps: nodes.filter(n => n.tag === "MAP").length, longestList: Math.max(0, ...lists) });
  }
  if (docs.length < 500) break;
  cursor = docs.at(-1).name;
}
const repeating = saving.filter(s => s.maps > 0);
console.log(JSON.stringify({
  scanned,
  saving: saving.length,
  mostSaveSites: Math.max(0, ...saving.map(s => s.saves)),
  withMap: repeating.length,
  longestListWhereSavesCanRepeat: Math.max(0, ...repeating.map(s => s.longestList)),
  top: [...repeating].sort((a, b) => b.longestList - a.longestList).slice(0, 5),
}, null, 2));
