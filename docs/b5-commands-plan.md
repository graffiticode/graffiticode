# B5 Commands, part 1: implementation plan

**Status:** reviewed (2026-11-07). The decisions in §2 are confirmed by the owner, and the review's corrections are folded in.
**Parents:** [interpreter plan](graffiticode-interpreter-plan.md), B5, D1, D2a and D2b; [interpreter design](graffiticode-interpreter-design.md), §5 "Immediate commands" and §12 acceptance criteria 2.
**Entry gate:** passed 2026-11-06 (`docs/evidence/b5-gate/`).

This plan turns B5's bullets into code-sized slices. It covers what exists today, the pieces to build, where each one lives, the order of the slices and releases, and the tests that close B5.

B5 activates no language. `COMMANDS_LNNNN` stays off everywhere until C5 (L0013) or C6 (L0176). B5 is done when the platform holds commands end to end against a declared test language, and the api carrying it is released as the D2b rollback floor.

## 1. Where we start

| Need | Today | Gap |
|---|---|---|
| Command identity | Policy `allocate` reuses an invocation per `(uid, idempotencyKey)` and refuses a different binding (`packages/policy/src/invocations.ts:57`). Keys are optional. | The allocation records no execution protocol (`legacy`/`command`) and no command id (D2a). Keys aren't required. |
| Admission | Binds a per-stage `StageManifest`: source, program and options digests, revision, image, registry version and required functions (`policy.ts:781-888`). | No stage model digest. No effect intents. |
| Occurrences | `ExecContext::next_occurrence(key)` returns `<key>.<N>` per compile (`languages/l0000/crates/core/src/exec.rs:308`). L0176's key is `SAVE_TO_ITEMBANK:<span.from>`. Policy forms `opid = inv/stg/occ` (`policy.ts:637`) and checks it only against `ID_RE`. | Occurrences aren't checked against an admitted intent. No `x:` runtime occurrences. |
| Effects | Run only inside a legacy compile through a connection. Interpreted stages never run through one (`packages/api/src/data.js:276`). | No `start` on `/interpret`. |
| Pinned inputs | `inputDigest` (a hash of `options`), plan pins (`lookupPlan`) and the execution token's `argd`. | Nothing stores a command's request, models, resolved inputs or observations. |
| Outcomes | Broker receipts per opid (`receipts/{sha256(opid)}`, with steps, outcome and resolution). Each response carries `effects`, and `takeEffects` lifts them out (`data.js:355`). | No per-command record of outcomes, and no aggregation. |
| Ownership | Policy's `admission-leases` is a revision-retirement fence. The Broker's `active-executions` exists for draining. | No execution lease, fencing generation or takeover. |
| Recovery | The caller retries with the same key. Policy's reconcile (`packages/broker/src/reconcile.ts`, over the Policy-only `POST /reconcile`, `packages/broker/src/app.ts:95`) resolves uncertain writes against the provider. Replay goes through Policy mint (`liveRefusal`, `policy.ts:602`) and needs the connection's credential (`broker.ts:384-403`). | No sweeper, and no way to read receipts without live permission and a credential. |
| Public contract | `POST /compile` takes an optional `Idempotency-Key` and `connectionId` (`routes/compile.js:71`). | No `POST /command` and no command status URL (D1). |
| Rollback floor | The deploy CLI guards flag and generation changes (`release.js:188`). | No floor is recorded, and nothing refuses a rollback below it (D2b). |

## 2. Decisions (confirmed 2026-11-07)

1. **Policy owns the command record.** Allocation, protocol, lease, fencing generation, admission, occurrence bindings and outcomes all live in Policy's named Firestore database `policy` (`packages/policy/src/main.ts:61`), next to `invocations`.
   - **Why Policy.** D2a requires the protocol and command id to be written atomically with the key, and authorize-execution must read the current generation on every step. Both already live in Policy.
   - **The api is the worker.** It calls Policy's command endpoints and never writes the record directly.
2. **Payloads are stored in Firestore.** This covers the request, models, pinned inputs, observations and occurrence arguments.
   - **The text is stored exactly.** Each payload is kept as its exact JSON text, with key order preserved. It is never re-serialized or sorted, which would reintroduce the ordering defect the B5 drive found (#296, #306).
   - **Size limits.** Each payload is capped at 512 KiB of serialized UTF-8, and a larger one is refused with `input-too-large`.
   - **Indexing.** Payload fields are exempt from indexing (§7).
   - **Document size.** The parent record stays well under Firestore's 1 MiB document limit: payloads, models, occurrences and outcomes live in subcollections, and the parent keeps only summaries.
   - **Fallback.** A content-addressed GCS store is the fallback if a real caller exceeds the cap. It would need its own IAM step, so it isn't in B5.
3. **Recovery is service-authenticated, and is driven by Cloud Scheduler through the api.**
   - **The trigger.** `POST /internal/commands/sweep` runs every minute, invoked with OIDC by a dedicated scheduler account.
   - **Which calls need which identity.** Only allocation takes the user's token. Every later call (initialization, admission, lease, session mint, settlement, bookkeeping) takes the api's service identity plus the command id and generation.
   - **Whose authority.** The principal is always the one stored on the command, never a caller's token, so recovery never depends on a user's token staying valid.
   - **Two kinds of action** (§7):
     - **Dispatch** of new effects rechecks live permission.
     - **Bookkeeping** of what already happened is fenced, but needs no live permission.
4. **Leases.** A lease runs for 60 s, and the worker renews it every 20 s. Execution tokens stay at 60 s.
   - Every owner write and every new effect authorization needs both an **unexpired lease** and **exactly the current generation**.
   - A request with any other generation is refused, whether it is lower or higher.
5. **Intents travel in the model and are omitted when empty.** The kernel model gains an optional `intents` field.
   - An empty or absent list is left out of both the serialization and the digest input.
   - So every existing model keeps its exact JSON text and its digest, and neither the api's whole-model cache key (`exactDigest`) nor its stage cache churns.
6. **Fencing rides on token claims that are optional for legacy and mandatory for commands.**
   - **What's added.** Session and execution tokens gain `cmd` (the command id) and `fg` (the fencing generation).
   - **Why optional.** They are optional in the token schema, so older Brokers and compilers still verify the tokens (P1b expand).
   - **Mandatory for commands.** For a `command`-protocol invocation they must be present. They are checked at mint and at every step authorization. Each check binds them to the command, its invocation (`inv`), its principal (`sub`) and an admitted stage (`stg`).
   - **Effect on the Broker.** Fencing reaches the Broker through `authorizeStep`, so its execution path doesn't change. The Broker gains one read-only, Policy-only route, `POST /receipts` (§7).

## 3. The command record

The command record is the Policy document `commands/{commandId}`. Its id is `c:` plus the hex SHA-256 of `[uid, idempotencyKey]`, so a key maps to exactly one record. The parent holds only summaries:

```
{
  schema: 1,
  commandId, uid, idempotencyKey, invocationId, protocol: "command",
  lang, taskId, connectionId,
  binding: { connectionId, taskId, inputDigest },
  phase: "allocated" | "initializing" | "admitted",
  admission: { planDigest, stages: { s0: { modelDigest, revision, tagUrl }, … } } | null,
  owner: { worker, generation, leaseExpiresAt },   // generation increments on every takeover
  status: "pending" | "completed" | "failed" | "partial" | "uncertain",
  result: { state: "none" | "available" | "unavailable", digest },
  publication: { state: "none" | "due" | "published", resultDigest },
  stages: { s0: { state: "pending" | "ran" | "not-reached", expansion: "open" | "closed", pinnedInput }, … },
  counts: { bound, completed, failed, partial, uncertain },  // a summary; the outcomes are the truth
  revisions: { compiler, interpreter: { s0: tagUrl, … }, registryVersion },
  runRef: null,                       // extension point (Track E1); B5 never sets it
  createdAt, updatedAt
}
```

Subcollections; every payload in them is exact JSON text and unindexed:
- `request/original`: the caller's `id`, `data`, `connectionId` and options, written at allocation.
- `models/{stage}`: the stage's model with its digest, revision and tagUrl, installed once.
- `inputs/{stage}`: the stage's pinned input, installed once.
- `observations/{observationId}`: recorded external reads, installed once.
- `occurrences/{stage}:{occurrenceId}`: `intentId`, `expansionKey`, the full arguments and their digest, the observations it derives from, and the issuance log `minted: [{ jti, exp }]`.
- `outcomes/{stage}:{occurrenceId}`: `{ outcome, source: "receipt" | "policy-refusal" | "lost-response", receipt, reason, at, generation }`.
- `result/final`: the head stage's answer, when `result.state` is `available`.

**Policy endpoints.** All are idempotent. "Fenced" means the request needs a live lease and exactly the current generation; a stale request gets `409 stale-generation` and changes nothing.

| Endpoint | Caller | Does | Kind |
|---|---|---|---|
| `POST /v1/commands` | user token | Allocates or finds. In **one transaction** it creates the invocation, the key, the command and `request/original`, records `protocol`, and claims the first lease at generation 1. A second caller gets the existing record. A different binding is a conflict (`idempotency-key-reused`). | allocation |
| `POST /v1/commands/:id/lease` | service | Renews the lease, or takes over (`expected: gen`) once it has expired, which increments the generation. | fenced |
| `PUT /v1/commands/:id/models/:stage` | service | Installs a stage's model if absent. | fenced |
| `POST /v1/commands/:id/admit` | service | The first admission, from the stored models under the stored principal. In one transaction it binds every stage's model digest, revision and intents, and sets `phase: admitted`. Live permission is checked. | dispatch |
| `POST /v1/commands/:id/session` | service | Mints the stage's session token with `cmd` and `fg`. Live permission is checked. | dispatch |
| `PUT /v1/commands/:id/inputs/:stage` | service | Installs a stage's pinned input if absent, and returns the installed one either way. | fenced |
| `PUT /v1/commands/:id/observations/:oid` | service | Allocates or installs one observation (§5). | fenced |
| `PUT /v1/commands/:id/occurrences/:stage/:occ` | service | Binds an occurrence, checking it against its intent and its bounds (§4). | fenced |
| `POST /v1/commands/:id/stages/:stage/close` | service | Closes a stage's expansion (§4). | fenced |
| `POST /v1/commands/:id/settle` | service | Records outcomes from the Broker's receipts (§7). | bookkeeping |
| `POST /v1/commands/:id/lost` | service | Records `uncertain` (`lost-response`) for a stage's bound occurrences that have no receipt and whose response was lost. | bookkeeping |
| `POST /v1/commands/:id/finish` | service | Writes the terminal status, aggregated by Policy from the recorded outcomes (§6), and the result if one is available. Create-once. | bookkeeping |
| `POST /v1/commands/:id/published` | service | Marks the publication delivered. | bookkeeping |
| `POST /v1/commands/:id/transition` | service | **Extension point** (Track E2): a conditional write with an optional scheduling intent. B5 implements the fenced write and refuses any intent with `not-supported`. | fenced |
| `GET /v1/commands/:id` | user token (owner) or service | Reads the record for the status URL. | read |

Mint and authorize-execution of a command's execution tokens use today's endpoints, with the checks in §4 and §7.

## 4. Admission, intents and occurrences

**Intents in the model** (kernel, `crates/core/src/model.rs`):
- `Model` gains an optional `intents: [{ id, fn, op, scope, bounds }]`:
  - `id` is stable;
  - `scope` is the connection or item it acts on;
  - `bounds` is `{ maxOccurrences }` for now.
- An empty list is omitted from serialization and from the digest (decision 5).
- A new hook, `Dialect::intents(model) -> Vec<Intent>`, defaults to none. A language with effects declares them from its compiled program, so L0176 lists one intent per `save-to-itembank` call site.
- A static intent's occurrence id is today's `<key>.<N>`.

**Admission** (Policy). `admit` binds, in one transaction, each stage's model digest and intents along with today's manifest.
- It refuses with `intent-not-registered` when an intent's `fn` or `op` isn't in the protected registry for the language.
- The admission token's `pld` covers the model digests, and a stage runs only if its model's digest equals the one admitted for its stage id.

**Occurrence checks.** Policy runs these at binding, at mint, and again at authorize-execution, for a `command`-protocol invocation:
- **The intent.** The occurrence's `fn`, `op` and `scope` must equal those of its admitted intent.
- **Static ids.** The id must equal an admitted intent's static id. An id beginning `x:` is never static, and a test pins that.
- **Runtime ids (`x:<sha256>`).** They need a bound occurrence record in which:
  - the `intentId` is admitted;
  - the id recomputes from `{intentId, expansionKey}`;
  - every observation it names is recorded in the command.

  "Justified" is checked structurally: the observations exist and belong to the command. What an expansion key *means* stays the language's (plan B5, split of responsibilities).
- **Bounds are enforced atomically.** Binding increments a per-intent counter in the same transaction, so concurrent binds can never exceed `maxOccurrences`.
- **Arguments.** The token's `argd` must equal the bound occurrence's args digest.
- Anything else is refused before any provider call.

**Closing expansion.** Settlement needs durable evidence that a stage has finished creating occurrences.
- **Static intents** are closed at admission: their occurrence ids are fixed by the admitted model.
- **Runtime-expanded intents** stay `open` until the stage closes them. The kernel's `start` answer lists each intent's final occurrence ids. On receiving the answer, the worker calls `close` with that list.
  - Policy checks that every listed id is bound and that nothing else is bound, then records `expansion: closed`.
  - A stage that ended in an error closes with what it bound.
- A stage left `open` after a crash is **resumed, not settled** (§7).

## 5. Pinned inputs and observations

- **Stage inputs.** Before a stage's first effect, the api pins the stage's resolved input with `PUT inputs/:stage`: the upstream output, or the caller's `data` for the tail. A retry or a takeover loads the pinned input and never re-resolves upstream.
  - This also covers the "stage's resolved output as a whole" form of a recorded observation, which design §5 allows for materialization later (B6).
- **Observations inside a stage.** A new kernel call, `ExecContext::observe(key, read)`, works in three steps:
  1. It asks Policy to allocate or find the observation `o:<sha256 {stage, key}>`.
  2. If one is recorded, it returns that record without calling `read`.
  3. Otherwise it runs `read` and installs the result. Installation is install-once, so on a race the first one wins and both callers use it.
- **A new check is a new observation.** The language makes the key (`poll 3`), so a poll is never answered from an older poll's record.
- **No caller in B5.** The first users are C3 (L0185 feeding a command) and Track E. B5 ships the hook and its tests.

## 6. Running a command (api worker)

`POST /command { id, connection, idempotencyKey, data? }` (D1). The key is required.

**1. Allocate** with `POST /v1/commands`. **The allocation winner decides dispatch** (D2a), on every path:
- **A new key** allocates `command` only while `COMMANDS_LNNNN=on` for the head language, and is otherwise refused with `commands-not-enabled`. Flags govern only new allocations.
- **An existing `command` key**, arriving through `/command` or `/compile`, is served from its record, whatever the flags are now:
  - **terminal:** the recorded outcome is returned, and a retry never upgrades it;
  - **live lease:** `pending`, the command id and the status URL;
  - **expired lease:** take it over (§7).
- **An existing `legacy` key** arriving through `/command` is served by today's legacy path at its admitted plan. No command record is touched.

**2. Initialize until admission commits.** This step is resumable:
- install each missing stage model with `PUT models/:stage`, reusing those already installed;
- then `admit`.

Before admission nothing is pinned and no effect has run, so compiling a missing model now is safe. Once `phase` is `admitted`, the models and revisions are never compiled or resolved again.

**3. Run right to left.** For each stage:
- An effect-free stage is interpreted as today (B3, `evaluate`), from the admitted model at its pinned revision.
- A stage with intents:
  1. is pinned (§5);
  2. gets a session from `session`;
  3. is called with `/interpret { operation: "start", model, input, identity }` at its pinned tagUrl.
- The kernel's `invoke` binds each occurrence (§4) before minting, then runs through Policy and the Broker as today.

**4. Record what happened.**
- **The stage answered:** `close` the stage, then `settle`. Outcomes come only from Policy: from receipts, from Policy's own refusals (§7), or as `lost-response`.
- **The response was lost:** `settle` first, then `lost` for bound occurrences with no receipt. Each operation is then:
  - `completed` if its receipt recorded success;
  - `uncertain` if its receipt was claimed with no final outcome, or if it has no receipt.
- **The chain stops at a stage that failed or lost its response.** The stages to its left are `not-reached`. `not-reached` describes stages and never decides the status.

**5. Finish.** `finish` aggregates the recorded outcomes, per design §5:
- `uncertain` if any operation is uncertain;
- `failed` if nothing was written anywhere;
- `completed` only if every admitted operation completed, every stage that ran is closed, and no intent-bearing stage is `not-reached`;
- `partial` otherwise.

The result is separate from the status:
- It is `available` only when the worker received the head stage's own answer, and `finish` records it.
- Receipts hold operation outputs, not the program's result, so B5 **never reconstructs a result from them**. Safe reconstruction is B6's `materialize`.
- `completed` with `result: unavailable` is a valid terminal state: there is nothing to publish, and the current artifact stays in place.

**6. Publish through an outbox.** For `completed` with a result available, `finish` also commits `publication: { state: due, resultDigest }` in the same transaction.
- **Delivery.** It is `artifacts.put` (the existing per-invocation store). For a command invocation it takes the command id, reads the committed `resultDigest`, and refuses content whose digest differs.
- **Why check-then-write is safe.** The checked value is immutable once `finish` commits. The store acknowledges an identical put and refuses any other, and the head moves by compare-and-set on `seq`, which orders invocations.
- **Marking it delivered.** After the put, `published`.
- **Invariant.** Every command-record write is fenced. The artifact is a projection of the fenced `finish`, delivered at least once, and it can only ever hold the committed content.

**7. Respond.** `{ commandId, outcome, result: available | unavailable, statusUrl }`. `GET /command/:id` reads the record, for the owner only.

**Kernel** (`crates/core`, `crates/server`):
- `/interpret` accepts `operation: "start"`, and `get` remains the default.
- `start` on a model without intents is refused with `no-intents`. `get` never invokes, as today.
- For a plan model, `start` runs today's compile path under the command identity, so L0176's `save_to_itembank` is reached unchanged. Its answer lists each intent's occurrence ids.
- `next_occurrence` stays as it is for static ids. A new `ExecContext::expand(intent, expansion_key)` returns the `x:` id and binds it.

## 7. Leases, fencing, settlement and recovery

**Fencing.**
- **Renewal.** The worker renews its lease every 20 s, on its own timer, since a stage can run up to 240 s. A failed renewal, or any `stale-generation`, stops the worker, and it returns `pending` to its caller.
- **At authorization.** Mint and authorize-execution (`policy.ts:670`) load the command and refuse `stale-generation` unless the token's `fg` equals the current generation **and** the lease is live. The Broker already calls authorize-execution before every step, so a stale worker can't begin an operation or a step.
- **A stale request changes nothing.** It is refused with no outcome, status or record write of any kind.

**Dispatch versus bookkeeping.**
- **Dispatch** authorizes new effects and rechecks live permission with `liveRefusal` every time: the first admission, the session mint, execution mint and authorize-execution.
  - `liveRefusal` checks that the connection exists and is enabled, the principal's ownership or access, an unchanged backend, and the grant.
  - It doesn't check account status (§11).
- **Bookkeeping** records what already happened. It is fenced and service-authenticated, with **no** live-permission check: lease takeover, `close`, `settle`, `lost`, `finish` and `published`.
- **So revocation stops remaining effects and never changes what already happened.** A command whose writes all completed before the connection was revoked still ends `completed`, and its due publication is still delivered.

**Settlement from receipts.**
- **The Broker route.** `POST /receipts` on the Broker is Policy-only, with the same caller-role check as `/reconcile`.
  - It takes an `invocationId`, and optionally opids, and returns each claim's binding, persisted steps and recorded outcome; a claim with no outcome reads as `uncertain`.
  - It reads `receipts` only. It takes no execution or replay token, reads no credential, never calls a provider and claims no `jti`, so it can't dispatch.
- **Policy's `settle`.** It calls that route for the command's invocation and records an outcome for each bound occurrence that has a receipt. It names the receipt's opid and checks that the opid belongs to the invocation, an admitted stage and a bound occurrence.
- **The worker never asserts an outcome.**

**Policy's own definite refusals.** When Policy refuses to admit or mint for the current owner, it may record `failed` (`source: policy-refusal`), but only when it can show that **no attempt** at the occurrence wrote anything or can still write:
- **A refused first admission.** Every occurrence of the refused stages is recorded `failed`. Nothing is ever minted for an unadmitted stage.
- **A refused mint.** Policy settles the opid first:
  - **A claim exists:** its receipt decides.
  - **No claim, and the occurrence's issuance log shows no token ever issued:** `failed`.
  - **No claim, but a token was issued:** nothing is recorded until every issued token has expired and the Broker's operation deadline has passed. Policy then settles again: a claim decides, and if there is still none, the occurrence is recorded `failed`. The Broker claims before any provider call, so an unclaimed opid whose tokens can no longer be used has written nothing.

    Until such an occurrence settles the command stays `pending`, and the sweeper revisits it.
- **The issuance log is committed before any token leaves Policy.** Before returning an execution token, Policy commits its `jti` and `exp` to the occurrence's issuance log, in a transaction that checks the live lease and the current generation. No token is returned without that committed entry. So an empty log proves that no token for the occurrence ever existed.
- **Only definite reasons are recorded:** `liveRefusal`'s reasons, and the intent, scope and bounds refusals.
- **Transient refusals record nothing** (`token-expiring`, unavailability, rate limits). The occurrence stays open for the next attempt.
- **Refusals inside the Broker** after a claim are already the receipt's `failed` or `partial`, and are settled through `/receipts`.

**Takeover and resumption.** The new owner takes the lease (the generation increments), settles, and then continues from the record:
- **Not `admitted`:** finish initialization (§6 step 2) from the stored request, reusing the installed models, under the stored principal.
- **Admitted:** load the models, revisions, pinned inputs and occurrence arguments, and resume at the first unfinished stage. §6 step 2 never runs again against current services.
- **A stage left `open`** is re-run with `start` on its pinned input at its pinned revision. Its bound occurrences present their recorded opids and arguments, so the Broker replays them with no provider call, and expansion continues.
- **When resuming isn't possible** (the connection was revoked, or the revision is gone), the open stage is aggregated as not complete: `partial` if anything was written, `uncertain` if anything is uncertain, and `failed` if nothing was. It is never `completed`.
- **A due publication** is delivered from the committed result.

**The sweeper** (decision 3) takes over `commands` that are `pending` with an expired lease, or have a publication `due` with an expired lease.

**Indexes.** They go in the named database `policy`. The root `firestore.indexes.json` and `firebase.json` target the default database and aren't involved.
- **What's needed:**
  - composite indexes `(status, owner.leaseExpiresAt)` and `(publication.state, owner.leaseExpiresAt)` on `commands`;
  - single-field index exemptions for the payload fields in `request`, `models`, `inputs`, `observations`, `occurrences` and `result`.
- **Where they're recorded:** `configs/firestore-policy-indexes.json`.
- **How they're deployed:** by hand, with `gcloud firestore indexes composite create --database=policy …` and `gcloud firestore indexes fields update --database=policy … --disable-indexes`. Releases never deploy indexes.
- **The check before slice 7:** `gcloud firestore indexes composite list --database=policy`.

`runRef` and a `pending` with no owner are allowed by the schema, but B5's sweeper never produces them (Track E extension points).

## 8. D2a, D2b and the flags

- **D2a. The protocol is recorded at allocation and decides dispatch on every path.**
  - `POST /v1/commands` records `command`. `/v1/invocations` (the legacy compile path) records `legacy`, and an invocation without the field reads as `legacy`.
  - A `legacy` key is served by the legacy path, even through `/command`. A `command` key is served from its record, even through `/compile`.
  - Nothing is ever adopted across protocols.
  - `COMMANDS_LNNNN` governs only new allocations. Existing `command` keys stay serviceable after it turns off. Nothing in B5 turns it on.
- **D2b. The rollback floor.**
  - The deploy CLI records `commandFloor: true` in the release receipt of the first api that carries B5.
  - `rollback --release` refuses a target without it once Policy reports, through a count endpoint the CLI reads, that any command record exists.
  - The guard in `release.js` already refuses a `COMMANDS_` flag change without a generation change.

## 9. Slices and release order

Each slice is one PR, and CI covers each one. The slices are additive: nothing calls the new code until slice 7.

| # | Slice | Package | Release |
|---|---|---|---|
| 1 | The command record and its subcollections; `POST /v1/commands` (atomic allocate, protocol, request, lease at gen 1); lease renew and takeover; `GET`; `protocol` on `/v1/invocations` | policy | Policy |
| 2 | Fenced writes (models, inputs, observations, occurrences with atomic bounds, `close`, `transition`); bookkeeping (`settle`, `lost`, `finish`, `published`); the issuance log; aggregation as a pure function in `common` | policy, common | Policy (after 2b) |
| 2b | `POST /receipts`: read-only and Policy-only | broker | Broker, before slice 2's Policy release |
| 3 | `cmd`/`fg` claims, mandatory for commands; `stale-generation` with the live-lease check at mint and authorize; the intent, scope and occurrence checks; `admit` and `session`, service-authorized, with `liveRefusal`; Policy's definite-refusal records | policy | Policy (P1b expand; no `REGISTRY_VERSION` bump, since the registry's contents are unchanged) |
| 4 | Kernel: `Model.intents` (omitted when empty), `Dialect::intents`, `/interpret` `operation: "start"` with occurrence lists in its answer, `ExecContext::observe`/`expand`, the policy client's command calls | l0000 crates | All 19 Rust services by redeploy (no behavior change: no dialect declares intents) |
| 4b | Remove the key-sorted model-digest fallback from `model.rs:from_json` *(done 2026-11-08, after slice 7's release but before any language's `COMMANDS_` flag, so no admission ever saw the key-sorted form)* | l0000 crates | All 19 Rust services. **Drain gate:** every producer emits exact digests (the Rust services since #306, the api since #296), and the longest configured model-cache lifetime (`MODEL_CACHE_TTL_MS`, default 10 min) has passed since the last such release. It must land before slice 7. |
| 5 | The api worker: `POST /command`, `GET /command/:id`, resumable initialization, the right-to-left command run, settlement, outbox publication, lease renewal | api | — (lands with 7) |
| 6 | The sweeper route, the scheduler account and job, the `policy` database indexes | api, infra | Indexes first; the job after 7 |
| 7 | D2a dispatch on the recorded protocol for `/command` and `/compile`, the `COMMANDS_` check for new allocations, and the D2b floor in the deploy CLI | api, deploy | **api = the D2b floor**, then a soak |

**Order:**
1. Broker (2b).
2. Policy (1–3).
3. The Rust services (4, then 4b after its drain gate).
4. The indexes.
5. The api (5–7), with the scheduler job.
6. A soak.

Each release goes through `--plan`, the candidate check and promotion, as usual.

## 10. Tests that close B5

These are design §12 acceptance criteria 2, without the repair items (B6). They run against a **declared test command language**: a fake dialect in `languages/l0000/crates/core/tests`, and a declared fake in `packages/api/src/command.spec.js`. The api tests run against in-process Policy and Broker under the emulator, as `w4.spec.js` and `at12.spec.js` do. Every effect test also checks the fake provider's call count.

**Identity and dispatch**
- A `/command` without a key is refused.
- The same key with the same input returns the recorded outcome with no new provider call.
- The same key with different input is a conflict.
- Sixteen concurrent duplicates execute once; the others see `pending`, then the outcome.
- Two concurrent first allocations with one key during an overlapping release: one wins, and both follow it.
- A `legacy` key through `/command` follows the legacy path. A `command` key through `/compile` follows its record.
- With `COMMANDS_LNNNN` turned off:
  - a new key is refused;
  - an existing `command` key returns its recorded outcome, or resumes;
  - the legacy compile is unchanged, as shown by the existing `w3`, `w4` and `at12` suites.

**Pinning, intents and occurrences**
- A chain with a fetched upstream (a fake L0185-like stage whose answer changes per call) loses its first response. The retry uses the pinned input and reaches the same receipts, never `operation-id-reused`.
- An input with unsorted keys round-trips byte for byte.
- A model with no intents keeps its digest and the api's cache key.
- These are refused before the provider:
  - an occurrence whose `fn`, `op` or `scope` differs from its intent's;
  - an occurrence not in the admitted intents;
  - an `x:` occurrence over `maxOccurrences`, naming an unrecorded observation, or with a mismatched encoding;
  - a stage whose model digest differs from the admitted one.
- Concurrent binds past `maxOccurrences` bind exactly the bound.
- No static id begins with `x:`.
- A `close` that lists an unbound id, or omits a bound one, is refused.
- A recorded observation is replayed and its read never runs again, while a new key (`poll 2`) runs the read.

**Ownership, recovery and revocation**
- These are refused:
  - a token with exactly the current generation but an expired lease;
  - one with a lower generation;
  - one with a higher generation.
- A stale-generation mint or write leaves the record byte for byte unchanged.
- The sweeper completes, with no user token, a command whose worker crashed:
  - right after allocation;
  - after some models were stored;
  - during admission.
- A worker killed after its first write is recovered by the sweeper once its lease expires, with no caller retry and no repeated write. This works after the user's token has expired, through the service identity and the stored principal.
- A paused original worker resumes after a takeover:
  - its pin, outcome, `close` and `finish` writes get `stale-generation`, and the pinned input is never replaced;
  - its new operation is refused at authorize-execution;
  - an operation it claimed before the refusal appears in the terminal outcome;
  - its artifact delivery is acknowledged only for the committed result, and refused for its own different one.
- A crash between occurrences: an intent allowing 100 occurrences completes occurrence 1, and the worker dies before binding occurrence 2. Settlement doesn't conclude `completed`. Recovery re-runs the stage: occurrence 1 replays with no provider call, occurrences 2 to n run, and the command ends `completed` once the stage closes. If the connection is revoked before recovery, the command ends `partial`.
- **Revocation.** Each case below runs through the real Policy and Broker authorization path, with the secret deleted where the case says so.
  - A write completes, the worker dies, and the connection is revoked and its secret deleted.
    - `settle` records `completed` from the receipt.
    - A replay through mint is refused (`liveRefusal`), which shows the old path can't do this.
    - The remaining occurrence is refused with no provider call, and the command is `partial`.
  - The connection is revoked before the first mint. The occurrence is `failed` (`policy-refusal`), and the command is `failed`.
  - The first write completes, then the connection is revoked before the second mint. The outcomes are `completed` (receipt) and `failed` (policy-refusal), so the command is `partial`.
  - A token was issued, the worker died, and the connection was revoked.
    - If the opid was claimed and completed, the occurrence is `completed`.
    - If it was never claimed, nothing is recorded until the token has expired, and then the occurrence is `failed`.
  - Every write completes, and the worker dies before `finish`. Then the connection is revoked. Recovery settles from the receipts, and the command ends `completed`.
  - `finish` commits `completed`, then the connection is revoked and the worker dies before delivery. The sweeper delivers the publication, and the outcome stays `completed`.
  - A transient mint refusal records nothing, and the retry proceeds.
  - **The issuance-log ordering.** Faults are injected at each point around a mint.
    - **The log commit fails, or its transaction finds a stale lease or generation.** No token is returned, the log is unchanged, and the provider is never called.
    - **Policy crashes after the log commit, before the response.** The entry exists with no token delivered. A later refusal waits for that entry's `exp` and the Broker's deadline, settles, and records `failed`. It never records `failed` early.
    - **Every token the Broker accepts for the opid has a matching log entry.** This is checked by `jti` across the fault runs.
  - `/receipts` called with any token, or from a non-Policy caller, is refused.

**Outcomes and results**
- Two saves, where the first completes and the second fails, give `partial`.
- All writes succeed, and the head stage's response is lost. The final expression transforms the save outputs, so it differs from them.
  - The command is `completed` with `result: unavailable`.
  - The artifact is unchanged and is never set to the receipt outputs.
  - A retry returns the same.
  - The same holds when the worker dies before `finish` and the sweeper settles it.
- An effect-free tail loses its response before the head's first write. The command is `failed`, with the head `not-reached`.
- A tail with intents loses its response, and its receipt is claimed with no final outcome. The command is `uncertain`, with the head `not-reached`.
- The same lost response, but the receipt records success. The operation settles `completed`, and the command aggregates with the head `not-reached`:
  - `partial` if the head has intents;
  - otherwise `completed`, with `result: unavailable`.
- `failed`, `partial` and `uncertain` are returned unchanged on retry, and none of them replaces the artifact.
- A crash after `finish` and before or after `artifacts.put` is delivered by the sweeper. A stale worker's `published` is refused.

**Floor**
- `rollback --release` below the floor is refused once a command exists. This is a `node --test` case in `packages/deploy`.

**Soak**
- Two weeks on the floor api with the sweeper running and no command traffic.
- Then a staged drive: a tagged revision with `COMMANDS_` on for the test language only, running 200 commands with injected kills, lost responses and revocations. The outcomes are checked against the fake provider's call log.

Real-language evidence (L0176 saves, L0013 snapshots) belongs to C6, C5 and the B6 entry gate.

## 11. Out of scope

- **B6:** repair commands, the repair ledger, `materialize` (including reconstruction of an unavailable result) and resuming `not-reached` stages.
- **Activating any language:** C5, C6, and D2's bridge (C5e, C6).
- **Track E:** run records, timers, scheduling intents, overdue-wait sweeps and continuation grants.
- **Caller migration:** D3 (console, MCP) and D4.
- **An account-status check in `liveRefusal`.** Today it checks connections, ownership or access, backend and grants. A later addition would add the lookup and its tests.

## 12. Risks

- **Transaction contention on a hot command.** With 16 duplicates, the allocate transaction is the only one they share; the rest read the record. The concurrency test measures it.
- **Lease renewal during a long stage.** A stage with a 240 s deadline outlives a 60 s lease, so renewal runs on its own timer rather than on stage completion.
- **The omit-when-empty rule** must hold in the kernel, the api's `exactDigest` and Policy alike. A golden test on each side pins the same digest for a model with and without intents.
- **The key-sorted digest fallback** goes in slice 4b, behind its drain gate and before slice 7, so admission never accepts the key-sorted form.
- **Occurrences waiting on token expiry** keep a command `pending` for up to a token lifetime plus the Broker's operation deadline after revocation. The sweeper settles them, and the status URL shows `pending` meanwhile.
