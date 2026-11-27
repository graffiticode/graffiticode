# C4: runtime and lifecycle decisions

**Status:** policies **selected** (owner, 2026-11-27). The owner selected the primary proposal of each of §2–§9; §10 records the selections. The withdrawal alternative (§6) and every other alternative are **not selected**. Selection approves the policies only, not their production implementation. The emulator harness covers the selected settlement, namespace pin and index, ordered recovery, and retained-descriptor behavior (`docs/evidence/interpreter-c4-l0182/continuation-harness/`, `lifecycle.harness.mjs`). Merged 2026-11-27 as a draft (#488), first written as a proposal (2026-11-26). This document approves no implementation, migration, backfill, reset or release. The ten verified eval-only reset candidates from slice 0 get **no automatic reset** under any proposal here. C5d and its legacy command remain held.

**Sources:**
- `docs/c4-l0182-assignment-plan.md`: decisions 3–7 and 10–12, §5 and §6.
- `docs/c4-continuation-race-review.md`: §3 (shared machinery), §5 (option (c)), §6 (floors and draining), and §8 (decisions that remain).
- `docs/evidence/interpreter-c4-l0182/continuation-harness/`: the emulator evidence for option (c).
- `docs/evidence/interpreter-c4-l0182/slice0-inventory.md`: the production counts quoted below.
- `graffiticode-app` `docs/respondent-sessions-proposal.md` (merged as a draft at `2a58aaf9`): §4.3 and §4.4.

## 1. Accepted (recorded, not reopened)

1. **Protocol (c)** (owner, 2026-11-25). Bindings and continuation operations live in the api's Firestore:
   - `respondent-bindings/<S>`;
   - `respondent-binding-history`;
   - `respondent-operations/<opId>`;
   - `l0182-continuation-barrier`.

   Items, their lock states and the console tombstone `continuation-ops/<opId>` stay in the console's Firestore. The steps are C0 register, C1 allocate, C2 bind-prepare, C3 finalize, C3a finalized ack, C4 activate, C5 unlock, and C-cancel, exactly as tabled in the race review §5. Options (a) and (b) are not pursued.
2. **Publication at ready.** C4 activate is the point of no return. It publishes authority while T is ready (finalized, still locked), and makes three writes in one api transaction: the active binding, history entry n+1, and the operation's result. C5 unlock then allows console edits. No extra api step after unlock.

   **Two kinds of record:**
   - **The current binding pointer,** `respondent-bindings/<S>.active`, is mutable. Each activation overwrites it, so it always names the current revision.
   - **The per-revision descriptor,** history entry `<S>:<n>`, is immutable. Written once, it holds that revision's principal, destination, `opId` and time.

   The pointer says which revision applies now. The descriptor says what that revision granted.
3. **Direct API-store authority reads.** The submission's freeze transaction (S4) reads `respondent-bindings/<S>` itself:
   - `prepared` → temporary `respondent-continuing`, from either principal;
   - `active` → the caller must equal `active.principal`, compared on every field, and the freeze records `active.revision`;
   - absent → the item-derived principal from S2, with the binding still absent inside S4 (revision 0).

   The console's `respondent-authority` route is therefore consulted only for **unbound** sessions. For bound sessions there is no mirror and no HTTP round trip inside the decision.
4. **#487's merged evidence.** The emulator-only harness was merged at `b7bec360`, from head `a2cb01ad`, as evidence only. CI run 45732426161 passed as the emulated target `c4-continuation-harness`, with 48 tests and no `allowSkips`.

   The harness implements every option-(c) step as one transaction in one of two distinct emulator projects. It also covers:
   - the creation barrier and tombstones;
   - readiness acknowledgements;
   - cancellation against finalize and activate;
   - frozen resubmission by the current respondent;
   - claim caller and destination binding;
   - refused-child persistence across crashes and resumptions;
   - the verified drain and the floors.

   It does **not** model the subjects of this document: deletion and expiry, sessionless programs, balancing, content changes, the recovery runner, acknowledgement transport, or canary routing. Any harness extension for them is a separate emulator-only PR.

**Unchanged:** the api assigns at run time (decision 1), and identity is `(survey ref, session)` (decision 2). Respondent authority is separate from item authority, which C5 keeps unchanged (decision 3). Migration and backfill classification (decision 10) stays a separate decision, outside this document.

## 2. Sessionless programs (plan decision 4)

**Constraint from §1:** submission needs a respondent principal. With no session there is nothing to look up, so a sessionless occurrence can never be submitted by anyone. Slice 0 found **1** current-vocabulary sessionless occurrence. The console proposal refuses revisions of existing sessionless programs until this decision is made, or until the owner starts an explicit new response.

**Selected (2026-11-27): sessionless occurrences are stateless reads, handled entirely in the language.** No implicit respondent identity is created for them.
- **The pick:** the candidate at index `sha256(model digest ‖ survey ref ‖ ordinal) mod n`, over the current candidates sorted by instance name. The ordinal counts that ref's sessionless occurrences in evaluation order.
- **Nothing is requested or written.** The occurrence isn't reported in `needsAssignment`, so the api creates no record, touches no draw cycle, and freezes nothing. A `response` in it is validated and served as a read.
- **Not balanced**, since there is no respondent to balance for.
- **Zero candidates** gives today's "no survey" error, with today's wording.
- **Stability:** it is stable for one model and candidate set. A release that adds or removes a version of that survey can change the pick. That is acceptable only because nothing about it is ever frozen; the release's PR names the affected surveys.
- **Deliberate differences:** this changes today's draw-without-replacement between repeated sessionless occurrences (plan decision 2). The difference is pinned by tests and listed in slice 2's gate.

**Alternatives:**
- **Refuse** a sessionless program at interpret: `survey-needs-session`. This newly breaks a program that compiles today, the 1 found included.
- **Keep a record per identity** `(survey ref, model digest, ordinal)` from the first read. It is balanced but never submittable, so it writes without a reason.

## 3. Balancing the draw (plan decision 5)

**Scope from slice 0:** only 2 installed surveys have more than one version (`civic-priorities` with 12, `workplace-pulse` with 3), covering about 29 identities. Named versions never draw.

**Selected (2026-11-27): today's draw without replacement, made durable.**
- **State:** `l0182-draw-cycles/<survey id>` = `{ cycle, taken: [instance…], candidates: [instance…] }`. The canary namespace keeps its own copy (§9).
- **Creating an unfrozen assignment for a bare id** reads and updates the cycle in the same transaction as the record, which also checks the cutover state:
  - it restricts `taken` to the current candidates;
  - if every current candidate is taken, it clears `taken` and increments `cycle`;
  - it picks uniformly among the untaken current candidates, using the api's CSPRNG;
  - it records `{ instance, digest, cycle, drawnAt }` on the assignment.
- **Reassignment** follows the same steps, for a removed version (§4) or a resolution that asks for a fresh draw.
- **Throughput:** one document per survey, far inside Firestore's ~1 sustained write/s per document at L0182's traffic. Contention retries are Firestore's, bounded by the stage's existing retry and `assignment-contended` (decision 7).
- **Randomness lives only in the api,** so interpretation stays a pure function of model, input and table.

**Alternatives:**
- A **uniform random pick** with no cycle document: no hot document, no balance.
- **Least-assigned** by sharded counters: balanced across releases, at more write cost and code.

## 4. Content changes and removed versions (plan decision 6)

**Selected (2026-11-27)**, per record state:

| Change in a release | Unfrozen record | Frozen record |
|---|---|---|
| Version added | no effect | no effect |
| Assigned version removed | fresh draw (§3), in the transaction that observes it | retained content from `l0182-survey-models/<digest>` |
| Same instance, new digest | keep the instance; move to the new digest, appending `{ from, to, at }` to `digestHistory` on the record | retained content; the frozen digest never changes |
| Every version of a bare id removed | the record is kept; the occurrence gives today's "no survey" error | retained content |
| Named version's file removed | as above | retained content |

**Why:** an unfrozen record has no submitted answers. So moving to new content changes only what is shown next. The view of a respondent mid-answer can shift, and that is accepted.

**Release rule (proposed):** a change to an installed survey's content is a reviewed release. Its PR lists the surveys and counts the unfrozen identities that would move. Survey data hasn't changed since 2026-09-22.

**Alternatives:**
- treat a new digest as a removal: a fresh draw, more churn for the same respondent;
- refuse any release that changes the content of an assigned version: content stays fixed, and fixes ship only as new versions.

## 5. Retention

**Selected (2026-11-27):** every C4 record is kept for as long as tasks are, which is forever, except where noted. No time-based expiry of cancellation tombstones.

| Record | Store | Retention | Why |
|---|---|---|---|
| `l0182-assignments` (frozen and unfrozen) | api | forever | tasks are kept forever; a frozen record is the answer's model |
| `l0182-survey-models/<digest>` | api | forever, immutable, content-addressed | the only copy once a version is removed |
| `l0182-draw-cycles` | api | current state only (overwritten) | it holds no history of who drew what; the assignment records that |
| `respondent-bindings/<S>` (the mutable current pointer) | api | forever, overwritten only by activation (or withdrawal, §6 alternative) | the R-api floor reads it |
| `respondent-binding-history/<S>:<n>` (immutable per-revision descriptors) | api | forever, never rewritten | I3 needs history 1…k; the descriptor is what revision n granted (§6) |
| `respondent-operations` (terminal included) | api | forever | I6: replay answers from them regardless of later rebindings |
| `respondent-operation-settlement/<opId>` (§7) | api | forever | bookkeeping only; outside I6, and never read by a replay |
| `respondent-operation-index/<opId>` (§9) | api | forever, create-only | pins an operation's namespace across retries and configuration changes |
| `l0182-session-namespace/<S>` (§9) | api | forever, create-only | pins a session's namespace |
| `continuation-ops/<opId>` tombstones and records | console | forever | a delayed C1 has no proven time bound; the tombstone is what refuses it |
| `l0182-task-quarantine`, `l0182-resolutions`, cutover state | api | quarantines until resolved; resolutions forever | the audit trail |
| canary counterparts (§9) | both | as production; deletable only by a separately approved canary cleanup | canary-owned records only |

**Cost:** one small document per assignment, survey version, binding revision and operation. At L0182's volume (slice 0: thousands of identities, almost all eval), this is negligible.

**Alternative for tombstones:** expire a `cancelled` tombstone after a bound on any C1's lifetime. That bound would be the console's request timeout plus retry budget, plus a margin, and only after a verified drain shows no operation older than the bound. Choosing it needs that bound proven, not assumed.

## 6. Deletion and expiry after unlock

**The gap** (race review §3): I4 requires that a binding granting authority name an existing destination T, with `respondentSession = S`, that is at least ready. Nothing yet says what happens when T, or the item S of an unbound session, later goes away.

**How items go away today** (`graffiticode-app` at `2a58aaf9`):
- **Archive.** Item "deletion" is archive. `DELETE /items/:id` in `packages/openapi-server` (operation `archive_item`) sets `mark: 5` through `updateItem` (`packages/core/src/items.ts`), the same function the console uses to set an item's mark. It is a field update. The document and its history stay.
- **Free-plan expiry is enforced on read.** An unclaimed free-plan item carries `expiresAt`, 48 hours by default (`freePlanItemTtlMs`, `packages/core/src/lib/free-plan-context.ts`). Readers skip it once that has passed (`items.ts`, `claims.ts`). No Firestore TTL policy covers items (`packages/core/src/storage-ttl.ts`), so the document remains. A claim removes `expiresAt` from the claimed copy.
- **Account deletion.** `DELETE /api/user/<name>` deletes the `users/<uid>` document only. Firestore doesn't cascade, so `users/<uid>/items/*` remain.
- **No code path hard-deletes an item.**

**Selected (2026-11-27): a minimal retained destination record. Authority lives in the binding, not in T's continued existence.**
- **The descriptor is per revision and immutable.** C4 writes history entry `<S>:<n+1>` = `{ revision n+1, principal, destination: T, opId, readyAt }`, where `readyAt` is the C4 commit time. It is written once in C4's transaction, never rewritten, and kept forever (§5). It is the **destination descriptor** for revision n+1.
- **The pointer is mutable.** In the same transaction, C4 sets `respondent-bindings/<S>.active` = `{ revision n+1, principal, opId, destination: T }`, a copy of the descriptor's fields, so S4 needs one read. A later activation overwrites the pointer with revision n+2 and writes descriptor n+2. Descriptor n+1 is unchanged and still answers what revision n+1 granted, for audits and for freezes that recorded n+1 (I2).
- **I4 is restated:** at activation, T existed and was ready, which the finalized acknowledgement proves. From then on, the descriptor for the pointer's current revision is the authority. T's later archive, expiry, unpublishing or removal doesn't change who may submit for S.
- **Submissions:** S4 reads only the pointer (§1.3). An archived T doesn't withdraw authority. The respondent can still submit through any path that carries S and attests their full principal. Frozen records keep their attribution and models regardless.
- **Unbound sessions:** authority is derived from the item whose id is S, through the console's `respondent-authority` route:
  - **Archive** (`mark: 5`) doesn't change the answer.
  - **Free-plan expiry** doesn't change it either. The route answers from the stored document whether or not `expiresAt` has passed. Expiry hides the item from listings and from claims, so in practice the respondent can no longer reach it, but authority is unchanged.
  - The route must not apply the listing readers' expiry filter.
- **Constraint on future lifecycle changes:** adding a hard delete or a TTL policy for items is a lifecycle change. So is cascading account deletion, or any purge. Each needs its own approved contract, either preserving the descriptor's guarantees for unbound sessions or adopting the alternative below for the affected path. Until then the console's write paths may archive but not remove an item that:
  - carries a `respondentSession`;
  - is named by a binding;
  - or is the source of a continuation.

  This matches the K-console floor.
- **Continuation sources:** a source X in `read-only{opId}` may be archived or expire like any item. Authority has already moved to the binding.
- **Cost:** a respondent keeps authority over S after hiding T. That is consistent with authority belonging to the principal, not the item. It needs no new cross-store protocol.

**Alternative, not selected (2026-11-27): authority withdrawal ordered against submissions.** It stays here as the reviewed design a future removal contract could adopt; nothing implements it. Removal of an item holding authority withdraws that authority through an api-ordered protocol, in the shape of option (c). The withdrawn item W is:
- **bound case:** the destination T named by the current pointer, at revision n;
- **unbound case:** the item whose id is S, at console version v, with **no** binding document for S. There is no revision and no bound destination.

**Who may withdraw.** Checking state is not enough: the request must prove permission over S. A frontend's or worker's service authentication identifies the caller, but never by itself grants that permission. Every withdrawal names exactly one **actor**, and its **action proof** is part of the request digest. So a replay with a different actor or proof is `operation-mismatch`.

- **The verified respondent.** The caller principal is built at ingress as in decision 3: the verified user token, plus an attested installation and workspace from a registered frontend.
  - **Bound:** it must equal `active.principal` on every field, inside W0's transaction.
  - **Unbound:** the api first calls the console's `respondent-authority` for S. Only `{ bound: false, principal }` whose principal equals the caller proceeds. `unknown`, `ambiguous`, or a `bound: true` answer (a binding the api's store doesn't yet show) is refused with `respondent-unknown`, `respondent-ambiguous` or a temporary `respondent-authority-unavailable`, and nothing is registered. The answer is recorded in the basis, and W1 re-proves it in the console's transaction (below).
  - **Proof in the digest:** `{ kind: "respondent", principal }`.
- **A scoped lifecycle worker.** A separate service identity, listed in `C4_LIFECYCLE_WORKERS`, distinct from the frontends' identities and from the runner's. It may register only these events, each with evidence that W1 re-checks in the console's transaction:
  - **`expiry`:** unbound sessions only. W is the free-plan item S, unclaimed, whose stored `expiresAt` is at or before W1's transaction time. A bound T has no `expiresAt` (a claim removes it), so a worker `expiry` on a bound session is refused.
  - **`account-deletion`:** a recorded deletion, `account-deletions/<uid>`, written by the deletion path. The authority's principal must be that uid's `user` principal: `active.principal` when bound, or the unique holder of S when unbound. A free-plan principal is never matched by uid alone.

  Proof in the digest: `{ kind: "worker", identity, event, evidence }`, where `evidence` is `{ expiresAt }` or `{ uid, deletionRecordId }`.
- **Anyone else** is refused, including a frontend identity without a verified respondent, and the runner. The runner may only roll forward or cancel an operation that already exists.

A withdrawal is an operation in `respondent-operations/<opId>`, with `kind: "withdraw"`. Its states are `withdraw-registered` → `completed`, or `cancelled`. Completed and cancelled are terminal. The console mirrors it in `continuation-ops/<opId>`, as for continuations.

| Step | Transaction | Expected phase and guards | Atomic writes | Replay | Recovery |
|---|---|---|---|---|---|
| **W0 register** | api | barrier `open`; no record for `opId` (or the same digest, **actor and proof included**); the actor is permitted (above); **bound:** `active.revision == n`, `active.destination == W`, not withdrawn, `prepared` absent, and a respondent actor equals `active.principal`; **unbound:** no binding document for S, W's id equals S, and the pre-read answer was `{ bound: false, principal }` (never `unknown` or `ambiguous`) | the operation `withdraw-registered{ basis, actor, proof }`, where basis is `{ bound, n, W }` or `{ unbound, S, v, principal }` | the same digest returns the registration | nothing has moved |
| **W1 lock** | console | W0's result for `opId`; **no `cancelled` tombstone** for `opId` (read in this transaction); **bound:** W `active`; **unbound:** W `open` at version v, **held uniquely** (no other holder) by the basis principal, with that principal's workspace for a free-plan item; **worker evidence** re-checked here (`expiresAt` passed and unclaimed, or the deletion record present for that uid) | W `withdrawing{opId}` (no answers, edits, deletion, or use as a continuation source); the console operation `locked` | a no-op if already locked by this `opId` | W-cancel |
| **W1a locked ack** | api | the operation `withdraw-registered`; the acknowledgement's `opId`, W and basis match | the operation records `ack.locked` | a no-op if identical; a mismatch is refused | retry the ack, or W-cancel |
| **W2 withdraw** — *point of no return* | api | the operation `withdraw-registered` **with `ack.locked`**; **bound:** `active.revision == n`, `active.opId` unchanged since W0, `prepared` absent; **unbound:** still no binding document for S | the pointer `active = { withdrawn: true, revision r, opId }`, where r is n+1 bound or 1 unbound (unbound: the binding document is created); immutable descriptor `<S>:<r>` = `{ revision r, withdrawn: true, item: W, opId, at }`; the operation `completed` with result `{ revision r, withdrawn: W }` | `completed` returns its recorded result; `cancelled` returns its cancellation, with no writes | after W2, only roll forward (W3) |
| **W3 remove** | console | W `withdrawing{opId}`; the api operation `completed` (W2's result) | W `withdrawn{opId}`, a **terminal** state replacing the transient lock, and also archived (`mark: 5`); the console operation `completed` | a no-op once W is `withdrawn{opId}` | rolled forward by replay or the runner (§7) |
| **W-cancel** | api, then console | api: the operation `withdraw-registered`, **not** `completed` | api, first: the operation `cancelled` with its reason, **terminal**. Then the console, in one transaction: the tombstone `continuation-ops/<opId> = cancelled` (created even if W1 never ran), and W `withdrawing{opId}` → its prior state | a no-op once cancelled; a delayed W2 finds the terminal record and is refused; a delayed W1 finds the tombstone and is refused | never touches another `opId`'s lock; impossible after W2 |

**The terminal item state `withdrawn{opId}`** keeps every restriction of the lock, permanently:
- no answers, regenerations, edits, or use as a continuation source;
- no un-archive. Setting `mark` back from 5 is refused, so archive is not the only guard;
- no hard deletion unless a future approved contract allows it.

It is not a transient state. The runner's cross-check and the drain count `withdrawing`, never `withdrawn`, so a completed withdrawal is never found again as unfinished. The K-console floor covers `withdrawn` like `read-only`: a console below it would ignore the state.

**How it orders against the rest of (c):**
- **Against submissions.** S4 reads the pointer. A freeze that commits before W2 keeps its freeze and attribution (I2). After W2, `active.withdrawn` refuses it with the permanent `respondent-withdrawn`. In the unbound case, S4's "absent" branch requires the document still absent, so it conflicts with W2's creation and, retried, is refused. Until W2, submissions aren't paused: the order is the api transaction, as with activation.
- **Against continuations.** W1 locks W, which is the only item a continuation of S may use as its source: T when bound, S's item when unbound. So C1 can't allocate on it. A continuation that allocated first makes W1's guard fail, and the withdrawal is cancelled. W0 and W2 require `prepared` absent and the revision unchanged, so a continuation that prepared or activated in between makes the withdrawal fail too. After W2, C0 refuses any continuation of S (`respondent-withdrawn`): an unbound C0 needs revision 0, and a bound one needs a principal.
- **Final:** a withdrawn session is never re-bound. Its frozen records stay readable.

**What drives it:**
- **Expiry needs a writer.** Read-side expiry never runs W0–W3, so a sweeper must drive it for expired items holding authority, or authority stays until it does.
- **Account deletion** drives one withdrawal per affected session.
- **The drain** (§8) also counts:
  - non-terminal withdrawals;
  - items in `withdrawing`;
  - missing tombstones;
  - outstanding `locked` acks.

**Costs:**
- every removal of an L0182 item that holds authority becomes a multi-step cross-store protocol;
- the drain and floors grow by one operation kind;
- the harness must be extended to cover W0–W3 before any write path relies on it.

## 7. Recovery

**Selected (2026-11-27), with three parts.** The 15-minute threshold and 5-minute interval are selected as healthy-service targets, a finalized continuation is rolled forward, and a racing submission gets a temporary refusal, not a queue. The rows for withdrawal operations apply only if a future contract adopts withdrawal.
- **Resumption by replay.** Every continuation request carries its `opId`. A retry of the same request resumes from whatever committed, as the harness driver does: completed steps are no-ops, and a refused child keeps its recorded reason.
- **Settlement is a separate record, so I6 is unchanged.** C0 (or W0) creates `respondent-operation-settlement/<opId>` = `{ opId, settled: false, createdAt }` in its own transaction, beside the operation record and in the same namespace.
  - The record becomes `{ settled: true, at }` only through a guarded **settled acknowledgement** from the console. That ack is sent after the console's last transaction for that `opId` commits: C5 unlock or W3 remove for a completed operation, or the tombstone cleanup for a cancelled one. The ack is refused unless the operation is already terminal.
  - The ack writes **only** the settlement record. The operation record, once `completed` or `cancelled`, is never written again, and replays answer from it alone (I6).
  - A terminal operation with an unsettled record is finished in the api but not yet in the console.
- **A recovery runner**, scheduled in the console (`graffiticode-app`), because its console writes need the console's identity. It calls api internal routes for api steps. Every few minutes (proposed: 5) it lists settlement records with `settled == false` whose `createdAt` is older than a threshold (proposed: 15 minutes). That covers non-terminal operations, **completed operations awaiting C5 or W3**, and **cancelled operations awaiting console cleanup**. As a cross-check, it also lists console items in `continuing`, `pending`, `finalizing` or `withdrawing`, and console operations not `completed` or `cancelled`, then looks up each `opId`. For each one:

  The rows are checked **in order, and the first match wins**. Each is guarded by the api phase, read first, because the console's record can lag it. For example, an api-cancelled operation can still have a console record that is `finalized` or `locked`.

  | # | api phase (and ack) | console | Action |
  |---|---|---|---|
  | 1 | `cancelled` | tombstone missing, or any lock carrying this `opId` (`continuing`, `read-only`, `pending`, `finalizing`, `withdrawing`), whatever the console operation's phase, `finalized` and `locked` included | cleanup: write the tombstone and revert this `opId`'s locks, then the settled ack. **Terminal cleanup takes precedence; no ack is resent** |
  | 2 | `cancelled` | cleanup done | the settled ack, if not settled |
  | 3 | `completed` | not `completed` | roll forward: C5 unlock (or W3 to `withdrawn`), then the settled ack |
  | 4 | `completed` | `completed` | the settled ack, if not settled |
  | 5 | `prepared` with `ack.finalized` | any | roll forward: C4 activate, then rows 3–4 |
  | 6 | `withdraw-registered` with `ack.locked` | any | roll forward: W2 withdraw, then rows 3–4. If W2's guards now fail (the revision moved, or `prepared` appeared), W-cancel, then rows 1–2 |
  | 7 | `prepared` without `ack.finalized` | `finalized` | resend C3a, **only while the api is `prepared`**; then row 5. A refusal means the phase moved: re-read and start again from row 1 |
  | 8 | `withdraw-registered` without `ack.locked` | `locked` | resend W1a, **only while the api is `withdraw-registered`**; then row 6. A refusal re-reads as in row 7 |
  | 9 | `registered`; `prepared` without `ack.finalized`; or `withdraw-registered` without `ack.locked` | not `finalized` (or not `locked` for a withdrawal) | cancel (api first, terminal), with `cancelReason: "abandoned"`; then rows 1–2 |

  It never acts on another `opId`'s state, and every action is a guarded step from the race review's table or §6. So running it concurrently with a client retry is safe: one transaction wins and the other is a no-op or refused.
- **Acknowledgement transport:** C3a, W1a and the settled ack are authenticated calls to api internal routes, made as the console's service identity. The api verifies the Google ID token, its audience and a caller allowlist, as in decision 3. Each is retried with the same body until recorded or refused.

**Submission pauses:** a submission racing a continuation gets the temporary `respondent-continuing` and retries. It is not queued.
- **The target, for a healthy service:** the threshold plus one runner interval, so about 20 minutes before the runner cancels or completes the operation.
- **It is not a bound.** If the api, the console, either Firestore or the runner itself is unavailable, steps fail closed, and the pause lasts until the outage ends and recovery runs. The barrier and the drain counts make such operations visible. Nothing ever times out into publishing authority, or into releasing a lock that a later step still needs.

**Multi-item claims:** the parent claim records its children once. Its result lists each child's outcome (completed, refused with reason, or still pending), as the harness does.

**Alternatives:**
- Run the runner in the api, with a console write route for its console steps. That adds an api → console write path.
- For `prepared` with `ack.finalized`, cancel instead of rolling forward. That is simpler to reason about, but it discards a continuation the console already finalized.

## 8. Rollback floors and switches

**Recorded from the race review §6** (accepted with (c)):
- **R-api:** freeze readers of `respondent-bindings`. Never lowered once any active binding exists.
- **K-console:** never lowered once any item carries another item's session, or any source is read-only. Draining doesn't justify lowering it.
- **W-api and W-console:** lowered only after a verified drain with the barrier closed.

**Selected mechanics (2026-11-27).** The documented legacy semantics during a flag-off rollback are accepted; re-activation needs a separately approved reconciliation.
- **api milestones:**
  - `c4-assignments` (plan §6 step 3), with `requires` on `l0182r`;
  - `c4-continuations`, the first api with S4's binding read. This is R-api.

  Both go in `deploy.json` `baselines`, with different strength:
  - `c4-continuations` is `{ milestone, commit, floor: true }`, a floor. The deploy CLI never releases or rolls back below it, and no override applies, `--allow-dirty` included (`packages/deploy/src/release.js`). It is added when the first continuation can be created, before any binding exists, and is permanent.
  - `c4-assignments` is an **ordinary** baseline entry, which permits the CLI's override.
- **The api's `requires` on `l0182r` is static.** The deploy CLI resolves `requires` from `deploy.json` alone (`packages/deploy/src/config.js`). Turning `INTERPRETER_L0182` off doesn't remove it. **Proposed: a guarded configuration change**, each direction its own `deploy.json` PR and its own approval:
  - **Removing it** (after rollback, plan decision 11):
    1. the off release (`INTERPRETER_L0182="off"`, generation `rust-2`) is promoted;
    2. every older api revision's tag and traffic is retired;
    3. **in-flight flag-on requests drain.** Retiring traffic stops new requests, but a request already running on a flag-on revision can still call `l0182r`'s exchange. Wait at least the api's request timeout (300 s) plus a margin after the last flag-on revision stopped receiving traffic. Then verify the drain from logs: no request on any flag-on api revision is still open or completes after that point, and `l0182r` shows no `/interpret` call after it. The `requires` stays in force throughout;
    4. `npm run deploy -- release-check api` passes. It is read-only, and refuses while stale tags remain, so the promoted revision is the only reachable one;
    5. a read-only `gcloud run revisions describe` of that revision shows `INTERPRETER_L0182=off`. `release-check` doesn't report environment values.

    Only then does the PR delete the `requires` entry. Its description carries the drain verification and both outputs. Until it merges, `l0182r` stays at or above the milestone.
  - **Reinstating it**, before re-activation:
    1. the PR adds `requires` back;
    2. `npm run deploy -- release-check api` passes with the restored entry, which checks that every reachable `l0182r` revision is at or above the required milestone;
    3. only then is an api with the flag on staged.

    So no api with the flag on is ever reachable without the dependency in force.
  - **Alternative:** conditional dependency support in the deploy CLI, for example `{ service, milestone, whenEnv: { INTERPRETER_L0182: "on" } }`, evaluated against the environment of every reachable api revision. That is a separate code proposal, with its own tests, and nothing here assumes it.
- **The console** needs the same guarantee in `graffiticode-app`'s release tooling for K-console and W-console. Its mechanism is that repository's decision, and it must exist before the first continuation is created.
- **Two switches, independent:**
  - `INTERPRETER_L0182` gates assignment and freezing (plan decisions 9 and 11);
  - **the creation barrier** is the off switch for continuations. Closing it is one api transaction, with no release, and stops new continuations while existing ones roll forward or cancel.

  Turning the interpreter flag off doesn't close the barrier, and closing the barrier doesn't stop freezes. With the flag off, existing bindings still govern who may continue a response in the console.
- **The drain is a script:** `scripts/c4-continuation-drain.js`, `--dry-run` by default. It reports the race review §6 counts (`drainCounts` in the harness). Closing the barrier is its one write, made only with approval. It never lowers a floor itself. It reports whether W may be lowered, and R and K stay. Its counts include unsettled operations (§7) and, if the withdrawal alternative is chosen, the withdrawal counts (§6).

## 9. Canary isolation

**Extends plan decision 12** to continuation state.

**Selected (2026-11-27):**
- **A namespace is decided once and then pinned.** Configuration changes never move existing state. Two create-only records in a single, un-namespaced api collection each:
  - **the session pin** `l0182-session-namespace/<S>` = `{ namespace, at }`. It is created by the first api transaction that writes anything for S: an assignment, a C0, a W0, or a freeze. The namespace is chosen then from `L0182_CANARY_SESSIONS`. Every later read and write for S uses the pin, never the current list.
  - **the operation index** `respondent-operation-index/<opId>` = `{ namespace, digest, session }`. It is created in C0's (or W0's) transaction, together with the namespaced operation record.
- **C0, including its retries,** reads in this order:
  1. the operation index for `opId`. If present, C0 uses its namespace and compares its digest. A retry after a lost response therefore replays in the original namespace whatever the list now says, and a different digest is `operation-mismatch`;
  2. otherwise, the session pin for S. If present, it uses that namespace;
  3. only for a session never seen before, the current list. It creates the pin, the index and the operation together.

  C0 returns the namespace, and every later step, in both stores, uses it. The console never decides it independently. A console that lost C0's response learns the namespace by replaying C0, and the cancel path and the runner (§7) read it from the index. So the two stores can't disagree, and the same `opId` can never exist in two namespaces.
- **Configuration changes:** a session added to or removed from `L0182_CANARY_SESSIONS` after it is pinned keeps its pin. A release-time check reports every listed session pinned `production`, and every unlisted session pinned `canary`, as a configuration error. The pin still wins. Moving a session between namespaces is a separate, explicit migration, never a configuration side effect.
- **Collections:**
  - api: `l0182-canary-assignments`, `-draw-cycles`, `-survey-models`, `-cutover` (decision 12), plus `canary-respondent-bindings`, `canary-respondent-binding-history`, `canary-respondent-operations`, and `canary-continuation-barrier`;
  - console: `canary-continuation-ops`.
- **Barrier:** the canary barrier is separate. Staged continuation tests can run while the production barrier is closed.
- **Sources and destinations** are only canary-owned items: the canary and verify accounts, and the two canary free-plan workspaces. C0 refuses a canary operation whose source or destination principal isn't on that list, and a production operation naming a canary session.
- **A program's text can't choose a namespace.** A stranger naming a canary session reaches only isolated records, where full-principal checks still apply.
- **No production user's response** is claimed, transferred, frozen or withdrawn by a canary. The scheduled canary never writes production records.
- **Tests:** the api slice's emulator tests cover:
  - routing at C0, and the recorded namespace on every step;
  - **a C0 retry after a lost response, with the list changed in between, replaying in the original namespace**;
  - a pinned session keeping its namespace after a list change;
  - refusal of mixed principals;
  - the independent barriers. Staged checks use real frontend attestations (decision 12).

## 10. Decisions (selected by the owner, 2026-11-27)

The owner selected the primary proposal for all eight. Selection approves the policies, not their production implementation.

1. **Sessionless** (§2): stateless language reads; never assigned, balanced or frozen. No implicit respondent identity.
2. **Balancing** (§3): durable draws without replacement, with the assignment and the cycle updated atomically.
3. **Content changes** (§4): an unfrozen record keeps its instance and moves to the new digest, with the change recorded in its history. A frozen record keeps its original content. Survey changes need reviewed releases.
4. **Retention** (§5): the records listed in §5 are kept indefinitely, subject to its stated exceptions. No time-based expiry of cancellation tombstones.
5. **Deletion and expiry** (§6): the retained per-revision destination descriptor. Archive and expiry don't withdraw authority. A future hard deletion, TTL or cascading deletion needs a separate contract that covers unbound sessions. Withdrawal is **not** selected.
6. **Recovery** (§7):
   - the console-side runner;
   - separate settlement records;
   - the ordered recovery rows;
   - the 15-minute threshold and 5-minute interval, as healthy-service targets;
   - finalized continuations rolled forward;
   - submissions temporarily refused, not queued.
7. **Floors and switches** (§8):
   - the permanent reader and console floors;
   - independent switches;
   - the verified drain;
   - the guarded changes to the static dependency;
   - the documented legacy semantics during a flag-off rollback.

   Re-activation needs a separately approved reconciliation.
8. **Canary** (§9):
   - the permanent session pin and operation index;
   - the recorded namespace on every step;
   - separate barriers;
   - canary-owned fixtures.

**Executable evidence:** `lifecycle.harness.mjs` in the continuation harness (emulator-only) covers:
- settlement;
- the namespace pin and index, including replay after a lost response or a configuration change;
- the ordered recovery rows;
- the retained descriptor through archive and expiry.

**Still unapproved:**
- production implementation: routes, deployment configuration, and the language, API and frontend slices;
- migration and backfill classification (decision 10), with no automatic resets, the ten eval-only candidates included;
- releases;
- installation-specific namespaces (decision 3).

Each needs its own approval.
