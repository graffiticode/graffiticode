// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0186 (`@graffiticode/l0186`).
//!
//! `conformance/cases.json` holds programs parsed with L0186's lexicon — generated from the
//! vocabulary (every word with good and wrong values, in and out of place), the spec's, the
//! TypeScript suite's, and hand-written ones — with the result the TypeScript compiler gave.
//! Every case must produce the same JSON text here (field order included), or fail with the
//! same error messages in the same order. Regenerate with `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0186::L0186;
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

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

async fn compile(case: &Case) -> Result<Json, Vec<String>> {
    let compiled = Compiler::new(L0186).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json().unwrap_or(Json::Null)),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 3000, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = Some(graffiticode_l0000::json_text(value));
                if text != case.expect.text {
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
            (Some(expected), Ok(value)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {value}"))
            }
        }
    }
    let total = failures.len();
    failures.truncate(12);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
