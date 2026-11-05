// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use axum::http::{HeaderMap, header::AUTHORIZATION};
use serde::Deserialize;
use serde_json::{Value as Json, json};

/// What the auth service says about a token it accepted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct AuthContext {
    pub uid: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{code} - {message}")]
pub struct AuthError {
    pub code: String,
    pub message: String,
    /// The auth service couldn't say (unreachable, slow, or failing): the token was not
    /// judged, so the caller may try again. Answered 503, never 401.
    pub unavailable: bool,
}

impl AuthError {
    /// The auth service judged the token and refused it.
    pub fn rejected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), unavailable: false }
    }

    /// The auth service couldn't judge the token.
    pub fn unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), unavailable: true }
    }
}

#[async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, token: &str) -> Result<AuthContext, AuthError>;
}

/// Verifies tokens against the Graffiticode auth service (`POST /oauth/verify`).
pub struct AuthService {
    client: reqwest::Client,
    url: String,
}

impl AuthService {
    pub fn new(client: reqwest::Client, auth_url: &str) -> Self {
        Self { client, url: format!("{}/oauth/verify", auth_url.trim_end_matches('/')) }
    }
}

#[async_trait]
impl TokenVerifier for AuthService {
    async fn verify(&self, token: &str) -> Result<AuthContext, AuthError> {
        let unavailable = |message: String| AuthError::unavailable("undefined", message);
        let response = self
            .client
            .post(&self.url)
            .json(&json!({ "idToken": token }))
            .send()
            .await
            .map_err(|err| unavailable(err.to_string()))?;
        let status = response.status().as_u16();
        // The service answers a bad token with 400 or 401 and a reason; anything else is the
        // service failing, not the token.
        if ![200, 400, 401].contains(&status) {
            return Err(AuthError::unavailable(status.to_string(), format!("auth service responded with {status}")));
        }
        let mut body: Json = response.json().await.map_err(|err| unavailable(err.to_string()))?;
        if body["status"] != "success" {
            let error = &body["error"];
            return Err(AuthError::rejected(
                error["code"].as_u64().map_or_else(|| "undefined".to_owned(), |code| code.to_string()),
                error["message"].as_str().unwrap_or("undefined"),
            ));
        }
        serde_json::from_value(body["data"].take()).map_err(|err| unavailable(err.to_string()))
    }
}

/// A verifier in front of another that remembers each accepted token for a short while and
/// asks again once when the service couldn't answer.
///
/// Every request carries its caller's token, and an interpreted stage makes two calls with the
/// same one (its model, then its interpretation), so asking the auth service each time costs a
/// round trip per call and, under load, an occasional failed or slow answer. The B5 drive
/// (2026-11-05) saw those answered as 401s. An accepted token is kept for at most `ttl`, and
/// never past its own `exp`; a refusal is never kept. Expiry is read from the token's claims
/// without checking its signature: the auth service has already accepted it, and the claim
/// only shortens how long that answer is reused.
pub struct CachingVerifier<V> {
    inner: V,
    ttl: Duration,
    max: usize,
    accepted: Mutex<HashMap<String, (AuthContext, Instant)>>,
}

impl<V: TokenVerifier> CachingVerifier<V> {
    pub const DEFAULT_TTL: Duration = Duration::from_secs(60);
    pub const DEFAULT_MAX: usize = 10_000;

    pub fn new(inner: V, ttl: Duration, max: usize) -> Self {
        Self { inner, ttl, max, accepted: Mutex::new(HashMap::new()) }
    }

    /// How long an answer for this token may be reused: `ttl`, cut short by its `exp`.
    fn keep_for(&self, token: &str) -> Option<Duration> {
        let claims: Json = jsonwebtoken::dangerous::insecure_decode_claims(token).ok()?;
        let exp = claims.get("exp")?.as_u64()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        let left = Duration::from_secs(exp.checked_sub(now)?);
        Some(left.min(self.ttl))
    }
}

#[async_trait]
impl<V: TokenVerifier> TokenVerifier for CachingVerifier<V> {
    async fn verify(&self, token: &str) -> Result<AuthContext, AuthError> {
        if let Some((context, until)) = self.accepted.lock().unwrap().get(token)
            && Instant::now() < *until
        {
            return Ok(context.clone());
        }
        let answer = match self.inner.verify(token).await {
            Err(err) if err.unavailable => self.inner.verify(token).await,
            answer => answer,
        };
        if let (Ok(context), Some(keep)) = (&answer, self.keep_for(token)) {
            let mut accepted = self.accepted.lock().unwrap();
            if accepted.len() >= self.max {
                let now = Instant::now();
                accepted.retain(|_, (_, until)| *until > now);
                if accepted.len() >= self.max {
                    accepted.clear();
                }
            }
            accepted.insert(token.to_owned(), (context.clone(), Instant::now() + keep));
        }
        answer
    }
}

/// The caller's token: `?access_token=`, then the body's `auth`, then the `Authorization`
/// header, with or without a `Bearer ` prefix.
pub fn token_from_request(query: Option<&str>, body: &Json, headers: &HeaderMap) -> Option<String> {
    let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    query.and_then(non_empty).or_else(|| body.get("auth").and_then(Json::as_str).and_then(non_empty)).or_else(|| {
        let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
        non_empty(header.strip_prefix("Bearer ").unwrap_or(header))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A verifier that answers from a script and counts its calls.
    struct Scripted {
        calls: AtomicUsize,
        answer: Box<dyn Fn(usize) -> Result<AuthContext, AuthError> + Send + Sync>,
    }

    #[async_trait]
    impl TokenVerifier for Scripted {
        async fn verify(&self, _token: &str) -> Result<AuthContext, AuthError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            (self.answer)(n)
        }
    }

    fn scripted(answer: impl Fn(usize) -> Result<AuthContext, AuthError> + Send + Sync + 'static) -> Scripted {
        Scripted { calls: AtomicUsize::new(0), answer: Box::new(answer) }
    }

    /// A signed token that expires `secs` from now (negative: already expired).
    fn token(secs: i64) -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &json!({ "sub": "u1", "exp": now + secs }),
            &jsonwebtoken::EncodingKey::from_secret(b"test"),
        )
        .unwrap()
    }

    fn uid(id: &str) -> AuthContext {
        AuthContext { uid: Some(id.to_owned()) }
    }

    #[tokio::test]
    async fn an_accepted_token_is_asked_about_once_within_its_ttl() {
        let cache = CachingVerifier::new(scripted(|_| Ok(uid("u1"))), Duration::from_secs(60), 10);
        let t = token(300);
        for _ in 0..3 {
            assert_eq!(cache.verify(&t).await, Ok(uid("u1")));
        }
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_refusal_is_never_kept() {
        let cache =
            CachingVerifier::new(scripted(|_| Err(AuthError::rejected("401", "bad"))), Duration::from_secs(60), 10);
        let t = token(300);
        for _ in 0..2 {
            assert!(!cache.verify(&t).await.unwrap_err().unavailable);
        }
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_unavailable_service_is_asked_again_once() {
        // Unavailable, then accepted: the caller sees the acceptance.
        let flaky = CachingVerifier::new(
            scripted(|n| if n == 0 { Err(AuthError::unavailable("undefined", "timed out")) } else { Ok(uid("u1")) }),
            Duration::from_secs(60),
            10,
        );
        assert_eq!(flaky.verify(&token(300)).await, Ok(uid("u1")));
        assert_eq!(flaky.inner.calls.load(Ordering::SeqCst), 2);
        // Unavailable twice: the caller is told so, which the server answers 503, not 401.
        let down =
            CachingVerifier::new(scripted(|_| Err(AuthError::unavailable("503", "down"))), Duration::from_secs(60), 10);
        assert!(down.verify(&token(300)).await.unwrap_err().unavailable);
        assert_eq!(down.inner.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_answer_is_never_kept_past_the_token_s_expiry() {
        // Expired, or without a readable exp: not kept, so each request asks.
        for t in [token(-5), "not-a-jwt".to_owned()] {
            let cache = CachingVerifier::new(scripted(|_| Ok(uid("u1"))), Duration::from_secs(60), 10);
            cache.verify(&t).await.unwrap();
            cache.verify(&t).await.unwrap();
            assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 2, "{t}");
        }
        // Expiring in 1 s: kept for 1 s, not 60.
        let cache = CachingVerifier::new(scripted(|_| Ok(uid("u1"))), Duration::from_secs(60), 10);
        assert!(cache.keep_for(&token(1)).unwrap() <= Duration::from_secs(1));
    }

    #[tokio::test]
    async fn the_cache_stays_within_its_size() {
        let cache = CachingVerifier::new(scripted(|_| Ok(uid("u1"))), Duration::from_secs(60), 3);
        for secs in 100..110 {
            cache.verify(&token(secs)).await.unwrap();
        }
        assert!(cache.accepted.lock().unwrap().len() <= 3);
    }

    #[test]
    fn the_query_wins_over_the_body_and_the_body_over_the_header() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer from-header".parse().unwrap());
        let body = json!({ "auth": "from-body" });
        let token = token_from_request;

        assert_eq!(token(Some("from-query"), &body, &headers).as_deref(), Some("from-query"));
        assert_eq!(token(Some(""), &body, &headers).as_deref(), Some("from-body"));
        assert_eq!(token(None, &json!({ "auth": 7 }), &headers).as_deref(), Some("from-header"));
        assert_eq!(token(None, &json!({}), &HeaderMap::new()), None);

        headers.insert(AUTHORIZATION, "bare-token".parse().unwrap());
        assert_eq!(token(None, &json!({}), &headers).as_deref(), Some("bare-token"));
    }
}
