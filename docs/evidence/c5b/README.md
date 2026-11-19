# C5b: the thumbnails bucket, evidence

**C5b is complete (2026-11-19).** The bucket and its IAM (Step 30), the migration copy, and Broker's switch (Step 31) are all live and verified. Production activation remains held (C5d).

Plan: [`docs/c5b-thumbnails-bucket-plan.md`](../../c5b-thumbnails-bucket-plan.md). IAM review: Step 30 and Step 31, both applied.

## Step 30: `gs://graffiticode-thumbnails` (`step30/`), applied 2026-11-19

The work ran from clean main `02c85d4f`, with owner approval at each stage: first the bucket and IAM, then the probes.

- **Pre-check:** the bucket answered 404 (`precheck.txt`).
- **Created** at 01:04:57Z (`create.log`). The settings read back (`settings.json`, `settings-summary.json`) are `US` multi-region, `STANDARD`, uniform access, public access prevention `inherited`, no versioning, soft delete 604800 s, and no lifecycle rule.
- **IAM,** set by one etag-protected read/modify/write with `scripts/c5b/bucket-policy.js`:
  - **At creation** (`policy-at-creation.json`, etag `CAE=`): the four convenience bindings.
  - **Intended** (`policy-intended.json`): `check` reported `same: true` before writing.
  - **Written** under `CAE=` (`set-iam-result.json`).
  - **After** (`policy-after.json`, etag `CAI=`): `check.json` reports `same: true` and `conditional: []`. The bindings are exactly:
    - `legacyBucketOwner` and `legacyObjectOwner`: `projectOwner:graffiticode`;
    - `legacyObjectReader`: `allUsers`;
    - `objectUser`: `serviceAccount:broker-run@…`.

    None is conditional, and no compiler account has a role.
- **Probes,** under run label `r11190108` (`run.txt`), running `scripts/c5b/bucket-probe.js` (sha256 in `probe-script.sha256`) on `node:22.23.3@sha256:363e1587…` in one-off jobs, in order:

  | Probe | Execution | Result |
  |---|---|---|
  | `broker-run` (`probe-broker.json`) | `c5b-bucket-probe-broker-l5md2` | `a-create` 200, `a-metadata` 200, `a-stale` 412, `a-overwrite` 200, `b-create` 200, `b-delete` 204, `staging-create` 403 |
  | `policy-run` (`probe-policy.json`) | `c5b-bucket-probe-policy-jnhmt` | `create` 403 |
  | `l0013r-run` (`probe-l0013r.json`) | `c5b-bucket-probe-l0013r-tv8h9` | `create` 403 |
  | anonymous, no credentials (`probe-anonymous.json`) | the operator's machine, with `a.png` still in place | `a-read` 200, `b-read` 404, `list-json` 401, `list-xml` 403 |

- **Cleanup** (`cleanup.log`, `after-cleanup.json`):
  - The operator removed `a.png` explicitly. The bucket then had 0 objects, counting all versions, and the staging bucket had no probe objects.
  - The three jobs were deleted.
  - **A soft-deleted count of 8 in `cleanup.log` is a miscount.** The correct count is 3, which `cleanup.log.annotation.md` explains with the raw inventory (`soft-deleted-inventory.txt` and `.json`, read at `soft-deleted-inventory-at.txt`). The log itself is unchanged.
  - **An anonymous 200 for the deleted `a.png`** came from Google's edge cache. The probe set no `Cache-Control`, so the public default `max-age=3600` applied. The bucket itself answered 404. Broker's publish and the migration copy both write `Cache-Control: no-cache`.

## The migration copy (`migration/`), done 2026-11-19

- **`plan-1.json`** was made read-only (`--phase plan`) on 2026-11-19, from main `076f6936`. It has 33 entries totalling 3,535,395 bytes, all `image/png`, with 33 distinct destinations and no problems (`plan-1.output.txt`).
- **Its sources are the old bucket as the C5a gate left it.** The names and generations, hashed in the gate's format, give `6e32da1b…`. That equals `r36074e`'s appspot digest, both at its baseline and after it.
- **Copy (owner-approved),** from main `d5d572b5`, ran against the committed `plan-1.json` (sha256 `831364d6…`) between 15:51:25Z and 15:51:37Z.
  - **Result:** all 33 entries `created`. Each took one rewrite call answering `done: true`, with no token restarts, no `source-changed`, no `exists-differs` and no failure.
  - **Files:** `copy-1-2026-11-19T15-51-37-431Z.json` and `copy-1.output.txt`.
  - **No amended plan was needed.**
- **Verify** passed with no problems against plan 1 (`verify-1-2026-11-19T15-52-01-595Z.json`, `verify-1.output.txt`):
  - every entry `created`;
  - every destination matching its plan entry in bytes (`crc32c`, `md5Hash`, size), `image/png`, `no-cache`, `migratedFrom` and `sourceGeneration`, with no `captureSequence`;
  - every object readable anonymously with the planned MD5;
  - anonymous listing refused (JSON 401, XML 403);
  - no source updated since its copy.
- **An independent read-back** (outside the tool) agreed: 33 objects, 3,535,395 bytes, all at the bucket root, all `image/png` with `Cache-Control: no-cache`, none carrying `captureSequence`.
- **For C5d's catch-up:** each source's generation is in `plan-1.json`, and each destination's generation is in the copy manifest.

## Step 31: Broker's thumbnail bucket (`step31/`), released 2026-11-19

- **Released:** `broker-rmwnqz13k-c374b1`, from the merge commit `86e8e4ed` (#433). Its only change is `THUMBNAIL_BUCKET`, from `graffiticode-c5a-gate` to `graffiticode-thumbnails` (`receipt-rmwnqz13k-c374b1.json`, `release.log`).
- **Before** (`before.json`): `broker-rmwkzsw86-98e2cf` served at 100%, with `THUMBNAIL_BUCKET=graffiticode-c5a-gate`.
- **Read back** (`readback.json`, `revision-readback.txt`): 100% traffic; `THUMBNAIL_BUCKET=graffiticode-thumbnails`, with the staging bucket and `BROKER_MIN_CONTRACT_VERSION=2` unchanged; the revision is Ready, with commit label `86e8e4ed`.
- **`release-check`** (`release-check.txt`): `broker: ok`.
- **Rollback plan,** by this release's own id (`rollback-plan.txt`): it restores `broker-rmwkzsw86-98e2cf` at 100%. That revision names the deleted gate bucket, which is harmless only while production admits no capture.
- **Production canary** (`canary-*.txt`): `canary-bpd85` passed 36/36.
- **Production** (`production-flags.json`): the api is `api-rmwkxlbvy-b5fa92`, with no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`, and `COMPILE_GENERATION_L0013=rust-1`. The thumbnails bucket holds the 33 migrated objects (`bucket-after.txt`).
- **The service description** is committed only as `service-after.redacted.json`. Its creator annotation's operator email is replaced, and `REDACTIONS.txt` records the original's sha256.
- **Summary:** `summary.json`.
