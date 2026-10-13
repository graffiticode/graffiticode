// SPDX-License-Identifier: MIT

//! Preflight: what one stage of a chain will do, decided before any stage executes and
//! without executing anything. The gateway collects a [`StageManifest`] from every stage's
//! compiler and asks policy for one decision; the plan it admits pins each stage, and the
//! compiler checks itself against that pin before it executes.
//!
//! All digests are SHA-256 over the canonical JSON every component shares.

use serde::Serialize;
use serde_json::Value as Json;

use crate::ast::{Ast, Node};
use crate::canonical::args_digest;
use crate::dialect::Dialect;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageManifest {
    /// The gateway's name for the stage's position (`s0` leftmost).
    pub stage: Option<String>,
    /// The compiler's language.
    pub lang: String,
    /// The program as stored (the gateway checks it against the task it loaded).
    pub source_digest: String,
    /// The program after the language's normalization, which is what executes.
    pub program_digest: String,
    /// The compile options.
    pub options_digest: String,
    /// The running Cloud Run revision.
    pub revision: String,
    /// The image it runs.
    pub image_digest: String,
    /// The registry version the language's declarations were written for; 0 for a language
    /// with none.
    pub registry_version: u32,
    /// Every protected function the program can reach: every explicit node, dead code
    /// included, plus implicit ones. Sorted, each once.
    pub required_functions: Vec<String>,
}

/// A deployed revision's identity. Absent outside Cloud Run (or for a revision the deploy CLI
/// did not release), in which case nothing can be pinned to it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RevisionIdentity {
    pub revision: Option<String>,
    pub image_digest: Option<String>,
}

impl RevisionIdentity {
    /// `K_REVISION`, which Cloud Run sets, and `GC_IMAGE_DIGEST`, which the deploy CLI sets.
    pub fn from_env() -> Self {
        let var = |name| std::env::var(name).ok().filter(|value: &String| !value.is_empty());
        Self { revision: var("K_REVISION"), image_digest: var("GC_IMAGE_DIGEST") }
    }
}

pub fn digest_of(value: &Json) -> String {
    args_digest(value)
}

/// Every protected function a program can reach, by static scan: each explicit protected node,
/// reachable or not, and each implicit function the language requires of every compile.
pub fn required_protected_functions(ast: &Ast, dialect: &dyn Dialect) -> Vec<String> {
    let protected = dialect.protected_functions();
    let explicit = ast.nodes().filter_map(|(_, node)| match node {
        Node::Form { op, .. } => protected.iter().find(|(tag, _)| tag == op.tag()).map(|(_, function)| &function.name),
        _ => None,
    });
    let implicit = dialect.implicit_protected_functions().iter().map(|function| &function.name);
    let mut functions: Vec<String> = implicit.chain(explicit).cloned().collect();
    functions.sort();
    functions.dedup();
    functions
}

/// Where a session's binding and this stage's own manifest disagree, by field name. Empty
/// means the compiler may execute what the plan admitted. The binding pins everything in the
/// manifest but the stage name and registry version.
pub fn binding_problems(bind: Option<&Json>, manifest: &StageManifest) -> Vec<&'static str> {
    let Some(bind) = bind.filter(|bind| bind.is_object()) else {
        return vec!["binding"];
    };
    let text = |field: &'static str, expected: &str| (bind[field].as_str() != Some(expected)).then_some(field);
    let functions = {
        let mut bound: Option<Vec<&str>> =
            bind["requiredFunctions"].as_array().and_then(|items| items.iter().map(Json::as_str).collect());
        if let Some(bound) = &mut bound {
            bound.sort_unstable();
        }
        let mut expected: Vec<&str> = manifest.required_functions.iter().map(String::as_str).collect();
        expected.sort_unstable();
        (bound != Some(expected)).then_some("requiredFunctions")
    };
    [
        text("lang", &manifest.lang),
        text("sourceDigest", &manifest.source_digest),
        text("programDigest", &manifest.program_digest),
        text("optionsDigest", &manifest.options_digest),
        text("revision", &manifest.revision),
        text("imageDigest", &manifest.image_digest),
        functions,
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> StageManifest {
        StageManifest {
            stage: Some("s1".into()),
            lang: "9999".into(),
            source_digest: "a".into(),
            program_digest: "b".into(),
            options_digest: "c".into(),
            revision: "r".into(),
            image_digest: "i".into(),
            registry_version: 6,
            required_functions: vec!["y".into(), "x".into()],
        }
    }

    #[test]
    fn binding_problems_names_each_disagreeing_field() {
        let agreeing = json!({
            "lang": "9999", "sourceDigest": "a", "programDigest": "b", "optionsDigest": "c",
            "revision": "r", "imageDigest": "i", "requiredFunctions": ["x", "y"],
        });
        assert_eq!(binding_problems(Some(&agreeing), &manifest()), Vec::<&str>::new());

        let disagreeing = json!({
            "lang": "9999", "sourceDigest": "z", "programDigest": "b", "optionsDigest": "c",
            "revision": "q", "imageDigest": "i", "requiredFunctions": ["x"],
        });
        assert_eq!(
            binding_problems(Some(&disagreeing), &manifest()),
            ["sourceDigest", "revision", "requiredFunctions"]
        );

        assert_eq!(binding_problems(None, &manifest()), ["binding"]);
        assert_eq!(binding_problems(Some(&json!("bind")), &manifest()), ["binding"]);
        assert_eq!(binding_problems(Some(&json!({})), &manifest()).len(), 7);
    }

    #[test]
    fn a_manifest_is_written_in_the_wire_names() {
        let wire = serde_json::to_value(manifest()).unwrap();
        assert_eq!(
            wire,
            json!({
                "stage": "s1", "lang": "9999", "sourceDigest": "a", "programDigest": "b", "optionsDigest": "c",
                "revision": "r", "imageDigest": "i", "registryVersion": 6, "requiredFunctions": ["y", "x"],
            })
        );
    }
}
