#!/usr/bin/env node
// Incident repair, 2026-11-10: restores the documents deleted from the
// graffiticode project's default Firestore database at 16:55-16:56Z (a test
// cleanup, clearFirestore, run without the emulator against production).
//
//   node scripts/restore-default-firestore.js                  # dry run: counts what it would restore
//   node scripts/restore-default-firestore.js --apply          # restores
//   node scripts/restore-default-firestore.js --only api-keys,oauth-clients [--apply]
//   --at <time>       the snapshot to restore from (a whole minute within the
//                     database's point-in-time recovery window)
//   --include-keys    also restore auth's signing keys (`keys`); left out by
//                     default, since auth made new ones at 17:28Z
//
// Reads each collection as it stood at --at (default 2026-11-10T16:55:00Z,
// the last minute before the deletion) through point-in-time recovery, and
// recreates every document that is missing now, with its fields exactly as
// they were, and its subcollections. Placeholder parents (no fields of their
// own, only subcollections, such as api-keys/-indexes-/token-to-id, the
// lookup index API keys are found by) are walked but never created. Every
// write is a create (currentDocument.exists=false): a document that exists
// now, written since the deletion, is never overwritten. Repeat runs restore
// only what is still missing. Runs as the operator (gcloud credentials).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const project = flag("--project", "graffiticode");
const at = flag("--at", "2026-11-10T16:55:00Z");
const apply = args.includes("--apply");
const COLLECTIONS = [
  "api-keys", "oauth-clients", "oauth-codes", "oauth-links", "oauth-pending", "refresh-tokens", "linked-emails", "nonces",
  "artifacts", "artifact-heads", "tasks", "code-hashes", "compiles", "stage-results",
  ...(args.includes("--include-keys") ? ["keys"] : []),
];
const only = flag("--only", null)?.split(",") ?? null;
const collections = only ? COLLECTIONS.filter(c => only.includes(c)) : COLLECTIONS;
// Caches with no subcollections: skip the per-document subcollection listing.
const FLAT = new Set(["compiles", "code-hashes", "stage-results", "artifacts", "artifact-heads", "nonces"]);

let token = (await promisify(execFile)("gcloud", ["auth", "print-access-token"])).stdout.trim();
let tokenAt = Date.now();
const refresh = async () => {
  if (Date.now() - tokenAt > 30 * 60_000) {
    token = (await promisify(execFile)("gcloud", ["auth", "print-access-token"])).stdout.trim();
    tokenAt = Date.now();
  }
};
const root = `projects/${project}/databases/(default)/documents`;
const api = "https://firestore.googleapis.com/v1";
const call = async (method, url, body) => {
  await refresh();
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      // A dropped connection (ECONNRESET, a timeout): retry it like a 5xx.
      if (attempt < 8) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw e;
    }
    const json = await res.json().catch(() => null);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      continue;
    }
    return { status: res.status, json };
  }
};

// Every document of a collection (under `parent`, a document name or the
// root) as it stood at `at`, a page at a time. `missing`: also the
// placeholder parents that have no fields of their own but hold
// subcollections; they come back with a name only.
async function * documentsAt(parent, collectionId, { missing = false } = {}) {
  let pageToken = "";
  do {
    const url = `${api}/${parent}/${collectionId}?pageSize=300&readTime=${at}${missing ? "&showMissing=true" : ""}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await call("GET", url);
    if (res.status !== 200) throw new Error(`list ${parent}/${collectionId} at ${at}: ${res.status} ${JSON.stringify(res.json?.error?.message ?? null)}`);
    for (const d of res.json?.documents ?? []) yield d;
    pageToken = res.json?.nextPageToken ?? "";
  } while (pageToken);
}

// Which of these document names are missing now.
const missingNow = async names => {
  const res = await call("POST", `${api}/projects/${project}/databases/(default)/documents:batchGet`, { documents: names });
  if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`batchGet: ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`);
  return new Set(res.json.filter(r => r.missing).map(r => r.missing));
};

const subcollectionsAt = async name => {
  const res = await call("POST", `${api}/${name}:listCollectionIds`, { readTime: at, pageSize: 100 });
  return res.json?.collectionIds ?? [];
};

// Creates, never overwrites.
const pending = [];
const totals = {};
const commit = writes => call("POST", `${api}/projects/${project}/databases/(default)/documents:commit`, {
  writes: writes.map(d => ({ update: { name: d.name, fields: d.fields ?? {} }, currentDocument: { exists: false } })),
});
const flush = async () => {
  if (!pending.length) return;
  const writes = pending.splice(0);
  if (!apply) return;
  const res = await commit(writes);
  if (res.status !== 200) {
    // One already recreated (a concurrent write) fails the whole commit:
    // write them one at a time, skipping any that exist.
    for (const d of writes) {
      const one = await commit([d]);
      if (one.status !== 200 && !/ALREADY_EXISTS|already exists/i.test(JSON.stringify(one.json))) {
        throw new Error(`restore ${d.name}: ${one.status} ${JSON.stringify(one.json?.error?.message ?? null)}`);
      }
    }
  }
};
const restore = async (doc, label) => {
  pending.push(doc);
  totals[label] = (totals[label] ?? 0) + 1;
  if (pending.length >= 200) await flush();
};

// One collection under `parent`: its documents missing now are restored,
// then, recursively, their subcollections (all of whose documents were
// deleted with them). A placeholder parent is never created; its
// subcollections are restored document by document.
async function restoreCollection(parent, collectionId, label, { flat }) {
  let page = [];
  let seen = 0;
  const handle = async () => {
    const placeholders = page.filter(d => !d.createTime);
    const real = page.filter(d => d.createTime);
    for (const d of placeholders) {
      for (const sub of await subcollectionsAt(d.name)) {
        await restoreCollection(d.name, sub, `${label}/${d.name.split("/").pop()}/${sub}`, { flat: false });
      }
    }
    const gone = real.length ? await missingNow(real.map(d => d.name)) : new Set();
    for (const d of real) {
      if (!gone.has(d.name)) continue;
      await restore(d, label);
      if (!flat) {
        for (const sub of await subcollectionsAt(d.name)) {
          await restoreCollection(d.name, sub, `${label}/*/${sub}`, { flat: false });
        }
      }
    }
    page = [];
  };
  for await (const d of documentsAt(parent, collectionId, { missing: !flat })) {
    page.push(d);
    seen++;
    if (page.length >= 100) await handle();
  }
  if (page.length) await handle();
  return seen;
}

console.log(`${apply ? "RESTORING" : "dry run"} from ${at} into ${root}`);
for (const c of collections) {
  const seen = await restoreCollection(root, c, c, { flat: FLAT.has(c) });
  await flush();
  const mine = Object.entries(totals).filter(([k]) => k === c || k.startsWith(`${c}/`));
  console.log(`  ${c}: ${seen} at ${at}; ${apply ? "restored" : "would restore"} ${mine.map(([k, n]) => `${k}=${n}`).join(" ") || "0"}`);
}
console.log(`${apply ? "applied" : "dry run"}: ${JSON.stringify(totals)}`);
