// The C5a gate's after-phase reads (scripts/lib/c5a-gate-reads.js) and the
// approvals rule (approvalsProblem), offline: the r36074e run's two
// measurement defects (the owner's review, 2026-11-18).
import test from "node:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CommandFailed, runCapturing, isBucketNotFound, bucketObjectCount, collectIndependently,
  approvalInventory, inventoryDigest, compareInventories, historyReadTime, archiveObservations, exactInventory,
} from "../lib/c5a-gate-reads.js";
import { approvalsProblem } from "../lib/c5a-gate-checks.js";

// A fake child process: writes, then exits (or never, for a timeout).
const fakeSpawn = ({ stdout = "", stderr = "", code = 0, hang = false }) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => setImmediate(() => child.emit("close", null, "SIGKILL"));
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    if (!hang) child.emit("close", code, null);
  });
  return child;
};
const NOT_FOUND = "ERROR: (gcloud.storage.buckets.describe) gs://graffiticode-thumbnails not found: 404.\n";
const FORBIDDEN = "ERROR: (gcloud.storage.buckets.describe) [op@example.com] does not have permission to access b instance [graffiticode-thumbnails] (or it may not exist): 403\n";

test("a failed command keeps its exit code and stderr; a hung one times out", async () => {
  assert.equal(await runCapturing("gcloud", ["x"], { spawnImpl: fakeSpawn({ stdout: "ok\n" }) }), "ok\n");
  const failed = await runCapturing("gcloud", ["storage", "buckets", "describe"], { spawnImpl: fakeSpawn({ stderr: NOT_FOUND, code: 1 }) }).catch(e => e);
  assert.ok(failed instanceof CommandFailed);
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, NOT_FOUND);
  assert.match(failed.message, /not found: 404/);
  const hung = await runCapturing("gcloud", ["x"], { timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }) }).catch(e => e);
  assert.equal(hung.timedOut, true);
});

test("only gcloud's not-found answer for that bucket counts as zero objects", async () => {
  const fail = (stderr, code = 1, timedOut = false) => new CommandFailed("gcloud", ["storage"], { code, stderr, timedOut });
  assert.equal(isBucketNotFound(fail(NOT_FOUND), "graffiticode-thumbnails"), true);
  assert.equal(isBucketNotFound(fail(FORBIDDEN), "graffiticode-thumbnails"), false);
  assert.equal(isBucketNotFound(fail(NOT_FOUND.replace("graffiticode-thumbnails", "graffiticode-thumbnails-x")), "graffiticode-thumbnails"), false);
  assert.equal(isBucketNotFound(fail(NOT_FOUND, 2), "graffiticode-thumbnails"), false);
  assert.equal(isBucketNotFound(fail(NOT_FOUND, 1, true), "graffiticode-thumbnails"), false);
  assert.equal(isBucketNotFound(new Error("gcloud storage buckets describe failed (1)"), "graffiticode-thumbnails"), false);
  const count = (describe, list = async () => "[]") => bucketObjectCount({ bucket: "graffiticode-thumbnails", describe, list });
  assert.equal(await count(async () => { throw fail(NOT_FOUND); }), 0);
  await assert.rejects(count(async () => { throw fail(FORBIDDEN); }), /403/);
  await assert.rejects(count(async () => { throw fail("", null, true); }), /timed out/);
  await assert.rejects(count(async () => { throw new Error("gcloud storage buckets describe failed (1)"); }), /failed \(1\)/);
  assert.equal(await count(async () => "graffiticode-thumbnails"), 0);
  assert.equal(await count(async () => "graffiticode-thumbnails", async () => JSON.stringify([{ url: "gs://graffiticode-thumbnails/a.png" }, { url: "gs://graffiticode-thumbnails/b.png" }])), 2);
  await assert.rejects(count(async () => "graffiticode-thumbnails", async () => "gs://graffiticode-thumbnails/a.png"), /isn't JSON/);
  await assert.rejects(count(async () => "graffiticode-thumbnails", async () => "{}"), /isn't a list/);
  // The second #423 review: an existing bucket's empty output isn't "no objects".
  await assert.rejects(count(async () => "graffiticode-thumbnails", async () => ""), /empty, not JSON/);
  await assert.rejects(count(async () => "graffiticode-thumbnails", async () => " \n"), /empty, not JSON/);
  await assert.rejects(count(async () => "graffiticode-thumbnails", async () => undefined), /empty, not JSON/);
});

test("appspot and thumbnails are collected independently", async () => {
  const { values, errors } = await collectIndependently({
    appspotAfter: async () => "6e32da1b",
    thumbnailsObjects: async () => { throw new CommandFailed("gcloud", ["storage"], { code: 1, stderr: FORBIDDEN }); },
  });
  assert.deepEqual(values, { appspotAfter: "6e32da1b" });
  assert.match(errors.thumbnailsObjects, /403/);
  const other = await collectIndependently({ appspotAfter: async () => { throw new Error("listing empty"); }, thumbnailsObjects: async () => 0 });
  assert.deepEqual(other.values, { thumbnailsObjects: 0 });
  assert.deepEqual(Object.keys(other.errors), ["appspotAfter"]);
});

const DOC = (rev, fields = {}) => ({ name: `projects/p/databases/revisions/documents/languages/0176/revisions/${rev}`, fields: { lang: "0176", revision: rev, status: "approved", contractVersions: [1, 2], ...fields } });
test("approval inventories: reordered keys never count; added, deleted and modified records do", () => {
  const a = approvalInventory({ "0176": [DOC("r2"), DOC("r1")], "0000": [] });
  // The same records with every key in another order, and the documents in another order.
  const reorder = d => ({ name: d.name, fields: Object.fromEntries(Object.entries(d.fields).reverse()) });
  const b = approvalInventory({ "0000": [], "0176": [reorder(DOC("r1")), reorder(DOC("r2"))] });
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(inventoryDigest(a), inventoryDigest(b));
  assert.deepEqual(compareInventories(a, b), { added: [], deleted: [], modified: [], baselineCount: 2, currentCount: 2, identical: true });
  const name = rev => DOC(rev).name;
  assert.deepEqual(compareInventories(a, approvalInventory({ "0176": [DOC("r1"), DOC("r2"), DOC("r3")] })).added, [name("r3")]);
  assert.deepEqual(compareInventories(a, approvalInventory({ "0176": [DOC("r1")] })).deleted, [name("r2")]);
  const modified = compareInventories(a, approvalInventory({ "0176": [DOC("r1"), DOC("r2", { status: "retired" })] }));
  assert.deepEqual(modified.modified, [name("r2")]);
  assert.equal(modified.identical, false);
  assert.notEqual(inventoryDigest(a), inventoryDigest(approvalInventory({ "0176": [DOC("r1"), DOC("r2", { status: "retired" })] })));
  assert.equal(compareInventories([], []).identical, false);
});

test("history is read at the baseline while Firestore allows it, else the whole minute before", () => {
  const at = "2026-11-18T21:45:33.773Z";
  assert.deepEqual(historyReadTime(at, Date.parse(at) + 20 * 60_000), { readTime: at, exact: true });
  assert.deepEqual(historyReadTime(at, Date.parse(at) + 3 * 3600_000), { readTime: "2026-11-18T21:45:00.000Z", exact: false });
});

const history = (comparison, readTime = "2026-11-18T21:45:33.773Z") => ({ baselineAt: "2026-11-18T21:45:33.773Z", readTime, exact: true, comparison });
const SAME = { added: [], deleted: [], modified: [], baselineCount: 42, currentCount: 42, identical: true };
test("approvals: a canonical baseline compares digests; an old one needs the history comparison", () => {
  assert.equal(approvalsProblem({ beforeDigest: "c1", beforeDigestKind: "canonical", afterDigest: "c1", afterDigestKind: "canonical" }), null);
  assert.match(approvalsProblem({ beforeDigest: "c1", beforeDigestKind: "canonical", afterDigest: "c2", afterDigestKind: "canonical" }), /changed/);
  // r36074e: its baseline digest counted key order.
  const old = { beforeDigest: "7e995b5c", beforeDigestKind: "json", afterDigest: "8d471c56", afterDigestKind: "canonical" };
  assert.match(approvalsProblem(old), /isn't canonical, and no history comparison/);
  assert.equal(approvalsProblem({ ...old, history: history(SAME) }), null);
  assert.match(approvalsProblem({ ...old, history: history({ ...SAME, deleted: ["r9"], identical: false }) }), /deleted \["r9"\]/);
  assert.match(approvalsProblem({ ...old, history: history({ ...SAME, added: ["r9"], identical: false }) }), /added \["r9"\]/);
  assert.match(approvalsProblem({ ...old, history: history({ ...SAME, modified: ["r9"], identical: false }) }), /modified \["r9"\]/);
  // The second #423 review: the rounded minute leaves a gap, so it never passes.
  assert.match(approvalsProblem({ ...old, history: history(SAME, "2026-11-18T21:45:00.000Z") }), /not exactly at the baseline/);
  assert.match(approvalsProblem({ ...old, history: history(SAME, "2026-11-18T21:45:33.772Z") }), /not exactly at the baseline/);
  assert.match(approvalsProblem({ ...old, history: history(SAME, "2026-11-18T21:46:00.000Z") }), /not exactly at the baseline/);
  assert.match(approvalsProblem({ ...old, history: { ...history(SAME), readTime: undefined } }), /not exactly at the baseline/);
  assert.match(approvalsProblem({ ...old, history: { ...history(SAME), comparison: undefined } }), /comparison wasn't recorded/);
  // A recorded history must match even beside equal canonical digests.
  assert.match(approvalsProblem({ beforeDigest: "c1", beforeDigestKind: "canonical", afterDigest: "c1", afterDigestKind: "canonical", history: history({ ...SAME, modified: ["r1"], identical: false }) }), /modified/);
  assert.match(approvalsProblem(undefined), /weren't read/);
});

const decode = v => (v == null ? null : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "arrayValue" in v ? (v.arrayValue.values ?? []).map(decode) : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)])) : null);
const rest = (rev, status = "approved") => ({ name: DOC(rev).name, fields: { revision: { stringValue: rev }, status: { stringValue: status } }, updateTime: "2026-11-17T01:35:15Z" });
test("a saved history read counts only at exactly the baseline", () => {
  const saved = { readTime: "2026-11-18T21:45:33.773Z", collectedAt: "2026-11-18T22:09:40Z", inventory: { "0176": [rest("r2"), rest("r1")], "0000": [] } };
  const inv = exactInventory(saved, "2026-11-18T21:45:33.773Z", decode);
  assert.deepEqual(inv.map(d => d.fields), [{ revision: "r1", status: "approved" }, { revision: "r2", status: "approved" }]);
  assert.throws(() => exactInventory({ ...saved, readTime: "2026-11-18T21:45:00.000Z" }, "2026-11-18T21:45:33.773Z", decode), /not at the baseline/);
  assert.throws(() => exactInventory({ readTime: saved.readTime }, saved.readTime, decode), /not at the baseline/);
});

// The runner's own after-phase block (scripts/c5a-gate.js), run twice with
// its reads stubbed and no network or files: first a failing thumbnails read,
// then everything succeeding. The first run's namespaced error must survive
// in the history (the second #423 review).
const AFTER = (() => {
  const script = readFileSync(new URL("../c5a-gate.js", import.meta.url), "utf8");
  return script.slice(script.indexOf("if (phase === \"after\") {"), script.indexOf("if (phase === \"judge\") {"));
})();
const runAfter = async (state, { thumbnails, appspot = async () => "same", flags = {} }) => {
  const current = approvalInventory({ "0176": [{ name: DOC("r1").name, fields: { revision: "r1", status: "approved" } }] });
  const collect = async (key, read) => {
    try {
      state.observations[key] = await read();
      if (state.observations.errors) delete state.observations.errors[key];
    } catch (e) {
      state.observations.errors = { ...(state.observations.errors ?? {}), [key]: String(e?.message ?? e) };
    }
  };
  const scope = {
    phase: "after",
    state,
    path,
    stateFile: "/nonexistent/state.json",
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => JSON.stringify({ readTime: state.baseline.at, collectedAt: "x", inventory: { "0176": [rest("r1")] } }),
    createHash,
    decode,
    flag: name => flags[name] ?? null,
    approvalDocs: async () => current,
    collect,
    observe: (key, value) => { state.observations[key] = value; },
    save: async () => {},
    historyReadTime: () => ({ readTime: "2026-11-18T21:45:00.000Z", exact: false }),
    inventoryDigest,
    compareInventories,
    collectIndependently,
    archiveObservations,
    exactInventory,
    appspotListing: appspot,
    thumbnailsCount: thumbnails,
  };
  await new Function(...Object.keys(scope), `return (async () => { ${AFTER} })()`)(...Object.values(scope));
};
test("a failed after phase, then a successful one: every earlier read error stays in the history", async () => {
  const state = { baseline: { at: "2026-11-18T21:45:33.773Z", approvals: "legacy", appspot: "same" }, commands: ["c:done"], observations: { errors: { elsewhere: "the r36074e combined failure" } } };
  await runAfter(state, { thumbnails: async () => { throw new CommandFailed("gcloud", ["storage"], { code: 1, stderr: FORBIDDEN }); } });
  assert.match(state.observations.errors["elsewhere.thumbnailsObjects"], /403/);
  assert.equal(state.observations.elsewhere.appspotAfter, "same");
  assert.equal(state.observations.errors.elsewhere, undefined);
  assert.deepEqual(state.observationHistory.elsewhere[0].errors, { elsewhere: "the r36074e combined failure" });
  // The old baseline with no exact history: the approvals row can't pass.
  assert.match(approvalsProblem(state.observations.approvals), /isn't canonical, and no history comparison/);
  await runAfter(state, { thumbnails: async () => 0, flags: { "--approvals-at-baseline": "/saved/baseline.raw.json" } });
  assert.deepEqual(state.observations.elsewhere, { appspotBefore: "same", appspotAfter: "same", thumbnailsObjects: 0 });
  assert.deepEqual(Object.keys(state.observations.errors).filter(k => k.startsWith("elsewhere")), []);
  const kept = state.observationHistory.elsewhere;
  assert.equal(kept.length, 2);
  assert.match(kept[1].errors["elsewhere.thumbnailsObjects"], /403/);
  assert.equal(kept[1].observation.appspotAfter, "same");
  assert.equal(JSON.stringify(state).includes("403"), true);
  // The saved exact-time inventory decides the approvals row.
  assert.equal(state.observations.approvals.history.readTime, "2026-11-18T21:45:33.773Z");
  assert.equal(state.observations.approvals.history.source.file, "/saved/baseline.raw.json");
  assert.equal(approvalsProblem(state.observations.approvals), null);
  assert.equal(state.observationHistory.approvals.length, 1);
});
