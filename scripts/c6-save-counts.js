#!/usr/bin/env node
// C6's bound measurement (docs/c6-l0176-commands-plan.md, decision 6): the
// most saves any production program has made, read from every Broker receipt
// (the broker database's `receipts`; operation ids are
// `<invocationId>/<stage>/<occurrence>`). A call site's count can't exceed its
// stage's, so the most write operations in one stage of one invocation bounds
// the most saves per call site from above. Read-only, with the operator's
// credentials. Prints JSON.
//
//   node scripts/c6-save-counts.js [--exclude-key-prefix c6-drive:]

import { execFileSync } from "node:child_process";

const CANARY = "995cc0bc98105563168b7fbee7b1e59a4256331c";
const project = "graffiticode";
const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents`;

const rows = [];
let cursor = null;
for (;;) {
  const page = { values: [{ referenceValue: cursor }], before: false };
  const structuredQuery = {
    from: [{ collectionId: "receipts" }],
    select: { fields: [{ fieldPath: "operationId" }, { fieldPath: "binding" }, { fieldPath: "claimedAt" }] },
    orderBy: [{ field: { fieldPath: "__name__" } }],
    limit: 1000,
    ...(cursor ? { startAt: page } : {}),
  };
  const res = await fetch(`${base}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery }) });
  if (!res.ok) throw new Error(`runQuery: ${res.status}`);
  const docs = (await res.json()).filter(r => r.document).map(r => r.document);
  for (const d of docs) {
    const f = d.fields ?? {};
    const b = f.binding?.mapValue?.fields ?? {};
    rows.push({ operationId: f.operationId?.stringValue, op: b.op?.stringValue ?? null, principal: b.principal?.stringValue ?? null, at: f.claimedAt?.stringValue ?? null });
  }
  if (docs.length < 1000) break;
  cursor = docs.at(-1).name;
}

const writes = rows.filter(r => r.op === "learnosity.write-items");
const perStage = list => {
  const counts = new Map();
  for (const r of list) {
    const [invocation, stage] = r.operationId.split("/");
    counts.set(`${invocation}/${stage}`, (counts.get(`${invocation}/${stage}`) ?? 0) + 1);
  }
  return [...counts.values()];
};
const summary = list => {
  const counts = perStage(list);
  return { writes: list.length, stages: counts.length, max: Math.max(0, ...counts), atLeast: Object.fromEntries([2, 3, 5, 10, 100].map(t => [t, counts.filter(n => n >= t).length])) };
};
const dates = rows.map(r => r.at).filter(Boolean).sort();
console.log(JSON.stringify({
  window: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
  receipts: rows.length,
  ops: [...new Set(rows.map(r => r.op))],
  all: summary(writes),
  canary: summary(writes.filter(r => r.principal === CANARY)),
  others: { ...summary(writes.filter(r => r.principal !== CANARY)), principals: new Set(writes.filter(r => r.principal !== CANARY).map(r => r.principal)).size },
}, null, 2));
