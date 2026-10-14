// SPDX-License-Identifier: MIT

//! What L0174 adds to the kernel, beyond what the conformance fixture pins.

use graffiticode_l0000::{Compiler, Diagnostic, Identity, Lexicon, LexiconError};
use graffiticode_l0174::{L0174, lexicon};
use serde_json::{Value as Json, json};

fn program(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases.iter().find(|case| case["src"] == src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))["ast"]
        .clone()
}

async fn compile(src: &str, data: Json) -> Result<Option<Json>, Vec<Diagnostic>> {
    let compiled = Compiler::new(L0174).compile(&program(src), &data, &json!({}), Identity::default()).await;
    compiled.result.map(|value| value.to_json())
}

#[test]
fn the_lexicon_redefines_min_and_max_and_nothing_else() {
    let lexicon = lexicon();
    // 28 words are written; two of them replace base words.
    assert_eq!(lexicon.len(), Lexicon::base().len() + 26);
    for word in ["min", "max"] {
        let (ours, base) = (lexicon.get(word).unwrap(), Lexicon::base().get(word).unwrap());
        assert_eq!(ours.name, base.name, "the same node tag");
        assert_ne!(ours, base, "a different word");
        assert_eq!(ours.signature, None);
    }
    assert_eq!(lexicon.get("add"), Lexicon::base().get("add"));
    assert_eq!(lexicon.get("fields").unwrap().arity, 2);
    assert_eq!(lexicon.get("LIGHT").unwrap().name, "TAG");
}

#[test]
fn the_overrides_are_declared_not_silent() {
    // The same additions merged without the declaration are refused.
    let additions: Lexicon = serde_json::from_str(include_str!("../src/lexicon-additions.json")).unwrap();
    let err = Lexicon::base().merge(additions, &[], Some("L0174")).unwrap_err();
    assert_eq!(
        err,
        LexiconError::UndeclaredOverride { lang_id: Some("L0174".into()), words: vec!["min".into(), "max".into()] }
    );
}

#[tokio::test]
async fn min_and_max_are_field_attributes_here() {
    assert_eq!(compile("min 1 max 9 {}..", json!({})).await, Ok(Some(json!({ "min": 1, "max": 9 }))));
    let form = compile("fields [ number label 'Guests' min 0 max 5 {} ] {}..", json!({})).await.unwrap().unwrap();
    assert_eq!(form["fields"][0], json!({ "type": "number", "name": "guests", "label": "Guests", "min": 0, "max": 5 }));
}

#[tokio::test]
async fn the_forms_posted_state_is_read_from_an_envelope_too() {
    let enveloped = json!({ "data": { "title": "edited" }, "errors": [] });
    assert_eq!(compile("title 'Only a title' {}..", enveloped).await, Ok(Some(json!({ "title": "edited" }))));
}

#[tokio::test]
async fn a_field_that_needs_options_is_reported_at_the_field() {
    let errors = compile("fields [ select label 'Topic' {} ] {}..", json!({})).await.unwrap_err();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].message, "The select field \"Topic\" requires a non-empty options list.");
    assert!(errors[0].from >= 0 && errors[0].to > errors[0].from, "{errors:?}");
}
