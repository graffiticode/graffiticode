# C6 activation drive: L0176 saves as commands (2026-11-09)

The staged activation drive of `docs/c6-l0176-commands-plan.md` §6 step 3, which replaces B5's skipped soak and supplies the reconciliation evidence for the B6 entry gate. Run with `scripts/c6-drive.js`. The full record of every command is `drive-state.json`; this page summarizes it.

**Verdict: passed.** The first pass passed. The live faults all pass, after a fix for the gap the lost head answer found (below).
- First pass: 200 commands. The 188 clean ones all `completed`, and the 12 faulted ones all `uncertain`.
- No write was repeated.
- 17 of 17 dropped-outcome operations were reconciled `applied`, where 10 were required.

## Where it ran

The canary account (`995cc0bc…`) wrote through its Learnosity sandbox connection only (`conn-686c62bc…`), in canary window `canary-window-c6`. The window is the operator's time-limited OpenIdTokenCreator grant on `api-run`, `l0176r-run` and `console-run`, which expires 2026-11-10T08:00Z.

Three non-production services, on their production twins' runtime accounts (IAM review, Step 21):

| Service | What it is |
| --- | --- |
| `api-drive` | the api at `7fe72a01` (C6 slices 0–3), with `COMMANDS_L0176=on`, `COMPILE_GENERATION_L0176=c6-drive-1`, and `BASE_URL_L0176` = l0176r-drive. It has no sweeper. |
| `l0176r-drive` | `l0176r-drive-rmw9qbqjr-751fe1` (commit `4e31be61`, image `sha256:99ff0995…`), with `BROKER_URL` = broker-faults, on `compilers-l0176` behind the egress proxy |
| `broker-faults` | the Broker at `d2841fa2`, with `BROKER_FAULT_PRINCIPALS` = the canary uid. `BROKER_FAULTS=drop-outcome` was set for the faults phase only. |

The proxy gained exactly `broker-faults-sja7fatcta-uc.a.run.app` for `compilers-l0176`.
- It runs config `7ef2039e…` on template `egress-proxy-226124a1cda1`, and `verify-rollout.js` reported `ok` with both VMs matching.
- 331 drive connections reached broker-faults through it, all allowed.
- No production compiler's refusals changed.

**Deviations from the plan.**
- **Separate services, not staged tags.** A tag URL is its own hostname too, so either way meant a proxy change. Separate services keep the drive apart from production's traffic and tags.
- **Two phases.** The fault applies to every canary write, so the drive ran it in a separate phase: clean commands with the fault unset, then faulted commands with it set.

## Results

| Run | Phase | Result |
| --- | --- | --- |
| `16a10e` | checks | passed. api-drive routes L0176 to l0176r-drive with commands on. l0176r-drive's `BROKER_URL` is broker-faults. broker-faults faults the canary only. The serving revision is approved with its tag URL. A gateway preflight at l0176r-drive reports that revision and image digest. |
| `193af0`, `bc882b`, `5f9d5a`, `eb3997` | clean | 188 commands, all `completed`: 95 via `POST /command` and 93 via the compile bridge, across one save (64), two saves (62) and a save inside `map` (62). Every command was admitted at `l0176r-drive-rmw9qbqjr-751fe1`, and every outcome is `completed` from a receipt. The two middle runs stopped on an expired canary token (it lasts 300 s); the script now refreshes it every 2 min. |
| — | clean | 16 concurrent duplicates of one key, twice: one command and one write each time. |
| `d2a4d3` | retries | 19 same-key retries (every tenth clean command, each by its own path) returned their recorded command, with no new receipt and the same references. |
| `14e57f`, `789a46` | faults | 12 commands, 7 via `/command` and 5 via the bridge, 17 operations. Each write succeeded at the provider and its outcome was dropped, so every command ended `uncertain`, settled from its receipt. |
| `5a2e7e`, `dc0308` | reconcile | The 12 keys went through Policy's `/v1/receipts/reconcile` as the console. All 17 operations came back `applied` and `final`, with 34 records carrying the operation's mark. Every command stayed `uncertain` (D1). `5a2e7e` reconciled only the first command, so it fell short of the count of 10 by design. |

**No write was repeated.**
- The 314 clean writes produced 314 provider references, none shared.
- The faulted writes' read-back found each operation's own marked records.

## The bound's measurement (decision 6)

The plan sets a runtime limit of 1000 saves per call site, and requires that the largest number production programs have made per site be measured first. Measured 2026-11-09, with two read-only scripts.

**At run time** (`scripts/c6-save-counts.js`). This covers every Broker receipt, the whole window since the Broker took over writes: 2026-09-28T21:46Z to 2026-11-09T21:29Z.
- **Totals:** 772 receipts, all `learnosity.write-items`, in 454 stages of invocations.
- **Bounded from above:** a call site's saves can't exceed its stage's, so the stage count is a ceiling for each site.
- **The most in one stage is 3** (94 stages made 3). None made 5 or more.
- **Who wrote them:** the canary made 759 of the writes. One other principal made 13, over 13 stages, at most 1 each.
- **Before the window:** writes went straight to Learnosity with no per-invocation record, so there is nothing earlier to read.

**In the stored programs** (`scripts/c6-save-sites.js`). This covers every L0176 task in the default database.
- 3359 programs, of which 328 save.
- At most 2 save sites in any one program.
- 71 programs have a `map`, where a save can repeat. The longest literal list in any of them has 4 elements.
- **Limit:** a `map` over data from another stage isn't visible statically. The runtime figure covers that case.

**Headroom:** about 333 times the most observed (3 against 1000). A program would have to save at one site in a map over more than 1000 elements to stop at the bound. It then ends `partial`, written once each up to the bound, and the drive's slice-0 tests show that outcome.

**Caveat:** real use is thin, 13 writes. The figure mainly shows that nothing in production comes near the bound, not that heavy use was observed. It is re-read with `scripts/c6-save-counts.js` before any later change to the bound.

## Live faults (2026-11-09, second pass)

These faults run against the deployed recovery path:
- `api-drive` takes the worker faults of `packages/api/src/commands/faults.js`, for the canary only. The production api refuses to start with them set.
- Revocation goes through Policy's console routes.
- api-drive was released as `api-drive-rmw9szk7s-61d56f`. Its traffic was then moved to the latest revision, so that each fault setting serves.

| Run | Fault | Result |
| --- | --- | --- |
| `5fa4d4` | **worker killed after its writes** (`exit-after-write`) | **Passed, 3/3** (one save, two saves, `map`). api-drive's process exited after the writes ran, and the client got 503. The **production api's sweeper** (`api-rmw9noal4-35457c`) took each command over through the admitted l0176r-drive revision, re-ran the open stage, and finished it `completed`, with its result. Every write has exactly one receipt, so no write was repeated. |
| `508ab1`, `d3b203` | **revocation mid-command** | **Passed, 3/3.** A save in a 10-element `map`; the canary narrowed its own connection to `init` and restored it, read back exactly. Narrowed after the first write's final outcome (2 commands): 1 completed from its receipt, and the rest `failed` by Policy refusal (`not-granted`), never written. Narrowed after the first claim (1 command): the first operation was cut between its steps, so the Broker recorded `partial` (`authorization-denied:not-granted`), and the rest were refused. Every command ended `partial`, with as many receipts as claims. |
| `9c61cd` | revocation, first attempt | The records were right (the between-steps case, `partial`). The script's check expected a completed write, and was corrected for `d3b203`. |
| `46c98b` | lost head answer, not applied | api-drive's traffic was still pinned to the release revision, so the fault env didn't serve. The 3 commands ran without a fault and completed (5 clean writes). |
| `805d05` | **lost head answer** (`lose-head-answer`) | **Found a gap, 0/3.** Every write completed from its receipt, but each command ended **`partial`** with `result: unavailable`, instead of `completed` with `result: unavailable`. See below. |
| `a5b97a` | **lost head answer, after the fix** | **Passed, 3/3** (one save, two saves, `map`). api-drive was re-released with the fix (`9c97a542`). Each head answer was lost with the expansion open, so api-drive left the command pending and answered 200. The production sweeper took each over, re-ran the open stage on its pinned input (the bound saves replayed at the Broker), closed it, and finished `completed` with its result. Every write has exactly one receipt. |

**The lost-head gap, found and fixed.**
- **What happened.** L0176's saves are runtime-expanding intents. A stage's expansion closes only from its answer's list of occurrences. When the head's answer was lost, the worker settled from receipts, recorded the stage lost and finished with the expansion still `open`. `finish` counted the open stage as not done, so the command ended `partial` though every write completed.
- **Why the tests missed it.** B5's worker test of a lost head answer uses static intents, which close at admission.
- **The fix** (`9c97a542`, owner-approved, B5 fix G). A lost answer from a stage whose intents expand at run time now settles what the receipts hold and leaves the command pending. Recovery re-runs the stage, the bound saves replay, and the stage closes. Stages with static intents keep their lost-answer outcome. The worker tests cover it, with three new tests that fail without the fix.
- **Where it runs.** Only the worker that receives the lost answer needs the fix. The production api's current code already resumes an open stage on takeover, as the kill phase shows. The fix reaches production with C6's activation release.

## Retained

- `l0176r-drive-rmw9qbqjr-751fe1` is retained and approved, with its tag. Its 17 receipts have no recorded final outcome, so retirement's recovery report would refuse it. It is retired, and its tag removed, only after a retirement succeeds.
- The three drive services stay at min 0, with the fault unset (`broker-faults-00004`), until C6 is promoted.
