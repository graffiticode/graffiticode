// SPDX-License-Identifier: MIT

//! The kernel's client for the policy authority and the credential broker. One snapshot per
//! compile (admission), then for each protected call: mint an execution token for exactly that
//! request, and spend it at the broker. The compiler never sees a connection's credential.
//!
//! Every request carries the calling service's identity twice, as Cloud Run requires: an
//! invoker ID token for Cloud Run IAM (`X-Serverless-Authorization`, audience = the service
//! URL) and a caller ID token policy and broker verify themselves (`X-Caller-Identity`,
//! audience = the service URN). In production both come from the metadata server for this
//! compiler's service account.

use async_trait::async_trait;
use serde_json::{Value as Json, json};

use crate::canonical::args_digest;
use crate::protected::{PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError, SnapshotRequest};

pub const POLICY_AUDIENCE: &str = "urn:graffiticode:policy";
pub const BROKER_AUDIENCE: &str = "urn:graffiticode:broker";

/// Mints a Google ID token for this service's account, for one audience.
#[async_trait]
pub trait IdTokenSource: Send + Sync {
    async fn id_token(&self, audience: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct HttpPolicyClient<T> {
    client: reqwest::Client,
    policy_url: String,
    broker_url: String,
    id_tokens: T,
}

impl<T: IdTokenSource> HttpPolicyClient<T> {
    pub fn new(
        client: reqwest::Client,
        policy_url: impl Into<String>,
        broker_url: impl Into<String>,
        id_tokens: T,
    ) -> Self {
        Self { client, policy_url: policy_url.into(), broker_url: broker_url.into(), id_tokens }
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
        let transport = |err: &dyn std::fmt::Display| ProtectedCallError::Transport(format!("{path}: {err}"));
        let (invoker, caller) = tokio::try_join!(self.id_tokens.id_token(base_url), self.id_tokens.id_token(urn))
            .map_err(|err| transport(&err))?;
        let mut request = self
            .client
            .post(format!("{base_url}{path}"))
            .header("X-Serverless-Authorization", format!("Bearer {invoker}"))
            .header("X-Caller-Identity", caller)
            .json(body);
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request.send().await.map_err(|err| transport(&err))?;
        let status = response.status();
        let mut body: Json = response.json().await.unwrap_or(Json::Null);
        if !status.is_success() || body["status"] != "success" {
            return Err(ProtectedCallError::Rejected {
                path: path.to_owned(),
                status: status.as_u16(),
                reason: body["error"]["reason"].as_str().map(str::to_owned),
            });
        }
        Ok(body["data"].take())
    }
}

#[async_trait]
impl<T: IdTokenSource> PolicyClient for HttpPolicyClient<T> {
    async fn snapshot(&self, request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        let SnapshotRequest { exec, lang_id, functions } = request;
        let mut body = json!({ "lang": lang_id, "connectionId": exec.connection_id(), "fns": functions });
        if let Some(token) = exec.invocation_token() {
            body["invocationToken"] = token.into();
        }
        if let Some(stage) = exec.stage() {
            body["stage"] = stage.into();
        }
        let data = self.post(&self.policy_url, POLICY_AUDIENCE, "/v1/snapshot", &body, exec.user_token()).await?;
        Ok(PolicySnapshot {
            allowed: PolicySnapshot::parse_allowed(&data).unwrap_or_default(),
            session_token: data["sessionToken"].as_str().map(str::to_owned),
        })
    }

    async fn invoke(&self, session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
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
        })?;
        let execute = json!({ "op": call.op, "payload": call.payload });
        self.post(&self.broker_url, BROKER_AUDIENCE, "/v1/execute", &execute, Some(execution_token)).await
    }
}
