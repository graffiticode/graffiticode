# C6, part 1: L0176 item-bank saves as B5 commands

**Status:** draft for review (2026-11-09).
**Parents:**
- [interpreter plan](graffiticode-interpreter-plan.md): C6, and Track D (D2 bridge, D3 callers, D4 retirement);
- [B5 plan](b5-commands-plan.md): done and released 2026-11-08; the api is the D2b floor.

**Decision recorded.** The owner skipped B5's two-week soak (2026-11-09). The fault drive that would have followed it moves here, as part of L0176's activation evidence (§6).

This plan makes `save-to-itembank` run as a B5 command, first behind the compile-to-command bridge (D2) and then through `POST /command` (D3).

It doesn't cover the read side of C6:
- interpreting L0176 reads (`INTERPRETER_L0176`);
- signing only in `present`;
- read-stage signing as `get`.

That is part 2, after this. Until then, reads stay on the legacy adapter, exactly as today.

## 1. Where we start

**Saves today.**
- A save runs on any `POST /compile` through a connection.
- The Rust dialect builds a plan for each activity the compile builds (`SavePlans`, `languages/l0176/crates/core/src/lib.rs:75`). `save_to_itembank` saves only an activity that this compile built (`lib.rs:322`).
- It invokes `save-to-itembank`, op `learnosity.write-items`, through Policy and the Broker. The occurrence is `SAVE_TO_ITEMBANK:<span.from>.<N>` (`lib.rs:167`, `protection.rs:207`).
- The program's value is the activity, with `data.itemBank` set to the Broker's result.

**Callers.**
- **The console** (graffiticode-app `core/src/lib/task-api.ts:107`, `compileThroughConnection`) posts `/compile { id, data: {}, connectionId, idempotencyKey }`.
  - Keys are `save:sha256(item|task|conn)`, or `recompile:<uuid>`.
  - It reads `status`, `data.errors` and `errors`.
  - Writes enter through create, update, publish, retry, recompile, republish and the effects outbox.
- **The canary** (`scripts/lib/canary.js:285`) and the **AT-10 provider check** (`scripts/lib/at10-provider.js:417`) read `data.effects` (filtered to `save-to-itembank`), `saved: true` and `references`.
- **MCP authoring** never writes (`externalWrites: false`). It reads `data.request` (`mcp-server/src/item-content.ts:714`).

**The B5 machinery** that L0176 has to fit:
- the model carries intents (`Dialect::intents`);
- `start` performs only declared intents and binds each occurrence before minting;
- the worker pins inputs, settles from receipts and publishes the committed result;
- `COMMANDS_L0176` gates new command allocations.

**What blocks a save from being a command** (found in the survey):
1. **The payload isn't deterministic.** Dynamic-content row keys are `graffiticode-<timestamp()>` (`activities.rs:~137`). A resumed run, or a retry with the same key, recomputes the plan, so the same occurrence is bound with different arguments. Policy refuses that as `operation-id-reused`. This is the C6 bullet "the content-digest dynamic-content reference".
2. **Signing isn't an intent.** Under `start`, `ExecContext::invoke` binds every protected call against the model's intents. L0176's PROG signing (`prog.0`) and implicit `init` signing (`INIT:…`) aren't intents, so `start` would refuse them.
3. **A save can repeat.** A save inside `map` or a lambda runs once per element, as `<key>.0`, `<key>.1`, and so on (`exec.rs:414`). A static `<key>.0` covers only a call site outside any function.
4. **No intents and no flags.** L0176 declares no intents. `deploy.json` has no `COMMANDS_L0176`.

## 2. Decisions this plan proposes (owner to confirm)

1. **Intents: one runtime-expanding intent per save call site.**
   - **Id:** `save:<from>`. Policy accepts only `[A-Za-z0-9_:.-]` in intent ids (`modelIntents`, `packages/policy/src/policy.ts:125`), so `@` would fail admission.
   - **Expansion key:** `<from>#<n>`, where `<n>` is the call's ordinal at that site in this run.
   - **Every site is runtime-expanding, never static.** The source can't show how often a site runs. The kernel's `apply` evaluates any callback expression, so `map`, `filter` and `reduce` can run a save more than once without any `LAMBDA` node around it.
     - A static `<key>.0` would let the first write succeed and refuse the second.
     - A runtime intent covers one call and many alike.
     - The cost: a command's occurrence ids (`x:…`) differ from a legacy compile's (`SAVE_TO_ITEMBANK:<from>.<N>`). That's harmless, since D2a never moves a key between protocols, so their receipts never meet.
   - **Determinism:** the ordinal is fixed by the pinned input, because `map`, `filter` and `reduce` run in order (`l0000-evaluation-order`). A test pins it.
   - **A save with no span** is refused at model time with a compile error. It never gets a `-` key.
   - **The bound** is a *proposed C6 limit*, not an existing one (decision 6).
2. **Deterministic payloads that keep row multiplicity and order.** The View samples uniformly over row ids, so a table `[A, A, B]` must keep A at ⅔: rows are never merged.
   - Each row's key is `graffiticode-<table digest>-<ordinal>`. The table digest is the first 16 hex characters of SHA-256 over the whole table's canonical JSON; the ordinal is the row's position.
   - The same input gives the same keys, in the same order, with the same duplicates. So the payload and its `argd` are the same on every run.
3. **No signing under `start`.** A command's job is the save; the head's result is the activity with `data.itemBank`, unsigned.
   - Under `start` (`exec.is_command()`), PROG and `init` skip signing and attach `signing: { unsigned: "command" }`, with no protected call.
   - The console doesn't read the signed request from a save response. The canary and AT-10 do, but they read it from the separate preview compile, which stays a legacy read.
4. **No `REGISTRY_VERSION` bump.** The parent plan's C6 bullet said a bump is needed. This PR corrects that bullet to match. The registry's entries don't change: same functions, ops and steps. Intents live in the model, and admission binds them, not the registry. The interpreter plan's note that a bump is needed predates B5's design and its intents-in-the-model decision.
   - **If a bump does turn out to be needed** (a new operation, or a changed step), it follows P1b's expand and contract. It moves three constants together: the registry, `compiler.ts:559` and `protection.rs:27`. TypeScript L0176 stays pinned inside the window.
5. **The bridge first, then the callers.**
   - **D2.** A `POST /compile` through a connection whose chain is command-eligible (decision 7) runs as a command. It uses the caller's key, or a fresh one if none, which matches today's new-invocation-per-request behavior. It answers in today's compile envelope, so no caller changes.
   - **D3.** The console then moves to `POST /command`. A key keeps working across the move because both routes build the same task chain (decision 8).
   - **D4.** The bridge is retired later, per the interpreter plan.

6. **A proposed runtime bound of 1000 saves per call site, with documented partial outcomes.**
   - **It's new.** No Broker or Policy limit exists today.
   - **Measure first.** Before activation, the largest number of saves any production program has made per call site is read from the gateway's effects logs. The bound must exceed it by a wide margin, or it's raised. Reaching it should then never happen in practice.
   - **The contract is a runtime limit, not a pre-check.**
     - A save is bound when it runs. Policy's per-intent counter, atomic in the bind transaction, refuses the bind past the bound (`bounds-exceeded`).
     - That's a definite refusal, and nothing was written for it. The saves before it stand.
     - The command ends `partial`, and a retry with the same key returns `partial` without writing again.
   - **B5 doesn't record that refusal today, so C6 adds it** (slice 0, Policy). `bindOccurrence` throws before storing anything, so the kernel leaves the refused occurrence out of the stage's list, and the worker could close the stage over the successful writes and finish `completed`.
     - **A durable refused attempt.** In the same transaction that refuses a bind for a definite reason (`bounds-exceeded`, `intent-not-admitted`, `occurrence-mismatch`), Policy commits a record `refusals/{stage}:{occurrenceId}`: the intent, expansion key, reason and generation. It then answers the refusal.
       - The record is idempotent: a resumed run's same refused bind finds it and answers the same.
       - It's separate from the bound occurrences, so the stage's close (exactly the bound set) is unaffected.
     - **Aggregation.** `finish` counts each refused attempt as a `failed` operation (`source: bind-refusal`). So a stage with one can never make the command `completed`: it's `partial` when anything was written and `failed` when nothing was. The aggregation function and its tests change with it.
     - **Recovery.** A takeover re-runs the stage. Its successful binds are acknowledged and their writes replayed from receipts, and the refused bind meets its record. The outcome is the same `partial`.
   - **No count pass.** Evaluating with placeholder save results can't promise anything before the first write: a program that branches on what a save returned could undercount (and fail partway anyway) or overcount (and be refused although it fits). So nothing is promised before writing. The limit is enforced where the writes happen, and its partial outcome is documented.
   - **Legacy compiles are unaffected.** The bound applies only to commands.
7. **One eligibility rule, for both entry points.** A chain is *command-eligible* when some stage both:
   - is in a language with `COMMANDS_LNNNN=on`, read from the stored tasks; and
   - performs a write: its preflight manifest's `requiredFunctions` include a function the registry marks `write`. Preflight has no effects, and the gateway already runs it for admission.

   A chain with no save stays on the legacy path, however the flags are set. A connection preview (L0176 `init` signing, no save) is never a command, so it never meets B5's "no writes, so failed" aggregation, and the read side stays as it is until part 2.
   - The same rule decides new allocation at `POST /command`, changed from slice 5's head-language check, and the bridge at `POST /compile`.
   - So a chain headed by L0000 with an L0176 save stage is treated alike by both. Turning the flag off makes both refuse new allocations alike, while existing keys are still served.
   - **At `POST /command`,** a chain with no write is refused with `no-effects`; it's a read, so there's nothing to command. **At the bridge,** it simply stays legacy.
8. **One task-chain normalization.** `/compile` and `/command` build the chain with the same function, moved out of `routes/compile.js`:
   - absent or empty `data` (`{}`) adds no data task;
   - other data appends its L0000 data task, unless the id already contains it.

   So the same item and key give the same `taskId`, and the same binding, on both routes.

## 3. The dialect (L0176 Rust, `languages/l0176/crates/core`)

- **`Dialect::intents(ast)`.** It walks the normalized AST, which is the one the kernel passes. For each `SAVE_TO_ITEMBANK` node it emits a runtime intent `save:<from>` (`fn` `save-to-itembank`, `op` `learnosity.write-items`, bounded per decision 6).
- **`save_to_itembank` under a command.**
  - Each occurrence is `exec.expand("save:<from>", "<from>#<n>")`, where `<n>` is a per-site counter kept in the dialect's invocation state.
  - Outside a command, nothing changes.
- **Deterministic dynamic-content keys** (decision 2), keeping row multiplicity and order, in both the Rust and TypeScript L0176. TypeScript is changed only so that a pinned TS revision and a Rust one build the same plan for a legacy retry; the TypeScript service is otherwise frozen.
- **Signing under a command** (decision 3): `prog` and `init` check `exec.is_command()`, and skip.
- **Tests** in `crates/core/tests/commands.rs`, modeled on the kernel's:
  - a model's intents for a single save, two saves, a save inside `map`, and a save repeated by a callback with no `LAMBDA` node;
  - the intent ids pass Policy's `modelIntents`, through an in-process Policy admission;
  - a dynamic-content table `[A, A, B]` keeps three rows in order, with stable keys;
  - at exactly the bound every save runs;
  - `start` binds each occurrence before minting;
  - a retry builds identical arguments (`argd` stable across runs and dynamic content);
  - there's no signing call under `start`;
  - a save inside `map` expands with the right keys and stays within the bound;
  - a span-less save is refused at model time.

  `brokered.rs` and the conformance corpus must pass unchanged for legacy compiles.
- **Release.** l0176r, by redeploy. Nothing changes for legacy compiles except the dynamic-content keys.

## 4. The api: the compile-to-command bridge (D2)

**The bridge** (`packages/api/src/data.js`).
- **When it applies:** a compile through a connection whose chain is command-eligible (decision 7): a flagged stage that performs a write. This is the same rule `POST /command` uses, which this slice changes from the head language to any writing stage. A compile with no save, such as a connection preview, stays legacy.
- **Normalization:** both routes call the shared task-chain function (decision 8).
- **What it does:** it allocates through `POST /v1/commands`, never `/v1/invocations`, with the caller's key or a fresh `bridge:<uuid>`. It then runs the B5 worker and builds today's compile envelope from the outcome.
- **The envelope it builds.**
  - **`data`:** the head's committed result. It's present only when there is one; the result is unavailable after a lost head answer.
  - **`errors`:** for any status other than `completed`, an error naming the status and the command's status URL.
  - **`effects`:** one per settled outcome, mapped back to today's shape: `{ fn, op, status: succeeded | failed | partial | uncertain, steps, replayed?, stage }`. This needs a small Policy read of outcomes with their receipts' steps, through the worker's existing `outcomes` read.
- **D2a holds.**
  - A key the legacy path already holds stays legacy and is served as today.
  - A command key on `/compile` is answered from its record (#321).
  - With the flag off, nothing changes.

**The worker** returns the head's answer envelope alongside the state, so the bridge can build `data` without a second read.

**Consumers to re-check:**
- canary: `data.effects`, `saved: true`, `references`;
- AT-10: `saved`, `references`, `questionReferences`;
- the console: status and errors;
- MCP: `data.request`, which isn't affected because MCP never writes.

**Tests** (api), each through the complete worker against an in-process Policy and receipt-keeping Broker (`commands/worker.spec.js` style):
- **Bound + 1.** The extra bind is refused, and its refusal is recorded. The stage closes over the successful writes, and the command finishes `partial`, not `completed`. A retry returns `partial` with no new write.
- **Recovery after the refusal.** A worker killed after the refused bind is taken over by the sweeper. The re-run replays the writes, meets the same refusal record, and ends `partial`, still with no repeated write.
- With the flag on, a connection compile with no save (a preview) stays on the legacy path, unchanged. `/command` refuses such a chain with `no-effects`.
- A chain headed by L0000 with an L0176 save is treated the same by `/compile` and `/command`, when its flag is turned on and when it's turned off.
- A key used on `/compile` (item with `data: {}`), then on `/command` with `data: {}` or none, gets the same `taskId` and binding: no `idempotency-key-reused`.
- With the flag on, a connection compile with a key becomes a command. The same key again returns the recorded outcome, with no new write.
- A compile without a key gets a fresh command each time.
- The envelope matches today's for success, partial, uncertain and failed.
- A legacy key stays legacy.
- With the flag off, the path is byte-for-byte unchanged (the existing w3, w4 and at12 suites).

## 5. Callers (D3), in graffiticode-app

- **The console's `compileThroughConnection`** moves to `POST /command { id, connectionId, idempotencyKey, data? }` and reads `{ commandId, outcome, result, statusUrl }`.
  - It maps `pending` to polling the status URL.
  - It maps `partial` and `uncertain` to the existing reconcile path, `reconcileItemWrite`, which uses Policy's `/v1/receipts/reconcile` with the same key.
  - Keys are unchanged: `save:…` and `recompile:…`.
- **The canary** gets a `--command` mode that saves through `POST /command`, alongside the bridge path.
- **MCP:** no change.
- **Ship order.** The clients ship first, and the bridge keeps old clients working meanwhile. D4 retires the bridge once telemetry shows no bridged saves for an agreed period.

## 6. Activation evidence and rollout

The order:
1. **Release the l0176r dialect** (§3), and run the canary as today; it must not change.
   - After activation (step 4), the existing **preview canary**, a connection compile with no save, runs again and must be byte-for-byte what it was: still legacy, still signed.
2. **Release the api bridge** (§4) with `COMMANDS_L0176` off.
3. **Stage.** A tagged api revision with `COMMANDS_L0176=on` and a new `COMPILE_GENERATION_L0176`. The deploy guard requires the generation to change with the flag. Run the activation drive against it, which replaces the skipped B5 soak.
   - **Who and where:** the canary account, the Learnosity sandbox connection only, and the canary window (IAM re-grant).
   - **Volume:** 200 commands across single save, two saves, and a save inside `map`, mixed between the bridge path and `POST /command`.
   - **Injected faults:** a worker killed after a write (the sweeper recovers it); a lost head answer; a revocation mid-command; a retry with the same key; 16 concurrent duplicates.
   - **Reconciliation** (B6's entry-gate evidence, kept in full). It needs uncertainties the reconciler *can* resolve: a provider write that succeeded, whose response or durable outcome was lost.
     - **The fault.** A staged Broker revision (a tag with no traffic) honors `BROKER_FAULTS=drop-outcome`, for the canary principal only. After a successful provider write, it skips recording the outcome and answers as if the response were lost. The claim and steps stay, so the receipt reads `uncertain`.
     - **Routing.** The staged l0176r revision points at that Broker tag, and the staged api at that l0176r tag. Nothing in production reaches it, and the flag is refused outside the canary principal.
     - **Approval of the staged compiler.** l0176r is pinnable, and Policy admits only approved revisions. A command preflights the staged l0176r tag, so its admission pins that revision, and without an approval Policy refuses it with `revision-not-approved`. `deploy --stage` leaves it unapproved, and today `approve` takes only a released (promoted) receipt. So:
       1. The deploy CLI gains `approve <service> --release <id> --staged`. It records the staged revision's approval and tag URL, with no traffic change. Approved tags are already kept by `retire-tags`, so the revision stays reachable for the drive.
       2. Before the drive: approve the staged l0176r revision, and check the approval with `scripts/revisions.js`.
       3. The drive's first command must show its admission pinning that revision: `records/state` `admission.stages[s].revision` and `tagUrl` equal the staged revision's. Otherwise the drive stops before any write.
       4. Afterward, the staged revision is retired (`scripts/revisions.js retire`) and its tag removed. Production traffic never moves.
     - **Volume:** at least 10 such operations, across single saves and expansions. Every one has a recorded uncertain outcome.
     - **Reconciling.** Permission is restored first, if a test revoked it. Then each is reconciled through Policy's `/v1/receipts/reconcile`.
     - **Verdicts:**
       - The reconciler's `applied` verdict, where provider read-back finds the records, is the **established completion** of that operation. It's recorded in the evidence, with no repeated write.
       - `unresolved` doesn't count toward the 10.
       - At least one of the 10 is, by construction, already successful.
     - **The command's terminal outcome is preserved.** It stays `uncertain` in its record (D1: later reconciliation advances knowledge but never rewrites a command's outcome). The evidence records the reconciled operations beside it.
     - **Revocation between steps** is tested separately. It can leave a genuinely partial operation the reconciler reports `unresolved`. That's the expected answer for it, so it isn't counted toward the 10.
   - **The rule:** the sandbox's records are compared with the command outcomes, and **no write may be repeated**. Each command's provider references must be unique to its operation, which v8's creates-only writes make checkable.
4. **Promote** `COMMANDS_L0176=on` in production by a forward release, with the generation change.
5. **D3 clients.**
6. **Later, D4:** retire the bridge, once there's no bridged traffic.

**Rollback.** Turn `COMMANDS_L0176` off, with a new generation, by a forward release. Existing command keys stay commands and are still served. Never roll back below the floor.

**The B6 entry gate.** This PR adds C6 to the gate's eligible languages. Activation alone doesn't pass the gate: the drive's reconciliation evidence above is also required, and the gate is claimed only when both are recorded in `docs/evidence/`.

## 7. Slices

| # | Slice | Where | Release |
|---|---|---|---|
| 0 | Durable refused attempts (`refusals/…`), counted `failed` by `finish`'s aggregation; tests | policy | Policy |
| 1 | Intents (`save:<from>`, runtime-expanding, with the proposed bound), deterministic dynamic-content keys, no signing under `start`, tests | l0176 crates (and TS keys) | l0176r |
| 2 | The bridge (D2), one eligibility rule and one task-chain normalization for both routes, the worker returning the head answer, the effects envelope, tests | api (and a Policy outcome read if needed) | api, with the flag off |
| 3 | The staged activation drive (`scripts/c6-drive.js`) with reconciliation, the staged Broker's `drop-outcome` fault (canary principal only), `approve --staged` in the deploy CLI, and its evidence | scripts, broker, deploy, docs/evidence | staged broker, l0176r (approved, no traffic) and api tags |
| 4 | `COMMANDS_L0176=on` with a new generation | deploy.json | api |
| 5 | Console `POST /command`, and the canary's `--command` mode | graffiticode-app, scripts | console |

## 8. Out of scope

- C6 part 2: interpreting L0176 reads, signing only in `present`, read-stage signing as `get`, the consumer checks for `data.request`, and the retirement of `generation.ts`.
- B6 repair.
- D4, until telemetry allows it.
- C5 (L0013).

## 9. Risks

- **Ordinal expansion keys depend on evaluation order.** They're stable only while `map`/`filter`/`reduce` stay sequential (the kernel guarantees it, per `l0000-evaluation-order`). A test pins it.
- **Dynamic-content keys change for legacy compiles too.** Any consumer that expects a timestamp shape must be checked. Nothing found so far.
- **The bridge's envelope must match** what canary, AT-10 and the console read. The tests compare against recorded legacy envelopes.
- **The bound** (decision 6) is new. Measure production before activation; raise it if any real program comes near.
- **The Broker fault hook** must never act in production. It's honored only on a staged tag and only for the canary principal, and a test pins both conditions.
