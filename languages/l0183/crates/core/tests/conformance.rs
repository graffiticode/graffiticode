// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0183 (`@graffiticode/l0183`).
//!
//! `conformance/cases.json` holds programs parsed with L0183's lexicon — every word of the
//! vocabulary tables written in every description and settings record with values of every
//! kind, webs of every size with blanks, distractors, labelled and assessed edges and pools,
//! the spec's programs, the TypeScript suite's, the learner's answers carried in upstream data,
//! and hand-written ones — with the result the TypeScript compiler gave. Every case must
//! produce the same JSON text here (field order included), or fail with the same errors.
//! Regenerate with `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0183::L0183;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    /// The upstream data the case was compiled with; `{}` when absent.
    data: Option<Json>,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    /// The compiled value as JSON text; absent for an undefined value.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

async fn compile(case: &Case) -> Result<graffiticode_l0000::Value, Vec<graffiticode_l0000::Diagnostic>> {
    let data = case.data.clone().unwrap_or_else(|| json!({}));
    Compiler::new(L0183).compile(&case.ast, &data, &json!({}), Identity::default()).await.result
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// - A program whose value is a record literal shaped like a compiled web
///   (`{interaction: {type: "concept-web"}}..`) is that record here; in TypeScript a record
///   literal reaches `PROG` in L0000's internal representation, its fields unread, and is
///   refused.
/// - An undefined value (`get-var "nope"`) inside a list is `null` here, as everywhere in the
///   Rust kernel, so `assess [get-var "nope"]` is refused with "Got null." where TypeScript
///   says "Got nothing.".
/// - A record literal's field given an undefined value is absent here, so
///   `node text "B" {a: get-var "nope"}` compiles; TypeScript keeps the key and refuses `a`. (A
///   setting given nothing, `{title: get-var "nope"}`, is dropped by both.)
const A_WEB_LITERAL: &str = "{interaction:";
const UNDEFINED_IN_A_LIST: &str = "assess [get-var \"nope\"]";
const UNDEFINED_FIELD: &str = "{a: get-var \"nope\"}";

fn diverges(case: &Case) -> bool {
    case.src.starts_with(A_WEB_LITERAL) || case.src.contains(UNDEFINED_IN_A_LIST) || case.src.contains(UNDEFINED_FIELD)
}

fn find<'a>(cases: &'a [Case], needle: &str) -> &'a Case {
    cases.iter().find(|case| case.src.contains(needle)).unwrap()
}

#[tokio::test]
async fn a_record_literal_shaped_like_a_web_is_read_as_one() {
    let cases = cases();
    let case = find(&cases, A_WEB_LITERAL);
    assert!(case.expect.errors.as_ref().unwrap()[0].starts_with("A program is one concept web"));
    let value = compile(case).await.unwrap();
    assert_eq!(value.to_json().unwrap()["interaction"]["type"], "concept-web");
}

#[tokio::test]
async fn undefined_in_a_list_is_null() {
    let cases = cases();
    let case = find(&cases, UNDEFINED_IN_A_LIST);
    let expected = &case.expect.errors.as_ref().unwrap()[0];
    assert!(expected.ends_with("Got nothing."));
    let errors = compile(case).await.unwrap_err();
    assert_eq!(errors[0].message, expected.replace("Got nothing.", "Got null."));
}

#[tokio::test]
async fn a_field_given_nothing_is_absent() {
    let cases = cases();
    let case = find(&cases, UNDEFINED_FIELD);
    assert!(case.expect.errors.as_ref().unwrap()[0].starts_with("node 1: `a` is not part of node."));
    let value = compile(case).await.unwrap().to_json().unwrap();
    assert_eq!(value["interaction"]["nodes"][0], json!({ "id": "n1", "text": "B" }));
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 1500, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        let label = match &case.data {
            Some(data) => format!("{label}\n  with data {data}"),
            None => label,
        };
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = value.to_json().map(|json| json.to_string());
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
                if said != *expected {
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
    failures.truncate(12);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
