// SPDX-License-Identifier: MIT

//! Where photographs are kept.

use std::sync::Arc;

use async_trait::async_trait;
use gcp_auth::TokenProvider;
use tokio::sync::OnceCell;

use crate::CameraError;

/// Stores a PNG and says where it can be fetched from.
#[async_trait]
pub trait Storage: Send + Sync {
    async fn put_png(&self, object: &str, png: &[u8]) -> Result<String, CameraError>;

    /// Whether a capture may be stored here at all, checked before anything is rendered.
    fn ready(&self) -> Result<(), CameraError> {
        Ok(())
    }

    /// The bucket captures are written to, when there is one, for the server to report.
    fn bucket(&self) -> Option<&str> {
        None
    }
}

/// A Google Cloud Storage bucket (the Firebase Storage bucket is one), written with the
/// application default credentials: the runtime service account on Cloud Run, and the
/// developer's own (`gcloud auth application-default login`) locally. No key file.
pub struct GoogleStorage {
    client: reqwest::Client,
    /// None when THUMBNAIL_BUCKET is unset: every capture is refused (interpreter plan A1b).
    bucket: Option<String>,
    credentials: OnceCell<Arc<dyn TokenProvider>>,
}

const SCOPE: &str = "https://www.googleapis.com/auth/devstorage.full_control";
const BOUNDARY: &str = "l0013-thumbnail-boundary";

impl GoogleStorage {
    pub fn new(client: reqwest::Client, bucket: Option<String>) -> Self {
        Self { client, bucket, credentials: OnceCell::new() }
    }

    fn require_bucket(&self) -> Result<&str, CameraError> {
        self.bucket.as_deref().ok_or_else(|| {
            "THUMBNAIL_BUCKET is not set: this server stores no captures. Set it to the bucket \
             captures belong in (an isolated bucket for any test run)."
                .into()
        })
    }
}

/// A `multipart/related` upload body: the object's metadata, then its bytes.
fn multipart(object: &str, png: &[u8]) -> Vec<u8> {
    // The object path is overwritten by every snap of an item, so nothing may cache it; the
    // caller's URL carries a content hash instead.
    let metadata = serde_json::json!({ "name": object, "contentType": "image/png", "cacheControl": "no-cache" });
    let mut body = Vec::with_capacity(png.len() + 512);
    body.extend(format!("--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n").bytes());
    body.extend(format!("--{BOUNDARY}\r\nContent-Type: image/png\r\n\r\n").bytes());
    body.extend_from_slice(png);
    body.extend(format!("\r\n--{BOUNDARY}--\r\n").bytes());
    body
}

#[async_trait]
impl Storage for GoogleStorage {
    fn ready(&self) -> Result<(), CameraError> {
        self.require_bucket().map(|_| ())
    }

    fn bucket(&self) -> Option<&str> {
        self.bucket.as_deref()
    }

    async fn put_png(&self, object: &str, png: &[u8]) -> Result<String, CameraError> {
        let bucket = self.require_bucket()?;
        let credentials = self.credentials.get_or_try_init(gcp_auth::provider).await?;
        let token = credentials.token(&[SCOPE]).await?;
        // The object is made public in the same write. A separate ACL update would be its own
        // read-modify-write and can race with this one.
        let response = self
            .client
            .post(format!("https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o"))
            .query(&[("uploadType", "multipart"), ("predefinedAcl", "publicRead")])
            .bearer_auth(token.as_str())
            .header("Content-Type", format!("multipart/related; boundary={BOUNDARY}"))
            .body(multipart(object, png))
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail: String = response.text().await.unwrap_or_default().chars().take(300).collect();
            return Err(format!("upload to {bucket} failed: HTTP {status} {detail}").into());
        }
        Ok(format!("https://storage.googleapis.com/{bucket}/{object}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upload_carries_its_metadata_then_its_bytes() {
        let body = multipart("thumbnails/abc.png", b"\x89PNG-bytes");
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--l0013-thumbnail-boundary\r\nContent-Type: application/json"));
        assert!(text.contains(r#""name":"thumbnails/abc.png""#));
        assert!(text.contains(r#""cacheControl":"no-cache""#));
        assert!(text.contains("Content-Type: image/png\r\n\r\n\u{fffd}PNG-bytes\r\n--l0013-thumbnail-boundary--\r\n"));
    }

    /// Without THUMBNAIL_BUCKET nothing is stored: no default bucket (interpreter plan A1b).
    #[tokio::test]
    async fn without_a_bucket_nothing_is_stored() {
        let none = GoogleStorage::new(reqwest::Client::new(), None);
        assert_eq!(none.bucket(), None);
        assert!(none.ready().unwrap_err().to_string().contains("THUMBNAIL_BUCKET is not set"));
        let refused = none.put_png("thumbnails/x.png", b"png").await.unwrap_err();
        assert!(refused.to_string().contains("THUMBNAIL_BUCKET is not set"), "{refused}");
        let isolated = GoogleStorage::new(reqwest::Client::new(), Some("gc-l0013-evidence".to_owned()));
        assert_eq!(isolated.bucket(), Some("gc-l0013-evidence"));
        assert!(isolated.ready().is_ok());
    }
}
