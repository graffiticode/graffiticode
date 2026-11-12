# B6: command repair

**Status:** draft for the owner's review (2026-11-12). Plan item: `docs/graffiticode-interpreter-plan.md` Track B, "B6 Commands, part 2", whose entry gate C6 met (2026-11-09). Design: `docs/graffiticode-interpreter-design.md` §5 ("Repair", "Stages the original never reached", "Artifact publication after a repair") and acceptance test 13. Builds on B5 (`docs/b5-commands-plan.md`) and C6 (`docs/c6-l0176-commands-plan.md`).

**Owner's requirements (2026-11-12).** The plan makes each one explicit:
1. **Retry only failed occurrences.** Only an occurrence established `failed` is retried; a `partial` or `uncertain` one is reconciled first.
2. **Atomic claim.** Occurrences are claimed atomically, so competing repairs can't repeat a write.
3. **Resumption.** The stages the original never reached are resumed.
4. **Materialization.** The full artifact is materialized from recorded data only, with no live reads or effects, and never overwrites newer work.
5. **Recorded reads.** C3 deferred recording fetched observations. Materialization needs recorded stage outputs or read observations, so it reproduces results without fetching again.

## 1. Where we start (survey, 2026-11-12)

**What B5 records** (Policy, `commands/{c:…}`, `packages/policy/src/command-records.ts`):
- the models;
- each intent-bearing stage's pinned input, written once (`inputs/{stage}`);
- each occurrence's binding: intent, expansion key, args and their digests, observations, minted tokens and generation (`occurrences/`);
- refusals (`refusals/`);
- each occurrence's outcome: status, source, `final`, receipt, steps and generation (`outcomes/`);
- the head's answer (`result/final`);
- each stage's state: `pending`, `ran` or `not-reached`, with its `pinnedInput` digest.

The command's status is `completed`, `failed`, `partial` or `uncertain`. An occurrence's outcome is one of the same four, from a `receipt`, a `policy-refusal` or a `lost-response`.

**What is not recorded:**
- **Occurrence outputs.**
  - Broker keeps each operation's `result` on its receipt (`broker.ts:557`).
  - The receipt read Policy settles from returns status, steps and reason, without `result` (`packages/broker/src/receipts-read.ts:49-57`).
  - So the item references a save returned (`data.itemBank` in L0176's answer) exist only in Broker.
- **Stage outputs.** Only the head's final answer, and the inputs of intent-bearing stages, which are their upstream stage's output. An effect-free stage's output is recorded only when an intent-bearing stage pins it as its input.
- **Observations.** `ExecContext::observe` exists (`languages/l0000/crates/core/src/exec.rs:429-452`), but it records only inside a command stage with a session, and no language calls it.
  - An L0185 stage has no intents and runs without a session, so its fetches can't be recorded (`docs/c3-l0185-interpreter-plan.md:28`, decision 5, deferred to B6).
  - Today an L0185 output below an L0176 save survives only as that L0176 stage's pinned input.

**What doesn't exist:**
- **No repair command, route or admission.**
- **No repair ledger.** Broker's write receipt is claimed once per operation id (`invocation/stage/occurrence`), which dedupes retries within one invocation. But a repair runs under a new invocation, so it gets new operation ids and new provider references (`operations.ts:144-157`). Only a ledger keyed by the original occurrence can keep two repairs, or a repair and a completed original, from both writing.
- **Reconciliation can't establish `failed`.**
  - Broker's verdicts are `applied` (every record carries this operation's mark) and `unresolved`. Absence on the provider proves nothing (`packages/broker/src/reconcile.ts:10-23`).
  - The resolution stays on the receipt and never reaches the command, whose outcome is frozen at `finish` (`commands.ts:108,119`; C6 plan: "later reconciliation advances knowledge but never rewrites a command's outcome").
- **Nothing resumes `not-reached` stages.** The worker marks them (`worker.js:188-192`) and can resume a running command from its furthest pinned input (`:167-183`), but nothing resumes them after `finish`.
- **No `materialize` anywhere.** The hook is declared (`dialect.rs:168-179`, default `None`), but no language implements it and no server route calls it.
- **No fence against overwriting newer work.** The artifact head moves only to a newer invocation, by compare-and-set on `seq` (`storage/artifacts.js:5-17`). But the command doesn't record which artifact it found, and nothing publishes an assembled result.

## 2. Decisions for the owner

Each has a recommendation; the plan below assumes it.

1. **Eligibility: recorded `failed` only, from any source.** An occurrence is eligible when its current outcome, across the original and every repair, is `failed`. That covers a definite provider rejection (receipt), a Policy refusal, and a bind refusal; none of them wrote anything.
   - **`partial` and `uncertain` are never repaired.** An `uncertain` one is reconciled first, and if every record landed it becomes `completed` (decision 2). Otherwise it stays blocked, as does a `partial` one, whose completed steps would repeat. Reconciling those is manual.
   - A refusal that would recur (`bounds-exceeded`, `intent-not-admitted`) is eligible but is refused again at the repair's admission, at no cost. *Recommended:* it is exactly the guarantee "retry only occurrences established as failed", and admission decides recurrence, not the ledger.
2. **Reconciliation feeds the ledger, and never yields `failed`.** A reconciliation `applied` verdict with `final` is written to the ledger as that occurrence's current outcome, `completed` with the recorded output. An `unresolved` one changes nothing. The command's own outcome stays frozen, as C6 decided.
   - **This amends the completion gate.** Its "or reconciled to `failed`" has no path, because no provider read can prove a write never landed. The gate becomes "recorded `failed`; `uncertain` reconciled to `completed` stops being a candidate". *Recommended:* inventing a "proved absent" verdict would contradict W5's evidence rule.
3. **A repair is its own command**, of kind `repair`, with a lease, fencing generation, idempotency key, invocation and outcome, referencing its original. It reuses B5's ownership, takeover and sweep unchanged.
   - It is started by `POST /command/{id}/repair { idempotencyKey, occurrences? }`, by the original command's owner, through the original's connection. With no `occurrences` it selects every eligible one.
   - *Recommended:* B5's machinery already guarantees what the design asks of a pending repair ("its lease and fencing generation work exactly as for commands").
4. **The ledger** is keyed `(original command, stage, occurrence)`, at `commands/{original}/ledger/{stage}:{occ}`.
   - **One transaction claims it all.** Before admission, a repair claims every occurrence it selects in one Firestore transaction. Each must be eligible (decision 1) and have no ledger entry, or only entries whose repair ended `failed`. Otherwise nothing is claimed, and the repair is refused `occurrence-claimed` (with the holding repair's id) or `not-eligible`.
   - **The entry tracks the repair's outcome.** It is written `pending` with the repair's id, then `completed`, `failed`, `partial` or `uncertain` with the repair's receipt and output, under the repair's fencing generation.
   - **One mint per entry.** A token is minted for an occurrence only while the minting repair holds its pending entry, as part of B5's fence check at mint and at authorize-execution.
   - *Recommended:* this is design §5 as written. Broker's receipt claim stays the per-invocation layer beneath it.
5. **Record every stage's output as a whole** (requirement 5), rather than per-read observations.
   - The worker installs each stage's output envelope once, by digest, in `outputs/{stage}`, for the original and for every repair. Each occurrence's output (Broker's `result`) is recorded on its outcome, and `/v1/receipts` returns it.
   - **Materialization replays these records.** A stage that ran is never re-evaluated, apart from its effect intents, below. An L0185 stage's recorded output is what it fetched then, whatever the source says now.
   - **Per-read observations stay deferred**, now as an optimization: they'd shrink records but aren't needed for correctness.
   - **A command recorded before this slice can't be materialized**, and its repairs complete the ledger only (decision 9).
   - *Recommended:* the design allows either form, whole outputs need no change in any language, and they cover every stage, effect-free or not.
6. **Materialization is a kernel replay, opted into per language.**
   - **The operation.** `/interpret` gains `operation: "materialize" { model, input, outputs }`. It runs the model against the stage's pinned input in a replay `ExecContext`. `expand` gives the same occurrence ids as the original (the pinned input fixes them). `invoke` returns the recorded output for that occurrence id, and fails if there isn't one. A system session, `observe` and every network call are refused; mode is `evaluate`, so nothing signs.
   - **The opt-in.** `Dialect::materialize` becomes a declaration, `materializes() -> bool`, true for L0176, because its effects all go through `ExecContext::invoke`.
   - **The chain.** It is materialized right to left. A stage with intents is replayed; a stage without intents takes its recorded output. A stage with neither a record nor a replay fails, and nothing is published.
   - *Recommended:* L0176's save already returns what `invoke` returns (`lib.rs:413-430`), so the replay needs no L0176-specific code, and the kernel makes "no live reads or effects" a property of the context, not of each language.
7. **Resumption.** When a repair completes the last failed occurrence of a stage:
   - that stage is materialized;
   - its output is installed as the next stage's first pinned input, by compare-and-set under the repair's fencing generation;
   - each `not-reached` stage then runs as part of the repair: the repair's invocation, the original's stage ids.
   - Their occurrences are claimed in the ledger as they are bound, in the bind transaction, because their runtime occurrences don't exist before they run. Each has no original outcome, so the claim needs no entry.
   - **A resumed stage that fails** leaves the stages beyond it `not-reached` for a later repair, and the repair's outcome aggregates them like any other.
   - *Recommended:* design §5, with the claim-at-bind rule spelled out for runtime intents.
8. **Fencing: publish as the original invocation's artifact.** When the ledger shows every occurrence of the original `completed`, the platform materializes the chain and stores the result as the **original invocation's** artifact (sequence and bindings), committed under the latest repair's fencing generation.
   - **Why this fences.** The original failed, so it has no artifact, and storing one is allowed once (ARTIFACT-01). The head moves only to a newer invocation, so a newer command that published has a higher `seq`, and the assembly never replaces it. If no newer command published, the current artifact is still the one the original found, and the assembly becomes it. That is the design's condition, enforced by the existing compare-and-set.
   - **A command that started later but hasn't finished** still wins when it publishes.
   - *Recommended:* it reuses a guard that's already tested, and needs no new "version found" field.
9. **Also materialize `completed` commands with no result** (a lost head answer). The same assembly, with no repair, runs on the owner's request: `POST /command/{id}/materialize`. *Recommended:* it is the design's "only `materialize` (B6) can rebuild it" and costs nothing once decision 6 exists. A command recorded before decision 5 can't be.
10. **Activation:** `REPAIR_L0176=on` turns on `/repair` and `/materialize` for L0176. Off, both routes answer `repair-unavailable`. The recording in decision 5 ships unconditionally first, so that commands become repairable before repair exists. *Recommended*, as the C-track flags.

## 3. Slices

1. **Record outputs** (Broker, Policy, api; no behavior change). `/v1/receipts` returns `result`. Policy's `settle` stores it on the outcome. The worker installs `outputs/{stage}` for every stage it runs. Tests:
   - settle round-trips `result`;
   - an output is installed once, and a second write with another digest is refused;
   - L0185 below L0176 records both stages' outputs.

   Released first, then soaked, so that commands run from then on can be materialized.
2. **Kernel materialize** (`languages/l0000`, L0176 opt-in). The replay `ExecContext`, the `/interpret` `materialize` operation, and `materializes()`. Tests:
   - L0176's corpus saves are materialized from recorded outputs, equal to the original answers with signing removed;
   - a missing output fails;
   - no policy, broker or network call is made (the kernel refuses each);
   - every intent-free stage that has a recorded output takes it and is never re-evaluated.

   Released as `l0176r` (and the kernel, with every language's next release).
3. **Policy: repairs and the ledger.**
   - the repair command kind;
   - the ledger;
   - the one-transaction claim, with its refusals;
   - claim-at-bind for resumed stages;
   - a mint only while the pending entry is held;
   - reconciliation verdicts written to the ledger (decision 2).

   Tests: every completion-gate behavior at the store level, including two concurrent claims (exactly one succeeds), a re-claim after `completed` (refused), and a re-claim after a failed repair (allowed).
4. **Api: the repair run.** The routes. The worker's repair path: claimed occurrences start under the repair's invocation; on stage completion, materialize, install the next pinned input and resume; on full completion, assemble and publish as the original invocation's artifact. Tests:
   - a newer published command is never overwritten;
   - a newer pending one wins when it publishes;
   - the materialized artifact equals what a clean run of the same program and inputs produced.
5. **Drive, gate and activation.** A synthetic drive with injected faults (B5's `faults.js`, never on the production service) on the canary account, meeting the completion gate:
   - failed-only selection;
   - ledger exclusion under concurrent repairs;
   - resumption of an L0176 → L0176 chain whose lower save failed;
   - materialization of L0176 over L0185 after the fetched source changed (a drive-owned source, not `l0185.graffiticode.org`'s fixtures);
   - at least 10 successful repairs.

   Then a staged activation of `REPAIR_L0176=on`, with evidence.

## 4. Completion gate (as amended by decision 2)

The plan's gate, with "reconciled to `failed`" replaced by the reconciliation rule: an `uncertain` occurrence reconciled to `completed` stops being a candidate, and one that stays unresolved stays blocked. Every other item stands: failed-only selection, ledger exclusion, resumption, materialization from recorded data under the latest repair's generation, and at least 10 successful repairs.

## 5. Out of scope

- Repairing `partial` occurrences, or `uncertain` ones that stay unresolved (manual reconciliation).
- Per-read observations (decision 5).
- Repair in the console UI (the routes are the interface; the console follows, like D3).
- Repair for languages other than L0176, until each opts in to `materializes()`; C5 (L0013) will be the next.

## 6. Risks

- **A repair repeats a write.** There are three layers:
  - the ledger's one-transaction claim, and its fence on minting;
  - Broker's per-operation claim beneath it;
  - eligibility limited to occurrences that wrote nothing.

  The drive's concurrent repairs test the first layer directly.
- **Materialization differs from the original.** It replays recorded outputs only, and the kernel refuses anything else. A test compares materialized answers with the originals over the corpus.
- **Record size.** Stage outputs are stored like pinned inputs (as text, by digest), within the same document limits. An output over the limit is recorded as too large, and that command can't be materialized; it is reported, never truncated.
- **Overwriting newer work.** Decision 8 relies on the artifact head's compare-and-set, which is already tested; slice 4 adds the newer-command cases.
