# C5: L0013 snapshots as brokered commands

**Status:** draft, revised after the owner's first review (2026-11-15). Plan item: `docs/graffiticode-interpreter-plan.md` Track C, "C5 L0013 snapshots become brokered commands" (C5a–C5e). Design: `docs/graffiticode-interpreter-design.md` §5 (one invocation per chain) and the L0013 notes (`:65`, `:198`, `:806`). Builds on B5 (`docs/b5-commands-plan.md`), C6 (`docs/c6-l0176-commands-plan.md`) and B6 (`docs/b6-command-repair-plan.md`).

This plan details **C5a**, authorization without a provider connection. It also fixes the decisions C5b–C5e depend on: storage, IAM, release order, rollback and the completion gate. C5b–C5e get their own detailed slices once C5a is approved.

**Owner's approvals (2026-11-15):**
- decision 0 is released on its own (#398);
- C5a's live gate uses one canary-owned private item and one canary-owned public item;
- the gate's uploads go to a separate test bucket, never the thumbnails bucket.

**Owner's review of the first draft (2026-11-15).** Six findings, each resolved below:
1. **Registry 8 stays.**
   - `ARTIFACT_COMPATIBLE_VERSIONS` and `REGISTRY_WINDOW` both list 8, since version 9 changes no L0176 function's meaning.
   - 8 leaves the window only through its own retirement gate, which covers v8 commands and repairs (decision 2).
2. **Tokens for plans with several scopes.**
   - Invocation, admission and session tokens bind the admitted plan's authority.
   - Each execution token selects exactly one authorized scope.
   - Any plan with an item scope is v3, mixed L0013/L0176 chains included. Connection-only plans stay v2 (decision 6).
3. **Reserve, stage and bind are separate durable states,** each written once. Recovery reuses what was staged. Tests cover crashes at each boundary, fencing and staging expiry (decision 9).
4. **No mirror.**
   - Thumbnails move to a dedicated uniform bucket.
   - Each item's fixed object is its own pointer. It is replaced only by an atomic generation-precondition write whose capture sequence must be newer, so there is no second step for a crash to fall between.
   - The console changes only its thumbnail base URL, released before activation (decision 8).
5. **Rollback protections before the first v3 record.**
   - Policy's and Broker's rollback floor is installed before C5a's live gate.
   - Workers declare a `scopes` capability. Policy never lists, leases or hands over a v3 command to a worker without it, so an older api sweeper can't take one (§3).
6. **Bucket roles follow the final protocol** and are checked against the live bucket (decision 8, §3 IAM).

## 1. Where we start (survey, 2026-11-15, at `90a60a03`)

### The snapshot today

**Who runs it.** Production snaps run on the Rust **`l0013r`**, as `l0013r-run` (`deploy.json:837-934`).
- The TypeScript `l0013` service was deleted at A7 (2026-11-05, IAM review Step 19).
- The api routes L0013 there with `BASE_URL_L0013` and `COMPILE_GENERATION_L0013=rust-1` (`deploy.json:180-182`).
- L0013 is neither interpreted nor a command language. It has no `INTERPRETER_`, `COMMANDS_` or `BRIDGE_L0013`, and no interpreter-manifest declaration.

**What a snap does** (`languages/l0013/crates/capture/src/lib.rs:248-277`, `crates/core/src/lib.rs:147-180`):
1. `snap item "<id>" {…}..` names an item.
2. The camera resolves the item to its head task through the console's `GET /api/form/resolve?id=<item>`, passing the caller's verified token if there is one.
3. It renders `api/form?id=<task>` in headless Chromium and crops the result.
4. It uploads the PNG to the **fixed path** `thumbnails/{item}.png` in `gs://graffiticode.appspot.com`, with `predefinedAcl=publicRead`. The upload overwrites and authenticates as `l0013r-run` through ADC (`storage.rs:79-100`).
5. It returns `{ url: …/thumbnails/{item}.png?v=<sha1[:16]>, item }`.

No thumbnail record or pointer exists anywhere.

**What "authorized" means today.** It is less than the master plan assumes.
- The resolver allows a capture when the item's **head task** is readable by the caller: `acls.public`, or the caller's uid in `acls.uids`, or no ACL (`graffiticode-app/…/api/form/resolve/route.ts`, `resolvers.ts:123-149`; `packages/api/src/storage/tasks.js:36-51`).
- That is read access to the task, not edit permission on the item. `acls.uids` holds every uid that ever posted identical code (`tasks.js:113-115`).
- A `task` option skipped the resolve entirely while still writing the item's path. Decision 0 closes it.

**Callers.**
- The console is the only one found. "Generate thumbnail" (`graffiticode-app/packages/console/src/lib/generate-thumbnail.ts:17-42`) compiles `snap item "<id>" {}..` signed in, with no connection and no `refresh`.
- The console then shows `https://storage.googleapis.com/graffiticode.appspot.com/thumbnails/{id}.png` (`tools-thumbnail-grid.tsx:6,47`).
- MCP excludes L0013.
- L0013 is cacheable (`dialect.rs:131-133`), so an identical compile is served from the api's cache **without snapping** unless `refresh` is passed (`data.js:290-296`).

**The item store** is the `graffiticode-app` project's default Firestore, `users/{owner}/items/{id}`, with `isPublic`, `taskId` and `lang` (`graffiticode-app/packages/core/src/items.ts:31-50`).
- Edit permission is the console's own rule: the item exists under the caller's uid (`items.ts:270-276`).
- Nothing in this repo reads the item store.

**The bucket, read live 2026-11-15.**
- `graffiticode.appspot.com` is the App Engine/Firebase default bucket, with **fine-grained ACLs** (`uniform_bucket_level_access: false`). Its default object ACL isn't public.
  - So each thumbnail is made public by `predefinedAcl=publicRead`, which needs `storage.objects.setIamPolicy`.
  - IAM Conditions can't be used on a fine-grained bucket, so no grant can be limited to `thumbnails/`.
- **Bucket IAM:**
  - `l0013-run` and `l0013r-run` each hold **`roles/storage.objectAdmin`**. This settles the IAM review's disagreement: it says objectCreator at `:295` and `:459`.
  - `firebase-storage@system` holds `storage.admin`, beside the legacy project bindings.
- Soft delete keeps deleted objects for 7 days.

**Egress.** `l0013r`'s class `compilers-l0013` allows api, app, auth, the language hosts and `storage.googleapis.com`, but **not Policy or Broker**.

### What Policy and Broker assume

**One invocation, one connection:**
- `allocateInvocation` and `allocateCommand` require a connection and access to it (`policy.ts:237-244`, `:280-289`).
- The sequence key and the binding include it (`invocations.ts:60-61,73`; `firestore.ts:45-48,129-131`).
- `Plan.connectionId` is required and in the digest (`contract.ts:33`, `policy.ts:1501-1510`).
- Admission authorizes every function against that one connection (`policy.ts:1530-1540`). So do the command session (`:657-668`), `liveRefusal` (`:1128-1155`) and `commandOperation` (`:698`, `:709`).
- Provenance is `user | publication | system` (`provenance.ts:18-41`).
- Audit requires a `conn-` id (`audit.ts:76`).

**Tokens.** Every profile requires `conn`. Session, execution and replay also require `own` and `backend` (`tokens.ts:66,73,90,107,116`).

**Broker.**
- It loads a credential only from the connection's sealed secret or from the preview consumer (`broker.ts:396-415`).
- The receipt binding includes `connectionId` (`:127`, `:442-451`).
- Reconcile requires a connection (`reconcile.ts:66-79`).
- Operations are Learnosity-only (`operations.ts:272-362`).

**The registry.**
- `FunctionSpec` has no credential or scope (`protected-registry.ts:87-95`).
- `isOperationAllowed` matches the connection's backend (`:214-225`).
- Every registered backend becomes a user-creatable connection backend (`policy/src/manage.ts:40,121`).
- **Artifacts and the window.** A stored artifact is served only under its own version or one listed in `ARTIFACT_COMPATIBLE_VERSIONS` (`:42-49`). A plan's version executes only while it is current or in `REGISTRY_WINDOW` (`:51-69`). Outside the window a session is replay-only (`rpl`, `policy.ts:1053,1184`).

**The api.**
- `POST /command` requires a signed-in user, a connection, and a key bound to it (`routes/command.js:82-87`, `routes/utils.js:151-152`).
- The bridge runs only for compiles through a connection (`data.js:330-336`).
- Artifacts key on `connectionId` (`storage/artifacts.js:38-40,62-66`).

**Groundwork that exists.**
- An intent already carries an optional `scope` (`languages/l0000/crates/core/src/model.rs:46-47`). Policy checks it, so far only as "equals the token's connection" (`policy.ts:709`).
- Workers already declare capabilities, `recording` and `repairs`, that Policy honors when listing, leasing and taking over commands (`commands.ts:28-45`, `ownableBy`).
- The deploy tool already refuses releases below a `baselines` entry marked `floor: true` (`packages/deploy/src/release.js:549-560`).

### Corrections to the master plan's C5 text (made in this PR)

- The uploader is `l0013r`/`l0013r-run`.
- `l0013r-run`'s grant predates A1b.
- The citations are corrected.
- "The same rule as resolving with an owner token today" isn't today's rule (decision 3).

## 2. Decisions for the owner

Each has a recommendation; the plan below assumes it.

### 0. Close the `task` override now (approved; #398)

`l0013r` refuses snap's `task` and `lang` options and always resolves the item. It is released on its own, ahead of C5.

### 1. Scopes per intent: `{ kind, id }`

An intent's `scope` becomes `{ kind: "connection", id }` or `{ kind: "item", id }`. The existing bare-string scope reads as `connection`.

**Static and bound scopes.**
- **Static:** an item scope whose id is a literal in the model. Admission authorizes it.
- **Bound:** an item id that arrives as data. It is authorized at the occurrence's reservation (decision 9), from its arguments, before any rendering or token.
- Both are re-checked at mint and at authorize-execution.
- The console's `snap item "<id>"` is static. A connection scope is always static.

**The plan names its scopes.**
- `Plan.connectionId` is present only if some intent has a connection scope.
- A v3 plan adds `scopes`, the sorted, de-duplicated static scopes, inside the digest.
- A bound item scope is recorded on its occurrence, never in the plan.

**The invocation.** It is allocated before any model is known, so its key can't depend on scopes.
- Its sequence key and binding keep `connectionId`, which is `null` when the request names no connection.
- An existing invocation is unchanged.
- A `null` connection is allowed only when the chain's head language declares item-scoped functions. Admission then refuses any connection-scoped intent (`connection-required`).

### 2. The registry: credential and scope, version 9, and version 8 kept

**New fields.**
- `FunctionSpec` gains `credential` (`"connection"`, the default, or `"service"`), `scope` (`"connection"`, the default, or `"item"`) and `publicCapture` (`{ since: "<date>" }`, or absent).
- L0013 registers `snap`: kind `write`, `credential: "service"`, `scope: "item"`, not delegable, `publicCapture: { since: <activation date> }`.
  - Its operation is `gcs.put-thumbnail`: backend `gcs`, kind `write`, `credential: "service"`, one `dispatch` step.
- `isOperationAllowed` takes the backend from the credential: the connection's for a connection function, the operation's own for a service function.
- `manage.ts` builds `BACKENDS` only from connection-credential operations, so `gcs` can never be created, granted or listed as a connection.

**`REGISTRY_VERSION` 9, under P1b.** L0013's Rust compiler becomes the fourth source that `scripts/check-registry-version.js` checks.

**Version 8 stays accepted, for artifacts and for execution.**
- **`ARTIFACT_COMPATIBLE_VERSIONS = [8]`.**
  - Version 9 adds functions and changes none of 8's meanings.
  - Without the listing, every stored v8 artifact would become incompatible, as the owner reproduced.
  - The listing is part of the bump's security review.
- **`REGISTRY_WINDOW = [8]`,** with no date for removing it.
  - Removing 8 would leave v8 plans with replay-only sessions.
  - Their `not-reached` stages, and B6 repairs of their failed occurrences, need fresh execution tokens, so they could never finish.
- **8 leaves the window only through its own retirement gate,** with the owner's approval. The gate passes only when, in Policy's records:
  - every v8 command is terminal, with no repair-eligible occurrence and no `not-reached` stage, or the owner has listed it as given up, with a dated notice;
  - no B6 repair or `/materialize` is pending on a v8 command.
- **The artifact listing has no retirement step.** v8 artifacts stay readable.

### 3. Item authority: owner edits, decided by the console's store, asked by Policy

**The rule.**
- A **private** item may be captured by its **owner** only, the console's edit rule.
- A **public** item (`isPublic: true`) falls under the compatibility exception (decision 4).
- This is narrower than today: non-owners who can read a private item's head task lose capture. No caller found does that.

**How Policy asks.** A new console route, `POST /api/internal/item-authority { itemId }`, answers `{ exists, ownerUid, isPublic, taskId, lang }`.
- It accepts only `policy-run`'s Google ID token, with the route's own audience.
- An item under two owners answers `ambiguous`, which Policy refuses (`item-ambiguous`).
- If the route is unavailable, Policy refuses with `item-authority-unavailable`, temporary and never allowing.

*Recommended* over granting `policy-run` Datastore read on all of `graffiticode-app`.

### 4. The public-capture exception, bridge-only for anonymous callers

- **Signed-in non-owners** may capture a public item. The capture is recorded with provenance `user` and `publicCapture: true`.
- **Anonymous callers** are admitted only through the D2 bridge, as provenance **`anonymous`** with subject `anonymous`. Each compile gets a fresh key, as today. `POST /command` keeps requiring sign-in.
- **The rate limit** is 12 public-exception captures per item per hour, across all non-owner callers, counted in Policy (`item-captures/{item}`). Owners have no per-item limit.
- **Ending the exception** is a separate, announced decision after D3. Because anonymous capture is bridge-only, **L0013's D4 waits for it**.

### 5. Broker matches credential to scope

**Exactly one scope per token.** An execution or replay token selects either a connection (`conn`, with `own` and `backend`) or an item (`scp: { kind: "item", id }`). The profile refuses a token that has both, or neither.

**A `credential: "service"` operation:**
- requires `scp.kind === "item"` and no `conn`;
- requires `args.item === scp.id`;
- runs as Broker's own runtime identity, through ADC.

A mismatch in either direction is refused `credential-scope-mismatch`, before the receipt claim.

**The receipt binding** records the selected scope (`scope: { kind, id }`) in place of `connectionId` for v3 tokens. v2 receipts are unchanged.

**Reconcile for `gcs.put-thumbnail`** reads the item's object metadata (decision 8):
- a `captureSequence` at or above the operation's own is `applied`, with `superseded: false` when equal (the object is this capture's own) and `superseded: true` when greater;
- a lower one is `unresolved`, as W5 requires: an upload in flight could still land.

### 6. Tokens and the plan contract: the plan binds authority, an execution token selects one scope

| Token | v2 (connection-only plan) | v3 (any plan with an item scope, mixed included) |
| --- | --- | --- |
| invocation | `conn` required, unchanged | `conn` optional (`null` when the request named none) |
| admission | `conn` and `pld`, unchanged | `pld`, whose plan holds `connectionId?` and `scopes`; `conn` only if the plan has a connection scope |
| session | `own`, `conn`, `backend`, unchanged | `pld` and `stg` bind the plan; `conn`, `own` and `backend` only if a connection-scoped intent is in the session's stage |
| execution, replay | connection scope, unchanged | exactly one scope: the connection or `scp` |

**Minting.** Policy mints an execution token for exactly one scope.
- That scope is the occurrence's intent scope if static, or its bound scope.
- It must be among the plan's authorized scopes, or authorized at the occurrence's reservation.
- Policy re-checks it live in `liveRefusal`: a connection by `accessFor` and `mayUse`, as today; an item by item authority and the rate limit's record.

**Contract versions.**
- `cv: 3` marks every v3 plan and token.
- A connection-only plan stays `cv: 2`, byte for byte, with the same digest.
- Broker and Policy accept v3 before anything issues it.

### 7. L0013 as a compiler caller

- `l0013r-run` joins Policy's and Broker's `CALLERS` as `{ role: "compiler", lang: "0013" }`.
- The api's `CALLER_IDENTITY_LANGS` gains `0013`.
- `l0013r` gains egress to Policy and Broker.

### 8. Storage: a dedicated bucket, where the fixed object is its own pointer

**The bucket.** A new **`gs://graffiticode-thumbnails`**, with uniform bucket-level access and public read through `allUsers: roles/storage.objectViewer`. There are no ACLs, so no `setIamPolicy` is needed.

**The pointer.** The published object is `{item}.png`, the fixed path the console reads. It carries custom metadata `captureSequence` (and `commandId`, `sha256`) and `Cache-Control: no-cache`. **That object is the pointer.**

**Publishing is one atomic write:**
1. Read the object's metadata: its `generation` and `captureSequence`, or "absent".
2. If this capture's sequence isn't greater, stop. The capture is `completed`, `superseded: true`, and nothing is written.
3. Otherwise upload with `ifGenerationMatch` set to that generation, or to `0` when the object was absent.
4. On `412`, go back to step 1.

**What this guarantees.**
- The bytes and the sequence change together or not at all, so no crash can leave the pointer moved and the image not.
- A capture's sequence is unique per item, so retrying the operation is safe. The retry either writes once, or finds the capture already there or superseded.
- *Recommended:* this is the design's second option (`graffiticode-interpreter-design.md:806`, "make the overwrite conditional on a generation … precondition"), and it needs no mirror. The master plan's immutable `thumbnails/{item}/{sha}.png` objects and Firestore pointer are dropped, and C5b's text is amended to match.

**The console** changes one constant, its thumbnail base URL. That change ships before activation, together with the copy of existing thumbnails (§4, C5b). The returned `url` keeps its `?v=<sha>` cache-buster.

**Permissions follow from the protocol.** See Google's [IAM roles for Cloud Storage](https://docs.cloud.google.com/storage/docs/access-control/iam-roles).
- `broker-run` needs `objects.get` for the metadata, plus `objects.create` and `objects.delete`, since overwriting a live object requires delete. That is `roles/storage.objectUser` on `graffiticode-thumbnails` only.
  - `objectCreator` can't overwrite.
  - `objectAdmin` adds IAM changes this protocol doesn't need.
- These are checked live before activation: a test write, a precondition failure and an overwrite, all by `broker-run`.

**Staging** (decision 9) lives in a new **`gs://graffiticode-command-staging`**: uniform, private, deleted by a 30-day lifecycle rule.
- `policy-run` has `roles/storage.objectCreator`, which can create but not overwrite, matching stage-once.
- `broker-run` has `roles/storage.objectViewer`.

**The old bucket.**
- Once the console reads the new bucket, nothing reads `graffiticode.appspot.com/thumbnails/`.
- Both L0013 accounts' `objectAdmin` there is removed at D4 (C5c).
- Old objects are left in place.

**The command's own artifact** keys on `[uid, taskId, connectionId-or-null]`, with `ownerUid` set to the caller. Under commands, `snap` isn't cacheable.

### 9. Reserve, stage, bind: three durable states per capture

Each capture occurrence moves through these states in Policy's command record (`occurrences/{stage}:{occ}`). Each state is written once, under the command's fencing generation.

| State | Written by | When | Holds |
| --- | --- | --- | --- |
| `reserved` | Policy `reserve`, in one transaction with `item-captures/{item}.nextCaptureSequence += 1` | before rendering | `item`, `captureSequence`, the item scope's authorization (and its rate-limit entry) |
| `staged` | Policy `stage`: a create-only write of `{commandId}/{occurrenceId}.png` (`ifGenerationMatch=0`), then a transaction `reserved` → `staged` | after rendering | `sha256`, `size`, `stagedAt` |
| `bound` | Policy's command bind (B5) | after staging | args `(item, sha256, captureSequence)`, exactly as reserved and staged; otherwise `binding-mismatch` |

**What the compiler does (C5d).**
1. It calls `reserve(intent, key)`, which answers with the reservation and the staged digest, if any.
2. It renders only if nothing is staged.
3. It calls `stage(png)`.
4. It binds and invokes with the staged digest.

The occurrence id comes from `expand` and is stable across attempts, so every call is idempotent.

**Recovery, and crashes at each boundary.** C5d tests these end to end; C5a tests them at store level.
- **After `reserve`, before staging:** the retry gets the same sequence, renders, and stages.
- **After the staging object is written, before the record moves to `staged`:**
  - the retry's create-only write fails `412`;
  - Policy reads the existing object, records its digest, and answers with it;
  - the retry discards its own render, so the bytes staged first always win.
- **After `staged`, before bind:** the retry doesn't render. It binds with the staged digest.
- **After bind:** B5 as today. Broker reads the staged bytes by `(commandId, occurrenceId)`, checks the digest, and publishes.

**An expired worker generation.**
- `reserve`, `stage` and bind are fenced. A stale worker is refused `fenced` at each one, and the new owner continues from the recorded state.
- A stale worker can still win the race to create the staging object. Its bytes are then adopted. That is safe: they are a render of the same reserved item, by the same pinned revision.

**Staging expiry.**
- Policy refuses to mint an execution token for a capture staged more than 25 days ago (`staging-expired`). The refusal is definite and nothing was written, so the occurrence is `failed` and a new capture is needed.
- Broker refuses with the same reason if the staged object is gone.
- Once published, the staged bytes are no longer needed: reconcile reads the published object.

**Abandoned reservations** never publish, so the next capture's higher sequence publishes normally.

## 3. C5a, in detail

C5a ships the authorization model **inert for production traffic**. The api allocates no v3 command until `COMMANDS_L0013` turns on in C5d, and every v2 path stays byte for byte unchanged.

It is **proven live** by a gate that creates the first v3 records. The rollback protections are therefore installed **before** that gate.

### Slices

1. **Registry and contract types** (`packages/common`).
   - **Registry:**
     - `FunctionSpec.credential`, `.scope` and `.publicCapture`;
     - `OPERATIONS["gcs.put-thumbnail"]` and `PROTECTED_FUNCTIONS["0013"].snap`;
     - `isOperationAllowed` decided by credential;
     - `REGISTRY_VERSION` 9, `REGISTRY_WINDOW` `[8]`, `ARTIFACT_COMPATIBLE_VERSIONS` `[8]`.
   - **Contract:**
     - the v3 `Plan`, with optional `connectionId` and `scopes`;
     - the token profiles of decision 6.
   - **Checks:** `scripts/check-registry-version.js` checks L0013 too.
   - **Tests:**
     - `manage.ts` excludes `gcs`, and `snap` isn't grantable;
     - a v2 plan digest is unchanged;
     - a stored v8 artifact is still served;
     - `isOperationAllowed` holds for `snap` only with backend `gcs`;
     - each token profile refuses both scopes and neither.
2. **Broker** (`packages/broker`).
   - **The work:**
     - v3 tokens;
     - the service-credential branch;
     - `credential-scope-mismatch` and the `args.item === scp.id` check;
     - the receipt's scope binding;
     - the `gcs` operations module: decision 8's publish and reconcile, reading from staging.
   - **Its bucket:** `THUMBNAIL_BUCKET`, set in C5a to the **gate bucket**, so Broker's C5a release can't write production thumbnails at all.
   - **Tests, with a fake GCS:**
     - a service operation with `conn` is refused, and so is a connection operation with `scp`;
     - an `args.item` other than `scp.id` is refused before the claim;
     - a v2 L0176 token from the current Policy is accepted unchanged;
     - the first capture publishes;
     - an older sequence arriving after a newer one completes `superseded: true` and leaves the object;
     - a `412` race between two captures ends on the newer;
     - a retry of a written operation answers from its receipt;
     - a retry after a crash between the upload and `putOutcome` reconciles `applied` and writes nothing;
     - a staged digest mismatch, or a missing staged object, is refused.
3. **Policy** (`packages/policy`).
   - **Authorization:**
     - scopes (decision 1);
     - connection-optional allocation;
     - admission authorizing each static scope by kind;
     - the item-authority client.
   - **Captures:**
     - `reserve` and `stage` (decision 9), with the staging bucket;
     - the rate limit.
   - **Execution tokens:**
     - one scope per execution token at mint;
     - `liveRefusal` by scope kind.
   - **Records:**
     - provenance `anonymous`;
     - audit with a nullable `connectionId`, plus `itemId`, `publicCapture` and the new provenance;
     - `CALLERS` for `l0013r-run`.
   - **The worker capability `scopes`.**
     - `listDue`, `renewLease` and `takeOver` hand a v3 command only to a worker that declares `scopes: 1` (`ownableBy`, like `recording` and `repairs`). Any other worker gets `worker-unsupported`.
     - The current api declares nothing, so it can never list or lease one.
   - **Tests:**
     - each scope kind is authorized at admission;
     - a mixed chain is one v3 invocation with two scopes, and each execution token carries only its own scope;
     - a connection-only chain stays v2, with the same digest;
     - a non-owner's private capture is refused at allocation, and at reservation for a bound scope;
     - an owner's capture is refused at authorize-execution after the item changes owner;
     - public captures by a signed-in non-owner and by `anonymous` are rate-limited at the 13th;
     - `item-authority-unavailable` never allows;
     - decision 9's boundaries, fencing and staging expiry, at store level;
     - a worker without `scopes` sees no v3 command in `listDue` and can't lease or take one over;
     - every existing L0176 command, repair and reconcile test passes unchanged.
4. **Console route** (graffiticode-app): `POST /api/internal/item-authority`. Tests:
   - only `policy-run`'s token is accepted;
   - an unknown item answers `exists: false`;
   - an item under two owners answers `ambiguous`.
5. **The deploy floor,** released with slices 2 and 3.
   - `deploy.json` gains a `baselines` entry `{ milestone: "C5a-scopes", commit: <the slice 3 merge>, floor: true }` for `policy` and `broker`.
   - From then on, `rollback --release` and releases from an older commit are refused below it.
   - Test: `npm run test:deploy` covers the new entry.

### Release order (C5a)

1. **Decision 0** (#398), on its own.
2. **The console route.** Nothing calls it yet.
3. **Broker, at the floor commit.** It accepts v3 tokens and registry versions 8 and 9, and is configured with the gate bucket.
4. **Policy, at the floor commit.** It accepts both versions, no api asks it for v3, and it lists and leases v3 commands only to `scopes` workers.
5. **Compilers report 9:** `l0176r` and `l0013r` releases that change only the constant. The window keeps 8, so v8 plans keep executing.
6. **The api's `REGISTRY_VERSION` 9,** with `COMMANDS_L0013` absent. It doesn't declare `scopes`; that comes with C5d.
7. **The live gate** (below), only after steps 3–5 are released with the floor in `deploy.json`.

### IAM changes (C5a)

Each is recorded in `docs/capability-policy-iam-review.md` as a new step and applied only with the owner's explicit approval.

- **`l0013r-run`:**
  - `run.invoker` on `policy` and `broker`;
  - their hosts added to `compilers-l0013`'s `network.allow`, with one proxy rollout verified by `verify-rollout.js`.
- **`policy-run`** may call the console route. The route checks the token's email itself. Read the app's ingress before granting anything there.
- **The gate bucket `gs://graffiticode-c5a-gate`:** uniform and private, with `broker-run` as `objectUser`. It is deleted after the gate, as `gs://graffiticode-b6-drive` was.
- **The staging bucket `gs://graffiticode-command-staging`** (decision 8): `policy-run` as `objectCreator`, `broker-run` as `objectViewer`. It is created in C5a because `stage` is part of C5a's tested model.
- **A canary window, `canary-window-c5a`,** for the gate only: a time-limited `iam.serviceAccountOpenIdTokenCreator` for the operator on `api-run` (as the gateway) and on `l0013r-run` (as the compiler). It expires on its own, as B6's did.
- **Nothing else:**
  - nothing changes on `graffiticode.appspot.com`;
  - `graffiticode-thumbnails` isn't created yet (C5b).

### Rollback (C5a)

- **Before the gate:** each C5a release can be rolled back by its own receipt, except below the floor.
  - The floor exists from step 3, so Policy and Broker can't return to a pre-scope revision once one has been released.
- **The gate creates v3 records:**
  - **Invocations and plans:** the floor keeps a scope-capable Policy and Broker serving them.
  - **Commands, if the gate creates any:** the `scopes` capability keeps today's api from listing, leasing or taking them over.
- **Compilers:** the registry window keeps 8 indefinitely (decision 2), so rolling compilers back to a v8 revision is always safe.
- **The gate itself needs no rollback:**
  - its records stay as evidence;
  - the canary items are left as they are;
  - the gate bucket is deleted after the evidence is extracted.

### C5a completion gate

All five slices are merged and released in the order above, and:

**L0176 is unchanged.**
- The staged production canary passes 36 of 36 against Policy and Broker at their C5a releases.
- The B6 repair round-trip (`docs/evidence/b6-repair-activation/roundtrip.mjs`) passes against them too.
- A v2 plan digest computed before and after is identical.
- A stored v8 artifact is still served.

**The live gate passes.** `scripts/c5a-gate.js` runs in `canary-window-c5a`, as the canary account. It uses the two owner-approved fixture items, one canary-owned private and one canary-owned public, both listed in the evidence. Through the released Policy and Broker, it shows:
- **Private item:** captured by its owner. Refused for a non-owner, at allocation and again at authorize-execution after access is narrowed.
- **Public item:** captured anonymously, rate-limited, and recorded as `anonymous` with `publicCapture: true`.
- **Mixed chain:** an item capture plus an L0176 save through the canary's sandbox connection is one v3 invocation, and each execution token carries only its own scope.
- **Mismatches:** `credential-scope-mismatch` holds both ways.
- **Reserve, stage and bind:**
  - they run in order;
  - a repeated `reserve` or `stage` returns the recorded state;
  - the object published in the **gate bucket** carries the reserved sequence;
  - an out-of-order pair ends on the newer capture.
- **Nothing written elsewhere:** `graffiticode.appspot.com`'s `thumbnails/` listing and generations are unchanged, and `graffiticode-thumbnails` gets nothing.

**Old workers can't take v3 commands.** Production's api `listDue` (checked through a status read) never returns the gate's v3 commands, and its sweeper logs no lease of them.

**The console route** refuses any caller but `policy-run`, checked live.

**The proxy** lets `l0013r` reach Policy and Broker and nothing else new (`verify-rollout.js`, the AT-11 probe).

**Evidence** goes in `docs/evidence/c5a-authorization/`: the release ids, the gate output and the extracts. Then the gate bucket is deleted and the window expires.

## 4. C5b–C5e, in outline

Each gets its own detailed slices after C5a.

- **C5b Publish to the thumbnails bucket.**
  1. Create `graffiticode-thumbnails` (decision 8). Copy every existing `graffiticode.appspot.com/thumbnails/*.png` into it, keeping the names.
  2. Grant `broker-run` `objectUser` there and verify it live: a write, a `412`, an overwrite.
  3. Release the console's new base URL. Thumbnails made after step 1 are still only in the old bucket, so they look stale until step 5.
  4. Release `l0013r` with `THUMBNAIL_BUCKET=graffiticode-thumbnails` and no `predefinedAcl` (a uniform bucket refuses it). `l0013r-run` gets `objectUser` there until D4.
  5. **Catch up without overwriting newer work.**
     - Copy each old object updated after step 1 to the new bucket, with `ifGenerationMatch` set to the generation step 1 recorded for that name, or `0` if step 1 found none.
     - So a capture already written to the new bucket since step 4 is never replaced by an older one.
     - The copy reports every name it skipped.
  6. Switch Broker's `THUMBNAIL_BUCKET` from the gate bucket to the thumbnails bucket.
- **C5c IAM handoff, at D4.**
  - `l0013r-run` loses `graffiticode-thumbnails`.
  - Both `l0013-run` and `l0013r-run` lose `objectAdmin` on `graffiticode.appspot.com`, in one change.
  - A check confirms that neither can write either bucket (`get-iam-policy`, plus a denied test write).
- **C5d The snapshot as a command.**
  - An L0013 interpreter declaration and model (Track C).
  - `reserve` and `stage` in the kernel's `ExecContext`, and snap through `invoke` in a command session. With no session, the legacy upload is unchanged until D4.
  - The api declares the `scopes` capability.
  - `INTERPRETER_L0013`, `COMMANDS_L0013` and a new `COMPILE_GENERATION_L0013`, released together.
  - A staged drive covering decision 9's crash points, on gate fixtures in a drive bucket, plus canary snapshot checks.
  - Repair and `materializes()` for L0013 stay out of scope. A failed snap is captured again.
- **C5e Bridge.**
  - With `COMMANDS_L0013` on, a legacy compile that reaches `snap` becomes a command with a fresh key, anonymous callers included, and the answer comes back in today's envelope.
  - The bridge runs for a connection, or for an item-scoped write in a language whose commands are on.
  - D3 moves the console to `POST /command` with a stable key.
  - D4 (bridge off, both accounts lose write) waits for the public-exception decision.

**Order:** decision 0 → C5a → C5b → C5d staged drive → C5d activation → C5e/D3 → the exception decision → D4 with C5c.

## 5. Completion gate for C5

The master plan's C5 tests, amended for decision 8, all passing, the last one after D4:
1. The first capture publishes.
2. An older capture finishing after a newer one leaves the newer published.
3. An abandoned reservation doesn't block the next capture.
4. A private item is refused for a non-owner at allocation, and again at execution after revocation.
5. A public item without an owner token succeeds, rate-limited and recorded.
6. Chains capturing two items, and chains mixing a snapshot with an L0176 save, are one invocation with a scope per intent. A mismatched credential or scope is refused.
7. A service operation carrying a connection is refused.
8. After D4, neither `l0013-run` nor `l0013r-run` can write either bucket.

Also:
- decision 9's crash, fencing and expiry tests;
- the `task` override test;
- canary snapshot checks;
- L0176's canary and repair round-trip, unchanged at every step;
- registry 8 still accepted, its retirement gate not run.

## 6. Out of scope

- Repair and materialization for L0013.
- Ending the public-capture exception.
- Retiring registry 8 (its own gate, decision 2).
- Deleting old thumbnails from `graffiticode.appspot.com`.
- Anonymous `POST /command`.

## 7. Risks

- **The console becomes a dependency of Policy for item scopes.** If the console is down, item captures are refused temporarily. L0176 is unaffected.
- **Registry 9 needs an `l0176r` release.** The change is only the constant, it follows P1b with 8 kept, and it is gated by the staged canary and the repair round-trip.
- **Narrowing capture to owners** could break a caller not yet seen. The bridge's audit shows it after activation, before D4.
- **Thumbnails made during C5b's switch** look stale only between C5b steps 3 and 5. The catch-up copy can't overwrite a newer capture (its generation precondition), and the copy log lists what it skipped.
- **The gate's canary window** gives an operator token creation on two runtime accounts. It is time-limited and approved separately, as B6's was.
