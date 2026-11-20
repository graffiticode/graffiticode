# C5d finding: a definitive pre-claim refusal is never settled

**Status:** design only. No code has changed. The fix and its regression tests are required before C5d activation (Step 34). The one command this left stuck is disposed of in [`capability-policy-iam-review.md`](capability-policy-iam-review.md), Step 32 §10.

## 1. What happened

In the C5d drive's `staging-gone` phase, generation 1 of an L0013 capture command staged its PNG and exited (`exit-after-stage`). The operator then deleted the staged object. Each takeover after that went the same way:
1. **It resumed at `s0`.** The reservation is `staged`, so neither Policy nor L0013 renders or stages again (`packages/policy/src/command-records.ts:537`, `packages/policy/src/policy.ts:1069`, `languages/l0013/crates/core/src/lib.rs:314–323`).
2. **It bound the occurrence and minted an execution token.**
3. **Broker refused it.** Broker read staging and found nothing. A re-read showed no claim, so it refused `staging-unavailable` (409) and wrote nothing (`packages/broker/src/broker.ts:632–657`, header 7c).
4. **Finish was refused.** The worker settled from receipts and found none. `finish` then refused `occurrences-unsettled` (`command-records.ts:672–676`).

The command is `pending` forever, and the sweeper retries it every minute. The plan expected "the command fails" (`docs/c5d-snapshot-commands-plan.md`, slice 3, `staging-gone`).

## 2. Why nothing settles it today

An occurrence counts as settled when `commands/{id}/outcomes/{stage}:{occ}` exists, or when the bind was refused (`refusals/…`). `finish` lists every bound occurrence and refuses if any has no outcome (`command-records.ts:661–676`). The writers of `outcomes` are:

| Writer | When | Why it doesn't apply |
|---|---|---|
| `recordFromReceipts` (`command-records.ts:606–626`) via `settleCommand` (`policy.ts:534–556`) | from Broker's receipts | there is no receipt |
| `recordRefusal` (`command-records.ts:645–653`) | Policy's own definite refusals at mint (`settleRefusal`, `policy.ts:876–894`) and reserve | a Broker refusal never reaches it |
| `recordLost` (`command-records.ts:630–641`) | a compile answer was lost | the answer wasn't lost, and `uncertain` would be false: nothing was written |
| `recordReconciliation` (`command-records.ts:795–823`) | an `applied` verdict for an `uncertain` outcome | no claim, no outcome |

**Broker's refusal is definite about the present only.** It proves no claim existed when it answered. It doesn't prove none can be made later, because a claim needs just two things:
- a valid execution token for the operation, which Policy mints while the command's lease is live and its revision `approved`;
- staged bytes that hash to the bound digest.

Staging is soft-deleted for 7 days, so the second can come back. That makes the refusal alone unsafe to settle on in Policy: a `failed` outcome recorded there while a token could still claim would race a real publication.

## 3. The fix: Broker records the refusal as the operation's outcome

**Which component.** Broker. It is the only authority on claims, and its claim is created once (`packages/broker/src/firestore.ts:15–23`, 54–58). So "refused, and never to be claimed" can be made true atomically there, and nowhere else.

**How it settles durably.** On the definite branch of 7c (staging read succeeded; the bytes are absent or don't hash to the bound digest; the re-read still finds no claim), Broker no longer just answers 409. It does three things:
1. **It claims the operation.** The claim records the token's verified binding, exactly as a write's claim does (`writeBinding`, `pld`). Its evidence is `{ refused: "staging-unavailable" }` in place of the publish evidence.
2. **It records the outcome.** `outcome/final` becomes `{ status: "failed", steps: [], result: null, reason: "staging-unavailable", category }`, with no run opened and no dispatch. **The claim and the outcome commit in one transaction, and nothing else is allowed** (#460 review). There is no two-write variant: a claim committed without its outcome reads `uncertain` (`receipts-read.ts`), and reconciliation returns `unresolved` for it, so a crash between two writes would leave the operation unsettled for good. The transaction creates the claim (failing if one exists) and `outcome/final` together, or neither.
3. **It still answers 409 `staging-unavailable`,** now with the recorded outcome.

**Settlement then follows the existing path:**
- the worker's `settle` reads receipts (`packages/broker/src/receipts-read.ts`) and records `failed`, `final: true`;
- `finish` aggregates the command `failed` (`packages/policy/src/command-outcomes.ts`);
- the publication is `none`.

Nothing new is needed in Policy's settlement, and no Policy writer gains authority.

**Before recording, Broker asks Policy's authorize-execution** for a registered `receipt` step (purpose: record a refusal), as it does before each effect today. If that is denied or unavailable, Broker records nothing and answers as now. A stale or fenced worker therefore can't settle the occurrence, and the next owner retries.

**A temporary outage stays retryable.** Staging that can't be read (a throw, timeout or 5xx, `unreadable` at `broker.ts:640–656`) stays exactly as it is: 503 `unavailable`, no claim, no outcome. The 7e reopen rule for a claimed-then-aborted run is unchanged: an aborted run wrote nothing, and the next run re-reads staging.

The fix touches only one branch: the read succeeded, and the bytes are missing or wrong. That covers:
- an operator's deletion;
- the 30-day lifecycle;
- a digest mismatch.

GCS reads are strongly consistent, and Policy marks a reservation `staged` only after the object's create succeeded (`policy.ts:1076–1095`). So a missing object behind a `staged` reservation means it was deleted, never that it hasn't arrived yet.

**A refusal racing a claim.** The claim's create-once decides:
- **A concurrent execute claims first** (for example, staging restored and read by another request): the refusal's create fails. It then replays the existing claim, as the raced branch does now (`broker.ts:651–653`). Nothing is recorded over it.
- **The refusal claims first:** any later or concurrent execute finds the claim and replays `failed` (`replayClaim`). It never reads staging and never publishes, even if the bytes come back.
- **A claimed run with no outcome yet** (in flight, or aborted under 7e): the refusal path isn't taken. In flight, the existing claim answers. Aborted, the reopen re-reads staging. If staging is then definitively missing, the reopening run records `failed` under its own run fence (`putOutcome` with `run`, `firestore.ts:122–139`), so a concurrent reopen can't double-record.
- **A crash during the refusal's record** leaves either both the claim and the outcome, or neither: they are one transaction. With neither, the next execute takes the same branch again and records once. A claim without an outcome can't come from this path.

**Reconciliation.** A refusal receipt carries no publish evidence, so `reconcile.ts` must treat it as final and never read for it. It is not `unresolved`.

**Retirement reports** (`packages/policy/src/revisions.ts:160–179`) see an outcome that is neither `uncertain` nor unfinished. A failed command stores no artifact, so its plan is still listed, as for any failed command today.

### Quarantine (required with or before the fix)

A command that can't settle (this one, or any future case of a definite refusal with no receipt) has no durable quarantine. Its exclusion from the due query depends on configuration alone (`ownableBy`, `packages/policy/src/commands.ts:150–151`). Once a scopes-enabled worker runs, the command is taken over every sweep (§10.2 of Step 32). The change:
- **The field:** `hold: { reason, decidedBy, at }` on the command, written only by an operator script (fenced to an expired lease, audited) and never by a worker.
- **Where it's honored:** `ownableBy` refuses a held command, so `listDue` (`firestore.ts:180–198`, `commands.ts:241–247`), `takeOver`, `renewLease` and the allocation-path takeovers (`packages/api/src/commands/bridge.js:121`, `packages/api/src/routes/command.js:210`) all skip it.
- **What it leaves alone:** status, outcomes and counts. A held command stays honestly `pending`.

## 4. Regression tests (all required)

1. **Broker `gcs.spec.ts`:**
   - **Missing staged bytes, no claim:** 409 `staging-unavailable`, a claim with the token's binding, and an outcome `failed`/`staging-unavailable` with `steps: []`. No upload request, no run opened. Replaces "refuses missing staged bytes with no claim, definitely, before claiming", which asserts no claim.
   - **A digest mismatch:** the same.
   - **Staging unreadable** (storage throws): 503 `unavailable`, no claim, no outcome. Then staging recovers, and the retry publishes.
   - **A retry after a recorded refusal,** with the bytes restored: it replays `failed`, never reads staging, never publishes.
   - **The same operation id with different args:** `operation-id-reused`.
   - **Authorization denied or unavailable** for the refusal's record: nothing recorded, and the answer is as today.
   - **A crash inside the refusal's transaction** (an injected failure after the claim's write is staged, before commit, in the memory store and under the Firestore emulator): neither the claim nor `outcome/final` exists, the receipt reads absent (not `uncertain`), and the next execute records the refusal exactly once.
2. **Race (memory store with an interleaving hook, and `firestore.spec.ts` under the emulator):**
   - **A claims first:** A has staging and claims; B read staging as missing. B's record loses and B replays A's claim, so A's outcome stands.
   - **B records first:** A then replays `failed`, with no upload.
   - **An aborted run (7e) reopening into missing staging:** exactly one `failed`, fenced to the open run. A concurrent reopen is refused `RunFenced`.
3. **Broker `reconcile.spec.ts`:** a refusal receipt is final and is never read.
4. **Policy `command-records.spec.ts` / `policy.spec.ts`:** settling from a refusal receipt records `failed`, `final`. Then `finish` gives `failed`, with publication `none`, and the command leaves `listDue`.
5. **The api's `worker.spec.js`, end to end (memory Policy, Broker and staging):** `exit-after-stage`, the object deleted, a takeover, then the command is `failed` and not due. The sweeper's next run lists nothing.
6. **The hold:** `listDue` skips a held command at every capability. `takeOver` and `renewLease` refuse it. The bridge and `POST /command` paths don't run it. Its status and outcomes are unchanged.
7. **Live:** a new C5d drive run whose `staging-gone` phase shows the command finishing `failed` with nothing published, and whose `cleanup` passes.
