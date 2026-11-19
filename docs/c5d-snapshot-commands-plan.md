# C5d: snapshots as commands, the staged drive and activation

**Status:** draft for review (2026-11-19). This details C5d of [`docs/c5-l0013-commands-plan.md`](c5-l0013-commands-plan.md) ("§4 C5b–C5e, in outline"). C5a is complete: its gate passed 20/20 ([`docs/evidence/c5a-authorization/`](evidence/c5a-authorization/README.md)). So is C5b: `gs://graffiticode-thumbnails` is live, with 33 migrated thumbnails, and Broker publishes there ([`docs/evidence/c5b/`](evidence/c5b/README.md)). **C5c, the IAM handoff, stays deferred to D4.** C5e's bridge is on from activation, as the C5 plan says; its D3 and D4 steps are out of scope.

**What C5d does:** every snap the production api serves becomes a brokered command. Broker publishes it into `graffiticode-thumbnails`, `l0013r` stops uploading directly, and the console reads the new bucket.

**Each live step needs the owner's approval:**
- the drive's infrastructure;
- the drive itself;
- each of the five activation steps;
- any window.

Production activation is the last of them.

## 1. Where we start (read 2026-11-19 at `78621ec8`)

**Production.**
- **api `api-rmwkxlbvy-b5fa92`** (`3b6b4a50`):
  - It has no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`, and it keeps `COMPILE_GENERATION_L0013=rust-1`.
  - `deploy.json` lists `COMMAND_SCOPES` in the api's `removeEnv`, so every production release strips it today.
  - The api's floor is the B5 milestone. C5a recorded that, before C5d, the api needs a floor at `3b6b4a50`, the first safe registry-9 release.
- **`l0013r-rmwmhjmoi-17a112`** (`6124cf96`), pinnable, approved at `[3]`:
  - Its `THUMBNAIL_BUCKET` is `graffiticode.appspot.com`.
  - A compile outside a command still renders and uploads directly to `graffiticode.appspot.com/thumbnails/{item}.png` (`languages/l0013/crates/capture/src/lib.rs` `snap`: `storage.ready()`, then `put_png`).
  - A command's capture uses `render`, which stores nothing and doesn't read `THUMBNAIL_BUCKET`. It then reserves, stages through Policy, and has Broker publish (`crates/core/src/lib.rs` `capture`).
  - The request timeout is 300 s, with concurrency 4.
- **Broker `broker-rmwnqz13k-c374b1`:** `THUMBNAIL_BUCKET=graffiticode-thumbnails`, `COMMAND_STAGING_BUCKET=graffiticode-command-staging`.
- **Policy `f6132821`:** C5a's scopes, reservations and render grants. Item authority comes from the console's route.

**What the api already has** (C5a slice 7, `packages/api/src/commands/bridge.js`, `policy-commands.js`):
- `COMMANDS_LNNNN`, `BRIDGE_LNNNN` (on unless `off`), and `COMMAND_SCOPES` (contract v3, declared on allocation, admission, lease and the due query);
- connectionless `POST /command`, and the bridge for item-scoped chains, anonymous included;
- per-language `INTERPRETER_LNNNN` routing through the interpreter manifest.

**What doesn't exist yet:**
- an L0013 interpreter declaration (`packages/common/src/interpreter-manifest.ts` has none);
- a way to refuse direct snaps in production (decision 2);
- the catch-up copy;
- capture fault points for a drive;
- a canary snapshot check;
- the console's switch.

L0013 inherits `cacheable() = true` (`languages/l0000/crates/core/src/dialect.rs:131`).

**The console** reads thumbnails at `hosts.thumbnails`, which defaults to `BUILT_IN_THUMBNAILS = https://storage.googleapis.com/graffiticode.appspot.com/thumbnails` (graffiticode-app `packages/core/src/profile/public-config-server.ts:32`). Its "Generate thumbnail" button compiles `snap item "<id>" {}..` signed in, with no connection. With L0013's commands on, the bridge makes that a connectionless v3 command.

**B6's drive services are left as they are.** `l0176r-drive` still exists, serving `l0176r-drive-rmwgzicgi-ac4468`, with `BROKER_URL` naming B6's `broker-faults`, a service since deleted. Its approved revisions may be pinned by B6's drive records. C5d's drive therefore uses **new, C5d-only service names** (decision 3): `broker-c5d-drive`, `l0013r-c5d-drive`, `l0176r-c5d-drive` and `api-c5d-drive`. It neither reuses `l0176r-drive` nor recreates `broker-faults`, which would make B6's path reach a live Broker again. B6's services, and any recovery dependency on them, are untouched; retiring them is a separate decision.

## 2. Decisions for the owner

### 1. The L0013 interpreter declaration

```ts
"0013": Object.freeze({
  interpreter: "interpreter",
  cacheCaps: Object.freeze({ evaluate: "no-store", present: "no-store" }),
}),
```

- **Why `no-store`:** a capture is an effect, and its result is a URL into a bucket a later capture overwrites. Under commands, a snap is never served from the compile cache. Today's cacheable L0013 serves an identical compile from cache without snapping unless `refresh` is passed, which is the opposite of what a capture command needs.
- **Version:** `INTERPRETER_MANIFEST_VERSION` goes up, and the declaration is security-reviewed as the manifest's header requires.
- **Inert until step 1:** the declaration does nothing until `INTERPRETER_L0013=on`.

### 2. Refusing direct snaps: configuration, not code (recommended)

- **The change:** `l0013r` is released without `THUMBNAIL_BUCKET`. `deploy.json` moves it to `removeEnv` and also to **`forbiddenEnv`**.
- **The effect:**
  - every direct snap is refused before rendering, with "THUMBNAIL_BUCKET is not set: this server stores no captures" (interpreter plan A1b's existing refusal);
  - command captures are unaffected, because `render` doesn't read the variable.
- **Rollback protection:** `forbiddenEnv` makes `release-check` fail on any reachable revision still carrying the variable, and makes `rollback` refuse such a target. No rollback can re-enable direct uploads. That is the C5 plan's "rolling `l0013r` back below step 2 would re-enable direct uploads", now prevented.
- **Every reachable revision, not just the serving one (the #436 review).** A configuration release changes only the serving revision.
  - Today three approved, tagged revisions carry `THUMBNAIL_BUCKET=graffiticode.appspot.com`: `l0013r-rmwjzlgz6-2882e6`, `l0013r-rmwl2casf-31e8b9`, and `l0013r-rmwmhjmoi-17a112` (serving).
  - Each tag URL reaches a revision that still uploads directly, and `release-check` fails on them once `forbiddenEnv` names the variable.
  - Step 2 therefore **retires every one of them** with `scripts/revisions.js retire`: the fenced protocol that marks a revision `retiring`, invalidates in-flight admissions' leases, reports any plan that still needs it, then marks it `retired` and removes its tag.
  - Only then is no upload-capable endpoint reachable. Slice 4's step 2 details the order, the handling of commands pinned to them, and the drain, which starts after the last tag is gone.
- **Alternative:** a code change that refuses with "snap runs only as a command" in place of the A1b message. It adds a release and a test for a clearer error. *Recommended:* the configuration, with the error documented.

### 3. The drive's topology: B6's pattern, with its own bucket

The drive runs through production Policy and its own Broker, compilers and api. Production thumbnails are never touched, and production Broker executes nothing for the drive. It only reads the drive's receipts (Policy's settlement) and does reconciliation's bookkeeping, as the boundary below specifies.

| Service | What | Configuration |
|---|---|---|
| `broker-c5d-drive` | Broker at `main`, as B6's `broker-faults` was (a new name: B6's stays deleted) | `THUMBNAIL_BUCKET=graffiticode-c5d-drive` (new); `COMMAND_STAGING_BUCKET=graffiticode-command-staging`; **`BROKER_FAULTS=drop-outcome` only during the `drop-outcome` phase** (`BROKER_FAULT_PRINCIPALS` = the canary; that phase runs one command at a time), unset otherwise. Broker isn't pinned, so changing its environment between phases moves no pin. A retry after a dropped outcome is a replay of the claim, which the fault never touches. The service's startup refuses faults on the production name `broker` |
| `l0013r-c5d-drive` | `l0013r` at `main`, pinnable, approved at `[3]` as its release records | `BROKER_URL` = broker-c5d-drive; **no `THUMBNAIL_BUCKET`** (decision 2, tried in the drive first); `L0013_CAPTURE_FAULTS` naming the run's target commands, **set once per drive run** (slice 1): never changed between a fault and its recovery |
| `l0176r-c5d-drive` | `l0176r` at `main`, a new service (not B6's `l0176r-drive`), pinnable, approved at `[1, 2]` by its release | `BROKER_URL` = broker-c5d-drive (the mixed chain's L0176 stage) |
| `api-c5d-drive` | the api at `main`, private, as `api-run` | `COMMANDS_L0013=on`, `COMMANDS_L0176=on`, `COMMAND_SCOPES=on`, `INTERPRETER_L0013=on`, `COMPILE_GENERATION_L0013=c5d-drive-1`, `BASE_URL_L0013` = `l0013r-c5d-drive`, `BASE_URL_L0176` = `l0176r-c5d-drive`; `API_COMMAND_FAULT_TARGETS` naming the run's `stop-renewal` targets, set once for the run; **its sweeper on**, so recovery is exercised |

- **`gs://graffiticode-c5d-drive`:** uniform and private, with `broker-run` as `objectUser`. It's deleted after the drive, as the gate bucket was.
- **Proxy:** `compilers-l0013` gains the `broker-c5d-drive` host for the drive only, rolled and verified (`verify-rollout.js`), then removed.
- **Window:** `canary-window-c5d` gives the operator OpenIdTokenCreator on `console-run` and `api-run`, 24 hours, as C5a's.
- **Fixtures:** canary-owned items: the C5a fixtures `7vwaCAIyMNCJEzgIfyYY` (private) and `wbyfys3akpc4yEGFrnuu` (public), plus a two-stage chain.
- **The mixed chain's L0176 stage runs on `l0176r-c5d-drive`, not production `l0176r`.** That new service runs `l0176r` at `main`, approved at `[1, 2]` by its release, with `BROKER_URL` = `broker-c5d-drive`, and `api-c5d-drive`'s `BASE_URL_L0176` names it. So the mixed chain's Learnosity sandbox write, through the canary's connection (a reviewed sandbox write), is executed by `broker-c5d-drive` too.

**The isolation boundary (the #436 review).** What the drive shares with production is fixed, so the evidence can check it.

| Path | Shared? | Why, and the approval it needs |
|---|---|---|
| Production **Policy** (records, plans, reservations, render grants, audit) | yes | the drive is Policy's own, as B6's was |
| **`graffiticode-command-staging`** (Policy writes, Broker reads) | yes | the staging bucket is Policy's; the drive's staged objects are named by its command ids and deleted by the 30-day rule. The `staging-gone` phase also has the operator delete one staged object (slice 3) |
| The console's **item-authority** route, the api's `/form` and `/data` (render grants) | yes, read-only | captures render through production origins, as the gate's did |
| **Broker's database** (`broker`: receipts, sealed connection secrets) | yes | `broker-c5d-drive` is the same Broker code on the same database, as in B6; it executes every drive operation |
| **Production Broker** | **reads and reconciliation bookkeeping only; no execution** | Policy's `BROKER_URL` names production Broker, and two of Policy's ordinary paths reach it for drive operations. **Settlement** reads each operation's receipt (`POST /v1/receipts`). **Reconciliation** reads the provider for evidence and appends what it found. For a capture, that is the object's metadata in `evidence.bucket`, the bucket recorded on the claim (the drive bucket; `broker-run`'s `objectUser` there covers it). Both are allowed. **Forbidden:** any `execute` or `execute-step` (a dispatch or a publish) by production Broker for a drive operation |
| Production **thumbnails** (`graffiticode-thumbnails`) | **no** | `broker-c5d-drive` publishes only to the drive bucket |
| Production **`l0013r`, `l0176r`** | **no** | `api-c5d-drive` routes L0013 and L0176 to the drive compilers |

**The evidence must show the boundary.** The drive's `boundary` phase (slice 3) reads Broker's `security_audit` for every invocation the drive allocated:
- every `execute` and `execute-step` record (each dispatch, publish and attempt) for a drive invocation comes from `broker-c5d-drive`, and **none** from `broker`;
- production `broker`'s records for drive invocations are only `receipts` reads and `reconcile` bookkeeping, and every `reconcile` read named the drive bucket;
- no object in `graffiticode-thumbnails` names a drive fixture or changed generation during the drive (its listing before and after);
- every compiler call, from the api's request logs, went to `l0013r-c5d-drive` or `l0176r-c5d-drive`.

*Alternative:* drive through production Broker into `graffiticode-thumbnails` on canary items. It needs no drive Broker, but it writes production thumbnails and can't inject Broker faults. *Recommended:* the isolated drive, with the boundary above.

### 4. The api's rollback floor before activation

- **The floor:** add an api baseline at `3b6b4a50`, marked `floor: true` (milestone `C5d-v9`), before step 1.
- **Why:** the first activated api binds snap chains' artifacts to registry 9, and a registry-8 api can't read them. With the floor, no rollback can reach a registry-8 api.
- **The current rollback target stays allowed:** `api-rmwkxlbvy-b5fa92` is at `3b6b4a50`.

### 5. Anonymous capture stays bridge-only

- **For anonymous callers,** capture runs only through the bridge, under the public-capture exception (12 per item per hour), exactly as the gate tested. Production then has anonymous snaps of public items as commands.
- **Ending the exception** remains a separate decision, after D3.

## 3. Slices

### Slice 1: code and tooling (PRs, no live effect)

1. **The interpreter declaration** (decision 1), with the manifest's version bump and its test.
2. **`deploy.json` changes, made but held:**
   - api: drop `COMMAND_SCOPES` from `removeEnv`, and add the `C5d-v9` floor baseline;
   - `l0013r`: `THUMBNAIL_BUCKET` into `removeEnv` and `forbiddenEnv`.

   Merged only with each step's approval: the floor first; the `l0013r` change at step 2; the api's environment at step 1.
3. **Capture fault points for the drive:** `L0013_CAPTURE_FAULTS`, refused when `K_SERVICE` is `l0013r`. They are **targeted and one-shot**, so recovery runs on the same pinned revision (the #436 review).
   - **Configuration:** a JSON map from a target command id to a fault, for example `{"c:<id>": "exit-after-stage"}`.
     - Command ids are deterministic (`c:` + sha256 of `[uid, idempotencyKey]`), so the drive runner computes every target from the run's keys before the run.
     - The map is set **once**, on the `l0013r-c5d-drive` revision the run's commands pin, and never changed during the run.
   - **Firing:** a fault fires only when the command session names that command (`cmd`) **and** its owner's fencing generation (`fg`) is **1**.
     - The sweeper's takeover is generation 2 or later, on the same pinned revision and with the same environment, so it runs the capture to completion. No environment change, and no re-pinning, is needed for recovery.
     - Only the named commands are affected: in `older-after-newer` only the older capture is targeted, never the newer.
   - **Kinds:**
     - `exit-after-reserve`: the process exits after `reserve_capture` returns, before rendering;
     - `exit-after-stage`: it exits after `stage_capture`, before `invoke`;
     - `stall-before-stage`: after rendering, before `stage_capture`, the compiler holds its request open **until it observes the takeover**, then continues. That is a stale worker resuming after a takeover.
       - **Observing the takeover:** every 10 s it repeats `reserve_capture` for its occurrence under its own generation-1 session. Before a takeover, that repeat is state-neutral and answers the recorded reservation. After one, Policy refuses it as a stale generation. That refusal is the signal to continue, to its own `stage_capture`, which Policy must also refuse.
       - **Bounded:** if no takeover is seen within 240 s (under the 300 s request timeout), the fault logs `no-takeover` and continues, and the `stale-worker` phase fails.
   - **Tests:**
     - each kind fires only for its target, only at generation 1, never at generation 2 and never for an untargeted command;
     - the production service name refuses the variable;
     - a malformed map is refused at startup;
     - `stall-before-stage` continues only after its probe is refused as stale, and logs `no-takeover` at its bound.
   - **Stopping the api worker's renewal (the #436 review).** A compiler stall alone never expires the lease: the api worker that called the compiler renews it on its own 20 s timer (`packages/api/src/commands/worker.js`, `LEASE_RENEW_MS`).
     - So `api-c5d-drive` gets a matching targeted fault, `API_COMMAND_FAULT_TARGETS`: a map from command id to `stop-renewal`, set once for the run, refused on the production service as `API_COMMAND_FAULTS` is.
     - For a targeted command at generation 1, the worker **stops renewing its lease and keeps its compiler request open**. When that request answers, the worker doesn't finish the command: its generation is fenced by then, and it only logs the answer.
     - The lease expires after 60 s, and the sweeper, the same service's or another instance's, takes the command over at generation 2.
     - **Tests:** renewal stops only for the target at generation 1; the request stays open; the worker's late answer finishes nothing; an untargeted command's renewal is unchanged; the production service refuses the variable.
4. **The catch-up copy:** `scripts/c5b/migrate-thumbnails.js --phase catchup`, with its rules in `scripts/lib/c5b-thumbnails.js`.
   - **Which objects:** it lists the old bucket and takes every `thumbnails/{item}.png` whose generation differs from the final plan's, or that the plan doesn't have.
   - **How it copies each:** a rewrite with `ifSourceGenerationMatch` (the listed generation) and `ifGenerationMatch` set to the generation C5b's copy created for that name (from the copy manifests), or `0` for a name C5b never copied.
   - **A `412` is told apart by reading the destination** (the #436 review: a blanket `skipped` breaks reruns):
     - **`adopted`:** the destination is already this catch-up's copy. It has no `captureSequence`, and its `migratedFrom` and `sourceGeneration` and bytes equal the listed source. A rerun after a crash between the copy and its manifest lands here.
     - **`skipped-capture`:** the destination carries a `captureSequence`. Broker has published a capture since, which is never replaced.
     - **`source-changed`:** the source's generation is no longer the listed one (`412` on `ifSourceGenerationMatch`). The run stops, as C5b's copy does; the operator re-lists and reruns.
     - **`destination-differs`:** anything else, such as another copy of an older source version with no `captureSequence`. The run stops for the owner's decision; nothing is overwritten.
   - **Manifests:** `catchup-<at>.json`, written once with exclusive creation and never overwritten. A rerun writes its own.
   - **Its own verify:** every name is `created` or `adopted` and matches its source, or `skipped-capture` and names a destination carrying a `captureSequence`.
   - **Tests:**
     - as for the C5b copy;
     - a name absent from the plan (`ifGenerationMatch=0`);
     - a destination Broker updated (`skipped-capture`);
     - **a crash after the rewrite completed but before the manifest was written:** the rerun records `adopted`, not `skipped`, and verify passes;
     - a source changed mid-run;
     - a destination holding another catch-up's older copy (`destination-differs`, never overwritten).
5. **A canary snapshot check** (`scripts/canary.js --snap <item>`). As the canary, it captures a canary-owned item through connectionless `POST /command`.
   - **It expects:** `completed`; the result's `url` under the configured thumbnails bucket; the object's `captureSequence` equal to the command's reserved sequence; and the same key answering the same command.
   - **It's used against `api-c5d-drive`** in the drive, and against production from step 1 on.
6. **The drive runner,** `scripts/c5d-drive.js`, with its checks in `scripts/lib/c5d-drive-checks.js`, tested offline as the C5a gate was. The phases are in slice 3.
7. **IAM review text:**
   - Step 32: the drive's infrastructure, window, proxy and bucket, with their teardown;
   - Step 33: the api's floor;
   - Step 34: the activation releases, with each step's read-back.

### Slice 2: the drive's infrastructure (Step 32, live, with approval)

- **Create:**
  - `gs://graffiticode-c5d-drive` with `broker-run` `objectUser`, by `bucket-policy.js`-style read/modify/write;
  - `broker-c5d-drive`, `l0013r-c5d-drive` (approved at `[3]` by its release, with the run's `L0013_CAPTURE_FAULTS` map) and `api-c5d-drive`, with their invokers as B6's;
  - `l0176r-c5d-drive` created at `main` (a new service), approved at `[1, 2]` by its release, with `BROKER_URL` = `broker-c5d-drive`;
  - the proxy's `broker-c5d-drive` host for `compilers-l0013` and `compilers-l0176`, rolled and verified;
  - the window.
- **Verify:**
  - the bucket's settings and IAM are read back;
  - `broker-c5d-drive`'s environment names the drive bucket and sets no `BROKER_FAULTS` (it is set only for the `drop-outcome` phase);
  - `l0013r-c5d-drive` has no `THUMBNAIL_BUCKET`, reports its bucket as null at `/status`, and its fault map names only the run's target commands;
  - `l0176r-c5d-drive`'s `BROKER_URL` is `broker-c5d-drive`;
  - `api-c5d-drive`'s environment is as in decision 3, its `API_COMMAND_FAULT_TARGETS` naming only the run's `stop-renewal` targets;
  - `graffiticode-thumbnails`' listing is recorded, for the `boundary` phase.

### Slice 3: the staged drive (live, with approval)

Every phase runs as the canary, through `api-c5d-drive`. Its checks read Policy's records, Broker's receipts and audit, and the drive bucket's objects. The C5 plan names the drive's scope as decision 9's crash points, the two-stage case, and canary snapshot checks.

| Phase | Shows |
|---|---|
| `first-capture` | a private item's capture publishes with its reserved sequence; a public item's, anonymously, under the exception (test 1) |
| `direct-refused` | a compile straight to `l0013r-c5d-drive` outside a command is refused, with A1b's message, and uploads nothing (decision 2) |
| `exit-after-reserve` | a targeted capture exits after reserve at generation 1. The sweeper takes it over (generation 2, same pinned revision); reserve answers the same reservation, nothing is counted twice, and the capture publishes its original sequence (test 3, an abandoned reservation doesn't block) |
| `exit-after-stage` | a targeted capture exits after staging, before publish, at generation 1. The generation-2 takeover reuses the staged bytes (no second render: the camera's request log has one render; Policy's `staged` record is unchanged) and publishes them |
| `drop-outcome` | with `BROKER_FAULTS=drop-outcome` on `broker-c5d-drive` for this phase only, a capture publishes and Broker drops its outcome. After the dropped request has finished, **the operator deletes that capture's staged object** from `graffiticode-command-staging`. The retry then replays the claim: Broker never reads staging again once a claim exists, so nothing is re-read or published twice. Policy's reconciliation, through production Broker, reads the object's metadata in the drive bucket (`evidence.bucket`) and resolves `applied`. **Its result is compared with the dropped operation's own expected result:** `{ item, captureSequence, sha256, url }` from that operation's reserved arguments (Policy's reservation: the item and the reserved `captureSequence`), its staged digest, and its claim's evidence (bucket and object), field for field. A separate live capture can't be the control, because Policy gives it another `captureSequence`. Production Broker's records are only `receipts` and `reconcile`, with no `execute` (decision 5's reconcile case, and staging gone after a claim, both live; decision 3's boundary) |
| `stale-worker` | one targeted capture, with `stop-renewal` on `api-c5d-drive` and `stall-before-stage` on `l0013r-c5d-drive`, both at generation 1. The api worker stops renewing while its compiler request stays open and stalled. The lease expires and the sweeper takes over (generation 2), which renders, stages and publishes. **The takeover is observed before the stalled request is released:** Policy's records show generation 2's lease before generation 1's next call. Then the stalled worker continues: Policy refuses its `stage`, and anything after, as a stale generation; its audit shows the refusal; nothing it rendered is published; the published sequence and digest are generation 2's; and the generation-1 api worker finishes nothing (decision 9's fencing, live) |
| `staging-gone` | `exit-after-stage` at generation 1, then the operator deletes that staged object from `graffiticode-command-staging` (the one write the drive makes there itself). The generation-2 takeover finds the reservation staged, so it doesn't render. Broker reads staging, finds nothing, and refuses **before any claim**: definitely, with no receipt; the command fails; nothing is published. A new capture, a new command, then succeeds (decision 9's staging-before-claim case, live) |
| `older-after-newer` | an older capture, the only target (`exit-after-stage` at generation 1), stops after staging. A newer capture of the same item runs to completion untargeted. The older's generation-2 takeover publishes nothing: `newer-present`, completed with its own result, the newer still published (test 2) |
| `two-stage` | a chain capturing two items, and identical snap programs in two stages, are one invocation with a scope per intent. Staged objects are named by stage (test 6) |
| `mixed` | a capture plus an L0176 save through the canary's connection is one invocation, each token carrying only its own scope (test 6) |
| `non-owner` | a private item is refused for a non-owner at allocation (test 4); after access is narrowed, the hermetic evidence stands as accepted in C5a |
| `rate-limit` | the 13th anonymous capture of a public item within the hour is refused `rate-limited`, and its command is retired (C5a's `fixtures-retired` rule) |
| `canary-snap` | `canary.js --snap` against `api-c5d-drive` passes |
| `boundary` | decision 3's isolation evidence, for every invocation the drive allocated. Every `execute` and `execute-step` record (each dispatch, publish and attempt) comes from `broker-c5d-drive`, and none from `broker`. Production `broker`'s records are only `receipts` reads (settlement) and `reconcile` bookkeeping, and every `reconcile` read named the drive bucket. `graffiticode-thumbnails` is unchanged across the drive, and every compiler call went to a drive compiler |
| `cleanup` | every command the drive allocated is terminal, and none is due |

- **Hermetic, with the reason each can't be produced live in this drive** (records at the deployed commits with verbatim output, under C5a's field-level rules):

  | Case | Why not live | Evidence |
  |---|---|---|
  | A crash after the staging object is created, before Policy's staged record commits | the window is inside Policy's own stage route; no approved interface stops Policy there, and Policy has no fault hooks in production | Policy `captures.spec.ts` › "after the staging object is written, before the record: the retry adopts the bytes staged first" |
  | A stale worker's staging object adopted (it won the create race) | needs the stale worker's create to land before the takeover's, inside Policy | Policy `captures.spec.ts` › "refuses a stale worker at reserve, stage and bind; its staging object, if it won, is adopted" (the refusal itself is live, in `stale-worker`) |
  | A dropped outcome's reconciled result equals what an **undropped run of identical inputs** returned | a live control would be a different capture with another `captureSequence`, so identical inputs can't be produced live. The live phase compares against the dropped operation's own reserved arguments and evidence instead | Broker `gcs.spec.ts` › "resolves a dropped outcome applied after a newer capture, with exactly the result the undropped run returned"; supporting, `gcs.spec.ts` › "never reads staging once a claim exists: deleted after a dropped outcome, the retry replays and reconciliation resolves applied" |
  | The conditional `412` race | no approved interface pauses or reorders execution (C5a) | as accepted in C5a |

  The `staging-gone` phase covers the before-claim case live; Broker `gcs.spec.ts` › "refuses missing staged bytes with no claim, definitely, before claiming" supports it.
- **The drive passes** only if every phase passes. Its evidence goes to `docs/evidence/c5d/drive/`.
- **Teardown (Step 32's), in this order (the #436 review: retire before deleting).** The retirement CLI refuses a revision that's serving, so each pinnable drive compiler is parked first:
  1. **Every drive command is terminal** and none is due (the `cleanup` phase).
  2. **Park each pinnable drive compiler** (`l0013r-c5d-drive`, `l0176r-c5d-drive`): deploy a parking revision with plain `gcloud run deploy`, not the deploy CLI, so it's never recorded approved. Its image is the same, it takes no invocations (its invoker binding is removed first), and it gets 100% of traffic. No approved drive revision then serves.
  3. **Retire every approved drive revision** with `node scripts/revisions.js retire <service> --release <id>`, one at a time.
     - A non-empty report (a plan still needing it) cancels the retirement. The drive's commands are all terminal by then, so a report is a finding to resolve, not to override. `--confirm-unrecoverable` is used only by the owner's named decision.
     - Each retirement removes the revision's tag.
     - **Verify:** `revisions.js status <service>` shows every drive release `retired`, and no tag URL answers.
  4. **Then delete:** `l0013r-c5d-drive`, `l0176r-c5d-drive`, `api-c5d-drive` and `broker-c5d-drive` (not pinnable, so nothing to retire), and `gs://graffiticode-c5d-drive`.
  5. **Remove the proxy hosts** (`broker-c5d-drive` from `compilers-l0013` and `compilers-l0176`), rolled and verified. The window expires.
  6. **B6's `l0176r-drive` is untouched throughout:** its revisions, tags and approval records stay as they were, so any recovery that depends on them is preserved. Retiring it is a separate decision.

### Slice 4: activation (Step 34, five ordered steps, each with approval)

**0. Before step 1:**
- the api floor (Step 33) is released and `release-check` passes;
- `canary.js --snap` and the catch-up tool are merged;
- the console PR (step 5) is reviewed and merged;
- a final read-only `--phase verify` of C5b's copy passes. Any source updated since is expected, and is listed for the catch-up.

**1. The api.**
- **The release:** from the merge commit adding `COMMANDS_L0013=on`, `COMMAND_SCOPES=on`, `INTERPRETER_L0013=on` and `COMPILE_GENERATION_L0013=c5d-1` together, with `BRIDGE_L0013` unset (on).
- **Staged first,** as C5a's api release was: the canary passes 36/36 and `canary.js --snap` passes on the staged tag, then it's promoted.
- **From then on,** every snap the api serves is a command into `graffiticode-thumbnails`, and the production sweeper recovers v3 commands.
- **Verify:**
  - the environment read back;
  - `release-check`;
  - the canary 36/36;
  - `canary.js --snap` on a canary-owned item;
  - the bridge observed on a console "Generate thumbnail" of a canary-owned item.

**2. Disable direct uploads on every reachable revision.**
1. **The release:** `l0013r` without `THUMBNAIL_BUCKET` (decision 2), a configuration release of the approved commit. Its release records it approved at `[3]`. From then on, new admissions pin it.
   - **Verify:** `/status` on the serving revision reports the thumbnail bucket as null; a direct `POST /compile` of a snap is refused before rendering.
2. **Retire every older approved revision that carries the variable,** one at a time, in this order: `l0013r-rmwjzlgz6-2882e6`, then `l0013r-rmwl2casf-31e8b9`, then `l0013r-rmwmhjmoi-17a112`. The command is `node scripts/revisions.js retire l0013r --release <its release id>`, never with `--confirm-unrecoverable` unless the owner decides it for a named plan.
   - **Commands pinned to a retiring revision:**
     - Retirement first fences new admissions to it.
     - Its report then lists every plan that still needs it: an unfinished or uncertain capture, or an unstored artifact.
     - A non-empty report cancels the retirement, which returns the revision to `approved`. The operator waits for the sweeper to finish those commands on their pinned revision, whose command path still works because `render` doesn't read the variable, then retries.
     - Only `rmwmhjmoi` can have such commands, from step 1 on. The other two were pinned only by the C5a gate's commands, all terminal.
     - A pinned command that can't finish (a reservation abandoned beyond recovery) is named in the report and retired by the owner's decision with the C5a gate's fenced takeover and empty finish, never silently.
   - **After each retirement:** the revision is `retired` in the revisions database, its tag is removed, and its tag URL no longer answers (`404`).
3. **Verify the whole service:**
   - `gcloud run services describe l0013r` lists no tag and no traffic for any revision except step 2's;
   - every former tag URL answers `404`;
   - `release-check l0013r` passes, with no reachable revision carrying `THUMBNAIL_BUCKET`;
   - `revisions.js status l0013r` shows step 2's revision approved and the three retired.

**3. Drain,** starting when the **last** upload-capable endpoint became unreachable: the later of step 2's promotion and the removal of the last retired tag.
- **The wait:** `l0013r`'s 300 s request timeout after that moment. A request admitted before the tag was removed may still upload until then.
- **Then confirm that no upload has happened since:**
  - `l0013r`'s logs (every revision) show no `snap` (direct) entry after that moment plus the timeout;
  - the old bucket's `thumbnails/` generations are unchanged across a listing taken after the wait and another 10 minutes later.

**4. Catch up.**
- **Run:** `--phase catchup`, then its verify. Every old object updated after C5b's plan is copied under its generation fence, or skipped where Broker has since published.
- **Evidence:** the manifest goes into `docs/evidence/c5d/activation/`.

**5. The console.** graffiticode-app's `BUILT_IN_THUMBNAILS` becomes `https://storage.googleapis.com/graffiticode-thumbnails`, released by its own process.
- **Verify:**
  - the console's thumbnail grid loads from the new bucket;
  - a fresh "Generate thumbnail" shows the new capture;
  - installations that set their own `hosts.thumbnails` are unaffected (listed beforehand).

**Between steps 1 and 5,** the console shows the old bucket: stale for captures made in that window, never wrong. It is minutes long.

## 4. Rollback

| After | Rollback | Effect |
|---|---|---|
| Step 1 (api) | `rollback --release <step 1's id>`, to `api-rmwkxlbvy-b5fa92`, which the floor allows | No new snap commands. Pending v3 commands wait in Policy, since the previous api doesn't declare `scopes`, until a roll forward. Direct uploads resume while step 2 hasn't happened. |
| Step 1, partially | a configuration release with only `INTERPRETER_L0013` off (the C5 plan's rule after step 2) | Commands keep running; the interpreter routing is reverted |
| Step 2 (`l0013r`) | **none by rollback:** `forbiddenEnv` refuses any target carrying `THUMBNAIL_BUCKET`, and the older revisions are retired, their tags removed. Roll forward only. A retirement that's still `retiring` can be `--cancel`led (back to `approved`) before it completes | Direct uploads stay off. Re-enabling them is a decision, not a rollback |
| Step 4 (catch-up) | none needed: create-only or generation-fenced, never over a Broker capture | |
| Step 5 (console) | revert its release | The console reads the old bucket, now frozen: stale, not wrong |

**The drive** needs no rollback beyond its teardown. Its records stay as evidence.

## 5. Completion gate for C5d

1. **The drive passed** every phase in slice 3, with its evidence merged and its infrastructure torn down.
2. **Activation steps 1 to 5** were each verified as listed.
3. **Decision 9's cases** are each live or hermetic as slice 3 lists, and the `boundary` phase shows the isolation held.
4. **The C5 plan's tests** 1 to 7 hold in production:
   - tests 1, 4 and 5 by `canary.js --snap` and a non-owner check;
   - test 2 and the crash points by the drive;
   - test 6 by the drive's `two-stage` and `mixed` phases;
   - test 7 by Broker's existing tests at the deployed commit.
5. **L0176 unchanged:** the canary passes 36/36 after each step, and the repair round-trip passes once after step 1, under the revised verdict.
6. **From step 2 on,** no reachable `l0013r` revision can upload: the older revisions are retired and untagged. That is the first half of the C5 plan's test 8; the second half, after D4, belongs to C5c.

## 6. Risks

- **Every snap becomes a command.** Snaps now depend on Policy, Broker and the console's item route. If one is down, a capture fails and is retried by the caller. The bridge's audit shows any caller narrowed by the owner-only rule.
- **The stale window,** between steps 1 and 5, lasts minutes.
- **Anonymous public captures** run under the exception, at 12 per item per hour, and are audited.
- **`no-store`** means a repeated "Generate thumbnail" always captures again. It's an explicit user action, rate-bounded for anonymous callers.
- **The drive's proxy exception** for `broker-c5d-drive` is temporary, and is removed at teardown.

## 7. Out of scope

- C5c, the IAM handoff, at D4.
- D3, the console's move to `POST /command` with a stable key.
- D4, the bridge off.
- Ending the public-capture exception.
- Repair and materialization for L0013: a failed snap is captured again.
- Deleting old thumbnails.
