// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0179 (`@graffiticode/l0179`).
//!
//! `conformance/cases.json` holds programs parsed with L0179's lexicon — generated from the
//! attribute table (every attribute in every container, with values of each kind it accepts and
//! refuses), the spec's, the TypeScript suite's, parameter expansion, validation and hand-written
//! ones — each with the upstream `data` it was compiled against and the result the TypeScript
//! compiler gave. Every case must produce the same JSON text here (field order included), or
//! fail with the same errors. Regenerate with `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0179::L0179;
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
    /// The compiled value as JSON text; absent for an undefined value.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

/// An upstream `{ data, errors }` envelope: the output of a chained task.
fn enveloped(data: &Json) -> bool {
    data.get("errors").is_some_and(Json::is_array)
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// Upstream data given as a `{ data, errors }` envelope is read from its `data`, as the kernel
/// reads it for every Rust language: its fields are laid over the output, and `params` and
/// `limit` come from it. The TypeScript reads the envelope itself — the output gains a `data`
/// field holding the upstream data, and the form's `params` are ignored.
fn diverges(case: &Case) -> bool {
    enveloped(&case.data)
}

async fn compile(case: &Case) -> Result<Option<Json>, Vec<String>> {
    let compiled = Compiler::new(L0179).compile(&case.ast, &case.data, &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json()),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

#[tokio::test]
async fn an_enveloped_upstream_is_read_from_its_data() {
    let cases = cases();
    let diverging: Vec<&Case> = cases.iter().filter(|case| diverges(case)).collect();
    assert!(!diverging.is_empty());
    for case in diverging {
        let inner = &case.data["data"];
        let expected: Json = serde_json::from_str(case.expect.text.as_deref().unwrap()).unwrap();
        // The TypeScript: the envelope's `data` lands in the output whole.
        assert_eq!(expected["data"], *inner, "{}", case.src);
        let actual = compile(case).await.unwrap().unwrap();
        // The Rust: its fields are laid over the output, and no `data` field appears.
        assert_eq!(actual.get("data"), None, "{}", case.src);
        assert_eq!(actual["a"], inner["a"], "{}", case.src);
        // The form's `params` win over the program's.
        if case.src.contains("params") {
            assert_eq!(actual["templateVariablesRecords"], json!([{ "A1": "1" }, { "A1": "2" }]), "{}", case.src);
            assert_ne!(expected["templateVariablesRecords"], actual["templateVariablesRecords"], "{}", case.src);
        }
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 1000, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        let label = format!("{label}  (data {})", case.data);
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
    failures.truncate(8);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
