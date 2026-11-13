# B6 command repair: evidence

Plan: [`docs/b6-command-repair-plan.md`](../../b6-command-repair-plan.md). Repair stays disabled until `REPAIR_L0176=on` (decision 10).

## Replay-support cutover (decision 11), slice 1

| | |
|---|---|
| Service | `l0176r` |
| Revision | `l0176r-rmwe83rgw-eae49e` (release `rmwe83rgw-eae49e`) |
| Image | `us-central1-docker.pkg.dev/graffiticode/services/l0176r@sha256:221db98801704faec822d267dfeab98be76ce44ef6199a16070ea568084d85c6` |
| Source | `main` at `07944db9` (#381, with its review fixes) |
| Revision created | 2026-11-13T00:22:20Z |
| Promoted to 100% | 2026-11-13, about 00:23Z |
| Rollback | `npm run rollback -- l0176r --env production --release rmwe83rgw-eae49e` (restores the traffic before it, `l0176r-rmwduyn6c-c054b7`) |

**What it means.** This is the first L0176 revision whose preflight manifest says `replay: 1`. A command admitted on an earlier L0176 revision pinned a revision without replay. It can never be repaired or materialized (`revision-unsupported`), and its failures stay reported, with manual reconciliation as before B6. A command admitted on this revision or a later one also needs `recording: 1` (slice 2) before it is eligible (`not-recorded` otherwise). Until slice 2 ships, Policy's stored admission doesn't keep `replay` (`pinnedStage` drops it), so no command admitted before slice 2 carries `replay: 1` in its record. The rule that matters is the recorded one; this revision only makes it possible.

**Repair stays off.** Nothing in the api sends `operation: "materialize"` or a start's `recorded` yet, and there is no `REPAIR_L0176` flag until slice 4.

**Checks after promotion (2026-11-13):**
- Traffic is 100% on `l0176r-rmwe83rgw-eae49e`. The older tagged revisions, pinned by admitted plans, carry no traffic.
- The live service answers the new route shape: `operation: "materialize"` without records is a 400 (`materialize needs the stage's recorded occurrences`), and `mode: "replay"` is a 400 (`mode must be "evaluate" or "present"`).
- Unchanged reads: 12 conformance programs, each read with `/interpret` in `evaluate` and `present`, with no connection. The new revision and the previous one (`rmwduyn6c-c054b7`) gave identical envelopes, apart from `revision` (24 of 24).

## Recording outputs (slice 2), released 2026-11-13

From `main` at `d5b0e8ab` (#384), in the plan's order:

| Service | Revision | Rollback |
|---|---|---|
| Broker | `broker-rmwfao7du-d30ef1` | `npm run rollback -- broker --env production --release rmwfao7du-d30ef1` |
| Policy | `policy-rmwfb0a6i-b1deb2` | none: Policy's `B6-recording` floor refuses any target below this slice, with no override. Fix forward. |
| api | `api-rmwfbfpg3-a8a20e` (image `sha256:5123187f…`) | `npm run rollback -- api --env production --release rmwfbfpg3-a8a20e` (restores `api-rmwe179az-dc8f27`; recording commands then wait, pending, for a recording api) |

- **Broker and Policy** were released and promoted directly; `release-check` is ok for both. Policy meets its new floor.
- **The api was staged** (`--stage`, 2026-11-13T18:45:46Z) and the canary job ran against its tag: **36/36** (`canary-hrqqx`, `--chain-admission --after-cutover --command --l0185-tail`). It included both command saves, L0176 and L0185 → L0176, and their same-key retries, which wrote nothing again.
- **Recording, seen in Policy's request log** for the L0185 → L0176 command (`c:c096b395…`) through the tag: `admit`, then `PUT outputs/s1` (the fetch's output) before `PUT inputs/s0`, then `settle`, `PUT outputs/s0` and `finish`, then `published`. Policy answered no `worker-unsupported`; its only 4xx since its release were the canary's own refusal probes.
- **Promoted** with [`slice2-promote-evidence.json`](slice2-promote-evidence.json). The tag `rmwe179az-dc8f27` was retired.
- **After promotion:** `release-check api` ok; the rollback plan restores `api-rmwe179az-dc8f27`; the production canary passed 33/33 (`canary-9cvvx`, its scheduled arguments).

**Repair stays off.** Commands admitted from now on carry `recording: 1` and are pinned to replay-capable L0176 revisions, so they will be eligible once slices 3 and 4 ship. No repair or materialize route exists yet.

## Repairs and the ledger in Policy (slice 3), released 2026-11-13

- **Policy** `policy-rmwffa18u-d77293`, from `main` at `0f1483b7` (#386). It is above its `B6-recording` floor, so the floor forbids rolling it back below this release; a fix goes forward.
- **After release:** `release-check policy` is ok. The production canary passed 33/33 (`canary-fxprk`). Policy's only 4xx since the release are the canary's own refusal probes: the denied final stage's admission, the v1 snapshot without a plan, and the author and revocation checks.
- **Repair is still unreachable.** No api route allocates a repair, and the live api states no `repairs` capability, so it can't own one. Reconciliation's ledger writes are live, as the owner agreed: they record what Broker established and dispatch nothing.
