// SPDX-License-Identifier: MIT

//! [`ExecContext`] is the per-invocation authorization context: who is compiling, through
//! which connection, under which invocation, and what policy admitted. There are no execution
//! modes: running the program is the action, and the grant is the authority.
//!
//! Two invariants make it a security boundary rather than a convenience:
//!
//! 1. A program cannot reach it. It is not a value, and no variable (`get-var`/`set-var`)
//!    names it.
//! 2. It belongs to one invocation, never to a [`Compiler`](crate::Compiler). A language server
//!    shares one compiler across concurrent requests, so state on the compiler would mix
//!    users. Each compile allocates a fresh context.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value as Json;
use uuid::Uuid;

use crate::protected::{PolicyClient, ProtectedCall, ProtectedCallError};

/// The caller's VERIFIED identity and invocation, supplied by the language server from its
/// authenticated request context — never from program input.
#[derive(Clone, Default)]
pub struct Identity {
    pub uid: Option<String>,
    pub connection_id: Option<String>,
    /// Forwarded to policy only.
    pub user_token: Option<String>,
    /// The logical invocation, allocated by the authenticated entry point (the gateway) and
    /// shared by every retry of it. Policy derives operation ids from it and from `stage`, so
    /// a retry reaches the same write receipts.
    pub invocation_token: Option<String>,
    /// This compile's position in the task chain.
    pub stage: Option<String>,
    /// The plan this chain was admitted under, from the gateway. Policy verifies it; with it,
    /// the compiler executes only what the plan pins for its stage.
    pub admission_token: Option<String>,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("uid", &self.uid)
            .field("connection_id", &self.connection_id)
            .field("stage", &self.stage)
            .finish_non_exhaustive()
    }
}

/// How a protected write went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectStatus {
    Succeeded,
    /// Refused before acting: nothing was done.
    Failed,
    Partial,
    /// The write was sent and nothing says how it went.
    Uncertain,
}

/// What one protected write did: the broker's outcome, or what can be said without one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedEffect {
    #[serde(rename = "fn")]
    pub function: String,
    pub op: String,
    pub status: EffectStatus,
    /// The completed provider steps. Empty for an uncertain write means none is known to have
    /// completed, not that nothing happened.
    pub steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The broker had already performed this operation and answered from its receipt.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub replayed: bool,
}

impl ProtectedEffect {
    /// The broker's outcome for a write. A status it does not recognize is uncertain.
    fn of_outcome(call: &ProtectedCall, outcome: &Json) -> Self {
        let text = |field: &str| outcome[field].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        Self {
            function: call.function.clone(),
            op: call.op.clone(),
            status: match outcome["status"].as_str() {
                Some("succeeded") => EffectStatus::Succeeded,
                Some("failed") => EffectStatus::Failed,
                Some("partial") => EffectStatus::Partial,
                _ => EffectStatus::Uncertain,
            },
            steps: outcome["steps"]
                .as_array()
                .map(|steps| steps.iter().filter_map(Json::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
            failed_step: text("failedStep"),
            reason: text("reason"),
            category: text("category"),
            replayed: outcome["replayed"] == true,
        }
    }

    /// A write that returned no outcome: refused before acting, or sent with its answer lost.
    fn of_error(call: &ProtectedCall, error: &ProtectedCallError) -> Self {
        let uncertain = error.effect_unknown();
        Self {
            function: call.function.clone(),
            op: call.op.clone(),
            status: if uncertain { EffectStatus::Uncertain } else { EffectStatus::Failed },
            steps: Vec::new(),
            failed_step: None,
            reason: (!uncertain).then(|| error.reason().map(str::to_owned)).flatten(),
            category: (!uncertain).then(|| error.category().map(str::to_owned)).flatten(),
            replayed: false,
        }
    }
}

/// What admission decided for this invocation. Set once, before the program runs.
pub(crate) struct Grant {
    pub allowed: HashSet<String>,
    /// The admitted functions that are writes: their outcomes are this compile's effects.
    pub writes: HashSet<String>,
    pub session_token: Option<String>,
    pub policy: Option<Arc<dyn PolicyClient>>,
}

pub struct ExecContext {
    identity: Identity,
    compile_id: Uuid,
    occurrences: HashMap<String, u64>,
    grant: Option<Grant>,
    effects: Vec<ProtectedEffect>,
}

impl ExecContext {
    pub fn new(identity: Identity) -> Self {
        let present = |field: Option<String>| field.filter(|s| !s.is_empty());
        Self {
            identity: Identity {
                uid: present(identity.uid),
                connection_id: present(identity.connection_id),
                user_token: present(identity.user_token),
                invocation_token: present(identity.invocation_token),
                stage: present(identity.stage),
                admission_token: present(identity.admission_token),
            },
            compile_id: Uuid::new_v4(),
            occurrences: HashMap::new(),
            grant: None,
            effects: Vec::new(),
        }
    }

    pub fn uid(&self) -> Option<&str> {
        self.identity.uid.as_deref()
    }

    pub fn connection_id(&self) -> Option<&str> {
        self.identity.connection_id.as_deref()
    }

    pub fn stage(&self) -> Option<&str> {
        self.identity.stage.as_deref()
    }

    /// The user token a policy client forwards.
    pub fn user_token(&self) -> Option<&str> {
        self.identity.user_token.as_deref()
    }

    /// The invocation token a policy client forwards.
    pub fn invocation_token(&self) -> Option<&str> {
        self.identity.invocation_token.as_deref()
    }

    /// The admission token a policy client forwards.
    pub fn admission_token(&self) -> Option<&str> {
        self.identity.admission_token.as_deref()
    }

    /// Whether this compile runs under an admitted plan.
    pub fn is_planned(&self) -> bool {
        self.identity.admission_token.is_some()
    }

    /// Unique to this compile. For diagnostics only: the logical invocation, which retries
    /// share, comes from the invocation token.
    pub fn compile_id(&self) -> Uuid {
        self.compile_id
    }

    /// Whether admission allowed `function` for this invocation.
    pub fn is_admitted(&self, function: &str) -> bool {
        self.grant.as_ref().is_some_and(|grant| grant.allowed.contains(function))
    }

    /// Deterministic occurrence ids: the Nth protected call made from the same node in this
    /// invocation is `<key>.<N>`. A retry that follows the same path reproduces them; a loop
    /// calling one node repeatedly gets distinct ones.
    pub fn next_occurrence(&mut self, key: &str) -> String {
        let n = self.occurrences.entry(key.to_owned()).or_default();
        let id = format!("{key}.{n}");
        *n += 1;
        id
    }

    /// The only way a language performs a protected operation. Refuses anything admission did
    /// not allow, before any network call. The outcome of a write is recorded as an effect,
    /// whether it succeeds or not.
    pub async fn invoke(&mut self, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        let grant = self
            .grant
            .as_ref()
            .filter(|grant| grant.allowed.contains(&call.function))
            .ok_or_else(|| ProtectedCallError::NotAdmitted(call.function.clone()))?;
        let policy = grant.policy.clone().ok_or(ProtectedCallError::NoClient)?;
        let is_write = grant.writes.contains(&call.function);
        let outcome = match grant.session_token.clone() {
            Some(session) => policy.invoke(&session, call).await,
            None => Err(ProtectedCallError::NoSession),
        };
        if is_write {
            self.effects.push(match &outcome {
                Ok(outcome) => ProtectedEffect::of_outcome(call, outcome),
                Err(error) => ProtectedEffect::of_error(call, error),
            });
        }
        outcome
    }

    /// Every protected write this compile has made, in order, including one that failed after
    /// an earlier one succeeded.
    pub fn effects(&self) -> &[ProtectedEffect] {
        &self.effects
    }

    pub(crate) fn into_effects(self) -> Vec<ProtectedEffect> {
        self.effects
    }

    pub(crate) fn set_grant(&mut self, grant: Grant) {
        debug_assert!(self.grant.is_none(), "admission runs once per invocation");
        self.grant = Some(grant);
    }
}

impl fmt::Debug for ExecContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecContext")
            .field("identity", &self.identity)
            .field("compile_id", &self.compile_id)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_identity_fields_are_absent() {
        let exec = ExecContext::new(Identity { uid: Some(String::new()), ..Identity::default() });
        assert_eq!(exec.uid(), None);
        assert_eq!(exec.connection_id(), None);
    }

    #[test]
    fn occurrence_ids_count_per_key() {
        let mut exec = ExecContext::new(Identity::default());
        assert_eq!(exec.next_occurrence("n12"), "n12.0");
        assert_eq!(exec.next_occurrence("n12"), "n12.1");
        assert_eq!(exec.next_occurrence("n7"), "n7.0");
    }

    #[test]
    fn debug_output_carries_no_tokens() {
        let exec = ExecContext::new(Identity {
            uid: Some("u1".into()),
            user_token: Some("user-secret".into()),
            invocation_token: Some("invocation-secret".into()),
            ..Identity::default()
        });
        let debug = format!("{exec:?}");
        assert!(debug.contains("u1"));
        assert!(!debug.contains("secret"), "{debug}");
    }

    #[tokio::test]
    async fn nothing_is_invocable_before_admission() {
        let mut exec = ExecContext::new(Identity::default());
        let call = ProtectedCall {
            function: "items.save".into(),
            op: "save".into(),
            payload: Json::Null,
            occurrence_id: "n1.0".into(),
        };
        assert!(matches!(exec.invoke(&call).await, Err(ProtectedCallError::NotAdmitted(f)) if f == "items.save"));
        assert!(exec.effects().is_empty());
    }

    #[test]
    fn an_effect_reads_the_brokers_outcome() {
        let call = ProtectedCall {
            function: "save-it".into(),
            op: "toy.write".into(),
            payload: Json::Null,
            occurrence_id: "n.0".into(),
        };
        let wire = |outcome: Json| serde_json::to_value(ProtectedEffect::of_outcome(&call, &outcome)).unwrap();
        assert_eq!(
            wire(serde_json::json!({ "status": "succeeded", "steps": ["questions", "items"], "result": {} })),
            serde_json::json!({ "fn": "save-it", "op": "toy.write", "status": "succeeded", "steps": ["questions", "items"] })
        );
        assert_eq!(
            wire(serde_json::json!({
                "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission", "error": "denied",
            })),
            serde_json::json!({
                "fn": "save-it", "op": "toy.write", "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission",
            })
        );
        assert_eq!(wire(serde_json::json!({ "status": "succeeded", "replayed": true }))["replayed"], true);
        // An outcome that is not recognized was sent, and nothing says how it went.
        assert_eq!(
            wire(serde_json::json!({ "status": "mystery" })),
            serde_json::json!({ "fn": "save-it", "op": "toy.write", "status": "uncertain", "steps": [] })
        );
    }

    #[test]
    fn a_failed_call_is_a_refusal_unless_its_answer_was_lost() {
        let call = ProtectedCall {
            function: "save-it".into(),
            op: "toy.write".into(),
            payload: Json::Null,
            occurrence_id: "n.0".into(),
        };
        let refused = ProtectedCallError::Rejected {
            path: "/v1/mint".into(),
            status: 403,
            reason: Some("operation-not-allowed".into()),
            category: Some("permission".into()),
            effect_unknown: false,
        };
        let effect = ProtectedEffect::of_error(&call, &refused);
        assert_eq!((effect.status, effect.reason.as_deref()), (EffectStatus::Failed, Some("operation-not-allowed")));
        assert_eq!(effect.category.as_deref(), Some("permission"));

        let lost = ProtectedCallError::Unreachable { path: "/v1/execute".into(), effect_unknown: true };
        let effect = ProtectedEffect::of_error(&call, &lost);
        assert_eq!((effect.status, effect.reason), (EffectStatus::Uncertain, None));
    }
}
