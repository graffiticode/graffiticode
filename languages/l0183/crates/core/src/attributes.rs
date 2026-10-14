// SPDX-License-Identifier: MIT

//! The vocabulary as data, and the checks every word runs.
//!
//! `attributes.json` is generated from `packages/core/src/attributes.ts`, the single source of
//! truth: the chain words (arity 2), the typed members (arity 1), the words of `assess [...]`,
//! and which words each description and settings record accepts. Change the vocabulary there
//! and regenerate. Every message here is a product surface — the generator reads it and tries
//! again — and matches the TypeScript's word for word.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value as Json;

use crate::js::{self, Object, is_record, is_tag, show_value, stringify};
use crate::text;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// The key this word emits.
    pub field: String,
    /// The value's type: `text`, `number`, `list`, `record`, `tag`, `boolean` or `flag`.
    pub expects: String,
    /// Closed set of legal values.
    pub one_of: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vocab {
    pub chain_fields: IndexMap<String, Meta>,
    pub member_fields: IndexMap<String, Meta>,
    pub assess_fields: IndexMap<String, Meta>,
    pub valid_attributes: IndexMap<String, Vec<String>>,
    pub valid_settings: IndexMap<String, Vec<String>>,
}

pub static VOCAB: LazyLock<Vocab> =
    LazyLock::new(|| serde_json::from_str(include_str!("attributes.json")).expect("the embedded vocabulary is valid"));

/// A node tag as the word it came from: `TRAY_ALIGN` is `tray-align`.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// The source word that emits `field`, for error messages (`trayAlign` is `tray-align`).
pub fn source_word(field: &str) -> String {
    static BY_FIELD: LazyLock<IndexMap<String, String>> = LazyLock::new(|| {
        let tables = [&VOCAB.chain_fields, &VOCAB.member_fields, &VOCAB.assess_fields];
        tables.into_iter().flatten().map(|(name, meta)| (meta.field.clone(), word_of(name))).collect()
    });
    BY_FIELD.get(field).cloned().unwrap_or_else(|| field.to_owned())
}

/// A member written the way it should be, for error messages.
pub fn member_example(word: &str) -> &'static str {
    match word {
        "edge" => "edge from \"hub\" to \"Nucleus\" label \"contains\" {}",
        "hub" => "hub text \"The Cell\" {}",
        _ => "node text \"Nucleus\" {}",
    }
}

/// Check and normalize a word's value.
pub fn check_value(name: &str, meta: &Meta, raw: Option<&Json>) -> Result<Json, String> {
    let word = word_of(name);
    let one_of = meta.one_of.as_deref();
    let shown = show_value(raw);
    match meta.expects.as_str() {
        "text" => {
            let raw = match raw {
                Some(Json::Number(n)) => js::js_string(&Json::Number(n.clone())),
                Some(Json::String(text)) => text.clone(),
                _ => return Err(format!("{word}: expected a string in \"quotes\", got {shown}.")),
            };
            if let Some(one_of) = one_of
                && !one_of.contains(&raw)
            {
                let legal: Vec<String> = one_of.iter().map(|v| format!("\"{v}\"")).collect();
                return Err(format!(
                    "{word}: {} is not one of {}.",
                    stringify(&Json::String(raw.clone())),
                    legal.join(", ")
                ));
            }
            if one_of.is_none() && text::trim(&raw).is_empty() && name != "TEXT" && name != "LABEL" {
                return Err(format!("{word}: must not be empty."));
            }
            Ok(Json::String(raw))
        }
        "number" => match raw {
            Some(n @ Json::Number(_)) => Ok(n.clone()),
            _ => Err(format!("{word}: expected a number, got {shown}.")),
        },
        "tag" => {
            let tag = raw.filter(|_| is_tag(raw)).and_then(|raw| raw["tag"].as_str());
            if let Some(tag) = tag
                && one_of.is_none_or(|one_of| one_of.iter().any(|v| v == tag))
            {
                return Ok(Json::String(tag.to_lowercase()));
            }
            let legal = one_of.unwrap_or_default().join(" or ");
            let bare = match raw {
                Some(Json::String(raw)) => {
                    one_of.unwrap_or_default().iter().find(|v| v.to_lowercase() == raw.to_lowercase())
                }
                _ => None,
            };
            let quoted = bare.map(|bare| format!(" Write it bare, without quotes: {word} {bare}.")).unwrap_or_default();
            Err(format!("{word}: expected the tag {legal}, got {shown}.{quoted}"))
        }
        "boolean" => match raw {
            Some(flag @ Json::Bool(_)) => Ok(flag.clone()),
            _ => {
                let unquote = match raw {
                    Some(Json::String(raw)) if raw == "true" || raw == "false" => {
                        format!(" Write it without quotes: {word} {raw}.")
                    }
                    _ => String::new(),
                };
                Err(format!("{word}: expected true or false, written bare, got {shown}.{unquote}"))
            }
        },
        "list" => match raw {
            Some(list @ Json::Array(_)) => Ok(list.clone()),
            _ => Err(format!("{word}: expected a list in [brackets], e.g. {word} [expected], got {shown}.")),
        },
        "record" => match raw {
            Some(record) if is_record(raw) => Ok(record.clone()),
            _ => Err(format!(
                "{word}: expected a description ending in `{{}}`, e.g. {}, got {shown}.",
                member_example(&word)
            )),
        },
        _ => Ok(Json::Bool(true)),
    }
}

/// Every container a word can be written in, by word, in the tables' order.
fn owners(table: &IndexMap<String, Vec<String>>) -> IndexMap<String, Vec<String>> {
    let mut owners: IndexMap<String, Vec<String>> = IndexMap::new();
    for (container, words) in table {
        for word in words {
            owners.entry(word.clone()).or_default().push(container.clone());
        }
    }
    owners
}

static ATTRIBUTE_OWNERS: LazyLock<IndexMap<String, Vec<String>>> = LazyLock::new(|| owners(&VOCAB.valid_attributes));
static SETTING_OWNERS: LazyLock<IndexMap<String, Vec<String>>> = LazyLock::new(|| owners(&VOCAB.valid_settings));

/// Which list each typed member goes in.
fn member_owner(word: &str) -> Option<&'static str> {
    match word {
        "node" => Some("nodes"),
        "edge" => Some("edges"),
        _ => None,
    }
}

/// An example of a setting written where it belongs.
fn setting_example(word: &str, owner: &str) -> String {
    let value = match word {
        "theme" => "DARK",
        "tray-align" if owner == "edges" => "bottom",
        "tray-align" => "left",
        "instant-feedback" => "true",
        _ => "\"…\"",
    };
    format!("{owner} [ … ] {word} {value} {{}}")
}

/// Where a misplaced word belongs, as a sentence to append to the error.
fn hint_for(w: &str, container: &str) -> String {
    if let Some(owner) = member_owner(w) {
        return format!(" `{w}` is a member of `{owner}`, e.g. {owner} [ {} ] {{}}.", member_example(w));
    }
    // A setting is never unknown to its own settings record, so an owner equal to `container`
    // means it was written among that container's children instead.
    if let Some(first) = SETTING_OWNERS.get(w).and_then(|owners| owners.first()) {
        return format!(" `{w}` is a setting and goes after the `]` of {first}, e.g. {}.", setting_example(w, first));
    }
    let owners: Vec<&String> =
        ATTRIBUTE_OWNERS.get(w).into_iter().flatten().filter(|owner| *owner != container).collect();
    if owners.is_empty() {
        return String::new();
    }
    if owners.iter().any(|owner| *owner == "assess") {
        let eg = if w == "points" { "assess [expected points 2]".to_owned() } else { format!("assess [{w}]") };
        return format!(" `{w}` belongs inside `assess [ … ]`, e.g. {eg}.");
    }
    let named: Vec<String> = owners.iter().map(|owner| format!("`{owner}`")).collect();
    format!(" `{w}` belongs in {}.", named.join(" or "))
}

/// Fold a bracket list of single-key records into one object. A malformed entry is an error,
/// never a silent drop.
pub fn merge_attributes(attrs: Option<&Json>, at: &str, example: &str) -> Result<Object, String> {
    let Some(Json::Array(attrs)) = attrs else {
        return Err(format!("{at}: expected a list in [brackets], e.g. {example}."));
    };
    let mut out = Object::new();
    for a in attrs {
        let Some(fields) = a.as_object().filter(|_| is_record(Some(a))) else {
            return Err(format!(
                "{at}: every entry must be a word of the list, e.g. {example}. Got {}.",
                show_value(Some(a))
            ));
        };
        for (key, value) in fields {
            if out.contains_key(key) {
                return Err(format!("{at}: `{}` is given twice. Each may appear once.", source_word(key)));
            }
            out.insert(key.clone(), value.clone());
        }
    }
    match js::js_order(Json::Object(out)) {
        Json::Object(out) => Ok(out),
        _ => unreachable!("an object stays an object"),
    }
}

fn first_unknown(allowed: &[String], given: Option<&Json>) -> Result<Option<String>, String> {
    Ok(js::keys(given)?.iter().map(|key| source_word(key)).find(|word| !allowed.contains(word)))
}

/// Reject a word a description does not accept, naming the legal set and where it belongs.
pub fn assert_known_attributes(container: &str, attrs: Option<&Json>, at: &str) -> Result<(), String> {
    let allowed = &VOCAB.valid_attributes[container];
    match first_unknown(allowed, attrs)? {
        None => Ok(()),
        Some(w) => Err(format!(
            "{at}: `{w}` is not part of {container}. It takes: {}.{}",
            allowed.join(", "),
            hint_for(&w, container)
        )),
    }
}

/// The same check for a settings record.
pub fn assert_known_settings(container: &str, settings: Option<&Json>) -> Result<(), String> {
    let allowed = &VOCAB.valid_settings[container];
    match first_unknown(allowed, settings)? {
        None => Ok(()),
        Some(w) => Err(format!(
            "{container}: `{w}` is not a setting of {container}. Its settings are: {}.{}",
            allowed.join(", "),
            hint_for(&w, container)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(VOCAB.chain_fields.len(), 15);
        assert_eq!(VOCAB.chain_fields["TRAY_ALIGN"].field, "trayAlign");
        assert_eq!(VOCAB.assess_fields["EXPECTED"].expects, "flag");
        assert_eq!(source_word("trayAlign"), "tray-align");
        assert_eq!(source_word("instantFeedback"), "instant-feedback");
        assert_eq!(source_word("nope"), "nope");
    }

    #[test]
    fn a_misplaced_word_says_where_it_belongs() {
        assert_eq!(
            hint_for("title", "concept-web"),
            " `title` is a setting and goes after the `]` of concept-web, e.g. concept-web [ … ] title \"…\" {}."
        );
        assert_eq!(
            hint_for("points", "node"),
            " `points` belongs inside `assess [ … ]`, e.g. assess [expected points 2]."
        );
        assert_eq!(hint_for("label", "node"), " `label` belongs in `edge`.");
        assert_eq!(hint_for("nope", "node"), "");
    }
}
