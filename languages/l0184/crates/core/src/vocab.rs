// SPDX-License-Identifier: MIT

//! The vocabulary as data (`packages/core/src/attributes.ts`): every word's field and the kind
//! of value it takes, the legality tables, how a value is checked, and the messages that say
//! where a misplaced word belongs. `vocab.json` is generated from the TypeScript by
//! `tests/conformance/generate.mjs`; `attributes.ts` stays the single source of truth.

use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;

use crate::js::{Js, is_record, is_tag, js_string, num, quote, trim};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub field: String,
    pub expects: String,
    pub one_of: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct Container {
    pub word: String,
}

#[derive(Debug, Deserialize)]
pub struct Part {
    pub min: f64,
    /// `null` is no limit (`Infinity` in the TypeScript).
    pub max: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vocab {
    pub kinds: Vec<String>,
    pub chain_fields: IndexMap<String, Meta>,
    pub member_fields: IndexMap<String, Meta>,
    pub container_fields: IndexMap<String, Container>,
    pub valid_attributes: IndexMap<String, Vec<String>>,
    pub plot_kind_attributes: IndexMap<String, Vec<String>>,
    pub label_positions: IndexMap<String, Vec<String>>,
    pub valid_settings: IndexMap<String, Vec<String>>,
    pub container_parts: IndexMap<String, IndexMap<String, Part>>,
    pub list_member: IndexMap<String, String>,
    pub examples: HashMap<String, String>,
    pub tailwind: HashMap<String, String>,
    #[serde(skip)]
    word_by_field: HashMap<String, String>,
    #[serde(skip)]
    attribute_owners: IndexMap<String, Vec<String>>,
    #[serde(skip)]
    setting_owners: IndexMap<String, Vec<String>>,
    #[serde(skip)]
    part_owners: IndexMap<String, Vec<String>>,
    #[serde(skip)]
    member_owner: HashMap<String, String>,
}

pub static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let mut vocab: Vocab = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    vocab.word_by_field = vocab
        .chain_fields
        .iter()
        .chain(vocab.member_fields.iter())
        .map(|(name, meta)| (meta.field.clone(), word_of(name)))
        .collect();
    vocab.attribute_owners = owners(vocab.valid_attributes.iter().map(|(c, ws)| (c, ws.iter())));
    vocab.setting_owners = owners(vocab.valid_settings.iter().map(|(c, ws)| (c, ws.iter())));
    vocab.part_owners = owners(vocab.container_parts.iter().map(|(c, parts)| (c, parts.keys())));
    vocab.member_owner = vocab.list_member.iter().map(|(list, member)| (member.clone(), list.clone())).collect();
    vocab
});

fn owners<'a>(
    table: impl Iterator<Item = (&'a String, impl Iterator<Item = &'a String>)>,
) -> IndexMap<String, Vec<String>> {
    let mut acc: IndexMap<String, Vec<String>> = IndexMap::new();
    for (container, words) in table {
        for w in words {
            acc.entry(w.clone()).or_default().push(container.clone());
        }
    }
    acc
}

/// A row name as the word it is written with: `X_AXIS` is `x-axis`.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// The source word that emits `field`, for error messages (`datasetId` is `dataset-id`).
pub fn source_word(field: &str) -> String {
    VOCAB.word_by_field.get(field).cloned().unwrap_or_else(|| field.to_owned())
}

/// A description written the way it should be, for error messages.
pub fn example_of(word: &str) -> String {
    VOCAB.examples.get(word).cloned().unwrap_or_else(|| format!("{word} … {{}}"))
}

/// A value as it was written, for an error message.
pub fn show_value(v: &Js) -> String {
    match v {
        Js::Undefined => "nothing".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Str(s) => quote(s),
        _ if is_tag(v) => format!("the tag {}", js_string(v.get("tag"))),
        Js::Arr(_) => "a list".to_owned(),
        Js::Obj(_) => "a record".to_owned(),
        other => js_string(other),
    }
}

/// `/^\d+(\.\d+)?%$/`.
fn is_percent(s: &str) -> bool {
    let Some(body) = s.strip_suffix('%') else { return false };
    let (whole, fraction) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

/// Checks and normalizes a word's value, or says what is wrong with it.
pub fn check_value(name: &str, meta: &Meta, raw: Js) -> Result<Js, String> {
    let word = word_of(name);
    let finite = |v: &Js| matches!(v, Js::Num(n) if n.is_finite());
    match meta.expects.as_str() {
        "text" | "color" => {
            let raw = match raw {
                Js::Num(n) if n.is_finite() => Js::Str(num(n)),
                other => other,
            };
            let Js::Str(s) = &raw else {
                return Err(format!("{word}: expected a string in \"quotes\", got {}.", show_value(&raw)));
            };
            if trim(s).is_empty() && name != "FORMATTER" {
                return Err(format!("{word}: must not be empty."));
            }
            Ok(raw)
        }
        "number" => {
            if !finite(&raw) {
                return Err(format!("{word}: expected a number, got {}.", show_value(&raw)));
            }
            Ok(raw)
        }
        "bound" => match &raw {
            Js::Num(n) if n.is_finite() => Ok(raw),
            Js::Str(s) if !trim(s).is_empty() => Ok(raw),
            _ => Err(format!("{word}: expected a number (or a date string on a TIME axis), got {}.", show_value(&raw))),
        },
        "size" => match &raw {
            Js::Num(n) if n.is_finite() && *n >= 0.0 => Ok(raw),
            Js::Str(s) if is_percent(trim(s)) => Ok(Js::str(trim(s))),
            _ => Err(format!(
                "{word}: expected pixels (a number) or a percentage like \"50%\", got {}.",
                show_value(&raw)
            )),
        },
        "boolean" => match &raw {
            Js::Bool(_) => Ok(raw),
            _ => {
                let hint = match raw.as_str() {
                    Some(s @ ("true" | "false")) => format!(" Write it without quotes: {word} {s}."),
                    _ => String::new(),
                };
                Err(format!("{word}: expected true or false, written bare, got {}.{hint}", show_value(&raw)))
            }
        },
        "tag" => {
            let one_of = meta.one_of.as_deref().unwrap_or_default();
            if is_tag(&raw) {
                let tag = js_string(raw.get("tag"));
                if meta.one_of.is_none() || one_of.contains(&tag) {
                    return Ok(Js::Str(tag));
                }
            }
            let bare = raw
                .as_str()
                .and_then(|s| one_of.iter().find(|v| v.to_lowercase() == s.to_lowercase()))
                .map(|bare| format!(" Write it bare and uppercase, without quotes: {word} {bare}."))
                .unwrap_or_default();
            Err(format!("{word}: expected one of {}, got {}.{bare}", one_of.join(", "), show_value(&raw)))
        }
        "data" => match &raw {
            Js::Arr(_) => Ok(raw),
            Js::Str(s) if !trim(s).is_empty() => Ok(raw),
            _ => Err(format!(
                "{word}: expected a list in [brackets] or the name of a dataset column in \"quotes\", got {}.",
                show_value(&raw)
            )),
        },
        // A list written in the program, or what `data use "0185"` gives: the upstream's list of
        // records as L0000's DATA hands it over (an integer-keyed record), or {} with no upstream.
        "rows" => {
            if matches!(raw, Js::Arr(_)) || is_record(&raw) {
                Ok(raw)
            } else {
                Err(format!(
                    "{word}: expected a list in [brackets], or data use \"0185\" for data fetched from a URL, got {}.",
                    show_value(&raw)
                ))
            }
        }
        "list" | "colors" => match &raw {
            Js::Arr(_) => Ok(raw),
            _ => Err(format!("{word}: expected a list in [brackets], got {}.", show_value(&raw))),
        },
        _ => {
            if !is_record(&raw) {
                return Err(format!(
                    "{word}: expected a description ending in `{{}}`, e.g. {}, got {}.",
                    example_of(&word),
                    show_value(&raw)
                ));
            }
            Ok(raw)
        }
    }
}

/// Where a misplaced word belongs, as a sentence to append to the error.
pub fn hint_for(w: &str, here: &str) -> String {
    let v = &*VOCAB;
    if let Some(list) = v.member_owner.get(w) {
        return format!(" `{w}` is a member of `{list}`, e.g. {list} [ {} ] {{}}.", example_of(w));
    }
    let others = |table: &IndexMap<String, Vec<String>>| -> Vec<String> {
        table.get(w).into_iter().flatten().filter(|o| *o != here).cloned().collect()
    };
    let parts = others(&v.part_owners);
    if !parts.is_empty() {
        let parts: Vec<String> = parts.iter().map(|p| format!("`{p}`")).collect();
        return format!(" `{w}` is a part of {}: write it inside its `[ … ]`.", parts.join(" or "));
    }
    let settings = others(&v.setting_owners);
    if let Some(s) = settings.first() {
        return if s == "charts" {
            format!(
                " `{w}` is a setting of the whole collection: write it after the outer `]`, e.g. charts [ … ] {w} … {{}}."
            )
        } else {
            format!(" `{w}` is a setting of `{s}`: write it after the chart's `]`, e.g. chart [ … ] {w} … {{}}.")
        };
    }
    let attrs = others(&v.attribute_owners);
    if attrs.is_empty() {
        return String::new();
    }
    if attrs.iter().any(|a| a == "label") {
        return format!(" `{w}` belongs inside `label … {{}}`, e.g. {}.", example_of("label"));
    }
    let attrs: Vec<String> = attrs.iter().map(|o| format!("`{o}`")).collect();
    format!(" `{w}` belongs in {}.", attrs.join(" or "))
}

/// Rejects a word a description does not accept, naming the legal set and where the misplaced
/// word belongs.
pub fn assert_known_attributes(kind: &str, attrs: &Js, place: &str, allowed: Option<&[String]>) -> Result<(), String> {
    let allowed = allowed.unwrap_or_else(|| VOCAB.valid_attributes[kind].as_slice());
    let unknown = crate::js::keys(attrs).into_iter().map(|k| source_word(&k)).find(|w| !allowed.contains(w));
    match unknown {
        None => Ok(()),
        Some(w) => Err(format!(
            "{place}: `{w}` is not part of {kind}. It takes: {}.{}",
            allowed.join(", "),
            hint_for(&w, kind)
        )),
    }
}

/// The same check for a settings chain.
pub fn assert_known_settings(container: &str, settings: &Js, place: &str) -> Result<(), String> {
    let allowed = &VOCAB.valid_settings[container];
    let unknown = crate::js::keys(settings).into_iter().map(|k| source_word(&k)).find(|w| !allowed.contains(w));
    match unknown {
        None => Ok(()),
        Some(w) => {
            let takes = if allowed.is_empty() {
                "It takes no settings: write `{}`.".to_owned()
            } else {
                format!("Its settings are: {}.", allowed.join(", "))
            };
            Err(format!("{place}: `{w}` is not a setting of {container}. {takes}{}", hint_for(&w, container)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(VOCAB.kinds.len(), 11);
        assert_eq!(source_word("datasetId"), "dataset-id");
        assert_eq!(source_word("nope"), "nope");
        assert_eq!(VOCAB.tailwind["blue-500"], "#3b82f6");
        assert_eq!(example_of("nope"), "nope … {}");
        assert!(VOCAB.container_parts["charts"]["chart"].max.is_none());
    }

    #[test]
    fn percentages() {
        assert!(is_percent("50%") && is_percent("50.5%"));
        assert!(!is_percent("50.%") && !is_percent("%") && !is_percent("5 %") && !is_percent("٥%"));
    }
}
