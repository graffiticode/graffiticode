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
| A `Renderer` stage after compile. It is pluggable via `config.Renderer`, but the default only turns records into plain JSON and no language overrides it. | `languages/l0000/packages/core/src/compiler.ts:2233`, `:2278`, `:2399` | A hook for an in-process `get` (Node only) |
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
- **L0013** `snap` renders in headless Chrome and uploads a content-addressed PNG to GCS during compile.

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
- **`start` / `dispatch`** run under a policy invocation. The `executionId` is the invocation (or wraps it), and each command is a stage, so every external effect is a broker operation with id `invocation/stage/occurrence`. Retries reach the same write receipt, so a repeated command returns the recorded outcome instead of running again.
- **No direct writes.** An interpreter never calls an external write API directly. Every protected effect goes through the broker, which asks policy to authorize the execution before each step and never caches that answer.

### Pipelines

Tasks compose into chains (`id0+id1+id2`) that compile right to left; each stage's output is the next stage's input `data` (`packages/api/src/data.js:318`). Interpretation must not change what flows between stages:

- **Only the head of the chain is interpreted.** Each stage passes its *model* to the stage on its left, never its interpreted result.
- **Why:** if an upstream result carried signed or expiring data, it would leak into stages that are cached and identified by their task id.
- **Existing exception:** when every task is L0158, the form is served as L0176 (`RENDER_LANG` in `packages/api/src/routes/form.js:14`). That is, in effect, interpreting the head as a different language. The language-selection rule should move into the interpreter declaration (§11) instead of staying hard-coded in the form route.

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

### Cache keys and TTL

**Results that carry bearer credentials are not cached.** The API passes a signed result straight through with `no-store`, as it does today for `cache: false`, protected or connection chains (`packages/api/src/data.js:231-244`, `packages/api/src/routes/utils.js:97-108`). `expiresAt` then tells the *consumer* when to call `get` again; it is not a server cache lifetime.

For an expiring result that may be cached (unsigned and viewer-independent), the cache key must cover more than the model hash. Depending on the resource's scope, it may need the tenant, execution ID, state version, and interpreter/configuration version.

`expiresAt` from the interpreter should be authoritative for the projection's lifetime, subject to platform safety margins and security limits. It replaces the boolean `cache: false` envelope field. Language-level TTL defaults and task-level overrides are possible future conveniences, but neither should extend a signed resource beyond its actual expiry. Task cache policy should be metadata rather than changes to program code where possible.

**Do not conflate TTL with durable workflow retention.** A result may expire while execution state remains indefinitely or according to a separate retention policy.

## 8. Form and API behavior

**Today's flow.** `/form` does not compile or build a result. It resolves the head task's language, builds a `/data?id=…` URL, and **redirects** to the language server's own `/form?url=<that /data URL>` (`packages/api/src/routes/form.js:52-92`). The language's form then fetches `/data` itself. It refreshes expiring resources on its own too: L0176 re-signs through `POST /preview/sign` when its request is close to expiry.

**Proposed flow.** Keep the redirect. `GET /data` is where the API runs `interpret(get)` on the head model, and an identity language skips that call. Client-side refresh becomes a general rule: when a result has `expiresAt`, the form asks for a fresh `get` (through `/data` or a dedicated refresh route) shortly before it expires. That lets `/preview/sign` become one case of the general mechanism.

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
- **Idempotency:** `start` and `dispatch` run under a policy invocation, so retries reach the same broker write receipt (operation id `invocation/stage/occurrence`, single-use `jti`). They need no separate idempotency scheme.
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
- Specify the request and response envelopes.
- Add the interpreter declaration to the protected registry, with identity as the default.
- Have the API run `get` in `GET /data` for the head of a chain only, and skip the call for identity languages.
- Add the Rust `Dialect::interpret` hook and the `/interpret` route.
- Existing static languages behave exactly as before.

**Phase 2 — Converge expiring projections.**
- L0176 stops signing in compile (`signForRender`) and emits unsigned models. Signing happens only in `get`, which formalizes the READ-01 read stage and `/preview/sign`.
- `expiresAt` replaces `cache: false`.
- The form's refresh before expiry becomes the general mechanism.
- Update or check the consumers that expect signed `/data` output today: the console, the MCP widget, and the ChatGPT inline L0176 form.
- Test that signatures expire and refresh correctly.

**Phase 3 — Migrate the other effectful compilers.**
- **L0185:** move URL fetches into `get`. The model is fixed; the fetched data is an expiring, cacheable, unsigned result.
- **L0013:** move the snapshot upload into `get` or a `start`. It is content-addressed and so already idempotent.
- **L0176:** `save-to-itembank` becomes a `start` command through the broker. It is already an explicit command in the program.
- Audit grant enforcement and add observability across compile, interpret and form.

**Deferred — durable executions.**
- Covers execution IDs, an authoritative execution store, state-change publication and invalidation, a versioned result cache, live form updates, and combined durable and expiring results.
- No current language needs these. `start` and `dispatch` stay in the contract as reserved operations, and this part moves to a follow-up design doc once a language needs it.
- §6–§9 sketch the direction for that doc.

## 13. Open design questions

Questions that block Phases 1–3:

1. Exactly what does the protected registry declare per language: identity, an in-process or HTTP `get`, the head-language rule (§5)?
2. Does the interpreter receive the full model, a model reference, or both? How is authorization conveyed (today: `auth`, `connectionId`, `invocationToken` and `stage` in the compile body)?
3. Is `get | start | dispatch` enough, or should commands go through a dedicated command API while `/interpret` stays the language endpoint?
4. What exactly may an idempotent `get` do? Signing through view-safe functions in stage `read` is allowed. Which other refreshes are, for example an L0185 fetch?
5. How do per-viewer signed resources work when one item is viewed through several connections?
6. What version and configuration information goes into model and result cache keys?
7. Is the head-only rule for pipelines (§5) right in every case, including L0158 → L0176?

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
- *(Proposed)* **Never cache results that carry bearer credentials server-side.** `expiresAt` tells the consumer when to refresh.
- *(Proposed)* **Interpret only the head of a pipeline.** Each stage passes its model, not its result, to the next.
- *(Proposed)* **Run `get` as policy stage `read`** with view-safe functions only, and send every `start`/`dispatch` effect through the broker under a policy invocation.
- *(Proposed)* **Defer durable executions** to a follow-up doc; `start`/`dispatch` stay reserved in the contract.

This document summarizes a proposed architecture, not an assertion that these interfaces or migrations have already been implemented.
