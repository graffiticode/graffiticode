#!/bin/bash

# Setup script for GCP automated deployment
# This script configures your GCP project for automated deployments

set -e

echo "🚀 L0175 GCP Deployment Setup"
echo "=============================="

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI is not installed. Please install it first:"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Get or set project ID
if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
    if [ -z "$PROJECT_ID" ]; then
        read -p "Enter your GCP Project ID: " PROJECT_ID
    fi
fi

echo "📦 Using project: $PROJECT_ID"
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "🔧 Enabling required APIs..."
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    containerregistry.googleapis.com \
    secretmanager.googleapis.com \
    iamcredentials.googleapis.com

# Get Cloud Build service account
BUILD_ACCOUNT="${PROJECT_ID}@cloudbuild.gserviceaccount.com"
echo "👤 Cloud Build service account: $BUILD_ACCOUNT"

# Grant permissions to Cloud Build
echo "🔐 Granting permissions to Cloud Build..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${BUILD_ACCOUNT}" \
    --role="roles/run.admin" \
    --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${BUILD_ACCOUNT}" \
    --role="roles/iam.serviceAccountUser" \
    --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${BUILD_ACCOUNT}" \
    --role="roles/storage.admin" \
    --quiet

# Create initial Cloud Run service
echo "🏗️ Creating initial Cloud Run service..."
read -p "Deploy initial service now? (y/n): " DEPLOY_NOW

if [ "$DEPLOY_NOW" = "y" ]; then
    # Check if Docker is installed
    if command -v docker &> /dev/null; then
        echo "🐳 Building and deploying with Docker..."

        # Build and push image
        docker build -t gcr.io/$PROJECT_ID/l0175:initial .
        docker push gcr.io/$PROJECT_ID/l0175:initial

        # Deploy to Cloud Run
        gcloud run deploy l0175 \
            --image gcr.io/$PROJECT_ID/l0175:initial \
            --platform managed \
            --region us-central1 \
            --port 50175 \
            --allow-unauthenticated \
            --set-env-vars AUTH_URL=https://auth.graffiticode.org
    else
        echo "🚀 Deploying from source (Cloud Build will build the container)..."
        gcloud run deploy l0175 \
            --source . \
            --platform managed \
            --region us-central1 \
            --port 50175 \
            --allow-unauthenticated \
            --set-env-vars AUTH_URL=https://auth.graffiticode.org
    fi

    echo "✅ Initial deployment complete!"
fi

# Setup for GitHub Actions (optional)
read -p "Setup GitHub Actions? (y/n): " SETUP_GITHUB

if [ "$SETUP_GITHUB" = "y" ]; then
    echo "🔧 Setting up GitHub Actions..."

    # Create service account for GitHub
    gcloud iam service-accounts create github-actions \
        --display-name="GitHub Actions Deploy" 2>/dev/null || echo "Service account already exists"

    GITHUB_SA="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"

    # Grant roles
    gcloud projects add-iam-policy-binding $PROJECT_ID \
        --member="serviceAccount:${GITHUB_SA}" \
        --role="roles/run.admin" \
        --quiet

    gcloud projects add-iam-policy-binding $PROJECT_ID \
        --member="serviceAccount:${GITHUB_SA}" \
        --role="roles/storage.admin" \
        --quiet

    gcloud projects add-iam-policy-binding $PROJECT_ID \
        --member="serviceAccount:${GITHUB_SA}" \
        --role="roles/iam.serviceAccountUser" \
        --quiet

    read -p "Generate service account key? (y/n): " GEN_KEY

    if [ "$GEN_KEY" = "y" ]; then
        KEY_FILE="github-actions-key.json"
        gcloud iam service-accounts keys create $KEY_FILE \
            --iam-account=$GITHUB_SA

        echo ""
        echo "📋 Service account key created: $KEY_FILE"
        echo "⚠️  IMPORTANT: Add this key to GitHub Secrets as GCP_SA_KEY"
        echo "   1. Copy the contents of $KEY_FILE"
        echo "   2. Go to GitHub repo → Settings → Secrets → Actions"
        echo "   3. Add new secret named 'GCP_SA_KEY' with the JSON content"
        echo "   4. Add another secret 'GCP_PROJECT_ID' with value: $PROJECT_ID"
        echo ""
        echo "🗑️  Remember to delete the key file after adding to GitHub:"
        echo "   rm $KEY_FILE"
    fi
fi

# Display next steps
echo ""
echo "✅ Setup Complete!"
echo "=================="
echo ""
echo "Next steps:"
echo ""

if [ "$SETUP_GITHUB" != "y" ]; then
    echo "1. Cloud Build Triggers (Recommended):"
    echo "   - Go to https://console.cloud.google.com/cloud-build/triggers"
    echo "   - Connect your GitHub repository"
    echo "   - Create triggers for main and develop branches"
    echo "   - Use cloudbuild.production.yaml for main branch"
    echo "   - Use cloudbuild.staging.yaml for other branches"
    echo ""
    echo "   OR"
    echo ""
fi

echo "2. GitHub Actions:"
echo "   - Add secrets to your GitHub repository:"
echo "     • GCP_PROJECT_ID = $PROJECT_ID"
echo "     • GCP_SA_KEY = (service account JSON key)"
echo "   - Push to main branch to trigger deployment"
echo ""
echo "3. Manual deployment:"
echo "   npm run gcp:build    # Using Cloud Build"
echo "   npm run gcp:deploy   # Direct deployment"
echo ""
echo "📚 See GITHUB_DEPLOYMENT.md for detailed instructions"