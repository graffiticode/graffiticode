# Deployment Guide

This application can be deployed to both Heroku and Google Cloud Platform (GCP).

## Google Cloud Platform (Cloud Run)

### Prerequisites

1. Install the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
2. Authenticate with GCP:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```
3. Enable required APIs:
   ```bash
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable run.googleapis.com
   gcloud services enable containerregistry.googleapis.com
   ```

### Deployment Methods

#### Method 1: Using Cloud Build (Recommended for CI/CD)

This method uses Cloud Build to build the Docker image and deploy to Cloud Run:

```bash
# Submit build to Cloud Build and deploy
npm run gcp:build
```

The `cloudbuild.yaml` configuration will:
1. Install dependencies
2. Build a Docker image
3. Push to Google Container Registry
4. Deploy to Cloud Run

#### Method 2: Direct Deployment from Source

Deploy directly from source code (Cloud Run will build the container):

```bash
npm run gcp:deploy
```

This command will:
- Build the container using the Dockerfile
- Deploy to Cloud Run in us-central1 region
- Make the service publicly accessible

#### Method 3: Manual Deployment

For more control over the deployment process:

```bash
# Build the Docker image locally
docker build -t gcr.io/YOUR_PROJECT_ID/l0175:latest .

# Push to Container Registry
docker push gcr.io/YOUR_PROJECT_ID/l0175:latest

# Deploy to Cloud Run
gcloud run deploy l0175 \
  --image gcr.io/YOUR_PROJECT_ID/l0175:latest \
  --platform managed \
  --region us-central1 \
  --port 50175 \
  --allow-unauthenticated \
  --set-env-vars AUTH_URL=https://auth.graffiticode.org
```

### Environment Variables

Configure environment variables in Cloud Run:

- `PORT`: Automatically set by Cloud Run (the app defaults to 50175)
- `AUTH_URL`: Authentication service URL (default: https://auth.graffiticode.org)
- `NODE_ENV`: Set to `production` in the Dockerfile

To update environment variables:

```bash
gcloud run services update l0175 \
  --region us-central1 \
  --set-env-vars AUTH_URL=https://your-auth-url.com
```

### Monitoring and Logs

View application logs:

```bash
npm run gcp:logs
```

Or use the GCP Console to monitor:
- Cloud Run: https://console.cloud.google.com/run
- Cloud Build: https://console.cloud.google.com/cloud-build
- Logs: https://console.cloud.google.com/logs

### Traffic Management

After deployment with `--no-traffic` flag in Cloud Build, you need to route traffic:

```bash
# Route 100% traffic to the latest revision
gcloud run services update-traffic l0175 \
  --region us-central1 \
  --to-latest

# Or gradually roll out (canary deployment)
gcloud run services update-traffic l0175 \
  --region us-central1 \
  --to-revisions REVISION_NAME=10
```

### Custom Domain

To map a custom domain:

```bash
gcloud run domain-mappings create \
  --service l0175 \
  --domain your-domain.com \
  --region us-central1
```

## Heroku Deployment

For Heroku deployment, the application uses the default Node.js buildpack:

1. Create a Heroku app:
   ```bash
   heroku create your-app-name
   ```

2. Deploy:
   ```bash
   git push heroku main
   ```

The application will use the `npm start` script defined in package.json.

## Build Configuration

### Dockerfile

The Dockerfile is configured for production deployment:
- Uses Node.js Alpine for smaller image size
- Installs only production dependencies
- Builds the application during image creation
- Exposes port 50175

### Cloud Build Configuration

The `cloudbuild.yaml` file defines the CI/CD pipeline:
- Installs dependencies
- Runs tests (when enabled)
- Builds and tags Docker image with commit SHA
- Deploys to Cloud Run with appropriate labels

### Files Excluded from Deployment

The `.gcloudignore` file excludes:
- Node modules (rebuilt in container)
- Test files
- Development configuration
- Documentation files
- Build artifacts

## Troubleshooting

### Common Issues

1. **Port Configuration**: Ensure the app uses `process.env.PORT` and falls back to 50175
2. **Memory Limits**: Cloud Run defaults to 256MB. Increase if needed:
   ```bash
   gcloud run services update l0175 --memory 512Mi --region us-central1
   ```
3. **Cold Starts**: Cloud Run may have cold starts. Consider minimum instances:
   ```bash
   gcloud run services update l0175 --min-instances 1 --region us-central1
   ```

### Rolling Back

To roll back to a previous revision:

```bash
# List revisions
gcloud run revisions list --service l0175 --region us-central1

# Route traffic to specific revision
gcloud run services update-traffic l0175 \
  --region us-central1 \
  --to-revisions REVISION_NAME=100
```