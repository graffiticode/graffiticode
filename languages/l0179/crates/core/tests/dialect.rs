// SPDX-License-Identifier: MIT

//! What L0179 adds to the kernel, beyond what the conformance fixture pins.

use graffiticode_l0000::{Compiler, Identity, Lexicon};
use graffiticode_l0179::{L0179, lexicon};
use serde_json::{Value as Json, json};

fn program(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    if let Some(case) = cases.iter().find(|case| case["src"] == src) {
        return case["ast"].clone();
    }
    let programs: Json = serde_json::from_str(include_str!("conformance/programs.json")).unwrap();
    programs.get(src).cloned().unwrap_or_else(|| panic!("no parsed program for {src:?}"))
}

async fn compile(src: &str, data: Json) -> Result<Option<Json>, Vec<String>> {
    let compiled = Compiler::new(L0179).compile(&program(src), &data, &json!({}), Identity::default()).await;
    compiled.result.map(|value| value.to_json()).map_err(|errors| errors.into_iter().map(|e| e.message).collect())
}

fn with_params(params: &str) -> String {
    format!(r#"sheets [ sheet "s1" [ cells [ cell A1 [text "x"] ] {{}} ] ] params {params} {{}}.."#)
}

#[test]
fn the_lexicon_adds_the_spreadsheet_words_and_address_barewords() {
    let lexicon = lexicon();
    for (word, tag, arity) in
        [("sheets", "SHEETS", 2), ("cell", "CELL", 2), ("params", "PARAMS", 2), ("font-size", "FONT_SIZE", 1)]
    {
        let entry = lexicon.get(word).unwrap();
        assert_eq!((entry.name.as_str(), entry.arity), (tag, arity), "{word}");
    }
    // Chaining attributes are arity 2: their value and the rest of the chain.
    assert_eq!(lexicon.get("title").unwrap().arity, 2);
    // `A1` and `A` parse as tags through regex-keyed entries.
    for pattern in ["^[A-Z][0-9]+$", "^[A-Z]$"] {
        assert_eq!(lexicon.get(pattern).unwrap().name, "TAG", "{pattern}");
    }
    assert_eq!(lexicon.get("add"), Lexicon::base().get("add"));
}

#[tokio::test]
async fn bare_upstream_data_supplies_params_and_lies_over_the_output() {
    let src = r#"sheets [ sheet "s1" [ cells [ cell A1 [text "{{A1}}"] ] {} ] ] params {"A1": "10..50:10"} {}.."#;
    let out = compile(src, json!({ "params": { "A1": "1..3" }, "limit": 2, "seen": true })).await.unwrap().unwrap();
    assert_eq!(out["templateVariablesRecords"], json!([{ "A1": "1" }, { "A1": "2" }]));
    assert_eq!(out["seen"], json!(true));
    assert_eq!(out["limit"], json!(2));
}

#[tokio::test]
async fn what_the_typescript_never_answers_is_a_compile_error() {
    // Each of these throws out of the TypeScript compiler's callbacks, or loops forever, so
    // it never resumes; the language server's request hangs. Here each is a compile error.
    for (src, error) in [
        (with_params(r#"{"A1": 1}"#), "TypeError: s.split is not a function (1)"),
        (with_params("[5]"), "TypeError: keys.forEach is not a function (5)"),
        (
            with_params(r#"{"B1": "1,2" "A1": "=B1"}"#),
            r#"params: "=B1" is a formula, which a parameter value cannot be yet."#,
        ),
        ("{cells: null}..".to_owned(), "TypeError: Cannot convert undefined or null to object"),
        (
            "{rows: null cells: {A1: {assess: {}}}}..".to_owned(),
            "TypeError: Cannot read properties of null (reading '*')",
        ),
    ] {
        assert_eq!(compile(&src, json!({})).await, Err(vec![error.to_owned()]), "{src}");
    }
}

#[tokio::test]
async fn a_range_that_never_ends_is_refused() {
    for range in ["1..2:0", "1..Infinity"] {
        let errors = compile(&with_params(&format!(r#"{{"A1": "{range}"}}"#)), json!({})).await.unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with(&format!("params: the range \"{range}\" does not end")), "{}", errors[0]);
    }
}
