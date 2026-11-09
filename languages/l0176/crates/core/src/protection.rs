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
/// The operation a save performs (the protected registry's `learnosity.write-items`).
pub const SAVE_OP: &str = "learnosity.write-items";
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

const NOT_AN_ACTIVITY: &str = "Error: init signs a Learnosity activity, `{ type: \"questions\" | \"items\", data: { questions, ... } }`; it was given ";

/// The message for the system signing limits: Policy's per-instance mint bucket refuses
/// `rate-limited`, Broker's per-session allowance `session-exhausted`. The View shows the same
/// words for the api's 429.
pub const BUSY_MESSAGE: &str = "Previews are busy right now; try again in a moment.";

/// Broker's `isRef`: an id of `[A-Za-z0-9_.:-]`, 1 to 250 characters.
fn is_ref(json: &Json) -> bool {
    json.as_str().is_some_and(|text| {
        (1..=250).contains(&text.len())
            && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    })
}

/// A value as `init`'s refusal names it.
fn describe_value(json: Option<&Json>) -> String {
    match json {
        None => "nothing".to_owned(),
        Some(Json::Null) => "null".to_owned(),
        Some(Json::Array(_)) => "a list".to_owned(),
        Some(Json::Bool(_)) => "a boolean".to_owned(),
        Some(Json::Number(_)) => "a number".to_owned(),
        Some(Json::String(_)) => "a string".to_owned(),
        Some(Json::Object(object)) => match object.get("type") {
            Some(kind) => format!("a \"{}\" record", crate::plain::js_string(kind)),
            None => "a record with no type (a bare signed request is not an activity)".to_owned(),
        },
    }
}

/// Why `init` can't sign this value, or `None` when it can: exactly what Broker's
/// `validatePreview` accepts, checked here so a refusal is a compile error, not an unsigned
/// preview. Nothing is adapted: a legacy `{ type, reference, data }` question, a bare signed
/// request or any other value is refused.
pub fn activity_refusal(json: Option<&Json>) -> Option<String> {
    let activity = json.and_then(Json::as_object);
    let preview =
        activity.and_then(|activity| activity.get("type")).is_some_and(|kind| kind == "questions" || kind == "items");
    let data = activity.and_then(|activity| activity.get("data")).and_then(Json::as_object);
    let (true, Some(data)) = (preview, data) else {
        return Some(format!("{NOT_AN_ACTIVITY}{}.", describe_value(json)));
    };
    let Some(questions) = data.get("questions").and_then(Json::as_array) else {
        return Some("Error: init: the activity's data.questions must be a list.".to_owned());
    };
    let bad = questions.iter().position(|question| {
        !question.as_object().is_some_and(|question| {
            question.get("type").is_some_and(Json::is_string) && question.get("response_id").is_some_and(is_ref)
        })
    })?;
    Some(format!(
        "Error: init: questions[{bad}] needs a type and response_id. A legacy `{{ type, reference, data }}` question record is not accepted; recompile the program that made it."
    ))
}

/// Removes any signing the activity arrived with: an incoming `request` (signed elsewhere,
/// perhaps for another domain) is never passed through, and a stale `signing` never outlives a
/// new signature. Whether anything was removed.
pub fn without_signing(activity: &mut Object) -> bool {
    let request = activity.remove("request").is_some();
    activity.remove("signing").is_some() || request
}

/// Whether this compile signs and saves through a connection: it selected one and admission
/// gave it a session. A system session never counts: it has no connection.
///
/// A command's `start` (B5, C6) is brokered too: its session, which policy issued for the
/// command's stage, carries the connection's authority, and the gateway sends no connection id.
pub fn is_brokered(exec: &ExecContext) -> bool {
    (exec.connection_id().is_some() || exec.is_command()) && exec.has_session()
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
    pub(crate) fn refused(error: &ProtectedCallError, function: &str) -> Self {
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
///
/// `occurrence_id` is the save's operation within the invocation: `<key>.<N>` for a compile, or
/// a command's expansion of its save intent (C6).
pub async fn save(exec: &mut ExecContext, plan: &Json, occurrence_id: String) -> Result<Json, Failure> {
    let call =
        ProtectedCall { function: SAVE.to_owned(), op: SAVE_OP.to_owned(), payload: plan.clone(), occurrence_id };
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
        "gateway-only" => {
            "Preview not signed: a preview without a connection is signed only through the Graffiticode api. Select a Learnosity connection to sign it."
        }
        "rate-limited" | "session-exhausted" => BUSY_MESSAGE,
        _ => "Preview not signed: the system preview signing failed. Select a Learnosity connection to sign it.",
    };
    let reason = reason.map(|reason| format!(" ({reason})")).unwrap_or_default();
    json!({ "unsigned": kind, "message": format!("{message}{reason}") })
}

/// A refusal as the unsigned preview it becomes: the system signing limits under their own
/// reason, with the busy message; anything else under `fallback`, its reason appended.
fn unsigned_for(fallback: &str, reason: Option<String>) -> Json {
    match reason.as_deref() {
        Some(busy @ ("rate-limited" | "session-exhausted")) => unsigned(busy, None),
        _ => unsigned(fallback, reason),
    }
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
        Err(SystemSessionRefusal::NotPermitted) => return with(activity, "signing", unsigned("gateway-only", None)),
        Err(SystemSessionRefusal::Unavailable(reason)) => {
            return with(activity, "signing", unsigned_for("unavailable", reason));
        }
        Ok(()) => {}
    }
    match sign(exec, &activity, key).await {
        Ok(Some(request)) if !request.is_null() => with(activity, "request", request),
        Ok(_) => activity,
        Err(failure) => with(activity, "signing", unsigned_for("signing-failed", failure.reason())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_names_what_it_was_given_as_typescript_does() {
        let given = |json: Option<Json>| activity_refusal(json.as_ref()).unwrap().replace(NOT_AN_ACTIVITY, "");
        assert_eq!(given(Some(json!(5))), "a number.");
        assert_eq!(given(Some(json!("questions"))), "a string.");
        assert_eq!(given(Some(json!(true))), "a boolean.");
        assert_eq!(given(Some(json!([1, 2]))), "a list.");
        assert_eq!(given(Some(Json::Null)), "null.");
        assert_eq!(given(None), "nothing.");
        assert_eq!(given(Some(json!({ "type": 7 }))), "a \"7\" record.");
    }

    #[test]
    fn a_broker_acceptable_activity_is_not_refused() {
        let activity = json!({ "type": "items", "data": { "questions": [{ "type": "mcq", "response_id": "graffiticode-t-0.a:b_c" }] } });
        assert_eq!(activity_refusal(Some(&activity)), None);
        let long = json!({ "type": "questions", "data": { "questions": [{ "type": "mcq", "response_id": "r".repeat(251) }] } });
        assert!(activity_refusal(Some(&long)).unwrap().contains("questions[0] needs"));
    }

    #[test]
    fn only_the_signing_limits_are_busy() {
        assert_eq!(
            unsigned_for("unavailable", Some("rate-limited".into())),
            json!({ "unsigned": "rate-limited", "message": BUSY_MESSAGE })
        );
        assert_eq!(
            unsigned_for("signing-failed", Some("session-exhausted".into())),
            json!({ "unsigned": "session-exhausted", "message": BUSY_MESSAGE })
        );
        assert_eq!(unsigned_for("unavailable", Some("no-system-connection".into()))["unsigned"], "unavailable");
    }
}
