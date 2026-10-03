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

The script writes both databases with application-default credentials. Disabling
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

`drain` refuses while Broker is on. Pass `--max-ms` if the limits were overridden.

## First release carrying the switch

The flag documents do not exist yet, and a missing flag means off. So:

1. `node scripts/protected-execution.js enable --reason "W0 bootstrap"` creates both
   documents **before** the release reaches traffic. The current services ignore
   them.
2. Deploy policy and broker. Their candidates report `on (flag)`.
3. Verify the off state once: `disable`, then check that both
   `/v1/protected-execution` answer `off` and a protected call answers 503
   `maintenance`; then `enable`.
4. Record the policy and broker revisions as the W0 rollback baseline. Rolling back
   below that baseline removes the switch, so it is allowed only with protected
   execution otherwise disabled.
