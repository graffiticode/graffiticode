// C5b's thumbnails migration and bucket policy (scripts/lib/c5b-thumbnails.js),
// offline, over a fake JSON API (docs/c5b-thumbnails-bucket-plan.md, slice 1).
import test from "node:test";
import assert from "node:assert/strict";
import {
  planEntries, destinationMetadata, destinationProblem, copyEntry, runCopy, amendPlan, verifyPlan,
  editBucketPolicy, normalizedBindings, policyCheck, writeManifestOnce, STEP30_EDIT, STEP30_EXPECTED, SOURCE_BUCKET, DESTINATION_BUCKET,
} from "../lib/c5b-thumbnails.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const src = (item, generation = "100", over = {}) => ({ name: `thumbnails/${item}.png`, generation, size: "10", md5Hash: `md5-${item}-${generation}`, crc32c: `crc-${item}-${generation}`, contentType: "image/png", updated: "2026-11-15T00:00:00Z", ...over });

// A fake JSON API: the source bucket's current objects, the destination's,
// and per-destination scripts for how a rewrite answers.
const fakeStorage = ({ sources, script = {} }) => {
  const dest = new Map();
  const calls = [];
  let nextGeneration = 5000;
  const tokens = new Map();
  return {
    dest,
    calls,
    async rewrite(req) {
      calls.push(req);
      assert.equal(req.sourceBucket, SOURCE_BUCKET);
      assert.equal(req.bucket, DESTINATION_BUCKET);
      assert.ok(req.sourceGeneration, "ifSourceGenerationMatch is always sent");
      const s = script[req.name] ?? {};
      if (s.transient?.length) return { status: s.transient.shift() };
      if (req.rewriteToken && s.refuseTokens === "once" && !s.refused) { s.refused = true; return { status: s.refuseStatus ?? 400 }; }
      if (req.rewriteToken && (s.refuseTokens === true || !tokens.has(req.rewriteToken))) return { status: 400 };
      const current = sources.get(req.source);
      if (!current || current.generation !== req.sourceGeneration) return { status: 412 };
      if (dest.has(req.name)) return { status: 412 };
      const progress = req.rewriteToken ? tokens.get(req.rewriteToken) + 1 : 1;
      if (progress < (s.doneAfter ?? 1)) {
        const token = `tok-${req.name}-${progress}`;
        tokens.set(token, progress);
        if (s.dieAt === progress) throw new Error("the operator's process died mid-rewrite");
        return { status: 200, body: { done: false, rewriteToken: token } };
      }
      const generation = String(nextGeneration++);
      const meta = s.writeOther ? { ...current, crc32c: "other" } : current;
      dest.set(req.name, { name: req.name, generation, size: meta.size, md5Hash: meta.md5Hash, crc32c: meta.crc32c, ...req.metadata });
      return { status: 200, body: { done: true, resource: { name: req.name, generation } } };
    },
    async get(bucket, name) {
      assert.equal(bucket, DESTINATION_BUCKET);
      return dest.has(name) ? { status: 200, body: dest.get(name) } : { status: 404 };
    },
  };
};
const sourcesOf = listing => new Map(listing.map(o => [o.name, o]));
const PLAN = listing => ({ number: 1, ...planEntries(listing) });

test("the plan: one entry per thumbnails/{item}.png, Broker's item pattern, no destination twice", () => {
  const { entries, problems } = planEntries([src("b"), src("a"), { ...src("x"), name: "thumbnails/sub/x.png" }, { ...src("y"), name: "thumbnails/y.jpg" }, { ...src("z"), name: "thumbnails/bad id.png" }, src("a")]);
  assert.deepEqual(entries.map(e => e.destination), ["a.png", "b.png"]);
  assert.deepEqual(entries[0], { item: "a", source: "thumbnails/a.png", sourceGeneration: "100", size: "10", md5Hash: "md5-a-100", crc32c: "crc-a-100", contentType: "image/png", updated: "2026-11-15T00:00:00Z", destination: "a.png" });
  assert.equal(problems.length, 4);
  assert.match(problems.join("|"), /sub\/x\.png.*y\.jpg.*bad id\.png.*named twice: a\.png/);
  assert.deepEqual(destinationMetadata(entries[0]), { contentType: "image/png", cacheControl: "no-cache", metadata: { migratedFrom: "thumbnails/a.png", sourceGeneration: "100" } });
});

test("a rewrite is created only at done: true, continued by its token, and the destination's metadata matching", async () => {
  const listing = [src("a")];
  const storage = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 3 } } });
  const r = await copyEntry({ entry: PLAN(listing).entries[0], storage });
  assert.equal(r.outcome, "created");
  assert.equal(r.calls, 3);
  assert.deepEqual(storage.calls.map(c => c.rewriteToken), [null, "tok-a.png-1", "tok-a.png-2"]);
  assert.ok(storage.calls.every(c => c.sourceGeneration === "100" && c.metadata.cacheControl === "no-cache"));
  assert.equal(destinationProblem(storage.dest.get("a.png"), PLAN(listing).entries[0]), null);
  // done: true but the object written isn't the plan's bytes: never created.
  const bad = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { writeOther: true } } });
  assert.deepEqual([(await copyEntry({ entry: PLAN(listing).entries[0], storage: bad })).outcome], ["failed"]);
  // done: false forever: bounded, failed, never created.
  const endless = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 1e9 } } });
  const e = await copyEntry({ entry: PLAN(listing).entries[0], storage: endless, maxRewriteCalls: 5 });
  assert.equal(e.outcome, "failed");
  assert.match(e.reason, /no done: true after 5/);
});

test("interruption: a lost token reruns to completion; a refused token restarts under the same preconditions", async () => {
  const listing = [src("a"), src("b")];
  const plan = PLAN(listing);
  const storage = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 3, dieAt: 2 } } });
  await assert.rejects(runCopy({ plan, storage }), /died mid-rewrite/);
  assert.equal(storage.dest.size, 0, "nothing is created by an unfinished rewrite");
  // The rerun is a fresh process: no token survives, and it starts over.
  const rerun = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 2 } } });
  const copy = await runCopy({ plan, storage: rerun });
  assert.equal(copy.complete, true);
  assert.deepEqual(copy.entries.map(e => e.outcome), ["created", "created"]);
  // A token refused once: the rewrite restarts with no token, and completes.
  const once = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 2, refuseTokens: "once" } } });
  const o = await copyEntry({ entry: plan.entries[0], storage: once });
  assert.equal(o.outcome, "created");
  assert.equal(o.restarts, 1);
  assert.deepEqual(once.calls.map(c => c.rewriteToken), [null, "tok-a.png-1", null, "tok-a.png-1"]);
  // Tokens always refused: bounded, failed, never created.
  const refused = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 2, refuseTokens: true } } });
  const r = await copyEntry({ entry: plan.entries[0], storage: refused, maxRewriteCalls: 6 });
  assert.equal(r.outcome, "failed");
  assert.ok(r.restarts >= 2);
  assert.ok(refused.calls.every(c => c.sourceGeneration === "100"));
});

test("a rerun after a partial copy adopts what the first run finished; transient answers back off", async () => {
  const listing = [src("a"), src("b"), src("c")];
  const plan = PLAN(listing);
  const storage = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { transient: [503, 429] } } });
  const slept = [];
  const first = await copyEntry({ entry: plan.entries[0], storage, sleep: async ms => { slept.push(ms); } });
  assert.equal(first.outcome, "created");
  assert.deepEqual(slept, [500, 1000]);
  const rerun = await runCopy({ plan, storage });
  assert.deepEqual(rerun.entries.map(e => e.outcome), ["adopted", "created", "created"]);
  assert.equal(rerun.complete, true);
});

test("a source changed since the plan stops the run; the amended plan re-reads only that entry", async () => {
  const listing = [src("a"), src("b"), src("c")];
  const plan1 = PLAN(listing);
  const now = [src("a"), src("b", "200"), src("c")];
  const storage = fakeStorage({ sources: sourcesOf(now) });
  const copy1 = await runCopy({ plan: plan1, storage });
  assert.deepEqual(copy1.entries.map(e => e.outcome), ["created", "source-changed"]);
  assert.equal(copy1.stoppedAt, "b.png");
  assert.equal(storage.dest.has("c.png"), false, "nothing after the stop is copied");
  const frozen = JSON.stringify([plan1, copy1]);
  const plan2 = amendPlan({ plan: plan1, copies: [copy1], listing: now });
  assert.equal(JSON.stringify([plan1, copy1]), frozen, "earlier manifests are untouched");
  assert.deepEqual(plan2.changed, ["b.png"]);
  assert.equal(plan2.number, 2);
  assert.equal(plan2.entries[0], plan1.entries[0]);
  assert.equal(plan2.entries[1].sourceGeneration, "200");
  const copy2 = await runCopy({ plan: plan2, storage });
  assert.deepEqual(copy2.entries.map(e => e.outcome), ["adopted", "created", "created"]);
  // A copied entry whose source changes later keeps its record.
  const later = [src("a", "300"), src("b", "200"), src("c")];
  const plan3 = amendPlan({ plan: plan2, copies: [copy1, copy2], listing: later });
  assert.deepEqual(plan3.changed, []);
});

test("a destination that exists with other bytes stops the run and is never replaced", async () => {
  const listing = [src("a"), src("b")];
  const plan = PLAN(listing);
  const storage = fakeStorage({ sources: sourcesOf(listing) });
  storage.dest.set("a.png", { name: "a.png", generation: "1", size: "10", md5Hash: "x", crc32c: "x", contentType: "image/png", cacheControl: "no-cache", metadata: { captureSequence: "3" } });
  const copy = await runCopy({ plan, storage });
  assert.deepEqual(copy.entries.map(e => e.outcome), ["exists-differs"]);
  assert.equal(storage.dest.get("a.png").crc32c, "x");
  assert.equal(storage.dest.has("b.png"), false);
});

const verifyInputs = (plan, storage, over = {}) => ({
  plan,
  copies: over.copies,
  destinations: Object.fromEntries(plan.entries.map(e => [e.destination, storage.dest.get(e.destination) ?? null])),
  anonymous: { reads: Object.fromEntries(plan.entries.map(e => [e.destination, { status: 200, md5Hash: e.md5Hash }])), list: { json: 401, xml: 403 } },
  sources: Object.fromEntries(plan.entries.map(e => [e.source, e.sourceGeneration])),
});
test("verify passes only for the final plan, every entry done and matching, readable, unlisted", async () => {
  const listing = [src("a"), src("b")];
  const plan = PLAN(listing);
  const storage = fakeStorage({ sources: sourcesOf(listing) });
  const copy = await runCopy({ plan, storage });
  const ok = verifyInputs(plan, storage, { copies: [copy] });
  assert.equal(verifyPlan(ok).ok, true);
  const fails = (mutate, pattern) => { const v = structuredClone(ok); mutate(v); const r = verifyPlan(v); assert.equal(r.ok, false); assert.ok(r.problems.some(p => pattern.test(p)), JSON.stringify(r.problems)); };
  fails(v => { v.copies = [{ ...copy, entries: copy.entries.slice(0, 1) }]; }, /b\.png: not created or adopted/);
  fails(v => { v.destinations["a.png"] = null; }, /a\.png: absent/);
  fails(v => { v.destinations["a.png"].metadata.captureSequence = "1"; }, /carries a captureSequence/);
  fails(v => { v.destinations["a.png"].cacheControl = "public"; }, /cache control public/);
  fails(v => { v.anonymous.reads["b.png"] = { status: 403 }; }, /anonymous read 403/);
  fails(v => { v.anonymous.reads["b.png"].md5Hash = "other"; }, /other bytes/);
  fails(v => { v.anonymous.list.json = 200; }, /anonymous json listing answered 200/);
  fails(v => { delete v.sources["thumbnails/a.png"]; }, /wasn't read/);
  // A source updated after its copy is listed for C5d, not a failure.
  const later = structuredClone(ok);
  later.sources["thumbnails/a.png"] = "900";
  const r = verifyPlan(later);
  assert.equal(r.ok, true);
  assert.deepEqual(r.updatedSinceCopy, [{ source: "thumbnails/a.png", copied: "100", now: "900" }]);
});

// Step 30's policy edit merges grants into existing role bindings.
const FRESH = {
  etag: "CAE=",
  version: 1,
  bindings: [
    { role: "roles/storage.legacyBucketOwner", members: ["projectEditor:graffiticode", "projectOwner:graffiticode"] },
    { role: "roles/storage.legacyBucketReader", members: ["projectViewer:graffiticode"] },
    { role: "roles/storage.legacyObjectOwner", members: ["projectEditor:graffiticode", "projectOwner:graffiticode"] },
    { role: "roles/storage.legacyObjectReader", members: ["projectViewer:graffiticode"] },
  ],
};
test("the Step 30 edit: a fresh policy becomes exactly the expected bindings, the etag kept", () => {
  const once = editBucketPolicy(FRESH, STEP30_EDIT);
  assert.equal(once.etag, "CAE=");
  assert.equal(once.version, 1);
  assert.deepEqual(normalizedBindings(once), STEP30_EXPECTED);
  // legacyObjectReader existed (projectViewer); allUsers merged into that role, one binding per role.
  assert.equal(once.bindings.filter(b => b.role === "roles/storage.legacyObjectReader").length, 1);
});

test("the Step 30 edit on an already-granted policy, and applied twice, adds nothing", () => {
  const twice = editBucketPolicy(editBucketPolicy(FRESH, STEP30_EDIT), STEP30_EDIT);
  assert.deepEqual(normalizedBindings(twice), STEP30_EXPECTED);
  const granted = { etag: "CAI=", bindings: [...STEP30_EXPECTED.map(b => ({ ...b, members: [...b.members] })), { role: "roles/storage.objectUser", members: ["serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com"] }] };
  const edited = editBucketPolicy(granted, STEP30_EDIT);
  assert.deepEqual(normalizedBindings(edited), STEP30_EXPECTED);
  assert.equal(edited.bindings.length, 4, "duplicate role bindings are merged");
  assert.ok(edited.bindings.every(b => new Set(b.members).size === b.members.length));
  assert.throws(() => editBucketPolicy({ bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"], condition: { expression: "true" } }] }, STEP30_EDIT), /conditional binding/);
});

// The #428 review.
test("an expired rewrite token (410) restarts the rewrite, within the bound", async () => {
  const listing = [src("a")];
  const storage = fakeStorage({ sources: sourcesOf(listing), script: { "a.png": { doneAfter: 2, refuseTokens: "once", refuseStatus: 410 } } });
  const r = await copyEntry({ entry: PLAN(listing).entries[0], storage });
  assert.equal(r.outcome, "created");
  assert.equal(r.restarts, 1);
  assert.deepEqual(storage.calls.map(c => c.rewriteToken), [null, "tok-a.png-1", null, "tok-a.png-1"]);
});

test("verify never passes a plan with unresolved problems", async () => {
  const listing = [src("a")];
  const plan1 = PLAN(listing);
  const storage = fakeStorage({ sources: sourcesOf(listing) });
  const copy = await runCopy({ plan: plan1, storage });
  // The reviewer's case: an amended plan that recorded a rejected source name.
  const plan2 = amendPlan({ plan: plan1, copies: [copy], listing: [...listing, { ...src("b"), name: "thumbnails/sub/b.png" }] });
  assert.equal(plan2.problems.length, 1);
  const r = verifyPlan({ ...verifyInputs(plan2, storage, { copies: [copy] }) });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /^plan 2: not thumbnails\/\{item\}\.png: thumbnails\/sub\/b\.png$/);
  assert.equal(verifyPlan(verifyInputs(plan1, storage, { copies: [copy] })).ok, true);
});

test("a manifest is created exclusively: a concurrent writer that wins is never overwritten", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c5b-manifest-"));
  const file = path.join(dir, "plan-1.json");
  // The interleaving: another planner creates the name just before this write.
  const racing = (f, data, options) => {
    writeFileSync(f, JSON.stringify({ competingWriter: "must survive" }));
    return writeFileSync(f, data, options);
  };
  assert.throws(() => writeManifestOnce(file, { number: 1 }, { writeFileSync: racing }), /exists; manifests are never overwritten/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { competingWriter: "must survive" });
  // Uncontended: created once; a second write is refused, the first kept.
  const other = path.join(dir, "plan-2.json");
  writeManifestOnce(other, { number: 2 });
  assert.throws(() => writeManifestOnce(other, { number: 99 }), /never overwritten/);
  assert.equal(JSON.parse(readFileSync(other, "utf8")).number, 2);
});

test("the exact read-back refuses a conditional binding, even with the approved members", () => {
  const expected = { etag: "CAE=", bindings: structuredClone(STEP30_EXPECTED) };
  assert.equal(policyCheck(expected).same, true);
  // The reviewer's case: Broker restricted to probe names passes the probes but not real publications.
  const probesOnly = structuredClone(expected);
  probesOnly.bindings.find(b => b.role === "roles/storage.objectUser").condition = { title: "probes-only", expression: "resource.name.startsWith(\"projects/_/buckets/graffiticode-thumbnails/objects/c5b-probe/\")" };
  const r = policyCheck(probesOnly);
  assert.equal(r.same, false);
  assert.deepEqual(r.conditional, ["roles/storage.objectUser"]);
  assert.ok(normalizedBindings(probesOnly).find(b => b.role === "roles/storage.objectUser").condition);
  // A conditional duplicate beside the unconditional grant fails too.
  const extra = structuredClone(expected);
  extra.bindings.push({ ...probesOnly.bindings.find(b => b.role === "roles/storage.objectUser") });
  assert.equal(policyCheck(extra).same, false);
});
