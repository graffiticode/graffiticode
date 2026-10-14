// SPDX-License-Identifier: MIT

//! The Rust compiler with the real translator behind it: Node, running
//! `tools/translatex-worker.mjs` and the `@graffiticode/translatex` installed in this
//! directory. Every conformance case must then come out byte-identical to what the TypeScript
//! compiler produced, corpus translations included.
//!
//! Skipped, loudly, where Node or the installed library is missing (CI's Rust image has
//! neither). The translator-free half of the comparison always runs, in the core crate.

use std::path::{Path, PathBuf};

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0014::{L0014, Translator};
use l0014_worker::NodeTranslator;
use serde_json::{Value as Json, json};

fn language_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn translator() -> Option<NodeTranslator> {
    let dir = language_dir();
    let installed = dir.join("node_modules/@graffiticode/translatex").is_dir();
    let node = std::process::Command::new("node").arg("--version").output().is_ok_and(|out| out.status.success());
    if !(installed && node) {
        eprintln!("SKIPPED: Node or @graffiticode/translatex is not installed; the real translator was not exercised");
        return None;
    }
    Some(NodeTranslator { node: "node".into(), script: dir.join("tools/translatex-worker.mjs") })
}

#[tokio::test(flavor = "multi_thread")]
async fn every_case_matches_typescript_with_the_real_translator() {
    let Some(translator) = translator() else { return };
    let cases: Vec<Json> = serde_json::from_str(include_str!("../../core/tests/conformance/cases.json")).unwrap();
    let compiler = Compiler::new(L0014::new(translator));
    let mut scored = 0;
    for case in &cases {
        let Some(expected) = case["expect"]["text"].as_str() else { continue };
        let value = compiler.compile(&case["ast"], &json!({}), &json!({}), Identity::default()).await.result.unwrap();
        let label: String = case["src"].as_str().unwrap().chars().take(80).collect();
        assert_eq!(serde_json::to_string(&value.to_json()).unwrap(), expected, "{label}");
        scored += case["expect"]["data"]["tests"].as_array().map_or(0, Vec::len);
    }
    assert!(scored >= 8, "the corpus cases were translated: {scored}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_that_does_not_parse_is_an_answer_with_errors() {
    let Some(translator) = translator() else { return };
    let rules = json!({ "data": {}, "rules": { "?+?": ["%1 plus %2"], "?": ["%1"] } });
    let answers = translator.translate(&rules, &["1+2".to_owned(), "\\frac{".to_owned()]).await.unwrap();
    assert_eq!(answers[0].value, "1 plus 2");
    assert!(answers[0].errors.is_empty());
    assert_eq!(answers[1].value, "");
    // The message, without the stack trace and file paths the library attaches.
    assert_eq!(answers[1].errors.len(), 1);
    assert!(answers[1].errors[0].starts_with("1001: "), "{:?}", answers[1].errors);
    assert!(!answers[1].errors[0].contains("node_modules"), "{:?}", answers[1].errors);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_large_corpus_does_not_stall_the_pipe() {
    let Some(translator) = translator() else { return };
    let rules = json!({ "data": {}, "rules": { "?+?": ["%1 plus %2"], "?": ["%1"] } });
    let sources: Vec<String> = (0..2000).map(|n| format!("{n}+{}", "9".repeat(60))).collect();
    let answers = translator.translate(&rules, &sources).await.unwrap();
    assert_eq!(answers.len(), 2000);
    assert_eq!(answers[1999].value, format!("1999 plus {}", "9".repeat(60)));
}

#[tokio::test]
async fn a_translator_that_cannot_start_is_a_compile_error_not_a_wrong_score() {
    // `tests` needs the translator; a program without a corpus never starts one.
    let cases: Vec<Json> = serde_json::from_str(include_str!("../../core/tests/conformance/cases.json")).unwrap();
    let program = |src: &str| cases.iter().find(|case| case["src"] == src).unwrap()["ast"].clone();
    let missing = NodeTranslator { node: "/nonexistent/node".into(), script: "worker.mjs".into() };
    let compiler = Compiler::new(L0014::new(missing));

    let with_corpus = program(r#"tests [["1+2" "1 plus 2"]] rules {"?+?": "%1 plus %2", "?": "%1"}.."#);
    let errors = compiler.compile(&with_corpus, &json!({}), &json!({}), Identity::default()).await.result.unwrap_err();
    assert_eq!(errors.len(), 1);
    assert!(
        errors[0].message.starts_with("tests: could not run TransLaTeX: /nonexistent/node did not start"),
        "{errors:?}"
    );

    let rules_only = program(r#"rules {"?+?": "%1 + %2"}.."#);
    let value = compiler.compile(&rules_only, &json!({}), &json!({}), Identity::default()).await.result.unwrap();
    assert_eq!(value.to_json().unwrap()["options"]["rules"], json!({ "?+?": ["%1 + %2"] }));
}
