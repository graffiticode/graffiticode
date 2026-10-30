// SPDX-License-Identifier: MIT

//! L0184 under the interpreter pass (docs/graffiticode-interpreter-plan.md, C1): every
//! conformance case compiles to a model, and interpreting it against the case's data gives
//! exactly what compiling the case against that data gives, as the server writes it. A program
//! that doesn't read its input is a value model, evaluated once; one that does (`rows data use
//! "0185"`) is a plan.

use std::sync::Arc;

use async_trait::async_trait;
use graffiticode_l0000::{
    Compiler, Diagnostic, Identity, LanguageSchema, Mode, ModelKind, SchemaError, SchemaSource, Value,
};
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
}

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
    assert!(all.len() >= 2500, "the fixture looks truncated: {} cases", all.len());
    let (mut values, mut plans, mut failures) = (0, 0, Vec::new());
    for case in &all {
        let compiler = compiler(case);
        let data = case.data.clone().unwrap_or_else(|| json!({}));
        let compiled = compiler.compile(&case.ast, &data, &json!({}), Identity::default()).await;
        let model = match compiler.model(&case.ast, &json!({})).await {
            Ok(model) => model,
            Err(errors) => {
                // Only a program that doesn't compile has no model, and it fails the same way.
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
        for mode in [Mode::Evaluate, Mode::Present] {
            let interpreted = compiler.interpret(&model, &data, &json!({}), mode, Identity::default()).await;
            if written(&interpreted.result) != written(&compiled.result) {
                failures.push(format!(
                    "{} (data {data}, {mode:?}):\n  compiled    {:?}\n  interpreted {:?}",
                    case.src,
                    written(&compiled.result),
                    written(&interpreted.result)
                ));
            }
        }
    }
    let total = failures.len();
    failures.truncate(10);
    assert!(failures.is_empty(), "{total} of {} cases differ:\n\n{}", all.len(), failures.join("\n\n"));
    // Most charts that compile don't read their input; those that fetch through L0185 do. (Most
    // of the corpus is programs that don't compile, which have no model.)
    assert!(values > 500 && plans > 50, "{values} value models and {plans} plans: the split looks wrong");
}

#[tokio::test]
async fn a_chart_that_reads_its_input_is_a_plan() {
    let all = cases();
    let reading = all.iter().find(|c| c.src.contains("data use")).expect("the corpus has a chart reading L0185 data");
    let model = compiler(reading).model(&reading.ast, &json!({})).await.unwrap();
    assert_eq!(model.kind, ModelKind::Plan(reading.ast.clone()));
}
