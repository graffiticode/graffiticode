// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0010 (`@graffiticode/l0010`).
//!
//! `conformance/cases.json` holds programs parsed with L0010's lexicon, each compiled against
//! two upstream inputs, with the result the TypeScript compiler gave. Every case must produce
//! the same data here, or fail with the same errors. Regenerate with
//! `npm run fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0010::L0010;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    data: Json,
    ast: Json,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    /// Absent when the program's value is undefined, which is not the same as `null`.
    #[serde(default, deserialize_with = "present")]
    data: Option<Json>,
    errors: Option<Vec<String>>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Json>, D::Error> {
    Json::deserialize(deserializer).map(Some)
}

/// Where this implementation deliberately differs from the TypeScript one.
fn divergence(case: &Case) -> Option<&'static [&'static str]> {
    match case.src.as_str() {
        // TypeScript accepts a plan that is a number and evaluates it to no languages at all.
        // A plan must be a list of language ids, as `plan "0158"` is already told.
        "plan 158.." => Some(&["plan: each element must be a language id string."]),
        _ => None,
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 70, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0010);
    let mut failures = Vec::new();
    for case in &cases {
        let actual = compiler.compile(&case.ast, &case.data, &json!({}), Identity::default()).await.result;
        let label = format!("{} (data {})", case.src, case.data);
        if let Some(expected) = divergence(case) {
            let said: Vec<&str> = actual.as_ref().err().into_iter().flatten().map(|e| e.message.as_str()).collect();
            if said != expected {
                failures.push(format!("{label}\n  divergence expected errors {expected:?}\n  got {actual:?}"));
            }
            continue;
        }
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let value = value.to_json();
                if value != case.expect.data {
                    failures.push(format!("{label}\n  expected {:?}\n  got      {value:?}", case.expect.data));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
                let expected: Vec<&str> = expected.iter().map(String::as_str).collect();
                if said != expected {
                    failures.push(format!("{label}\n  expected errors {expected:?}\n  got {errors:?}"));
                }
            }
            (None, Err(errors)) => {
                failures.push(format!("{label}\n  expected {:?}\n  got errors {errors:?}", case.expect.data))
            }
            (Some(expected), Ok(value)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {:?}", value.to_json()))
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} cases disagree:\n\n{}", failures.len(), cases.len(), failures.join("\n\n"));
}
