// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0182 (`@graffiticode/l0182`).
//!
//! `conformance/cases.json` holds programs parsed with L0182's lexicon — every program the
//! TypeScript suite parses, the spec's, programs generated from the installed surveys and from
//! the attribute table, and hand-written ones — with the result the TypeScript compiler gave.
//! A case with a `fixture` was compiled against that survey data, served the way the suite's
//! `setSource` fixtures serve it; the rest against the installed surveys, with no draws taken
//! and every draw taking the first untaken version. Every case must produce the same JSON text
//! here (field order included), or fail with the same errors. Regenerate with
//! `npm run rust:fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0182::L0182;
use graffiticode_l0182::source::{Files, Fixture};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    fixture: Option<Served>,
    expect: Expect,
}

#[derive(Deserialize)]
struct Served {
    data: Json,
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

/// The dialect a case was compiled with: its fixture, or the installed surveys with a fresh
/// draw that always takes the first untaken version.
fn dialect(case: &Case) -> L0182 {
    match &case.fixture {
        Some(served) => L0182::with_source(Fixture(served.data.clone())),
        None => L0182::with_source(Files::installed(|_| 0)),
    }
}

/// What the Rust compile of a case gives: the value as JSON text, or the error messages.
async fn compile(case: &Case) -> Result<Option<String>, Vec<String>> {
    let compiled = Compiler::new(dialect(case)).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => Ok(value.to_json().map(|json| json.to_string())),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

/// Where this implementation deliberately differs from the TypeScript one.
fn diverges(case: &Case) -> bool {
    unresolved_public_value(case) || decimal(case)
}

/// `get-val-public` with no value to fold in: the kernel's checker refuses the program, where
/// the TypeScript evaluates it to undefined and `session-id` then refuses that.
fn unresolved_public_value(case: &Case) -> bool {
    case.ast.to_string().contains("\"GET_VAL_PUBLIC\"")
}

/// A number too precise for a float is an object (a `Decimal`) in TypeScript. Where a word
/// only says it is not a string or a reference ("got a record") both agree, and those cases are
/// compared like any other, as are cases that write it out (both print `12345678901234567000`).
/// The one place they part: as an entry of an attribute list the TypeScript merges the
/// `Decimal`'s own fields.
fn decimal(case: &Case) -> bool {
    case.src.contains("12345678901234567890") && case.expect.errors.iter().flatten().any(|e| e.contains("native code"))
}

#[tokio::test]
async fn an_unresolved_public_value_is_refused_by_the_kernel() {
    let cases = cases();
    let case = cases.iter().find(|case| unresolved_public_value(case)).expect("the case is in the corpus");
    let expected = case.expect.errors.as_ref().unwrap();
    assert!(expected[0].starts_with("session-id: expected a string in \"quotes\", got undefined."));
    let errors = compile(case).await.unwrap_err();
    assert!(errors.iter().any(|e| e.contains("get-val-public")), "{errors:?}");
}

#[tokio::test]
async fn an_exact_number_is_a_record_but_not_a_decimal() {
    let cases = cases();
    let find = |src: &str| cases.iter().find(|case| case.src == src).expect("the case is in the corpus");

    // As an entry of an attribute list: TypeScript lists the Decimal's fields as words; here it
    // is an entry that is not an attribute.
    let merged = find("survey [ 12345678901234567890 ]..");
    assert!(decimal(merged));
    assert!(merged.expect.errors.as_ref().unwrap()[0].contains("`function Object() { [native code] }`, `s`, `e`, `d`"));
    let errors = compile(merged).await.unwrap_err();
    assert_eq!(
        errors,
        ["survey: every entry must be an attribute applied to a value, e.g. [id \"team-retro\"]. Got a record."]
    );

    // Written out, both print the same digits; the comparison covers it.
    let written = find("ratings [ [ 12345678901234567890 ] ]..");
    assert!(!decimal(written));
    assert_eq!(written.expect.text.as_deref(), Some(r#"{"ratings":[[12345678901234567000]]}"#));
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 3000, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compile(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        let label = match &case.fixture {
            Some(served) => format!("{label}\n  served {}", served.data),
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
            (Some(expected), Err(errors)) => {
                if errors != expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {errors:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(text)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got {text:?}"))
            }
        }
    }
    let total = failures.len();
    failures.truncate(8);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}
