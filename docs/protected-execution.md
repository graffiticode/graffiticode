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
