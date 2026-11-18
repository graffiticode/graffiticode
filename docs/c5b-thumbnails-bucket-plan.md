# C5b: the thumbnails bucket

**Status:** draft for review (2026-11-18). This details C5b of [`docs/c5-l0013-commands-plan.md`](c5-l0013-commands-plan.md) ("§4 C5b–C5e, in outline", and decision 8). C5a is complete: its gate passed 20/20 (`docs/evidence/c5a-authorization/`), and the gate's api and bucket are retired.

**What C5b does.** It prepares the production destination for L0013 captures. Nothing reads or writes it yet.
1. It creates `gs://graffiticode-thumbnails`, publicly readable.
2. It grants `broker-run` the publishing role there, and verifies it live as `broker-run`.
3. It copies today's thumbnails into it, under decision 8's create-only rule, recording each source generation.
4. It switches Broker's `THUMBNAIL_BUCKET` to it.

**What C5b leaves alone:**
- **Production admits no v3 capture command.** It has no `COMMANDS_L0013` or `COMMAND_SCOPES`, so nothing publishes to the new bucket until C5d.
- **`l0013r` keeps uploading** directly to `graffiticode.appspot.com/thumbnails/`, as today, until C5d step 2.
- **The console keeps reading the old bucket.** Its base URL changes only at C5d step 5.
- **No compiler account gets any role** on the new bucket, ever (C5c).

Each live step is an IAM review step, applied only with the owner's approval: Step 30 for the bucket and grants, Step 31 for Broker's switch. The migration copy is approved separately.

## 1. Where we start (read 2026-11-18)

- **The old thumbnails** are `gs://graffiticode.appspot.com/thumbnails/{item}.png`.
  - **Contents:** 33 objects, 3.5 MB, all `image/png` with `Cache-Control: no-cache`. The names are flat, with no nesting. They were last updated 2026-06-02 to 2026-11-15.
  - **The bucket:** a `US` multi-region with fine-grained ACLs and 7-day soft delete. Each object is public through `predefinedAcl=publicRead`, but the bucket can't be listed anonymously.
- **Who writes them:** `l0013r` as `l0013r-run`, which holds `objectAdmin` on that bucket (C5c removes it).
- **Who reads them:** the console, through the app's `hosts.thumbnails`. It defaults to `BUILT_IN_THUMBNAILS = https://storage.googleapis.com/graffiticode.appspot.com/thumbnails` (graffiticode-app `packages/core/src/profile/public-config-server.ts:32`). No other consumer exists in either repo.
- **Broker's thumbnail bucket:**
  - `THUMBNAIL_BUCKET=graffiticode-c5a-gate` (`deploy.json` broker env). That bucket was deleted after the gate, and nothing publishes there.
  - Broker refuses `graffiticode.appspot.com` as a thumbnail bucket (`packages/broker/src/gcs.ts:83,206`).
  - It publishes `{item}.png` at the bucket root. Its result URL is `https://storage.googleapis.com/<bucket>/{item}.png?v=<sha>` (`gcs.ts:135`).
  - An object without `captureSequence` reads as sequence 0, so any capture replaces it (`gcs.spec.ts` "replaces an object with no sequence, as the migration copy leaves").
- **The staging bucket** `graffiticode-command-staging` exists, from Step 28, and is unchanged by C5b.
- **Org policy** doesn't block a public bucket. `iam.allowedPolicyMemberDomains` allows all, and `storage.publicAccessPrevention` isn't enforced for the project.

## 2. Decisions for the owner

### 1. Public read without listing (a correction to decision 8)

Decision 8 grants `allUsers: roles/storage.objectViewer`. That role includes **`storage.objects.list`**, so anyone could list the bucket and enumerate every item id that has a thumbnail, private items included. Today the objects are each public, but the bucket can't be listed.

**Recommended:** grant `allUsers` the role **`roles/storage.legacyObjectReader`** instead. It grants `storage.objects.get` only, which keeps today's exposure: a known URL is readable, and the bucket can't be enumerated ([Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)). Verification checks both: an anonymous object GET answers 200, and an anonymous list answers 401 or 403.

*Out of scope, but worth stating:* a private item's thumbnail is publicly readable by URL, today and after C5b. Changing that is a separate decision.

### 2. Location: `US` multi-region (recommended)

- **Why:** the old bucket is `US` multi-region, and the thumbnails are served to browsers. Keeping the same location type keeps availability and latency as they are.
- **The cost:** Broker, in `us-central1`, writes cross-region within the US. For a few KB per capture, that's negligible.
- **The alternative:** `us-central1` beside Broker, as the gate and staging buckets were. It saves nothing that matters, and serving gets less redundant.

### 3. Settings

| Setting | Value | Why |
|---|---|---|
| Uniform bucket-level access | on | no ACLs (decision 8); public read is one IAM binding |
| Public access prevention | `inherited` (not enforced) | public read needs it off for this bucket |
| Versioning | off | the generation precondition is the protocol; a noncurrent version adds nothing |
| Soft delete | 7 days | recover an accidental deletion, as for the old bucket and staging |
| Lifecycle | none | thumbnails are permanent |
| Storage class | `STANDARD` | |

### 4. The bucket's other bindings, reduced at creation (as in Step 28)

- **Creation adds four bindings:** `legacyBucketOwner`, `legacyObjectOwner`, `legacyBucketReader` and `legacyObjectReader`, for `projectOwner`, `projectEditor` and `projectViewer`.
- **Recommended:** keep `projectOwner`'s two, and remove `projectEditor` and `projectViewer` from all four, as was done for the gate and staging buckets.
- **The bindings that remain:**
  - `projectOwner:graffiticode`: `legacyBucketOwner`, `legacyObjectOwner`;
  - `serviceAccount:broker-run@…`: `objectUser`;
  - `allUsers`: `legacyObjectReader` (decision 1).

### 5. Who copies: the operator, server-side (recommended)

- **How:** the migration copy runs once with the operator's own credentials. The operator is a project owner, so `legacyObjectOwner` already covers it, and nothing is granted for the copy.
- **Each object** is a server-side `objects.rewrite`:
  - `ifSourceGenerationMatch` is the generation recorded in the plan, so it copies exactly that version or fails;
  - `ifGenerationMatch=0`, so it creates a name and never replaces one.

  The bytes never leave Google.
- **The alternative,** a one-off job as a dedicated copier identity with a time-limited grant, adds a grant and a teardown to buy nothing that the preconditions and manifest don't already give.

### 6. What a migrated object carries

| Field | Value |
|---|---|
| Name | `{item}.png` (the bucket root, where Broker publishes) |
| `Content-Type` | `image/png` |
| `Cache-Control` | `no-cache` (as Broker writes) |
| Custom metadata | `migratedFrom: thumbnails/{item}.png`, `sourceGeneration: <g>`; **no `captureSequence`** (reads as 0, so the first capture replaces it) |

## 3. Slices

### Slice 1: tooling and review (one PR, no live effect)

1. **`scripts/c5b/migrate-thumbnails.js`,** with pure parts in `scripts/lib/c5b-migration.js` and offline tests over a fake storage API.
   - **`--phase plan`, read-only:** lists `gs://graffiticode.appspot.com/thumbnails/*.png` through every page. It writes `plan-1.json` (an amended plan is `plan-<n+1>.json`; see copy), giving for each object its source name, generation, size, `md5Hash`, `crc32c`, `contentType`, `updated` and destination name.
     - It refuses names that aren't `thumbnails/{id}.png`, with the item-id pattern Broker uses.
     - It refuses a destination name that appears twice.
   - **`--phase copy`, the only write:** it reads the current plan (`plan-<n>.json`) and copies its entries in order, one object at a time.
     - **One rewrite, to completion** ([objects.rewrite](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/rewrite)). The request carries both preconditions and the fixed destination metadata.
       - **HTTP 200 alone doesn't mean the copy finished.** The answer says `done`.
       - While `done` is `false`, the same request is repeated with the answer's `rewriteToken`, keeping the same preconditions, until `done` is `true`.
       - Only then, with the answer's `resource` in hand, does it read the destination's metadata (`generation`, `crc32c`, `md5Hash`, `size`, `contentType`, `cacheControl`, custom metadata). The entry is recorded `created` only if those match the plan entry and the planned metadata.
       - Today's source and destination are both `US` multi-region `STANDARD`, so Google can copy by metadata and normally answers `done: true` at once. The tool never assumes it.
     - **Interruption and recovery:**
       - **A process that dies mid-rewrite loses its token.** The copy is simply run again. A destination that was never completed doesn't exist, so the preconditions let the copy start over.
       - **A token Google refuses** (expired, or the request changed) restarts that object's rewrite from the beginning, under the same preconditions.
       - **A destination that already exists** (412 on `ifGenerationMatch=0`) is read, never written. It's recorded `adopted` if its bytes (`crc32c`, `md5Hash`, `size`) and metadata match the plan entry, which is what an earlier interrupted run leaves. Otherwise it's `exists-differs`.
     - **A source that changed since the plan** (412 on `ifSourceGenerationMatch`) is `source-changed`.
     - **Stopping:** the run stops at the first `source-changed`, `exists-differs` or `failed` entry, and creates nothing after it.
       - For `exists-differs` and `failed`, the run is reported and needs the owner's decision.
       - For `source-changed`, the operator prepares an **amended plan**, `plan-<n+1>.json`. It is the previous plan with only the changed, not-yet-copied entries re-read: their new generation, bytes and metadata. Entries already `created` or `adopted` keep their original records.
       - The amended plan is reviewed, then the copy is rerun against it. Every earlier manifest (`plan-<n>.json`, `copy-<n>.json`) is kept unchanged.
     - **Transient answers:** 429 and 5xx are retried with backoff. Each attempt is the same request with the same preconditions.
     - **Output:** `copy-<n>.json` records each entry's outcome, the rewrite calls it took, and the destination's generation and digests.
   - **`--phase verify`, read-only,** against the final plan (the one the completed copy ran). It passes only if every entry was `created` or `adopted`; a `source-changed`, `exists-differs` or `failed` entry means the copy isn't finished, so verify fails.
     - **For every plan entry, the destination object:** exists; has the source's `crc32c`, `md5Hash` and size; has `contentType` `image/png` and `Cache-Control` `no-cache`; carries `sourceGeneration` equal to the plan's; and has no `captureSequence`.
     - **Anonymously,** with no credentials: each object's public URL answers 200 with the same bytes, by `crc32c`, and listing the bucket is refused.
     - **The old bucket since the copy:** any source updated after its entry was copied is listed, with both generations, for C5d's catch-up. This isn't a failure: the copy is exactly the planned version, and the catch-up's generation precondition brings over the newer one.
     - It writes `verify.json`.
   - **Tests** (a fake storage API):
     - the plan's name checks;
     - `done: false` answers continued with their `rewriteToken` until `done: true`, and `created` recorded only after the destination's metadata matches;
     - a 200 with `done: false` and no later call is never `created`;
     - interruption: the process dies mid-rewrite, the token is lost, and the rerun completes it; and a refused token restarts the object;
     - a rerun after a partial copy, with earlier destinations `adopted`;
     - a source changing between plan and copy: the run stops, an amended plan updates only that entry, earlier manifests are untouched, and the rerun completes;
     - a destination that already exists with other bytes, which is `exists-differs`, stops the run and is never replaced;
     - the backoff;
     - every verify failure, including a plan with an unfinished entry;
     - that no rewrite request is sent without both preconditions.
2. **The probe, extended** (`scripts/c5a/bucket-probe.js`, or a `scripts/c5b/` copy). It runs as the identity under test and prints only status codes. Probe objects live under `c5b-probe/<run>/`.

   | As | Check | Expect |
   |---|---|---|
   | `broker-run` | create `a.png` with `ifGenerationMatch=0` | 200 |
   | | metadata `fields=generation,metadata` | 200 |
   | | overwrite `a.png` with a stale generation | 412 |
   | | overwrite `a.png` with the current generation | 200 (`objectUser` deletes) |
   | | create `b.png`, then delete it | 200, then 204 |
   | | staging bucket create | 403 (unchanged) |
   | `policy-run` | create on the thumbnails bucket | 403 |
   | `l0013r-run` | create on the thumbnails bucket | 403 |
   | anonymous | GET `a.png` (still in place) | 200 |
   | anonymous | GET `b.png` (deleted) | 404 |
   | anonymous | list the bucket (JSON API, and the XML endpoint) | 401 or 403 (decision 1) |

   - **`a.png` stays in place** through every job and anonymous check.
   - **Then the operator removes it explicitly,** `gcloud storage rm gs://graffiticode-thumbnails/c5b-probe/<run>/a.png`, and lists the bucket to confirm it's empty.
   - **Results** go to the evidence before the jobs are deleted.

3. **IAM review text for Steps 30 and 31:** the exact commands, the expected read-back and the probes, as Step 28 has them. It also corrects Step 29's heading, which says "PROPOSED; held" though it ran.
4. **This plan, amended by the owner's decisions,** and decision 8's role corrected in the C5 plan if decision 1 is accepted.

### Slice 2: the bucket and its grants (Step 30, live, with approval)

```bash
gcloud storage buckets create gs://graffiticode-thumbnails --project=graffiticode \
  --location=US --default-storage-class=STANDARD \
  --uniform-bucket-level-access --no-public-access-prevention \
  --soft-delete-duration=7d

# Bindings: one etag-protected read/modify/write, as Step 28 had to do.
# remove-iam-policy-binding doesn't match the convenience members ("binding … not found").
gcloud storage buckets get-iam-policy gs://graffiticode-thumbnails --format=json > policy-at-creation.json
jq '
  .bindings |= map(.members |= map(select(. != "projectEditor:graffiticode" and . != "projectViewer:graffiticode")))
  | .bindings |= map(select(.members | length > 0))
  | .bindings += [
      {"role": "roles/storage.objectUser", "members": ["serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com"]},
      {"role": "roles/storage.legacyObjectReader", "members": ["allUsers"]}
    ]' policy-at-creation.json > policy-intended.json   # keeps the read etag
gcloud storage buckets set-iam-policy gs://graffiticode-thumbnails policy-intended.json
# A concurrent change makes the etag stale; set-iam-policy then fails, and the step restarts from the read.

# Exact read-back: the bindings, sorted, equal the expected set and nothing else.
gcloud storage buckets get-iam-policy gs://graffiticode-thumbnails --format=json \
  | jq -S '[.bindings[] | {role, members: (.members | sort)}] | sort_by(.role)' > policy-after.json
diff policy-after.json expected-bindings.json   # expected-bindings.json: decision 4's set
```

- **The evidence keeps all three policies** (at creation, intended, after) and the diff, which must be empty.
- **The only changes from creation's policy:** the removal of `projectEditor` and `projectViewer`, and the two added bindings. `allUsers` appears nowhere else.

**Verification:**
1. **Settings, read back:** `US`, `STANDARD`, uniform `true`, public access prevention `inherited`, versioning off, soft delete `604800`, lifecycle `null`.
2. **IAM, read back:** exactly the bindings in decision 4, by the sorted diff above, which must be empty.
3. **Behaviour:** the probe jobs, in the order `broker-run`, `policy-run`, `l0013r-run`, then the anonymous checks while `a.png` is still in place (slice 1's table). Each job is a one-off Cloud Run job, created with approval and deleted after its results are recorded, as Step 28's were.
4. **Cleanup, then empty:** after the anonymous checks, the operator removes `c5b-probe/<run>/a.png` explicitly, and the bucket then lists no objects.

**Rollback:** delete the bucket, which is empty and read by nothing.

### Slice 3: the migration copy (live, with approval)

1. `--phase plan` writes `plan-1.json`, which is reviewed: today 33 objects.
2. `--phase copy`. **Expect** every entry `created`. A `source-changed` stops the run: the operator prepares the amended plan (slice 1), it's reviewed, and the copy is rerun against it. `exists-differs` or `failed` stops it for the owner's decision. Every plan and copy manifest is kept.
3. `--phase verify`. **Expect** no problems.

**Evidence** in `docs/evidence/c5b/`: every `plan-<n>.json` and `copy-<n>.json`, `verify.json`, and each run's output.
- **C5d's catch-up** (plan §4, step 4) uses the final plan's recorded source generations, with each entry's destination generation from the copy manifests. It copies each name the old bucket updated after the plan, with `ifGenerationMatch` set to what this copy created, or `0` if it found none.
- **Between this copy and C5d,** the console still reads the old bucket. The new bucket's copies only go stale. They are never wrong, since any capture replaces them.

**Rollback:** delete the migrated objects. Nothing reads the bucket yet, and the copy can simply be run again.

### Slice 4: Broker's switch (Step 31, a release, with approval)

1. **`deploy.json`:** set broker `THUMBNAIL_BUCKET` to `graffiticode-thumbnails`, which is its only change, in a reviewed PR.
2. **Release Broker from the merge commit** with the deploy CLI.
   - The `C5a-scopes` floor and `contractMinimum` are unaffected.
   - Broker's startup check refuses only the forbidden names: a thumbnail bucket equal to the staging bucket, or `graffiticode.appspot.com`. It doesn't catch any other typo, and it doesn't check that the bucket exists. The reviewed `deploy.json` diff and the read-back below are what confirm the value.

**Verification:**
- **The release:** the serving revision's environment shows the new bucket (read back); `release-check` passes; the receipt names the merge commit.
- **The production canary** passes 36/36, so L0176 is unchanged.
- **Before anything publishes:** production still has no `COMMANDS_L0013` or `COMMAND_SCOPES`, so no capture can reach Broker yet. Broker's live publish path to this bucket is first exercised in C5d's staged drive, on drive fixtures, before activation. Slice 2's `broker-run` probe has already shown the same API calls succeed there.

**Rollback:** by **Step 31's own release id**, the receipt of the release that switched the bucket.
- **The command:** `npm run rollback -- broker --env production --release <Step 31 release id>`. It restores the traffic that preceded that release.
- **Why not the previous receipt:** it would be refused, since the CLI checks that the named release owns current traffic.
- **Before promotion is considered done:** `npm run rollback -- broker --env production --release <Step 31 release id> --plan` is run. Its expected target, the revision serving before Step 31 (today `broker-rmwkzsw86-98e2cf`), goes into Step 31's evidence.
- **What the target names:** that revision has `THUMBNAIL_BUCKET=graffiticode-c5a-gate`, which no longer exists. That's harmless while production admits no capture: a publish there would fail, and nothing publishes.
- **If C5d has started,** roll forward instead, with a config release.

## 4. Order and dependencies

```
slice 1 (PR, review) → slice 2 (Step 30) → slice 3 (copy) → slice 4 (Step 31)
                                                          ↘ C5d staged drive → C5d activation 1–5 (console switch at 5)
```

- **Slice 3 needs slice 2,** since it must have the bucket and its public read.
- **Slice 4 is independent of slice 3,** because nothing publishes until C5d. It is ordered after the copy so that the first capture Broker publishes in production can never meet a missing name that the copy then fails to create.
- **The console's switch** belongs to C5d step 5. It is graffiticode-app's `BUILT_IN_THUMBNAILS` (or `hosts.thumbnails`), to `https://storage.googleapis.com/graffiticode-thumbnails`, after direct uploads are disabled, drained and caught up.

## 5. Completion gate for C5b

- **The bucket:** its settings and IAM read back as in slice 2; the probe results are all as expected; anonymous object reads succeed and anonymous listing is refused.
- **The copy:** verify passes against the final plan: every entry is `created` or `adopted`, with identical bytes, the planned metadata and no `captureSequence`. Sources updated after their copy are listed for C5d.
- **Broker:** its serving revision names `graffiticode-thumbnails`; `release-check` passes; the production canary passes 36/36.
- **Production unchanged:** no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`. `l0013r` still writes only the old bucket, and the console still reads it.
- **Evidence** is in `docs/evidence/c5b/`.

## 6. Risks

- **Public listing:** decision 1 removes it. If `objectViewer` is kept instead, every thumbnail's item id becomes listable.
- **Stale copies:** an old-bucket upload during the copy stops it, and an amended plan copies the new version. An upload after an entry's copy makes that copy stale. Verify lists it, and C5d's catch-up brings it over through the recorded generations. The console doesn't read the new bucket before C5d step 5.
- **A capture before the copy:** none can happen, because production publishes nothing until C5d. If one did, the copy's `ifGenerationMatch=0` would leave the newer capture in place and report the name as `exists`.
- **Broker's rollback target names a deleted bucket:** this is safe only while production admits no capture (slice 4).
- **Cost:** 3.5 MB of storage, and egress only for public reads, which the old bucket already pays.

## 7. Out of scope

- The console's base URL (C5d step 5).
- Disabling direct uploads, draining and catch-up (C5d).
- Removing `objectAdmin` from `l0013-run` and `l0013r-run` (C5c).
- Deleting old thumbnails from `graffiticode.appspot.com`.
- Private thumbnails.
