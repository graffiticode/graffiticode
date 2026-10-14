// SPDX-License-Identifier: MIT

//! The vocabulary as data (`attributes.ts`), and the three rules every attribute list follows:
//! a value is checked against the type its word expects, a list merges into one record with no
//! word given twice, and a container refuses a word it does not take — naming where it belongs.
//!
//! The table itself lives in TypeScript; `vocab.json` is generated from it.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde_json::Value as Json;

use crate::js::{Js, Obj, show_value, trim};

/// What a word asserts about its value before it is used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expects {
    String,
    Number,
    /// A list of references to options.
    Refs,
    /// One reference to an item.
    Ref,
    /// An answer on a scale.
    Answer,
    /// A member list: one attribute list per entry.
    Records,
    Any,
}

/// One row of `attributeFields`: the field a word emits and what it expects.
#[derive(Clone, Debug)]
pub struct Attribute {
    pub field: String,
    pub expects: Expects,
}

pub struct Vocab {
    /// Keyed by AST tag (`SESSION_ID`).
    pub attributes: IndexMap<String, Attribute>,
    /// Which words each container takes, in source spelling.
    pub valid: IndexMap<String, Vec<String>>,
    /// The scale presets, as `scales.ts` declares them.
    pub presets: IndexMap<String, Json>,
    pub default_instructions: String,
    pub default_rating_instructions: String,
}

pub static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let json: Json = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    let attributes = json["attributes"]
        .as_object()
        .expect("attributes")
        .iter()
        .map(|(name, row)| {
            let expects = match row["expects"].as_str() {
                Some("string") => Expects::String,
                Some("number") => Expects::Number,
                Some("refs") => Expects::Refs,
                Some("ref") => Expects::Ref,
                Some("answer") => Expects::Answer,
                Some("records") => Expects::Records,
                _ => Expects::Any,
            };
            (name.clone(), Attribute { field: row["field"].as_str().expect("field").to_owned(), expects })
        })
        .collect();
    let valid = json["validAttributes"]
        .as_object()
        .expect("validAttributes")
        .iter()
        .map(|(container, words)| {
            let words = words.as_array().expect("words").iter().map(|w| w.as_str().expect("word").to_owned()).collect();
            (container.clone(), words)
        })
        .collect();
    let text = |name: &str| json[name].as_str().expect("default wording").to_owned();
    Vocab {
        attributes,
        valid,
        presets: json["presets"].as_object().expect("presets").clone().into_iter().collect(),
        default_instructions: text("defaultInstructions"),
        default_rating_instructions: text("defaultRatingInstructions"),
    }
});

/// A tag as the word it is spelled: `SESSION_ID` is `session-id`.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// Maps an emitted field back to its source spelling (`writeIn` is `write-in`). Container
/// words are not rows in the table but must still be nameable.
fn field_word(field: &str) -> String {
    VOCAB
        .attributes
        .iter()
        .find(|(_, row)| row.field == field)
        .map(|(name, _)| word_of(name))
        .unwrap_or_else(|| field.to_owned())
}

/// The first container that legitimately owns a word, other than `except`.
fn owner_of(word: &str, except: &str) -> Option<&'static str> {
    VOCAB
        .valid
        .iter()
        .filter(|(container, words)| container.as_str() != except && words.iter().any(|w| w == word))
        .map(|(container, _)| container.as_str())
        .next()
}

/// Asserts a value's type. Runs where the value is used, never in a checker pass.
pub fn check_value(name: &str, row: &Attribute, raw: &Js) -> Option<String> {
    let word = word_of(name);
    let reference = |v: &Js| match v {
        Js::Str(s) => !trim(s).is_empty(),
        Js::Num(n) => crate::js::is_integer(*n),
        _ => false,
    };
    match row.expects {
        Expects::Refs => {
            let items = match raw {
                Js::List(items) if !items.is_empty() => items,
                _ => {
                    return Some(format!(
                        "{word}: expected a list of options — each named by its text, its id, or its position, e.g. {word} [\"clean air and water\" \"affordable housing\"]."
                    ));
                }
            };
            let bad = items.iter().position(|v| !reference(v))?;
            Some(format!(
                "{word}: entry {} is {}; every entry must be an option's id in \"quotes\", or its position as a whole number.",
                bad + 1,
                show_value(&items[bad])
            ))
        }
        Expects::Records => {
            let example = format!("{word} [[item \"…\" rating \"Agree\"] [item \"…\" rating 4]]");
            let items = match raw {
                Js::List(items) if !items.is_empty() => items,
                _ => {
                    return Some(format!(
                        "{word}: expected a list with one [item … rating …] list per answer, e.g. {example}."
                    ));
                }
            };
            let bad = items.iter().position(|v| !matches!(v, Js::List(_)))?;
            Some(format!(
                "{word}: entry {} is {}; each answer is its own list in brackets, e.g. {example}.",
                bad + 1,
                show_value(&items[bad])
            ))
        }
        Expects::Ref => (!reference(raw)).then(|| {
            format!(
                "{word}: expected an item's text in \"quotes\" (or its id, or its position as a whole number), got {}.",
                show_value(raw)
            )
        }),
        Expects::Answer => {
            let ok = match raw {
                Js::Str(s) => !trim(s).is_empty(),
                Js::Num(n) => n.is_finite(),
                _ => false,
            };
            (!ok).then(|| {
                format!("{word}: expected a label in \"quotes\" or a number on the scale, got {}.", show_value(raw))
            })
        }
        Expects::Number => match raw {
            Js::Num(n) if n.is_finite() => None,
            _ => Some(format!("{word}: expected a number, got {}.", show_value(raw))),
        },
        Expects::String => match raw {
            Js::Str(_) => None,
            _ => Some(format!("{word}: expected a string in \"quotes\", got {}.", show_value(raw))),
        },
        Expects::Any => None,
    }
}

/// Folds an attribute list into one record. A malformed entry is an error, never a silent drop.
pub fn merge_attributes(attrs: &Js, place: &str) -> Result<Obj, String> {
    let Js::List(items) = attrs else {
        return Err(format!(
            "{place}: expected an attribute list in [brackets], e.g. [id \"team-retro\" session-id get-val-public \"itemId\"]."
        ));
    };
    let mut out = Obj::new();
    for item in items {
        let Js::Obj(entry) = item else {
            return Err(format!(
                "{place}: every entry must be an attribute applied to a value, e.g. [id \"team-retro\"]. Got {}.",
                show_value(item)
            ));
        };
        for (key, value) in entry {
            if out.contains_key(key) {
                return Err(format!("{place}: `{}` is given twice. Each attribute may appear once.", field_word(key)));
            }
            out.insert(key.clone(), value.clone());
        }
    }
    Ok(out)
}

/// Refuses a word the container does not take, naming the words it does and where the
/// misplaced one belongs.
pub fn assert_known_attributes(container: &str, attrs: &Obj) -> Result<(), String> {
    let Some(allowed) = VOCAB.valid.get(container) else { return Ok(()) };
    let unknown: Vec<String> =
        attrs.keys().map(|key| field_word(key)).filter(|word| !allowed.iter().any(|w| w == word)).collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let hints: String = unknown
        .iter()
        .filter_map(|word| owner_of(word, container).map(|owner| format!(" `{word}` belongs inside `{owner}`.")))
        .collect();
    let named: Vec<String> = unknown.iter().map(|word| format!("`{word}`")).collect();
    Err(format!(
        "{container}: {} {} of {container}. It takes: {}.{hints}",
        named.join(", "),
        if unknown.len() == 1 { "is not an attribute" } else { "are not attributes" },
        allowed.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(VOCAB.attributes.len(), 8);
        assert_eq!(VOCAB.attributes["WRITE_IN"].field, "writeIn");
        assert_eq!(VOCAB.attributes["RATINGS"].expects, Expects::Records);
        assert_eq!(VOCAB.valid["survey"], ["id", "session-id", "response"]);
        assert_eq!(VOCAB.presets.keys().last().map(String::as_str), Some("stars-5"));
        assert_eq!(field_word("sessionId"), "session-id");
        assert_eq!(field_word("response"), "response");
        assert_eq!(owner_of("item", "response"), Some("ratings"));
    }
}
