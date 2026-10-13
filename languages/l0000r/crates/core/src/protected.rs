// SPDX-License-Identifier: MIT

//! Admission of protected functions: the early half of delegated API permissions. A protected
//! function is one whose evaluation exercises an external API through a connection. The broker
//! enforces authority at the call; this pass rejects early, so a program is never begun that
//! would have to be abandoned halfway, after earlier external calls had already happened.
//!
//! Coverage for EXPLICIT calls comes from scanning every node in the pool by tag, not from
//! walking the tree. The parser lowers every call of a lexicon function — top level,
//! parenthesized, under a branch, inside a lambda, bound by `let` — to a node carrying that
//! function's tag, so no dialect can skip one. It is conservative: a protected call in dead
//! code is still admitted or refused.
//!
//! The scan does NOT cover protected behavior a dialect performs without a protected node in
//! the source: implicit operations (signing every render, say) and any call constructed at run
//! time. A dialect must declare those as implicit protected functions, which are admitted for
//! every compile of that language.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value as Json;

use crate::ast::Ast;
use crate::dialect::Dialect;
use crate::error::Diagnostic;
use crate::exec::{ExecContext, Grant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectedKind {
    Read,
    Write,
    Sign,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtectedFunction {
    /// The permission key: the stable function name a grant names.
    pub name: String,
    pub kind: ProtectedKind,
}

impl ProtectedFunction {
    pub fn new(name: impl Into<String>, kind: ProtectedKind) -> Self {
        Self { name: name.into(), kind }
    }
}

/// What a dialect asks the broker to do for one protected call.
#[derive(Clone, Debug, PartialEq)]
pub struct ProtectedCall {
    pub function: String,
    pub op: String,
    pub payload: Json,
    /// Stable within the invocation for the same node and ordinal (see
    /// [`ExecContext::next_occurrence`]), so a retried save reproduces the same operation ids.
    pub occurrence_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtectedCallError {
    #[error("{0} was not admitted for this invocation")]
    NotAdmitted(String),
    #[error("no protected-operation client is configured")]
    NoClient,
    #[error("no policy session for this invocation")]
    NoSession,
    #[error("{path} failed ({status})")]
    Rejected { path: String, status: u16, reason: Option<String> },
    #[error("{0}")]
    Transport(String),
}

/// The function names an invocation may call through its connection, and the session that
/// later mints execution tokens for them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolicySnapshot {
    pub allowed: Vec<String>,
    pub session_token: Option<String>,
}

impl PolicySnapshot {
    /// Reads the `allowed` list of a policy response. It is accepted only if it is exactly
    /// well-formed: a malformed list allows nothing, because partially honoring it would let a
    /// corrupted or mismatched response grant whatever valid-looking strings it happens to hold.
    pub fn parse_allowed(response: &Json) -> Option<Vec<String>> {
        response
            .as_object()?
            .get("allowed")?
            .as_array()?
            .iter()
            .map(|name| name.as_str().filter(|name| !name.is_empty()).map(str::to_owned))
            .collect()
    }
}

pub struct SnapshotRequest<'a> {
    pub exec: &'a ExecContext,
    pub lang_id: &'a str,
    pub functions: &'a [String],
}

/// The policy authority and credential broker, as the kernel sees them.
#[async_trait]
pub trait PolicyClient: Send + Sync {
    /// Fetched once per compile, covering every protected function the program contains.
    async fn snapshot(&self, request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError>;

    /// Performs one admitted protected call. A client that only admits leaves this alone.
    async fn invoke(&self, _session_token: &str, _call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        Err(ProtectedCallError::NoClient)
    }
}

/// Decides every protected function before the program runs: one missing from the policy
/// snapshot is an error, so evaluation never begins. A granted function (a write included)
/// then runs whenever the program calls it. The snapshot is fetched once, only when protected
/// functions are present, and fails closed: no policy client, a failed fetch, or a malformed
/// response means nothing is allowed.
pub(crate) async fn admit(
    ast: &Ast,
    dialect: &dyn Dialect,
    policy: Option<&Arc<dyn PolicyClient>>,
    exec: &mut ExecContext,
) -> Vec<Diagnostic> {
    // Implicit operations have no node; they are required by every compile.
    let implicit = dialect.implicit_protected_functions().iter().map(|function| (None, function));
    let explicit = ast.nodes().filter_map(|(id, node)| match node {
        crate::ast::Node::Form { op, .. } => dialect.protected_function(op.tag()).map(|function| (Some(id), function)),
        _ => None,
    });
    let found: Vec<_> = implicit.chain(explicit).collect();
    if found.is_empty() {
        return Vec::new();
    }
    // A write must be visible in the program: an implicit one would run on every compile
    // without the program ever asking for it.
    if let Some((_, function)) =
        found.iter().find(|(id, function)| id.is_none() && function.kind == ProtectedKind::Write)
    {
        return vec![Diagnostic::new(format!("Implicit protected function {} cannot be a write.", function.name))];
    }

    let mut grant = Grant { allowed: HashSet::new(), session_token: None, policy: None };
    // A view of a published item has no user: it carries the publication's invocation token
    // instead, and policy confines it to view-safe functions.
    let has_principal = exec.uid().is_some() || exec.invocation_token().is_some();
    if let Some(policy) = policy
        && exec.connection_id().is_some()
        && has_principal
    {
        let mut functions: Vec<String> = Vec::new();
        for (_, function) in &found {
            if !functions.contains(&function.name) {
                functions.push(function.name.clone());
            }
        }
        let request = SnapshotRequest { exec, lang_id: dialect.lang_id(), functions: &functions };
        match policy.snapshot(request).await {
            Ok(snapshot) => {
                grant.allowed = snapshot.allowed.into_iter().collect();
                grant.session_token = snapshot.session_token;
                grant.policy = Some(Arc::clone(policy));
            }
            Err(err) => {
                tracing::warn!(error = %err, "policy snapshot failed");
                return vec![Diagnostic::new("Permission check is unavailable; protected functions cannot run.")];
            }
        }
    }

    let errors = found
        .iter()
        .filter(|(_, function)| !grant.allowed.contains(&function.name))
        .map(|(id, function)| {
            let message = if exec.connection_id().is_some() {
                format!("{} is not permitted through the selected connection.", function.name)
            } else {
                format!("{} requires a connection that permits it.", function.name)
            };
            Diagnostic::at(message, id.and_then(|id| ast.span(id)))
        })
        .collect();
    exec.set_grant(grant);
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_snapshot_is_all_or_nothing() {
        assert_eq!(
            PolicySnapshot::parse_allowed(&json!({ "allowed": ["a", "b"] })),
            Some(vec!["a".into(), "b".into()])
        );
        assert_eq!(PolicySnapshot::parse_allowed(&json!({ "allowed": [] })), Some(vec![]));
        for malformed in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "allowed": "a" }),
            json!({ "allowed": ["a", 1] }),
            json!({ "allowed": ["a", ""] }),
        ] {
            assert_eq!(PolicySnapshot::parse_allowed(&malformed), None, "{malformed}");
        }
    }
}
