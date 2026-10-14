// SPDX-License-Identifier: MIT

//! The dialect across compiles: what one compile cannot show the conformance test.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0182::L0182;
use graffiticode_l0182::source::Files;
use serde_json::{Value as Json, json};

/// The AST of a corpus program.
fn ast(src: &str) -> Json {
    let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    cases
        .into_iter()
        .find(|case| case["src"] == src)
        .map(|case| case["ast"].clone())
        .expect("the case is in the corpus")
}

async fn compile(compiler: &Compiler, ast: &Json, data: Json) -> Json {
    compiler.compile(ast, &data, &json!({}), Identity::default()).await.result.unwrap().to_json().unwrap()
}

#[tokio::test]
async fn a_session_keeps_its_version_from_one_compile_to_the_next() {
    let compiler = Compiler::new(L0182::default());
    let taken = ast(r#"survey [ id "civic-priorities" session-id "s-1" ].."#);
    let first = compile(&compiler, &taken, json!({})).await["survey"]["instance"].clone();
    for _ in 0..5 {
        assert_eq!(compile(&compiler, &taken, json!({})).await["survey"]["instance"], first);
    }
}

#[tokio::test]
async fn without_a_session_every_version_is_drawn_before_any_twice() {
    let compiler = Compiler::new(L0182::with_source(Files::installed(|len| len / 2)));
    let taken = ast(r#"survey [ id "civic-priorities"  ].."#);
    let mut seen = std::collections::HashSet::new();
    for _ in 0..12 {
        seen.insert(compile(&compiler, &taken, json!({})).await["survey"]["instance"].to_string());
    }
    assert_eq!(seen.len(), 12);
}

#[tokio::test]
async fn the_data_a_compile_is_handed_never_reaches_the_output() {
    // PROG ignores `data`: a stored model, an envelope singly or doubly wrapped, or nothing.
    let compiler = Compiler::new(L0182::default());
    let taken = ast(r#"survey [ id "school-1" ].."#);
    let plain = compile(&compiler, &taken, json!({})).await;
    for data in [
        json!({ "response": { "choices": ["o0"] } }),
        json!({ "survey": { "title": "STALE", "options": [] } }),
        json!({ "data": { "survey": { "title": "STALE" } }, "errors": [] }),
        json!({ "data": { "data": { "survey": { "title": "STALE" } }, "errors": [] }, "errors": [] }),
        json!(null),
        json!("nope"),
        json!([]),
    ] {
        assert_eq!(compile(&compiler, &taken, data).await, plain);
    }
}
