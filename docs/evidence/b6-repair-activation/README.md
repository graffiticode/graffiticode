# B6 activation: REPAIR_L0176=on, staged (2026-11-15)

The staged activation of `docs/b6-command-repair-plan.md` slice 5 ("Activation, after the drive passes"), after the drive passed ([evidence](../b6-repair-drive/README.md), report `bed54b`, 13 counted repairs).

**Status: staged, not promoted.** Production's api still serves `api-rmwfmheue-b24633` at 100%. Promotion waits for the owner's review of this evidence.

## The candidate

| | |
| --- | --- |
| Change | `deploy.json`: `REPAIR_L0176=on` for the api, with no compile generation change (repair adds routes and changes no compiled result). Commit `18467f95`, on `main` at `9f95b1a5`. |
| Release | `rmwh6ru3u-cd1743`, staged 2026-11-15T02:10:12Z with `npm run deploy -- api --stage` |
| Revision | `api-rmwh6ru3u-cd1743`, tag URL `https://rmwh6ru3u-cd1743---api-sja7fatcta-uc.a.run.app`, no traffic |
| Image | `us-central1-docker.pkg.dev/graffiticode/services/api@sha256:5cd6458d1790291a0e5a5e43574923f0c810638d84ae5196b0cd4b4a02ae1508` |
| L0176 flags on the revision | `COMMANDS_L0176=on`, `INTERPRETER_L0176=on`, `COMPILE_GENERATION_L0176=interp-1`, `BRIDGE_L0176=off`, `REPAIR_L0176=on`; no fault variable |
| Checks | the CLI's candidate checks and `verify/api.js` passed; `npm run test:deploy` 99/99 with the change |

Both runs below avoided the scheduled production canary (`23 */6 * * *`): they ran between 02:10 and 02:20 UTC, and the nearest scheduled runs were 00:23 and 06:23.

## Canary against the tag: passed 36 of 36

`canary-nm5m7`, 02:10:38–02:15:30Z, run with `gcloud run jobs execute canary --args=--uid,995cc0bc…,--connection,conn-686c62bc…,--chain-admission,--after-cutover,--command,--l0185-tail,--api-url,<tag URL>`. Its full output is `canary-output.txt`:
- gateway preview and write, and the write's same-key retry with nothing written again;
- chain admission pinned to `l0176r-rmwe83rgw-eae49e`;
- the command write, its status and same-key retry, and a command over L0185;
- saved reads freshly signed with no save effects;
- the denied final stage, v1 refused, the direct path, Author removed, token and receipt replay, and the revocation probe, with the connection's permissions restored to `null` each time.

## Repair round-trip against the tag: passed 11 of 11

`roundtrip.mjs`, run `97c038`, 02:15:51Z onwards. Its output is `roundtrip-output.txt`, and its record (ids, call lines, Broker audit, receipts, references) is `roundtrip-record.json`. It runs on the canary account through its sandbox connection, through production's l0176r and Broker, which have no faults. So it makes the `failed` occurrence by narrowing, as the drive's `originals-narrow` did.

1. **The original.** A 2-element map of saves, POSTed to the tag. Once the first write had its final outcome, the canary narrowed its own connection to `init`, so the second was refused. The original ended `partial`: A (`x:8ba6…`) completed, B (`x:6e74…`) failed. The connection's owner permissions were `null` before and read back `null` after.
2. **The repair,** POSTed to the tag:
   - selected exactly B;
   - completed;
   - published as the original invocation's artifact (`inv-01fbb06e…`).
3. **The evidence:**
   - the staged revision `api-rmwh6ru3u-cd1743` logged `call start` for both the original and the repair;
   - **Broker's audit:** A has one claim and its `items` and `questions` dispatches once each under the original's operation, and nothing under the repair's. B has nothing under the original's operation, and one claim with each step dispatched once under the repair's. Every entry is production `broker`.
   - **Broker's receipts:** exactly one under each invocation.
   - **The artifact, read back through the tag:** two references, A's with the original operation's prefix (`gc-3796521393f6260d-`) and B's with the repair's (`gc-cfd3ad74c913a00e-`).
   - the repair's key answers the same repair.

## Promotion

`promote-evidence.json` is the draft evidence for `npm run deploy -- promote api --env production --release rmwh6ru3u-cd1743 --evidence docs/evidence/b6-repair-activation/promote-evidence.json`. Its corpus is the staged canary (36 checks, 0 failures). Its `reviewedAt` is set when the owner approves.

**Rollback:** a forward release with `REPAIR_L0176=off` (deleting the line is refused by the deploy guard). Repairs already pending finish under any repairs-capable api, and Policy's `B6-repairs` floor keeps the Policy they need. Moving traffic back to `api-rmwfmheue-b24633` (`npm run rollback -- api --release rmwfmheue-b24633`) also turns it off.
