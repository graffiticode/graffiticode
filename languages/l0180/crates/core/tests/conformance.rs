// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0180 (`@graffiticode/l0180`).
//!
//! `conformance/cases.json` holds programs parsed with L0180's lexicon — every word generated
//! into every container from the attribute table, numeric blanks across their settings, option
//! lists whose order may or may not be information, the spec's programs, the TypeScript suite's,
//! and hand-written ones aimed at each error — with the upstream data a case was compiled
//! against and the result the TypeScript compiler gave. Every case must produce the same JSON
//! text here (field order included), or fail with the same errors in the same order.
//! Regenerate with `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0180::L0180;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    #[serde(default = "empty")]
    data: Json,
    expect: Expect,
}

fn empty() -> Json {
    json!({})
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
///
/// - Upstream data that is a chained task's `{data, errors}` envelope: the TypeScript `PROG`
///   spreads the envelope itself under the item (so the output gains `data` and `errors`
///   keys); the kernel hands every dialect the data model inside it, and that is what is
///   spread here.
/// - A reference to nothing inside a list (`[ get-var "nope" ]`): TypeScript holds `undefined`
///   there and names it so in the error; a kernel list holds `null`, and the error says
///   `null`. The same refusal, worded for the value each side has.
fn diverges(case: &Case) -> bool {
    envelope(case) || undefined_in_a_list(case)
}

fn envelope(case: &Case) -> bool {
    case.data.get("errors").is_some_and(Json::is_array)
}

fn undefined_in_a_list(case: &Case) -> bool {
    case.src.contains("[ get-var \"nope\" options") || case.src.contains("\"a\" get-var \"nope\" ]")
}

#[tokio::test]
async fn nothing_in_a_list_is_null_not_undefined() {
    let cases = cases();
    let found: Vec<&Case> = cases.iter().filter(|case| undefined_in_a_list(case)).collect();
    assert_eq!(found.len(), 2);
    for case in found {
        let expected = case.expect.errors.clone().unwrap();
        let actual = compile(case).await.unwrap_err();
        assert_eq!(expected.len(), 1);
        assert!(expected[0].contains("undefined"), "{expected:?}");
        assert_eq!(actual, [expected[0].replace("undefined", "null")]);
    }
}

async fn compile(case: &Case) -> Result<Option<Json>, Vec<String>> {
    let compiled = Compiler::new(L0180).compile(&case.ast, &case.data, &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json()),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

#[tokio::test]
async fn an_upstream_envelope_is_read_for_its_data() {
    let cases = cases();
    let case = cases.iter().find(|case| envelope(case)).unwrap();
    let expected: Json = serde_json::from_str(case.expect.text.as_deref().unwrap()).unwrap();
    // The TypeScript spreads the envelope's own keys…
    assert_eq!(expected["data"], json!({ "response": ["A"] }));
    assert_eq!(expected["errors"], json!([]));
    // …the Rust spreads the model inside it.
    let actual = compile(case).await.unwrap().unwrap();
    assert_eq!(actual["response"], json!(["A"]));
    assert_eq!(actual.get("data"), None);
    assert_eq!(actual.get("errors"), None);
    assert_eq!(actual["interaction"], expected["interaction"]);
    assert_eq!(actual["validation"], expected["validation"]);
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 2000, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = value.as_ref().map(Json::to_string);
                if text != case.expect.text {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {}",
                        case.expect.text.as_deref().unwrap_or("nothing"),
                        text.as_deref().unwrap_or("nothing")
                    ));
                }
            }
            (Some(expected), Err(errors)) => {
                if errors != expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {errors:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(value)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {value:?}"))
            }
        }
    }
    let total = failures.len();
    failures.truncate(12);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
