// SPDX-License-Identifier: MIT

//! What L0010 adds to the kernel, beyond what the conformance fixture pins.

use graffiticode_l0000::{Compiler, Diagnostic, Identity, Lexicon};
use graffiticode_l0010::{L0010, MAX_STAGES, is_language_id, lexicon};
use serde_json::{Value as Json, json};

fn program(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases.iter().find(|case| case["src"] == src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))["ast"]
        .clone()
}

async fn errors(src: &str) -> Vec<Diagnostic> {
    Compiler::new(L0010).compile(&program(src), &json!({}), &json!({}), Identity::default()).await.result.unwrap_err()
}

#[test]
fn the_lexicon_is_the_base_language_and_plan() {
    assert_eq!(lexicon().len(), Lexicon::base().len() + 1);
    assert_eq!(lexicon().get("plan").unwrap().name, "PLAN");
    assert_eq!(lexicon().get("add"), Lexicon::base().get("add"));
}

#[test]
fn a_language_id_is_three_to_five_digits() {
    for id in ["158", "0158", "01580"] {
        assert!(is_language_id(id), "{id}");
    }
    for not in ["", "12", "123456", "abc", "01a8", " 158", "0158 ", "٠١٥٨"] {
        assert!(!is_language_id(not), "{not:?}");
    }
}

#[tokio::test]
async fn a_bad_stage_is_reported_where_it_is_written() {
    let found = errors(r#"plan ["bad" "0158" "0158" 7].."#).await;
    assert_eq!(found.len(), 3);
    assert_eq!(found[0], Diagnostic::spanning("plan: \"bad\" is not a language id.", 6, 11));
    assert_eq!(found[1], Diagnostic::spanning("plan: duplicate language \"0158\".", 19, 25));
    assert_eq!(found[2].message, "plan: each element must be a language id string.");
}

#[tokio::test]
async fn a_plan_is_bounded() {
    assert_eq!(MAX_STAGES, 4);
    let found = errors(r#"plan ["0001" "0002" "0003" "0004" "0005"].."#).await;
    assert_eq!(found, [Diagnostic::spanning("plan: at most 4 stages.", 0, 4)]);
}
