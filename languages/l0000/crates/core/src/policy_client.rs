// SPDX-License-Identifier: MIT

//! The kernel's client for the policy authority and the credential broker. One snapshot per
//! compile (admission), then for each protected call: mint an execution token for exactly that
//! request, and spend it at the broker. The compiler never sees a connection's credential.
//!
//! Every request carries the calling service's identity twice, as Cloud Run requires: an
//! invoker ID token for Cloud Run IAM (`X-Serverless-Authorization`, audience = the service
//! URL) and a caller ID token policy and broker verify themselves (`X-Caller-Identity`,
//! audience = the service URN). In production both come from the metadata server for this
//! compiler's service account ([`MetadataIdTokens`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Value as Json, json};

use crate::canonical::args_digest;
use crate::protected::{
    PolicyClient, PolicySnapshot, PreviewSession, ProtectedCall, ProtectedCallError, SnapshotRequest,
};

pub const POLICY_AUDIENCE: &str = "urn:graffiticode:policy";
pub const BROKER_AUDIENCE: &str = "urn:graffiticode:broker";

const EXECUTE: &str = "/v1/execute";
/// Policy's session profile: a session is accepted as policy's only if policy signed it, for
/// policy, as a session.
const SESSION_ISSUER: &str = "urn:graffiticode:policy";
const SESSION_TYPE: &str = "gc-session+jwt";

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Mints a Google ID token for this service's account, for one audience.
#[async_trait]
pub trait IdTokenSource: Send + Sync {
    async fn id_token(&self, audience: &str) -> Result<String, BoxError>;
}

pub struct HttpPolicyClient<T> {
    client: reqwest::Client,
    policy_url: String,
    broker_url: Option<String>,
    id_tokens: T,
    /// Policy's public keys, fetched once and again when a session names a key not seen yet
    /// (rotation).
    keys: Mutex<Option<Arc<JwkSet>>>,
}

impl<T: IdTokenSource> HttpPolicyClient<T> {
    /// `broker_url` is optional: a language with no protected functions asks policy for its
    /// stage binding and never executes anything at the broker.
    pub fn new(
        client: reqwest::Client,
        policy_url: impl Into<String>,
        broker_url: Option<String>,
        id_tokens: T,
    ) -> Self {
        Self { client, policy_url: policy_url.into(), broker_url, id_tokens, keys: Mutex::new(None) }
    }

    /// Returns the `data` of a `{ status: "success", data }` response.
    async fn post(
        &self,
        base_url: &str,
        urn: &str,
        path: &str,
        body: &Json,
        bearer: Option<&str>,
    ) -> Result<Json, ProtectedCallError> {
        let (invoker, caller) = tokio::try_join!(self.id_tokens.id_token(base_url), self.id_tokens.id_token(urn))
            .map_err(|err| ProtectedCallError::Unavailable(format!("{path}: no service identity: {err}")))?;
        let mut request = self
            .client
            .post(format!("{base_url}{path}"))
            .header("X-Serverless-Authorization", format!("Bearer {invoker}"))
            .header("X-Caller-Identity", caller)
            .json(body);
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        // No answer at all. Asking the broker to act may have acted.
        let response = request
            .send()
            .await
            .map_err(|_| ProtectedCallError::Unreachable { path: path.to_owned(), effect_unknown: path == EXECUTE })?;
        let status = response.status();
        let mut body: Json = response.json().await.unwrap_or(Json::Null);
        if !status.is_success() || body["status"] != "success" {
            let field = |name: &str| body["error"][name].as_str().map(str::to_owned);
            let reason = field("reason");
            return Err(ProtectedCallError::Rejected {
                path: path.to_owned(),
                status: status.as_u16(),
                category: field("category"),
                // The broker refuses with a reason, before acting; an execute that failed
                // without one (a crash, a proxy error) may have acted.
                effect_unknown: path == EXECUTE && reason.is_none(),
                reason,
            });
        }
        Ok(body["data"].take())
    }

    async fn load_keys(&self) -> Result<Arc<JwkSet>, ProtectedCallError> {
        let unavailable = |status: u16| ProtectedCallError::Unavailable(format!("/v1/jwks failed ({status})"));
        let invoker = self
            .id_tokens
            .id_token(&self.policy_url)
            .await
            .map_err(|err| ProtectedCallError::Unavailable(format!("/v1/jwks: no service identity: {err}")))?;
        let response = self
            .client
            .get(format!("{}/v1/jwks", self.policy_url))
            .header("X-Serverless-Authorization", format!("Bearer {invoker}"))
            .send()
            .await
            .map_err(|_| unavailable(0))?;
        let status = response.status();
        let keys: JwkSet = match response.json().await {
            Ok(keys) if status.is_success() => keys,
            _ => return Err(unavailable(status.as_u16())),
        };
        let keys = Arc::new(keys);
        *self.keys.lock().unwrap() = Some(Arc::clone(&keys));
        Ok(keys)
    }

    /// A session's claims, once its signature, issuer, audience, type and lifetime check out.
    /// The stage binding it carries is trusted from here only.
    async fn verify_session(&self, session_token: &str) -> Result<Json, ProtectedCallError> {
        let cached = self.keys.lock().unwrap().clone();
        let keys = match cached {
            Some(keys) => keys,
            None => self.load_keys().await?,
        };
        match session_claims(session_token, &keys) {
            Ok(claims) => Ok(claims),
            Err(SessionError::UnknownKey) => {
                let keys = self.load_keys().await?;
                session_claims(session_token, &keys).map_err(|_| ProtectedCallError::BadSession)
            }
            Err(SessionError::Invalid) => Err(ProtectedCallError::BadSession),
        }
    }
}

enum SessionError {
    /// Signed with a key not in the set: policy may have rotated one in.
    UnknownKey,
    Invalid,
}

fn session_claims(token: &str, keys: &JwkSet) -> Result<Json, SessionError> {
    let header = jsonwebtoken::decode_header(token).map_err(|_| SessionError::Invalid)?;
    if header.alg != Algorithm::ES256 || header.typ.as_deref() != Some(SESSION_TYPE) {
        return Err(SessionError::Invalid);
    }
    let jwk = header.kid.as_deref().and_then(|kid| keys.find(kid)).ok_or(SessionError::UnknownKey)?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| SessionError::Invalid)?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[SESSION_ISSUER]);
    validation.set_audience(&[POLICY_AUDIENCE]);
    validation.leeway = 0;
    jsonwebtoken::decode::<Json>(token, &key, &validation).map(|token| token.claims).map_err(|_| SessionError::Invalid)
}

#[async_trait]
impl<T: IdTokenSource> PolicyClient for HttpPolicyClient<T> {
    async fn snapshot(&self, request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        let SnapshotRequest { exec, lang_id, functions, manifest } = request;
        let mut body = json!({ "lang": lang_id, "connectionId": exec.connection_id(), "fns": functions });
        if let Some(token) = exec.invocation_token() {
            body["invocationToken"] = token.into();
        }
        if let Some(stage) = exec.stage() {
            body["stage"] = stage.into();
        }
        // Under a plan: the admission and this stage's own manifest, which policy compares
        // with what the plan pins.
        if let Some(token) = exec.admission_token() {
            body["admissionToken"] = token.into();
            body["manifest"] = json!(manifest);
        }
        let data = self.post(&self.policy_url, POLICY_AUDIENCE, "/v1/snapshot", &body, exec.user_token()).await?;
        let allowed = PolicySnapshot::parse_allowed(&data).unwrap_or_default();
        let Some(session_token) = data["sessionToken"].as_str() else {
            return Ok(PolicySnapshot { allowed, session_token: None, bind: None });
        };
        // A planned stage executes only on a binding policy signed.
        let bind = match exec.admission_token() {
            Some(_) => Some(self.verify_session(session_token).await?["bind"].take()),
            None => None,
        };
        Ok(PolicySnapshot { allowed, session_token: Some(session_token.to_owned()), bind })
    }

    async fn invoke(&self, session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        let Some(broker_url) = &self.broker_url else {
            return Err(ProtectedCallError::Unavailable("no broker is configured for this compiler".to_owned()));
        };
        let execute = json!({ "op": call.op, "payload": call.payload });
        let attempt = async || {
            let mint = json!({
                "sessionToken": session_token,
                "fn": call.function,
                "op": call.op,
                "occurrenceId": call.occurrence_id,
                "argsDigest": args_digest(&call.payload),
            });
            let minted = self.post(&self.policy_url, POLICY_AUDIENCE, "/v1/mint", &mint, None).await?;
            let execution_token = minted["executionToken"].as_str().ok_or_else(|| ProtectedCallError::Rejected {
                path: "/v1/mint".to_owned(),
                status: 200,
                reason: Some("no-execution-token".to_owned()),
                category: None,
                effect_unknown: false,
            })?;
            self.post(broker_url, BROKER_AUDIENCE, EXECUTE, &execute, Some(execution_token)).await
        };
        // An execution token must outlast the broker's deadline when it arrives. A slow
        // arrival (a cold broker instance) is refused as token-expiring, before the token is
        // spent or any receipt claimed, so the call is retried once with a fresh token for the
        // same operation (the same occurrence id; the broker's receipt still guards a repeat).
        match attempt().await {
            Err(err) if err.reason() == Some("token-expiring") => attempt().await,
            outcome => outcome,
        }
    }

    /// `POST /v1/preview-session`, as this compiler's own identity and with no user token: the
    /// session is the system's.
    async fn preview_session(&self, lang_id: &str) -> Result<PreviewSession, ProtectedCallError> {
        let body = json!({ "lang": lang_id });
        let data = self.post(&self.policy_url, POLICY_AUDIENCE, "/v1/preview-session", &body, None).await?;
        Ok(PreviewSession {
            allowed: PolicySnapshot::parse_allowed(&data).unwrap_or_default(),
            session_token: data["sessionToken"].as_str().filter(|token| !token.is_empty()).map(str::to_owned),
        })
    }
}

/// Google ID tokens for this service's own account, from the Cloud Run metadata server, cached
/// until shortly before they expire.
pub struct MetadataIdTokens {
    client: reqwest::Client,
    endpoint: String,
    cache: Mutex<HashMap<String, (String, u64)>>,
}

const METADATA_IDENTITY: &str =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

impl MetadataIdTokens {
    /// `client` should be [`crate::egress::metadata_client`]: a general client may send the
    /// request through the egress proxy, which refuses it (ISOLATE-01).
    pub fn new(client: reqwest::Client) -> Self {
        Self::with_endpoint(client, METADATA_IDENTITY)
    }

    /// The metadata server's identity client, direct, never through a proxy.
    pub fn direct() -> Result<Self, crate::egress::EgressError> {
        Ok(Self::new(crate::egress::metadata_client()?))
    }

    /// With the identity endpoint somewhere else (for tests).
    pub fn with_endpoint(client: reqwest::Client, endpoint: impl Into<String>) -> Self {
        Self { client, endpoint: endpoint.into(), cache: Mutex::default() }
    }
}

#[async_trait]
impl IdTokenSource for MetadataIdTokens {
    async fn id_token(&self, audience: &str) -> Result<String, BoxError> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if let Some((token, expires)) = self.cache.lock().unwrap().get(audience)
            && expires.saturating_sub(60) > now
        {
            return Ok(token.clone());
        }
        let response = self
            .client
            .get(&self.endpoint)
            .query(&[("audience", audience), ("format", "full")])
            .header("Metadata-Flavor", "Google")
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(format!("metadata identity token failed ({})", response.status().as_u16()).into());
        }
        let token = response.text().await?;
        // Read only for its expiry; whoever receives the token verifies it.
        let claims: Json = jsonwebtoken::dangerous::insecure_decode(&token)?.claims;
        let expires = claims["exp"].as_u64().unwrap_or(0);
        self.cache.lock().unwrap().insert(audience.to_owned(), (token.clone(), expires));
        Ok(token)
    }
}
