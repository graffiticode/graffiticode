// SPDX-License-Identifier: MIT

//! The attribute vocabulary, as `packages/core/src/attributes.ts` declares it.
//!
//! `attributes.json` is generated from that table by `tests/conformance/generate.mjs`: each
//! word's emitted field, shape, argument type and arity, its coercion and validator by name,
//! and which words each container takes. Change the vocabulary there and regenerate.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;

use crate::js::{Js, Obj, js_string, number_string, trim};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Expects {
    String,
    Number,
    Boolean,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Coerce {
    /// `tagValue(v)`.
    TagValue,
    /// `tagValue(v) || ""`.
    AsTag,
    /// `tagValue(v)?.toLowerCase() || v`.
    Lowercase,
    /// `v ? "instant" : "check"`.
    Feedback,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Validate {
    CssSize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Meta {
    pub field: String,
    #[serde(default)]
    pub shape: Option<String>,
    #[serde(default)]
    pub expects: Option<Expects>,
    #[serde(default)]
    pub chaining: bool,
    #[serde(default)]
    pub coerce: Option<Coerce>,
    #[serde(default)]
    pub validate: Option<Validate>,
}

impl Meta {
    /// An attribute whose value is itself an attribute list (`assess [...]`).
    pub fn is_object(&self) -> bool {
        self.shape.as_deref() == Some("object")
    }
}

#[derive(Deserialize)]
struct Table {
    attributes: IndexMap<String, Meta>,
    containers: IndexMap<String, Vec<String>>,
}

pub struct Vocabulary {
    /// Node tag (`FONT_SIZE`) to its row.
    pub attributes: IndexMap<String, Meta>,
    /// Container tag (`CELL`) to the words it takes, in source spelling.
    pub containers: IndexMap<String, Vec<String>>,
    /// Emitted field to source spelling (`hideMenu` is `hide-formulabar`).
    field_to_word: IndexMap<String, String>,
    /// Source spelling to the containers that take it, lowercase.
    owners: IndexMap<String, Vec<String>>,
}

pub static VOCABULARY: LazyLock<Vocabulary> = LazyLock::new(|| {
    let table: Table =
        serde_json::from_str(include_str!("attributes.json")).expect("the embedded attribute table is valid");
    // Seeded with `params`, which evaluates into the `sheets` slot without being a table row.
    let mut field_to_word: IndexMap<String, String> =
        [("templateVariablesRecords".to_owned(), "params".to_owned())].into_iter().collect();
    for (name, meta) in &table.attributes {
        field_to_word.insert(meta.field.clone(), word(name));
    }
    let mut owners: IndexMap<String, Vec<String>> = IndexMap::new();
    for (container, words) in &table.containers {
        for w in words {
            owners.entry(w.clone()).or_default().push(container.to_lowercase());
        }
    }
    Vocabulary { attributes: table.attributes, containers: table.containers, field_to_word, owners }
});

/// A node tag as the word it is written as: `FONT_SIZE` is `font-size`.
pub fn word(tag: &str) -> String {
    tag.to_lowercase().replace('_', "-")
}

/// L0166's `tagValue`: a non-empty string, or the name of a `{tag}`.
pub fn tag_value(v: &Js) -> Option<String> {
    match v {
        Js::Str(s) if !s.is_empty() => Some(s.clone()),
        Js::Obj(obj) => match obj.get("tag") {
            Some(Js::Str(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Names a bad value the way its author wrote it.
fn describe(v: &Js) -> String {
    match v {
        Js::Undefined | Js::Null => "nothing".to_owned(),
        Js::Num(n) => format!("the number {}", number_string(*n)),
        Js::Bool(b) => b.to_string(),
        Js::Arr(_) => "a list".to_owned(),
        Js::Obj(_) | Js::Dec(_) => "a record".to_owned(),
        Js::Str(_) => format!("`{}`", js_string(v)),
    }
}

/// `checkType`: the argument's type, enforced where the value is read.
fn check_type(name: &str, meta: &Meta, raw: &Js) -> Option<String> {
    let word = word(name);
    match meta.expects? {
        Expects::String => {
            tag_value(raw).is_none().then(|| format!("E_ARG_TYPE: {word} expects a string, got {}.", describe(raw)))
        }
        Expects::Number => match raw {
            Js::Num(n) if n.is_finite() => {
                (name == "POINTS" && *n < 0.0).then(|| format!("E_INVALID_POINTS: {} must be >= 0.", number_string(*n)))
            }
            _ => Some(format!("E_ARG_TYPE: {word} expects a number, got {}.", describe(raw))),
        },
        Expects::Boolean => (!matches!(raw, Js::Bool(_)))
            .then(|| format!("E_ARG_TYPE: {word} expects true or false, got {}.", describe(raw))),
    }
}

/// `checkValue`: the type first, then the attribute's own rule.
pub fn check_value(name: &str, meta: &Meta, raw: &Js) -> Option<String> {
    check_type(name, meta, raw).or_else(|| match meta.validate? {
        Validate::CssSize => css_size(raw),
    })
}

const FONT_SIZE_KEYWORDS: &[&str] = &[
    "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "smaller", "larger", "inherit",
    "initial", "unset",
];

const UNITS: &[&str] =
    &["px", "pt", "pc", "em", "rem", "ex", "ch", "vw", "vh", "vmin", "vmax", "%", "in", "cm", "mm", "q"];

/// A CSS length (`/^-?(\d+\.?\d*|\.\d+)(px|…|q)$/i`) or a font-size keyword.
fn css_size(v: &Js) -> Option<String> {
    let s = tag_value(v)?;
    if FONT_SIZE_KEYWORDS.contains(&s.to_lowercase().as_str()) || is_length(trim(&s)) {
        return None;
    }
    Some(format!(
        "E_INVALID_SIZE: font-size \"{s}\" needs a unit, e.g. \"14px\" — a bare number is not a CSS size and does not render."
    ))
}

fn is_length(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    let number = if digits > 0 {
        let rest = &s[digits..];
        let rest = rest.strip_prefix('.').map_or(rest, |r| r.trim_start_matches(|c: char| c.is_ascii_digit()));
        s.len() - rest.len()
    } else {
        match s.strip_prefix('.') {
            Some(rest) => {
                let frac = rest.bytes().take_while(u8::is_ascii_digit).count();
                if frac == 0 {
                    return false;
                }
                1 + frac
            }
            None => return false,
        }
    };
    // ASCII-only case folding: JavaScript's `i` flag without `u` does not fold `ſ` or `K`.
    let unit = s[number..].to_ascii_lowercase();
    UNITS.contains(&unit.as_str())
}

/// The value an attribute stores, after its coercion.
pub fn coerce(meta: &Meta, raw: Js) -> Js {
    match meta.coerce {
        None => raw,
        Some(Coerce::TagValue) => tag_value(&raw).map_or(Js::Undefined, Js::Str),
        Some(Coerce::AsTag) => Js::Str(tag_value(&raw).unwrap_or_default()),
        Some(Coerce::Lowercase) => match tag_value(&raw).map(|s| s.to_lowercase()) {
            Some(lower) if !lower.is_empty() => Js::Str(lower),
            _ => raw,
        },
        Some(Coerce::Feedback) => Js::str(if raw.truthy() { "instant" } else { "check" }),
    }
}

/// `assertKnownAttributes`: refuses a word the container does not take, naming what it takes
/// and where the word belongs.
pub fn assert_known(container: &str, attrs: &Js) -> Result<(), String> {
    let vocabulary = &*VOCABULARY;
    let Some(allowed) = vocabulary.containers.get(container) else { return Ok(()) };
    let where_ = container.to_lowercase();
    let unknown: Vec<String> = attrs
        .keys()
        .unwrap_or_default()
        .into_iter()
        .map(|field| vocabulary.field_to_word.get(&field).cloned().unwrap_or(field))
        .filter(|w| !allowed.contains(w))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let hints: String = unknown
        .iter()
        .map(|w| {
            let owners: Vec<&str> = vocabulary
                .owners
                .get(w)
                .into_iter()
                .flatten()
                .map(String::as_str)
                .filter(|owner| *owner != where_)
                .collect();
            if owners.is_empty() { String::new() } else { format!(" `{w}` belongs to {}.", owners.join(" or ")) }
        })
        .collect();
    let listed: Vec<String> = unknown.iter().map(|u| format!("`{u}`")).collect();
    let verb = if unknown.len() == 1 { "is not an attribute" } else { "are not attributes" };
    Err(format!("{where_}: {} {verb} of {where_}. It takes: {}.{hints}", listed.join(", "), allowed.join(", ")))
}

/// `mergeAttributes`: an attribute list folded into one object.
pub fn merge(attrs: &Js, where_: &str) -> Result<Obj, String> {
    let Js::Arr(list) = attrs else {
        return Err(format!("{where_}: expected an attribute list in [brackets], e.g. [text \"Total\"]."));
    };
    let mut out = Obj::new();
    for a in &list.items {
        if !a.is_object() || matches!(a, Js::Null | Js::Arr(_)) {
            return Err(format!(
                "{where_}: every entry must be an attribute applied to a value, e.g. [text \"Total\" width 100]."
            ));
        }
        crate::js::spread_into(&mut out, a);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_loads() {
        let v = &*VOCABULARY;
        assert_eq!(v.attributes["HIDE_FORMULABAR"].field, "hideMenu");
        assert!(v.attributes["TITLE"].chaining);
        assert!(v.attributes["ASSESS"].is_object());
        assert_eq!(v.attributes["FONT_SIZE"].validate, Some(Validate::CssSize));
        assert_eq!(v.field_to_word["hideMenu"], "hide-formulabar");
        assert_eq!(v.owners["assess"], ["cell", "column", "row"]);
    }

    #[test]
    fn a_css_length_needs_a_unit() {
        for good in ["14px", "1.2em", "120%", ".5rem", "-1PX", "1.px", "3Q"] {
            assert!(is_length(good), "{good}");
        }
        for bad in ["16", "px", ".px", "1.2.3px", "10 px", "-px", "1e3px", "١px"] {
            assert!(!is_length(bad), "{bad}");
        }
    }
}
