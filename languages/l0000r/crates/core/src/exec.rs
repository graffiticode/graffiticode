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

/// What admission decided for this invocation. Set once, before the program runs.
pub(crate) struct Grant {
    pub allowed: HashSet<String>,
    pub session_token: Option<String>,
    pub policy: Option<Arc<dyn PolicyClient>>,
}

pub struct ExecContext {
    identity: Identity,
    compile_id: Uuid,
    occurrences: HashMap<String, u64>,
    grant: Option<Grant>,
}

impl ExecContext {
    pub(crate) fn new(identity: Identity) -> Self {
        let present = |field: Option<String>| field.filter(|s| !s.is_empty());
        Self {
            identity: Identity {
                uid: present(identity.uid),
                connection_id: present(identity.connection_id),
                user_token: present(identity.user_token),
                invocation_token: present(identity.invocation_token),
                stage: present(identity.stage),
            },
            compile_id: Uuid::new_v4(),
            occurrences: HashMap::new(),
            grant: None,
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
    /// not allow, before any network call.
    pub async fn invoke(&self, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        let grant = self
            .grant
            .as_ref()
            .filter(|grant| grant.allowed.contains(&call.function))
            .ok_or_else(|| ProtectedCallError::NotAdmitted(call.function.clone()))?;
        let policy = grant.policy.as_ref().ok_or(ProtectedCallError::NoClient)?;
        let session = grant.session_token.as_deref().ok_or(ProtectedCallError::NoSession)?;
        policy.invoke(session, call).await
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
        let exec = ExecContext::new(Identity::default());
        let call = ProtectedCall {
            function: "items.save".into(),
            op: "save".into(),
            payload: Json::Null,
            occurrence_id: "n1.0".into(),
        };
        assert!(matches!(exec.invoke(&call).await, Err(ProtectedCallError::NotAdmitted(f)) if f == "items.save"));
    }
}
