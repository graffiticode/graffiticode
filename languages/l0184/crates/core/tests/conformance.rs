// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0184 (`@graffiticode/l0184`).
//!
//! `conformance/cases.json` holds programs parsed with L0184's lexicon — generated from the
//! vocabulary, the spec's, every program the TypeScript suite compiles, number and date sweeps,
//! and hand-written ones — with the upstream data they were compiled against and the result the
//! TypeScript compiler gave. Every case must produce the same JSON text here (field order
//! included), or fail with the same errors. Regenerate with `npm run rust:fixtures`.

use std::sync::Arc;

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Identity, LanguageSchema, SchemaError, SchemaSource};
use graffiticode_l0184::L0184;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    #[serde(default)]
    data: Option<Json>,
    #[serde(default)]
    schema: Option<Json>,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    /// The compiled value as JSON text; absent for an undefined value.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

/// `use "0185"` resolves to the schema the case was compiled against.
struct OneSchema(Json);

#[async_trait]
impl SchemaSource for OneSchema {
    async fn schema(&self, _lang: &str) -> Result<Arc<LanguageSchema>, SchemaError> {
        LanguageSchema::new(&self.0).map(Arc::new)
    }
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

fn compiler(case: &Case) -> Compiler {
    match &case.schema {
        Some(schema) => Compiler::new(L0184).with_schemas(OneSchema(schema.clone())),
        None => Compiler::new(L0184),
    }
}

async fn run(case: &Case) -> Result<Json, Vec<String>> {
    let data = case.data.clone().unwrap_or_else(|| json!({}));
    match compiler(case).compile(&case.ast, &data, &json!({}), Identity::default()).await.result {
        Ok(value) => Ok(value.to_json().unwrap_or(Json::Null)),
        Err(errors) => Err(errors.into_iter().map(|e| e.message).collect()),
    }
}

/// Where this implementation deliberately differs from the TypeScript one.
///
/// A number of 2^64 or more in the output (`1e20`) is written in exponent form (`1e+20`): the
/// kernel's JSON numbers are `u64`, `i64` or `f64`, and an `f64` that large is written
/// exponentially, where JavaScript writes digits up to 1e21. It is the same double. These are
/// exactly the cases whose expected text does not survive a round trip through `serde_json`.
fn diverges(case: &Case) -> bool {
    case.expect.text.as_deref().is_some_and(|text| reserialized(text) != text)
}

fn reserialized(text: &str) -> String {
    serde_json::from_str::<Json>(text).map(|json| json.to_string()).unwrap_or_default()
}

#[tokio::test]
async fn huge_numbers_are_the_same_doubles_in_exponent_form() {
    let all = cases();
    let diverging: Vec<&Case> = all.iter().filter(|case| diverges(case)).collect();
    assert!(!diverging.is_empty());
    for case in diverging {
        let expected: Json = serde_json::from_str(case.expect.text.as_deref().unwrap()).unwrap();
        let actual = run(case).await.unwrap();
        assert_eq!(actual, expected, "{}", case.src);
        assert!(actual.to_string().contains("e+"), "{}", case.src);
    }
}

/// An item given an undefined value (`get-var` of a name never set) is refused, as in
/// TypeScript: it is not a value, though the kernel would write it as `null`.
#[tokio::test]
async fn an_undefined_item_is_not_a_value() {
    let all = cases();
    let src = r#"charts [ chart [ plots [ plot kind BAR values [1 get-var "nope"] {} ] {} ] {} ] {}.."#;
    let case = all.iter().find(|c| c.src == src).unwrap();
    let expected = r#"chart "c1" plot 1: values item 2: a value must be a number, a string, true/false or null — got a list or a record."#;
    assert_eq!(case.expect.errors.as_deref(), Some(&[expected.to_owned()][..]));
    assert_eq!(run(case).await, Err(vec![expected.to_owned()]));
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let all = cases();
    assert!(all.len() >= 2500, "the fixture looks truncated: {} cases", all.len());
    let mut failures = Vec::new();
    for case in all.iter().filter(|case| !diverges(case)) {
        let actual = run(case).await;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect();
        let label = match &case.data {
            Some(data) => format!("{label} (data {data})"),
            None => label,
        };
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = value.to_string();
                if Some(&text) != case.expect.text.as_ref() {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {text}",
                        case.expect.text.as_deref().unwrap_or("nothing")
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
    failures.truncate(10);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", all.len(), failures.join("\n\n"));
}
