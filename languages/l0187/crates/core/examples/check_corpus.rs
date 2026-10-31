// SPDX-License-Identifier: MIT

//! The corpus gate's compiler half (`npm run check-corpus`): compiles every parsed program in the
//! JSON file it is given (`[{n, ast}]`, or `{n, parseError}` for one the parser rejected) and
//! fails unless each compiles to a board the independent validator accepted. A program in the
//! RAG corpus is retrieved by every later generation, so one that does not compile, or compiles
//! to a board the compiler had to give up on, must not be embedded.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use serde_json::{Value as Json, json};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quiet = args.iter().any(|a| a == "--quiet");
    let file = args.iter().find(|a| !a.starts_with("--")).expect("usage: check_corpus <parsed.json> [--quiet]");
    let programs: Vec<Json> =
        serde_json::from_str(&std::fs::read_to_string(file).expect("the parsed file")).expect("JSON");
    let mut failed = Vec::new();
    for p in &programs {
        let n = p["n"].as_str().map(str::to_owned).unwrap_or_else(|| p["n"].to_string());
        if let Some(e) = p.get("parseError") {
            failed.push(format!("{n}: does not parse: {}", e.as_str().unwrap_or("")));
            continue;
        }
        let compiled = Compiler::new(L0187).compile(&p["ast"], &json!({}), &json!({}), Identity::default()).await;
        match compiled.result {
            Ok(value) => {
                let data = value.to_json().unwrap_or_default();
                if data["report"]["accepted"] != true {
                    failed.push(format!("{n}: compiled, but its board was not accepted"));
                } else if !quiet {
                    println!("{n}: ok");
                }
            }
            Err(errors) => failed.push(format!(
                "{n}: {}",
                errors
                    .iter()
                    .map(|e| format!("[{}] {}", e.code.as_deref().unwrap_or("error"), e.message))
                    .collect::<Vec<_>>()
                    .join("; ")
            )),
        }
    }
    for f in &failed {
        println!("FAIL {f}");
    }
    println!("{} of {} programs pass", programs.len() - failed.len(), programs.len());
    if !failed.is_empty() {
        let list: Vec<String> = failed.iter().map(|f| f.split(':').next().unwrap_or("").to_owned()).collect();
        println!("Regenerate with --only {}", list.join(","));
        std::process::exit(1);
    }
}
