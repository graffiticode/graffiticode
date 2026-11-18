# OAuth-store migration: the auth service's half

Each installation is moving its OAuth records (clients, pending authorizations, codes, tokens) out of this service's store into its own database. The plan is graffiticode-app's `docs/installations-plan.md` (P5, the store handover). This service is the legacy store, and stays the authority for what it holds until each record is migrated. The frontend's half is merged and inactive.

## The contract (version 1)

The source of truth is graffiticode-app's `packages/core/src/oauth/legacy-contract.ts`. One acceptance suite (`legacy-contract-suite.ts`) holds both this service and the frontend's stand-in to it. This service implements it in:

- `packages/auth/src/storage/oauth-migration.js`: status, fence, seal, `consume`, `markMigrated`, `revoke`, and the inventory.
- `packages/auth/src/routes/oauth-migration.js`: the HTTP binding at `/oauth-migration/v1`. Answers are bare JSON, as the contract states them.
- The fence on every ordinary write:
  - `storage/oauth-flow.js` (clients, pending authorizations, codes) and `storage/oauth-tokens.js` (tokens): each write is a transaction that reads `oauth-migration/<installation>` first, so none commits after the fence does;
  - `services/oauth-tokens.js` checks the fence first too, so a fenced store answers `409 migration_fenced` whether or not the token exists;
  - rotation is now one transaction, so the old token can never be deleted while the new one is refused.
- Marks stored on the records, and reported by reads:
  - `migration { mode, claim_id }` and `revoked_at` on a token, with `/oauth-tokens/lookup` reporting `revoked` and `migration`;
  - `consumed_by` on a code or pending authorization: a consumed code reads as used, and a consumed pending authorization as gone.

Records written before installations name none; they are Graffiticode's. Other installations have no records here.

A token is named by its key: the SHA-256 of its refresh token, or of its access token if it has none. Index entries are named `h:<that hash>`. The inventory gives an entry still under its raw name (`token-index.js`) its hashed name, so a dormant token is findable by its key afterwards.

The fence and the seal are one-way, and need the operator's key as well as the internal key: `X-Migration-Operator-Key` must match `OAUTH_MIGRATION_OPERATOR_KEY`, which no service holds. When that variable is unset, both answer 500.

## Verification

- `packages/auth/src/storage/oauth-migration.spec.js` (emulator):
  - the seal only after the fence;
  - other installations;
  - fenced rotation keeping the old token;
  - keys by access token;
  - raw-named index entries, repaired by the inventory;
  - inventory paging, and only OAuth tokens;
  - expired codes;
  - revocation marking without deleting;
  - the seal refusing every migration operation.
- `packages/auth/src/routes/oauth-migration.spec.js`:
  - bare JSON answers;
  - input validation;
  - the internal and operator keys;
  - `409 migration_fenced` on the flow and token routes.
- **The shared suite against this service:** graffiticode-app's `packages/mcp-server/tests/oauth-legacy-contract.test.ts`, with `OAUTH_LEGACY_CONTRACT_URL`, `INTERNAL_API_KEY` and `OAUTH_MIGRATION_OPERATOR_KEY` set. It passes (8/8) against this service run locally on the emulators. Before activation, it must also pass against a disposable deployed instance. The suite sets a fence that is never lifted, so never run it against production.

## Index repair

Index entries written before the hashing change are named by the raw token until a lookup moves them, and that move is best effort. So a missing hashed entry proves nothing.

Fencing runs a full repair pass (`repairIndex`). Every token reached through a raw-named entry gets its hashed entry, one transaction per entry. Only a pass that completes without an error records `index_ready`.

- **Until then**, `markMigrated` and `revoke` answer 503, which the contract's callers retry. Neither ever answers absent or applied on a guess.
- **A failed pass** leaves the fence set and the index not ready. Fencing again re-runs the pass.
- **A conflicting entry stops the pass.** If a hashed entry names a different live token, the pass refuses rather than overwriting it.
- **The fence keeps the names complete.** It stops every other write, so once the pass completes, every reachable token stays findable by its key.
- **Unreachable tokens stay unreachable.** A token that no index entry reaches isn't usable today; repair doesn't make it usable, and the inventory doesn't list it.
- **Each credential is judged by its own index.** A credential counts only if its own hashed entry reaches the token (`usableToken`). A token whose refresh token no index reaches is usable by its access token alone, so it is presented without its refresh token (`refresh_token: null`) everywhere: access lookups, the inventory, and `markMigrated` and `revoke`, which find it by its access token's key. It is never dropped, and an import never gives back a refresh token that couldn't be used.
- **The inverse: an unreachable access token.** A token whose access token no index reaches is usable by its refresh token alone. It is reported with `access_usable: false`, by refresh lookups and in the inventory, and keyed by its refresh token. The contract's importer then gives it a fresh access token, chosen once under its migration claim, so the stored access token never becomes live.
- **The inventory waits too.** It answers 503 until the index is ready, because what is usable is read from the repaired names.

## Deployment and activation

Older auth code doesn't know the fence: it writes regardless. So before the fence, no auth revision older than this change may be reachable, and none may come back. This uses the deploy CLI's floor baselines (`packages/deploy/README.md`, "Adding a security milestone"):

1. **Merge, then add the floor.** Once this change is on `main`, append the first entry to auth's `baselines` in `deploy.json`: `{ "milestone": "P5-fence", "commit": "<its merge commit>", "floor": true }`. From then on:
   - `rollback` refuses any auth target below it, with no override;
   - `release` refuses older source.
2. **Release auth, with the operator key.** Put `OAUTH_MIGRATION_OPERATOR_KEY` in Secret Manager, readable by the operator only, and add it to auth's `secrets`. Without it, nobody can fence. Deploying changes nothing for callers until an operator fences: every write path keeps its behavior unfenced, and the new routes are unused.
3. **Verify the contract.** Run the shared suite against a disposable instance. It sets a fence that is never lifted, so never run it against production. When it passes, the operator may set `OAUTH_MIGRATION_VERIFIED_CONTRACT=1` on MCP (graffiticode-app).
4. **Gate the fence.** Two checks must pass:
   - `npm run deploy -- release-check auth` (read-only). It fails while auth has a stale tag (a tagged revision serving no traffic; auth has `retireTags`) or serves a revision below `P5-fence`. Fix failures with `npm run deploy -- retire-tags auth`; that cleanup is best effort, so re-run `release-check` until it passes.
   - graffiticode-app's `npm run check:drained`, for MCP and REST.
5. **Follow the cutover runbook** (installations plan, P5): fence (which also repairs the index; re-run it until it succeeds), import and sweep, seal, sweep, retire.

**What the floor doesn't cover:** a revision deployed outside the CLI (`gcloud run deploy` by hand). `release-check` still finds it if it's reachable, which is why step 4 comes right before the fence.
