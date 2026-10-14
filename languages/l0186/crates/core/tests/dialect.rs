// SPDX-License-Identifier: MIT

//! What the conformance fixture does not record: error positions, upstream data, the lexicon.
//! The programs are the fixture's parsed ones.

use graffiticode_l0000::{Compiler, Dialect, Identity};
use graffiticode_l0186::{L0186, lexicon};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
}

fn ast(src: &str) -> Json {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases.into_iter().find(|case| case.src == src).unwrap_or_else(|| panic!("no case {src}")).ast
}

#[tokio::test]
async fn an_early_close_points_at_the_second_description() {
    // The TypeScript reports `{"from":44,"to":49}`: the `title "x" {}` after the board.
    let code = ast("board [ page [ sticky text \"A\" {} ] {} ] {} title \"x\" {}..");
    let errors =
        Compiler::new(L0186).compile(&code, &json!({}), &json!({}), Identity::default()).await.result.unwrap_err();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].message.starts_with("A `{}` ended a description early: the program has 2"));
    assert_eq!((errors[0].from, errors[0].to), (44, 49));
}

#[tokio::test]
async fn a_word_error_has_no_position() {
    let code = ast("board [ page [ sticky x 1 x 2 {} ] {} ] {}..");
    let errors =
        Compiler::new(L0186).compile(&code, &json!({}), &json!({}), Identity::default()).await.result.unwrap_err();
    assert_eq!(errors[0].message, "x: is given twice. Each word may appear once in a description.");
    assert_eq!((errors[0].from, errors[0].to), (-1, -1));
}

#[tokio::test]
async fn upstream_data_never_reaches_the_board() {
    let code = ast("board [ page [ ] {} ] {}..");
    for data in [json!({ "secret": 1 }), json!({ "data": { "secret": 1 }, "errors": [] })] {
        let board = Compiler::new(L0186).compile(&code, &data, &json!({}), Identity::default()).await.result.unwrap();
        assert_eq!(
            board.to_json().unwrap(),
            json!({ "type": "board", "showPageTabs": false, "showPageMenu": false, "pages": [{ "name": "Page 1", "nodes": [] }] })
        );
    }
}

#[tokio::test]
async fn save_to_figjam_adds_the_file_key_last() {
    let code = ast("board [ page [ sticky text \"A\" {} ] {} ] title \"T\" {} save-to-figjam \"ABC123\"..");
    let board = Compiler::new(L0186).compile(&code, &json!({}), &json!({}), Identity::default()).await.result.unwrap();
    let board = board.to_json().unwrap();
    assert_eq!(board["fileKey"], "ABC123");
    assert_eq!(board.as_object().unwrap().keys().next_back().unwrap(), "fileKey");
}

#[test]
fn no_base_word_is_shadowed() {
    // The shape kind OR is a tag, so L0000's logical `or` keeps working.
    let lexicon = serde_json::to_value(lexicon()).unwrap();
    assert_eq!(lexicon["or"]["name"], "OR");
    assert_eq!(lexicon["OR"]["name"], "TAG");
    assert_eq!(lexicon["save-to-figjam"]["arity"], 1);
    assert_eq!(lexicon["board"]["arity"], 2);
    assert!(L0186.cacheable());
}
