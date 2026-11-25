# C5d Step 32a: the fresh drive, run `d1ca6da0` (evidence)

[Step 32a](../../../capability-policy-iam-review.md) of the C5d plan: a fresh, isolated drive of snapshot commands through production Policy. It reused the `*-c5d-drive` names, published only to `gs://graffiticode-c5d-drive`, and was torn down afterwards.

**Verdict: DRIVE PASSED** (18 phases, 82 checks), in the aggregate report [`report-2026-11-24T19-08-09-162Z.json`](../drive/d1ca6da0/report-2026-11-24T19-08-09-162Z.json).

- `older-after-newer` passes through the **owner-approved supplement**.
- Its original manifest **failed one check**, and stays the phase's manifest. That failed judgment, the supplement and the named retirement decision are all recorded below.
- **Teardown is complete.**
- **The legacy command `c:f54ea9f1…` is still pending under its durable hold.**
  - Its 28 retained records were unchanged at every check from §0 to closeout.
  - Nothing named it at any point in the window.

**Verify offline**, after `npm run build`:

```bash
node docs/evidence/c5d/step32a/verify-published.mjs --self-test
node docs/evidence/c5d/step32a/verify-published.mjs [--private-literals <private JSON list>] [--private-source <private evidence root>]
```

- **The scan covers every published file:** the evidence, the generated files (the verifier included) and both parent documents.
  - Each file is scanned as written, and again with its escapes decoded.
  - It checks for tokens, keys, local paths, sealed secrets, and any email address other than a service account.
- **No exact operator email or caller IP appears in this published evidence bundle.** The operator's address and IPs are checked only when `--private-literals` supplies them, from a JSON list kept privately.
- **`--self-test`** plants synthetic leaks (TEST-NET-3 addresses, example.com, a synthetic JWT) and requires each to fail. It covers generated files, parent documents and escaped forms.

**Publication:**
- Redactions are recorded in [`publication.json`](publication.json), [`files.json`](files.json) and [`../REDACTIONS.txt`](../REDACTIONS.txt).
- Every file in [`../drive/d1ca6da0/`](../drive/d1ca6da0/) is published **byte-identical**. That includes the approved supplement, its original manifest and both aggregate reports.
- The supplement's raw receipt is also published unchanged.
- Redacted files are derivatives of private originals, each named by `originalSha256`.

## Layout

| Path | What |
|---|---|
| [`../drive/d1ca6da0/`](../drive/d1ca6da0/) | the run: `plan.json`, each phase's manifest (failed ones kept beside reruns), the journal, the re-judge reports, the aggregate reports |
| `setup/` | §§1–3: bucket policy, placeholders, invokers, the four releases from `62d8198c` (including the interrupted Broker attempt: build succeeded, no deployment), release checks, the sweeper |
| `proxy/`, `proxy-rollback/` | §4's roll to `egress-proxy-9a1404b049a2` (`94ecf108…`), and the teardown roll back to `egress-proxy-ce42b3628a5a` (`8b637609…`): templates, `verify-rollout`, the canary |
| `window/` | `canary-window-c5d2`: the grants, one shared expiry `2026-11-25T01:41:42Z`, the revocation |
| `readback*/`, `pre-staging-gone/` | the per-phase reads: claims, outcomes, steps, buckets, held-command audit queries |
| `broker-fault/`, `deletion1/`, `deletion2/` | the Broker fault's revision and traffic, and the two staging deletions with their watcher and preconditions |
| `rejudge-older-after-newer/`, `aggregate-*/` | the re-judges' and aggregate judges' outputs and before/after hashes |
| `after-drive/`, `teardown/` | §9's reads; §10's teardown in order, then §10.7's closing reads |
| `legacy-*` | the 28-record retained comparison at each step |

## The run (2026-11-23/24 UTC)

**Setup, §§0–5:**
- **§0:** the 28 retained records `same`, 6/6 controls, and `ownableBy` false at all 8 combinations.
- **§§1–3:** the bucket, placeholders, invokers, releases and sweeper. All release checks pass, and the environments pass 12/12.
- **§4:** the drive Broker's certificate, and the proxy rolled to `9a1404b049a2`. `verify-rollout` passed on both VMs, and the canary passed 36/36.
- **§5:** the window granted on `api-run` and `console-run`.

**The phases:**

| Phase | Result |
|---|---|
| `checks` | 6/6, plus §7's manual read-backs |
| `access-probes` | 17/17 |
| `baseline` | 33 objects |
| `first-capture` | 3/3 |
| `direct-refused` | 3/3, with A1b's refusal |
| `exit-after-reserve` | 4/4 |
| `exit-after-stage` | 3/3 |
| `drop-outcome` (with deletion 2 and the retry) | 6/6, judged on the merged manifests; the Broker fault was set, then restored |
| `stale-worker` | 6/6 |
| `staging-gone` | 7/7, the corrected #466 result |
| `older-after-newer` | 3/4 as written, 4/4 with the supplement (see below) |
| `two-stage` | 2/2 |
| `mixed` | 2/2 |
| `non-owner` | 1/1 |
| `rate-limit` | 2/2 |
| `canary-snap` | 3/3 |
| `boundary` | 6/6 |
| `cleanup` | 3/3 |

- **`staging-gone`:**
  - The watcher checked five preconditions, including that no claim existed, then deleted 42 seconds before the takeover.
  - Broker recorded a durable refusal.
  - The command ended `failed`, with publication `none`, and the fresh capture succeeded.
- **`mixed`:** snap got item scope only, and the save got connection scope only. The sandbox save succeeded.
- **`non-owner`:** refused `not-owner` at admission, as the verify account, with no reservation and no Broker execution.
- **`rate-limit`:** 0 prior captures, 13 attempted, 12 allowed, then one `rate-limited`. The retirement helper retired only the refused command.
- **`cleanup`:** 28 commands, all terminal: 24 completed, 3 failed and 1 uncertain. None is due.

**Browser warnings:** `Uncaught signal: 13` and `chromiumoxide` websocket warnings appeared before renders. They're recorded in the logs; renders completed and digests matched. Their cause is unconfirmed, and the owner judged them non-blocking.

**An audit-logging defect, noted:** Policy's finish line logs reason `invalid`, because its allowlist rejects `completed`. The decision and completion are still recorded.

## The original failed judgment, and the approved supplement

1. **The failure:** `older-after-newer`'s original manifest ([`older-after-newer-2026-11-24T16-54-16-178Z.json`](../drive/d1ca6da0/older-after-newer-2026-11-24T16-54-16-178Z.json), sha256 `35780e8e…`) failed `older-newer-present` with "the older's result isn't its own capture".
   - The check read the **command** result, which is only `{item, url}`.
   - The live behaviour was correct: the older capture's Broker `outcome/final` held its own sequence 20, its publish step observed `newer-present`, and the final object was the newer capture's sequence 21.
2. **The fix:** #475 corrected the check to read the operation's `outcome/final`, by its exact document name.
   - Review round 1 added strict Firestore value decoding and bound the re-judge to `--run`.
   - It also added `judge --approve-rejudge`, which verifies both sources' hashes and recomputes the verdict.
3. **The supplement:** the owner kept the run and approved [`rejudge-older-after-newer-2026-11-24T17-13-28-973Z.json`](../drive/d1ca6da0/rejudge-older-after-newer-2026-11-24T17-13-28-973Z.json) (sha256 `e81bf970…`, 4/4).
   - Its sources are the original manifest (`35780e8e…`) and the raw receipt [`readback-older-after-newer/older-outcome-final.json`](readback-older-after-newer/older-outcome-final.json) (`e44c1c66…`).
   - An earlier re-judge (`17-03-31`, `390a78da…`) is kept, but it wasn't approved.
4. **The aggregate:** run with the supplement, it keeps the failed original as the phase's manifest, and records the supplement and all three hashes under `supplements`. Default judging still fails the phase on its original, and the verifier recomputes both outcomes.

## Teardown, §10, and the named retirement decision

1. **§10.1–3:**
   - The sweeper was deleted.
   - Both compilers were closed: `allUsers` removed first, then no invoker binding, and Cloud Run's 403.
   - Both were parked on unapproved revisions, with plain `gcloud`.
2. **§10.4, retirement:**
   - `l0013r-c5d-drive` release `rmwtr1q6y-99884e` reported **3 plans**, and cancelled itself (`teardown/4-…`).
     - The plans are this run's own terminal test commands: the quota refusal `17664062…`, the drop-outcome `32f54d6b…` and the staging refusal `6e4d3bb2…`.
     - It also fenced one stale admission lease, left by the refused `non-owner` admission.
   - **The owner's named decision** was `--confirm-unrecoverable` for exactly those three plans.
     - A fresh report listed the same set (`teardown/6-…`).
     - The three commands' 34 records were canonically identical before and after (`teardown/7-records-canonical-*.sha.txt`).
     - The release retired at 20:29:27Z, and its tag was removed at 20:44:31Z after the drain.
   - `l0176r-c5d-drive` release `rmwtrvx68-fd9659`: an empty report, so a normal retirement. It retired at 20:45:23Z, and its tag was removed at 21:00:27Z.
3. **§10.5:**
   - The four services were deleted.
   - The bucket was deleted once its listing was saved. It held only the two fixture PNGs.
   - #476 (the cleanup PR, the inverse of #472) merged as `5261ad89`, ending the re-enable restriction.
4. **§10.6:**
   - The proxy was rolled back to `egress-proxy-ce42b3628a5a`. Its logical user-data is `ce42b3628a5a…`, and its config `8b637609…` equals what `5261ad89` generates.
   - It went stable at 22:02:22Z. `verify-rollout` passed on both VMs, and the canary `canary-5jxm2` passed 36/36.
   - The drive Broker's certificate secret was deleted once no running proxy referenced it.
   - Both `canary-window-c5d2` grants were revoked, and the policies equal their pre-grant read-backs.
5. **§10.7:**
   - B6's `l0176r-drive` is unchanged, and the 28 retained records are `same`.
   - The controls pass 6/6, including `ownableBy` false at all 8 combinations.
   - Protected execution is **ON**.
   - The held-command audit is clear from 01:41:42Z to 22:34:57Z.

**Two operator slips, recorded:**
- A first retirement attempt from the runner checkout found no release receipt and changed nothing.
- One unneeded `secrets versions access` read of the drive certificate secret went to `/dev/null` before its deletion.

**Still held:** lifting the hold, the production compiler releases, and Steps 33–34.
