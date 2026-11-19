// C5d's catch-up copy (scripts/lib/c5b-thumbnails.js, docs/c5d-snapshot-commands-plan.md
// slice 1 item 4), offline, over a fake JSON API that honours both generation
// preconditions.
import test from "node:test";
import assert from "node:assert/strict";
import {
  planEntries, runCopy, copiedGenerations, selectCatchup, catchupEntry, runCatchup, verifyCatchup, destinationProblem,
  SOURCE_BUCKET, DESTINATION_BUCKET,
} from "../lib/c5b-thumbnails.js";

const src = (item, generation = "100", over = {}) => ({ name: `thumbnails/${item}.png`, generation, size: "10", md5Hash: `md5-${item}-${generation}`, crc32c: `crc-${item}-${generation}`, contentType: "image/png", updated: "2026-11-15T00:00:00Z", ...over });

// The fake: the source bucket's current objects (a Map the test may change),
// the destination's, and per-destination scripts for how a rewrite answers.
// A rewrite is refused 412 unless the source is at ifSourceGenerationMatch and
// the destination at ifGenerationMatch ("0": absent).
// Generations are unique across every fake, as GCS's are across writes.
let nextGeneration = 7000;
const fakeStorage = ({ sources, script = {} }) => {
  const dest = new Map();
  const calls = [];
  const tokens = new Map();
  return {
    dest,
    calls,
    sources,
    async rewrite(req) {
      calls.push(req);
      assert.equal(req.sourceBucket, SOURCE_BUCKET);
      assert.equal(req.bucket, DESTINATION_BUCKET);
      assert.ok(req.sourceGeneration, "ifSourceGenerationMatch is always sent");
      assert.equal(typeof req.ifGenerationMatch, "string", "ifGenerationMatch is always sent");
      const s = script[req.name] ?? {};
      s.before?.(req);
      if (s.transient?.length) return { status: s.transient.shift() };
      if (req.rewriteToken && s.refuseTokens === "once" && !s.refused) { s.refused = true; return { status: s.refuseStatus ?? 400 }; }
      if (req.rewriteToken && (s.refuseTokens === true || !tokens.has(req.rewriteToken))) return { status: 400 };
      const current = sources.get(req.source);
      if (!current || current.generation !== req.sourceGeneration) return { status: 412 };
      const have = dest.get(req.name);
      if ((have ? String(have.generation) : "0") !== req.ifGenerationMatch) return { status: 412 };
      const progress = req.rewriteToken ? tokens.get(req.rewriteToken) + 1 : 1;
      if (progress < (s.doneAfter ?? 1)) {
        const token = `tok-${req.name}-${progress}`;
        tokens.set(token, progress);
        return { status: 200, body: { done: false, rewriteToken: token } };
      }
      const generation = String(nextGeneration++);
      const meta = s.writeOther ? { ...current, crc32c: "other" } : current;
      dest.set(req.name, { name: req.name, generation, size: meta.size, md5Hash: meta.md5Hash, crc32c: meta.crc32c, ...structuredClone(req.metadata) });
      return { status: 200, body: { done: true, resource: { name: req.name, generation } } };
    },
    async get(bucket, name) {
      const store = bucket === DESTINATION_BUCKET ? dest : bucket === SOURCE_BUCKET ? sources : null;
      assert.ok(store, `unknown bucket ${bucket}`);
      return store.has(name) ? { status: 200, body: structuredClone(store.get(name)) } : { status: 404 };
    },
  };
};
const sourcesOf = listing => new Map(listing.map(o => [o.name, o]));
const setSource = (storage, o) => storage.sources.set(o.name, o);
const listingOf = storage => [...storage.sources.values()];

// C5b's world, done: plan 1 over a, b, c (generation 100), copied.
const c5b = async (items = ["a", "b", "c"]) => {
  const listing = items.map(i => src(i));
  const plan = { number: 1, ...planEntries(listing) };
  const storage = fakeStorage({ sources: sourcesOf(listing) });
  const copy = await runCopy({ plan, storage });
  assert.equal(copy.complete, true);
  return { plan, copies: [copy], storage };
};
// Broker publishes a capture over a name (its generation changes, captureSequence set).
const capture = (storage, name, sequence = "4") => {
  storage.dest.set(name, { name, generation: "9900", size: "12", md5Hash: "cap", crc32c: "cap", contentType: "image/png", cacheControl: "no-cache", metadata: { captureSequence: sequence } });
};
const destinationsOf = (storage, selection) => Object.fromEntries(selection.entries.map(e => [e.destination, storage.dest.get(e.destination) ?? null]));

test("selection: changed and unplanned sources, fenced on C5b's generations or 0; bad names refused", async () => {
  const { plan, copies, storage } = await c5b();
  const gens = copiedGenerations(copies);
  assert.deepEqual(gens.problems, []);
  assert.equal(gens.generations.get("a.png"), storage.dest.get("a.png").generation);
  setSource(storage, src("b", "200"));
  setSource(storage, src("d", "300"));
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  assert.deepEqual(sel.problems, []);
  assert.deepEqual(sel.entries.map(e => [e.destination, e.sourceGeneration, e.plannedGeneration, e.ifGenerationMatch]), [
    ["b.png", "200", "100", storage.dest.get("b.png").generation],
    ["d.png", "300", null, "0"],
  ]);
  // Bad names are refused, and a selection with problems never runs.
  const bad = selectCatchup({ plan, copies, listing: [...listingOf(storage), { ...src("x"), name: "thumbnails/sub/x.png" }, { ...src("y"), name: "thumbnails/bad id.png" }] });
  assert.equal(bad.problems.length, 2);
  await assert.rejects(runCatchup({ selection: bad, storage }), /selection has problems/);
  // A plan with unresolved problems, or copy manifests that disagree, is refused too.
  assert.match(selectCatchup({ plan: { ...plan, problems: ["vanished"] }, copies, listing: listingOf(storage) }).problems[0], /^plan 1: vanished$/);
  const disagree = [...copies, { entries: [{ destination: "a.png", outcome: "adopted", generation: "1" }] }];
  assert.match(selectCatchup({ plan, copies: disagree, listing: listingOf(storage) }).problems.join("|"), /a\.png: copy manifests record generations/);
  // A planned source the bucket no longer lists is reported, not selected.
  storage.sources.delete("thumbnails/c.png");
  assert.deepEqual(selectCatchup({ plan, copies, listing: listingOf(storage) }).absentFromListing, ["thumbnails/c.png"]);
});

test("a changed source is copied over C5b's copy under both fences, with C5b's metadata and the new generation", async () => {
  const { plan, copies, storage } = await c5b();
  const c5bGeneration = storage.dest.get("b.png").generation;
  setSource(storage, src("b", "200"));
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const run = await runCatchup({ selection: sel, storage });
  assert.equal(run.complete, true);
  assert.deepEqual(run.entries.map(e => [e.destination, e.outcome]), [["b.png", "created"]]);
  const call = storage.calls.at(-1);
  assert.equal(call.sourceGeneration, "200");
  assert.equal(call.ifGenerationMatch, c5bGeneration);
  assert.deepEqual(call.metadata, { contentType: "image/png", cacheControl: "no-cache", metadata: { migratedFrom: "thumbnails/b.png", sourceGeneration: "200" } });
  const b = storage.dest.get("b.png");
  assert.equal(b.crc32c, "crc-b-200");
  assert.equal(Object.hasOwn(b.metadata, "captureSequence"), false);
  assert.equal(run.entries[0].generation, b.generation);
  assert.equal(verifyCatchup({ selection: sel, catchups: [run], destinations: destinationsOf(storage, sel) }).ok, true);
});

test("a name absent from the plan is created with ifGenerationMatch=0", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("new", "500"));
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const run = await runCatchup({ selection: sel, storage });
  assert.deepEqual(run.entries.map(e => [e.destination, e.outcome, e.ifGenerationMatch]), [["new.png", "created", "0"]]);
  assert.equal(storage.calls.at(-1).ifGenerationMatch, "0");
  assert.equal(destinationProblem(storage.dest.get("new.png"), sel.entries[0]), null);
});

test("a destination Broker updated is skipped-capture, never replaced, and the run goes on", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("a", "200"));
  setSource(storage, src("b", "200"));
  capture(storage, "a.png");
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const run = await runCatchup({ selection: sel, storage });
  assert.equal(run.complete, true);
  assert.deepEqual(run.entries.map(e => [e.destination, e.outcome]), [["a.png", "skipped-capture"], ["b.png", "created"]]);
  assert.equal(run.entries[0].captureSequence, "4");
  assert.equal(storage.dest.get("a.png").crc32c, "cap", "the capture is untouched");
  assert.equal(verifyCatchup({ selection: sel, catchups: [run], destinations: destinationsOf(storage, sel) }).ok, true);
  // A name C5b never copied that Broker has since published: skipped too.
  setSource(storage, src("fresh", "600"));
  capture(storage, "fresh.png", "1");
  const r = await catchupEntry({ entry: selectCatchup({ plan, copies, listing: listingOf(storage) }).entries.find(e => e.destination === "fresh.png"), storage });
  assert.equal(r.outcome, "skipped-capture");
});

test("a crash after the rewrite completed, before the manifest: the rerun records adopted, not skipped, and verify passes", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("b", "200"));
  setSource(storage, src("new", "500"));
  const sel1 = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const lost = await runCatchup({ selection: sel1, storage });
  assert.deepEqual(lost.entries.map(e => e.outcome), ["created", "created"]);
  // The process dies here: `lost` is never written. The rerun re-lists and runs again.
  const sel2 = selectCatchup({ plan, copies, listing: listingOf(storage) });
  assert.deepEqual(sel2.entries, sel1.entries);
  const before = new Map([...storage.dest].map(([k, v]) => [k, structuredClone(v)]));
  const rerun = await runCatchup({ selection: sel2, storage });
  assert.equal(rerun.complete, true);
  assert.deepEqual(rerun.entries.map(e => [e.destination, e.outcome]), [["b.png", "adopted"], ["new.png", "adopted"]]);
  assert.deepEqual(rerun.entries.map(e => e.generation), lost.entries.map(e => e.generation));
  assert.deepEqual(storage.dest, before, "the rerun writes nothing");
  const v = verifyCatchup({ selection: sel2, catchups: [rerun], destinations: destinationsOf(storage, sel2) });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
});

test("a source changed mid-run stops the run; nothing after it is copied; a rerun after re-listing completes", async () => {
  const { plan, copies, storage } = await c5b();
  for (const i of ["a", "b", "c"]) setSource(storage, src(i, "200"));
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const c5bB = structuredClone(storage.dest.get("b.png"));
  // Between the listing and b's rewrite, an upload lands on b.
  const raced = fakeStorage({ sources: storage.sources, script: { "b.png": { before: () => setSource(storage, src("b", "250")) } } });
  for (const [k, v] of storage.dest) raced.dest.set(k, v);
  const run = await runCatchup({ selection: sel, storage: raced });
  assert.equal(run.complete, false);
  assert.equal(run.stoppedAt, "b.png");
  assert.deepEqual(run.entries.map(e => [e.destination, e.outcome]), [["a.png", "created"], ["b.png", "source-changed"]]);
  assert.equal(run.entries[1].now, "250");
  assert.deepEqual(raced.dest.get("b.png"), c5bB, "C5b's copy of b is untouched");
  assert.equal(raced.dest.get("c.png").metadata.sourceGeneration, "100", "c, after the stop, isn't copied");
  // Verify fails on the stopped run.
  const sel2 = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const v = verifyCatchup({ selection: sel2, catchups: [run], destinations: destinationsOf(raced, sel2) });
  assert.equal(v.ok, false);
  assert.match(v.problems.join("|"), /b\.png: source-changed.*c\.png: no catch-up record/);
  // The rerun (re-listed): a adopted, b and c created; verify over both manifests passes.
  const rerun = await runCatchup({ selection: sel2, storage: raced });
  assert.deepEqual(rerun.entries.map(e => e.outcome), ["adopted", "created", "created"]);
  assert.equal(verifyCatchup({ selection: sel2, catchups: [run, rerun], destinations: destinationsOf(raced, sel2) }).ok, true);
});

test("a destination holding another catch-up's older copy is destination-differs: the run stops, nothing overwritten", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("a", "200"));
  setSource(storage, src("b", "200"));
  const first = await runCatchup({ selection: selectCatchup({ plan, copies, listing: listingOf(storage) }), storage });
  assert.equal(first.complete, true);
  // After that catch-up, a's source changes again (an upload the drain missed).
  setSource(storage, src("a", "300"));
  const held = structuredClone(storage.dest.get("a.png"));
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const run = await runCatchup({ selection: sel, storage });
  assert.equal(run.complete, false);
  assert.deepEqual(run.entries.map(e => [e.destination, e.outcome]), [["a.png", "destination-differs"]]);
  assert.match(run.entries[0].reason, /bytes differ/);
  assert.deepEqual(storage.dest.get("a.png"), held, "never overwritten");
  assert.equal(verifyCatchup({ selection: sel, catchups: [first, run], destinations: destinationsOf(storage, sel) }).ok, false);
  // Any other occupant without a captureSequence: also destination-differs.
  setSource(storage, src("z", "50"));
  storage.dest.set("z.png", { name: "z.png", generation: "1", size: "10", md5Hash: "x", crc32c: "x", contentType: "image/png", cacheControl: "no-cache", metadata: {} });
  const z = await catchupEntry({ entry: selectCatchup({ plan, copies, listing: listingOf(storage) }).entries.find(e => e.destination === "z.png"), storage });
  assert.equal(z.outcome, "destination-differs");
  assert.equal(storage.dest.get("z.png").crc32c, "x");
  // A destination C5b copied that has since vanished (the fence no longer holds): differs, not recreated.
  setSource(storage, src("c", "200"));
  storage.dest.delete("c.png");
  const c = await catchupEntry({ entry: selectCatchup({ plan, copies, listing: listingOf(storage) }).entries.find(e => e.destination === "c.png"), storage });
  assert.deepEqual([c.outcome, c.reason], ["destination-differs", "absent"]);
  assert.equal(storage.dest.has("c.png"), false);
});

test("as C5b's copy: done: true only, continued by token, refused or expired tokens restart, bounded, transient backoff", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("a", "200"));
  const entry = () => selectCatchup({ plan, copies, listing: listingOf(storage) }).entries[0];
  const fenced = entry().ifGenerationMatch;
  // Continued by its rewriteToken to done: true.
  const multi = fakeStorage({ sources: storage.sources, script: { "a.png": { doneAfter: 3, transient: [503, 429] } } });
  for (const [k, v] of storage.dest) multi.dest.set(k, structuredClone(v));
  const slept = [];
  const r = await catchupEntry({ entry: entry(), storage: multi, sleep: async ms => { slept.push(ms); } });
  assert.equal(r.outcome, "created");
  assert.deepEqual(slept, [500, 1000]);
  assert.deepEqual(multi.calls.map(c => c.rewriteToken), [null, null, null, "tok-a.png-1", "tok-a.png-2"]);
  assert.ok(multi.calls.every(c => c.sourceGeneration === "200" && c.ifGenerationMatch === fenced));
  // A refused (400) or expired (410, 404) token restarts under the same fences.
  for (const refuseStatus of [400, 404, 410]) {
    const once = fakeStorage({ sources: storage.sources, script: { "a.png": { doneAfter: 2, refuseTokens: "once", refuseStatus } } });
    for (const [k, v] of storage.dest) once.dest.set(k, structuredClone(v));
    const o = await catchupEntry({ entry: entry(), storage: once });
    assert.equal(o.outcome, "created", `restart after ${refuseStatus}`);
    assert.equal(o.restarts, 1);
    assert.deepEqual(once.calls.map(c => c.rewriteToken), [null, "tok-a.png-1", null, "tok-a.png-1"]);
    assert.ok(once.calls.every(c => c.ifGenerationMatch === fenced));
  }
  // Tokens always refused, or done: false forever: bounded, failed, nothing written, the run stops.
  for (const s of [{ doneAfter: 2, refuseTokens: true }, { doneAfter: 1e9 }]) {
    const stuck = fakeStorage({ sources: storage.sources, script: { "a.png": s } });
    for (const [k, v] of storage.dest) stuck.dest.set(k, structuredClone(v));
    const held = structuredClone(stuck.dest.get("a.png"));
    const f = await catchupEntry({ entry: entry(), storage: stuck, maxRewriteCalls: 5 });
    assert.equal(f.outcome, "failed");
    assert.deepEqual(stuck.dest.get("a.png"), held);
  }
  // done: true, but the object isn't the listed source's bytes: failed, never created.
  const other = fakeStorage({ sources: storage.sources, script: { "a.png": { writeOther: true } } });
  for (const [k, v] of storage.dest) other.dest.set(k, structuredClone(v));
  const w = await runCatchup({ selection: selectCatchup({ plan, copies, listing: listingOf(storage) }), storage: other });
  assert.deepEqual([w.entries[0].outcome, w.complete], ["failed", false]);
  assert.match(w.entries[0].reason, /after done: bytes differ/);
});

test("verify reports every failure and passes only when each selected name is done and matches", async () => {
  const { plan, copies, storage } = await c5b();
  setSource(storage, src("a", "200"));
  setSource(storage, src("b", "200"));
  capture(storage, "b.png");
  const sel = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const run = await runCatchup({ selection: sel, storage });
  assert.deepEqual(run.entries.map(e => e.outcome), ["created", "skipped-capture"]);
  const ok = { selection: sel, catchups: [run], destinations: destinationsOf(storage, sel) };
  assert.equal(verifyCatchup(ok).ok, true);
  const fails = (mutate, pattern) => {
    const v = structuredClone(ok);
    mutate(v);
    const r = verifyCatchup(v);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => pattern.test(p)), JSON.stringify(r.problems));
  };
  fails(v => { v.catchups = []; }, /a\.png: no catch-up record/);
  fails(v => { v.destinations["a.png"] = null; }, /a\.png: absent/);
  fails(v => { v.destinations["a.png"].crc32c = "other"; }, /a\.png: bytes differ/);
  fails(v => { v.destinations["a.png"].metadata.sourceGeneration = "100"; }, /a\.png: metadata/);
  fails(v => { v.destinations["a.png"].cacheControl = "public"; }, /cache control public/);
  fails(v => { v.destinations["b.png"] = null; }, /b\.png: skipped-capture, but the destination is absent/);
  fails(v => { delete v.destinations["b.png"].metadata.captureSequence; }, /b\.png: skipped-capture, but the destination carries no captureSequence/);
  fails(v => { v.catchups[0].entries[0].outcome = "failed"; v.catchups[0].entries[0].reason = "rewrite 500"; }, /a\.png: failed \(rewrite 500\)/);
  fails(v => { v.selection.problems = ["not thumbnails/{item}.png: thumbnails/x/y.png"]; }, /not thumbnails/);
  // The source moved on after the catch-up: its record is stale.
  setSource(storage, src("a", "300"));
  const later = selectCatchup({ plan, copies, listing: listingOf(storage) });
  const r = verifyCatchup({ selection: later, catchups: [run], destinations: destinationsOf(storage, later) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("|"), /a\.png: created at source generation 200, the source is now 300/);
  // A later manifest's record supersedes an earlier one's.
  const stopped = { entries: [{ ...run.entries[0], outcome: "source-changed" }] };
  assert.equal(verifyCatchup({ ...ok, catchups: [stopped, run] }).ok, true);
  assert.equal(verifyCatchup({ ...ok, catchups: [run, stopped] }).ok, false);
});
