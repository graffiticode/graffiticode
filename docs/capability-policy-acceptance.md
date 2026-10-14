# Capability security acceptance run (W5 stage 5)

Run 2026-10-14 against the spec's AT-01 to AT-12
([spec](graffiticode_capability_policy_spec.md#11-acceptance-scenarios)). **AT-11 is excluded**: it
waits for ISOLATE-01, which is deferred. The rest of this record is
[the as-built record](capability-policy-as-built.md).

Each clause was mapped to the automated tests that check it, and those tests run in CI. Live
evidence came from the deployed services. Statuses:
- **Covered:** a test checks the property itself.
- **Partial:** only some cases are tested, or the property is only implied.
- **Gap:** no test.

Jeff accepts the production evidence. The agent did the mapping and the checks.

## Revisions and live evidence

| Service | Serving revision | `release-check` |
| --- | --- | --- |
| Policy | `policy-rmv8e1zrv-84fd65` | ok |
| Broker | `broker-rmv8dr19j-3ef04d` | ok |
| api | `api-rmv8arq72-a4cb45` | ok |
| l0000 | `l0000-rmv5mguhi-2678e5` | ok |
| l0176 | `l0176-rmv77l8sj-2e0569` | ok |

- **Source:** main at `caa0139`. CI passed on the last code commits, `9469b28` and `1820f8b`.
- **Canary**, 2026-10-14 20:19Z, using the canary account and its sandbox connection only:
  ```sh
  node scripts/canary.js --uid 995cc0bc… --connection conn-686c62bc… --chain-admission --after-cutover --reconcile
  ```
  Result: **passed (24 checks)**. The checks covered:
  - chain admission (pinned);
  - the denied final stage;
  - gateway write and its retry;
  - retry across a deploy;
  - token and receipt replay;
  - the revocation probe (minted, then narrowed; replay after narrowing);
  - v1 refused;
  - Author removed;
  - reconcile: `applied`, with 2 records carrying the mark.
- **AUDIT-01, deployed (W5 stage 1):**
  - categorized refusal records were seen on the enforcing revisions;
  - each alert policy (outage, uncertain, partial, artifact storage, permission denial) was
    triggered and its delivery confirmed by nonce.
- **RETAIN-01, deployed (W5 stage 2):**
  - `scripts/retention-check.js` passes against production: no TTL on a protected
    collection, PITR at 7 days, daily backups kept 14 weeks, on all four databases.
  - **The restore test is still to run**, once the first daily backups exist.

## Results

| AT | Requirements | Verdict | Open items |
| --- | --- | --- | --- |
| AT-01 | MODEL-01/02, AUTH-01 | **Pass** | Broker has no invoker-mismatch test (Policy has one) |
| AT-02 | CONN-01, GRANT-01/02 | **Open** | Account enumeration; verified-email claim; leave; provisioning failure |
| AT-03 | ADMIT-01/02, API-01 | **Pass** | Undeclarable behavior is refused at preflight; no gateway-level test |
| AT-04 | ADMIT-03, REG-01, TOKEN-01 | **Open** | L0000's canonical vectors drifted; language changed after admission |
| AT-05 | EXEC-01/02, REVOKE-01, API-02 | **Pass** | Single sub-cases (below) |
| AT-06 | MODEL-03, WRITE-01, FAIL-01 | **Pass** | None |
| AT-07 | RUN-01, WRITE-01/02, RETAIN-01 | **Pass, pending restore** | RETAIN-01's restore test |
| AT-08 | RECOVER-01, ARTIFACT-01 | **Pass** | Cross-account denial isn't tested on the recovery path itself |
| AT-09 | PREVIEW-01, READ-01, PUB-01 | **Partial** | Repeated views and answers never repeating saves is implied, not tested |
| AT-10 | PROVIDER-01, L0176-01 | **Open** | No provider-side evidence for lifetimes, replay, revocation or preview scope |
| AT-11 | SECRET-01, ISOLATE-01 | **Deferred** | The ISOLATE-01 plan (self-hosted egress proxy) is deferred |
| AT-12 | AUDIT-01, RELEASE-01 | **Pass** | Old receipts are shown never to re-execute, not still to be reportable |

## Detail

Short names in the evidence:

| Name | Path |
| --- | --- |
| pol/ | `packages/policy/src/` |
| brk/ | `packages/broker/src/` |
| api/ | `packages/api/src/` |
| com/ | `packages/common/src/` |
| l0/ | `languages/l0000/packages/core/src/` |
| l176/ | `languages/l0176/packages/core/src/` |
| scr/ | `scripts/test/` |

Test names are quoted from the specs.

### AT-01: unauthorized callers: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Forged user context | Covered | pol/app.spec "requires a verified user"; api/at12.spec bad user token; l0/exec-context.test "programs cannot reach the ExecContext" |
| Wrong caller role | Covered | pol/app.spec "route authorization by caller"; brk/app.spec "refuses policy on the execute route", "refuses compilers" |
| Wrong caller language | Covered | pol/app.spec "binds a compiler to its own language"; brk/app.spec "…spent by another language's compiler" |
| Missing service identity | Covered | pol/app.spec "refuses a missing caller identity", "…unknown service account"; l0/preflight.test anonymous caller |
| Mismatched transport identity | Partial | pol/app.spec "…differs from the invoker", "…for another audience", "…unsigned, crafted caller identity". Broker only tests the wrong audience |
| Direct compiler requests without authority | Covered | pol/policy.spec "must come from a policy invocation token…"; brk/app.spec "refuses a request with no execution token"; l0/protected-client.test; l176/brokered.test |

### AT-02: connections and sharing: Open

| Clause | Status | Evidence |
| --- | --- | --- |
| Exact language/function scope | Covered | pol/delegation.spec "permissions are (language, function) pairs" |
| Implicit preview | Covered | delegation.spec "can grant rendering alone: previews, never a save" |
| Owner restrictions | Covered | delegation.spec owner's permissions; brk/live.spec owner narrowing. Live: canary revocation probe and denied final stage |
| Expiry, revoke | Covered | delegation.spec "stops the recipient's next call once revoked or expired"; pol/live.spec "grant expired" |
| Leave | Partial | delegation.spec only checks the recipient's list is empty, not that their next snapshot or mint is refused |
| Verified pending-email claim | Partial | Policy's claim by hash is tested. The console's `verifiedEmailHashes` (`graffiticode-app/packages/console/src/lib/connection-sharing.ts`), which must send only verified emails, has no test |
| No account enumeration | **Gap** | No test. An email share's `pending` flag in the owner's grant list (`ConnectionGrant.pending`, console `pages/api/index.ts`) shows whether that email has an account. The account-ID share's "No account has that ID." needs a 40-hex ID, so it can't be used to enumerate |
| No onward sharing | Covered | delegation.spec "…a recipient cannot reshare" |
| Rotation account changes | Covered | pol/manage.spec "…a different provider account"; brk/app.spec "keeps owner, backend and provider account immutable…" |
| Provisioning failures | Partial | manage.spec covers bad input. A Broker secret created before a failed Policy write is left behind, untested |
| ID reuse | Covered | brk/app.spec "…and never reuses an id" |

### AT-03: chain denial before any effect: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Deny the final stage: zero transformations, signatures, provider requests | Covered | api/w4-cross.spec "denies the final stage before an earlier one runs…"; pol/admissions.spec. Live: canary denied final stage |
| Dead-code calls | Covered (unit) | l0/preflight.test "names every explicit protected node, dead code included…"; l0/protected-functions.test |
| Implicit behavior | Covered | l0/protected-functions.test; l176/preflight.test "…implicit init included" |
| Legacy lowering | Covered (unit) | l176/preflight.test legacy save member form; l176/save-boundary.test |
| Unavailable preflight | Covered | w4-cross.spec "an unavailable preflight blocks the chain…"; api/w4.spec |
| Undeclarable dynamic behavior | Partial | l0/preflight.test "refuses undeclarable protected behaviour"; l176/brokered.test Author activity as data. No gateway test that an `undeclarable-protected` preflight blocks the chain |

### AT-04: bindings and tokens: Open

| Clause | Status | Evidence |
| --- | --- | --- |
| Source, options, revision, ordering changed | Covered | w4.spec; l0/preflight.test `bindingProblems`; admissions.spec "refuses stages out of order". Live: canary retry across a deploy |
| Language changed | Partial | Checked at admission and preflight only. No test changes `lang` in the binding after admission |
| Registry, plan digest, required functions | Covered | admissions.spec (registry rows, plan, functions); brk/broker.spec "…minted for another registry version" |
| Token type/audience substitution, missing claims, excessive lifetime | Covered | pol/policy.spec (typ, missing claim, profile lifetime caps); brk/live.spec "refuses a token without prv" |
| Tampered arguments | Covered | broker.spec "rejects a payload other than the one the token was minted for"; pol/authorize.spec |
| Token replay | Covered | broker.spec; brk/app.spec; brk/firestore.spec "claims a jti once, even under concurrency". Live: canary token replay |
| Canonical digest agreement | Partial | com/ and brk/ share `CANONICAL_VECTORS`. `l0/canonical.test.ts` keeps a hand-copied list of 4 of the 5 vectors, missing `d5878057…`, and nothing compares it with the shared set. Live: the canary's pinned admission, gateway write and token first use agree |

### AT-05: authority removed after mint: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Mint, revoke, execute: zero effects | Covered | brk/live.spec "AT-05: authority removed after mint…" (write and signature) |
| Expiry | Partial | live.spec covers writes, not signatures |
| Owner narrowing | Covered (write) | live.spec. Live: canary revocation probe |
| Disable | Covered | live.spec, write and signature |
| Unpublish, system-connection replacement | Covered (signature) | live.spec; pol/policy.spec. These apply to signatures only, so that is full coverage |
| Policy outage | Covered | live.spec "Policy unavailable…" (dispatch, signing, receipt replay); api/at12.spec |
| No decision reuse | Covered | live.spec "…never reuses a decision"; authorize.spec; pol/app.spec "…never caches the decision" |

### AT-06: partial and uncertain writes: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Revoke between writes | Covered | live.spec "keeps the first effect, never starts the second, and reports partial"; at12.spec; w3.spec |
| Lost response or crash | Covered | live.spec; broker.spec "…never finished as uncertain", "…stopped between steps"; at12.spec |
| Authorization/dispatch race | Covered | live.spec "lets a step authorized before the revocation dispatch, and stops the next", with no rollback asserted |

### AT-07: one execution per operation: Pass, pending restore

| Clause | Status | Evidence |
| --- | --- | --- |
| Racing fresh tokens: one claimant | Covered | broker.spec "executes once when two fresh tokens for one operation race"; firestore.spec. Live: canary receipt replay (sequential) |
| Retry after response loss: no automatic repeat | Covered | broker.spec; recovery.spec "blocks the retry of an uncertain save…"; l176/brokered.test |
| Key reused with changed input | Covered | policy.spec; broker.spec; w4-cross.spec |
| Replay after revocation | Covered | live.spec; w4-cross.spec. Live: canary replay after narrowing |
| Stable binding | Covered | policy.spec; w4-cross.spec. Live: canary gateway write retry, retry across a deploy |
| Identities never expire | Covered, restore pending | brk/retention.spec (emulator) survival after connection deletion; scr/retention.test; deployed `retention-check` (no TTL on a protected collection; PITR and backups). The restore test is outstanding |
| A deliberate new invocation writes again | Covered | broker.spec "writes again for an intentional rerun"; recovery.spec |
| Reconciliation (WRITE-02) | Covered | brk/ and pol/ reconcile.spec; broker.spec evidence and mark tests. Live: canary reconcile `applied` |

### AT-08: artifact recovery: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Storage retries exhausted | Covered | recovery.spec "reports, beside the result, an artifact it could not store, with the retry identity" |
| Recover with the same plan, no repeated writes | Covered | w4-cross.spec; recovery.spec |
| Revoked recovery, unavailable pinned revisions | Covered | recovery.spec; w4-cross.spec "can't recover against a revision retired since…"; admissions.spec |
| Cross-account/connection denial | Partial | artifacts.spec, read.spec and policy.spec cover each piece. No recovery-path test with another user |
| Signed-content rejection | Covered | api/data.spec |
| Slow-old-run ordering, changed retry output vs a publication | Covered | artifacts.spec; recovery.spec |

### AT-09: previews and published views: Partial

| Clause | Status | Evidence |
| --- | --- | --- |
| System previews can't save; no Author authority | Covered | policy.spec "never mints a write or Author signing"; l176/brokered.test "a system session never writes" |
| Missing configuration is unsigned | Covered | brokered.test; policy.spec |
| Private/anonymous views use stored content | Covered | publication.spec; read.spec "…with a data-only program, never the source" |
| Repeated views/answers never repeat saves | Partial | Implied by the data-only program, and by policy.spec "…the publisher's preview signing, and nothing else". No repeated-view count; no learner-answer test |
| Missing artifacts don't rebuild | Covered | read.spec |
| Recipients can't publish; unpublishing blocks issuance | Covered | delegation.spec; pol/live.spec; policy.spec; publication.spec |

### AT-10: against the provider: Open

| Clause | Status | Evidence |
| --- | --- | --- |
| Draft-only saves | Partial | broker.spec "never publishes" (status `unpublished` enforced); l176/itembank.test. The canary writes to the sandbox but doesn't read the stored status back |
| Preview scope | Unit only | broker.spec "signs a constrained preview…", "rejects a payload carrying identity or config fields" |
| Request/session lifetimes | **Gap** | Preview signing (`brk/operations.ts`) sets no `expires` on the security packet, so the lifetime is whatever Learnosity applies to the timestamp. Not verified |
| Provider replay | **Gap** | Only Graffiticode's own token and receipt replay is tested |
| Revocation limits | **Gap** | Not tested: what a signed request still allows after a grant is revoked |

The 2026-10-14 sandbox spike established only that the `gc_operation` mark persists and that
there is no job lookup. PROVIDER-01 stays provider-unverified.

### AT-12: audit and mixed versions: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Correlation: success, denial, partial, outage | Covered | api/at12.spec (each case); pol/correlation.spec; brk/live.spec; broker.spec maintenance |
| Redaction | Covered | at12.spec `afterEach` scans every record for the markers; pol/audit.spec pseudonymization; broker.spec "…without tokens, secrets or raw ids" |
| Categories (AUDIT-01) | Covered | pol/audit.spec categories; scr/failures-inventory.test. Live: categorized records on deployed revisions; alerts delivered |
| Cutover/rollback fails closed | Covered | scr/at12-rollback.test (both directions, `release-check` below W4) |
| Old receipts survive | Partial | at12-rollback shows W3 receipts are never re-executed; live.spec "replays an older receipt without the new fields". No check that the W3 receipt is still reportable after rollback |
| Old proofs can't bypass new checks | Covered | at12-rollback; admissions.spec v1 refusal; w4-cross.spec. Live: canary v1 refused |

## Gaps, most important first

1. **AT-10, provider behavior:**
   - preview signature lifetime, which today has no `expires`;
   - provider-side replay;
   - what a signed request allows after revocation;
   - preview scope against the sandbox.

   This needs sandbox tests, and possibly an `expires` on preview signing.
2. **AT-02, account enumeration:** the owner's grant list shows `pending`, which reveals
   whether an email has an account. Fix in the console, and add a test.
3. **AT-02, verified-email claim:** add a test for `verifiedEmailHashes`.
4. **AT-07 / RETAIN-01, restore test:** run it once the first daily backups exist.
5. **AT-04, canonical vectors:** L0000's test is missing one vector. Import or check against
   `CANONICAL_VECTORS` (an l0000 release).
6. **AT-12:** show that a W3 receipt is still reportable after rollback.
7. **AT-02:** a failure partway through provisioning leaves a Broker secret behind.
8. **AT-09:** a test that repeated views and answers never save.
9. **AT-03:** a gateway test that an `undeclarable-protected` preflight blocks the chain.
10. **AT-04:** a test that changes the language after admission.
11. **AT-02:** a test that a recipient who left is refused at the next snapshot or mint.
12. **Single sub-cases:**
    - AT-05 signature expiry;
    - AT-01 Broker invoker mismatch;
    - AT-08 cross-account recovery.

Live coverage doesn't reach AT-01, AT-06, AT-08 or AT-09's save prohibition. These rest on
CI tests.
