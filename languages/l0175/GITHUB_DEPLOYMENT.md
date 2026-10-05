# GitHub Automated Deployment Setup

This guide explains how to set up automatic deployment from GitHub to Google Cloud Platform (GCP) using either Cloud Build triggers or GitHub Actions.

## Option 1: Cloud Build Triggers (Recommended)

Cloud Build triggers automatically deploy your code when you push to GitHub.

### Step 1: Connect GitHub to Cloud Build

1. Go to the [Cloud Build Triggers page](https://console.cloud.google.com/cloud-build/triggers) in GCP Console
2. Click "Connect Repository"
3. Select "GitHub" as the source
4. Authenticate with GitHub and grant permissions
5. Select your repository: `graffiticode/l0175`
6. Click "Connect"

### Step 2: Create Triggers

#### Production Trigger (Main Branch)

1. Click "Create Trigger"
2. Configure:
   - **Name**: `l0175-production-deploy`
   - **Description**: Deploy L0175 to production on main branch push
   - **Event**: Push to a branch
   - **Source**:
     - Repository: Your connected repo
     - Branch: `^main$`
   - **Configuration**: Cloud Build configuration file
   - **Location**: `/cloudbuild.production.yaml`
   - **Substitution variables** (click "Add Variable"):
     - `_DEPLOY_REGION`: `us-central1`
     - `_AUTH_URL`: `https://auth.graffiticode.org`
     - `_MIN_INSTANCES`: `1`
     - `_MAX_INSTANCES`: `100`
     - `_MEMORY`: `512Mi`

3. Click "Create"

#### Staging Trigger (Develop/Feature Branches)

1. Click "Create Trigger"
2. Configure:
   - **Name**: `l0175-staging-deploy`
   - **Description**: Deploy L0175 staging on branch push
   - **Event**: Push to a branch
   - **Source**:
     - Repository: Your connected repo
     - Branch: `^develop$|^feature/.*$`
   - **Configuration**: Cloud Build configuration file
   - **Location**: `/cloudbuild.staging.yaml`
   - **Substitution variables**:
     - `_DEPLOY_REGION`: `us-central1`
     - `_AUTH_URL`: `https://auth.graffiticode.org`

3. Click "Create"

#### Pull Request Trigger (Optional)

1. Click "Create Trigger"
2. Configure:
   - **Name**: `l0175-pr-preview`
   - **Description**: Deploy preview for pull requests
   - **Event**: Pull request
   - **Configuration**: Cloud Build configuration file
   - **Location**: `/cloudbuild.staging.yaml`
   - **Comment control**: Required (only builds when someone comments `/gcbrun`)

3. Click "Create"

### Step 3: Grant Permissions

Cloud Build needs permissions to deploy to Cloud Run:

```bash
# Get the Cloud Build service account
PROJECT_ID=$(gcloud config get-value project)
BUILD_ACCOUNT="${PROJECT_ID}@cloudbuild.gserviceaccount.com"

# Grant Cloud Run Admin role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${BUILD_ACCOUNT}" \
  --role="roles/run.admin"

# Grant Service Account User role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${BUILD_ACCOUNT}" \
  --role="roles/iam.serviceAccountUser"
```

### Step 4: Test the Trigger

```bash
# Make a change and push to trigger deployment
git add .
git commit -m "Test automated deployment"
git push origin main
```

Monitor the build in the [Cloud Build History](https://console.cloud.google.com/cloud-build/builds) page.

## Option 2: GitHub Actions

GitHub Actions provides an alternative CI/CD solution that runs entirely on GitHub.

### Step 1: Create Service Account

1. Create a service account for GitHub Actions:

```bash
PROJECT_ID=$(gcloud config get-value project)

# Create service account
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions Deploy"

# Grant necessary roles
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

### Step 2: Create Service Account Key

```bash
# Create and download key
gcloud iam service-accounts keys create key.json \
  --iam-account=github-actions@${PROJECT_ID}.iam.gserviceaccount.com

# Copy the content of key.json
cat key.json

# IMPORTANT: Delete the local key file after copying
rm key.json
```

### Step 3: Add GitHub Secrets

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Add the following secrets:

   - **GCP_PROJECT_ID**: Your GCP project ID
   - **GCP_SA_KEY**: The entire JSON key content from Step 2
   - **AUTH_URL**: `https://auth.graffiticode.org` (optional, has default)

### Step 4: Enable the Workflow

The workflow file is already created at `.github/workflows/deploy-gcp.yml`. It will:

- Deploy to production when pushing to `main`
- Deploy to staging when pushing to `develop`
- Create preview deployments for feature branches
- Clean up preview deployments when PRs are closed

### Step 5: Test GitHub Actions

```bash
# Push to main to trigger production deployment
git add .
git commit -m "Test GitHub Actions deployment"
git push origin main
```

Monitor the deployment in the "Actions" tab of your GitHub repository.

## Option 3: Workload Identity Federation (More Secure)

Instead of using service account keys, use Workload Identity Federation for keyless authentication:

### Step 1: Enable APIs

```bash
gcloud services enable iamcredentials.googleapis.com
```

### Step 2: Create Workload Identity Pool

```bash
PROJECT_ID=$(gcloud config get-value project)
GITHUB_REPO="graffiticode/l0175"

# Create pool
gcloud iam workload-identity-pools create "github" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create provider
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github" \
  --display-name="GitHub provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

### Step 3: Create Service Account and Bind

```bash
# Create service account
gcloud iam service-accounts create github-wif \
  --display-name="GitHub WIF Service Account"

# Bind to workload identity
gcloud iam service-accounts add-iam-policy-binding \
  "github-wif@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}"

# Grant Cloud Run permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-wif@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"
```

### Step 4: Update GitHub Actions

In `.github/workflows/deploy-gcp.yml`, update the auth step:

```yaml
- name: Google Auth
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-provider
    service_account: github-wif@PROJECT_ID.iam.gserviceaccount.com
```

## Deployment Environments

### Production (main branch)
- URL: https://l0175-[hash]-uc.a.run.app
- Full traffic routing
- Minimum instances: 1
- Maximum instances: 100
- Memory: 512Mi

### Staging (develop branch)
- URL: https://l0175-staging-[hash]-uc.a.run.app
- Full traffic routing
- Maximum instances: 10
- Memory: 256Mi

### Preview (feature branches)
- URL: https://l0175-[branch-name]-[hash]-uc.a.run.app
- Temporary deployments
- Auto-cleanup on PR close
- Maximum instances: 5
- Memory: 256Mi

## Monitoring Deployments

### Cloud Build
- [Build History](https://console.cloud.google.com/cloud-build/builds)
- [Build Triggers](https://console.cloud.google.com/cloud-build/triggers)

### GitHub Actions
- Repository → Actions tab
- Each workflow run shows logs and status

### Cloud Run
- [Services List](https://console.cloud.google.com/run)
- Click on service for metrics, logs, and revisions

## Rollback Strategy

### Using Cloud Console
1. Go to [Cloud Run](https://console.cloud.google.com/run)
2. Click on your service
3. Go to "Revisions" tab
4. Select previous revision
5. Click "Manage Traffic"
6. Route 100% to previous revision

### Using CLI
```bash
# List revisions
gcloud run revisions list --service=l0175 --region=us-central1

# Route traffic to specific revision
gcloud run services update-traffic l0175 \
  --to-revisions=l0175-00005-abc=100 \
  --region=us-central1
```

## Troubleshooting

### Build Fails
1. Check [Cloud Build logs](https://console.cloud.google.com/cloud-build/builds)
2. Common issues:
   - Missing npm packages
   - Build script errors
   - Docker build failures

### Deployment Fails
1. Check service account permissions
2. Verify environment variables
3. Check Cloud Run quotas

### Service Not Accessible
1. Verify `--allow-unauthenticated` flag
2. Check Cloud Run service URL
3. Verify port configuration (50175)

## Cost Optimization

1. **Use minimum instances = 0** for staging/preview
2. **Set concurrency limits** to control scaling
3. **Use Cloud Build triggers** instead of GitHub Actions to save on GitHub minutes
4. **Clean up preview deployments** automatically

## Security Best Practices

1. **Use Workload Identity Federation** instead of service account keys
2. **Separate production and staging** projects if possible
3. **Use Secret Manager** for sensitive environment variables
4. **Enable Cloud Audit Logs** for deployment tracking
5. **Restrict branch protection** on main branch
6. **Require PR reviews** before deploying to production