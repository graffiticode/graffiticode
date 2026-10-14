// SPDX-License-Identifier: MIT

//! Data as the TypeScript compiler holds it: plain JavaScript values.
//!
//! L0185's steps work on whatever a fetch returned, so they are written against JavaScript's
//! reading of it, and the output is what `JSON.stringify` makes of the result. [`Js`] is that
//! value: `undefined` is a value (a field can hold it, and `JSON.stringify` drops it), a
//! number is an `f64` (NaN included), an object keeps its keys in JavaScript's order — array
//! indices first, ascending, then the rest as inserted — and a `Date` (which Papa makes of an
//! ISO date-time in a CSV) is an object with no fields of its own.

use std::fmt::Write as _;

use graffiticode_l0000::value::format_number;
use indexmap::IndexMap;
use serde_json::Value as Json;

use crate::dates;

#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    /// A `Date`, by its time value in milliseconds (NaN when invalid).
    Date(f64),
    Arr(Vec<Js>),
    Obj(Obj),
}

/// A plain object: its own enumerable properties, in JavaScript's order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(IndexMap<String, Js>);

/// A key JavaScript treats as an array index, and orders first.
pub fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

impl Obj {
    pub fn new() -> Self {
        Self::default()
    }

    /// `obj[key] = value`: an existing key keeps its place, a new one goes where JavaScript
    /// would put it.
    pub fn set(&mut self, key: impl Into<String>, value: Js) {
        let key = key.into();
        if let Some(slot) = self.0.get_mut(&key) {
            *slot = value;
            return;
        }
        match index_key(&key) {
            Some(n) => {
                let at = self.0.keys().position(|k| index_key(k).is_none_or(|m| m > n)).unwrap_or(self.0.len());
                self.0.shift_insert(at, key, value);
            }
            None => {
                self.0.insert(key, value);
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.0.get(key)
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn remove(&mut self, key: &str) -> Option<Js> {
        self.0.shift_remove(key)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.keys()
    }

    pub fn values(&self) -> impl Iterator<Item = &Js> {
        self.0.values()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Js)> {
        self.0.iter()
    }
}

impl FromIterator<(String, Js)> for Obj {
    fn from_iter<I: IntoIterator<Item = (String, Js)>>(iter: I) -> Self {
        let mut obj = Obj::new();
        for (key, value) in iter {
            obj.set(key, value);
        }
        obj
    }
}

impl From<&str> for Js {
    fn from(s: &str) -> Self {
        Js::Str(s.to_owned())
    }
}

impl From<String> for Js {
    fn from(s: String) -> Self {
        Js::Str(s)
    }
}

impl Js {
    pub fn str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, Js::Undef | Js::Null)
    }

    /// `typeof v === "object" && v !== null`.
    pub fn is_object(&self) -> bool {
        matches!(self, Js::Date(_) | Js::Arr(_) | Js::Obj(_))
    }

    /// A value read from JSON text, as `JSON.parse` would build it.
    pub fn from_json(json: &Json) -> Js {
        match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Num(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Js::Str(s.clone()),
            Json::Array(items) => Js::Arr(items.iter().map(Js::from_json).collect()),
            Json::Object(object) => Js::Obj(object.iter().map(|(k, v)| (k.clone(), Js::from_json(v))).collect()),
        }
    }

    /// `JSON.parse`.
    pub fn parse_json(text: &str) -> Option<Js> {
        serde_json::from_str::<Json>(text).ok().map(|json| Js::from_json(&json))
    }
}

/// `typeof v.tag === "string"`: how the TypeScript tells a tag from a record.
pub fn is_tag(v: &Js) -> bool {
    matches!(v, Js::Obj(obj) if matches!(obj.get("tag"), Some(Js::Str(_))))
}

pub fn tag_of(v: &Js) -> Option<&str> {
    match v {
        Js::Obj(obj) if is_tag(v) => obj.get("tag").and_then(Js::str),
        _ => None,
    }
}

/// An object that is neither a list nor a tag.
pub fn is_record(v: &Js) -> bool {
    matches!(v, Js::Date(_)) || matches!(v, Js::Obj(_)) && !is_tag(v)
}

/// A finite number.
pub fn is_num(v: &Js) -> bool {
    matches!(v, Js::Num(n) if n.is_finite())
}

/// How a value is named in a message.
pub fn show_value(v: &Js) -> String {
    match v {
        Js::Undef => "nothing".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Str(s) => quote(s),
        _ if is_tag(v) => format!("the tag {}", tag_of(v).unwrap_or_default()),
        Js::Arr(_) => "a list".to_owned(),
        Js::Obj(_) | Js::Date(_) => "a record".to_owned(),
        other => js_string(other),
    }
}

/// `JSON.stringify` of a string.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_string(&mut out, s);
    out
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// JavaScript's `String(v)`.
pub fn js_string(v: &Js) -> String {
    match v {
        Js::Undef => "undefined".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => format_number(*n),
        Js::Str(s) => s.clone(),
        Js::Date(t) => dates::to_string(*t),
        Js::Arr(items) => {
            let parts: Vec<String> =
                items.iter().map(|item| if item.is_nullish() { String::new() } else { js_string(item) }).collect();
            parts.join(",")
        }
        Js::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `JSON.stringify(v)`, or `None` where it returns `undefined`.
pub fn stringify(v: &Js) -> Option<String> {
    if matches!(v, Js::Undef) {
        return None;
    }
    let mut out = String::new();
    write_json(&mut out, v);
    Some(out)
}

fn write_json(out: &mut String, v: &Js) {
    match v {
        Js::Undef | Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Num(n) if n.is_finite() => out.push_str(&format_number(*n)),
        Js::Num(_) => out.push_str("null"),
        Js::Str(s) => write_string(out, s),
        Js::Date(t) => match dates::to_iso_string(*t) {
            Some(iso) => write_string(out, &iso),
            None => out.push_str("null"),
        },
        Js::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Js::Obj(obj) => {
            out.push('{');
            let mut first = true;
            for (key, value) in obj.iter() {
                if matches!(value, Js::Undef) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(out, key);
                out.push(':');
                write_json(out, value);
            }
            out.push('}');
        }
    }
}

/// The error JavaScript throws when it reads a property of `null` or `undefined`.
pub fn read_error(v: &Js, key: &str) -> String {
    let what = if matches!(v, Js::Null) { "null" } else { "undefined" };
    format!("Cannot read properties of {what} (reading '{key}')")
}

/// `Object.entries(v)`: its own enumerable properties. `null` and `undefined` throw.
pub fn entries(v: &Js) -> Result<Vec<(String, Js)>, String> {
    Ok(match v {
        Js::Undef | Js::Null => return Err("Cannot convert undefined or null to object".to_owned()),
        Js::Obj(obj) => obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Js::Arr(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Js::Str(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Js::Str(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Vec::new(),
    })
}

/// `{...v}`: as [`entries`], but spreading `null` or `undefined` gives `{}`.
pub fn spread(v: &Js) -> Obj {
    entries(v).unwrap_or_default().into_iter().collect()
}

/// `Object.prototype.hasOwnProperty.call(v, key)`.
pub fn has_own(v: &Js, key: &str) -> bool {
    match v {
        Js::Obj(obj) => obj.has(key),
        Js::Arr(items) => key == "length" || index_key(key).is_some_and(|i| (i as usize) < items.len()),
        Js::Str(s) => key == "length" || index_key(key).is_some_and(|i| (i as usize) < s.encode_utf16().count()),
        _ => false,
    }
}

/// `v[key]` for an own property (inherited ones are not modelled).
pub fn prop(v: &Js, key: &str) -> Js {
    match v {
        Js::Obj(obj) => obj.get(key).cloned().unwrap_or(Js::Undef),
        Js::Arr(items) if key == "length" => Js::Num(items.len() as f64),
        Js::Arr(items) => index_key(key).and_then(|i| items.get(i as usize)).cloned().unwrap_or(Js::Undef),
        Js::Str(s) if key == "length" => Js::Num(s.encode_utf16().count() as f64),
        Js::Str(s) => index_key(key)
            .and_then(|i| s.encode_utf16().nth(i as usize))
            .map_or(Js::Undef, |unit| Js::Str(String::from_utf16_lossy(&[unit]))),
        _ => Js::Undef,
    }
}

/// `a === b`: objects are equal only to themselves, and no two values here are the same object.
pub fn strict_eq(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Undef, Js::Undef) | (Js::Null, Js::Null) => true,
        (Js::Bool(a), Js::Bool(b)) => a == b,
        (Js::Num(a), Js::Num(b)) => a == b,
        (Js::Str(a), Js::Str(b)) => a == b,
        _ => false,
    }
}

/// White space as JavaScript's `trim` sees it.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// JavaScript's `Number(s)` for a string.
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &t[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)));
    }
    if is_decimal_literal(t) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`
fn is_decimal_literal(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// JavaScript's `parseFloat` of text that is known to start, after white space, with a
/// decimal literal.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_space);
    let b = t.as_bytes();
    let mut end = 0;
    let mut best = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        end += 1;
    }
    while end <= b.len() {
        if is_decimal_literal(&t[..end]) {
            best = end;
        }
        if end == b.len() || !(b[end].is_ascii_digit() || matches!(b[end], b'.' | b'e' | b'E' | b'+' | b'-')) {
            break;
        }
        end += 1;
    }
    if best == 0 { f64::NAN } else { t[..best].parse().unwrap_or(f64::NAN) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objects_take_javascripts_key_order() {
        let mut obj = Obj::new();
        for key in ["b", "10", "a", "2", "01", "2"] {
            obj.set(key, Js::Num(1.0));
        }
        assert_eq!(obj.keys().cloned().collect::<Vec<_>>(), ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(to_number(" 12 "), 12.0);
        assert_eq!(to_number("0x1f"), 31.0);
        assert_eq!(to_number(".5"), 0.5);
        assert_eq!(to_number("5."), 5.0);
        assert!(to_number("1e").is_nan());
        assert!(to_number("inf").is_nan());
        assert_eq!(to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(parse_float("  1.5e3x"), 1500.0);
        assert_eq!(parse_float("1e+"), 1.0);
    }

    #[test]
    fn stringify_is_javascripts() {
        let mut obj = Obj::new();
        obj.set("a", Js::Undef);
        obj.set("b", Js::Arr(vec![Js::Undef, Js::Num(f64::NAN), Js::Num(1e21), Js::Str("\u{1}\"".into())]));
        assert_eq!(stringify(&Js::Obj(obj)).unwrap(), r#"{"b":[null,null,1e+21,"\u0001\""]}"#);
        assert_eq!(js_string(&Js::Arr(vec![Js::Num(1.0), Js::Null, Js::Str("a".into())])), "1,,a");
    }
}
