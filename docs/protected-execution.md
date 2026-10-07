# Protected-execution switch

Capability plan W0. Policy (snapshot, preview session, mint) and Broker (execute)
refuse protected work with `maintenance` (HTTP 503) while the switch is off.
Implementation: `packages/policy/src/maintenance.js`.

## How it decides

1. `PROTECTED_EXECUTION=disabled` in a service's environment is a hard disable. It
   always wins, and undoing it needs a deploy.
2. Otherwise the flag document `controls/protected-execution` in the service's own
   Firestore database (`policy`, `broker`) decides. Execution is on only for
   `enabled: true`.
3. A missing or unreadable flag fails closed: off.

A read is reused for up to 2 s, so a flip takes effect within that bound. Broker
checks before anything stateful: a refused execution token is not spent and still
works within its 60 s lifetime once execution is back on. Invocations are still
allocated while off, since they authorize nothing by themselves.

## Operating it

```bash
node scripts/protected-execution.js status
node scripts/protected-execution.js disable --reason "v6 release window"
node scripts/protected-execution.js enable  --reason "v6 verified"
```

The script writes both databases with application-default credentials. Every write
merges: switching on or off keeps a configured canary, and setting the canary keeps
the switch where it is. Disabling
stops issuance (Policy) before execution (Broker); enabling reopens them in the
reverse order. Each document records `updatedBy`, `updatedAt` and `reason`.

Both services answer `GET /v1/protected-execution` with `{ enabled, source }`, where
`source` is one of `env-disabled`, `flag`, `flag-missing` or `flag-unreadable`. The
candidate checks (`verify/policy.js`, `verify/broker.js`) log it. Set
`GC_VERIFY_PROTECTED_EXECUTION=on` or `off` on the deploying shell to require one
state, which is how a release verifies both states on a candidate.

## Canary while paused

While the flag is off it may name one canary account and its dedicated connection
(a sandbox Learnosity consumer, never production credentials, never `VERIFY_UID`):

```bash
node scripts/protected-execution.js canary --uid <uid> --connection <id> --reason "W0 canary"
node scripts/protected-execution.js canary --clear --reason "canary retired"
```

Policy (snapshot, mint) and Broker (execute) then still admit exactly that pair,
matched only on verified identity: the authenticated user at snapshot, the session
token's `sub`/`conn` at mint, and the execution token's `sub`/`conn` at Broker. Every
normal check still applies, and each admission is audited as
`canary-during-maintenance`. System previews stay paused. A hard disable, a missing
or unreadable flag, or a malformed canary admits no one. The status route never
shows the canary.

### Running the canary

```bash
node scripts/canary.js --uid <canary uid> --connection <canary connection id>
```

It checks, as the canary account:

- **gateway preview**: a preview program compiled through the connection returns a
  signed preview request (gateway → L0176 → Policy → Broker);
- **gateway write**: a save program writes one draft (`graffiticode-canary` in the
  sandbox item bank), and the same request with the same idempotency key returns
  the same outcome;
- **gateway write effects** (W3b, FAIL-01): the write's response lists one
  `save-to-itembank` effect, `succeeded`, with its steps, and the retry's lists it as
  `replayed`, so callers learn what a save did from L0176, through api;
- **token replay**: an execution token executes once, and reusing it is refused
  (409 `token-replayed`);
- **receipt replay**: a fresh token for an operation that already wrote returns the
  recorded receipt (`replayed: true`) and writes nothing;
- **author denied** (AUTHOR-01): for the connection's owner, who otherwise holds every
  function, Policy's snapshot leaves `author` out, and Broker refuses
  `learnosity.sign-author` with 403 `operation-not-enabled`. It fails once Author is
  enabled; update the check then;
- **revocation probe** (W2, live authorization): the canary owns its connection, so
  it narrows its own owner permissions to `init` and back. A fresh token for an
  operation that already wrote is refused once narrowed (403
  `authorization-denied:not-granted`) and writes nothing; a token minted before the
  narrowing records `failed` with no step taken. The exact original permissions are
  restored in a `finally` and read back, and the run fails unless they match. This
  is owner-permission revocation; real grant revocation, expiry, disabling and
  unpublishing are covered by Broker's tests (`packages/broker/src/live.spec.ts`).

The direct-path checks need execution tokens, so the script mints them itself as the
gateway (api) and compiler (l0176) runtime accounts, and the probe calls Policy's
console routes as the console's runtime account (`console-run@graffiticode-app`,
`--console-account` to change it). The operator needs
`roles/iam.serviceAccountOpenIdTokenCreator` on those three accounts, granted for the
release window if preferred. Before W2 is released the probe can't pass;
`--no-revocation-probe` skips it. The canary account's API key is read from Secret
Manager `canary-api-key`. The script refuses `VERIFY_UID`, and exits non-zero unless
every check passes.

#### W4 checks (chain admission)

```bash
node scripts/canary.js --uid <uid> --connection <id> --chain-admission [--retry-state <file>] [--after-cutover]
```

`--chain-admission` is for once the canary connection is in api's `CHAIN_ADMISSION`
(`canary` with it in `CHAIN_ADMISSION_CONNECTIONS`, or `all`). The canary finds the
gateway's own invocation for a compile by allocating, as the gateway, with the same
connection, task, input digest and idempotency key. That reuses the invocation and
gives it the token for Policy's plan lookup. It adds:

- **chain admission: pinned**: the gateway write's invocation is marked (contract 2)
  and has a plan, with every stage pinned to an approved revision with a tag URL, and
  L0176's stage pinned to the revision serving now. If the serving revision can't be
  read, the check fails;
- **chain admission: L0000 stage**: a preview compiled with input data, which api runs
  as an L0000 stage feeding L0176. So L0000 is preflighted, admitted and bound as a
  Policy caller too. Both stages must be pinned, each to the revision serving its
  language now. It's a preview, so it writes nothing;
- **denied final stage** (AT-03, live): a chain whose first stage saves and whose
  final stage would sign an Author activity arriving as data (`init data {}..`, which
  L0176's preflight declares as needing `author`). It must be refused at admission
  (`fn-not-enabled`), with no effects in the response and no plan stored, so no stage
  ran;
- **direct path: admitted**: the direct-path checks run on a marked invocation,
  preflighted at L0176 and admitted as the gateway does, so their snapshots carry the
  plan;
- **retry across a deploy** (AT-07, live; `--retry-state <file>`): the first run
  records its write's task, key, plan and pinned revision in the file. Deploy L0176,
  then run the canary again with the same file. The second run retries that write: it
  must give the same outcome, `replayed`, under the same plan, still pinned to the old
  revision (no `plan-mismatch`). The file is removed once that passes. Run again
  without a deploy, and the check fails and keeps the file.

`--after-cutover` is for once Policy runs `MIN_CONTRACT_VERSION=2`. It adds **v1
refused**: every new invocation is marked, and a snapshot without an admitted plan
(the v1 shape) is refused with `plan-required`. The direct path then always runs
under a plan.

The W4 checks also mint an ID token for `api-run@` with audience
`urn:graffiticode:0176`, for L0176's `/preflight`; the same OpenIdTokenCreator role
covers it.

## Draining before a release

Broker bounds every execution (`packages/broker/src/limits.js`):

| Limit | Default | Override |
|---|---|---|
| each provider request, response included | 10 s | `BROKER_PROVIDER_CALL_TIMEOUT_MS` |
| no provider request starts after | 30 s | `BROKER_EXECUTION_DEADLINE_MS` (at most 60 s) |
| maximum execution duration (adds 10 s to record the outcome) | 50 s | derived |

A request that times out is recorded `uncertain`; one never started because of the
deadline is definite (`failed`, or `partial` after earlier steps). Each write registers
in `active-executions` (broker database) before its receipt claim and leaves when it
finishes; an entry left by a crash expires at the maximum duration. Signing is not
tracked, since it has no provider effect. A TTL policy on `active-executions.expiresAt`
can clean up expired entries; counting ignores them either way.

```bash
node scripts/protected-execution.js disable --reason "v6 release window"
node scripts/protected-execution.js drain     # no active writes, or 50 s since Broker went off
```

`drain` trusts an empty count at once. That is safe because of Broker's drain
barrier: every write registers as active and then re-reads the switch, skipping its
cache. `drain` reads the flag as off before it counts, so a write that registers after
the count re-reads after the flip and is refused before any provider request, however
slow its registration was. The canary is the exception: it is still admitted, so do
not run it while draining (`drain` notes a configured canary). The time bound, the
maximum execution duration plus the 2 s cache window, only covers entries a crashed
attempt left behind. Each write attempt has its own entry, so a retry that replays a
pending receipt never hides the attempt still writing. `drain` refuses while Broker is on. Pass `--max-ms` if the
limits were overridden.

## Re-enabling is gated

`enable` first runs `npm run deploy -- release-check` for every service in
`deploy.json` with `retireTags` or `baselines` (policy, broker, api, l0176) and refuses
if any still has stale tags or serves a revision that does not meet its current
milestone. A revision meets a milestone only if it was built cleanly from the
milestone's commit or a descendant (its `commit-sha` and `gc-dirty` labels), so old
code redeployed under a new release id does not. `--skip-release-check` exists for
non-production projects; it is refused for the production project, and recorded as
`releaseCheckSkipped: true` elsewhere.

Rolling back below the current milestone needs `npm run rollback -- <service>
--release <id> --below-baseline`, and the CLI then checks Policy's and Broker's own
`/v1/protected-execution` and refuses unless both are off. Policy and Broker
(`enforcesSwitch`) are never rolled back below their first milestone, W0: older code
ignores the switch, so nothing could keep protected execution off; roll forward
instead. `enable` refuses until every service meets its milestone again; a passing
canary on the older release does not change that.

## First release carrying the switch

The flag documents do not exist yet, and a missing flag means off. So:

1. Retire stale tags on the protected services (`npm run deploy -- retire-tags
   <service>`, or the equivalent `gcloud run services update-traffic
   --remove-tags=`), until `npm run deploy -- release-check <service>` passes for
   each. No baseline is set yet.
2. `node scripts/protected-execution.js enable --reason "W0 bootstrap"` creates both
   documents **before** the release reaches traffic. The current services ignore
   them.
3. Deploy policy and broker. Their candidates report `on (flag)`.
4. Verify the off state once: `disable`, then `drain`, then check that both
   `/v1/protected-execution` answer `off` and a protected call answers 503
   `maintenance`; then `enable`.
5. Record the W0 milestone: add `baselines: [{ "milestone": "W0", "commit": "<sha>" }]`
   to policy and broker (and to api and l0176 once they release W0 code) in
   `deploy.json`, using the commit their releases were built from (the receipt's
   `commit`), and commit that. From then on rollback and `enable` enforce it.

## The W2 release (live authorization)

From W2, Broker asks Policy's `POST /v1/authorize-execution` before every effect,
and requires `prv` (provenance) in execution tokens. A Broker built from main can't
run without both, so `deploy.json`'s broker entry is `blocked` until this release;
the release commit removes the field. There is no registry bump: nothing stored
becomes incompatible.

Before the window (operator):

1. A new version of the `policy-callers` secret that adds
   `"broker-run@graffiticode.iam.gserviceaccount.com": {"role": "broker"}`, and
   policy's `POLICY_CALLERS` in `deploy.json` pointing at it.
2. `roles/run.invoker` on the `policy` service for `broker-run@`.
3. For the canary's revocation probe, `roles/iam.serviceAccountOpenIdTokenCreator`
   on `console-run@graffiticode-app` as well as `api-run@` and `l0176-run@`.
4. `release-check` passes for policy and broker.

The window:

1. `node scripts/protected-execution.js disable --reason "W2 release window"`, then
   `drain`.
2. `GC_VERIFY_PROTECTED_EXECUTION=off npm run deploy -- policy`. Policy now issues
   `prv` and serves authorize-execution; the Broker still running ignores both.
3. Remove `blocked` from broker in `deploy.json` and commit (the CLI deploys a clean
   tree), then `GC_VERIFY_PROTECTED_EXECUTION=off npm run deploy -- broker`.
4. Record the W2 milestone in `baselines` for policy and broker (the commit their
   receipts name), and commit.
5. Run the canary **while ordinary execution is still paused** (the allowlist admits
   it), with the revocation probe: every check must pass.
6. Only then `node scripts/protected-execution.js enable --reason "W2 verified"`.

Tokens issued before the window carry no `prv` and live at most 60 s; Broker refuses
them (`bad-token`), and callers retry with the same idempotency key, which mints a
fresh token for the same operation. Rolling Broker back below W2 removes live
checks: it needs `--below-baseline` with the switch off; roll forward instead.

## Monitoring

`scripts/monitoring.js` keeps the security audit's metrics and alerts in Cloud Monitoring.
It reads the audit lines every service writes to `run.googleapis.com/stdout` with
`jsonPayload.logName="security_audit"`.

```
node scripts/monitoring.js [--email <operator address>]           # dry run: filter check + plan
node scripts/monitoring.js --apply --email <operator address>     # create or update
node scripts/monitoring.js --verify-alert --email <operator address>
node scripts/monitoring.js --confirm <nonce> <nonce>            # once both emails arrive
```

**Metrics** (`logging.googleapis.com/user/security_audit/<id>`). Each failure is counted
once, by the record that reports it:

| metric | counts |
| --- | --- |
| `policy_denials` | Policy refusals, by event and reason |
| `broker_local_refusals` | Broker's own refusals, e.g. `bad-token`, `token-replayed` or `maintenance`. Broker's relays of Policy denials (`authorization-denied:*`) are excluded |
| `authorization_outages` | Broker writes stopped by `authorization-unavailable` |
| `gateway_policy_unavailable` | gateway requests refused with `policy-unavailable` |
| `uncertain_writes` / `partial_writes` | Broker's final outcome; replays are excluded |
| `artifact_failures` | api artifacts not stored, by category. `unavailable` is an outage. `conflict` includes a retry with the same key whose output differs from the stored artifact (the first is kept) |
| `receipt_replays` | answers from a recorded outcome; never a new effect |

**Alerts** (email to the operator's channel, at most one email per alert every 5 minutes):
- *Security audit: authorization outage*: any `authorization-unavailable` or
  `policy-unavailable`. Check Policy's health and its latest release first.
- *Security audit: uncertain write*: the provider may or may not have applied a write.
  Reconcile it from the receipt (`steps`, `failedStep`) before anyone retries under a new
  operation. A retry with the same idempotency key only replays the recorded outcome.

**The dry run** counts each metric's filter against the last 7 days of deployed entries
(`--days N` changes the window). It fails when a metric's source records (service and
event) match nothing. It also fails when a metric the canary produces matches nothing:
policy denials, Broker-local refusals and replays. `--apply` refuses in either case.
`--apply` is idempotent: run it again after a change to these definitions, and it updates
only what differs.

**After every apply**, check delivery in two runs; neither prompts, so both work from
`!` in Claude Code. `--verify-alert` writes one test record per alert to its own log,
`security_audit_test`. The alert conditions match those records; the metrics never do. It
keeps their nonces in `.gc-deploy/monitoring/pending.json`. Each email ends
`Nonce: <nonce>`. Once they arrive (usually within 5 minutes), run `--confirm` with the
nonce from each email, in any order. An alert whose email didn't arrive is left out and
recorded as not confirmed, as is one whose incident fired without its email arriving. The
result is appended to `.gc-deploy/monitoring/alert-verification.json`.

## Approved revisions

Chain admission (capability plan W4) pins each stage of a protected chain to a specific compiler
revision. A revision of a **pinnable** service (`deploy.json` `pinnable`: `l0000`, `l0176`) can be
pinned only while the `revisions` Firestore database records it as `approved`. The deploy identity
writes that database, and Policy can only read it (IAM review, Step 11).

- **Releases** of a pinnable service record their revision as approved **before promotion**, with
  its tag, tag URL, image digest, commit and supported contract versions. If the record can't be
  written, nothing is promoted. `npm run deploy -- approve <service> --release <id>` records a
  revision released before its service was pinnable.
- **Tags** of approved revisions are kept: admitted plans route to them. `retire-tags` and a
  release's own tag retirement skip them, and also skip a `retired` revision whose tag
  retirement hasn't removed yet (during its 15-minute wait, or after an interruption there).
  Only `retire` removes them.
- **`release-check`** (and so `protected-execution.js enable`) checks every **reachable** revision
  of a pinnable service, serving or tagged. Each must be approved, not mid-retirement, support the
  required contract version, and meet the current baseline. Until both serving revisions are
  recorded (`approve`, once), `enable` refuses.

**Retiring a revision** is always an explicit operator act:

```
node scripts/revisions.js status l0176
node scripts/revisions.js retire l0176 --release <id>                 # report; retires only if nothing is lost
node scripts/revisions.js retire l0176 --release <id> --confirm-unrecoverable
node scripts/revisions.js retire l0176 --release <id> --resume        # after an interruption
node scripts/revisions.js retire l0176 --release <id> --cancel        # back to approved
```

It refuses a revision that's still serving. It works in this order:

1. Marks the revision `retiring`. No new plan can pin it, and its snapshots are refused.
2. Fences admissions in flight: their leases are invalidated, so none can store a plan after this
   point.
3. Reports, from fresh reads, every plan that still needs the revision to recover: an uncertain or
   unfinished write, or an invocation whose artifact was never stored. Retiring makes those
   recoveries unavailable (`pinned-revision-unavailable`).
4. Without `--confirm-unrecoverable` and with anything reported, it **cancels itself**: the
   revision is approved again, and the report is recorded. Otherwise it marks the revision
   `retired`, waits 15 minutes for proofs issued before then to expire, and removes the tag.

An interrupted `retire` leaves the revision `retiring`, which blocks its snapshots. `status` and
`release-check` show it. `--resume` continues; `--cancel` restores `approved`.

Each retirement records its own id, and every later step requires it. A cancelled retirement
whose process wakes up later finds itself superseded (`retirement-superseded`) and changes
nothing, so its stale report can never retire a revision that a newer plan pins.

Retention is advice, not automation: keep the last three approved revisions, plus any the report
names. Keeping a revision runnable never permits re-running an uncertain write: that still needs
provider evidence.

## W4 activation and cutover

Chain admission (capability plan W4) changes authority in exactly three steps, in this
order: `CHAIN_ADMISSION=canary`, `CHAIN_ADMISSION=all`, and the cutover to
`MIN_CONTRACT_VERSION=2`. Everything before them releases with no change in behaviour.

### Before anything changes

1. **The IAM gate** (IAM review, Step 11). Every unconditional writer of the
   `revisions` database that isn't an operator is either removed or recorded as
   accepted in `docs/capability-policy-iam-review.md`. That includes
   `firebase-adminsdk-qflje`'s live key and its project-wide
   `serviceAccountTokenCreator` and `firebase.sdkAdminServiceAgent` grants. Removal is
   the intended outcome: find the key's consumer and migrate it, then remove the key
   and the unintended impersonation and approvals-write authority.
2. **L0000 as a Policy caller.**
   - A new version of the `policy-callers` secret that adds
     `"l0000-run@graffiticode.iam.gserviceaccount.com": {"role": "compiler", "lang": "0000"}`,
     with Policy's `POLICY_CALLERS` in `deploy.json` pointing at that version.
   - `roles/run.invoker` on the `policy` service for `l0000-run@`.
   - `POLICY_URL` in L0000's `env`.
3. **The minimum-version guard.** `release-check`, and so `enable`, inspects every
   reachable Policy and Broker revision's effective `MIN_CONTRACT_VERSION`, and once the
   cutover has been recorded, refuses any below 2 (PR 8). Don't activate without it.
4. **Component releases**, all with `CHAIN_ADMISSION=off` and `MIN_CONTRACT_VERSION=1`
   (or unset): policy, broker, l0000 (the 0.10.1 server, pinnable), l0176 (pinnable,
   registry version 6) and api. Each candidate must pass. Then:
   - `node scripts/revisions.js status l0000` and `status l0176`: the serving revisions
     are `approved` and support contract versions 1 and 2;
   - `npm run deploy -- release-check <service>` passes for all five.
5. **The protected-chain inventory**, before `CHAIN_ADMISSION=all`. Every protected
   chain must have stages only in L0000 and L0176: under `all`, a chain with a stage in
   any other language fails admission (`stage-not-pinnable`). Record the evidence,
   including the canary's L0000 → L0176 chain, in the release notes.
6. **The canary's roles**: OpenIdTokenCreator on `api-run@`, `l0176-run@` and
   `console-run@graffiticode-app`, as for W2.

### Canary

1. In `deploy.json`, set api's `CHAIN_ADMISSION=canary` and
   `CHAIN_ADMISSION_CONNECTIONS=<canary connection id>`. Commit, then
   `npm run deploy -- api`. Only the canary connection's new invocations are marked;
   everything else keeps the per-stage path.
2. `node scripts/canary.js --uid <uid> --connection <id> --chain-admission --retry-state .gc-deploy/canary/w4-retry.json`.
   Every check must pass. The run records its write for the next step.
3. Release L0176 again (`npm run deploy -- l0176`). The old revision stays approved
   behind its tag.
4. Run step 2's command again: **retry across a deploy** must pass, and the file is
   removed.
5. In the audit, check that the `admission` events are the canary's, allowed, apart from
   one `fn-not-enabled` denial (the denied final stage) per run.

### All

1. Set api's `CHAIN_ADMISSION=all`, commit, then `npm run deploy -- api`. Every new
   invocation through a connection is now marked, and runs only under an admitted plan.
   Invocations started earlier keep the per-stage path until the cutover.
2. Run the canary with `--chain-admission`.
3. Soak for at least a day of normal traffic. Watch for admission denials, especially
   `stage-not-pinnable`, `preflight-unavailable` and `revision-not-approved`. A
   denial for a legitimate chain means a missed inventory entry.

To back out before the cutover, set `CHAIN_ADMISSION=off`. Marked invocations still
run only under their plans (a retry still needs its plan), and new ones are no longer
marked.

### The cutover window (RELEASE-01)

1. `node scripts/protected-execution.js disable --reason "W4 cutover"`, then `drain`.
2. Set `MIN_CONTRACT_VERSION=2` in the `env` of policy and broker in `deploy.json`, and
   commit. Then `GC_VERIFY_PROTECTED_EXECUTION=off npm run deploy -- policy`, then the
   same for broker. Policy stops issuing v1 proofs and marks every new invocation;
   Broker refuses any token without `cv: 2`.
3. **Make the last v1 issuer unreachable.** The cutover revision serves 100%, and
   every older Policy revision's tag is retired (`npm run deploy -- retire-tags
   policy`), so `release-check policy` passes. The time this happened, from the
   receipt in `.gc-deploy/`, is **T**.
4. **Wait until T + 30 minutes.** That is the longest lifetime of a Policy proof
   (invocation tokens, 30 minutes; sessions and admissions, 15; execution tokens,
   60 s). The proof is the time elapsed since the last issuer became unreachable. The
   audit is consulted, but it isn't the proof.
5. **Record the W4 baselines.** Add `{ "milestone": "W4", "commit": "<sha>" }` to
   `baselines` for policy, broker, api, l0000 and l0176, using each one's release
   commit from its receipt. Commit.
6. **Run the canary while paused**:
   `node scripts/canary.js --uid <uid> --connection <id> --chain-admission --after-cutover`.
   Every check must pass, including **v1 refused**.
7. `node scripts/protected-execution.js enable --reason "W4 cutover verified"`. Its
   `release-check` now requires every reachable revision of the five services to meet
   W4 and support contract version 2, retained tags included.

After the cutover, a retry of a run started before it gets `invocation-incompatible`.
The caller must start a new run with a new idempotency key, which may repeat writes
the old run already made. Old receipts are kept, but the invocations that wrote them
can't resume (`scripts/test/at12-rollback.test.js`).

### Rollback

- **The guarantee:** protected execution stays off whenever a rollback would lose a
  required check. Rolling any of the five services below W4 needs `--below-baseline`
  with the switch off, and `enable` then refuses until it is rolled forward.
- **What isn't claimed:** that old code refuses new claims. The W3 Policy ignores
  plans and admission tokens entirely, and the W3 Broker skips the contract check. It
  records a newer Policy's `contract-version-unsupported` as `unclassified-reason`, but
  still does nothing (AT-12, against the actual W3 builds: `npm run test:at12-rollback`).
- **Never lower `MIN_CONTRACT_VERSION` after the cutover.** A configuration release from
  the same commit meets the W4 baseline, but would admit v1 proofs again. The
  minimum-version guard (prerequisite 3) makes `release-check` and `enable` refuse it. To
  stop protected chains, switch protected execution off.

### As built

Record the activation in `docs/capability-policy-as-built.md`: the release ids, T, the
canary runs, the inventory, the baselines, and the restriction that every stage of a
protected chain is pinned.
