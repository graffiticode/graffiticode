// SPDX-License-Identifier: MIT

//! What L0003 adds to the kernel, beyond what the conformance fixture pins.

use graffiticode_l0000::{Compiler, Diagnostic, Identity, Lexicon};
use graffiticode_l0003::{L0003, lexicon};
use serde_json::{Value as Json, json};

fn program(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases.iter().find(|case| case["src"] == src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))["ast"]
        .clone()
}

async fn compile(src: &str, data: Json) -> Result<Option<Json>, Vec<Diagnostic>> {
    let compiled = Compiler::new(L0003).compile(&program(src), &data, &json!({}), Identity::default()).await;
    compiled.result.map(|value| value.to_json())
}

#[test]
fn the_lexicon_is_the_base_language_and_four_words() {
    let lexicon = lexicon();
    assert_eq!(lexicon.len(), Lexicon::base().len() + 6);
    for (word, tag) in [("hello", "HELLO"), ("image", "IMAGE"), ("theme", "THEME"), ("id", "ID")] {
        assert_eq!(lexicon.get(word).unwrap().name, tag);
    }
    // DARK and LIGHT are tags, written without `tag`.
    assert_eq!(
        (lexicon.get("DARK").unwrap().name.as_str(), lexicon.get("LIGHT").unwrap().cls.as_str()),
        ("TAG", "val")
    );
    assert_eq!(lexicon.get("add"), Lexicon::base().get("add"));
}

#[tokio::test]
async fn upstream_data_is_read_from_an_envelope_too() {
    // A chained task hands its output over as `{ data, errors }`; the data model is what merges.
    let enveloped = json!({ "data": { "hello": "edited" }, "errors": [] });
    assert_eq!(
        compile(r#"theme DARK hello "world".."#, enveloped).await,
        Ok(Some(json!({ "theme": "dark", "hello": "edited" })))
    );
}

#[tokio::test]
async fn a_bad_argument_is_reported_where_it_is_written() {
    let errors = compile(r#"theme "dark" hello "world".."#, json!({})).await.unwrap_err();
    assert_eq!(errors, [Diagnostic::spanning("Expecting a tag DARK or tag LIGHT. Got the string \"dark\".", 6, 12)]);

    let errors = compile(r#"id 5 hello "world".."#, json!({})).await.unwrap_err();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].message, "id: expecting a string, e.g. id \"greeting\" hello \"world\". Got the number 5.");
}

#[tokio::test]
async fn a_non_record_result_is_not_merged_with_upstream_data() {
    for (src, expected) in [("42..", json!(42)), ("[1 2 3]..", json!([1, 2, 3])), (r#""text".."#, json!("text"))] {
        assert_eq!(compile(src, json!({ "hello": "edited" })).await, Ok(Some(expected)));
    }
}
