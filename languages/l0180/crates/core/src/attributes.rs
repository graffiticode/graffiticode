// SPDX-License-Identifier: MIT

//! The vocabulary as data, and the checks every word's value goes through:
//! `packages/core/src/attributes.ts`.
//!
//! The tables themselves stay in TypeScript. `vocab.json` is generated from `attributes.ts` by
//! `tests/conformance/generate.mjs`; change a word there and regenerate.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value as Json;

use crate::plain::{Object, show_value};
use crate::text;

/// One row of `attributeFields` or `configFields`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub field: String,
    pub shape: Option<String>,
    pub expects: Option<String>,
    pub one_of: Option<Vec<String>>,
    pub flag: Option<bool>,
}

impl Meta {
    pub fn is_flag(&self) -> bool {
        self.flag == Some(true)
    }

    fn is_object(&self) -> bool {
        self.shape.as_deref() == Some("object")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tables {
    attribute_fields: IndexMap<String, Meta>,
    config_fields: IndexMap<String, Meta>,
    valid_attributes: IndexMap<String, Vec<String>>,
}

pub struct Vocab {
    pub attributes: IndexMap<String, Meta>,
    pub config: IndexMap<String, Meta>,
    valid: IndexMap<String, Vec<String>>,
    /// Containers that legitimately own each word, for the "belongs inside" hint.
    owners: IndexMap<String, Vec<String>>,
    /// An emitted field's source spelling (`minChoices` is `min-choices`).
    field_words: IndexMap<String, String>,
    /// The activity-level words, in source spelling.
    config_words: Vec<String>,
}

pub static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let tables: Tables = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    let mut owners: IndexMap<String, Vec<String>> = IndexMap::new();
    for (container, words) in &tables.valid_attributes {
        for word in words {
            owners.entry(word.clone()).or_default().push(container.clone());
        }
    }
    // Container words are not rows in the table, but they must still be nameable when a
    // container rejects one of them. (`fieldToWord`'s seed in attributes.ts.)
    let mut field_words: IndexMap<String, String> = [
        ("options", "options"),
        ("parts", "parts"),
        ("selections", "selections"),
        ("rubric", "rubric"),
        ("responses", "responses"),
        ("blanks", "blanks"),
        ("dropdowns", "dropdowns"),
        ("elements", "elements"),
        ("targets", "targets"),
        ("categories", "categories"),
        ("matchItems", "match-items"),
        ("classificationItems", "classification-items"),
        ("tokens", "tokens"),
        ("gaps", "gaps"),
        ("items", "items"),
    ]
    .into_iter()
    .map(|(field, word)| (field.to_owned(), word.to_owned()))
    .collect();
    for (name, meta) in tables.attribute_fields.iter().chain(&tables.config_fields) {
        field_words.insert(meta.field.clone(), word_of(name));
    }
    let config_words = tables.config_fields.keys().map(|name| word_of(name)).collect();
    Vocab {
        attributes: tables.attribute_fields,
        config: tables.config_fields,
        valid: tables.valid_attributes,
        owners,
        field_words,
        config_words,
    }
});

/// Source spelling for a tag, so an error names the word the author wrote.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// Map an emitted field back to its source spelling.
pub fn field_word(field: &str) -> String {
    VOCAB.field_words.get(field).cloned().unwrap_or_else(|| field.to_owned())
}

/// The QTI template identifier for an authored spelling.
pub fn template_id(word: &str) -> String {
    word.replace('-', "_")
}

/// Assert a value's type. The error, or `None`.
pub fn check_value(name: &str, meta: &Meta, raw: Option<&Json>) -> Option<String> {
    let word = word_of(name);
    if meta.is_object() {
        return match raw {
            Some(Json::Array(_)) => None,
            _ => Some(format!("{word}: expected an attribute list in [brackets], e.g. {word} [correct points 1].")),
        };
    }
    if meta.expects.as_deref() == Some("strings") {
        let list = match raw {
            Some(Json::Array(list)) if !list.is_empty() => list,
            _ => {
                let eg: Vec<String> = match &meta.one_of {
                    Some(values) => values.iter().take(2).map(|v| format!("\"{v}\"")).collect(),
                    None => vec!["\"First.\"".to_owned(), "\"Second.\"".to_owned()],
                };
                return Some(format!("{word}: expected a list of strings, e.g. {word} [{}].", eg.join(" ")));
            }
        };
        if let Some(bad) = list.iter().position(|s| s.as_str().is_none_or(|s| text::trim(s).is_empty())) {
            return Some(format!(
                "{word}: entry {} is {}; every entry must be a non-empty string.",
                bad + 1,
                show_value(Some(&list[bad]))
            ));
        }
        if let Some(values) = &meta.one_of
            && let Some(unknown) = list.iter().find(|v| !values.iter().any(|value| v.as_str() == Some(value)))
        {
            return Some(format!(
                "{word}: {} is not one of the values `{word}` takes: {}.",
                show_value(Some(unknown)),
                values.join(", ")
            ));
        }
        return None;
    }
    let expects = meta.expects.as_deref()?;
    match (expects, raw) {
        ("number", Some(Json::Number(_))) | ("string", Some(Json::String(_))) | ("boolean", Some(Json::Bool(_))) => {}
        ("number", _) => return Some(format!("{word}: expected a number, got {}.", show_value(raw))),
        ("string", _) => return Some(format!("{word}: expected a string in \"quotes\", got {}.", show_value(raw))),
        ("boolean", _) => return Some(format!("{word}: expected true or false, got {}.", show_value(raw))),
        _ => {}
    }
    if let Some(values) = &meta.one_of
        && !values.iter().any(|value| raw.and_then(Json::as_str) == Some(value))
    {
        return Some(format!("{word}: {} is not a {word} mode. It takes: {}.", show_value(raw), values.join(", ")));
    }
    None
}

/// Fold an attribute list into one object. A malformed entry is a compile error.
pub fn merge_attributes(attrs: Option<&Json>, at: &str) -> Result<Object, String> {
    let Some(Json::Array(attrs)) = attrs else {
        return Err(format!("{at}: expected an attribute list in [brackets], e.g. [text \"A\" assess [correct]]."));
    };
    let mut out = Object::new();
    for a in attrs {
        let Json::Object(a) = a else {
            return Err(format!(
                "{at}: every entry must be an attribute applied to a value, e.g. [text \"A\" assess [correct]]. Got {}.",
                show_value(Some(a))
            ));
        };
        for (k, v) in a {
            if out.contains_key(k) {
                return Err(format!("{at}: `{}` is given twice. Each attribute may appear once.", field_word(k)));
            }
            out.insert(k.clone(), v.clone());
        }
    }
    Ok(out)
}

/// Reject a word the container does not accept, naming the legal set and where the misplaced
/// word belongs.
pub fn assert_known_attributes(container: &str, attrs: &Object) -> Result<(), String> {
    let Some(allowed) = VOCAB.valid.get(container) else { return Ok(()) };
    let unknown: Vec<String> = attrs.keys().map(|k| field_word(k)).filter(|w| !allowed.contains(w)).collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let hints: String = unknown
        .iter()
        .map(|w| {
            if container != "activity" && VOCAB.config_words.contains(w) {
                return format!(
                    " `{w}` configures the whole activity, so it goes after the items list rather than inside an item: items [ … ] {w} \"…\" {{}}."
                );
            }
            let owner = VOCAB
                .owners
                .get(w)
                .into_iter()
                .flatten()
                .find(|o| o.as_str() != container && o.as_str() != "activity");
            owner.map_or_else(String::new, |owner| format!(" `{w}` belongs inside `{owner}`."))
        })
        .collect();
    let listed: Vec<String> = unknown.iter().map(|u| format!("`{u}`")).collect();
    Err(format!(
        "{container}: {} {} of {container}. It takes: {}.{hints}",
        listed.join(", "),
        if unknown.len() == 1 { "is not an attribute" } else { "are not attributes" },
        allowed.join(", ")
    ))
}

/// Reject an `assess` word its container has no use for.
pub fn assert_assess_words(assess: Option<&Json>, allowed: &[&str], at: &str) -> Result<(), String> {
    if !crate::plain::truthy(assess) {
        return Ok(());
    }
    let Some(stray) = crate::plain::keys(assess).into_iter().find(|w| !allowed.contains(&w.as_str())) else {
        return Ok(());
    };
    let takes: Vec<String> = allowed.iter().map(|w| field_word(w)).collect();
    Err(format!(
        "{at}: `{}` is not part of an `assess` here. It takes: {}.{}",
        field_word(&stray),
        takes.join(", "),
        if stray == "position" { " `position` belongs on an `order` element." } else { "" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_vocabulary_loads() {
        assert!(VOCAB.attributes["CORRECT"].is_flag());
        assert_eq!(field_word("minChoices"), "min-choices");
        assert_eq!(field_word("matchItems"), "match-items");
        assert_eq!(field_word("nope"), "nope");
        assert_eq!(VOCAB.config_words, ["navigation", "submission"]);
    }

    #[test]
    fn a_misplaced_word_is_told_where_it_belongs() {
        let attrs: Object = [("correct".to_owned(), json!(true))].into_iter().collect();
        let err = assert_known_attributes("option", &attrs).unwrap_err();
        assert_eq!(
            err,
            "option: `correct` is not an attribute of option. It takes: id, text, assess. `correct` belongs inside `assess`."
        );
    }
}
