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
npm run deploy -- l0176 --stage
npm run deploy -- promote l0176 --release <release-id> --evidence <file>
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
- `retireTags`: `true` makes each release, after promotion, remove the tags of revisions that serve no traffic (keeping its own), so an old revision of a protected service is not callable through its tag URL. Traffic is verified unchanged. The receipt records the tags in `retiredTags` and, when there were any, `tagsRetiredAt`: when their removal was verified, no earlier than they stopped answering. A failure leaves the release released, records `tagRetirementError` in the receipt and prints a warning. Rollback targets revision names, so it is unaffected. `npm run deploy -- retire-tags <service>` does the same on demand and prints the verified time; `--plan` lists the stale tags (a read-only describe). Like every command it takes the local lock but not a cloud one, so do not run it while someone else's candidate is being verified.
- `baselines`: `[{ "milestone": "W0", "commit": "<40-hex>" }, …]`, oldest first: the commit of each security milestone's release. A revision meets a milestone only if it was built cleanly (`gc-dirty=false`) from that commit or a descendant (`commit-sha`, both labels every release sets); its name or age never counts, so old code redeployed under a new release id does not. Ancestry comes from the local Git history (fetch first).
- `contractMinimum`: `{ "env": "POLICY_MIN_CONTRACT_VERSION", "floor"?: 2 }` (policy and broker). `release-check` reads that variable from every reachable revision's own environment, serving or tagged, since a configuration release of the same commit meets every baseline. An invalid or unreadable value (including one from a secret) always fails. With `floor`, an unset or lower value fails too, `env` must keep the floor, and a rollback to a revision below it needs `--below-baseline` with protected execution off.
- `network` (compilers, ISOLATE-01): `{ "network", "subnet", "tags": [..], "proxy": "http://host:port", "ca": { "secret": "name:version", "path": "/dir/ca.pem" }, "allow": [hostnames] }`. Each release deploys on that network and subnet with `--vpc-egress=all-traffic`, sets `HTTPS_PROXY`/`HTTP_PROXY` to the proxy, `NO_PROXY` to the metadata server only (`169.254.169.254,metadata.google.internal`), mounts the egress proxy's private CA certificate (the public certificate only; the proxy terminates TLS for each allowed host with a certificate it issues) from the pinned secret version at `path`, and sets `NODE_EXTRA_CA_CERTS` to it. `env` may not set those variables itself. `allow` is the reviewed host list the proxy enforces; the CLI keeps it with the service for review, and `deploy/egress-proxy` generates the proxy's config from it (the CLI doesn't configure the proxy). `release-check` reads every reachable revision, serving or tagged, and fails on any without the network interface, all-traffic egress, the exact proxy variables, or the CA mount. `rollback` refuses such a target before moving traffic, with no override (not even `--below-baseline`): roll forward, or back to a controlled revision. A release's smoke checks also ask the candidate for `/egress`, the egress bootstrap's own report (`@graffiticode/l0000/egress`, or l0000r's route). It must say `installed: true` with this service's proxy, or the candidate isn't promoted (or staged): without the bootstrap its outbound HTTP would try the direct route the compiler firewall drops.
- `enforcesSwitch`: `true` for services that enforce the protected-execution switch themselves (policy, broker). They are never rolled back below their first milestone, whose code introduced the switch, since older code would ignore it.
- `protectedExecution`: `{ "policyUrl", "brokerUrl" }` (in `environments.production`), where `rollback --below-baseline` reads `/v1/protected-execution` with the operator's identity.
- Rollback below the current milestone needs `--below-baseline`, and then also needs both Policy and Broker to report protected execution off; the receipt records `rolledBackBelowBaseline`.
- `npm run deploy -- release-check <service>` (read-only) exits non-zero if the service still has stale tags (when `retireTags`) or serves a revision that does not meet its current milestone, or any reachable revision fails its `contractMinimum`, `network` or `forbiddenEnv` check, or a required service (`requires`) has a reachable revision below its milestone; `--json` prints the result. `scripts/protected-execution.js enable` runs it for every service with `retireTags` or `baselines` and refuses if any fails; its `--skip-release-check` is refused for the production project. A release whose tag retirement failed exits non-zero.
- `removeSecrets`: environment names whose secret mounts each release removes (`--remove-secrets`). A name cannot also appear in `secrets`. Rolling back to a release made before the removal brings the mount back with that revision, and needs the runtime account to still have access to the secret.
- `removeEnv`: environment variable names each release removes (`--remove-env-vars`). `env` is applied with `--update-env-vars`, which keeps every variable it isn't given, so deleting a name from `env` leaves it set on the next revision; list it here to remove it. A name cannot also be in `env` (or `secrets`, which `removeSecrets` handles), and the CLI's own variables (`GC_RELEASE`, `GC_IMAGE_DIGEST`, and the `network` ones) cannot be removed. Rolling back to an earlier revision brings back whatever that revision carried; `forbiddenEnv` guards against that.
- `forbiddenEnv`: environment variable names that no reachable revision may carry, with any value (an empty string or a secret reference counts) in any container. It applies to every reachable revision, whatever its commit, since a revision keeps the variables it was made with. `release-check` reads every reachable revision, serving or tagged (retained tags included), and fails on one that carries a forbidden name or whose environment can't be read. `rollback` refuses such a target before moving traffic, with no override (not even `--below-baseline`), so a rollback can't restore a revision of the current commit that still carries the variable. A release refuses to promote a candidate that inherited a forbidden variable from the service's template: list it in `removeEnv` as well. A forbidden name can't be set in `env` or `secrets`. Tags only stop reaching a revision once they are retired: `retire-tags` for unapproved ones, and `scripts/revisions.js retire` for approved revisions of a pinnable service, whose tags `retire-tags` keeps.
- `minInstances`, `maxInstances`: integers (0–1000 and 1–1000, min not above max) passed as `--min-instances` and `--max-instances` on each release. They are revision settings: a revision keeps the limits it was deployed with (a rollback restores the old revision's limits), and a later release without the field keeps the service's current value rather than clearing it. Set the value you want instead of deleting the field.
- `requires`: `[{ "service": "<other service>", "milestone": "<name in its baselines>" }, …]`, for a service that fails closed against another's older code (Broker refuses system-session execution tokens without the `sexp` claim that only Policy's milestone issues). The service must be in `deploy.json` in the same project and region, the milestone in its `baselines` (for the same environment), and a service can't require itself; any invalid `requires` fails the plan of every service, the required one included. Enforced both ways, by the same provenance test as `baselines` (clean build from the milestone's commit or a descendant):
  - Releasing the requiring service: before promotion, every reachable revision of each required service, serving or tagged, must meet the milestone; otherwise the release fails at `candidate` with traffic unchanged, naming the revisions. Retire the old ones (or release the required service) first.
  - `release-check` on the requiring service reports the same as `requires: [{ service, milestone, below: [..] }]` and fails.
  - Releasing the required service: a candidate below a milestone another service requires (old code redeployed) is not promoted.
  - Rolling back the required service: a target below a required milestone is refused before traffic moves, with no override (not even `--below-baseline`). The refusal lasts as long as the `requires` entry is in `deploy.json`, so remove it only once no reachable revision of the requiring service depends on the milestone.
- `smoke`: read-only GET checks with `path`, successful `status`, and optional `bodyIncludes` and `timeoutMs` (1000–600000, default 30000). The first check usually starts the candidate's first instance, so a slow-starting service sets `timeoutMs` on it.
- `smokeServiceAccount`: required for private services. The deployer impersonates it for an ID token using the service URL as audience, then requests the candidate tag URL.
- `verify`: optional `{ "module": "<relative .js path>" }`. After the smoke checks and before promotion, the CLI loads this module **from the release's captured snapshot** (not the working tree), records its sha256 in the receipt, and awaits its default export with `{ candidateUrl, serviceUrl, headers, config, cloud, fetch, log }`. `headers` carries only Cloud Run invocation (`X-Serverless-Authorization` for private services); application credentials are the module's own concern, read with the deployer's `cloud` credentials. Any rejection fails the release with traffic unchanged (`failedAt: "candidate"`). The module runs on the deployer's machine and can import only Node built-ins and other snapshot files. The release refuses to start if the module is not in the snapshot.
- `exclude`: additional exact file paths or directory prefixes, not glob patterns.
- `include`: optional. When set, the snapshot is only these exact paths or directory prefixes (e.g. `languages/l0176` and its Dockerfile); `exclude` and the built-in credential rules still apply within them. Use it for a service that lives in one directory of a larger workspace.
- `blocked`: an optional explanation that prevents deployment until an operator removes it after meeting the stated prerequisites.

Any other key in a service, environment or override is refused (`Unknown setting(s)`), so a misspelt or unsupported setting fails the plan rather than being silently left out of a release.

### Adding a security milestone

To make every reachable revision carry a new guarantee (for example L0176's `gateway-only` rule):

1. Release the code that introduces it. Its commit is the milestone's commit: any clean (`gc-dirty=false`) release built from it or a descendant meets the milestone.
2. Append `{ "milestone": "<name>", "commit": "<40-hex>" }` to the **end** of the service's `baselines`: the last entry is the current milestone, and names must be distinct. The commit must be in the deployer's local Git history (`git fetch` first).
3. Run `npm run deploy -- release-check <service>`. It lists every reachable revision below the new milestone (for a pinnable service, tagged ones included). Retire them (`retire-tags`, or `scripts/revisions.js retire` for approved revisions) until it passes.

From then on, a rollback to a revision below that milestone needs `--below-baseline` with protected execution switched off. A guarantee that depends on configuration as well as code (a variable that turns the rule off) pairs the milestone with `forbiddenEnv`, and `removeEnv` to drop the variable: the milestone catches old code, which needs no variable to lack the rule, and `forbiddenEnv` catches new code still configured to bypass it.

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

### Staging: `--stage` and `promote`

`npm run deploy -- <service> --stage` runs a release up to and including its candidate checks (build, deploy with no traffic, smoke, `verify`, the candidate's network controls, `forbiddenEnv`, and `requires` both ways), then stops. The candidate keeps its tag and no traffic; the receipt's status is `staged`, its `url` is the candidate's tag URL, and it records `stagedAt`, the service's fingerprint (`stagedFingerprint`) and `networkHash`: the sha256 of the canonical JSON (keys sorted at every level) of the service's resolved `network` setting, or `null` without one. This is ISOLATE-01's inventory step: the corpus runs against the tag, and the proxy's refusals are reviewed before anything serves.

`npm run deploy -- promote <service> --release <id> --evidence <file>` promotes it. It refuses, leaving the receipt staged and traffic untouched, unless:

- the receipt is for this target and `staged` (a released, failed or rolled-back one is refused);
- `deploy.json`'s `network` still hashes to the receipt's `networkHash` (a changed allow list means a new candidate);
- the evidence is valid (below);
- the service is unchanged since staging: same generation, template and traffic. Another release, a moved percentage or a retired tag all refuse.

It then re-runs the candidate checks, re-reads the service, and promotes through the release's own path: approval first for a pinnable service, `update-traffic` to exactly that revision, verification, and tag retirement. The receipt gains `promotedWith: { reviewer, reviewedAt, evidenceHash }`. A failure after promotion starts is recorded as for a release (`failedAt: promoting`). `--plan` with `promote` reads the receipt and evidence and prints the evidence problems, without cloud calls.

The evidence file:

```json
{
  "version": 1,
  "service": "l0176",
  "release": "<release id>",
  "revision": "l0176-<release id>",
  "networkHash": "<the staged receipt's networkHash>",
  "reviewer": "<who reviewed it>",
  "reviewedAt": "2026-10-20T18:00:00Z",
  "corpus": { "ranAt": "2026-10-20T17:30:00Z", "tasks": 120, "failures": 0 },
  "refusals": [
    { "destination": "www.googleapis.com:443", "decision": "added", "note": "PREFLIGHT_GATEWAYS key fetch" },
    { "destination": "example.com:443", "decision": "not-needed", "note": "a test item's link; not fetched in production" }
  ]
}
```

`service`, `release`, `revision` and `networkHash` must match the receipt. `reviewer` is required. The corpus run must have at least one task, no failures, and a UTC `ranAt` no earlier than `stagedAt`; `reviewedAt` is a UTC time no earlier than the run. `refusals` lists every destination the proxy refused for the candidate (empty if none). Each has a `decision`, `added` or `not-needed`, and a `note` explaining it. An `added` host must be in `network.allow`, so it went into the staged candidate's `networkHash`. Adding a host therefore means a new candidate, after the proxy has been updated (`deploy/egress-proxy`).

While a candidate is staged, its tag reaches it like any candidate's, and `release-check` counts it as reachable. For a service with `retireTags` it is a stale tag, and for a pinnable one an unapproved revision, until promotion. A later release's tag retirement removes it, after which `promote` refuses.

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
