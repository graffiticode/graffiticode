# C5: L0013 snapshots as brokered commands

**Status:** draft for the owner's review (2026-11-15). Plan item: `docs/graffiticode-interpreter-plan.md` Track C, "C5 L0013 snapshots become brokered commands" (C5a–C5e). Design: `docs/graffiticode-interpreter-design.md` §5 (one invocation per chain), the L0013 notes (`:65`, `:198`, `:806`). Builds on B5 (`docs/b5-commands-plan.md`), C6 (`docs/c6-l0176-commands-plan.md`) and B6 (`docs/b6-command-repair-plan.md`).

This draft details **C5a** (authorization without a provider connection) and fixes the decisions C5b–C5e depend on: artifact storage, IAM, release order, rollback and the completion gate. C5b–C5e get their own detailed slices once C5a's decisions are settled.

## 1. Where we start (survey, 2026-11-15, at `90a60a03`)

### The snapshot today

**Who runs it.** Production snaps run on the Rust **`l0013r`**, as `l0013r-run` (`deploy.json:837-934`).
- The TypeScript `l0013` service was deleted at A7 (2026-11-05, IAM review Step 19).
- The api routes L0013 there with `BASE_URL_L0013` and `COMPILE_GENERATION_L0013=rust-1` (`deploy.json:180-182`).
- L0013 is neither interpreted nor a command language: it has no `INTERPRETER_`, `COMMANDS_` or `BRIDGE_L0013`, and no interpreter-manifest declaration.

**What a snap does** (`languages/l0013/crates/capture/src/lib.rs:248-277`, `crates/core/src/lib.rs:147-180`):
1. `snap item "<id>" {…}..` names an item.
2. The camera resolves the item to its head task through the console's `GET /api/form/resolve?id=<item>`, passing the caller's verified token if there is one.
3. It renders `api/form?id=<task>` in headless Chromium and crops.
4. It uploads the PNG to the **fixed path** `thumbnails/{item}.png` in `gs://graffiticode.appspot.com`, with `predefinedAcl=publicRead`. The upload overwrites (`storage.rs:79-100`) and authenticates as `l0013r-run` through ADC.
5. It returns `{ url: …/thumbnails/{item}.png?v=<sha1[:16]>, item }`.

There is no thumbnail record or pointer anywhere; the fixed path is the only record.

**What "authorized" means today.** It is less than the master plan assumes.
- The resolver allows a capture when the item's **head task** is readable by the caller: `acls.public`, or the caller's uid in `acls.uids`, or no ACL (`graffiticode-app/packages/app/src/app/api/form/resolve/route.ts`, `resolvers.ts:123-149`; `packages/api/src/storage/tasks.js:36-51`).
- That is read access to the task, not edit permission on the item. `acls.uids` holds every uid that ever posted identical code (`tasks.js:113-115`).
- **A gap that's open today.** A program that supplies `task` (and `lang`) in snap's options **skips the resolve entirely**, but still writes `thumbnails/{item}.png` (`capture/src/lib.rs:253-256`, `:265`).
  - So `snap item "<any id>" {task: "<any readable task>"}..`, compiled by anyone (anonymous compiles are allowed, `routes/auth.js:18-49`), replaces any item's public thumbnail with a render of another task.
  - Nothing uses the override: snap has no `task` modifier, so it is reachable only through a literal record, and neither repo passes one.
  - See decision 0.

**Callers.**
- The console is the only one found. "Generate thumbnail" in ItemsNav (`graffiticode-app/packages/console/src/lib/generate-thumbnail.ts:17-42`) posts `snap item "<id>" {}..` and compiles it, signed in, with no connection and no `refresh`.
- The console then shows `https://storage.googleapis.com/graffiticode.appspot.com/thumbnails/{id}.png` directly (`tools-thumbnail-grid.tsx:6,47`); it never reads the returned URL.
- MCP excludes L0013 (`graffiticode-app/packages/core/src/discovery.ts:5-10`).
- **The compile cache.** L0013 is cacheable (`dialect.rs:131-133`), so a repeated identical compile is served from the api's cache **without snapping**, unless `refresh` is passed (`data.js:290-296`).

**The item store.**
- It is in the **`graffiticode-app` project's** default Firestore: `users/{owner}/items/{id}` with `isPublic`, `taskId`, `lang`, … (`graffiticode-app/packages/core/src/items.ts:31-50`).
- Edit permission is the console's own rule, existence under the caller's uid (`items.ts:270-276`).
- Nothing in this repo reads the item store.

**IAM.**
- Two accounts can write the bucket:
  - `l0013r-run` holds `storage.objectAdmin` on `graffiticode.appspot.com`; it already had it when found on 2026-11-02.
  - `l0013-run` holds a grant there too. Its service is gone, but the account and grant remain.
- The IAM review disagrees with itself on `l0013-run`'s role: objectAdmin at `:30`, `:1549`, objectCreator at `:295`, `:459`. Live IAM is read before C5c.
- `l0013r`'s proxy class `compilers-l0013` allows api, app, auth, the language hosts and `storage.googleapis.com`, but **not Policy or Broker**.

### What Policy and Broker assume

**One invocation, one connection.** Every layer assumes it.

**Policy**
- `allocateInvocation` and `allocateCommand` require a connection id and the caller's access to it (`policy.ts:237-244`, `:280-289`).
- The invocation's sequence key and binding include it (`invocations.ts:60-61,73`; `firestore.ts:45-48,129-131`).
- `Plan.connectionId` is required and is in the plan digest (`contract.ts:33`, `policy.ts:1501-1510`).
- Admission authorizes every function against that one connection (`policy.ts:1530-1540`). So do the command session (`:657-668`), `liveRefusal` (`:1128-1155`) and `commandOperation` (`:698`, `:709`).
- `provenance` is `user | publication | system` (`provenance.ts:18-41`).
- Audit requires a `conn-` id (`audit.ts:76`).

**Tokens.** Every profile requires `conn`; session, execution and replay also require `own` and `backend` (`tokens.ts:66,73,90,107,116`).

**Broker**
- It loads a credential only from the connection's sealed secret or the preview consumer (`broker.ts:396-415`).
- Its receipt binding includes `connectionId` (`:127`, `:442-451`).
- Reconcile requires a connection (`reconcile.ts:66-79`).
- Operations are Learnosity only, with no provider registry (`operations.ts:272-362`, `main.ts:91-96`).

**The registry.**
- `FunctionSpec` has no credential or scope (`protected-registry.ts:87-95`).
- `isOperationAllowed` matches the connection's backend (`:214-225`).
- Any registered backend becomes a connection backend users can create and grant (`policy/src/manage.ts:40,121`).

**The api.**
- `POST /command` requires a signed-in user, a connection, and a key bound to that connection (`routes/command.js:82-87`, `routes/utils.js:151-152`).
- The bridge runs only for compiles through a connection (`data.js:330-336`).
- Artifacts bind and key on `connectionId` (`storage/artifacts.js:38-40,62-66`).

**Groundwork that exists.**
- An intent already carries an optional `scope` (`languages/l0000/crates/core/src/model.rs:46-47`).
- Policy accepts it (`policy.ts:146-147`) and checks it, today only as "equals the token's connection" (`:709`). B5's plan already describes scope as "the connection or item it acts on" (`b5-commands-plan.md:114-116`).

### Corrections to the master plan's C5 text

The master plan is corrected by this plan's PR:
- the uploader is `l0013r`/`l0013r-run`, not `l0013`;
- `l0013r-run`'s grant predates A1b rather than being granted by it;
- the citations are off: `storage.rs:88` for the ACL, `deploy.json:837` for `l0013r`, `policy.ts:232` for `allocateInvocation`;
- "the same rule as resolving with an owner token today" is not today's rule (above, and decision 3).

## 2. Decisions for the owner

Each has a recommendation; the plan below assumes it.

### 0. Close the `task` override now, before C5

Release `l0013r` with snap's `task` and `lang` options refused with a clear error. Snap always resolves the item and renders that item's own head task. *Recommended:* it is a live integrity gap that is independent of C5, nothing uses it, and C5's item scope would otherwise authorize the item while the compiler renders whatever a program names. It is one `l0013r` release with tests, and needs no other change.

### 1. Scopes per intent: `{ kind, id }`

An intent's `scope` becomes `{ kind: "connection", id }` or `{ kind: "item", id }`. The existing bare-string scope reads as `connection`.
- **Static and bound scopes.** An item scope whose id is a literal in the model is **static**: admission authorizes it.
  - An item id that arrives as data, such as from an upstream stage, is **bound**: it is authorized at the occurrence's bind, from the bound args, before any token exists.
  - Both are re-checked at mint and at authorize-execution.
  - The console's `snap item "<id>"` is static. A connection scope is always static, as today.
- **The plan names its scopes.**
  - `Plan.connectionId` becomes optional: it is required only if some intent has a connection scope.
  - The plan gains `scopes`, the sorted, de-duplicated static scopes, inside the digest.
  - Bound item scopes are recorded on the occurrence binding (`scope`), never in the plan.
- **The invocation.**
  - Its sequence key and binding replace `connectionId` with a scope key: the connection id when there is one, otherwise `scopes:<digest>`.
  - Invocations already recorded keep `connectionId`, read as that key.
- *Recommended:* one invocation per chain (design §5), and it covers a chain that captures several items, or captures one and saves another through a connection. Bound scopes are needed because an item id from data can't be known at admission.

### 2. The registry declares credential and scope

- **`FunctionSpec` gains `credential`** (`"connection"`, the default, or `"service"`), **`scope`** (`"connection"`, the default, or `"item"`) and **`publicCapture`** (`{ since: "<date>" }` or absent).
- **L0013 registers `snap`** with `kind: "write"`, `credential: "service"`, `scope: "item"`, not delegable, `publicCapture: { since: <activation date> }`. Its operation is **`gcs.put-thumbnail`**: backend `gcs`, kind `write`, `credential: "service"`, one `dispatch` step.
- **`isOperationAllowed`** takes the backend from the credential:
  - for a connection function, the connection's backend, as today;
  - for a service function, the operation's own declared backend.
- **Service backends are never connection backends.** `manage.ts` builds `BACKENDS` only from connection-credential operations, so `gcs` can never be created, granted or listed as a connection, and `snap` never appears in grant views.
- **The registry version.**
  - The change is `REGISTRY_VERSION` 9, rolled out under P1b.
  - L0013's Rust compiler becomes the fourth source checked by `scripts/check-registry-version.js`.
  - Once it registers a function, L0013 is a protected language, so admission requires it to report 9.

### 3. Item authority: owner edits, decided by the console's store, asked by Policy

- **The rule:**
  - a **private** item may be captured by its **owner** only, which is the console's own edit rule (an item under `users/{uid}/items/{id}`);
  - a **public** item (`isPublic: true`) may be captured under the compatibility exception (decision 4).

  This is **narrower than today**. Non-owners who can read a private item's head task lose capture. The console only captures from its owner's ItemsNav, so no caller found is affected.
- **Where Policy asks.** A new console route, `POST /api/internal/item-authority { itemId }`, answers `{ exists, ownerUid, isPublic, taskId, lang }`.
  - It accepts only a Google ID token for `policy-run@graffiticode.iam.gserviceaccount.com`, with the app's audience.
  - It reads the item store with the app's existing admin access.
  - It answers `ambiguous` if the id exists under more than one owner, and Policy refuses that (`item-ambiguous`).
- **When the console is unavailable.** Policy's refusal is `item-authority-unavailable`, temporary and not definite, so a command retries it. It never falls back to allowing.
- *Recommended,* over granting `policy-run` Datastore read on the whole `graffiticode-app` project. That grant would expose every user's items, while the route exposes one answer about one item, and the console stays the owner of item semantics.

### 4. The public-capture exception, bridge-only for anonymous callers

- **Signed-in non-owners.** From activation, an item scope on a public item is authorized for any signed-in caller, recorded with provenance `user` and `publicCapture: true` on the audit entry.
- **Anonymous callers.** They are admitted only through the D2 bridge: a legacy compile without a token becomes a command with provenance **`anonymous`** and subject `anonymous`, with a fresh key every time, as today.
  - `POST /command` keeps requiring sign-in. Anonymous callers therefore get no status reads or keys, and no new public surface.
- **A rate limit.** Each item allows 12 public-exception captures per hour, counted in Policy (`item-captures/{item}`), from all non-owner callers together. Owners aren't limited beyond the gateway's own limits.
- **Ending it.** This is unchanged from the master plan: a separate, announced decision after D3's inventory, with a dated notice.
  - Because anonymous capture is bridge-only, **D4 for L0013 (bridge off) can't come before that decision**. Turning the bridge off would end anonymous capture.
- *Recommended:* it keeps every request that works today working, which the master plan requires. It also avoids opening anonymous `POST /command` before we know whether anyone needs it.

### 5. Broker matches credential to scope

**Execution and replay tokens** carry either `conn` (with `own` and `backend`) **or** `scp: { kind: "item", id }`, never both. The profile enforces exactly one.

**A `credential: "service"` operation:**
- requires `scp.kind === "item"` and no `conn`;
- requires `args.item === scp.id`, so the written object is bound to the authorized item;
- runs with **Broker's own runtime identity** through ADC.

**A connection operation presenting `scp`, or a service operation presenting `conn`,** is refused `credential-scope-mismatch` before the receipt claim.

**The receipt binding** replaces `connectionId` with the scope key (decision 1). Existing receipts are unaffected.

**Reconcile** for a service operation reads the provider directly, with no secret. For `gcs.put-thumbnail` the evidence is the content-addressed object and the pointer, so `applied` is readable (decision 8).

### 6. Tokens and the plan contract

- **Optional connection claims.** `conn`, `own` and `backend` become optional in the session, execution, replay, admission and invocation profiles, with the exactly-one rule of decision 5.
- **A new contract version.** A plan or token without a connection is **contract version 3**. Policy issues `cv: 3` only for a scoped plan, and every L0176 plan stays `cv: 2`, byte for byte.
- **Release order makes it safe:** Broker and Policy accept v3 before anything issues it (§4).

### 7. L0013 as a compiler caller

- `l0013r-run` joins Policy's and Broker's `CALLERS` as `{ role: "compiler", lang: "0013" }`.
- The api's `CALLER_IDENTITY_LANGS` gains `0013`, so the api calls `l0013r` with its identity, as it does `l0176r`.
- `l0013r` gains egress to the Policy and Broker hosts (C5c).

### 8. Artifact storage (C5b, C5d)

**Thumbnails are immutable and content-addressed.** Each is written once to `thumbnails/{item}/{sha256}.png`, publicly readable, `Cache-Control: public, max-age=31536000, immutable`.

**The pointer** is in **Broker's** database, `thumbnail-pointers/{item}`, holding `{ publishedCaptureSequence, object, sha256, commandId, publishedAt }`.
- Publishing is a compare-and-set in a Firestore transaction. It sets the pointer **only if the capture's sequence is greater than `publishedCaptureSequence`**.
- An older capture that finishes later still has its object written, and completes with `superseded: true`.

**The capture sequence** is allocated by **Policy**, from `item-captures/{item}.nextCaptureSequence`.
- The kernel gains `reserve(intent, key)` and l0013r calls it **before rendering**. Policy increments the counter in the bind transaction and records the value on the occurrence binding, so a retry or recovery reuses it.
- Allocation never publishes: an abandoned capture never moves the pointer.

**The rendered PNG is staged before the write** (C5d).
- At bind, the compiler sends the PNG to Policy, which stores it in a new private bucket, `gs://graffiticode-command-staging`, as `{commandId}/{occurrenceId}/{sha256}.png`, with a 30-day lifecycle, and records the digest on the binding.
- The Broker operation's args are only `(item, sha256, captureSequence)`. Broker reads the staged bytes, checks the digest, writes the immutable object and publishes.
- A retry or recovery uses the staged bytes and never renders again, so a second render can't produce `args-mismatch`.

**Compatibility with the fixed path.** The console reads `thumbnails/{item}.png` directly. Until it reads the pointer (D3), Broker also writes that mirror after a successful publish, guarded by a GCS generation precondition held on the pointer, so a slower older capture can't overwrite it.
- The mirror is dropped once the console has moved and the D3 inventory shows no other readers.
- *Alternative:* have the console read the pointer before activation, and never write the mirror. That's simpler, but it couples activation to a console release.

**The command's own artifact** (the head's answer `{ url, item }`) keys on `[uid, taskId, scopeKey]` (decision 1), with `ownerUid` = the caller.
- The answer's `url` is the immutable object's URL, so it never needs a cache-busting parameter.

**`snap` stops being cacheable** under commands: L0013 overrides `cacheable` to false for a snap stage. Each command captures; the D2 bridge gives each legacy compile a fresh key. That fixes today's accidental "cached snap does nothing".

## 3. C5a, in detail

C5a ships the authorization model, released and **inert**. Nothing can allocate a connectionless or item-scoped command until the api's `COMMANDS_L0013` turns on in C5d. Every L0176 path must stay byte for byte unchanged.

### Slices

1. **Registry and contract types** (`packages/common`).
   - `FunctionSpec.credential`, `.scope` and `.publicCapture`, with their docs; `OPERATIONS["gcs.put-thumbnail"]`; `PROTECTED_FUNCTIONS["0013"].snap`.
   - `isOperationAllowed` takes the backend from the credential.
   - `REGISTRY_VERSION` 9, with `REGISTRY_WINDOW` `[8]`, so both are accepted.
   - The `Plan` type: optional `connectionId`, plus `scopes`.
   - `scripts/check-registry-version.js` checks L0013's Rust constant.
   - Tests:
     - `manage.ts`'s backends exclude `gcs`, and `snap` isn't grantable;
     - an L0176 plan digest is unchanged;
     - `isOperationAllowed` for `snap` passes only with backend `gcs` and fails for a connection backend.
2. **Broker** (`packages/broker`).
   - Token profiles with the exactly-one rule (decisions 5, 6).
   - The service-credential branch; `credential-scope-mismatch`; the `args.item === scp.id` check; the receipt binding scope key.
   - The `gcs` operations module, wired in `main.ts`, is unreachable without a v3 token and not yet configured with a bucket.
   - Reconcile for service operations.
   - Tests:
     - a service operation with `conn` is refused;
     - a connection operation with `scp` is refused;
     - a service operation whose `args.item` differs from `scp.id` is refused before the claim;
     - an L0176 execution token from the current Policy is still accepted unchanged;
     - with a fake GCS, a capture writes the immutable object and publishes, an older sequence completes `superseded: true` and leaves the pointer, and a retry with the same operation id answers from its receipt with no write.
3. **Policy** (`packages/policy`).
   - Scopes on the plan, the invocation key and the occurrence binding (decision 1).
   - Connection-optional allocation and admission, authorizing each static scope by kind: a connection by `accessFor`/`mayUse` as today, an item by the item-authority client (decision 3).
   - Bound item scopes are authorized at bind. Each scope is re-checked in `liveRefusal` at mint and at authorize-execution.
   - Provenance `anonymous`, only for public-capture item scopes reached through the bridge.
   - The rate limit; `item-captures/{item}`; `reserve` (the capture sequence).
   - Audit: nullable `connectionId`, plus `itemId`, `publicCapture` and the new provenance.
   - `CALLERS` for `l0013r-run`.
   - Tests:
     - each scope authorized at admission;
     - a mixed chain (snap then L0176 save) admitted with one invocation and two scopes, each operation minted only under its own;
     - a private item captured by a non-owner is refused at allocation;
     - an owner's capture is refused at authorize-execution after the item is moved to another owner or deleted;
     - a public item is captured by a signed-in non-owner and by `anonymous`, rate-limited at the 13th within the hour;
     - `item-authority-unavailable` doesn't allow;
     - a bound item scope from data is authorized at bind and refused there for a private item the caller doesn't own;
     - every existing L0176 command, repair and reconcile test passes unchanged.
4. **Console route** (graffiticode-app): `POST /api/internal/item-authority`, accepting only `policy-run`'s ID token. Tests:
   - another account's token, or none, is refused 403;
   - an unknown item answers `exists: false`;
   - an id present under two owners answers `ambiguous`.

### Order of release (C5a)

Each step is inert until the next step that uses it.

1. **Decision 0:** the `l0013r` fix, released on its own.
2. **Common,** shipped inside the releases below.
3. **The console route,** deployed and called by nothing yet.
4. **Broker:** it accepts v3 tokens and window `[8, 9]`. No Policy issues either yet.
5. **Policy:** it accepts both versions, issues `cv: 3` only for a connectionless plan, and no api asks for one yet. Its item-authority client points at the console route.
6. **Compilers report registry version 9** (P1b's "compilers" step): `l0176r` and `l0013r` releases with the constant changed and nothing else. The window still accepts 8, so plans admitted on 8 replay.
7. **The api's `REGISTRY_VERSION` 9,** with `COMMANDS_L0013` absent, so nothing changes for L0013 traffic.
8. **Later, after a soak:** contract the window to `[9]` (P1b's "contract" step), recorded with its date.

### IAM changes for C5a

Each is recorded in `docs/capability-policy-iam-review.md` as a new step.
- `policy-run` gains the ability to call the console's item-authority route. The route checks the token's email itself, and no IAM role is needed unless the app's ingress requires one; read the app's hosting before granting anything.
- `l0013r-run` gains `run.invoker` on `policy` and `broker`, plus their hosts in `compilers-l0013`'s `network.allow`. That is one proxy rollout, verified with `verify-rollout.js`.
- **Nothing on the bucket changes in C5a.** Broker's write grant comes with C5b (§5).

### Rollback (C5a)

- **Every C5a release is inert,** so each can be rolled back by its own release receipt to the previous revision. This holds until a v3 plan or item-scoped command exists, and none can exist before C5d's activation.
- **After activation,** Policy and Broker can't go below their scope-capable releases. That's the same floor rule as D2b: the deploy tool refuses `rollback --release` for `policy` and `broker` below the first scope-capable release once any v3 invocation exists.
- **The registry window** keeps 8 accepted until the contract step. So rolling the compilers back to an rv 8 revision during the soak is safe.

### C5a completion gate

All four slices are merged and released in the order above, and the following hold:
- **L0176 is unchanged.**
  - The production canary passes with its full staged set (36 checks, against Policy and Broker at the C5a releases).
  - The B6 repair round-trip (`docs/evidence/b6-repair-activation/roundtrip.mjs`) passes against them.
  - An L0176 plan digest computed before and after the change is identical.
- **The authorization tests pass,** run against the released Policy and Broker with a test-only operation: the slice 3 tests, plus the slice 2 mismatch tests.
  - The live run uses `gcs.put-thumbnail` against a **drive bucket**, not the thumbnails bucket. It runs as the canary account, on a canary-owned private item and a canary-owned public item. Before running, the canary-owned items must be listed as an owner-approved fixture.
- **The console route** refuses any caller but `policy-run`, checked live.
- **The proxy** allows `l0013r` to reach Policy and Broker, and nothing else new (`verify-rollout.js` and the AT-11 probe).
- **The evidence** is an evidence README under `docs/evidence/c5a-authorization/`, with the release ids and the test outputs.

## 4. C5b–C5e, in outline

Each gets its own detailed slices after C5a's review.

- **C5b Upload and publish.** The `gcs` operations configured with the thumbnails bucket. The pointer and capture sequence (decision 8). The mirror. **IAM:** `broker-run` gains write on `graffiticode.appspot.com`, conditioned to `objects/thumbnails/` (role per the bucket's ACL mode: `objectCreator` if uniform, or `objectAdmin` if publicRead ACLs need `setIamPolicy`; read live first). The staging bucket, with `policy-run` as creator and `broker-run` as viewer.
- **C5c IAM handoff.**
  - Both `l0013-run` and `l0013r-run` keep direct write until D4.
  - At D4, both lose it in the same release, and a check confirms that neither can write the bucket (`gcloud storage buckets get-iam-policy` and a denied test write).
  - This step finally retires `l0013-run`'s grant; its live role is read first, given the IAM review's two versions.
- **C5d The snapshot as a command.**
  - An L0013 interpreter declaration and model (Track C), plus `reserve`, staging, and snap through `ExecContext::invoke` in a command session. With no session, the legacy upload is unchanged until D4.
  - `INTERPRETER_L0013`, `COMMANDS_L0013` and a new `COMPILE_GENERATION_L0013`, together.
  - A staged drive and canary checks for snapshots: a capture of a canary-owned item, an out-of-order pair, an abandoned capture, and a private-item refusal.
  - Repair and `materializes()` for L0013 stay out of scope (B6 noted it as next). A failed snap is simply captured again.
- **C5e Bridge.**
  - With `COMMANDS_L0013` on, a legacy L0013 compile reaching `snap` becomes a command with a fresh key, including anonymous (decision 4), returned in today's envelope. The bridge condition changes from "has a connection" to "has a connection, or the chain has an item-scoped write and its language's commands are on".
  - D3 moves the console to `POST /command` with a stable key and to reading the pointer.
  - D4 (bridge off, both accounts lose write) waits for the public-exception decision.

**Order across C5:** decision 0 → C5a → C5b → C5c's Broker grant → C5d staged drive → C5d activation → C5e/D3 → the exception decision → D4.

## 5. Completion gate for C5

The master plan's C5 tests, all passing, the last after D4:
1. the first capture publishes;
2. an older capture finishing after a newer one leaves the pointer on the newer;
3. an abandoned capture doesn't block the next;
4. a private item by a non-owner is refused at allocation, and at execution after access is revoked;
5. a public item without an owner token succeeds, rate-limited and recorded;
6. a chain capturing two items, and one mixing a snapshot with an L0176 save, is one invocation with a scope per intent, and a mismatched credential or scope is refused;
7. a service operation carrying a connection is refused;
8. after D4, neither `l0013-run` nor `l0013r-run` can write the bucket.

Also:
- the `task` override test (decision 0);
- the production canary gains snapshot checks;
- L0176's canary and repair round-trip are unchanged at every step.

## 6. Out of scope

- Repair and materialization for L0013.
- Ending the public-capture exception (a separate, announced decision).
- Moving thumbnails out of the App Engine default bucket.
- An anonymous `POST /command`.

## 7. Risks

- **The console becomes a dependency of Policy for item scopes.** If the console is down, item captures are refused temporarily; L0176 is unaffected.
- **Registry 9 needs an `l0176r` release.** It's a constant-only change, but it touches the C6/B6 language. It follows P1b with the window open, and the staged canary and repair round-trip gate it.
- **Narrowing to owners** could break a caller the inventory hasn't seen. The bridge's per-request audit (provenance, `publicCapture`, refusals) shows it after activation, before D4.
- **`publicRead` on new objects** depends on the bucket's ACL mode. If the bucket is uniform, objects are public through bucket IAM and `predefinedAcl` is refused, so read it first.
