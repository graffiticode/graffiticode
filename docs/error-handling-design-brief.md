# Graffiticode Error Handling Design Brief

**Status:** Proposed

**Date:** November 25, 2026

**Scope:** Console, MCP, app core and GraphQL, API gateway, language services, and their Policy and Broker interactions

## Recommendation

Adopt one shared, versioned failure contract, with recovery decisions based on execution state. Extend the existing FAIL-01 registry and preserve the durable command machinery. Prioritize places where errors lose meaning, disappear in a pipeline, or become cached success before reorganizing the error class hierarchy.

The contract should let a person or agent answer four questions: what failed, where it failed, what is known to have happened, and what action is safe next. HTTP status and message text alone cannot answer them.

This brief compares the checked-out backend at `4c5babf3deeda2c411fbe46fd66620fb744a0e6f` and app at `155d89a95cf0a1be374a5b9485ffae133353e72d`. The findings describe source behavior and local reproductions; deployed revisions and production traffic were not inspected. The changes below are a proposal, with existing behavior identified separately.

## Intent of the forum discussion

The [error handling discussion](https://forum.graffiticode.org/t/graffiticode-error-handling-best-practices/131/4) favors a shared library, simple assertions, outcome-oriented base classes, centralized translation, and explicit ownership of asynchronous failures. The latest reply recommends a narrow library surface, concrete subclasses only when callers need to distinguish them, and preserving an existing cause without wrapping twice.

Retain those principles. Revise the HTTP-centered model so console, MCP, GraphQL, Rust language services, and background workers share failure semantics. Protocol adapters should map those semantics to their own response formats.

## Current implementation

### Shared vocabulary and error classes

[FAIL-01](../packages/common/src/failures.ts) already defines five categories: `authentication`, `permission`, `malformed`, `conflict`, and `unavailable`. It preserves underlying Policy reasons and explicitly separates classification from retry authorization. Its inventory tests check reasons emitted by Policy, Broker, and the API.

The [interpreter design](graffiticode-interpreter-design.md#9-execution-and-workflow-lifecycle) and [execution observation plan](execution-observation-plan.md) already call for extending this registry with typed details and context-aware recovery. They also establish that errors cannot manufacture or overwrite recorded command outcomes.

The shared-library implementation is fragmented. [Common errors](../packages/common/src/errors.ts) and their [HTTP translator](../packages/common/src/http.ts) use concrete-class branches. The API has a separate [HTTP error hierarchy](../packages/api/src/errors/http.js), whose subclasses inherit response handling through `HttpError`. App core defines another hierarchy. The API's final handler returns a plain 500 for unknown errors, while the common translator includes their message. Response format and disclosure behavior therefore depend on the boundary that catches the error.

### Language services and the gateway

The Rust [diagnostic type](../languages/l0000/crates/core/src/error.rs) supports source positions and optional code, category, stage, function, and step fields. Compiler diagnostics normally travel inside an HTTP-success envelope. Request failures use other shapes, including an `error` string or a structured HTTP error.

The API's [language client](../packages/api/src/lang/compile.js) retries selected connection errors, timeouts, and 503s only for calls declared to have no effects. Calls that may act are not automatically resent. These safeguards should remain.

However, its final catch converts every terminal HTTP exception to message-only diagnostics and `responseLost: true`. A local probe confirmed that a definite HTTP 403 with a structured permission reason becomes a lost response, discarding its reason and category. A received refusal and a response that never arrived require different handling.

### Pipeline propagation and caching

The gateway's [data path](../packages/api/src/data.js) stops an admitted chain after a stage returns errors. That early-stop rule does not cover every ordinary chain. In a local probe, a later stage ran after an earlier failure and returned a clean result that replaced it.

The same legacy path can cache failures. A local probe injected a lost language response into an unprotected legacy compile. The gateway stored the failed envelope, served it again without compiling, and the [`/data` route](../packages/api/src/routes/data.js) returned it with HTTP 200 and `Cache-Control: public, max-age=31536000, immutable`.

The interpreter path already excludes failed results from stage-cache writes. Legacy compile-cache writes and response cache headers need the same general failure exclusion, including on cache reads.

### App core, console, and MCP

The recent [compiled-data normalization](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/api.ts) correctly preserves envelope errors, including responses containing both data and errors. [Spec generation](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/spec-generation-service.ts) rejects missing or failed compiled data before generation and caching when a dialect's directive requires it. This is a useful model for other boundaries.

Other paths still return `null`, wrap failures in generic messages, or retain only text. The MCP [core adapter](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/mcp-server/src/core-backend.ts) specially preserves free-plan failures but generally flattens other errors. Its [failed-generation guidance](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/mcp-server/src/tools.ts) leaves the agent to infer retryability from prose. Generation jobs retain failure code and retryability, but the item-facing projection exposes the message as `generationError`.

The console [editor](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/console/src/components/Editor.tsx) reduces fetched diagnostics to message and position. [Write guidance](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/write-errors.ts) extracts reasons and partial or uncertain status from message text. Useful recovery semantics exist underneath these presentations but do not consistently reach the caller.

### Execution records and async ownership

Durable generation jobs, command records, Broker receipts, same-key retries, and reconciliation already provide a stronger model than generic exception handling. Preserve those mechanisms.

The newer design reserves command outcomes for authoritative settlement. The legacy gateway can instead synthesize an uncertain effect when an admitted protected stage loses its response. Align that behavior with the newer rule: report the lost observation and the recorded effects separately.

The language client's deadline uses `Promise.race` to stop waiting without cancelling the underlying request. Attempts also receive individual deadlines rather than one propagated request budget. A timeout can therefore leave work running while another read attempt starts.

## Proposed design

### One registry and a small error hierarchy

Extend FAIL-01 into the authoritative contract registry. Each reason should define its category, typed public details, safe message template, default HTTP mapping, and applicable recovery rules. Recovery rules take execution context; a registry entry cannot grant a retry independently of that context.

Preserve existing reason names and classifications, including intentionally different missing-resource categories. Add app and compiler reasons incrementally. Normalize legacy spellings through explicit compatibility aliases. Keep unknown reasons observable and conservatively handled; their fallback `unavailable` category does not grant retry permission.

Publish a transport-neutral schema and shared fixtures for TypeScript and Rust. Generate types where useful, while keeping execution and authorization logic in their owning services.

Use one domain `FailureError` carrying a registered failure and an optional cause. Retain convenience classes and helpers such as `checkArgument` where they improve readability. Add concrete subclasses only when callers must catch them separately. HTTP error families may remain compatibility wrappers, but core operations should communicate failures without inheriting from an HTTP class.

Helpers throw the intended error directly. Propagate existing failures unchanged unless adding meaningful context; preserve their cause and structured fields when wrapping.

The public failure contract should carry:

- A contract version and registered reason.
- The existing FAIL-01 category.
- A safe, actionable message and reason-specific, allowlisted details.
- Language, stage, function, or provider-step context where applicable and authorized.
- A typed recovery decision.
- A safe request reference for support and correlation.

Stack traces, internal causes, raw upstream bodies, and credentials remain outside the public contract. HTTP status is transport metadata; it must not be confused with a stable reason or a legacy numeric error code.

### Separate requests, diagnostics, and execution outcomes

Keep three concepts explicit:

1. **Request failure:** why an operation could not be accepted or answered.
2. **Compiler diagnostics:** source problems, warnings, incomplete content, or invalid compiler output.
3. **Execution outcome:** what authoritative records establish actually happened.

Give diagnostics stable reasons, severity, language and stage, source identity, and documented source-position units. Verify position behavior across TypeScript, Rust, and non-ASCII input. Severity describes whether a diagnostic blocks use; it does not introduce another failure-category system.

Useful partial output may accompany blocking diagnostics, but it stays provisional. It cannot become authoritative input to recipe generation, rendering, or a later stage. Preserve incomplete designs and warnings without automatically treating every warning as failure. Successful `null` data remains possible where the language contract permits it; missing required data must be checked according to that contract.

A transport failure does not establish command failure or uncertainty. Return the recorded outcome when available, with its observation version or time. If that read fails, state that the outcome could not be obtained. Never invent `pending`, `failed`, or `uncertain` to fill the gap. Known earlier effects remain visible even when a later stage or response fails.

### Recovery as explicit actions

Replace `retryable` as the primary recovery interface with a typed decision based on the reason, operation, original request identity, and recorded execution state. Supported actions should include:

- Retry the same request using its existing key.
- Read or poll the existing command or job.
- Reauthenticate or change the connection.
- Edit source or supply missing input.
- Reconcile an uncertain effect.
- Repair eligible failed occurrences.
- Take no automatic action.

Creating a fresh execution is a distinct action when it could repeat effects. Clients must never silently substitute a new idempotency key. Same-key retries, failed-only repair, and deliberate new executions retain their existing authorization and receipt rules.

Keep `retryable` temporarily as a compatibility projection. An action must be specific about its target: retrying a read, polling a job, repairing an occurrence, and repeating a write are different operations. A category alone never authorizes any of them.

### Translate once at each protocol boundary

Use one shared normalization function and thin protocol adapters:

- **HTTP:** consistent JSON errors, appropriate status and headers, `no-store`, and a support reference. Reuse the app's existing Problem Details approach for new or explicitly versioned endpoints. Preserve existing response formats during migration.
- **GraphQL:** preserve reason, category, details, and recovery in `extensions`, alongside field paths and normal partial-data semantics.
- **MCP:** return actionable text and the same structured failure. Preserve authentication challenges. A status lookup that successfully reports a failed job may remain a successful lookup; an operation that cannot execute returns a tool error. Version output schemas consistently with these results.
- **Console:** retain structured diagnostics and derive available actions from recovery decisions, rather than interpreting prose. Show transport failures explicitly instead of leaving stale data or an empty panel without an explanation.
- **Language services:** consistently distinguish rejected HTTP requests, compiler diagnostic responses, and unavailable or unreadable responses. Preserve a received, validated refusal through the gateway.

Validate downstream envelopes before using them. Do not identify an envelope solely by the presence of an ordinary `data` property. Keep legacy response normalization in explicit adapters rather than spreading shape detection through consumers.

### Cache and pipeline invariants

Initially exclude all failed compilation envelopes from result caches and return them with `no-store`. Enforce this on cache reads and writes so existing entries cannot bypass the rule. Include a targeted invalidation or cache-generation transition for already-stored failures in the implementation plan.

Stop ordinary pipelines on blocking failure across admitted, interpreted, and legacy paths. Any language construct that deliberately handles an error requires an explicit contract. Preserve the failing stage's diagnostics and all known prior effects.

Execution records remain recovery evidence under their own retention rules. Excluding failed compilation results from caches must not delete receipts, commands, jobs, or reconciliation history.

If deterministic diagnostic caching later proves useful, introduce it separately with compiler-revision and input keys and a bounded lifetime. Task identity alone does not establish that an error is immutable.

### Async ownership and observability

Every asynchronous operation has an owner responsible for awaiting it, supervising it durably, or handling an intentional best-effort failure. Catch when translating, recovering, adding context, or owning detached work. Avoid catch-and-log blocks that consume required failures and return implicit success.

Required side effects use durable jobs or outboxes. Optional enrichment may degrade explicitly. Cleanup must preserve the primary failure when cleanup also fails. HTTP handlers must respect already-sent headers and delegate or terminate appropriately rather than attempting a second response.

Improve the operational contract in these areas:

- **Deadlines:** propagate a request budget, bound attempts across layers, and abort abandoned network work where possible. Aborting a connection does not prove that server-side effects stopped.
- **Retry ownership:** assign retries to one layer, with backoff, jitter, and `Retry-After`, avoiding multiplication across clients and services.
- **LLM repair:** repair actionable source diagnostics only. Authentication failures, outages, and compiler-output schema bugs require different recovery.
- **Public messages and logs:** serialize allowlisted details and sanitize diagnostics under the existing privacy contract. Ordinary logs exclude prompts, source, credentials, and provider payloads. Preserve internal cause chains only in appropriately protected, sanitized diagnostics.
- **Correlation:** expose a safe request reference and join attempts to authorized job and command handles. Logging should avoid repeated full exceptions at every layer while retaining useful boundary and attempt context.
- **Metrics:** measure request failures, failed compilation, authorization outages, partial or uncertain effects, artifact-storage failure, and recovery separately. HTTP success is not execution success.

## Delivery sequence

1. **Correctness fixes:** failed-result caching and invalidation, legacy pipeline stopping, and preservation of definite language-service refusals. Add focused regressions before broader refactoring.
2. **Shared contract:** registry descriptors, schemas, normalization, cause-preserving helpers, and TypeScript/Rust compatibility fixtures.
3. **Client propagation:** structured GraphQL and MCP failures, generation-failure projections, console diagnostics, and write-recovery actions. Keep legacy fields until consumers migrate.
4. **Consolidation:** retire duplicate translators and message parsing after compatibility coverage passes. Introduce stricter enforcement incrementally with explicit versioning for breaking changes.

The first increment should not wait for class-hierarchy consolidation. Later increments should reuse the existing [FAIL-01 specification](graffiticode_capability_policy_spec.md), interpreter contracts, and observation plan rather than establish competing definitions. Follow-on plans should reconcile any wording or fields they change in those documents.

## Acceptance criteria

Tests should exercise complete boundaries and recovery decisions, including these cases:

- A definite language-service permission denial retains its reason and category through the gateway, GraphQL, MCP, and console; it is not labelled a lost response.
- A temporary outage is excluded from stored result caches and receives `no-store`, including when an older failed entry already exists.
- A blocking stage failure prevents later ordinary stages from executing or replacing its diagnostics. Known prior effects remain present.
- A response containing both data and blocking errors cannot trigger dependent recipe generation or caching.
- A lost write response never authorizes a fresh execution, fabricates an outcome, or conceals an already-completed execution. Recovery uses the existing command and key.
- Source errors, warnings, incomplete designs, transport failures, and compiler-output schema failures reach their intended recovery paths. Only actionable source diagnostics enter LLM repair.
- Changing message wording leaves classification and recovery behavior unchanged.
- TypeScript and Rust serialize compatible public failures and diagnostic positions, including non-ASCII source.
- Unknown downstream fields, malformed envelopes, internal exceptions, and cause chains cannot expose credentials or raw payloads through public responses or ordinary logs.
- Deadline, cancellation, lease-loss, and retry-budget tests preserve execution authority and avoid duplicate effects.

## Validation of the current-state findings

The source audit ran 41 focused existing tests successfully: 17 language-client and output-validation tests, 19 compiled-data and MCP core-error tests, and five failure-inventory tests. One existing language-client test was skipped. Some test commands required workarounds for stale compiled output and an unavailable local SWC native binding; this was not a full-suite run.

Dependency-injected probes confirmed three behaviors in the inspected source: an answered 403 becomes `responseLost`, a legacy lost-response envelope is stored and served with a one-year immutable cache header, and a later non-admitted stage can replace an earlier failure. The probes used no live language services or external writes. Production occurrence and prevalence remain unmeasured.
