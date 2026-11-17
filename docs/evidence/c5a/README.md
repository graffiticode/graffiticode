# C5a: release evidence

Plan: [`docs/c5-l0013-commands-plan.md`](../../c5-l0013-commands-plan.md), "Release order (C5a)". **The release phase is complete (2026-11-17).** C5a's live gate is still pending; its IAM changes and gate resources each need the owner's approval.

## Releases, in the plan's order

| Step | Service | Source | Revision | Image | Rollback restores |
|---|---|---|---|---|---|
| 2 | `console` (item-authority route, app#116) | graffiticode-app `cd338c1` | `console-rmwjw7o6n-d368e9` | | `console-rmwjk87g7-51fd55` |
| 2 | `app` (render-grant resolver, app#117) | graffiticode-app `cd338c1` | `app-rmwjwsu2n-067a1a` | | `app-rmvpp8fy0-42bbbb` |
| 3 | `broker` | `6918feca` (#400) | `broker-rmwjy9cjp-4a0c2c` | `sha256:13695d20…e6a77e` | `broker-rmwfao7du-d30ef1`, which is below the `C5a-scopes` floor |
| 4 | `policy` | `6918feca` | `policy-rmwjyqeto-b2be2b` | `sha256:6d80ee9d…f48e5` | `policy-rmwfh9fjc-7e95a3`, also below the floor |
| 5 | `l0013r` (pinnable, approved with contract `[3]`, registry 9) | `6918feca` | `l0013r-rmwjzlgz6-2882e6` | `sha256:da228f7c…e44c25` | `l0013r-rmwib5i8t-15863b` |
| 5 | `l0176r` (pinnable, approved with `[1, 2]`, registry 9; the 14 earlier approvals kept) | `6918feca` | `l0176r-rmwk08k8n-c74227` | `sha256:0b6ac1bc…e4ef4bc` | `l0176r-rmwe83rgw-eae49e` |
| 6 | `api` (`REGISTRY_VERSION` 9) | `3b6b4a50` (#409) | `api-rmwkxlbvy-b5fa92` | `sha256:109d3f7c…66d4bd` | `api-rmwh6ru3u-cd1743` (registry 8) |

No other Rust service was released for registry 9.

## Canary results (36 checks each, canary account and connection)

All four runs used `--chain-admission --after-cutover --command --l0185-tail`, so they include the L0185 → L0176 command save and its retry.

| After | Execution | Against | Result |
|---|---|---|---|
| Policy | `canary-4f95v` | production api | 36/36 |
| `l0013r`, `l0176r` | `canary-tvdmf` | production api | 36/36 |
| api, staged | `canary-99xz2` | the candidate's tag, `https://rmwkxlbvy-b5fa92---api-sja7fatcta-uc.a.run.app` | 36/36 |
| api, promoted | `canary-56svr` | `https://api-sja7fatcta-uc.a.run.app`, serving `api-rmwkxlbvy-b5fa92` | 36/36 |

During the staged run the candidate logged no errors, no `binding-differs` and no incompatible-artifact answers. `release-check` was ok for Policy (after its release) and for the api (after promotion).

## The api release

- **Staged** 2026-11-17T17:05:37Z from `3b6b4a50`, with no traffic. `verify/api.js` passed on the candidate.
- **Promoted** with [`api-promote-evidence.json`](api-promote-evidence.json) (`promote --plan`: no evidence problems). The promotion retired the stale tag on `api-rmwh6ru3u-cd1743`; rollback moves traffic by revision name and doesn't need it.
- **Rollback:** `npm run rollback -- api --env production --release rmwkxlbvy-b5fa92 --plan` restores `api-rmwh6ru3u-cd1743` to 100%.
  - That revision is registry 8. Rolling back to it is safe in both directions for L0176 artifacts, which bind 8 in both builds (plan decision 2 and "Rollback (C5a)").
  - No v9 artifact exists yet: only an api with `COMMANDS_L0013` makes one.

## Flags and capabilities

- **`COMMANDS_L0013`:** unset. Of the command and repair flags, the revision carries only `COMMANDS_L0176` and `REPAIR_L0176`, as before.
- **`scopes`:** disabled. The api's lease and due calls don't declare it, so Policy never gives it a v3 command.
- **The app's resolver:** answers render grants 503 until `app-run` may invoke Policy (the plan's IAM changes).

## Still pending

- **C5a's live gate,** with its IAM changes, buckets, `api-c5a-gate`, the canary window and the edge-cache check, each applied only with the owner's approval.
- **Before C5d:** the api's rollback floor at `3b6b4a50`, the first safe registry-9 api release.
