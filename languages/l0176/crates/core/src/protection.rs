// SPDX-License-Identifier: MIT

//! L0176's brokered path. Every Learnosity authority — signing a preview, writing to the item
//! bank — is exercised by the credential broker under a token policy mints for exactly that
//! request. The compiler holds no Learnosity secret.
//!
//! - A compile that **selects a connection** is admitted by policy before it runs, and signs
//!   and saves through that connection ([`sign`], [`save`]).
//! - A compile **without one** writes nothing (a save is reported as skipped) and signs its
//!   preview through a **system session** policy issues on a Graffiticode-owned connection,
//!   confined to `init` ([`sign_preview`]). With no session to be had, the preview goes out
//!   unsigned with a reason: `signing: { unsigned, message }`, not a compile error.
//!
//! These declarations drive early admission only. Authority is decided by policy and the
//! broker from the reviewed registry (the monorepo's `packages/common` protected registry);
//! disagreeing with it can only cause refusals, never extra authority.

use graffiticode_l0000::{
    Diagnostic, ExecContext, ProtectedCall, ProtectedCallError, ProtectedFunction, ProtectedKind, SystemSessionRefusal,
};
use serde_json::{Value as Json, json};

use crate::plain::Object;

/// The registry version these declarations were written for. A plan pins it, and policy
/// refuses a stage that reports another.
pub const REGISTRY_VERSION: u32 = 8;

pub const SIGN: &str = "init";
pub const SAVE: &str = "save-to-itembank";

/// The protected words, by node tag.
pub fn protected_functions() -> Vec<(String, ProtectedFunction)> {
    vec![
        ("INIT".to_owned(), ProtectedFunction::new(SIGN, ProtectedKind::Sign)),
        ("SAVE_TO_ITEMBANK".to_owned(), ProtectedFunction::new(SAVE, ProtectedKind::Write)),
    ]
}

/// Every render is signed, so every brokered compile needs `init`.
pub fn implicit_protected_functions() -> Vec<ProtectedFunction> {
    vec![ProtectedFunction::new(SIGN, ProtectedKind::Sign)]
}

/// The fields a preview may carry to the broker, which refuses anything else.
const PREVIEW_KEYS: &[&str] = &["id", "name", "questions", "session_id", "dynamic_content_data"];

/// What an uncertain write tells its caller: it may or may not have landed, and running it
/// again is the caller's decision.
const UNCERTAIN_GUIDANCE: &str = " — it may or may not have been written. Check the item bank; to save again anyway, rerun with a new idempotency key (the write may repeat).";

/// Whether this compile signs and saves through a connection: it selected one and admission
/// gave it a session. A system session never counts: it has no connection.
pub fn is_brokered(exec: &ExecContext) -> bool {
    exec.connection_id().is_some() && exec.has_session()
}

/// A protected call that did not succeed, with what the caller needs beside the message.
#[derive(Debug, Default)]
pub struct Failure {
    pub message: String,
    pub code: Option<String>,
    pub category: Option<String>,
    pub function: Option<String>,
    pub step: Option<String>,
}

impl Failure {
    fn refused(error: &ProtectedCallError, function: &str) -> Self {
        Failure {
            message: error.to_string(),
            code: error.reason().map(str::to_owned),
            category: error.category().map(str::to_owned),
            function: Some(function.to_owned()),
            step: None,
        }
    }

    /// The compile error: the message, with its code, category, stage, function and step.
    pub fn diagnostic(self, exec: &ExecContext) -> Diagnostic {
        Diagnostic {
            code: self.code,
            category: self.category,
            stage: exec.stage().map(str::to_owned),
            function: self.function,
            step: self.step,
            ..Diagnostic::new(format!("Error: {}", self.message))
        }
    }

    /// Policy's or the broker's reason, for an unsigned preview.
    fn reason(&self) -> Option<String> {
        self.code.clone()
    }
}

fn text(json: &Json, field: &str) -> Option<String> {
    json[field].as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}

/// The broker's result, or why it did not succeed.
fn succeeded(outcome: Json, what: &str, function: &str) -> Result<Json, Failure> {
    if outcome["status"] == "succeeded" {
        return Ok(outcome["result"].clone());
    }
    let status = outcome["status"].as_str().unwrap_or("failed");
    let detail = outcome["error"].as_str().map(|error| format!(": {error}")).unwrap_or_default();
    let guidance = if status == "uncertain" { UNCERTAIN_GUIDANCE } else { "" };
    Err(Failure {
        message: format!("{what} {status}{detail}{guidance}"),
        code: text(&outcome, "reason"),
        category: text(&outcome, "category"),
        function: Some(function.to_owned()),
        step: text(&outcome, "failedStep"),
    })
}

/// Signs a `{type, data}` activity through the broker: the signed request, or `None` for a
/// value that is not a Learnosity activity.
pub async fn sign(exec: &mut ExecContext, activity: &Object, key: &str) -> Result<Option<Json>, Failure> {
    let op = match activity.get("type").and_then(Json::as_str) {
        Some("questions") => "learnosity.sign-questions-preview",
        Some("items") => "learnosity.sign-items-preview",
        _ => return Ok(None),
    };
    let data = activity.get("data");
    let payload: Object = PREVIEW_KEYS
        .iter()
        .filter_map(|field| data.and_then(|data| data.get(*field)).map(|value| ((*field).to_owned(), value.clone())))
        .collect();
    let call = ProtectedCall {
        function: SIGN.to_owned(),
        op: op.to_owned(),
        payload: Json::Object(payload),
        occurrence_id: exec.next_occurrence(key),
    };
    let outcome = exec.invoke(&call).await.map_err(|error| Failure::refused(&error, SIGN))?;
    Ok(Some(succeeded(outcome, "Learnosity signing", SIGN)?["request"].clone()))
}

/// Writes a save plan through the broker. A retry of the same invocation returns the recorded
/// outcome rather than writing again; an uncertain or partial save is reported, never re-run.
pub async fn save(exec: &mut ExecContext, plan: &Json, key: &str) -> Result<Json, Failure> {
    let call = ProtectedCall {
        function: SAVE.to_owned(),
        op: "learnosity.write-items".to_owned(),
        payload: plan.clone(),
        occurrence_id: exec.next_occurrence(key),
    };
    let outcome = match exec.invoke(&call).await {
        Ok(outcome) => outcome,
        // The broker was asked to write and its answer was lost: as uncertain as an uncertain
        // outcome, and said the same way.
        Err(error) if error.effect_unknown() => {
            return Err(Failure {
                message: format!("Item bank save uncertain: {error}{UNCERTAIN_GUIDANCE}"),
                function: Some(SAVE.to_owned()),
                ..Failure::default()
            });
        }
        Err(error) => return Err(Failure::refused(&error, SAVE)),
    };
    let replayed = outcome["replayed"] == true;
    let mut result = succeeded(outcome, "Item bank save", SAVE)?;
    if replayed && let Json::Object(result) = &mut result {
        result.insert("replayed".into(), json!(true));
    }
    Ok(result)
}

/// Why a preview went out unsigned: reported beside the activity, never as a compile error.
fn unsigned(kind: &str, reason: Option<String>) -> Json {
    let message = match kind {
        "not-configured" => {
            "Preview not signed: this server has no system preview signing configured. Select a Learnosity connection to sign it."
        }
        "unavailable" => {
            "Preview not signed: no system preview session is available. Select a Learnosity connection to sign it."
        }
        _ => "Preview not signed: the system preview signing failed. Select a Learnosity connection to sign it.",
    };
    let reason = reason.map(|reason| format!(" ({reason})")).unwrap_or_default();
    json!({ "unsigned": kind, "message": format!("{message}{reason}") })
}

/// Signs a questions or items preview for a compile with no connection, through a system
/// session: the activity with its `request`, or with `signing: { unsigned, message }`.
pub async fn sign_preview(exec: &mut ExecContext, lang_id: &str, activity: Object, key: &str) -> Object {
    let with = |mut activity: Object, field: &str, value: Json| {
        activity.insert(field.to_owned(), value);
        activity
    };
    match exec.open_system_session(lang_id, SIGN).await {
        Err(SystemSessionRefusal::NotConfigured) => return with(activity, "signing", unsigned("not-configured", None)),
        Err(SystemSessionRefusal::Unavailable(reason)) => {
            return with(activity, "signing", unsigned("unavailable", reason));
        }
        Ok(()) => {}
    }
    match sign(exec, &activity, key).await {
        Ok(Some(request)) if !request.is_null() => with(activity, "request", request),
        Ok(_) => activity,
        Err(failure) => with(activity, "signing", unsigned("signing-failed", failure.reason())),
    }
}
