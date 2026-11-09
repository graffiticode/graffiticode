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

1. **Intents, one per save call site.** Each one is static or runtime-expanding, depending on where the call site is.
   - **Outside any `LAMBDA`:** a static intent with one occurrence, `SAVE_TO_ITEMBANK:<from>.0`. This is today's id, so a legacy receipt and a command receipt for the same program line up.
   - **Inside a function (`map`, `filter`, `reduce`, or a lambda applied elsewhere):** a runtime intent.
     - The expansion key is `<from>#<n>`, where `<n>` is the call's ordinal at that site.
     - The bound is `maxOccurrences` = 100, the Broker's per-invocation write budget.
     - The ordinal is deterministic: the pinned input fixes the evaluation, and `map`/`filter`/`reduce` run in order (`l0000-evaluation-order`).
   - A save the dialect can't place, with no span, is refused at model time with a compile error. It never gets a `-` key.
2. **Deterministic payloads.** Dynamic-content row keys become a content digest: the first 16 hex characters of SHA-256 over the row's canonical JSON, as `graffiticode-<digest>`. Rows with identical content collapse to one key, which matches what the provider does with duplicate rows anyway. The same input then always gives the same payload, and the same `argd`.
3. **No signing under `start`.** A command's job is the save; the head's result is the activity with `data.itemBank`, unsigned.
   - Under `start` (`exec.is_command()`), PROG and `init` skip signing and attach `signing: { unsigned: "command" }`, with no protected call.
   - The console doesn't read the signed request from a save response. The canary and AT-10 do, but they read it from the separate preview compile, which stays a legacy read.
4. **No `REGISTRY_VERSION` bump.** The registry's entries don't change: same functions, ops and steps. Intents live in the model, and admission binds them, not the registry. The interpreter plan's note that a bump is needed predates B5's design and its intents-in-the-model decision.
   - **If a bump does turn out to be needed** (a new operation, or a changed step), it follows P1b's expand and contract. It moves three constants together: the registry, `compiler.ts:559` and `protection.rs:27`. TypeScript L0176 stays pinned inside the window.
5. **The bridge first, then the callers.**
   - **D2.** With `COMMANDS_L0176=on`, a `POST /compile` through a connection whose chain contains an L0176 save stage runs as a command. It uses the caller's key, or a fresh one if none, which matches today's new-invocation-per-request behavior. It answers in today's compile envelope, so no caller changes.
   - **D3.** The console then moves to `POST /command`.
   - **D4.** The bridge is retired later, per the interpreter plan.

## 3. The dialect (L0176 Rust, `languages/l0176/crates/core`)

- **`Dialect::intents(ast)`.**
  - It walks the normalized AST, which is the one the kernel passes.
  - For each `SAVE_TO_ITEMBANK` node it emits a static intent (outside any lambda) or a runtime intent (inside one), per decision 1.
  - Intent ids are `save@<from>`. `fn` is `save-to-itembank`; `op` is `learnosity.write-items`.
- **`save_to_itembank` under a command.**
  - **A static intent's occurrence:** `next_occurrence(key)`, exactly as today.
  - **A runtime intent's occurrence:** `exec.expand("save@<from>", "<from>#<n>")`, where `<n>` is a per-site counter kept in the dialect's invocation state.
  - Outside a command, nothing changes.
- **Deterministic dynamic-content keys** (decision 2), in both the Rust and TypeScript L0176. TypeScript is changed only so that a pinned TS revision and a Rust one build the same plan for a legacy retry; the TypeScript service is otherwise frozen.
- **Signing under a command** (decision 3): `prog` and `init` check `exec.is_command()`, and skip.
- **Tests** in `crates/core/tests/commands.rs`, modeled on the kernel's:
  - a model's intents for a single save, two saves, and a save inside `map`;
  - `start` binds each occurrence before minting;
  - a retry builds identical arguments (`argd` stable across runs and dynamic content);
  - there's no signing call under `start`;
  - a save inside `map` expands with the right keys and stays within the bound;
  - a span-less save is refused at model time.

  `brokered.rs` and the conformance corpus must pass unchanged for legacy compiles.
- **Release.** l0176r, by redeploy. Nothing changes for legacy compiles except the dynamic-content keys.

## 4. The api: the compile-to-command bridge (D2)

**The bridge** (`packages/api/src/data.js`).
- **When it applies:** `COMMANDS_LNNNN=on` for some stage's language, and a compile through a connection whose chain has a stage with intents.
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

**Tests** (api):
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
2. **Release the api bridge** (§4) with `COMMANDS_L0176` off.
3. **Stage.** A tagged api revision with `COMMANDS_L0176=on` and a new `COMPILE_GENERATION_L0176`. The deploy guard requires the generation to change with the flag. Run the activation drive against it, which replaces the skipped B5 soak.
   - **Who and where:** the canary account, the Learnosity sandbox connection only, and the canary window (IAM re-grant).
   - **Volume:** 200 commands across single save, two saves, and a save inside `map`, mixed between the bridge path and `POST /command`.
   - **Injected faults:** a worker killed after a write (the sweeper recovers it); a lost head answer; a revocation mid-command; a retry with the same key; 16 concurrent duplicates.
   - **The rule:** the sandbox's records are compared with the command outcomes, and **no write may be repeated**. Each command's provider references must be unique to its operation, which v8's creates-only writes make checkable.
4. **Promote** `COMMANDS_L0176=on` in production by a forward release, with the generation change.
5. **D3 clients.**
6. **Later, D4:** retire the bridge, once there's no bridged traffic.

**Rollback.** Turn `COMMANDS_L0176` off, with a new generation, by a forward release. Existing command keys stay commands and are still served. Never roll back below the floor.

**The B6 entry gate.** L0176 running on B5 meets B6's entry gate: a command language from C3 or C5 or a Track E language, extended here to C6 (to update in the plan's gate wording).

## 7. Slices

| # | Slice | Where | Release |
|---|---|---|---|
| 1 | Intents, deterministic dynamic-content keys, no signing under `start`, tests | l0176 crates (and TS keys) | l0176r |
| 2 | The bridge (D2), the worker returning the head answer, the effects envelope, tests | api (and a Policy outcome read if needed) | api, with the flag off |
| 3 | The staged activation drive (`scripts/c6-drive.js`) and its evidence | scripts, docs/evidence | staged api revision |
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
- **The 100-occurrence bound** might cut a real program short. If so, raise it per intent, and the model then declares it.
