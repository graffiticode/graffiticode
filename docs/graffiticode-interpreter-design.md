# Graffiticode Interpreter Pass: Architecture Design

**Status:** Design proposal / discussion summary  
**Date:** 2026-10-28

## 1. Executive summary

Graffiticode should restore a first-class **interpreter pass** after compilation. Compilation becomes a pure, deterministic transformation from a task's code to an immutable model; interpretation supplies the current result consumed by a form and, when explicitly requested, coordinates side effects or durable workflows.

The proposed language interface is:

```text
Code --POST /compile--> Model --POST /interpret--> Result --/form--> Experience
```

`POST /interpret` is a **universal language contract** whose default is the **identity interpreter**. The platform supplies that default, and the protected registry declares which languages override it (§11). Languages override it only when they need dynamic behavior. For identity languages, the API skips the HTTP call.

Much of this already exists in another form: L0176's READ-01 read stage, `POST /preview/sign`, the form's refresh before expiry, and the policy/broker effect machinery (§2). This design formalizes and generalizes those pieces. Durable workflows are kept in the contract as reserved operations, and their design is deferred (§12).

The design supports four combinations of state and result validity: immutable/indefinite, immutable/expiring, mutable/indefinite, and mutable/expiring. A durable workflow can update its result when state changes **and** refresh expiring presentation credentials without restarting or advancing the workflow.

The central rule is: **Reading or refreshing a form must never unintentionally repeat a business operation.**

## 2. Existing Graffiticode abstractions

- **Item:** Persistent design-time repository of task commits, not itself a runtime business transaction.
- **Task:** `(lang, code)`; task identity/code hash can support compilation caching.
- **Compiler:** Language-selected transformation of code into a model.
- **Model:** `(lang, data)`, the immutable output of compilation.
- **Form:** Browser-facing, language-specific runtime consuming the current result; not merely a static viewer.
- **Broker/grants and egress proxy:** Mediate capabilities and enforce access to external services.

Historically, external side effects in Graffiticode have occurred during **compilation**. This proposal changes that behavior: compilers should become pure and side effects should move to interpretation/execution. Existing caching of compiled models remains useful; dynamic state should no longer require appending upstream state objects to tasks and recompiling.

The renderer pass is the conceptual predecessor of the proposed interpreter pass. It still exists in the Node core, but it does almost nothing (see below).

### What already exists

Several pieces of the interpreter pass exist today under other names. This design should formalize them rather than build them a second time.

| Existing mechanism | Where | Interpreter concept |
| --- | --- | --- |
| A `Renderer` stage. It is pluggable via `config.Renderer`, but it runs *inside* `Compiler.compile`, so its output is part of the compiled (and cached) result. The default normalizes internal records and `Decimal` values to plain JSON. That step is required: without it `{"answer":42}` serializes as `{"_type":"record","_entries":{}}`. No language overrides it. | `languages/l0000/packages/core/src/compiler.ts:2233`, `:2278`, `:2399` | Not the interpreter. Deterministic JSON normalization, which stays in compilation |
| The READ-01 read stage. It re-signs a stored L0176 artifact with a fixed data-only program, never runs the source, and may use only the view-safe functions under `stage: "read"`. | `packages/api/src/read.js`; enforced at `packages/policy/src/policy.ts:387,600` and `packages/broker/src/broker.ts:143` | `interpret(get)` for a saved item |
| `POST /preview/sign`. It is stateless and `no-store`, and re-signs a preview activity through the system preview session. | `packages/api/src/routes/preview.js` | `interpret(get)` for a preview |
| The form refreshes on its own. The L0176 form treats a request as stale 60 s before its `expires` and re-signs through `/preview/sign`. | `languages/l0176/packages/view/src/components/form/expiry.ts`, `sign.ts` | Refresh on expiry, driven by the consumer |
| `cache: false` in the compile envelope. It makes the whole chain uncacheable. | `packages/api/src/data.js:240-244`, `:367-372` | A crude, boolean `expiresAt` |
| Policy invocations, operation ids `invocation/stage/occurrence`, broker write receipts, `jti` claims, and authorize-execution before each step. | `packages/policy/src/policy.ts:1-41`, `packages/broker/src/broker.ts:1-52` | Idempotent, re-authorized effects for `start`/`dispatch` |
| `degrades_without_connection`, and L0176's unsigned `signing: {unsigned, message}` output. | `languages/l0000/crates/core/src/dialect.rs:105` | A declared, visible degraded result (see §10) |

### How routes reach languages today

- **Rust.** Every dialect server is `l0000r_server::serve(dialect, lexicon)`, which serves `app()` from `languages/l0000/crates/server/src/lib.rs:63` through a Cargo path dependency. A route added there appears in every `lNNNNr` service once it is rebuilt. The `Dialect` trait has no render or interpret hook yet.
- **Node, which production runs.** Each language's `packages/api` builds its own Express app. Only helpers are shared from the published `@graffiticode/l0000` core (preflight handler, gateway verifier, egress), never routes, and the per-language apps have drifted apart (l0184 has no `/preflight`, for example). **A route added to L0000's Node server reaches no other language.**

### What happens at compile time today

- **L0176** signs every output during compile (`signForRender`, `languages/l0176/packages/core/src/compiler.ts:134`). It writes to the item bank during compile, but only for an explicit `save-to-itembank <activity>`, which goes through policy and the broker.
- **L0185** fetches URLs during compile, with an in-process 60 s cache (`languages/l0185/crates/core/src/fetch.rs`). So a given task id does not always produce the same data.
- **L0013** `snap` renders in headless Chrome and uploads a PNG to GCS during compile. The object path is fixed per item (`thumbnails/{item}.png`, `languages/l0013/packages/core/src/snap.ts:319`) and is overwritten on every snap. The content hash is only a cache-busting query parameter on the returned URL (`:486`). So repeated captures can produce different bytes, and an older capture can overwrite a newer one.
- **Other nondeterminism**, with no external effect:
  - L0176 stamps dynamic-content tables with a timestamp reference (`"graffiticode-" + new Date().toISOString()…`, `languages/l0176/packages/core/src/items.ts:64`).
  - L0182 draws survey versions at random and records the draws in process-local state during compile (`languages/l0182/packages/core/src/source.ts:123`).
  - L0176's `init <activity>` operator signs during compile, separately from `signForRender`.

  Removing the effects above does not make these compilers deterministic.

## 3. Goals and non-goals

### Goals

1. Preserve immutable, reusable, cacheable compiled models.
2. Support static languages without requiring custom interpreter code.
3. Support time-limited presentation resources, such as signed Learnosity requests and document URLs.
4. Support durable, event-driven workflow/saga execution with stable form URLs.
5. Allow workflow state changes to update or invalidate the API's cached result.
6. Keep read/refresh operations distinct from state-advancing operations.
7. Keep language-specific semantics in language implementations, not in the generic API.
8. Respect tenant, identity, grants, and authorization boundaries in all caches and effects.

### Non-goals

- Recompiling a task on each workflow transition or token refresh.
- Treating the API result cache as the authoritative store for durable workflows.
- Automatically starting business transactions on a form GET.
- Requiring every language to implement a nontrivial interpreter.
- Choosing a particular durable workflow engine in this design.

## 4. Universal language endpoint

### Recommendation: `POST /interpret`

Use `/interpret`, not `/execute`, as the language endpoint. *Interpret* names the general abstraction: it may return an identity result, refresh a signed representation, or handle explicit execution operations. *Execute* would be misleading for read-only projection.

| Endpoint | Language contract | Purpose |
| --- | --- | --- |
| `POST /compile` | Required | Purely transform code into an immutable model |
| `POST /interpret` | Universal, with L0000 default | Interpret model under an explicit operation and return a result |
| `/form/:id` | Platform/browser-facing route | Deliver the current form-facing result |

### L0000 default

L0000 provides identity semantics for `operation: "get"`:

```ts
function interpret({ model, operation }: InterpretRequest): InterpretResult {
  if (operation === "get") return { data: model };
  throw new UnsupportedOperationError(operation);
}
```

A language can override `/interpret` to provide more capabilities. The API may skip the network call for a language that declares the identity implementation, but the **contract stays the same for every language**. As §2 shows, a route added to L0000's Node server would not reach any production language. The identity default therefore has to come from the platform (§11).

**Failure behavior:** If a language declares a non-identity interpreter and that interpreter fails, return an error. Do not silently substitute the compiled model. A *declared, visible degraded result* is different from a fallback and is allowed: L0176 without a connection returns an unsigned preview marked `signing: {unsigned, message}`. The language chooses that result and labels it in the result itself. The platform never substitutes it.

## 5. Interpreter operation contract

A single endpoint can be operation-aware:

```ts
type InterpretOperation = "get" | "start" | "dispatch";

interface InterpretRequest {
  model: unknown;
  operation: InterpretOperation;
  executionId?: string;
  event?: unknown;
  context?: {
    tenantId?: string;
    principalId?: string;
    authorization?: unknown;
    idempotencyKey?: string;
  };
}

interface InterpretResult {
  data: unknown;
  executionId?: string;
  stateVersion?: number | string;
  expiresAt?: string;
}
```

These types are **illustrative**, not a finalized wire schema. In particular, the platform should define whether the interpreter receives a full model, a model reference, or both; how authorization is conveyed; and the schema for `event`.

- **`get`:** Read or regenerate the form-facing projection. May refresh expiring presentation resources. Must not initiate or advance a business transaction.
- **`start`:** Explicitly initiate an execution, including authorized side effects. Return or identify the execution.
- **`dispatch`:** Explicitly deliver an event/command to an existing execution, such as an approval or cancellation. Validate permissions and idempotency.

The `get` operation may perform a narrowly scoped, repeatable signing action, but it should not mutate authoritative business workflow state. Treat `start` and `dispatch` as commands, not reads.

For long-running workflows, `/interpret` need not block until completion: `start` may return an `executionId` and initial state while the workflow engine proceeds asynchronously.

### Mapping onto policy and the broker

The operations reuse the capability machinery that already exists, rather than adding a second effect path:

- **`get`** runs as policy stage `read`. It may call only the language's view-safe functions (`viewSafeFunctionsForLang`), it needs no execution plan, and it never runs program source. This is exactly the READ-01 rule.
- **`start`** (and, later, `dispatch`) runs under a policy invocation. Each command is a stage, so every external effect is a broker operation with id `invocation/stage/occurrence`.
- **No direct writes.** An interpreter never calls an external write API directly. Every protected effect goes through the broker, which asks policy to authorize the execution before each step and never caches that answer.

### Immediate commands

`start` is needed now, for L0176 item-bank saves and L0013 snapshots (Phase 3). That is an **immediate command**: one invocation, a bounded run, and a persisted outcome. Durable workflow orchestration is something else and stays deferred (§12): long-lived executions, `dispatch`, state versions, and published projections. Nothing below depends on it.

Broker receipts deduplicate *external writes*: one receipt per operation id. They do not deduplicate the command itself. So a command has its own identity, inputs and lifecycle.

**Identity.**
- A command is identified by `(uid, idempotencyKey)`, and the caller must supply the key. Policy already supports this: `allocate` reuses an invocation for a known key and refuses the key if the binding differs (`packages/policy/src/invocations.ts:57`).
- Without a key, every request allocates a new invocation, which is today's behavior. So **`start` requires an idempotency key**; a command without one is refused, not run.
- The key is bound to the command's input: the existing `connectionId`, `taskId` and `inputDigest`, plus the model digest. Reusing a key with a different binding is a conflict, not a replay.

**Pinned inputs.**
- A command may resolve data before it acts. An example is a head interpreter that fetches what an L0185 stage describes and then saves it.
- A retry that re-resolved could get different data. It would then present the same broker operation id with different arguments, and the broker refuses that as `operation-id-reused` (`packages/broker/src/broker.ts:429`).
- So before its first effect, a command persists, in its command record:
  - the resolved inputs, or a snapshot of them with its digest;
  - the model digest;
  - the implementation revisions it ran under (compiler, interpreter, `REGISTRY_VERSION`).
- Every retry and every recovery reuses that snapshot and never fetches the data again. A retry that can't load it fails rather than fetching afresh.

**Effect intents come from the model.**
- Today L0176's save plans exist only in a WeakMap tied to one compile (`languages/l0176/packages/core/src/compiler.ts:77`). That is how `save-to-itembank` can save only an activity built by the same compile.
- Once compilation and `start` are separate requests, that guarantee has to live in the model. The compiled model carries **validated effect intents**, each with a **stable occurrence id**.
- `start` executes only intents found in the model whose digest it is bound to. The occurrence ids give the broker operation ids (`invocation/stage/occurrence`), so they must not change between attempts.

**Provenance and admission are separate.**
- **Model provenance** describes the model and nothing else: language, task id, model digest, compiler revision, `REGISTRY_VERSION`. Because it names no caller, the model can be reused across callers and invocations.
- **Command admission** is today's admission: bound to one invocation, user, connection, stage and revision (`packages/policy/src/tokens.ts`). It also binds, with authentication, the digest of the model it admits.
- A command runs only when its admission's model digest matches the model it was handed.

**Lifecycle.**
- **`pending`:** claimed and not yet finished. The command record and its key are claimed atomically, before any effect, the same way the broker claims a receipt.
  - A concurrent duplicate gets `pending` with the command id, and polls. It never blocks indefinitely.
  - The claim carries a **lease**. If the process dies, the lease expires, and a **recovery owner** takes the command over: the next retry with the same key, or a reconciler.
  - Taking over is safe because the pinned inputs and stable occurrence ids lead it to the same broker receipts. Writes that already happened are replayed from the receipts, not repeated.
- **Terminal outcomes**, mapped from the broker's:
  - `completed`: every step succeeded. Carries the recorded result.
  - `failed`: definitely nothing was written (the broker's `failed`, `packages/broker/src/broker.ts:464`). It is safe to try again with a new key.
  - `partial`: some steps completed. The broker persists each one (`receipts/{id}/steps/{n}`), and the outcome lists which.
  - `uncertain`: the broker could not tell whether a write was applied (`packages/broker/src/broker.ts:14-25`).
- **A retry returns the recorded outcome**, and never upgrades `partial` or `uncertain` to `completed`. Resolving either one is an explicit act: reconcile against the provider, or start a new command with a new key.

**Command outcomes are not artifacts.**
- A command's outcome is stored in its command record.
- Only a `completed` outcome that produces a usable result replaces the **artifact** that connection and publication views read (§8).
- A `failed`, `partial` or `uncertain` command leaves the current artifact in place.

### Pipelines

Tasks compose into chains (`id0+id1+id2`) that compile right to left; each stage's output is the next stage's input `data` (`packages/api/src/data.js:318`).

**Only the head is interpreted, and the head's interpreter interprets the whole model.**
- Each stage below the head passes its compiled *model* to the stage on its left, never an interpreted result.
- Upstream stages therefore stay pure and remain cached by task id, as today.
- Whatever an upstream stage contributes is part of the model the head receives. That includes things that need interpreting, such as a fetch an L0185 stage describes. Interpreting it is the head interpreter's job.
- A language whose `get` should honor such contributions must understand them, for example by applying the same fetch semantics. The platform does not interpret intermediate stages on the head's behalf.
- The composed result's `cache` class and `expiresAt` are the head interpreter's to set (§7).

**Existing exception:** when every task is L0158, the form is served as L0176 (`RENDER_LANG` in `packages/api/src/routes/form.js:14`). The head model is interpreted by another language. That language-selection rule should move into the interpreter declaration (§11) instead of staying hard-coded in the form route.

## 6. Interpreter behavior is compositional, not a fixed enum

The early shorthand distinguished **identity**, **immediate**, and **durable** interpreters. The hybrid example shows that these are not mutually exclusive classes. Two independent properties better describe the result:

| State | Indefinite projection | Expiring projection |
| --- | --- | --- |
| Immutable | Static chart or spreadsheet | Learnosity preview with expiring signature |
| Mutable | Workflow status display | Workflow status with expiring signed resources |

The same durable workflow may publish state-change updates and periodically need a fresh form-facing projection.

### Identity

`get` returns the model unchanged. There is no independent execution state and no interpreter call is needed in the optimized API path. `start` and `dispatch` are unsupported unless overridden.

### Immediate projection

An interpreter computes a result, such as a signed Learnosity preview request or freshly fetched L0185 data. When the result expires, the consumer calls `get` again **without recompiling**.

Whether the result may be cached depends on what it contains:
- A result **with bearer credentials** (signatures, signed URLs, tokens) is never cached server-side. This is an existing rule: "Responses carrying signed authority are not cacheable" (`docs/graffiticode_capability_policy_spec.md:347`).
- An **unsigned, viewer-independent** result, such as L0185's fetched data, may be cached until its `expiresAt`.

### Durable execution

An explicit `start` creates an execution. A workflow engine maintains authoritative durable state, handles timers/events/approvals, and performs authorized effects. It publishes a new projection or invalidation on state changes. `get` reads the current state/projection and may refresh expiring resources, but does not advance the workflow.

### Hybrid durable + expiring

Example: a claim workflow is waiting for approval. The durable state contains a document ID, while the form needs a signed document URL valid for ten minutes. The workflow's state version remains unchanged as the URL expires. `get` reinterprets the *current* state to produce a new signed URL; the workflow is not restarted or advanced.

## 7. State, projection, and caching

Separate three things:

1. **Compiled model cache:** Immutable model keyed by task/code identity and relevant compiler version/configuration.
2. **Authoritative execution store:** Durable state and event history, owned by the workflow/interpreter infrastructure.
3. **API result cache:** Current **materialized form-facing projection**, potentially expiring, owned by the platform for efficient delivery.

The API result cache is not the source of truth for a durable saga. It can be rebuilt from authoritative state after eviction or failure.

### Two invalidation mechanisms

A cached projection is valid only if **both** conditions hold:

```text
projection.stateVersion == currentExecution.stateVersion
AND
now < projection.expiresAt  (if an expiration exists)
```

- **State change:** The workflow interpreter publishes a replacement projection or invalidation to the API.
- **Time expiration:** The API invokes `interpret(get)` against current execution state to refresh the projection.

A state-change event may race with a token refresh. The API must avoid publishing a projection generated from an obsolete state version.

### Publish versus invalidate

- **Invalidate:** On workflow transition, remove cached projection; next read invokes `get`.
- **Publish/update (preferred):** On transition, interpreter sends a new projection to the API. Reads are fast and subscribers can receive updates immediately.

Publishing requires reliable delivery or reconciliation and **monotonic version checks**. An update with an older version must not overwrite a newer result. Invalidating remains a useful fallback, especially when the interpreter cannot cheaply produce a complete projection at transition time.

### Cache classification and expiry

Expiry and cacheability are different properties. A signed Learnosity request and a public L0185 fetch can expire at the same moment and still need opposite storage policies. So a result carries both:

- **`cache`** says where the result may be stored. It is one of these classes:

  | `cache` | Meaning | API compile cache (Firestore `compiles/`) | `Cache-Control` (browser / CDN) |
  | --- | --- | --- | --- |
  | `immutable` | A function of the task ids alone | Stored | `<visibility>, max-age=31536000, immutable` (today's default) |
  | `shared` | Viewer-independent, holds no credentials, valid until `expiresAt` | Stored, keyed as below, until `expiresAt` | `<visibility>, max-age=<seconds to expiresAt>` |
  | `private` | Depends on the viewer or connection, holds no bearer credentials | Not stored | `private, no-store` |
  | `no-store` | Holds bearer credentials (signatures, signed URLs, tokens) | Not stored | `no-store`, today's `setNoStoreCacheHeaders` |

- **`expiresAt`** says when a consumer must call `get` again. It never widens the class: a `no-store` result with a ten-minute `expiresAt` is still never stored.
- **Visibility** is a third, independent property, and it comes from the *request*, not the result.
  - A private task can produce viewer-independent data that still requires authorization to read.
  - So `shared` means "the same for every *authorized* viewer". It does not mean public.
  - `<visibility>` in the table is `public` only for an anonymous read. That can return only public tasks, because private ones throw NotFound. Every authenticated read is `private` (`packages/api/src/routes/data.js:110`, as today).
  - Likewise, a stored `shared` entry is read only through the same task-visibility check as a compile cache read.

**The classification is trusted, not asserted.**
- The language's declaration in the protected registry (§11) sets the *least restrictive* class each language may return.
- The API applies the stricter of that declaration and what the result envelope says.
- The existing rules still apply on top: protected or connection chains (`packages/api/src/data.js:231-244`) are at least `private`.
- So a compromised or buggy language server cannot turn a signed result into a cached one.
- The boolean `cache: false` envelope field maps to `no-store` until languages move to the classification.

For a `shared` result, the cache key must cover more than the model hash. Where they apply, it includes the execution ID, state version, and interpreter/configuration version.

`expiresAt` from the interpreter should be authoritative for the projection's lifetime, subject to platform safety margins and security limits. Language-level TTL defaults and task-level overrides are possible future conveniences, but neither should extend a resource beyond its actual expiry. Task cache policy should be metadata rather than changes to program code where possible.

**Do not conflate TTL with durable workflow retention.** A result may expire while execution state remains indefinitely or according to a separate retention policy.

## 8. Form and API behavior

**Today's flow.** `/form` does not compile or build a result. It resolves the head task's language, builds a `/data?id=…` URL, and **redirects** to the language server's own `/form?url=<that /data URL>` (`packages/api/src/routes/form.js:52-92`). The language's form then fetches `/data` itself.

What `/data` returns depends on how the item is viewed:

- **Plain view.** The compiled result.
- **Through a connection.** The recipient's own current private **artifact**, the stored result of an earlier run, re-signed under a `read` invocation (`buildReadArtifact`, `packages/api/src/read.js:52`). The source is never run.
- **Through a publication.** The artifact the publication **pins**, read under the *publication's* authority rather than the viewer's (`buildReadPublished`, `packages/api/src/read.js:90`).
- **When the artifact is missing or incompatible** (made under another `REGISTRY_VERSION`), the view fails with a specific reason (`artifact-not-found`, `published-artifact-unavailable`, `artifact-incompatible`). It does not run the program. Getting a result needs an explicit run or republish.

**L0176's refresh today is narrower than "refresh before expiry"** (`languages/l0176/packages/view/src/components/form/Form.tsx:85-120`):

- Staleness is checked **once per content, before Learnosity is initialized** (60 s before `expires`, `expiry.ts`).
- An assessment that is already initialized keeps running past `expires`. It is never re-signed or re-initialized because time passed, so the learner's answers are never lost.
- A stale **questions** activity is re-signed through `POST /preview/sign`, under the system preview session.
- A stale **items** activity is *not* re-signed. It can load bank items the system consumer can't see, so it is reported as expired instead.

**Proposed flow.** Keep the redirect. `GET /data` is where the API runs `interpret(get)` on the head model, and an identity language skips that call. These rules carry over unchanged:

- **Artifacts and publications survive interpretation.** For a connection or publication view, `get` interprets the selected **artifact**, not a fresh compile of the model. It keeps the existing selection, the authority (the recipient's, or the publication's), and the failure reasons. A missing or incompatible artifact still requires an explicit `start` (run) or republish, never an implicit one. An artifact *is* the persisted result of a run (see Phase 3).
- **Refresh preserves the user's state.** A refresh replaces only the presentation parts of a result (signatures, URLs). A consumer refreshes only before it has initialized the content or while it is idle. It never re-initializes content the user is working in, and never discards their input.
- **Refresh keeps its original authority.** A refreshing `get` runs under the same authority as the result it replaces: the same connection, the same publication, or the system preview session for content that session originally signed. When that authority can't produce a valid result (L0176's bank-backed items), the consumer reports expiry. It never re-signs under a different identity.

Within those rules, refresh becomes general. A result with `expiresAt` tells the consumer when to ask for a fresh `get`, through `/data` or a dedicated refresh route, and `/preview/sign` becomes one case of that mechanism.

Durable executions (deferred, see §12): a stable `/form/:itemId` URL resolves the task/model and the current execution, if any. If several executions exist for the same model, the platform needs a selection rule or an explicit selector such as `/form/:id?execution=...`.

Conceptual read path for `/data` once durable executions exist:

```ts
async function getFormResult(itemId, executionId, viewer) {
  const model = await resolveCompiledModel(itemId);
  const execution = await resolveExecution(model, executionId);
  const key = resultCacheKey(model, execution, viewer);

  if (isIdentityInterpreter(model.lang)) return model;

  const cached = await resultCache.get(key);
  if (cached && isCurrentAndUnexpired(cached, execution)) return cached.data;

  const fresh = await interpret(model.lang, {
    operation: "get",
    model,
    executionId: execution?.id,
    context: contextFor(viewer)
  });
  await resultCache.putIfCurrent(key, fresh);
  return fresh.data;
}
```

This is conceptual pseudocode. `resultCache` holds only results that may be cached (see §7). A credential-bearing result skips both the lookup and the `put`. In a distributed system, the API must ensure it knows the current execution version (or uses an equivalent versioned cache protocol); merely trusting a stale local version would make the validity test unreliable.

The form can receive updates through SSE, WebSockets, or polling. Reading a result and subscribing to updates are separate from `start` and `dispatch`. Local ephemeral UI state (hover, open menu, etc.) remains in the browser.

## 9. Execution and workflow lifecycle

1. An agent or human creates/updates a Graffiticode item/task.
2. The language compiler produces a pure, immutable model, cached by task identity/hash.
3. An authorized caller explicitly requests `interpret(start)` when the model represents a business execution.
4. The interpreter/workflow engine creates an execution ID and persists authoritative state.
5. Workflow transitions occur due to timers, external responses, approvals, or explicit `dispatch` commands.
6. Each state change publishes a versioned result or cache invalidation to the API.
7. `/form/:id` reads the latest cached result and subscribes to changes.
8. If presentation data expires, the API calls `interpret(get)` to regenerate the projection without restarting the execution or recompiling the model.

A workflow engine such as Temporal could implement durable orchestration behind a language interpreter; it is an implementation choice, not part of the generic language contract. The compiled model may describe steps, dependencies, approvals, compensation, and allowed effects.

## 10. Security and correctness requirements

- **Explicit effect boundary:** Form GET and `interpret(get)` must not trigger business transactions. Side effects require explicit authorized commands.
- **Grants at effect time:** Re-check authorization when a protected effect actually happens, not only at compile time or when a workflow starts. The broker already does this: it asks policy to authorize the execution before every step and never caches the answer. An interpreter's effects must go through it (§5). Revocation behavior still has to be defined for queued effects.
- **Idempotency:** `start` requires an idempotency key bound to its input and model digest, and the command is claimed atomically under a lease, with its inputs pinned (§5, "Immediate commands"). Broker receipts (operation id `invocation/stage/occurrence`, single-use `jti`) deduplicate the external writes inside a command. They do not deduplicate the command itself. Retries return the recorded outcome unchanged.
- **Tenant isolation:** Partition execution state, cache keys, subscriptions, and published updates by tenant and authorized audience.
- **Credential hygiene:** Signed URLs/tokens may be bearer credentials. Apply strict TTLs, avoid unsafe logging, and consider whether results can be shared across viewers.
- **Version ordering:** Use monotonic state versions, compare-and-set updates, and recovery/reconciliation to handle out-of-order or lost publications.
- **Execution identity:** Distinguish multiple runs of the same model; never assume model hash uniquely identifies a business execution.
- **Read consistency:** Define whether a form may briefly show stale state or must perform an authoritative version check for sensitive transitions.
- **Failure behavior:** An outage of a declared interpreter is a visible error, never an identity fallback. A degraded result that the language declares and labels (§4) is allowed. Rebuild evicted projections from durable state.
- **Compensation and audit:** Durable workflows should retain audit trails and explicit compensation semantics for partially completed side effects.

## 11. L0000 inheritance and implementation strategy

There are two ways to make `/interpret` universal:

1. **Language inheritance:** every language server inherits L0000's route and default handler.
2. **Platform fallback:** the API supplies identity for any language that doesn't declare an interpreter.

**Recommendation: platform fallback (2), with the declaration in the protected registry.**

- Inheritance works for the Rust servers, which all serve `l0000r_server::app()`. It does not work for the Node servers, which production runs: each has its own copy of the Express app (§2).
- In practice, then, only the platform fallback reaches every language without editing and redeploying all of them.
- The declaration belongs in `@graffiticode/common/protected-registry`, beside `compilerConfigForLang`. That is already the security-reviewed per-language manifest, and changing it requires a `REGISTRY_VERSION` bump. `language-info.json` is a weaker option, since a language server can change it on its own.
- The API reads the declaration; it never probes for the route at runtime.
- The same declaration should replace today's hard-coded per-language constants that do this job: `RENDER_LANG` (`packages/api/src/routes/form.js:14`) and `CALLER_IDENTITY_LANGS` (`packages/api/src/caller-identity.js:15`).

**Rust parity.**
- Add `/interpret` to `app()` in `languages/l0000/crates/server/src/lib.rs`.
- Add an `interpret` hook to the `Dialect` trait whose default is identity.
- The Rust core has no stage after evaluation today.

**Node.** The `Renderer` stays inside compilation as deterministic JSON normalization (records and `Decimal` to plain JSON). Every model, including identity models and non-head stages, must be serializable without the interpreter. The interpreter is a separate operation applied to the normalized model, never a replacement for the renderer.

For identity languages, `get` returns the model and unsupported operations fail explicitly. For effectful languages, a declared interpreter is mandatory and must never silently fall back to identity.

## 12. Suggested rollout

**Phase 1 — Contract and identity.**
- Finalize the wire envelopes:
  - The **model envelope** carries provenance only: language, task id, model digest, compiler/configuration version, `REGISTRY_VERSION`. It names no caller, invocation or admission, so it is reusable (§5, "Immediate commands").
  - The **result envelope** carries `cache` (§7), `expiresAt`, refresh metadata the consumer can read (which authority to refresh under, and whether a refresh is allowed once the content has started), and, for a command, its outcome (§5).
- Define admission separately from provenance:
  - A `get` accepts a model whose provenance matches the interpreting language and `REGISTRY_VERSION`.
  - A `start` additionally needs a command admission bound to the model's digest.
- Add the interpreter declaration to the protected registry, covering:
  - identity or not;
  - the least restrictive `cache` class;
  - the head-language rule.

  Identity is the default.
- Have the API run `get` on the head of the chain in the shared `getData` logic (§5, §8), and skip the call for identity languages.
- Keep the `Renderer` inside compilation as JSON normalization (§11). The interpreter is a new, separate operation applied to its output.
- Keep the shared View working. Its edit flow posts form state to `POST /compile` (`languages/l0000/packages/view/src/lib/api.ts:48`). That route stores the form state as a data task, *appends* it to the chain (`id+dataId`, `packages/api/src/routes/compile.js:91`), and calls the same `getData` logic `GET /data` uses. So the head interpretation must live in that shared logic, and both routes must return the same interpreted result.
- Add the Rust `Dialect::interpret` hook and the `/interpret` route.
- Existing static languages behave exactly as before.

**Phase 2 — Converge expiring projections.**
- L0176 stops signing in compile and emits unsigned models. This covers both `signForRender` and the `init <activity>` operator. Signing happens only in `get`, which formalizes the READ-01 read stage and `/preview/sign`.
- The `cache` classification replaces `cache: false`: L0176 results are `no-store`.
- The form's refresh before expiry becomes the general mechanism, under the lifecycle and authority rules in §8.
- Update or check the consumers that expect signed `/data` output today: the console, the MCP widget, and the ChatGPT inline L0176 form.

**Phase 3 — Migrate effects and nondeterminism out of compilers.**
- **L0185:** move URL fetches out of compile. The model describes the fetches. The head interpreter performs them: L0185's own `get` when L0185 is the head, or a head language that honors L0185's model (§5). Results are `shared`, and the fetched data expires. A `start` that depends on fetched data pins it (§5).
- **L0013:** a snapshot is a write, so it becomes a `start`, not a `get`. It needs a deliberate write policy first. Either address objects immutably (for example `thumbnails/{item}/{sha}.png`, with the item pointing at the latest one), or make the overwrite conditional on a generation or version precondition so an older capture can never replace a newer one.
- **L0176 `save-to-itembank`:** becomes an immediate `start` command through the broker. It is already an explicit command in the program.
  - The compiled model carries the validated save intent and its stable occurrence id, replacing the per-compile WeakMap (§5).
  - The command's outcome is persisted in its command record.
  - A `completed` save replaces the **artifact** that connection and publication views read (§8). Any other outcome leaves the current artifact in place.
- **L0176 dynamic-content reference:** derive the reference from the content (for example a digest of the table), not from the clock.
- **L0182 version draws:** a draw is per respondent, not per program. The model lists the versions; it doesn't choose one. Assigning a version is the one declared exception to a read-only `get`: an **idempotent get-or-create**.
  - **Declared, not implicit.** The registry declaration names get-or-create for L0182 explicitly. No other language's `get` may write state.
  - **Atomic.** The assignment is created only if absent, in one transaction, keyed by `(survey item id, respondent)`. Concurrent first reads converge on one assignment, and later reads return it. It is stored durably, not in process-local maps, so restarts don't change it.
  - **Stable across revisions.** The key uses the item id, not the task id. A revision keeps the respondent's assignment as long as the assigned version still exists. If a revision removes that version, the respondent is reassigned only if they have submitted no answers.
  - **Frozen on submission.** Once a respondent submits answers, their assignment never changes.
  - **No external effect and no business transaction.** Only the assignment record is written, so it stays a `get` rather than a `start`.
  - **Classified `private`**, since it depends on the respondent.
  - If even balancing across versions isn't required, a stateless draw (a hash of item id and respondent) gives the same stability with no write at all.
- Audit grant enforcement and add observability across compile, interpret and form.

**Deferred — durable executions.**
- Covers long-lived executions and execution IDs, `dispatch`, an authoritative execution store, state versions, state-change publication and invalidation, a versioned result cache, live form updates, and combined durable and expiring results.
- No current language needs these. `dispatch` stays in the contract as a reserved operation, and this part moves to a follow-up design doc once a language needs it.
- Immediate `start` commands (§5) are *not* deferred. Phase 3 needs them, with their invocation ids, pinned inputs and persisted outcomes.
- §6–§9 sketch the direction for that doc.

### Acceptance criteria

Phases 1–3 are done when tests show:

1. **Pipelines.**
   - Only the head is interpreted.
   - Upstream stages pass compiled models and stay cached by task id.
   - The head interpreter receives an L0185 stage's model and honors its fetches, or reports that it doesn't support them. The platform never interprets an intermediate stage.
2. **Commands.**
   - A `start` without an idempotency key is refused.
   - A retry with the same key and input returns the recorded outcome without new external writes.
   - The same key with different input is a conflict.
   - Concurrent duplicates execute once; the second caller sees `pending`, then the outcome.
   - A command that depends on fetched data, whose first attempt loses its response, is retried with the pinned snapshot. It reaches the same broker receipts, not `operation-id-reused`.
   - A process killed after the claim is recovered when its lease expires, without repeating completed writes.
   - `failed`, `partial` and `uncertain` are returned as such on retry, never as `completed`, and none of them replaces the current artifact.
   - `start` runs only intents present in the model its admission's digest names.
3. **Artifacts and publications.**
   - A connection view interprets the recipient's current artifact.
   - A publication view interprets the pinned artifact under the publication's authority, never the viewer's.
   - A missing or incompatible artifact fails with its existing reason and never triggers a run.
4. **Cache headers and storage.**
   - Each class maps to the storage and `Cache-Control` in §7.
   - A language that claims a looser class than its registry declaration is held to the declaration.
   - A `no-store` result never reaches Firestore `compiles/`, the browser cache or the CDN.
   - An authenticated read of a `shared` or `immutable` result is never sent `public`.
5. **Refresh.**
   - A stale result is refreshed before initialization, under its original authority.
   - Content the user is already working in is never re-signed or re-initialized, and their input survives.
   - A result that its original authority can't refresh is reported as expired, never re-signed under another identity.
6. **Determinism and serialization.**
   - Compiling the same task twice yields byte-identical models for every migrated language: L0176, L0185, L0013 and L0182.
   - Every model, including identity and non-head models, is plain JSON with records and `Decimal` values normalized.
7. **L0182 assignment.**
   - Concurrent first reads produce one assignment.
   - Restarts don't change it.
   - A revision that keeps the version keeps the assignment.
   - Submitted answers freeze it.
8. **Compatibility.** The View's edit → `POST /compile` path returns the same interpreted result as `GET /data`, and static languages' output is unchanged.

## 13. Open design questions

Questions that block Phases 1–3:

1. What is the exact schema of the registry declaration (§11, §12 Phase 1), and how is a change to it reviewed?
2. Does the interpreter receive the full model, a model reference, or both? How is authorization conveyed (today: `auth`, `connectionId`, `invocationToken` and `stage` in the compile body)?
3. Is `get | start | dispatch` enough, or should commands go through a dedicated command API while `/interpret` stays the language endpoint?
4. Which refreshes may a `get` do beyond signing through view-safe functions in stage `read`? For example, what limits apply to L0185's fetches (rate, size, egress)?
5. How do per-viewer signed resources work when one item is viewed through several connections?
6. Where is the command record stored (§5), and how are `partial` and `uncertain` outcomes reconciled against the provider?
7. Where does an L0182 respondent's assignment state live, who may read it, and what identifies a respondent who isn't signed in?
8. How does a head language declare which upstream model contributions (such as L0185 fetches) it honors? Is honoring them shared library code or per-language?
9. What is the lease length for a `pending` command, and who is the recovery owner when no retry arrives?

Questions deferred with durable executions:

- How an interpreter publishes updates to the API (callback endpoint, message bus, or shared execution service).
- How the current execution of an item is selected.
- What consistency `/form` guarantees after a transition.
- Whether to publish a full projection or only invalidate.
- Authorization and revocation for queued effects.
- How long execution state is kept.
- How errors and partial failures reach forms and agents.

## 14. Design decisions reached so far

- **Use `/interpret`** as the language endpoint, rather than `/execute`.
- **Make identity the universal default**, so no language author has to write a handler. *(Proposed: the platform supplies it, declared in the protected registry, rather than L0000 route inheritance; see §11.)*
- **Optimize identity away** in the API when safely declared.
- **Keep compilation pure and models immutable** as the target architecture.
- **Distinguish `get` from `start`/`dispatch`** so reading never inadvertently executes a business operation.
- **Treat interpreter behavior as compositional**, not restricted to three exclusive interpreter types.
- **Let interpreters publish or invalidate result-cache entries** on durable state changes; prefer versioned publication when practical.
- **Refresh expiring projections independently of workflow state changes** and without recompilation.
- **Keep authoritative durable state outside the API result cache.**
- *(Proposed)* **Keep cacheability and expiry separate.** A trusted `cache` class (`immutable`, `shared`, `private`, `no-store`), capped by the registry declaration, decides storage and headers. `expiresAt` only tells the consumer when to refresh. Bearer credentials are always `no-store`.
- **Interpret only the head of a pipeline.** Upstream stages pass compiled models, and the head interpreter interprets the whole composed model, including what upstream stages contributed.
- **Keep the `Renderer` in compilation** as deterministic JSON normalization. The interpreter is a separate operation applied after it.
- *(Proposed)* **Treat `start` as an immediate command, implemented now.** It has:
  - a required idempotency key bound to its input and model digest;
  - an atomic claim with a lease and a recovery owner;
  - inputs pinned before its first effect;
  - intents and occurrence ids carried by the model;
  - admission bound to the model digest;
  - `pending`, then `completed`, `failed`, `partial` or `uncertain`, never upgraded on retry.

  Command outcomes are separate from artifacts.
- *(Proposed)* **Separate model provenance from command admission.** Models name no caller and are reusable.
- *(Proposed)* **`shared` is not public.** Cache-Control visibility follows the request (public only for anonymous reads), independently of the cache class.
- *(Proposed)* **L0182's assignment is the one declared get-or-create exception to a read-only `get`.** It is atomic, durable, stable across revisions, and frozen on submission.
- *(Proposed)* **Keep artifact and publication reads.** `get` interprets the selected artifact under the existing authority. A missing artifact never triggers an implicit run.
- *(Proposed)* **Constrain refresh.** Refresh before initialization or while idle, under the original authority, without losing user input.
- *(Proposed)* **Run `get` as policy stage `read`** with view-safe functions only, and send every `start`/`dispatch` effect through the broker under a policy invocation.
- *(Proposed)* **Defer durable executions** to a follow-up doc. `dispatch` stays reserved in the contract.

This document summarizes a proposed architecture, not an assertion that these interfaces or migrations have already been implemented.
