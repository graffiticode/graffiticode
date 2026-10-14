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

/// What differs on every compile: session and activity ids (UUIDs), and a dynamic-content
/// table's timestamped references. The generator masks the TypeScript output the same way.
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
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if uuid(i) {
            out.push_str("<uuid>");
            i += 36;
        } else if stamp(i) {
            out.push_str("graffiticode-<time>");
            i += 34;
        } else {
            let c = text[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
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
                let text = value.to_json().map(|json| mask(&json.to_string()));
                if text != case.expect.text {
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
