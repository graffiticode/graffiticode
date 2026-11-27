# C4: runtime and lifecycle decisions

**Status:** proposal, docs only (2026-11-26). §1 records what the owner has already accepted. Every other section is a **proposal**: nothing in §2–§9 is selected, implemented or approved. This document approves no implementation, migration, backfill, reset, release, or merge. The ten verified eval-only reset candidates from slice 0 get **no automatic reset** under any proposal here. C5d and its legacy command remain held.

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

**Proposed: sessionless occurrences are stateless reads, handled entirely in the language.**
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

**Proposed: today's draw without replacement, made durable.**
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

**Proposed**, per record state:

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

**Proposed:** every C4 record is kept for as long as tasks are, which is forever, except where noted.

| Record | Store | Retention | Why |
|---|---|---|---|
| `l0182-assignments` (frozen and unfrozen) | api | forever | tasks are kept forever; a frozen record is the answer's model |
| `l0182-survey-models/<digest>` | api | forever, immutable, content-addressed | the only copy once a version is removed |
| `l0182-draw-cycles` | api | current state only (overwritten) | it holds no history of who drew what; the assignment records that |
| `respondent-bindings`, `respondent-binding-history` | api | forever | I3 needs history 1…k; the R-api floor reads them |
| `respondent-operations` (terminal included) | api | forever | I6: replay answers from them regardless of later rebindings |
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

**Proposed: a minimal retained destination record. Authority lives in the binding, not in T's continued existence.**
- **At C4,** the active binding already carries `{ principal, revision, opId, destination: T }`. Add `readyAt`, the C4 commit time. This record, with history entry n+1, is the **destination descriptor**. It is written once, never rewritten, and kept forever (§5).
- **I4 is restated:** at activation, T existed and was ready, which the finalized acknowledgement proves. From then on, the descriptor is the authority. T's later archive, expiry, unpublishing or removal doesn't change who may submit for S.
- **Submissions:** S4 reads only the binding (§1.3). An archived T doesn't withdraw authority. The respondent can still submit through any path that carries S and attests their full principal. Frozen records keep their attribution and models regardless.
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

**Alternative: authority withdrawal ordered against submissions.** Removal of T, or of an unbound item S, withdraws authority through an api-ordered protocol, in the shape of option (c):

| Step | Store | Guards | Writes |
|---|---|---|---|
| **W0 register** | api | barrier `open`; the binding's active revision n, or absent for unbound | the operation `withdraw-registered{n}` |
| **W1 lock** | console | no tombstone for `opId`; T `active` | T `withdrawing{opId}`: no answers, edits or deletion |
| **W2 withdraw** — *point of no return* | api | the operation registered; `active.revision == n`; `prepared` absent | `active = { withdrawn: true, revision n+1, opId }`; history n+1 |
| **W3 remove** | console | T `withdrawing{opId}`; the api operation completed | archive or remove T |
| **W-cancel** | api, then console | before W2 | the tombstone; T back to `active` |

- S4 refuses a withdrawn binding with the permanent `respondent-withdrawn`. A submission that commits before W2 keeps its freeze (I2). One that starts after is refused. Ordering is the api transaction, as with activation.
- **Expiry needs a writer.** Read-side expiry never runs W0–W3, so a sweeper must drive it, or authority stays until it does.
- **Account deletion** drives one withdrawal per affected session.
- **Costs:**
  - every removal of an L0182 item becomes a multi-step cross-store protocol;
  - the drain and floors grow by one operation kind;
  - the harness must be extended to cover it before any write path relies on it.

## 7. Recovery

**Proposed, with three parts.**
- **Resumption by replay.** Every continuation request carries its `opId`. A retry of the same request resumes from whatever committed, as the harness driver does: completed steps are no-ops, and a refused child keeps its recorded reason.
- **A recovery runner**, scheduled in the console (`graffiticode-app`), because its console writes need the console's identity. It calls api internal routes for api steps. Every few minutes (proposed: 5) it lists api operations that are not terminal and older than a threshold (proposed: 15 minutes), and for each:

  | Found | Action |
  |---|---|
  | `completed`, console not `completed` | roll forward: C5 unlock |
  | `prepared` with `ack.finalized` | roll forward: C4 activate, then C5 |
  | console `finalized`, ack not recorded | resend C3a, then roll forward |
  | `registered`, or `prepared` without the console finalized | C-cancel, recording `cancelReason: "abandoned"` |
  | api `cancelled` with no console tombstone | write the tombstone and revert this `opId`'s locks |

  It never acts on another `opId`'s state, and every action is a guarded step from the race review's table. So running it concurrently with a client retry is safe: one transaction wins and the other is a no-op or refused.
- **Acknowledgement transport:** C3a is an authenticated call to an api internal route, made as the console's service identity. The api verifies the Google ID token, its audience and a caller allowlist, as in decision 3. It is retried with the same body until recorded or refused.

**Submission pauses:** a submission racing a continuation gets the temporary `respondent-continuing` and retries. It is not queued. The pause is bounded by the threshold plus one runner interval (proposed: at most 20 minutes) before the runner cancels or completes the operation.

**Multi-item claims:** the parent claim records its children once. Its result lists each child's outcome (completed, refused with reason, or still pending), as the harness does.

**Alternatives:**
- Run the runner in the api, with a console write route for its console steps. That adds an api → console write path.
- For `prepared` with `ack.finalized`, cancel instead of rolling forward. That is simpler to reason about, but it discards a continuation the console already finalized.

## 8. Rollback floors and switches

**Recorded from the race review §6** (accepted with (c)):
- **R-api:** freeze readers of `respondent-bindings`. Never lowered once any active binding exists.
- **K-console:** never lowered once any item carries another item's session, or any source is read-only. Draining doesn't justify lowering it.
- **W-api and W-console:** lowered only after a verified drain with the barrier closed.

**Proposed mechanics:**
- **api milestones:**
  - `c4-assignments` (plan §6 step 3), with `requires` on `l0182r`;
  - `c4-continuations`, the first api with S4's binding read. This is R-api, and it is a permanent baseline once any binding is active.

  Both go in `deploy.json` `baselines`, so `npm run deploy -- rollback` refuses to go below them.
- **The console** needs the same guarantee in `graffiticode-app`'s release tooling for K-console and W-console. Its mechanism is that repository's decision, and it must exist before the first continuation is created.
- **Two switches, independent:**
  - `INTERPRETER_L0182` gates assignment and freezing (plan decisions 9 and 11);
  - **the creation barrier** is the off switch for continuations. Closing it is one api transaction, with no release, and stops new continuations while existing ones roll forward or cancel.

  Turning the interpreter flag off doesn't close the barrier, and closing the barrier doesn't stop freezes. With the flag off, existing bindings still govern who may continue a response in the console.
- **The drain is a script:** `scripts/c4-continuation-drain.js`, `--dry-run` by default. It reports the race review §6 counts (`drainCounts` in the harness). Closing the barrier is its one write, made only with approval. It never lowers a floor itself. It reports whether W may be lowered, and R and K stay.

## 9. Canary isolation

**Extends plan decision 12** to continuation state.

**Proposed:**
- **One namespace decision, made once.** The api chooses the namespace from the session and `L0182_CANARY_SESSIONS`, before any read, at C0. It records the namespace in the operation and returns it in C0's result. Every later step, in both stores, uses the recorded namespace. The console never decides it independently, so the two stores can't disagree.
- **Collections:**
  - api: `l0182-canary-assignments`, `-draw-cycles`, `-survey-models`, `-cutover` (decision 12), plus `canary-respondent-bindings`, `canary-respondent-binding-history`, `canary-respondent-operations`, and `canary-continuation-barrier`;
  - console: `canary-continuation-ops`.
- **Barrier:** the canary barrier is separate. Staged continuation tests can run while the production barrier is closed.
- **Sources and destinations** are only canary-owned items: the canary and verify accounts, and the two canary free-plan workspaces. C0 refuses a canary operation whose source or destination principal isn't on that list, and a production operation naming a canary session.
- **A program's text can't choose a namespace.** A stranger naming a canary session reaches only isolated records, where full-principal checks still apply.
- **No production user's response** is claimed, transferred, frozen or withdrawn by a canary. The scheduled canary never writes production records.
- **Tests:** the api slice's emulator tests cover routing at C0, the recorded namespace on every step, refusal of mixed principals, and the independent barriers. Staged checks use real frontend attestations (decision 12).

## 10. Decisions for the owner

Each is **proposed** above. Choosing one approves only the choice, not its implementation.

1. **Sessionless** (§2): stateless reads in the language, or refuse, or keep a record per identity.
2. **Balancing** (§3): a durable draw without replacement, or a uniform pick, or least-assigned.
3. **Content changes** (§4): moving an unfrozen record to the new digest, or a fresh draw, or refusing such releases. Also the release rule.
4. **Retention** (§5): everything forever, including tombstones, or tombstone expiry once its bound is proven.
5. **Deletion and expiry** (§6): the minimal retained destination record, with the constraint on future removal paths, or authority withdrawal ordered against submissions.
6. **Recovery** (§7): the console-side runner and its thresholds, and roll forward versus cancel for a finalized but unactivated operation.
7. **Floors and switches** (§8): the `c4-continuations` baseline, the console's floor mechanism, independent switches, and the drain script.
8. **Canary** (§9): the C0-recorded namespace and the canary continuation collections.

**Still outside this document:** migration and backfill classification (decision 10), with no automatic resets, the ten eval-only candidates included. Also outside: installation-specific namespaces (decision 3), and the language, API and harness slices. Each needs its own approval.
