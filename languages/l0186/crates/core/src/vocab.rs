// SPDX-License-Identifier: MIT

//! The vocabulary as data, and the checks and messages built from it.
//!
//! `vocab.json` is generated from `packages/core/src/attributes.ts`, the single source of
//! truth: change a word there and run `npm run rust:fixtures`. A tag's `emit` function is
//! written out there as the value each accepted tag emits.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value as Json;

use crate::plain::{Plain, js_number, js_round, js_string, object, quote, trim};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Expects {
    Text,
    Content,
    Coord,
    Size,
    Opacity,
    Boolean,
    Tag,
    TagOrNumber,
    Color,
    Endpoints,
    Point,
    Waypoints,
    Record,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub field: String,
    pub expects: Expects,
    #[serde(default)]
    pub one_of: Vec<String>,
    pub emit: Option<IndexMap<String, Json>>,
}

#[derive(Deserialize)]
pub struct Statement {
    pub name: String,
    pub word: String,
    pub field: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vocab {
    /// Properties (arity 2), by node tag.
    pub chain_fields: IndexMap<String, Meta>,
    /// Members (arity 1), by node tag.
    pub member_fields: IndexMap<String, Meta>,
    /// Containers (arity 2): node tag → word.
    pub container_fields: IndexMap<String, String>,
    pub save_to_figjam: Statement,
    pub valid_attributes: IndexMap<String, Vec<String>>,
    pub valid_settings: IndexMap<String, Vec<String>>,
    pub container_members: IndexMap<String, Vec<String>>,
    pub named_colors: IndexMap<String, String>,
    pub shape_kinds: Vec<String>,
    pub stamp_kinds: Vec<String>,
    examples: IndexMap<String, String>,
    #[serde(skip)]
    word_by_field: IndexMap<String, String>,
    #[serde(skip)]
    attribute_owners: IndexMap<String, Vec<String>>,
    #[serde(skip)]
    setting_owners: IndexMap<String, Vec<String>>,
    #[serde(skip)]
    member_owners: IndexMap<String, Vec<String>>,
}

pub static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let mut vocab: Vocab = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    vocab.word_by_field = vocab
        .chain_fields
        .iter()
        .chain(&vocab.member_fields)
        .map(|(name, meta)| (meta.field.clone(), word_of(name)))
        .chain([(vocab.save_to_figjam.field.clone(), vocab.save_to_figjam.word.clone())])
        .collect();
    vocab.attribute_owners = owners(&vocab.valid_attributes);
    vocab.setting_owners = owners(&vocab.valid_settings);
    vocab.member_owners = owners(&vocab.container_members);
    vocab
});

/// Which tables list each word, in table order.
fn owners(table: &IndexMap<String, Vec<String>>) -> IndexMap<String, Vec<String>> {
    let mut acc: IndexMap<String, Vec<String>> = IndexMap::new();
    for (container, words) in table {
        for word in words {
            acc.entry(word.clone()).or_default().push(container.clone());
        }
    }
    acc
}

/// A node tag as the word it is written with: `FONT_SIZE` is `font-size`.
pub fn word_of(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// What `Object.prototype` holds under a name: `wordByField` is a plain object, so a lookup of
/// one of these finds the inherited function, which a message then prints as its source.
const INHERITED: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
];

/// The source word that emits `field`, for error messages (`fontSize` is `font-size`).
pub fn source_word(field: &str) -> String {
    if let Some(word) = VOCAB.word_by_field.get(field) {
        return word.clone();
    }
    match field {
        "constructor" => "function Object() { [native code] }".to_owned(),
        "__proto__" => "[object Object]".to_owned(),
        _ if INHERITED.contains(&field) => format!("function {field}() {{ [native code] }}"),
        _ => field.to_owned(),
    }
}

/// A description written the way it should be, for error messages.
pub fn example_of(word: &str) -> String {
    VOCAB.examples.get(word).cloned().unwrap_or_else(|| format!("{word} … {{}}"))
}

/// Where `save-to-figjam` goes, for every error that finds it somewhere else.
pub const SAVE_HINT: &str = " `save-to-figjam` is a statement on its own line at the top of the program, e.g. save-to-figjam \"https://www.figma.com/board/ABC123/Name\" then board [ … ] {}..";

/// `a` or `an`, by JavaScript's `/^[aeiou]/`.
pub fn a_or_an(word: &str) -> &'static str {
    if word.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" }
}

fn where_setting(w: &str, c: &str) -> String {
    if c == "board" {
        format!(" `{w}` is a setting of the board: write it after the board's outer `]`, e.g. board [ … ] {w} … {{}}.")
    } else {
        format!(" `{w}` is a setting of `{c}`: write it after the {c}'s `]`, e.g. {c} [ … ] {w} … {{}}.")
    }
}

/// Where a misplaced word belongs, as a sentence to append to the error.
pub fn hint_for(w: &str, here: &str) -> String {
    if w == VOCAB.save_to_figjam.word {
        return SAVE_HINT.to_owned();
    }
    let others = |table: &IndexMap<String, Vec<String>>| -> Vec<String> {
        table.get(w).into_iter().flatten().filter(|o| *o != here).cloned().collect()
    };
    let members = others(&VOCAB.member_owners);
    if let Some(first) = members.first() {
        let named: Vec<String> = members.iter().map(|m| format!("`{m}`")).collect();
        return format!(
            " `{w}` is a member of {}: write it inside its `[ … ]`, e.g. {first} [ {} ] {{}}.",
            named.join(" or "),
            example_of(w)
        );
    }
    let settings = others(&VOCAB.setting_owners);
    let attrs = others(&VOCAB.attribute_owners);
    if let Some(first) = settings.first()
        && attrs.is_empty()
    {
        return where_setting(w, first);
    }
    if !attrs.is_empty() {
        let also = if settings.is_empty() {
            String::new()
        } else {
            let named: Vec<String> = settings.iter().map(|s| format!("`{s}`")).collect();
            format!(", or a setting of {}", named.join(" or "))
        };
        let described: Vec<String> = attrs.iter().map(|o| format!("{} `{o}`", a_or_an(o))).collect();
        return format!(" `{w}` describes {}{also}.", described.join(" or "));
    }
    String::new()
}

/// Rejects a word a description does not accept, naming the legal set and where it belongs.
pub fn assert_known_attributes(kind: &str, attrs: &Plain, at: &str) -> Result<(), String> {
    let allowed = &VOCAB.valid_attributes[kind];
    let unknown = attrs.keys()?.iter().map(|key| source_word(key)).find(|w| !allowed.contains(w));
    match unknown {
        None => Ok(()),
        Some(w) => {
            Err(format!("{at}: `{w}` is not part of {kind}. It takes: {}.{}", allowed.join(", "), hint_for(&w, kind)))
        }
    }
}

/// The same check for a settings chain.
pub fn assert_known_settings(container: &str, settings: &Plain, at: &str) -> Result<(), String> {
    let allowed = &VOCAB.valid_settings[container];
    let unknown = settings.keys()?.iter().map(|key| source_word(key)).find(|w| !allowed.contains(w));
    match unknown {
        None => Ok(()),
        Some(w) => {
            let takes = if allowed.is_empty() {
                "It takes no settings: write `{}`.".to_owned()
            } else {
                format!("Its settings are: {}.", allowed.join(", "))
            };
            Err(format!("{at}: `{w}` is not a setting of {container}. {takes}{}", hint_for(&w, container)))
        }
    }
}

/* ------------------------------------------------------------------ values */

/// A bare tag (`DIAMOND`) reaches a word as `{tag: "DIAMOND"}`.
pub fn tag_of(value: &Plain) -> Option<&str> {
    value.as_object().and_then(|object| object.get("tag")).and_then(Plain::as_str)
}

pub fn is_record(value: &Plain) -> bool {
    matches!(value, Plain::Object(_) | Plain::Decimal(_)) && tag_of(value).is_none()
}

/// A value as it was written, for an error message.
pub fn show_value(value: &Plain) -> String {
    match value {
        Plain::Undefined => "nothing".to_owned(),
        Plain::Null => "null".to_owned(),
        Plain::Str(text) => quote(text),
        Plain::List(_) => "a list".to_owned(),
        Plain::Decimal(_) => "a record".to_owned(),
        Plain::Object(_) => match tag_of(value) {
            Some(tag) => format!("the tag {tag}"),
            None => "a record".to_owned(),
        },
        other => js_string(other),
    }
}

/// `#rgb` or `#rrggbb`, any case.
fn is_hex(color: &str) -> bool {
    color
        .strip_prefix('#')
        .is_some_and(|digits| matches!(digits.len(), 3 | 6) && digits.chars().all(|c| c.is_ascii_hexdigit()))
}

/// A named colour, as `NAMED_COLORS[name]` finds one — the plain object's inherited
/// `constructor` and `__proto__` included.
fn is_named_color(name: &str) -> bool {
    VOCAB.named_colors.contains_key(name) || matches!(name, "constructor" | "__proto__")
}

/// A tag written as a quoted string, and the fix.
fn quoted_tag(word: &str, raw: &Plain, one_of: &[String]) -> String {
    let Plain::Str(raw) = raw else { return String::new() };
    let written = trim(raw).to_lowercase().replace(['-', ' '], "_");
    match one_of.iter().find(|tag| tag.to_lowercase() == written) {
        Some(tag) => format!(" Write it bare and uppercase, without quotes: {word} {tag}."),
        None => String::new(),
    }
}

fn emitted(meta: &Meta, tag: &str) -> Plain {
    match meta.emit.as_ref().and_then(|emit| emit.get(tag)) {
        Some(Json::Number(n)) => Plain::Num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Json::String(text)) => Plain::Str(text.clone()),
        _ => Plain::Str(tag.to_owned()),
    }
}

/// Checks and normalizes a word's value: the field's value, or the error.
pub fn check_value(name: &str, meta: &Meta, raw: &Plain) -> Result<Plain, String> {
    let word = word_of(name);
    let one_of = || meta.one_of.join(", ");
    match meta.expects {
        Expects::Text | Expects::Content => {
            let text = match raw.finite() {
                Some(n) => js_number(n),
                None => match raw {
                    Plain::Str(text) => text.clone(),
                    _ => return Err(format!("{word}: expected a string in \"quotes\", got {}.", show_value(raw))),
                },
            };
            if matches!(meta.expects, Expects::Text) && trim(&text).is_empty() {
                return Err(format!("{word}: must not be empty."));
            }
            Ok(Plain::Str(text))
        }
        Expects::Coord => match raw.finite() {
            Some(_) => Ok(raw.clone()),
            None => Err(format!("{word}: expected a number of pixels, got {}.", show_value(raw))),
        },
        Expects::Size => match raw.finite() {
            Some(n) if n > 0.0 => Ok(raw.clone()),
            _ => Err(format!("{word}: expected a number of pixels above 0, got {}.", show_value(raw))),
        },
        Expects::Opacity => match raw.finite() {
            Some(n) if (0.0..=100.0).contains(&n) => Ok(raw.clone()),
            n => {
                let hint = match n {
                    Some(n) if n > 0.0 && n <= 1.0 => {
                        format!(" Opacity is a percentage: write {word} {}.", js_number(js_round(n * 100.0)))
                    }
                    _ => String::new(),
                };
                Err(format!("{word}: expected a number from 0 to 100, got {}.{hint}", show_value(raw)))
            }
        },
        Expects::Boolean => match raw {
            Plain::Bool(_) => Ok(raw.clone()),
            _ => {
                let hint = match raw.as_str() {
                    Some(flag @ ("true" | "false")) => format!(" Write it without quotes: {word} {flag}."),
                    _ => String::new(),
                };
                Err(format!("{word}: expected true or false, written bare, got {}.{hint}", show_value(raw)))
            }
        },
        Expects::Tag => match tag_of(raw) {
            Some(tag) if meta.one_of.iter().any(|t| t == tag) => Ok(emitted(meta, tag)),
            _ => Err(format!(
                "{word}: expected one of {}, got {}.{}",
                one_of(),
                show_value(raw),
                quoted_tag(&word, raw, &meta.one_of)
            )),
        },
        Expects::TagOrNumber => match (tag_of(raw), raw.finite()) {
            (Some(tag), _) if meta.one_of.iter().any(|t| t == tag) => Ok(emitted(meta, tag)),
            (_, Some(n)) if n > 0.0 => Ok(raw.clone()),
            _ => Err(format!(
                "{word}: expected one of {}, or a number of pixels above 0, got {}.{}",
                one_of(),
                show_value(raw),
                quoted_tag(&word, raw, &meta.one_of)
            )),
        },
        Expects::Color => {
            if let Plain::Str(text) = raw {
                let color = trim(text);
                if is_hex(color) {
                    return Ok(Plain::Str(color.to_owned()));
                }
                let lower = color.to_lowercase();
                if is_named_color(&lower) {
                    return Ok(Plain::Str(lower));
                }
            }
            let names: Vec<&str> = VOCAB.named_colors.keys().map(String::as_str).collect();
            Err(format!(
                "{word}: expected a hex colour like \"#ffcc00\" or one of {}, got {}.",
                names.join(", "),
                show_value(raw)
            ))
        }
        Expects::Endpoints => {
            let ok = |v: &Plain| v.as_str().is_some_and(|s| !trim(s).is_empty()) || v.finite().is_some();
            if ok(raw) {
                return Ok(Plain::Str(js_string(raw)));
            }
            match raw {
                Plain::List(items) if !items.is_empty() && items.iter().all(ok) => {
                    Ok(Plain::List(items.iter().map(|item| Plain::Str(js_string(item))).collect()))
                }
                _ => Err(format!(
                    "{word}: expected a node's id in \"quotes\", a list of ids like [\"a\" \"b\"], or \"*\", got {}.",
                    show_value(raw)
                )),
            }
        }
        Expects::Point => {
            let current = |v: &Plain| tag_of(v) == Some("_");
            let pair = match raw {
                Plain::List(items) if items.len() == 2 && items.iter().all(|v| v.finite().is_some() || current(v)) => {
                    items
                }
                _ => {
                    return Err(format!(
                        "{word}: expected an [x y] pair of numbers, like {}, or _ for the current x or y, like waypoint [_ 400], got {}.",
                        example_of(&word),
                        show_value(raw)
                    ));
                }
            };
            if pair.iter().all(current) {
                return Err(format!(
                    "{word}: [_ _] keeps both coordinates, so it is not a new point. Give x or y a number, like waypoint [_ 400]."
                ));
            }
            let at = |v: &Plain| if current(v) { Plain::Null } else { v.clone() };
            Ok(object([("x", at(&pair[0])), ("y", at(&pair[1]))]))
        }
        Expects::Waypoints => {
            const EXAMPLE: &str = "waypoints [ waypoint [300 0] waypoint [300 400] ]";
            let Plain::List(items) = raw else {
                return Err(format!("{word}: expected a list of waypoints, like {EXAMPLE}, got {}.", show_value(raw)));
            };
            if items.is_empty() {
                return Err(format!("{word}: needs at least one waypoint, like {EXAMPLE}."));
            }
            let mut points = Vec::new();
            for (i, item) in items.iter().enumerate() {
                let keys = if is_record(item) { item.keys()? } else { Vec::new() };
                if is_record(item) && keys.is_empty() {
                    return Err(format!(
                        "{word}: item {} is a stray `{{}}`. A waypoint takes only its pair: write waypoint [300 0], not waypoint [300 0] {{}}.",
                        i + 1
                    ));
                }
                if keys.len() != 1 || keys[0] != "waypoint" {
                    let what =
                        if keys.len() == 1 { format!("a `{}`", source_word(&keys[0])) } else { show_value(item) };
                    return Err(format!(
                        "{word}: item {} is {what}, which is not a waypoint. Write each one as waypoint [x y], like {EXAMPLE}.",
                        i + 1
                    ));
                }
                points.push(item.get("waypoint")?.clone());
            }
            Ok(Plain::List(points))
        }
        Expects::Record => {
            if is_record(raw) {
                Ok(raw.clone())
            } else {
                Err(format!(
                    "{word}: expected a description ending in `{{}}`, e.g. {}, got {}.",
                    example_of(&word),
                    show_value(raw)
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(VOCAB.chain_fields.len(), 28);
        assert_eq!(VOCAB.member_fields.len(), 6);
        assert_eq!(VOCAB.shape_kinds.len(), 30);
        assert_eq!(source_word("fontSize"), "font-size");
        assert_eq!(source_word("saveToFigjam"), "save-to-figjam");
        assert_eq!(source_word("toString"), "function toString() { [native code] }");
        assert_eq!(emitted(&VOCAB.chain_fields["FONT_SIZE"], "LARGE"), Plain::Num(40.0));
        assert_eq!(emitted(&VOCAB.chain_fields["TO_CAP"], "ARROW_LINES"), Plain::Str("arrow-lines".into()));
    }

    #[test]
    fn hints_name_where_a_word_belongs() {
        assert_eq!(hint_for("width", "sticky"), " `width` describes a `shape`, or a setting of `section`.");
        assert_eq!(
            hint_for("title", "page"),
            " `title` is a setting of the board: write it after the board's outer `]`, e.g. board [ … ] title … {}."
        );
        assert_eq!(hint_for("nope", "page"), "");
    }

    #[test]
    fn colours_are_hex_or_named() {
        let fill = &VOCAB.chain_fields["FILL"];
        assert_eq!(check_value("FILL", fill, &Plain::Str(" Red ".into())), Ok(Plain::Str("red".into())));
        assert_eq!(check_value("FILL", fill, &Plain::Str("#ABC".into())), Ok(Plain::Str("#ABC".into())));
        assert!(check_value("FILL", fill, &Plain::Str("#ABCD".into())).is_err());
        // The plain object's inherited `constructor` is truthy, so the TypeScript accepts it.
        assert_eq!(check_value("FILL", fill, &Plain::Str("Constructor".into())), Ok(Plain::Str("constructor".into())));
    }
}
