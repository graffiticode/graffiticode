#!/usr/bin/env node
// One-off repair (C6): marks the artifacts commands published before the
// worker marked them `form: "result"`, so the read path serves them as an
// envelope and signs them (packages/api/src/read.js storedEnvelope). Without
// the mark, a view of an L0176 item saved as a command since activation
// (2026-11-09) serves the activity's inner data, unsigned.
//
//   node scripts/c6-mark-command-artifacts.js            # dry run: lists what it would mark
//   node scripts/c6-mark-command-artifacts.js --apply    # marks them
//
// Every command Policy published (policy database, commands/, publication
// state "published") names its invocation, and its artifact is
// artifacts/<invocationId> in the default database. Only the `form` field is
// added, and only where it is missing: the content, its digest and every
// binding are untouched, so the artifact stays what it was (ARTIFACT-01) and
// a repeated run changes nothing. Runs as the operator (gcloud credentials).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const project = flag("--project", "graffiticode");
const apply = args.includes("--apply");
const FORM = "result";

const token = (await promisify(execFile)("gcloud", ["auth", "print-access-token"])).stdout.trim();
const base = database => `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents`;
const call = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

// Published commands, a page at a time, by document name.
const published = [];
let after = null;
for (;;) {
  const structuredQuery = {
    from: [{ collectionId: "commands" }],
    where: { fieldFilter: { field: { fieldPath: "publication.state" }, op: "EQUAL", value: { stringValue: "published" } } },
    select: { fields: [{ fieldPath: "invocationId" }, { fieldPath: "taskId" }, { fieldPath: "createdAt" }] },
    orderBy: [{ field: { fieldPath: "__name__" } }],
    limit: 300,
    ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
  };
  const res = await call("POST", `${base("policy")}:runQuery`, { structuredQuery });
  if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`runQuery: ${res.status} ${JSON.stringify(res.json)?.slice(0, 300)}`);
  const docs = res.json.filter(r => r.document).map(r => r.document);
  for (const d of docs) {
    published.push({
      invocationId: d.fields?.invocationId?.stringValue,
      taskId: d.fields?.taskId?.stringValue,
      createdAt: d.fields?.createdAt?.stringValue,
    });
  }
  if (docs.length < 300) break;
  after = docs.at(-1).name;
}

const counts = { published: published.length, marked: 0, alreadyMarked: 0, noArtifact: 0, failed: 0 };
for (const c of published) {
  if (!c.invocationId) { counts.noArtifact++; continue; }
  const url = `${base("(default)")}/artifacts/${encodeURIComponent(c.invocationId)}`;
  const got = await call("GET", `${url}?mask.fieldPaths=form&mask.fieldPaths=invocationId`);
  if (got.status === 404) { counts.noArtifact++; continue; }
  if (got.status !== 200) { counts.failed++; console.log(`  read failed ${c.invocationId}: ${got.status}`); continue; }
  if (got.json?.fields?.form) { counts.alreadyMarked++; continue; }
  if (!apply) {
    counts.marked++;
    console.log(`  would mark ${c.invocationId} (task ${c.taskId}, ${c.createdAt})`);
    continue;
  }
  // Only `form`, and only on a document that exists.
  const res = await call("PATCH", `${url}?updateMask.fieldPaths=form&currentDocument.exists=true`, { fields: { form: { stringValue: FORM } } });
  if (res.status === 200) {
    counts.marked++;
    console.log(`  marked ${c.invocationId} (task ${c.taskId}, ${c.createdAt})`);
  } else {
    counts.failed++;
    console.log(`  mark failed ${c.invocationId}: ${res.status} ${JSON.stringify(res.json?.error?.message ?? null)}`);
  }
}
console.log(`${apply ? "applied" : "dry run"}: ${JSON.stringify(counts)}`);
process.exit(counts.failed ? 1 : 0);
