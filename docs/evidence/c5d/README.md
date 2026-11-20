# C5d Step 32: the staged drive (evidence)

[Step 32](../../capability-policy-iam-review.md) of the C5d plan ([`docs/c5d-snapshot-commands-plan.md`](../../c5d-snapshot-commands-plan.md)): an isolated drive of snapshot commands through production Policy, publishing only to `gs://graffiticode-c5d-drive`.

**Verdict: the drive has not passed.** It stopped at `staging-gone` on a blocking product finding (below). Its sweeper is paused, Broker's fault is off, the stuck command stays recorded pending, and `cleanup` stays failed. Compiler retirement and infrastructure deletion are held pending review of the command's disposal procedure.

The operator's address is redacted throughout as `<operator>` ([`REDACTIONS.txt`](REDACTIONS.txt)). No production credential, and no token or key, is in this evidence; two local-test JWT fixtures in the build logs are redacted ([`REDACTIONS.txt`](REDACTIONS.txt)).

## Layout

| Path | What |
|---|---|
| [`step32/before/`](step32/before/) | B6's `l0176r-drive` before Step 32 (generation 7), for the "unchanged" check |
| [`step32/bucket/`](step32/bucket/) | `gs://graffiticode-c5d-drive`: settings, its policy at creation, intended and after |
| [`step32/services/`](step32/services/) | the four placeholders (Ready gate, the Broker placeholder's environment), the run-1 releases, the twins' images, serving revisions, the sweeper job |
| [`step32/readback/`](step32/readback/) | the invokers after the run-1 releases, and `l0176r-drive` after |
| [`step32/proxy/`](step32/proxy/) | template `egress-proxy-9a1404b049a2`, the rolling update, `verify-rollout` (`94ecf108…`, both VMs `match: true`) |
| [`step32/window/`](step32/window/) | `canary-window-c5d` on `api-run` and `console-run`, one shared expiry `2026-11-20T23:14:39Z` |
| [`step32/releases-run1/`](step32/releases-run1/) | the run-1 release logs (`f41f2aed`) |
| [`step32/run2/`](step32/run2/) | the public-compiler correction's bindings and re-releases (`b6036456`), serving revisions, and the Broker fault's traffic switch |
| [`drive/0aa69b9a/`](drive/0aa69b9a/) | run 1, **aborted**: its manifests, journal and console output |
| [`drive/ad49c0ac/`](drive/ad49c0ac/) | run 2, **stopped**: its manifests, journal, console output and [`staging-gone-incident/`](drive/ad49c0ac/staging-gone-incident/) |

Manifests are the runner's, each written once; failed manifests are kept beside their reruns.

## Timeline (UTC)

**2026-11-19, infrastructure (Step 32 §1–§5).**
- Bucket created private: uniform access, public access prevention, soft delete off; `broker-run` its only `objectUser`.
- Four private placeholders from the live twins' images, each Ready with 100% resolved traffic; the Broker placeholder carrying its generated environment and three pinned secrets.
- Exact invokers on each.
- The drive Broker's host certificate issued into its secret (readable by `egress-proxy` only), the template built and rolled: both new VMs HEALTHY, `verify-rollout` passed. A pre-ready UNHEALTHY probe on a booting VM matched the previous rollout's pattern.
- Releases from `f41f2aed`: `broker-c5d-drive-rmwo55sk0-feb2b6`, `l0013r-c5d-drive-rmwo5eh0t-66f668` (approved `[3]`), `l0176r-c5d-drive-rmwo5egv6-a16b77` (approved `[1, 2]`), `api-c5d-drive-rmwo5g9vx-da6614`.
- The sweeper job (`command-sweeper`, audience = the drive api's URL); a live sweep returned 200.
- The window, both bindings sharing one expiry.

**Run `0aa69b9a` (aborted).**
- `checks` failed once while the window binding propagated, then passed 6/6. `baseline`: 33 objects.
- `first-capture` failed: the drive api's preflight got Cloud Run's 403. The api calls compilers with `X-Caller-Identity` only, and the drive compilers had been made private. Nothing was allocated.
- Corrected by #452 (public drive compilers, `access-probes`, `resolve-intent`, nonzero exits), #453 (`resolve-intent`'s manifest) and #454 (`cleanup --aborted`).
- `resolve-intent` recorded `first-public` as a pre-allocation answer (`preflight-unavailable`), the saved answer untouched. `cleanup --aborted` passed: all 13 planned ids absent, nothing due, Policy's enumeration complete and empty.

**Run `ad49c0ac` (stopped).**
- Plan; `allUsers` on the two compilers only; re-releases from `b6036456`: `l0013r-c5d-drive-rmwo9rmhz-e7abb8`, `l0176r-c5d-drive-rmwo9rmds-b7a578`, `api-c5d-drive-rmwo9rmds-75d10c`.
- `checks` 6/6.
- `access-probes`: 14/14 probes. The drive bucket's empty listing then failed to read (#455), and the rerun after reauthentication passed 17/17.
- `baseline`: 33 objects.
- `first-capture` passed.
- `direct-refused`: first a 401, because the now-public compiler verified api-run's ID token as a user token (#456); the rerun passed with A1b's refusal.
- `exit-after-reserve` passed.
- `exit-after-stage`: `staged-reused` counted 0 because of ANSI codes in the render lines (#457). `recount-renders` found exactly 1 render in the original window, and passed.
- `drop-outcome` and `drop-outcome-retry` passed (see "The Broker fault" below).
- `stale-worker` passed.
- **`staging-gone` stopped the drive** (see "The finding" below).

## The Broker fault (Step 32 §6, corrected)

- `gcloud run services update … --update-env-vars=BROKER_FAULTS=drop-outcome` created `broker-c5d-drive-00003-st7` with **no traffic**: the CLI routes by revision name. With the owner's approval, traffic was moved to it and its settings verified.
- `drop-outcome`: the command ended `uncertain`, the claim named the drive bucket and the staged object, and `outcome/final` was absent.
- Deletion 2, generation-fenced at `1795203211162428`, after the four preconditions.
- `drop-outcome-retry`: the same command; the reconcile was `applied`, final.
- Traffic restored to `rmwo55sk0-feb2b6` and the template cleared; both verified without `BROKER_FAULTS` (`step32/run2/`). Step 32 §6 is corrected to match.

## The finding: a definitive pre-claim refusal is never settled

`staging-gone` (`drive/ad49c0ac/staging-gone-incident/`):

1. **Generation 1 staged, then exited** by its fault at 19:37:54Z.
2. **Deletion 1:** the watcher (its script and log are kept) verified the four preconditions and deleted the staged object, generation-fenced at `1795203474250242`, at 19:38:10Z, inside the 60 s lease. The preconditions were:
   - the fault line names the plan's id;
   - the reservation is `staged` at generation 1;
   - the name derives from that reservation;
   - the live generation matches.
3. **The takeover loop:** every sweeper takeover from 19:39:07 to 19:54:14 did the same three things:
   - resumed at s0;
   - asked Broker to execute `gcs.put-thumbnail`, which Broker refused **409 `staging-unavailable`, before any claim**;
   - then had its finish refused by Policy with `occurrences-unsettled`.
4. **The command stays `pending` / `admitted`.** Its one reservation is `staged` at generation 1. Broker holds **no receipt document** for operation `inv-078ca8f4-b88f-4fe3-8e04-1cc853b71aa3/s0/x:9eb94a78…`; a control read of the drop-outcome operation's receipt returned 200.
5. **The runner timed out after 600 s** and wrote no `staging-gone` manifest. Its console output is kept.
6. **The drive's sweeper was paused** at 19:55:14Z, with the owner's approval. No sweep has reached the drive api since.

**Disposition:** the command stays recorded pending, with an unsettled occurrence and no Broker claim. `cleanup` stays failed. No outcome is fabricated, and `recordLost` isn't used.

**Required before C5d activation:** a product fix that durably settles the definitive pre-claim refusal, while preserving temporary-outage recovery and claim-race safety, with its regression test. The command's disposal procedure, which must also account for future scopes-enabled workers, issued tokens, in-flight requests and a fresh receipt check using the store's actual paths, is being prepared for review.
