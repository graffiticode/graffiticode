// SPDX-License-Identifier: MIT

//! The backfill extractor's CLI: reads `{ "program": <AST pool>, "output": <saved value>?,
//! "errors": <bool>? }` from standard input and writes the report (`backfill::extract`) to
//! standard output. Pure: it opens no file, store or network connection.

use std::io::Read;

use graffiticode_l0182::backfill::extract;
use serde_json::Value as Json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input: Json = serde_json::from_str(&text)?;
    let output = input.get("output").filter(|o| !o.is_null());
    let errors = input.get("errors").and_then(Json::as_bool).unwrap_or(false);
    println!("{}", extract(&input["program"], output, errors));
    Ok(())
}
