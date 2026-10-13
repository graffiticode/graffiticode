// SPDX-License-Identifier: MIT

//! Who may call `POST /preflight`: the authenticated gateway only.
//!
//! Cloud Run IAM is unchanged (a language server stays public for anonymous compiles and
//! `/form`), so the route authenticates the caller itself. `X-Caller-Identity` must be a Google
//! ID token for one of the configured gateway service accounts, with exactly this language's
//! audience (`urn:graffiticode:<lang>`), issued by Google, unexpired, for a verified email.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::http::{HeaderMap, StatusCode};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::Value;

const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_CERTS: &str = "https://www.googleapis.com/oauth2/v3/certs";
const CERTS_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, PartialEq, Eq)]
pub struct CallerRefused {
    pub status: StatusCode,
    pub reason: &'static str,
}

impl CallerRefused {
    /// No acceptable identity was presented.
    fn rejected() -> Self {
        Self { status: StatusCode::UNAUTHORIZED, reason: "caller-rejected" }
    }

    /// A genuine Google identity, but not a gateway's.
    fn not_allowed() -> Self {
        Self { status: StatusCode::FORBIDDEN, reason: "route-not-allowed-for-caller" }
    }
}

#[async_trait]
pub trait GatewayVerifier: Send + Sync {
    async fn verify(&self, headers: &HeaderMap) -> Result<(), CallerRefused>;
}

/// The audience a gateway's ID token must carry for a language: `urn:graffiticode:0000`.
pub fn language_audience(lang: &str) -> String {
    format!("urn:graffiticode:{}", canonical_lang(lang))
}

/// `L176`, `176` and `0176` are the same language: `0176`.
pub fn canonical_lang(lang: &str) -> String {
    format!("{:0>4}", lang.strip_prefix(['L', 'l']).unwrap_or(lang))
}

enum Certs {
    /// Google's published keys, refetched hourly and when a token names a key not seen yet.
    Google {
        client: reqwest::Client,
        cached: Mutex<Option<(Instant, Arc<JwkSet>)>>,
    },
    Fixed(Arc<JwkSet>),
}

pub struct GoogleGateways {
    audience: String,
    gateways: HashSet<String>,
    certs: Certs,
}

impl GoogleGateways {
    /// `gateways` are the service-account emails allowed to preflight. With none, every
    /// preflight is refused.
    pub fn new(client: reqwest::Client, lang: &str, gateways: &[String]) -> Self {
        Self::build(lang, gateways, Certs::Google { client, cached: Mutex::new(None) })
    }

    /// Verifies against a fixed key set instead of Google's.
    pub fn with_keys(lang: &str, gateways: &[String], keys: JwkSet) -> Self {
        Self::build(lang, gateways, Certs::Fixed(Arc::new(keys)))
    }

    fn build(lang: &str, gateways: &[String], certs: Certs) -> Self {
        let gateways = gateways.iter().map(|g| g.trim().to_lowercase()).filter(|g| !g.is_empty()).collect();
        Self { audience: language_audience(lang), gateways, certs }
    }

    async fn keys(&self, refresh: bool) -> Option<Arc<JwkSet>> {
        let (client, cached) = match &self.certs {
            Certs::Fixed(keys) => return Some(Arc::clone(keys)),
            Certs::Google { client, cached } => (client, cached),
        };
        if !refresh
            && let Some((fetched, keys)) = &*cached.lock().unwrap()
            && fetched.elapsed() < CERTS_TTL
        {
            return Some(Arc::clone(keys));
        }
        let keys: JwkSet = client.get(GOOGLE_CERTS).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        let keys = Arc::new(keys);
        *cached.lock().unwrap() = Some((Instant::now(), Arc::clone(&keys)));
        Some(keys)
    }

    async fn claims(&self, token: &str) -> Option<Value> {
        let header = jsonwebtoken::decode_header(token).ok()?;
        if header.alg != Algorithm::RS256 {
            return None;
        }
        let kid = header.kid?;
        let mut keys = self.keys(false).await?;
        if keys.find(&kid).is_none() {
            keys = self.keys(true).await?;
        }
        let key = DecodingKey::from_jwk(keys.find(&kid)?).ok()?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&GOOGLE_ISSUERS);
        validation.set_audience(&[&self.audience]);
        validation.leeway = 0;
        jsonwebtoken::decode::<Value>(token, &key, &validation).ok().map(|token| token.claims)
    }
}

#[async_trait]
impl GatewayVerifier for GoogleGateways {
    async fn verify(&self, headers: &HeaderMap) -> Result<(), CallerRefused> {
        let presented = headers.get("x-caller-identity").and_then(|value| value.to_str().ok()).unwrap_or("");
        let token = match presented.get(..7) {
            Some(prefix) if prefix.eq_ignore_ascii_case("bearer ") => &presented[7..],
            _ => presented,
        }
        .trim();
        if token.is_empty() {
            return Err(CallerRefused::rejected());
        }
        let claims = self.claims(token).await.ok_or_else(CallerRefused::rejected)?;
        let email = claims["email"].as_str().unwrap_or("").to_lowercase();
        if claims["email_verified"] != true || !self.gateways.contains(&email) {
            return Err(CallerRefused::not_allowed());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_has_one_audience_however_it_is_written() {
        for lang in ["0000", "L0000", "0", "l0"] {
            assert_eq!(language_audience(lang), "urn:graffiticode:0000");
        }
        assert_eq!(language_audience("L176"), "urn:graffiticode:0176");
    }
}
