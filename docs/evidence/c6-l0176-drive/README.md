# C6 activation drive: L0176 saves as commands (2026-11-09)

The staged activation drive of `docs/c6-l0176-commands-plan.md` §6 step 3, which replaces B5's skipped soak and supplies the reconciliation evidence for the B6 entry gate. Run with `scripts/c6-drive.js`. The full record of every command is `drive-state.json`; this page summarizes it.

**Verdict: passed.**
- 200 commands. The 188 clean ones all `completed`, and the 12 faulted ones all `uncertain`.
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

## Not exercised

These faults from the plan's list can't be injected from outside the api:
- **A worker killed after a write.** Its recovery path, the production sweeper taking over through the admitted revision, is covered by B5's gate tests, not by this drive.
- **A lost head answer.** Covered by B5's tests (`completed` with `result: unavailable`).
- **Revocation mid-command.** Covered by B5's tests (`partial`, from receipts and a Policy refusal).

## Retained

- `l0176r-drive-rmw9qbqjr-751fe1` is retained and approved, with its tag. Its 17 receipts have no recorded final outcome, so retirement's recovery report would refuse it. It is retired, and its tag removed, only after a retirement succeeds.
- The three drive services stay at min 0, with the fault unset (`broker-faults-00004`), until C6 is promoted.
