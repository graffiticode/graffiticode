// SPDX-License-Identifier: MIT

//! L0185's vocabulary, as `packages/core/src/attributes.ts` declares it. `vocab.json` is
//! generated from it by `tests/conformance/generate.mjs`; change the vocabulary there and
//! regenerate.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;

/// One word: its role, what its parameter must be, and its example (which error messages
/// quote).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepMeta {
    pub role: String,
    pub expects: String,
    #[serde(default)]
    pub one_of: Vec<String>,
    #[serde(default)]
    pub of: Option<String>,
    pub example: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vocab {
    step_fields: IndexMap<String, StepMeta>,
}

static VOCAB: LazyLock<Vocab> =
    LazyLock::new(|| serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid"));

pub const OPS: [&str; 13] = [
    "EQUALS",
    "NOT-EQUALS",
    "ABOVE",
    "AT-LEAST",
    "BELOW",
    "AT-MOST",
    "IN",
    "NOT-IN",
    "CONTAINS",
    "STARTS-WITH",
    "ENDS-WITH",
    "MISSING",
    "PRESENT",
];
pub const NO_VALUE_OPS: [&str; 2] = ["MISSING", "PRESENT"];
pub const AGGS: [&str; 7] = ["COUNT", "SUM", "AVERAGE", "MEDIAN", "MIN", "MAX", "COUNT-DISTINCT"];
pub const JOIN_KINDS: [&str; 2] = ["LEFT", "INNER"];

/// A word by its node tag (`GROUP_BY`).
pub fn meta(name: &str) -> Option<&'static StepMeta> {
    VOCAB.step_fields.get(name)
}

/// The node tags of every word.
pub fn names() -> impl Iterator<Item = &'static str> {
    VOCAB.step_fields.keys().map(String::as_str)
}

/// `GROUP_BY` is the word `group-by`.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(names().count(), 23);
        assert_eq!(meta("PARSE").unwrap().one_of, ["JSON", "CSV"]);
        assert_eq!(meta("AT").unwrap().of.as_deref(), Some("fetch"));
        assert_eq!(meta("SORT_BY").unwrap().role, "step");
        assert_eq!(word_of("CONNECTION_ID"), "connection-id");
    }
}
