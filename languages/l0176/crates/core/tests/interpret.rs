// SPDX-License-Identifier: MIT

//! L0176 on the interpreter (C6 part 2, docs/c6-l0176-reads-plan.md), over the conformance
//! corpus, as the envelopes the server sends (`Compiler::envelope`):
//!
//! - every `/compile` and every `present` answer is `cache: false`, whatever it holds: an
//!   activity, any other value, or compile errors (the legacy API reads anything else as
//!   permanent); no `evaluate` answer carries `cache`;
//! - `present` answers exactly as `/compile` does, and `evaluate` the same with the signing
//!   removed;
//! - nothing in an answer changes from one compile to the next, and a generated activity id
//!   changes with the content.

use graffiticode_l0000::{Compilation, Compiler, Identity, Mode};
use graffiticode_l0176::L0176;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
}

fn cases() -> Vec<Case> {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() >= 200, "the fixture looks truncated: {} cases", cases.len());
    cases
}

fn label(src: &str) -> String {
    src.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

/// An answer's data, or its errors, without the cache fields.
fn answer(compiler: &Compiler, compiled: &Compilation) -> Json {
    let mut envelope = compiler.envelope(compiled);
    let object = envelope.as_object_mut().unwrap();
    object.remove("cache");
    object.remove("expiresAt");
    envelope
}

/// What `evaluate` leaves out: the signing of the head's activity.
fn unsigned(mut answer: Json) -> Json {
    if let Some(Json::Object(data)) = answer.get_mut("data") {
        data.remove("request");
        data.remove("signing");
    }
    answer
}

/// Two programs that aren't in the corpus: a compile error and a value that isn't an activity.
fn extra() -> Vec<Case> {
    let error = json!({
        "4": { "tag": "NUM", "elts": ["3"] }, "5": { "tag": "NUM", "elts": ["0"] },
        "6": { "tag": "STR", "elts": ["Too few arguments for ADD. Expected 2."] },
        "7": { "tag": "ERROR", "elts": [6, 5, 4] }, "root": 7,
    });
    let number = json!({
        "1": { "tag": "NUM", "elts": ["1"] }, "2": { "tag": "EXPRS", "elts": [1] },
        "3": { "tag": "PROG", "elts": [2] }, "root": 3,
    });
    vec![Case { src: "add 1..".into(), ast: error }, Case { src: "1..".into(), ast: number }]
}

#[tokio::test]
async fn every_compile_and_present_answer_is_cache_false_and_no_evaluate_answer_has_cache() {
    let compiler = Compiler::new(L0176::new());
    let (mut errors, mut values, mut failures) = (0, 0, Vec::new());
    for case in cases().into_iter().chain(extra()) {
        let compiled = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
        if compiled.result.is_err() {
            errors += 1
        } else {
            values += 1
        }
        let envelope = compiler.envelope(&compiled);
        if envelope.get("cache") != Some(&json!(false)) {
            failures.push(format!("/compile {}: {envelope}", label(&case.src)));
        }
        // A program that compiles has a model; a plan, since `init` is implicit.
        let Ok(model) = compiler.model(&case.ast, &json!({})).await else { continue };
        for mode in [Mode::Present, Mode::Evaluate] {
            let interpreted = compiler.interpret(&model, &json!({}), &json!({}), mode, Identity::default()).await;
            let envelope = compiler.envelope(&interpreted);
            let expected = (mode == Mode::Present).then(|| json!(false));
            if envelope.get("cache") != expected.as_ref() {
                failures.push(format!("{mode:?} {}: {envelope}", label(&case.src)));
            }
        }
    }
    assert!(errors > 0 && values > 0, "the corpus has both errors ({errors}) and values ({values})");
    assert!(failures.is_empty(), "{} answers break the legacy contract:\n{}", failures.len(), failures.join("\n"));
}

#[tokio::test]
async fn present_answers_as_compile_and_evaluate_is_the_same_unsigned() {
    let compiler = Compiler::new(L0176::new());
    let (mut interpreted, mut failures) = (0, Vec::new());
    for case in cases() {
        let Ok(model) = compiler.model(&case.ast, &json!({})).await else { continue };
        interpreted += 1;
        let compiled =
            answer(&compiler, &compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await);
        let present = compiler.interpret(&model, &json!({}), &json!({}), Mode::Present, Identity::default()).await;
        let evaluate = compiler.interpret(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default()).await;
        if answer(&compiler, &present) != compiled {
            failures.push(format!("present {}", label(&case.src)));
        }
        let evaluated = answer(&compiler, &evaluate);
        if evaluated != unsigned(compiled.clone()) {
            failures.push(format!("evaluate {}:\n  compiled  {compiled}\n  evaluated {evaluated}", label(&case.src)));
        }
        // Data for the next stage is never signed, at any depth.
        let text = evaluated.to_string();
        if text.contains("\"signing\"") || text.contains("\"request\"") {
            failures.push(format!("evaluate {} is signed: {text}", label(&case.src)));
        }
    }
    assert!(interpreted >= 150, "only {interpreted} cases have a model");
    let total = failures.len();
    failures.truncate(8);
    assert!(failures.is_empty(), "{total} cases differ:\n{}", failures.join("\n"));
}

#[tokio::test]
async fn nothing_in_an_answer_changes_from_one_compile_to_the_next() {
    let compiler = Compiler::new(L0176::new());
    let (mut generated, mut failures) = (0, Vec::new());
    for case in cases() {
        let first = compiler.envelope(&compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await);
        let second = compiler.envelope(&compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await);
        if first != second {
            failures.push(format!("{}:\n  {first}\n  {second}", label(&case.src)));
        }
        let text = first.to_string();
        if text.contains("session_id") {
            failures.push(format!("{} carries a session_id: {text}", label(&case.src)));
        }
        generated += first["data"]["data"]["id"].as_str().is_some_and(|id| id.starts_with("graffiticode-")) as usize;
    }
    assert!(generated >= 30, "only {generated} cases build a questions activity");
    assert!(failures.is_empty(), "{} cases change:\n{}", failures.len(), failures.join("\n"));
}

/// Every string node in the program equal to `from` becomes `to`.
fn replace_strings(ast: &mut Json, from: &str, to: &str) -> usize {
    let mut replaced = 0;
    for node in ast.as_object_mut().unwrap().values_mut() {
        if node["tag"] == "STR" && node["elts"][0] == from {
            node["elts"][0] = json!(to);
            replaced += 1;
        }
    }
    replaced
}

#[tokio::test]
async fn a_generated_activity_id_changes_with_the_content_and_an_explicit_one_is_kept() {
    let compiler = Compiler::new(L0176::new());
    let data = |compiled: Compilation| compiled.result.unwrap().to_json().unwrap();
    let mut checked = 0;
    for case in cases() {
        let Ok(value) = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await.result else {
            continue;
        };
        let value = value.to_json().unwrap_or(Json::Null);
        let Some(id) = value["data"]["id"].as_str().filter(|id| id.starts_with("graffiticode-")) else { continue };
        let Some(stimulus) = value["data"]["questions"][0]["stimulus"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut changed = case.ast.clone();
        if replace_strings(&mut changed, stimulus, &format!("{stimulus} (edited)")) == 0 {
            continue;
        }
        let edited = data(compiler.compile(&changed, &json!({}), &json!({}), Identity::default()).await);
        let edited_id = edited["data"]["id"].as_str().unwrap();
        assert!(edited_id.starts_with("graffiticode-") && edited_id != id, "{}: {id} -> {edited_id}", label(&case.src));
        checked += 1;
    }
    assert!(checked >= 10, "only {checked} cases had a stimulus to edit");
    // An explicit id is the activity's own: an items activity's is its `lrn-id`.
    let items = cases().into_iter().find(|case| case.src.contains("\"lrn-id\" \"t\" items")).unwrap();
    let items = data(compiler.compile(&items.ast, &json!({}), &json!({}), Identity::default()).await);
    assert_eq!(items["data"]["id"], "t");
}
