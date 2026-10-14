// SPDX-License-Identifier: MIT

//! Values as the plain JavaScript objects the TypeScript L0183 works on, and the JavaScript
//! readings of them its messages and output were written against.
//!
//! L0183's words read their arguments as plain JSON ([`plain`], the TypeScript's
//! `toPlainObject`) and build JSON. A missing value (JavaScript's `undefined`) is `None`. An
//! object's keys keep the order a JavaScript object gives them — array-index keys first,
//! ascending, then the rest as inserted — because that is the order the TypeScript compiler
//! emits and iterates.

use std::cmp::Ordering;

use graffiticode_l0000::{Number, Value};
use serde_json::{Map, Value as Json};

use crate::text;

pub type Object = Map<String, Json>;

/// A JavaScript `TypeError`, as its message reads in Node.
pub fn cannot_read(of: Option<&Json>, property: &str) -> String {
    let of = if matches!(of, Some(Json::Null)) { "null" } else { "undefined" };
    format!("Cannot read properties of {of} (reading '{property}')")
}

/// A value as plain JSON, or `None` for a missing one.
pub fn plain(value: &Value) -> Option<Json> {
    value.to_json().map(js_order)
}

/// A plain value back as a kernel value, its keys in JavaScript's order.
pub fn value(json: Json) -> Value {
    Value::from_json(&js_order(json))
}

/// Orders every object's keys as a JavaScript object orders them.
pub fn js_order(json: Json) -> Json {
    match json {
        Json::Object(object) => {
            let (mut indices, named): (Vec<_>, Vec<_>) = object
                .into_iter()
                .map(|(key, value)| (key, js_order(value)))
                .partition(|(key, _)| index(key).is_some());
            indices.sort_by_key(|(key, _)| index(key));
            Json::Object(indices.into_iter().chain(named).collect())
        }
        Json::Array(items) => Json::Array(items.into_iter().map(js_order).collect()),
        other => other,
    }
}

/// A key JavaScript treats as an array index.
fn index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

fn number(n: &serde_json::Number) -> String {
    Number::Float(n.as_f64().unwrap_or(f64::NAN)).display()
}

/// A value as JavaScript's `String()` (and a template literal) writes it.
pub fn js_string(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        Json::Null => "null".to_owned(),
        Json::Bool(flag) => flag.to_string(),
        Json::Number(n) => number(n),
        Json::Array(items) => join(items.iter().map(Some), ","),
        Json::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String()` of a value that may be missing.
pub fn js_string_or_undefined(json: Option<&Json>) -> String {
    json.map_or_else(|| "undefined".to_owned(), js_string)
}

/// `Array.prototype.join`: a missing or null element is empty.
pub fn join<'a>(items: impl Iterator<Item = Option<&'a Json>>, separator: &str) -> String {
    items
        .map(|item| match item {
            None | Some(Json::Null) => String::new(),
            Some(item) => js_string(item),
        })
        .collect::<Vec<_>>()
        .join(separator)
}

/// `JSON.stringify`, numbers written as JavaScript writes them.
pub fn stringify(json: &Json) -> String {
    match json {
        Json::Number(n) => number(n),
        Json::Array(items) => format!("[{}]", items.iter().map(stringify).collect::<Vec<_>>().join(",")),
        Json::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, value)| format!("{}:{}", Json::String(key.clone()), stringify(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// Whether a value is truthy in JavaScript.
pub fn truthy(json: Option<&Json>) -> bool {
    match json {
        None | Some(Json::Null) => false,
        Some(Json::Bool(flag)) => *flag,
        Some(Json::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Json::String(text)) => !text.is_empty(),
        Some(Json::Array(_) | Json::Object(_)) => true,
    }
}

/// `ToNumber`.
pub fn to_number(json: Option<&Json>) -> f64 {
    match json {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => string_to_number(text),
        Some(other @ (Json::Array(_) | Json::Object(_))) => string_to_number(&js_string(other)),
    }
}

fn string_to_number(text: &str) -> f64 {
    let text = text::trim(text);
    match text {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => {
            let radix = |prefix: &str, radix| {
                text.strip_prefix(prefix)
                    .or_else(|| text.strip_prefix(&prefix.to_uppercase()))
                    .map(|digits| u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64))
            };
            if let Some(n) = radix("0x", 16).or_else(|| radix("0o", 8)).or_else(|| radix("0b", 2)) {
                return n;
            }
            let numeric = text.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
            if numeric { text.parse().unwrap_or(f64::NAN) } else { f64::NAN }
        }
    }
}

/// A number as JSON, written as the kernel writes one.
pub fn num(n: f64) -> Json {
    Value::from(n).to_json().unwrap_or(Json::Null)
}

/// JavaScript's `+`, for the running total of points.
pub fn add(a: &Json, b: Option<&Json>) -> Json {
    let is_text = |json: Option<&Json>| matches!(json, Some(Json::String(_) | Json::Array(_) | Json::Object(_)));
    if is_text(Some(a)) || is_text(b) {
        Json::String(js_string(a) + &js_string_or_undefined(b))
    } else {
        num(to_number(Some(a)) + to_number(b))
    }
}

/// `===` (and `SameValueZero`, which differs only for NaN). Two objects are never the same
/// object here: every one this compiler compares was built separately.
pub fn strict_eq(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(a)), Some(Json::Bool(b))) => a == b,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Json::String(a)), Some(Json::String(b))) => a == b,
        _ => false,
    }
}

/// A bare tag (`DARK`) reaches the words as `{tag: "DARK"}`.
pub fn is_tag(json: Option<&Json>) -> bool {
    matches!(json, Some(Json::Object(object)) if object.get("tag").is_some_and(Json::is_string))
}

/// An object that is neither a list nor a tag: a description or settings record.
pub fn is_record(json: Option<&Json>) -> bool {
    matches!(json, Some(Json::Object(_))) && !is_tag(json)
}

/// A value as it was written, for an error message.
pub fn show_value(json: Option<&Json>) -> String {
    match json {
        None => "nothing".to_owned(),
        Some(Json::String(_)) => stringify(json.expect("matched")),
        Some(tag) if is_tag(json) => format!("the tag {}", js_string(&tag["tag"])),
        Some(Json::Array(_)) => "a list".to_owned(),
        Some(Json::Object(_)) => "a record".to_owned(),
        Some(other) => js_string(other),
    }
}

/// `Object.keys`.
pub fn keys(json: Option<&Json>) -> Result<Vec<String>, String> {
    match json {
        None | Some(Json::Null) => Err("Cannot convert undefined or null to object".to_owned()),
        Some(json) => Ok(entries(json).into_iter().map(|(key, _)| key).collect()),
    }
}

/// A value's own enumerable properties, as `{...value}` copies them.
pub fn entries(json: &Json) -> Object {
    match json {
        Json::Object(object) => object.clone(),
        Json::Array(items) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        Json::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Json::String(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Object::new(),
    }
}

/// Reading `value[key]` (and `value?.[key]`): `None` where JavaScript reads `undefined`.
pub fn get(json: Option<&Json>, key: &str) -> Option<Json> {
    match json? {
        Json::Object(object) => object.get(key).cloned(),
        Json::Array(items) => match key {
            "length" => Some(num(items.len() as f64)),
            _ => index(key).and_then(|i| items.get(i as usize)).cloned(),
        },
        Json::String(text) => {
            let units: Vec<u16> = text.encode_utf16().collect();
            match key {
                "length" => Some(num(units.len() as f64)),
                _ => index(key)
                    .and_then(|i| units.get(i as usize))
                    .map(|unit| Json::String(String::from_utf16_lossy(&[*unit]))),
            }
        }
        _ => None,
    }
}

/// `a.k ?? fallback`.
pub fn or_else(json: Option<Json>, fallback: impl FnOnce() -> Json) -> Json {
    match json {
        None | Some(Json::Null) => fallback(),
        Some(json) => json,
    }
}

/// `Array.prototype.sort`'s default order: by UTF-16 code units.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_take_javascripts_order() {
        let ordered = js_order(json!({ "b": 1, "10": 2, "a": { "2": 0, "z": 1, "1": 2 }, "01": 3, "2": 4 }));
        assert_eq!(ordered.to_string(), r#"{"2":4,"10":2,"b":1,"a":{"1":2,"2":0,"z":1},"01":3}"#);
    }

    #[test]
    fn strings_and_numbers_are_javascripts() {
        assert_eq!(js_string(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(js_string(&json!(2.5)), "2.5");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(stringify(&json!({ "a": [1.5, "\"q\""], "b": null })), r#"{"a":[1.5,"\"q\""],"b":null}"#);
        assert_eq!(show_value(Some(&json!({ "tag": "DARK" }))), "the tag DARK");
        assert_eq!(show_value(Some(&json!({ "tag": 5 }))), "a record");
        assert_eq!(show_value(None), "nothing");
        assert_eq!(to_number(Some(&json!(" 2 "))), 2.0);
        assert!(to_number(Some(&json!({}))).is_nan());
        assert_eq!(add(&json!(0), Some(&json!("2"))), json!("02"));
        assert_eq!(add(&json!(1), Some(&json!(0.5))), json!(1.5));
    }

    #[test]
    fn properties_are_read_as_javascript_reads_them() {
        assert_eq!(get(Some(&json!("abc")), "1"), Some(json!("b")));
        assert_eq!(get(Some(&json!("abc")), "length"), Some(json!(3)));
        assert_eq!(get(Some(&json!([7])), "0"), Some(json!(7)));
        assert_eq!(get(Some(&json!([7])), "00"), None);
        assert_eq!(keys(Some(&json!("ab"))).unwrap(), ["0", "1"]);
        assert!(keys(Some(&json!(null))).is_err());
        assert_eq!(utf16_cmp("\u{ff5e}", "😀"), Ordering::Greater);
    }
}
