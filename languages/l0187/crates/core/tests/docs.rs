// SPDX-License-Identifier: MIT

//! Every program in the published documentation compiles as it says (design §12, language
//! documentation guidelines): each ```gc block in `spec/*.md` and `spec/template.gc` compiles to
//! a board the validator accepted and the schema allows; each ```gc-invalid <code> block is
//! rejected with an error of that code. `npm run cases` re-extracts them; `cases:check` fails
//! when the docs changed and `doc-cases.json` did not.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct DocCase {
    name: String,
    expect: String,
    ast: Json,
}

#[tokio::test]
async fn every_documented_program_compiles_as_documented() {
    let cases: Vec<DocCase> = serde_json::from_str(include_str!("doc-cases.json")).unwrap();
    assert!(cases.len() >= 10, "the docs hold {} programs", cases.len());
    assert!(cases.iter().any(|c| c.name == "template.gc"));
    let schema: Json = serde_json::from_str(include_str!("../../../generated/schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let mut failures = Vec::new();
    for case in &cases {
        let compiled = Compiler::new(L0187).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
        match (case.expect.as_str(), compiled.result) {
            ("valid", Ok(value)) => {
                let data = value.to_json().unwrap();
                let errors: Vec<String> = validator.iter_errors(&data).map(|e| e.to_string()).collect();
                if !errors.is_empty() {
                    failures.push(format!("{}: does not match the schema: {}", case.name, errors.join("; ")));
                }
                if data["report"]["accepted"] != true {
                    failures.push(format!("{}: not accepted by the validator", case.name));
                }
            }
            ("valid", Err(errors)) => failures.push(format!(
                "{}: documented as valid but fails: {}",
                case.name,
                errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>().join("; ")
            )),
            (code, Ok(_)) => failures.push(format!("{}: documented as failing with {code} but compiles", case.name)),
            (code, Err(errors)) => {
                if !errors.iter().any(|e| e.code.as_deref() == Some(code)) {
                    failures.push(format!(
                        "{}: expected an error coded {code}, got {:?}",
                        case.name,
                        errors.iter().map(|e| e.code.clone()).collect::<Vec<_>>()
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
