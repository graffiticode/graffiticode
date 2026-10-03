# @graffiticode/deploy

A private, dependency-free Node CLI for releasing the current workspace to Cloud Run. The workspace controls the release; Cloud Build only tests and produces the container image. No Git push or CI trigger is involved.

## Usage in this monorepo

Requires Node 22+, Git, tar, and gcloud. Run at the repository root:

```sh
npm run deploy -- api --plan
npm run deploy -- broker --plan
npm run deploy -- api --env production
npm run deploy -- api --allow-dirty
npm run rollback -- api --release <release-id>
npm run rollback -- api --release <release-id> --plan
npm run test:deploy
```

`--plan` is entirely local: it validates configuration, freezes and hashes the source in a temporary directory, prints the target/settings/missing variables, and removes the temporary files. It does not query cloud state, show a live configuration diff, or verify permissions. It accepts a dirty workspace. Normal deployment requires a clean workspace unless `--allow-dirty` is explicit.

The root scripts invoke the workspace CLI directly, so preview works before reinstalling dependencies. Installing the workspace also exposes the `gc-deploy` binary. The existing `gcp:<service>:build` and `gcp:<service>:deploy` scripts are compatibility aliases to the complete release command. Do not chain them: either performs a complete release.

## Configuration

`deploy.json` belongs at the Git repository root. Version 1 contains `environments` and `services`. Settings are merged in this order: selected environment, service, service's `environments[environment]` override. Merging is shallow: overriding `env`, `secrets`, `steps`, or `smoke` replaces that entire field. Unknown environments fail; there is no implicit staging-to-production fallback.

A single-service repository can omit the service argument. Use `--config path/to/deploy.json` to choose a different file; its containing directory must still be the Git root. `${VARIABLE}` strings resolve from the invoking process environment. Missing variables are shown in previews and reject actual deploys.

Each service declares:

- `project`, `region`, `service` (defaults to the service key), and an untagged `image` registry path.
- `dockerfile`, `port`, `runtimeServiceAccount`, `buildServiceAccount`.
- `access`: `public` or `private`. Invocation IAM is checked, never rewritten by the release command.
- `steps`: Cloud Build test/install steps. The CLI appends the Docker build and publishes via `images` with verified provenance.
- `env`: non-secret environment values to update. Unspecified existing settings are preserved. Do not put credentials here; settings are printed and stored in receipts.
- `secrets`: environment names mapped to `secret-name:number`. `latest` and other aliases are rejected. Mounting is additive: deleting an entry does not unmount a secret that an earlier release mounted.
- `retireTags`: `true` makes each release, after promotion, remove the tags of revisions that serve no traffic (keeping its own), so an old revision of a protected service is not callable through its tag URL. Traffic is verified unchanged. A failure leaves the release released, records `tagRetirementError` in the receipt and prints a warning. Rollback targets revision names, so it is unaffected. `npm run deploy -- retire-tags <service>` does the same on demand; `--plan` lists the stale tags (a read-only describe). Like every command it takes the local lock but not a cloud one, so do not run it while someone else's candidate is being verified.
- `baseline`: `{ "milestone": "W0", "release": "<release id>" }`, the first release of this service carrying the current security milestone's guarantees. `rollback` refuses a target below it unless `--below-baseline` is passed (only with protected execution switched off), and `release-check` fails while anything below it serves. Revisions this CLI did not create count as below any baseline.
- `npm run deploy -- release-check <service>` (read-only) exits non-zero if the service still has stale tags (when `retireTags`) or serves a revision below its `baseline`; `--json` prints the result. `scripts/protected-execution.js enable` runs it for every service with `retireTags` or `baseline` and refuses if any fails. A release whose tag retirement failed now also exits non-zero.
- `removeSecrets`: environment names whose secret mounts each release removes (`--remove-secrets`). A name cannot also appear in `secrets`. Rolling back to a release made before the removal brings the mount back with that revision, and needs the runtime account to still have access to the secret.
- `smoke`: read-only GET checks with `path`, successful `status`, and optional `bodyIncludes`.
- `smokeServiceAccount`: required for private services. The deployer impersonates it for an ID token using the service URL as audience, then requests the candidate tag URL.
- `verify`: optional `{ "module": "<relative .js path>" }`. After the smoke checks and before promotion, the CLI loads this module **from the release's captured snapshot** (not the working tree), records its sha256 in the receipt, and awaits its default export with `{ candidateUrl, serviceUrl, headers, config, cloud, fetch, log }`. `headers` carries only Cloud Run invocation (`X-Serverless-Authorization` for private services); application credentials are the module's own concern, read with the deployer's `cloud` credentials. Any rejection fails the release with traffic unchanged (`failedAt: "candidate"`). The module runs on the deployer's machine and can import only Node built-ins and other snapshot files. The release refuses to start if the module is not in the snapshot.
- `exclude`: additional exact file paths or directory prefixes, not glob patterns.
- `include`: optional. When set, the snapshot is only these exact paths or directory prefixes (e.g. `languages/l0176` and its Dockerfile); `exclude` and the built-in credential rules still apply within them. Use it for a service that lives in one directory of a larger workspace.
- `blocked`: an optional explanation that prevents deployment until an operator removes it after meeting the stated prerequisites.

Source selection uses Git-tracked files plus untracked, non-ignored files. Tracked deletions are omitted. `.git`, `node_modules`, `.gc-deploy`, `.codex`, `.agents`, `.claude`, `.env*`, `*.key`, and `*.pem` are always excluded. Symlinks and submodules are rejected. Additional credentials with other names must be excluded explicitly. This CLI does not use `.gcloudignore`; it submits a prebuilt archive. Docker still applies `.dockerignore` inside that archive. The source hash covers sorted paths, executable modes, and file contents, not archive timestamps. It records the exact copied input even for dirty workspaces; the full Git commit is a separate field.

## One-time infrastructure setup

This implementation does not provision infrastructure or change IAM. Before using it against production:

1. Revalidate and apply the existing `docs/capability-policy-iam-review.md`. In particular, remove deployment/impersonation powers from application runtime identities. Provision the dedicated runtime accounts named in `deploy.json`, their database/KMS/secret grants, and migrate existing services to those identities. The CLI refuses a runtime identity mismatch.
2. Create the regional Docker Artifact Registry repository `services` in `graffiticode/us-central1`, and enable the required Cloud Build, Artifact Registry, Container Analysis, and Cloud Run APIs.
3. Create a separate build service account. Set `GC_DEPLOY_BUILD_ACCOUNT` to its email. Grant it the build source/log bucket access, Artifact Registry writer, and logging/provenance permissions required by Cloud Build. It must not deploy Cloud Run services or access application secrets. The generated build uses `GCS_ONLY` logs and a regional user-owned log bucket so `gcloud builds log --stream` can stream them.
4. Give the human deployer build submission and build-account `actAs` permissions; image read, Cloud Run deployment/read/IAM-policy-read permissions; `actAs` on each permitted runtime identity; and secret-version metadata read permissions. The CLI never reads secret payloads. It also describes the build/runtime service accounts. Configure these resource scopes deliberately rather than using Owner.
5. Provision each Cloud Run service separately with the intended runtime identity and invocation policy. This first version requires an existing service with a resolved 100% traffic allocation, so it can guarantee a rollback target. Bootstrap new broker/policy services privately as part of their infrastructure setup; then remove their `blocked` fields after the review is complete. The CLI's IAM check is service-level; project/org inheritance and application caller maps remain part of that review.
6. For private candidate checks, set `GC_DEPLOY_SMOKE_ACCOUNT` to a dedicated service account with `run.invoker` on the target. Grant the deployer permission to impersonate that account. The current checks are `/` for process readiness and `/v1/jwks` for policy key initialization; they do not create credentials, sign external requests, or exercise the full broker workflow.
7. Set the numbered secret versions shown by `--plan`: `BROKER_CALLERS_VERSION`, `POLICY_CALLERS_VERSION`, `AUDIT_PSEUDONYM_SECRET_VERSION`, and `BROKER_SECRET_KEY_VERSION` as applicable. Set `BROKER_URL` for policy. For stable production settings, these can instead be checked-in references in `deploy.json`. Add `POLICY_URL` to the API's `env` when enabling that integration; an existing value is preserved meanwhile.

No infrastructure changes, cloud builds, deployments, or package publication were performed while implementing this package.

## Release and recovery behavior

A release checks service identity/access and secret-version availability, submits the frozen source, streams build logs, and requires a successful build with a matching SHA-256 image digest. It deploys that digest to a named revision with no default traffic, verifies the candidate URL, then promotes the exact revision to 100%. It never resolves a mutable image tag during deployment.

Receipts are saved atomically under `.gc-deploy/releases/<release-id>.json`, with owner-only file permissions. They include source/config hashes, Git commit, file manifest, build ID/source location, image digest, resolved managed configuration/secret versions, previous traffic, revision and status. The uploaded source is retained according to the source bucket policy; local temporary snapshots are removed. Back up receipts if rollback must work from another machine. They contain non-secret configuration, not secret payloads.

Build/test/smoke failures do not promote traffic. A failed candidate remains tagged for inspection. If submission, deployment, or promotion is interrupted, remote work may continue: inspect the receipt, build status, and service before retrying. In particular, a lost promotion response may mean traffic already moved. The receipt records `failedAt: promoting` in that case; rollback can recover if this revision owns all traffic.

`rollback --release ID` restores the traffic distribution *preceding* that release, without rebuilding. It refuses if another release now owns traffic. It does not revert database changes, IAM, service-level settings, or secret contents, and it requires the old revisions and secret versions to remain available. Unmanaged secrets still using `latest` do not acquire reproducible rollback behavior automatically.

There is a per-workspace/per-target lock and optimistic remote drift detection before deployment and promotion. This is not a distributed transaction: two operators can race between the final read and Cloud Run update. Serialize production releases across machines. An interrupted local process can leave a lock; check its PID and cloud work before removing it. Old candidate tags are retained; remove them as an explicit maintenance operation when no longer needed.

The four `configs/cloudbuild.*.yaml` files are legacy **build-only** recipes; normal deployment generates its build from `deploy.json`. They require explicit `_IMAGE`, `_RELEASE`, and a build service account if invoked directly. They cannot deploy. The older `packages/auth/cloudbuild.yaml` is an unrelated legacy service configuration and is not used by this CLI.

## Sharing with sibling repositories

The package is deliberately `private: true` for its first rollout. It has no runtime npm dependencies. Test its packaged binary with `npm pack -w @graffiticode/deploy`; a sibling repository can install that tarball for evaluation. After validating a real release, remove `private`, choose publication access, and publish as a separate explicit action. Consumers should pin `@graffiticode/deploy` to an exact version and use:

```json
{
  "scripts": {
    "deploy": "gc-deploy",
    "rollback": "gc-deploy rollback"
  }
}
```

Each consumer owns its `deploy.json`, Dockerfile, tests, and infrastructure. No dependency on this monorepo's layout is built into the CLI.

## References

- [Manual Cloud Build submissions](https://docs.cloud.google.com/build/docs/running-builds/submit-build-via-cli-api)
- [Verified build provenance](https://docs.cloud.google.com/build/docs/securing-builds/generate-validate-build-provenance)
- [Cloud Run traffic migration and rollback](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
- [Private service authentication and tagged URL audiences](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
- [Secret versions](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
