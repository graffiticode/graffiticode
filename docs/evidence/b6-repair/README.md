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
