# Capability policy — Phase 1 IAM & data-boundary review

> **Status:** review only, 2026-09-25. Nothing in this document has been applied.
> Scope: GCP project `graffiticode` (us-central1) — `auth`, `api`, compilers `l0NNN`,
> and the planned `policy` and `broker` services. Design context:
> `console/docs/graffiticode_capability_policy_spec.md`.

**Evidence legend:** **[LIVE]** = read from GCP with a read-only command. **[REPO]** = read from a
repo file (path given). **[UNVERIFIED]** = inferred or a GCP default. Needs confirming with the
§1.4 commands before any step in §3 runs.

**Live read status:** none. `gcloud` on the reviewer's machine is logged in as
`jeff@artcompiler.com`, but every call failed with `Reauthentication failed. cannot prompt during
non-interactive execution`. **Every fact below is [REPO] or [UNVERIFIED].** §1.4 lists the exact
read-only commands that turn each one into [LIVE]. Run them first.

---

## 1. Current state

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
| `api-run` | ✗ (not needed in Phase 1; see §5) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✓ `datastore.user` conditioned to `(default)` | ✗ |
| `auth-run` | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✓ conditioned to `(default)`, plus `tokenCreator` on itself | ✗ |
| `policy-run` | — | ✗ | ✓ public | ✓ `cloudkms.signer` + `publicKeyViewer` on the key only | ✗ | ✓ `datastore.user` conditioned to `policy` | ✗ | ✗ (identity comes from verifying the auth token via `auth`, not from reading auth's data) | ✗ |
| `broker-run` | ✗ (it fetches the public key from KMS directly) | — | ✗ | ✓ `publicKeyViewer` only (verifies, cannot sign) | ✓ `secretAccessor` | ✗ | ✓ `datastore.user` conditioned to `broker` | ✗ | ✓ `secretAccessor` |
| `l0176-run`, `l0158-run` (protected-function compilers) | ✓ `run.invoker` | ✓ `run.invoker` | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ after cut-over. Until then, `learnosity-secret` (legacy) stays |
| other `lNNNN-run` | ✗ (add when a language gains a protected function) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `l0013-run` | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗. Separately: `storage.objectCreator` on bucket `graffiticode.appspot.com` |
| Console runtime SA (project `graffiticode-app`) | ✓ `run.invoker` (cross-project; see §3 step 7) | ✗ | ✓ public | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Default compute SA | ✗ | ✗ | ✓ public | ✗ | ✗ | ✗ after Editor removal | ✗ after Editor removal | ✗ after Editor removal | ✗ |
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
BUILD_SA=${PN}@cloudbuild.gserviceaccount.com        # confirm via §1.4 `gcloud builds list`
CONSOLE_SA=<console runtime SA in graffiticode-app>   # open question §5
LANGS="l0000 l0002 l0003 l0010 l0011 l0012 l0013 l0014 l0154 l0158 l0159 l0166 l0169 l0170 l0172 l0173 l0174 l0176 l0177 l0178 l0179 l0180 l0181 l0182 l0183"
PROTECTED="l0176 l0158"                               # compilers with broker-backed functions
sa() { echo "$1-run@$P.iam.gserviceaccount.com"; }
```

### 3.1 Compilers stay public in Phase 1 (do not add `--no-allow-unauthenticated`)

Browsers and third parties load compiler URLs directly [REPO]:
- `express.static(STATIC_DIR)` is mounted **before auth** in `l0000/packages/api/src/app.ts` and
  `l0176/packages/api/src/app.ts`: `lexicon.json`, `/lexicon.js` alias, `schema.json`, `spec.html`,
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

```bash
for n in api auth policy broker $LANGS; do
  gcloud iam service-accounts add-iam-policy-binding $(sa $n) --project $P \
    --member serviceAccount:$BUILD_SA --role roles/iam.serviceAccountUser
  # repeat for each human deployer: --member user:<email>
done
```
Rollback: the same loop with `remove-iam-policy-binding`.

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
Then, in each repo, add `--service-account=<name>-run@graffiticode.iam.gserviceaccount.com` to
every `cloudbuild*.yaml` Deploy step and every `gcp:deploy` script. That is a separate, reviewed
change per repo and is not part of this review.

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
```

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

### Step 9: Strip Editor from default SAs. Gate: required before broker holds production credentials

```bash
gcloud projects remove-iam-policy-binding $P --member serviceAccount:$COMPUTE_SA --role roles/editor
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
2. Step 9 (Editor removed).
3. Only then add a version to `BROKER_SECRET_KEY` / `broker-learnosity-system`.

Rollback: `add-iam-policy-binding … --role roles/editor`, the same members.

---

## 4. Verification (read-only)

| After step | Check | Expected |
|---|---|---|
| 1 | `gcloud iam service-accounts list --project $P --filter='email~-run@'` | one per service |
| 2 | `gcloud iam service-accounts get-iam-policy $(sa l0176) --project $P` | `$BUILD_SA` has `serviceAccountUser` |
| 3/4 | `gcloud projects get-iam-policy $P --flatten=bindings --filter="bindings.members:$(sa policy)" --format='table(bindings.role,bindings.condition.expression)'` | `datastore.user` only, condition on `databases/policy` |
| 4 | `gcloud firestore databases list --project $P` | `(default)`, `policy`, `broker` |
| 4 (matrix) | Document-level reads and writes against each **actual** database, as each SA (tester holds `serviceAccountTokenCreator` on the SA). Use the REST API with an impersonated access token: `TOKEN=$(gcloud auth print-access-token --impersonate-service-account $(sa policy))`, then `curl -H "Authorization: Bearer $TOKEN" https://firestore.googleapis.com/v1/projects/$P/databases/<db>/documents/iam-probe/doc1` (GET), `POST .../documents/iam-probe?documentId=<id>` (create), `PATCH .../documents/iam-probe/doc1` (update), `DELETE` (delete). Repeat for `broker-run` and one compiler SA, across `(default)`, `policy`, `broker`. | `policy-run`: allowed on `policy` only; `broker-run`: allowed on `broker` only (and per the receipt role, create allowed, update/delete denied if a create-only role is used); compiler SA: denied on `policy` and `broker`. An index-list denial is **not** evidence of document isolation. Delete the probe docs afterwards. |
| 5 | `gcloud secrets get-iam-policy BROKER_SECRET_KEY --project $P` | **only** `broker-run` as `secretAccessor` |
| 5 | `gcloud secrets versions list BROKER_SECRET_KEY --project $P` | empty until provisioning |
| 5 | `gcloud kms keys get-iam-policy token-signing --keyring policy --location $R --project $P` | `signer` only for `policy-run`; `publicKeyViewer` for `policy-run`, `broker-run` |
| 5 (negative) | `gcloud projects get-iam-policy $P --flatten=bindings --filter='bindings.role:(roles/secretmanager.secretAccessor OR roles/secretmanager.admin OR roles/cloudkms.admin OR roles/editor OR roles/owner) AND bindings.members:serviceAccount'` | no compiler SA, and after step 9 no default SA |
| 6 | `gcloud run services list … --format='table(metadata.name,spec.template.spec.serviceAccountName)'` | no row shows `-compute@` |
| 7 | `gcloud run services get-iam-policy broker --project $P --region $R` | `run.invoker` = the `$PROTECTED` SAs only; **no `allUsers`/`allAuthenticatedUsers`** |
| 7 (negative) | `curl -s -o /dev/null -w '%{http_code}' $(gcloud run services describe broker --project $P --region $R --format='value(status.url)')` | `403` (no token) |
| 7 (negative) | `curl … -H "Authorization: Bearer $(gcloud auth print-identity-token --impersonate-service-account $(sa l0000) --audiences <broker-url>)"` | `403` (not an invoker) |
| 7 (positive) | same with `$(sa l0176)` | `200` from the hello placeholder |
| 3.1 (unchanged) | `curl -sI https://l0176.graffiticode.org/lexicon.json`, and `/form` | `200`, still public |
| 8 | `gcloud secrets get-iam-policy GRAFFITICODE_SECRET_KEY --project $P` | no `-compute@` member |
| 9 | `gcloud projects get-iam-policy $P --flatten=bindings --filter='bindings.role:roles/editor'` | humans or groups only |

---

## 5. Open questions

1. **Live state.** Re-run §1.4. In particular: is the compute SA on Editor? Which services mount
   `GRAFFITICODE_SECRET_KEY`? Does `graffiticode-auth` (from `packages/auth/cloudbuild.yaml`) still
   exist? Is there an App Engine app?
2. **Console runtime SA** in `graffiticode-app`. Is it the default compute SA of that project? If so,
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
5. **Does `api` need policy in Phase 1?** Only if `api` (not the compiler) must pre-validate the
   selected connection. The spec puts the snapshot fetch in the compiler, so the answer is presumed
   no.
6. **Direct compiler access.** Compilers remain public, so anyone can POST `/compile` directly with
   their own user token. That is safe only if policy authorizes solely from the verified end-user
   token and broker solely from the policy token. The spec also leaves open **cached compiled output
   and public task reads** of protected results.
7. **Compiler egress.** Nothing stops a compiler from calling Learnosity directly with a key it
   already holds. The boundary only holds once `learnosity-secret` and the parse-time credentials in
   ASTs are removed from compilers. Plan that cut-over and `GRAFFITICODE_SECRET_KEY`'s role in it.
   Sharing the `GRAFFITICODE_SECRET_KEY` keyring with every compiler means compilers can decrypt
   console-encrypted secrets, and broker's `BROKER_SECRET_KEY` must not reuse it.
8. **`auth` private keys in Firestore `(default)`.** Move them to KMS or Secret Manager (a separate
   project) so `api-run`'s `(default)` access does not include the ability to mint auth tokens.
9. **Receipts integrity.** Is Firestore-in-`broker`-DB enough, or do receipts also need a
   retention-locked GCS bucket or a log sink?
10. **Staging services and per-language SAs.** Do staging revisions share production SAs? Recommended:
    no, use `lNNNN-stg-run`.
