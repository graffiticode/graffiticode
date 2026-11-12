// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0176 (`@graffiticode/l0176`).
//!
//! `conformance/cases.json` holds programs parsed with L0176's lexicon — every program in the
//! spec, the TypeScript suite's, and hand-written ones — with the result the TypeScript
//! compiler gave. Every case must produce the same JSON text here (field order included), or
//! fail with the same errors. Both are compiled with no policy client, so a preview comes back
//! unsigned and a save is skipped. Regenerate with `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0176::L0176;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    /// The compiled value as JSON text, masked; absent for an undefined value.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

/// What differs on every compile of the TypeScript: UUIDs, and a dynamic-content table's
/// timestamped references. The generator masks the TypeScript output the same way. An
/// activity's own `data.id` and `data.session_id` are compared field by field instead
/// ([`activity_fields`]).
fn mask(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |at: usize, len: usize| {
        bytes.get(at..at + len).is_some_and(|run| run.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    };
    let digits = |at: usize, len: usize| bytes.get(at..at + len).is_some_and(|run| run.iter().all(u8::is_ascii_digit));
    let at = |at: usize, byte: u8| bytes.get(at) == Some(&byte);
    let uuid = |i: usize| {
        hex(i, 8)
            && at(i + 8, b'-')
            && hex(i + 9, 4)
            && at(i + 13, b'-')
            && at(i + 14, b'4')
            && hex(i + 15, 3)
            && at(i + 18, b'-')
            && bytes.get(i + 19).is_some_and(|b| matches!(b, b'8' | b'9' | b'a' | b'b'))
            && hex(i + 20, 3)
            && at(i + 23, b'-')
            && hex(i + 24, 12)
    };
    let stamp = |i: usize| {
        bytes[i..].starts_with(b"graffiticode-")
            && digits(i + 13, 4)
            && at(i + 17, b'-')
            && digits(i + 18, 2)
            && at(i + 20, b'-')
            && digits(i + 21, 2)
            && at(i + 23, b'T')
            && digits(i + 24, 9)
            && at(i + 33, b'Z')
    };
    // Since C6 this implementation keys a dynamic-content table by its digest, not the time
    // (`graffiticode-<16 hex>-row-<i>`), so a retried save sends the same payload. The TypeScript
    // one still uses the time. Both are masked alike; what follows them is still compared.
    let digest =
        |i: usize| bytes[i..].starts_with(b"graffiticode-") && hex(i + 13, 16) && bytes[i + 29..].starts_with(b"-row-");
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if uuid(i) {
            out.push_str("<uuid>");
            i += 36;
        } else if stamp(i) {
            out.push_str("graffiticode-<time>");
            i += 34;
        } else if digest(i) {
            out.push_str("graffiticode-<time>");
            i += 29;
        } else {
            let c = text[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// A generated activity id here: `graffiticode-<16 hex>` of the activity's unsigned content.
fn is_generated_id(json: &Json) -> bool {
    json.as_str()
        .and_then(|id| id.strip_prefix("graffiticode-"))
        .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// The two activity fields this implementation deliberately changed (C6 part 2, decision 3),
/// compared field by field rather than masked. Where the TypeScript activity's `data.id` is a
/// random UUID, the one here must be generated from the content, and both become `<generated>`;
/// an explicit id must be equal. The TypeScript activity has a random `data.session_id`; the one
/// here must have none (Broker sets the signed request's own), so the TypeScript's is dropped.
/// What the expected side must lose is checked, not assumed: a mismatch is left in place.
fn activity_fields(expected: &mut Json, actual: &mut Json) {
    let is_activity = |json: &Json| {
        json.get("type").is_some_and(|kind| kind == "questions" || kind == "items") && json["data"].is_object()
    };
    if is_activity(expected) && is_activity(actual) {
        let (want, got) = (expected["data"].as_object_mut().unwrap(), actual["data"].as_object_mut().unwrap());
        if want.get("session_id").is_some_and(|id| id == "<uuid>") && !got.contains_key("session_id") {
            want.remove("session_id");
        }
        if want.get("id").is_some_and(|id| id == "<uuid>") {
            want.insert("id".into(), json!("<generated>"));
            if got.get("id").is_some_and(is_generated_id) {
                got.insert("id".into(), json!("<generated>"));
            }
        }
    }
    match (expected, actual) {
        (Json::Object(want), Json::Object(got)) => {
            for (key, want) in want.iter_mut() {
                if let Some(got) = got.get_mut(key) {
                    activity_fields(want, got);
                }
            }
        }
        (Json::Array(want), Json::Array(got)) => {
            want.iter_mut().zip(got.iter_mut()).for_each(|(want, got)| activity_fields(want, got))
        }
        _ => {}
    }
}

#[test]
fn activity_ids_and_sessions_are_compared_field_by_field() {
    let compare = |expected: Json, actual: Json| {
        let (mut expected, mut actual) = (expected, actual);
        activity_fields(&mut expected, &mut actual);
        expected == actual
    };
    let ts = json!({ "type": "questions", "data": { "id": "<uuid>", "name": "Test", "session_id": "<uuid>" } });
    let rust = json!({ "type": "questions", "data": { "id": "graffiticode-0123456789abcdef", "name": "Test" } });
    assert!(compare(ts.clone(), rust));
    // A random id here, a session id kept, or an id that isn't the digest form all disagree.
    assert!(!compare(ts.clone(), json!({ "type": "questions", "data": { "id": "<uuid>", "name": "Test" } })));
    assert!(!compare(
        ts.clone(),
        json!({ "type": "questions", "data": { "id": "graffiticode-0123456789abcdef", "name": "Test", "session_id": "s" } })
    ));
    assert!(!compare(ts, json!({ "type": "questions", "data": { "id": "graffiticode-xyz", "name": "Test" } })));
    // An explicit id must be equal.
    let ts = json!({ "type": "questions", "data": { "id": "t", "session_id": "<uuid>" } });
    assert!(compare(ts.clone(), json!({ "type": "questions", "data": { "id": "t" } })));
    assert!(!compare(ts, json!({ "type": "questions", "data": { "id": "graffiticode-0123456789abcdef" } })));
}

/// The TypeScript L0176 is built on a published `@graffiticode/l0000` whose unresolved
/// `get-val-*` message ends in the error's coordinates, stringified: `requires a resolved
/// value.[object Object]`. The kernel here, and the TypeScript L0000 since, say it without.
fn kernel_message(message: &str) -> &str {
    message
        .strip_suffix("[object Object]")
        .filter(|message| message.ends_with("requires a resolved value."))
        .unwrap_or(message)
}

#[test]
fn masking_hides_only_what_changes() {
    assert_eq!(
        mask(r#"{"id":"455f8224-8aea-4671-8581-2a6240f036c9","r":"graffiticode-2026-10-14T010203456Z-row-0","t":"t"}"#),
        r#"{"id":"<uuid>","r":"graffiticode-<time>-row-0","t":"t"}"#
    );
    assert_eq!(mask(r#"{"r":"graffiticode-db1ae46d919a4bf5-row-1"}"#), r#"{"r":"graffiticode-<time>-row-1"}"#);
    // An item reference isn't a table key, even with sixteen hex characters.
    assert_eq!(mask(r#"{"r":"graffiticode-db1ae46d919a4bf5-0"}"#), r#"{"r":"graffiticode-db1ae46d919a4bf5-0"}"#);
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// A program whose value is an activity written as a record literal (`{type: "questions" data:
/// …}..`) is signed here, like any other activity. TypeScript leaves it unsigned only because a
/// record literal reaches its `PROG` in its internal representation, whose `type` it cannot
/// see; the same literal under `init`, or arriving as upstream data, it signs.
///
/// An attribute given an undefined value (`stimulus get-var "nope"`) emits `null` here. In
/// TypeScript the field is present but undefined, so it replaces the default and then vanishes
/// from the JSON; a value here is never undefined inside an object.
fn diverges(case: &Case) -> bool {
    case.src.starts_with("{type: \"questions\"") || case.src.contains("get-var \"nope\"")
}

#[tokio::test]
async fn an_undefined_attribute_is_null_not_absent() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    let case = cases.iter().find(|case| case.src.contains("get-var \"nope\"")).unwrap();
    assert!(!case.expect.text.as_deref().unwrap().contains("stimulus"), "TypeScript drops it");
    let value = Compiler::new(L0176::new()).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    assert_eq!(value.result.unwrap().to_json().unwrap()["data"]["questions"][0]["stimulus"], Json::Null);
}

#[tokio::test]
async fn an_activity_written_as_a_literal_is_signed_too() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    let case = cases.iter().find(|case| case.src == "{type: \"questions\" data: {questions: []}}..").unwrap();
    let value = Compiler::new(L0176::new()).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    assert_eq!(value.result.unwrap().to_json().unwrap()["signing"]["unsigned"], "not-configured");
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 200, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0176::new());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let mut actual: Option<Json> =
                    value.to_json().map(|json| serde_json::from_str(&mask(&json.to_string())).unwrap());
                let mut expected: Option<Json> =
                    case.expect.text.as_deref().map(|text| serde_json::from_str(text).unwrap());
                if let (Some(expected), Some(actual)) = (&mut expected, &mut actual) {
                    activity_fields(expected, actual);
                }
                let text = actual.map(|json| json.to_string());
                if text != expected.map(|json| json.to_string()) {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {}",
                        case.expect.text.as_deref().unwrap_or("nothing"),
                        text.as_deref().unwrap_or("nothing")
                    ));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
                let expected: Vec<&str> = expected.iter().map(|message| kernel_message(message)).collect();
                if said != expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {said:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(value)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {:?}", value.to_json()))
            }
        }
    }
    let total = failures.len();
    failures.truncate(8);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}

#[test]
fn the_published_lexicon_never_advertises_a_retired_spelling() {
    let lexicon = graffiticode_l0176::lexicon();
    for word in graffiticode_l0176::DEPRECATED_WORDS {
        assert!(lexicon.get(word).is_none(), "{word} is retired and must not be served");
    }
    // The current spelling stays.
    assert_eq!(lexicon.get("token-highlight").map(|e| e.name.as_str()), Some("TOKEN_HIGHLIGHT"));
}
