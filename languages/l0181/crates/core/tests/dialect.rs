// SPDX-License-Identifier: MIT

//! The dialect beyond what the fixture compares: where errors point, and the lexicon.

use graffiticode_l0000::{Compiler, Diagnostic, Identity};
use graffiticode_l0181::{L0181, lexicon};
use serde_json::{Value as Json, json};

fn ast(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases.into_iter().find(|case| case["src"] == src).map(|case| case["ast"].clone()).unwrap()
}

async fn errors(ast: &Json) -> Vec<Diagnostic> {
    Compiler::new(L0181).compile(ast, &json!({}), &json!({}), Identity::default()).await.result.unwrap_err()
}

/// The THEME node's first argument.
fn argument(ast: &Json) -> &Json {
    let theme = ast.as_object().unwrap().values().find(|node| node["tag"] == "THEME").unwrap();
    &ast[theme["elts"][0].as_u64().unwrap().to_string()]
}

#[tokio::test]
async fn a_bad_theme_points_at_what_it_was_given() {
    // The TypeScript spreads the argument node's `coord` into the error.
    let ast = ast(r#"cards [["a" "b"]] theme "dark" {}.."#);
    let coord = &argument(&ast)["coord"];
    let errors = errors(&ast).await;
    assert_eq!(errors.len(), 1);
    assert_eq!((errors[0].from, errors[0].to), (coord["from"].as_i64().unwrap(), coord["to"].as_i64().unwrap()));
}

#[tokio::test]
async fn a_node_without_a_position_gives_none() {
    // A number literal carries no `coord`, so the TypeScript error has -1/-1.
    let ast = ast(r#"cards [["a" "b"]] theme 3 {}.."#);
    assert!(argument(&ast).get("coord").is_none());
    let errors = errors(&ast).await;
    assert_eq!((errors[0].from, errors[0].to), (-1, -1));
}

#[tokio::test]
async fn a_bad_deck_has_no_position() {
    // The Transformer's errors are strings in the TypeScript.
    let errors = errors(&ast("cards [] {}..")).await;
    assert_eq!((errors[0].from, errors[0].to), (-1, -1));
}

#[test]
fn the_lexicon_has_the_deck_words() {
    let lexicon = serde_json::to_value(lexicon()).unwrap();
    for word in ["cards", "title", "instructions", "theme", "DARK", "LIGHT"] {
        assert!(lexicon.get(word).is_some(), "{word}");
    }
    assert_eq!(lexicon["theme"]["arity"], 2);
    assert_eq!(lexicon["DARK"]["name"], "TAG");
    // The base vocabulary is still there.
    assert!(lexicon.get("add").is_some());
}
