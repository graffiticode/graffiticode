# B5 Commands, part 1: implementation plan

**Status:** draft for review (2026-11-07).
**Parents:** [interpreter plan](graffiticode-interpreter-plan.md), B5, D1, D2a and D2b; [interpreter design](graffiticode-interpreter-design.md), §5 "Immediate commands" and §12 acceptance criteria 2.
**Entry gate:** passed 2026-11-06 (`docs/evidence/b5-gate/`).

This plan turns B5's bullets into code-sized slices. It covers what exists today, the pieces to build, where each one lives, the order of the slices and releases, and the tests that close B5.

B5 activates no language. `COMMANDS_LNNNN` stays off everywhere until C5 (L0013) or C6 (L0176). B5 is done when the platform holds commands end to end against a declared test language, and the api carrying it is released as the D2b rollback floor.

## 1. Where we start

| Need | Today | Gap |
|---|---|---|
| Command identity | Policy `allocate` reuses an invocation per `(uid, idempotencyKey)` and refuses a different binding (`packages/policy/src/invocations.ts:57`). Keys are optional. | No execution protocol (`legacy`/`command`) and no command id on the allocation (D2a). No required key. |
| Admission | Binds a per-stage `StageManifest` (source, program and options digests, revision, image, registry version, required functions) (`policy.ts:781-888`). | No stage model digest. No effect intents. |
| Occurrences | `ExecContext::next_occurrence(key)` returns `<key>.<N>` per compile (`languages/l0000/crates/core/src/exec.rs:308`). L0176's key is `SAVE_TO_ITEMBANK:<span.from>`. Policy forms `opid = inv/stg/occ` (`policy.ts:637`) and checks only `ID_RE`. | Occurrences aren't checked against an admitted intent. No `x:` runtime occurrences. |
| Effects | Run only inside a legacy compile through a connection. Interpreted stages never run through one (`packages/api/src/data.js:276`). | No `start` on `/interpret`. |
| Pinned inputs | `inputDigest` (a hash of `options`), plan pins (`lookupPlan`) and the execution token's `argd`. | Nothing stores a command's resolved inputs or observations. |
| Outcomes | Broker receipts per opid (`receipts/{sha256(opid)}`, with steps, outcome and resolution). Each response carries `effects`, and `takeEffects` lifts them out (`data.js:355`). | No per-command record of outcomes, and no aggregation. |
| Ownership | Policy's `admission-leases` is a revision-retirement fence. Broker `active-executions` exists for draining. | No execution lease, fencing generation or takeover. |
| Recovery | The caller retries with the same key, and Policy reconcile (`packages/broker/src/reconcile.ts`) resolves uncertain writes. | No sweeper. Recovery depends on a caller retrying. |
| Public contract | `POST /compile` takes an optional `Idempotency-Key` and `connectionId` (`routes/compile.js:71`). | No `POST /command` and no command status URL (D1). |
| Rollback floor | The deploy CLI guards flag and generation changes (`release.js:188`). | No floor recorded, and no refusal below it (D2b). |

## 2. Decisions this plan proposes (owner to confirm)

1. **Policy owns the command record.** Allocation, protocol, lease, fencing generation, admission, occurrence bindings and outcomes all live in Policy's Firestore, next to `invocations`.
   - Why: D2a requires the protocol and command id to be written atomically with the key, and authorize-execution must read the current generation on every step. Both already live in Policy.
   - The api is the **worker**. It calls Policy's command endpoints and never writes the record directly. The authentication is the same as `/v1/invocations` today.
2. **Pinned inputs and observations are stored inline** in Policy's Firestore, as canonical JSON under their digest, in the command's `inputs` and `observations` subcollections (§3). They are capped at 512 KB each, and a larger one is refused with `input-too-large`. Today's L0176 saves and L0013 snapshot metadata fit.
   - A content-addressed GCS store is the fallback if a real caller exceeds the cap. It would bring its own IAM step, so it isn't in B5.
3. **The recovery sweeper is an api route driven by Cloud Scheduler.** `POST /internal/commands/sweep` runs every minute and is invoked with OIDC by a dedicated scheduler account.
   - The api already holds the worker code, and Policy stays a decision service.
   - The sweep claims expired leases through Policy, which does the compare-and-set, so the api never decides ownership.
4. **Leases and tokens.** A lease runs for 60 s and is renewed every 20 s while the worker runs. Execution tokens stay at 60 s.
   - A worker that misses two renewals loses ownership at the next fenced write or step authorization.
5. **Intents travel in the model, and are covered by its digest only when present.** The kernel model gains an optional `intents` field, and `identity` hashes it only when it isn't empty.
   - So every existing model keeps its digest, and the stage cache and model cache don't churn.
6. **Fencing rides on optional token claims.** Session and execution tokens gain optional `cmd` (the command id) and `fg` (the fencing generation).
   - They are optional so that older Brokers and compilers still verify the tokens (P1b expand).
   - Policy refuses an execution for a `command`-protocol invocation whose token lacks them. This is a Policy check; the Broker doesn't change.

## 3. The command record

The command record is the Policy document `commands/{commandId}`. Its id is `c:` plus the hex SHA-256 of `[uid, idempotencyKey]`, so a key maps to exactly one record.

```
{
  schema: 1,
  commandId, uid, idempotencyKey,
  invocationId,                       // the one invocation for the whole chain
  protocol: "command",                // D2a; the allocation also carries it
  lang, taskId, connectionId,
  binding: { connectionId, taskId, inputDigest, modelDigests: ["s0" → digest, …] },
  admission: { planDigest, stages: { s0: { modelDigest, revision, tagUrl, intents: [...] }, … } },
  owner: { worker, generation, leaseExpiresAt },   // generation increments on every takeover
  status: "pending" | "completed" | "failed" | "partial" | "uncertain",
  stages: { s0: { state: "ran" | "not-reached", pinnedInput: digest|null }, … },
  outcomes: { "<stage>/<occurrence>": { outcome, receipt: opid, at, generation } },
  result: digest|null,                // a completed command's result, for the artifact
  revisions: { compiler, interpreter: tagUrl per stage, registryVersion },
  runRef: null,                       // extension point (Track E1); B5 never sets it
  createdAt, updatedAt
}
```

Subcollections:
- `inputs/{digest}`: pinned stage inputs, installed once.
- `observations/{observationId}`: recorded external reads, installed once.
- `occurrences/{stage}:{occurrenceId}`: bindings, persisted before dispatch.

**Policy endpoints** (new, all idempotent):

| Endpoint | Does | Fenced |
|---|---|---|
| `POST /v1/commands` | Allocate or find. It creates the invocation, the key and the command in **one transaction**, records `protocol`, and claims the first lease at generation 1. A second caller gets the existing record, with `pending` while its lease is live. A different binding gets a conflict (`idempotency-key-reused`). | Creates gen 1 |
| `POST /v1/commands/:id/lease` | Renew, or take over (`expected: gen`). Takeover succeeds only when the lease has expired, and it increments the generation. | CAS on gen |
| `POST /v1/commands/:id/admit` | Binds the ordered stage model digests and their intents, and returns the admission token. | gen |
| `PUT /v1/commands/:id/inputs/:stage` | Installs a stage's pinned input if absent, and returns the installed digest either way. | gen |
| `PUT /v1/commands/:id/observations/:oid` | Allocates or installs one observation (§5). | gen |
| `PUT /v1/commands/:id/occurrences/:stage/:occ` | Binds an occurrence: `intentId`, `expansionKey`, args digest and the observations it derives from. | gen |
| `POST /v1/commands/:id/outcomes` | Records one or more operation outcomes. | gen |
| `POST /v1/commands/:id/finish` | Writes the terminal status and result digest. The status is aggregated by Policy from the recorded outcomes, never taken from the worker. | gen |
| `POST /v1/commands/:id/transition` | **Extension point** (Track E2): a conditional write with an optional scheduling intent. B5 implements the fenced write and refuses any intent with `not-supported`. | gen |
| `GET /v1/commands/:id` | Reads the record for the api's status URL. Owner only. | — |

Every fenced write is a Firestore transaction that compares `owner.generation`. A stale writer gets `409 stale-generation` and stops.

## 4. Admission and occurrences

**Intents in the model** (kernel, `crates/core/src/model.rs`):
- `Model` gains an optional `intents: [{ id, fn, op, scope, bounds }]`.
  - `id` is stable.
  - `scope` is the connection or item it acts on.
  - `bounds` carries the expansion limits, `{ maxOccurrences }` for now.
- A new hook, `Dialect::intents(model) -> Vec<Intent>`, defaults to none. A language with effects declares them from its compiled program, so L0176 lists one intent per `save-to-itembank` call site.
- An intent's static occurrence id is today's `<key>.<N>`. The digest covers `intents` only when the list isn't empty (decision 5).

**Admission** (Policy, `policy.ts` admission):
- `admit` takes, per stage, the model digest and the intent list along with today's manifest.
- It refuses `intent-not-registered` when an intent's `fn`/`op` isn't in the protected registry for the language.
- The admission token's `pld` covers the model digests. Each stage then runs only if its model's digest equals the one admitted for its stage id.

**Occurrence checks** (Policy, at mint and again at authorize-execution) for a `command`-protocol invocation:
- **Static id.** It must equal an admitted intent's static id. An id beginning `x:` is never static, and a test pins that.
- **Runtime id (`x:<sha256>`).** It must have a bound occurrence record in which:
  - the `intentId` is admitted;
  - the id recomputes from `{intentId, expansionKey}`;
  - the count of bound occurrences for the intent is within `bounds.maxOccurrences`;
  - every observation it names is recorded in the command.

  "Justified" is checked structurally: the observations exist and belong to the command. What an expansion key *means* stays the language's (plan B5, split of responsibilities).
- **Arguments.** The `argd` must equal the bound occurrence's args digest.
- Anything else is refused before any provider call.

## 5. Pinned inputs and observations

- **Stage inputs.** Before a stage's first effect, the api pins the stage's resolved input (the upstream output, or the caller's `data` for the tail) with `PUT inputs/:stage`. A retry or a takeover reads the pinned digest and loads that input. It never re-resolves upstream.
  - This also covers the "stage's resolved output as a whole" form of a recorded observation that design §5 allows for materialization later (B6).
- **Observations inside a stage.** A new kernel call, `ExecContext::observe(key, read)`, works in three steps:
  1. It asks Policy to allocate or find the observation `o:<sha256 {stage, key}>`.
  2. If one is recorded, it returns that observation without calling `read`.
  3. Otherwise it runs `read` and installs the result, which is install-once, so on a race the first one wins and both callers use it.
- **A new check is a new observation.** The language makes the key (`poll 3`), so a poll is never answered from an older poll's record.
- **No caller in B5.** The first users are C3 (L0185 feeding a command) and Track E. B5 ships the hook and its tests.

## 6. Running a command (api worker)

`POST /command { id, connection, idempotencyKey, data? }` (D1). The key is required.
1. **Allocate.** `POST /v1/commands`.
   - **Existing and terminal:** return the recorded outcome. A retry never upgrades it.
   - **Existing with a live lease:** return `pending`, the command id and the status URL.
   - **Existing with an expired lease:** take over (§7).
   - **A `legacy` protocol on the key** (D2a): hand the request to today's legacy compile path with its admitted plan. No command record is touched.
2. **Model and admit.** Compile each stage's model, which the model cache may serve. Then `admit` with the ordered model digests and intents.
3. **Run right to left.** For each stage:
   - an effect-free stage is interpreted as today (B3, `evaluate`);
   - a stage with intents is pinned (§5), then called with `/interpret { operation: "start", model, input, identity }`. The identity carries the session token, which holds `cmd` and `fg`.
   - The kernel's `invoke` binds each occurrence (§4) before minting, then runs through Policy and the Broker as today.
4. **Record.** Each stage's `effects` are recorded with `POST outcomes`, keyed `<stage>/<occurrence>`.
   - A lost response from a stage that may have acted records `uncertain` for that stage's admitted intents with no outcome (today's synthesized `uncertain`, `data.js:523`).
   - When a stage fails, the chain stops, and the stages to its left are recorded `not-reached`.
5. **Finish.** `POST finish`. Policy aggregates, per design §5:
   - `completed`: every operation completed;
   - `failed`: no write anywhere;
   - `uncertain`: any operation is uncertain;
   - `partial`: otherwise.

   Only `completed` replaces the artifact (the existing per-invocation store), and that write is fenced too: the api writes the artifact only after `finish` accepts its generation.
6. **Respond.** `{ commandId, outcome, statusUrl }`. `GET /command/:id` reads the record, owner only.

**Kernel** (`crates/core`, `crates/server`):
- `/interpret` accepts `operation: "start"`, which defaults to `get`.
- `start` on a model without intents is refused with `no-intents`. `get` never invokes, as today.
- For a plan model, `start` runs today's compile path under the command identity, so L0176's `save_to_itembank` is reached unchanged.
- `next_occurrence` stays as it is for static ids. A new `ExecContext::expand(intent, expansion_key)` returns the `x:` id and binds it.

## 7. Leases, fencing and recovery

- **Renewal.** The worker renews every 20 s. A failed renewal, or any `stale-generation`, stops the worker, which returns `pending` to its caller.
- **Fencing at authorization.** `authorize-execution` (`policy.ts:670`) loads `commands/{cmd}.owner.generation` and refuses `stale-generation` when the token's `fg` is lower.
  - The Broker already calls it before every step, so a stale worker can't begin an operation or a step.
  - An operation it claimed before that is settled by the Broker's receipt claim. The new owner finds the claim and gets the recorded outcome, or `uncertain`.
- **Takeover.** The new owner increments the generation and reloads the record:
  - stages with a pinned input reuse it;
  - bound occurrences reuse their arguments;
  - operations with recorded outcomes are skipped.

  Every remaining occurrence presents the same opid and arguments, so the Broker replays anything that already ran.
- **The sweeper** (decision 3) queries `commands` where `status == "pending"` and `owner.leaseExpiresAt < now`, takes each one over, and runs it as in §6 from step 2.
  - The query needs a composite index on `(status, owner.leaseExpiresAt)`. Releases don't deploy `firestore.indexes.json`, so the index is deployed by hand and checked before the api release.
  - `runRef` and a `pending` with no owner are allowed by the schema, but B5's sweeper never produces them (Track E extension points).

## 8. D2a, D2b and the flag

- **D2a.** `POST /v1/commands` and `/v1/invocations` both record `protocol`.
  - `/v1/invocations`, the legacy compile path, records `legacy`. An invocation without the field reads as `legacy`.
  - `/command` allocates `command` only when `COMMANDS_LNNNN=on` for the head language, and refuses `commands-not-enabled` otherwise. Nothing in B5 turns that flag on.
  - A key allocated under one protocol is refused by the other path. It is never adopted.
- **D2b.** The deploy CLI records `commandFloor: true` in the release receipt of the first api that carries B5.
  - `rollback --release` refuses a target without it once Policy reports that any command record exists, through a count endpoint the CLI reads.
  - The guard in `release.js` already refuses a `COMMANDS_` flag change without a generation change.

## 9. Slices and release order

Each slice is one PR. CI covers each one, and the slices are additive: nothing calls the new code until slice 7.

| # | Slice | Package | Release |
|---|---|---|---|
| 1 | Command record, `POST /v1/commands` (atomic allocate, protocol, lease gen 1), lease renew/takeover, `GET`, and `protocol` on `/v1/invocations` | policy | Policy |
| 2 | Fenced writes: inputs, observations, occurrences, outcomes, finish (aggregation as a pure function in `common`), and `transition` (the extension point) | policy, common | Policy |
| 3 | Optional `cmd`/`fg` claims, `stale-generation` in authorize-execution, the occurrence checks at mint and authorize, and admission with model digests and intents | policy | Policy (P1b expand; no `REGISTRY_VERSION` bump: the registry's contents are unchanged) |
| 4 | Kernel: `Model.intents` (digest covers it only when present), `Dialect::intents`, `/interpret` `operation: "start"`, `ExecContext::observe`/`expand`, the policy client's command calls, and removal of the legacy key-sorted digest fallback | l0000 crates | All 19 Rust services, by redeploy (no behavior change: no dialect declares intents) |
| 5 | api worker: `POST /command`, `GET /command/:id`, the right-to-left command run, fenced artifact write, lease renewal | api | — (lands with 7) |
| 6 | Sweeper route, scheduler account and job, the composite index | api, infra | Index first, then the job after 7 |
| 7 | D2a dispatch on the recorded protocol, the `COMMANDS_` check, and the D2b floor in the deploy CLI | api, deploy | **api = the D2b floor**, then soak |

The Broker doesn't change: fencing reaches it through `authorizeStep`. Its receipt claim already settles races.

**Order:** Policy (1–3), Rust services (4), index, api (5–7) with the scheduler job, then a soak. Each release follows `--plan`, candidate check and promote, as usual.

## 10. Tests that close B5

Design §12 acceptance criteria 2, without the repair items (B6). They run against a **declared test command language**: a fake dialect in `languages/l0000/crates/core/tests`, plus a declared fake in `packages/api/src/command.spec.js`. The api tests run against in-process Policy and Broker, as `w4.spec.js` and `at12.spec.js` do, under the emulator.

**Identity**
- A `/command` without a key is refused.
- The same key with the same input returns the recorded outcome with no new provider call (the Broker's fake provider counts calls).
- The same key with different input is a conflict.
- Sixteen concurrent duplicates execute once; the others see `pending`, then the outcome.

**Pinning and occurrences**
- A chain with a fetched upstream (a fake L0185-like stage whose answer changes per call) loses its first response. The retry uses the pinned input and reaches the same receipts, never `operation-id-reused`.
- An `x:` occurrence within bounds is authorized. One over `maxOccurrences`, one naming an unrecorded observation, or one with a mismatched encoding is refused before the provider.
- An occurrence not in the admitted intents is refused, and so is a model whose digest differs from the admitted one.
- No static id begins with `x:`.
- An observation that has been recorded is replayed and its read never runs again, while a new key (`poll 2`) runs the read.

**Ownership**
- A worker killed after the claim is recovered by the sweeper after its lease expires, with no caller retry and no repeated write.
- A paused original worker resumes after a takeover:
  - its pin, outcome, finish and artifact writes get `stale-generation`;
  - the pinned input is never replaced;
  - its new operation is refused at authorize-execution;
  - an operation it claimed before the refusal appears in the terminal outcome.

**Outcomes**
- Two saves, the first completed and the second failed, give `partial`.
- A lost stage response gives `uncertain`.
- `failed`, `partial` and `uncertain` are returned unchanged on retry, and none replaces the artifact.

**Protocol and floor**
- A `legacy` key retried through `/command` is refused.
- A `command` key is never compiled by the legacy path.
- Two concurrent first allocations with one key during an overlapping release: one wins, and both follow it.
- `rollback --release` below the floor is refused once a command exists. This is a `node --test` case in `packages/deploy`.
- With `COMMANDS_LNNNN` off, `/command` is refused and the legacy compile is unchanged. This runs over the existing `w3`/`w4`/`at12` suites.

**Soak.** Two weeks on the floor api with the sweeper running and no command traffic. Then a staged drive: a revision tagged with `COMMANDS_` on for the test language only, 200 commands with injected kills and lost responses, and the outcomes checked against the fake provider's call log.

Real-language evidence (L0176 saves, L0013 snapshots) belongs to C6 and C5 and to the B6 entry gate.

## 11. Out of scope

- B6: repair commands, the repair ledger, `materialize` and resuming `not-reached` stages.
- Activating any language: C5, C6, and D2's bridge (C5e, C6).
- Track E: run records, timers, scheduling intents, overdue-wait sweeps and continuation grants.
- D3 caller migration (console, MCP), and D4.

## 12. Risks

- **Firestore transaction contention** on a hot command under 16 duplicates. The allocate transaction is the only one they share, and the rest read the record. The concurrency test measures it.
- **Lease renewal during a long stage.** A stage with a 240 s deadline outlives a 60 s lease, so renewal runs on its own timer and isn't tied to stage completion.
- **The digest-only-when-present rule** must hold in the kernel, the api's `exactDigest` and Policy alike. One golden test per side pins the same digest for a model with and without intents.
- **The legacy model-digest fallback** in `model.rs:from_json` is removed in slice 4, the same redeploy, so admission never accepts the key-sorted form.
