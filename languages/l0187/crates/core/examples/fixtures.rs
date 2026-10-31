// SPDX-License-Identifier: MIT

//! Writes packages/view/embed/fixtures.json for the view's dev page: every valid test and
//! documentation program, compiled. `cargo run -q --example fixtures`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use serde_json::{Value as Json, json};

#[tokio::main]
async fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    for file in ["tests/doc-cases.json", "tests/cases.json"] {
        let cases: Vec<Json> = serde_json::from_str(&std::fs::read_to_string(dir.join(file)).unwrap()).unwrap();
        for case in cases {
            let compiled =
                Compiler::new(L0187).compile(&case["ast"], &json!({}), &json!({}), Identity::default()).await;
            if let Ok(value) = compiled.result {
                out.push(json!({ "name": case["name"], "data": value.to_json() }));
            }
        }
    }
    let path = dir.join("../../packages/view/embed/fixtures.json");
    std::fs::write(&path, serde_json::to_string(&out).unwrap()).unwrap();
    println!("wrote {} fixtures to {}", out.len(), path.display());
}
