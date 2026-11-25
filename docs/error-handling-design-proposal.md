# Graffiticode Error Handling Design Proposal

**Status:** Proposed

**Date:** November 25, 2026

**Scope:** Console, MCP, app core and GraphQL, API gateway, language services, and their Policy and Broker interactions

## Decision

Use one shared set of error fields to explain what failed, where it failed, what is known to have happened, and what action is safe next. Extend the existing failure table and preserve the durable execution records. Fix errors that disappear or become cached success before consolidating error classes.

Keep the [forum discussion's](https://forum.graffiticode.org/t/graffiticode-error-handling-best-practices/131/4) small library surface: add concrete subclasses only when callers need to distinguish them, handle the shared base contract without a branch for every subclass, and preserve causes without double wrapping. Errors need a consistent meaning as they move from language services through the API to the console or AI clients, regardless of how each interface represents them.

## Current behavior and gaps

The [shared failure table](../packages/common/src/failures.ts) maps specific reasons to five categories: `authentication`, `permission`, `malformed`, `conflict`, and `unavailable`. For example, `not-granted` maps to permission. It preserves underlying Policy reasons and has tests checking emitted reasons. Today it supplies classification; the proposal adds typed details and recovery guidance.

Durable jobs, command records, Broker receipts, and reconciliation already support recovery without blindly repeating writes. The [interpreter design](graffiticode-interpreter-design.md#9-execution-and-workflow-lifecycle) and [execution observation plan](execution-observation-plan.md) establish that recorded outcomes determine what happened and that categories alone cannot authorize retries.

Five gaps remain in the inspected source:

1. **Definite refusals become lost responses.** The [language client](../packages/api/src/lang/compile.js) converts terminal HTTP exceptions to message-only diagnostics and `responseLost: true`. A probe confirmed that an answered 403 loses its permission reason and category. A received refusal needs different handling from a response that never arrived.
2. **Later stages can hide earlier failures.** The [gateway](../packages/api/src/data.js) stops admitted chains on errors, but that guard does not cover every ordinary chain. A probe showed a later stage replacing an earlier failure with a clean result.
3. **Legacy failures can become immutable output.** A probe injected a lost language response into an unprotected legacy compile. The gateway stored it, served it again without compiling, and the [`/data` route](../packages/api/src/routes/data.js) returned HTTP 200 with `Cache-Control: public, max-age=31536000, immutable`. The interpreter stage cache already excludes failures; the legacy path needs the same protection.
4. **Clients lose recovery information.** The MCP [core adapter](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/mcp-server/src/core-backend.ts) generally reduces errors to text, while [generation guidance](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/mcp-server/src/tools.ts) asks agents to infer retryability from prose. The console editor reduces diagnostics to message and position, and [write guidance](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/write-errors.ts) extracts reasons and outcomes from message text.
5. **Error handling differs by layer.** [Common HTTP translation](../packages/common/src/http.ts), [API errors](../packages/api/src/errors/http.js), and app core have separate hierarchies and response behavior. The language client's `Promise.race` deadline stops waiting without cancelling the request, so timed-out work can overlap a later read attempt.

The recent [compiled-data normalization](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/api.ts) provides a useful precedent: it preserves errors even when data is present. [Spec generation](https://github.com/graffiticode/graffiticode-app/blob/155d89a95cf0a1be374a5b9485ffae133353e72d/packages/core/src/lib/spec-generation-service.ts) then rejects failed or missing compiled data before generation and caching when the dialect requires it.

## Shared error fields and helpers

Extend the failure table with each reason's category, allowed public details, safe message template, default HTTP mapping, and recovery rules. Preserve existing reasons and classifications, including intentionally different missing-resource categories. Handle legacy spellings through explicit aliases. Unknown reasons remain observable and conservatively handled; the fallback `unavailable` category grants no retry permission.

The public error fields are:

- **Version, reason, and category:** the contract version, specific failure reason, and its existing broad classification.
- **Message and details:** a safe explanation and reason-specific fields callers are allowed to see.
- **Context:** language, stage, function, or provider step where applicable and authorized.
- **Recovery:** a structured next action, determined using the request and recorded execution state.
- **Request reference:** a safe identifier for support and correlation.

HTTP status remains response metadata, separate from the reason and legacy numeric error codes. Stack traces, internal causes, credentials, and raw upstream bodies stay outside public responses.

Use one `FailureError` base class in TypeScript, with an optional cause. Retain helpers such as `checkArgument`; add subclasses only when callers must catch them separately. HTTP classes may remain compatibility wrappers. Rust uses its own error types and serializes the same public fields. Share schemas and compatibility fixtures between implementations.

Helpers throw the intended error directly. Propagate an existing failure unchanged unless adding meaningful context; preserve its cause and structured fields when wrapping.

## Diagnostics and execution outcomes

Keep three concepts separate:

1. **Request failure:** why an operation could not be accepted or answered.
2. **Compiler diagnostics:** source problems, warnings, incomplete content, or invalid compiler output.
3. **Execution outcome:** what recorded evidence establishes actually happened.

Give diagnostics stable reasons, severity, language and stage, source identity, and documented source-position units. The existing Rust [diagnostic type](../languages/l0000/crates/core/src/error.rs) already supports several of these fields. Verify positions across TypeScript, Rust, and non-ASCII input.

Blocking diagnostics prevent dependent generation, normal rendering, and later pipeline execution. Partial output may remain available for inspection, clearly marked provisional. Warnings and incomplete designs retain their language-specific behavior. Successful `null` data is valid where the language permits it; check missing data against that language's requirements.

A timeout does not establish command failure or uncertainty. Return the recorded outcome with its observation version or time; if it cannot be read, say so. Never invent `pending`, `failed`, or `uncertain` to fill the gap. Preserve known earlier effects. Align the legacy gateway's synthetic uncertain effects with this rule: Policy settlement and Broker receipts establish outcomes.

## Recovery actions

Replace `retryable` as the primary interface with a structured action based on the reason, operation, original request identity, and recorded state:

- Retry the same request with its existing key.
- Read or poll the existing command or job.
- Reauthenticate or change the connection.
- Edit source or supply missing input.
- Reconcile an uncertain effect or repair eligible failed occurrences.
- Take no automatic action.

For example, a read timeout may permit a bounded retry; a write timeout requires checking the existing execution before deciding what to do. A fresh execution is a separate action when it could repeat effects. Clients must never silently replace an idempotency key.

Keep `retryable` temporarily for older clients. Recovery rules must name the target operation and retain its authorization, receipt, and repair restrictions. A failure category alone never authorizes recovery.

## Interfaces

Normalize errors once when they enter a service, then translate them at each external interface:

- **HTTP:** consistent JSON errors, appropriate status and headers, `no-store`, and a support reference. Reuse the app's Problem Details format for new or explicitly versioned endpoints; preserve existing formats during migration.
- **GraphQL:** carry reason, category, details, and recovery in `extensions`, preserving field paths and partial-data behavior.
- **MCP:** return actionable text and the same structured error, with compatible output schemas and authentication challenges. A successful status lookup may report a failed job; an operation that cannot execute returns a tool error.
- **Console:** retain diagnostic fields and offer actions such as reconnecting, checking a save, or retrying from the recovery decision. Show request failures explicitly, including when displaying earlier data.
- **Language services:** distinguish rejected requests, compiler diagnostics, and missing or unreadable responses. Preserve received, validated refusals through the gateway.

Validate downstream response shapes. A `data` property alone does not identify an envelope. Keep support for legacy shapes in explicit adapters rather than repeating detection throughout consumers.

## Pipelines and caches

Stop ordinary pipelines on blocking failure across admitted, interpreted, and legacy paths. Preserve the failing stage's diagnostics and prior effects. Any language construct that deliberately handles an error needs an explicit contract.

Initially exclude all failed compilation results from caches and return them with `no-store`. Enforce this on reads and writes, and invalidate existing failed entries or move to a new cache generation. Retain execution records, receipts, and reconciliation history under their own retention rules.

If deterministic diagnostic caching later proves useful, introduce it separately with compiler-revision and input keys and a bounded lifetime. Task identity alone cannot make an error immutable.

## Async ownership and observability

Every asynchronous operation has an owner that awaits it, supervises it durably, or handles an intentional best-effort failure. Catch when translating, recovering, adding context, or owning detached work. Required side effects use durable jobs or outboxes; optional enrichment may degrade explicitly. Preserve the primary failure if cleanup also fails, and never attempt a second HTTP response after headers have been sent.

- **Deadlines and retries:** propagate one request budget, bound attempts across layers, and abort abandoned network work where possible. Assign retries to one layer with backoff, jitter, and `Retry-After`. Aborting a connection does not prove server-side effects stopped.
- **LLM repair:** send only actionable source diagnostics to code repair. Authentication failures, outages, and compiler-output schema bugs require other recovery.
- **Privacy and correlation:** use allowlisted public details and sanitized logs. Exclude prompts, source, credentials, and provider payloads from ordinary logs. Join attempts through safe request references and authorized job or command handles without repeating full exceptions at every layer.
- **Metrics:** distinguish request failures, failed compilation, authorization outages, partial or uncertain effects, artifact-storage failures, and recovery. HTTP success does not establish execution success.

## Delivery sequence

1. **Fix correctness:** prevent failed-result caching, invalidate old failures, stop legacy pipelines, and preserve definite language-service refusals. Add focused regressions first.
2. **Introduce shared fields:** extend the failure table, schemas, normalization, and cause-preserving helpers; verify TypeScript/Rust compatibility.
3. **Preserve information through clients:** update GraphQL, MCP, generation-failure projections, console diagnostics, and write recovery. Retain legacy fields during migration.
4. **Consolidate:** remove duplicate translators and message parsing after compatibility checks pass. Explicitly version breaking changes.

Reconcile affected wording and fields in the [capability-policy specification](graffiticode_capability_policy_spec.md), interpreter design, and observation plan as each increment lands.

## Acceptance criteria

- A definite permission refusal retains its reason and category through each supported interface and is never labelled a lost response.
- Temporary failures are excluded from cached results and receive `no-store`, including when an older failed entry exists.
- Blocking stage failures stop later ordinary stages without losing diagnostics or prior effects. Data with blocking errors cannot trigger dependent recipe generation or caching.
- Lost responses never manufacture outcomes or authorize fresh executions. Deadline, cancellation, and lease-loss tests preserve execution authority and avoid duplicate effects.
- Source errors, warnings, incomplete designs, outages, and compiler-output failures reach their intended recovery paths. Changing message wording does not change recovery behavior.
- TypeScript and Rust produce compatible public errors and diagnostic positions, including non-ASCII source.
- Malformed responses, unknown fields, exceptions, and cause chains cannot expose credentials or raw payloads through public responses or ordinary logs.

## Audit basis

The November 25 source audit inspected backend `4c5babf3deeda2c411fbe46fd66620fb744a0e6f` and app `155d89a95cf0a1be374a5b9485ffae133353e72d`. It ran 41 focused existing tests successfully, with one existing test skipped. Some commands required local tooling workarounds; this was not a full-suite run.

Dependency-injected probes confirmed the answered-403, immutable-failure-cache, and overwritten-stage-failure behaviors above. They used no live language services or external writes. Deployed revisions and production prevalence were not checked.
