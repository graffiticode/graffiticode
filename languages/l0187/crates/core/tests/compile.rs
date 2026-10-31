// SPDX-License-Identifier: MIT

//! Compiles every test program and compares the result with the reviewed snapshot in
//! `expected.json`: the output for a valid program; for an invalid one (`invalid-*`), every
//! error's message, code, category and position. Error text is a product surface, so a change to
//! any message shows up here.
//!
//! After a deliberate change, regenerate and review the diff:
//!
//! ```text
//! UPDATE_EXPECT=1 cargo test --test compile
//! ```

use std::collections::BTreeMap;
use std::path::Path;

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    name: String,
    ast: Json,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("cases.json")).unwrap()
}

pub async fn compile(ast: &Json, data: &Json) -> Json {
    let compiled = Compiler::new(L0187).compile(ast, data, &json!({}), Identity::default()).await;
    match compiled.result {
        Ok(value) => json!({ "data": value.to_json() }),
        Err(errors) => json!({ "errors": errors }),
    }
}

#[tokio::test]
async fn every_program_compiles_as_reviewed() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/expected.json");
    let mut actual = BTreeMap::new();
    for case in cases() {
        let result = compile(&case.ast, &json!({})).await;
        let failed = result.get("errors").is_some();
        let invalid = case.name.starts_with("invalid-");
        assert_eq!(failed, invalid, "{}: {}", case.name, serde_json::to_string_pretty(&result).unwrap());
        actual.insert(case.name, result);
    }
    let text = serde_json::to_string_pretty(&actual).unwrap() + "\n";
    if std::env::var_os("UPDATE_EXPECT").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let expected: BTreeMap<String, Json> =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("tests/expected.json; run with UPDATE_EXPECT=1"))
            .unwrap();
    let mut differences = Vec::new();
    for (name, result) in &actual {
        match expected.get(name) {
            Some(want) if want == result => {}
            Some(want) => differences.push(format!(
                "{name}\n  expected {}\n  got      {}",
                serde_json::to_string(want).unwrap(),
                serde_json::to_string(result).unwrap()
            )),
            None => differences.push(format!("{name}: no snapshot")),
        }
    }
    for name in expected.keys().filter(|name| !actual.contains_key(*name)) {
        differences.push(format!("{name}: snapshot of a program that no longer exists"));
    }
    assert!(
        differences.is_empty(),
        "{} differ (UPDATE_EXPECT=1 to accept):\n\n{}",
        differences.len(),
        differences.join("\n\n")
    );
}

/// Upstream data never reaches the board, and a program that reads none compiles the same
/// against any input.
#[tokio::test]
async fn upstream_data_never_reaches_the_board() {
    for case in cases().iter().filter(|c| !c.name.starts_with("invalid-")) {
        let alone = compile(&case.ast, &json!({})).await;
        let chained = compile(&case.ast, &json!({ "data": { "x": 10, "pages": [] }, "errors": [] })).await;
        assert_eq!(alone, chained, "{}", case.name);
    }
}

/// Identical input compiles to identical bytes.
#[tokio::test]
async fn compiling_is_repeatable() {
    for case in cases() {
        let first = serde_json::to_string(&compile(&case.ast, &json!({})).await).unwrap();
        let second = serde_json::to_string(&compile(&case.ast, &json!({})).await).unwrap();
        assert_eq!(first, second, "{}", case.name);
    }
}

/// Every compiled board matches the published schema (`generated/schema.json`), and that file is
/// the one the schema module emits.
#[tokio::test]
async fn every_compiled_board_matches_the_schema() {
    let text = include_str!("../../../generated/schema.json");
    assert!(text == graffiticode_l0187::schema::schema_json(), "generated/schema.json is stale: run `npm run emit`");
    let schema: Json = serde_json::from_str(text).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for case in cases().iter().filter(|c| !c.name.starts_with("invalid-")) {
        let data = compile(&case.ast, &json!({})).await["data"].clone();
        let errors: Vec<String> =
            validator.iter_errors(&data).map(|e| format!("{} at {}", e, e.instance_path())).collect();
        assert!(errors.is_empty(), "{}: {}", case.name, errors.join("\n"));
    }
    // The schema is strict: an unknown field, or a mark off the whole-pixel grid, is rejected.
    let retro = cases().into_iter().find(|c| c.name == "retro").unwrap();
    let mut data = compile(&retro.ast, &json!({})).await["data"].clone();
    data["pages"][0]["nodes"][0]["x"] = json!(1.5);
    assert!(!validator.is_valid(&data));
    let mut data = compile(&retro.ast, &json!({})).await["data"].clone();
    data["pages"][0]["extra"] = json!(true);
    assert!(!validator.is_valid(&data));
}
