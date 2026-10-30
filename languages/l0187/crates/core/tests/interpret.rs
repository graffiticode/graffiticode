// SPDX-License-Identifier: MIT

//! L0187 under the interpreter pass (docs/graffiticode-interpreter-plan.md, C1): every test
//! program compiles to a model, and interpreting it against an input gives exactly
//! what compiling the case against that input gives, as the server writes it, in both modes.
//! The corpus records no upstream data, so each case is checked against none and against an
//! upstream value and envelope too. A program that doesn't read its input is a value model,
//! evaluated once.

use graffiticode_l0000::{Compiler, Diagnostic, Identity, Mode, ModelKind, Value};
use graffiticode_l0187::L0187;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    name: String,
    ast: Json,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("cases.json")).unwrap()
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
    assert!(all.len() >= 50, "the fixture looks truncated: {} cases", all.len());
    let compiler = Compiler::new(L0187);
    let inputs = [json!({}), json!({ "secret": 1 }), json!({ "data": { "secret": 1 }, "errors": [] })];
    let (mut values, mut plans, mut failures) = (0, 0, Vec::new());
    for case in &all {
        let model = match compiler.model(&case.ast, &json!({})).await {
            Ok(model) => model,
            Err(errors) => {
                // Only a program that doesn't compile has no model, and it fails the same way.
                let compiled = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
                if written(&compiled.result) != Err(format!("{errors:?}")) {
                    failures
                        .push(format!("{}: no model ({errors:?}), but compiled to {:?}", case.name, compiled.result));
                }
                continue;
            }
        };
        match &model.kind {
            ModelKind::Value(_) => values += 1,
            ModelKind::Plan(_) => plans += 1,
        }
        for input in &inputs {
            let compiled = compiler.compile(&case.ast, input, &json!({}), Identity::default()).await;
            for mode in [Mode::Evaluate, Mode::Present] {
                let interpreted = compiler.interpret(&model, input, &json!({}), mode, Identity::default()).await;
                if written(&interpreted.result) != written(&compiled.result) {
                    failures.push(format!(
                        "{} (input {input}, {mode:?}):\n  compiled    {:?}\n  interpreted {:?}",
                        case.name,
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
    // Boards ignore their input: nearly every compiling program is a value model.
    assert!(values >= 10, "{values} value models and {plans} plans: the split looks wrong");
    println!("{values} value models, {plans} plans");
}

/// The test programs have no board that reads its input; one that does (a `data` expression before the
/// board) is a plan, and still interprets as it compiles.
#[tokio::test]
async fn a_program_that_reads_its_input_is_a_plan() {
    let all = cases();
    let compiler = Compiler::new(L0187);
    let mut board = None;
    for case in &all {
        if !case.name.starts_with("invalid-")
            && matches!(compiler.model(&case.ast, &json!({})).await.map(|m| m.kind), Ok(ModelKind::Value(_)))
        {
            board = Some(case.ast.clone());
            break;
        }
    }
    let mut ast = board.expect("a board that compiles");
    let prog = ast[ast["root"].to_string().trim_matches('"')].clone();
    let exprs_id = prog["elts"][0].to_string();
    let exprs_id = exprs_id.trim_matches('"');
    ast["9001"] = json!({ "tag": "RECORD", "elts": [] });
    ast["9002"] = json!({ "tag": "DATA", "elts": [9001] });
    let mut elts = ast[exprs_id]["elts"].as_array().unwrap().clone();
    elts.insert(0, json!(9002));
    ast[exprs_id]["elts"] = json!(elts);
    let model = compiler.model(&ast, &json!({})).await.unwrap();
    assert_eq!(model.kind, ModelKind::Plan(ast.clone()));
    let input = json!({ "secret": 1 });
    let compiled = compiler.compile(&ast, &input, &json!({}), Identity::default()).await;
    let interpreted = compiler.interpret(&model, &input, &json!({}), Mode::Present, Identity::default()).await;
    assert_eq!(written(&interpreted.result), written(&compiled.result));
    assert!(compiled.result.is_ok(), "{:?}", compiled.result);
}
