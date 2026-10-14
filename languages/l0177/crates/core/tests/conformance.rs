// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0177 (`@graffiticode/l0177`).
//!
//! `conformance/cases.json` holds programs parsed with L0177's lexicon — designs generated from
//! the vocabulary, the spec's, the TypeScript suite's, and hand-written ones — with the result
//! the TypeScript compiler gave. Every case must produce the same JSON text here (field order,
//! warning order and recorded paths included), or fail with the same errors. Regenerate with
//! `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0177::L0177;
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
    /// The compiled value as JSON text; absent for an undefined value.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// A property given an undefined value (`domain get-var "nope"`) is kept as `null` here, so
/// the design shows `"domain": null`; in TypeScript the field holds `undefined` and vanishes
/// from the JSON. The warnings are the same.
fn diverges(case: &Case) -> bool {
    case.src.contains("get-var \"nope\"")
}

#[tokio::test]
async fn a_property_given_nothing_is_null_not_absent() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    let case = cases.iter().find(|case| diverges(case)).unwrap();
    let expected: Json = serde_json::from_str(case.expect.text.as_deref().unwrap()).unwrap();
    let actual = Compiler::new(L0177).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    let actual = actual.result.unwrap().to_json().unwrap();
    assert_eq!(expected.get("domain"), None);
    assert_eq!(actual["domain"], Json::Null);
    assert_eq!(actual["warnings"], expected["warnings"]);
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 90, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0177);
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
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
    failures.truncate(8);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
