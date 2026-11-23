// C5d fresh drive (IAM review Step 32a §0 and §9): the records the drive must
// leave unchanged, and their comparison with the post-hold baseline.
//
// Two retained commands, after the first drive and the hold (2026-11-23):
//   C1, the legacy command (staging-gone), held: Policy's command and all six
//       subcollections; Broker's absences for its one operation H1 (no claim,
//       outcome, run, resolution or active execution, no steps, and no claim
//       under its invocation).
//   C2, the drop-outcome command: Policy's command and all six subcollections;
//       Broker's claim for its operation H2, its resolution, its one step and
//       its one reconciliation attempt, and the absence of an outcome, a run
//       and an active execution.
//
// Each record's expectation comes from the hold's published after-reads
// (docs/evidence/c5d/hold/after-2026-11-23, read 2026-11-23 after the act)
// where they cover it, as the private original's canonical form; else it is a
// fixed expectation (absent, or no documents); else (C2's steps only, which
// no post-hold read saved) the drive's own first capture, `--before`.
//
// Everything here is pure: reads go through an injected `get`/`post`.

import { createHash } from "node:crypto";

export const C1 = "c:f54ea9f1fc642d8d6007c75bf9945ad118eef093a2a209b0af4adc6b5407133f";
export const C2 = "c:db80a736f58318fe6f9cb1141bd60fc7c575d922cefe6374fe35496eeeff009b";
const OCC = "s0/x:9eb94a78cb3e9aff42a8cb34cda835fe4ec7d204459a12080dd421919c60e515";
export const INV1 = "inv-078ca8f4-b88f-4fe3-8e04-1cc853b71aa3";
export const INV2 = "inv-b8878442-06cb-4517-9a10-fbee816c5f42";
const sha = s => createHash("sha256").update(s).digest("hex");
export const H1 = sha(`${INV1}/${OCC}`);
export const H2 = sha(`${INV2}/${OCC}`);
export const SUBCOLLECTIONS = Object.freeze(["occurrences", "reservations", "outcomes", "refusals", "ledger", "holds"]);
export const PAGE_SIZE = 100;

const enc = encodeURIComponent;
const cmd = c => `commands/${enc(c)}`;

// kind: "doc" (200 expected), "absent" (404 expected), "collection" (every
// page), "query" (Broker's receipts under an invocation's operation-id prefix).
// baseline: { hold: <file under the after-reads> } | { absent: true } |
// { empty: true } | { before: true }.
export const RECORDS = Object.freeze([
  { id: "c1-command", db: "policy", kind: "doc", path: cmd(C1), baseline: { hold: "legacy-command.json" } },
  ...SUBCOLLECTIONS.map(s => ({ id: `c1-${s}`, db: "policy", kind: "collection", path: `${cmd(C1)}/${s}`, baseline: { hold: `legacy-${s}.json` } })),
  { id: "c2-command", db: "policy", kind: "doc", path: cmd(C2), baseline: { hold: "retained-records/fresh-7.json" } },
  { id: "c2-occurrences", db: "policy", kind: "collection", path: `${cmd(C2)}/occurrences`, baseline: { hold: "retained-records/fresh-8.json" } },
  { id: "c2-reservations", db: "policy", kind: "collection", path: `${cmd(C2)}/reservations`, baseline: { hold: "retained-records/fresh-9.json" } },
  { id: "c2-outcomes", db: "policy", kind: "collection", path: `${cmd(C2)}/outcomes`, baseline: { hold: "retained-records/fresh-10.json" } },
  { id: "c2-ledger", db: "policy", kind: "collection", path: `${cmd(C2)}/ledger`, baseline: { hold: "retained-records/fresh-11.json" } },
  { id: "c2-refusals", db: "policy", kind: "collection", path: `${cmd(C2)}/refusals`, baseline: { empty: true } },
  { id: "c2-holds", db: "policy", kind: "collection", path: `${cmd(C2)}/holds`, baseline: { empty: true } },
  ...["", "/outcome/final", "/run/state", "/resolution/final"].map(p => ({ id: `h1-receipt${p.replace(/\//g, "-")}`, db: "broker", kind: "absent", path: `receipts/${H1}${p}`, baseline: { absent: true } })),
  { id: "h1-active-execution", db: "broker", kind: "absent", path: `active-executions/${H1}`, baseline: { absent: true } },
  { id: "h1-steps", db: "broker", kind: "collection", path: `receipts/${H1}/steps`, baseline: { hold: "legacy-broker-steps.json" } },
  { id: "h1-invocation-query", db: "broker", kind: "query", invocation: INV1, baseline: { empty: true } },
  { id: "h2-receipt", db: "broker", kind: "doc", path: `receipts/${H2}`, baseline: { hold: "retained-records/fresh-12.json" } },
  { id: "h2-resolution", db: "broker", kind: "doc", path: `receipts/${H2}/resolution/final`, baseline: { hold: "retained-records/fresh-13.json" } },
  { id: "h2-outcome", db: "broker", kind: "absent", path: `receipts/${H2}/outcome/final`, baseline: { absent: true } },
  { id: "h2-run-state", db: "broker", kind: "absent", path: `receipts/${H2}/run/state`, baseline: { absent: true } },
  { id: "h2-active-execution", db: "broker", kind: "absent", path: `active-executions/${H2}`, baseline: { absent: true } },
  { id: "h2-reconciliation-attempts", db: "broker", kind: "collection", path: `receipts/${H2}/reconciliation-attempts`, baseline: { hold: "drop-outcome-reconciliation-attempts.json" } },
  { id: "h2-steps", db: "broker", kind: "collection", path: `receipts/${H2}/steps`, baseline: { before: true } },
]);

export class Unreadable extends Error {}

const parse = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreadable(`${what}: not JSON`);
  }
};

// Keys sorted at every level; a collection is its documents sorted by name.
export const canon = v => Array.isArray(v)
  ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const byName = docs => [...docs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// A saved or fresh read, in the one form compared.
export const normalize = (kind, body, what) => {
  if (kind === "absent") return { absent: true };
  if (kind === "doc") {
    if (!body || typeof body !== "object" || typeof body.name !== "string" || !body.fields) throw new Unreadable(`${what}: not a document`);
    return canon(body);
  }
  if (kind === "collection") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Unreadable(`${what}: not a listing`);
    if (body.nextPageToken) throw new Unreadable(`${what}: a truncated listing (nextPageToken)`);
    const extra = Object.keys(body).filter(k => k !== "documents");
    if (extra.length) throw new Unreadable(`${what}: unexpected listing keys ${extra.join(", ")}`);
    const docs = body.documents ?? [];
    if (!Array.isArray(docs) || docs.some(d => typeof d?.name !== "string")) throw new Unreadable(`${what}: malformed documents`);
    return canon({ documents: byName(docs) });
  }
  if (kind === "query") {
    if (!Array.isArray(body)) throw new Unreadable(`${what}: not a query response`);
    if (body.some(r => r?.error)) throw new Unreadable(`${what}: the query answered an error`);
    // readTime differs on every read; only the documents are compared.
    return canon({ documents: byName(body.filter(r => r.document).map(r => r.document)) });
  }
  throw new Error(`unknown kind ${kind}`);
};

const FS = "https://firestore.googleapis.com/v1/projects/graffiticode/databases";
const prefixQuery = inv => ({
  structuredQuery: {
    from: [{ collectionId: "receipts" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "operationId" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: `${inv}/` } } },
          { fieldFilter: { field: { fieldPath: "operationId" }, op: "LESS_THAN", value: { stringValue: `${inv}0` } } }]
      }
    }
  }
});

// One record, read completely: every page of a listing (a page token that
// repeats, or more than maxPages, is unreadable). Any status but the expected
// ones is unreadable. Returns { status, body } with body the merged read.
export const readRecord = async (record, { get, post, maxPages = 50 }) => {
  const base = `${FS}/${record.db}/documents`;
  if (record.kind === "query") {
    const r = await post(`${base}:runQuery`, prefixQuery(record.invocation));
    if (r.status !== 200) throw new Unreadable(`${record.id}: status ${r.status}`);
    return { status: 200, body: parse(r.text, record.id) };
  }
  if (record.kind === "collection") {
    const documents = [];
    const seen = new Set();
    let token = "";
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Unreadable(`${record.id}: more than ${maxPages} pages`);
      const r = await get(`${base}/${record.path}?pageSize=${PAGE_SIZE}${token ? `&pageToken=${enc(token)}` : ""}`);
      if (r.status !== 200) throw new Unreadable(`${record.id}: status ${r.status}`);
      const j = parse(r.text, record.id);
      if (j.documents !== undefined && !Array.isArray(j.documents)) throw new Unreadable(`${record.id}: malformed documents`);
      documents.push(...(j.documents ?? []));
      if (!j.nextPageToken) break;
      if (seen.has(j.nextPageToken)) throw new Unreadable(`${record.id}: a repeated page token`);
      seen.add(j.nextPageToken);
      token = j.nextPageToken;
    }
    return { status: 200, body: documents.length ? { documents } : {} };
  }
  const r = await get(`${base}/${record.path}`);
  if (r.status === 404) return { status: 404, body: parse(r.text, record.id) };
  if (r.status !== 200) throw new Unreadable(`${record.id}: status ${r.status}`);
  return { status: 200, body: parse(r.text, record.id) };
};

// The expected canonical form of one record, or an Unreadable when its
// baseline can't be read. readFile(name) returns the text or throws.
export const expected = (record, { readHold, readBefore }) => {
  const b = record.baseline;
  if (b.absent) return { absent: true };
  if (b.empty) return canon({ documents: [] });
  if (b.hold) {
    let text;
    try {
      text = readHold(b.hold);
    } catch (err) {
      throw new Unreadable(`${record.id}: baseline ${b.hold} unreadable${err instanceof Unreadable ? ` (${err.message})` : ""}`);
    }
    return normalize(record.kind, parse(text, `baseline ${b.hold}`), `baseline ${b.hold}`);
  }
  if (b.before) {
    if (!readBefore) return null;
    let text;
    try {
      text = readBefore(`${record.id}.json`);
    } catch {
      throw new Unreadable(`${record.id}: --before ${record.id}.json unreadable`);
    }
    return normalize(record.kind, parse(text, `before ${record.id}`).body, `before ${record.id}`);
  }
  throw new Error(`${record.id}: no baseline`);
};

// Compare every record. Returns { rows, changed, unreadable, unbaselined, fresh }.
// A record whose fresh status doesn't fit its kind is changed (a present
// absence, an absent document); a read or baseline that fails is unreadable.
export const compareAll = async ({ get, post, readHold, readBefore = null, records = RECORDS }) => {
  const rows = [];
  const fresh = {};
  let changed = 0; let unreadable = 0; let unbaselined = 0;
  for (const record of records) {
    try {
      const read = await readRecord(record, { get, post });
      fresh[record.id] = read;
      const want = expected(record, { readHold, readBefore });
      let got;
      if (record.kind === "absent") got = read.status === 404 ? { absent: true } : { present: read.body };
      else if (record.kind === "doc" && read.status === 404) got = { absent: true };
      else got = normalize(record.kind, read.body, record.id);
      if (want === null) {
        unbaselined++;
        rows.push({ id: record.id, verdict: "recorded", note: "no post-hold baseline: this read is the drive's baseline" });
        continue;
      }
      const same = JSON.stringify(got) === JSON.stringify(want);
      if (!same) changed++;
      rows.push({ id: record.id, verdict: same ? "same" : "CHANGED" });
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      unreadable++;
      rows.push({ id: record.id, verdict: "UNREADABLE", note: err.message });
    }
  }
  return { rows, changed, unreadable, unbaselined, fresh };
};

// 0 every record same; 1 any changed; 2 any unreadable (worst wins); a record
// recorded without a baseline is allowed only on the first capture.
export const exitCode = ({ changed, unreadable, unbaselined }, { first }) =>
  unreadable ? 2 : changed ? 1 : unbaselined && !first ? 2 : 0;

// The post-hold baseline is the private originals of the hold's after-reads
// (the published copies are redacted, so they can't equal a fresh read). Each
// original is accepted only if its sha256 is the `originalSha256` that the
// published docs/evidence/c5d/hold/publication.json records for it.
export const holdReader = ({ readFile, publication }) => {
  const want = new Map((publication?.files ?? []).map(f => [f.path, f.originalSha256]));
  return name => {
    const listed = want.get(`after-2026-11-23/${name}`);
    if (!listed) throw new Unreadable(`${name}: not in publication.json`);
    const text = readFile(name);
    if (sha(text) !== listed) throw new Unreadable(`${name}: sha256 differs from publication.json's original`);
    return text;
  };
};
