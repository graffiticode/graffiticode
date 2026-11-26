# C4: continuation and submission race, protocol review

**Status:** review, docs only, revised after the owner's third review (2026-11-25). It selects **no** option. It works through the three options that `docs/c4-l0182-assignment-plan.md` decision 7 leaves open, so that the owner can choose one, and it lists the decisions that remain. Nothing here is implemented or approved.

**What the first review changed:**
1. **(b)** no longer relies on clock skew for safety. The binding becomes effective only when an api transaction confirms it under a still-held fence, so expiry can't let a delayed binding take effect.
2. **(c)** has an authoritative activation point after finalization. Submissions and item writes are gated while a continuation is being prepared.
3. **(c)** cancellation writes a durable terminal state that makes delayed binds fail before anything is deleted. The source is checked and locked before authority can move.
4. **Rollback** accounts for in-flight work: there are floors for freeze readers and binding writers, and outstanding operations are drained or recovered before a rollback.
5. **L** is defined against the freeze transaction's start, with the commit time recorded. **I7** is restated so that (a)'s permitted admission is consistent with it.

**What the third review changed:**
1. **No console-side resurrection.** Cancellation persists a console tombstone for the `opId`, even when nothing was allocated. B1 and C1 read it in their transactions, so a delayed allocation after the tombstone commits is impossible (§3).
2. **Authority is published only after verified console readiness.** B2 needs the console's *prepared* acknowledgement, and B4 and C4 its *finalized* one. Each is bound to the `opId`, epoch or revision, and the destination. The doc now separates **ready** (finalized and locked; submissions allowed) from **unlocked** (console edits allowed), and I4 is restated to match (§1, §3–§5).

**What the second review changed:**
1. **(b)** separates the established authority from the current attempt. An abandoned attempt never undoes a confirmation, and the fallback never resurrects an earlier owner. No new continuation starts while a confirmation is unfinalized, and acknowledgements must match `opId`, epoch and revision (§4).
2. **(c)** fences every later phase, cancellation included. T stays protected from finalize until unlock. Cancel and activate race on one api record, with activate as the point of no return. Late finalize and cleanup calls check their `opId` and phase, and never clear a newer operation's lock (§5).
3. Completed continuations leave persistent state, so the console compatibility floor (and the api reader floor) stay even after a drain (§6).
4. The drain uses a transactional **creation barrier** in the api, with older writers retired. It counts unfinalized confirmations and pending console cleanup, not only api records (§3, §6).
5. (b) and (c) have explicit **transition tables**: expected phase, `opId` and epoch guards, atomic writes, replay and recovery.

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
- **I4 (binding ↔ items).** A binding that grants authority names an existing destination item T with `respondentSession = S` that is at least **ready**: its console finalize committed, so its session and program are final, though it may still be locked (`finalizing`). **Unlocked** (`active`) additionally allows console edits. Submissions through the api need ready; console edits need unlocked. Whether to publish authority only at unlock instead is an owner decision (§8).
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

## 3. Shared machinery for (b) and (c)

**Operation identity.** One `opId` per child continuation: session S, source item X, destination item T. Every write in either store names its `opId`, and every guard below checks it, so a late call can never act on, or clear, a newer operation's state.

**Console item states**, which the console enforces on every write path (editor, chat, MCP, REST, deletion, sharing):

| Item | State | Answers or regenerations | Edits | Deletion |
|---|---|---|---|---|
| X | `open` | yes | yes | yes |
| X | `continuing{opId}` | no | no | no |
| X | `read-only{opId}` | no | no | no (it keeps its history) |
| T | `pending{opId}` | no | no | no |
| T | `finalizing{opId}` | no | no | no |
| T | `active` | yes, with `respondentSession = S` | yes | yes |
| T | `cancelled{opId}` | no | no | tombstone; optional deletion only after the operation is terminal in both stores |

**Console tombstones: no resurrection.**
- `continuation-ops/<opId>` in the console's store is the console's record of the operation. Cancellation always **creates or overwrites** it as `cancelled`, **whether or not anything was allocated**, in the same console transaction that reverts any locks carrying this `opId`.
- **B1 and C1 read it in their own transaction,** and refuse if it is `cancelled`.
- So a request that registered (C0) or acquired (B0) and paused before allocating can't recreate locks once the tombstone has committed.
- If the delayed allocation commits **before** the tombstone, it creates locks under this `opId`, and the tombstone transaction finds and reverts them.
- After the tombstone, late writes are impossible. The drain (§6) counts an api-cancelled operation as pending until its console tombstone exists.

**Console readiness acknowledgements.** The api can't read the console's store inside its transactions, so the console reports each committed phase to the api.
- **How:** an authenticated call, made as the console's service identity (verified as in decision 3), **after** the console transaction has committed. It carries `{ opId, phase: "prepared" | "finalized", epoch (b) or revision (c), destination T, source X }`.
- **Recording:** a guarded api transaction (rows B1a, B3a, C3a below) writes it into the operation record only if every field matches what the record expects, and the operation isn't terminal.
- **Why that is enough:** a console phase, once committed, can change only through cancellation cleanup. Cancellation cleanup runs only after the api's cancel transaction, which conflicts with the publishing transaction on the same operation record. So a recorded acknowledgement stays true until publication, or until cancel wins.

**The creation barrier.**
- `l0182-continuation-barrier` in the api's store holds `{ state: "open" | "closed", epoch }`.
- **Every operation is created by an api transaction that reads the barrier** (step B0 or C0 below), and is refused when it is `closed`. The console creates no operation of its own: it may not allocate or prepare without the api's creation result for that `opId`.
- Closing the barrier is itself a transaction, so a request paused before creation either created its operation before the close (and is counted by the drain) or is refused after it.
- The barrier fences only writers that use it. Console revisions that create continuations any other way must be retired (floor W-console, §6) before the barrier means anything.

## 4. Option (b): a fence held by the api, with an api-confirmed binding

**Why it needs a confirm:**
- With the binding effective as soon as the console commits it, a zero-skew sequence breaks it: the console passes its deadline check, pauses, the fence expires, a submission reads the old authority, the delayed binding commits, and the submission freezes against an unchanged fence epoch.
- Marking authority `unknown` afterwards can't undo an acknowledged freeze.
- So the console's write is only **prepared**, and authority moves only at an api confirm under a fence still held by the same attempt.

**State in the api's store, per session:** `l0182-session-fences/<S>` has two independent parts.
- `authority: { principal, revision, opId, epoch, finalized } | absent`: the **established** authority, the last confirmed continuation. Absent means never continued, and authority is derived from the source item.
- `attempt: { opId, epoch, state: "held" | "abandoned", heldUntil } | absent`: the **current attempt**, which never changes `authority` except through B2.

Abandoning an attempt clears only `attempt`. **The established `authority` always survives.** The fallback to the derived source principal happens only when `authority` is absent, so it can never resurrect an earlier owner after a confirmation.

**Operation records** (api, `respondent-operations/<opId>`): `acquired{epoch}` → `confirmed` → `completed`, or `cancelled`. The console mirrors them in its own `continuation-ops/<opId>`.

**Transitions:**

| Step | Transaction | Expected phase and guards | Atomic writes | Replay | Recovery |
|---|---|---|---|---|---|
| **B0 acquire** | api | barrier `open`; no operation record for `opId` (or one with the same request digest); `attempt` absent, or `abandoned`, or `held` past `heldUntil` (then abandoned in this transaction); `authority` absent or `finalized: true` (**no new continuation while one is confirmed but unfinalized**); `authority.revision` equals the request's expected revision | `attempt = { opId, epoch+1, held, heldUntil }`; the operation record `acquired{epoch+1, expectedRevision}` | an existing record with the same digest returns its state; if `acquired` and its attempt was abandoned, re-acquire with a new epoch only if `authority.revision` is still the expected one, otherwise cancel | none needed: nothing has moved |
| **B1 prepare** | console | the console operation absent, or `prepared{opId}`, and **not** `cancelled` (the tombstone is read in this transaction); X `open` at the expected version, or `continuing{opId}`; T absent, or `pending{opId}`; the result of B0 for this `opId` and epoch | X `continuing{opId}`, T `pending{opId}`, a prepared binding entry `{opId, epoch, n+1}`, and the console operation `prepared{epoch}` | the same `opId` and epoch is a no-op; a newer epoch (after a re-acquire) updates the prepared epoch only | a prepared state with no confirm is cleaned up by C-cancel below |
| **B1a prepared ack** | api | the operation `acquired{epoch}`; the acknowledgement's `opId`, epoch, revision n+1, T and X match the record | the operation records `ack.prepared = { epoch, revision, T }` | a no-op if already recorded identically; a mismatch is refused | a missing ack means B2 can't run: retry the ack, or cancel |
| **B2 confirm** — *point of no return* | api | the operation is `acquired{epoch}` **with `ack.prepared` for this epoch**; `attempt.opId == opId`, `attempt.epoch == epoch`, `attempt.state == held`; `authority.revision` equals the expected revision | `authority = { principal P′, revision n+1, opId, epoch, finalized: false }`; `attempt` cleared; the operation `confirmed` | `confirmed` returns; any guard failure → the operation becomes `cancel-required` | after B2, recovery only **rolls forward** (B3, B4, B5) |
| **B3 finalize** | console | the console operation `prepared{epoch}` (or `finalized`, a no-op); X `continuing{opId}`; T `pending{opId}`; the api operation `confirmed` (B2's result) | X `read-only{opId}`; T `finalizing{opId}`; the console operation `finalized` | a no-op once `finalized` | rolled forward by replay |
| **B3a finalized ack** | api | the operation `confirmed`; the acknowledgement's `opId`, epoch, revision n+1, T and X match | the operation records `ack.finalized` | a no-op if identical; a mismatch is refused | retry the ack (roll forward) |
| **B4 acknowledge** — *authority usable (T ready, still locked)* | api | `authority.opId == opId`, `authority.epoch == epoch`, `authority.revision == n+1`, `finalized == false`, **and `ack.finalized` recorded** | `authority.finalized = true`; the operation `completed` | `completed` returns; a mismatched opId, epoch or revision is refused (never sets another operation's flag) | rolled forward by replay |
| **B5 unlock** — *T unlocked* | console | T `finalizing{opId}`; the api operation `completed` | T `active`; the console operation `completed` | a no-op once `active` | rolled forward by replay |
| **B-cancel** | api, then console | api: the operation is not `confirmed` or `completed`; console cleanup: only states carrying **this** `opId` | api: the operation `cancelled`, and `attempt` cleared if held by this `opId`; then console, in one transaction: the **tombstone** `continuation-ops/<opId> = cancelled` (created if absent), X `continuing{opId}` → `open`, T `pending{opId}` → `cancelled{opId}` | a no-op once cancelled; a B1 delayed past the tombstone is refused; one that committed before it is reverted by it | never clears a lock with another `opId`; never runs after B2 |

**Submissions under (b)**, inside S4, reading `l0182-session-fences/<S>`:
- `attempt` held → temporary refusal, `respondent-continuing`;
- `authority` with `finalized: false` → temporary refusal;
- `authority` with `finalized: true` (T ready; it may still be locked) → the caller must equal `authority.principal`, and the freeze records `authority.revision`;
- `authority` absent → the derived principal from S2. The fence document must be unchanged since it was read before S2: same `attempt` epoch, or the same absence.

Clocks decide only liveness, through `heldUntil` and when a fence is abandoned.

## 5. Option (c): bindings and operations in the api's store

**State in the api's store:**
- `respondent-bindings/<S>` = `{ active: { principal, revision, opId } | absent, prepared: { opId, revision } | absent }`;
- `respondent-operations/<opId>`: `registered` → `prepared` → `completed`, or `cancelled`.

The console mirrors the operation in `continuation-ops/<opId>`.

**Transitions:**

| Step | Transaction | Expected phase and guards | Atomic writes | Replay | Recovery |
|---|---|---|---|---|---|
| **C0 register** | api | barrier `open`; no record for `opId` (or the same digest); the expected revision recorded | the operation `registered{expectedRevision n, X, source version v, T id}`; T's id is allocated here | the same digest returns the registration | nothing has moved |
| **C1 allocate** | console | C0's result for `opId`; **no `cancelled` tombstone for `opId`** (read in this transaction); X `open` at version v; T absent | X `continuing{opId}`; T `pending{opId}`; the console operation `allocated` | a no-op if already allocated by `opId` | cancel (C-cancel) |
| **C2 bind-prepare** | api | the operation `registered` (or `prepared`, a no-op); `active.revision == n` (or absent for unbound); `prepared` absent | `prepared = { opId, revision n+1 }`; the operation `prepared` | a no-op once `prepared` by this `opId` | cancel, or roll forward |
| **C3 finalize** | console | the console operation `allocated`; X `continuing{opId}`; T `pending{opId}`; the api operation `prepared` (C2's result) | X `read-only{opId}`; T `finalizing{opId}` (**still protected: no answers, edits or deletion**); the console operation `finalized` | a no-op once `finalized` | cancel (until C4), or roll forward |
| **C3a finalized ack** | api | the operation `prepared`; the acknowledgement's `opId`, revision n+1, T and X match the record | the operation records `ack.finalized = { revision, T }` | a no-op if identical; a mismatch is refused | retry the ack, or cancel (until C4) |
| **C4 activate** — *point of no return; authority usable (T ready, still locked)* | api | the operation `prepared` **with `ack.finalized` recorded**; `prepared.opId == opId`; `active.revision == n` (or absent) | `active = { principal P′, revision n+1, opId }`; `prepared` cleared; the operation `completed` | a no-op once `completed` | after C4, recovery only **rolls forward** (C5) |
| **C5 unlock** — *T unlocked* | console | T `finalizing{opId}`; the api operation `completed` | T `active`; the console operation `completed` | a no-op once `active` | rolled forward by replay |
| **C-cancel** | api, then console | api: the operation `registered` or `prepared`, **not** `completed`; console: only states carrying **this** `opId` | api: the operation `cancelled`, and `prepared` cleared if it is this `opId`'s; then console, in one transaction: the **tombstone** `continuation-ops/<opId> = cancelled` (created even if C1 never ran), X (`continuing{opId}` or `read-only{opId}`) → `open`, T (`pending{opId}` or `finalizing{opId}`) → `cancelled{opId}` | a no-op once cancelled; a late C2, C3a or C4 fails on the terminal record; a C1 delayed past the tombstone is refused; a C1 or C3 that committed before it is reverted by it | never clears another `opId`'s lock; impossible after C4 |

**Ordering of cancel against finalize and activate.** Both cancel and activate are api transactions on the same operation record, so exactly one wins. Activate also requires the finalized acknowledgement, so it can't run after C2 unless C3 really committed. Cancel is allowed until C4 commits, even after C3: it then reverts the console's `read-only{opId}` and `finalizing{opId}`. After C4, cancel is refused and recovery rolls forward.

**Submissions under (c)**, inside S4, reading `respondent-bindings/<S>`:
- `prepared` present → temporary refusal from **either** principal, including calls made straight to the api;
- `active` (T ready; it may still be locked) → the caller must equal `active.principal`, and the freeze records `active.revision`;
- absent → the derived principal from S2, with the document still absent in S4.

**Item writes** are refused by the console states (§3) from C1 until C5, or until cancel cleanup.

## 6. Rollback, floors and draining

**Persistent state** remains after every continuation completes: bindings or confirmed authority (api); `respondentSession = S` on T and read-only sources (console). Older code would misread it:
- an api below its reader floor wouldn't consult that authority;
- a console below its compatibility floor would regenerate T with T's own id, or ignore read-only.

So:

| Floor | Scope | When it may be lowered |
|---|---|---|
| **R-api** (freeze readers of fences or bindings) | the api | never, once any confirmed authority (b) or active binding (c) exists |
| **K-console** (respondent sessions: `respondentSession` folding, read-only and pending states, validation) | the console | never, once any item carries `respondentSession` different from its id, or any source is read-only, unless that state is migrated away by a separate decision. **Draining doesn't justify lowering it** |
| **W-api** (B0–B4 or C0–C4, cancel) | the api | only after a verified drain |
| **W-console** (B1, B3, B5 or C1, C3, C5, cleanup, the barrier-respecting creation path) | the console | only after a verified drain; console revisions that create continuations without the barrier must be retired first |

**A verified drain:**
1. **Close the barrier** (an api transaction). From then on no operation can be created; a request paused before creation is refused at B0 or C0.
2. Confirm that every console revision still serving traffic respects the barrier. Older writers are retired.
3. Drive every operation to a terminal state, by replay or cancel.
4. Count, and require **zero** of each:
   - non-terminal api operation records;
   - held attempts (b);
   - confirmed but unfinalized authority (b);
   - prepared bindings (c);
   - console operations not `completed` or `cancelled`;
   - console items in `continuing`, `pending` or `finalizing`;
   - cancel cleanup still pending in the console: an api-cancelled operation with no console tombstone;
   - acknowledgements outstanding: a console phase committed but not yet recorded in the api.
5. Only then may a **W** floor be lowered. The **R** and **K** floors stay.

**For (a):** there are no api writers, and the console's continuation is one transaction. K-console still applies once respondent sessions exist. Its audit store has no rollback constraint.

## 7. Side by side

| | (a) as of the check | (b) fence + api confirm | (c) bindings in the api |
|---|---|---|---|
| Old principal freezes after a rebinding? | yes, within L, audited | no | no |
| Point of no return | the console transaction | B2 confirm (usable after B4) | C4 activate |
| Clock assumption | L, measured on S4's start | none for safety (liveness only) | none |
| Submissions paused during a continuation? | no | while held or unfinalized | while prepared |
| Steps per continuation | 1 console | B0 acquire, B1 prepare, B2 confirm, B3 finalize, B4 acknowledge, B5 unlock | C0 register, C1 allocate, C2 bind-prepare, C3 finalize, C4 activate, C5 unlock |
| Delayed or late writers | not applicable | prepared only, confirm fails | operation record terminal, bind fails |
| Permanent floors | K-console once respondent sessions exist | R-api and K-console | R-api and K-console |

## 8. Decisions that remain (the owner's)

1. **Choose (a), (b) or (c)**, or another protocol.
2. **If (a):** accept admitted old-principal work after a transfer; choose L and the transaction-duration bound; define the audit record and what a finding triggers.
3. **If (b):** T (the hold); the sweeper for abandoned attempts and prepared console state; whether submissions may wait while a continuation is held or unfinalized; who runs the B3–B5 roll-forward.
4. **If (c):**
   - where respondent authority is answered (the console route calling the api, or C4 reading its own store);
   - the cancellation sweeper and when it runs (before C4 only);
   - tombstone retention;
   - how long submissions may be paused during a continuation.
5. **Publication point for (b) and (c):** at **ready** (B4/C4, T still locked; as written), or only at **unlocked** (after B5/C5, adding a final api step). The second keeps I4 at "active", at the cost of one more round trip.
6. **For every option:**
   - a racing submission gets a temporary refusal (proposed) or is queued;
   - multi-item claim progress reporting;
   - the floors (R-api, K-console, W-api, W-console), the barrier, the drain procedure and who runs it;
   - the tests in §8.
7. **Unchanged and still open:** the backfill's migration gaps (decision 10), sessionless programs (decision 4), and historical-copy resolution.

## 9. Tests any chosen option must pass

- freeze before rebind, and rebind before freeze, with the expected attribution (I2);
- an unbound session racing its first binding;
- one submission touching several sessions while one of them is rebound;
- a multi-item claim crashing after one child; replay resumes the rest with no duplicates (I3–I5);
- claim A → transfer B → replay A, which returns A's recorded result and leaves B's authority unchanged (I6);
- rollback:
  - W floors are lowered only after a verified drain, with the barrier closed;
  - a request paused before creation is refused after the close;
  - R-api and K-console are never lowered while persistent state exists;
  - an older console revision is refused by K-console;
- **for (a):** S4 started after L is refused; the commit time is recorded and an overrun is audited;
- **for (b):**
  - the zero-skew counterexample above: the delayed prepare commits, and its confirm fails;
  - an abandoned attempt after an earlier confirmation leaves that confirmed principal in place (the original owner is never restored);
  - B0 refused while a confirmation is unfinalized;
  - B4 with a mismatched `opId`, epoch or revision is refused;
  - B2 without a prepared acknowledgement, and B4 without a finalized one, are refused;
  - B0 → cancel → tombstone → delayed B1 is refused;
  - a crash at each step;
  - submissions refused while held or unfinalized;
- **for (c):**
  - a crash at each step;
  - submissions refused while prepared, from **both** principals, including directly through the api;
  - a cancel followed by a delayed bind-prepare fails;
  - cancel after C3 and before C4 reverts the console locks, and activate after cancel fails;
  - cancel after C4 is refused, and recovery rolls forward;
  - a late finalize or cleanup for an old `opId` never clears a newer operation's lock;
  - **C0 → cancel → cleanup and drain complete → delayed C1**: refused by the tombstone, and nothing is locked;
  - **C2 → C4 without a successful C3**: refused (no finalized acknowledgement), and authority doesn't move;
  - a C3a acknowledgement with a mismatched `opId`, revision or T is refused;
  - T `finalizing` refuses edits and deletion;
  - the source locked from allocate until finalize or cancel;
  - T never answerable before activate.
