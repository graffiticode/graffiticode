import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { C1, C2, H1, H2, RECORDS, SUBCOLLECTIONS, PAGE_SIZE, Unreadable, canon, compareAll, exitCode, holdReader, normalize, readRecord } from "../lib/c5d-retained-records.js";

const sha = s => createHash("sha256").update(s).digest("hex");
const doc = (name, fields = { a: { stringValue: "x" } }) => ({ name, fields, createTime: "2026-11-20T00:00:00Z", updateTime: "2026-11-23T01:25:31Z" });

// A fake Firestore: path → document (or listing of documents), every read
// recorded. Listings page by PAGE_SIZE unless `pageSize` overrides.
const world = () => {
  const docs = new Map();
  const lists = new Map();
  const put = (db, p, d) => docs.set(`${db}/${p}`, d);
  const list = (db, p, ds) => lists.set(`${db}/${p}`, ds);
  for (const c of [C1, C2]) {
    put("policy", `commands/${encodeURIComponent(c)}`, doc(`projects/graffiticode/databases/policy/documents/commands/${c}`));
    for (const s of SUBCOLLECTIONS) list("policy", `commands/${encodeURIComponent(c)}/${s}`, []);
  }
  list("policy", `commands/${encodeURIComponent(C1)}/holds`, [doc("h/1")]);
  list("policy", `commands/${encodeURIComponent(C2)}/occurrences`, [doc("o/1")]);
  list("broker", `receipts/${H1}/steps`, []);
  put("broker", `receipts/${H2}`, doc(`r/${H2}`));
  put("broker", `receipts/${H2}/resolution/final`, doc("res"));
  list("broker", `receipts/${H2}/reconciliation-attempts`, [doc("att/1")]);
  list("broker", `receipts/${H2}/steps`, [doc("step/0")]);
  const queries = new Map();
  const state = { docs, lists, queries, calls: [], status: new Map(), pageSize: PAGE_SIZE, tokens: null };
  state.get = async url => {
    state.calls.push(url);
    const u = new URL(url);
    const [, db, , ...rest] = u.pathname.replace("/v1/projects/graffiticode/databases/", "/").split("/");
    const key = `${db}/${rest.join("/")}`;
    const forced = state.status.get(key);
    if (forced) return { status: forced, text: forced === 404 ? "{\"error\":{}}" : "oops" };
    if (lists.has(key)) {
      const all = lists.get(key);
      const start = Number(u.searchParams.get("pageToken") ?? 0);
      const page = all.slice(start, start + state.pageSize);
      const next = start + state.pageSize < all.length ? String(start + state.pageSize) : null;
      const token = state.tokens ? state.tokens(next) : next;
      return { status: 200, text: JSON.stringify({ ...(page.length ? { documents: page } : {}), ...(token ? { nextPageToken: token } : {}) }) };
    }
    if (docs.has(key)) return { status: 200, text: JSON.stringify(docs.get(key)) };
    return { status: 404, text: "{\"error\":{\"code\":404}}" };
  };
  state.post = async (url, body) => {
    state.calls.push(url);
    const inv = body.structuredQuery.where.compositeFilter.filters[0].fieldFilter.value.stringValue.slice(0, -1);
    const hits = queries.get(inv) ?? [];
    return { status: 200, text: JSON.stringify(hits.length ? hits.map(d => ({ document: d, readTime: "t" })) : [{ readTime: "t" }]) };
  };
  return state;
};

// The post-hold baseline as the world stands, with publication.json hashes.
const baselineOf = async w => {
  const files = new Map();
  for (const r of RECORDS) {
    if (!r.baseline.hold) continue;
    const read = await readRecord(r, w);
    files.set(r.baseline.hold, JSON.stringify(read.body));
  }
  const publication = { files: [...files].map(([name, text]) => ({ path: `after-2026-11-23/${name}`, originalSha256: sha(text) })) };
  const readFile = name => {
    if (!files.has(name)) throw new Error("ENOENT");
    return files.get(name);
  };
  return { files, publication, readHold: holdReader({ readFile, publication }) };
};
const beforeOf = async w => {
  const read = await readRecord(RECORDS.find(r => r.id === "h2-steps"), w);
  return name => {
    if (name !== "h2-steps.json") throw new Error("ENOENT");
    return JSON.stringify(read);
  };
};
const verdicts = rows => Object.fromEntries(rows.map(r => [r.id, r.verdict]));

test("covers both retained commands' Policy records and the specified Broker records", () => {
  const ids = RECORDS.map(r => r.id);
  for (const c of ["c1", "c2"]) {
    assert.ok(ids.includes(`${c}-command`));
    for (const s of SUBCOLLECTIONS) assert.ok(ids.includes(`${c}-${s}`), `${c}-${s}`);
  }
  for (const id of ["h1-receipt", "h1-receipt-outcome-final", "h1-receipt-run-state", "h1-receipt-resolution-final", "h1-active-execution", "h1-steps", "h1-invocation-query",
    "h2-receipt", "h2-resolution", "h2-outcome", "h2-run-state", "h2-active-execution", "h2-reconciliation-attempts", "h2-steps"]) assert.ok(ids.includes(id), id);
  // The post-hold baseline is the hold's after-reads: the held command and its hold history.
  assert.equal(RECORDS.find(r => r.id === "c1-command").baseline.hold, "legacy-command.json");
  assert.equal(RECORDS.find(r => r.id === "c1-holds").baseline.hold, "legacy-holds.json");
  assert.equal(RECORDS.find(r => r.id === "h2-reconciliation-attempts").baseline.hold, "drop-outcome-reconciliation-attempts.json");
  assert.equal(new Set(ids).size, ids.length);
});

test("an unchanged world compares same everywhere; C2's steps are recorded at §0 and compared after", async () => {
  const w = world();
  const { readHold } = await baselineOf(w);
  const first = await compareAll({ ...w, readHold });
  assert.equal(first.changed + first.unreadable, 0, JSON.stringify(first.rows));
  assert.equal(first.unbaselined, 1);
  assert.equal(verdicts(first.rows)["h2-steps"], "recorded");
  assert.equal(exitCode(first, { first: true }), 0);
  assert.equal(exitCode(first, { first: false }), 2, "after §0, a record without a baseline fails");
  const after = await compareAll({ ...w, readHold, readBefore: await beforeOf(w) });
  assert.deepEqual([after.changed, after.unreadable, after.unbaselined], [0, 0, 0]);
  assert.equal(exitCode(after, { first: false }), 0);
});

test("listings are read to the last page, and compared whole", async () => {
  const w = world();
  w.pageSize = 2;
  const key = `policy/commands/${encodeURIComponent(C1)}/ledger`;
  w.lists.set(key, [doc("l/1"), doc("l/2"), doc("l/3"), doc("l/4"), doc("l/5")]);
  const { readHold } = await baselineOf(w);
  const read = await readRecord(RECORDS.find(r => r.id === "c1-ledger"), w);
  assert.equal(read.body.documents.length, 5);
  assert.equal(w.calls.filter(u => u.includes("/ledger?")).length >= 3, true);
  // A change on the last page only is caught.
  w.lists.set(key, [doc("l/1"), doc("l/2"), doc("l/3"), doc("l/4"), doc("l/5", { a: { stringValue: "changed" } })]);
  const r = await compareAll({ ...w, readHold, readBefore: await beforeOf(w) });
  assert.equal(verdicts(r.rows)["c1-ledger"], "CHANGED");
  assert.equal(exitCode(r, { first: false }), 1);
});

test("a repeated page token, or too many pages, is unreadable", async () => {
  const w = world();
  w.pageSize = 1;
  w.lists.set(`policy/commands/${encodeURIComponent(C1)}/ledger`, [doc("l/1"), doc("l/2"), doc("l/3")]);
  w.tokens = () => "same";
  await assert.rejects(readRecord(RECORDS.find(r => r.id === "c1-ledger"), w), Unreadable);
  const v = world();
  v.pageSize = 1;
  v.lists.set(`policy/commands/${encodeURIComponent(C1)}/ledger`, [doc("l/1"), doc("l/2"), doc("l/3")]);
  await assert.rejects(readRecord(RECORDS.find(r => r.id === "c1-ledger"), { ...v, maxPages: 2 }), /more than 2 pages/);
});

test("every kind of change fails, named", async () => {
  const cases = [
    ["c1-command", w => w.docs.set(`policy/commands/${encodeURIComponent(C1)}`, { ...doc(`projects/graffiticode/databases/policy/documents/commands/${C1}`), updateTime: "2026-12-01T00:00:00Z" })],
    ["c1-command", w => w.docs.delete(`policy/commands/${encodeURIComponent(C1)}`)],
    ["c1-holds", w => w.lists.set(`policy/commands/${encodeURIComponent(C1)}/holds`, [doc("h/1"), doc("h/2")])],
    ["c1-holds", w => w.lists.set(`policy/commands/${encodeURIComponent(C1)}/holds`, [])],
    ["c1-refusals", w => w.lists.set(`policy/commands/${encodeURIComponent(C1)}/refusals`, [doc("ref/1")])],
    ["c2-command", w => w.docs.set(`policy/commands/${encodeURIComponent(C2)}`, doc(`projects/graffiticode/databases/policy/documents/commands/${C2}`, { status: { stringValue: "failed" } }))],
    ["c2-holds", w => w.lists.set(`policy/commands/${encodeURIComponent(C2)}/holds`, [doc("h/9")])],
    ["c2-refusals", w => w.lists.set(`policy/commands/${encodeURIComponent(C2)}/refusals`, [doc("ref/9")])],
    ["h1-receipt", w => w.docs.set(`broker/receipts/${H1}`, doc("claim"))],
    ["h1-receipt-outcome-final", w => w.docs.set(`broker/receipts/${H1}/outcome/final`, doc("out"))],
    ["h1-active-execution", w => w.docs.set(`broker/active-executions/${H1}`, doc("ae"))],
    ["h1-steps", w => w.lists.set(`broker/receipts/${H1}/steps`, [doc("s/0")])],
    ["h1-invocation-query", w => w.queries.set("inv-078ca8f4-b88f-4fe3-8e04-1cc853b71aa3", [doc("claimed")])],
    ["h2-receipt", w => w.docs.set(`broker/receipts/${H2}`, doc(`r/${H2}`, { evidence: { stringValue: "other" } }))],
    ["h2-resolution", w => w.docs.delete(`broker/receipts/${H2}/resolution/final`)],
    ["h2-outcome", w => w.docs.set(`broker/receipts/${H2}/outcome/final`, doc("out"))],
    ["h2-run-state", w => w.docs.set(`broker/receipts/${H2}/run/state`, doc("run"))],
    ["h2-reconciliation-attempts", w => w.lists.set(`broker/receipts/${H2}/reconciliation-attempts`, [doc("att/1"), doc("att/2")])],
    ["h2-steps", w => w.lists.set(`broker/receipts/${H2}/steps`, [doc("step/0"), doc("step/1")])],
  ];
  for (const [id, mutate] of cases) {
    const w = world();
    const { readHold } = await baselineOf(w);
    const readBefore = await beforeOf(w);
    mutate(w);
    const r = await compareAll({ ...w, readHold, readBefore });
    const v = verdicts(r.rows);
    assert.equal(v[id], "CHANGED", `${id}: ${JSON.stringify(r.rows.filter(x => x.verdict !== "same"))}`);
    assert.deepEqual(r.rows.filter(x => x.verdict !== "same").map(x => x.id), [id], id);
    assert.equal(exitCode(r, { first: false }), 1, id);
  }
});

test("unreadable data fails, never passes as unchanged", async () => {
  const w = world();
  const { readHold, files, publication } = await baselineOf(w);
  // A read that answers neither 200 nor 404.
  w.status.set(`policy/commands/${encodeURIComponent(C1)}/ledger`, 403);
  let r = await compareAll({ ...w, readHold, readBefore: await beforeOf(world()) });
  assert.equal(verdicts(r.rows)["c1-ledger"], "UNREADABLE");
  assert.equal(exitCode(r, { first: false }), 2);
  // An absence read that errors is unreadable too, not "absent".
  const x = world();
  x.status.set(`broker/receipts/${H1}`, 500);
  r = await compareAll({ ...x, readHold, readBefore: await beforeOf(world()) });
  assert.equal(verdicts(r.rows)["h1-receipt"], "UNREADABLE");
  // A baseline file that doesn't hash to publication.json's original (a redacted copy).
  const y = world();
  const tampered = holdReader({ readFile: n => (n === "legacy-command.json" ? files.get(n).replace("x", "<operator>") : files.get(n)), publication });
  r = await compareAll({ ...y, readHold: tampered, readBefore: await beforeOf(y) });
  assert.equal(verdicts(r.rows)["c1-command"], "UNREADABLE");
  assert.match(r.rows.find(x => x.id === "c1-command").note, /sha256 differs/);
  // A baseline missing from disk, or from publication.json.
  const missing = holdReader({ readFile: () => { throw new Error("ENOENT"); }, publication });
  r = await compareAll({ ...y, readHold: missing, readBefore: await beforeOf(y) });
  assert.ok(r.rows.filter(x => x.verdict === "UNREADABLE").length >= 10);
  const unlisted = holdReader({ readFile: n => files.get(n), publication: { files: [] } });
  r = await compareAll({ ...y, readHold: unlisted, readBefore: await beforeOf(y) });
  assert.match(r.rows.find(x => x.id === "c1-holds").note, /not in publication.json/);
  // Not JSON, a truncated saved listing, a malformed document.
  assert.throws(() => normalize("collection", { documents: [], nextPageToken: "p" }, "b"), /truncated/);
  assert.throws(() => normalize("collection", { documents: [{}] }, "b"), /malformed/);
  assert.throws(() => normalize("doc", { fields: {} }, "b"), /not a document/);
  assert.throws(() => normalize("query", [{ error: { code: 7 } }], "b"), /error/);
  const z = world();
  z.get = async () => ({ status: 200, text: "not json" });
  await assert.rejects(readRecord(RECORDS.find(r => r.id === "c1-command"), z), /not JSON/);
});

test("comparison is canonical: key order and listing order don't matter, readTime is ignored", () => {
  const a = normalize("collection", { documents: [doc("b"), { fields: { z: 1, a: 2 }, name: "a" }] }, "a");
  const b = normalize("collection", { documents: [{ name: "a", fields: { a: 2, z: 1 } }, doc("b")] }, "b");
  assert.deepEqual(a, b);
  assert.deepEqual(normalize("query", [{ readTime: "1" }], "q"), normalize("query", [{ readTime: "2" }], "q"));
  assert.deepEqual(normalize("collection", {}, "e"), canon({ documents: [] }));
});
