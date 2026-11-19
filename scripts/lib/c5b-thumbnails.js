// C5b's thumbnails migration and bucket policy (docs/c5b-thumbnails-bucket-plan.md),
// as pure functions over an injected storage API, so every rule is tested
// offline (scripts/test/c5b-thumbnails.test.js). The CLI is
// scripts/c5b/migrate-thumbnails.js; the policy edit's is scripts/c5b/bucket-policy.js.
// C5d's catch-up copy (docs/c5d-snapshot-commands-plan.md) extends it: its rules
// are below, tested in scripts/test/c5d-catchup.test.js.
//
// Storage API (the JSON API, injected):
//   rewrite({ sourceBucket, source, sourceGeneration, bucket, name, ifGenerationMatch, metadata, rewriteToken })
//     -> { status, body }   one objects.rewrite call with ifSourceGenerationMatch=sourceGeneration
//                           and ifGenerationMatch (C5b's copy: "0"; C5d's catch-up: the
//                           generation C5b's copy created for the name, or "0");
//                           body { done, rewriteToken, resource } on 200
//   get(bucket, name) -> { status, body }   the object's metadata (either bucket), or 404
//   The CLI also lists the source bucket; the rules take that listing as input.
//
// Plan entry: { item, source, sourceGeneration, size, md5Hash, crc32c, contentType, updated, destination }
// Copy outcomes: created | adopted | source-changed | exists-differs | failed
// C5d catch-up outcomes (docs/c5d-snapshot-commands-plan.md, slice 1 item 4):
//   created | adopted | skipped-capture | source-changed | destination-differs | failed

import { writeFileSync as fsWriteFileSync } from "node:fs";

export const SOURCE_BUCKET = "graffiticode.appspot.com";
export const DESTINATION_BUCKET = "graffiticode-thumbnails";
// Broker's item id pattern (packages/broker/src/gcs.ts ITEM_RE): the
// destination is the name Broker publishes, `{item}.png`.
export const ITEM_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_RE = /^thumbnails\/([^/]+)\.png$/;

// ------------------------------------------------------------------- plan

// The plan from the source listing (every page): one entry per thumbnail,
// refusing any name that isn't `thumbnails/{item}.png` with Broker's item
// pattern, and any destination named twice.
export const planEntries = listing => {
  const problems = [];
  const entries = [];
  const seen = new Set();
  for (const o of listing) {
    const m = SOURCE_RE.exec(o.name ?? "");
    if (!m || !ITEM_RE.test(m[1])) {
      problems.push(`not thumbnails/{item}.png: ${o.name}`);
      continue;
    }
    const destination = `${m[1]}.png`;
    if (seen.has(destination)) {
      problems.push(`destination named twice: ${destination}`);
      continue;
    }
    seen.add(destination);
    entries.push({
      item: m[1],
      source: o.name,
      sourceGeneration: String(o.generation),
      size: String(o.size),
      md5Hash: o.md5Hash,
      crc32c: o.crc32c,
      contentType: o.contentType ?? null,
      updated: o.updated ?? null,
      destination,
    });
  }
  entries.sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
  return { entries, problems };
};

// What every migrated object carries (plan decision 6): no captureSequence,
// so the first capture replaces it.
export const destinationMetadata = entry => ({
  contentType: "image/png",
  cacheControl: "no-cache",
  metadata: { migratedFrom: entry.source, sourceGeneration: entry.sourceGeneration },
});

// A destination object matches its plan entry: the planned bytes and the
// planned metadata, and no captureSequence.
export const destinationProblem = (meta, entry) => {
  if (!meta) return "absent";
  const want = destinationMetadata(entry);
  if (meta.crc32c !== entry.crc32c || meta.md5Hash !== entry.md5Hash || String(meta.size) !== entry.size) return "bytes differ";
  if (meta.contentType !== want.contentType || meta.cacheControl !== want.cacheControl) return `content type ${meta.contentType}, cache control ${meta.cacheControl}`;
  const custom = meta.metadata ?? {};
  if (custom.migratedFrom !== entry.source || custom.sourceGeneration !== entry.sourceGeneration) return `metadata ${JSON.stringify(custom)}`;
  if (Object.hasOwn(custom, "captureSequence")) return "carries a captureSequence";
  return null;
};

// ------------------------------------------------------------------- copy

export const TRANSIENT = status => status === 429 || (status >= 500 && status < 600);
export const MAX_ATTEMPTS = 6;
export const MAX_REWRITE_CALLS = 100;

// One call, with transient answers retried by backoff. Each attempt is the
// same request with the same preconditions.
const withBackoff = async (call, { sleep, maxAttempts = MAX_ATTEMPTS, baseMs = 500 }) => {
  for (let attempt = 1; ; attempt++) {
    const res = await call();
    if (!TRANSIENT(res.status) || attempt >= maxAttempts) return { ...res, attempts: attempt };
    await sleep(baseMs * 2 ** (attempt - 1));
  }
};

// One rewrite, to completion: a 200 with done: false is continued with its
// rewriteToken; a refused or expired token (400, 404, or 410, which Google
// documents for an expired rewrite token) restarts the rewrite under the same
// preconditions, within the call bound. Answers { resource } at done: true,
// { status: 412 } on a precondition failure, or { failed: reason }. `record`
// counts the calls and restarts. Shared by C5b's copy and C5d's catch-up.
const rewriteToCompletion = async ({ request, storage, sleep, maxRewriteCalls, record }) => {
  let rewriteToken = null;
  for (;;) {
    if (record.calls >= maxRewriteCalls) return { failed: `no done: true after ${record.calls} rewrite calls` };
    const res = await withBackoff(() => storage.rewrite({ ...request, rewriteToken }), { sleep });
    record.calls++;
    if (res.status === 200) {
      if (res.body?.done === true && res.body.resource) return { resource: res.body.resource };
      if (!res.body?.rewriteToken) return { failed: "done: false without a rewriteToken" };
      rewriteToken = res.body.rewriteToken;
      continue;
    }
    if (rewriteToken && (res.status === 400 || res.status === 404 || res.status === 410)) {
      rewriteToken = null;
      record.restarts++;
      continue;
    }
    if (res.status === 412) return { status: 412 };
    return { failed: `rewrite ${res.status}` };
  }
};

// After done: true, only the destination's own metadata matching the entry,
// at the generation the rewrite answered, is `created`.
const checkCreated = async ({ entry, resource, storage, sleep, record }) => {
  const dest = await withBackoff(() => storage.get(DESTINATION_BUCKET, entry.destination), { sleep });
  if (dest.status !== 200) return { ...record, outcome: "failed", reason: `destination read ${dest.status} after done` };
  const problem = destinationProblem(dest.body, entry);
  if (problem) return { ...record, outcome: "failed", reason: `after done: ${problem}` };
  if (String(dest.body.generation) !== String(resource.generation)) return { ...record, outcome: "failed", reason: `generation ${dest.body.generation}, rewrite answered ${resource.generation}` };
  return { ...record, outcome: "created", generation: dest.body.generation };
};

// One plan entry, to completion (rewriteToCompletion), create-only
// (ifGenerationMatch=0). A 412 is told apart by reading the destination:
// absent means the source changed; a matching object is `adopted` (an earlier,
// interrupted run finished it); any other is `exists-differs`, never replaced.
export const copyEntry = async ({ entry, storage, sleep = async () => {}, maxRewriteCalls = MAX_REWRITE_CALLS }) => {
  const request = { sourceBucket: SOURCE_BUCKET, source: entry.source, sourceGeneration: entry.sourceGeneration, bucket: DESTINATION_BUCKET, name: entry.destination, ifGenerationMatch: "0", metadata: destinationMetadata(entry) };
  const record = { destination: entry.destination, calls: 0, restarts: 0 };
  const r = await rewriteToCompletion({ request, storage, sleep, maxRewriteCalls, record });
  if (r.failed) return { ...record, outcome: "failed", reason: r.failed };
  if (r.status === 412) {
    const dest = await withBackoff(() => storage.get(DESTINATION_BUCKET, entry.destination), { sleep });
    if (dest.status === 404) return { ...record, outcome: "source-changed" };
    if (dest.status !== 200) return { ...record, outcome: "failed", reason: `destination read ${dest.status}` };
    const problem = destinationProblem(dest.body, entry);
    return problem ? { ...record, outcome: "exists-differs", reason: problem, generation: dest.body.generation } : { ...record, outcome: "adopted", generation: dest.body.generation };
  }
  return checkCreated({ entry, resource: r.resource, storage, sleep, record });
};

export const DONE = new Set(["created", "adopted"]);
export const STOPPING = new Set(["source-changed", "exists-differs", "failed"]);

// The whole plan, in order, one object at a time, stopping at the first
// source-changed, exists-differs or failed entry: nothing after it is copied.
export const runCopy = async ({ plan, storage, sleep, onEntry = () => {} }) => {
  const entries = [];
  for (const entry of plan.entries) {
    const result = await copyEntry({ entry, storage, sleep });
    entries.push(result);
    onEntry(result);
    if (STOPPING.has(result.outcome)) return { plan: plan.number, entries, stoppedAt: entry.destination, complete: false };
  }
  return { plan: plan.number, entries, stoppedAt: null, complete: true };
};

// The amended plan after a source-changed stop: the previous plan's entries
// that some copy run created or adopted keep their records, and so does every
// entry whose source is unchanged; only a changed, not-yet-copied entry is
// re-read from the fresh listing (its new generation, bytes and metadata).
// Earlier manifests are inputs only, never changed.
export const amendPlan = ({ plan, copies, listing }) => {
  const copied = new Set(copies.flatMap(c => c.entries.filter(e => DONE.has(e.outcome)).map(e => e.destination)));
  const fresh = planEntries(listing);
  const byDestination = new Map(fresh.entries.map(e => [e.destination, e]));
  const problems = [...fresh.problems];
  const entries = plan.entries.map(e => {
    if (copied.has(e.destination)) return e;
    const now = byDestination.get(e.destination);
    if (!now) {
      problems.push(`${e.source}: no longer in the source listing`);
      return e;
    }
    // Unchanged at the source (same generation and bytes): the previous record stands.
    const same = now.sourceGeneration === e.sourceGeneration && now.crc32c === e.crc32c && now.md5Hash === e.md5Hash && now.size === e.size;
    return same ? e : now;
  });
  const changed = entries.filter((e, i) => e !== plan.entries[i]).map(e => e.destination);
  return { number: plan.number + 1, amends: plan.number, entries, changed, problems };
};

// ----------------------------------------------------------------- verify

// Verify against the final plan: every entry created or adopted by the copy
// runs, and the destination matching it; anonymously, each object readable
// with the same bytes and the bucket not listable; sources updated after
// their copy are listed for C5d, not failures.
//   copies       every copy manifest run against any plan
//   destinations { name: metadata | null }
//   anonymous    { reads: { name: { status, md5Hash } }, list: { json, xml } }
//                md5Hash: base64 MD5 of the bytes read anonymously (Node computes
//                MD5, not CRC32C), compared with the plan's md5Hash
//   sources      { name: generation | null }   the source bucket now
export const verifyPlan = ({ plan, copies, destinations, anonymous, sources }) => {
  // A plan with unresolved problems (a rejected source name, a duplicate, a
  // vanished source) is never verified, whatever its entries show.
  const problems = (plan.problems ?? []).map(p => `plan ${plan.number}: ${p}`);
  const done = new Map();
  for (const c of copies) for (const e of c.entries) if (DONE.has(e.outcome)) done.set(e.destination, e);
  const updatedSinceCopy = [];
  for (const entry of plan.entries) {
    const d = entry.destination;
    if (!done.has(d)) problems.push(`${d}: not created or adopted by any copy`);
    const problem = destinationProblem(destinations[d] ?? null, entry);
    if (problem) problems.push(`${d}: ${problem}`);
    const read = anonymous?.reads?.[d];
    if (read?.status !== 200 || read.md5Hash !== entry.md5Hash) problems.push(`${d}: anonymous read ${read?.status ?? "not made"}${read?.status === 200 ? ", other bytes" : ""}`);
    const now = sources?.[entry.source];
    if (now === undefined) problems.push(`${entry.source}: the source wasn't read`);
    else if (now !== null && String(now) !== entry.sourceGeneration) updatedSinceCopy.push({ source: entry.source, copied: entry.sourceGeneration, now: String(now) });
  }
  for (const via of ["json", "xml"]) {
    const s = anonymous?.list?.[via];
    if (s !== 401 && s !== 403) problems.push(`anonymous ${via} listing answered ${s ?? "not made"}`);
  }
  return { problems, updatedSinceCopy, ok: problems.length === 0 };
};

// ------------------------------------------------------------ C5d catch-up
// docs/c5d-snapshot-commands-plan.md, slice 1 item 4 and activation step 4:
// after direct uploads are disabled and drained, every old-bucket thumbnail
// updated since C5b's final plan is copied under its generation fences, or
// skipped where Broker has since published. Tests: scripts/test/c5d-catchup.test.js.

// The generation C5b's copy created (or adopted) for each name, from every
// copy manifest. A create-only copy can't leave two generations for one name;
// manifests that disagree are a problem, never a guess.
export const copiedGenerations = copies => {
  const generations = new Map();
  const problems = [];
  for (const c of copies) {
    for (const e of c.entries) {
      if (!DONE.has(e.outcome)) continue;
      const g = String(e.generation);
      const had = generations.get(e.destination);
      if (had !== undefined && had !== g) problems.push(`${e.destination}: copy manifests record generations ${had} and ${g}`);
      else generations.set(e.destination, g);
    }
  }
  return { generations, problems };
};

// Which objects: every `thumbnails/{item}.png` in the old bucket's listing
// (every page) whose generation differs from the final plan's entry, or that
// the plan doesn't have; bad names are refused as planEntries refuses them.
// Each selected entry carries the destination generation it is fenced on:
// the one C5b's copy created for that name, or "0" if it copied none.
export const selectCatchup = ({ plan, copies, listing }) => {
  const fresh = planEntries(listing);
  const { generations, problems: copyProblems } = copiedGenerations(copies);
  const problems = [...(plan.problems ?? []).map(p => `plan ${plan.number}: ${p}`), ...fresh.problems, ...copyProblems];
  const planned = new Map(plan.entries.map(e => [e.destination, e]));
  const entries = [];
  for (const e of fresh.entries) {
    const was = planned.get(e.destination);
    if (was && was.sourceGeneration === e.sourceGeneration) continue;
    entries.push({ ...e, plannedGeneration: was?.sourceGeneration ?? null, ifGenerationMatch: generations.get(e.destination) ?? "0" });
  }
  // Informational: a planned source the old bucket no longer lists is left as copied.
  const listed = new Set(fresh.entries.map(e => e.destination));
  const absentFromListing = plan.entries.filter(e => !listed.has(e.destination)).map(e => e.source);
  return { plan: plan.number, entries, problems, absentFromListing };
};

const hasCapture = meta => Object.hasOwn(meta?.metadata ?? {}, "captureSequence");

// One catch-up entry, to completion as C5b's copy is, with
// ifSourceGenerationMatch = the listed generation and ifGenerationMatch = the
// recorded destination generation. The metadata is C5b's, with the new
// sourceGeneration and no captureSequence. A 412 is told apart by reading the
// destination, then the source:
//   skipped-capture      the destination carries a captureSequence: Broker
//                        published since; never replaced
//   adopted              the destination already is this copy of the listed
//                        source (a rerun after a crash before the manifest)
//   source-changed       the source is no longer the listed generation; the run stops
//   destination-differs  anything else; the run stops, nothing is overwritten
export const catchupEntry = async ({ entry, storage, sleep = async () => {}, maxRewriteCalls = MAX_REWRITE_CALLS }) => {
  const request = { sourceBucket: SOURCE_BUCKET, source: entry.source, sourceGeneration: entry.sourceGeneration, bucket: DESTINATION_BUCKET, name: entry.destination, ifGenerationMatch: entry.ifGenerationMatch, metadata: destinationMetadata(entry) };
  const record = { destination: entry.destination, source: entry.source, sourceGeneration: entry.sourceGeneration, ifGenerationMatch: entry.ifGenerationMatch, calls: 0, restarts: 0 };
  const r = await rewriteToCompletion({ request, storage, sleep, maxRewriteCalls, record });
  if (r.failed) return { ...record, outcome: "failed", reason: r.failed };
  if (r.status !== 412) return checkCreated({ entry, resource: r.resource, storage, sleep, record });
  const dest = await withBackoff(() => storage.get(DESTINATION_BUCKET, entry.destination), { sleep });
  if (dest.status !== 200 && dest.status !== 404) return { ...record, outcome: "failed", reason: `destination read ${dest.status}` };
  const meta = dest.status === 200 ? dest.body : null;
  if (meta && hasCapture(meta)) return { ...record, outcome: "skipped-capture", generation: meta.generation, captureSequence: String(meta.metadata.captureSequence) };
  if (meta && destinationProblem(meta, entry) === null) return { ...record, outcome: "adopted", generation: meta.generation };
  const source = await withBackoff(() => storage.get(SOURCE_BUCKET, entry.source), { sleep });
  if (source.status === 404 || (source.status === 200 && String(source.body.generation) !== entry.sourceGeneration)) {
    return { ...record, outcome: "source-changed", now: source.status === 200 ? String(source.body.generation) : null };
  }
  if (source.status !== 200) return { ...record, outcome: "failed", reason: `source read ${source.status}` };
  return { ...record, outcome: "destination-differs", reason: meta ? destinationProblem(meta, entry) : "absent", generation: meta?.generation ?? null };
};

export const CATCHUP_DONE = new Set(["created", "adopted", "skipped-capture"]);
export const CATCHUP_STOPPING = new Set(["source-changed", "destination-differs", "failed"]);

// The whole selection, in order, one object at a time, stopping at the first
// source-changed, destination-differs or failed entry: nothing after it is
// copied. A selection with problems is never run.
export const runCatchup = async ({ selection, storage, sleep, onEntry = () => {} }) => {
  if (selection.problems.length) throw new Error(`the catch-up selection has problems: ${selection.problems.join("; ")}`);
  const entries = [];
  for (const entry of selection.entries) {
    const result = await catchupEntry({ entry, storage, sleep });
    entries.push(result);
    onEntry(result);
    if (CATCHUP_STOPPING.has(result.outcome)) return { plan: selection.plan, entries, stoppedAt: entry.destination, complete: false };
  }
  return { plan: selection.plan, entries, stoppedAt: null, complete: true };
};

// The catch-up's own verify, read-only, against the selection made now: each
// selected name's latest catch-up record (manifests oldest first) is created
// or adopted, for the source's current generation, with the destination
// matching it; or skipped-capture, with the destination carrying a
// captureSequence.
//   catchups      every catch-up manifest, oldest first
//   destinations  { name: metadata | null }   for every selected name
export const verifyCatchup = ({ selection, catchups, destinations }) => {
  const problems = [...selection.problems];
  const latest = new Map();
  for (const c of catchups) for (const e of c.entries) latest.set(e.destination, e);
  for (const entry of selection.entries) {
    const d = entry.destination;
    const rec = latest.get(d);
    const meta = destinations[d] ?? null;
    if (!rec) {
      problems.push(`${d}: no catch-up record`);
      continue;
    }
    if (rec.outcome === "skipped-capture") {
      if (!hasCapture(meta)) problems.push(`${d}: skipped-capture, but the destination ${meta ? "carries no captureSequence" : "is absent"}`);
      continue;
    }
    if (!DONE.has(rec.outcome)) {
      problems.push(`${d}: ${rec.outcome}${rec.reason ? ` (${rec.reason})` : ""}`);
      continue;
    }
    if (rec.sourceGeneration !== entry.sourceGeneration) problems.push(`${d}: ${rec.outcome} at source generation ${rec.sourceGeneration}, the source is now ${entry.sourceGeneration}`);
    const problem = destinationProblem(meta, entry);
    if (problem) problems.push(`${d}: ${problem}`);
  }
  return { plan: selection.plan, selected: selection.entries.length, problems, ok: problems.length === 0 };
};

// ------------------------------------------------------------ bucket policy

// The Step 30 edit: remove members everywhere, and grant each { role, member }
// by merging it into that role's existing binding (never a second binding for
// a role), dropping bindings left empty. Idempotent: applying it twice equals
// applying it once. Everything else in the policy, the etag included, is kept.
export const editBucketPolicy = (policy, { removeMembers = [], grants = [] }) => {
  const drop = new Set(removeMembers);
  const byRole = new Map();
  for (const b of policy.bindings ?? []) {
    if (b.condition) throw new Error(`a conditional binding on ${b.role}: edit it by hand`);
    const members = (byRole.get(b.role) ?? []).concat((b.members ?? []).filter(m => !drop.has(m)));
    byRole.set(b.role, members);
  }
  for (const { role, member } of grants) byRole.set(role, [...(byRole.get(role) ?? []), member]);
  const bindings = [...byRole].map(([role, members]) => ({ role, members: [...new Set(members)].sort() })).filter(b => b.members.length).sort((a, b) => (a.role < b.role ? -1 : 1));
  return { ...policy, bindings };
};
// The comparable form of a policy's bindings, for the exact read-back. A
// binding's condition is kept, so a conditional grant (Broker restricted to
// probe names, say) never compares equal to the approved unconditional one.
export const normalizedBindings = policy => (policy.bindings ?? [])
  .map(b => ({ role: b.role, members: [...new Set(b.members)].sort(), ...(b.condition ? { condition: b.condition } : {}) }))
  .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
// The exact read-back: the expected bindings, with no condition anywhere.
export const policyCheck = (policy, expected = STEP30_EXPECTED) => {
  const got = normalizedBindings(policy);
  const conditional = got.filter(b => b.condition).map(b => b.role);
  const same = conditional.length === 0 && JSON.stringify(got) === JSON.stringify(expected);
  return { expected, got, conditional, same };
};

export const STEP30_EDIT = Object.freeze({
  removeMembers: ["projectEditor:graffiticode", "projectViewer:graffiticode"],
  grants: [
    { role: "roles/storage.objectUser", member: "serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com" },
    { role: "roles/storage.legacyObjectReader", member: "allUsers" },
  ],
});
export const STEP30_EXPECTED = Object.freeze([
  { role: "roles/storage.legacyBucketOwner", members: ["projectOwner:graffiticode"] },
  { role: "roles/storage.legacyObjectOwner", members: ["projectOwner:graffiticode"] },
  { role: "roles/storage.legacyObjectReader", members: ["allUsers"] },
  { role: "roles/storage.objectUser", members: ["serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com"] },
]);

// ---------------------------------------------------------------- manifests

// A manifest is created once and never overwritten: exclusive creation
// ("wx"), so a concurrent writer that creates the name first wins and this
// write fails, whatever was checked before (no check-then-write window).
export const writeManifestOnce = (file, value, { writeFileSync = fsWriteFileSync } = {}) => {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if (e?.code === "EEXIST") throw new Error(`${file} exists; manifests are never overwritten`);
    throw e;
  }
  return file;
};
