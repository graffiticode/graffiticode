// SPDX-License-Identifier: MIT

//! Writes the files derived from L0187's vocabulary into `generated/`, or checks that the
//! committed copies are current:
//!
//! ```text
//! cargo run --bin emit -- generated/   # write
//! cargo run --bin emit -- --check      # compare with generated/, exit 1 if stale
//! ```
//!
//! `tools/assemble-static.mjs` copies `generated/` into the server's static directory.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn outputs() -> Vec<(&'static str, String)> {
    vec![
        ("lexicon.json", graffiticode_l0187::lexicon::lexicon_json()),
        ("schema.json", graffiticode_l0187::schema::schema_json()),
    ]
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let default_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../generated");
    match args.as_slice() {
        [flag] if flag == "--check" => check(&default_dir),
        [flag, dir] if flag == "--check" => check(Path::new(dir)),
        [dir] => write(Path::new(dir)),
        [] => write(&default_dir),
        _ => {
            eprintln!("usage: emit [<dir>] | emit --check [<dir>]");
            ExitCode::FAILURE
        }
    }
}

fn write(dir: &Path) -> ExitCode {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("emit: cannot create {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    for (name, text) in outputs() {
        let path: PathBuf = dir.join(name);
        if let Err(e) = std::fs::write(&path, text) {
            eprintln!("emit: cannot write {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("wrote {}", path.display());
    }
    ExitCode::SUCCESS
}

fn check(dir: &Path) -> ExitCode {
    let mut stale = Vec::new();
    for (name, text) in outputs() {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
            stale.push(path.display().to_string());
        }
    }
    if stale.is_empty() {
        println!("generated files are current");
        ExitCode::SUCCESS
    } else {
        eprintln!("stale generated files (run `npm run emit`): {}", stale.join(", "));
        ExitCode::FAILURE
    }
}
