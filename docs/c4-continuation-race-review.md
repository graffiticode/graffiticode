# C4: continuation and submission race, protocol review

**Status:** review, docs only (2026-11-25). It selects **no** option. It works through the three options that `docs/c4-l0182-assignment-plan.md` decision 7 leaves open, so that the owner can choose one, and it lists the decisions that remain. Nothing here is implemented or approved.

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
- **C4.** Write the binding at revision n+1, its history entry and the operation record `respondent-operations/<opId>`.
- **C5.** Mark the source item read-only.

Today C2 to C5 can be one console transaction, because all of their documents are in `graffiticode-app`. S4 is one api transaction in `graffiticode`. **No transaction spans both projects.** That is the whole problem.

**The invariants** every option must keep, whatever fails:
- **I1 (one authority).** At any moment S has exactly one respondent principal, or `unknown`/`ambiguous`, and every reader agrees on it at the same version.
- **I2 (attribution).** A freeze records the principal and the authority version that admitted it, and the submitter. Neither is ever rewritten. A later continuation doesn't change a past freeze.
- **I3 (binding ↔ history ↔ operations).** A binding at revision k has history entries 1…k, and exactly one operation record per rebinding. Each operation record's result names the revision it wrote and the destination item.
- **I4 (binding ↔ items).** A current binding's `itemId` names an existing, active destination item with `respondentSession = S`. That item exists only if a continuation committed.
- **I5 (source state).** A source item is read-only if and only if a continuation from it committed.
- **I6 (operation records are immutable).** Created once and never modified, so a replay answers from them regardless of later rebindings.
- **I7 (fail closed).** Any outage or unverifiable state refuses the submission or continuation temporarily. It never succeeds on stale or partial state.

## 2. Option (a): authority as of the check

**Commit points:**
- **Authority for a submission** is decided at S2: the lookup's answer `(P, n)`, or `(P, unbound + source item version)` for an unbound S. It is valid for a bounded admission lifetime L, starting at S2.
- **The submission commits** at S4, if S4 starts within L.
- **The continuation commits** at its console transaction (C2–C5).

**Permitted outcomes:**
- A freeze by P at n, committed after a rebinding to P′ at n+1 when S2 happened before the rebinding and S4 within L. The answers belong to the continued response either way; attribution records P at n (I2).
- Never: a freeze admitted by a lookup older than L, or by a principal other than the one in the lookup.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash between S2 and S4 | nothing frozen; the caller retries from S1 with a fresh lookup |
| Crash in the middle of a claim | the console transaction is atomic: none of C3–C5 is written, and the claim's replay resumes (I3–I5 hold) |
| Abandoned fence | not applicable |
| Late writer after a fence expires | not applicable. The equivalent is a **late submitter**: an admission older than L is refused at S4 (temporary, retry with a fresh lookup) |
| Unbound S, then a first binding | an attempt admitted at "unbound" (the source item's version observed) may freeze after the first binding commits, within L. The audit records it |
| Partial multi-item claim | child operations commit independently in console transactions. A submission for a session whose child committed sees the new binding at its next S2 |
| Replay after a later transfer | console-only: the operation record answers (I6). The api is uninvolved |

**The audit:** after S4, a re-read of authority that shows a revision other than n is logged `superseded-after-admission`. It doesn't undo the freeze. As the plan says, the re-read alone doesn't prove which commit came first: S2's time and the binding's commit time are in different systems.

**Rollback combinations:**

| api | console | Safe? |
|---|---|---|
| without C4 submission | with bindings | yes: no freezes |
| with C4 | without the respondent-authority route | yes: the lookup fails, so submissions are temporarily refused (I7) |
| with C4 | with bindings | normal |

**Costs:** it's the simplest. But an old principal's admitted work may complete after a transfer. That has to be accepted explicitly, and L has to be chosen.

## 3. Option (b): a fence held by the api

**State:** in the api's store, `l0182-session-fences/<S>` = `{ epoch, holder: opId, state: "held" | "released" | "abandoned", heldUntil, bindingRevision }`. The epoch increases on every acquisition, and a missing document is epoch 0, unfenced.

**Commit points:**
- **A continuation:**
  1. it **acquires** the fence (an api transaction: no live hold; epoch e → e+1; `heldUntil` = now + T);
  2. it runs its console transaction, which carries `fenceEpoch = e+1` and `fenceHeldUntil`, and refuses to commit if the console's clock is past `fenceHeldUntil − margin`;
  3. it **releases** the fence (an api transaction: epoch still e+1 and holder matches; record `bindingRevision = n+1`; state `released`).
- **A submission:**
  1. it reads the fence document, epoch e₀ (unheld), **before** S2;
  2. it runs S2;
  3. at S4, in the same transaction, it requires the epoch still e₀ and the fence unheld. Otherwise it is temporarily refused (`respondent-rebinding`) and retries.

**Why it orders:** any rebinding that could commit between a submission's S2 and its S4 had to acquire the fence first, which moves the epoch, so S4 sees the change and refuses.

**Unbound S, then a first binding:** the first continuation creates the fence document. A submission whose transaction read the document as missing conflicts with that creation and retries. So the first binding is covered by the same rule.

**Late writers after a fence expires:**
- **The hazard:** the hold expires, a submission proceeds on the old authority, and then the delayed console transaction commits the binding.
- **Mitigation:** the console refuses to commit past `fenceHeldUntil − margin`, by the console's clock. A submission treats the fence as held until `heldUntil + margin`, by the api's clock. Safety then depends on a **bounded clock skew** between the projects (Google front-end time; the margin must exceed the skew). That is an assumption, not a proof.
- **Belt and braces:** a binding committed with a fence epoch that the api later finds `abandoned` or superseded is marked **unconfirmed**. Respondent authority answers `unknown` for S until it is reconciled, so nobody can submit, and an operator or the owner resolves it.

**Abandoned fences:** a fence past `heldUntil` with no release is `abandoned` by whoever next reads it (in a transaction). The continuation that held it must re-acquire it and re-check C2 before committing. An abandoned fence never re-enables submissions under authority that a still-pending console transaction could change: the margin rule above, plus "unconfirmed" bindings.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash after acquiring, before the console commits | the fence becomes abandoned at `heldUntil`. Submissions for S are refused until then, then proceed on the unchanged binding. A replay of the operation re-acquires |
| Crash after the console commits, before release | the binding is committed, and the fence becomes abandoned. The next reader finds the binding (via the lookup) at n+1, and release-on-read records `bindingRevision` (I1 holds after reconciliation) |
| Partial multi-item claim | one fence per session, children independent; a crash leaves each child in one of the two rows above |
| Replay after a later transfer | the operation record answers (I6) without acquiring a fence; nothing is changed |
| Console transaction refused by the margin | nothing written, the fence released or abandoned, and a temporary refusal; replay retries the whole continuation |

**Consistency (I3–I5):** they hold, since C3–C5 stay in one console transaction. I1 holds outside the unconfirmed case, which answers `unknown`.

**Rollback combinations:**

| api | console | Safe? |
|---|---|---|
| without fences | with fence-using continuations | yes: acquisition fails, so continuations are refused (fail closed) |
| with fences | without continuations | yes |
| with fences | rolled back below the margin check | **unsafe**: the console could commit after expiry. The console needs a floor at the margin-check milestone while fences are on |

**Costs:** two systems and two extra api round trips per continuation; a clock-skew assumption; an "unconfirmed" reconciliation path. Submissions are refused for at most T plus the margin while a continuation runs or after it is abandoned.

## 4. Option (c): bindings stored where the freeze happens

**State:** `respondent-bindings/<S>` and its history move to the api's store. A console continuation calls an authenticated api route, `POST /respondent-bindings/continue`, that writes them.

**Commit points:**
- **The binding commits** in an api transaction, which S4 can read atomically: S4 re-reads the binding and requires the revision n that S2 used. With the binding in the same store, S2 becomes a read inside S4, and the lookup is unnecessary.
- **The continuation as a whole is not one commit.** Its console-side writes (C3 destination item, C5 source read-only) are in `graffiticode-app`. The plan's amendment is explicit that moving bindings alone doesn't make the claim atomic.

**A coordinated continuation**, one possible shape for review:
1. **Console, allocate:** create the destination item in state `pending-continuation` (not answerable, not listed) with its server-allocated id, and record the parent and child operation in the console as `started`.
2. **api, bind:** one api transaction. Check C2 against the api-held binding (expected revision n, or absent for unbound); write binding n+1, its history, and the **operation record** (the api store becomes authoritative for operation records); return the result.
3. **Console, finalize:** one console transaction. Destination → `active`, source → read-only, console operation → `completed` with the api's result.

**Which store is authoritative:**
- **The api store** for bindings, history and operation records.
- **The console** for items.
- The console's `respondent-authority` route would read the api's binding (no mirror), or be retired in favour of the api answering directly. With no stale mirror allowed, the route would have to call the api, or the console would have to read the api's store with read access.

**Unbound S, then a first binding:** the binding document's absence is read inside both S4 and the bind transaction, so they serialize. The source item's version (for unbound authority) comes from the console, so the bind step must carry the source item version observed at step 1, and the finalize step must re-check it. That is an open part of the contract.

**Failures:**

| Failure | Behavior |
|---|---|
| Crash after allocate, before bind | a `pending-continuation` destination exists with no binding: unanswerable and invisible. Replay of the operation resumes at bind; an expiry sweeps an abandoned one |
| Crash after bind, before finalize | the binding is at n+1 and points at a pending destination. Respondent authority answers the new principal; the destination isn't yet answerable. Replay reads the api operation record and runs finalize (I4 and I5 converge on replay) |
| Crash during finalize | the console transaction is atomic: it either commits or replays |
| Partial multi-item claim | children are independent; each child is in one of the states above and resumes from its records |
| Replay after a later transfer | the api operation record (immutable) answers bind; finalize is idempotent by operation; nothing changes the newer binding |
| Late writer | no fence. A delayed bind is just a transaction that commits or fails on its expected revision |

**Consistency:** I1 and I2 hold atomically for submissions. I3 holds within the api store. I4 and I5 hold **after replay converges**, but between bind and finalize they are temporarily broken (binding → pending destination; source not yet read-only). In that interval the source item must already refuse new answers, or a pending marker must make submissions by the source principal fail: the binding has moved, so they don't match anyway.

**Rollback combinations:**

| api | console | Safe? |
|---|---|---|
| without the binding route | with continuations | yes: continuations refused |
| with bindings | without finalize | **partial**: bindings can commit with destinations left pending, so the console needs a floor at finalize support |
| rolled back below bindings while bindings exist | any | **unsafe**: authority unreadable, so the api needs a floor (`c4-respondent-bindings`) once any binding exists |

**Costs:**
- no clock assumption, and submissions linearizable against bindings;
- a three-step continuation with resume;
- a cross-project read for respondent authority;
- the proposal's storage location changes;
- operation records split from items.

## 5. Side by side

| | (a) as of the check | (b) api fence | (c) bindings in the api |
|---|---|---|---|
| Can an old principal freeze after a rebinding? | yes, within L, audited | no (under the clock-skew bound) | no |
| First binding covered? | audited only | yes (document creation conflicts) | yes, plus a source-version check |
| Extra assumption | admission lifetime L | bounded clock skew, margin | none for ordering |
| Continuation atomic? | yes (console only) | yes (console), plus fence steps | no: allocate → bind → finalize, with resume |
| Submissions blocked during a continuation? | no | up to T plus the margin | no |
| New stores or routes | audit log | fence collection; two api routes | binding route; authority read moves |
| Rollback floors | none required | console margin check | api bindings; console finalize |

## 6. Decisions that remain (the owner's)

1. **Choose (a), (b) or (c),** or another protocol, after this review.
2. **If (a):** accept that admitted old-principal work may freeze after a transfer, and choose L, the audit record, and what an audit finding triggers.
3. **If (b):**
   - the hold length T and the margin;
   - the clock-skew assumption and how it is monitored;
   - the "unconfirmed binding" reconciliation owner and procedure;
   - whether submissions may be refused for up to T plus the margin.
4. **If (c):**
   - where operation records live (the api, as proposed here, or both);
   - how the console reads authority with no stale mirror;
   - the source-item version check for unbound sessions;
   - pending-destination expiry;
   - the floors.
5. **For every option:**
   - whether a submission racing a continuation gets a temporary refusal (and retries) or is queued;
   - multi-item claim progress reporting;
   - the deploy floors and their order;
   - the test list in §7.
6. **Unchanged and still open:** the backfill's migration gaps (decision 10), sessionless programs (decision 4), and historical-copy resolution. None of them is decided by the choice here.

## 7. Tests any chosen option must pass

- freeze before rebind, and rebind before freeze, with the expected attribution (I2);
- an unbound session racing its first binding;
- one submission touching several sessions while one of them is rebound;
- a multi-item claim crashing after one child; replay resumes the rest with no duplicates (I3–I5);
- claim A → transfer B → replay A, which returns A's recorded result and leaves B's authority unchanged (I6);
- every rollback combination marked safe stays safe, and every unsafe one is refused by a floor;
- for (b): a crash after acquiring, a crash after the console commits, abandonment, and a console commit refused by the margin;
- for (c): a crash at each step, and a pending destination never answerable;
- for (a): an admission older than L refused.
