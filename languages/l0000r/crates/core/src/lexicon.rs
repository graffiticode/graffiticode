// SPDX-License-Identifier: MIT

//! A language's vocabulary: the words the parser recognizes and the node tag each produces.
//!
//! A child dialect builds its vocabulary by merging its own words over L0000's. The merge is
//! child-over-parent, so a child word that reuses a base name replaces the base function — it
//! disappears from that dialect. That is sometimes intended (a forms language where `min` and
//! `max` are field-range attributes, not math builtins) and sometimes a bug that surfaces far
//! from its cause. The difference is intent, so intent has to be written down:
//! [`Lexicon::merge`] refuses a collision that is not declared, and refuses a declaration that
//! no longer collides. Prefer renaming to overriding: an override spends a base word for good.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// A surface word: the node tag it produces (`name`) and its signature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LexiconEntry {
    pub tk: u32,
    pub name: String,
    pub cls: String,
    pub arity: u32,
    #[serde(rename = "type")]
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub extra: IndexMap<String, Json>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Lexicon(IndexMap<String, LexiconEntry>);

/// Generated from the TypeScript package by `tests/conformance/generate.mjs`.
const BASE_JSON: &str = include_str!("lexicon.json");

static BASE: LazyLock<Lexicon> =
    LazyLock::new(|| serde_json::from_str(BASE_JSON).expect("the embedded base lexicon is valid"));

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LexiconError {
    #[error(
        "{}lexicon: {} would shadow the base lexicon without being declared. Rename to avoid the \
         collision (preferred — mirror more of the source path, e.g. \"filter\" -> \
         \"filter-restricted\"), or declare the override to claim the word deliberately.",
        prefix(.lang_id), quoted(.words)
    )]
    UndeclaredOverride { lang_id: Option<String>, words: Vec<String> },
    #[error(
        "{}lexicon: declared override(s) {} shadow nothing — remove them.",
        prefix(.lang_id), quoted(.words)
    )]
    StaleOverride { lang_id: Option<String>, words: Vec<String> },
}

fn prefix(lang_id: &Option<String>) -> String {
    lang_id.as_ref().map(|id| format!("{id} ")).unwrap_or_default()
}

fn quoted(words: &[String]) -> String {
    words.iter().map(|word| format!("\"{word}\"")).collect::<Vec<_>>().join(", ")
}

impl Lexicon {
    /// L0000's own vocabulary.
    pub fn base() -> &'static Lexicon {
        &BASE
    }

    /// L0000's vocabulary as the JSON document a language server publishes at `/lexicon.json`.
    pub fn base_json() -> &'static str {
        BASE_JSON
    }

    pub fn get(&self, word: &str) -> Option<&LexiconEntry> {
        self.0.get(word)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &LexiconEntry)> {
        self.0.iter().map(|(word, entry)| (word.as_str(), entry))
    }

    /// Merges a child language's words over this lexicon.
    ///
    /// `overrides` lists the words of `self` the child deliberately replaces: a claim that the
    /// base meaning is wrong for the domain, not merely inconvenient. `lang_id` (e.g. `"L0177"`)
    /// only labels the error.
    pub fn merge(
        &self,
        additions: Lexicon,
        overrides: &[&str],
        lang_id: Option<&str>,
    ) -> Result<Lexicon, LexiconError> {
        let lang_id = lang_id.map(str::to_owned);
        let undeclared: Vec<String> = additions
            .0
            .keys()
            .filter(|word| self.0.contains_key(*word) && !overrides.contains(&word.as_str()))
            .cloned()
            .collect();
        if !undeclared.is_empty() {
            return Err(LexiconError::UndeclaredOverride { lang_id, words: undeclared });
        }
        let stale: Vec<String> = overrides
            .iter()
            .filter(|word| !(self.0.contains_key(**word) && additions.0.contains_key(**word)))
            .map(|word| (*word).to_owned())
            .collect();
        if !stale.is_empty() {
            return Err(LexiconError::StaleOverride { lang_id, words: stale });
        }
        let mut merged = self.clone();
        merged.0.extend(additions.0);
        Ok(merged)
    }
}

impl FromIterator<(String, LexiconEntry)> for Lexicon {
    fn from_iter<I: IntoIterator<Item = (String, LexiconEntry)>>(iter: I) -> Self {
        Self(iter.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Op;

    fn word(name: &str) -> LexiconEntry {
        LexiconEntry {
            tk: 1,
            name: name.to_owned(),
            cls: "function".to_owned(),
            arity: 1,
            signature: "<any: any>".to_owned(),
            description: None,
            extra: IndexMap::new(),
        }
    }

    fn words(names: &[&str]) -> Lexicon {
        names.iter().map(|name| ((*name).to_owned(), word(&name.to_uppercase()))).collect()
    }

    #[test]
    fn every_base_word_names_a_kernel_operator() {
        assert!(!Lexicon::base().is_empty());
        for (word, entry) in Lexicon::base().iter() {
            assert!(!matches!(Op::from_tag(&entry.name), Op::Dialect(_)), "{word} -> {}", entry.name);
        }
    }

    #[test]
    fn the_base_lexicon_serializes_back_to_its_source() {
        let source: Json = serde_json::from_str(BASE_JSON).unwrap();
        assert_eq!(serde_json::to_value(Lexicon::base()).unwrap(), source);
    }

    #[test]
    fn new_words_merge_over_the_base() {
        let merged = Lexicon::base().merge(words(&["hello"]), &[], None).unwrap();
        assert_eq!(merged.len(), Lexicon::base().len() + 1);
        assert_eq!(merged.get("hello").unwrap().name, "HELLO");
        assert_eq!(merged.get("add"), Lexicon::base().get("add"));
    }

    #[test]
    fn an_undeclared_collision_is_refused() {
        let err = Lexicon::base().merge(words(&["filter", "hello"]), &[], Some("L0177")).unwrap_err();
        assert_eq!(
            err,
            LexiconError::UndeclaredOverride { lang_id: Some("L0177".into()), words: vec!["filter".into()] }
        );
        assert!(err.to_string().starts_with("L0177 lexicon: \"filter\" would shadow"));
    }

    #[test]
    fn a_declared_override_replaces_the_base_word() {
        let merged = Lexicon::base().merge(words(&["min"]), &["min"], None).unwrap();
        assert_eq!(merged.len(), Lexicon::base().len());
        assert_eq!(merged.get("min").unwrap().signature, "<any: any>");
    }

    #[test]
    fn a_stale_override_is_refused() {
        for (additions, overrides) in [(words(&["hello"]), ["min"]), (words(&["hello"]), ["hello"])] {
            let err = Lexicon::base().merge(additions, &overrides, None).unwrap_err();
            assert!(matches!(err, LexiconError::StaleOverride { .. }), "{err}");
        }
    }
}
