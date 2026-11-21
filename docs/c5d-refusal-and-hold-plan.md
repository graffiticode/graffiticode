# C5d: the atomic staging refusal and the durable command hold

**Status:** draft, **held** (2026-11-21). Nothing here is implemented, released or applied. It plans the fix that [`docs/c5d-staging-gone-finding.md`](c5d-staging-gone-finding.md) designed, the durable `hold` that [`capability-policy-iam-review.md`](capability-policy-iam-review.md) Step 32 §10.2 requires before Step 34, and the disposal of the two drive records this leaves. Read at `d10c1b09`. Every file:line below is at that commit.

**The owner's directive:** one held plan, before implementation. It covers the transaction crash tests (memory and emulator), temporary-outage recovery, claim/refusal races, and hold enforcement across due selection, takeover and renewal, including races with an existing worker. It specifies operator authorization, auditing and rollout order. The legacy command stays pending under quarantine, and the drop-outcome records are preserved unchanged. **Implementation, releases, applying the hold, new drive infrastructure and window, and Steps 33–34 all stay held pending review** (§8).

## 1. Where we start

**Broker's definite refusal.** `executeWrite` handles an operation with `loadStaged` at `packages/broker/src/broker.ts:632–657`:
- With a claim, it replays (633–636), unless the claim is reopenable under 7e (`reopenable`, 623–628).
- Otherwise it reads staging (638–645). A throw sets `unreadable`.
- With no bytes, it reads the claim again (651). A claim that is not reopenable answers by replay (653).
- Otherwise it refuses: `unavailable` 503, or `staging-unavailable` 409 (656). **Nothing is written either way.**

**The same gap on a reopened run (not in the finding note).** Take an aborted claim (7e, `broker.ts:59–68`) whose staging is then definitively missing. It reaches 656 too: `raced` exists, but it is still reopenable (653), so the answer is 409 with nothing written. The test `gcs.spec.ts:883` ("refuses a reopened run whose staging has gone, definitely, starting no run") asserts exactly that. The receipt reader skips an aborted latest run (`receipts-read.ts:56`), so Policy reads no receipt, and the command is stuck in the same way.

The note's remedy, a reopening run that "records `failed` under its own run fence (`putOutcome` with `run`)", needs `startRun` (`firestore.ts:90–99`) and then `putOutcome` (122–138). That is two transactions. A crash between them leaves an open run with no outcome, which reads `uncertain` (`receipts-read.ts:73–81`), forever. That is the two-write hazard #460's review excluded. Decision 1 covers this case with one transaction.

**The stores.**
- The Firestore receipt store (`packages/broker/src/firestore.ts:48–164`) writes each record once:
  - `claim` with `createOnce` (15–23, 54–59);
  - `putOutcome` with `createOnce`, or fenced to its run in a transaction (122–138);
  - `startRun` and `abortRun` in transactions (90–108).
- The memory store (`packages/broker/src/stores.ts:138–241`) defines the contracts (header 1–44). Each transition there runs with no `await` between its read and its write (182).
- No operation today creates a claim and an outcome together.

**Policy's settlement already handles a recorded `failed`.**
- `readReceipts` reports a claim with an outcome as `recorded: true` with its `status` and `reason` (`receipts-read.ts:61–72`).
- `recordFromReceipts` maps `failed` to the outcome `failed`, `final: true` (`command-records.ts:606–626`; `outcomeFromReceipt`, `command-outcomes.ts:15`).
- `finish` aggregates. With nothing written, the status is `failed` (`command-outcomes.ts:20–24`), and the publication is `none` (`command-records.ts:736`).
- A `failed` command is neither `pending` nor due, so `listDue` drops it (`firestore.ts:180–198`; `commands.ts:241–247`).

**Ownership and fencing.**
- `ownableBy` (`commands.ts:150–151`) gates `listDue`, `takenOverLease` (168–177) and `renewedLease` (158–165).
- `ownerRefusal` (102–107) fences every owner request:
  - directly: `transitionCommand` (`policy.ts:611`), `admitCommand` (627), `commandSession` (746), `commandBind` (949);
  - through `commandOperation` (836), and so mint (1563) and authorize-execution (1741);
  - through the records' `owned` (`command-records.ts:193–198`): every owner write and every bookkeeping write, settle and finish included.
- Nothing on a command record is outside a worker's reach today. There is no `hold`.

**The two records.**
- **Legacy, stuck:** `c:f54ea9f1…7133f` (Step 32 §10). `pending`, `admitted`, `scopes: 1`, generation 11, its lease expired near 2026-11-20T19:55:14Z. One bound occurrence, no outcome, and no Broker document at `receipts/{H1}`. Its revision `l0013r-c5d-drive-rmwo9rmhz-e7abb8` is retired, with `unrecoverable` [`5db5e929…`, `b7d4fa03…`].
- **Drop-outcome:** `c:db80a736…009b`, plan `b7d4fa03…`, invocation `inv-b8878442-06cb-4517-9a10-fbee816c5f42`. In Policy it is `uncertain`, with occurrence outcome `uncertain`, `final: false`, and a ledger entry `completed`, source `reconciliation`, at 19:35:14Z. In Broker: a claim at `receipts/{H2}` (`1a01024f…`), no `outcome/final`, and `resolution/final` `applied` at 19:35:13Z.
- Both were last compared canonically by `docs/evidence/c5d/drive/ad49c0ac/teardown/13-retained-records/compare.mjs` (all `same`).

## 2. Decisions

### 1. One store transaction per refusal, in two shapes (recommended)

Two new receipt-store operations. Each has identical semantics in `firestore.ts` and `stores.ts`, and the `stores.ts` header documents the contract:
- **`claimRefused(operationId, binding, { pld, evidence }, outcome) -> { created: true } | { created: false, claim }`.**
  - In one transaction, it reads the claim. If one exists, it returns it and writes nothing.
  - Otherwise it creates the claim (`tx.create`) and `outcome/final` (`tx.create`) together. Firestore's create precondition makes a concurrent claim abort the commit, and the retried callback then sees the claim.
  - The memory version checks and sets both with no `await` between.
- **`refuseRun(operationId, run, outcome) -> boolean`** (the reopened case).
  - In one transaction, it reads `run/state` and `outcome/final`. It requires the latest run to be aborted at `run - 1` and no outcome to exist, which is `startRun`'s condition (`firestore.ts:95`).
  - It then sets `run/state` to `{ run, state: "open" }` and creates the outcome together. A run with an outcome has ended, as any other run.
  - It returns `false`, writing nothing, exactly when `startRun` would.

**Alternatives:**
- `claim` then `putOutcome`: excluded by #460's review (a crash leaves `uncertain` for good).
- A claim with an inline `refused` status and no outcome document: every reader (`receipts-read.ts:53`, `replayClaim` at `broker.ts:579`, `recoveryReport` at `policy/src/revisions.ts:170`) keys on `outcome/final`, so each would need to change, against older readers during rollout.

**Recommended:** both operations as above.

### 2. What the refusal records

- **The claim:**
  - `binding` from `writeBinding` (`broker.ts:557`), exactly as a write's;
  - `pld`, so `recoveryReport` (`revisions.ts:166`) finds it and counts it neither uncertain nor unfinished;
  - `evidence: { refused: "staging-unavailable" }` in place of `thumbnailEvidence` (`gcs.ts:224`). `thumbnailResultFromEvidence` returns `null` for it (`gcs.ts:132–133`), so a materialize can't read it as a publication.
- **The outcome:** `{ status: "failed", steps: [], result: null, reason: "staging-unavailable", category: "conflict" }`. The category is `classify` of the reason (`common/src/failures.ts:162`).
- **Not opened or dispatched:** no run and no dispatch. On the reopened path, the claim's original evidence stays as it was.
- **The audit:** Broker audits `{ outcome: "failed", reason: "staging-unavailable", steps: [] }`.
- **Missing bytes and a digest mismatch** stay one reason. `loadStaged` returns `null` for both (`gcs.ts:219–223`), and the plan adds no distinction.

### 3. Authorization before recording: a new registered step, with a registry bump (recommended; the owner decides)

**How it works today.**
- Broker asks `authorizeStep(step, purpose)` (`broker.ts:382–395`).
- Broker and Policy both check the pair against the registry's step table: `isStepRegistered`, `common/src/protected-registry.ts:207–222`, with Policy's check at `policy.ts:1729`.
- For a command's token, Policy also runs `commandOperation` (`policy.ts:1741–1747`): the owner is current, with a live lease (`ownerRefusal`); the occurrence is bound; the token is logged.
- `gcs.put-thumbnail` registers `publish` (dispatch, conditional) and `receipt` (replay) (`protected-registry.ts:175–180`).
- No registered step means "record a refusal". The step table is part of the registry, and the registry's header says a change is a security change and bumps `REGISTRY_VERSION` (`protected-registry.ts:9–11`).

**Options:**
- **(a) A new step `refusal`, with a new purpose `record`, added to `gcs.put-thumbnail`'s steps** (after `receipt`; a non-dispatch step needs no predecessor, 217).
  - `StepPurpose` (118) gains `"record"`, and so does Policy's audit validator (`policy/src/audit.ts:75`).
  - `REGISTRY_VERSION` goes 9 → 10. `REGISTRY_WINDOW` becomes `[9, 8]` (96), and `ARTIFACT_COMPATIBLE_VERSIONS` becomes `[9, 8]` (83).
  - No function changes meaning: every `meaningSince` stays, so `boundVersion` (308–320) binds every artifact exactly as today, since `min(10, 9, 8)` is 8 as `min(9, 8)` is.
  - `scripts/check-registry-version.js` then requires the same constant in `languages/l0176` (TypeScript and Rust) and `languages/l0013` (Rust) in the same PR. Their releases can wait under the window, and stay held.
- **(b) Ask for `publish`/dispatch, attempt 1,** which is registered.
  - No registry change.
  - But Policy's audit would record a dispatch authorized that Broker knew it wouldn't send, and the decision grants more than the act needs.
- **(c) Reuse `receipt`/replay.**
  - No registry change.
  - But a replay decision would then authorize a write. Replay-only tokens are authorized for exactly that pair (`policy.ts:1718–1719`), so the step's meaning changes, which is itself a registry change without its bump.

**Recommended: (a).** It is the only option that keeps the registry the authority on what Broker may do. Its rollout is ordered in decision 10.

**Either way, the check is the same:**
- Broker asks immediately before the transaction.
- It checks `inTime` after the decision (`broker.ts:375–378`, 392).
- Denied, unavailable or out of time, it records nothing and answers 409 `staging-unavailable`, as today. A stale or fenced worker's token is denied at `commandOperation`, so it can't settle the occurrence.

**Which side may deploy first:**
- An older Policy denies the unknown step (`step-not-registered`), so a new Broker against it records nothing and stays as today. That is safe.
- An older Broker never asks for the step. That is safe.

### 4. What stays the same

- **The answer:** 409 `staging-unavailable`, with the same body. The note says "now with the recorded outcome". The plan leaves `detail` unset, because the worker settles from receipts and the L0000 kernel's client (which L0013 uses) needs no change. A retry answers by replay: 200 with `{ status: "failed", reason: "staging-unavailable", steps: [], replayed: true }` (`replayClaim`, `broker.ts:576–593`).
- **A temporary outage:** a throw, a timeout or a 5xx (`gcs.ts:173–174`) sets `unreadable` and answers 503 `unavailable`. No claim, no outcome (`broker.ts:640–656`). A 404 is the only read that counts as missing (`gcs.ts:173`).
- **The 7e reopen rule:** unchanged. A run that aborted before dispatch wrote nothing. The next run re-reads staging (`broker.ts:632–645`), and only a definite miss takes `refuseRun`.
- **Replay never re-reads staging:** with a claim and no reopen, 633–636 answer first. After `claimRefused` or `refuseRun` there is an outcome, so `reopenable` returns `null` (625).

### 5. Reconciliation treats a refusal receipt as final

Today `reconcile.ts` reads every bound claim. A refusal's evidence fails `readsEvidence` (`gcs.ts:229`), so it would append an `unresolved` attempt, `evidence-format-unknown`, at every request (`reconcile.ts:124–129`).

**The change:** a claim whose `evidence.refused` is set is answered `{ operationId, verdict: "refused", final: true, reason }`. It reads nothing and appends nothing. The check sits after the resolution check (112–116) and before the evidence check (124).

- **Policy:** it acts only on `applied` and `final` (`ledgerFromReconciliation`, `policy.ts:2062`), so the new verdict is inert there.
- **The console:** the console in `graffiticode-app` renders reconcile results. Whether it tolerates an unknown verdict is open question 3.

**Alternative:** answer `unresolved`. That would be false, and it would invite repeated reads.

### 6. The hold's shape

- **The field:** `hold` on `commands/{id}`, present only while held:

  ```
  { n, reason, note, decision, decidedBy, appliedBy, at, generation, leaseExpiresAt, readTime }
  ```

  - `n` is this hold's index.
  - `reason` is a slug (`^[a-z0-9-]{1,64}$`), and `note` is free text of at most 500 characters.
  - `decision` names the owner's decision (a PR or evidence path).
  - `generation` and `leaseExpiresAt` are the owner's, as the transaction read them. `readTime` is the snapshot's server time.
- **The history:** `commands/{id}/holds/{n}`, created once per act:

  ```
  { n, act: "apply" | "lift", reason, note, decision, decidedBy, appliedBy, at, generation, leaseExpiresAt, readTime, fencing: "lease-expired" }
  ```

- **What the write leaves:** it uses `tx.update(ref, { hold })`, never `touch` (`command-records.ts:199–203`). The command's only change is that one field. `updatedAt`, `status`, `owner`, `counts`, `outcomes`, `refusals`, `ledger` and `publication` don't move.
- **The scope:** only a `pending` command can be held. Anything else is refused `not-pending`. A finished command with a due publication is out of scope (open question 4).

**Alternative:** a separate `command-holds` collection read beside every command. That adds a read to `listDue`'s scan and to every fence, and it splits the record.

### 7. Where the hold is enforced

`ownableBy` gains `&& !command?.hold`. `ownerRefusal` gains a last check, `if (command.hold) return "command-held"`, placed after `lease-expired` so a stale worker still sees the reason every worker knows (`api/src/commands/worker.js:33`). `takenOverLease` and `renewedLease` refuse `command-held` before `requireCapableWorker`. A new failure reason, `command-held` (`conflict`), goes in `common/src/failures.ts`.

| Path | Where | Held | Why |
|---|---|---|---|
| Due selection, every capability | `listDue`, `firestore.ts:180–198`, `commands.ts:241–247`, through `ownableBy` | skipped | it never fills a sweep; the scan pages on past it (191–193) |
| Takeover (sweep, bridge, `POST /command`, repair route) | `takenOverLease`, `commands.ts:168–177`, through `leaseCommand`, `policy.ts:481–505`; callers `sweep.js:19`, `bridge.js:123`, `routes/command.js:212` | refused `command-held` | every caller already skips a `PolicyRefused` (`sweep.js:21–24`, `bridge.js:125–127`, `command.js:215–217`) |
| Renewal | `renewedLease`, `commands.ts:158–165` | refused | a renewal refusal stops the worker at its next step (`worker.js:86–90`, 66–76) |
| Session, bind, reserve, stage, admit, transition | `ownerRefusal`, at the lines above | refused | no live lease can exist (decision 8); defense in depth |
| Mint, authorize-execution | `commandOperation`, `policy.ts:836` | refused | not `definite`, so `settleRefusal` (1565) never runs |
| Settle, finish, `recordLost`, owner writes | `owned`, `command-records.ts:193–198` | refused | no owner exists while held; a held command is never settled behind the hold |
| Allocation with the same key | `allocateCommand`, `policy.ts:346–383` | allowed | it returns the summary and leases nothing; the caller's takeover is refused |
| Repair of a held original | `repairGate`, `command-records.ts:132` | refused `command-pending` | already, since a held command is pending |
| Reconciliation into the ledger | `recordReconciliation`, `command-records.ts:795–823` | allowed | it records Broker's verdict, leases and mints nothing; it applies only to an `uncertain` outcome |
| Reads (`getCommand`, `commandRead`), Broker receipt reads, `recoveryReport` | | allowed | they don't act |

`commandSummary` (`commands.ts:180–199`) gains `held: true` while held, so `GET /command/:id` shows it. Older readers ignore the field.

### 8. A hold and a live worker: refuse while the lease is live (recommended)

**Options:**
- **(a) Refuse to apply** while `owner.leaseExpiresAt + HOLD_MARGIN_MS > readTime`, with `HOLD_MARGIN_MS = COMMAND_LEASE_MS` (60 s, `commands.ts:66`). The comparison uses the transaction snapshot's server `readTime`, as admissions do (`firestore.ts:101`), never the operator's clock. The operator retries after expiry.
- **(b) Apply at once, and fence the worker** at its next renewal or Policy write. A worker already inside Broker would then be denied at its next authorization, `authorization-denied:command-held`. For `gcs.put-thumbnail` after a dispatch, that is definite: Broker records `failed` or `partial` (`broker.ts:732–741`). So the hold would change an outcome, which the directive forbids.

**Recommended: (a).** Every race is then decided in one transaction on `commands/{id}`. Firestore serializes transactions on the same document, and the memory store's `update` is synchronous (`commands.ts:206–210`):
- **A live lease:** the hold is refused `lease-live` and changes nothing.
- **A takeover in flight:** `takeOver` (`firestore.ts:168–170`, through `change` at 120–126) and the hold each read the command. If the takeover commits first, the hold sees a live lease and is refused. If the hold commits first, the takeover sees `hold` and is refused `command-held`.
- **An allocation-path takeover:** the same `takeOver` transaction (`bridge.js:123`, `command.js:212`), so the same outcome. The allocation itself never leases.
- **A worker whose lease lapsed but is still mid-stage:** it is already fenced `lease-expired` at every Policy write and at Broker's next authorization (`policy.ts:836`), as today. The hold adds nothing it can observe first, because `ownerRefusal` checks the lease before the hold.

### 9. Operator authorization: a script, not a route (recommended)

**How operator acts are authorized today.**
- `scripts/revisions.js` writes approvals with the operator's application-default credentials (header 23–24, 74–76). It records `by` from `gcloud config get-value account` (55–61), and its logic lives in `@graffiticode/policy/revisions`.
- Policy's manage routes act for a signed-in user on their own connections (`policy/src/app.ts:377–399`), not for an operator.
- The protected switch is an operator script, `scripts/protected-execution.js`.
- Writes to `policy` are IAM-governed: `policy-run` is the only conditioned `datastore.user`. The project's three Owners, and the `firebase-adminsdk` agent (a known residual), write unconditionally (`capability-policy-iam-review.md`, 865–885). Security rules don't apply to IAM-authenticated access.
- Firestore `DATA_WRITE` audit logging has been on since 2026-11-10. Its entries carry document names and the principal, never field values.

**Options:**
- **(a) `scripts/command-hold.js status | apply | lift <commandId> --reason <slug> --note <text> --decision <ref>`.**
  - It uses the operator's ADC against database `policy`, and runs the transaction in a new `@graffiticode/policy/holds` module (Firestore and memory versions of `applyHold` and `liftHold`).
  - It refuses a service-account credential.
  - `appliedBy` is the gcloud account, as `revisions.js` does. `decidedBy` is the owner named in `--decision`.
- **(b) A Policy route, `POST /v1/commands/:id/hold`,** gated to a new caller role `operator`. That needs:
  - a new `policy-callers` version;
  - `run.invoker` on `policy` for a human;
  - a new authorize branch.

  It adds an Internet-reachable way to stop commands, and it takes no write power away from Owners.

**Recommended: (a).**
- **Who:** an Owner, by the owner's named decision. Apply and lift alike, with no new IAM.
- **The authoritative "who":** the `DATA_WRITE` entry for the commit (decision 10), not the self-reported account.
- **Workers can't write it:** a worker can't write `hold`, because no Policy route or `COMMAND_WRITES` member (`policy.ts:507`) touches it.

### 10. Auditing

Each act leaves three records. They are read back in that order:
1. **The command's `hold`, and its history document** (decision 6), read through the Firestore REST API.
2. **Cloud Audit Logs:** the `DATA_WRITE` entry for the commit to database `policy` that names `commands/{id}` and `commands/{id}/holds/{n}`. Its `authenticationInfo.principalEmail` must be the Owner who ran the script. The exact filter is first confirmed on an existing operator write (the 2026-11-21 `revisions.js` write is one), before it is relied on.
3. **The evidence:** the script's own output, and the before and after reads, in `docs/evidence/c5d/hold/`.

**Fencing outcome:** the history records `fencing: "lease-expired"` with the generation and expiry it read. Apply is refused otherwise, so there is no other outcome to record.

### 11. Lifting

`lift` is the same kind of act, by the same Owners, with its own reason and decision:
- it deletes `hold` (`FieldValue.delete()`) and creates `holds/{n+1}` (`act: "lift"`), in one transaction;
- it changes nothing else. The command is then due at the next sweep of a capable worker, since its lease has long expired.

For the legacy command, **no lift is planned.**

### 12. Rollout order, floors and `requires` (recommended)

1. **Policy first** (`common` with it): the hold enforcement, the `refusal`/`record` step, registry 10 with window `[9, 8]`, `command-held`. New milestone **`C5d-hold`, a floor**: rolling Policy below it would put the held command back in due selection.
2. **Broker:** registry 10 with window `[9, 8]`, `claimRefused`, `refuseRun`, the reconcile change. New milestone **`C5d-refusal`, a floor**: Step 34 depends on it.
   - A Broker `requires` on Policy isn't needed for safety. Against an older Policy, its refusal is only denied (decision 3).
   - Registry-10 tokens appear only once a compiler reports 10, and compilers release last.
3. **api:** `command-held` joins `LOST_OWNERSHIP` (`worker.js:33`). Still no `COMMAND_SCOPES`.
4. **Apply the hold** to the legacy command (§5).
5. **The compilers** (`l0013r`, `l0176r`) at registry 10, later and held, each with `requires` on `policy` `C5d-hold` and `broker` `C5d-refusal`. Until then the window keeps 9.
6. **Step 34 step 1 (#445)** adds to the api's entry `requires: [{ policy, C5d-hold }, { broker, C5d-refusal }]` (`packages/deploy/README.md:57–61`). That refuses a scopes api while either is below its milestone, and refuses rolling either back below it afterwards.

   `requires` checks code, not data. So Step 34's preconditions also gain §5's after-reads: the hold is present on `c:f54ea9f1…` and the command is still unsettled.

**Alternative:** Broker before Policy. That is also safe, but the hold can't be applied until Policy ships, and it is what Step 34 needs most.

## 3. Slices

Each slice needs the owner's approval. None is approved by this plan.

1. **Code (PRs, no live effect):**
   - `common` (the registry and failures);
   - Broker (the stores, `executeWrite`, reconcile);
   - Policy (the hold, the enforcement, the audit purpose, `holds` module);
   - api (`LOST_OWNERSHIP`, the e2e spec);
   - `scripts/command-hold.js`;
   - `deploy.json` milestones (each added once its commit is on `main`, `README.md:44`);
   - the four registry constants.

   **Verify:** `npm run build`, `test:unit`, `test:ci:emulated` (the `broker-firestore` and `policy-firestore` targets, `scripts/test-targets.json:74–87`), the compiled groups, `typecheck`, `check-registry-version.js`.
2. **Policy release** (`npm run deploy -- policy`). **Verify:** `release-check policy` with `C5d-hold` current, and protected execution on. **Rollback:** none below the floor. A defect is fixed forward.
3. **Broker release.** **Verify:** `release-check broker`, and the production canary 36/36 (the form of `canary-f5gsb`). **Rollback:** forward only. Below the floor, older code reads a refusal receipt correctly (decision 4, and §7).
4. **api release.** **Verify:** the canary, and that the serving revisions have no `COMMAND_SCOPES` (Step 32 §10.3 read 6). **Rollback:** the previous api, down to the B5 floor; the hold doesn't depend on the api.
5. **Apply the hold** (§5). **Verify:** §5's after-reads. **Rollback:** `lift`, by the owner's decision.
6. **A fresh drive's infrastructure and window,** as Step 32 again, reviewed anew (held).
7. **The fresh drive** (held). Its `staging-gone` must show `failed` with nothing published, and its `cleanup` must pass.
8. **The compilers' registry-10 releases; Step 33; Step 34** (held).

## 4. Tests (all required, in slice 1)

**Broker, `gcs.spec.ts` (memory stores, `localAuthorizer`).** Replaces 444, 455 and 883.
- **Missing bytes, no claim:**
  - 409 `staging-unavailable`;
  - a claim with the token's binding, `pld`, and `evidence.refused`;
  - `outcome/final` `failed` with `steps: []`;
  - no run state, no upload;
  - `asks` includes `refusal`/`record`.
- **A digest mismatch:** the same.
- **Unreadable, then recovered:** a storage throw, then a 5xx, then a timeout each give 503, with no claim and no outcome. Restored, the retry publishes.
- **Replay after a recorded refusal, with bytes restored:** `failed` replayed, `storage.read` never called, no upload.
- **The same operation id, different args:** `operation-id-reused` (`broker.ts:578`), nothing changed.
- **Authorization for `refusal` denied, unavailable, or past the deadline:** 409, nothing recorded. A later authorized retry records once.
- **The reopened run:** aborted, staging deleted, retried. `refuseRun` records `failed` at run 1; `run/state` is `{ run: 1, open }`; the receipt reads `failed`.

**Transaction crash tests.**
- **Memory:** `createMemoryReceiptStore({ beforeCommit })`, a test-only hook called after both records are built and before either is stored.
  - A throw leaves neither the claim nor the outcome.
  - `readReceipts` lists nothing, never `uncertain`.
  - The next execute records once.
  - The same applies to `refuseRun`: no run state change, no outcome.
- **Emulator** (`firestore.spec.ts`, gated by `FIRESTORE_EMULATOR_HOST` at line 36, run in CI by `broker-firestore`):
  - A `db` wrapper whose transaction throws after the claim's `tx.create` and before the outcome's, and a second variant that throws after both: neither document exists afterwards, `receipts/{H}` is 404, and the retry records once.
  - The same wrapper for `refuseRun`.
  - No production test seam.

**Claim/refusal races** (memory, with a `storage.read` stub that blocks on a promise; and the emulator with `Promise.all`):
- **A claims first:** A read bytes; B read none. B's `claimRefused` returns `created: false`, B replays A's outcome, and A publishes once.
- **B records first:** A's `claim` finds it, and A replays `failed` with no upload.
- **Two concurrent refusals:** exactly one outcome, and both answer.
- **A reopen racing `refuseRun`:** exactly one of `startRun` and `refuseRun` succeeds, and the loser replays. Two concurrent `refuseRun`: one outcome.

**Broker `reconcile.spec.ts`:** a refusal receipt gives `refused`, `final`, with no `observe` call and no attempt appended. A thumbnail claim beside it reconciles as before. The drop-outcome shape (claim, resolution `applied`, no outcome) returns its resolution without a read, unchanged.

**Policy (`command-records.spec.ts`, `policy.spec.ts`):** settle from a refusal receipt records `failed`, `final: true`, `source: "receipt"`. Then `finish` gives `failed`, `counts.failed` 1, publication `none`. `listDue` omits it at every capability.

**api, end to end:** a new `packages/api/src/commands/staging-gone.spec.js`, modeled on `recovery.spec.js:18–64` (in-process Policy and Broker, memory stores, a staging stub, an L0013 stub).
- **The sequence:** exit after stage, delete the object, a sweep takes over.
- **The result:** the command is `failed`, not due, with no artifact. The next sweep lists nothing.
- **Recovery:** the same with a staging outage first stays pending, then completes once staging reads again.

**Hold** (`commands.spec.ts` memory; `commands-firestore.spec.ts`, emulator):
- **Due selection:** `listDue` skips a held command for all eight capability combinations, and returns the next ownable one within `limit`.
- **Takeover and renewal:** `takeOver` and `renewLease` refuse `command-held`. So do bridge and `POST /command` re-sends: the command stays pending and the worker is never run.
- **Policy paths:** `commandSession`, mint and authorize-execution refuse `command-held`, `settleRefusal` is not called, and settle and finish are refused.
- **Applying the hold:**
  - apply over a live lease is refused `lease-live`, and also within the margin;
  - apply after expiry succeeds;
  - apply to a non-pending command is refused `not-pending`.
- **Races with a live worker (emulator, `Promise.all`):**
  - takeover against apply: exactly one wins, by the rules of decision 8;
  - renewal against apply: the hold is refused while the lease is live;
  - an allocation-path takeover against apply: the same.
- **The record is untouched:** before and after documents are equal except `hold`. `updatedAt`, `owner`, `status`, `counts` and the subcollections are unchanged.
- **The audit:** the `holds/{n}` record is created once, with its fields. Lifting restores the document exactly, adds `holds/{n+1}`, and the command is due again.
- **Old workers:** an older api's worker receiving `command-held` stops without effects.

**Later, live (held):** the fresh drive (slice 7).

## 5. The legacy command: hold it, read before and after

1. **Before** (read-only; Step 32 §10.3, with its 2026-11-21 amendments):
   - **Read 1 (Policy):** command and subcollections, as before.
   - **Read 2 (Broker):**
     - the four paths answer 404;
     - the `runQuery` over the invocation's prefix uses the visible upper bound (`/` → `0`), with the `exit-after-stage` control returning its receipt;
     - the positive control GET answers 200.
   - **Read 3 (staging):** through the JSON API with `softDeleted=true`, with the drop-outcome prefix as control. After `hardDeleteTime` 2026-11-27T19:38:10Z, it lists nothing.
   - **Read 4 (tokens):** every `exp` has passed.
   - **Read 6 (production api):** no serving or tagged revision carries `COMMAND_SCOPES`.
   - **The comparison:** `teardown/13-retained-records/compare.mjs`, rerun into a new directory, all `same`.
   - **The new reads:** the baseline for `commands/$CMD/holds` (empty) and for Broker `receipts/{H2}/reconciliation-attempts`.
2. **Apply:**

   ```bash
   node scripts/command-hold.js apply "$CMD" --reason definite-refusal-unsettled --note "<…>" --decision <the owner's decision>
   ```

   It is expected to read generation 11, the lease expired 2026-11-20T19:55:14Z, `fencing: lease-expired`.
3. **After:**
   - **The command:** `commands/$CMD`, canonically, equals the before read except `fields.hold` and the response's `updateTime`. It is still `pending`, `admitted`, at generation 11.
   - **The subcollections:** `occurrences`, `reservations`, `outcomes`, `refusals` and `ledger` are byte-equal to the before read. `holds` has exactly `1`.
   - **Broker:** read 2 again, unchanged. There is still no claim.
   - **Due selection:** run the released `ownableBy` from `packages/policy/dist` at Policy's release commit over the fetched document, for all eight capability combinations. Every one is `false`. This is a read-only stand-in for the due route, which needs `api-run` tokens and a window.
   - **The audit:** the `DATA_WRITE` entry (decision 10).
   - **The evidence** goes to `docs/evidence/c5d/hold/`.
4. **After every later release, until Step 34:** read 1 and the hold again, unchanged.

The command stays `pending` and unsettled, with no Broker claim. The fix can't touch it:
- Broker is never asked for its operation again, because no owner can mint a token: it is held, and its revision is retired (`policy.ts:755`).
- A restored staging object would publish nothing, for the same reasons (§10.2).

## 6. The drop-outcome records: preserved unchanged

**What the fix does to them: nothing.**
- `claimRefused` acts only when no claim exists, and `refuseRun` only on an aborted run. `receipts/{H2}` is a run-0 claim, and it isn't aborted.
- No new execute can reach it. Its command isn't `pending`, so takeover is refused `command-finished` (`commands.ts:174`), and its revision is retired.
- Reconcile returns its existing `resolution/final` before reading anything (`reconcile.ts:112–116`). The refusal check never sees its thumbnail evidence.

**What the hold does to them: nothing.** It isn't applied to them, and `not-pending` would refuse it.

**The read-backs**, after each of slices 2–5:
- `compare.mjs`'s C2 rows, all `same`: command, occurrences, reservations, outcomes, ledger, `receipts/{H2}`, `resolution/final`;
- `receipts/{H2}/outcome/final` still 404;
- `reconciliation-attempts` with the baseline count.

## 7. Rollback

- **Code:** each release rolls back only by the deploy CLI.
- **Policy below `C5d-hold`:** refused, by the floor.
- **Broker below `C5d-refusal`:** refused, by the floor. If it were allowed, older code would:
  - replay a refusal claim's `failed` (it has an outcome);
  - settle it the same way (`receipts-read.ts:61–72`);
  - append `evidence-format-unknown` attempts on reconcile, harmlessly.
- **The registry bump:** reverting it means Policy and Broker releases again, while no registry-10 plan exists. That holds until the compilers ship (slice 8).
- **The hold:** `lift`, as an audited act.
- **What no rollback touches:** the legacy command's records, and the drop-outcome records.

## 8. What stays held

- the implementation (slice 1's PRs, beyond review);
- every release: Policy, Broker, api, the compilers' registry-10 releases;
- applying the hold to `c:f54ea9f1…`, and any lift;
- new drive infrastructure, and any window;
- the fresh drive;
- Step 33 (#443) and Step 34 (#445, #444).

## 9. Open questions for the owner

1. **Decision 3:** a registry bump to 10 for one recording step (recommended), or one of the no-bump options (b, c), each of which stretches an existing step's meaning.
2. **The margin:** `HOLD_MARGIN_MS` of 60 s on top of the server's `readTime` (decision 8). Is the lease length the right margin?
3. **The console:** whether it renders an unknown reconcile verdict (`refused`). It lives in `graffiticode-app`, outside this repository.
4. **Holding a finished command with a due publication:** refused here (`not-pending`). Is that wanted?
5. **The `holds` subcollection:** `holds/{n}` under the command, or a top-level `command-holds` log for one query across commands.

## 10. Found while reading

1. **The reopened-run gap** (§1): the finding note's fenced `putOutcome` design is a two-write variant. Decision 1's `refuseRun` replaces it.
2. **The answer:** the note's "now with the recorded outcome" would change the 409's body. The plan keeps the body unchanged (decision 4).
3. **Reconcile reads every claim, recorded or not** (`reconcile.ts:91–98`). So the refusal receipt needs an explicit final branch, not just a recorded outcome (decision 5).
4. **Out of scope, flagged:** Policy's `/v1/authorize-execution` route drops `attempt` (`packages/policy/src/app.ts:368–370`), though Broker sends it (`broker/src/authorizer.ts:29`).
   - Over HTTP, attempt 2 or later of the conditional `publish` would be checked as attempt 1 after `publish`. `isStepRegistered` (`protected-registry.ts:220–221`) refuses that as `step-not-registered`, so a precondition-contention retry fails definitely.
   - This needs its own finding and test; this plan doesn't change it.
