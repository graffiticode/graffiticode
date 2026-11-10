---
name: deploy
description: Release a Graffiticode service to Google Cloud Run with the workspace deploy CLI (plan, release, rollback), or bump @graffiticode/l0000 in every language and redeploy. Use before running any `npm run deploy`, `npm run rollback`, or `upgrade-l0000-*-and-deploy` command.
---

# Deploying to Google Cloud Run

The shared workspace CLI lives in `packages/deploy`; `deploy.json` owns service configuration.

```bash
npm run deploy -- api --plan          # offline preview; no cloud calls
npm run deploy -- api                 # build, candidate check, then promotion
npm run deploy -- broker --plan
npm run deploy -- policy --plan
npm run rollback -- api --release <release-id>
npm run test:deploy
```

`gcp:<service>:build` and `gcp:<service>:deploy` are compatibility aliases to the same
complete release command. Do not chain them. Builds freeze local source, run tests in
Cloud Build, publish an image, then return control to the workspace for deployment by
digest. `--allow-dirty` explicitly permits uncommitted input. Receipts are in `.gc-deploy/`.

Read `packages/deploy/README.md` before an actual release: the target Artifact Registry,
build account, runtime identities, and existing services must be provisioned first.
The IAM/data-boundary state (runtime accounts, invokers, secrets) is recorded in `docs/capability-policy-iam-review.md`; a `deploy.json` entry with a `blocked` field refuses to deploy until it is removed.
The CLI does not provision infrastructure, change invocation IAM, or publish packages.
The old `configs/cloudbuild.*.yaml` recipes now build only; normal releases generate their
build configuration from `deploy.json`.

To bump the shared base in every language and redeploy: `npm run upgrade-l0000-and-deploy` (or `upgrade-l0000-view-and-deploy`), with `-- --lang 0177 0184`, `--no-force`, `--plan`, `--verbose`. It upgrades and tests languages in parallel, commits each passing upgrade separately, pushes once, then deploys in batches; a failing upgrade is reverted (`scripts/lib/upgrade-and-deploy.js`).
