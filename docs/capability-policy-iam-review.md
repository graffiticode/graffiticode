# Capability policy — Phase 1 IAM & data-boundary review

> **Status:** Phase 1 complete, 2026-09-30. §1.0c records the final state; §1.0b and §1.0 are
> the history (steps applied out of order, and interim deny policies since removed).
> Scope: GCP project `graffiticode` (us-central1) — `auth`, `api`, compilers `l0NNN`,
> and the planned `policy` and `broker` services. Design context:
> `console/docs/graffiticode_capability_policy_spec.md`.

**Evidence legend:** **[LIVE]** = read from GCP with a read-only command. **[REPO]** = read from a
repo file (path given). **[UNVERIFIED]** = inferred or a GCP default. Needs confirming with the
§1.4 commands before any step in §3 runs.

**Live read status:** read 2026-09-27, 2026-09-28 and 2026-09-30 with the §1.4 commands (as
`jeff@artcompiler.com`). **§1.0c (2026-09-30) is the current state and supersedes §1.0b and
§1.0; all three supersede every [UNVERIFIED] below that they cover.**

---

## 1. Current state

### 1.0c Final state, 2026-09-30 [LIVE]

Steps 1–9 are done. No workload runs as a default service account, and neither default
account holds any project role.

| Step | Final state |
|---|---|
| 1 SAs | One per service: `api-run`, `auth-run`, `policy-run`, `broker-run`, and `lNNNN-run` for all 41 compilers. Plus `deploy-build` and `deploy-smoke` for the deploy CLI |
| 2 Deployers | `deploy-build` builds (the deploy CLI's builds run as it); Artifact Registry repo `services` exists. The compiler repos still deploy through the legacy Cloud Build SA |
| 3 Roles | Compiler SAs hold no project roles (they need none) and **no compiler can read a provider secret** (2026-10-15): `learnosity-secret` had no readers and its only version disabled, and was **deleted 2026-10-18**; `GRAFFITICODE_SECRET_KEY` is deleted. `l0013-run` has `storage.objectAdmin` on `gs://graffiticode.appspot.com` |
| 4 Databases | `policy`, `broker`, `(default)`: each limited to its own SA(s); delete protection on for all three |
| 5 Key and secrets | Unchanged from §1.0b |
| 6 Move services | **Every Cloud Run service runs as its own SA.** The last 27 compilers moved 2026-09-30 with `services update --service-account`, each checked by compiling its published `template.gc` against a same-day baseline (no regressions, none reverted) |
| 7 Invokers | Unchanged from §1.0b |
| 8 Shared secrets | Compute SA's access to `GRAFFITICODE_SECRET_KEY` and `learnosity-secret` removed. 2026-10-15: `l0176-run`'s and then `l0158-run`'s access to `learnosity-secret` removed, and its version 1 disabled, and the secret deleted 2026-10-18; `GRAFFITICODE_SECRET_KEY` deleted. L0158 holds no credential: its previews are signed by L0176 through Broker. The credential that secret held was already retired at its provider |
| 9 Strip Editor | `roles/editor` removed from the compute SA and `graffiticode@appspot`; neither holds any project role. The compute SA's `tokenCreator` on itself is removed too. The only Editor holders left are Google-managed service agents (`cloudservices`, `containerregistry`) |

**Interim controls removed.** Deny policies `deny-compute-deploy` and `deny-compute-firestore`
were deleted once the Policy Troubleshooter showed nothing grants the compute SA
`run.services.update`, `iam.serviceAccounts.actAs` or `datastore.entities.get`. The org-level
`roles/iam.denyAdmin` grant made to create them was removed. The GitHub Actions SAs remain
disabled with no keys or roles (delete them after a quiet period).

**Verified 2026-09-30.** All 41 compilers were compiled after Step 9: 33 compile; the other 8
fail exactly as before any IAM change (template or input-data problems, and `l0156`'s missing
Anthropic key). `api`, `auth` and `console` answer 200, and no service logged a permission
error after Editor was removed. Pre-change policies are saved in the session scratchpad only.

**Still open (outside Phase 1)**

- The legacy Cloud Build SA keeps project-wide `run.admin`, `serviceAccountUser`,
  `storage.admin`, `firebase.admin` and `serviceusage.apiKeysAdmin`, because the compiler repos
  deploy through it. Narrowing it means moving those repos to the deploy CLI or a scoped build SA.
- Org policy `iam.automaticIamGrantsForDefaultServiceAccounts` is not enforced; enforce it at the
  org so new projects' default SAs don't get Editor.
- Compilers stay publicly invokable by design (§3.1).
- `l0156` has no Anthropic API key configured, and several compilers publish a `template.gc`
  that does not compile on its own (`l0001`, `l0157`, `l0165`).
- `auth` puts refresh tokens in request URLs (`GET /oauth-tokens?refresh_token=…`), so they land
  in request logs.

### 1.0b Live state and progress, 2026-09-28 [LIVE]

Much of §3 was applied on 2026-09-27, before this read and **out of order**: `policy` and
`broker` were deployed with real images and `BROKER_SECRET_KEY` got a version while the default
compute SA still held Editor, `run.admin`, `serviceAccountUser` and `serviceAccountTokenCreator`.
Step 9's gate was therefore already crossed. The 2026-09-28 changes below close the resulting
exposure without waiting for Steps 6–9.

**Progress by step**

| Step | Applied | Still to do |
|---|---|---|
| 1 SAs | `api-run`, `auth-run`, `l0176-run`, `policy-run`, `broker-run` | 40 compiler SAs (incl. `l0158-run`); `deploy-build`, `deploy-smoke` |
| 2 Deployers | Required APIs enabled (Run, Build, Artifact Registry, Container Analysis, KMS, Secret Manager) | Build/smoke SAs, the `services` Artifact Registry repo, deployer grants. Images still go to `gcr.io` and Cloud Build still runs as the legacy SA |
| 3 Roles | `api-run`: `datastore.user` on `(default)` only, `cloudtrace.agent`. `auth-run`: `datastore.user` on `(default)` only, `roles/firebaseauth.viewer` (the code only calls `getUser`, `verifyIdToken`, `createCustomToken`, so viewer replaces the `firebaseauth.admin` proposed in Step 3), `tokenCreator` on itself | `l0013` bucket grant |
| 4 Databases | `policy` and `broker` (nam5), each `datastore.user` to its own SA only. **Delete protection on for `policy`, `broker` and `(default)`** | — |
| 5 Key and secrets | KMS `policy/token-signing` (P-256; `signer` = `policy-run`, `publicKeyViewer` = `policy-run`, `broker-run`). `policy-callers`, `broker-callers`, `audit-pseudonym-secret` and `BROKER_SECRET_KEY` each at v1, accessor only the intended SA(s). New: `auth-internal-api-key` v1, accessor `auth-run`. Also `auth-cleanup-api-key` v1 (2026-10-21, Step 13), accessors `auth-run` and `auth-maintenance-run` | `broker-learnosity-system` (not created; the broker keeps connection credentials sealed in its own database) |
| 6 Move services | `api` → `api-run`, `l0176` → `l0176-run`, **`auth` → `auth-run`** (revision `auth-00014-9kl`; `INTERNAL_API_KEY` now from `auth-internal-api-key:1`, previously a plain env var readable by anyone with `run.services.get`) | 40 compilers, `l0158` first |
| 7 Invokers | Both services private. `policy`: `api-run`, `console-run@graffiticode-app`, `l0176-run`. `broker`: `l0176-run`, `policy-run` | `deploy-smoke` on both; `l0158-run` once it exists |
| 8 Shared secrets | — | Compute SA still reads `GRAFFITICODE_SECRET_KEY` and `learnosity-secret` (needed until the 40 compilers move) |
| 9 Strip Editor | Compute SA's project `run.admin`, `serviceAccountUser`, `serviceAccountTokenCreator` **removed**; `tokenCreator` re-granted on itself only | `roles/editor` on the compute and App Engine SAs |

**Interim controls, not in §3 (2026-09-28)**

- **Deny policy `deny-compute-deploy`** (project attachment): the compute SA may not
  `run.googleapis.com/services.{create,update,delete,setIamPolicy}` or
  `iam.googleapis.com/serviceAccounts.actAs`. Editor alone grants all but `setIamPolicy`, so
  removing `run.admin` was not enough to stop a compromised compiler redeploying `policy`/`broker`
  or acting as their SAs.
- **Deny policy `deny-compute-firestore`**: the compute SA may not
  `datastore.googleapis.com/entities.{get,list,create,update,delete}`, on any database. This
  closes Editor's access to the `broker` database (`connection-secrets`). Safe only because
  `auth` moved first; no compiler on the compute SA uses Firestore (verified by the sweep below
  for the 40 live compilers, not by source for 16 of them).
- Creating them required `roles/iam.denyAdmin`, which can only be granted on the organization:
  granted to `jeff@artcompiler.com` on org `496958484376` (artcompiler.com).
- **Both deny policies are removed at Step 9**, once Editor is gone; revisit the org
  `denyAdmin` grant then.
- **GitHub service accounts disabled:** `github-actions@` (project `run.admin`,
  `serviceAccountUser`, `storage.admin`, a user-managed key from 2025-10-20, last used
  2026-03-18) and `github-action-564425249@` (Firebase Hosting, key from 2023). Both disabled,
  keys deleted, all 7 project bindings removed. There are no GitHub Actions deploys; delete the
  accounts after a quiet period, and remove any copies of the keys stored as GitHub secrets.
- Policy Troubleshooter API enabled for verification.

**Verified 2026-09-28**

- Policy Troubleshooter, compute SA (Cloud Run resources must be named by **project number**,
  `//run.googleapis.com/projects/656973052505/...`, and calls need `--billing-project=graffiticode`):
  update/delete `broker`/`policy` and `actAs` `broker-run` → allowed by Editor, **denied** by the
  deny policy; `setIamPolicy` on `policy` and `getAccessToken` on `broker-run` → not granted;
  `signBlob` on itself → allowed; `run.services.get` on `l0000` → allowed (control);
  `datastore.entities.get` → allowed by Editor, **denied**.
- `auth` sign-in (Ethereum) succeeded on the compute SA after the `tokenCreator` narrowing, and
  again on `auth-run`: `GET /authenticate/ethereum/…` (Firestore read), `…/internal/exists/…`
  (`INTERNAL_API_KEY` from the secret) and `POST /authenticate/ethereum/…` (custom token) all 200.
- Compile sweep of the 40 compilers still on the compute SA (each language's published
  `template.gc`, parsed with its `lexicon.json`, `POST /compile` with `{}` data): 34 compiled.
  None failed on a permission. The rest were template or data problems (`l0001`, `l0165`
  unparseable template; `l0157` missing terminator; `l0013` sample item not found; `l0158`,
  `l0182` need data) and `l0156`, which has **no Anthropic API key configured** (not caused by
  these changes: no env var or secret of any compiler was touched).
- Brokered save, end to end (console Connection panel **Run** on an L0176 item): `api` →
  policy `invocations` → L0176 → policy `snapshot`, `mint` (`save-to-itembank`,
  `learnosity.write-items`) → broker `execute` → Learnosity, every hop 200 and audited `allowed`.
  A connection created from the console (policy → broker credential provisioning) also succeeded.
  Selecting a connection on an item does not by itself write: only **Run** sends `connectionId`.

**Found, not fixed**

- `auth` logs refresh tokens: `GET /oauth-tokens?refresh_token=…` puts them in Cloud Run request
  logs in cleartext. Move them to a header or body.
- The console logged `DSPy service error … 404` (unrelated to IAM).
- Org policy `iam.automaticIamGrantsForDefaultServiceAccounts` is not enforced; that is how the
  compute SA got Editor. Enforce it at the org once Step 9 is done so new projects don't repeat it.
- Other SAs with project-wide deploy power remain: the legacy Cloud Build SA
  (`run.admin`, `serviceAccountUser`, `storage.admin`, `firebase.admin`,
  `serviceusage.apiKeysAdmin`). It is what the compiler repos deploy as; narrowing it is part of
  Step 2.

Resolved open questions: §5 Q2 (the console's runtime SA is the dedicated
`console-run@graffiticode-app.iam.gserviceaccount.com`); §5 Q1 in part (live list above).

### 1.0 Live state, read 2026-09-27 [LIVE]

| What | Live | Differs from this review's assumption |
| --- | --- | --- |
| Project number | `656973052505` | — |
| Cloud Run services (us-central1) | 43: `api`, `auth`, `l0000`–`l0003`, `l0010`–`l0014`, `l0137`, `l0151`–`l0161` (not `l0162`), `l0163`, `l0165`–`l0183` | More compilers than the 25 local repos |
| Service account of every service | `656973052505-compute@developer.gserviceaccount.com` (default compute) | Confirmed |
| Invokers of every service | `allUsers` | Confirmed |
| Ingress of every service | `all` | Confirmed |
| Default compute SA's project roles | `roles/editor`, **`roles/run.admin`**, **`roles/iam.serviceAccountUser`**, **`roles/iam.serviceAccountTokenCreator`** | Worse than assumed: the runtime SA itself can deploy and modify any Cloud Run service and act as, and mint tokens for, any SA in the project |
| Service accounts in the project | default compute, `firebase-adminsdk-qflje@`, `graffiticode@appspot`, `storage@`, `github-action-564425249@`, `github-actions@` | None of `policy-run`, `broker-run`, `api-run`, `auth-run`, `l*-run` exists |
| Secrets | `GRAFFITICODE_SECRET_KEY`, `learnosity-secret`: each `secretAccessor` → default compute SA only | Confirmed; no other secrets exist |
| Firestore databases | `(default)` only | No named databases |
| Cloud KMS | API not enabled on the project | Must be enabled before §3 step 5 |
| Cloud Build triggers | none (global or us-central1) | Every deploy is manual (`gcloud builds submit`) |

Consequence: any compromised compiler holds `run.admin` and `serviceAccountUser` through the shared
SA, so it could redeploy `policy` or `broker` with its own code, or act as their SAs, once they
exist. Moving `policy`, `broker` and the gateway onto their own SAs (§3 steps 1 and 6) is a
precondition for deploying them, not hardening. Removing those roles from the shared SA
touches all 43 services, so it follows §3 step 6, service by service.

Not yet read: the org policy `iam.automaticIamGrantsForDefaultServiceAccounts`, the Cloud Build
service account, and each service's env var names and secret mounts beyond `l0176`.

### 1.1 Cloud Run services (project `graffiticode`, us-central1)

| Service | Deploy source | Runtime SA | Invoker | Ingress | Secrets mounted |
|---|---|---|---|---|---|
| `api` | `graffiticode/configs/cloudbuild.api.yaml` | none set → **default compute SA** [UNVERIFIED] | `--allow-unauthenticated` → `allUsers` [REPO] | not set → `all` [UNVERIFIED] | none in config. Uses `REDIS_URL`, `INTERNAL_API_KEY` (set out-of-band) [REPO `packages/api/src`] |
| `auth` | `graffiticode/configs/cloudbuild.auth.yaml` | default compute SA [UNVERIFIED] | `allUsers` [REPO] | `all` [UNVERIFIED] | none in config |
| `graffiticode-auth` | `packages/auth/cloudbuild.yaml` (`services update --no-traffic`, buildpacks, `us.gcr.io`) | ? | ? | ? | Probably a legacy service. Confirm it exists, or delete the config (§5) |
| `l0000`…`l0183` (25 local repos; live services may include more, e.g. `l0175` is referenced in `api` but has no local repo) | each `lNNNN/cloudbuild*.yaml` and `package.json gcp:deploy` | default compute SA [UNVERIFIED]. No config sets `--service-account` [REPO, grep of every `l0*/cloudbuild*.yaml`] | `allUsers` in every config [REPO] | `all` [UNVERIFIED] | see below |
| `l0176` | `l0176/cloudbuild.yaml` | default compute SA | `allUsers` | `all` | `--set-secrets=LEARNOSITY_SECRET=learnosity-secret:latest,GRAFFITICODE_SECRET_KEY=GRAFFITICODE_SECRET_KEY:latest` [REPO] |
| `l0158` | `l0158/cloudbuild.yaml` | default compute SA | `allUsers` | `all` | `--update-secrets=LEARNOSITY_SECRET=learnosity-secret:latest`, plus `GRAFFITICODE_SECRET_KEY` out-of-band [REPO] |
| `l0013` | `l0013/…` | default compute SA | `allUsers` | `all` | none. **Writes to GCS bucket `graffiticode.appspot.com`** (thumbnails) with its runtime SA's ADC [REPO `l0013/packages/core/src/snap.ts`] |
| `l0166`, others | — | — | — | — | `GRAFFITICODE_SECRET_KEY` may be mounted out-of-band by `console/scripts/set-compiler-secret.sh` [REPO]. The live list is unknown |

Staging and production variants (`cloudbuild.staging.yaml` / `.production.yaml`) exist for many
languages. Staging services may exist under other names; list them all (§1.4).

**Deploy-config hazard [REPO]:** almost every compiler config uses `--set-env-vars`, and `l0176`
also uses `--set-secrets`. Both replace the whole set. They do not touch `serviceAccountName`: a
`gcloud run deploy` with no `--service-account` keeps the service's current SA. So a migrated
service stays migrated on its next Cloud Build deploy. Still, add `--service-account` to each config
so it is explicit (§3 step 6).

### 1.2 Project IAM and default service accounts

| Principal | Likely roles | Source |
|---|---|---|
| `PN-compute@developer.gserviceaccount.com` (default compute SA) | **`roles/editor`** (auto-granted unless the org policy `iam.automaticIamGrantsForDefaultServiceAccounts` blocked it) | [UNVERIFIED] |
| `graffiticode@appspot.gserviceaccount.com` (App Engine default; bucket `graffiticode.appspot.com` exists, so it likely does too) | `roles/editor` | [UNVERIFIED] |
| `PN@cloudbuild.gserviceaccount.com` (legacy Cloud Build SA), or the compute SA if the project uses the newer build-SA default | `roles/cloudbuild.builds.builder`, plus `roles/run.admin` and `roles/iam.serviceAccountUser` (it deploys Cloud Run) | [UNVERIFIED] |
| Secret `GRAFFITICODE_SECRET_KEY` | `secretAccessor` → **default compute SA** (step 3 of `set-compiler-secret.sh` binds the service's SA, which falls back to `PN-compute@…`) | [REPO] |
| Secret `learnosity-secret` | `secretAccessor` → default compute SA (needed for the l0176/l0158 mounts) | [UNVERIFIED] |

**Why this matters.** If a service runs as the default compute SA with Editor:
- **Firestore:** `roles/editor` includes `datastore.entities.*` on **every** database in the
  project, named databases included. IAM conditions narrow a grant; they cannot subtract from an
  unconditional Editor.
- **Control plane [UNVERIFIED]:** Editor includes `run.services.update`. Whether it also confers
  `iam.serviceAccounts.actAs` on `broker-run` is **not established** — do not assume it from the
  role name. Confirm the *effective* permission for the specific principal and resource:
  `gcloud iam roles describe roles/editor --format=json | jq '.includedPermissions | map(select(test("actAs|run.services.update")))'`
  and, for the concrete pair, the Policy Troubleshooter:
  `gcloud policy-intelligence troubleshoot-policy iam //iam.googleapis.com/projects/$P/serviceAccounts/$(sa broker) --principal-email=$PN-compute@developer.gserviceaccount.com --permission=iam.serviceAccounts.actAs`.
  If both hold, a compromised compiler could redeploy `broker` or attach `broker-run` to a
  revision it controls and read the broker secret; per-secret IAM would not help. `run.services.update`
  on `broker` alone already lets it replace the broker's image, so Step 9 is required either way.
- **Secrets:** today every service that shares the default compute SA shares its secret grants.
  Any compiler, `api` and `auth` can all read `GRAFFITICODE_SECRET_KEY` and `learnosity-secret`.

**Existing boundary leak found in code [REPO]:** `auth` stores its **ES256 private JWKs** in
Firestore `(default)`, collection `keys` (`packages/auth/src/storage/keys.js`, field `privateJwk`).
Any principal with datastore read on `(default)` can mint `auth` access tokens. Today that includes
every compiler if they run as the compute SA. This is outside the scope of the capability work, but
it has the same root cause and the same fix (§3 steps 1, 3, 6, 9).

### 1.3 Firestore and other data

- `(default)` database: used by `api` (`tasks`, lang-override) and `auth` (`keys`, `api-keys`,
  `refresh-tokens`, `oauth-links`, `linked-emails`, `email-invites`, …) through `admin.initializeApp()`
  and ADC [REPO]. Named databases: none known [UNVERIFIED].
- Compilers do not touch Firestore directly (grep of `l0*/packages/*/src`), with one exception:
  `l0013` writes to GCS [REPO].
- `auth` also mints Firebase custom tokens (`firebaseAuth.createCustomToken`,
  `packages/auth/src/services/auth.js:76`). On Cloud Run this needs `iam.serviceAccounts.signBlob`
  on its own SA. **When auth moves to its own SA, grant it `roles/iam.serviceAccountTokenCreator`
  on itself, or sign-in breaks.**
- `api` uses Redis (`REDIS_URL`). If that is Memorystore, the service has a VPC connector or VPC
  egress. Keep networking unchanged when switching the SA (use `services update`, not a fresh deploy).

### 1.4 Read-only commands to turn this section into [LIVE]

```bash
gcloud auth login                        # interactive; the failure above
P=graffiticode; R=us-central1
PN=$(gcloud projects describe $P --format='value(projectNumber)')

# Services: SA, ingress, URL
gcloud run services list --project $P --region $R \
  --format="table(metadata.name,spec.template.spec.serviceAccountName,metadata.annotations.'run.googleapis.com/ingress',status.url)"
# allUsers per service
for s in $(gcloud run services list --project $P --region $R --format='value(metadata.name)'); do
  echo "$s: $(gcloud run services get-iam-policy $s --project $P --region $R \
    --flatten=bindings --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)')"; done
# Env var NAMES and secret REFERENCES only. Never print the env block itself:
# plain (non-secret) env vars carry their values in cleartext there.
gcloud run services describe l0176 --project $P --region $R --format=json \
  | jq '[.spec.template.spec.containers[0].env[]? | {name, secret: .valueFrom.secretKeyRef.name?, version: .valueFrom.secretKeyRef.key?}]'
# Secret volume mounts (names only)
gcloud run services describe l0176 --project $P --region $R --format=json \
  | jq '[.spec.template.spec.volumes[]? | {name, secret: .secret.secretName?}]'

# Project IAM, by member
gcloud projects get-iam-policy $P --flatten=bindings \
  --format='table(bindings.role,bindings.members,bindings.condition.title)'
gcloud iam service-accounts list --project $P
gcloud resource-manager org-policies describe iam.automaticIamGrantsForDefaultServiceAccounts --project $P

# Secrets and who can read them
gcloud secrets list --project $P
for s in $(gcloud secrets list --project $P --format='value(name)'); do
  echo "== $s"; gcloud secrets get-iam-policy $s --project $P --format='table(bindings.role,bindings.members)'; done

# Firestore, KMS, Cloud Build SA
gcloud firestore databases list --project $P
gcloud kms keyrings list --location $R --project $P
gcloud builds list --project $P --limit 5 --format='value(serviceAccount)'
gcloud iam roles describe roles/editor --format=json | grep -E 'actAs|datastore.entities.get|run.services.update|cloudkms.cryptoKeyVersions.useToSign|secretmanager.versions.access'
```

---

## 2. Target access matrix (end of Phase 1)

SA naming: `<name>-run@graffiticode.iam.gserviceaccount.com`. One SA **per language**
(`l0176-run`, `l0158-run`, …). Policy uses the caller's SA email to bind "which language is asking",
so a shared compiler SA would let any compiler mint tokens for L0176's protected functions.

| Principal ↓ / Resource → | invoke `policy` | invoke `broker` | invoke compilers | policy signing key (KMS) | `BROKER_SECRET_KEY` | Firestore `policy` | Firestore `broker` | Firestore `(default)` | Learnosity system creds (`broker-learnosity-system`) |
|---|---|---|---|---|---|---|---|---|---|
| `api-run` | ✓ `run.invoker` (gateway: invocations, publications) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✓ `datastore.user` conditioned to `(default)` | ✗ |
| `auth-run` | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✓ conditioned to `(default)`, plus `tokenCreator` on itself. `secretAccessor` on `act-as-callers`, `act-as-grant-secret` and `audit-pseudonym-secret` (Step 12), and on `auth-migration-operator-key` (the OAuth-store migration's fence and seal; `docs/oauth-store-migration.md`) | ✗ |
| `policy-run` | — | ✓ `run.invoker` (admin routes: provisions connection credentials) | ✓ public | ✓ `cloudkms.signer` + `publicKeyViewer` on the key only | ✗ | ✓ `datastore.user` conditioned to `policy` | ✗ | ✗ (identity comes from verifying the auth token via `auth`, not from reading auth's data) | ✗ |
| `broker-run` | ✗ (it fetches the public key from KMS directly) | — | ✗ | ✓ `publicKeyViewer` only (verifies, cannot sign) | ✓ `secretAccessor` | ✗ | ✓ `datastore.user` conditioned to `broker` | ✗ | ✓ `secretAccessor` |
| `l0176-run` (protected-function compiler) | ✓ `run.invoker` | ✓ `run.invoker` | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (signs only through Broker; `forbiddenEnv` refuses `LEARNOSITY_*`) |
| `l0158-run` | ✗ (removed by 2026-10-20: L0158 renders through L0176) | ✗ (removed by 2026-10-20) | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (`learnosity-secret` deleted 2026-10-18) |
| other `lNNNN-run` | ✗ (add when a language gains a protected function) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `l0013-run` | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗. Separately: `storage.objectCreator` on bucket `graffiticode.appspot.com` |
| Console runtime SA (project `graffiticode-app`) | ✓ `run.invoker` (cross-project; see §3 step 7). The only caller `auth` accepts on `/internal/act-as` (Step 12; auth is public, so this is the caller-identity check, not IAM) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| App-tier front doors `mcp-run@`, `openapi-run@` (project `graffiticode-app`) | ✗: they call no Policy route (core skips the connection lookup for them; connection writes run only in the console). Not in `policy-callers` | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗. They sign act-as grants (Step 12) but are not act-as callers, and hold no model key |
| Default compute SA | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ after Editor removal | ✗ after Editor removal | ✗ after Editor removal | ✗ |
| `auth-maintenance-run` (Step 13) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (it reaches auth's cleanup route over HTTP with the cleanup-only key, not Firestore) | ✗. Only `secretAccessor` on `auth-cleanup-api-key` |
| `auth-maintenance-scheduler` (Step 13) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗. Only `run.invoker` on the job `auth-refresh-token-cleanup` |
| Cloud Build SA | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗. Needs `run.admin` plus `serviceAccountUser` on each runtime SA to deploy it |
| Humans / deployers (Owners) | Owners can do everything; that is accepted. Keep day-to-day deployers on `run.developer` + `serviceAccountUser`, not Owner | | | | | | | | |

Why each row reads as it does:
- **Compilers never hold the signing key or the broker secret.** The spec's premise is that the
  broker checks a token the compiler cannot forge. If a compiler could sign, or read the external
  credential, the token would add nothing.
- **Broker verifies with the public key only.** Using KMS asymmetric signing makes "only policy can
  sign" an IAM fact, not a code convention. The private key never leaves KMS.
- **Policy does not read `(default)`.** It learns the end user's identity by verifying the auth token
  (JWKS or `auth` verify endpoint) that the caller forwards. That avoids handing it `auth`'s `keys`
  collection.
- **Compilers stay publicly invokable** (§3.1). Service identity on calls *from* compilers to
  policy and broker is what Phase 1 adds.

---

## 3. Proposed changes (ordered; each step reversible on its own)

Common variables:

```bash
P=graffiticode; R=us-central1
PN=$(gcloud projects describe $P --format='value(projectNumber)')
COMPUTE_SA=${PN}-compute@developer.gserviceaccount.com
LEGACY_BUILD_SA=${PN}@cloudbuild.gserviceaccount.com # compiler repos' Cloud Build deploys; confirm via §1.4 `gcloud builds list`
BUILD_SA=deploy-build@$P.iam.gserviceaccount.com     # graffiticode repo: builds images only (Step 2)
SMOKE_SA=deploy-smoke@$P.iam.gserviceaccount.com     # graffiticode repo: candidate checks on private services (Step 2)
DEPLOYER=user:<email>                                # each human who runs `npm run deploy`
CONSOLE_SA=<console runtime SA in graffiticode-app>   # open question §5
# Every compiler service that is live, not the local repo list: §1.0 counts 43 services, and
# a service left on the compute SA blocks Steps 8 and 9. Check the names this filter drops.
LANGS=$(gcloud run services list --project $P --region $R --format='value(metadata.name)' | grep -E '^l[0-9]{4}$' | tr '\n' ' ')
gcloud run services list --project $P --region $R --format='value(metadata.name)' | grep -vE '^(l[0-9]{4}|api|auth|policy|broker)$'
PROTECTED="l0176 l0158"                               # compilers with broker-backed functions
sa() { echo "$1-run@$P.iam.gserviceaccount.com"; }
```

**Deploy tooling.** This repository (`api`, `auth`, `policy`, `broker`) now releases through the
workspace CLI in `packages/deploy`, configured by `deploy.json` [REPO]. It changes three things this
review originally assumed: images go to Artifact Registry (`us-central1-docker.pkg.dev/graffiticode/services/*`),
not `gcr.io`; Cloud Build only builds, as a dedicated `deploy-build` SA, and the **human deployer**
deploys the image by digest; and the CLI refuses a service whose runtime SA differs from
`deploy.json` (`packages/deploy/src/release.js`). The compiler repos still deploy through their own
Cloud Build configs, as the legacy Cloud Build SA.

### 3.1 Compilers stay public in Phase 1 (do not add `--no-allow-unauthenticated`)

Browsers and third parties load compiler URLs directly [REPO]:
- `express.static(STATIC_DIR)` is mounted **before auth** in `l0000/packages/api/src/app.ts` and
  `l0176/packages/api/src/app.ts`: `lexicon.json`, `/lexicon.js` alias (removed 2026-10-29), `schema.json`, `spec.html`,
  `instructions.md`, `language-info.json`, `usage-guide.md`, `scope.json`, `template.gc`,
  `/assets/*` (the hashed `/form` bundle), `index.html`.
- `GET /form` serves the embed. `api`'s `/form` route **302-redirects the browser to
  `${compilerBaseUrl}/form?...`** (`graffiticode/packages/api/src/routes/form.js:57-59`). The response
  sets `Cross-Origin-Resource-Policy: cross-origin` so claude.ai and chatgpt.com widget iframes can
  embed it.
- Console fetches `https://lNNNN.graffiticode.org/language-info.json` from the **browser**
  (`console/src/components/tools-gallery.tsx:59`), and fetches `spec.html` server-side
  (`src/pages/api/languages.ts:58`).
- `api` calls `POST /compile` at `https://lNNNN.graffiticode.org` **with no Google identity token**
  (`packages/api/src/lang/compile.js`, `util.js:81`). Per-user overrides point at `…run.app` tag URLs.

A browser cannot attach a Google ID token, so `--no-allow-unauthenticated` would break `/form`,
embeds and the tools gallery. Paths to making `/compile` private later, in rough cost order:
1. **Split services per language:** `lNNNN` (public: static + `/form`) and `lNNNN-compile`
   (private, `run.invoker` = `api-run`). `api` fetches an ID token from the metadata server with
   audience equal to the compile URL. Change `getBaseUrlForLanguage` so it returns separate compile
   and asset bases.
2. **Static to GCS or Firebase Hosting behind the existing domain, and the service private.**
   `/form` must then become a static file, and `api`'s redirect target changes.
3. **External HTTPS LB with serverless NEG:** path-route `/compile` through IAP or a separate
   backend. This costs the most in infrastructure.

Phase 1 does not depend on compiler privacy. The broker trusts **the policy-signed token**, not the
caller. Policy trusts **the forwarded end-user token** for identity, and the **caller's service
identity** only for "which language is asking".

### Step 1: Create service accounts (no effect on running services)

```bash
for n in api auth policy broker $LANGS; do
  gcloud iam service-accounts create $n-run --project $P --display-name "Cloud Run: $n"; done
```
Rollback: `for n in …; do gcloud iam service-accounts delete $(sa $n) --project $P --quiet; done`
(only before step 6 attaches them).

### Step 2: Let deployers act as the new SAs (resource-level, not project-level)

Two deploy paths, so two sets of grants.

**Compiler repos** (Cloud Build deploys): the legacy build SA acts as each compiler's SA.

```bash
for n in $LANGS; do
  gcloud iam service-accounts add-iam-policy-binding $(sa $n) --project $P \
    --member serviceAccount:$LEGACY_BUILD_SA --role roles/iam.serviceAccountUser; done
```

**This repository** (`packages/deploy`): Cloud Build builds and pushes only; the deployer deploys.
The build SA must **not** hold `run.*`, `actAs` on runtime SAs, or any application secret, so a
compromised build step cannot deploy.

```bash
gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com \
  containeranalysis.googleapis.com run.googleapis.com cloudkms.googleapis.com --project $P
gcloud artifacts repositories create services --repository-format docker --location $R --project $P
gcloud iam service-accounts create deploy-build --project $P --display-name "Cloud Build: image builds"
gcloud iam service-accounts create deploy-smoke --project $P --display-name "Deploy: private candidate checks"

# Build SA: push images, write build logs, read the uploaded source.
gcloud artifacts repositories add-iam-policy-binding services --location $R --project $P \
  --member serviceAccount:$BUILD_SA --role roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $P --member serviceAccount:$BUILD_SA \
  --role roles/logging.logWriter --condition=None
gcloud storage buckets add-iam-policy-binding gs://${P}_cloudbuild \
  --member serviceAccount:$BUILD_SA --role roles/storage.objectViewer
# [UNVERIFIED] The test steps pull gcr.io/graffiticode/firebase, so the build SA also needs read on
# wherever that image lives; and the CLI's REGIONAL_USER_OWNED_BUCKET logging needs write on that
# bucket. Confirm both on the first build rather than granting broader roles up front.

# Deployer: submit builds as the build SA, read images, deploy and read services (incl. IAM
# policy), act as the four runtime SAs, read secret-version metadata, mint smoke tokens.
gcloud iam service-accounts add-iam-policy-binding $BUILD_SA --project $P \
  --member $DEPLOYER --role roles/iam.serviceAccountUser
gcloud projects add-iam-policy-binding $P --member $DEPLOYER --role roles/cloudbuild.builds.editor --condition=None
gcloud storage buckets add-iam-policy-binding gs://${P}_cloudbuild --member $DEPLOYER --role roles/storage.objectCreator
gcloud artifacts repositories add-iam-policy-binding services --location $R --project $P \
  --member $DEPLOYER --role roles/artifactregistry.reader
gcloud projects add-iam-policy-binding $P --member $DEPLOYER --role roles/run.developer --condition=None
for n in api auth policy broker; do
  gcloud iam service-accounts add-iam-policy-binding $(sa $n) --project $P \
    --member $DEPLOYER --role roles/iam.serviceAccountUser; done
for s in policy-callers broker-callers audit-pseudonym-secret BROKER_SECRET_KEY; do
  gcloud secrets add-iam-policy-binding $s --project $P --member $DEPLOYER \
    --role roles/secretmanager.viewer --condition=None; done   # after Step 5 creates them
gcloud iam service-accounts add-iam-policy-binding $SMOKE_SA --project $P \
  --member $DEPLOYER --role roles/iam.serviceAccountTokenCreator
```
`secretmanager.viewer` is metadata only (the CLI checks that each pinned version exists); it cannot
read payloads. Owners already hold all of this; the grants are for a non-Owner deployer, which §2
recommends. `SMOKE_SA` gets `run.invoker` on `policy` and `broker` in Step 7.

Rollback: the same commands with `remove-iam-policy-binding`; delete `deploy-build`, `deploy-smoke`
and the `services` repository if nothing has been pushed to it.

### Step 3: Least-privilege roles that reproduce today's needs

```bash
DEF='expression=resource.name=="projects/'$P'/databases/(default)",title=default-db-only'
for n in api auth; do
  gcloud projects add-iam-policy-binding $P --member serviceAccount:$(sa $n) \
    --role roles/datastore.user --condition="$DEF"
done
gcloud iam service-accounts add-iam-policy-binding $(sa auth) --project $P \
  --member serviceAccount:$(sa auth) --role roles/iam.serviceAccountTokenCreator   # custom tokens
gcloud projects add-iam-policy-binding $P --member serviceAccount:$(sa auth) \
  --role roles/firebaseauth.admin --condition=None                                 # getUser/createCustomToken
gcloud storage buckets add-iam-policy-binding gs://graffiticode.appspot.com \
  --member serviceAccount:$(sa l0013) --role roles/storage.objectCreator           # l0013 thumbnails
# Legacy secrets, only for the compilers that mount them today:
for n in l0176 l0158; do
  gcloud secrets add-iam-policy-binding learnosity-secret --project $P \
    --member serviceAccount:$(sa $n) --role roles/secretmanager.secretAccessor --condition=None; done
for n in <each service that mounts GRAFFITICODE_SECRET_KEY per §1.4>; do
  gcloud secrets add-iam-policy-binding GRAFFITICODE_SECRET_KEY --project $P \
    --member serviceAccount:$(sa $n) --role roles/secretmanager.secretAccessor --condition=None; done
# Optional, if OTEL/trace export is on: roles/cloudtrace.agent, roles/monitoring.metricWriter
```
Firestore database-scoped IAM conditions use `resource.name == "projects/P/databases/DB"`. Verify
with a negative test (§4) before relying on them. If a Firestore API call is evaluated against a
resource name the condition does not match, it fails **closed** (denied), not open.

Also audit what `api`/`auth` read out-of-band (e.g. `INTERNAL_API_KEY`, Redis auth secrets). Grant
`secretAccessor` for each secret the service mounts (§1.4 describe output).
Rollback: the same commands with `remove-iam-policy-binding` (projects: same `--condition`).

### Step 4: Named Firestore databases, with access to each

```bash
gcloud firestore databases create --project $P --database policy --location nam5 --type firestore-native
gcloud firestore databases create --project $P --database broker --location nam5 --type firestore-native
gcloud projects add-iam-policy-binding $P --member serviceAccount:$(sa policy) --role roles/datastore.user \
  --condition='expression=resource.name=="projects/'$P'/databases/policy",title=policy-db-only'
gcloud projects add-iam-policy-binding $P --member serviceAccount:$(sa broker) --role roles/datastore.user \
  --condition='expression=resource.name=="projects/'$P'/databases/broker",title=broker-db-only'
```
- Location must match `(default)`'s multi-region. Check with `gcloud firestore databases list`, and
  use `us-central1` if `(default)` is regional.
- App code must open the database by name, e.g. `getFirestore(app, "policy")` (needs firebase-admin
  ≥ 11.10).
- Honest limits:
  - IAM is **per database, not per collection.** `policy` gets the whole `policy` DB, covering
    connections, grants and sessions together. That is acceptable because one service owns them.
  - Security Rules do not apply to server SDKs.
  - Firestore IAM does have separate `datastore.entities.create`, `.update`, `.delete` and `.get`
    permissions, so a custom role *can* grant create without update. Whether that holds depends on
    the API method: e.g. an Admin SDK `create()` commits with an `exists: false` precondition, while
    `set()` without a precondition may require both create and update. **Verify enforcement
    against the exact calls the broker makes** (see §4) before relying on it.
  - A receipt's lifecycle (`pending → succeeded|failed|partial`) is an update. To make receipts
    append-only under a create-only role, store each transition as its own document (claim doc
    created atomically, then an outcome doc created once) rather than mutating one doc. Otherwise
    append-only is a code convention; if tamper-evidence matters, also sink receipts to a locked
    GCS bucket or Cloud Logging.
  - The conditions mean nothing while Editor-bearing SAs exist (step 9).
- After data exists: `gcloud firestore databases update --database policy --delete-protection`.

Rollback: remove the two bindings, then `gcloud firestore databases delete --database policy|broker`
(only while empty and unprotected; a database ID cannot be reused for a while after deletion).

### Step 5: Key material with no values yet

```bash
# Policy signing key: KMS asymmetric P-256 (ES256). The private key never leaves KMS.
gcloud kms keyrings create policy --location $R --project $P
gcloud kms keys create token-signing --keyring policy --location $R --project $P \
  --purpose asymmetric-signing --default-algorithm ec-sign-p256-sha256 --protection-level software
gcloud kms keys add-iam-policy-binding token-signing --keyring policy --location $R --project $P \
  --member serviceAccount:$(sa policy) --role roles/cloudkms.signer
for n in policy broker; do
  gcloud kms keys add-iam-policy-binding token-signing --keyring policy --location $R --project $P \
    --member serviceAccount:$(sa $n) --role roles/cloudkms.publicKeyViewer; done

# Broker secrets: containers only, no versions (values are added later, by a human, out of band)
gcloud secrets create BROKER_SECRET_KEY --project $P --replication-policy automatic
gcloud secrets create broker-learnosity-system --project $P --replication-policy automatic
for s in BROKER_SECRET_KEY broker-learnosity-system; do
  gcloud secrets add-iam-policy-binding $s --project $P \
    --member serviceAccount:$(sa broker) --role roles/secretmanager.secretAccessor --condition=None; done
```
**Service configuration secrets.** The deploy configs (`configs/cloudbuild.policy.yaml`,
`configs/cloudbuild.broker.yaml` on branch `policy-service`) also mount three secrets that the
services refuse to start without:

| Secret | Env var | Mounted by | Value |
|---|---|---|---|
| `policy-callers` | `POLICY_CALLERS` | `policy-run` | JSON caller map (below). Version 4 (2026-10-12, W4 PR 8 prerequisite) adds `l0000-run` as a `compiler` for `0000`, alongside `api-run` (`gateway`), `broker-run` (`broker`), `console-run@graffiticode-app` (`console`) and `l0176-run` (`compiler`, `0176`); validated with Policy's `parseCallers` before upload. `l0000-run` also holds `run.invoker` on `policy` (granted 2026-10-12). |
| `broker-callers` | `BROKER_CALLERS` | `broker-run` | JSON caller map (below) |
| `audit-pseudonym-secret` | `AUDIT_PSEUDONYM_SECRET` | `policy-run`, `broker-run`, `auth-run` (Step 12) | random, ≥ 16 chars; **shared** so the services pseudonymize a user to the same audit id |
| `act-as-callers` | `ACT_AS_CALLERS` | `auth-run` | JSON caller map for `/internal/act-as` (Step 12): `console-run@graffiticode-app` (`console`) only |
| `act-as-grant-secret` | `ACT_AS_GRANT_SECRET` | `auth-run` here (verifies); in project `graffiticode-app`, as its own secret there, the producers that sign: `console-run@`, `mcp-run@` (2026-10-16, R2), `openapi-run@` (2026-10-16, Phase 4) | random, ≥ 32 chars; signs job-bound act-as grants (Step 12) |

```bash
for s in policy-callers broker-callers audit-pseudonym-secret; do
  gcloud secrets create $s --project $P --replication-policy automatic; done
gcloud secrets add-iam-policy-binding policy-callers --project $P \
  --member serviceAccount:$(sa policy) --role roles/secretmanager.secretAccessor --condition=None
gcloud secrets add-iam-policy-binding broker-callers --project $P \
  --member serviceAccount:$(sa broker) --role roles/secretmanager.secretAccessor --condition=None
for n in policy broker; do
  gcloud secrets add-iam-policy-binding audit-pseudonym-secret --project $P \
    --member serviceAccount:$(sa $n) --role roles/secretmanager.secretAccessor --condition=None; done
```

The caller maps bind each verified caller SA to a role (`packages/policy/src/config.js`,
`caller.js`). They hold no credentials, so unlike `BROKER_SECRET_KEY` they can get values right
away; they are secrets only so that changing a caller does not need a redeploy of the image.

```bash
# policy: compilers snapshot + mint for their own language; the console manages
# connections; the gateway (api) allocates invocations and reads publications.
printf '%s' '{
  "'$(sa l0176)'": {"role": "compiler", "lang": "0176"},
  "'$(sa l0158)'": {"role": "compiler", "lang": "0158"},
  "'$CONSOLE_SA'": {"role": "console"},
  "'$(sa api)'": {"role": "gateway"}
}' | gcloud secrets versions add policy-callers --project $P --data-file=-
# broker: compilers execute; policy provisions connection credentials (admin routes).
printf '%s' '{
  "'$(sa l0176)'": {"role": "compiler", "lang": "0176"},
  "'$(sa l0158)'": {"role": "compiler", "lang": "0158"},
  "'$(sa policy)'": {"role": "policy"}
}' | gcloud secrets versions add broker-callers --project $P --data-file=-
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add audit-pseudonym-secret --project $P --data-file=-
```

`BROKER_SECRET_KEY`, when it is provisioned (after Step 9), is 32 bytes as 64 hex characters or
base64 (`openssl rand -base64 32`); `packages/broker/src/secret-box.js` rejects anything else.

A caller map entry only takes effect for an SA that also holds `run.invoker` on the service
(Step 7). The code on `policy-service` has two callers the access matrix in §2 does not: `api-run`
calls policy (gateway role) and `policy-run` calls broker (policy role). Step 7 grants both.

Rollback: `gcloud secrets delete <name>` for each of the three.

If the ES256 key must be a JWK in Secret Manager instead (the plan's literal wording), create
`POLICY_SIGNING_JWK` the same way, with the accessor role for `policy-run` only. KMS is preferred:
a leaked Secret Manager accessor leaks the key, while a leaked KMS signer grant only allows signing
while the grant lasts.

Rollback:
- Remove the bindings.
- `gcloud secrets delete <name>`.
- KMS: `gcloud kms keys versions disable|destroy 1 --key token-signing …`. Keyrings and keys cannot
  be deleted, only their versions (a scheduled destroy with a 24h default).

### Step 6: Move existing services onto their SAs, one at a time

Do one service per change and watch logs. Start with a low-traffic compiler, then `l0013`,
`l0176`/`l0158`, then `api`, and `auth` last (sign-in is the highest blast radius).

```bash
gcloud run services update l0000 --project $P --region $R --service-account $(sa l0000)
# … each $LANGS, then:
gcloud run services update api  --project $P --region $R --service-account $(sa api)
gcloud run services update auth --project $P --region $R --service-account $(sa auth)
```
`services update` keeps the image, env, secrets and VPC settings; it only rolls a new revision.
Then, in each compiler repo, add `--service-account=<name>-run@graffiticode.iam.gserviceaccount.com`
to every `cloudbuild*.yaml` Deploy step and every `gcp:deploy` script. That is a separate, reviewed
change per repo and is not part of this review.

In this repository, `deploy.json` already names `api-run` and `auth-run`, and the CLI refuses a
service whose runtime SA differs. So **`npm run deploy -- api` and `-- auth` fail until this step
moves those two services.** Do not work around that by editing `deploy.json` back to the compute SA.

Rollback, per service:
`gcloud run services update <svc> --service-account $COMPUTE_SA`, or
`gcloud run services update-traffic <svc> --to-revisions <previous>=100`.

### Step 7: Deploy `policy` and `broker` private, then add invokers

```bash
for n in policy broker; do
  gcloud run deploy $n --project $P --region $R --image us-docker.pkg.dev/cloudrun/container/hello \
    --service-account $(sa $n) --no-allow-unauthenticated --ingress all; done
for c in $PROTECTED; do
  for n in policy broker; do
    gcloud run services add-iam-policy-binding $n --project $P --region $R \
      --member serviceAccount:$(sa $c) --role roles/run.invoker; done; done
gcloud run services add-iam-policy-binding policy --project $P --region $R \
  --member serviceAccount:$CONSOLE_SA --role roles/run.invoker
# Gateway → policy (invocations, publications) and policy → broker (credential provisioning),
# matching the caller maps in Step 5.
gcloud run services add-iam-policy-binding policy --project $P --region $R \
  --member serviceAccount:$(sa api) --role roles/run.invoker
gcloud run services add-iam-policy-binding broker --project $P --region $R \
  --member serviceAccount:$(sa policy) --role roles/run.invoker
# The deploy CLI's candidate checks (GET / and, for policy, /v1/jwks) on the private services.
for n in policy broker; do
  gcloud run services add-iam-policy-binding $n --project $P --region $R \
    --member serviceAccount:$SMOKE_SA --role roles/run.invoker; done
```

The placeholder deploy is also the CLI's bootstrap: it only releases to an existing service with
100% of traffic on one revision, so it always has a rollback target. `SMOKE_SA` has no caller-map
entry, so it reaches only the unauthenticated `/` and `/v1/jwks` routes.

How callers reach `policy`, and why:
- **Compilers → policy (snapshot, mint).** The compiler sends its Google ID token (audience = the
  policy `run.app` URL) in `X-Serverless-Authorization`, and forwards the end user's auth access
  token in `Authorization`. Cloud Run IAM checks the first; policy verifies the second itself
  against auth's JWKS.
- **Caller (service) identity inside policy.** Policy binds `lang` to the calling SA (`l0176-run`
  may only obtain snapshots and tokens for L0176 functions), so it needs a trustworthy caller
  email. Cloud Run **removes the signature** from `X-Serverless-Authorization` before forwarding
  it, so policy must NOT run ordinary JWT verification on that header (it would fail), and must
  not treat an unsigned token it could not verify as proof by itself. Chosen design:
  - The compiler also sends a **second Google ID token** in `X-Caller-Identity`, audience
    `urn:graffiticode:policy`, minted for its own SA. Policy verifies it fully (Google certs,
    issuer, audience, expiry, `email_verified`) and takes the caller email only from it.
  - Cloud Run IAM on `X-Serverless-Authorization` remains the outer gate (only invoker SAs reach
    the container at all). Policy additionally requires the verified `X-Caller-Identity` email to
    be an invoker SA and to match the stripped header's `email` claim, so the two cannot disagree.
  - Tests (Step 7 verification): (a) valid invoker token + matching caller token → 200; (b) caller
    token for a different SA than the invoker token → 403 from policy; (c) caller token with wrong
    audience or expired → 403; (d) a crafted, unsigned `X-Caller-Identity` → 403; (e) no invoker
    token → 403 at Cloud Run before the container.
- **Console → policy (grant/connection management).** Keep `policy` IAM-only and have the console
  **server** (Next.js resolver in `graffiticode-app`) call it with its runtime SA's ID token in
  `X-Serverless-Authorization`, plus the user's token in `Authorization`. This matches how the
  console already proxies `api`, needs no `allUsers` on the service that can mint tokens, and gives
  a single auditable caller.
  - **Same caller-identity contract as compilers.** The console server also sends
    `X-Caller-Identity`: a Google ID token for its own SA, audience `urn:graffiticode:policy`,
    which policy verifies fully and matches against the invoker, exactly as for compilers. Policy
    takes the caller only from that verified token.
  - **Route authorization by caller.** Policy maps each verified caller SA to the routes it may
    use: the console SA may call only the **management** routes (connections, grants, "granted to
    me"), always on behalf of the verified end user in `Authorization`; compiler SAs may call only
    **snapshot** and **mint**, for their own language. A console call to snapshot/mint, or a
    compiler call to a management route, is refused (403) and audited.
  - Tests (Step 7): the five caller-identity tests above, repeated for the console SA, plus
    console→mint and compiler→grant-create both returning 403.
  - Alternative: policy public, with every route requiring a verified user token (a Firebase ID
    token from project `graffiticode`, or an auth access token). It works, but it exposes the mint
    and snapshot routes to the internet, guarded only by app code.
  - If a browser ever needs policy directly, deploy a separate `policy-public` service (same image,
    management routes only, `allUsers`) rather than opening `policy`.
- **Broker → policy:** none. The broker verifies tokens with the KMS public key.
- **Policy → broker (credential provisioning).** When a connection is created or its secret
  rotated, policy stores the credential through the broker's admin routes, so the value is sealed
  under `BROKER_SECRET_KEY` and policy never holds it at rest. Policy sends the same two Google ID
  tokens as any caller (audience `urn:graffiticode:broker` in `X-Caller-Identity`); the broker
  admits only the `policy` role to admin routes (`packages/broker/src/app.js`).
- **Gateway → policy (invocations, publications).** `api` allocates an invocation for each compile
  through a connection and reads publication state, under the `gateway` role. Both routes refuse
  any other role. Without `POLICY_URL` set, `api` refuses those compiles rather than running them
  unguarded (`packages/api/src/app.js`).
- **Ingress:** `all` in Phase 1. `internal` would require compilers to egress through a VPC (Direct
  VPC egress), and would block the cross-project console. Revisit for `broker` once compilers have
  VPC egress: `broker` could then go `--ingress internal`.

Rollback:
- `gcloud run services remove-iam-policy-binding …` for each invoker.
- `gcloud run services delete policy|broker` (nothing depends on them until compilers ship calls).

### Step 8: Retire the default compute SA's grants on shared secrets

This applies once `gcloud run services list` shows no service on `$COMPUTE_SA`.

```bash
for s in GRAFFITICODE_SECRET_KEY learnosity-secret; do
  gcloud secrets remove-iam-policy-binding $s --project $P \
    --member serviceAccount:$COMPUTE_SA --role roles/secretmanager.secretAccessor; done
```
Also update `console/scripts/set-compiler-secret.sh`: it already binds the service's own SA. After
migration it no longer falls back to the compute SA, so no change should be needed. Verify on the
next run.
Rollback: `add-iam-policy-binding` with the same member and role.

### Step 9: Strip Editor and the control-plane roles from default SAs. Gate: required before broker holds production credentials

```bash
# §1.0 [LIVE]: the compute SA holds these three on top of Editor. They, not Editor, are what let a
# compromised compiler redeploy policy/broker or act as their SAs, so removing Editor alone is not enough.
for role in roles/editor roles/run.admin roles/iam.serviceAccountUser roles/iam.serviceAccountTokenCreator; do
  gcloud projects remove-iam-policy-binding $P --member serviceAccount:$COMPUTE_SA --role $role; done
gcloud projects remove-iam-policy-binding $P --member serviceAccount:$P@appspot.gserviceaccount.com --role roles/editor
```
Preconditions:
- No Cloud Run service, Cloud Function, App Engine version, Scheduler job, or **Cloud Build**
  (if it builds as the compute SA) still runs as these SAs.
- `gcloud builds list` shows the build SA. If it is the compute SA, first give Cloud Build a
  dedicated SA with `cloudbuild.builds.builder`, `run.admin`, `artifactregistry.writer` /
  `storage.admin` (gcr), and `serviceAccountUser` on the runtime SAs.
- Use IAM Recommender or Policy Analyzer on `$COMPUTE_SA` to confirm 90 days of no use.

**Risk statement.** While any compiler runs as a principal with `roles/editor`, the data boundary is
nominal. Editor's `datastore.entities.*` would reach the `broker` database. Whether the same
principal could also redeploy `broker` or act as `broker-run` depends on its **effective**
permissions (`run.services.update` on `broker`, `iam.serviceAccounts.actAs` on `broker-run`),
which are **unverified** — confirm them with the §1.2 troubleshooter commands rather than inferring
them from the role. The database exposure alone is enough to require this step. Order therefore
matters:
1. Steps 6 and 8 (compilers off the compute SA).
2. Step 9 (Editor and the three control-plane roles removed).
3. Only then add a version to `BROKER_SECRET_KEY` / `broker-learnosity-system`.

The broker refuses to start without `BROKER_SECRET_KEY` (`packages/broker/src/main.js`), and the
deploy CLI requires a pinned version of it. So the first real broker release (Step 10) cannot
happen before this step; only the Step 7 placeholder can.

Rollback: `add-iam-policy-binding` for each removed role, the same members.

### Step 10: First real releases (this repository)

```bash
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add BROKER_SECRET_KEY --project $P --data-file=-
npm run deploy -- broker --plan      # lists the variables still missing
export GC_DEPLOY_BUILD_ACCOUNT=$BUILD_SA GC_DEPLOY_SMOKE_ACCOUNT=$SMOKE_SA
export BROKER_CALLERS_VERSION=<n> POLICY_CALLERS_VERSION=<n> AUDIT_PSEUDONYM_SECRET_VERSION=<n> BROKER_SECRET_KEY_VERSION=<n>
```
1. Remove the `blocked` field from `broker` and `policy` in `deploy.json` (a reviewed commit).
2. `npm run deploy -- broker`.
3. `BROKER_URL=<broker run.app URL> npm run deploy -- policy`. Its candidate check requires
   `/v1/jwks` to answer, which proves the KMS public key read works.
4. Add `POLICY_URL` to `api`'s `env` in `deploy.json`, then `npm run deploy -- api`.

Rollback: `npm run rollback -- <service> --release <id>` restores the previous traffic split. It
does not undo IAM or secret versions.

---

### Step 11: The approved-revisions database (capability plan W4, PR 1)

Admitted plans pin compiler revisions that the `revisions` database records as `approved`
(`packages/deploy/src/revisions.js`, `packages/policy/src/revisions.ts`). It's written only by the
deploy identity (the operator, with their own credentials). Policy's runtime account reads it and
can't write it. Firestore rules don't bind server clients, so the boundary is IAM. Create the
database and grant the read **before** the first release of a `pinnable` service (`l0000`,
`l0176`): such a release records its revision before promotion and doesn't promote if it can't.

```bash
P=graffiticode
gcloud firestore databases create --project $P --database revisions --location nam5 \
  --type firestore-native --delete-protection
gcloud projects add-iam-policy-binding $P --member serviceAccount:$(sa policy) --role roles/datastore.viewer \
  --condition='expression=resource.name=="projects/'$P'/databases/revisions",title=revisions-db-read-only'
```

Then record the revisions already serving (released before their service was pinnable), from
their receipts:

```bash
npm run deploy -- approve l0176 --release <current l0176 release id>
npm run deploy -- approve l0000 --release <current l0000 release id>
```

Verification, before anything relies on it. Two parts: who can write `revisions` at all, and
behavioural probes of `policy-run`'s actual access.

**1. Every principal that can write it.** Policy Analyzer resolves the effective permissions on
the database, including roles inherited from the folder or organization, custom roles and basic
roles. A project-level `jq` over `get-iam-policy` would miss those.

```bash
# Asked of the project, where every grant is made. The database itself isn't in Asset
# Inventory's resource search (asking about it returns NOT_FOUND, "not fully explored").
# A conditional binding is listed as CONDITIONAL; check that its condition names another
# database.
gcloud asset analyze-iam-policy --project=$P \
  --full-resource-name=//cloudresourcemanager.googleapis.com/projects/$P \
  --permissions=datastore.entities.create,datastore.entities.update,datastore.entities.delete --format=json
R=//firestore.googleapis.com/projects/$P/databases/revisions
```

Expected: only human operators (`user:`). Any service account listed can write approvals, which
defeats the boundary. Remove its role, or scope its condition to its own database, before relying
on it. The Policy Troubleshooter answers the same question for one principal at a time, and is
supporting evidence:
`gcloud policy-intelligence troubleshoot-policy iam $R --principal-email=$(sa policy) --permission=datastore.entities.create`.

**2. Behavioural probes as `policy-run`,** against disposable documents in a `probes`
collection, which nothing reads. They need the operator to hold `serviceAccountTokenCreator` on
`policy-run`, so grant it, probe, and revoke it:

```bash
OP=$(gcloud config get-value account)
gcloud iam service-accounts add-iam-policy-binding $(sa policy) --project $P \
  --member user:$OP --role roles/iam.serviceAccountTokenCreator
D=https://firestore.googleapis.com/v1/projects/$P/databases/revisions/documents/probes
N=probe-$(date +%s)
OPT=$(gcloud auth print-access-token)
# A document for policy-run to read, try to update and try to delete, seeded by the operator.
curl -s -o /dev/null -w "seed %{http_code} (expect 200)\n" -X PATCH -H "Authorization: Bearer $OPT" \
  -H "Content-Type: application/json" "$D/$N-seed" -d '{"fields":{"probe":{"stringValue":"seed"}}}'
T=$(gcloud auth print-access-token --impersonate-service-account=$(sa policy))
probe() { curl -s -o /dev/null -w "%{http_code}  $1\n" -X "$2" -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" "$3" ${4:+-d "$4"}; }
probe "get    (expect 200)" GET    "$D/$N-seed"
probe "list   (expect 200)" GET    "$D"
probe "create (expect 403)" POST   "$D?documentId=$N-created" '{"fields":{"probe":{"stringValue":"x"}}}'
probe "update (expect 403)" PATCH  "$D/$N-seed?currentDocument.exists=true" '{"fields":{"probe":{"stringValue":"changed"}}}'
probe "delete (expect 403)" DELETE "$D/$N-seed"
# Clean up as the operator (the created one exists only if create was wrongly allowed),
# and take the grant back.
for doc in seed created; do curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $OPT" "$D/$N-$doc"; done
gcloud iam service-accounts remove-iam-policy-binding $(sa policy) --project $P \
  --member user:$OP --role roles/iam.serviceAccountTokenCreator
```

The read probes passing and each write probe answering 403 is the evidence the boundary holds
for `policy-run`. Record the output in the as-built release record. The Analyzer's list is the
evidence that nothing else but the operators can write.
**Applied and verified 2026-10-07:**
- **Created:** the database (nam5, delete protection on, `concurrencyMode: PESSIMISTIC`, so
  transactions lock what they read, which the retirement fence relies on). Granted `policy-run`
  `datastore.viewer` with the condition `revisions-db-read-only`.
- **Probes as `policy-run`** (impersonated, disposable documents): get 200, list 200, create
  403, update 403, delete 403. Cleaned up, and the temporary token-creator grant revoked. IAM
  changes took about a minute to apply, in both directions; the probe waits up to 8 minutes.
- **Writers per Policy Analyzer** (project, fully explored):
  - `api-run`, `auth-run`, `broker-run` and `policy-run`'s `datastore.user`: CONDITIONAL, each
    scoped to its own database, so they can't write `revisions`.
  - Unconditional: the three Owners (operators, as intended), and these:
    - the legacy Cloud Build account (`roles/firebase.admin`). **Removed 2026-10-07**: no
      triggers, no Firebase or Firestore admin activity in 30 days, and its remaining builds only
      push images and `gcloud run deploy`, which `run.admin` and `serviceAccountUser` still
      cover. Restore with `add-iam-policy-binding … --role roles/firebase.admin` if an old
      recipe turns out to need it.
    - `firebase-adminsdk-qflje`, which has two unintended authorities over approvals:
      - **Direct writes:** `roles/firebase.sdkAdminServiceAgent` (Firestore access across the
        project, the `revisions` database included). Policy Analyzer lists it as an unconditional
        writer for this reason.
      - **Impersonation:** project-wide `roles/iam.serviceAccountTokenCreator`, so it can act as
        any service account in the project. That reaches approval writes through any service
        account that can write `revisions`, or can grant that, now or later. (Impersonating
        `policy-run` doesn't write: its access to `revisions` is read-only, verified by the
        probes above.)

      It has two user-managed, non-expiring keys. The
      2022 key `d40cd54b…` (no recorded use) was **disabled 2026-10-07**. Key `6bfb0894…`
      (created 2026-02-03) **last authenticated 2026-09-11** (Policy Analyzer reports the day only; see the investigation below).
      **CLOSED 2026-10-12 (Jeff):** the gate no longer blocks W4 activation. See "Gate
      closed", at the end of this checklist. *(Original requirement:)* Find that key's users and
      migrate them. Then remove both authorities and verify that each is gone. Removing the key alone isn't enough: anyone
      who can act as the account still holds both. The gap is to be closed by removal, not
      accepted. The 2026-09-11 authentication remains unattributed.
      - **Investigation, 2026-10-07.** No key material was read or printed: searches listed file
        names only, and secrets by name and update date only.
        - Local: no file under `~/work`, `~/Downloads`, `~/Desktop`, `~/Documents` or
          `~/.config` names the key id or the account, except these docs and gcloud's own logs
          of the IAM inspections above.
        - GitHub, per-repository Actions secrets in the `graffiticode` organization: two could
          hold a downloaded key, `console`'s `FIREBASE_SERVICE_ACCOUNT_GRAFFITICODE` (updated
          2023-01-15) and `l0002`'s `GCP_SA_KEY` (updated 2025-10-20). Both were last updated
          before the key was created (2026-02-03), so **neither holds it**. No current workflow
          in either repository references them.
        - Organization-level Actions secrets: only `NPM_TOKEN`, so no key there.
        - Not checked: other GitHub organizations, hosting providers' environment variables,
          other machines, and every deployed service's environment and mounted secrets.
        - **Found: a key file on an operator workstation**, used by local tooling. The
          key-specific audit logs show Storage writes from L0013's thumbnail upload during its
          local development (2026-06-02). The console repository's admin scripts also use the
          file, through `GRAFFITICODE_CREDENTIALS`; those read Firestore, which the audit logs
          don't record (Data Access logs are off). The latest use found was 2026-09-10. **No
          deployed consumer was identified in the checks performed**: deployed L0013 sets neither
          credential variable and runs as `l0013-run@`.
        - **Not established:** that these are the only consumers, or which use was the
          2026-09-11 authentication.
        - **Migration checklist.** The gate closes after step 6. Reordered 2026-10-08: the
          gate depends on the account's authority, not on its key, so key deletion, the only
          irreversible step, comes last.
          1. Move the consumers to application-default credentials, and merge: L0013 (this
             repository) and the console's admin scripts (`graffiticode/console` #8). **Done
             2026-10-07.**
          2. **Exercise both migrated consumers successfully with ADC.** **Done 2026-10-08**: a
             console admin script read the `graffiticode` project's Firestore; L0013's upload
             path (its credential setup and public-read save) wrote to and deleted from
             `thumbnails/`.
          3. Key `6bfb0894…` **disabled 2026-10-07** (reversible). New authentications with the
             key are refused, but disabling doesn't revoke short-lived credentials already issued
             with it (up to an hour). Step 4 records the exact disable time from the audit log, and
             tells activity on those credentials apart from anything later. The observation period
             continues alongside the steps below. A quiet period doesn't show there are no
             infrequent consumers.
          4. **Check for remaining consumers and record coverage**: `node scripts/sa-consumers.js`
             (read-only; tests in `scripts/test/sa-consumers.test.js`). Each check reports
             `PASS`, `FOUND` or `INCOMPLETE`. A failed command, including an API that's disabled,
             is `INCOMPLETE`, never an empty inventory. The verdict passes only if every check is
             `PASS`, or `INCOMPLETE` and accepted by the operator with a recorded reason
             (`--accept <check>=<reason>`; a `FOUND` can't be accepted). It writes the evidence,
             including the full Analyzer response, to `.gc-deploy/iam/`. The checks:
             - **Workloads:** every reachable Cloud Run revision (serving or tagged), read from the
               revision itself; Cloud Run jobs, Cloud Build triggers, Cloud Scheduler jobs and
               Eventarc triggers in every enumerated region; Cloud Functions in all regions; App
               Engine versions; Compute instances; Pub/Sub push subscriptions. An Asset Inventory
               search is recorded as supplementary only, since it covers selected metadata.
             - **Who can act as it:** Policy Analyzer for `actAs`, `getAccessToken`, `signJwt`,
               `signBlob`, `getOpenIdToken` and `implicitDelegation`, with groups expanded and
               indirect impersonation paths analyzed. The analysis must be fully explored, with
               no errors, unexpanded groups or conditional bindings. Anyone other than the
               project's Owners and the account itself is `FOUND`. Both user-managed keys must be
               disabled.
             - **Its authentications:** the key's disable time, and audit log entries made as the
               account since then. Entries within an hour that used the key are credentials issued
               before the disable; anything else means another consumer. Policy Analyzer's last
               authentications for the account and the key are reported by day, so one on the
               disable day itself is `INCOMPLETE`. Data Access logging is off, so empty logs are
               limited evidence.
             - **Not covered**, recorded with the evidence: Workflows, Cloud Tasks, Dataflow,
               Vertex AI and GKE workload identity; resources in other projects; untagged
               revisions with no traffic.

             If a legitimate dependency turns up, migrate it to a dedicated identity with only the
             permissions it needs, before step 5.

             **First run, 2026-10-08** (`.gc-deploy/iam/sa-consumers-2026-10-08T15-27-24-190Z.json`,
             before the review fixes in `258d0d3`; to be re-run). Verdict `FOUND`, with no
             exceptions accepted:
             - **No consumer found.** No reachable Cloud Run revision (118), Cloud Function,
               Compute instance, App Engine version or Cloud Build trigger runs as the account. Both
               keys are disabled; the key's disable was recorded at 2026-10-07T23:38:49Z. No
               matching activity since, and both Policy Analyzer last authentications are
               2026-09-11, within the stated logging limits.
             - **`INCOMPLETE` (3):** Cloud Run jobs in `me-central2` (permission denied: an opt-in
               region), and the Scheduler and Eventarc APIs (reported as never used or disabled).
               These are for the operator to accept or resolve.
             - **`FOUND`: eight principals can act as the account, all through project-wide
               roles** that reach every service account in the project, not this one in
               particular. These are access paths, not evidence of use:
               - seven Google-managed service agents: App Engine (`gcp-gae-service`), Cloud Build
                 (`gcp-sa-cloudbuild`), Cloud Functions (`gcf-admin-robot`), Compute
                 (`compute-system`), Cloud Run (`serverless-robot-prod`), Container Registry
                 (Editor) and the Google APIs agent (`cloudservices`, Editor). Some, with Editor, can
                 also write `revisions` directly. Section 3 lists some of these agents as accepted.
                 Whether they're accepted on this path, the operator decides.
               - **the legacy Cloud Build account** (`PN@cloudbuild.gserviceaccount.com`):
                 project-wide `iam.serviceAccountUser` (`actAs`), so a build running as it can deploy
                 a workload as any service account. It is still in active use: builds up to
                 2026-10-06 (`global`) and 2026-10-03 (`us-central1`), for many language images. It
                 can't be removed outright without checking which of those builds deploy and as
                 whom. Narrowing it to per-account grants on the runtime accounts it deploys is the
                 open item already listed for Step 2.
             - **Assessment.** No consumer of this account was found. The access paths don't block
               step 5: once its two grants are gone, acting as this account confers no approvals
               authority. They do bear on step 6, which asks who can write `revisions` and who can
               act as those writers: the Editor-holding agents, and the legacy Cloud Build
               account's project-wide `actAs`, must be resolved or explicitly accepted there.

             **Second run, 2026-10-08** (`.gc-deploy/iam/sa-consumers-2026-10-08T16-59-12-995Z.json`,
             no exceptions accepted): the same eight access paths and three `INCOMPLETE` checks; no
             reachable revision (118) runs as the account; both keys disabled; the authentication
             checks pass within their limits.

             **Step 4 decision, recorded 2026-10-08 (Jeff).** The checker's `FOUND` verdict
             stands; step 4 is cleared by this recorded decision, not by a changed verdict:
             - **The three `INCOMPLETE` inventories** (Cloud Run jobs in `me-central2`; Cloud
               Scheduler; Eventarc): *inventory unavailable; residual dependency risk accepted*,
               **for the reversible step 5 removal only.** Not recorded as empty: the errors say
               "permission denied" and "never used or disabled", which don't establish that no
               resources exist.
             - **The seven Google-managed agents' access paths:** deferred to step 6. They are not
               exempted by identity class: acting as this account is harmless to approvals only
               once its effective authority is removed and verified. The two Editor-holding agents'
               direct write access to `revisions` needs its own explicit disposition at step 6.
             - **The legacy Cloud Build account:** handled at step 6. It doesn't delay step 5, but
               its access to every other approvals writer must be resolved or explicitly accepted
               before W4 activation.
          5. **Remove both authorities from `firebase-adminsdk-qflje` outright** (decided
             2026-10-07), once steps 1-4 are done:
             - `roles/firebase.sdkAdminServiceAgent`, its direct Firestore write access, which
               includes `revisions`;
             - the project-wide `roles/iam.serviceAccountTokenCreator`.

             Don't add a replacement grant unless a remaining requirement has been shown. Both
             removals are reversible: re-adding a binding restores it, and whatever needed it is a
             consumer to migrate. **If either grant is restored, the gate reopens.**
          6. **Verify both**, read-only. **The gate closes here**:
             - Policy Analyzer for writers of the `revisions` database (this step's check) lists
               no unintended principal;
             - for each service account that check lists, Policy Analyzer for who can impersonate
               it shows nothing beyond the operators: every signing and delegation permission
               (`actAs`, `getAccessToken`, `signJwt`, `signBlob`, `getOpenIdToken`,
               `implicitDelegation`), with indirect impersonation paths analyzed, and the analysis
               fully explored;
             - `firebase-adminsdk-qflje` holds no project-wide token-creator;
             - **fresh step 4 evidence** (`node scripts/sa-consumers.js`, run after step 5) shows no
               unresolved consumer finding: no workload runs as the account and no activity since
               the disable;
             - **every authority path has a recorded disposition**: each principal the evidence
               lists as able to act as the account, each writer of `revisions`, and each principal
               able to act as a writer, recorded as removed, or explicitly accepted with a reason.
               This includes the two Editor-holding Google agents and the legacy Cloud Build
               account. The checker's verdict may remain `FOUND` for access paths; what closes
               the gate is that none is left without a disposition.
          7. Delete the key, and its file on the workstation. This is hygiene, not authority: a
             disabled key on an account with neither grant can't write approvals, even if it is
             re-enabled.

          **Step 5 done, 2026-10-08:** Jeff removed `roles/firebase.sdkAdminServiceAgent` and the
          project-wide `roles/iam.serviceAccountTokenCreator` from `firebase-adminsdk-qflje`
          (both unconditional bindings). Its only remaining project role is `roles/storage.admin`.

          **Step 6 evidence, 2026-10-08** (all under `.gc-deploy/iam/`):
          - **Fresh step 4 run** (`sa-consumers-2026-10-08T18-14-16-827Z.json`, after the
            removals). No consumer: no reachable revision (118) or other inventoried workload runs
            as the account; both keys disabled; no activity since the disable. The same three
            inventories are `INCOMPLETE`, and the same eight principals can act as the account, now
            by direct paths only. The indirect paths of the earlier runs are gone.
          - **Writers of `revisions`** (`revisions-writers-2026-10-08.json`; project scope; fully
            explored, no errors; `datastore.entities.create`, `update` and `delete`).
            `firebase-adminsdk-qflje` is no longer listed.
          - **Who can act as the Google-agent writers** (`actas-<agent>-2026-10-08.json`):
            `INCOMPLETE`. Each agent lives in a Google-owned project, and the Analyzer reports "no
            resource found" in this project's scope, so its IAM can't be analyzed from here.

          **Step 6 dispositions: PROPOSED 2026-10-08, revised after review; pending Jeff's
          approval.** One row per authority path the evidence lists, each to be removed, or
          accepted with the function it serves and the residual risk accepted. **Step 6 is not
          ready to close the gate:** who can act as the remaining Google-agent writers couldn't be
          analyzed, so paths through them stay unresolved until accepted explicitly. W4
          activation stays blocked until every row is approved, and any removal is done and
          re-verified.

          | Authority path | Evidence | Proposed disposition |
          |---|---|---|
          | Owners: `user:admin@artcompiler.com`, `user:jeff@artcompiler.com`, `user:kevin.m.dyer@gmail.com` (write `revisions`) | writers; Jeff's confirmation, 2026-10-08 | **Accepted as authorized operators.** Jeff confirmed that all three remain current. |
          | `service-PN@containerregistry` agent, project Editor (wrote `revisions`, could replace W4 code) | writers; deployment paths; dependency check | **Removed, 2026-10-12.** **Dependency check** (read-only): `gcr.io` here is served by Artifact Registry (`REDIRECTION_FROM_GCR_IO_ENABLED`), and the images in use resolve there: `gcr.io/graffiticode/l0158@sha256:822cf90a…` and the release pipeline's pinned `gcr.io/graffiticode/firebase@sha256:8b553694…` both resolve to `us-docker.pkg.dev/graffiticode/gcr.io/…`. 26 of the 48 Cloud Run services pull from `gcr.io`, all served that way. Neither the agent nor the Container Registry API had any audit activity in 90 days. The legacy buckets (`artifacts.graffiticode.appspot.com`, `us.artifacts.…`) remain but aren't used. Jeff then **removed its Editor binding**. **Verified:** build `47aa0528-dbaa-4d5f-8e64-e545700aab70` redeployed `l0158` from its `gcr.io` image afterwards (`test-build-20261012T171501Z.json`), and the Troubleshooter (live) answers `ALLOW_ACCESS_STATE_NOT_GRANTED` for it updating `policy`, `broker` and `l0000`, acting as `policy-run`, and writing Firestore at project level. Restore, if a build or pull needs it: re-add the binding |
          | `PN@cloudservices` (Google APIs service agent), project Editor (writes `revisions`) | writers; act-as `INCOMPLETE` | **Accepted by Jeff, 2026-10-12, as a platform-trust exception covering all three of its authorities:** writing `revisions`; **replacing the five W4 services' code** (Editor gives it the deployment path below); and an impersonation boundary that can't be verified from this project. Function: Google uses it to run internal operations on the project's behalf (for example, managed instance groups and Deployment Manager), and removing its Editor role can break them. Residual risk accepted: Google's internal use of those authorities, and that who can act as it is unanalyzable from here |
          | `service-PN@firebase-rules` agent, `roles/firebaserules.system` (writes `revisions`) | writers; act-as `INCOMPLETE` | **Accepted by Jeff, 2026-10-12, as a platform-trust exception covering** its Firestore write authority (including `revisions`) and an impersonation boundary that can't be verified from this project. Function: Firebase Security Rules, which Firestore uses. Residual risk accepted: Google's internal use of that write authority, and that who can act as it is unanalyzable from here |
          | `service-PN@gcf-admin-robot` (Cloud Functions service agent), `roles/cloudfunctions.serviceAgent` | deployment paths | **Removed, 2026-10-12.** It could update all five W4 services and act as their runtime accounts. **Dependency check** (read-only, 2026-10-12): the API was enabled, but there were no functions of either generation in any region; none of the 48 Cloud Run services was function-backed; no Cloud Functions audit activity in 90 days, by the agent or against the API; and no function deploy configuration or command in the local repositories. Jeff then **disabled the Cloud Functions API**, which deleted the agent. Its binding now names `deleted:serviceAccount:…gcf-admin-robot…?uid=111028530608006311076` and grants nothing. The Troubleshooter answers `NOT_FOUND` for the agent's address on `policy` and `broker` update and on act-as `policy-run`. Jeff then removed that leftover binding (2026-10-12): the project policy no longer contains `roles/cloudfunctions.serviceAgent`. Re-enabling the API would create a new agent and grant it this role again, so that would reopen this row |
          | `service-PN@gcp-gae-service` agent, `roles/appengine.serviceAgent` (writes `revisions`) | writers; act-as `INCOMPLETE`; dependency check | **Accepted by Jeff, 2026-10-12, as a platform-trust exception covering** its Firestore write authority (including `revisions`) and an impersonation boundary that can't be verified from this project. **Dependency check** (read-only, 2026-10-12): the App Engine application exists and is serving (`us-central`, `CLOUD_FIRESTORE`), with no services or versions, and the App Engine Admin API is enabled. The `(default)` Firestore database has **App Engine integration `ENABLED`**: disabling the application would disable the database that holds api's and auth's data, so removal isn't proposed. (`policy`, `broker` and `revisions` have integration disabled.) The default bucket `gs://graffiticode.appspot.com` is in use (L0013's thumbnails). No audit activity by the agent in 90 days. **Live (Troubleshooter):** it can't update `policy` or act as `policy-run` (not granted), so it has **no code-replacement path**; it can write Firestore at project level (granted). Residual risk accepted: Google's internal use of that write authority, and the unanalyzable impersonation boundary. Longer term, outside this gate: switching `(default)`'s App Engine integration off would let the application and this agent be retired, after its own investigation |
          | `api-run`, `auth-run`, `broker-run`, `policy-run`: `datastore.user`, each conditioned to its own database | writers (`CONDITIONAL`) | **Accepted by Jeff, 2026-10-12, for this review:** the conditions name their own databases, not `revisions`. The condition evidence (`revisions-writers-2026-10-08.json`) and Policy's negative write probes (`policy-run`: create, update and delete on `revisions` refused) stay attached |
          | The eight principals able to act as `firebase-adminsdk-qflje` | step 4 run | **Accepted by Jeff, 2026-10-12, for this specific path only,** after verifying that the account's effective approvals authority is still removed. Live, 2026-10-12: its only project role is `roles/storage.admin`; the Troubleshooter answers `ALLOW_ACCESS_STATE_NOT_GRANTED` for Firestore entity create, update and delete at project level, and for getting tokens for `policy-run`. This doesn't accept those eight principals' other permissions |
          | Legacy Cloud Build account (`PN@cloudbuild`): formerly project-wide `iam.serviceAccountUser`, `run.admin` and more | IAM policy; writers; deployment paths; Troubleshooter | **Resolved, 2026-10-12: no path to approvals found.** Its deployment path to the W4 services was removed on 2026-10-08 ("Narrowing done", below). **Paths through the remaining writers, checked live** (Troubleshooter, 2026-10-12): it can't act as or get tokens for `api-run`, `auth-run`, `broker-run` or `policy-run`; can't set the project's IAM policy; and can't write Firestore at project level (all `ALLOW_ACCESS_STATE_NOT_GRANTED`). The Owners are users, which can't be impersonated. Who can act as the three accepted Google agents is governed outside this project; that's covered by the impersonation boundary accepted for each. Its remaining project roles (`cloudbuild.builds.builder`, `serviceusage.apiKeysAdmin`, `storage.admin`) give it no approvals path, and stay on the Step 2 list |
          | The three `INCOMPLETE` inventories (Cloud Run jobs in `me-central2`; Scheduler; Eventarc) | step 4 runs | Accepted at step 4 for the reversible step 5 only: *inventory unavailable; residual dependency risk accepted*. **Confirmed by Jeff, 2026-10-12, limited to that purpose:** never evidence of an empty inventory |

          **Recommended dispositions (review, 2026-10-08), pending Jeff's approval:** accept the
          four runtime accounts' database-scoped grants, keeping the condition evidence and
          Policy's negative write probes attached. Accept the path through the eight principals
          able to act as `firebase-adminsdk-qflje`, once its effective approvals authority is
          verified as still removed; this doesn't accept those principals' other permissions.
          Keep the three incomplete inventories accepted for the reversible removal only, never as
          evidence of an empty inventory. Accepting `cloudservices` and Firebase Rules, with their
          write authority and unverified impersonation boundary, is Jeff's explicit risk
          decision. Container Registry and App Engine stay pending. The legacy Cloud Build account
          stays unresolved, and narrowing it comes first.

          **Deployment paths, 2026-10-08** (`.gc-deploy/iam/deploy-<service>-{update,actas}-2026-10-08.json`,
          all fully explored). Cloud Run deployment needs permission to update the service *and*
          to act as its runtime account. Principals other than the Owners holding both on
          `policy`, `broker`, `api`, `l0000` and `l0176`:
          - **the legacy Cloud Build account:** `run.admin` and `iam.serviceAccountUser`, both
            project-wide. Any build running as it can deploy new code to any of the five;
          - **Container Registry's agent and `cloudservices`:** project Editor;
          - **Google's Cloud Functions agent:** `cloudfunctions.serviceAgent`.

          **What the legacy Cloud Build account actually deploys**
          (`.gc-deploy/iam/legacy-builds-*-2026-10-08.json`, the 539 most recent builds that ran as
          it, read from their steps):
          - **Everything now in `deploy.json`** it last deployed between 2026-08-25 and 2026-09-29,
            before the deploy CLI took over. That includes `policy` (2026-09-28) and `broker`
            (2026-09-27).
          - **25 services it alone still deploys:** `l0002 l0011 l0012 l0137 l0151 l0152 l0153
            l0154 l0155 l0156 l0157 l0158 l0159 l0160 l0161 l0163 l0165 l0166 l0167 l0168 l0169
            l0170 l0171 l0172 l0173`, all in `us-central1`, the latest `l0158` on 2026-10-02. Each
            runs as its own `lNNNN-run` account. Every deploy passes `--allow-unauthenticated`,
            which sets the service's IAM, so it needs `run.admin` *on that service*.

          **Narrowing: direction approved by review, 2026-10-08.** It's a production IAM change,
          for Jeff to run phase by phase with `scripts/legacy-build-narrowing.sh`. **The order
          matters.** IAM permissions are additive, so a deploy test passes while the project-wide
          grants remain, whatever the scoped grants are. Testing only means something after the
          broad grants are gone:
          1. `save`: record the project policy and the 25 services' and accounts' policies, for
             rollback (read-only).
          2. `grant`: `roles/run.admin` on each of the 25 services, and
             `roles/iam.serviceAccountUser` on each of their 25 runtime accounts.
          3. `verify`: all 50 scoped grants are present (read-only).
          4. `remove`: the project-wide `roles/run.admin` and `roles/iam.serviceAccountUser`.
          5. Wait a few minutes for propagation, then `check` (read-only), using the Policy
             Troubleshooter's allow-policy answer:
             - updating the five W4 services and acting as their runtime accounts: not granted;
             - setting IAM on the 25 services and acting as their accounts: granted.

             Deny policies can't be read with the operator's access, so the overall answer is
             `UNKNOWN_INFO`. An unseen deny policy can only remove access: the W4 negatives stand,
             and step 6 shows the 25 still work.
          6. `test`: redeploy `l0158`'s current image through a build that runs as the legacy
             account, with `--allow-unauthenticated`, as its deploys do. That's a new revision
             with the same code.
          7. Re-run the deployment-path analyses for the five W4 services, and record them here.

          `rollback` re-adds the two project-wide grants, only if a legitimate deploy breaks. The
          gate then stays open until the narrowing is redone. The legacy Cloud Build row stays
          unresolved until step 7's analyses and the negative checks pass.

          **Narrowing done, 2026-10-08** (Jeff ran each phase; evidence under
          `.gc-deploy/iam/legacy-build-narrowing/`):
          1. `save`: the project policy and the 25 services' and accounts' policies, as of
             `20261008T184818Z` (51 files, all valid JSON).
          2. `grant`, then `verify`: all 50 scoped grants present, each an exact, unconditional
             binding.
          3. `remove`: the project-wide `roles/run.admin` and `roles/iam.serviceAccountUser` removed
             at 19:02:11 and 19:02:12 UTC (audit log). A second `remove` run then failed with "not
             found"; `remove` now skips absent bindings. Its project roles are now
             `cloudbuild.builds.builder`, `serviceusage.apiKeysAdmin` and `storage.admin`.
          4. `check` (Policy Troubleshooter, allow policies; with retries after intermittent
             failures): **passed.** Updating each W4 service and acting as its runtime account:
             `ALLOW_ACCESS_STATE_NOT_GRANTED`. Update, set-IAM and act-as on each of the 25:
             granted.
          5. `test`: build `f2c0fe34-253d-4c36-afb2-8b55fa3ed8b5` redeployed `l0158` at its serving
             digest (`gcr.io/graffiticode/l0158@sha256:822cf90a…`), with
             `--allow-unauthenticated`. Before submitting, the project's default build account was
             asserted to be the legacy account, and the build ran as it. Result: `SUCCESS`
             (`test-build-20261008T204618Z.json`). No rollback.
          6. **Deployment-path analyses after the narrowing**
             (`.gc-deploy/iam/deploy-<service>-{update,actas}-after-narrowing.json`). Nine of ten
             came back fully explored, and **none lists the legacy account**. The remaining
             principals, other than the Owners, are `cloudservices` (Editor), Container
             Registry's agent (Editor) and the Cloud Functions agent on update. On act-as, those
             three plus Google's Compute, Cloud Build and Cloud Run agents. All have pending
             dispositions above. The tenth, `l0000` update, hit Cloud Asset Inventory's daily
             `analyzeIamPolicy` quota (`429`): 200 a day per project, not raisable, reset at
             midnight Pacific.
          7. **The tenth analysis, re-run 2026-10-12** (`deploy-l0000-update-after-narrowing.json`).
             It was fully explored, with no errors, but **its answer is stale.** It credits the
             legacy account with project-level `roles/run.admin` and `roles/firebase.admin`.
             `firebase.admin` was removed on 2026-10-07 and `run.admin` on 2026-10-08. The live
             project policy holds neither: the account's project roles are
             `cloudbuild.builds.builder`, `serviceusage.apiKeysAdmin` and `storage.admin`. The
             audit log shows no project IAM change since the two removals at 19:02 on 2026-10-08.
             The Policy Troubleshooter, which reads the live policy, again answers
             `ALLOW_ACCESS_STATE_NOT_GRANTED` for the legacy account updating `l0000` (and
             `policy`). **The narrowing holds;** the Analyzer answered from an out-of-date
             snapshot of the project's IAM policy. It also lists `cloudservices`, Container
             Registry's agent and the Cloud Functions agent (pending dispositions above), and the
             three Owners.

          **What this means for the evidence.** A Policy Analyzer result can lag the live policy,
          even when it reports being fully explored. For any negative the gate relies on, the
          authority is the live policy and the Troubleshooter's answer; the Analyzer is
          supporting evidence. Step 6's final verification must cross-check each Analyzer result
          against the live policy (`gcloud projects get-iam-policy` and the resource's own
          policy) and record any disagreement. The 2026-10-08 analyses for `policy`, `broker` and
          `api` agree with the live policy.

          Its other project-wide roles (`storage.admin`, `serviceusage.apiKeysAdmin`,
          `cloudbuild.builds.builder`) don't deploy services. They're outside this gate, and stay
          on the Step 2 list.

          **Container Registry and App Engine dependency checks, 2026-10-08:**
          - **Neither agent made any request** recorded in the Admin Activity or Policy Denied logs
            in the last 90 days (`.gc-deploy/iam/activity-<agent>-2026-10-08.json`). Data Access
            logs are off, so reads aren't covered.
          - **The App Engine application** is the project's legacy Firestore and default-bucket
            anchor (`databaseType: CLOUD_FIRESTORE`, `defaultBucket: graffiticode.appspot.com`).
            Its agent stays, pending; removing it isn't proposed.
          - **Container Registry's agent holds Editor**, which also gives it the deployment path
            above. With `gcr.io` redirected to Artifact Registry and no recorded activity, removal
            remains the proposal. Residual risk: reads the logs don't show.

          **Additional cleanup, separate from the approvals authority:** remove
          `firebase-adminsdk-qflje`'s project-wide `roles/storage.admin`. That fits retiring the
          account; no remaining consumer was found that needs it. Dependency risk recorded and
          accepted as for step 5; the binding can be restored.

          After any approved removals: re-run the writers analysis and the step 4 checker, and
          record the results here. The gate closes only when every row has an approved
          disposition and those re-runs match.

          **Final verification, 2026-10-12** (from main `22ef2fd`; evidence under
          `.gc-deploy/iam/`):
          - **Step 4 checker** (`sa-consumers-2026-10-12T17-46-17-818Z.json`, with the Policy
            Denied log). Verdict `FOUND`, as expected for retained access paths. **No consumer:**
            no reachable Cloud Run revision (121), App Engine version, Compute instance, Cloud
            Build trigger or Pub/Sub push subscription runs as the account. Both keys are disabled.
            No activity since the disable. Policy Analyzer's last authentications both predate it.
            - `INCOMPLETE`: Cloud Run jobs in `me-central2`, Scheduler and Eventarc, still accepted
              for the reversible removal only. Plus **Cloud Functions**, newly unreadable because
              its API is disabled. Accepted on the strength of the clean dependency check made
              before the disable, and because no function can run with the API disabled.
            - `FOUND`: five Google agents can act as the account (App Engine, Cloud Build,
              Compute, `cloudservices`, Cloud Run). That's down from eight: the Container Registry
              and Cloud Functions agents are gone, and the legacy Cloud Build account was narrowed.
              All five are covered by the approved disposition for paths through
              `firebase-adminsdk-qflje`, which no longer reaches `revisions`. App Engine and
              `cloudservices` are also individually accepted.
          - **Writers of `revisions`** (`revisions-writers-final-2026-10-12.json`; fully explored,
            no errors): exactly the principals in the table above. The three Owners; the four
            runtime accounts, each conditioned to its own database; `cloudservices` (Editor);
            the Firebase Rules agent; and the App Engine agent.
          - **Cross-checked against the live policy** (`project-policy-final-2026-10-12.json`): 10
            writer bindings in the Analyzer and 10 in the live policy. None stale, none missing.
            The negatives the gate relies on were confirmed live with the Troubleshooter the same
            day: `firebase-adminsdk-qflje` (no Firestore writes, no tokens for `policy-run`), the
            legacy Cloud Build account (no W4 deployment, no act-as or tokens on the runtime
            accounts, no `setIamPolicy`, no Firestore writes), and Container Registry's agent.

          **Gate closed, 2026-10-12 (Jeff).** Every authority path in the step 6 table has a
          recorded disposition, removed or accepted with a reason. The fresh step 4 evidence shows
          no unresolved consumer, and the writers analysis matches the live policy. W4 activation
          (PR 8, `docs/protected-execution.md`, "W4 activation and cutover") is no longer blocked
          by this gate. **The gate reopens if:** any removed binding is restored; key `6bfb0894…`
          is re-enabled; the Cloud Functions API is re-enabled (its new agent would get the role
          back); or a new writer of `revisions` appears.

          **Cleanup, outside the gate, done 2026-10-13 (Jeff):** `firebase-adminsdk-qflje`'s
          project-wide `roles/storage.admin` removed, and both of its user-managed keys
          (`6bfb0894…` and the 2022 `d40cd54b…`, disabled since 2026-10-07) **deleted**. Verified
          live: the account has no project roles, no user-managed keys and no act-as bindings, so
          the "key re-enabled" reopening condition above can no longer occur. The canary's expired
          `canary-window` grants (OpenIdTokenCreator on `api-run@`, `l0176-run@` and
          `console-run@graffiticode-app`) and the `canary-window-w4` ones were removed too; each
          canary window adds a fresh time-limited grant. The workstation copy of the deleted key
          was removed the same day.

          **Legacy Cloud Build account narrowed further, 2026-10-13 (Jeff):** its project-wide
          `roles/serviceusage.apiKeysAdmin` and `roles/storage.admin` removed; its only project
          role is now `roles/cloudbuild.builds.builder`, with the scoped `run.admin` and act-as
          grants on the 25 legacy language services kept. Evidence for removal: no legacy
          `cloudbuild*.yaml` uses API keys or Cloud Storage beyond its own build source and logs,
          and in 400 days of admin-activity audit logs the account made no `apikeys`,
          `serviceusage` or `storage` call (its calls were `actAs`, Cloud Run
          `ReplaceService`/`CreateService`/`SetIamPolicy` and `CreateBuild`). Object-level
          Storage access isn't in admin-activity logs, so the removal was then tested as the
          account: a build fetching its uploaded source and pushing to `gcr.io` (redirected to
          Artifact Registry; build `26ec88d8-4ff1-4f5f-8927-0a867ee8e7fb`, image deleted after),
          and `scripts/legacy-build-narrowing.sh test` redeploying l0158 at its serving digest
          (build `9460831d-5b3d-4ce8-adec-92886cb88a46`); both succeeded. Policy before:
          `.gc-deploy/iam/project-policy-before-legacy-roles-20261013T230333Z.json`. Rollback:
          `add-iam-policy-binding` for either role.

          **Still open, outside the gate:** longer term, investigate switching `(default)`'s App
          Engine integration off.
    - Google-managed service agents (`cloudservices` and `containerregistry` with Editor,
      `firebase-rules`, `gcp-gae-service`): **not accepted by this list.** Their dispositions are
      the step 6 rows above, each now approved or carried out (2026-10-12): `cloudservices`,
      Firebase Rules and App Engine accepted; Container Registry's Editor removed.

- Rollback: `remove-iam-policy-binding` with the same condition. The database has delete
  protection: disable it explicitly before deleting it (`gcloud firestore databases update
  --no-delete-protection`). Never delete it while an admitted plan pins a revision it records.

### Step 12: `auth` `/internal/act-as` for app-tier workers (app tier Phase 3.5 R0)

The console's generation worker, and the effects that follow a generation, run a user's work
with the user gone: a Cloud Tasks job, or a sweeper redispatching one. Today the job payload
carries the user's own bearer token. App tier Phase 3.5 drops that and has the worker ask `auth`
for a short-lived token instead: `POST /internal/act-as {purpose, uid, subject, grant}`
(`packages/auth/src/routes/internal.js`). Two checks, both required:

1. **Caller identity.** `X-Caller-Identity` is a Google-signed ID token for the caller's runtime
   SA, audience `urn:graffiticode:auth` (`ACT_AS_AUDIENCE`), and the SA is in `ACT_AS_CALLERS`.
   Same verifier as Policy's callers (`createCallerIdentity`, moved to
   `@graffiticode/common/caller`). **`auth` is public** (it serves sign-in), so there is no
   Cloud Run IAM in front of the route and no `X-Serverless-Authorization` to match: the verified
   ID token is the only identity gate (`requireServerlessMatch: false`). The shared
   `X-Internal-API-Key` is **not** accepted: other services hold it, so it can't name one caller.
2. **A job-bound grant** (`@graffiticode/common/act-as`): HMAC-SHA256 with `ACT_AS_GRANT_SECRET`
   over purpose (`generation` or `effect`), uid, subject (the generation or effect id) and
   `notAfter`. The producer signs it when it reserves the work; `auth` checks it without reading
   app-tier data. A generation grant can't be used for an effect, or the reverse.

The answer is `auth`'s ordinary 5-minute ES256 access token for that uid (what `/oauth/verify`
and Policy's `AUTH_URL` verifier accept), with an added `act: {sub: <caller SA>, purpose,
subject}` claim marking it as delegated. Every request, allowed or refused, writes one
`security_audit` line (caller, purpose, pseudonymized uid, outcome, reason).

Until all three secrets are mounted the route answers 503, so the code can ship first.

```bash
P=graffiticode
for s in act-as-callers act-as-grant-secret; do
  gcloud secrets create $s --project $P --replication-policy automatic; done
for s in act-as-callers act-as-grant-secret audit-pseudonym-secret; do
  gcloud secrets add-iam-policy-binding $s --project $P \
    --member serviceAccount:$(sa auth) --role roles/secretmanager.secretAccessor --condition=None; done
echo '{"console-run@graffiticode-app.iam.gserviceaccount.com":{"role":"console"}}' |
  gcloud secrets versions add act-as-callers --project $P --data-file=-
# The grant secret's value is generated once and stored in both projects (auth verifies here;
# producers sign in graffiticode-app). Pipe it; never echo it or write it to disk.
openssl rand -base64 48 | tee >(gcloud secrets versions add act-as-grant-secret --project $P --data-file=-) |
  gcloud secrets versions add ACT_AS_GRANT_SECRET --project graffiticode-app --data-file=-
```

Then pin the three versions in `auth`'s `deploy.json` secrets and release `auth`. No new grant
lets `console-run@` invoke `auth`: it is public.

**Who signs and who exchanges.** In `graffiticode-app`, `ACT_AS_GRANT_SECRET` is read by every
producer that reserves v2 generation jobs, since each signs its job's grant when it reserves:
`console-run@` (from the start), `mcp-run@` (2026-10-16, when mcp moved to core mode, app tier R2)
and `openapi-run@` (2026-10-16, the REST API, Phase 4). **Only `console-run@` exchanges grants**:
`act-as-callers` still names it alone, and generation runs only in the console's worker. So a
compromised front door can sign a grant but can't turn it into a user token: `/internal/act-as`
refuses its identity before the grant is looked at. Widening the signers widened nothing in
project `graffiticode`.

- Rollback: remove `ACT_AS_CALLERS` from `auth`'s config (the route answers 503), or disable the
  grant secret's version. Tokens already issued expire within 5 minutes.

### Step 13: the scheduled refresh-token cleanup (2026-10-21) [LIVE]

`auth` deletes expired refresh tokens at `POST /v1/refresh-tokens/clean-expired`. That covers
each token's doc, its `token-to-id` index entry and its `private/key` doc (since `f842011d`,
2026-09-29). The route took only the internal key until 2026-10-21. Since then it also takes its own key
(below). Nothing called it, and 536 expired tokens had built up. Issue #4 asked
for this cleanup, and PR #10 included an earlier version of it.

Now a daily job calls it:
- Cloud Scheduler `auth-refresh-token-cleanup` (us-central1, `17 4 * * *` UTC) POSTs to Cloud
  Run's `…/jobs/auth-refresh-token-cleanup:run` with an OAuth token for
  `auth-maintenance-scheduler`.
- The Cloud Run job `auth-refresh-token-cleanup` runs `curlimages/curl@sha256:c1fe1679…` as
  `auth-maintenance-run`. It reads the **cleanup-only key** as an env var from
  `auth-cleanup-api-key:1`, sends it as `X-Cleanup-API-Key` and calls the route (`max-retries 1`,
  300 s).

New identities and grants, each the narrowest that works:

| Principal | Grant | Resource | Why |
|---|---|---|---|
| `auth-maintenance-run@graffiticode` (new) | `roles/secretmanager.secretAccessor` | secret `auth-cleanup-api-key` only | the job sends the cleanup key. No project roles, and nothing else. It held `auth-internal-api-key` until 2026-10-21, when that grant was removed |
| `auth-maintenance-scheduler@graffiticode` (new) | `roles/run.invoker` | Cloud Run job `auth-refresh-token-cleanup` only | the scheduler starts that job. It can't read the key (Troubleshooter: `secretmanager.versions.access` NOT_GRANTED, `run.jobs.run` GRANTED) |
| `service-656973052505@gcp-sa-cloudscheduler` | `roles/cloudscheduler.serviceAgent` (granted by Google when the API was enabled) | project | mints the scheduler account's OAuth token |

Also new: the Cloud Scheduler API (`cloudscheduler.googleapis.com`) is enabled in `graffiticode`,
for this job alone.

**The cleanup-only key (2026-10-21, #164; auth `auth-rmvice18m-c1157a`).** The internal key
opens every internal auth route: `linked-emails/internal/sign-in`, `/oauth-clients` and
`/oauth-tokens` among them. So the job doesn't hold it any more.
- **The key:** `requireCleanupAuth` accepts `X-Cleanup-API-Key` against `CLEANUP_API_KEY`, in
  constant time.
- **The secret:** `CLEANUP_API_KEY` comes from `auth-cleanup-api-key:1`, a random value readable by
  `auth-run` and `auth-maintenance-run` only.
- **Scope:** only `POST /v1/refresh-tokens/clean-expired` accepts it; tests show it opens no
  internal-only route. Without the header the route still takes the internal key.
- **The old grant:** `auth-maintenance-run`'s grant on `auth-internal-api-key` is removed
  (Troubleshooter: NOT_GRANTED on it, GRANTED on `auth-cleanup-api-key`), so
  `auth-internal-api-key` is again read by `auth-run` alone.
- **What's left:** a compromised job can now only run the cleanup, which deletes nothing but
  expired tokens.

- **Verification:** a manual run deleted 536 expired tokens and kept 52. A run with the cleanup
  key (2026-10-21 16:52Z) succeeded, and auth answered 200. The first scheduled run
  is due 2026-10-22 04:17 UTC (`gcloud scheduler jobs describe auth-refresh-token-cleanup
  --location=us-central1`). A forced run right after enabling the API made no attempt.
- **Rollback:** `gcloud scheduler jobs pause auth-refresh-token-cleanup --location=us-central1`.
  To remove it, delete the scheduler job and the Cloud Run job, then
  `auth-cleanup-api-key`, and both accounts.

### Step 14: rotating the console credentials exposed on 2026-10-23 (2026-10-24 to 10-26) [LIVE]

**The exposure.** The graffiticode-app `console` service held six values as plain env vars.
Anyone who could read the service's configuration could read them, and all six were printed into
an operator session transcript on 2026-10-23:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`;
- `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET`;
- `INTERNAL_API_KEY`, which was also on mcp-service, dspy-service, app and `auth` (here, as
  `auth-internal-api-key:1`);
- `VALID_INVITE_CODES`.

An investigation agent also read the `INTERNAL_API_KEY` and `auth-internal-api-key` payloads
while comparing them. Both are treated as exposed.

**The rule.** Moving a value into Secret Manager doesn't close the exposure; the old value is
still valid. Each credential was replaced, the replacement verified in production, and only
then was the old one revoked.

| Credential | Replacement | Verified | Old value |
|---|---|---|---|
| `INTERNAL_API_KEY` | New random key. auth checks it against `auth-internal-api-key:2`, and briefly also `_PREVIOUS` (#173, #174, #175: dual-key check, SHA-256 digests compared in constant time). Senders console, mcp-service and app read graffiticode-app `INTERNAL_API_KEY:2` | console, app and mcp-service calls to auth's internal routes succeed on the new key | **rejected**: auth refuses it, and dspy-service no longer accepts any key (it was retired from this credential: public invocation removed, then a missing key made to fail closed, then the key removed). Old versions disabled |
| `ANTHROPIC_API_KEY` | **No static key.** console exchanges its runtime account's Google identity token for a short-lived Claude API token (Anthropic Workload Identity Federation; rule pinned to `console-run`'s `sub` and `email`), in `core/src/lib/anthropic-auth.ts` (graffiticode-app #50–#53). A failed exchange fails over to OpenAI | generations through federation, `fallbacks=0` | deleted in the Anthropic Console |
| `OPENAI_API_KEY` | New service-account project key in the Artcompiler org, restricted to model capabilities and the Responses API: `OPENAI_API_KEY:2`, readable by `console-run` only | RAG `embedding.complete` on a fresh generation | the legacy user key is **revoked** (refused with 401). Version 1, a key created in the wrong org by mistake and never exposed, is disabled |
| `STRIPE_SECRET_KEY` | Rolled in Stripe, with the old key kept valid for 24 h: `STRIPE_SECRET_KEY:1` | `/api/payments/subscription`, `usage` and `methods` returned 200 | **refused** (401, checked 2026-10-27 after the 24 h window) |
| `STRIPE_WEBHOOK_SECRET` | Rolled, with a 24 h overlap: `STRIPE_WEBHOOK_SECRET:1`. During the overlap the old one is held as `STRIPE_WEBHOOK_SECRET_PREVIOUS:1`, and `verifyStripeEvent` tries each (#48) | a Stripe test event was delivered with 200 | **done 2026-10-27**: `_PREVIOUS` removed (console-00699-6xs, graffiticode-app #69) and its version disabled. The only delivery during the overlap was the test event. `reconcile-subscriptions.ts` dry run with production's price ids: 4 in sync, 0 drift |
| `VALID_INVITE_CODES` | none; the route and dialog were deleted (#48) | `/api/invite-code` returns 404 | removed from console, and listed in `removeEnv` |

Each new secret is readable by its service's runtime account alone, and pinned in graffiticode-app
`deploy.json` (#54, #57, #58).

**Switching a plain env var to a secret mount** took one manual update per service:
`gcloud run services update <svc> --remove-env-vars=X --update-secrets=X=X:N`, then
`update-traffic`. gc-deploy refuses a name that is in both `env` and `secrets`, and an
out-of-band update makes a revision that gets no traffic. Console's remaining `:latest` mounts
were pinned to their current versions in the same pass, so console now mounts no `:latest`
secret.

**Rollback.** No console revision before `console-00697-sx6` is a valid rollback target, because
each one holds a value that is now revoked or about to be.

**The access review (2026-10-26).**
- **graffiticode:** clean. Every service runs as its own `-run` account, and no user-managed
  service account keys exist. The only secret reader that isn't a `-run` account is
  `egress-proxy`, which reads its own certificates.
- **graffiticode-app:**
  - `www` (public) and `dspy-service` ran as the default compute account. That account holds
    project **Editor** and could read 10 secrets. Both services now run as **`static-run@`**,
    which has no roles (neither calls a Google API), and the compute account's secret grants are
    removed. Its Editor role is still to be removed, once a quiet period shows nothing else uses
    it. `questioncompiler`, unused, is deleted.
  - The unused user-managed key `53ea457b` on `firebase-adminsdk-5zize` is deleted. Key
    `9259e1c0` remains, for the operator's local tooling (last used 2026-10-13).
- **People:** the owners (the operator, plus `kevin.m.dyer@gmail.com` on both projects and
  `admin@artcompiler.com` on graffiticode) are kept, by decision.
- **Secret Manager:** no human or service holds a project-level Secret Manager role. Grants are
  per secret.

**Still open:**
- removing the compute account's Editor role;

**Usage review: Stripe (2026-10-26, through the API, read-only).** Since 2026-10-22 there were 31
events, all from three subscription renewals (invoice, payment intent, charge and subscription
update for each). There were no refunds, payouts, transfers or disputes, and no changes to the
account or to an external account. Nothing found.

**Usage review: OpenAI and Anthropic (2026-10-27, from the providers' dashboards).**
- **Exposure:**
  - before 2026-10-23, only the three project owners could read console's configuration (the
    access review above);
  - the transcript exposure was on 10-23;
  - each key was revoked on 10-24 (Anthropic) and 10-25 (OpenAI).
- **OpenAI:**
  - spend on the old key from Sep 27 to Oct 24 was $20.60;
  - every day with spend matches a day of console's own OpenAI generations (Sep 28: 26; Sep
    30: 24; Oct 5: 22; Oct 19: 62), and there's none without them;
  - spend beyond what production's tokens explain came from local development runs: the
    operator's local `.env.local` files held the same key;
  - no spend on the old key after its revocation; Oct 25 is all on the new key.
- **Anthropic:** the old console key had no usage after its deletion on 10-24 (reported by the
  operator from the Usage page).
- **Nothing found.** P1 #1 closed on 2026-10-27.

### Step 15: `l0000r` takes over L0000's protected-execution role (interpreter plan A4) [LIVE]

L0000's switch from `l0000` (TypeScript) to `l0000r` (Rust) needs `l0000r` to stand where `l0000`
stands: a compiler Policy trusts for `0000`, pinnable, and on `l0000`'s network class. Applied
with the A4 switch (2026-10-29). Checked 2026-11-03: `policy-callers:5` lists `l0000r-run`,
which holds `run.invoker` on `policy`, and `l0000r` runs on `compilers-l0000`.

- **Caller map.** *(Uploaded 2026-10-29 as version 5: version 4 plus the one entry, validated
  with `parseCallers`; `deploy.json` pins `policy-callers:5`, applied when `policy` is released.)*
  A new `policy-callers` version adds `l0000r-run` as a `compiler` for `0000`,
  alongside `l0000-run` (which stays, for plans pinned to `l0000` revisions). Validate it with
  Policy's `parseCallers` before uploading. Pin `deploy.json`'s `policy` entry to **the version
  Secret Manager returns** (not an assumed number) and release `policy`.
- **Invoker.** `l0000r-run` gets `run.invoker` on `policy`, as `l0000-run` has. *(Granted
  2026-10-29.)*
- **Network.** `l0000r` moves to subnet `compilers-l0000` (`api`, `auth`, Policy's `run.app`
  host, `www.googleapis.com`), the same class as `l0000`.
- **Pinnable.** `deploy.json`'s `l0000r` entry is `pinnable` for `0000` with contract versions 1
  and 2, the W4 baseline, `POLICY_URL` and `PREFLIGHT_GATEWAYS=api-run`. Its first such release
  records its revision in `revisions` before promotion. Its previous serving revision
  (`l0000r-rmvfv6ypx-25d112`, never approved, needed by no plan) is then a reachable unapproved
  revision; remove its tag with the deploy CLI's tag retirement.
- `l0000` and its approved revisions stay: admitted plans that pin them keep retrying there.

### Step 18: `l0176r` takes over L0176's protected-execution role (interpreter plan A5) [LIVE]

This is Step 15 again for L0176, with the Broker added. `l0176r` has to stand where `l0176`
stands: a `0176` compiler that both Policy and the Broker trust, pinnable, and on
`compilers-l0176`. Its Rust side first ports L0176's two parity gaps: `init` validation, and
gateway-only system signing with the busy results. A compile only gets `POLICY_URL` and
`BROKER_URL` after that. Applied 2026-11-03 and 2026-11-04, with the switch (plan A5); each line
is dated.

- **Policy's caller map.** *(Uploaded 2026-11-03 as version 6, validated with `parseCallers`, read back identical; pinned in #265 and released as `policy-rmw14q3w9-a953d6`.)* Upload a new `policy-callers` version: version 5 plus `l0176r-run` as a
  `compiler` for `0176`, next to `l0176-run`. `l0176-run` stays, because plans pinned to `l0176`
  revisions still retry there. Validate the version with `parseCallers` before uploading. Then
  pin `deploy.json`'s `policy` to **the version Secret Manager returns**, and release `policy`.
- **Broker's caller map.** *(Uploaded 2026-11-03 as version 2, validated with `parseCallers`, read back identical; pinned in #265 and released as `broker-rmw153pw6-4af529`.)* Upload a new `broker-callers` version in the same way: version 1 plus
  `l0176r-run` as a `compiler` for `0176`. Then pin `deploy.json`'s `broker` to the returned
  version, and release `broker`.
- **Invokers.** *(Granted 2026-11-03.)* Grant `l0176r-run` `run.invoker` on `policy` and on `broker`, as `l0176-run` has.
- **Network.** *(Applied 2026-11-03, #261; `l0176r-rmw15gmir-6bba5a` and later run on it.)* Move `l0176r` to subnet `compilers-l0176`, the same class as `l0176`. That class
  allows `api`, `auth`, Policy's and the Broker's `run.app` hosts, and `www.googleapis.com`.
  `production/network.json` gets the same block. The proxy's generated config is unchanged by
  this (checked 2026-11-03), so the proxy needs no rebuild.
- **Pinnable.** *(Applied 2026-11-03, #261. `l0176r-rmw15gmir-6bba5a` was approved for `0176` before promotion, retiring the never-approved tag `rmvftxxii-b39b6c`; `l0176r-rmw18bcvb-0b20c8` followed with #270; release-check ok.)* `deploy.json`'s `l0176r` takes `l0176`'s values:
  - `pinnable` for `0176`, with contract versions 1 and 2;
  - its `baselines`, plus `rust-parity` at the parity port's merge commit (#262, `db3ad15d`);
  - `POLICY_URL`, `BROKER_URL`, and `PREFLIGHT_GATEWAYS=api-run`;
  - `forbiddenEnv` of `SYSTEM_PREVIEW_DIRECT`, `LEARNOSITY_KEY` and `LEARNOSITY_SECRET`.

  Its first release of this kind records its revision in `revisions` before promotion.
- **`l0176` and its approved revisions stay** until A7, for the plans that pin them. The canary replayed a write pinned to `l0176-rmvv31tuj-fa4690` across the switch (2026-11-03).
- **Canary window.** *(Granted 2026-11-03, expired 2026-11-04T04:00Z.)* The operator held `roles/iam.serviceAccountOpenIdTokenCreator` on `api-run`, `l0176r-run` and `console-run`, conditioned `canary-window-a5`. It covered the canary runs through the staged api (`docs/evidence/track-a5-l0176/`). `l0176-run` was left out, so run 1's direct-path check, which used the TypeScript compiler, failed. A5 doesn't change that path.
- **Switch.** *(2026-11-03/04.)*
  - `api-rmw18zdds-309a6c` (#271, routing to `l0176r`'s run.app host) was promoted with the canary evidence.
  - `l0176.graffiticode.org` was then repointed to `l0176r`.
  - `api-rmw2dx5l8-727612` (#278) routes through the domain.
  - Warmth moved: `l0176r` is at min 1 and `l0176` at min 0.

### Step 16: an isolated bucket for `l0013r`'s capture evidence (interpreter plan A1b) [LIVE]

Before L0013 switches to Rust, its captures are gathered against a bucket that isn't
production's, so no evidence run can overwrite `thumbnails/{item}.png` in
`graffiticode.appspot.com`. `l0013r` refuses to capture without `THUMBNAIL_BUCKET` (no default,
PR #242) and reports the bucket in effect on `GET /egress` (`language.thumbnailBucket`).

- **Bucket.** *(Created 2026-11-02.)* `gs://graffiticode-l0013-evidence`, `us-central1`,
  fine-grained access (the upload's `publicRead` ACL needs object ACLs), public access prevention
  inherited, lifecycle: objects deleted after 30 days.
- **Access.** *(Granted 2026-11-02.)* `l0013r-run` has `roles/storage.objectAdmin` on this bucket.
  It **already had** `roles/storage.objectAdmin` on production's `graffiticode.appspot.com`
  (found 2026-11-02, alongside `l0013-run`), so before PR #242 an `l0013r` snap would have written
  production thumbnails; the no-default `THUMBNAIL_BUCKET` is what keeps evidence runs off them.
- **Configuration.** `deploy.json`'s `l0013r` sets `THUMBNAIL_BUCKET=graffiticode-l0013-evidence`.
  Egress needs no change: `storage.googleapis.com` is already in `l0013r`'s allow list.
- **At the switch** *(2026-11-02)*: `THUMBNAIL_BUCKET` is set to `graffiticode.appspot.com`,
  explicitly, in the switch PR (no new grant is needed). At D4 both runtime accounts lose direct
  write (plan C5c). The evidence bucket stays, emptying itself after 30 days.

### Step 17: the `l0184` TypeScript service is retired (interpreter plan A7) [LIVE]

L0184 runs only on `l0184r` (domain `l0184.graffiticode.org` mapped to it on 2026-11-02, the
api routing through the domain). The owner had the TypeScript service deleted.

- **Service.** *(Deleted 2026-11-03.)* Cloud Run `l0184`. Its last revision,
  `l0184-rmvu66ggb-23009b`, has its image in `us-central1-docker.pkg.dev/graffiticode/services/l0184`,
  which is retained. The entry is removed from `deploy.json` and from
  `deploy/egress-proxy/production/network.json`, so the regenerated `step1-checklist.md` no longer
  grants or expects `l0184-run`'s binding. The regenerated AT-11 step 7 configs
  (`deploy/egress-proxy/step7/at11/collect.json`, `probe-compilers-default.json`) no longer probe it.
  A future inventory that still lists the account would show it as a compiler outside `deploy.json`.
- **Runtime account.** `l0184-run` still exists. Its only remaining grant is
  `roles/secretmanager.secretAccessor` on `egress-proxy-ca-bundle`, checked 2026-11-03: it has no
  project roles and no invoker on `l0184r`. Removing that binding and the account is a separate
  owner decision. Until then the live secret policy has one more member than the checklist
  expects.
- **Unchanged.** The proxy's certificate for `l0184.graffiticode.org` stays, because the domain
  is live on `l0184r`, and so do the allow lists that name it.
- **The Rust service takes the plain name** *(owner's rule, 2026-11-04)*. Cloud Run can't rename a service, so a new service `l0184` runs `l0184r`'s image. It runs as `l0184-run`, reused: that account holds exactly what `l0184r-run` did, `secretAccessor` on `egress-proxy-ca-bundle` and nothing else, so no grant changes. The AT-11 tooling maps a runtime account to its service by name, which is why the account follows the service.
  - Then `l0184.graffiticode.org` is repointed to `l0184`, and `l0184r` is retired.
  - After that, `l0184r-run` holds only that same CA-bundle grant, until it is removed.

### Step 19: fifteen more TypeScript services are retired (interpreter plan A7) [LIVE]

The owner had the TypeScript services of every switched, non-pinnable language deleted
*(2026-11-05)*: `l0003`, `l0010`, `l0013`, `l0014`, `l0174`, `l0175`, `l0177`–`l0183`, `l0185`
and `l0186`. Production serves each language from its `lNNNNr` service, behind its domain.

- **Before deleting.**
  - No domain mapping named any of them.
  - None had a request since 2026-11-03.
  - No tester override pointed at one.
  - None is pinnable, so no admitted plan pins its revisions.
- **After.** A compile of each language through `api.graffiticode.org` came back without errors.
- **Images.** The last images are retained in Artifact Registry, where the cleanup policy keeps each image's 10 newest versions.
- **Config.** The `deploy.json` and `production/network.json` entries are removed. The step 1 checklist and the AT-11 step 7 configs are regenerated.
- **Kept, deliberately.** `l0000` and `l0176` are pinnable, and admitted plans pin their TypeScript revisions; the A5 canary replayed one on `l0176-rmvv31tuj-fa4690`. Each stays until no live plan names one of its revisions.
- **Runtime accounts.** The fifteen `lNNNN-run` accounts remain, holding only what they held before: the egress CA bundle, and for `l0013-run` the thumbnails bucket (removed at D4, plan C5c). Removing them is a separate decision.
- **Rust names.** The renames of `lNNNNr` to `lNNNN` are deferred (owner, 2026-11-05).

### Step 20: the B5 command sweeper and the policy database's indexes [LIVE]

Recovery of abandoned commands (`docs/b5-commands-plan.md` §7), set up 2026-11-09.

- **`command-sweeper@graffiticode.iam.gserviceaccount.com`** is new and holds **no roles**.
  - Cloud Scheduler mints an OIDC token as it, for the audience `https://api-sja7fatcta-uc.a.run.app/internal/commands/sweep`.
  - The api checks that token itself: the audience is `SWEEP_AUDIENCE`, and the email is verified and listed in `SWEEP_CALLERS`.
  - The api is public on Cloud Run, so no invoker grant is involved. A token from any other account, or for any other audience, is refused with 401 before anything runs.
- **Cloud Scheduler job `command-sweep`** runs every minute: `POST` to that URL with `oidcToken.serviceAccountEmail` = the sweeper.
  - Each sweep asks Policy, as the api (gateway role), for the commands that are due, takes each over and continues it under the command's stored principal. No user token is involved.
- **The `policy` database's indexes** are created by hand (releases don't deploy indexes) from `configs/firestore-policy-indexes.json`, through the Firestore Admin API. gcloud 586's `firestore indexes composite create` crashes.
  - Composite on `commands`: `(status, owner.leaseExpiresAt)` and `(publication.state, owner.leaseExpiresAt)`.
  - Index exemptions on the payload fields: `request.text`, `models.text`, `inputs.text`, `observations.text`, `occurrences.args` and `result.text`.
- **Check:**
  - `gcloud scheduler jobs describe command-sweep --location us-central1` shows the sweeper's OIDC token and that audience.
  - The composite indexes are `READY` (Firestore Admin API, `databases/policy/collectionGroups/commands/indexes`).
  - A `POST` to the sweep URL without that token answers 401.

### Step 21: the C6 activation drive's services and the fault Broker's proxy host [RETIRED 2026-11-11, except `l0176r-drive`]

**Retired 2026-11-11.**
- **Deleted:** the `broker-faults` and `api-drive` Cloud Run services. Their last authenticated use was the drive itself (11-09). Since then they received only refused unauthenticated `GET /` requests.
- **Removed from configuration:** their `deploy.json` entries, and the `broker-faults` host from `l0176r-drive`'s `network.allow`, the production network model and the step 1 checklist.
- **Still to do:** the proxy VMs keep listing the host until the next `egress-proxy` rolling update. The generated config without it has `config_sha256` `1aa650b05c2bb744c0a1fa4afe7ff16ae5b1ec6a6aca44e08cc14ba3b2f76d36`. The host now points at no service.
- **Kept until that rollout:** the secret `egress-proxy-cert-broker-faults-sja7fatcta-uc-a-run-app`, because the current template loads it at boot. Delete it after the rollout.
- **Kept, deliberately:** `l0176r-drive` and its approved, tagged revision `l0176r-drive-rmw9qbqjr-751fe1`. The drive's receipts are tied to it, and its retirement report counts them as unfinished. It serves no traffic, and its `BROKER_URL` still names the deleted `broker-faults`.

The original setup, as it was:

L0176's activation drive (`docs/c6-l0176-commands-plan.md` §6), set up 2026-11-09. Three non-production services, each on its production twin's runtime account, so no new identity or role exists. Production never routes to any of them.

- **`broker-faults`** is the production Broker image with `BROKER_FAULTS=drop-outcome` and `BROKER_FAULT_PRINCIPALS` = the canary uid only. After a successful provider write for that principal it records no outcome and answers as if the response were lost. Every other principal gets the ordinary Broker. The production service refuses to start with any fault set (`K_SERVICE=broker`, `packages/broker/src/faults.ts`).
  - Private. `run.invoker`: `l0176r-run` (the drive compiler) and `deploy-smoke` only. Neither `l0176-run` nor `policy-run` holds it.
  - Its receipts are in the same `broker` database, so Policy's settle and reconcile (through the production Broker) read them.
- **`l0176r-drive`** is the l0176r image with `BROKER_URL` = broker-faults, on `compilers-l0176` behind the proxy, as `l0176r-run`.
- **`api-drive`** is the api image with `COMMANDS_L0176=on`, `COMPILE_GENERATION_L0176=c6-drive-1`, `BASE_URL_L0176` = l0176r-drive, and no sweeper settings. The production api's sweeper recovers drive commands too, through their admitted revision.
- **The proxy.** `compilers-l0176` gains exactly `broker-faults-sja7fatcta-uc.a.run.app`, through l0176r-drive's `network.allow`. Its certificate is from the production CA, and the secret `egress-proxy-cert-broker-faults-sja7fatcta-uc-a-run-app` is readable by `egress-proxy` only. The config is `7ef2039e…` on template `egress-proxy-226124a1cda1`, rolled 2026-11-09 and verified by `verify-rollout.js` (both VMs `match: true`). The previous template `egress-proxy-0cfb77e009f1` is kept.
- **Check:**
  - `gcloud run services get-iam-policy broker-faults` lists only `l0176r-run` and `deploy-smoke`.
  - The production broker's env has no `BROKER_FAULT*`.

### Step 22: Firestore deletes are denied except to the runtime services, and logged [LIVE]

After the 2026-11-10 incident: at 16:55Z a test cleanup (`clearFirestore`, run without the emulator) used owner credentials to delete production collections in the default database. Everything was restored from point-in-time recovery (`scripts/restore-default-firestore.js`), and the cleanup helpers now refuse to run outside the emulator (#338). These changes stop, detect and limit a repeat.

- **The deny policy `firestore-no-deletes`** is attached to project `graffiticode`; the file is `configs/iam/firestore-no-deletes.json`. Live 2026-11-11 16:16Z.
  - It denies `datastore.googleapis.com/entities.delete`, `databases.bulkDelete`, `databases.delete` and `backups.delete` to everyone, owners included.
  - It exempts `api-run`, `auth-run`, `broker-run` and `policy-run`, the only identities that delete as part of normal work. The nightly `auth-refresh-token-cleanup` job deletes through auth's API, so as `auth-run`.
  - It doesn't affect creates or updates, Firestore's own TTL expiry (`stage-results`), or point-in-time recovery reads.
  - The one operator script that deleted documents, `lang-overrides clear`, now writes an empty `bindings` document instead, and the api treats that as no override (#344).
  - **Managing it needs `roles/iam.denyAdmin`.** That role can only be granted on the organization (`artcompiler.com`, `496958484376`). It was granted to `jeff@artcompiler.com` to create the policy and removed afterwards (2026-11-11); an organization admin grants it again to change the policy.
  - **A deliberate owner delete:** remove the policy (`gcloud iam policies delete firestore-no-deletes --attachment-point=cloudresourcemanager.googleapis.com%2Fprojects%2Fgraffiticode --kind=denypolicies`), then recreate it from the file.
- **Firestore data-access audit logs (`DATA_WRITE`)** are on for `datastore.googleapis.com`, through the project IAM policy's `auditConfigs`, since 2026-11-10.
  - Entries carry document names, never field values.
  - **The `_Default` sink exclusion `firestore-token-index-names`** drops entries naming auth's lookup-index documents (`*/-indexes-/*`). Those names contained the token itself: API keys, refresh tokens, OAuth access and refresh tokens. New entries are named by the token's hash (`packages/auth/src/storage/token-index.js`), and legacy ones move as they're used. Keep the exclusion while legacy entries remain. About 21 such entries were stored between 18:00 and 23:15Z on 11-10, before the exclusion. They are readable by owners only and age out with the bucket's retention.
- **Alerts**, on the operator SMS and `jeff@artcompiler.com` email channels:
  - **"Firestore: deletes by a person"**: any delete request whose caller isn't a service account. Log metric `firestore_deletes_by_person`.
  - **"Firestore: delete burst"**: more than 100 delete requests in 10 minutes. Log metric `firestore_delete_requests`; normal is about 18 an hour.
- **Check:**
  - `gcloud iam policies get firestore-no-deletes --attachment-point=cloudresourcemanager.googleapis.com%2Fprojects%2Fgraffiticode --kind=denypolicies` matches the file.
  - An owner `DELETE` of a non-existent document (`deny-check/probe-does-not-exist`) answers 403.
  - The services' delete requests appear in the data-access log with status OK.

### Step 23: `l0185r` is pinnable (C3 follow-up) [LIVE]

An L0185 stage can be admitted in a chain (the L0185 → L0176 save as a command) only once `l0185r` is pinnable: Policy refuses a language with no approved revision (`stage-not-pinnable`). L0185 has no protected functions, so its manifests carry registry version 0 and no required functions; it needs no Policy or Broker caller entry and no invoker grant.

- **Preflight's key fetch.** `/preflight` verifies the api's Google ID token (`PREFLIGHT_GATEWAYS=api-run`), which needs Google's certificates from `www.googleapis.com`. L0185's open class refuses every `googleapis.com` name (D2). The owner chose (2026-11-12) a single open-class exception: `GET /oauth2/v3/certs` on `www.googleapis.com`, and 403 `request` for anything else on that host (`deploy/egress-proxy/classes.json` `open.exceptions`). L0185 programs can reach that one public document too; it's public.
- **Proxy first.** The exception is in the proxy's static config, so the proxy is rolled out (README, "Change a compiler's hosts") **before** the `l0185r` candidate. This rollout also drops the retired fault Broker's host (Step 21), which the 2026-11-11 config already did but which wasn't rolled out.
- **`deploy.json`:** `l0185r` gets `pinnable` for `0185` with contract versions 1 and 2, `PREFLIGHT_GATEWAYS=api-run@graffiticode.iam.gserviceaccount.com`, and `www.googleapis.com` in `network.allow` (matching `production/network.json`).
- **Release.** Its first pinnable release records its revision as approved before promotion. The serving revision `l0185r-rmwcjrz90-673abb` was never approved; its tag is retired by the release (`retireTags`), as for `l0000r` and `l0176r`.
- **Applied 2026-11-12.** #366 (`7d6a74cf`). The proxy was rolled out at about 03:30Z: template `egress-proxy-6cfd69d74ba1`, config `56007b0e…`, `verify-rollout` ok on both VMs; the previous template `egress-proxy-226124a1cda1` is kept. `l0185r-rmwczv08x-e43ac0` was approved before promotion, the `rmwcjrz90-673abb` tag was retired, and `release-check l0185r` is ok. An anonymous `/preflight` answers 401. The canary's `--l0185-tail` (#367, execution `canary-nq62q`) completed an L0185 → L0176 save as a command, and the same key wrote nothing again. During that run the proxy logged one `GET /oauth2/v3/certs` from `compilers-l0185` (200, allowed), and `compilers-l0185` logged no refusals between the rollout and the run.
- **Check:** `release-check l0185r` ok; a staged `/preflight` from the api answers a manifest for `0185`, and from anyone else 401/403; a probe in `compilers-l0185` gets the certificates and a 403 `request` for any other `www.googleapis.com` path.

### Step 24: the B6 repair drive's services, the fault Broker's proxy host, and the drive's source [RETIRED 2026-11-15, except `l0176r-drive`]

**Retired 2026-11-15,** after the drive passed ([evidence](evidence/b6-repair-drive/README.md)) and the activation was promoted (`api-rmwh6ru3u-cd1743`, `REPAIR_L0176=on`): the production canary passed 33 of 33 (`canary-zm52x`) and `release-check api` passed.
- **Deleted:** the `broker-faults` and `api-drive` Cloud Run services. Before deletion `broker-faults`' `run.invoker` was `l0176r-run` and `deploy-smoke` only, and neither service served anything after the drive but stray `GET`s (`broker-faults` refused each, 403). Also the bucket `gs://graffiticode-b6-drive` and its one object.
- **Removed from configuration:** their `deploy.json` entries; the `broker-faults` host from `l0176r-drive`'s `network.allow` and the production network model; the `storage.googleapis.com` exception from `classes.json`, with that host in `l0185r`'s `network.allow` (deploy.json and the network model), the AT-11 probe and the proxy tests. L0013's own `storage.googleapis.com` stays. The step 1 checklist is regenerated.
- **The proxy:** the generated config is back to `config_sha256` `56007b0ed96392573305115fdc94178eccbab6d18bf264e6a5a5f4bb63f1236f`, the config before B6, which template `egress-proxy-6cfd69d74ba1` already carries. After #395 merged (`90a60a03`), the group was rolled to that template (`rolling-action start-update`, proactive, surge 2, unavailable 0). Its new VMs `egress-proxy-fbl6` and `egress-proxy-5q0c` each reported `56007b0e…` (19:56:12Z and 19:56:34Z), and `verify-rollout.js --expect 56007b0e… --size 2` answered `ok` (both `match: true`). The production canary then passed 33 of 33 (`canary-nl2zh`), its revocation probe restoring the connection's permissions to `null`. The previous template `egress-proxy-647de380be30` is kept.
- **Certificates:** the secret `egress-proxy-cert-broker-faults-sja7fatcta-uc-a-run-app` was deleted after the rollout (the current template no longer loads it). The secret `egress-proxy-cert-storage-googleapis-com` stays: L0013 uses that host (its version 2, added for the drive, is from the same CA and is the one served).
- **Kept, deliberately,** as in Step 21: `l0176r-drive` and its approved revisions. It serves no traffic, and its `BROKER_URL` still names the deleted `broker-faults`.
- **The canary window** `canary-window-b6` expires on its own at 2026-11-17T08:00Z.

The setup, as it was:

B6 slice 5's drive (`docs/b6-command-repair-plan.md`, slice 5, "The drive, in detail"). It reuses Step 21's shape, at `main`, with repair on. Each service runs on its production twin's runtime account, so no new identity or role exists. Production never routes to any of them; the production api's sweeper recovers the drive's orphaned commands and repairs, through their admitted revisions.

- **`broker-faults`:** the Broker at `main`, as `broker-run`, private.
  - `BROKER_FAULT_PRINCIPALS` is the canary uid only.
  - `BROKER_FAULTS` is unset in `deploy.json`, and set per phase: `fail-write` (a claimed write is recorded `failed` before any provider request) or `drop-outcome`.
  - It refuses to start as the production service, with either fault set.
  - `run.invoker`: `l0176r-run` and `deploy-smoke` only.
- **`l0176r-drive`:** l0176r at `main` (replay-capable), as `l0176r-run`, with `BROKER_URL` = broker-faults, on `compilers-l0176` behind the proxy. Its C6 revision `rmw9qbqjr` stays approved.
- **`api-drive`:** the api at `main`, as `api-run`, public. Its environment is the production api's with these changes:
  - no sweeper settings (`SWEEP_*`);
  - `BASE_URL_L0176` = l0176r-drive;
  - `COMPILE_GENERATION_L0176=b6-drive-1`;
  - `REPAIR_L0176=on`;
  - `API_COMMAND_FAULT_PRINCIPALS` = the canary uid, with `API_COMMAND_FAULTS` set only for the boundary phase (`exit-after-output`).
- **The proxy:**
  - `compilers-l0176` gains exactly `broker-faults-sja7fatcta-uc.a.run.app` again, through l0176r-drive's `network.allow`.
  - L0185's open class gains one reviewed exception: `storage.googleapis.com`, `GET` at exactly `/graffiticode-b6-drive/source.json`, and nothing else on that host, listed in `l0185r`'s `network.allow`.
  - The generated config is `config_sha256` `d7f974b70ed23afaade5926462c6796aa563edf7885ac9466a56581fddd8781d`.
- **The drive's source:** the object `gs://graffiticode-b6-drive/source.json`, readable by `allUsers` (the bucket holds nothing else), fetched by `l0185r` as `https://storage.googleapis.com/graffiticode-b6-drive/source.json`. The operator writes it with `Cache-Control: no-store`.

**The owner's actions, in order:**
1. **Provision the two services,** so the CLI can release to them; its first release replaces the placeholder image:
   - `gcloud run deploy broker-faults --region=us-central1 --image=<the live broker image digest> --service-account=broker-run@graffiticode.iam.gserviceaccount.com --no-allow-unauthenticated`, then grant `roles/run.invoker` on it to `l0176r-run` and `deploy-smoke` only;
   - `gcloud run deploy api-drive --region=us-central1 --image=<the live api image digest> --service-account=api-run@graffiticode.iam.gserviceaccount.com --allow-unauthenticated`.
2. **The proxy:**
   - issue the certificates for `broker-faults-sja7fatcta-uc.a.run.app` and `storage.googleapis.com` into their `egress-proxy-cert-<host>` secrets, readable by `egress-proxy` only (README, "Certificates");
   - build the template from `out/cloud-init.yaml` (`infra.js --plan`), and run the rolling update;
   - verify with `verify-rollout.js --expect d7f974b7…`.
3. **The source:** `gcloud storage buckets create gs://graffiticode-b6-drive --location=us-central1 --uniform-bucket-level-access`, then `allUsers` `roles/storage.objectViewer` on it, and the first object `source.json` as `{"label":"init"}` with `Cache-Control: no-store`.
4. **The canary window:** `roles/iam.serviceAccountOpenIdTokenCreator` on `api-run` and on `console-run@graffiticode-app` for the operator, time-limited by an IAM condition, as in C6.

**Then the agent:**
- releases `broker-faults`, `l0176r-drive` (its approval comes with its release) and `api-drive` with the CLI;
- sets each phase's fault with `gcloud run services update … --update-env-vars` or `--remove-env-vars`, moving the drive's traffic to the latest revision;
- runs `scripts/b6-drive.js`. The phases that time a narrowing, and the checks that read approvals, read Broker's and the revisions database with the operator's credentials, as C6's did, so the owner runs those.

**Retirement,** after the drive: delete `broker-faults` and `api-drive`; remove their entries, the `broker-faults` host and the `storage.googleapis.com` exception; roll out the proxy; delete the bucket. The canary window expires.

**Check:**
- `gcloud run services get-iam-policy broker-faults` lists only `l0176r-run` and `deploy-smoke`.
- The production Broker's and api's environments have no fault variables.

### Step 25: the app's render-grant resolver may read Policy's keys (C5a) [LIVE]

The app's form resolver accepts Policy's render grants (C5 plan, decision 7 and "IAM changes (C5a)"; app#117). It verifies each grant with Policy's public keys from `GET /v1/jwks`, which is behind Cloud Run IAM. It fetches them with `app-run`'s own Google ID token for Policy's audience. Without this grant, every grant is answered 503 `render-grants-unavailable`.

- **The binding:** `roles/run.invoker` on the `policy` service (graffiticode, us-central1) for `serviceAccount:app-run@graffiticode-app.iam.gserviceaccount.com`. It is service-level only; `app-run` has no project-level role in `graffiticode`.
- **It grants nothing else.** Policy has two routes open to any invoker: `/v1/jwks` (public keys) and `/v1/protected-execution` (a public status). Every other route requires a caller role (`ROUTE_ROLES` in `packages/policy/src/app.ts`: gateway, broker, compiler or console), which `app-run` doesn't have.
- **Applied 2026-11-17, about 17:20Z,** with the owner's approval (only this step; the rest of C5a's IAM stays held).
- **Verified:**
  - **The binding:** `run.invoker` on `policy` lists `app-run` (9 members), and there are no project-level bindings.
  - **Through the app:** a well-formed ES256 grant signed by a throwaway key was sent to `https://app-cfdwwd7ega-uc.a.run.app/api/form/resolve` (served by `app-rmwjwsu2n-067a1a`).
    - Before the binding, and until it propagated (17:20:31–17:21:51Z), the app answered 503 `render-grants-unavailable`. Policy logged `GET /v1/jwks` 403 for each attempt.
    - At 17:22:11Z Policy logged `GET /v1/jwks` 200, and the app answered 401 `bad-render-grant`: the keys loaded and the foreign signature was refused.
    - A later probe answered 401 from the held keys, with no new fetch.
    - Every answer was `Cache-Control: no-store`.
- **Rollback:** `gcloud run services remove-iam-policy-binding policy --project graffiticode --region us-central1 --member=serviceAccount:app-run@graffiticode-app.iam.gserviceaccount.com --role=roles/run.invoker`. The resolver then answers 503 again; nothing else changes.

### Step 26: `l0013r` as a Policy and Broker caller (C5a) [LIVE 2026-11-17]

L0013's `snap` under a command reserves and stages through Policy and publishes its thumbnail through Broker, as `l0013r-run` (C5 plan, "IAM changes (C5a)"). Each of the three parts was applied only with the owner's approval. Production `COMMANDS_L0013` stays unset, so no api yet gives `l0013r` a command session.

1. **Invoker bindings (applied 2026-11-17, about 17:30Z):** `roles/run.invoker` on the `policy` and `broker` services (graffiticode, us-central1) for `serviceAccount:l0013r-run@graffiticode.iam.gserviceaccount.com`, service-level only.
   - **Verified:** `policy` now has 10 invokers and `broker` 5, each including `l0013r-run`. `l0013r-run` has no project-level role in `graffiticode`. The IAM troubleshooter's allow policy grants `run.routes.invoke` on both.
   - **Rollback:** `gcloud run services remove-iam-policy-binding <policy|broker> --project graffiticode --region us-central1 --member=serviceAccount:l0013r-run@graffiticode.iam.gserviceaccount.com --role=roles/run.invoker`.
2. **The caller lists (live 2026-11-17):** a new version of each, adding `"l0013r-run@graffiticode.iam.gserviceaccount.com": { "role": "compiler", "lang": "0013" }` and nothing else.
   - **Versions:** `policy-callers` 7 (from 6) and `broker-callers` 3 (from 2). Each was checked against the reviewed payload (the previous version plus the one entry) and parsed by Policy's `parseCallers` (8 and 4 callers). `deploy.json` pins them (#411, merged `58adb430`).
   - **Released from `main` at `58adb430`:**
     - Broker `broker-rmwkzsw86-98e2cf` reads `broker-callers:3`;
     - then Policy `policy-rmwl04x01-2d9c35` reads `policy-callers:7`.
     - `release-check` is ok for both, and the full canary passed 36/36 (`canary-mrlkr`).
   - **Rollback:** `npm run rollback -- broker|policy --env production --release rmwkzsw86-98e2cf|rmwl04x01-2d9c35` restores `broker-rmwjy9cjp-4a0c2c` and `policy-rmwjyqeto-b2be2b`, which read versions 2 and 6 (both still enabled). Then disable versions 3 and 7.
3. **The proxy (live 2026-11-17):** `compilers-l0013`'s `network.allow` gains `policy-sja7fatcta-uc.a.run.app`, `broker-sja7fatcta-uc.a.run.app` and `www.googleapis.com`.
   - **Why `www.googleapis.com`:** `l0013r`'s `/preflight` verifies the api's Google ID token (`PREFLIGHT_GATEWAYS`) with `https://www.googleapis.com/oauth2/v3/certs` (`languages/l0000/crates/server/src/gateway.rs`), as `l0176r` and `l0000r` do. The owner approved it in the review of #411.
   - **What changed:** only the Envoy configuration and its digest. The generated DNS, firewall and certificate-loading scripts are unchanged, and each host's certificate secret already existed.
   - **Rollout:**
     - Config `56007b0e…` → `8b637609…`, on template `egress-proxy-ce42b3628a5a` (user-data digest `ce42b3628a5a…`).
     - Rolling update at 18:20Z (proactive, surge 2, unavailable 0). The group was stable at 18:23Z on `egress-proxy-62k9` and `egress-proxy-d856`.
     - The previous template, `egress-proxy-6cfd69d74ba1`, is kept.
   - **`verify-rollout.js --expect 8b637609… --size 2`: ok.** Both VMs report `8b637609…` with `match: true`, at 18:23:58Z and 18:24:01Z ([`docs/evidence/c5a/step26/verify-rollout.json`](evidence/c5a/step26/verify-rollout.json)).
   - **The class probe,** with its verdict kept as reported: `pending`.
     - It ran the regenerated AT-11 probe (#411) as `l0013r-run` on `compilers-l0013`: job `at11-net-l0013r`, image `at11-probe@sha256:0b96d1ae52b1307fda0677a2ac86991dda400afc21a7a455e50d0a886dfff224`, execution `at11-net-l0013r-qdmmm`, nonce `b2493b5b6cb396e2`, 2026-11-17T18:25Z.
     - Of 24 rows, 17 passed and 6 are n/a for the class. Among those that passed:
       - `listed`: Policy is reached through the proxy, with Policy's own answer;
       - `external`: `www.googleapis.com` and `storage.googleapis.com` are reached;
       - `broker-no-token`: Broker's own refusal, 401 `missing-execution-token`;
       - Learnosity, unlisted hosts, other run.app services, fronting, redirects, IP literals, trailing dots and direct connections are all still refused.
     - **`dns-exfil` remains `pending-log`.** The job got NXDOMAIN for `at11-b422fd4a7b2d5303.at11.graffiticode.org`, but only the collector (`scripts/at11/collect.js`) decides that row, from the authoritative DNS server's query log.
     - **The collector can't run.** That log and the collector's control job (`at11-iam-control`) were in `graffiticode-isolate01`, which is `DELETE_REQUESTED`. `graffiticode` has no query log for `at11.graffiticode.org`. So no collector verdict exists for this rollout.
     - The full evidence line is [`docs/evidence/c5a/step26/at11-net-l0013r-qdmmm.json`](evidence/c5a/step26/at11-net-l0013r-qdmmm.json). The job was deleted after the evidence was saved.
   - **Scoped exception (owner, 2026-11-17):** for this rollout only, the 17 passing rows, the n/a rows and the job's NXDOMAIN observation stand as the probe evidence, with `dns-exfil` recorded as unverifiable.
     - **The reason:** this change touched only Envoy's configuration. DNS resolution for compilers isn't part of it.
     - **It doesn't carry over.** Restoring the DNS collector and its control is tracked in §5 (open question 11), and must be done before any future DNS-control change.
   - **Then `l0013r` was re-released** from `58adb430` as `l0013r-rmwl2casf-31e8b9`, image `sha256:a1a53155…`.
     - Its approval record in the revisions database says `approved`, contract `[3]`. The previous approval, `l0013r-rmwjzlgz6-2882e6` with `[3]`, is kept.
     - `release-check l0013r` is ok, and the full canary then passed 36/36 (`canary-rmhjb`). The revision logged no errors.
     - **Rollback:** `npm run rollback -- l0013r --env production --release rmwl2casf-31e8b9` restores `l0013r-rmwjzlgz6-2882e6`.
   - **Proxy rollback:** run a rolling update back to `egress-proxy-6cfd69d74ba1` (config `56007b0e…`), and verify with `verify-rollout.js --expect 56007b0e…`.

### Step 27: Policy asks the console's item-authority route (C5a) [LIVE 2026-11-17]

Policy decides who may capture an item by asking the console's own item store (C5 plan, decision 3): `POST /api/internal/item-authority { itemId }` on the `console` service (graffiticode-app, app#116, live since `console-rmwjw7o6n-d368e9`). Today Policy has no `ITEM_AUTHORITY_URL`, so every item scope is refused `item-authority-unavailable`. This step gives Policy the route.

**Ingress, read first (2026-11-17):**
- **The console:** ingress `all`, and `allUsers` holds `roles/run.invoker`, so Cloud Run doesn't authenticate its callers. `console.graffiticode.org` is mapped to it and proxied by Cloudflare. Its run.app URL is `https://console-cfdwwd7ega-uc.a.run.app`.
- **The route authenticates its caller itself.** It accepts only a Google-issued ID token with a verified email in `ITEM_AUTHORITY_CALLERS` (unset, so `policy-run@graffiticode.iam.gserviceaccount.com` only), issued for `ITEM_AUTHORITY_AUDIENCE` (unset, so `https://console.graffiticode.org/api/internal/item-authority`). Anything else gets 403 and nothing about the item. Every answer is `no-store`.
- **Baseline probes (2026-11-17),** on both the run.app URL and the domain:
  - `POST` with no token: 403, `no-store`;
  - `POST` with a malformed token: 403, `no-store`;
  - `GET`: 405.
- **The route's query** (a collection group on `items.id`) has its index in `graffiticode-app`'s Firestore: `COLLECTION_GROUP`, ascending, `READY`.

**The change, entirely in Policy's `deploy.json` env** (this PR):

```json
"ITEM_AUTHORITY_URL": "https://console-cfdwwd7ega-uc.a.run.app/api/internal/item-authority",
"ITEM_AUTHORITY_AUDIENCE": "https://console.graffiticode.org/api/internal/item-authority"
```

- **No IAM change.** The console is already publicly invokable, and the route checks Policy's token itself. Granting `policy-run` invoker there would add nothing.
- **No console change or release.** The audience above is the route's default, and its caller default is `policy-run`.
- **The run.app URL, not the domain.** Service-to-service calls avoid Cloudflare's proxy: its WAF and bot rules, its timeout, and its caching (§5, open question 4). The token's audience stays the console's own name; the route checks that, not the host it was reached on.
- **Inert in production until the gate.** Policy asks the route only for an item scope: a v3 admission, reservation, mint or authorization. The production api declares no `scopes`, and `COMMANDS_L0013` is unset, so nothing asks before `api-c5a-gate`. Every 36-check canary path is unchanged.

**Verification plan (each step needs the owner's approval):**
1. **Positive probe as `policy-run`, before Policy is released.**
   - A one-off Cloud Run job, `c5a-item-authority-probe`, runs as `policy-run` from the public `node:22` image with an inline script. It takes a metadata-server ID token for the audience above, then calls the run.app URL:
     - with a known canary item id: expect 200 `{ exists: true, ownerUid: <the canary uid>, isPublic, taskId, lang }`;
     - with an id no one holds: expect 200 `{ exists: false }`;
     - with a token for another audience: expect 403.
   - The job logs only status codes and the answers' fields, never a token. It is deleted after its evidence is saved.
   - This proves the token reaches the route intact on a public service (§5, open question 3). The other way to prove it is the gate itself.
   - **Done 2026-11-17 (owner-approved; passed).**
     - **The job:** `c5a-item-authority-probe`, execution `c5a-item-authority-probe-ppbkf`, at 19:55Z, running [`scripts/c5a/item-authority-probe.js`](../scripts/c5a/item-authority-probe.js) on `node:22.23.3@sha256:363e1587…`. The job was deleted after its evidence was saved.
     - **The tokens:** both were for `policy-run`, verified, issued by `accounts.google.com`.
     - **The canary's private L0176 item `3UItj2wroJ80BnHXkpR9`:** 200, `{ exists: true, ownerUid: <the canary uid>, isPublic: false, taskId, lang: "0176" }`.
     - **An unknown id:** 200 `{ exists: false }`.
     - **The known item, with a token for the run.app URL's audience:** 403.
     - Every answer was `Cache-Control: no-store`.
     - **Evidence:** [`docs/evidence/c5a/step27/probe-result.json`](evidence/c5a/step27/probe-result.json); no tokens are recorded.
2. **Release Policy** from `main` with the env:
   - `verify/policy.js` passes;
   - `release-check policy` is ok;
   - the serving revision carries both variables;
   - the full 36-check canary passes, unchanged since nothing asks the route yet;
   - the rollback target is recorded.
   - **Done 2026-11-17 (owner-approved).** #413 merged as `f6132821`, and Policy was released from that clean `main` as `policy-rmwl4or99-166557`:
     - `verify/policy.js` passed on the candidate.
     - **The variables:** the only revision taking traffic, `policy-rmwl4or99-166557` at 100%, carries both, as `gcloud run revisions describe` shows them: `ITEM_AUTHORITY_URL=https://console-cfdwwd7ega-uc.a.run.app/api/internal/item-authority` and `ITEM_AUTHORITY_AUDIENCE=https://console.graffiticode.org/api/internal/item-authority`.
     - `release-check policy` is ok.
     - **The canary:** the full 36-check run passed through `api-rmwkxlbvy-b5fa92` (`canary-68st7`, from 21:07Z), and the new revision logged no errors.
     - **The rollback plan:** `npm run rollback -- policy --env production --release rmwl4or99-166557 --plan` restores `policy-rmwl04x01-2d9c35` to 100%.
     - **No calls from Policy yet,** as expected: nothing in production asks the route. Between 20:45Z and 21:10Z the console logged 20 `GET`s of the route from outside addresses with a generic `Mozilla/5.0 (compatible)` agent, through both hosts, each answered 405. They look like link scanners following the URLs in the PRs; the owner reviewed them, and no change is needed.
3. **At the gate** (C5a's completion gate, held), through `api-c5a-gate`:
   - the owner's capture of their private item is allowed;
   - another account's capture of it is refused `not-owner`;
   - a non-owner's capture of a public item is decided as decision 4 says (the public-capture exception, recorded as such);
   - an unknown id is refused `item-not-found`.
   - Policy's log shows one route call per decision, and the console's log shows no 403 for `policy-run`.

**Risks:**
- **Cold starts are unlikely.** The console has a service-level minimum of 1 instance (`run.googleapis.com/minScale: 1`; its releases set no revision-level minimum, and today's kept it). Policy gives up after 5 s (`ITEM_AUTHORITY_TIMEOUT_MS`); a slow answer is a temporary `item-authority-unavailable`, which never allows, and the command resumes later.
- **Exposure.** The route's public surface is unchanged: it has been live and refusing every caller but `policy-run` since app#116.

**Rollback:** every item scope is then refused `item-authority-unavailable` again, as today. Either way, verify it from the revisions that receive traffic, not from the service: `gcloud run services describe` shows the latest revision's template, which a traffic rollback leaves unchanged.
1. Read the service's `status.traffic`, and list every revision with a nonzero percent.
2. Run `gcloud run revisions describe <revision>` for each.
3. Confirm that none of them carries `ITEM_AUTHORITY_URL` or `ITEM_AUTHORITY_AUDIENCE`, and that the intended rollback revision receives 100%.

```bash
gcloud run services describe policy --project=graffiticode --region=us-central1 --format=json \
  | jq -r '.status.traffic[] | select((.percent // 0) > 0) | "\(.revisionName) \(.percent)"' \
  | while read -r rev pct; do
      n=$(gcloud run revisions describe "$rev" --project=graffiticode --region=us-central1 --format=json \
        | jq '[.spec.containers[].env[]? | select(.name == "ITEM_AUTHORITY_URL" or .name == "ITEM_AUTHORITY_AUDIENCE")] | length')
      echo "$rev ${pct}% item-authority-vars=$n"
    done
```

The expected output is one line, the rollback revision at `100%` with `item-authority-vars=0`. Run against today's Policy (2026-11-17), it prints `policy-rmwl04x01-2d9c35 100% item-authority-vars=0`.
- **Immediately:** `npm run rollback -- policy --env production --release <this release>` moves traffic back to the previous revision (`policy-rmwl04x01-2d9c35` today), which was created without either variable.
- **Forward**, by a new release. Deleting the variables from `env` isn't enough: the CLI applies `env` with `--update-env-vars`, which keeps any variable it isn't given (`packages/deploy/README.md`, `removeEnv`). Remove both names from Policy's `env` and add them to its `removeEnv`, which the release passes as `--remove-env-vars`:

  ```json
  "removeEnv": ["ITEM_AUTHORITY_URL", "ITEM_AUTHORITY_AUDIENCE"]
  ```

  A name can't be in both `env` and `removeEnv`, so this is one `deploy.json` change, released and then verified as above.

### Step 28: the C5a gate bucket and the command staging bucket [LIVE 2026-11-17]

Two new buckets in `graffiticode`, as C5 plan decisions 8 and 9 and "IAM changes (C5a)" describe them. Neither exists yet (checked 2026-11-17: `gs://graffiticode-c5a-gate`, `gs://graffiticode-command-staging` and `gs://graffiticode-thumbnails` each answer 404).

Both services are already configured for them:
- **Broker** sets `THUMBNAIL_BUCKET=graffiticode-c5a-gate` and `COMMAND_STAGING_BUCKET=graffiticode-command-staging`.
- **Policy** sets `COMMAND_STAGING_BUCKET=graffiticode-command-staging`.

**Nothing in production uses either bucket until the gate.** Only a v3 capture under `COMMANDS_L0013` stages or publishes, and production has neither. Creating them changes no serving behaviour.

**What each service does to them** (the code):
- **Policy** (`packages/policy/src/staging.ts`) does two things, both in the staging bucket only:
  - creates `{commandId}/{stage}/{occurrenceId}.png` once, with a `POST` upload and `ifGenerationMatch=0`;
  - reads it back with `GET alt=media`, to adopt what a lost acknowledgment left behind.
- **Broker** (`packages/broker/src/gcs.ts`):
  - **staging:** reads the staged bytes with `GET alt=media`;
  - **thumbnail bucket:** reads `{item}.png`'s generation and metadata, then writes it with `ifGenerationMatch` set to that generation (`0` when absent), as a multipart upload with `captureSequence`, `commandId`, `sha256` and `item` metadata, `Cache-Control: no-cache`;
  - **the permission that implies:** replacing an existing object needs `storage.objects.delete`.
- Neither service lists objects, reads bucket metadata, or changes ACLs or IAM.

#### The gate bucket, `gs://graffiticode-c5a-gate`

Broker's thumbnail bucket for the C5a gate only, so Broker's C5a release can't write production thumbnails. It's deleted after the gate's evidence is extracted, as `gs://graffiticode-b6-drive` was.

```bash
gcloud storage buckets create gs://graffiticode-c5a-gate --project=graffiticode \
  --location=us-central1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=0
gcloud storage buckets add-iam-policy-binding gs://graffiticode-c5a-gate \
  --member=serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com \
  --role=roles/storage.objectUser
```

- **Location:** `us-central1`, beside Broker.
- **Access:** uniform bucket-level access, so there are no object ACLs, and public access prevention is enforced, unlike production thumbnails (decision 8's `graffiticode-thumbnails`, C5b, will be public).
- **No versioning and no soft delete:** the bucket is transient, and nothing in it needs recovering.
- **No lifecycle rule:** the gate reads what it published, and deleting the bucket is the gate's own last step.
- **`broker-run` gets `roles/storage.objectUser`,** which grants `objects.get`, `create`, `delete` and `list`. The protocol needs get, create and delete. `objectCreator` can't overwrite, and `objectAdmin` would add object IAM and ACL changes it doesn't need. It's granted on this bucket only.

#### The staging bucket, `gs://graffiticode-command-staging`

Decision 9: where a capture's rendered PNG is staged before Broker publishes it. It's permanent, and its objects are deleted after 30 days.

```bash
cat > /tmp/staging-lifecycle.json <<'JSON'
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 30}}]}
JSON
gcloud storage buckets create gs://graffiticode-command-staging --project=graffiticode \
  --location=us-central1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=7d --lifecycle-file=/tmp/staging-lifecycle.json
gcloud storage buckets add-iam-policy-binding gs://graffiticode-command-staging \
  --member=serviceAccount:policy-run@graffiticode.iam.gserviceaccount.com \
  --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://graffiticode-command-staging \
  --member=serviceAccount:policy-run@graffiticode.iam.gserviceaccount.com \
  --role=roles/storage.objectViewer
gcloud storage buckets add-iam-policy-binding gs://graffiticode-command-staging \
  --member=serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com \
  --role=roles/storage.objectViewer
```

- **Location and access** are as for the gate bucket: `us-central1`, uniform, public access prevention enforced, no versioning. Unlike the gate bucket, it keeps soft delete (below).
- **Lifecycle:** objects are deleted at 30 days of age. That bounds how long a pending command can wait to publish: a capture staged more than 30 days before Broker reads it finds nothing, and Broker refuses it rather than publishing anything else. Recovery (the sweeper, C5d) runs well within that.
- **Seven-day soft delete** ([Google's soft delete](https://docs.cloud.google.com/storage/docs/soft-delete)): a deleted object can be restored for 7 days.
  - Neither runtime identity can delete a staged object: Policy has `objectCreator` and `objectViewer`, and Broker has `objectViewer`.
  - People and accounts with broader roles can delete one: the project owners and `storage@graffiticode` (`roles/storage.admin`). Soft delete gives a recovery window for an accidental deletion.
  - Objects the lifecycle rule deletes are also kept for 7 more days, at a small storage cost.
- **`policy-run`** gets `objectCreator` and `objectViewer`:
  - it can create a name once and read it back;
  - it can't replace or delete it, so staged bytes are immutable to Policy.
- **`broker-run`** gets `objectViewer`: read only.

#### What both buckets also inherit

- **Bucket-level convenience bindings, reduced at creation.**
  - **What creation adds:** a bucket created with uniform access gets four: `legacyBucketOwner` and `legacyObjectOwner` for `projectOwner:graffiticode` and `projectEditor:graffiticode`, and `legacyBucketReader` and `legacyObjectReader` for `projectViewer:graffiticode`. This plan first listed only the bucket-level two, read from `graffiticode-l0013-evidence`, which uses fine-grained access.
  - **Why reduce them:** these bindings grant object access that basic project roles don't carry by themselves, and they extend to anyone who later holds those project roles ([basic roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles#basic-roles)).
  - **What was removed (owner's choice, 2026-11-17):** `projectEditor` from both owner roles, and `projectViewer` from both reader roles, on both buckets. `projectOwner`'s two bindings stay.
- **Project roles:**
  - `roles/owner`: the three project owners;
  - `roles/editor`: the Google APIs service agent `656973052505@cloudservices` only;
  - `roles/storage.admin`: `storage@graffiticode`;
  - `roles/storage.objectViewer`: the Artifact Registry service agent, project-wide.
- No compiler account (`l0013r-run` included) has any role on either bucket. `l0013r-run`'s `objectAdmin` is on `graffiticode.appspot.com` and `graffiticode-l0013-evidence` only.

#### Verification

1. **Settings**, read only:

   ```bash
   for b in graffiticode-c5a-gate graffiticode-command-staging; do
     gcloud storage buckets describe gs://$b --format=json \
       | jq -c --arg b "$b" '{bucket: $b, location, default_storage_class, uniform_bucket_level_access, public_access_prevention, versioning_enabled, soft_delete: .soft_delete_policy.retentionDurationSeconds, lifecycle: .lifecycle_config}'
   done
   ```

   **Expect:** `US-CENTRAL1`, `STANDARD`, `uniform_bucket_level_access: true`, `public_access_prevention: "enforced"`, versioning off or null.
   - **Gate:** soft delete `"0"`, and lifecycle `null`.
   - **Staging:** soft delete `"604800"` (7 days), and lifecycle `[Delete, age 30]`.

2. **IAM**, read only:

   ```bash
   for b in graffiticode-c5a-gate graffiticode-command-staging; do
     echo "== $b"; gcloud storage buckets get-iam-policy gs://$b --format=json | jq -r '.bindings[] | "\(.role): \(.members|join(", "))"'
   done
   ```

   **Expect** exactly these bindings:
   - **both buckets:** `roles/storage.legacyBucketOwner: projectOwner:graffiticode` and `roles/storage.legacyObjectOwner: projectOwner:graffiticode`;
   - **gate:** `roles/storage.objectUser: serviceAccount:broker-run@…`;
   - **staging:** `roles/storage.objectCreator: serviceAccount:policy-run@…`, and `roles/storage.objectViewer: serviceAccount:broker-run@…, serviceAccount:policy-run@…`.

3. **Behaviour, as each service's own identity.** These are two one-off Cloud Run jobs, each needing approval, running [`scripts/c5a/bucket-probe.js`](../scripts/c5a/bucket-probe.js) on `node:22.23.3@sha256:363e1587…`. Each makes the same JSON API calls the service's code makes, under `c5a-probe/<run>/`, and prints only status codes; its tokens come from the metadata server and are never printed.

   - **`c5a-bucket-probe-policy`, as `policy-run`** (run first):

     | Check | Expect | What it shows |
     |---|---|---|
     | `create-once` | 200 | |
     | `create-again` | 412 | create-once holds |
     | `read` | 200 | adoption |
     | `overwrite` | 403 | no delete |
     | `delete` | 403 | |
     | `gate-read` | 403 | no access outside staging |

   - **`c5a-bucket-probe-broker`, as `broker-run`:**

     | Check | Expect | What it shows |
     |---|---|---|
     | `staging-read` | 200 | Policy's staged object |
     | `staging-create` | 403 | |
     | `gate-create` | 200 | |
     | `gate-metadata` | 200 | |
     | `gate-stale` | 412 | |
     | `gate-overwrite` | 200 | the plan's "test write, a precondition failure and an overwrite" |

   - **Anonymous reads** of both probe objects (`curl https://storage.googleapis.com/<bucket>/c5a-probe/<run>/…`) answer 401 or 403.
   - **Afterwards:** the operator deletes `c5a-probe/` from both buckets with `gcloud storage rm`, and the two jobs. The results, without tokens, go to `docs/evidence/c5a/step28/`.

**Applied 2026-11-17 (owner-approved).** Evidence: [`docs/evidence/c5a/step28/`](evidence/c5a/step28/).
1. **Created** both buckets with the commands above (staging with `--soft-delete-duration=7d` and the 30-day rule), and added the four runtime bindings.
2. **Settings** (`settings.jsonl`): as expected.
   - **Both:** `US-CENTRAL1`, `STANDARD`, uniform, public access prevention `enforced`, versioning null.
   - **Gate:** soft delete `0`, no lifecycle.
   - **Staging:** soft delete `604800`, and Delete at age 30.
3. **IAM at creation** (`iam-at-creation.txt`, with the JSON policies) carried the four convenience bindings above, not two. The owner chose to remove `projectEditor` and `projectViewer` from them.
   - `gcloud storage buckets remove-iam-policy-binding` didn't match those convenience members ("binding … not found"), so nothing changed that way.
   - Instead, each policy was read, only those members were removed with `jq` (which left the two reader bindings empty, so they're dropped), and the policy was written back with `set-iam-policy` under its etag.
   - **Read back** (`iam-after.txt`): exactly the expected bindings above.
4. **Probes,** at run label `r11172247`, both passed:
   - **`c5a-bucket-probe-policy-rrg8t`, as `policy-run`** (`probe-policy.json`): `create-once` 200, `create-again` 412, `read` 200, `overwrite` 403, `delete` 403, `gate-read` 403.
   - **`c5a-bucket-probe-broker-w6xhm`, as `broker-run`** (`probe-broker.json`): `staging-read` 200, `staging-create` 403, `gate-create` 200, `gate-metadata` 200, `gate-stale` 412, `gate-overwrite` 200.
5. **Anonymous reads** of both probe objects (`anonymous-reads.txt`): 403 by `storage.googleapis.com/<bucket>/<object>`, and 401 by the JSON API.
6. **Cleanup,** after this evidence was pushed: the operator deleted `c5a-probe/` from both buckets, and both jobs.

**Rollback:**
- **The gate bucket:** `gcloud storage rm -r gs://graffiticode-c5a-gate`. That's also its planned end after the gate.
- **The staging bucket:** remove the three bindings with `gcloud storage buckets remove-iam-policy-binding`, using the same members and roles. Delete it only if C5a is abandoned: Policy's and Broker's configuration name it.
- **Removing either bucket** makes staging or publishing fail with an error, which means unavailable, never allowed.

### Step 29: the C5a gate api and the canary window [LIVE 2026-11-17–18; retired 2026-11-18]

The gate (C5 plan, "C5a completion gate") runs `scripts/c5a-gate.js` as the canary account through a dedicated api, `api-c5a-gate`, as B6's drive ran through `api-drive` (Step 24). Production is untouched: production `COMMANDS_L0013` stays unset, and its api declares no `scopes`.

#### The api slice (resolved)

When this step was first proposed, the api at `main` couldn't run the gate: `POST /command` refused a command with no connection, the api never declared the `scopes` capability, and `scripts/c5a-gate.js` didn't exist. So the entry carried a `blocked` reason. C5a slice 7 (#417, merged `08c74b8f`) added all three, behind `COMMAND_SCOPES=on`:
- connectionless commands through `POST /command` and the compile bridge, with whole-chain eligibility;
- the capability declared on allocation, admission, lease, takeover and the due query;
- anonymous public capture through the bridge only, and no fallback to L0013's direct upload;
- the deploy guard (production `api` lists `COMMAND_SCOPES` in `removeEnv`);
- the gate runner and its tested verdict.

The `blocked` field is removed. Releasing `api-c5a-gate` still needs the owner's approval, as do the provisioning, invokers and window below.

#### The deployment (`deploy.json` `api-c5a-gate`, in this PR)

- **The production api's entry** (image build, steps, smoke, `verify/api.js`, `EDGE_AUTH_SECRET`), with these changes:
  - **image** `us-central1-docker.pkg.dev/graffiticode/services/api-c5a-gate`;
  - **`access: "private"`**, with `smokeServiceAccount: deploy-smoke@graffiticode.iam.gserviceaccount.com` for the CLI's candidate checks;
  - **runtime** `api-run` (Policy's gateway caller and `l0013r`'s `PREFLIGHT_GATEWAYS` both name it, so no new identity or caller entry is needed);
  - **no sweeper:** `SWEEP_AUDIENCE` and `SWEEP_CALLERS` are dropped from `env` and listed in its `removeEnv`, so no revision of it ever mounts the sweep route (recovery is left to C5d's drive, and Cloud Scheduler never calls it);
  - **`COMMANDS_L0013=on`, `COMPILE_GENERATION_L0013=c5a-gate-1`, `COMMAND_SCOPES=on`;**
  - `BASE_URL_L0013` stays production `l0013r` (`l0013r-rmwl2casf-31e8b9` is approved `[3]`), and every other language's routing is production's.
- **It reaches Broker's gate bucket only.** Broker's `THUMBNAIL_BUCKET` is `graffiticode-c5a-gate` (Step 28).
- **It is released from `main`** (now including #417), with the owner's approval, after the service is provisioned.

#### Provisioning and invokers (owner's actions; each needs approval)

1. **Create the service** privately, so the CLI can release to it (the CLI needs an existing service with 100% traffic). The image is the live production api's:

   ```bash
   gcloud run deploy api-c5a-gate --project=graffiticode --region=us-central1 \
     --image=us-central1-docker.pkg.dev/graffiticode/services/api@sha256:109d3f7c322e6d52dbcc2253ee733d3b31230a2ec27253ddad1142d4dd66d4bd \
     --service-account=api-run@graffiticode.iam.gserviceaccount.com --no-allow-unauthenticated
   ```

   - **A bootstrap placeholder only.** Creating a service from the production api's image copies none of its configuration: no environment (no `AUTH_URL`, `POLICY_URL`, routing or flags) and no secret mounts (`EDGE_AUTH_SECRET`). So the placeholder isn't a working api, and nothing is validated against it. It exists only so the CLI has a service with 100% traffic to release to.
   - **The gate api is validated after its first managed release** (`npm run deploy -- api-c5a-gate`), which applies `deploy.json`'s environment and secrets. Its verification (below) reads that release's serving revision.
   - Until then, only its two invokers can reach the placeholder.
2. **Invokers:** `roles/run.invoker` on `api-c5a-gate` only, for two accounts:
   - `deploy-smoke`, for the CLI's candidate checks;
   - `console-run@graffiticode-app`, the gateway identity the gate calls through.

   ```bash
   for m in serviceAccount:deploy-smoke@graffiticode.iam.gserviceaccount.com serviceAccount:console-run@graffiticode-app.iam.gserviceaccount.com; do
     gcloud run services add-iam-policy-binding api-c5a-gate --project=graffiticode --region=us-central1 --member=$m --role=roles/run.invoker
   done
   ```

   Not `allUsers` (B6's `api-drive` was public; this one isn't), and not `command-sweeper`.

#### The canary window, `canary-window-c5a` (the IAM diff)

The gate calls `api-c5a-gate` as the canary account does through the console:
- a `console-run` ID token for the gate api's URL, in `X-Serverless-Authorization`;
- the canary user's token in `Authorization`.

The operator mints the first by impersonation, so the operator needs `roles/iam.serviceAccountOpenIdTokenCreator` on `console-run` for the window only. This is a conditional binding on the service account `console-run@graffiticode-app.iam.gserviceaccount.com`:

```diff
  bindings:
+ - role: roles/iam.serviceAccountOpenIdTokenCreator
+   members: [user:<the operator, as in canary-window-b6>]
+   condition:
+     title: canary-window-c5a
+     description: C5a live gate through api-c5a-gate (C5 plan)
+     expression: request.time < timestamp("<grant time + 24h, UTC>")
```

```bash
gcloud iam service-accounts add-iam-policy-binding api-run@graffiticode.iam.gserviceaccount.com \
  --project=graffiticode --member=user:<operator> --role=roles/iam.serviceAccountOpenIdTokenCreator \
  --condition='title=canary-window-c5a,description=C5a live gate through api-c5a-gate (C5 plan),expression=request.time < timestamp("<grant time + 24h>")'
gcloud iam service-accounts add-iam-policy-binding console-run@graffiticode-app.iam.gserviceaccount.com \
  --project=graffiticode-app --member=user:<operator> --role=roles/iam.serviceAccountOpenIdTokenCreator \
  --condition='title=canary-window-c5a,description=C5a live gate through api-c5a-gate (C5 plan),expression=request.time < timestamp("<grant time + 24h>")'
```

- **`api-run` too (amended for #417's review):** the gate's old-worker row is judged from Policy's due query asked as the gateway, and its v3 fixtures and v2 control are allocated as the gateway (`scripts/c5a-gate.js --phase due`). So the window also grants the same conditional `roles/iam.serviceAccountOpenIdTokenCreator` on `api-run@graffiticode.iam.gserviceaccount.com`, as B6's window did, under the same title and expiry. No compiler account is granted: the plan forbids impersonating a compiler.
- **It expires on its own,** and the gate's reads of Policy's and Broker's databases use the operator's own credentials.
- **Stale bindings, for a later cleanup (not part of this step):** `console-run`'s policy still holds five expired conditional windows for the operator: `canary-window` (2026-10-24), `-a4`, `-a5`, `-c6` and `-b6` (expired 2026-11-17T08:00Z). They grant nothing now.

#### Verification (when applied)

- **The service:**
  - `gcloud run services get-iam-policy api-c5a-gate` lists exactly `deploy-smoke` and `console-run` as invokers;
  - an unauthenticated request answers 403 (Cloud Run's own page);
  - the serving revision's environment, read from the revision (Step 27's method), carries `COMMANDS_L0013=on`, `COMMAND_SCOPES=on` and `COMPILE_GENERATION_L0013=c5a-gate-1`, and no `SWEEP_*`.
- **The window:** `gcloud iam service-accounts get-iam-policy` on `console-run@graffiticode-app` and on `api-run@graffiticode` shows `canary-window-c5a` with its expiry. After expiry, minting fails.
- **Production unchanged:** the production api's serving revision has no `COMMANDS_L0013` or `COMMAND_SCOPES`, and the production canary still passes 36/36.

**Retirement, after the gate:**
- delete `api-c5a-gate` and its `deploy.json` entry, and the gate bucket (Step 28);
- the window expires.

**Retired 2026-11-18,** after the gate passed 20/20 (run `r36074e`) and its evidence merged (#424, `docs/evidence/c5a-authorization/`):
- **`api-c5a-gate` deleted** at 22:59:51Z, with its two revisions and its invokers (`console-run`, `deploy-smoke`). Its `deploy.json` entry is removed.
- **`gs://graffiticode-c5a-gate` deleted** at 23:00:02Z, with its two objects; Broker's `objectUser` there went with it. Both objects were first checked byte for byte against the archived images.
- **Production unchanged:**
  - canary `canary-9jqm2` passed 36/36;
  - the production api, `api-rmwkxlbvy-b5fa92`, still has no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`.
- **Kept:** the command staging bucket, and the C5a releases' permanent IAM and proxy configuration.
- **Broker's `THUMBNAIL_BUCKET`** still names the deleted gate bucket. Nothing publishes there while production admits no v3 capture command, and C5b switches it before any activation.
- **`canary-window-c5a`** is left to expire on its condition at 2026-11-19T03:57:32Z, unextended.
- **Record:** `docs/evidence/c5a-authorization/retirement/` (a snapshot before deletion and `verification.json`).

### Step 30: the thumbnails bucket (C5b) [LIVE 2026-11-19]

C5b slice 2 ([`docs/c5b-thumbnails-bucket-plan.md`](c5b-thumbnails-bucket-plan.md)): Broker's production thumbnail bucket. Nothing reads or writes it until C5d. Production admits no v3 capture command (no `COMMANDS_L0013` or `COMMAND_SCOPES`), `l0013r` keeps uploading to `graffiticode.appspot.com`, and the console keeps reading there. Checked 2026-11-18: `gs://graffiticode-thumbnails` answers 404, and org policy allows a public bucket (`iam.allowedPolicyMemberDomains` allows all; `storage.publicAccessPrevention` isn't enforced for the project).

```bash
gcloud storage buckets create gs://graffiticode-thumbnails --project=graffiticode \
  --location=US --default-storage-class=STANDARD \
  --uniform-bucket-level-access --no-public-access-prevention \
  --soft-delete-duration=7d

# The bindings: one etag-protected read/modify/write (Step 28: remove-iam-policy-binding
# doesn't match creation's convenience members). The edit is scripts/c5b/bucket-policy.js:
# it removes projectEditor and projectViewer and merges the two grants into their roles'
# bindings, never a duplicate, idempotent; the etag is kept, so a concurrent change fails.
gcloud storage buckets get-iam-policy gs://graffiticode-thumbnails --format=json > policy-at-creation.json
node scripts/c5b/bucket-policy.js edit policy-at-creation.json > policy-intended.json
gcloud storage buckets set-iam-policy gs://graffiticode-thumbnails policy-intended.json
gcloud storage buckets get-iam-policy gs://graffiticode-thumbnails --format=json > policy-after.json
node scripts/c5b/bucket-policy.js check policy-after.json   # exits 1 unless exactly the four bindings below
```

**What it sets:**
- **Location** `US` (multi-region, as the old bucket), `STANDARD`.
- **Access:** uniform bucket-level access, with public access prevention `inherited`. Public read needs it off for this bucket.
- **No versioning:** the generation precondition is the protocol.
- **Soft delete** of 7 days.
- **No lifecycle rule.**
- **Bindings, exactly:**
  - `roles/storage.legacyBucketOwner` and `roles/storage.legacyObjectOwner`: `projectOwner:graffiticode`;
  - `roles/storage.objectUser`: `serviceAccount:broker-run@…`. Broker reads `{item}.png`'s generation and metadata and writes under `ifGenerationMatch`; replacing a live object needs `objects.delete`. `objectCreator` can't overwrite, and `objectAdmin` would add IAM changes it doesn't need;
  - `roles/storage.legacyObjectReader`: `allUsers`. That is object reads only, so the bucket can't be listed anonymously (C5b decision 1). It is **not** `objectViewer`, which includes `storage.objects.list`.
- **No compiler account** has any role on this bucket, now or later (C5c).

#### Verification

1. **Settings, read back:** `US`, `STANDARD`, `uniform_bucket_level_access: true`, `public_access_prevention: "inherited"`, versioning off or null, soft delete `"604800"`, lifecycle `null`.
2. **IAM, read back:** `bucket-policy.js check` passes. The three policies (at creation, intended, after) go to the evidence.
3. **Behaviour.** One-off Cloud Run jobs, each needing approval and deleted after its results are recorded, run [`scripts/c5b/bucket-probe.js`](../scripts/c5b/bucket-probe.js) as the identity under test. The anonymous checks run from the operator's machine with no credentials. Order and expectations, at one run label:

   | As | Check | Expect |
   |---|---|---|
   | `broker-run` | `a-create`, `a-metadata`, `a-stale`, `a-overwrite` | 200, 200, 412, 200 |
   | | `b-create`, `b-delete` | 200, 204 |
   | | `staging-create` | 403 |
   | `policy-run` | `create` | 403 |
   | `l0013r-run` | `create` | 403 |
   | anonymous | `a-read`, `b-read` | 200, 404 |
   | | `list-json`, `list-xml` | 401 or 403 |

4. **Cleanup:** after the anonymous checks, the operator removes `c5b-probe/<run>/a.png` explicitly (`gcloud storage rm`). The bucket then lists no objects. The probe output, without tokens, goes to `docs/evidence/c5b/step30/`.

**Rollback:** `gcloud storage rm -r gs://graffiticode-thumbnails`. Before slice 3's copy it is empty, and nothing reads it until C5d.

**Applied 2026-11-19 (owner-approved).** Evidence: [`docs/evidence/c5b/step30/`](evidence/c5b/step30/).
1. **Created** at 01:04:57Z from main `02c85d4f`. The settings read back exactly as expected.
2. **IAM:** written under etag `CAE=`, read back at `CAI=`. `bucket-policy.js check` reported `same: true`, with no conditions: exactly the four bindings above.
3. **Probes** at `r11190108`, all as expected:
   - `broker-run`: 200, 200, 412, 200, 200, 204, 403;
   - `policy-run` and `l0013r-run`: 403;
   - anonymous: `a-read` 200, `b-read` 404, `list-json` 401, `list-xml` 403.
4. **Cleanup:**
   - `a.png` was removed and the bucket has 0 objects. Three probe generations remain soft-deleted until 2026-11-26: the log's "8" is annotated to 3, with the raw inventory.
   - The jobs were deleted.
   - A cached anonymous 200 for the deleted probe object came from the public default `max-age=3600`. The bucket answered 404.

### Step 31: Broker's thumbnail bucket (C5b) [LIVE 2026-11-19]

C5b slice 4: Broker's `THUMBNAIL_BUCKET` goes from `graffiticode-c5a-gate`, deleted with the gate, to `graffiticode-thumbnails`. It comes after Step 30 and the migration copy.

1. **A reviewed PR** changes only broker's `THUMBNAIL_BUCKET` in `deploy.json`.
2. **Broker is released from its merge commit** with the deploy CLI (`npm run deploy -- broker`). The `C5a-scopes` floor and `contractMinimum` are unaffected.
   - Broker's startup refuses only the forbidden names: a thumbnail bucket equal to the staging bucket, or `graffiticode.appspot.com`. It doesn't catch other typos or check that the bucket exists.
   - The reviewed diff and the read-back below confirm the value.

**Verification:**
- **The release:** the serving revision's environment shows `THUMBNAIL_BUCKET=graffiticode-thumbnails` (read back); `release-check broker` passes; the receipt names the merge commit.
- **The rollback target is recorded first:** `npm run rollback -- broker --env production --release <this release's id> --plan` is run before the release is considered done, and its target revision is recorded (today `broker-rmwkzsw86-98e2cf`).
- **The production canary** passes 36/36.
- **Production unchanged:** no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`. Nothing publishes until C5d, whose staged drive first exercises Broker's publish path here. Step 30's `broker-run` probe has already shown the same calls.

**Rollback:** `npm run rollback -- broker --env production --release <this release's id>`. It names this release's own receipt; the CLI refuses a release that doesn't own current traffic.
- It restores the revision that names the deleted gate bucket.
- That's harmless only while production admits no capture: a publish there would fail, and nothing publishes.
- After C5d starts, roll forward with a config release instead.

**Applied 2026-11-19 (owner-approved).** Evidence: [`docs/evidence/c5b/step31/`](evidence/c5b/step31/).
1. **Released** `broker-rmwnqz13k-c374b1` (release `rmwnqz13k-c374b1`) from the merge commit `86e8e4ed` (#433), `dirty: false`. It replaced `broker-rmwkzsw86-98e2cf`, whose tag was retired.
2. **Read back:** 100% traffic. `THUMBNAIL_BUCKET=graffiticode-thumbnails`; `COMMAND_STAGING_BUCKET` and `BROKER_MIN_CONTRACT_VERSION=2` are unchanged. The revision is Ready, with commit label `86e8e4ed`.
3. **`release-check broker`:** `ok`.
4. **Rollback plan:** `rollback --release rmwnqz13k-c374b1 --plan` restores `broker-rmwkzsw86-98e2cf` at 100%.
5. **Production canary:** `canary-bpd85` passed 36/36.
6. **Production unchanged:** no `COMMANDS_L0013`, `COMMAND_SCOPES` or `INTERPRETER_L0013`. The bucket holds the 33 migrated thumbnails. The service description is committed only in redacted form (`REDACTIONS.txt`).

## 4. Verification (read-only)

| After step | Check | Expected |
|---|---|---|
| 1 | `gcloud iam service-accounts list --project $P --filter='email~-run@'` | one per service |
| 2 | `gcloud iam service-accounts get-iam-policy $(sa l0176) --project $P` | `$LEGACY_BUILD_SA` has `serviceAccountUser` |
| 2 | `gcloud iam service-accounts get-iam-policy $(sa policy) --project $P` | the deployer has `serviceAccountUser`; **`$BUILD_SA` does not** |
| 2 (negative) | `gcloud projects get-iam-policy $P --flatten=bindings --filter="bindings.members:$BUILD_SA" --format='value(bindings.role)'` | no `run.*`, `iam.*` or `secretmanager.*` role |
| 3/4 | `gcloud projects get-iam-policy $P --flatten=bindings --filter="bindings.members:$(sa policy)" --format='table(bindings.role,bindings.condition.expression)'` | `datastore.user` only, condition on `databases/policy` |
| 4 | `gcloud firestore databases list --project $P` | `(default)`, `policy`, `broker` |
| 4 (matrix) | Document-level reads and writes against each **actual** database, as each SA (tester holds `serviceAccountTokenCreator` on the SA). Use the REST API with an impersonated access token: `TOKEN=$(gcloud auth print-access-token --impersonate-service-account $(sa policy))`, then `curl -H "Authorization: Bearer $TOKEN" https://firestore.googleapis.com/v1/projects/$P/databases/<db>/documents/iam-probe/doc1` (GET), `POST .../documents/iam-probe?documentId=<id>` (create), `PATCH .../documents/iam-probe/doc1` (update), `DELETE` (delete). Repeat for `broker-run` and one compiler SA, across `(default)`, `policy`, `broker`. | `policy-run`: allowed on `policy` only; `broker-run`: allowed on `broker` only (and per the receipt role, create allowed, update/delete denied if a create-only role is used); compiler SA: denied on `policy` and `broker`. An index-list denial is **not** evidence of document isolation. Delete the probe docs afterwards. |
| 5 | `gcloud secrets get-iam-policy BROKER_SECRET_KEY --project $P` | **only** `broker-run` as `secretAccessor` |
| 5 | `gcloud secrets versions list BROKER_SECRET_KEY --project $P` | empty until provisioning |
| 5 | `for s in policy-callers broker-callers audit-pseudonym-secret; do gcloud secrets get-iam-policy $s --project $P; done` | `policy-callers`: only `policy-run`; `broker-callers`: only `broker-run`; `audit-pseudonym-secret`: only those two |
| 5 | `gcloud kms keys get-iam-policy token-signing --keyring policy --location $R --project $P` | `signer` only for `policy-run`; `publicKeyViewer` for `policy-run`, `broker-run` |
| 5 (negative) | `gcloud projects get-iam-policy $P --flatten=bindings --filter='bindings.role:(roles/secretmanager.secretAccessor OR roles/secretmanager.admin OR roles/cloudkms.admin OR roles/editor OR roles/owner) AND bindings.members:serviceAccount'` | no compiler SA, and after step 9 no default SA |
| 6 | `gcloud run services list … --format='table(metadata.name,spec.template.spec.serviceAccountName)'` | no row shows `-compute@` |
| 7 | `gcloud run services get-iam-policy broker --project $P --region $R` | `run.invoker` = the `$PROTECTED` SAs and `policy-run` only; **no `allUsers`/`allAuthenticatedUsers`** |
| 7 (negative) | `curl -s -o /dev/null -w '%{http_code}' $(gcloud run services describe broker --project $P --region $R --format='value(status.url)')` | `403` (no token) |
| 7 (negative) | `curl … -H "Authorization: Bearer $(gcloud auth print-identity-token --impersonate-service-account $(sa l0000) --audiences <broker-url>)"` | `403` (not an invoker) |
| 7 (positive) | same with `$(sa l0176)` | `200` from the hello placeholder |
| 3.1 (unchanged) | `curl -sI https://l0176.graffiticode.org/lexicon.json`, and `/form` | `200`, still public |
| 8 | `gcloud secrets get-iam-policy GRAFFITICODE_SECRET_KEY --project $P` | no `-compute@` member |
| 9 | `gcloud projects get-iam-policy $P --flatten=bindings --filter='bindings.role:roles/editor'` | humans or groups only |
| 9 | `gcloud projects get-iam-policy $P --flatten=bindings --filter="bindings.members:$COMPUTE_SA" --format='value(bindings.role)'` | empty |
| 10 | `npm run deploy -- policy` output and `.gc-deploy/releases/<id>.json` | candidate checks pass (`/`, `/v1/jwks`); status `released` |
| 12 | `for s in act-as-callers act-as-grant-secret; do gcloud secrets get-iam-policy $s --project $P; done` | only `auth-run` as `secretAccessor` |
| 12 | `gcloud secrets get-iam-policy ACT_AS_GRANT_SECRET --project graffiticode-app` | exactly `console-run@`, `mcp-run@`, `openapi-run@` (the producers that sign) |
| 12 | `gcloud secrets versions access latest --secret act-as-callers --project $P` | names `console-run@graffiticode-app` only (the one service that exchanges grants) |
| 12 (negative) | `curl -s -o /dev/null -w '%{http_code}' -X POST https://auth.graffiticode.org/internal/act-as -H "X-Internal-API-Key: …"` | `401`, and a `security_audit` line with `reason: caller-rejected` |
| 12 (negative) | same with `X-Caller-Identity: $(gcloud auth print-identity-token --impersonate-service-account mcp-run@graffiticode-app.iam.gserviceaccount.com --audiences urn:graffiticode:auth --include-email)` | `403` (not an allowed caller) |
| 12 (positive, canary window) | as `console-run@`, with a grant signed for a test uid | `200`; the token verifies at `/oauth/verify` as that uid |

---

## 5. Open questions

1. **Live state.** Re-run §1.4. In particular: is the compute SA on Editor? Which services mount
   `GRAFFITICODE_SECRET_KEY`? Does `graffiticode-auth` (from `packages/auth/cloudbuild.yaml`) still
   exist? Is there an App Engine app?
2. **Resolved 2026-09-28:** the console runs as the dedicated
   `console-run@graffiticode-app.iam.gserviceaccount.com`, which holds invoker on `policy`.
   Original question: **Console runtime SA** in `graffiticode-app`. Is it the default compute SA of that project? If so,
   give the console a dedicated SA before granting it cross-project invoker on `policy`, because
   otherwise every workload in `graffiticode-app` could call policy.
3. **Caller identity inside policy.** Cloud Run strips the signature from the forwarded
   `X-Serverless-Authorization` and, when both authorization headers are present, checks
   `X-Serverless-Authorization` (Cloud Run service-to-service docs). Policy therefore takes the
   caller only from the separately verified `X-Caller-Identity` token (Step 7) and the end user
   only from `Authorization`. Staging must verify the *application's* handling of that behaviour:
   that the user token in `Authorization` reaches policy intact alongside a stripped
   `X-Serverless-Authorization`, and that the stripped header's `email` matches the verified caller.
4. **Custom domains vs `run.app`.** Are `lNNNN.graffiticode.org` / `api.graffiticode.org` Cloudflare-
   proxied (console's own domain is)? ID-token audiences must match the URL called; use `run.app`
   URLs for service-to-service calls or set `--add-custom-audiences`. The Cloudflare ~100s timeout
   also applies to any long broker operation called through the proxy.
5. ~~**Does `api` need policy in Phase 1?**~~ **Resolved: yes.** The code on `policy-service` has
   `api` allocate an invocation (and read publications) through policy for every compile that uses a
   connection, under the `gateway` role. `api-run` therefore needs `run.invoker` on `policy` (Step 7)
   and a `gateway` entry in `policy-callers` (Step 5). The snapshot fetch still happens in the
   compiler, as the spec says.
6. **Direct compiler access.** Compilers remain public, so anyone can POST `/compile` directly with
   their own user token. That is safe only if policy authorizes solely from the verified end-user
   token and broker solely from the policy token. The spec also leaves open **cached compiled output
   and public task reads** of protected results.
7. **Compiler egress.** Nothing stops a compiler from calling Learnosity directly with a key it
   already holds. The boundary only holds once `learnosity-secret` and the parse-time credentials in
   ASTs are removed from compilers. Plan that cut-over and `GRAFFITICODE_SECRET_KEY`'s role in it.
   **Credentials done (2026-10-15):** no compiler holds or can read a provider credential. The
   parse-time credentials were retired 2026-10-02/03; L0176 signs only through Broker;
   L0158 now renders through L0176 (graffiticode #101, #102, #103; l0158 #1), and both shared
   secrets are retired. Egress enforcement (below) is deployed, and ISOLATE-01 closed on 2026-10-20.
   Sharing the `GRAFFITICODE_SECRET_KEY` keyring with every compiler means compilers can decrypt
   console-encrypted secrets, and broker's `BROKER_SECRET_KEY` must not reuse it.

   **ISOLATE-01, deployed and closed 2026-10-20 with recorded residuals (step 1 on 2026-10-18; compilers moved 2026-10-19/20; the legacy compilers in the D6 wave, 2026-10-20).** The plan is
   `~/.claude/plans/isolate-01-compiler-egress.md`, and the runbook is
   `deploy/egress-proxy/README.md`. In place:
   - **Network:** the `compilers` VPC, with the subnets `egress-proxy` (10.8.0.0/27) and five
     classes: `compilers-default`, `compilers-l0000`, `compilers-l0176`, `compilers-l0013` and
     `compilers-l0185`.
   - **Firewall:** the network firewall policy `compilers-egress`. Compilers may reach only the
     proxy's internal load balancer (`10.8.0.2:3128`); DNS other than the metadata server's is
     denied, and so is everything else.
   - **DNS and NAT:** the private root zone (only `metadata.google.internal`), and Cloud NAT for
     the proxy subnet only, with 4096 ports per VM and a 10 s UDP timeout (since 2026-10-20; the
     defaults ran out under Envoy's DNS refreshes).
   - **The proxy account** `egress-proxy@graffiticode.iam.gserviceaccount.com` has:
     - `secretAccessor` on the `egress-proxy-cert-<host>` secrets only, one per terminated host
       (48 on 2026-10-20);
     - `roles/logging.logWriter` and `roles/monitoring.metricWriter`, for COS's logging agent.

     Envoy's UID can't reach metadata, so it holds no credential.
   - **The CA bundle:** `egress-proxy-ca-bundle` (the public CA certificate only) is readable
     by each of the 62 compiler runtime accounts: the 36 in `deploy.json` (`lNNNN-run`,
     `lNNNNr-run`) and the 26 legacy ones (62 members, checked 2026-10-21). That's the only grant
     ISOLATE-01 adds to them.
   - **The proxy itself:** the two-VM group `egress-proxy`, on template
     `egress-proxy-0cfb77e009f1`, config `1aa650b0` (2026-10-20: DNS clusters that follow the
     TTL, one retry decided host by host, and an access log without queries).

   **Allow lists, as reviewed in the step 3 inventory** (`deploy.json` `network.allow`):
   - `compilers-default` (14 TypeScript languages and 16 Rust `*r` services): `api` and `auth`
     only.
   - `compilers-l0000`: `api` and `auth`, Policy's `run.app` host and `www.googleapis.com` (the
     `PREFLIGHT_GATEWAYS` key fetch).
   - `compilers-l0176`: the same, plus Broker's `run.app` host.
   - `compilers-l0013` (L0013, `l0013r`): `api`, `auth`, `storage.googleapis.com` (thumbnail
     uploads), `app.graffiticode.org` (item resolve) and the 41 `lNNNN.graffiticode.org`
     language hosts (Chrome renders an item's form on its language's host). Each is an exact
     host, not a wildcard.
   - `compilers-l0185` (L0185, `l0185r`): `api` and `auth` terminated, and public hosts through
     the open route (D2). Since Step 23, also `GET https://www.googleapis.com/oauth2/v3/certs`
     and nothing else on that host (the open class's one exception).

   Each compiler's evidence is in `.gc-deploy/inventory/<service>-<release>.json`.

   **Exceptions:**
   - **D2:** L0185's open fetches, and since 2026-10-20 those of the legacy l0137 and l0170
     (Jeff). Learnosity, `run.app`, `googleapis.com` and `internal` names are refused by name;
     IP literals and internal addresses are refused too. The residual: they can exfiltrate
     content they compile to a public host.
   - **D6 ended on 2026-10-20** (the D6 wave). The 26 legacy compilers outside `deploy.json`
     are on the proxy.
     - **Placement:** `deploy/egress-proxy/production/network.json` marks them `legacy`. l0137 and
       l0170 are in `compilers-l0185`; the other 24 are in `compilers-default`, with api and
       auth only.
     - **Checks:** `scripts/legacy-network-check.js` checks every reachable revision, and refuses
       `LEARNOSITY_*` on l0158 and l0160. Each repo's production deploy step carries the
       controls, with `--update-env-vars` (graffiticode/l0002#1, l0158#2, and `#1` in the other
       24).
     - **New grant:** `656973052505@cloudbuild` (the legacy Cloud Build account) holds
       `roles/compute.networkUser` on the `compilers-default` and `compilers-l0185` subnets only,
       so it can deploy them.
     - **AT-11:** passed for all 26 (run `eec4a66d71d25450`).

   D1 (L0158's preview-only consumer) was superseded on 2026-10-15: L0158 holds no credential.

   **Retired 2026-10-19/20:**
   - every unproxied reachable compiler revision (step 5);
   - `l0158-run`'s `run.invoker` on Policy and Broker;
   - `learnosity-secret` (deleted 2026-10-18).

   L0176's `forbiddenEnv` refuses `LEARNOSITY_KEY` and `LEARNOSITY_SECRET`.

   **Accepted residual (Jeff, 2026-10-20):** the retired shared Learnosity consumer is still
   accepted by Learnosity. It's a developer sandbox's primary key, and it reaches only that
   development item bank, which never affects student-facing items.

8. **`auth` private keys in Firestore `(default)`.** Move them to KMS or Secret Manager (a separate
   project) so `api-run`'s `(default)` access does not include the ability to mint auth tokens.
9. **Receipts integrity.** Is Firestore-in-`broker`-DB enough, or do receipts also need a
   retention-locked GCS bucket or a log sink?
10. **Staging services and per-language SAs.** Do staging revisions share production SAs? Recommended:
    no, use `lNNNN-stg-run`.

11. **The AT-11 collector has no DNS log or control (found 2026-11-17, Step 26).** `collect.js` reads the authoritative query log for `at11.graffiticode.org` and runs the control job `at11-iam-control`. Both were in `graffiticode-isolate01`, which is now `DELETE_REQUESTED`, so no collector verdict can be produced (`dns-exfil` stays `pending-log` and every run is void without the control). Step 26 went ahead under a scoped owner exception that covers only that Envoy-only rollout. **Before any future DNS-control change** (the compilers' resolver policy, the `compilers-root` zone, or the DNS firewall rules), restore both in `graffiticode`: an authoritative zone for the probe domain with query logging, and the control's canary resources. Then update `collect.json`'s `controlProject` and `dnsLog`, and run the full collector.
