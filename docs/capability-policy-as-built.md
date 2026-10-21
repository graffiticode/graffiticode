# Capability security conformance record

Assessment date: 2026-10-02; W1 entries updated for the v6 release (2026-10-05) and W2 entries for its release (2026-10-06). Source: local working trees and the dated evidence cited below.

The [capability security specification](graffiticode_capability_policy_spec.md) defines
required behavior. This document records evidence and gaps; it does not relax requirements.
The current implementation does **not** yet conform to the stronger admission, revocation,
and provider-validation requirements. Updating these documents changes no runtime behavior.

Status vocabulary: **Implemented** means present in inspected code for the stated scope;
**Partial** means a requirement has both code and gaps; **Missing** means the required path
was not found; **Unverified** means the available evidence does not establish the guarantee.
None of these statuses alone establishes deployment conformance.

## 1. Current execution path

The gateway allocates one invocation for a request through a connection and sends stages
sequentially. Each compiler scans its own program and asks Policy for a snapshot before
transformation. Each protected call mints an argument-bound token after live Policy checks.
Broker verifies that token, consumes its ID once, loads the credential, and performs the
operation. Writes use durable receipt claims; signing returns a provider request that the
browser uses directly. Broker does not currently call Policy at execution time.

L0176 no longer signs using program/configuration credentials. Without a user connection,
it obtains a system preview session from Policy and signs through Broker, or returns
unsigned output with a reason. It skips writes and leaves Author output unsigned.
The local l0000 core manifest is version 0.8.0 and L0176 declares `^0.8.0`; this is dependency
metadata, not independent evidence of an npm publication or deployed revision.

Evidence: [gateway execution](../packages/api/src/data.js),
[compiler admission](../languages/l0000/packages/core/src/protected-functions.ts),
[Policy](../packages/policy/src/policy.ts), [Broker](../packages/broker/src/broker.ts),
[L0176 protection](../languages/l0176/packages/api/src/protection.ts), and
[L0176 dependency manifest](../languages/l0176/packages/core/package.json).

## 2. Conformance by subsystem

### Identity, grants, and registry

- **Implemented baseline; stronger flow pending — MODEL-01, MODEL-02, AUTH-01.** Service
  identity is separately verified and bound to roles/languages; end-user identity comes
  from verified authentication. Program context is separated from authorization context.
  The new Broker-to-Policy execution authorization role and gateway preflight role are missing.
  Evidence: [caller verification](../packages/policy/src/caller.ts),
  [Policy routes](../packages/policy/src/app.ts), [Broker routes](../packages/broker/src/app.ts),
  and [execution context](../languages/l0000/packages/core/src/exec-context.ts).
- **Implemented core controls — CONN-01, GRANT-01, GRANT-02.** Owner management, exact
  language/function permissions, implicit previews, optional expiry, pending email claims,
  no onward delegation, owner restrictions, immutable account rotation, and deletion
  tombstones are present. Provisioning/deletion failure ordering and deployment behavior
  require full acceptance validation; local tests are not a distributed failure audit.
  Evidence: [management](../packages/policy/src/manage.ts),
  [delegation tests](../packages/policy/src/delegation.spec.ts),
  [secret store](../packages/broker/src/stores.ts), and
  [Firestore secret storage](../packages/broker/src/firestore.ts).
- **Partial — REG-01.** The authoritative registry is version 6 (released 2026-10-05). Policy
  checks session version at mint and Broker checks execution/receipt version. Exact matching
  exists. v6 adds the registered execution-step table: each operation's steps in order, each
  with its purpose (`dispatch`, `sign` or `replay`), queried by `operationSteps` and
  `isStepRegistered`. W2 (released 2026-10-06) authorizes every execution step
  against it, at Policy and in Broker. Chain plan binding is missing.
  Evidence: [registry](../packages/common/src/protected-registry.ts),
  [Policy](../packages/policy/src/policy.ts), [Broker](../packages/broker/src/broker.ts).

### Chain admission and live execution authorization

- **Partial — RUN-01.** User-scoped idempotency keys bind task, connection, and the gateway's
  options digest. Policy allocates sequences and stores invocations; stages and occurrence
  IDs bind receipt identities. The new complete execution-input and immutable plan contract
  still needs implementation/verification. Evidence:
  [gateway allocation](../packages/api/src/invocations.js),
  [Policy invocation storage](../packages/policy/src/firestore.ts), and
  [compiler client](../languages/l0000/packages/core/src/protected-client.ts).
- **Implemented and tested, not released — ADMIT-01, ADMIT-02, ADMIT-03, API-01 (W4).** In
  production, admission is still per compiler stage: the gateway executes a stage before
  starting the next, so an earlier stage can write before a later one discovers a denied
  function. W4 (merged to main, `CHAIN_ADMISSION=off` by default) adds:
  - a preflight of every stage, and one admission decision for the chain before any stage
    runs;
  - a durable plan pinning each stage to an approved revision, and the admission token;
  - execution through the pinned revisions, stopping at the first failure.

  Tests cover AT-03/04/07/08 across real HTTP services, and AT-12's cutover and rollback
  against the actual W3 builds. Production acceptance is pending; see "W4 status" in
  section 4. Evidence: [gateway](../packages/api/src/data.js),
  [gateway admission](../packages/api/src/admission.js),
  [Policy admission](../packages/policy/src/policy.ts),
  [cross-service tests](../packages/api/src/w4-cross.spec.js),
  [admission scan](../languages/l0000/packages/core/src/protected-functions.ts), and
  [compiler](../languages/l0000/packages/core/src/compiler.ts).
- **Partial — TOKEN-01, EXEC-01.** Invocation/session/execution profiles, fixed ES256,
  issuer/audience/type, digest checks, caller-language binding, credential binding, and
  atomic token consumption exist. There is no admission profile or plan binding. Since v6
  (2026-10-05) one profile schema drives both issuance and verification: each profile's
  typed claims, a `kid` the JWKS names, `jti`, `iat` not in the future (10 s skew), and
  `exp - iat` within the profile maximum; caller-set registered claims are refused. W2
  (released 2026-10-06) adds provenance: execution tokens carry `prv` (`user`,
  `publication` with `pub`, or `system`), required by the profile, stamped by mint from the
  session it checked, and its combination checked by `provenanceRefusal` at Policy and Broker.
  W4 (merged, not released) adds the admission profile and plan binding: `cv` on every
  proof, and for user provenance `pld`, `stg` and `bind`, with a minimum contract version at
  Policy and Broker.
  Evidence: [tokens](../packages/policy/src/tokens.ts),
  [provenance](../packages/policy/src/provenance.ts),
  [minting](../packages/policy/src/policy.ts), [Broker](../packages/broker/src/broker.ts), and
  [canonicalization](../packages/broker/src/canonical.ts).
- **Implemented, released 2026-10-06 — EXEC-02, REVOKE-01, API-02 (W2).** Policy's
  Broker-only `POST /v1/authorize-execution` re-verifies the execution token with its own
  profile, reads the protected-execution switch fresh, binds the request to the token
  (operation, args digest, registry, function/operation), checks provenance and the
  registered step, then re-reads live state through the same `liveRefusal` mint uses
  (connection, owner binding and backend, grant scope and expiry or owner restrictions,
  AUTHOR-01, publication, system connection), with plain Firestore reads and no cache. It
  returns a fresh, audited, non-cacheable decision. Broker requires an authorizer and asks
  before each provider request, each local signature and each receipt replay, in the step
  table's order, never reusing a decision. Each wait is bounded by
  `min(authorizeMs, time left)` with late decisions discarded by the clock, and the deadline
  and token expiry are checked again with nothing awaited before the effect. A token
  without the headroom to outlast the deadline is refused on arrival, before it is spent.
  Denied or unavailable, the effect doesn't happen. AT-05 (revocation, expiry, owner
  narrowing, disabling, unpublishing, system-connection replacement after mint: zero
  effects; Policy outage blocks dispatch, signing and replay) and AT-06 (revocation between
  writes gives partial; the authorization/dispatch race) are tested; the canary's
  owner-permission revocation probe passed in production (section 4). Grant revocation,
  expiry, disabling and unpublishing in production rest on those tests; the probe exercises
  owner-permission revocation only.
  Evidence: [authorize-execution](../packages/policy/src/policy.ts) and
  [parity with mint](../packages/policy/src/live.spec.ts),
  [Broker execution](../packages/broker/src/broker.ts),
  [authorizer](../packages/broker/src/authorizer.ts),
  [limits](../packages/broker/src/limits.ts), and
  [AT-05/AT-06 tests](../packages/broker/src/live.spec.ts).

### Writes, retention, and recovery

- **Partial — MODEL-03, WRITE-01, WRITE-02.** Receipt claims prevent duplicate
  execution; binding mismatches fail. Success, failed, partial, and uncertain outcomes are
  represented. Unknown provider responses are uncertain; same-key retries return recorded
  outcomes. Since v6 each completed provider step is persisted (`receipts/{id}/steps/{n}`)
  before the next provider request; a step that cannot be recorded stops the operation as
  uncertain, and a replay without a final outcome reports the persisted steps (verified in
  production, section 4). W2 (released 2026-10-06) authorizes every replay live, and
  separates refusals from outcomes: refused before the receipt claim, a typed refusal; after
  it, `failed` with no step taken or `partial` after one, the reason recorded on the receipt;
  a dispatched step without a resolved response stays `uncertain`; a request with no time
  left is never sent. No exactly-once provider guarantee exists.
  - **W5 stage 3, in code, not yet released:** the evidence reconciliation needs.
    - **Claim:** a write's claim records, in the same create and before any provider
      request, an evidence block (format 1):
      - each record's step, kind and reference;
      - a digest of its projected fields as the program sent them;
      - where the mark goes.
    - **Mark:** every record Broker sends carries the operation id, in a question's
      `data.metadata.gc_operation` and an item's `metadata.gc_operation`. A program's record
      that already carries it is refused. The binding's `argsDigest` still covers only the
      program's payload.
    - **Provider findings (sandbox spike, 2026-10-14):**
      - The mark persists and reads back unchanged.
      - A rejected `set` stored nothing, but that's observed, not guaranteed.
      - There's no request or job lookup.
      - So reconciliation will confirm `applied` from marks, and otherwise report
        `unresolved`; it never claims `not_applied`.

    Released as `broker-rmv8c7p8i-cea788` (2026-10-14); the canary passed 23 of 23 with marked
    writes, so the sandbox accepts them.
  - **Reconciliation (released 2026-10-14):**
    - **Policy** `POST /v1/receipts/reconcile`: the console only, for the signed-in user. Allowed
      for the connection's owner, or for the user who made the save while their grant still
      covers a write. The save is named by the exact idempotency key it used, or its invocation
      id.
    - **Broker** `POST /v1/reconcile`: Policy only. For each write receipt of that invocation on
      that connection:
      - after the write's deadline plus 60 s, it reads back exactly the claim's references with
        the connection's credential;
      - it decides each record `landed` (this operation's mark) or unknown;
      - the verdict is `applied` or `unresolved`, and every attempt is appended;
      - `resolution/final` is created only for `applied`, and only if absent;
      - a disagreeing race is recorded as a conflict.

      It never writes or re-executes, and older receipts without evidence stay unresolved.
  - **Released:** `broker-rmv8dr19j-3ef04d` then `policy-rmv8e1zrv-84fd65` (main `9469b28`),
    `release-check` ok.
  - **Live check:** the canary with `--reconcile` (`1820f8b`) at 17:43Z passed 24 of 24. Its
    reconcile check waited 44 s for the write's deadline and grace period, then found the
    operation's mark on both of its records: `applied`, and final.
  - **Console** (graffiticode-app #2 and #3, `55eed1b`):
    - each save records the idempotency key that attempt used;
    - "Check the item bank" asks Policy by that key: confirmed saves become a success,
      anything else keeps the failure and shows what the check found;
    - partial and uncertain saves are recognised before their cause, and Retry isn't offered
      for them;
    - the check is offered only when the server marks the save `checkable` (its key
      recorded), and a refused check explains itself in plain language.

    Deployed as `console-rmv8foi02-60caf5` on 2026-10-14. A first deploy attempt failed its
    smoke check: the deploying checkout's `node_modules` held a deploy CLI from before
    per-check `timeoutMs`, so the candidate's 39 s cold start hit the old fixed 30 s limit.
    `npm ci` fixed it; nothing was promoted from the failed attempt, and its tag was retired.
  - **Still open:** the verdicts are `applied` and `unresolved` only. `not_applied` and
    `partially_applied` would need Learnosity to guarantee in writing that a rejected `set`
    stores nothing; that's a question for their support.
  Evidence: [Broker](../packages/broker/src/broker.ts),
  [provider response classification](../packages/broker/src/learnosity.ts),
  [receipt store](../packages/broker/src/firestore.ts), and
  [receipt tests](../packages/broker/src/broker.spec.ts).
- **Closed 2026-10-16 — RETAIN-01.** Invocation and receipt code has no
  automatic expiry. Token-ID documents carry an expiry field suitable for cleanup. W4's
  admission plans (`plans`) and invocation markers have no expiry either. W5 stage 2:
  - `scripts/retention-check.js`, 2026-10-14: **no TTL policy** on any of `policy`, `broker`,
    `(default)` or `revisions`. Point-in-time recovery (7 days) and daily backups (kept 14 weeks)
    were enabled on all four at 16:07Z; the check then **passed** on every part
    (`.gc-deploy/retention/config-2026-10-14T16-07-33-821Z.json`).
  - Connection deletion keeps invocations, idempotency keys and receipts (claim, steps,
    outcome), and refuses a retry with no provider call (`retention.spec.ts`, emulator).
  - **Restore test passed, 2026-10-16:**
    - **Restored:** the daily backups of `policy` (snapshot 12:02:53Z) and `broker`
      (10:41:44Z), into scratch databases.
    - **Compared** with `retention-check --compare` to a cutoff of 10:40:44Z:
      - Policy, 465 documents: 182 invocations, 182 idempotency keys, 38 sequences, 63 plans;
        3 updated since were checked for existence. 0 problems.
      - Broker, 432 documents: 124 receipts, 184 steps, 124 outcomes. 0 problems.
      - The key → invocation → plan → receipt links: 0 problems.
      - The 117 canary records from before the cutoff: none missing.
    - **Evidence:** `.gc-deploy/retention/restore-2026-10-16T19-50-00-401Z.json`.
    - **Cleanup:** the scratch databases were deleted afterwards. Their delete protection,
      inherited from the source, was turned off first.
    - **Also fixed:** the check's backup lookup, which passed `gcloud` the full backup name
      where it takes `--backup` and `--location`.
  Evidence:
  [Policy stores](../packages/policy/src/firestore.ts) and
  [Broker stores](../packages/broker/src/firestore.ts).
- **Partial — RECOVER-01.** Atomic artifact storage, three storage attempts, and recovery
  through same-invocation receipt replay exist. Since v6 a compile whose artifact is not
  stored returns `artifact: { stored: false, error, reason, retryable, invocationId, seq,
  idempotencyKey }` beside the result (`artifact-storage-unavailable` after three attempts,
  or `artifact-rejected`). Pinned-plan recovery is missing.
  Evidence: [gateway storage loop](../packages/api/src/data.js),
  [artifact store](../packages/api/src/storage/artifacts.js), and
  [recovery tests](../packages/api/src/recovery.spec.js).

- **Implemented, released — FAIL-01** (W3 and W3b, 2026-10-06).
  - **Categories:** every refusal Policy, Broker and api return carries a category
    (authentication, permission, malformed, conflict, unavailable). A wrapped Broker reason
    gets the underlying reason's category, and an unknown reason is `unavailable`. An
    inventory test fails on any reason without a category.
  - **What failed:** compile errors name the reason (`code`), category, stage, function and
    failed step, without credentials or payloads.
  - **Effects:** every save's effects reach the caller, added up across calls and stages,
    from L0176 through l0000 0.9.0 and api: `partial`, and `uncertain` with `steps: []`,
    including when the cause is revocation or a lost answer. The canary checks this in
    production.
  - **Already held, now tested:** api never replaces a refused or failed invocation with a
    new one, and never answers or caches a compile through a connection from the shared
    cache.

  Limits:
  - A body the JSON parser rejects is categorized `malformed` but still answers 500.
  - The no-replacement rule is proven at the api gateway, not for other clients such as
    the console.

  Evidence: [failures](../packages/common/src/failures.ts),
  [AT-12 harness](../packages/api/src/at12.spec.js),
  [l0000 effects](../languages/l0000/packages/core/src/exec-context.ts),
  [L0176](../languages/l0176/packages/core/src/protection.ts), section 4.

### Provider authority, artifacts, and views

- **Hardening, 2026-10-16 — PROVIDER-01:** preview signatures (`learnosity.sign-questions-preview`,
  `learnosity.sign-items-preview`) now carry `expires`, set by Broker and covered by the
  signature: 10 minutes by default (`BROKER_PREVIEW_EXPIRES_MINUTES`, 1 to 60). Without it, a
  Learnosity signature is accepted for 7 days by default. Shipped ahead of the AT-10 work as an
  interim narrowing of issued authority. Under REG-01 it's recorded here and folded into the
  registry v8 contract, which AT-10's containment completes.
- **Released 2026-10-18 (registry v8) — PROVIDER-01, L0176-01, AT-10.** Broker builds every
  provider request from a constrained payload. The provider's own limits are measured in the
  development organisation, and are recorded in the AT-10 table in
  [capability-policy-acceptance.md](capability-policy-acceptance.md).
  - **Saves only create** (B1). Every question and item is written under
    `gc-<16 hex of sha256(operation id)>-<reference sent>`. The mapping is applied once, before
    the receipt claim, and used for the records, the item links, the evidence and the returned
    references. An item may link only to questions the same save writes. A save never changes or
    unpublishes a record already in the bank.
  - **Questions previews sign only with the preview consumer** (A3), Broker's
    `BROKER_PREVIEW_CONNECTIONS`, for every provenance; without it they're refused. The Questions
    API signs only the security packet, so a holder can change the request. The preview consumer
    is the system connection: Graffiticode's own, used only for previews (dated operator
    attestation, expires 2027-01-16).
  - **Items previews** keep the owner's connection: their signature covers the request.
  - **Broker pins**, on both APIs: `type` `local_practice` (others refused), a fresh `session_id`,
    a random `user_id`, and a 10-minute `expires`.
  - **Recorded residual:** every Learnosity key Graffiticode uses is in one development
    organisation with one item bank. A misused preview signature can start general Questions
    sessions for 10 minutes, any number of times. Each can store sessions and responses for up to
    7 days, in that organisation's session store, which holds no learner data. It can't reach the
    bank: other services refuse the signature, and Questions sessions make no item-bank call.
  - Evidence: [operations](../packages/broker/src/operations.ts), [broker](../packages/broker/src/broker.ts),
    [provider client](../packages/broker/src/learnosity.ts), and
    [browser initialization](../languages/l0176/packages/view/src/components/form/Form.tsx).
- **Closed by removal, released 2026-10-13 — AUTHOR-01.** Registry v7 removes `author`
  and `learnosity.sign-author`, and with them the enablement gate: Policy and Broker have no
  Author function or operation, and `POLICY_ENABLED_GATED_FUNCTIONS` /
  `BROKER_ENABLED_GATED_OPERATIONS` stop either service if set. L0176 has no `author`
  keyword, no `author.ts` and no Author SDK in its view; an Author activity arriving as data
  is a compile error pointing to L0177, never signed, and preflight declares nothing for
  data-dependent programs beyond `init`. Stored tasks checked first (2026-10-13): of 2,953
  L0176 tasks, 3 call `author`, all the operator's own test programs. The canary's
  **author removed** and new **denied final stage** checks replace its Author-based ones.
  Released together, paused, on 2026-10-13
  ([runbook](protected-execution.md#the-registry-v7-release-author-removed); record in section 4).
  Before v7 (v6): deny-by-default, Policy refused it (`fn-not-enabled`) and Broker omitted and
  refused its operation (`operation-not-enabled`) unless enabled; never enabled in production.
  Evidence: [registry](../packages/common/src/protected-registry.ts),
  [Policy](../packages/policy/src/policy.ts), [Broker operations](../packages/broker/src/operations.ts)
  and [L0176 compiler](../languages/l0176/packages/core/src/compiler.ts).
  - **Decided 2026-10-12 (Jeff): after the W4 cutover, remove `author` from L0176.**
    L0176 becomes only items and activities for the item bank, and its authority only the
    brokered, auditable kind (`init`, `save-to-itembank`). Graffiticode stops signing Author
    sessions at all. L0177 is a read-only planner: it helps people plan an Author API
    integration, which their own application signs with their own credentials, outside
    Graffiticode. AUTHOR-01 and AT-10's Author questions then have nothing left to cover. If
    Graffiticode ever needed to sign Author sessions, that would be a new, dedicated language
    and protected function, decided from scratch. The plan:
    1. **Check stored L0176 items for `author`** before removing it. The 30-day chain inventory
       found only the canary's.
    2. **Registry version 7:** remove `author` from `0176` (a security change). Policy's
       admission compares each stage's registry version, so L0176, Policy and Broker are
       released together.
    3. **L0176:** remove the `author` activity, or make it a compile error pointing to L0177;
       drop `author.ts`; and limit `dataDependentAuthority` to items and questions.
    4. **Broker:** retire `learnosity.sign-author`. **Policy:** the gate has nothing to gate in
       L0176. Remove `0176:author` from the gated-function handling and its tests.
    5. **Canary:** replace the Author-based checks. "Author denied" goes. "Denied final stage"
       needs another refusal, for example a stage needing `save-to-itembank` with the canary's
       owner permissions narrowed to `init`.
    6. **Docs and tests:** the W4 runbook, this record, the AT-03 Author-from-data cases, and
       the AUTHOR-01 conformance entry, which becomes closed by removal.

    The notes below explain why. They no longer describe a plan to enable Author in L0176.
  - **Notes for enabling Author (recorded 2026-10-12, for future investigation).**
    - *Why Author is riskier than the other L0176 functions, and why it's owner-only and not
      shareable.* `init` and `save-to-itembank` act through Broker, one narrow operation at a
      time: each is authorized live, draft-only, receipted and audited, so revocation is
      immediate and retries never repeat a write. `author` instead has Broker sign a Learnosity
      **Author Site session**, and then Broker steps out:
      1. **Scope:** the session can create, edit and delete items and activities across the
         item bank the connection's credentials reach, not only the item at hand. Narrowing it
         to items, references or widgets is what AT-10 still has to prove against the provider.
      2. **Nothing mediates what happens next:** the edits go from the browser straight to
         Learnosity. Broker sees only the signing, so there's no per-action authorization,
         receipt or audit, and no record of what was changed.
      3. **Revocation isn't immediate:** revoking access stops new sessions, but one already
         signed works until it expires.
      4. **The signed request is portable:** anyone holding it can use it while it's valid.
      5. **No undo through Graffiticode:** deletes and overwrites happen in the provider
         directly, with nothing to replay or reverse.

      So sharing `author` would hand someone broad, unmediated and hard-to-revoke control of
      the owner's item bank, under the owner's credentials. That's why the registry marks it
      owner-only, non-delegable and not view-safe.
    - *How enabling it would have worked* (a product request, 2026-10-12: "there should be a
      grant in 0176 settings to allow creating author items"; superseded by the decision above). Under AUTHOR-01, owner permissions can't
      bypass the deployment gate, so:
      1. **The deployment gate** opens only after AT-10 passes: Policy's
         `POLICY_ENABLED_GATED_FUNCTIONS` (`0176:author`) and Broker's
         `BROKER_ENABLED_GATED_OPERATIONS` (`learnosity.sign-author`). Today neither is set.
      2. **Per connection, inside the gate:** an `author` row in the console's L0176 access
         table, in the owner's column only (never sharees'). Until the gate opens, show it
         disabled, explaining that Author isn't enabled on this deployment. That's a
         console-only change that grants nothing. The console shows no `author` row today.
      3. **Proposed Policy change, to go with opening the gate:** require an *explicit* `author`
         opt-in even for an owner whose permissions are "everything" (`null`). Otherwise every
         owner gains Author the moment the gate opens. This is a security change, with tests.
      4. **Questions for the AT-10 investigation:** can Author sessions be restricted to items,
         references or widgets? Is their lifetime short enough to bound revocation? Can the
         provider report what a session changed, so actions could be audited or reconciled
         (WRITE-02)?
    - *Related behaviour (L0176, 2026-10-12):* an Author activity compiled without a connection
      is now a compile error (`fn-not-enabled`, category `permission`), not a silent unsigned
      result, so a refreshed console preview keeps showing why it can't open.
- **Partial — PREVIEW-01.** System preview sessions and separation from ordinary connection
  authority exist. L0176 ignores program credentials and reports unsigned preview failures.
  Saves without a connection expose a language-specific skip marker; the complete generic
  skipped-call reporting contract is not established. Execution-time revalidation is missing.
  Evidence: [Policy preview sessions](../packages/policy/src/policy.ts),
  [L0176 compiler](../languages/l0176/packages/core/src/compiler.ts), and
  [brokered compiler tests](../languages/l0176/packages/core/src/brokered.test.ts).
- **Partial — ARTIFACT-01, READ-01, PUB-01.** Private artifacts, sequence-based selection,
  structural signed-request rejection, cache bypass, data-only preview signing, and owner-only
  publications exist. Publications pin an artifact; anonymous views are restricted to
  view-safe functions. Since v6 the artifact store acknowledges a repeated put only for the
  same canonical content and bindings and otherwise refuses (`ArtifactConflict`), so the
  artifact a publication names cannot be replaced. Plan binding
  and execution-time revalidation are missing. Complete
  learner-answer routing and deployed cross-account behavior remain unverified.
  Evidence: [read path](../packages/api/src/read.js),
  [artifact storage](../packages/api/src/storage/artifacts.js),
  [publication tests](../packages/api/src/publication.spec.js), and
  [Policy](../packages/policy/src/policy.ts).

### Secrets, isolation, audit, and rollout

- **Partial — SECRET-01.** Broker encrypts secrets with connection/owner/backend associated
  data and checks owner/backend at execution. Rotation preserves provider key identity.
  L0176 no longer reads legacy program/config credentials. The legacy `get-val-private`
  shared-secret path is retired: no service mounts the key, and the key is destroyed (see the
  inventory below). **Since 2026-10-15 no compiler holds or can read a provider credential**
  (L0158 below). ISOLATE-01 is closed with recorded residuals (below). Evidence:
  [secret storage](../packages/broker/src/firestore.ts),
  [rotation rules](../packages/broker/src/stores.ts), and [deployment manifest](../deploy.json).

  Legacy shared-secret inventory (2026-10-02, read-only):
  - Path: the console encrypts `get-val-private` values with `GRAFFITICODE_SECRET_KEY` at
    parse time; the parser bakes the ciphertext into the task AST; l0000 and basis compilers
    decrypt it when the key is mounted. Only key version 1 exists; no service mounts
    `GRAFFITICODE_SECRET_KEYS`.
  - Mounted on Cloud Run: `l0176` (`deploy.json`), `l0158` (its own `cloudbuild.yaml`,
    basis 1.13.2) and `console` (graffiticode-app). Secret accessors: `l0176-run`,
    `l0158-run`; in graffiticode-app, `console-run` and the default compute account.
  - Stored tasks (L0158 2,390, L0176 2,897; ciphertext never decrypted or printed): 91 carry
    `GET_VAL_PRIVATE` ciphertext, two distinct values: 66 one-block values (the baked
    `encrypt("")`) and 25 of a single 32–47-byte credential. Other languages not scanned.
  - Operator actions (owner, 2026-10-02): stored user secrets (`users/{uid}/settings`)
    deleted for all users; the baked credential retired at its provider.
  - Retirement completed 2026-10-02/03 (UTC):
    - Console stops encrypting: `get-val-private` bakes `""`; `secret-crypto` and
      `set-compiler-secret.sh` removed (console `de17847`).
    - Mounts removed, verified on the serving revisions: `l0176-rmurlrewx-7bdf2d` (deploy
      CLI `removeSecrets`, `2df5228`), `l0158-00163-8jl` (l0158 `e487891`, Cloud Build
      `c88c30b9`), `console-00659-5k5` (Cloud Build `f97158c4`). No Cloud Run service in
      either project mounts `GRAFFITICODE_SECRET_KEY` or `GRAFFITICODE_SECRET_KEYS`.
    - Secret-level accessors removed: `l0176-run`, `l0158-run` (graffiticode);
      `console-run` and the default compute account (graffiticode-app). Both secret policies
      are empty.
    - Key version 1 destroyed: graffiticode 2026-10-03T00:08:05Z, graffiticode-app
      2026-10-03T00:08:24Z. Ciphertext remaining in old task ASTs is permanently
      undecryptable.
  - **L0158, 2026-10-15.** L0158 signed its own Questions API previews with the shared
    `learnosity-secret`. It now compiles to an unsigned activity, and its items render in
    L0176's form, which resolves dynamic data and signs through Broker under the system preview
    session. Saves and Author were removed from L0158 (they're compile errors pointing to L0176
    and L0177). Stored programs were checked first: no live item used Author or an explicit
    `init`, and none was published.
    - Code: graffiticode #101 (L0176 resolve-then-sign; stricter `init`), #102 (the api's `/form`
      redirect and the generation-scoped compile cache), #103 (activation,
      `COMPILE_GENERATION_L0158`); l0158 #1.
    - Released: `l0176-rmv9xzfol-ab9092`; L0158 `l0158-00167-bd6` (no secret mounted, no
      `LEARNOSITY_KEY`); api `api-rmva17zn4-89777d` with the generation set. The 15,761 compile
      records the old L0158 had made were deleted, so every view compiles through the new one.
    - Checked live: L0158 items render in L0176's form, signed; `save-to-itembank` shows the
      error pointing to L0176.
    - Canary after the releases, 2026-10-15: **passed (24 checks)** against
      `l0176-rmv9xzfol-ab9092` and `api-rmva17zn4-89777d`, reconcile `applied` (a first run
      failed 4 checks on IAM grant propagation only, all `getOpenIdToken` 403s).
    - Secrets: `l0176-run`'s and `l0158-run`'s access to `learnosity-secret` removed; its only
      version disabled, to be deleted; `GRAFFITICODE_SECRET_KEY` deleted. The credential that
      secret held was already retired at its provider.
  - Follow-ups (not SECRET-01 blockers): remove the inert keyring `decrypt` from l0000 core
    (`compiler.ts`); review project-level Editor on the graffiticode-app default compute
    account; delete stale local `.env.local` copies of the destroyed key.
- **Closed with recorded residuals — ISOLATE-01 (2026-10-20).**
  - **Egress:** all 36 compilers in `deploy.json` send their outbound traffic through the
    egress proxy, as allowlisted per class (rollout steps 1–5, 2026-10-18/20; graffiticode
    #135, #137, #140–#142 and #144–#149):
    - each was promoted on recorded evidence (`.gc-deploy/inventory/`);
    - `release-check` is ok for every one, and no unproxied revision is reachable
      (`.gc-deploy/at11/step5/`);
    - `rollback` refuses an uncontrolled target.
  - **AT-11 passed for all 62 compiler accounts** (run `b492fffa1316be33`; #143, #151, #152):
    - the network matrix for every `deploy.json` compiler;
    - the IAM probe for every account, the 26 legacy ones included, beside a passing control.
  - **Residuals:**
    - D2: L0185's open fetches, and the legacy l0137's and l0170's;
    - D6 (the legacy compilers' network) **ended on 2026-10-20**. All 26 are behind the proxy,
      and AT-11 passed for them in run `eec4a66d71d25450` (#156, #157);
    - the legacy sandbox Learnosity key, still accepted by the provider but reaching no
      student-facing item.
  - **Since closing (2026-10-20/21):**
    - the proxy's access log drops the query (#154, #155), its terminated hosts' clusters follow
      the DNS TTL, and each route retries once, decided host by host (#160; template
      `egress-proxy-0cfb77e009f1`, config `1aa650b0`);
    - L0013's Chrome takes a PAC script that sends only `*.graffiticode.org` to the proxy, with
      its background traffic off (#161; `l0013-rmvhc4stk-007f29`, `l0013r-rmvi7wdw2-beaa02`);
    - `scripts/legacy-network-check.js` also refuses a legacy staging service (`lNNNN-<branch>`)
      off its language's class (#159), and the legacy repos' staging configs carry the controls;
    - the step 0 prototype's projects (`graffiticode-isolate01`, `-ctl`) were deleted on
      2026-10-21, and Envoy validation now runs in `graffiticode` (#162). A later AT-11 run
      needs new control resources, a DNS-exfiltration zone and rebinding names.
  - **Records:** IAM review §4 item 7, the runbook (`deploy/egress-proxy/README.md`), and the
    plan's step records.
- **Partial — AUDIT-01.** Since W3 (released 2026-10-06), Policy, Broker and api audit:
  - **What:** admission, snapshots, mint, each step's authorization, execution and its final
    outcome with the known prior steps, receipt replays, artifacts, publications and
    connection/grant changes.
  - **Correlation:** request ids, attempt ids, decision ids and invocation/stage/operation
    ids, taken only from verified tokens.
  - **Values:** checked field by field; a value the registry or the server didn't produce
    is recorded as `invalid`. Users and owners are pseudonymized at Policy and Broker; api's
    records carry no user identifier at all (enforced).
  - **Redaction:** covered across real HTTP by the AT-12 harness, and checked on deployed
    records after the canary (section 4).
  - **Monitoring:** `scripts/monitoring.js` counts denials, Broker-local refusals,
    authorization outages, uncertain and partial writes, artifact failures and replays
    separately. Alerts for outages and uncertain writes were applied, and both emails were
    confirmed delivered by nonce on 2026-10-06.

  - **Categories (W5 stage 1, released 2026-10-14):** every failure record (`denied`,
    `failed`, `partial`, `uncertain`) carries its reason's category, added by the audit itself,
    and Broker's write outcomes always have a reason (`provider-rejected`,
    `provider-response-lost`, `step-not-persisted`, or a refusal's). Released as
    `policy-rmv888ia7-bdda82`, `broker-rmv88ik5s-d87210` and `api-rmv88w1vg-54fc59` (main
    `93f8212`, which adds only other languages' changes to #85's `9547019`).
    - **Deployed evidence:** the canary run at 15:31Z (23 of 23) produced these failure
      records, every one with a category:

      | Service | Event | Outcome | Reason | Category |
      | --- | --- | --- | --- | --- |
      | Policy | `authorize-execution` (2) | denied | `not-granted` | permission |
      | Policy | `admission` | denied | `not-granted` | permission |
      | Policy | `snapshot` | denied | `plan-required` | conflict |
      | Broker | `execute` | denied | `authorization-denied:not-granted` | permission |
      | Broker | `execute` | failed | `authorization-denied:not-granted` | permission |
      | Broker | `execute` | denied | `token-replayed` | conflict |
      | Broker | `execute` | denied | `operation-mismatch` | malformed |
      | api | `admission` | denied | `not-granted` | permission |
      | api | `artifact` | failed | `artifact-rejected` | conflict |

      The releases' own candidate checks recorded `caller-rejected` as `authentication` on
      Policy and Broker.
    - **Monitoring:** an `api_denials` metric and alerts for partial writes, artifact storage
      outages and permission denials outside the canary were applied on 2026-10-14. All five
      alerts' emails were confirmed delivered by nonce that day. The first test of the three
      new ones, written 38 s after they were created, sent nothing: new log-based alerts take
      several minutes to start matching.

    - **Required (in code, not yet released):** a failure record whose category can't be
      determined is written with `category: "invalid"`, still counted by outcome, and counted
      by the `uncategorized_failures` metric (expected zero).

  Missing: reconciliation events (W5 stage 3). Evidence:
  [audit](../packages/policy/src/audit.ts), [AT-12 harness](../packages/api/src/at12.spec.js),
  [monitoring](../scripts/monitoring.js).
- **Missing — RELEASE-01.** No stronger-contract cutover/version enforcement, pinned-plan
  legacy rejection, or rollback gate exists. These are future implementation requirements,
  not actions performed by this documentation revision.

## 3. Console behavior and earlier-document corrections

The sibling Console working tree now writes a newly saved connectable program version
through the user's current connection. Its deterministic key binds item, task, and connection;
retry reuses that key, while deliberate recompile generates a fresh key. It reports outcomes
as `lastWrite`. Free-plan/system-account paths skip that write. This replaces the former
Run-only description; a Run button is not a security boundary in the revised specification.
Evidence: `console/src/pages/api/resolvers.ts` (`writeThroughCurrentConnection`,
`retryItemWrite`) and `console/src/lib/current-connection.ts` (`saveWriteKey`), in the sibling
repository inspected on the assessment date. Those files are not versioned by this repository.

The prior as-built document also contained obsolete l0000 0.5/0.6 release prerequisites,
parse-time preview signing, incomplete publication descriptions, contradictory deployment
statements, and old branch inventories. They are superseded by this dated record, not
carried forward as outstanding requirements. No claim is made here about whether those
historical branches have been merged or deleted.

## 4. Deployment evidence and limits

No live cloud audit was performed for this documentation revision.

The [IAM review](capability-policy-iam-review.md) records historical live evidence:

- On 2026-09-28, connection provisioning and an owner save succeeded through gateway,
  Policy, L0176, Broker, and Learnosity. This contradicts the old assertion that no protected
  end-to-end run had occurred; it does not validate the new contract.
- On 2026-09-30, all services used dedicated identities and the default accounts held no
  project roles. The review records separate databases and private Policy/Broker services.
- That same record still lists L0158/L0176 access to legacy Learnosity/decryption secrets
  and broad legacy build permissions. Their present state needs verification. *(Verified and
  closed 2026-10-15: no compiler can read either secret; see SECRET-01.)*

W0 release controls, released 2026-10-03 (UTC) from main `14cc636` (clean):

- Stale tags retired before the release: 9 on policy, 4 on broker, 5 on api, 5 on l0176;
  `release-check` then passed for all four.
- Flags created with `enable` ("W0 bootstrap", 21:13Z) before the release reached traffic.
- Released `policy-rmusw3hu8-0f089c` and `broker-rmuswdv73-e78f51`; each candidate
  reported `/v1/protected-execution` `on (flag)` (`GC_VERIFY_PROTECTED_EXECUTION=on`) and
  passed its denial checks; each release retired the previous revision's tag.
- Off state verified 21:30:08–21:30:34Z: `disable`, `drain` (no active writes), both
  services reported `{"enabled":false,"source":"flag"}`, then `enable` ("W0 release
  verified"; release checks passed). A live 503 `maintenance` refusal was not exercised:
  the operator cannot yet mint L0176 caller identities (the same grant the canary needs);
  the refusal is covered by unit tests.
- W0 milestone recorded in `deploy.json` `baselines` for policy and broker (commit
  `14cc636`). api and l0176 receive theirs when they release W0 code.
- Not yet done at W0: the live canary. It first ran after the v6 release (below).

v6 (W1) release, 2026-10-05 (UTC), from main `5e0fa93` (clean): registry v6 with AUTHOR-01,
the execution-step table, TOKEN-01, WRITE-01, ARTIFACT-01 and RECOVER-01.

- Preflight: CI passed on `5e0fa93`; `release-check` passed for policy, broker, api and l0176.
  Production held 11 artifacts, all registry v4 and already incompatible under the v5 api,
  and no publications, so v6 invalidated nothing new.
- Protected execution off 19:22:15-19:49:33Z; `drain` found no active writes.
- Released `broker-rmuvmzse6-29b37e` and `policy-rmuvna4jo-0d789b` (candidates reported
  `off (flag)` with `GC_VERIFY_PROTECTED_EXECUTION=off` and passed their denial checks), then
  `api-rmuvnmpw8-5c76cd`. L0176 was not redeployed: it does not read the registry version.
- W1 milestone recorded for policy, broker and api in `deploy.json` (`0aa76f0`; api's first
  baseline) before `enable`, whose release checks then passed.
- Live canary, 20:12Z and 20:15Z, after re-enabling: on the first run, 6 of 7 checks passed;
  the gateway preview was signed (Policy minted and Broker executed
  `learnosity.sign-questions-preview`, both allowed) but the canary did not recognise the
  Questions request shape. With that and its token minting fixed (`d71ec40`), the rerun passed
  7 of 7: gateway preview, gateway write and same-key retry, token replay refused (409
  `token-replayed`), receipt replay (`replayed: true`).
- WRITE-01 in production: each canary write's receipt holds `steps/0 questions` and
  `steps/1 items`, recorded in order before its `succeeded` outcome.
- No errors, 5xx or `registry-version-*` refusals in the logs after the window.
- Console smoke test passed (operator, 20:22-20:30Z) as a grantee of the canary connection
  (`init` and `save-to-itembank` only): previews signed with no connection (system preview
  session) and through the connection; a draft save wrote once (20:24:13Z, `steps/0 questions`,
  `steps/1 items`, `succeeded`) and its recompile wrote nothing; Author was refused ("author is
  not permitted through the selected connection") before any mint. As a grantee without
  Author that refusal does not isolate the AUTHOR-01 gate; the canary's check below does.
- AUTHOR-01 in production, canary 20:52Z (`2e84fa8`, 9 of 9 checks): for the connection's
  owner, Policy's snapshot allowed `["init","save-to-itembank"]` when asked for `author` too,
  and Broker refused `learnosity.sign-author` with 403 `operation-not-enabled`
  (20:52:06Z, audited `denied`).
- Not yet done: a live 503 `maintenance` refusal (the canary does not exercise it) and the
  24 h soak.

W2 (live authorization) release, 2026-10-06 (UTC): Broker asks Policy's authorize-execution
before every effect, and execution tokens carry provenance. No registry bump.

- Prerequisites: `policy-callers` version 3 (version 1 plus broker-run as `broker`, checked
  with Policy's parseCallers; version 2, added the night before, is identical), Policy's
  `POLICY_CALLERS` pointed at it (`2830d66`); `roles/run.invoker` on the policy service for
  broker-run; the operator's OpenID token-creator on console-run, api-run and l0176-run
  (expiring 2026-10-07 00:00Z).
- Protected execution off 14:23:11-15:35:59Z; `drain` found no active writes.
- Released `policy-rmuwrr2ib-bb24c1` from `2830d66` (candidate `off (flag)`; caller denials
  on `/v1/snapshot` and the new `/v1/authorize-execution`), then, with broker's `blocked`
  field removed (`cca38b3`), `broker-rmuws6fve-6da360` from `cca38b3` (candidate `off
  (flag)`; caller denials on `/v1/execute`). Both clean builds.
- W2 milestone recorded for policy and broker (`39840f2`) before `enable`, whose release
  checks then passed.
- Canary under the allowlist while ordinary execution was paused, 13 of 13: the nine
  earlier checks, now through live authorization, plus the owner-permission revocation
  probe: a fresh token for an operation that had written was refused once the owner narrowed
  their permissions (403 `authorization-denied:not-granted`); a token minted before the
  narrowing recorded `failed` with no step taken (`authorization-denied:not-granted`); the
  permissions were restored and read back unchanged (`null`).
- Policy's audit shows one decision per step: `authorize-execution` for `sign`, `questions`
  then `items` (dispatch) and `receipt` (replay), each matched by Broker's `execute-step`,
  and exactly the probe's two `not-granted` denials. No errors or 5xx on policy, broker,
  api or l0176 through the window.
- Delayed canary, 2026-10-06 ~18:20Z (about three hours after the release, ordinary execution on):
  13 of 13 again, revocation probe included, permissions restored unchanged.
- Not yet done: a live 503 `maintenance` refusal outside the canary (still unit-tested only).

### The W3 service release (2026-10-06)

Audit values, correlation and failure categories (W3 PRs 1-4, spec AUDIT-01 / FAIL-01),
additive and authority-neutral, so no maintenance window: policy `policy-rmux0jmj2-cb9902`
and broker `broker-rmux0u0z2-12c43f` (c6ae2ad), api `api-rmux53ise-374246` (66deea7).

- api's first attempt failed in Cloud Build: the emulator test image
  (`gcr.io/graffiticode/firebase`, undefined in the repo) ran Node 16.15.1, with no global
  `fetch` for the AT-12 harness. It is now defined in `configs/Dockerfile.firebase-test.yaml`
  (same `node:22.23.3` as build and runtime, plus a headless JRE) and pinned by digest
  (1915a35). The second attempt's candidate check refused promotion: it pinned the private-task
  404 body, which now carries `category`; the check now pins `category: "malformed"` exactly,
  since `permission` there would reveal the task exists (66deea7). A third attempt's
  `gcloud builds log --stream` hung after a successful build; it was stopped before anything
  deployed, and the release was rerun.
- Canary 13 of 13 after policy and broker, and again after api, revocation probe included.
- Audit after api's canary: every api record (`gateway-invocation`, `artifact`) has
  `requestId` and `attemptId` and no user or owner field; no uid or address in any service's
  records; no value recorded as `invalid`; api's invocation ids match Policy's invocation
  records and Broker's execute records; the probe's minted-then-narrowed write recorded
  `failed`, `steps: []`, `failedStep: questions`, `category: permission`.
- Observed, not new: the canary's same-key write retry records api `artifact` `failed`
  `artifact-rejected` (`conflict`); the replayed compile's output differs from the stored
  artifact, which keeps the first. api audited nothing before W3, so this was invisible.
- Later canary, 2026-10-06 21:12Z: 13 of 13, revocation probe included. That is about 2h40m
  after the policy and broker releases, but only 25 minutes after api's. No ERROR entries
  or 5xx on api, policy, broker or l0176 since api's release.
- Monitoring (W3 PR 5), 2026-10-06: `node scripts/monitoring.js --apply` passed the filter
  check against the last 7 days of deployed entries. It created 8 metrics, the operator's
  email channel and 2 log-match alert policies; a second dry run showed all 11 unchanged.
  `--verify-alert` wrote one test record per alert at 22:16:43Z. Both emails, *authorization
  outage* and *uncertain write*, arrived, and their nonces were confirmed at 22:29Z
  (`.gc-deploy/monitoring/alert-verification.json`).
- W3b, 2026-10-06:
  - `@graffiticode/l0000` 0.9.0 published: protected-write effects, structured compile
    errors, and iterators that run in order.
  - L0176 `l0176-rmuxb8bkg-02e234` (3150f4c), on l0000 0.9.0 in both the core and the
    server.
  - Canary 15 of 15, with two new checks: the gateway write's response listed one
    `save-to-itembank` effect, `succeeded`, steps `["questions","items"]`, and the retry's
    listed it as `replayed`.
  - No ERROR entries or 5xx on api, policy, broker or l0176 after the release.

  FAIL-01 is now implemented (section 2). AUDIT-01 stays Partial: denial records carry
  `reason` without `category`, and reconciliation is missing.

### W4 status (2026-10-07)

W4 implementation and automated tests are complete. Production acceptance remains pending:
- five component releases (policy, broker, api, l0000, l0176) with `CHAIN_ADMISSION=off`;
- live W4 canary checks;
- the protected-chain inventory;
- a soak at `CHAIN_ADMISSION=all`;
- the cutover to contract version 2 and its rollback safeguards.

The supporting infrastructure and the l0000 npm releases are already delivered:
- the `revisions` database, read-only to Policy;
- approvals for the serving L0000 and L0176 revisions;
- `@graffiticode/l0000` 0.10.0 and 0.10.1.

The IAM gate (`docs/capability-policy-iam-review.md`, Step 11: `firebase-adminsdk-qflje`'s
approvals-write and impersonation authority) **closed on 2026-10-12** (Jeff), after the final
verification recorded there. Activation now waits only on the prerequisites in the runbook.

**Component releases, 2026-10-12** (prerequisite 4; `CHAIN_ADMISSION` unset, so off, and the
minimum contract version 1, so behaviour is unchanged). In the runbook's order, each followed by
the canary at 15/15 (without `--chain-admission`):

| Service | Revision | Built from | Notes |
|---|---|---|---|
| policy | `policy-rmv5kkewa-c8602c` | `1cb4fff` | `POLICY_CALLERS` at `policy-callers:4`, which adds `l0000-run` as a compiler for `0000`; the W3 revision's tag retired |
| broker | `broker-rmv5m556c-b22d87` | `1cb4fff` | the W3 revision's tag retired |
| l0000 | `l0000-rmv5mguhi-2678e5` | `7ff6021` | approved in `revisions` before promotion; `release-check` ok |
| l0176 | `l0176-rmv5moqn6-73db6d` | `7ff6021` | approved in `revisions` before promotion; `release-check` ok |
| api | `api-rmv5mwrm0-53cfe7` | `7ff6021` | the gated chain-admission path, still off |

Every build was clean (`gc-dirty=false`). Broker, L0000, L0176 and api were released from a
clean worktree of main, because the shared checkout held another session's uncommitted L0186
files. Their receipts are copied into `.gc-deploy/releases/`. Prerequisite 2 (L0000 as a Policy
caller) is done too: the `policy-callers` version above, `run.invoker` on `policy` for
`l0000-run`, and `POLICY_URL` in L0000's environment.

**Canary phase, 2026-10-12: chain admission live for the canary connection only.**
- **Switched on:** api `api-rmv5pe4j4-9d8e50` with `CHAIN_ADMISSION=canary` and
  `CHAIN_ADMISSION_CONNECTIONS` naming the canary's sandbox connection (`cd7198b`). A first
  attempt, receipt `rmv5o8f75-83a4d4`, failed while polling its successful build on a DNS
  outage, and deployed nothing.
- **First W4 canary: 20/20.** The write ran under plan `a5d4d13b…`, contract 2, pinned to the
  serving `l0176-rmv5moqn6-73db6d`. A real L0000→L0176 chain was preflighted, admitted and
  bound: plan `967fcdb0…`, pinned to `l0176-rmv5moqn6-73db6d` and `l0000-rmv5mguhi-2678e5`. That
  was L0000's first production use of Policy. The denied final stage was refused at admission
  (`fn-not-enabled`), with no effects and no plan stored. The direct path was admitted. The 15
  original checks still passed.
- **Retry across a deploy: passed.** L0176 was released again (`l0176-rmv5qckjx-5d3c21`; the old
  revision stayed approved and tagged), then the canary ran again: 22/22. The recorded write
  replayed on `l0176-rmv5moqn6-73db6d` under its original plan, with no `plan-mismatch`, while new
  writes and chains pinned to the new revision.
- **Audit:** all 33 admission and plan-lookup records since the switch are the canary
  connection's: 18 plan lookups, 11 admissions allowed (8 new, 3 reused), and 4
  `fn-not-enabled` denials, which are the two runs' denied-final-stage checks, recorded by
  Policy and api. No other connection took the admission path.

**Protected-chain inventory, 2026-10-12: passed** (prerequisite 5;
`.gc-deploy/inventory/chain-inventory-2026-10-12.json`). Window 2026-09-12 to 2026-10-12, 21:14
UTC. Coverage complete: 100 of 100 invocations scanned, 22 distinct chains. Language sequences:
L0176 alone, 19 chains and 96 invocations; L0176 ← L0000, 2 chains and 2 invocations (the
canary's L0000→L0176 chain); L0176 ← L0176, 1 chain and 2 invocations (the canary's
denied-final-stage chain). 0 unsupported, 0 unreadable. So no chain in use would be refused with
`stage-not-pinnable` under `CHAIN_ADMISSION=all`. The window's volume is low and mostly the
canary's, so a rare chain that didn't run in it isn't covered; the soak under `all` is where
that shows.

**`CHAIN_ADMISSION=all`, 2026-10-12, about 21:42 UTC:** api `api-rmv5rnbbi-50d277` (`1b8f60f`); the
canary passed 20/20 under `all`. **Soak,** about 19 hours (shortened by Jeff): the audit held 54
admission-path records, from the canary and Jeff's own test session only (4 admitted, 1
`fn-not-enabled` for an Author item, as intended). There were no unexpected denials, and no
other real traffic.

**The cutover window, 2026-10-13, 16:18 to 17:09 UTC** (`docs/protected-execution.md`, "The cutover
window"):
1. **Before the window:** the pre-W4 revisions `l0176-rmuxb8bkg-02e234` and
   `l0000-rmupvrtl5-da1639` were retired with `scripts/revisions.js retire`. Neither report named
   a plan, no admissions were fenced, and both tags were removed after the 15-minute wait.
2. **Disabled** at 16:18:23 UTC, then **drained** (no active writes).
3. **Merged `0838b57`:** `POLICY_MIN_CONTRACT_VERSION=2` and `BROKER_MIN_CONTRACT_VERSION=2`,
   `contractMinimum` floor 2 on both, and the W4 baselines (policy and broker at `1cb4fff`; api,
   l0000 and l0176 at `7ff6021`).
4. **Released Policy,** `policy-rmv6vydjz-a5729a`. Its release retired the old revision's tag
   (`rmv5kkewa-c8602c`), the last revision able to issue v1 proofs. **T = 16:27:13 UTC,**
   conservatively: the receipt doesn't record when tags are retired, so T is the time the release
   command finished, after the retirement. **Released Broker,** `broker-rmv6w9xad-985b27` (old tag
   `rmv5m556c-b22d87` retired). `release-check` passed on all five services at 16:36 UTC: W4
   baselines, the floor, and approvals.
5. **Waited** until T + 30 minutes (16:57:13 UTC), the longest proof lifetime.
6. **Canary, paused, with `--chain-admission --after-cutover`:** 22/22 at about 17:05 UTC.
   `v1 refused` passed: every new invocation is marked (contract 2, Policy's minimum 2), and a
   snapshot without a plan is refused with `plan-required`. The first run was 21/22. Its gateway
   preview hit `409 token-expiring`: the new Broker revision's first instance started about 20
   seconds before the request arrived, longer than the execution token's spare lifetime. Broker
   refused before spending it, as designed. The re-run, with Broker warm, passed.
7. **Enabled** at 17:09:28 UTC, after `release-check` passed on all five services.

**W4 is activated:** chain admission applies to every connection, and only contract version 2 is
accepted. A retry of a run started before the cutover gets `invocation-incompatible`.

**Follow-ups from the window:**
- **Cold-start `token-expiring`:** a user whose compile is the first to wake an idle Broker can
  see `409 token-expiring`. Broker's contract expects the caller to retry with a fresh token
  (`broker.ts`), but l0000's protected client didn't. **Done 2026-10-13:** the client retries once
  with a freshly minted token for the same operation (l0000 0.10.2), released in L0176
  `l0176-rmv73kqzv-03d0e4`; canary 22/22 after it. Keeping one Broker instance warm is optional.
- **Deploy CLI:** record each release's tag-retirement time in its receipt, so the cutover's T
  comes from the receipt, as the runbook assumes. **Done 2026-10-13:** receipts carry
  `tagsRetiredAt`.
- **Post-cutover, already planned:** remove `author` from L0176 (AUTHOR-01, above). **Done
  2026-10-13**, the registry v7 release below; retire older
  approved L0176 revisions (keep the last three); and the IAM cleanup outside the gate. The procedure is
in `docs/protected-execution.md`, "W4 activation and cutover".

**What W4 does and doesn't promise users:**
- **Languages:** protected chains initially support only L0000 and L0176 stages. A chain with
  a stage in any other language is refused at admission (`stage-not-pinnable`).
- **Not atomic:** W4 prevents a *known* admission denial in a later stage from following an
  earlier write. It doesn't make a chain atomic. Revocation, outages and lost responses can
  still produce partial or uncertain outcomes, reported as effects.
- **After the cutover:** invocations started before contract version 2 can't resume, even
  when receipts exist (`invocation-incompatible`). Starting a new invocation may repeat writes
  the old one made.

The current `deploy.json` wires gateway/L0176 to Policy, L0176 to Broker, and a system
connection into Policy. Configuration intent does not prove a deployment uses it. Refresh
live identity, database, token-key, secret, egress, provider-session, and rollback evidence
before claiming production conformance. Keep old observations dated rather than rewriting
historical records as current facts.

### Registry v7 release (Author removed), 2026-10-13

From main `d52cf66` (#79 code, #80 unblock), in one paused window
(`docs/protected-execution.md`, "The registry v7 release"):

1. **Before:** `release-check` passed for policy, broker, api and l0176. Neither
   `POLICY_ENABLED_GATED_FUNCTIONS` nor `BROKER_ENABLED_GATED_OPERATIONS` was set on the live
   services. Stored tasks: 3 of 2,953 L0176 tasks called `author`, all the operator's own.
2. **Disabled** at 21:23:13 UTC and drained (no active writes).
3. **Released**, each with `GC_VERIFY_PROTECTED_EXECUTION=off`, after #80 removed the four
   `blocked` fields:

   | Service | Revision | Old tag retired |
   | --- | --- | --- |
   | Policy | `policy-rmv76xiho-452413` | `rmv6vydjz-a5729a` |
   | Broker | `broker-rmv77a8nu-0b868b` | `rmv6w9xad-985b27` |
   | L0176 | `l0176-rmv77l8sj-2e0569` | none |
   | api | `api-rmv77p2nz-ce5491` | `rmv5rnbbi-50d277` |

4. **Retired the v6 L0176 revisions** `rmv5moqn6-73db6d`, `rmv5qckjx-5d3c21`,
   `rmv5ty3bz-c06749` and `rmv73kqzv-03d0e4` (`--confirm-unrecoverable`). Their reports named
   8 plans, all with 0 uncertain and 0 unfinished receipts and no stored artifact, which a v7
   Policy refuses to resume anyway. The four ran in parallel; one tag removal hit a Cloud Run
   update conflict and finished with `--resume`. L0176's only approved revision is now
   `l0176-rmv77l8sj-2e0569`.
5. **v7 baselines** at `d52cf66` for the four services (#81, `0d1888e`); `release-check` ok.
6. **Canary while paused**, 22:33Z, `--chain-admission --after-cutover`: 23 of 23, including
   **author removed** (Policy allowed `["init","save-to-itembank"]`; Broker answered
   `sign-author` with 403 `operation-mismatch`) and **denied final stage** (200, `not-granted`,
   0 effects, no plan; permissions restored).
7. **Enabled** at 22:35:09 UTC, after `release-check` passed on all five services.

Every artifact and publication stored under v6 is now incompatible until its owner recompiles
(and republishes); runs started before the window can't resume.

### Registry v8 release (AT-10: fresh save references, the preview consumer), 2026-10-18

From main `1a8d828f` (#122), in one paused window (the runbook's "The registry v8 release"):

1. **Before:**
   - `release-check` passed for policy, broker, api and l0176;
   - the canary's OpenIdTokenCreator grants were in force on `api-run`, `l0176-run` and
     `console-run` (until 2026-10-19T06:00Z);
   - #122 passed CI, including the emulator suite.
2. **Disabled** at 20:31:00 UTC and drained (no active writes). #122 was merged inside the window.
3. **Released**, each with `GC_VERIFY_PROTECTED_EXECUTION=off`:

   | Service | Revision | Old tag retired |
   | --- | --- | --- |
   | Policy | `policy-rmveadjgp-1b3667` | `rmve53hbk-90d67a` |
   | Broker | `broker-rmveamaj2-3dcac6` | `rmve5dscz-a390e4` |
   | L0176 | `l0176-rmveaui2m-804996` | none |
   | api | `api-rmveay51w-3d3c0e` | `rmvb5y46h-9c7060` |

4. **Retired the v7 L0176 revision** `l0176-rmvb9akkt-5b79e9` (`--confirm-unrecoverable`). Its
   report named 23 plans, all with 0 uncertain and 0 unfinished receipts; a v8 Policy refuses to
   resume them anyway. The script marked the record retired, then didn't exit, so its tag was
   removed by hand (`gcloud run services update-traffic --remove-tags`).
5. **v8 baselines** at `1a8d828f` for the four services (#126, `31b651d5`); `release-check` ok.
6. **Canary while paused** (`--chain-admission --after-cutover`): 23 of 23.
7. **Provider matrix while paused** (AT-10, below):
   - Broker-signed `separation`: a Questions signature, now from the preview consumer, was
     refused by every other service;
   - draft-only saves left published content unchanged;
   - `integrity` behaved as on v7;
   - `caches` found `POST /compile` without `no-store`. That predates v8; fixed in #130 and
     released as `api-rmveeouvf-0c12ae`.
8. **Enabled** at 21:37:06 UTC, after `enable`'s `release-check` gate passed. Total time paused:
   66 minutes.

Broker and Policy run one minimum instance each (#124, released before the window). A cold
start of both had made a Broker authorization miss its 5-second limit. The console's Recompile
wording followed (graffiticode-app #30, `console-rmvedpi6m-7310f4`).

## 5. Validation evidence and remaining acceptance work

During the 2026-10-02 comparison, local tests passed: Policy 137, Broker 43 (excluding its
Firestore emulator suite), and L0176 core 144. Policy/Broker tests used `--transform '{}'`
because the local SWC native binding failed; HTTP tests also needed permission for local
listeners. This is evidence for existing behavior, not for the new requirements.

Commands used for that comparison:

```sh
npm run -w packages/policy test -- --runInBand --silent --transform '{}'
npm run -w packages/broker test -- --runInBand --silent --transform '{}' --testPathIgnorePatterns firestore.spec.js
# From languages/l0176:
npm run -w packages/core test -- --reporter=dot
```

Gateway recovery/publication tests cited above were inspected, not rerun for this revision.
Firestore integration, production IAM/egress, learner-answer routing, and live provider
session behavior were not validated by those test runs.

**Acceptance run, 2026-10-14 (W5 stage 5):** [capability-policy-acceptance.md](capability-policy-acceptance.md) maps each AT clause to its tests and the live evidence. Updated the same day once its gaps were closed: every AT passes except AT-07 (pending the restore test), AT-10 (open: provider-side) and AT-11 (deferred with ISOLATE-01). Since then AT-07 passed (restore test, 2026-10-16) and AT-10 passed with recorded residuals (registry v8, 2026-10-18), and AT-11 passed with recorded residuals (ISOLATE-01, 2026-10-20), so every AT passes. The backlog below is the pre-W4 view, kept for history.

The spec's AT-01 through AT-12 are the release acceptance backlog. In particular:

- AT-03/04 need new complete-chain admission, immutable-plan, and proof-substitution tests.
- AT-05/06 need revocation-after-mint, per-step live checks, outage, and race tests.
- AT-07/08 need durable step evidence, retention checks, pinned recovery, and explicit
  artifact-storage failure tests in addition to existing receipt/recovery coverage.
- AT-09/10 need full deployed view/answer and provider-session tests, plus the Author gate.
- AT-11/12 need deployed isolation negatives, legacy credential invalidation, audit
  correlation, and mixed-version cutover/rollback evidence.

**Milestones aren't conformance.** Completing W0-W4 doesn't make the implementation conform
to the spec. These remain open alongside W5. Jeff is the accountable owner of all four. The
coding agent does the implementation work named, and Jeff accepts the production evidence.

| Item | State | Responsibility | Closure criterion |
|---|---|---|---|
| AUDIT-01 | Partial: denial records have no `category`; no reconciliation events | Agent implements categories and reconciliation audit events. Jeff accepts production evidence | Every audited refusal carries its category, checked by the inventory test; reconciliation outcomes audited; both shown on deployed records |
| WRITE-02 | Missing: no reconciliation from provider evidence. No exactly-once provider guarantee is claimed | Agent implements W5 reconciliation and its tests. Jeff accepts provider-backed evidence | Uncertain and partial writes reconciled against provider evidence, with AT-10 for Author, shown against the provider |
| RETAIN-01 | **Closed 2026-10-16:** restore test passed (see RETAIN-01 above) | Jeff owns production retention, backups and restore verification. Agent supplies the checks | A successful restore test, and verification that every record RETAIN-01 names (invocation records, idempotency bindings, admission plans, receipt claims and outcomes) has no unintended expiry and survives connection deletion, not just backups configured; in the Policy and Broker databases, recorded |
| ISOLATE-01 | **Closed 2026-10-20, with recorded residuals:** all 36 `deploy.json` compilers are behind the egress proxy, and AT-11 passed for all 62 compiler accounts (run `b492fffa1316be33`). Residuals: D2 and the legacy sandbox key; D6 ended 2026-10-20 (all 26 legacy compilers on the proxy, AT-11 run `eec4a66d71d25450`) | Jeff owns production IAM and network controls. Agent supplies configuration changes and negative tests | Enforced egress allowlist; compilers denied access to credentials (secrets, keys, metadata tokens beyond their own) and denied impersonation; all shown by deployed negative tests (AT-11) |

Update this record when each requirement is implemented and tested. Record source revision,
command/environment, outcome, and date; retain the distinction between local implementation
and deployed verification.
