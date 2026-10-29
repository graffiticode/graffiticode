// SPDX-License-Identifier: MIT

//! The interpreter pass's kernel contract (docs/graffiticode-interpreter-plan.md, B1): a task
//! compiles on its own to a model, and interpreting the model against an input gives exactly what
//! compiling the task against that input gives today.

use std::sync::Arc;

use async_trait::async_trait;
use graffiticode_l0000::{
    Ast, Compiler, Diagnostic, Dialect, Identity, L0000, LanguageSchema, Mode, Model, ModelKind, SchemaError,
    SchemaSource,
};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    data: Json,
    ast: Json,
    schema: Option<Option<Json>>,
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

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

fn compiler_for(case: &Case) -> Compiler {
    match &case.schema {
        Some(schema) => Compiler::new(L0000).with_schemas(OneSchema(schema.clone())),
        None => Compiler::new(L0000),
    }
}

/// Every conformance case: a plan model interpreted against the case's data gives the same
/// compilation, value or errors, as compiling the case against it.
#[tokio::test]
async fn a_plan_model_interprets_exactly_as_its_program_compiles() {
    let cases = cases();
    assert!(cases.len() > 350, "the fixture looks truncated: {} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let compiler = compiler_for(case);
        let compiled = compiler.compile(&case.ast, &case.data, &json!({}), Identity::default()).await;
        match compiler.model(&case.ast, &json!({})).await {
            Err(errors) => {
                // Only a program that doesn't compile has no model, and it fails the same way.
                if compiled.result.as_ref().err() != Some(&errors) {
                    failures
                        .push(format!("{}: no model ({errors:?}), but compiled to {:?}", case.src, compiled.result));
                }
            }
            Ok(model) => {
                if model.kind != ModelKind::Plan(case.ast.clone()) {
                    failures.push(format!(
                        "{}: L0000 declares nothing input-independent, so every model is a plan",
                        case.src
                    ));
                }
                let interpreted =
                    compiler.interpret(&model, &case.data, &json!({}), Mode::Evaluate, Identity::default()).await;
                // Compared as printed: NaN (`div 0 0`) is never equal to itself.
                if format!("{interpreted:?}") != format!("{compiled:?}") {
                    failures.push(format!(
                        "{} (data {}):\n  compiled    {:?}\n  interpreted {:?}",
                        case.src, case.data, compiled.result, interpreted.result
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

/// A dialect that declares every program input-independent: L0000's words, nothing more.
struct Constant;

#[async_trait]
impl Dialect for Constant {
    fn lang_id(&self) -> &str {
        "0000"
    }
    fn input_independent(&self, _ast: &Ast) -> bool {
        true
    }
}

/// A program that doesn't read its input, from the corpus.
fn constant_case() -> Case {
    cases().into_iter().find(|c| c.src == "add 1 2..").expect("the corpus has add 1 2")
}

#[tokio::test]
async fn an_input_independent_program_compiles_to_a_value_that_interprets_by_identity() {
    let case = constant_case();
    let compiler = Compiler::new(Constant);
    let model = compiler.model(&case.ast, &json!({})).await.unwrap();
    assert_eq!(model.kind, ModelKind::Value(json!(3)));
    for input in [json!({}), json!({ "data": { "a": 1 }, "errors": [] }), json!([1, 2])] {
        let interpreted = compiler.interpret(&model, &input, &json!({}), Mode::Present, Identity::default()).await;
        assert_eq!(interpreted.result.unwrap().to_json(), Some(json!(3)));
        assert!(interpreted.effects.is_empty());
    }
}

#[tokio::test]
async fn a_model_round_trips_through_json_and_refuses_tampering() {
    let case = constant_case();
    for compiler in [Compiler::new(L0000), Compiler::new(Constant)] {
        let model = compiler.model(&case.ast, &json!({})).await.unwrap();
        assert_eq!(Model::from_json(&model.to_json()).unwrap(), model);
    }
    let mut plan = Compiler::new(L0000).model(&case.ast, &json!({})).await.unwrap().to_json();
    plan["program"]["root"] = json!("1");
    assert!(Model::from_json(&plan).unwrap_err().contains("digest doesn't match"));
    for bad in [
        json!(1),
        json!({ "lang": "0000", "kind": "other", "digest": "x" }),
        json!({ "lang": "0000", "kind": "value", "digest": "x" }),
    ] {
        assert!(Model::from_json(&bad).unwrap_err().starts_with("Error: not a model: "));
    }
}

#[tokio::test]
async fn a_model_from_another_language_is_refused() {
    let case = constant_case();
    let model = Model { lang: "0158".to_owned(), kind: ModelKind::Plan(case.ast.clone()) };
    let interpreted =
        Compiler::new(L0000).interpret(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default()).await;
    let errors = interpreted.result.unwrap_err();
    assert_eq!(errors[0].code.as_deref(), Some("model-language-mismatch"));
}

/// A dialect with an interpretation of its own, told which mode it is in.
struct Interpreting;

#[async_trait]
impl Dialect for Interpreting {
    fn lang_id(&self) -> &str {
        "0000"
    }
    async fn interpret(&self, _model: &Model, input: &Json, mode: Mode) -> Option<Result<Json, Vec<Diagnostic>>> {
        Some(Ok(json!({ "input": input, "present": mode == Mode::Present })))
    }
}

#[tokio::test]
async fn a_dialect_may_interpret_its_own_plans_and_sees_the_mode() {
    let case = constant_case();
    let compiler = Compiler::new(Interpreting);
    let model = compiler.model(&case.ast, &json!({})).await.unwrap();
    let interpreted =
        compiler.interpret(&model, &json!({ "a": 1 }), &json!({}), Mode::Present, Identity::default()).await;
    assert_eq!(interpreted.result.unwrap().to_json(), Some(json!({ "input": { "a": 1 }, "present": true })));
}

#[test]
fn modes_are_evaluate_by_default_or_present() {
    assert_eq!(Mode::from_json(&Json::Null), Ok(Mode::Evaluate));
    assert_eq!(Mode::from_json(&json!("evaluate")), Ok(Mode::Evaluate));
    assert_eq!(Mode::from_json(&json!("present")), Ok(Mode::Present));
    assert!(Mode::from_json(&json!("render")).is_err());
}

#[tokio::test]
async fn by_default_a_language_can_t_materialize() {
    let case = constant_case();
    let model = Compiler::new(L0000).model(&case.ast, &json!({})).await.unwrap();
    assert!(L0000.materialize(&model, &json!({}), &json!({})).is_none());
}
