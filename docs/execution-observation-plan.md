# Unified plan: execution observation, durable runs and A2A service jobs

**Status:** Plan, reviewed (2026-11-16). Implementation not started.  
**Spans:** `graffiticode` (backend) and `graffiticode-app` (frontend).

## Context

This plan joins together work that is specified across four documents:
- [interpreter design](graffiticode-interpreter-design.md) §9, "Execution observation contracts";
- [interpreter plan](graffiticode-interpreter-plan.md) Track E;
- the [L0188 design](l0188-language-design.md);
- the frontend [A2A design](https://github.com/graffiticode/graffiticode-app/blob/main/docs/graffiticode-a2a-design.md), §3, §4.3, §6, §7 and §8.

Each document is correct in its own scope. This plan sets the order of work, which work depends on which, and which parts can start now. It also records the rules every workstream must keep, and the decisions taken where reusing existing code carried risk.

**This plan governs sequencing and cross-cutting decisions.** Where it adds a decision (D-1 to D-6), the source documents point here. Their contract text stays authoritative for everything else.

## Baseline (from the code surveys)

**Shipped in `graffiticode`:**
- B1–B6.
- D1, D2a and D2b: `POST /command`, `/:id/repair`, `/:id/materialize` and `GET /:id` in `packages/api/src/routes/command.js`. Submission is *synchronous* for a command this request owns: `runCommand` in `packages/api/src/commands/bridge.js:61` waits for the worker before returning.
- D3/D4 for L0176, and C6.
- The command store in Policy:
  - `packages/policy/src/commands.ts` and `command-records.ts`;
  - `owned(commandId, generation)` fencing;
  - pinned inputs;
  - the per-operation outcomes in `command-outcomes.ts`;
  - the repair ledger;
  - `recordReconciliation`.
- The sweeper in `packages/api/src/commands/sweep.js`.
- The interpreter manifest, `packages/common/src/interpreter-manifest.ts` (v9).
- The error registry, `packages/common/src/failures.ts`, enforced by `scripts/test/failures-inventory.test.js`.

**Not built in `graffiticode`:**
- Track E1–E6. The only hook is `runRef: null` on the command record.
- L0188.
- Event logs, interrupts, artifact manifests and timers.

**Shipped in `graffiticode-app`:**
- `packages/core`:
  - generation jobs v2 in `generation-jobs.ts` (envelope, dispatch, lease, deadline);
  - the effects outbox in `effects.ts`;
  - idempotency claims in `idempotency.ts`.
- `sendWrite` in `writes.ts` already calls `POST /command` and polls it, through `lib/task-api.ts`.
- MCP authoring is write-free (`externalWrites: false`), with a baseline test.

**Not built in `graffiticode-app`:** service jobs, the service registry, A2A, the Learnosity MCP endpoint, and the `job_*` tools.

## Decision: `failures.ts` is the error registry

An earlier draft of design §9 invented its own category set: authentication, authorization, validation, resource, state, dependency, system. It should have been anchored to the registry that already exists and is enforced: FAIL-01, `packages/common/src/failures.ts:13`, `REASON_CATEGORIES`. §9 has been amended so that:
- **Categories.** `failures.ts` is the registry, and its five existing categories (`authentication`, `permission`, `malformed`, `conflict`, `unavailable`) stay unchanged.
  - No new categories; `not-found` in particular is deferred. Existing missing-resource reasons are deliberately classified differently: `command-not-found` is `permission` and `artifact-not-found` is `malformed`. A new wire category would need its own compatibility and information-disclosure review.
  - No second classification axis. Reason codes, typed details and the separate interrupt kinds give §9 the precision it needs.
- **Existing reasons** keep their current classifications. They are not recategorized from §9's old terms.
- **New reasons** are registered in `failures.ts`:
  - `event-not-understood` → `malformed`;
  - `event-not-applicable` and `cursor-expired` → `conflict`;
  - unsupported contract version and stale interrupt revision get reasons classified the same way, under the inventory test.
- **Policy refusals** surface Policy's own registered reasons. They are not flattened into a single `policy-refused` permission denial. §9's `policy-refused` code is removed; "refused by Policy" is described as "carries the underlying Policy reason".
- **Each reason gets typed details and recovery guidance.**
  - Guidance takes the execution context and recorded outcome into account. The same reason can call for a same-key retry before settlement and for reconciliation after an `uncertain` one.
  - A category alone never authorizes a retry.
- **Plan E1 changes** from "ship an error registry" to "extend the existing FAIL-01 registry and its enforcement tests".
- **Frontend adapters** consume the native categories and reasons, and translate them only at the protocol boundary (A2A design §6.4).

## Decisions on reuse risks

These settle the gaps a review of this plan found. Each decision has a verification gate, listed under Verification.

**D-1. Service-job idempotency outlives generation claims.**
- Service jobs use the primitives in `packages/core/src/idempotency.ts` (claim, bind, mismatch, takeover of an unbound claim) in a separate collection, `service-job-keys`.
- They don't inherit generation's fixed 24-hour TTL (`IDEMPOTENCY_TTL_MS`) or its 45-minute deadline.
- **Retention.**
  - A binding never expires while its job is not terminal.
  - After the job ends, it is kept for a documented retry window. The window is set per service and recorded in the service definition, for example 30 days.
  - Only after the window can the key be read as absent.
- **What a late retry gets.** A retry after the window is a new job, and the API docs say so. Because backend keys are persisted per step (D-5), a late retry can never reach an earlier job's backend invocation under a different key.

**D-2. A run owns itself once the handoff commits.**
- **Separate records.** A run has its own owner, lease and fencing generation, held in its own record. The command's `owned()` fencing and lease (`packages/policy/src/commands.ts`) still apply to the command record and nothing else.
- **Handoff.** In one transaction, under the command's generation, the start command commits:
  - the run record;
  - the run's first scheduling intent;
  - the command's `runRef`, which sets it to be settled by the run.

  From then on, the run's generation fences everything the run does: state, events, interrupts, manifests, and the execution tokens Policy mints for run steps. Before the handoff, ordinary command recovery applies.
- **Settlement.**
  - **Run owner settles.** A command driven by a run is settled by the run's owner, with a write conditioned on the run's generation, once the operation contract establishes its outcome. Its own lease is no longer renewed.
  - **Run continues after settlement.** Settling the command, including as `uncertain`, doesn't end the run. The run can stay in a `reconciliation` interrupt.
  - **Dispatch goes through the run.** Dispatch commands (answers, reconciliation, stop) are their own commands. Once admitted, they enqueue a run event, and the run's owner applies it.
- **Sweeper.**
  - `packages/api/src/commands/sweep.js` skips commands with a `runRef` instead of treating a sleeping run's command as abandoned.
  - Runs get their own sweep: expired run leases and overdue waits, driven by the run's recorded next wakeup.

**D-3. The service-scope claim is issued, verified and bound before any M1 write.**
- **Issuer.** The frontend's server-side service runtime, authenticated to Policy as a registered client identity. Only registered identities may assert a scope. Nothing in a request body or prompt is trusted as a scope.
  - **The registered client identity is an installation's registered caller** ([`installation-boundary-plan.md`](installation-boundary-plan.md), I-1 and I-2). The installation registry provides it, and the API attests it to Policy. The scope digest joins the admission binding beside the installation (I-4).
- **Verification.**
  - Policy checks the issuer at allocation.
  - The scope is intersected with console grants and connection policy, so it can only narrow authority.
  - Policy checks it again at every authorize-execution.
- **Binding.** The scope's digest becomes part of the command's immutable admission binding, together with identity, principal, connection, input digest, model digests and deadline. A *submission* that reuses a key with a different scope or deadline is a conflict. *Adopting* existing evidence (D-5) is a different request, and it never changes a binding.
- **Propagation.**
  - Dispatch, reconciliation and repair commands inherit the original command's scope. They may only narrow it.
  - E3 continuation grants carry the scope too.
- **Rollout guard.**
  - A scoped command record carries a required-capability marker. Policy releases and workers that can't enforce scopes fail closed on it.
  - Once a scoped record exists, the deploy tool refuses a rollback below the scope-enforcing floor, by the same mechanism as D2b.
- **Gate.** M1's exit evidence shows these refused:
  - scope escalation;
  - a preview request that tries to write;
  - an older worker processing a scoped record.

**D-4. Nonblocking submission is an implementation step (W1), not shipped behavior.**
- Allocation commits the command record together with a recoverable dispatch intent, then returns the handle and status URL.
- Execution proceeds independently: a wake hint, a worker claim under lease, and the sweeper recovering due work that was never dispatched.
- **Opt-in.** Callers choose it through the W1 contract version, so existing synchronous callers don't change. `sendWrite` already polls, so it can opt in.
- **Exit tests:** a crash after allocation and before dispatch is recovered; duplicate wakeups produce one owner.

**D-5. Existing write identities are preserved.**
- **Step keys are persisted.** A step's backend key is derived once, when the step is created, and stored on the step. Later attempts always read it back and never derive it again.
- **Adopting and submitting are separate requests.**
  - **Adopt.** Read an existing operation's evidence (identity, outcome, receipts) under its existing admission. Nothing new is attached: no scope, no deadline, no principal.
  - **Submit.** Allocate a new execution under the submitter's own binding (D-3).
- **A save head, shared across jobs.** Each save identity has one save head: a record in the `policy` database keyed by `saveWriteKey(item, task, connection)` (`packages/core/src/lib/current-connection.ts`). Every caller reads the head, never the attempt it saw last.
  - **Current attempt.** The head points at the save's *current attempt*: an attempt number and a protocol-aware execution reference, either `{protocol: "command", commandId}` or `{protocol: "legacy", invocationId}`.
  - **Attempt keys** come from the save identity and the attempt number, never from a job. Attempt 1 is the content-addressed key itself.
- **The head and the allocation commit together.** The head lives in the `policy` database, beside command records and Policy's key allocation (D2a). So one Policy transaction does all of:
  - creates or advances the head;
  - allocates the attempt's command record under its binding;
  - records the dispatch intent (D-4).

  The head therefore never points at an attempt that has no record, and the D-4 sweeper recovers any allocated attempt that was never dispatched.
- **Legacy saves are adopted as they are.**
  - **First resolution.** When the head is first resolved for a key that Policy already allocated as `legacy` (D2a), it points at the recorded legacy invocation. No command record is created, and no other invocation is allocated.
  - **What adoption reads.** The legacy invocation's broker receipts and the item's `lastWrite`, as today's legacy path reports them.
  - **Recovery** of a legacy attempt uses only its recorded legacy path, with the same key: completed operations replay from receipts, and a failed operation runs at most once. B5 and D2a preserve this.
  - **The head never advances past a legacy attempt.** A failed legacy save is recovered through its own key, never retried as a new command attempt.
- **Save steps check for existing work first.** An Assessment Authoring save step resolves the head:
  - **An attempt exists** (from the console or another service job): the step *adopts* the current attempt. It records `adopted: <execution reference>`, and the job's validators judge the adopted evidence against its own completion contract.
  - **One execution reference everywhere.** Everything that refers to an execution uses the protocol-aware reference `{protocol, commandId | invocationId}`, never a bare command id:
    - step records;
    - the save head;
    - `adoptable` refusals and adoption responses;
    - detached-job references;
    - `job_get` and A2A status.

    Status reads resolve the reference by its protocol: `GET /command/:id` for a command, and the recorded legacy evidence (receipts and `lastWrite`) for a legacy invocation. Neither kind of read starts or advances execution.
  - **No invocation exists:** the step *submits* a newly scoped command, using that same content-addressed key with the job's scope and deadline as its binding. A later console save or service job of the same content adopts it.
  - **A race:** Policy's atomic allocation decides. The first submission wins and binds the key. A later submission with a different binding gets an `adoptable` refusal carrying the winner's execution reference, and the caller adopts it. It never re-binds.
- **Retries are excluded across jobs.**
  - A save's current attempt can be retried only if it settled `failed`. That proves *that attempt* wrote nothing; it says nothing about other attempts, which is why retries go through the head.
  - **Claim.** A retry runs one Policy transaction. It compare-and-sets the head from attempt *n* (a `failed` command attempt) to *n+1*, allocates *n+1*'s command record under the claimant's scope and deadline, and records its dispatch intent. There is no window in which the head names an attempt that hasn't been allocated.
  - **One winner.** A concurrent claimant loses the compare-and-set and adopts attempt *n+1*. So at most one retry exists per failed attempt, and later adopters find the newest attempt, never the failed original.
  - A `partial` or `uncertain` attempt blocks retry. It goes to reconciliation or repair, and its existing ledger exclusions apply.
- **The console path** (`sendWrite` in `writes.ts`) uses the same head, and the same adopt-or-submit semantics. A console save after a scoped service-job save adopts it rather than conflicting.
- **An adopter observes; it doesn't own.**
  - A step that adopts doesn't own the execution. Its job's deadline and cancellation never touch that execution.
  - The rule that a job can't end while effects are pending applies to effects the job submitted.
  - **Detaching.** When an adopter reaches its deadline while the adopted attempt is still `pending`, it *detaches*. The job ends `failed` against its completion contract, with external outcome `pending`, marked `detached`, and carrying the owning execution reference (command or legacy invocation), so a caller can follow it.
  - **Cancelling.** Cancelling a job that only adopts detaches it; no stop is sent.
  - **The owner's stop.** A submitter's stop does apply to its own execution, and adopters see the settled result.
  - **A2A design amendments:**
    - §4.3: `pending` may be terminal only as a detached adopted effect;
    - §6.3: detaching is an allowed terminal path for observers;
    - §6.4: an adopter's cancel and deadline only detach.
- **Recovery keeps recorded keys.** Retrying or reconciling an existing save (an item's `lastWrite`, or a queued `connection_write` effect) uses the key already recorded there. Queued effects drain with their payload keys.
- **New key, new invocation.** Only an intentional new save gets a new invocation: a new task revision, `recompile:`, or the failed-retry case above.

**D-6. Run state, manifests and checkpoints share one transactional store.**
- **Policy's `policy` database holds, next to the command records:**
  - authoritative run records;
  - event logs;
  - interrupts;
  - artifact manifest references;
  - processing checkpoints.

  A manifest append and its checkpoint therefore commit in one transaction.
- **Chunk content** goes to object storage, addressed by digest and written before its reference commits. An orphaned chunk is harmless and collected later.
- **Named outputs get their own store.**
  - The existing API store (`packages/api/src/storage/artifacts.js`) keeps one immutable artifact per invocation, with `artifact-heads` sequencing, so several named outputs can't all be published there.
  - **The existing store is unchanged.** It still holds the program's result per invocation, read by connection and publication views exactly as today.
  - **A new store in the API's database** holds named outputs (dataset, exceptions, ...), with the sealed manifest and content digest. Its document path is `run-artifacts/{runId}/artifacts/{artifactId}/versions/{manifestVersion}`.
  - The run record (in `policy`) lists its named artifacts and their current versions, and the projection and A2A artifacts reference them from there.
- **Delivery.**
  - Each sealed manifest version reaches the new store through an outbox, as B5's publication does: at-least-once delivery, with idempotent publication.
  - Publishing a (run, artifact, version) that already exists with the same digest is an acknowledgement. A different digest is refused.

## Workstreams

**W1. Backend contract foundation.** Needs no runs, so it can start now.
- **First: the installation boundary's I1–I3** ([`installation-boundary-plan.md`](installation-boundary-plan.md)): the registry, installation context in Policy, and the API's attestation. D-3's issuer and binding build on them. Its Policy slices land after C5d's activation.
- **Errors (FAIL-01).**
  - Register the new reasons in `failures.ts`, keeping the five categories.
  - Add typed details and recovery guidance per reason. Guidance depends on context and never comes from the category alone.
  - `HttpError` (`packages/api/src/errors/http.js`) and `routes/utils.js` carry the details and guidance next to the existing `reason` and `category`.
  - Policy's `CommandRefused` keeps its specific reasons.
- **Capability declarations.** Extend `InterpreterDeclaration` with `operations` and `dispatchEvents`, and bump `INTERPRETER_MANIFEST_VERSION`.
  - Preflight in `routes/command.js` refuses undeclared new work before `allocate`.
  - An existing key bypasses the preflight and is served from its record, as B5 §6 requires.
- **Contract versions.** Add a contract-version header to `/command`. A request for an unsupported version is refused, never downgraded; an absent header gets the documented default.
- **Per-operation evidence.** `GET /command/:id` returns per-(stage, occurrence) outcomes, plus ledger and reconciliation evidence. Check what it returns today and extend only what's missing.
- **Service scope and deadline.** Command admission accepts a service-scope claim (serviceId, definition version, serviceJobId, permitted actions, limits) and a deadline. They are issued, verified, bound and guarded during rollout as in D-3.
- **Nonblocking submission.** The opt-in dispatch-and-return path from D-4.

**W2. Run substrate (E1, E2).**
- **Run records.** A run record behind `runRef`, with `stateVersion`, its own owner and lease, and its own fencing generation. The run takes over from the command at the handoff in D-2, and its records live in the `policy` database (D-6).
- **Event log.** A per-run event log whose monotonic sequence is committed in the same transaction as each transition, with a delivery record per consumer.
- **Interrupts.** Interrupt records with id, revision, kind, resolver, schemas and expiry. A missing pinned revision raises a `dependency` interrupt.
- **Artifact manifests.** Manifests next to `storage/artifacts.js`:
  - immutable chunks with ordinals;
  - each append committed atomically with its checkpoint;
  - idempotent replay;
  - sealing with a content digest.
- **Timers and recovery.** Persisted timers and overdue-wait recovery, built by extending `sweep.js` and the scheduler rather than adding a new engine.

**W3. Continuation authority (E3).** The continuation grant also carries the W1 service-scope claim and the deadline. Policy re-checks revocation on every wakeup, and a revoked grant raises an `authorization` interrupt.

**W4. Run reads (E4).**
- explicit run selector;
- authorized run listing (`updatedAfter`, page token);
- snapshot plus `after=<sequence>` polling, with a `cursor-expired` reset;
- the credential-free agent status representation;
- the View's workflow update path, with presentation refresh ordered per audience and outside the run lease.

**W5. First L0188 operation and its gates (E5, E6).** The L0188 Rust dialect, one operation (a narrow pilot job or the cohort rescore), its broker handlers and registry entries under P1b, and the E6 recovery drills.

**W6. Frontend service jobs.** Can start now, on immediate commands.
- **Service registry.** Versioned service definitions in `packages/core`.
- **Job store.** `service-jobs/{jobId}`, reusing the lease and claim patterns in `generation-jobs.ts` and the outbox in `effects.ts`. Deadlines come from the service definition, not generation's constants. Key bindings follow D-1. Each job keeps a per-job event sequence, committed in the same transaction as its transitions.
- **Derived keys:**
  - (job, step) for a start;
  - (job, answer submission) for an answer;
  - (job, cancel request) for a cancel.

  Keys are immutable per attempt and persisted when the attempt is created (D-5). Save steps resolve the shared save head instead of keeping their own attempts.
- **Outcomes and completion.**
  - External outcomes aggregated per operation from W1's evidence (A2A design §4.3).
  - Completion validators decide whether the service succeeded.
  - The deadline is sent into admission.
- **First consumer.** Assessment Authoring's explicit save, an L0176 immediate command. It runs alongside the console path in `writes.ts` and shares its keys and receipts (D-5).
- **Later.** Runs (after W4): the job stores run references and the last cursor it consumed, and maps the run's lifecycle classes and interrupts (A2A design §6.3).

**W7. Protocol adapters.**
- **MCP first.** A Learnosity MCP endpoint with `assessment_*` tools, `data_plan`, and `job_get`, `job_continue` and `job_cancel`. The existing `create_item` and `update_item` and their no-external-writes baseline are unchanged.
- **A2A pilot.** Two cards, one HTTP binding, Get Task by polling, input-required continuation, and cancel.

**Later.** Replay streams, webhooks, the MCP Tasks extension, A2A streaming and push, exposing B6 repair to callers, signed release records, and further L0188 operations.

## Milestones

| Milestone | Contents | Depends on | Exit evidence |
| --- | --- | --- | --- |
| M0 | Docs: this plan, the §9 error correction, the pointers | — | Merged |
| M1 | W1 (including scope from D-3 and nonblocking submission from D-4) and W6 on immediate commands; W7 MCP for authoring and `data_plan` | B5 and B6 (shipped) | Authoring save through a service job shows the right outcome for completed, failed, partial and uncertain saves; D-1, D-3, D-4 and D-5 gates; the no-writes baseline stays green |
| M2 | W2, W3 and W4 (Track E substrate) | M1's W1 | Run, event, interrupt and manifest tests; D-2 and D-6 gates; cursor reset; presentation refresh with no owner |
| M3 | W5, plus W6 on runs and the Data Operations skill | M2 | E6 drills; job state and outcome mapping exercised over a live run |
| M4 | W7 A2A pilot | M1 for the authoring and planning skills; M3 for data skills | Interop with the named client: discovery, auth, retrieval, continuation, cancel |

M2 and the M4 pilot for authoring can run in parallel.

## Rules every workstream keeps

1. Only Policy and Broker settlement determines an outcome. Errors, timeouts and deadlines never do.
2. Run state decides whether work continues, validators decide whether the service succeeded, and per-operation evidence decides the external outcome.
3. **Keys are derived, and immutable per attempt.**
   - A new attempt exists only through an explicit, atomic head claim after its predecessor settled `failed` (D-5).
   - Regenerating code after the first start never produces a new key.
4. An existing key is always served from its record, whatever the manifest or flags say now.
5. Event sequence, `stateVersion`, presentation refresh order and listing cursors are four different things and are never interchanged.
6. **Durable artifacts, event logs, agent status and other agent-readable records never carry credentials.** Three exceptions are explicit:
   - credential storage protected by the Broker;
   - approved continuation grants held by Policy (E3);
   - authorized browser presentation responses bound to an audience, which carry temporary credentials under `no-store` (the `present` result and E4 refreshes, as the L0188 projection contract allows).

   Credentials never reach a durable or agent-readable surface.
7. Reads never start or advance work.
8. The backend owns the contracts. Adapters translate them. Service jobs coordinate work and own completion.

## Verification

- **M0:** `git diff --check`; the links resolve on `main`.
- **W1:**
  - `failures-inventory.test.js` covers every new reason;
  - existing reasons keep their classifications (a snapshot of `REASON_CATEGORIES` before and after);
  - Policy refusals reach callers with their original reason;
  - preflight refuses undeclared work without allocating, and an existing key still replays when its declaration has been removed;
  - an unsupported version is refused;
  - per-operation evidence matches the ledger and reconciliation records.
- **D-1:** retrying a job after more than 24 hours, while it is live or within its window, returns the same job and the same persisted backend keys.
- **D-2:**
  - the handoff is atomic;
  - an `uncertain` initiating command with its run in a `reconciliation` interrupt stays resumable, and the run's owner applies the reconciliation dispatch;
  - the command sweeper doesn't reclaim a sleeping run's command;
  - the run sweep resumes an overdue wait;
  - a stale run owner's writes and token requests are refused.
- **D-3:**
  - scope escalation, preview-to-write and a changed scope on key reuse are refused;
  - repair and dispatch inherit the scope and can only narrow it;
  - an older worker fails closed on a scoped record;
  - a rollback below the scope floor is refused.
- **D-4:** opt-in submission returns before the worker runs; a crash between allocation and dispatch is recovered by the sweeper; duplicate wakeups produce one owner; synchronous callers are unchanged.
- **D-5:**
  - **Console first, then a service job:** the job adopts the console invocation. Its admission is unchanged (no scope added), and the job's validators judge the evidence.
  - **Service job first, then the console:** the console adopts the scoped invocation without conflict. The original scope and deadline are unchanged.
  - **Two service jobs with different scopes or deadlines:** one submission wins allocation, the other gets `adoptable` and adopts it, and the winner's binding is unchanged. A concurrent race produces the same result.
  - **Concurrent retries:** two jobs that adopt the same `failed` attempt both try to retry. One wins the head and submits attempt *n+1*; the other adopts it. Exactly one write results.
  - **Adopting after a successful retry:** a later job or console save resolves the head to the successful retry, not the failed original.
  - **A crash between claiming the retry and submitting it:** the head, the attempt's command record and its dispatch intent are either all present or all absent. If present, the sweeper dispatches the attempt and later callers adopt a real command.
  - **Migrating a legacy save:** an existing `legacy`-allocated save key, resolved for the first time by a service job, gets a head with a legacy reference. Adoption reads its receipts, no command record or new invocation is created, and a retry with the same key stays on the legacy path. The same test also checks that:
    - the step record and `job_get` carry `{protocol: "legacy", invocationId}`;
    - an authorized status read through that reference returns the legacy evidence without starting or advancing execution;
    - the deadline and cancel both detach the job, with the legacy reference, without touching the invocation.

    This sits beside the console-first test.
  - **Blocked retries:** a `partial` or `uncertain` attempt is never retried through the head.
  - **An adopter timing out:** it detaches (`failed`, external outcome `pending`, `detached`, referencing the owner) while the original keeps running to its own settlement. Cancelling an adopter sends no stop.
  - Retrying an existing `lastWrite` or a queued `connection_write` effect keeps its recorded key and receipt.
- **D-6:**
  - an append and its checkpoint commit together, and replaying an append returns the existing version;
  - an orphaned chunk is never referenced;
  - a dataset artifact and an exceptions artifact from the same run publish separately without conflict;
  - the existing per-invocation publication is unchanged;
  - a crash after the destination write but before the outbox acknowledges it, followed by redelivery, ends in one publication: the same digest is acknowledged, and a different digest is refused.
- **W2–W4:** run the E-step acceptance criteria and E6 drills. Add tests for:
  - several events from one transition;
  - replay after a crash mid-append;
  - an expired cursor.
- **W6:**
  - tests in `packages/core` for the outcome aggregation table, the state mapping (an uncertain command with a reconciliation interrupt makes the job interrupted, not failed), stable answer-submission keys, and deadline handling with the backend unreachable;
  - `tests/baseline/mcp-no-external-writes.test.ts` stays green.
- **W7:** A2A card and payload validation against the pinned SDK; one end-to-end interop run.

## Open decisions (recorded in the doc)

Wire shapes; the run selector's name; how a calling agent's identity maps to an end-user delegation; the A2A pilot client and SDK version; the first L0188 operation.
