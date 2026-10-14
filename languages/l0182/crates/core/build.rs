// SPDX-License-Identifier: MIT

//! Embeds the installed surveys, `packages/core/data/*.json`, in the crate.
//!
//! The TypeScript compiler reads that directory at compile time; the Rust one carries the same
//! files in its binary, so the runtime image needs nothing beside the binary and `static/`.
//! The directory stays the single source of truth: adding a survey there and rebuilding is all
//! either implementation needs.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let data = manifest.join("../../packages/core/data");
    println!("cargo:rerun-if-changed={}", data.display());

    let mut names: Vec<String> = fs::read_dir(&data)
        .unwrap_or_else(|e| panic!("reading {}: {e}", data.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // Not a hidden file: a deploy snapshot packed on macOS carries an AppleDouble `._<name>`
        // beside each file, which is metadata, not a survey.
        .filter(|name| name.ends_with(".json") && !name.starts_with('.'))
        .collect();
    names.sort();

    let mut out = String::from(
        "/// Every installed survey file: its name, and its text.\npub static FILES: &[(&str, &str)] = &[\n",
    );
    for name in &names {
        let path = fs::canonicalize(data.join(name)).expect("the survey file exists");
        println!("cargo:rerun-if-changed={}", path.display());
        out.push_str(&format!("    ({name:?}, include_str!({:?})),\n", path.display().to_string()));
    }
    out.push_str("];\n");
    let dest = Path::new(&env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("surveys.rs");
    fs::write(dest, out).expect("writing surveys.rs");
}
