// SPDX-License-Identifier: MIT

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
        let unavailable = |message: String| AuthError { code: "undefined".to_owned(), message };
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
            return Err(AuthError {
                code: status.to_string(),
                message: format!("auth service responded with {status}"),
            });
        }
        let mut body: Json = response.json().await.map_err(|err| unavailable(err.to_string()))?;
        if body["status"] != "success" {
            let error = &body["error"];
            return Err(AuthError {
                code: error["code"].as_u64().map_or_else(|| "undefined".to_owned(), |code| code.to_string()),
                message: error["message"].as_str().unwrap_or("undefined").to_owned(),
            });
        }
        serde_json::from_value(body["data"].take()).map_err(|err| unavailable(err.to_string()))
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
