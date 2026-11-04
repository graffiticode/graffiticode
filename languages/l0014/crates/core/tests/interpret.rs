// SPDX-License-Identifier: MIT

//! L0014 under the interpreter pass (docs/graffiticode-interpreter-plan.md, C2): TransLaTeX
//! rule sets. Its programs read their input, so every program that compiles is a plan the kernel
//! evaluates. Interpreting that plan against an input gives exactly what compiling the case
//! against that input gives, as the server writes it, in both modes. As in the conformance test,
//! the translator answers from each case's recorded results, so what is under test is
//! assembling the rule set and scoring the corpus, at compile and at interpret time alike.

use std::collections::HashMap;

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Diagnostic, Identity, Mode, ModelKind, Value};
use graffiticode_l0014::{L0014, Translation, Translator, TranslatorError};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    #[serde(default)]
    data: Json,
    ast: Json,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    data: Option<Json>,
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

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

/// What the server writes for a result: the JSON text of its value (none when undefined), or
/// its errors.
fn written(result: &Result<Value, Vec<Diagnostic>>) -> Result<Option<String>, String> {
    match result {
        Ok(value) => Ok(value.to_json().map(|json| graffiticode_l0000::json_text(&json))),
        Err(errors) => Err(format!("{errors:?}")),
    }
}

#[tokio::test]
async fn every_case_interprets_exactly_as_it_compiles() {
    let all = cases();
    assert!(all.len() >= 27, "the fixture looks truncated: {} cases", all.len());
    let (mut values, mut plans, mut failures) = (0, 0, Vec::new());
    for case in &all {
        let compiler = Compiler::new(L0014::new(Recorded::from(&case.expect)));
        let model = match compiler.model(&case.ast, &json!({})).await {
            Ok(model) => model,
            Err(errors) => {
                let compiled = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
                if written(&compiled.result) != Err(format!("{errors:?}")) {
                    failures
                        .push(format!("{}: no model ({errors:?}), but compiled to {:?}", case.src, compiled.result));
                }
                continue;
            }
        };
        match &model.kind {
            ModelKind::Value(_) => values += 1,
            ModelKind::Plan(_) => plans += 1,
        }
        let mut inputs = vec![json!({}), json!({ "secret": 1 }), json!({ "data": { "secret": 1 }, "errors": [] })];
        if !case.data.is_null() {
            inputs.insert(0, case.data.clone());
        }
        for input in &inputs {
            let compiled = compiler.compile(&case.ast, input, &json!({}), Identity::default()).await;
            for mode in [Mode::Evaluate, Mode::Present] {
                let interpreted = compiler.interpret(&model, input, &json!({}), mode, Identity::default()).await;
                if written(&interpreted.result) != written(&compiled.result) {
                    let label: String = case.src.chars().take(90).collect();
                    failures.push(format!(
                        "{label} (input {input}, {mode:?}):\n  compiled    {:?}\n  interpreted {:?}",
                        written(&compiled.result),
                        written(&interpreted.result)
                    ));
                }
            }
        }
    }
    let total = failures.len();
    failures.truncate(10);
    assert!(failures.is_empty(), "{total} of {} cases differ:\n\n{}", all.len(), failures.join("\n\n"));
    assert_eq!(values, 0, "{values} value models: L0014 reads its input, so every model is a plan");
    assert!(plans > 0, "no plans");
    println!("{plans} plans");
}
