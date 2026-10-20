# Capability security acceptance run (W5 stage 5)

Run 2026-10-14 against the spec's AT-01 to AT-12
([spec](graffiticode_capability_policy_spec.md#11-acceptance-scenarios)). AT-11 was excluded then,
since it waited for ISOLATE-01. It ran on 2026-10-20 and passed with recorded residuals (its row,
below). The rest of this record is
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
| AT-01 | MODEL-01/02, AUTH-01 | **Pass** | None |
| AT-02 | CONN-01, GRANT-01/02 | **Pass** | Fixed 2026-10-14 and deployed: console `console-rmv8rkauu-336058`, Policy `policy-rmv8rkci1-bba5e2` |
| AT-03 | ADMIT-01/02, API-01 | **Pass** | None |
| AT-04 | ADMIT-03, REG-01, TOKEN-01 | **Pass** | None (both closed 2026-10-14) |
| AT-05 | EXEC-01/02, REVOKE-01, API-02 | **Pass** | None |
| AT-06 | MODEL-03, WRITE-01, FAIL-01 | **Pass** | None |
| AT-07 | RUN-01, WRITE-01/02, RETAIN-01 | **Pass** | None (the restore test passed 2026-10-16) |
| AT-08 | RECOVER-01, ARTIFACT-01 | **Pass** | None |
| AT-09 | PREVIEW-01, READ-01, PUB-01 | **Pass** | Learner answers aren't a gateway path (the Learnosity client handles them), so only views are tested |
| AT-10 | PROVIDER-01, L0176-01 | **Pass, with recorded residuals** (2026-10-18, registry v8) | Provider rotation documented, not measured; established-session lifetime documented, not measurable from the client; general Questions sessions possible under the previews-only consumer for 10 minutes (PROVIDER-01 revision) |
| AT-11 | SECRET-01, ISOLATE-01 | **Passed with recorded residuals (2026-10-20)** | Run `b492fffa1316be33` (one image, `at11-probe@sha256:2839d78d…`; evidence `.gc-deploy/at11/b492fffa1316be33/`). **All 62 compiler accounts passed:** the 36 in `deploy.json` passed the network matrix on their own class and the IAM probe; the 26 legacy ones passed the IAM probe, with their network under D6. The control passed in the same run. Network rows: 616 passed, 172 n/a, 4 residual (D2), none failed or void. **Residuals:** D2 (L0185's open fetches); D6 (the legacy compilers' network, a dated exception); the legacy sandbox Learnosity key, still accepted by the provider but reaching no student-facing item (Jeff, 2026-10-20) |
| AT-12 | AUDIT-01, RELEASE-01 | **Pass** | None |

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
| Mismatched transport identity | Covered | pol/app.spec "…differs from the invoker", "…for another audience", "…unsigned, crafted caller identity"; brk/app.spec "refuses a caller identity that differs from the invoker, spending nothing" |
| Direct compiler requests without authority | Covered | pol/policy.spec "must come from a policy invocation token…"; brk/app.spec "refuses a request with no execution token"; l0/protected-client.test; l176/brokered.test |

### AT-02: connections and sharing: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Exact language/function scope | Covered | pol/delegation.spec "permissions are (language, function) pairs" |
| Implicit preview | Covered | delegation.spec "can grant rendering alone: previews, never a save" |
| Owner restrictions | Covered | delegation.spec owner's permissions; brk/live.spec owner narrowing. Live: canary revocation probe and denied final stage |
| Expiry, revoke | Covered | delegation.spec "stops the recipient's next call once revoked or expired"; pol/live.spec "grant expired" |
| Leave | Covered | delegation.spec "stops the recipient's next call once they leave, and the owner's still work" |
| Verified pending-email claim | Covered | Policy's claim by hash (delegation.spec); console `connection-sharing.test.ts`: `verifiedEmailHashes` sends only verified emails, and nothing when the auth service is unreachable (graffiticode-app #10) |
| No account enumeration | Covered (graffiticode-app #10) | Found two leaks: the share dialogs' `findAccounts` search listed accounts by fragments of a name, email or ID, and an email share resolved to its account at once, so `pending` showed whether the email had one. Both removed: sharing takes an exact email (always pending by hash, never looked up) or an exact account ID. Console `connection-sharing.test.ts` (no lookup for an email share), `share-recipient.test.ts` (exact entries only). An exact account ID can still be checked for existence; IDs aren't secret and can't be listed |
| No onward sharing | Covered | delegation.spec "…a recipient cannot reshare" |
| Rotation account changes | Covered | pol/manage.spec "…a different provider account"; brk/app.spec "keeps owner, backend and provider account immutable…" |
| Provisioning failures | Covered | Fixed: a failed record write now deletes the Broker secret again (best effort) and audits `storage-failed`. manage.spec "deletes the secret again when the record can't be stored", "surfaces the store's error even when the cleanup fails", "stores no record when the broker refuses the secret" |
| ID reuse | Covered | brk/app.spec "…and never reuses an id" |

### AT-03: chain denial before any effect: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Deny the final stage: zero transformations, signatures, provider requests | Covered | api/w4-cross.spec "denies the final stage before an earlier one runs…"; pol/admissions.spec. Live: canary denied final stage |
| Dead-code calls | Covered (unit) | l0/preflight.test "names every explicit protected node, dead code included…"; l0/protected-functions.test |
| Implicit behavior | Covered | l0/protected-functions.test; l176/preflight.test "…implicit init included" |
| Legacy lowering | Covered (unit) | l176/preflight.test legacy save member form; l176/save-boundary.test |
| Unavailable preflight | Covered | w4-cross.spec "an unavailable preflight blocks the chain…"; api/w4.spec |
| Undeclarable dynamic behavior | Covered | l0/preflight.test "refuses undeclarable protected behaviour"; l176/brokered.test Author activity as data; w4-cross.spec "an undeclarable-protected preflight blocks the chain: zero transformations, signatures and provider requests" |

### AT-04: bindings and tokens: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Source, options, revision, ordering changed | Covered | w4.spec; l0/preflight.test `bindingProblems`; admissions.spec "refuses stages out of order". Live: canary retry across a deploy |
| Language changed | Covered | w4-cross.spec "a stage whose binding names another language once admitted is refused at its snapshot, and nothing runs", "a retry whose stage now reports another language is refused before admission…"; admissions.spec "refuses a manifest naming another language", "refuses another language's compiler presenting the stage"; l0/preflight.test "another language" row |
| Registry, plan digest, required functions | Covered | admissions.spec (registry rows, plan, functions); brk/broker.spec "…minted for another registry version" |
| Token type/audience substitution, missing claims, excessive lifetime | Covered | pol/policy.spec (typ, missing claim, profile lifetime caps); brk/live.spec "refuses a token without prv" |
| Tampered arguments | Covered | broker.spec "rejects a payload other than the one the token was minted for"; pol/authorize.spec |
| Token replay | Covered | broker.spec; brk/app.spec; brk/firestore.spec "claims a jti once, even under concurrency". Live: canary token replay |
| Canonical digest agreement | Covered | com/ and brk/ share `CANONICAL_VECTORS` (6 vectors). L0000's TypeScript (`l0/canonical.test.ts`) and Rust (`crates/core/src/canonical.rs`) copies carried only 4; both now carry all 6, and scr/canonical-vectors.test.js fails if either copy lacks one. Live: the canary's pinned admission, gateway write and token first use agree |

### AT-05: authority removed after mint: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Mint, revoke, execute: zero effects | Covered | brk/live.spec "AT-05: authority removed after mint…" (write and signature) |
| Expiry | Covered | live.spec "a write, the grant expired", "a signature, the grant expired" |
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

### AT-07: one execution per operation: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Racing fresh tokens: one claimant | Covered | broker.spec "executes once when two fresh tokens for one operation race"; firestore.spec. Live: canary receipt replay (sequential) |
| Retry after response loss: no automatic repeat | Covered | broker.spec; recovery.spec "blocks the retry of an uncertain save…"; l176/brokered.test |
| Key reused with changed input | Covered | policy.spec; broker.spec; w4-cross.spec |
| Replay after revocation | Covered | live.spec; w4-cross.spec. Live: canary replay after narrowing |
| Stable binding | Covered | policy.spec; w4-cross.spec. Live: canary gateway write retry, retry across a deploy |
| Identities never expire | Covered | brk/retention.spec (emulator) survival after connection deletion; scr/retention.test; deployed `retention-check` (no TTL on a protected collection; PITR and backups); **the restore test, 2026-10-16:** every protected record before the cutoff restored intact, with its links (see the as-built, RETAIN-01) |
| A deliberate new invocation writes again | Covered | broker.spec "writes again for an intentional rerun"; recovery.spec |
| Reconciliation (WRITE-02) | Covered | brk/ and pol/ reconcile.spec; broker.spec evidence and mark tests. Live: canary reconcile `applied` |

### AT-08: artifact recovery: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Storage retries exhausted | Covered | recovery.spec "reports, beside the result, an artifact it could not store, with the retry identity" |
| Recover with the same plan, no repeated writes | Covered | w4-cross.spec; recovery.spec |
| Revoked recovery, unavailable pinned revisions | Covered | recovery.spec; w4-cross.spec "can't recover against a revision retired since…"; admissions.spec |
| Cross-account/connection denial | Covered | artifacts.spec, read.spec, policy.spec; recovery.spec "refuses another user's retry of a save whose artifact was lost, and the owner can still recover it", "refuses another user's retry of an uncertain save, without contacting the provider" |
| Signed-content rejection | Covered | api/data.spec |
| Slow-old-run ordering, changed retry output vs a publication | Covered | artifacts.spec; recovery.spec |

### AT-09: previews and published views: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| System previews can't save; no Author authority | Covered | policy.spec "never mints a write or Author signing"; l176/brokered.test "a system session never writes" |
| Missing configuration is unsigned | Covered | brokered.test; policy.spec |
| Private/anonymous views use stored content | Covered | publication.spec; read.spec "…with a data-only program, never the source" |
| Repeated views/answers never repeat saves | Covered (views) | publication.spec "serve repeated views, anonymous and signed in, from the stored artifact: preview signing each time, never a save"; read.spec "signs every repeated view from the stored activity, under the artifact's one invocation, never the source". Learner answers go to Learnosity from its client, not through the gateway |
| Missing artifacts don't rebuild | Covered | read.spec |
| Recipients can't publish; unpublishing blocks issuance | Covered | delegation.spec; pol/live.spec; policy.spec; publication.spec |

### AT-10: against the provider: Pass, with recorded residuals

Measured in the development Learnosity organisation with the AT-10 harness
(`scripts/at10-provider.js`; evidence in `.gc-deploy/provider/`, facts only). The raw signer
established the provider's behaviour; Broker-signed runs against the deployed v8 services show
that Broker's implementation holds. Every Learnosity key Graffiticode uses is in that one
organisation and item bank, which holds no learner data.

| Clause | Status | Evidence |
| --- | --- | --- |
| Draft-only saves | Covered | Registry v8 (B1): Broker writes every record under references derived from the operation id. Draft cases on v8, Broker-signed, 2026-10-18 21:23Z: writing a question a published item uses leaves it unchanged (c), and so does a save whose item write fails (d). A save, publish and second save leaves the item published, its question unchanged (e), and so does reusing a published item's reference (f). On v7 each of these changed or unpublished published content. Also broker.spec "fresh references per save (B1)" and reconcile.spec "resolves a lost response after dispatch as applied, on the mapped records" |
| Preview scope | Covered, with residual | The Questions API signs only the security packet, so `type`, `state`, `questions` and `session_id` can be changed; `user_id` and a foreign origin are refused (`integrity`, `scope`). Registry v8 (A3) signs Questions previews only with the previews-only preview consumer. Its signatures are refused by the Data, Items and Author APIs (`separation`, raw 17:59Z and Broker-signed on v8 21:22Z), and its sessions make no item-bank call (`scope`, raw 20:13Z and Broker-signed on v8 21:40Z). Items previews: the signature covers the request, and every tamper was refused. Residual, accepted by the PROVIDER-01 revision: a holder can run general Questions sessions storing sessions and responses for the lifetimes below |
| Request lifetime | Covered | Broker sets `expires` at 10 minutes (`BROKER_PREVIEW_EXPIRES_MINUTES`). On v8, Broker-signed, 2026-10-18: initialised at 5 minutes, accepted (22:57Z run). At 11 minutes, refused 10003 "Failed authentication", 1 minute past `expires`, with a control signed at that moment accepted (23:09Z run) |
| Established-session lifetime | Documented, not measurable | Questions sessions make no server call the client can probe (`session`, Broker-signed on v8 23:09Z: `probe-unconfirmed` before and after `expires`). Recorded as Learnosity's documented 168 hours |
| Provider replay | Covered | No single-use: one signed request initialises in the same browser twice, in two contexts, and after first use, each beside an accepted control (`replay`, Broker-signed on v8 2026-10-18 23:20Z) |
| Revocation | Graffiticode measured; provider documented | Graffiticode's revocation stops the next mint and the next step (canary revocation probe, 23/23 in the v8 window). Provider rotation is documented, not measured (operator decision, 2026-10-18). Its blast radius: a leaked preview signature reaches only the previews-only consumer. Consumer secrets are sealed in Broker, and no compiler can read one (IAM review) |
| Caches and artifacts | Covered | `caches`, 2026-10-18 22:56Z: every route that can carry a signed request answers `Cache-Control: no-store` (`POST /compile` since #130, `api-rmveeouvf-0c12ae`) |

Left in place: the window's `gc-…` draft records in the development item bank (operator
decision). Follow-up work, not a condition for closing: `canary.js --provider`, the per-release
check of the preview consumer key, Broker's `expires`, the cache headers and the attestation's
expiry.

### AT-12: audit and mixed versions: Pass

| Clause | Status | Evidence |
| --- | --- | --- |
| Correlation: success, denial, partial, outage | Covered | api/at12.spec (each case); pol/correlation.spec; brk/live.spec; broker.spec maintenance |
| Redaction | Covered | at12.spec `afterEach` scans every record for the markers; pol/audit.spec pseudonymization; broker.spec "…without tokens, secrets or raw ids" |
| Categories (AUDIT-01) | Covered | pol/audit.spec categories; scr/failures-inventory.test. Live: categorized records on deployed revisions; alerts delivered |
| Cutover/rollback fails closed | Covered | scr/at12-rollback.test (both directions, `release-check` below W4) |
| Old receipts survive | Covered | scr/at12-rollback.test "a W3 receipt survives: still as written, replayed after a rollback, and reported by reconciliation"; live.spec "replays an older receipt without the new fields" |
| Old proofs can't bypass new checks | Covered | at12-rollback; admissions.spec v1 refusal; w4-cross.spec. Live: canary v1 refused |

## Gaps, most important first

1. ~~**AT-10, provider behavior**~~: passed with recorded residuals, 2026-10-18 (registry v8;
   see AT-10 above).
2. ~~**AT-02, account enumeration**~~: fixed 2026-10-14 (graffiticode-app #10).
3. ~~**AT-02, verified-email claim**~~: tested (graffiticode-app #10).
4. ~~**AT-07 / RETAIN-01, restore test**~~: passed 2026-10-16.
5. ~~**AT-04, canonical vectors**~~: both L0000 copies carry all 6, checked against
   `CANONICAL_VECTORS` (tests only; no l0000 release needed).
6. ~~**AT-12:** old receipts reportable~~: tested.
7. ~~**AT-02:** a failure partway through provisioning~~: fixed.
8. ~~**AT-09:** repeated views~~: tested (answers aren't a gateway path).
9. ~~**AT-03:** undeclarable preflight at the gateway~~: tested.
10. ~~**AT-04:** language changed after admission~~: tested.
11. ~~**AT-02:** leave~~: tested.
12. ~~**Single sub-cases**~~ (AT-05 signature expiry, AT-01 Broker invoker mismatch, AT-08
    cross-account recovery): tested.

No test written for these gaps found a bug. AT-10 passed on 2026-10-18 with recorded
residuals (registry v8). AT-11 passed with recorded residuals on 2026-10-20, so every AT now passes.

Live coverage doesn't reach AT-01, AT-06, AT-08 or AT-09's save prohibition. These rest on
CI tests.
