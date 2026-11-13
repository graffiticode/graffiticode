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
2. **Record outputs, and recover from them** (Broker, Policy, api). Admission records `recording: 1` (decision 11). Admission also keeps each stage's `replay` from its preflight manifest: today `pinnedStage` (`packages/common/src/contract.ts`) and the stored admission keep only the pinned fields and drop it. It is stored beside the pinned stage, not inside it, so plan digests and session bindings don't change (owner's note on slice 1, 2026-11-12). No change to a run that doesn't crash. `/v1/receipts` returns `result`. Policy's `settle` stores it on the outcome. The worker installs `outputs/{stage}` for every stage it runs, before pinning the next stage's input, and Policy refuses a pinned input that differs from the output below it. Recovery starts at the first stage without a recorded output (decision 5). Broker's save declares `resultFromEvidence`, and an `applied` final resolution carries the result (decision 2). Tests:
   - settle round-trips `result`;
   - an output is installed once, and a second write with another digest is refused;
   - L0185 below L0176 records both stages' outputs;
   - `input-not-output` is refused;
   - the crash at the output/pin boundary (fault `exit-after-output`), with the source changed and with it unavailable: recovery uses the recorded output and makes no L0185 call;
   - `resultFromEvidence(writeEvidence(p)) = run(p).result` over the corpus payloads, and an `applied` resolution of a receipt with no outcome carries the reconstructed result.

   Released after slice 1's `l0176r` is live, then soaked, so that commands run from then on can be materialized.
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
4. **Api: the repair run.** The routes. The worker's repair path: the repaired stage starts under the repair's invocation with its recorded occurrences (7a); on stage completion, install its output and the next pinned input and resume; on full completion, assemble and publish as the original invocation's artifact. Tests:
   - A completed and B failed in one stage: one provider write (B's), A's receipt and references unchanged in the output (7a);
   - a dropped outcome → reconciliation → materialization equal to a clean run, with no further write (decision 2);
   - an operation with no reconstructable output leaves the command unmaterializable, `output-unavailable`;
   - unknown-format evidence permits neither completion nor resumption (decision 2);
   - an old-revision command is refused `revision-unsupported`, a new-revision one is repaired at its own `tagUrl` (decision 11);
   - a newer published command is never overwritten;
   - a newer pending one wins when it publishes;
   - the materialized artifact equals what a clean run of the same program and inputs produced.
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
