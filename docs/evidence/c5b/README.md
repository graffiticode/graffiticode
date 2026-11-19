# C5b: the thumbnails bucket, evidence

Plan: [`docs/c5b-thumbnails-bucket-plan.md`](../../c5b-thumbnails-bucket-plan.md). IAM review: Step 30 (applied) and Step 31 (held).

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

## The migration copy (`migration/`), planned, held

- **`plan-1.json`** was made read-only (`--phase plan`) on 2026-11-19, from main `076f6936`. It has 33 entries totalling 3,535,395 bytes, all `image/png`, with 33 distinct destinations and no problems (`plan-1.output.txt`).
- **Its sources are the old bucket as the C5a gate left it.** The names and generations, hashed in the gate's format, give `6e32da1b…`. That equals `r36074e`'s appspot digest, both at its baseline and after it.
- **Held:** `--phase copy`, then `verify`, are held for the owner's approval. Any amended plan and every copy and verify manifest will be added here, none overwritten.
