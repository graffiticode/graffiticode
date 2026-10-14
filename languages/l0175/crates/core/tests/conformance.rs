// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0175 (`@graffiticode/l0175`).
//!
//! `conformance/cases.json` holds programs parsed with L0175's lexicon, each compiled against
//! two upstream inputs, with the result the TypeScript compiler gave. Every case must produce
//! the same JSON text here, or fail with the same errors. Regenerate with
//! `npm run fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0175::L0175;
use serde::Deserialize;
use serde_json::{Value as Json, json};

/// The first place two texts differ, with some of what surrounds it.
fn show(text: &Option<String>) -> String {
    text.clone().unwrap_or_else(|| "nothing".to_owned())
}

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    /// The compiled value as JSON text. The text is compared, not the value, so that the
    /// order of an item's fields is held too.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// A chain normally ends in `{}`. If it ends in a record literal with fields, TypeScript does
/// not see them: it builds on the literal's internal representation, where its fields are not
/// properties. Here a record is a record, so `claim id "c1" {text: "…"}` has its text.
fn diverges(case: &Case) -> bool {
    case.src.contains(r#"{text: "From a literal."}"#)
}

#[tokio::test]
async fn a_chain_may_end_in_a_record_literal() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    let case = cases.iter().find(|case| diverges(case)).expect("the fixture has the case");
    assert_eq!(
        case.expect.errors.as_deref(),
        Some(&["claim 'c1': missing text.".to_owned()][..]),
        "TypeScript does not see the field"
    );
    let item =
        Compiler::new(L0175).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result.unwrap();
    assert_eq!(item.to_json().unwrap()["review"]["correctClaim"], json!({ "id": "c1", "text": "From a literal." }));
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 250, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0175);
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = value.to_json().map(|json| json.to_string());
                if text != case.expect.text {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {}",
                        show(&case.expect.text),
                        show(&text)
                    ));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
                let expected: Vec<&str> = expected.iter().map(String::as_str).collect();
                if said != expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {said:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(_)) => failures.push(format!("{label}\n  expected errors {expected:?}\n  got a value")),
        }
    }
    failures.truncate(6);
    assert!(failures.is_empty(), "{} of {} cases disagree:\n\n{}", failures.len(), cases.len(), failures.join("\n\n"));
}
