// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0185 (`@graffiticode/l0185`).
//!
//! `conformance/cases.json` holds programs parsed with L0185's lexicon — generated from the
//! sample data and the vocabulary, the spec's, the TypeScript suite's, and hand-written ones —
//! with the result the TypeScript compiler gave. Every case must produce the same JSON text
//! here (field order included), or fail with the same errors. Regenerate with
//! `npm run rust:fixtures`.
//!
//! Nothing is fetched from the network. The fixture fetcher is the TypeScript harness's:
//! `https://example.org/<file>` and `https://l0185.graffiticode.org/data/<file>` read
//! `packages/core/data/<file>` (or `fixtures/`), and `https://example.org/t/<name>` the
//! bodies in `conformance/fetches.json`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0185::{FetchResult, Fetcher, L0185};
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

#[derive(Deserialize)]
#[serde(untagged)]
enum Synthetic {
    Body {
        text: String,
        #[serde(rename = "contentType")]
        content_type: String,
    },
    Error {
        error: String,
    },
}

/// The TypeScript harness's fetcher, recording what it was asked for.
#[derive(Clone, Default)]
struct Fixtures {
    synthetic: Arc<HashMap<String, Synthetic>>,
    fetched: Arc<Mutex<Vec<String>>>,
}

impl Fixtures {
    fn new() -> Self {
        Self {
            synthetic: Arc::new(serde_json::from_str(include_str!("conformance/fetches.json")).unwrap()),
            fetched: Arc::default(),
        }
    }
}

#[async_trait]
impl Fetcher for Fixtures {
    async fn fetch(&self, url: &str) -> Result<FetchResult, String> {
        self.fetched.lock().unwrap().push(url.to_owned());
        let missing =
            || Err(format!("fetch: fetching {} failed: the server answered 404.", serde_json::to_string(url).unwrap()));
        if let Some(name) = url.strip_prefix("https://example.org/t/") {
            return match self.synthetic.get(url) {
                Some(Synthetic::Body { text, content_type }) => {
                    Ok(FetchResult { text: text.clone(), content_type: content_type.clone() })
                }
                Some(Synthetic::Error { error }) => Err(error.clone()),
                None => {
                    let _ = name;
                    missing()
                }
            };
        }
        let Some(file) = url
            .strip_prefix("https://example.org/")
            .or_else(|| url.strip_prefix("https://l0185.graffiticode.org/data/"))
        else {
            return missing();
        };
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core");
        let data = core.join("data").join(file);
        let path = if data.is_file() { data } else { core.join("fixtures").join(file) };
        let Ok(text) = std::fs::read_to_string(&path) else { return missing() };
        let content_type = if file.ends_with(".csv") {
            "text/csv"
        } else if file.ends_with(".html") {
            "text/html"
        } else {
            "application/json"
        };
        Ok(FetchResult { text, content_type: content_type.to_owned() })
    }
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

async fn compile(src_ast: &Json) -> Result<Json, Vec<String>> {
    let compiled = Compiler::new(L0185::with_fetcher(Fixtures::new()))
        .compile(src_ast, &json!({}), &json!({}), Identity::default())
        .await;
    compiled
        .result
        .map(|v| v.to_json().unwrap_or(Json::Null))
        .map_err(|errors| errors.into_iter().map(|e| e.message).collect())
}

/// Where this implementation deliberately differs from the TypeScript one.
fn diverges(case: &Case) -> bool {
    kernel_error_in_function(case)
}

/// An L0000 error inside a function of the record (`<row: add "a" 1>`) is the kernel's own
/// message, and the Rust kernel words its messages differently (see languages/l0000's
/// CLAUDE.md, "Conformance").
fn kernel_error_in_function(case: &Case) -> bool {
    case.expect.errors.as_ref().is_some_and(|errors| {
        errors.iter().any(|e| e.starts_with("Error in ") || e.contains(" argument must be a number"))
    })
}

#[tokio::test]
async fn kernel_errors_in_functions_are_the_rust_kernels() {
    let cases = cases();
    let diverging: Vec<&Case> = cases.iter().filter(|c| kernel_error_in_function(c)).collect();
    assert_eq!(diverging.len(), 3);
    for case in diverging {
        let errors = compile(&case.ast).await.unwrap_err();
        assert_eq!(errors.len(), 1, "{}", case.src);
        assert!(
            errors[0].starts_with("Error in ") && errors[0].contains("expected a number"),
            "{}: {errors:?}",
            case.src
        );
        let expected = case.expect.errors.as_ref().unwrap();
        assert!(expected[0].contains("ADD") || expected[0].contains("MUL"));
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation() {
    let cases = cases();
    assert!(cases.len() >= 2000, "the fixture looks truncated: {} cases", cases.len());
    let compiler = Compiler::new(L0185::with_fetcher(Fixtures::new()));
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| !diverges(case)) {
        let actual = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result;
        let label: String = case.src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = value.to_json().map(|json| json.to_string());
                if text != case.expect.text {
                    failures.push(format!(
                        "{label}\n  expected {}\n  got      {}",
                        case.expect.text.as_deref().unwrap_or("nothing").chars().take(600).collect::<String>(),
                        text.as_deref().unwrap_or("nothing").chars().take(600).collect::<String>()
                    ));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
                if said != *expected {
                    failures.push(format!("{label}\n  expected errors {expected:#?}\n  got {said:#?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a value\n  got errors {errors:?}")),
            (Some(expected), Ok(value)) => failures.push(format!(
                "{label}\n  expected errors {expected:?}\n  got {}",
                value.to_json().map(|j| j.to_string()).unwrap_or_default().chars().take(300).collect::<String>()
            )),
        }
    }
    let total = failures.len();
    let shown = std::env::var("SHOW").ok().and_then(|n| n.parse().ok()).unwrap_or(8);
    failures.truncate(shown);
    assert!(failures.is_empty(), "{total} of {} cases disagree:\n\n{}", cases.len(), failures.join("\n\n"));
}

#[tokio::test]
async fn a_url_used_twice_is_fetched_once() {
    let fixtures = Fixtures::new();
    let case = cases()
        .into_iter()
        .find(|c| c.src.starts_with("let a = fetch \"https://example.org/people.json\" {}.. join"))
        .unwrap();
    let compiled = Compiler::new(L0185::with_fetcher(fixtures.clone()))
        .compile(&case.ast, &json!({}), &json!({}), Identity::default())
        .await;
    assert!(compiled.result.is_ok());
    assert_eq!(*fixtures.fetched.lock().unwrap(), ["https://example.org/people.json"]);
}

#[tokio::test]
async fn without_a_fetcher_fetch_is_an_error() {
    let case =
        cases().into_iter().find(|c| c.src.starts_with("limit 3 fetch \"https://example.org/people.json\"")).unwrap();
    let compiled =
        Compiler::new(L0185::without_fetcher()).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    let errors: Vec<String> = compiled.result.unwrap_err().into_iter().map(|e| e.message).collect();
    assert_eq!(errors, ["fetch: fetching is not available here."]);
    let _ = compile;
}
