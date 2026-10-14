// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0181 (`@graffiticode/l0181`).
//!
//! `conformance/cases.json` holds programs parsed with L0181's lexicon — generated ones (every
//! word given every kind of value, in and out of the positions the Checker walks; decks of
//! every shape; upstream data merged over every kind of result), the spec's, the TypeScript
//! suite's, and hand-written ones — with the upstream data they were compiled against and the
//! result the TypeScript compiler gave. Every case must produce the same JSON text here (key
//! order included), or fail with the same errors in the same order. Regenerate with
//! `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0181::L0181;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    #[serde(default)]
    data: Option<Json>,
    ast: Json,
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

async fn compile(case: &Case) -> Result<Option<String>, Vec<String>> {
    let data = case.data.clone().unwrap_or_else(|| json!({}));
    let compiled = Compiler::new(L0181).compile(&case.ast, &data, &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json().map(|json| json.to_string())),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

/// Where this implementation deliberately differs from the TypeScript one; each has its own
/// test below.
fn diverges(case: &Case) -> bool {
    [EXACT_NUMBER, ADD_A_RECORD, MAPPED_ERROR].contains(&case.src.as_str()) || enveloped(case)
}

/// Upstream data that is a compile's `{data, errors}` envelope. The TypeScript merges the
/// envelope itself (`data` and `errors` become fields); the kernel unwraps it, as it does for
/// every Rust language, and merges what it carries.
fn enveloped(case: &Case) -> bool {
    case.data.as_ref().is_some_and(|data| data.get("errors").is_some_and(Json::is_array))
}

#[tokio::test]
async fn an_upstream_envelope_is_unwrapped() {
    let cases = cases();
    let enveloped: Vec<&Case> = cases.iter().filter(|case| enveloped(case)).collect();
    assert!(!enveloped.is_empty());
    for case in enveloped {
        let actual = compile(case).await.unwrap();
        let expected = case.expect.text.as_deref();
        if case.src.starts_with('{') || case.src.starts_with("cards") || case.src.starts_with("DARK") {
            let (expected, actual) = (expected.unwrap(), actual.unwrap());
            assert!(expected.ends_with(r#","data":{"response":1},"errors":[]}"#), "{expected}");
            assert!(actual.ends_with(r#","response":1}"#), "{actual}");
            assert!(!actual.contains("errors"));
        } else {
            // Not an object: nothing merges, either way.
            assert_eq!(actual.as_deref(), expected);
        }
    }
}

/// A number no `f64` holds is a `Decimal` object in TypeScript, and `PROG` spreads every
/// object it ends with, so the program's value is the `Decimal`'s internals. Here it is the
/// number.
const EXACT_NUMBER: &str = "12345678901234567890..";

/// L0000's `add` given a record: the TypeScript passes decimal.js's own message through, the
/// kernel says what it got.
const ADD_A_RECORD: &str = "add 1 title 3 {}..";

/// TypeScript's `LAMBDA` reports its body's errors twice when it is applied; the kernel once.
const MAPPED_ERROR: &str = "map (<x: title 3 x>) [{}]..";

fn case(src: &str) -> Case {
    cases().into_iter().find(|case| case.src == src).unwrap()
}

#[tokio::test]
async fn an_exact_number_is_a_number_not_a_decimals_internals() {
    let case = case(EXACT_NUMBER);
    assert_eq!(case.expect.text.as_deref(), Some(r#"{"s":1,"e":19,"d":[123456,7890123,4567890]}"#));
    assert_eq!(compile(&case).await.unwrap().as_deref(), Some("12345678901234567000"));
}

#[tokio::test]
async fn adding_a_record_says_what_it_got() {
    let case = case(ADD_A_RECORD);
    let title = r#"title: expected a string, e.g. title "Spanish Vocab". Got 3."#;
    let expected = case.expect.errors.as_deref().unwrap();
    assert_eq!(expected, [title, "Error in ADD operation: [DecimalError] Invalid argument: [object Object]"]);
    assert_eq!(compile(&case).await.unwrap_err(), [title, "Error in ADD operation: expected a number, got a record"]);
}

#[tokio::test]
async fn an_error_in_an_applied_function_is_reported_once() {
    let case = case(MAPPED_ERROR);
    let title = r#"title: expected a string, e.g. title "Spanish Vocab". Got 3."#;
    assert_eq!(case.expect.errors.as_deref().unwrap(), [title, title]);
    assert_eq!(compile(&case).await.unwrap_err(), [title]);
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 400, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        let label = match &case.data {
            Some(data) => format!("{label}  (data {data})"),
            None => label,
        };
        match (&case.expect.errors, &actual) {
            (None, Ok(text)) => {
                if *text != case.expect.text {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {}",
                        case.expect.text.as_deref().unwrap_or("nothing"),
                        text.as_deref().unwrap_or("nothing")
                    ));
                }
            }
            (Some(expected), Err(said)) => {
                if said != expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {said:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(text)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {text:?}"))
            }
        }
    }
    let total = failures.len();
    failures.truncate(12);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
