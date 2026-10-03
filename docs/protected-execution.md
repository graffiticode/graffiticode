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

`drain` trusts an empty count only once the switch has settled: a service may act on
a cached "on" for up to 2 s after the flip, and a request admitted then registers as
active a moment later, so it waits at least 5 s. Its time bound is the maximum
execution duration plus that 2 s cache window, since an admitted request arrived by
then and starts no provider request after its arrival plus the deadline. Each write
attempt has its own entry, so a retry that replays a pending receipt never hides the
attempt still writing. `drain` refuses while Broker is on. Pass `--max-ms` if the
limits were overridden.

## Re-enabling is gated

`enable` first runs `npm run deploy -- release-check` for every service in
`deploy.json` with `retireTags` or a `baseline` (policy, broker, api, l0176) and refuses
if any still has stale tags or serves a revision below its milestone baseline.
`--skip-release-check` bypasses it (a non-production project) and is recorded as
`releaseCheckSkipped: true`, which `status` shows.

Rolling back below a baseline needs `npm run rollback -- <service> --release <id>
--below-baseline`, only with protected execution switched off; `enable` then refuses
until the service is at or above the baseline again. A passing canary on the older
release does not change that.

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
5. Record the W0 baseline: set `baseline: { "milestone": "W0", "release": "<id>" }`
   on policy and broker in `deploy.json` (their new release ids) and commit. From then
   on rollback and `enable` enforce it.
