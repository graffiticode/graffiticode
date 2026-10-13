// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript implementation (`@graffiticode/l0000`).
//!
//! `conformance/cases.json` holds programs parsed by `@graffiticode/parser`, each with the
//! result the TypeScript compiler gave. Every case must produce the same data here, or fail
//! where it failed there. Regenerate with `conformance/generate.mjs`.

use std::sync::Arc;

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Identity, L0000, LanguageSchema, SchemaError, SchemaSource};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    data: Json,
    ast: Json,
    expect: Expect,
    /// Present for `use` cases: the schema the upstream language publishes, or null if the
    /// fetch fails.
    schema: Option<Option<Json>>,
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

/// JSON equality with numbers compared by value: `3` and `3.0` are the same number.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        (Json::Array(a), Json::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b)),
        (Json::Object(a), Json::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

fn same_result(a: &Option<Json>, b: &Option<Json>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => same(a, b),
        (None, None) => true,
        _ => false,
    }
}

struct OneSchema(Option<Json>);

#[async_trait]
impl SchemaSource for OneSchema {
    async fn schema(&self, lang: &str) -> Result<Arc<LanguageSchema>, SchemaError> {
        match &self.0 {
            Some(schema) => LanguageSchema::new(schema).map(Arc::new),
            None => Err(SchemaError(format!("HTTP 404 from https://api.graffiticode.org/L{lang}/schema.json"))),
        }
    }
}

/// Where this implementation deliberately differs from the TypeScript one.
fn divergence(case: &Case) -> Option<(&'static str, Json)> {
    Some(match case.src.as_str() {
        "equiv [1 2] [1 2].." | "equiv {a: [1]} {a: [1]}.." => {
            ("equiv compares lists and nested values by structure, not by identity", json!(true))
        }
        r#"length (get "a" (data {})).."# => {
            ("a nested upstream object is a record like any other, so it has a length", json!(1))
        }
        // TypeScript left a call's arguments in scope for the whole body, so a lambda written
        // inside another was applied to the outer call's arguments.
        "apply (<x: <y: add x y>>) [1].." => (FUNCTION_VALUE, json!({ "lambda": { "params": ["y"] } })),
        "map (<x: <y: x>>) [1 2].." => {
            (FUNCTION_VALUE, json!([{ "lambda": { "params": ["y"] } }, { "lambda": { "params": ["y"] } }]))
        }
        "map (<x: [x <y: y>]>) [1].." => (FUNCTION_VALUE, json!([[1, { "lambda": { "params": ["y"] } }]])),
        _ => return None,
    })
}

const FUNCTION_VALUE: &str = "a function returned from a function is a function, not a second application";

/// Error text this implementation words differently; only the prefix is compared.
fn comparable(message: &str) -> &str {
    if message.starts_with("Error in ")
        && let Some(end) = message.find(" operation:")
    {
        return &message[..end + " operation:".len()];
    }
    for prefix in ["upstream data does not match L0166:", "use: failed to load L0166/schema.json:"] {
        if message.starts_with(prefix) {
            return prefix;
        }
    }
    message
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() > 350, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    let mut diverged = 0;
    for case in &cases {
        let compiler = match &case.schema {
            Some(schema) => Compiler::new(L0000).with_schemas(OneSchema(schema.clone())),
            None => Compiler::new(L0000),
        };
        let actual = compiler.compile(&case.ast, &case.data, &json!({}), Identity::default()).await.result;
        let label = format!("{} (data {})", case.src, case.data);

        if let Some((_reason, expected)) = divergence(case) {
            diverged += 1;
            match &actual {
                Ok(value) if same_result(&value.to_json(), &Some(expected.clone())) => {}
                other => failures.push(format!("{label}\n  divergence expected {expected}\n  got {other:?}")),
            }
            continue;
        }
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let value = value.to_json();
                if !same_result(&value, &case.expect.data) {
                    failures.push(format!("{label}\n  expected {:?}\n  got      {value:?}", case.expect.data));
                }
            }
            (Some(expected), Err(errors)) => {
                // TypeScript reports some errors twice; compare what was said, not how often.
                let said: Vec<&str> = errors.iter().map(|e| comparable(&e.message)).collect();
                for message in expected {
                    // Messages that exposed implementation detail have no counterpart.
                    if message.contains("SyntaxError") || message.starts_with("Type Error:") {
                        continue;
                    }
                    if !said.contains(&comparable(message)) {
                        failures.push(format!("{label}\n  expected error {message:?}\n  got {errors:?}"));
                    }
                }
                // ...but never say a thing more often than TypeScript did: that would mean a
                // subexpression was evaluated twice.
                for message in &said {
                    let times = |all: &[&str]| all.iter().filter(|m| m == &message).count();
                    let expected: Vec<&str> = expected.iter().map(|m| comparable(m)).collect();
                    if expected.contains(message) && times(&said) > times(&expected) {
                        failures.push(format!("{label}\n  {message:?} reported too often\n  got {errors:?}"));
                    }
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
    assert_eq!(diverged, 6, "every listed divergence should be exercised by a case");
}
