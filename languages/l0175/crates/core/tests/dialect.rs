// SPDX-License-Identifier: MIT

//! What L0175 adds to the kernel, beyond what the conformance fixture pins.

use std::collections::HashMap;

use graffiticode_l0000::{Compiler, Identity, Lexicon, Value};
use graffiticode_l0175::authored::Program;
use graffiticode_l0175::compose::{compose, plausibility};
use graffiticode_l0175::{L0175, lexicon};
use serde_json::{Value as Json, json};

fn cases() -> Vec<Json> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

/// The parsed program whose source contains every one of `marks`, and nothing in `without`.
fn program(marks: &[&str], without: &[&str]) -> Json {
    let has = |case: &Json, mark: &&str| case["src"].as_str().unwrap().contains(*mark);
    let found = cases()
        .into_iter()
        .find(|case| marks.iter().all(|mark| has(case, mark)) && !without.iter().any(|mark| has(case, mark)));
    found.unwrap_or_else(|| panic!("no program with {marks:?}"))["ast"].clone()
}

async fn compile(ast: &Json) -> graffiticode_l0000::Compilation {
    Compiler::new(L0175).compile(ast, &json!({}), &json!({}), Identity::default()).await
}

#[test]
fn the_lexicon_adds_the_builder_words_and_redefines_nothing() {
    let lexicon = lexicon();
    assert_eq!(lexicon.len(), Lexicon::base().len() + 122);
    assert_eq!(lexicon.get("task-model").unwrap().name, "TASK_MODEL");
    assert_eq!(lexicon.get("claim").unwrap().arity, 1);
    assert_eq!(lexicon.get("c1-t10").unwrap().name, "TAG");
    assert_eq!(lexicon.get("add"), Lexicon::base().get("add"));
}

#[tokio::test]
async fn a_problem_points_at_the_element_it_is_about() {
    // A source with neither a line nor a quote, the last of five.
    let ast = program(&[r#"source id "e8" status irrelevant {}"#], &[]);
    let errors = compile(&ast).await.result.unwrap_err();
    let about = errors.iter().find(|error| error.message == "source 'e8': needs a line number or a quote.").unwrap();
    assert!(about.from > 0 && about.to > about.from, "{about:?}");
    // The whole program's problems have no place.
    let errors = compile(&program(&["42.."], &["target"])).await.result.unwrap_err();
    assert_eq!((errors[0].message.as_str(), errors[0].from, errors[0].to), ("Passage has no `lines`.", -1, -1));
}

#[tokio::test]
async fn where_an_element_was_written_never_reaches_the_item() {
    for case in cases() {
        if let Ok(value) = compile(&case["ast"]).await.result {
            let text = value.to_json().map(|json| json.to_string()).unwrap_or_default();
            assert!(!text.contains("\\u0000"), "{}", case["src"]);
        }
    }
}

#[tokio::test]
async fn composing_twice_gives_the_same_item() {
    let ast = program(&[r#"outcome id "q1" type ebsr"#, r#"outcome id "q3" type hot-text"#], &[]);
    let first = compile(&ast).await.result.unwrap().to_json();
    assert_eq!(first, compile(&ast).await.result.unwrap().to_json());
    let items = first.unwrap();
    // Three questions over one pool: the correct option is not at the same label each time.
    let keys: Vec<&str> = [0, 2].iter().map(|i| items["items"][*i]["answerKey"]["partA"].as_str().unwrap()).collect();
    assert_ne!(keys[0], keys[1], "{keys:?}");
}

#[test]
fn an_empty_program_composes_to_no_items_and_says_what_is_missing() {
    let (value, problems) = compose(Program::read(&Value::Undefined));
    assert_eq!(value, json!({ "kind": "items", "items": [], "grade": 5 }));
    assert_eq!(
        problems.iter().map(|problem| problem.message.as_str()).collect::<Vec<_>>(),
        ["Passage has no `lines`."]
    );
}

#[test]
fn an_authors_plausibility_settles_the_score() {
    let read = |json: Json| Program::read(&Value::from_json(&json!({ "claims": [json] }))).claims.remove(0);
    let correct = read(json!({ "id": "c1", "text": "Mara cares about the pool.", "dimension": "character" }));
    let pinned = read(json!({ "id": "d1", "text": "x", "plausibility": 7 }));
    assert_eq!(plausibility(&pinned, &correct, &HashMap::new()), 1.0);
    // Unpinned: the base, the same dimension, a similar length, and the kind of error.
    let like = read(
        json!({ "id": "d2", "text": "Mara fears the cold pool.", "dimension": "character", "errorType": "faulty-reasoning" }),
    );
    let unlike = read(json!({ "id": "d3", "text": "No.", "dimension": "setting" }));
    let (like, unlike) =
        (plausibility(&like, &correct, &HashMap::new()), plausibility(&unlike, &correct, &HashMap::new()));
    assert!(like > 0.7 && unlike < 0.45, "{like} {unlike}");
}
