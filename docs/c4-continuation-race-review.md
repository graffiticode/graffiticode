# C4: continuation and submission race, protocol review

**Status:** review, docs only, revised after the owner's first review (2026-11-25). It selects **no** option. It works through the three options that `docs/c4-l0182-assignment-plan.md` decision 7 leaves open, so that the owner can choose one, and it lists the decisions that remain. Nothing here is implemented or approved.

**What the first review changed:**
1. **(b)** no longer relies on clock skew for safety. The binding becomes effective only when an api transaction confirms it under a still-held fence, so expiry can't let a delayed binding take effect.
2. **(c)** has an authoritative activation point after finalization. Submissions and item writes are gated while a continuation is being prepared.
3. **(c)** cancellation writes a durable terminal state that makes delayed binds fail before anything is deleted. The source is checked and locked before authority can move.
4. **Rollback** accounts for in-flight work: there are floors for freeze readers and binding writers, and outstanding operations are drained or recovered before a rollback.
5. **L** is defined against the freeze transaction's start, with the commit time recorded. **I7** is restated so that (a)'s permitted admission is consistent with it.

**Sources:**
- `docs/c4-l0182-assignment-plan.md`: decision 3 (principals, attestation), decision 7 (freeze, the race), decision 10 (backfill), §5;
- `graffiticode-app` `docs/respondent-sessions-proposal.md`: §4.2 (`respondentSession`), §4.3 (respondent authority, bindings), §4.4 (rebinding proof, operation records, multi-item claims).

## 1. The two operations, and where their state lives

**A submission** (api, project `graffiticode`):
- **S1.** Build the caller principal at ingress (decision 3).
- **S2.** Look up respondent authority for each session the response touches: the principal P and an authority version.
- **S3.** Compare the principals.
- **S4.** Run the freeze transaction over the `l0182-assignments` records and `l0182-survey-models`, recording `{ principal, authority version }` and the submitter (decision 7).
- **S5.** Serve the result only after S4 commits.

**A continuation** (a claim or transfer; console, project `graffiticode-app`), for each source item carrying session S:
- **C1.** Authenticate and prove the action (claim token and workspace, or the transfer caller), and check replay against the immutable operation record (proposal §4.4).
- **C2.** Prove current authority over S, at the expected binding revision n, or for an unbound S, from its unique source item.
- **C3.** Write the destination item (`respondentSession = S`).
- **C4.** Write the binding at revision n+1, its history entry and the operation record.
- **C5.** Mark the source item read-only.

Today C2 to C5 can be one console transaction (all in `graffiticode-app`), and S4 is one api transaction (`graffiticode`). **No transaction spans both projects.**

**Invariants** every option must keep:
- **I1 (one authority).** At any moment S has exactly one respondent principal, or `unknown`/`ambiguous`, and every reader agrees on it at the same version.
- **I2 (attribution).** A freeze records the principal and authority version that admitted it, and the submitter. Neither is ever rewritten.
- **I3 (binding ↔ history ↔ operations).** A binding at revision k has history entries 1…k, and exactly one operation record per rebinding, whose result names the revision it wrote and the destination item.
- **I4 (binding ↔ items).** A binding that grants authority names an existing, **active** destination item with `respondentSession = S`.
- **I5 (source state).** A source item is read-only if and only if a continuation from it is in progress or committed.
- **I6 (operation records are immutable)** once in a terminal state: `completed` or `cancelled`. A replay answers from them, regardless of later rebindings.
- **I7 (fail closed).** An outage, or state the protocol can't verify, refuses temporarily. An operation succeeds only on authority the chosen option **defines as valid** at its decision point. In (a), that includes an admission under revision n within L after a later rebinding. In (b) and (c), it never does.

## 2. Option (a): authority as of the check

**Decision and commit points:**
- **Admission** happens at S2: `(P, n)`, or for an unbound S, `(P, unbound, source item version)`.
- **L bounds the start of the freeze transaction**, not its commit. Firestore can't make a commit conditional on wall-clock time, so S4 must begin within L of S2, and runs at most one attempt under that admission (a retry needs a fresh S2). The freeze records S2's time, S4's start time and the transaction's actual commit time. A commit later than S4's start plus the transaction's maximum duration is an audit finding.
- **The continuation commits** in one console transaction (C2–C5).

**Permitted outcomes:**
- A freeze by P at n that commits after a rebinding to P′ at n+1, when S2 preceded the rebinding and S4 started within L. The answers belong to the continued response either way; I2 records P at n.
- Never: a freeze whose S4 started after L, or for a principal other than the admitted one.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash between S2 and S4 | nothing is frozen; retry from S1 with a fresh lookup |
| Crash in the middle of a claim | atomic console transaction: nothing is written, and replay resumes (I3–I5) |
| Late submitter | S4 starting after L is refused; retry with a fresh lookup |
| Unbound S, then a first binding | an admission at "unbound" may freeze after the first binding, within L; audited |
| Partial multi-item claim | children commit independently; a later S2 sees each new binding |
| Replay after a later transfer | the console's operation record answers (I6); the api is uninvolved |

**The audit:** after S4, a re-read showing a revision other than n is logged `superseded-after-admission`. It doesn't undo the freeze, and it doesn't by itself prove which commit came first.

**Costs:** simplest. An old principal's admitted work may complete after a transfer, and the owner must accept that explicitly.

## 3. Option (b): a fence held by the api, with an api-confirmed binding

**Why the first version was unsafe:** with the binding effective as soon as the console commits it, this sequence breaks it, even with zero clock skew:
1. the console passes its deadline check;
2. it pauses;
3. the fence expires;
4. a submission reads the old authority;
5. the delayed binding commits;
6. the submission freezes against an unchanged fence epoch.

Marking authority `unknown` afterwards can't undo an acknowledged freeze. The check has to constrain the **commit that makes the binding effective**, not a step before it.

**Revised:** the console's binding write is only **prepared**. It becomes effective only through an **api confirmation** made under a fence that is still held at that moment.

**State in the api's store:** `l0182-session-fences/<S>` = `{ epoch, holder: opId, state: "held" | "confirmed" | "abandoned", heldUntil, confirmedRevision, confirmedPrincipal }`. A missing document is epoch 0, with no confirmed binding (authority is derived from the source item).

**The continuation:**
1. **Acquire** (an api transaction): no live hold, epoch e → e+1, `state: held`, `heldUntil` = now + T.
2. **Prepare** (a console transaction): C2–C5 with the binding written as `prepared` (epoch e+1, revision n+1), the source marked `continuing` (no answers or regenerations), the destination `pending`, and the operation record `prepared`. A prepared binding grants no authority.
3. **Confirm** (an api transaction, **the authoritative commit point**): requires `state: held`, epoch e+1, holder = this `opId`, and the fence not abandoned. It sets `state: confirmed`, `confirmedRevision = n+1` and `confirmedPrincipal`. If the fence was abandoned meanwhile, confirmation **fails**, and the prepared binding never takes effect.
4. **Finalize** (a console transaction): binding `prepared` → `active`, destination → active, source → read-only, operation record → `completed`. It runs only after a successful confirmation, and is idempotent.

**Respondent authority** is the api's `confirmedPrincipal` at `confirmedRevision`, or, with no confirmation, the derived source-item principal. A submission reads the fence document **inside S4**:
- `held` → refused temporarily (`respondent-continuing`);
- `confirmed` → the principal must equal `confirmedPrincipal`, and the authority version recorded is `confirmedRevision`;
- absent or `abandoned` with no confirmation → the derived principal, read from the console at S2, with S4 checking that the fence is still unheld at the same epoch.

The decision and the freeze are then atomic in the api's store.

**Expiry and late writers:**
- An expired hold is moved to `abandoned` by the next api transaction that reads it.
- A delayed console prepare can still commit afterwards, but it is only `prepared`. Its confirm then fails, so a late writer can't take effect.
- Clocks affect **liveness** only (how long submissions wait), never safety.
- A prepared binding left by a failed confirm is cancelled (operation `cancelled`, source `continuing` cleared, destination cancelled) by replay or a sweeper.

**Unbound S, then a first binding:** the first acquisition creates the fence document. A submission whose S4 read it as missing conflicts with that creation and retries, so the first binding is ordered with submissions.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash after acquiring, before prepare | the hold expires and is abandoned; nothing else happened. Replay re-acquires |
| Crash after prepare, before confirm | prepared, not effective. Replay re-acquires (if abandoned) and confirms under the new epoch, after re-checking C2; or it cancels |
| Crash after confirm, before finalize | authority has moved, but finalize hasn't run, so the destination is `pending` and the source `continuing`. Until finalize, the new principal's submissions are refused (`respondent-continuing`, because the fence is confirmed but the console isn't finalized; the fence document carries `finalized: false` until finalize reports back). Replay runs finalize, then a small api transaction sets `finalized: true` |
| Partial multi-item claim | one fence per session; each child is in one of the rows above |
| Replay after a later transfer | the operation record (terminal) answers; no fence is touched |

**Costs:**
- three api steps per continuation (acquire, confirm, finalized);
- submissions for S wait while a continuation is held or unfinalized;
- authority moves into the api's store, so (b) converges towards (c) with a fence in front.

## 4. Option (c): bindings stored where the freeze happens

**State in the api's store:**
- `respondent-bindings/<S>` with `state: prepared | active`, plus its history;
- the **authoritative operation records** `respondent-operations/<opId>`, in `prepared | completed | cancelled`.

The console holds the items.

**The continuation, with an explicit activation point:**
1. **Allocate and lock** (a console transaction):
   - check the source item's version and lock it: `continuing`, so it can't be answered, regenerated or otherwise written;
   - create the destination T as `pending`, which can't be answered or written;
   - record the console's view of the operation as `started`, with the source version it locked.

   The source version is checked **here**, before any authority can move, and stays locked.
2. **Bind-prepare** (an api transaction):
   - requires the binding at the expected revision n (or absent for unbound), and an operation record for this `opId` that is absent or `prepared` by this same attempt;
   - writes the binding n+1 as **`prepared`** and the operation record as `prepared`.

   A prepared binding grants **no** authority. Respondent authority still answers the previous principal, and **every** submission for S is refused temporarily (`respondent-continuing`), from either principal, while a prepared binding exists.
3. **Finalize** (a console transaction): T → `active`, source → read-only (I5).
4. **Activate** (an api transaction, **the authoritative activation point**): binding n+1 `prepared` → `active`, operation record → `completed`. From here P′ may submit, and I4 holds because T is already active.

**Why the gate matters:** hiding T in the console doesn't stop its principal submitting directly through the api, so the api itself refuses submissions for S while the binding is prepared. Replay convergence is how a continuation finishes, not what keeps it safe.

**Cancellation, which fences delayed binds:**
1. **Cancel** (an api transaction): the operation record → `cancelled`, a durable terminal state. A prepared binding of that operation is discarded, and the binding returns to revision n, active.
2. A **delayed bind-prepare** for that `opId` then fails: its operation record is terminal. A different `opId` must start again at allocate.
3. **Then** the console transaction: T → `cancelled` (a tombstone), and the source's `continuing` lock is cleared.
4. Deletion of T, if it happens at all, comes only after both have committed. A tombstone kept for audit is preferred.

The sequence "expiry deletes T, then a delayed bind passes its unchanged expected revision" can't happen: the bind checks the operation record, which is already terminal.

**Unbound S, then a first binding:** the absent binding document is read inside both S4 and bind-prepare, so they serialize. The source's authority was locked at allocate.

**Respondent authority:** the console's route reads the api's binding (no mirror), or C4 reads its own store directly and the route answers only console-side questions. With no stale mirror, the console calls the api.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash after allocate | T `pending`, source locked, no binding. Replay continues at bind-prepare, or cancels |
| Crash after bind-prepare | prepared, not effective; submissions for S refused. Replay finalizes then activates, or cancels |
| Crash after finalize, before activate | T active and source read-only, but the binding is still prepared, so submissions are still refused. Replay activates |
| A delayed bind after cancel | fails on the terminal operation record |
| Partial multi-item claim | children are independent, each in one of the states above |
| Replay after a later transfer | the terminal api operation record answers; nothing touches the newer binding |

**Costs:**
- no clock assumption;
- four steps, with submissions for S paused during them;
- authority read across projects;
- the proposal's binding storage moves to the api.

## 5. Rollback with work in flight

Removing an endpoint stops **new** work, not continuations already underway. For each option, a rollback below a milestone is allowed only after its outstanding work is drained or recovered.

**Floors** (milestones in `deploy.json`, with `requires` both ways):
- **Freeze readers** (api revisions that read the authority the option relies on: the audit for (a), fence and confirmed authority for (b), bindings for (c)): an api floor at that milestone, once any such state exists.
- **Binding writers** (console revisions that prepare or finalize continuations, and api revisions that confirm, activate or cancel): a floor on each side, while any operation is non-terminal.

**Before rolling either side below its floor:**
1. Disable new continuations (a console flag), and new submissions for affected sessions where the option needs it.
2. Drive every non-terminal operation to `completed` or `cancelled`, by replay or the cancel path, until a read shows **zero** non-terminal operations, zero held fences (b), and zero prepared bindings (c).
3. Only then is the rollback allowed. For a reader floor, it is allowed only if no state remains that the older revision would misread. In (b) and (c), confirmed or active authority in the api store always remains, so the api freeze-reader floor is permanent once used.

| Combination | (a) | (b) | (c) |
|---|---|---|---|
| api below its freeze-reader floor | allowed (the audit is lost) | refused once any fence is confirmed | refused once any binding exists |
| api below its writer floor (confirm, activate, cancel) | not applicable | only after draining | only after draining |
| console below its writer floor | only after draining console operations | only after draining | only after draining |
| both at or above their floors | normal | normal | normal |

## 6. Side by side

| | (a) as of the check | (b) fence + api confirm | (c) bindings in the api |
|---|---|---|---|
| Old principal freezes after a rebinding? | yes, within L, audited | no | no |
| Commit point for authority | the console transaction | api confirm (usable only after `finalized`) | api activate |
| Clock assumption | L, measured on S4's start | none for safety (liveness only) | none |
| Submissions paused during a continuation? | no | while held or unfinalized | while prepared |
| Steps per continuation | 1 console | acquire, prepare, confirm, finalize, finalized | allocate, bind-prepare, finalize, activate |
| Delayed or late writers | not applicable | prepared only, confirm fails | operation record terminal, bind fails |
| Permanent api floor | no | yes | yes |

## 7. Decisions that remain (the owner's)

1. **Choose (a), (b) or (c)**, or another protocol.
2. **If (a):** accept admitted old-principal work after a transfer; choose L and the transaction-duration bound; define the audit record and what a finding triggers.
3. **If (b):** T; the sweeper for abandoned and prepared state; whether submissions may wait while a continuation is held or unfinalized; how finalize reports back.
4. **If (c):**
   - where respondent authority is answered (the console route calling the api, or C4 reading its own store);
   - the cancellation sweeper and when it runs;
   - tombstone retention;
   - how long submissions may be paused during a continuation.
5. **For every option:**
   - a racing submission gets a temporary refusal (proposed) or is queued;
   - multi-item claim progress reporting;
   - the floors, the drain procedure and who runs it;
   - the tests in §8.
6. **Unchanged and still open:** the backfill's migration gaps (decision 10), sessionless programs (decision 4), and historical-copy resolution.

## 8. Tests any chosen option must pass

- freeze before rebind, and rebind before freeze, with the expected attribution (I2);
- an unbound session racing its first binding;
- one submission touching several sessions while one of them is rebound;
- a multi-item claim crashing after one child; replay resumes the rest with no duplicates (I3–I5);
- claim A → transfer B → replay A, which returns A's recorded result and leaves B's authority unchanged (I6);
- rollback: each floor refuses while its state or non-terminal work exists, and allows only after a verified drain;
- **for (a):** S4 started after L is refused; the commit time is recorded and an overrun is audited;
- **for (b):**
  - the zero-skew counterexample above: the delayed prepare commits, and its confirm fails;
  - a crash at each step;
  - submissions refused while held or unfinalized;
- **for (c):**
  - a crash at each step;
  - submissions refused while prepared, from **both** principals, including directly through the api;
  - a cancel followed by a delayed bind-prepare fails;
  - the source locked from allocate until finalize or cancel;
  - T never answerable before activate.
