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
| A `Renderer` stage. It is pluggable via `config.Renderer`, but it runs *inside* `Compiler.compile`, so its output is part of the compiled (and cached) result. The default only turns records into plain JSON, and no language overrides it. | `languages/l0000/packages/core/src/compiler.ts:2233`, `:2278`, `:2399` | A hook for an in-process `get` (Node only) |
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
- **`start` / `dispatch`** run under a policy invocation. The `executionId` is the invocation (or wraps it), and each command is a stage, so every external effect is a broker operation with id `invocation/stage/occurrence`.
- **No direct writes.** An interpreter never calls an external write API directly. Every protected effect goes through the broker, which asks policy to authorize the execution before each step and never caches that answer.

### Command identity and retries

Broker receipts deduplicate *external writes*: one receipt per operation id. They do not deduplicate creating an execution, or a workflow's change of state. Commands therefore need their own identity:

- **A command has an identity.** It is `(uid, idempotencyKey)`, and the caller must supply the key. Policy already supports this: `allocate` reuses an invocation for a known key and refuses the key if the binding differs (`packages/policy/src/invocations.ts:57`). Without a key, every request allocates a new invocation, which is today's behavior. So **`start` and `dispatch` require an idempotency key**; a command without one is refused, not run.
- **The key is bound to the command's input.** The binding is the existing `connectionId`, `taskId` and `inputDigest`, plus, for `dispatch`, the `executionId` and a digest of the event. Reusing a key with a different binding is a conflict, not a replay.
- **Recording the command is atomic.** The command record and its key are claimed together, in one transaction, before any effect, the same way the broker claims a receipt before calling the provider. A concurrent duplicate finds the claim and waits for, or reads, its outcome.
- **The outcome is one of three, and stays one of three.**
  - `completed`: carries the recorded result.
  - `partial`: some steps completed. The broker persists each step (`receipts/{id}/steps/{n}`), and the outcome lists which ones.
  - `uncertain`: the broker could not tell whether a write was applied (`packages/broker/src/broker.ts:14-25`).

  A retry returns the recorded outcome. It does not convert `partial` or `uncertain` into `completed`. Resolving either one is an explicit act: reconcile against the provider, or start a new command with a new key.

### Pipelines

Tasks compose into chains (`id0+id1+id2`) that compile right to left; each stage's output is the next stage's input `data` (`packages/api/src/data.js:318`). A language's `get` does one of two different jobs, and the two compose differently:

- **Resolution.** `get` produces *data* the program depends on, such as the URLs L0185 fetches. A downstream stage needs this data, not the model that describes how to fetch it.
- **Presentation.** `get` adds what only a viewer needs, such as a Learnosity signature. A downstream stage must never receive it.

A language declares which job its `get` does (§11). The pipeline rule follows from that:

1. **A resolving stage is interpreted wherever it sits in the chain.** Its result is the next stage's input. Otherwise L0185 feeding another language would hand over an unresolved fetch model, and L0185's interpreter would never run.
2. **A presentation stage is interpreted only at the head.** Every stage below the head passes its model, so signed or expiring data never reaches a stage that is cached by task id.
3. **A resolved result must not carry credentials.** A resolving `get` whose result is classified `private` or `no-store` (§7) is an error when that result would feed a downstream stage.
4. **Resolution changes the cache key downstream.** A stage that consumes resolved data is no longer a function of task ids alone:
   - Its compile is cached under the task id plus a digest of its input (the way `POST /compile` already appends a data task, `packages/api/src/routes/compile.js:91`).
   - Or it inherits the upstream classification and earliest `expiresAt`.
   - The composed result takes the strictest classification and the earliest expiry of any stage.

**Existing exception:** when every task is L0158, the form is served as L0176 (`RENDER_LANG` in `packages/api/src/routes/form.js:14`). That is, in effect, a presentation `get` in another language at the head. The language-selection rule should move into the interpreter declaration (§11) instead of staying hard-coded in the form route.

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
  | `immutable` | A function of the task ids alone | Stored | `public\|private, max-age=31536000, immutable` (today's default) |
  | `shared` | Viewer-independent, holds no credentials, valid until `expiresAt` | Stored, keyed as below, until `expiresAt` | `public, max-age=<seconds to expiresAt>` |
  | `private` | Depends on the viewer or connection, holds no bearer credentials | Not stored | `private, no-store` |
  | `no-store` | Holds bearer credentials (signatures, signed URLs, tokens) | Not stored | `no-store`, today's `setNoStoreCacheHeaders` |

- **`expiresAt`** says when a consumer must call `get` again. It never widens the class: a `no-store` result with a ten-minute `expiresAt` is still never stored.

**The classification is trusted, not asserted.**
- The language's declaration in the protected registry (§11) sets the *least restrictive* class each language may return.
- The API applies the stricter of that declaration and what the result envelope says.
- The existing rules still apply on top: protected or connection chains (`packages/api/src/data.js:231-244`) are at least `private`.
- So a compromised or buggy language server cannot turn a signed result into a cached one.
- The boolean `cache: false` envelope field maps to `no-store` until languages move to the classification.

For a `shared` result, the cache key must cover more than the model hash. It includes the input digest (§5, "Pipelines"), and, where they apply, the execution ID, state version, and interpreter/configuration version.

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
- **Idempotency:** `start` and `dispatch` require an idempotency key bound to their input, and the command is recorded atomically (§5, "Command identity and retries"). Broker receipts (operation id `invocation/stage/occurrence`, single-use `jti`) deduplicate the external writes inside a command. They do not deduplicate the command itself. Retries return the recorded `completed`, `partial` or `uncertain` outcome unchanged.
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

**Node.** The existing `Renderer` hook (`config.Renderer`) can carry an in-process `get` for languages that need one.

For identity languages, `get` returns the model and unsupported operations fail explicitly. For effectful languages, a declared interpreter is mandatory and must never silently fall back to identity.

## 12. Suggested rollout

**Phase 1 — Contract and identity.**
- Finalize the wire envelopes:
  - The **model envelope** carries provenance: language, task id, compiler/configuration version, `REGISTRY_VERSION`, and the admission under which it was compiled.
  - The **result envelope** carries `cache` (§7), `expiresAt`, refresh metadata the consumer can read (which authority to refresh under, and whether a refresh is allowed once the content has started), and, for a command, its outcome (§5).
- Define admission for `get`: which models an interpreter accepts, and that a model's provenance must match the language and registry version that interpret it.
- Add the interpreter declaration to the protected registry, covering:
  - identity or not;
  - resolving or presentation `get` (§5);
  - the least restrictive `cache` class;
  - the head-language rule.

  Identity is the default.
- Have the API run `get` in `GET /data` according to the pipeline rules (§5), and skip the call for identity languages.
- Move the `Renderer` stage out of `Compiler.compile`, so a compiled model no longer includes rendering. The default renderer becomes the identity `get`.
- Keep the shared View working. Its edit flow posts form state to `POST /compile` (`languages/l0000/packages/view/src/lib/api.ts:48`), which prepends a data task and delegates to `GET /data`, so that path must return the interpreted result exactly as `GET /data` does.
- Add the Rust `Dialect::interpret` hook and the `/interpret` route.
- Existing static languages behave exactly as before.

**Phase 2 — Converge expiring projections.**
- L0176 stops signing in compile and emits unsigned models. This covers both `signForRender` and the `init <activity>` operator. Signing happens only in `get`, which formalizes the READ-01 read stage and `/preview/sign`.
- The `cache` classification replaces `cache: false`: L0176 results are `no-store`.
- The form's refresh before expiry becomes the general mechanism, under the lifecycle and authority rules in §8.
- Update or check the consumers that expect signed `/data` output today: the console, the MCP widget, and the ChatGPT inline L0176 form.

**Phase 3 — Migrate effects and nondeterminism out of compilers.**
- **L0185:** move URL fetches into a *resolving* `get`, with `shared` results. The model is fixed; the fetched data expires.
- **L0013:** a snapshot is a write, so it becomes a `start`, not a `get`. It needs a deliberate write policy first. Either address objects immutably (for example `thumbnails/{item}/{sha}.png`, with the item pointing at the latest one), or make the overwrite conditional on a generation or version precondition so an older capture can never replace a newer one.
- **L0176 `save-to-itembank`:** becomes a `start` command through the broker. It is already an explicit command in the program. Even with durable executions deferred, the command's outcome (§5) is persisted as the **artifact** that connection and publication views read (§8), so a save and the views that follow it agree.
- **L0176 dynamic-content reference:** derive the reference from the content (for example a digest of the table), not from the clock.
- **L0182 version draws:** a draw is per respondent, not per program. Move it into `get`, keyed by a respondent or session seed, with durable assignment state instead of process-local maps, and classify the result `private`. The model lists the versions; it doesn't choose one.
- Audit grant enforcement and add observability across compile, interpret and form.

**Deferred — durable executions.**
- Covers execution IDs, an authoritative execution store, state-change publication and invalidation, a versioned result cache, live form updates, and combined durable and expiring results.
- No current language needs these. `start` and `dispatch` stay in the contract as reserved operations, and this part moves to a follow-up design doc once a language needs it.
- §6–§9 sketch the direction for that doc.

### Acceptance criteria

Phases 1–3 are done when tests show:

1. **Pipelines.**
   - An L0185 stage feeding another language delivers fetched data, not its fetch model.
   - A presentation (signed) result never reaches a downstream stage.
   - A resolving `get` that returns `private` or `no-store` data into a pipeline is refused.
   - The composed result has the strictest class and the earliest expiry of its stages.
2. **Command retries.**
   - A `start` without an idempotency key is refused.
   - A retry with the same key and input returns the recorded outcome without new external writes.
   - The same key with different input is a conflict.
   - Concurrent duplicates execute once.
   - A `partial` or `uncertain` outcome is returned as such on retry, never reported as `completed`.
3. **Artifacts and publications.**
   - A connection view interprets the recipient's current artifact.
   - A publication view interprets the pinned artifact under the publication's authority, never the viewer's.
   - A missing or incompatible artifact fails with its existing reason and never triggers a run.
4. **Cache headers and storage.** Each class maps to the storage and `Cache-Control` in §7. A language that claims a looser class than its registry declaration is held to the declaration. A `no-store` result never reaches Firestore `compiles/`, the browser cache or the CDN.
5. **Refresh.**
   - A stale result is refreshed before initialization, under its original authority.
   - Content the user is already working in is never re-signed or re-initialized, and their input survives.
   - A result that its original authority can't refresh is reported as expired, never re-signed under another identity.
6. **Determinism.** Compiling the same task twice yields byte-identical models for every migrated language: L0176, L0185, L0013 and L0182.
7. **Compatibility.** The View's edit → `POST /compile` path returns the same interpreted result as `GET /data`, and static languages' output is unchanged.

## 13. Open design questions

Questions that block Phases 1–3:

1. What is the exact schema of the registry declaration (§11, §12 Phase 1), and how is a change to it reviewed?
2. Does the interpreter receive the full model, a model reference, or both? How is authorization conveyed (today: `auth`, `connectionId`, `invocationToken` and `stage` in the compile body)?
3. Is `get | start | dispatch` enough, or should commands go through a dedicated command API while `/interpret` stays the language endpoint?
4. Which refreshes may a `get` do beyond signing through view-safe functions in stage `read`? For example, what limits apply to L0185's fetches (rate, size, egress)?
5. How do per-viewer signed resources work when one item is viewed through several connections?
6. Where is the command record stored (§5), and how are `partial` and `uncertain` outcomes reconciled against the provider?
7. Where does an L0182 respondent's assignment state live, and who may read it?
8. Do the pipeline rules (§5) hold for L0158 → L0176, where the head is presented as a different language?

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
- *(Proposed)* **Treat resolving and presentation `get` differently in pipelines.** A resolving stage is interpreted wherever it sits and passes its result on. A presentation stage is interpreted only at the head.
- *(Proposed)* **Give commands their own identity.** A required idempotency key, bound to the command's input, claimed atomically. Outcomes are `completed`, `partial` or `uncertain` and are never upgraded on retry.
- *(Proposed)* **Keep artifact and publication reads.** `get` interprets the selected artifact under the existing authority. A missing artifact never triggers an implicit run.
- *(Proposed)* **Constrain refresh.** Refresh before initialization or while idle, under the original authority, without losing user input.
- *(Proposed)* **Run `get` as policy stage `read`** with view-safe functions only, and send every `start`/`dispatch` effect through the broker under a policy invocation.
- *(Proposed)* **Defer durable executions** to a follow-up doc; `start`/`dispatch` stay reserved in the contract.

This document summarizes a proposed architecture, not an assertion that these interfaces or migrations have already been implemented.
