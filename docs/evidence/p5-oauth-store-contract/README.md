# OAuth-store migration contract v1: the disposable deployed instance

This is the activation gate in `docs/oauth-store-migration.md`, step 3. Before migration can be activated, the shared contract suite must pass against a deployed auth instance that is disposable, never production, because the suite sets a fence that can never be lifted.

**Result: 8/8 passed** on 2026-11-19 at 16:31:12 UTC, with none failing or skipped, in 13.4 s. The raw output is in [`contract-results.tap`](contract-results.tap).

## What was tested
- **Image:** `us-central1-docker.pkg.dev/graffiticode/services/auth@sha256:ddf56fdaecfe3948ecb542a82a75ccf6ceec3373eeac98225c0dba336e47256b`. That is production auth release `rmwnqn8lz-143390`, built cleanly from `f8aaf3c1cff3dca9bf1a6b8d9a791db17aebcb2a` (#427 contract v1, #429 `P5-fence` floor, #430 operator key), and it ran by digest.
- **Instance:** Cloud Run service `auth-probe` in the throwaway project `gc-auth-contract-probe-6c2452` (us-central1), with no production access:
  - its own default Firestore database;
  - its own runtime account `auth-probe-run`, whose only role was `datastore.user` in that project;
  - an internal key and an operator key generated for this run only.

  For the image pull alone, that project's Cloud Run service agent had read access to `graffiticode`'s `services` image repository.
- **Suite:** graffiticode-app's `packages/mcp-server/tests/oauth-legacy-contract.test.ts` (from `packages/core/src/oauth/legacy-contract-suite.ts`), at `c7c7fea`, which is the content merged in graffiticode-app#119. It ran over HTTPS with graffiticode-app's HTTP client (`packages/mcp-server/src/oauth/firestore-store.ts`).

## Cases

| # | Case | Result |
|---|---|---|
| 1 | Status reports contract v1, unfenced | ok |
| 2 | Before the fence, ordinary writes work and migration operations are refused (`not_fenced`) | ok |
| 3 | The fence refuses every ordinary write; reads keep working | ok |
| 4 | `consume`: single use, idempotent for its claim, refused for any other | ok |
| 5 | `markMigrated`: compare-and-set with three outcomes, visible on reads | ok |
| 6 | `revoke`: idempotent, refuses a later mark, visible on reads | ok |
| 7 | Inventory: the installation's tokens with their marks, and its clients, across pages | ok |
| 8 | The seal: every migration operation is refused, and reads keep working | ok |

## Cleanup (verified)
- The image-pull grant on `graffiticode/services` was removed.
- `gc-auth-contract-probe-6c2452` was deleted and is in `DELETE_REQUESTED`.
- Production auth was untouched: it reports contract v1, unfenced and unsealed.
- MCP's `OAUTH_MIGRATION_VERIFIED_CONTRACT` was not changed.

## What this allows
The operator may set `OAUTH_MIGRATION_VERIFIED_CONTRACT=1` on MCP (graffiticode-app). The cutover runbook's gates still apply before the fence: `npm run deploy -- release-check auth` and graffiticode-app's `check:drained` must both pass.
