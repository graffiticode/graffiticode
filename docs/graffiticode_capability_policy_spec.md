# Graffiticode capability security specification

Revision: 2026-10-02. Status: normative target, including requirements not yet implemented.

This document defines how the system MUST work and supersedes the earlier design-state
text at this path. MUST and MUST NOT are release requirements; SHOULD permits a documented,
reviewed exception. Requirement identifiers are stable across revisions.

Implementation evidence belongs in [the conformance record](capability-policy-as-built.md).
Historical infrastructure observations belong in [the IAM review](capability-policy-iam-review.md).
Neither a passing unit test nor this specification establishes production conformance.

## 1. Purpose and trust boundaries

**MODEL-01 — Authority.** A connection owner may let another Graffiticode account invoke
specific language functions using that connection without revealing its credential.
Authority is an identity-based grant enforced through scoped execution tokens. This is a
hybrid capability system, not a claim of conformance to the classic object-capability model.
Ordinary computation needs no connection permission. Protected behavior includes provider
requests and creation of signed requests that convey provider authority to a browser.

**MODEL-02 — Components.** Auth establishes user identity. The gateway checks task access,
resolves the complete composition, coordinates admission, and manages artifacts. Compilers
normalize programs, declare protected behavior, and execute admitted stages. Policy owns
authorization decisions. Broker alone retrieves connection secrets and performs registered
operations. The browser may consume constrained provider-signed requests but never receives
the signing secret.

Programs, AST members, options, incoming data, and client identity fields are untrusted.
They MUST NOT set or modify execution identity, connection authority, invocation, admission,
stage, or tokens. A requested connection is input to authorization, never proof of permission.
Compilers are trusted to describe and execute their programs correctly; Broker independently
limits them to authorized operations and payloads. Tokens do not prove that a compromised
compiler followed the source program.

**MODEL-03 — Limits.** Admission prevents execution of a composition known to require a
denied function. It does not guarantee successful execution, transactionality, rollback,
or exactly-once effects at a provider. Revocation cannot undo completed writes. Provider
sessions already issued to a browser have the separate limits in §7.

## 2. Identity, connections, and grants

**AUTH-01 — Independent identities.** Policy and Broker MUST authenticate the calling
service and enforce its role independently of the end user. Compiler callers are bound to
a language. End-user identity comes only from verified authentication, or a Policy-issued
authority explicitly representing a publication or system preview.

On Cloud Run, transport admission uses `X-Serverless-Authorization`; the application
separately verifies `X-Caller-Identity`, including issuer, audience, expiry, and verified
service identity, and checks consistency with the admitted caller. A stripped transport
token is not independently verifiable evidence of identity.

Only Console may manage connections and grants on a verified user's behalf. Only the
gateway may allocate user invocations, submit chain admissions, and manage publications.
Only the matching compiler may obtain its stage session and mint/spend execution tokens.
Only Broker may request execution-time authorization from Policy. Only Policy may provision
Broker credentials. Public compiler endpoints do not confer protected authority.

**CONN-01 — Lifecycle.** A connection has an immutable ID, owner, backend, and provider
account identity. Creation activates it only after credential provisioning succeeds.
Rotation changes the secret for the same provider account and preserves grants; changing
owner, backend, or provider account requires a new connection and new grants. Disabling
refuses further authorization. Deletion revokes access, removes credentials and grants,
and leaves a permanent ID tombstone. Provisioning/deletion failures MUST NOT leave an
authorizable connection with invalid binding or revive a deleted ID.

**GRANT-01 — Scope.** Grants bind owner, connection, recipient account, exact
`(language, function)` pairs, and optional expiry. Only the owner may create, modify, or
revoke them. Recipients may inspect shared connections and leave, but cannot reshare,
rotate credentials, manage grants, or publish. Only registry functions marked `delegable`
may be granted. An empty permission set allows nothing. Item-level, group, organization,
and onward-delegation grants are outside this contract.

An implicit delegable preview function accompanies any granted function in its language
and may also be granted alone. This rule never introduces write or Author authority.
Owners have registered functions for their backend unless they restrict their own
permissions; an empty owner list allows nothing and an absent list restores the default.
Owner restrictions do not limit which otherwise-delegable functions they may share.

**GRANT-02 — Recipient resolution.** Sharing by email MUST NOT reveal whether an account
exists. Pending shares bind to a protected email identifier and can be claimed only after
trusted verification establishes the recipient owns that email. Claiming, editing, expiry,
and leaving MUST preserve the owner/connection binding.

## 3. Registry and credential boundary

**REG-01 — Reviewed authority.** One versioned registry defines language/function,
backend, operation names and kinds, explicit compiler tags, implicit behavior, delegability,
and view safety. Operation payload constraints form part of that version's security
contract. Policy and Broker independently enforce it. Compiler manifests, language overrides,
and programs cannot extend it. Security-relevant changes require review and a version bump.
Implicit functions MUST NOT perform writes. Every write requires an explicit source operation
or its documented normalization, visible to admission before execution.
Admission, sessions, execution tokens, and receipts carry its version. The baseline requires
an exact installed version match; mismatches fail before effects and never silently create
a new invocation. Older-version compatibility is not part of this baseline.

**SECRET-01 — Custody.** Broker stores credentials encrypted under a broker-only key,
authenticated against connection ID, owner, and backend. Before use it checks those bindings
and the immutable provider account identity. Its API supports create, rotate, and delete,
with no secret read-back. Console and Policy may handle credentials transiently for
provisioning but MUST NOT persist, log, or echo them. Credentials MUST NOT enter task ASTs,
compile configuration, compiler processes, artifacts, or browser output. Public provider
identifiers in signed requests are not secret signing credentials.

**ISOLATE-01 — Deployment boundary.** Compiler identities MUST NOT read Broker credentials
or keys, sign Policy tokens, impersonate privileged services, or alter their deployments/IAM.
Policy, Broker, and application stores require separate access boundaries. Compiler outbound
traffic MUST pass enforced controls preventing access to protected provider endpoints,
including alternate hosts, direct IPs, redirects, and unapproved proxies. A reviewed
destination allowlist is required; source-code conventions alone do not satisfy this rule.
Broker permits only registered destinations and operations, never an arbitrary proxy/signer.
Legacy provider credentials embedded in programs or available to compilers MUST be invalidated
at the provider, and obsolete secret/decryption-key access removed. Removing their use from
current code does not invalidate existing copies.

## 4. Invocation and chain-wide admission

**RUN-01 — Logical identity.** Before protected execution, the gateway allocates a durable
invocation from Policy. A user-scoped idempotency key binds task-chain revision, connection,
and all external input/options that affect execution. Equal keys and bindings reuse the
invocation; conflicting bindings are refused. An intentional rerun uses a new key. Callers
MUST preserve the original key for transport retries and recovery. A request without a key
starts a new invocation and MUST NOT be retried as though it had one.

Policy assigns a monotonically increasing sequence per recipient/task-chain/connection.
Stable stage IDs and call occurrences, including repeated-call indices, determine operation
IDs: `invocation/stage/occurrence`. Token IDs and task IDs alone are not write identities.

**ADMIT-01 — Complete preflight.** Before any stage executes, the gateway MUST resolve all
stages and collect a side-effect-free preflight manifest from each approved, immutable
compiler revision. Preflight uses the same normalization as execution, including legacy
save lowering, and scans every explicit protected node, even in dead code. It includes
implicit functions and conservative declarations of dynamically constructed protected
behavior. It cannot mint execution tokens, sign previews, or contact providers.

Preflight does not execute upstream stages to discover permissions. If complete protected
behavior cannot be declared without execution, the protected run is refused. Arguments may
be computed later but cannot introduce undeclared functions. Pure stages also provide a
manifest, possibly with no protected functions. An unavailable preflight or unsupported
compiler revision blocks the entire protected run.

**ADMIT-02 — One decision.** The gateway submits the complete ordered manifest to Policy,
bound to invocation, source/task identities, normalized program digests, compiler revisions,
connection, external input digest, and registry version. Policy validates every function
using one consistent read of relevant connection and grant state. Denying any stage denies
the entire chain. No transformer starts and no provider operation occurs before all stages
are admitted.

Policy durably binds the manifest to the invocation and issues an expiring admission proof.
The first successful admission fixes that plan. A retry may refresh proof after fresh
authorization but cannot replace the plan. If a pinned revision is unavailable, recovery
fails explicitly; changing revisions requires a deliberate new invocation.

**ADMIT-03 — Execution binding.** Each stage session references its admitted plan and stage.
Before execution the compiler checks its revision, normalized program digest, language,
stage, registry version, and required functions against that plan. Policy mints only admitted
functions. Changed, omitted, reordered, injected, or undeclared stages/functions fail closed.
The gateway stops later stages after an execution failure. Runtime validation, revocation,
and provider failures may still stop a run after earlier stages succeeded; their effects
remain recorded.

## 5. Tokens and live execution checks

**TOKEN-01 — Profiles.** Policy uses ES256 with fixed issuer `urn:graffiticode:policy`,
algorithm, explicit type, audience, expiry, issued-at time, key ID, and unique token ID.
Verification rejects missing required claims, invalid profiles, expired tokens, and lifetimes
exceeding the profile maximum.

- Invocation: `gc-invocation+jwt`, Policy audience, maximum 30 minutes.
- Admission: `gc-admission+jwt`, Policy audience, maximum 15 minutes; references a durable plan.
- Stage or restricted-preview session: `gc-session+jwt`, Policy audience, maximum 15 minutes.
- Execution: `gc-exec+jwt`, Broker audience, maximum 60 seconds; accepted once by Broker.

Policy audience is `urn:graffiticode:policy`; Broker audience is `urn:graffiticode:broker`.
Token expiry does not delete invocations or receipts. Refresh requires current authorization
and preserves logical identity.

Execution claims bind principal, owner, connection, backend, language, function, operation,
argument digest, registry version, session, operation ID, and authority provenance. User runs
carry their plan/stage; publication and system-preview claims carry the restricted authority
identifiers needed for live checks. Tokens cannot switch provenance. Argument digests use
SHA-256 over canonical JSON: sorted object keys, preserved array order, no whitespace,
omitted undefined object members, and null for undefined array entries. Reject inputs outside
serializable JSON. Compiler, Policy, and Broker use identical encoding.

**EXEC-01 — Independent verification.** Broker verifies caller language, execution token,
registry/function/operation/backend relationship, constrained payload, argument digest, and
credential binding. It atomically consumes the token ID before any effect. Reusing a consumed
token is refused; an authorized retry obtains a fresh token for the same operation ID.
Token expiry is checked independently of storage cleanup.

**EXEC-02 — Live authorization.** After local validation and durable write claiming where
applicable, Broker MUST obtain a fresh Policy authorization immediately before each provider
request or local signature issuance. Multi-request operations need a check before each step.
Receipt replay needs a check before returning its outcome. Decisions cannot be cached,
queued for later use, or reused for another step.

Policy verifies execution proof and re-reads current connection/owner/backend binding,
grant existence/scope/expiry or owner restrictions, admitted plan, registry compatibility,
and operation availability. Publication calls also require the live publication and preview
authority; system calls require the currently configured system connection and restricted
preview function. Broker identity is mandatory. Missing state, denial, token expiry, or
Policy unavailability prevents the next effect or replay. After waiting or retrying,
Broker obtains a fresh decision rather than relying on an earlier one.

**REVOKE-01 — Ordering.** Live checks use strongly consistent state: a revocation committed
before a check's authorization read is observed and denied. A check that wins the race may
authorize the immediately following dispatch. No distributed transaction with the provider
is promised; dispatched operations may finish. Revocation between steps prevents later steps,
leaving partial or uncertain outcomes as appropriate. Disabling, grant expiry/narrowing,
and unpublishing obey the same rule for the authority they remove.

## 6. Durable writes and recovery

**WRITE-01 — Receipts.** Before dispatching a write, Broker atomically claims a durable
receipt for its operation ID, bound to principal, owner, connection, language, function,
operation, registry version, argument digest, and admitted plan where applicable. Only one
claimant executes. Equal bindings return recorded outcomes after live authorization;
unequal bindings are refused. Pending claims block duplicate execution.

Persist step outcomes as they become known. Distinguish success, definite failure before
any effect, partial completion, and uncertainty. Timeout, process loss, lost response, or
an unrecognized provider result is not proof that no write occurred. Known completed steps
remain visible if a later step is uncertain. Revocation before first dispatch records no
provider effect; revocation after a completed step records partial completion. Uncertainty
takes precedence wherever an attempted effect cannot be resolved.

**WRITE-02 — No automatic repeat.** Retrying a completed, failed, partial, pending, or
uncertain operation does not re-execute it. Reconciliation may append a resolution only
with auditable provider evidence and must preserve the original receipt. Without evidence,
report uncertainty and require a deliberate new invocation, warning that effects may repeat.
Do not silently resume unfinished provider steps.

**RETAIN-01 — Indefinite retention.** Invocation records, idempotency bindings, admission
plans, receipt claims, and outcomes have no automatic expiry. Connection deletion does not
delete them. Token replay records may be cleaned up after token expiry because expired tokens
are independently rejected. Future receipt cleanup requires a revised contract with durable
expired-invocation rejection/tombstones verified before deletion; missing receipts must never
turn an old retry into a new write.

**RECOVER-01 — Artifact recovery.** The gateway atomically stores unsigned artifact content
and updates its current-selection pointer. It retries failed storage up to three times within
the request. If storage still fails, the response explicitly reports that the artifact was
not stored and preserves invocation/retry identity. It must not imply provider failure or
show an old artifact as the new result. Recovery repeats the same invocation and plan,
reauthorizes, replays receipts, and stores the artifact. Revocation blocks recovery; previous
effects remain recorded. There is no authority-bypassing recovery token or automatic new run.

## 7. Provider authority and L0176

**PROVIDER-01 — Integration contract.** Each operation has reviewed payload constraints,
destinations, credential identity rules, effect classification, and response/error
classification. Broker builds requests; callers cannot broaden them through identity,
security fields, arbitrary configuration, or destinations.

Signing returns provider authority to a browser. Each integration MUST record and test its
permitted actions/resources, request acceptance lifetime, established-session lifetime,
replay behavior, and available revocation mechanism. These limits must be finite, documented,
and release-verified using provider configuration where needed. A 60-second execution token
does not give a provider request a 60-second lifetime or make it single-use. Graffiticode
revocation stops new issuance after a denying live check; existing authority follows the
provider's documented rules. Such authority cannot enter reusable artifacts or shared caches.

**L0176-01 — Function boundaries.** `init` signs constrained Questions/Items previews and
is implicit for rendering, delegable, and view-safe. `save-to-itembank` writes question/item
records as drafts; it is delegable but not view-safe. Legacy literal save syntax is normalized
before preflight/execution; hidden write flags are refused. Saves grant neither publication
nor Author editing/deletion. Grants do not restrict individual item references. Every provider
write step obeys live authorization and receipt rules.

**AUTHOR-01 — Disabled until verified.** `author` is owner-only, non-delegable, and not
view-safe. Policy and Broker MUST reject it by default. Enable it only after integration
tests establish request shape, item/reference restrictions, edit/delete permissions, widget
restrictions, and PROVIDER-01 authority limits. Owner permissions cannot bypass this gate.
Mocked SDK tests do not establish provider compatibility.

## 8. Preview, artifact, and publication paths

**PREVIEW-01 — No user connection.** Compilation without a selected user connection cannot
write through user credentials or issue Author authority. It may obtain a restricted system
preview session through an authenticated compiler, without an end user or user invocation.
The Graffiticode-owned system connection authorizes only registry functions that are all
of implicit, signing, and view-safe. Ordinary owner/grant/publication paths cannot use it.
Policy rechecks configuration at mint and execution; each signing still needs an execution token.

Skipped protected user calls report function, occurrence, and `no-connection`, separately
from errors. Invalid programs still fail. Unavailable system signing returns unsigned output
with a reason, never a fallback to program credentials. Generation verification, error
correction, corpus checks, and eval select no user connection. A distinct authorized save/run
may subsequently execute a generated program. Selecting a connection alone does not run it.
Saving a version may be that action if the product exposes its write behavior and preserves
retry identity.

**ARTIFACT-01 — Private results.** Successful protected runs store unsigned artifacts bound
to recipient, owner, connection, task-chain revision, invocation, plan, and registry version.
Reject embedded signed requests or reusable authority. Current selection uses invocation
sequence, not completion time; an older run cannot displace a newer successful result.
Access needs the matching recipient and task authorization; identifiers alone grant nothing.
Once stored, an artifact's content is immutable: a retry may acknowledge identical content,
but cannot replace the artifact a publication already names. Differing output requires a new
invocation and, for published content, an explicit republish.
Protected chains bypass shared compile caches even without a selected user connection.
Responses carrying signed authority are not cacheable.

**READ-01 — Views and answers.** A private view loads an existing artifact and obtains
current preview authorization. Signing uses a fixed data-only program or equivalently
constrained operation unable to execute source. Missing/incompatible artifacts require an
explicit run, never automatic rebuild. Learner answers cannot rerun saves; required protected
answer operations need separate registered authority. Reads cannot fall back to source
execution when authorization or artifact selection fails.

**PUB-01 — Owner-only publication.** A publisher owns the active connection, has current
preview permission and task-publishing access, and names their own compatible current
artifact. The publication pins that artifact and task revision. Grant recipients cannot
publish. Republish explicitly selects a new artifact.

Published views use publication authority, possibly anonymously, and only view-safe functions.
Artifact, task revision, connection, publisher, and owner must match. Policy rechecks publication
and preview authority on view, mint, and execution. Unpublishing/disable stops future
authorization; issued provider sessions retain PROVIDER-01 limits. Views never grant writes.
These constrained view paths do not rerun admission for the original chain: they authorize
only preview operations on stored content.

## 9. Interfaces and failures

The additions below are required interfaces, not claims about current routes. Use the
existing success/error envelope. Authority travels in trusted context, not program options.
Ordinary unprotected compilation remains compatible.

**API-01 — Preflight and admission.** Add compiler `POST /preflight` for the authenticated
gateway. Input names stage, language, source program, and compile options. Return validation
errors or a manifest with stage, source digest, normalized program digest, immutable compiler
revision, registry version, and required functions. The gateway supplies task identity and
complete ordering, obtains manifests directly from approved services, never trusts a client's
manifest, and pins the same revisions for execution. Protected language overrides require
these approval/identity checks or are refused.

Add gateway-only Policy `POST /v1/admissions` with invocation token and complete ordered
manifest. Return `admissionToken` and `planDigest` only on complete admission. Persist the
full plan server-side; tokens reference its digest. Use TOKEN-01 canonicalization for plans
and programs too. Extend compile context and user-run `POST /v1/snapshot` with admission
proof and stage/program/revision binding. Snapshots may narrow, never extend, admission.
Mint and execution inherit its binding. Publication/system sessions keep separate provenance.

**API-02 — Broker authorization.** Add Broker-only Policy `POST /v1/authorize-execution`.
Input includes execution token, validated operation and argument digest, Broker-derived step
identifier, and purpose `dispatch`, `sign`, or `replay`. Policy checks token, binding,
registered step/purpose, and live state. Return an auditable decision ID or denial; the
response is neither transferable nor cacheable. The execution token retains its Broker
audience; this route explicitly revalidates that profile rather than relaxing audience
validation generally. Extend caller configuration/IAM so Broker can invoke this role at
Policy, never grant management or minting.

**FAIL-01 — Failures.** Distinguish authentication, permission denial, malformed requests,
plan/idempotency conflicts, and unavailable dependencies. Identify failed stage/function or
provider step without exposing credentials/payloads. Report partial or uncertain effects even
when the immediate cause is revocation or dependency loss. Clients cannot automatically
replace a denied, failed, or uncertain invocation with a new one. Denied invocations cannot
be answered from shared cached results.

**AUDIT-01 — Evidence.** Audit admission, mint, execution decisions, receipt replay, provider
outcomes, reconciliation, publication, and connection/grant changes. Include decision IDs,
invocation/operation correlation, registry version, outcome/reason, and pseudonymous principal
and owner identifiers. Never log raw tokens, secrets, emails, wallet addresses, prompts,
source, argument values, or provider bodies. Record known prior effects when later steps fail.
Receipts are protected application data, not public logs. Monitor denial, authorization
outage, uncertain writes, and artifact failure separately; HTTP success is not provider success.

## 10. Migration and release

**RELEASE-01 — Coordinated enforcement.** Implement/test Policy and registry contracts,
Broker checks, compiler preflight/binding, and gateway coordination before enabling the
stronger contract. Identify this admission/execution contract as version 2, distinct from the
registry version; proofs carry it and all consumers reject unsupported contract versions.
Subsequent incompatible format changes require a contract version increment. Cutover
rejects old sessions/execution tokens without required binding: drain or invalidate old
proofs rather than retain a bypass. Keep existing receipts/artifacts. Old invocations without
pinned plans cannot resume protected execution under the new contract; report incompatibility
and require an explicit new run with a duplicate-effect warning.

Restricted preview/publication proofs also require execution-time checks and provenance.
Registry-incompatible artifacts need a new authorized run before republishing. Rollback keeps
protected execution disabled if required checks would be lost. There is no silent fallback
to stage-only admission, mint-only revocation, or legacy credentials.

Claim production conformance only after acceptance checks pass against deployed revisions
and isolation configuration. Record dates, revisions, and evidence in the conformance record.
Provider limits and Author enablement need real integration evidence. Documentation changes
do not themselves enable or disable operations.

## 11. Acceptance scenarios

These are release checks. Unit, integration, emulator, and deployed negative tests cover
different boundaries; mocks do not replace provider validation.

- **AT-01 (MODEL-01, MODEL-02, AUTH-01):** Forged user context, wrong caller role/language,
  missing service identity, mismatched transport identity, and direct compiler requests
  without authority cannot mint or execute protected operations.
- **AT-02 (CONN-01, GRANT-01, GRANT-02):** Test exact language/function scope, implicit preview,
  owner restrictions, expiry, revoke, leave, verified pending-email claim, no account
  enumeration, no onward sharing, rotation account changes, provisioning failures, and ID reuse.
- **AT-03 (ADMIT-01, ADMIT-02, API-01):** Deny the final stage when the first would save:
  zero transformations, signatures, and provider requests. Include dead-code calls, implicit
  behavior, legacy lowering, unavailable preflight, and undeclarable dynamic protected behavior.
- **AT-04 (ADMIT-03, REG-01, TOKEN-01):** Change source, options, revision, ordering, language,
  registry, plan digest, or required functions after admission: refuse mismatches. Test token
  type/audience substitution, missing claims, excessive lifetime, tampered args, token replay,
  and canonical-digest agreement across components.
- **AT-05 (EXEC-01, EXEC-02, REVOKE-01, API-02):** Mint, commit revocation, then execute:
  zero effects. Repeat for expiry, owner narrowing, disable, unpublish, and system-connection
  replacement. Policy outage prevents dispatch, signing, and receipt replay. Decisions cannot
  authorize a later step.
- **AT-06 (MODEL-03, WRITE-01, FAIL-01):** Revoke between provider writes: first effect remains,
  second never starts, report partial. Lose a response or crash after dispatch: report
  uncertainty with known completed steps. Test the authorization/dispatch race without
  asserting rollback or instantaneous cancellation.
- **AT-07 (RUN-01, WRITE-01, WRITE-02, RETAIN-01):** Race fresh tokens for one operation,
  retry after response loss, reuse a key with changed input, and replay after revocation:
  one claimant, stable binding, no automatic repeat, and no expiry of invocation/receipt
  identities. A deliberate new invocation may write again.
- **AT-08 (RECOVER-01, ARTIFACT-01):** Exhaust artifact storage retries after a successful
  write: report missing artifact and original retry identity. Recover with the same plan
  without repeating writes. Test revoked recovery, unavailable pinned revisions,
  cross-account/connection denial, signed-content rejection, slow-old-run ordering, and
  changed retry output that would otherwise overwrite a published artifact.
- **AT-09 (PREVIEW-01, READ-01, PUB-01):** System previews cannot save or issue Author authority.
  Missing configuration returns unsigned output. Private/anonymous published views use stored
  content; repeated views/answers never repeat saves. Missing artifacts do not rebuild.
  Recipients cannot publish; unpublishing blocks issuance.
- **AT-10 (PROVIDER-01, L0176-01, AUTHOR-01):** Against the provider, verify draft-only saves,
  preview scope, request/session lifetimes, replay, and revocation limits. Prove Author denial
  by default; require real edit/delete/reference/widget tests before enabling it.
- **AT-11 (SECRET-01, ISOLATE-01):** As deployed compiler identities, attempt direct provider
  access, alternate paths/proxies, secret/key/database access, impersonation, and deployment
  changes. Forbidden paths fail. Verify legacy provider credentials no longer work.
- **AT-12 (AUDIT-01, RELEASE-01):** Inspect audit correlation/redaction for success, denial,
  partial outcomes, and outages. Exercise mixed-version cutover/rollback: protected calls
  fail closed, old receipts survive, and old proofs cannot bypass the new checks.
