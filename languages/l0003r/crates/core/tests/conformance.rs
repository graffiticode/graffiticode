// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0003 (`@graffiticode/l0003`).
//!
//! `conformance/cases.json` holds programs parsed with L0003's lexicon, each compiled against
//! several upstream inputs, with the result the TypeScript compiler gave. Every case must
//! produce the same data here, or fail where it failed there. Regenerate with
//! `npm run fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0003::L0003;
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

/// The check errors say what was expected in the same words as TypeScript, and what was found
/// in clearer ones (TypeScript reports a string as "tag dark" and a number as "NUM").
fn comparable(message: &str) -> &str {
    message.split_once(" Got ").map_or(message, |(expected, _)| expected)
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 100, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0003);
    let mut failures = Vec::new();
    for case in &cases {
        let actual = compiler.compile(&case.ast, &case.data, &json!({}), Identity::default()).await.result;
        let label = format!("{} (data {})", case.src, case.data);
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let value = value.to_json();
                if value != case.expect.data {
                    failures.push(format!("{label}\n  expected {:?}\n  got      {value:?}", case.expect.data));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| comparable(&e.message)).collect();
                let expected: Vec<&str> = expected.iter().map(|m| comparable(m)).collect();
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
