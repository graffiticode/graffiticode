# Capability security conformance record

Assessment date: 2026-10-02. Source: local working trees and the dated evidence cited below.

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
[Policy](../packages/policy/src/policy.js), [Broker](../packages/broker/src/broker.js),
[L0176 protection](../languages/l0176/packages/api/src/protection.ts), and
[L0176 dependency manifest](../languages/l0176/packages/core/package.json).

## 2. Conformance by subsystem

### Identity, grants, and registry

- **Implemented baseline; stronger flow pending — MODEL-01, MODEL-02, AUTH-01.** Service
  identity is separately verified and bound to roles/languages; end-user identity comes
  from verified authentication. Program context is separated from authorization context.
  The new Broker-to-Policy execution authorization role and gateway preflight role are missing.
  Evidence: [caller verification](../packages/policy/src/caller.js),
  [Policy routes](../packages/policy/src/app.js), [Broker routes](../packages/broker/src/app.js),
  and [execution context](../languages/l0000/packages/core/src/exec-context.ts).
- **Implemented core controls — CONN-01, GRANT-01, GRANT-02.** Owner management, exact
  language/function permissions, implicit previews, optional expiry, pending email claims,
  no onward delegation, owner restrictions, immutable account rotation, and deletion
  tombstones are present. Provisioning/deletion failure ordering and deployment behavior
  require full acceptance validation; local tests are not a distributed failure audit.
  Evidence: [management](../packages/policy/src/manage.js),
  [delegation tests](../packages/policy/src/delegation.spec.js),
  [secret store](../packages/broker/src/stores.js), and
  [Firestore secret storage](../packages/broker/src/firestore.js).
- **Partial — REG-01.** The authoritative registry is version 5. Policy checks session
  version at mint and Broker checks execution/receipt version. Exact matching exists;
  chain plan binding and registered execution-step authorization are missing.
  Evidence: [registry](../packages/common/src/protected-registry.js),
  [Policy](../packages/policy/src/policy.js), [Broker](../packages/broker/src/broker.js).

### Chain admission and live execution authorization

- **Partial — RUN-01.** User-scoped idempotency keys bind task, connection, and the gateway's
  options digest. Policy allocates sequences and stores invocations; stages and occurrence
  IDs bind receipt identities. The new complete execution-input and immutable plan contract
  still needs implementation/verification. Evidence:
  [gateway allocation](../packages/api/src/invocations.js),
  [Policy invocation storage](../packages/policy/src/firestore.js), and
  [compiler client](../languages/l0000/packages/core/src/protected-client.ts).
- **Missing — ADMIT-01, ADMIT-02, ADMIT-03, API-01.** Admission is per compiler stage.
  Gateway `reduceRight` executes a stage before starting the next; there is no all-stage
  preflight, consistent chain admission decision, durable pinned plan, or admission proof.
  An earlier stage can write before a later stage discovers a denied function.
  Existing tag scanning includes dead code and declared implicit behavior within a stage.
  Evidence: [gateway](../packages/api/src/data.js),
  [admission scan](../languages/l0000/packages/core/src/protected-functions.ts), and
  [compiler](../languages/l0000/packages/core/src/compiler.ts).
- **Partial — TOKEN-01, EXEC-01.** Invocation/session/execution profiles, fixed ES256,
  issuer/audience/type, digest checks, caller-language binding, credential binding, and
  atomic token consumption exist. There is no admission profile or plan binding. Execution
  claims do not preserve publication/system provenance in the form needed for the new live
  check. Verification requires `jti` and `exp` but does not independently enforce every
  required claim or maximum lifetime from the revised specification.
  Evidence: [tokens](../packages/policy/src/tokens.js),
  [minting](../packages/policy/src/policy.js), [Broker](../packages/broker/src/broker.js), and
  [canonicalization](../packages/broker/src/canonical.js).
- **Missing — EXEC-02, REVOKE-01, API-02.** Live grant checks occur at mint. Broker has no
  Policy authorization dependency or check before each provider step, signature, or replay.
  A token minted before revocation can remain usable until expiry. Adding a route alone
  will not meet the contract: every operation step and receipt replay must use it.
  Evidence: [Broker execution](../packages/broker/src/broker.js) and
  [multi-step operations](../packages/broker/src/operations.js).

### Writes, retention, and recovery

- **Partial — MODEL-03, WRITE-01, WRITE-02, FAIL-01.** Receipt claims prevent duplicate
  execution; binding mismatches fail. Success, failed, partial, and uncertain outcomes are
  represented. Unknown provider responses are uncertain; same-key retries return recorded
  outcomes. Steps accumulate in process and are persisted with the final outcome, so a crash
  can lose known step detail. Durable incremental step evidence, live replay authorization,
  and evidence-based reconciliation are missing. No exactly-once provider guarantee exists.
  Evidence: [Broker](../packages/broker/src/broker.js),
  [provider response classification](../packages/broker/src/learnosity.js),
  [receipt store](../packages/broker/src/firestore.js), and
  [receipt tests](../packages/broker/src/broker.spec.js).
- **Partial / deployment unverified — RETAIN-01.** Invocation and receipt code has no
  automatic expiry. Token-ID documents carry an expiry field suitable for cleanup.
  Admission records do not exist. Indefinite retention configuration, backups, and actual
  database cleanup policies have not been verified in this review. Evidence:
  [Policy stores](../packages/policy/src/firestore.js) and
  [Broker stores](../packages/broker/src/firestore.js).
- **Partial — RECOVER-01.** Atomic artifact storage, three storage attempts, and recovery
  through same-invocation receipt replay exist. Exhausted storage attempts currently log
  an error and still return the compile result; they do not provide the required explicit
  artifact-storage failure response. Pinned-plan recovery is missing.
  Evidence: [gateway storage loop](../packages/api/src/data.js),
  [artifact store](../packages/api/src/storage/artifacts.js), and
  [recovery tests](../packages/api/src/recovery.spec.js).

### Provider authority, artifacts, and views

- **Partial / provider unverified — PROVIDER-01, L0176-01.** Broker has constrained preview,
  draft save, and Author operations. Saves make sequential provider requests. Preview/Author
  operations sign locally and return authority for browser SDK use. The repository does not
  establish the revised finite request/session lifetime and revocation acceptance criteria
  against the live provider. Evidence: [operations](../packages/broker/src/operations.js),
  [provider client](../packages/broker/src/learnosity.js), and
  [browser initialization](../languages/l0176/packages/view/src/components/form/Form.tsx).
- **Missing gate — AUTHOR-01.** Author is non-delegable and not view-safe, but an owner can
  reach its signer. The code explicitly labels its provider request shape unverified; there
  is no deny-by-default validation gate. Do not equate owner-only enforcement with conformance.
  Evidence: [Author operation](../packages/broker/src/operations.js) and
  [registry](../packages/common/src/protected-registry.js).
- **Partial — PREVIEW-01.** System preview sessions and separation from ordinary connection
  authority exist. L0176 ignores program credentials and reports unsigned preview failures.
  Saves without a connection expose a language-specific skip marker; the complete generic
  skipped-call reporting contract is not established. Execution-time revalidation is missing.
  Evidence: [Policy preview sessions](../packages/policy/src/policy.js),
  [L0176 compiler](../languages/l0176/packages/core/src/compiler.ts), and
  [brokered compiler tests](../languages/l0176/packages/core/src/brokered.test.ts).
- **Partial — ARTIFACT-01, READ-01, PUB-01.** Private artifacts, sequence-based selection,
  structural signed-request rejection, cache bypass, data-only preview signing, and owner-only
  publications exist. Publications pin an artifact; anonymous views are restricted to
  view-safe functions. The artifact store currently overwrites content for a repeated
  invocation ID; immutable content under a pinned publication is not enforced. Plan binding
  and execution-time revalidation are missing. Complete
  learner-answer routing and deployed cross-account behavior remain unverified.
  Evidence: [read path](../packages/api/src/read.js),
  [artifact storage](../packages/api/src/storage/artifacts.js),
  [publication tests](../packages/api/src/publication.spec.js), and
  [Policy](../packages/policy/src/policy.js).

### Secrets, isolation, audit, and rollout

- **Partial — SECRET-01.** Broker encrypts secrets with connection/owner/backend associated
  data and checks owner/backend at execution. Rotation preserves provider key identity.
  L0176 no longer reads legacy program/config credentials. Universal credential-path removal
  and provider invalidation are not established; the deployment manifest still mounts
  `GRAFFITICODE_SECRET_KEY` for L0176. Evidence:
  [secret storage](../packages/broker/src/firestore.js),
  [rotation rules](../packages/broker/src/stores.js), and [deployment manifest](../deploy.json).
- **Missing repo controls / deployment unverified — ISOLATE-01.** No compiler egress
  enforcement satisfying the new allowlist contract was found in the inspected deployment
  configuration. Historical IAM improvements do not establish current egress, secret-access,
  impersonation, and credential invalidation guarantees. See §4 below.
- **Partial — AUDIT-01.** Audit records allowlist fields and pseudonymize user/owner IDs.
  Required decision/plan/invocation/operation correlation and new authorization events need
  additions. Deployed log coverage and redaction across services remain unverified.
  Evidence: [audit implementation](../packages/policy/src/audit.js).
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
  and broad legacy build permissions. Their present state needs verification.

The current `deploy.json` wires gateway/L0176 to Policy, L0176 to Broker, and a system
connection into Policy. Configuration intent does not prove a deployment uses it. Refresh
live identity, database, token-key, secret, egress, provider-session, and rollback evidence
before claiming production conformance. Keep old observations dated rather than rewriting
historical records as current facts.

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

The spec's AT-01 through AT-12 are the release acceptance backlog. In particular:

- AT-03/04 need new complete-chain admission, immutable-plan, and proof-substitution tests.
- AT-05/06 need revocation-after-mint, per-step live checks, outage, and race tests.
- AT-07/08 need durable step evidence, retention checks, pinned recovery, and explicit
  artifact-storage failure tests in addition to existing receipt/recovery coverage.
- AT-09/10 need full deployed view/answer and provider-session tests, plus the Author gate.
- AT-11/12 need deployed isolation negatives, legacy credential invalidation, audit
  correlation, and mixed-version cutover/rollback evidence.

Update this record when each requirement is implemented and tested. Record source revision,
command/environment, outcome, and date; retain the distinction between local implementation
and deployed verification.
