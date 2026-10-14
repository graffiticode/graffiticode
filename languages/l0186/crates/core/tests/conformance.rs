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

/// Where this implementation deliberately differs from the TypeScript one.
fn diverges(case: &Case) -> bool {
    huge_integer(case)
}

/// An integer above 2^53 − 1 in the output is written as the kernel's JSON writer (serde's)
/// writes an `f64`: `9007199254740992.0`, `1e+20`, `1.2345678901234568e+20`, where JavaScript
/// writes `9007199254740992`, `100000000000000000000`, `123456789012345680000`. The value is
/// the same. This is L0000's serialization (`Value::to_json`), shared by every Rust language,
/// not L0186's; a message L0186 writes prints JavaScript's form.
fn huge_integer(case: &Case) -> bool {
    case.expect.text.is_some()
        && (case.src.contains("100000000000000000000") || case.src.contains(": 123456789012345678901}"))
}

async fn compile(case: &Case) -> Result<Json, Vec<String>> {
    let compiled = Compiler::new(L0186).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json().unwrap_or(Json::Null)),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

/// Every number as an `f64`, so values compare whatever form they were written in.
fn as_floats(json: Json) -> Json {
    match json {
        Json::Number(n) => json!(n.as_f64().unwrap()),
        Json::Array(items) => Json::Array(items.into_iter().map(as_floats).collect()),
        Json::Object(object) => Json::Object(object.into_iter().map(|(k, v)| (k, as_floats(v))).collect()),
        other => other,
    }
}

#[tokio::test]
async fn a_huge_integer_is_written_as_an_f64() {
    let cases = cases();
    let diverging: Vec<&Case> = cases.iter().filter(|case| huge_integer(case)).collect();
    assert_eq!(diverging.len(), 4);
    for case in diverging {
        let expected = case.expect.text.as_deref().unwrap();
        let actual = compile(case).await.unwrap();
        // The same values, fields and order: only the digits are written differently.
        assert_eq!(as_floats(serde_json::from_str::<Json>(expected).unwrap()), as_floats(actual.clone()));
        let actual = actual.to_string();
        let pairs: &[(&str, &str)] = if case.src.contains("100000000000000000000") {
            &[("100000000000000000000", "1e+20"), ("\"y\":9007199254740992}", "\"y\":9007199254740992.0}")]
        } else {
            &[("123456789012345680000", "1.2345678901234568e+20")]
        };
        for (ts, rust) in pairs {
            assert!(expected.contains(ts) && actual.contains(rust), "{expected}\n{actual}");
        }
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 3000, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = Some(value.to_string());
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
