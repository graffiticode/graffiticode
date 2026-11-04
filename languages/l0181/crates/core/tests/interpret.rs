// SPDX-License-Identifier: MIT

//! L0181 under the interpreter pass (docs/graffiticode-interpreter-plan.md, C2): flashcard decks. Its programs
//! read their input, so the dialect leaves `input_independent` at its default and every program
//! that compiles is a plan the kernel evaluates. Interpreting that plan against an input gives
//! exactly what compiling the case against that input gives, as the server writes it, in both
//! modes. Each case is checked against its own recorded data, against none, and against an
//! upstream value and envelope.

use graffiticode_l0000::{Compiler, Diagnostic, Identity, Mode, ModelKind, Value};
use graffiticode_l0181::L0181;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    #[serde(default)]
    data: Json,
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
    assert!(all.len() >= 473, "the fixture looks truncated: {} cases", all.len());
    let compiler = Compiler::new(L0181);
    let (mut values, mut plans, mut failures) = (0, 0, Vec::new());
    for case in &all {
        let model = match compiler.model(&case.ast, &json!({})).await {
            Ok(model) => model,
            Err(errors) => {
                // Only a program that doesn't compile has no model, and it fails the same way.
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
                    failures.push(format!(
                        "{} (input {input}, {mode:?}):\n  compiled    {:?}\n  interpreted {:?}",
                        case.src,
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
    // L0181 doesn't declare input independence, so nothing is a value model.
    assert_eq!(values, 0, "{values} value models: L0181 reads its input, so every model is a plan");
    assert!(plans > 0, "no plans");
    println!("{plans} plans");
}
