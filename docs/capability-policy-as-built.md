# Capability security conformance record

Assessment date: 2026-10-02; W1 entries updated for the v6 release, 2026-10-05. Source: local working trees and the dated evidence cited below.

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
  check. Since v6 (2026-10-05) one profile schema drives both issuance and verification:
  each profile's typed claims, a `kid` the JWKS names, `jti`, `iat` not in the future (10 s
  skew), and `exp - iat` within the profile maximum; caller-set registered claims are refused.
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
  outcomes. Since v6 each completed provider step is persisted (`receipts/{id}/steps/{n}`)
  before the next provider request; a step that cannot be recorded stops the operation as
  uncertain, and a replay without a final outcome reports the persisted steps (verified in
  production, section 4). Live replay authorization and evidence-based reconciliation are
  missing. No exactly-once provider guarantee exists.
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
  through same-invocation receipt replay exist. Since v6 a compile whose artifact is not
  stored returns `artifact: { stored: false, error, reason, retryable, invocationId, seq,
  idempotencyKey }` beside the result (`artifact-storage-unavailable` after three attempts,
  or `artifact-rejected`). Pinned-plan recovery is missing.
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
- **Partial / provider unverified — AUTHOR-01.** Since v6 Author is deny-by-default: the
  registry marks it `requiresEnablement`, Policy refuses it (`fn-not-enabled`) unless
  `POLICY_ENABLED_GATED_FUNCTIONS` names it, and Broker omits and refuses its operation
  (`operation-not-enabled`) unless `BROKER_ENABLED_GATED_OPERATIONS` does. Both are empty in
  production. Enabling it waits on AT-10 provider evidence for its request shape.
  Evidence: [Author operation](../packages/broker/src/operations.js),
  [Policy](../packages/policy/src/policy.js) and
  [registry](../packages/common/src/protected-registry.ts).
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
  view-safe functions. Since v6 the artifact store acknowledges a repeated put only for the
  same canonical content and bindings and otherwise refuses (`ArtifactConflict`), so the
  artifact a publication names cannot be replaced. Plan binding
  and execution-time revalidation are missing. Complete
  learner-answer routing and deployed cross-account behavior remain unverified.
  Evidence: [read path](../packages/api/src/read.js),
  [artifact storage](../packages/api/src/storage/artifacts.js),
  [publication tests](../packages/api/src/publication.spec.js), and
  [Policy](../packages/policy/src/policy.js).

### Secrets, isolation, audit, and rollout

- **Partial — SECRET-01.** Broker encrypts secrets with connection/owner/backend associated
  data and checks owner/backend at execution. Rotation preserves provider key identity.
  L0176 no longer reads legacy program/config credentials. The legacy `get-val-private`
  shared-secret path is retired: no service mounts the key, and the key is destroyed (see the
  inventory below). Deployed ISOLATE-01 controls and AT-11 remain open. Evidence:
  [secret storage](../packages/broker/src/firestore.js),
  [rotation rules](../packages/broker/src/stores.js), and [deployment manifest](../deploy.json).

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
  - Follow-ups (not SECRET-01 blockers): remove the inert keyring `decrypt` from l0000 core
    (`compiler.ts`); review project-level Editor on the graffiticode-app default compute
    account; delete stale local `.env.local` copies of the destroyed key.
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
  Author that refusal does not isolate the AUTHOR-01 gate; the gate's own evidence is the
  Policy and Broker tests until the canary gains an Author-denied check.
- Not yet done: a live 503 `maintenance` refusal (the canary does not exercise it) and the
  24 h soak.

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
