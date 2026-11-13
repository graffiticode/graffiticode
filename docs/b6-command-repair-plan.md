# B6: command repair

**Status:** draft, revised after the owner's second review (2026-11-12). Plan item: `docs/graffiticode-interpreter-plan.md` Track B, "B6 Commands, part 2", whose entry gate C6 met (2026-11-09). Design: `docs/graffiticode-interpreter-design.md` §5 ("Repair", "Stages the original never reached", "Artifact publication after a repair") and acceptance test 13. Builds on B5 (`docs/b5-commands-plan.md`) and C6 (`docs/c6-l0176-commands-plan.md`).

**Owner's requirements (2026-11-12).** The plan makes each one explicit:
1. **Retry only failed occurrences.** Only an occurrence established `failed` is retried; a `partial` or `uncertain` one is reconciled first.
2. **Atomic claim.** Occurrences are claimed atomically, so competing repairs can't repeat a write.
3. **Resumption.** The stages the original never reached are resumed.
4. **Materialization.** The full artifact is materialized from recorded data only, with no live reads or effects, and never overwrites newer work.
5. **Recorded reads.** C3 deferred recording fetched observations. Materialization needs recorded stage outputs or read observations, so it reproduces results without fetching again.

**Owner's review of the first draft (2026-11-12).** Four gaps, each resolved below:
- **Recovery consumes recorded outputs** (decision 5). A recorded output is never fetched or computed again, including by the worker's recovery, and a crash between recording a stage's output and pinning the next stage's input is tested.
- **A repaired stage that partly completed** (decision 7a). In a stage where save A completed and B failed, the repair runs the original model on the original pinned input; A answers from its record with no provider call, and only B executes. Occurrence identities, argument bindings and the original admission's bounds are preserved and checked.
- **Materialization has its own kernel mode** (decision 6). Ordinary `evaluate` can't reach a save (L0176 returns `skipped: "evaluate"`, and without a session its brokered branch is closed), so the earlier claim that L0176 needs no change was wrong. A `replay` mode reaches recorded results, refuses every live effect, and reproduces command occurrence ids without a session. L0176 changes to take its command branch in it.
- **A reconciled save's output has a defined source** (decision 2). For L0176, Broker reconstructs the save's result from the claim's immutable evidence and persists it with the `applied` resolution. Where no output can be established, materialization is unavailable for that command; it is reported, never guessed.

The owner agreed with failed-only eligibility, removing "reconciled to `failed`" (the master completion gate is amended with it), keeping the original command's outcome frozen, and publishing under the original invocation's sequence.

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
2. **Reconciliation feeds the ledger, and never yields `failed`.** A reconciliation `applied` verdict with `final` is written to the ledger as that occurrence's current outcome, `completed`, with its output (below). An `unresolved` one changes nothing. The command's own outcome stays frozen, as C6 decided.
   - **The output of a reconciled write.** Today reconciliation returns a verdict, its evidence and `final`, not the operation's output. And in the dropped-outcome case (Broker claimed and wrote, but `putOutcome` never ran) the receipt has no `result` at all, so exposing receipt results (decision 5) doesn't fill it. So:
     - A write operation may declare `resultFromEvidence(evidence)`, a pure function of the claim's evidence, which is immutable and recorded before any provider request.
     - For L0176's save it exists. The save's result is `{ saved: true, references, questionReferences }` (`operations.ts:330-334`): `questionReferences` are the evidence's `question` records in dispatch order, and `references` its `item` records, or the question records when there are no items. Every reference was fixed by B1's mapping before the claim, so the evidence names exactly what was written.
     - When Broker creates an `applied` final resolution, it computes the result in the same create, as `result` with `resultSource: "evidence"`. A receipt whose outcome was recorded keeps that outcome's `result` as the source of truth; Broker checks the two agree and records a conflict if they don't (a bug, which blocks materialization of that occurrence).
     - `/v1/reconcile` and `/v1/receipts` return the result. Policy writes it to the ledger entry as the occurrence's output.
     - **Evidence Broker can't interpret establishes nothing.** A receipt with no evidence, or evidence in an unknown format, stays `unresolved`, exactly as Broker rules today (`reconcile.ts`, `no-evidence` / `evidence-format-unknown`). It never becomes `completed`, so it stays blocked: not a repair candidate, not counted toward its stage's completion, and nothing resumes above it.
     - **Completed with output `unavailable`** applies only when completion is independently established by an `applied`, `final` verdict, and the output still can't be (an operation that declares no `resultFromEvidence`). The occurrence stops being a repair candidate, but its stage can't be materialized, so nothing resumes above it and nothing is published. `/materialize` answers `output-unavailable`, naming it.
     - Test (slice 4): a receipt with unknown-format evidence reconciles `unresolved`; the ledger is unchanged, a repair selecting it is refused `not-eligible`, its stage isn't counted complete, and no stage above it resumes.
     - Tests: in slice 2, the property test below and Broker's persistence of the result with the resolution; in slice 4 and the drive, a dropped outcome (fault: Broker exits after the write, before `putOutcome`) → reconciliation `applied` with the reconstructed result → materialization equal to a clean run's answer, with the provider's write count unchanged. A property test checks `resultFromEvidence(writeEvidence(p)) = run(p).result` over the corpus payloads.
   - **This amends the completion gate, here and in the master plan.** Its "or reconciled to `failed`" has no path, because no provider read can prove a write never landed. The gate becomes "recorded `failed`; `uncertain` reconciled to `completed` stops being a candidate". *Recommended:* inventing a "proved absent" verdict would contradict W5's evidence rule.
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
   - **Recovery consumes recorded outputs.** Today recovery restarts at the furthest pinned input (`worker.js:167-183`). If L0185's output were recorded and the worker crashed before L0176 pinned its input, recovery would fetch again: changed data could conflict with the installed output, and an unavailable source could block recovery. So recording changes recovery:
     - The order at every boundary is: install `outputs/{k}`, then pin the input of stage k+1 from it. Policy refuses a pinned input whose digest differs from the recorded output of the stage below (`input-not-output`), so the two can't diverge.
     - Recovery starts at the first stage, in execution order, with no recorded output. Its input is the recorded output of the stage below (or its own pinned input, which must then equal that output). A stage with a recorded output is never run again, whether or not it has intents.
     - The furthest-pinned-input rule stays for commands recorded before slice 2.
     - Test: a fault `exit-after-output` (in `faults.js`, never on production) exits after L0185's output is installed and before L0176 pins its input. The source is then changed, and in a second case made unavailable. Recovery pins exactly the recorded output, makes no L0185 call, and completes; the save's args digest equals what a run without the crash produced.
   - **Materialization replays these records.** A stage that ran is never re-evaluated, apart from replaying its effect intents (decision 6). An L0185 stage's recorded output is what it fetched then, whatever the source says now.
   - **Per-read observations stay deferred**, now as an optimization: they'd shrink records but aren't needed for correctness.
   - **A command recorded before slice 2 can't be repaired or materialized** (decision 11).
   - *Recommended:* the design allows either form, whole outputs need no change in any language, and they cover every stage, effect-free or not.
6. **Materialization is a kernel `replay` mode, opted into per language.** Ordinary `evaluate` can't be used unchanged: L0176's save returns `{ skipped: "evaluate" }` before it reaches `invoke` (`lib.rs:386-390`), the kernel's `invoke` refuses every call in `evaluate` (`exec.rs:511-513`), and without a session `is_brokered` is false (`protection.rs:130-132`), so the command branch that expands occurrences is unreachable.
   - **The mode.** `Mode::Replay`, a third mode beside `present` and `evaluate`, set only by the operation below, never by a request's own `mode`.
     - **Occurrence ids without a session.** The context is a command context: it is given the stage's admitted intents from the original's recorded admission, so `is_command()` is true and `expand(intent, key)` computes `runtime_occurrence_id` exactly as the original did (`exec.rs:32-37`). That id is a pure function of the intent and its expansion key (site and ordinal), which the pinned model and input fix. No session, grant or Policy client exists in the context.
     - **Recorded results only.** The context holds the stage's recorded occurrences, `{ occurrenceId → { argd, result } }`. `invoke` in `replay` makes no network call: it answers `{ status: "succeeded", result }` when the occurrence is recorded and the call's args digest equals the recorded one, and otherwise fails the stage (`not-recorded`, `args-mismatch`). It records no effect.
     - **Nothing live.** `open_system_session`, `request_system_session` and `observe` are refused, as in `evaluate`, and nothing signs. A `use` loads no schema: the replay's schema source refuses before the compiler's own (HTTP in production) is asked, so the stage fails rather than depend on a schema's current content. `cacheable_in(Replay)` is false.
     - **A refusal halts.** Any call the records refuse (blocked, other arguments, no record) stops every later live call in the stage, in a replay or a repair's `start`, and fails the stage.
   - **The operation.** `/interpret` gains `operation: "materialize" { model, input, recorded }`, which runs the model on the stage's pinned input in a `replay` context. The intents are the admitted model's own (`model.intents`, which admission bound). `recorded` is `{ completed: { <occurrence>: { argd, result } }, blocked: [<occurrence>] }`, and a repair's `start` takes the same field (7a). The answer lists the occurrences answered from records (`replayed`, by intent). Any call the records refuse fails the stage, whatever the dialect does with the error, and so does a recorded occurrence the run never reaches (`recorded-not-reached`).
   - **The L0176 change.** `save_to_itembank` takes its command branch when `mode() == Replay`: expand the site's intent, then `protection::save` through `invoke`, which returns the recorded result. `is_brokered` becomes `is_brokered || mode == Replay` for saves only. The `evaluate` branch and the no-connection branch are unchanged. L0176's signing checks are written `mode() == Evaluate` (`lib.rs:459,509`), so a new mode would sign; they become `mode() != Present`, and the kernel's live paths (`invoke` past the replay answer, system sessions) are likewise allowed only in `present`, so any future mode is closed by default.
   - **The opt-in.** `Dialect::materialize` (`dialect.rs:168-179`) becomes a declaration, `materializes() -> bool`, true for L0176. A language opts in only when every effect goes through `ExecContext::invoke` and its command branch handles `replay`.
   - **The chain.** It is materialized right to left. A stage with intents is replayed from its pinned input and its occurrences; a stage without intents takes its recorded output. A stage with neither fails, and nothing is published.
   - Tests (slice 2): L0176's corpus saves materialize to their original answers, signing removed; a missing or mismatched occurrence fails; the occurrence ids equal the original's; a `replay` context with a Policy client present still makes no call to it (the kernel never consults one in `replay`); `evaluate` still answers `skipped`.
   - *Recommended:* the kernel makes "no live reads or effects" a property of the mode, and the per-language change is one branch, which `materializes()` makes explicit.
7. **Repair execution.**

   **7a. A repaired stage, partly completed.** In a stage with two saves where A completed and B failed, running the original model again meets A first. The ledger would refuse A's write, but the stage needs A's result to continue, and the plan must execute only B. The same mechanism as decision 6 does it, inside a live command start:
   - **What runs.** The repaired stage runs under the repair's session, on the original's admitted model at its pinned revision (the original's `tagUrl`), with the original's pinned input. A retired revision refuses the repair (`revision-retired`) before anything is claimed. An admission is never retargeted to another revision (decision 11).
   - **Recorded occurrences answer from the record.** The worker gives the start the stage's recorded occurrences that the repair didn't select: every `completed` one, from the original or an earlier repair, with its args digest and output. When the program reaches one, `invoke` answers from the record, as in `replay`: no bind, no token, no Broker call, no provider call.
   - **Selected occurrences execute once.** A selected occurrence (B) is bound under the repair's session and executed through Policy and Broker as any command occurrence, minted only while the repair holds its pending ledger entry (decision 4).
   - **Anything else stops the stage.** An occurrence recorded `failed` that the repair didn't select, or a `partial` or `uncertain` one, fails the stage with `not-selected` before any call, so a repair can't spill into what it didn't claim. An occurrence the original never bound (the original stage stopped before reaching it) is new: it is claimed at bind, as in 7b.
   - **Identities.** Occurrence ids are recomputed by `expand` from the pinned model and input, and must equal the original's. Policy's bind for a repair refuses an occurrence id the original didn't record for that stage, except a new one as above.
   - **Argument bindings.** Policy's repair bind requires the args digest to equal the original binding's for that occurrence (`binding-mismatch`); the kernel requires the same of a recorded occurrence. A mismatch fails the stage with nothing written: the model and input are pinned, so it would be a bug.
   - **Admission bounds.** A repair is never admitted afresh. Its admission references the original's, with the same models, revisions, intents and bounds, and re-checks only the authority (owner, connection, permission). An intent's `maxOccurrences` counts every occurrence of the stage, recorded or new, across the original and every repair, so a repair can't exceed what the original was admitted for.
   - **Its output.** The stage's answer is the original program's output, with A's references from its record and B's from its new write. It is installed in `outputs/{stage}` (the repair's, with the ledger as provenance), and decision 5's boundary rule applies above it.
   - Test (slice 4, and in the drive): A completed, B failed by an injected rejection. The repair makes exactly one provider write (B's), A's receipt count and references are unchanged and appear in the stage output, B's ledger entry is `completed`, and a second repair selecting B is refused `occurrence-claimed`.

   **7b. Resumption.** When a repair completes the last failed occurrence of a stage:
   - that stage's output is its answer under the repair (7a), or, when its last occurrence completed by reconciliation and nothing ran, its materialization (decision 6);
   - its output is installed in `outputs/{stage}`, then is installed as the next stage's first pinned input, by compare-and-set under the repair's fencing generation;
   - each `not-reached` stage then runs as part of the repair: the repair's invocation, the original's stage ids.
   - Their occurrences are claimed in the ledger as they are bound, in the bind transaction, because their runtime occurrences don't exist before they run. Each has no original outcome, so the claim needs no entry.
   - **A resumed stage that fails** leaves the stages beyond it `not-reached` for a later repair, and the repair's outcome aggregates them like any other.
   - *Recommended:* design §5, with the claim-at-bind rule spelled out for runtime intents.
8. **Fencing: publish as the original invocation's artifact.** When the ledger shows every occurrence of the original `completed`, the platform materializes the chain and stores the result as the **original invocation's** artifact (sequence and bindings), committed under the latest repair's fencing generation.
   - **Why this fences.** The original failed, so it has no artifact, and storing one is allowed once (ARTIFACT-01). The head moves only to a newer invocation, so a newer command that published has a higher `seq`, and the assembly never replaces it. If no newer command published, the current artifact is still the one the original found, and the assembly becomes it. That is the design's condition, enforced by the existing compare-and-set.
   - **A command that started later but hasn't finished** still wins when it publishes.
   - *Recommended:* it reuses a guard that's already tested, and needs no new "version found" field.
9. **Also materialize `completed` commands with no result** (a lost head answer). The same assembly, with no repair, runs on the owner's request: `POST /command/{id}/materialize`. *Recommended:* it is the design's "only `materialize` (B6) can rebuild it" and costs nothing once decision 6 exists. A command recorded before decision 5 can't be.
10. **Activation:** `REPAIR_L0176=on` turns on `/repair` and `/materialize` for L0176. Off, both routes answer `repair-unavailable`. The kernel support (slice 1) and the recording (slice 2) ship before it, so that commands become repairable before repair exists. *Recommended*, as the C-track flags.
11. **Two eligibility gates per command, both checked before any ledger claim.** Recording alone doesn't make a command repairable: a command keeps the L0176 revision it was admitted on, and a revision without replay can't answer completed occurrences from their records (7a) or materialize (decision 6). So a repair or `/materialize` is admitted only when both hold, and is otherwise refused before claiming anything:
    - **Compiler support, from the original's pinned revision.** The preflight manifest gains `replay: 1` when the dialect `materializes()`. Admission records each stage's manifest as today, so the original's admission says whether the revision it pinned supports replay. That is read from the record, never by asking a current revision. Any intent-bearing stage, or any stage materialization must replay, whose admitted manifest lacks it is refused `revision-unsupported`.
    - **Recording support, from the original's record.** Admission records `recording: 1` once slice 2 is live; every stage the repair or assembly needs must have its recorded output, or for the repaired stage its recorded occurrences. Otherwise `not-recorded`.
    - **Order of release.** The kernel replay ships first (slice 1), unreachable until repair is on: `replay` is set only by the `materialize` operation and recorded occurrences only by the repair path, neither of which anything calls yet. Recording follows (slice 2). So every command recorded is already on a revision that supports replay, and the window this review identified doesn't open.
    - **Unsupported commands, documented.** A command admitted before slice 1's `l0176r` release (no `replay` in its manifest), or before slice 2 (no `recording`), can't be repaired or materialized. Its failed occurrences stay reported, with manual reconciliation as before B6. `/repair` names the gate it fails. The evidence README lists the cutover revision and date.
    - Tests (slice 3, store level; slice 4, end to end): a command admitted on a revision without `replay` is refused `revision-unsupported` with no ledger entry written; the same program admitted on a supporting revision is repaired; the repair runs at the original's `tagUrl`, never the current one; a command without `recording` is refused `not-recorded`.
    - *Recommended:* releasing the kernel first closes the window, and the recorded gates make the rule enforceable rather than a matter of timing.

## 3. Slices

1. **Kernel replay** (`languages/l0000`, L0176 opt-in), released first and unreachable until repair is on (decision 11). The preflight manifest's `replay: 1`. `Mode::Replay`; recorded occurrences on the `ExecContext`, answered by `invoke` in `replay` and, for unselected occurrences, inside a live start (7a); the `/interpret` `materialize` operation; `materializes()`; L0176's save branch for `replay`. Tests:
   - L0176's corpus saves are materialized from recorded outputs, equal to the original answers with signing removed, with the original occurrence ids;
   - a missing, unreached or args-mismatched occurrence fails;
   - no policy, broker or network call is made in `replay`, even with a client present;
   - in a live start with recorded occurrences, a recorded one makes no Policy call, a selected one binds and invokes once, and an unselected failed one stops the stage (`not-selected`);
   - `evaluate` still answers `skipped: "evaluate"`.

   Released as `l0176r` (and the kernel, with every language's next release). Its revision and date are the cutover for decision 11. **Released 2026-11-13: `l0176r-rmwe83rgw-eae49e`** (from `07944db9`; [evidence](evidence/b6-repair/README.md)).
2. **Record outputs, and recover from them** (Broker, Policy, api). Admission records `recording: 1` (decision 11), only when the worker's admission request says it (the worker that records outputs does), so no command is marked recording by a worker that doesn't record, whatever order Broker, Policy and the api are released in. Admission also keeps each stage's `replay` from its preflight manifest: today `pinnedStage` (`packages/common/src/contract.ts`) and the stored admission keep only the pinned fields and drop it. It is stored beside the pinned stage, not inside it, so plan digests and session bindings don't change (owner's note on slice 1, 2026-11-12). No change to a run that doesn't crash. `/v1/receipts` returns `result`. Policy's `settle` stores it on the outcome. The worker installs `outputs/{stage}` for every stage it runs, before pinning the next stage's input, and Policy refuses a pinned input that differs from the output below it. Recovery starts at the first stage without a recorded output (decision 5). Broker's save declares `resultFromEvidence`, and an `applied` final resolution carries the result (decision 2). Tests:
   - settle round-trips `result`;
   - an output is installed once, and a second write with another digest is refused;
   - L0185 below L0176 records both stages' outputs;
   - `input-not-output` is refused;
   - the crash at the output/pin boundary (fault `exit-after-output`), with the source changed and with it unavailable: recovery uses the recorded output and makes no L0185 call;
   - `resultFromEvidence(writeEvidence(p)) = run(p).result` over the corpus payloads, and an `applied` resolution of a receipt with no outcome carries the reconstructed result.

   Released after slice 1's `l0176r` is live, then soaked, so that commands run from then on can be materialized. **Released 2026-11-13: `broker-rmwfao7du-d30ef1`, `policy-rmwfb0a6i-b1deb2`, `api-rmwfbfpg3-a8a20e`** (from `d5b0e8ab`; [evidence](evidence/b6-repair/README.md)).

   **Who may own a recording command.** A worker states `recording: 1` on every lease (renewal and takeover), and Policy gives a command admitted as recording only to such a worker (`worker-unsupported` otherwise), in the same update as the lease. A worker from before slice 2 would fetch again what was recorded, and could fail a command whose output survives (the owner's review of #384). A command admitted without recording can be owned by any worker, as before. The sweep's due list applies the same rule before its limit: a worker without `recording: 1` is never listed a recording command, so commands it can't own never fill its sweeps and hide legacy ones it can (the owner's review of 9c61320f).

   **Release, staging and rollback.**
   - **Order: Broker, then Policy, then the api.** Each is safe beside the older version of the next.
     - A Broker without this slice returns no results, and Policy records outcomes without output.
     - Policy before the api: no command is admitted as recording until the api's worker says it records, so the capability check has nothing to refuse yet.
   - **Staging the api.** A command started through the staged tag is admitted as recording. If its worker dies, the live (older) api's sweeper is never listed it, and would be refused its takeover, so the command stays `pending`, never failed or fetched again, until a recording api is live. Promote, and the new sweeper recovers it. If the staged release is abandoned, such commands (the canary account's) stay pending until the next recording api ships. They are listed as pending commands with `admission.recording: 1`.
   - **Rolling back the api** to a revision before this slice has the same effect on recording commands: they wait, pending, for a recording api, and rolling forward recovers them. The older sweeper still recovers commands admitted without recording, which recording ones never crowd out of its sweeps.
   - **Policy has a rollback floor at this slice** (`deploy.json`, policy baseline `B6-recording`, `floor: true`). Policy's guard is the only thing that keeps an older worker from owning a recording command, and recording commands can be pending, or have a publication due, at any time after the api ships. So `npm run rollback -- policy` refuses any target below the floor, with no override (`--below-baseline` included), whatever order the api is rolled back in. A Policy defect after this slice is fixed by a forward release. The floor's commit is this slice's capability-aware due selection, which is on the branch, so the PR merges with a merge commit (as #381–#383 did), keeping it an ancestor of `main`. From then until Policy is released from `main`, `release-check policy` reports the live revision below its current milestone; Policy ships first in the order above, so that window is the release itself.
   - **Rolling back Broker** is harmless: receipts stop carrying results, and outputs recorded meanwhile are absent. Those occurrences simply can't be materialized later.
3. **Policy: repairs and the ledger.**
   - the repair command kind;
   - the ledger;
   - the one-transaction claim, with its refusals;
   - the two eligibility gates, before any claim (decision 11);
   - claim-at-bind for resumed stages and for occurrences new to a repaired stage;
   - the repair bind's identity and binding checks (`binding-mismatch`), and bounds counted across the original and its repairs (7a);
   - a mint only while the pending entry is held;
   - reconciliation verdicts written to the ledger with their output, or `unavailable` (decision 2).

   Tests: every completion-gate behavior at the store level, including two concurrent claims (exactly one succeeds), a re-claim after `completed` (refused), and a re-claim after a failed repair (allowed).

   **As built** (`packages/policy`: `command-records.ts`, `commands.ts`, `policy.ts`, `app.ts`):
   - **Allocation.** `POST /v1/commands/:id/repairs { idempotencyKey, occurrences?, worker }` takes the user's token, like command allocation. Only the original's own user may call it, through the original's connection, checked live; anyone else gets `command-not-found`.
     - The repair is a command record with `kind: "repair"`, `repairOf` and `selection`. Its selection is fixed at allocation: the named occurrences, or every occurrence that is `failed` now and held by no repair.
     - With nothing to retry, an empty selection is allowed only to resume stages the original never reached, once every occurrence below them completed (7b). Otherwise the request is refused `nothing-to-repair`.
     - The checks before anything is allocated:
       1. the gates on the command itself: `not-original`, `command-pending`, `not-admitted`, `revision-unsupported`, `not-recorded`;
       2. then each selected occurrence: `occurrence-claimed`, with the holder named in the refusal's `detail`, or `not-eligible`.
     - **A key already used answers from its record**, before anything that changes as repairs run (eligibility, claims). After the owner and access checks, a key holding a repair of this original, with the original's binding (and, when the request names occurrences, the same selection), returns that repair, `reused`, whether it is allocated, admitted or finished. Any other holder of the key is refused `idempotency-key-reused`: the original's own key, a repair of another original, another selection, or a legacy invocation. A selection is at most 100 occurrences.
   - **The canonical snapshot** (`canonicalStages`; the owner's review of #386). A stage a repair runs that the original never reached, resumed by 7b, records its pinned input and output in the repair. So the original keeps a `canonical` map, written in the same transactions:
     - for each stage, the first pinned input any repair installed for it, which every later repair must pin too (`input-conflict` otherwise, checked before `input-not-output`);
     - the latest output any repair recorded for it;
     - each naming the repair that recorded it.

     The gates, the resume check and `revision-retired` read the original's stages merged with this snapshot. A failure in a resumed stage can therefore be repaired again.

     A resumed stage counts as having run only once a repair has recorded its output (the owner's review of 8c97a0d9). If a repair stopped after pinning the stage's input, the stage stays resumable, and the next repair pins the same input.

     **Reads.** `records/state` includes `canonical`. On an original, `records/input` and `records/output` resolve to the canonical record, and a new `from` field names the command it is in:
     - **output:** the latest repair's output for the stage, otherwise the original's own; `{ output: null, tooLarge: true }` when the latest is too large;
     - **input:** the original's own pinned input, otherwise the first repair's.
   - **The gates in detail** (`repairGate`, applied the same way at allocation and in the claim's transaction, over the merged stages):
     - every intent-bearing stage's admitted manifest says `replay: 1`;
     - the admission says `recording: 1`;
     - every stage that wasn't `not-reached` has a recorded output digest, or, for a stage with intents, a pinned input (a `"too-large"` output marker counts as no output);
     - every stage with a selected occurrence has its pinned input.
   - **Admission is the claim.** The worker admits a repair through the same `/admit` route, and Policy runs `admitRepair` for it.
     - Policy checks the authority again: protected execution, the connection, the user's access, and each pinned function's permission. It also checks the gates, and that every revision the repair or the assembly runs is still available, otherwise `revision-retired`. Those revisions are each intent-bearing stage's and each `not-reached` stage's.
     - Then `claimRepair` makes one transaction: it claims every selected occurrence and records the admission. Any refusal claims nothing, and is recorded as the repair's `admissionRefusal`.
     - The repair's admission is the original's, plus `repairOf`: the same plan digest, models, revisions, intents and bounds.
   - **Running under the original's plan.** A repair's session names the repair's own invocation and the original's plan. Mint and authorize-execution accept that plan for the repair's invocation only when the token's command is a repair of that invocation, whose original the plan was admitted for (`repairsUnder`).
   - **The ledger** is `commands/{original}/ledger/{stage}:{occurrence}`.
     - An entry is `pending` while a repair holds it, with `repairId`, `claim` (`admission` or `bind`), `prior`, `argsDigest`, `counted` and the earlier `attempts`.
     - When the repair finishes, the entry takes the repair's outcome for that occurrence: `status`, `source`, `receipt` and `output`. An occurrence the repair never bound, or whose bind was refused, becomes `failed`, since nothing was written for it, and a later repair may claim it again.
     - An occurrence's current outcome is its settled ledger status, otherwise the original's own.
   - **A repair's bind.**
     - An occurrence the original or any repair recorded is bound only by the repair holding it: `occurrence-claimed` if another holds it, `not-selected` otherwise.
     - Its args digest must equal the original binding's, or the earlier repair's, otherwise `binding-mismatch`.
     - An occurrence new to the stage is claimed in the bind transaction. It counts once toward the intent's bound, alongside the original's count (`repairCounts` on the original).
   - **Mint and authorize-execution for a repair** need the pending entry this repair holds: `occurrence-not-claimed` otherwise, once the repair has finished, for example.
   - **A repair's `finish`:**
     - its status counts only the stages it touched: ran, bound in, pinned an input for, or recorded an output for;
     - a repair with no operations of its own, one that only resumed stages with no effects, is `completed` when it recorded a result and every stage it touched finished (an intent-bearing one closed). Otherwise it is `failed`, since nothing was written;
     - it never makes its own publication due. Publication goes to the original's artifact (decision 8, slice 4).
   - **Reconciliation** (`POST /v1/receipts/reconcile`, from the console):
     - When an operation has an `applied` and `final` verdict, Policy writes a ledger entry for it, but only for an occurrence whose current outcome is `uncertain`: the original's own, or one a repair settled `uncertain`.
     - The entry is `completed`, `source: "reconciliation"`. Its output is the result when Broker's `resultSource` is `outcome` or `evidence`, otherwise `{ unavailable: <resultSource> }`.
     - Nothing else changes: an `unresolved` or non-final verdict, a `failed` or `partial` occurrence, and the original's frozen outcome. This is live as soon as Policy ships (the owner agreed, 2026-11-13); it only records what Broker established, and dispatches nothing.
   - **Who may own a repair.**
     - A lease, takeover and the due list take a `repairs` capability beside `recording`. A repair is owned only by a worker that states `repairs: 1` (`worker-unsupported` otherwise), and listed as due only to one.
     - The live api states no such capability, so it can never own or sweep a repair. Until slice 4's api, nothing allocates one.
   - **Reads.** `records/state` now includes `kind`, `repairOf` and `selection`, and there is a new read, `records/ledger`, which returns the original's ledger.
   - **New failure reasons:**
     - conflict: `occurrence-claimed`, `not-eligible`, `nothing-to-repair`, `revision-unsupported`, `not-recorded`, `revision-retired`, `command-pending`, `not-selected`, `binding-mismatch`, `occurrence-not-claimed`, `input-conflict`;
     - malformed: `not-original`, `kind-mismatch`.
   - **Release:** Policy only, above its `B6-recording` floor. Repair stays unreachable: no api route calls `/repairs`, and no live worker states `repairs: 1`.
4. **Api: the repair run.** The routes. The worker's repair path: the repaired stage starts under the repair's invocation with its recorded occurrences (7a); on stage completion, install its output and the next pinned input and resume; on full completion, assemble and publish as the original invocation's artifact. Tests:
   - A completed and B failed in one stage: one provider write (B's), A's receipt and references unchanged in the output (7a);
   - a dropped outcome → reconciliation → materialization equal to a clean run, with no further write (decision 2);
   - an operation with no reconstructable output leaves the command unmaterializable, `output-unavailable`;
   - unknown-format evidence permits neither completion nor resumption (decision 2);
   - an old-revision command is refused `revision-unsupported`, a new-revision one is repaired at its own `tagUrl` (decision 11);
   - a newer published command is never overwritten;
   - a newer pending one wins when it publishes;
   - the materialized artifact equals what a clean run of the same program and inputs produced.

   **As built** (api: `commands/worker.js`, `commands/records.js`, `routes/command.js`, `comp.js`; Policy: `command-records.ts`, `client.ts`):
   - **Routes,** for the command's own user, read with their token. They are on only when `REPAIR_LNNNN` is on for the language of every stage with effects, as the command's admission recorded them, whatever language the head is. So an L0176 save under an L0000 head follows `REPAIR_L0176` (the owner's review of #387). A command with no stage with effects has nothing to repair. When a route is off (the flag is unset in production), it answers `409 repair-unavailable` and runs nothing.
     - `POST /command/:id/repair { idempotencyKey, occurrences? }` allocates the repair through Policy (`POST /v1/commands/:id/repairs`) and runs it at once, as `/command` runs a command. A pending repair whose worker stopped is taken over. The answer is the command answer plus `repairOf`. A refusal carries its category's status, and Policy's `detail` when it has one, for example the repair holding an occurrence.
     - `POST /command/:id/materialize` (decision 9) answers `{ ...command, result: "available", published }`. When the command can't be materialized, the refusal names the stage, and the occurrence where there is one.
   - **The worker's repair path.**
     - Admission is `/admit` on the repair, which Policy turns into the claim. A refusal there finishes the repair `failed`, with nothing run.
     - The run reads the original through Policy's gateway reads (`readOriginal`): its state with the canonical snapshot, its models, outcomes, refusals and occurrences, and the ledger. From these it gives each occurrence a current outcome, the argument digest it was bound with, and its recorded output. The ledger now keeps each repair-bound occurrence's Broker digest (`argd`), so a later repair can answer it from its record.
     - The repair starts at the first stage, in execution order, that holds a selected occurrence or that the original never reached. Its input is that stage's canonical pinned input, otherwise the output below it.
     - If the stage below has intents and no output (its answer was lost and its writes later reconciled), that stage is materialized from its records, and its output is recorded first. The repair binds and pins nothing in that stage. Its `finish` counts the rebuilt stage as run and closed, with no operation of its own (the owner's review of #387).
     - From there, `runStages` runs as for any command, with three differences:
       - it uses the original's models at their pinned `tagUrl`s;
       - each stage's `start` carries `recorded`: every other occurrence of the stage that completed with a usable output (`{ argd, result }`); everything else the records hold is blocked, and only the repair's own claims execute;
       - its own records govern recovery above the starting stage.
   - **Publication (decision 8).** When a repair finishes `completed` with a result, Policy marks its publication due only if the original is now complete: every occurrence of the original completed, across it and its repairs, and every stage reached, counting the canonical snapshot.
     - The publication names the original's invocation and sequence (`publication.artifact`). The worker stores the result under them, so the artifact store's compare-and-set keeps a newer invocation's artifact current.
     - A repair that leaves the original incomplete publishes nothing.
   - **Materialization (decisions 6 and 9; `materializeCommand`).**
     - It needs both eligibility gates, every occurrence completed with a usable output (`not-complete` or `output-unavailable` otherwise, naming it), and every stage reached.
     - The chain is rebuilt right to left. A stage with intents is replayed through `/interpret` `operation: "materialize"` at its pinned `tagUrl`, on its canonical pinned input with its recorded occurrences; a stage without intents takes its recorded output. A stage the kernel can't rebuild refuses the request `materialize-failed`.
     - The head's data is stored as the command's own invocation's artifact. An artifact already stored for that invocation is the answer, and is never rebuilt.
   - **Capability.** The api's Policy client states `repairs: 1` on every lease and sweep, so this api owns and recovers repairs.
   - **New failure reasons** (conflict): `repair-unavailable`, `not-complete`, `output-unavailable`, `materialize-failed`.
   - **Tests.** In `packages/api/src/commands/repair.spec.js`, end to end with an in-process Policy, a receipt-keeping Broker that can reject or drop a write, and a kernel-like L0176 whose `start` answers from `recorded` and whose `materialize` acts on nothing:
     - every case listed above;
     - recovery of a repair whose worker died after its write;
     - the routes with the flag off and on.

     Policy's `repairs.spec.ts` adds the publication rule: due with the original's artifact when the repair completes the original, none otherwise.
   - **Release:** Policy first (the ledger's `argd` and the repair publication), then the api, staged with the canary, with `REPAIR_L0176` still unset. With the flag off, nothing allocates a repair, so the new paths stay unreached until slice 5's staged activation. **Released 2026-11-13: `policy-rmwfh9fjc-7e95a3`, `api-rmwfhnmt8-b8ed83`** (from `2ce14335`; [evidence](evidence/b6-repair/README.md)).
5. **Drive, gate and activation.** A synthetic drive with injected faults (B5's `faults.js`, never on the production service) on the canary account, meeting the completion gate:
   - failed-only selection;
   - ledger exclusion under concurrent repairs;
   - a partly completed stage (A completed, B failed), repaired with one write;
   - resumption of an L0176 → L0176 chain whose lower save failed;
   - a dropped outcome reconciled and materialized with no further write;
   - recovery across the output/pin boundary after the source changed;
   - materialization of L0176 over L0185 after the fetched source changed (a drive-owned source, not `l0185.graffiticode.org`'s fixtures);
   - at least 10 successful repairs.

   Then a staged activation of `REPAIR_L0176=on`, with evidence.

## 4. Completion gate (as amended by decision 2)

The master plan's gate (`docs/graffiticode-interpreter-plan.md`, "B6 completion gate"), amended in this PR: "reconciled to `failed`" is replaced by the reconciliation rule (an `uncertain` occurrence reconciled to `completed` stops being a candidate, and one that stays unresolved stays blocked). It also names the review's cases: a partly completed stage repaired with only its failed occurrence executed, a dropped outcome reconciled and materialized with no further write, and recovery that consumes recorded outputs. Every other item stands: ledger exclusion, resumption, materialization from recorded data under the latest repair's generation, and at least 10 successful repairs.

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
- **Materialization differs from the original.** It replays recorded outputs only, and the kernel refuses anything else. A reconstructed save result is checked against the recorded outcome wherever both exist. A test compares materialized answers with the originals over the corpus.
- **Record size.** Stage outputs are stored like pinned inputs (as text, by digest), within the same document limits. An output over the limit is recorded as too large, and that command can't be materialized; it is reported, never truncated. Recovery at that boundary falls back to the pinned-input rule, as for a command recorded before slice 2.
- **Overwriting newer work.** Decision 8 relies on the artifact head's compare-and-set, which is already tested; slice 4 adds the newer-command cases.
