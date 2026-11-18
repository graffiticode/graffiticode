# C5a authorization: the live gate's evidence

Plan: [`docs/c5-l0013-commands-plan.md`](../../c5-l0013-commands-plan.md), "C5a completion gate". Release evidence: [`../c5a/`](../c5a/README.md).

**The gate passed 20 of 20 checks** on run `r36074e` (run id `efb34d9b`), on 2026-11-18. The owner accepted it, independently re-judged the saved observations and reproduced the stored verdict.
- That run's first judgment was **17 of 20**, from two measurement defects in the runner's after phase. #423 corrected them, and `after` and `judge` were then rerun read-only. No capture was repeated.
- An earlier run, `r381d64`, stopped at its captures phase.

Both earlier results are kept here unchanged, with their original file and directory names. (`preserved-18of21/` is named from an earlier miscount: its report records 17 of 20.)

`node docs/evidence/c5a-authorization/verify.mjs` checks every file against `MANIFEST.sha256`, re-judges the final report's observations (20/20), confirms the earlier report's 17/20, and re-compares the exact-time approval inventories.

## What ran, and in what order

| When (UTC, 2026-11-18) | What | Result |
|---|---|---|
| 03:57 | `canary-window-c5a` applied (OpenIdTokenCreator for the operator on `console-run` and `api-run`), expiring 2026-11-19T03:57:32Z | |
| 04:03–04:22 | **r381d64**: baseline, edge P1/E1/E2, E3/E4, captures | stopped: private captures showed "failed to post compile"; the non-owner was refused by the api's task ACL (404) before Policy; the quota audit was read before ingestion; a 13th anonymous command was left pending (later retired) |
| 15:30 | r381d64 follow-ups: 13th command retired; non-owner retry refused `not-owner` at admission; quota recollected (12 allowed, then refused) | see `r381d64/` |
| 17:44–19:22 | The render fix released: `@graffiticode/l0000-view@0.5.1`, `@graffiticode/l0179-view@0.4.4`, `l0179r-rmwmgl5h5-c576b4`, `l0013r-rmwmhjmoi-17a112` | production canaries `canary-jqqh6` and `canary-qvw98`: 36/36 |
| 19:45 | **r36074e** L0176 check: B6 repair round-trip `4fe391` against production `api-rmwkxlbvy-b5fa92` | recorded 9/11. The owner accepted it as a timing variant; 11/11 under the revised verdict (#421) |
| 20:39 | v8 artifact view read through today's api | served unchanged; preview signing only, no dispatch |
| 21:45–21:54 | **r36074e** gate: P1 → baseline → E1/E2 (A1, A1′, A2) → E4 watcher → captures → due → cleanup → after → judge | 17/20 (measurement defects only) |
| 22:09 | Approval inventory read from Firestore history at exactly the baseline, 21:45:33.773Z | 42 records, identical to the current inventory |
| 22:32 | `after` (with `--approvals-at-baseline`) and `judge` rerun from main `7d11ca73` | **20/20, GATE PASSED** |

## Releases and flags at the gate (`r36074e/releases/serving.json`, read after the pass)

| Service | Serving revision | Commit |
|---|---|---|
| api (production) | `api-rmwkxlbvy-b5fa92` | `3b6b4a50` |
| api-c5a-gate (private) | `api-c5a-gate-rmwlgsr21-0a71e4` | `43c09964` |
| policy | `policy-rmwl4or99-166557` | `f6132821` |
| broker | `broker-rmwkzsw86-98e2cf` | `58adb430` |
| l0013r (pinnable, approved `[3]`) | `l0013r-rmwmhjmoi-17a112` | `6124cf96` |
| l0176r (approved `[1, 2]`) | `l0176r-rmwk08k8n-c74227` | `6918feca` |
| l0179r | `l0179r-rmwmgl5h5-c576b4` | `6124cf96` |
| l0000r (approved `[1, 2]`) | `l0000r-rmw8gtkc2-830693` | |
| l0185r | `l0185r-rmwczv08x-e43ac0` | `7d6a74cf` |

**Production flags: C5a is not active in production.**
- The production api has no `COMMANDS_L0013`, no `COMMAND_SCOPES` and no `INTERPRETER_L0013`. It keeps `COMPILE_GENERATION_L0013=rust-1`, with `COMMANDS_L0176` and `REPAIR_L0176` on, as before.
- Only `api-c5a-gate` carries `COMMANDS_L0013=on`, `COMMAND_SCOPES=on` and `COMPILE_GENERATION_L0013=c5a-gate-1`.
- Broker publishes to `graffiticode-c5a-gate` (`THUMBNAIL_BUCKET`). l0013r's legacy uploader still names `graffiticode.appspot.com`, whose `thumbnails/` listing the gate showed unchanged.

**Held:** production activation and any window extension.

## Retirement (2026-11-18, after this evidence merged as `b12f5a3e`)

The record is in `retirement/`. `verification.json` holds the results, the other files are a read-only snapshot taken before deletion, and `REDACTIONS.txt` records one redacted email.
1. **Nothing left to archive.**
   - Every file of the local gate directory is here.
   - The gate bucket held two current objects and no older versions: the private item at generation `1795038439870721` (`c:34f2972f…`, sequence 6) and the public item at `1795038553049259` (`c:a9fbbf7a…`, sequence 24). Both match `r36074e/images/mixed-1795038439870721.png` and `public-1795038553049259.png` byte for byte.
   - The gate api's release receipt (`rmwlgsr21-0a71e4`) is added to `retirement/`.
2. **Deleted:**
   - `api-c5a-gate` at 22:59:51Z, with its revisions and invokers;
   - `gs://graffiticode-c5a-gate` at 23:00:02Z, with its two objects.

   Both answer not found afterwards. The `deploy.json` entry is removed.
3. **Production:**
   - canary `canary-9jqm2` passed 36/36;
   - the production api (`api-rmwkxlbvy-b5fa92`) still has no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`, with `COMPILE_GENERATION_L0013=rust-1`.
4. **Kept:** `graffiticode-command-staging`, and the permanent C5a IAM and proxy configuration.
5. **Still to note:**
   - Broker's `THUMBNAIL_BUCKET` still names `graffiticode-c5a-gate`. Nothing publishes there while production admits no v3 capture command, and C5b switches it.
   - `canary-window-c5a` expires on its condition at 2026-11-19T03:57:32Z. It was not extended.

## Each check, and whether its evidence is live or hermetic

**Live** means produced through the released services: commands through `api-c5a-gate`, plus reads of Policy's, Broker's and the gate bucket's records. **Hermetic** means a test run at the commit the service serves, with its verbatim jest output; those records are in `evidence/`. A live field always decides, and a fallback never replaces it (`fieldEvidence`).

| Check | Evidence | Where |
|---|---|---|
| observations-read | live | `r36074e/state.json` (no read errors) |
| scenarios | live: the stored plans | `state.json` › plans |
| l0176-unchanged | **live:** production canary `canary-qvw98` 36/36; repair round-trip `4fe391` (production, revised verdict); the v8 artifact read. **Construction:** the v2 plan digest, rebuilt at Policy `2ce14335` (pre-C5a) and `f6132821` from three recorded plans' inputs | `r36074e/l0176/`, `v2digest/`, `v8artifact/`, `evidence-l0176-console-proxy.json` |
| plans-pin-approved | live | `state.json` › plans; approvals in the judge flags |
| private-owner | live | `state.json` › privateOwner; `images/` |
| images-correct | live: each published PNG at its exact generation, compared with the owner-approved references `fa3bbbd8` (private) and `db1481a6` (public), all identical | `r36074e/images/`, `state.json` › images |
| private-non-owner | **live:** refused `not-owner` at admission. **Hermetic:** `narrowed`, Policy `f6132821` `scopes.spec` "refuses an owner's capture at authorize-execution once the item has changed owner" | `state.json`, `evidence/hermetic-fallbacks.json` |
| public-anonymous | live: Policy's `command-reserve` audit, 12 allowed then `rate-limited` | `state.json` › publicAnonymous |
| mixed-chain | live: Broker's `execute` audit | `state.json` › mixed |
| mismatches | hermetic: Broker `58adb430` `gcs.spec` | `evidence/hermetic-required.json` |
| composition | live | `state.json` › composition |
| per-stage-contracts | **live:** plans; approval records unchanged, by inventory at exactly the baseline. **Hermetic:** the pre-slice-6 plan, Policy `f6132821` `scopes.spec` | `approvals-history/`, `evidence/hermetic-required.json` |
| registry-versions | live: the plans' manifests, and the canary command `c:0f8fc69b…`'s plan (L0185 0, L0176 9) | `registry-versions.json` |
| conditional-retry | hermetic: Broker `58adb430` `gcs.spec` "ends a 412 race…", supported by Policy `f6132821` `scopes.spec`. It can't be induced through the approved interfaces: nothing pauses or reorders execution | `evidence/hermetic-fallbacks.json`, [`../c5a/gate-fallbacks-proposal.md`](../c5a/gate-fallbacks-proposal.md) |
| reserve-stage-bind | **live:** order and sequences for each of the four scenarios, from the published object's command, its reservation and its bind for one occurrence. **Hermetic:** the repeats (Policy `captures.spec`) and the out-of-order pair (Broker `gcs.spec`) | `state.json` › reserveStageBind, `evidence/hermetic-fallbacks.json` |
| nothing-elsewhere | live: the appspot `thumbnails/` digest unchanged; `graffiticode-thumbnails` doesn't exist (gcloud's exact 404) | `state.json` › elsewhere |
| old-workers | live: the due phase | `state.json` › oldWorkers, `due.log` |
| fixtures-retired | live: the 2 v3 fixtures, the v2 control and the 13 quota commands are all terminal, and none is due | `state.json` › fixtureCleanup, `cleanup.log` |
| console-route | live: Step 27's policy-run probe (200), and fresh refusals at 21:46Z (anonymous, api-run, wrong audience: 403) | `console-route/`, [`../c5a/step27/`](../c5a/step27/) |
| proxy | Step 26: `verify-rollout` ok; AT-11 under Step 26's recorded owner exception (`docs/capability-policy-iam-review.md`, collector item 11) | [`../c5a/step26/`](../c5a/step26/) |

## The edge cache (procedure rev 3, `edge-cache-procedure.md`)

All probes were anonymous with redirects off. Each response's headers and body digest are in `r36074e/edge/`.
- **P1 (public control):** 302, `no-store`, `DYNAMIC`, with the expected data-URL shape. Its public `/data` went `MISS` then `HIT`, `immutable`.
- **E1/E2 (priming):** A1 (`/form?id=T&lang=0179`), A1′ (the camera's own `/form?id=T`) and A2 (`/data?id=T&generations=%40L0179%3Dinterp-4`) all answered 404, `no-store`, `DYNAMIC`/`BYPASS`, with no age and the same body.
- **E4:** the watcher started from generation `1794975635917666`. It saw the first fresh private publish (generation `1795038397756527`, `c:544d4e99…`, sequence 4) and probed A1, A1′ and A2 twice, all within 3 s of the object's creation (created 21:46:37Z, seen 21:46:38.175Z, probes 21:46:38.644–39.705Z). All six probes answered as in E1.
- **The camera's requests** (`edge/e3-api-requests.json`): the api logged exactly A1′ and A2 for all three private captures. No `POST /compile` reached the api during the captures, so the display-only capture context held.

## Approval records (`r36074e/approvals-history/`)

- **The recorded baseline digest** (`7e995b5c…`) was taken the old way, where JSON key order counts. Two reads of the same records could differ. It is kept as recorded.
- **`baseline.raw.json`:** the complete L0176 and L0000 inventory, read at 22:09:40Z from the `revisions` database's history at **exactly** the baseline time, 2026-11-18T21:45:33.773Z. That database has point-in-time recovery, with 7 days retained. `current.raw.json` was read a second later.
- **The comparison:** 42 records each; none added, deleted or modified. The canonical digest was `35f781bf…` before redaction. The final after phase used `baseline.raw.json` (`--approvals-at-baseline`) and recorded its original sha256 `e0ddf950…`.
- **Supplemental:** `supplemental.json`.

**Redaction:** the approval records' `retiringBy` and `retiredBy` fields name the operator's email address. In the three inventory files it is replaced with `<operator>`. `REDACTIONS.txt` lists each file's original sha256. The unredacted originals stay with the operator. The replacement is the same in every copy, so the redacted inventories compare exactly as the originals did (`verify.mjs`).

## Directory map

- **`r36074e/`:** the passing run.
  - **State and reports:** `state.json` (final, with `observationHistory`); `report.json` (20/20); `report-2026-11-18T21:53:51.947Z.json` (the first judgment, 17/20); `preserved-18of21/` (the original state, report and logs, with their `MANIFEST.sha256`, copied before the rerun).
  - **Phase logs:** `captures.log`, `due.log`, `cleanup.log`, `after.log`, `after-2.log`, `judge-2.log`.
  - **Captures and edge:** `images/` (each scenario's PNG at its generation); `edge/` (`edge-probe.mjs`, `p1`/`e1`/`e2`/`e4-watch` and the api request extract).
  - **Approvals:** `approvals-history/` (inventories and provenance); `after-diagnosis.json` (the read-only diagnosis of the first judgment).
  - **L0176 and other rows:** `l0176/` (the round-trip output, its Broker extraction and rejudge); `v2digest/` (recorded inputs, the construction at both commits, the comparison); `v8artifact/` (provenance and the live read); `registry-versions.json`; `console-route/`; `hermetic/` (verbatim jest output at the deployed commits, and the builder of `evidence/hermetic-fallbacks.json`); `evidence-l0176-console-proxy.json`.
  - **Releases:** `releases/serving.json`.
- **`r381d64/`:** the stopped run. Its state (with `observationHistory`), edge probes, E3 command and request extracts, images, and the follow-ups (`retire-13th`, `nonowner-acl`, quota recollection).
- **`evidence/`:**
  - `hermetic-required.json` (mismatches, pre-slice-6);
  - `hermetic-fallbacks.json` (narrowed, conditional retry, reserve/stage/bind repeats and out-of-order);
  - the earlier `hermetic-fallbacks.DRAFT.json` and the original test outputs.
- **Top level:** `fixtures.json` (the canary-owned fixture items and tasks, with read-back ACLs), `edge-cache-procedure.md`, `REDACTIONS.txt`, `MANIFEST.sha256`, `verify.mjs`.
