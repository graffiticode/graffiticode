// C5b's thumbnails migration and bucket policy (docs/c5b-thumbnails-bucket-plan.md),
// as pure functions over an injected storage API, so every rule is tested
// offline (scripts/test/c5b-thumbnails.test.js). The CLI is
// scripts/c5b/migrate-thumbnails.js; the policy edit's is scripts/c5b/bucket-policy.js.
//
// Storage API (the JSON API, injected):
//   rewrite({ sourceBucket, source, sourceGeneration, bucket, name, metadata, rewriteToken })
//     -> { status, body }   one objects.rewrite call with ifSourceGenerationMatch and
//                           ifGenerationMatch=0; body { done, rewriteToken, resource } on 200
//   get(bucket, name) -> { status, body }   the object's metadata, or 404
//
// Plan entry: { item, source, sourceGeneration, size, md5Hash, crc32c, contentType, updated, destination }
// Copy outcomes: created | adopted | source-changed | exists-differs | failed

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

// One plan entry, to completion. A rewrite that answers 200 with done: false
// is continued with its rewriteToken; only done: true, then the destination's
// own metadata matching the plan, is `created`. A refused token (400 or 404 on
// a continued call) restarts the rewrite under the same preconditions. A 412 is
// told apart by reading the destination: absent means the source changed; a
// matching object is `adopted` (an earlier, interrupted run finished it); any
// other is `exists-differs`, never replaced.
export const copyEntry = async ({ entry, storage, sleep = async () => {}, maxRewriteCalls = MAX_REWRITE_CALLS }) => {
  const request = { sourceBucket: SOURCE_BUCKET, source: entry.source, sourceGeneration: entry.sourceGeneration, bucket: DESTINATION_BUCKET, name: entry.destination, metadata: destinationMetadata(entry) };
  const record = { destination: entry.destination, calls: 0, restarts: 0 };
  let rewriteToken = null;
  let resource = null;
  for (;;) {
    if (record.calls >= maxRewriteCalls) return { ...record, outcome: "failed", reason: `no done: true after ${record.calls} rewrite calls` };
    const res = await withBackoff(() => storage.rewrite({ ...request, rewriteToken }), { sleep });
    record.calls++;
    if (res.status === 200) {
      if (res.body?.done === true && res.body.resource) {
        resource = res.body.resource;
        break;
      }
      if (!res.body?.rewriteToken) return { ...record, outcome: "failed", reason: "done: false without a rewriteToken" };
      rewriteToken = res.body.rewriteToken;
      continue;
    }
    if (rewriteToken && (res.status === 400 || res.status === 404)) {
      rewriteToken = null;
      record.restarts++;
      continue;
    }
    if (res.status === 412) {
      const dest = await withBackoff(() => storage.get(DESTINATION_BUCKET, entry.destination), { sleep });
      if (dest.status === 404) return { ...record, outcome: "source-changed" };
      if (dest.status !== 200) return { ...record, outcome: "failed", reason: `destination read ${dest.status}` };
      const problem = destinationProblem(dest.body, entry);
      return problem ? { ...record, outcome: "exists-differs", reason: problem, generation: dest.body.generation } : { ...record, outcome: "adopted", generation: dest.body.generation };
    }
    return { ...record, outcome: "failed", reason: `rewrite ${res.status}` };
  }
  const dest = await withBackoff(() => storage.get(DESTINATION_BUCKET, entry.destination), { sleep });
  if (dest.status !== 200) return { ...record, outcome: "failed", reason: `destination read ${dest.status} after done` };
  const problem = destinationProblem(dest.body, entry);
  if (problem) return { ...record, outcome: "failed", reason: `after done: ${problem}` };
  if (String(dest.body.generation) !== String(resource.generation)) return { ...record, outcome: "failed", reason: `generation ${dest.body.generation}, rewrite answered ${resource.generation}` };
  return { ...record, outcome: "created", generation: dest.body.generation };
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
  const problems = [];
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
// The comparable form of a policy's bindings, for the exact read-back.
export const normalizedBindings = policy => (policy.bindings ?? []).map(b => ({ role: b.role, members: [...new Set(b.members)].sort() })).sort((a, b) => (a.role < b.role ? -1 : 1));

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
