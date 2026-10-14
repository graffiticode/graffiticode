// SPDX-License-Identifier: MIT

//! Differential test against the TypeScript L0014 (`@graffiticode/l0014`).
//!
//! `conformance/cases.json` holds programs parsed with L0014's lexicon and the result the
//! TypeScript compiler gave, including the exact JSON text: a rule set's key order is its
//! rule precedence, so the comparison is of bytes, not of values. The last case is
//! `spec/latex-to-latex.gc`, the reconstruction of the rule set TransLaTeX ships.
//!
//! Translating is not L0014's job (see `Translator`), so here the translator answers from the
//! recorded results. What is under test is everything else: assembling the rule set, and
//! pairing, trimming and scoring the corpus. Regenerate with `npm run rust:fixtures`.

use std::collections::HashMap;

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0014::{L0014, Translation, Translator, TranslatorError};
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
    data: Option<Json>,
    /// `JSON.stringify` of the data.
    text: Option<String>,
    errors: Option<Vec<String>>,
}

/// Answers each source with the translation TypeScript recorded for it in this case.
struct Recorded(HashMap<String, Json>);

impl Recorded {
    fn from(expect: &Expect) -> Self {
        let tests = expect.data.as_ref().and_then(|data| data["tests"].as_array()).cloned().unwrap_or_default();
        Self(
            tests
                .iter()
                .map(|test| {
                    let source = match &test["source"] {
                        Json::String(source) => source.clone(),
                        Json::Null => String::new(),
                        other => other.to_string(),
                    };
                    (source, test["actual"].clone())
                })
                .collect(),
        )
    }
}

#[async_trait]
impl Translator for Recorded {
    async fn translate(&self, _rules: &Json, sources: &[String]) -> Result<Vec<Translation>, TranslatorError> {
        Ok(sources
            .iter()
            .map(|source| Translation { value: self.0.get(source).cloned().unwrap_or(json!("")), errors: Vec::new() })
            .collect())
    }
}

#[tokio::test]
async fn agrees_with_the_typescript_implementation_byte_for_byte() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 25, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let compiler = Compiler::new(L0014::new(Recorded::from(&case.expect)));
        let actual = compiler.compile(&case.ast, &case.data, &json!({}), Identity::default()).await.result;
        let label: String = case.src.chars().take(90).collect();
        match (&case.expect.errors, &actual) {
            (None, Ok(value)) => {
                let text = serde_json::to_string(&value.to_json()).unwrap();
                if Some(&text) != case.expect.text.as_ref() {
                    failures.push(format!("{label}\n  expected {:?}\n  got      {text:?}", case.expect.text));
                }
            }
            (Some(expected), Err(errors)) => {
                let said: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
                if said != expected.iter().map(String::as_str).collect::<Vec<_>>() {
                    failures.push(format!("{label}\n  expected errors {expected:?}\n  got {errors:?}"));
                }
            }
            (None, Err(errors)) => failures.push(format!("{label}\n  expected a result\n  got errors {errors:?}")),
            (Some(expected), Ok(_)) => {
                failures.push(format!("{label}\n  expected errors {expected:?}\n  got a result"))
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} cases disagree:\n\n{}", failures.len(), cases.len(), failures.join("\n\n"));
}

/// The acceptance test of the language itself: the reconstructed LaTeX-to-LaTeX program
/// compiles to the rule set TransLaTeX ships, 49 words, 1 type and 80 rules, in order.
#[tokio::test]
async fn the_shipping_rule_set_compiles_to_itself() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    let case = cases.iter().find(|case| case.src.contains("LaTeX to LaTeX translator")).expect("the identity case");
    let compiler = Compiler::new(L0014::new(Recorded::from(&case.expect)));
    let value = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result.unwrap();
    let options = &value.to_json().unwrap()["options"];
    let count = |part: &str| options[part].as_object().map_or(0, serde_json::Map::len);
    assert_eq!((count("words"), count("types"), count("rules")), (49, 1, 80));
    let keys: Vec<&String> = options.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["data", "words", "types", "rules", "allowInterval", "parsingIntegralExpr", "RHS"]);
    assert_eq!(serde_json::to_string(&value.to_json()).unwrap(), *case.expect.text.as_ref().unwrap());
}
