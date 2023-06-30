terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "4.71.0"
    }
  }
}

provider "google" {
  project = "graffiticode"
  region  = "us-central1"
}

resource "google_cloudbuild_trigger" "graffiticode-auth-staging-trigger" {
  name     = "graffiticode-auth-staging-trigger"
  location = "global"

  github {
    owner = "graffiticode"
    name  = "root"
    push {
      branch = "^main$"
    }
  }

  included_files = [
    "packages/auth/**",
    "packages/common/**",
  ]

  filename = "configs/cloudbuild.auth.yaml"
}

resource "google_cloudbuild_trigger" "graffiticode-api-staging-trigger" {
  name     = "graffiticode-api-staging-trigger"
  location = "global"

  github {
    owner = "graffiticode"
    name  = "root"
    push {
      branch = "^main$"
    }
  }

  included_files = [
    "packages/api/**",
    "packages/common/**",
  ]

  filename = "configs/cloudbuild.api.yaml"
}
