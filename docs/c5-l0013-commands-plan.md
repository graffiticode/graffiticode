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

**Owner's second review (2026-11-15, at `111f25d3`).** Six findings, each resolved below:
1. **Staged objects are named by stage too.** The path is `{commandId}/{stage}/{occurrenceId}.png`, the same identity Broker looks up. A test runs identical snap programs in two stages (decision 9).
2. **Policy can read what it staged.** `policy-run` gets `objectViewer` beside `objectCreator`, on the staging bucket only. That is what adopting a lost acknowledgment needs, and it adds no overwrite (decision 8).
3. **No legacy writer ever touches the new bucket.**
   - Direct uploads keep writing only the old bucket, so no direct writer ever gets access to the new one.
   - At activation they are disabled and drained. Then a one-time migration copy, under the same generation fence, brings over what they wrote.
   - Only then does the console switch (decision 8, §4).
4. **Staging expiry never fails a possibly-applied write.**
   - Policy no longer refuses on staging age.
   - Broker checks the staged bytes **before** its receipt claim. With no claim, nothing was written, so a missing object is a definite refusal.
   - Once a claim exists, receipt replay and reconciliation answer, and staging is never read again (decision 9).
5. **The result is stable.**
   - The operation's effect is "the item's published sequence is at least this capture's".
   - Its result `{ item, captureSequence, sha256, url }` comes from its own arguments, so reconciliation rebuilds exactly the original result.
   - Whether a newer capture had already published is an observation recorded on the receipt's step, not part of the result.
   - A test covers a dropped outcome followed by a newer capture (decisions 5 and 8).
6. **Connectionless eligibility follows the chain's effect stages, not its head.** The gate includes an L0013 capture under an L0000 head (decision 1, §3).

**Owner's third review (2026-11-15, at `23bec2d7`).** Two integration gaps, each resolved below:
1. **Publishing retries are registered, bounded attempts.** A `412` made publishing dispatch its one step again, which Broker's step rules refuse.
   - The operation's step now declares `attempts: 4` and `conditional: true`.
   - Each attempt is authorized fresh by Policy and audited, and recorded on the receipt.
   - Only a `conditional` step may have more than one attempt. L0176's steps declare neither, so their rules are unchanged, and a test proves it.
   - A test covers the older capture winning first and the newer retrying (decisions 2, 5 and 8).
2. **Compiler support comes before the gate, by approval, per stage.**
   - The kernel today only asks for a session through a connection (`languages/l0000/crates/core/src/protected.rs:263-266`), so a connectionless L0013 stage needs real compiler work, not a constant.
   - That work moves into C5a (slice 6). `l0013r` becomes pinnable, advertising contract 3 only from that release.
   - Admission applies an explicit, tested per-stage rule: a stage needs contract 3 only if it has an item-scoped intent. Existing pinned revisions and their records are untouched.
   - The gate runs end to end through approved revisions (decision 10, §3).

**Owner's fourth review (2026-11-15, at `7f479cfd`).** One rollout correction:
- L0185 and L0000 have no protected functions, so they keep reporting registry version **0**, and only `l0176r` and `l0013r` report 9. The owner reproduced that L0185 reporting 9 beside L0176 reporting 9 is refused `registry-version-mismatch`.
- The release instructions are corrected (decision 10, §3), and the mixed-version admission check is added to Policy's tests and the gate.

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
- **Connectionless eligibility follows the chain's effect stages, not its head.**
  - A request with no connection may run as a command when **some stage** of the chain is in a language whose commands are on and which declares an item-scoped write. That is decided by the api from the chain's tasks and their languages' registry entries, as `buildEligibility` does for flagged stages.
  - The head may be any language, such as an L0000 program over an L0013 capture.
  - Admission then refuses any connection-scoped intent in such a chain (`connection-required`). Any stage's item-scoped intents are authorized as in this decision.

### 2. The registry: credential and scope, version 9, and version 8 kept

**New fields.**
- `FunctionSpec` gains `credential` (`"connection"`, the default, or `"service"`), `scope` (`"connection"`, the default, or `"item"`) and `publicCapture` (`{ since: "<date>" }`, or absent).
- L0013 registers `snap`: kind `write`, `credential: "service"`, `scope: "item"`, not delegable, `publicCapture: { since: <activation date> }`.
  - Its operation is `gcs.put-thumbnail`: backend `gcs`, kind `write`, `credential: "service"`, with one `dispatch` step `publish` (`conditional: true`, `attempts: 4`) and a `receipt` replay step.
- **A step may declare `conditional: true` with `attempts: n`** (2 ≤ n ≤ 4).
  - Such a step is a precondition-guarded write: a failed precondition means nothing was written.
  - Only a `conditional` step may be authorized more than once, as attempts 1..n of that same step, in order.
  - Every other step keeps today's rule: once, in registered order, never repeated. L0176's steps are unchanged.
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

**Conditional attempts** (`gcs.put-thumbnail`'s `publish` step, decision 8):
- **Authorization.** Each attempt is authorized by Policy before it is sent, as `authorize-execution { step: "publish", purpose: "dispatch", after, attempt }`.
  - Attempt 1 has `after: null`. Attempt k > 1 has `after: "publish"` and `attempt: k`.
  - Policy allows attempt k only if the step is `conditional`, k ≤ its `attempts`, and the execution token is live. Each attempt gets its own decision id.
  - `isStepRegistered` gains `attempt`. For a step that isn't `conditional`, any `attempt` > 1 is `step-not-registered`, so L0176's validation is byte for byte the same.
- **Audit.** Each attempt is audited as an `execute-step` with its `attempt` and decision id.
- **Receipt record.**
  - Each attempt is persisted before the next one is authorized, at `receipts/{opid}/attempts/{k}`, as `{ step, attempt, decisionId, observed }`. `observed` is `precondition-failed`, `published` or `newer-present`.
  - A `precondition-failed` attempt wrote nothing, so it isn't a completed step and never makes an outcome `partial`.
  - Only the attempt that wrote, or found a newer capture, completes the step.
- **Exhaustion.** After `attempts` failed preconditions, the operation is `failed`, `precondition-contention`. That is definite, because no attempt wrote.
  - A new capture is needed, but in practice each `412` means another capture published. A newer one ends the loop at the next read as `newer-present`, so only older captures that kept winning first can exhaust it.
  - The operation deadline still bounds the whole loop.
- **Tests (slice 2):**
  - **Older wins first.** Captures A (sequence 5) and B (sequence 6) both read the object at sequence 4, and A writes first.
    - B's attempt 1 fails `412`. Its attempt 2 is authorized fresh, with a new decision id, reads sequence 5, and writes.
    - Each of B's two attempts has its own audit entry and receipt record. The object ends at sequence 6.
    - A is `completed` with `observed: published`.
  - **Four `412`s in a row** make B `failed` with `precondition-contention`. The object is never written by B.
  - **Retry rules.** A fifth attempt, an attempt on a step that isn't `conditional` (L0176's `questions`, `items`), and attempt k with `after` other than `publish` are each refused by Policy.
  - **L0176 unchanged.** Every existing L0176 step-order test passes unchanged.

**The receipt binding** records the selected scope (`scope: { kind, id }`) in place of `connectionId` for v3 tokens. v2 receipts are unchanged.

**The operation's effect, result and reconciliation** (`gcs.put-thumbnail`, decision 8):
- **Its effect** is defined as "the item's published `captureSequence` is at least this capture's". Writing establishes it, and so does finding a newer capture already published. A retry in either case writes nothing.
- **Its result** is `{ item, captureSequence, sha256, url }`.
  - It is a pure function of the operation's own arguments, and `resultFromEvidence` returns exactly it from the claim's evidence.
  - It never depends on what was published later.
  - Whether this execution wrote, or found a newer capture, is recorded on the receipt's step as `observed: "published" | "newer-present"`. That is an execution-time observation, not part of the result, and reconciliation never reconstructs it.
- **Reconciliation** reads the item's object metadata:
  - a `captureSequence` at or above the operation's own establishes the effect, `applied`, with the result from evidence;
  - a lower one is `unresolved`, as W5 requires, since an upload in flight could still land.
- **Test** (slice 2 and the C5d drive): capture A's outcome is dropped after its write, then a newer capture B publishes. Reconciling A gives `applied` with a result equal, field for field, to the result A's own execution returned in the undropped control run.

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
2. If this capture's sequence isn't greater, stop. The effect is already established, so the capture is `completed` with its stable result, nothing is written, and the step records `observed: "newer-present"`.
3. Otherwise upload with `ifGenerationMatch` set to that generation, or to `0` when the object was absent.
4. On `412`, the attempt is recorded `precondition-failed`, and the next attempt (decision 5) is authorized fresh and goes back to step 1, up to 4 attempts.

**What this guarantees.**
- The bytes and the sequence change together or not at all, so no crash can leave the pointer moved and the image not.
- A capture's sequence is unique per item, so retrying the operation is safe. The retry either writes once, or finds its own or a newer capture already published, and writes nothing.
- *Recommended:* this is the design's second option (`graffiticode-interpreter-design.md:806`, "make the overwrite conditional on a generation … precondition"), and it needs no mirror. The master plan's immutable `thumbnails/{item}/{sha}.png` objects and Firestore pointer are dropped, and C5b's text is amended to match.

**Every writer of the new bucket follows the protocol.**
- **Broker** writes it, under the sequence fence.
- **The one-time migration copy** writes it with `ifGenerationMatch=0` only, which creates a name and never replaces one. Its objects carry no `captureSequence`, which reads as 0, so any capture replaces them.
- **No direct writer ever gets access.** `l0013r`'s legacy upload keeps writing only the old bucket until it is disabled (§4, C5b), so an unfenced writer can never remove a newer capture or its sequence.

**The console** changes one constant, its thumbnail base URL. It switches only after direct uploads are disabled and drained and the migration copy has run (§4). The returned `url` keeps its `?v=<sha>` cache-buster.

**Permissions follow from the protocol.** See Google's [IAM roles for Cloud Storage](https://docs.cloud.google.com/storage/docs/access-control/iam-roles).
- `broker-run` needs `objects.get` for the metadata, plus `objects.create` and `objects.delete`, since overwriting a live object requires delete. That is `roles/storage.objectUser` on `graffiticode-thumbnails` only.
  - `objectCreator` can't overwrite.
  - `objectAdmin` adds IAM changes this protocol doesn't need.
- These are checked live before activation: a test write, a precondition failure and an overwrite, all by `broker-run`.

**Staging** (decision 9) lives in a new **`gs://graffiticode-command-staging`**: uniform, private, deleted by a 30-day lifecycle rule.
- `policy-run` has `roles/storage.objectCreator` and `roles/storage.objectViewer`, on this bucket only.
  - Create without delete can't overwrite, which matches stage-once.
  - The viewer role gives `objects.get`, which adoption needs: reading the object a lost acknowledgment left behind.
  - Neither grants delete, so staged bytes are immutable to Policy.
- `broker-run` has `roles/storage.objectViewer`.

**The old bucket.**
- Once the console reads the new bucket, nothing reads `graffiticode.appspot.com/thumbnails/`.
- Direct uploads there are disabled and drained at activation (§4). Both L0013 accounts' `objectAdmin` there is removed at D4 (C5c).
- Old objects are left in place.

**The command's own artifact** keys on `[uid, taskId, connectionId-or-null]`, with `ownerUid` set to the caller. Under commands, `snap` isn't cacheable.

### 9. Reserve, stage, bind: three durable states per capture

Each capture occurrence moves through these states in Policy's command record (`occurrences/{stage}:{occ}`). Each state is written once, under the command's fencing generation.

| State | Written by | When | Holds |
| --- | --- | --- | --- |
| `reserved` | Policy `reserve`, in one transaction with `item-captures/{item}.nextCaptureSequence += 1` | before rendering | `item`, `captureSequence`, the item scope's authorization (and its rate-limit entry) |
| `staged` | Policy `stage`: a create-only write of `{commandId}/{stage}/{occurrenceId}.png` (`ifGenerationMatch=0`), then a transaction `reserved` → `staged` | after rendering | `sha256`, `size`, `stagedAt`, the object's path |
| `bound` | Policy's command bind (B5) | after staging | args `(item, sha256, captureSequence)`, exactly as reserved and staged; otherwise `binding-mismatch` |

**What the compiler does (C5d).**
1. It calls `reserve(intent, key)`, which answers with the reservation and the staged digest, if any.
2. It renders only if nothing is staged.
3. It calls `stage(png)`.
4. It binds and invokes with the staged digest.

The occurrence id comes from `expand` and is stable across attempts, so every call is idempotent.

**Identity includes the stage.** Occurrence ids repeat across stages: identical snap programs in two stages expand to the same id. So a staged object, its record and Broker's lookup are all keyed by `(commandId, stage, occurrenceId)`, the same triple as the operation id. Test (slice 3, and the C5d drive): one chain with the same snap program in two stages stages, binds and publishes two captures, each from its own render, and neither stage reads the other's bytes.

**Recovery, and crashes at each boundary.** C5d tests these end to end; C5a tests them at store level.
- **After `reserve`, before staging:** the retry gets the same sequence, renders, and stages.
- **After the staging object is written, before the record moves to `staged`:**
  - the retry's create-only write fails `412`;
  - Policy reads the existing object (`objects.get`, decision 8), records its digest, and answers with it;
  - the retry discards its own render, so the bytes staged first always win.
- **After `staged`, before bind:** the retry doesn't render. It binds with the staged digest.
- **After bind:** B5 as today. Broker reads the staged bytes by `(commandId, stage, occurrenceId)`, checks the digest, and only then claims and publishes.

**An expired worker generation.**
- `reserve`, `stage` and bind are fenced. A stale worker is refused `fenced` at each one, and the new owner continues from the recorded state.
- A stale worker can still win the race to create the staging object. Its bytes are then adopted. That is safe: they are a render of the same reserved item, by the same pinned revision.

**Staging expiry never fails a write that may have happened.**
- **Broker checks the staged bytes before claiming.** It reads and checks the staged object **before** its receipt claim, and a write needs a claim first.
- **No claim, missing bytes.** A missing or mismatched object with no claim for the operation id is refused `staging-unavailable`. That is definite: nothing was written. Only then is the occurrence `failed`.
- **A claim exists.** Broker never reads staging again:
  - a recorded outcome is replayed from the receipt;
  - an uncertain claim goes to reconciliation, which reads the published object.

  So expiry can't turn a possibly applied write into a failure.
- **Policy makes no age-based refusal.** The 30-day lifecycle only bounds storage.
- Test (slice 2): the staged object is deleted after a claim whose outcome was dropped. The retry reconciles `applied`, with the stable result, and nothing is refused.
- Test (slice 2): the staged object is deleted with no claim. The refusal is `staging-unavailable`, definite, and no claim is made.

**Abandoned reservations** never publish, so the next capture's higher sequence publishes normally.

### 10. Compiler support, approval and the per-stage contract rule

**What a stage needs from its compiler under v3.** It depends only on the stage's own intents:

| Stage | What its compiler sees under a v3 plan | Contract it must advertise |
| --- | --- | --- |
| no protected functions (an L0000 head, L0185) | no session or token, the same preflight and model as v2 | 2 or 3 |
| only connection-scoped intents (L0176 in a mixed chain) | a session through the plan's connection, as today; tokens are opaque bearer strings that the kernel only passes back to Policy | 2 or 3 |
| any item-scoped intent (L0013's `snap`) | a command session without a connection, plus `reserve` and `stage` | 3 |

**The rule.**
- Admission computes each stage's required contract from its admitted intents. It refuses `contract-version-unsupported` unless the pinned revision's approval record lists it, and lists 2 or 3 for the first two rows.
- A v2 plan is checked exactly as today, against `CONTRACT_VERSION` 2.
- *Recommended:* it is explicit, and it means a mixed or composed v3 plan can pin today's approved L0000 and L0176 revisions. Their records aren't rewritten.

**Tests.**
- **Policy (slice 3):**
  - each row is admitted with the listed versions and refused without them;
  - a v2 plan pinning a `[1, 2]` revision is admitted as before;
  - a v3 plan whose L0013 stage pins a revision without 3 is refused;
  - **mixed registry versions,** with Policy at registry 9:
    - L0185 reporting 0 with L0176 reporting 9 is admitted;
    - L0185 reporting 9 with L0176 reporting 9 is refused `registry-version-mismatch`;
    - L0000 reporting 0 over L0013 reporting 9 is admitted;
    - L0013 reporting 8 with L0176 reporting 9 is refused.
- **Kernel (slice 6):** a connection-scoped stage under a v3 plan sends Policy byte-identical snapshot and command-session requests to v2, and never decodes a token.

**The compiler work (C5a slice 6).** It is released inert, because the api allocates no L0013 command until C5d. Its parts:
- **The kernel** (`languages/l0000/crates/core`):
  - A **command session no longer needs a connection.** `command_session` is used whenever the exec context carries a command session, and the legacy snapshot path still requires a connection (`protected.rs:263-266`).
  - **`reserve` and `stage`** are added to `ExecContext` and the Policy client (decision 9).
  - The preflight manifest's `requiredFunctions` and the model's intents carry item scopes (`{ kind: "item", id }`) when the item is a literal.
- **L0013** (`languages/l0013/crates/core`): inside a command session, snap runs `reserve`, renders only if nothing is staged, then runs `stage` and `invoke` with `(item, sha256, captureSequence)`. Outside one it uploads directly to the old bucket, unchanged until C5d's disable step.
- **Approval** (`deploy.json`):
  - `l0013r` gains `pinnable: { lang: "0013", contractVersions: [3] }`. Its releases are recorded `approved` in the revisions database like L0176's.
  - The contract-floor report (`packages/deploy/src/revisions.js:126`) counts a revision as meeting the floor when it lists the floor or a later version. A v3-only revision then isn't reported as unsupported. This is tested in `test:deploy`.
- **Other pinnable services:**
  - **Only protected languages report the registry version.** Admission requires every stage with protected functions to report the plan's version, and every stage without any to report 0 (`policy.ts:1479-1493`).
    - The bump therefore needs exactly two compiler changes: `l0176r` and `l0013r` report 9.
    - `l0185r` and `l0000r` have no protected functions. They keep reporting **0** and are **not** released for the bump. A non-zero version from them is refused `registry-version-mismatch`.
  - `l0176r`'s registry-9 release keeps `contractVersions` at `[1, 2]` (per the rule), so its declaration doesn't change.
  - Existing revisions and their approval records are never edited. Plans already pinned to them keep them.

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
     - an older sequence arriving after a newer one completes with its stable result, `observed: "newer-present"`, and leaves the object;
     - a dropped outcome followed by a newer capture reconciles `applied` with the original result (decision 5);
     - a staged object deleted after a claim still reconciles; deleted with no claim, it is refused `staging-unavailable` before claiming (decision 9);
     - a `412` race between two captures ends on the newer;
     - a retry of a written operation answers from its receipt;
     - a retry after a crash between the upload and `putOutcome` reconciles `applied` and writes nothing;
     - a staged digest mismatch is refused before the claim;
     - two stages with the same occurrence id read their own staged objects.
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
     - decision 9's boundaries and fencing, at store level, including adoption after a lost staging acknowledgment, and two stages with the same occurrence id staging separately;
     - a chain whose head is L0000 over an L0013 capture is eligible without a connection, and a connectionless chain with a connection-scoped intent is refused `connection-required`;
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
6. **Compilers** (decision 10): kernel command sessions without a connection, `reserve` and `stage`, item scopes in manifests and models, L0013's command branch, `l0013r` pinnable at `[3]`, and the floor report's rule.
   - **Kernel tests:**
     - a connection-scoped stage under a v3 plan sends byte-identical Policy requests;
     - a connectionless command session is used for an item-scoped intent, and the legacy snapshot path still needs a connection.
   - **L0013 tests, against a fake Policy:**
     - a command snap reserves, renders, stages, binds and invokes;
     - a retry after staging doesn't render;
     - two stages with the same snap program each reserve and stage their own capture;
     - outside a command session, snap is unchanged.
   - **Deploy test:** `test:deploy` covers `l0013r`'s pinnable entry and the floor report's rule.

### Release order (C5a)

1. **Decision 0** (#398), on its own.
2. **The console route.** Nothing calls it yet.
3. **Broker, at the floor commit.** It accepts v3 tokens and registry versions 8 and 9, and is configured with the gate bucket.
4. **Policy, at the floor commit.** It accepts both versions, no api asks it for v3, and it lists and leases v3 commands only to `scopes` workers.
5. **Compilers (slice 6).**
   - `l0013r` is released pinnable with `[3]`, inert: no api gives it a session.
   - `l0176r` is released reporting registry 9, with its declaration unchanged at `[1, 2]`.
   - `l0185r` and `l0000r` are not released: they have no protected functions and keep reporting 0.
   - Each release's approval record is checked in the revisions database. The window keeps 8, so v8 plans keep executing on their pinned revisions.
6. **The api's `REGISTRY_VERSION` 9,** with `COMMANDS_L0013` absent. It doesn't declare `scopes`; that comes with C5d.
7. **The live gate** (below), only after steps 3–5 are released with the floor in `deploy.json`, and `l0013r`'s release is approved with `[3]`.

### IAM changes (C5a)

Each is recorded in `docs/capability-policy-iam-review.md` as a new step and applied only with the owner's explicit approval.

- **`l0013r-run`:**
  - `run.invoker` on `policy` and `broker`;
  - their hosts added to `compilers-l0013`'s `network.allow`, with one proxy rollout verified by `verify-rollout.js`.
- **`policy-run`** may call the console route. The route checks the token's email itself. Read the app's ingress before granting anything there.
- **The gate bucket `gs://graffiticode-c5a-gate`:** uniform and private, with `broker-run` as `objectUser`. It is deleted after the gate, as `gs://graffiticode-b6-drive` was.
- **The staging bucket `gs://graffiticode-command-staging`** (decision 8): `policy-run` as `objectCreator` and `objectViewer`, `broker-run` as `objectViewer`, on that bucket only. It is created in C5a because `stage` is part of C5a's tested model.
- **The gate api, `api-c5a-gate`,** for the gate only, as B6's `api-drive` was:
  - the api at the C5a commit, as `api-run`, private;
  - `COMMANDS_L0013=on`, generation `c5a-gate-1`, and the `scopes` capability, with **no sweeper**, so recovery is left to C5d's drive;
  - `BASE_URL_L0013` is production `l0013r`, whose approved revision the plans pin;
  - it is deleted after the gate.
- **A canary window, `canary-window-c5a`:** a time-limited `iam.serviceAccountOpenIdTokenCreator` for the operator on `console-run@graffiticode-app`, to call the gate api as the canary account does through the console. It expires on its own, as B6's did.
- **Nobody impersonates a compiler.** Every compiler call comes from the approved `l0013r`, `l0176r` and `l0000r` revisions themselves.
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
  - the gate bucket and `api-c5a-gate` are deleted after the evidence is extracted, and the window expires;
  - `l0013r`'s pinnable revision stays approved, which is harmless while no production api allocates L0013 commands.

### C5a completion gate

All six slices are merged and released in the order above, and:

**L0176 is unchanged.**
- The staged production canary passes 36 of 36 against Policy and Broker at their C5a releases.
- The B6 repair round-trip (`docs/evidence/b6-repair-activation/roundtrip.mjs`) passes against them too.
- A v2 plan digest computed before and after is identical.
- A stored v8 artifact is still served.

**The live gate passes.**
- `scripts/c5a-gate.js` runs in `canary-window-c5a`, as the canary account, through `api-c5a-gate`.
- It uses the two owner-approved fixture items, one canary-owned private and one canary-owned public, both listed in the evidence.
- Every plan pins approved revisions:
  - the `[3]` `l0013r` release;
  - the current production `l0000r` and the registry-9 `l0176r`, at `[1, 2]`, under the per-stage rule.
- Through the released Policy, Broker and compilers, it shows the following.
- **Private item:** captured by its owner. Refused for a non-owner, at allocation and again at authorize-execution after access is narrowed.
- **Public item:** captured anonymously, rate-limited, and recorded as `anonymous` with `publicCapture: true`.
- **Mixed chain:** an item capture plus an L0176 save through the canary's sandbox connection is one v3 invocation, and each execution token carries only its own scope.
- **Mismatches:** `credential-scope-mismatch` holds both ways.
- **Composition:** an L0000 head over an L0013 capture of the private item runs as a connectionless v3 command, with its item scope authorized.
- **Per-stage contracts:**
  - the mixed and composed plans pin `[1, 2]` revisions for their L0176 and L0000 stages and are admitted;
  - a plan pinning a pre-slice-6 `l0013r` revision is refused `contract-version-unsupported` (it isn't pinnable);
  - the approval records of revisions released before C5a are byte-identical before and after.
- **Registry versions:** the admitted plans' manifests show `l0000r` reporting 0 and `l0176r` and `l0013r` reporting 9. The staged canary's L0185 → L0176 checks (`--l0185-tail`) show L0185 at 0 beside L0176 at 9, admitted.
- **A conditional retry:** two captures of the public item are started so that the older one publishes first. The newer one's audit shows two `execute-step` attempts with distinct decision ids, and the object ends on the newer capture.
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

- **C5b The thumbnails bucket.** Before activation, with nothing yet reading it:
  1. Create `graffiticode-thumbnails` (decision 8).
  2. Grant `broker-run` `objectUser` there and verify it live: a write, a `412`, and an overwrite.
  3. Run the migration copy of every `graffiticode.appspot.com/thumbnails/*.png` with `ifGenerationMatch=0`, keeping names and recording each source generation. Direct uploads still go only to the old bucket, and the console still reads it.
  4. Switch Broker's `THUMBNAIL_BUCKET` from the gate bucket.
- **C5c IAM handoff, at D4.**
  - Both `l0013-run` and `l0013r-run` lose `objectAdmin` on `graffiticode.appspot.com`, in one change.
  - A check confirms that neither can write either bucket: `get-iam-policy` on both buckets, plus a denied test write.
  - Neither ever held a grant on `graffiticode-thumbnails`.
- **C5d The snapshot as a command, and the switch.**
  - **What ships** (the compiler side shipped in C5a slice 6):
    - an L0013 interpreter declaration (Track C);
    - the api's `scopes` capability in production.
  - **A staged drive first:** decision 9's crash points and the two-stage case, on gate fixtures in a drive bucket, plus canary snapshot checks.
  - **Activation, in order:**
    1. The api turns on `INTERPRETER_L0013`, `COMMANDS_L0013` and a new `COMPILE_GENERATION_L0013` together, with the bridge for connectionless item-scoped chains (C5e's first bullet), so every snap the api serves is a command into the new bucket.
    2. **Disable direct uploads.** `l0013r` is released with snap refused outside a command session (`snap runs only as a command`), so no request, direct to `l0013r` or through an older api, can upload.
    3. **Drain.** Wait out `l0013r`'s request timeout after step 2's revision serves all traffic. Then confirm from its logs and the old bucket's object generations that no upload has happened since.
    4. **Catch up.** Copy each old object updated after C5b's copy into the new bucket, with `ifGenerationMatch` set to the generation C5b's copy recorded for that name, or `0` if it found none. A capture Broker has written since is never replaced, and every skipped name is reported.
    5. **The console's new base URL** is released.
  - **Between steps 1 and 5** the console shows the old bucket, which is stale for captures made in that window but never wrong. That window is minutes long.
  - **Rollback after step 2** turns off only `INTERPRETER_L0013`; commands keep running. Rolling back `l0013r` below step 2's revision would re-enable direct uploads to the old bucket only, never the new one.
  - Repair and `materializes()` for L0013 stay out of scope. A failed snap is captured again.
- **C5e Bridge.**
  - The bridge is on from activation: a legacy compile reaching `snap` becomes a command with a fresh key, anonymous included, and answers in today's envelope.
  - It runs for a connection, or for a chain with an item-scoped write stage in a language whose commands are on (decision 1).
  - D3 moves the console to `POST /command` with a stable key.
  - D4 (bridge off, plus C5c) waits for the public-exception decision.

**Order:** decision 0 → C5a → C5b → the C5d staged drive → C5d activation steps 1–5 (with the bridge) → D3 → the exception decision → D4 with C5c.

## 5. Completion gate for C5

The master plan's C5 tests, amended for decision 8, all passing, the last one after D4:
1. The first capture publishes.
2. An older capture finishing after a newer one leaves the newer published.
3. An abandoned reservation doesn't block the next capture.
4. A private item is refused for a non-owner at allocation, and again at execution after revocation.
5. A public item without an owner token succeeds, rate-limited and recorded.
6. Chains capturing two items, and chains mixing a snapshot with an L0176 save, are one invocation with a scope per intent. A mismatched credential or scope is refused.
7. A service operation carrying a connection is refused.
8. After D4, neither `l0013-run` nor `l0013r-run` can write either bucket. From C5d step 2 on, `l0013r` uploads nothing.

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
- **Thumbnails made during activation** look stale only between C5d steps 1 and 5. The catch-up copy can't overwrite a newer capture, because of its generation precondition, and its log lists what it skipped.
- **The gate's canary window** gives an operator token creation on two runtime accounts. It is time-limited and approved separately, as B6's was.
