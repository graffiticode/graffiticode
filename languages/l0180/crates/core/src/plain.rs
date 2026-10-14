// SPDX-License-Identifier: MIT

//! Values as the plain JSON objects the TypeScript L0180 works on, and the JavaScript readings
//! of them its messages and output were written against.
//!
//! Every L0180 word reads its arguments as JSON ([`plain`]) and builds JSON. An object's keys
//! keep the order a JavaScript object would give them — array-index keys first, ascending,
//! then the rest as written — because that is the order the TypeScript compiler emits, and the
//! order in which it sums a key's values.

use graffiticode_l0000::{Number, Value};
use serde_json::{Map, Value as Json, json};

use crate::text;

pub type Object = Map<String, Json>;

/// A value as plain JSON, or `None` for a missing one.
pub fn plain(value: &Value) -> Option<Json> {
    value.to_json().map(js_order)
}

/// A JSON value as a runtime value.
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

/// A number as JavaScript's `String()` writes it.
pub fn num(n: f64) -> String {
    Number::Float(n).display()
}

/// A value as JavaScript's `String()` writes it.
pub fn js_string(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        Json::Null => "null".to_owned(),
        Json::Bool(flag) => flag.to_string(),
        Json::Number(number) => num(number.as_f64().unwrap_or(f64::NAN)),
        Json::Array(items) => join(items, ","),
        Json::Object(_) => "[object Object]".to_owned(),
    }
}

/// A value as a template literal or `String()` writes it, a missing one included.
pub fn js_str(json: Option<&Json>) -> String {
    json.map_or_else(|| "undefined".to_owned(), js_string)
}

/// `String(s ?? "")`.
pub fn js_str_or_empty(json: Option<&Json>) -> String {
    match json {
        None | Some(Json::Null) => String::new(),
        Some(json) => js_string(json),
    }
}

/// `Array.prototype.join`: `null` and `undefined` entries are empty.
pub fn join(items: &[Json], separator: &str) -> String {
    let items: Vec<String> = items.iter().map(|item| js_str_or_empty(Some(item))).collect();
    items.join(separator)
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

/// `value.key` for a key that is no array index: only an object has one.
pub fn prop<'a>(json: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    match json {
        Some(Json::Object(object)) => object.get(key),
        _ => None,
    }
}

/// `typeof value === "number"`, as the number.
pub fn number(json: Option<&Json>) -> Option<f64> {
    json.and_then(Json::as_f64)
}

/// `typeof value === "string"`, as the string.
pub fn string(json: Option<&Json>) -> Option<&str> {
    json.and_then(Json::as_str)
}

/// JavaScript's `Number(value)`, which is what `<` and `>` compare a non-number as.
pub fn to_number(json: Option<&Json>) -> f64 {
    match json {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Json::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => string_to_number(text),
        Some(Json::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] if !one.is_array() && !one.is_object() => to_number(Some(one)),
            _ => f64::NAN,
        },
        Some(Json::Object(_)) => f64::NAN,
    }
}

fn string_to_number(text: &str) -> f64 {
    let t = text::trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str, radix: u32| {
        t.strip_prefix(prefix).map(|digits| {
            if digits.is_empty() {
                f64::NAN
            } else {
                u128::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64)
            }
        })
    };
    if let Some(n) = radix("0x", 16).or_else(|| radix("0X", 16)) {
        return n;
    }
    if let Some(n) = radix("0o", 8).or_else(|| radix("0O", 8)) {
        return n;
    }
    if let Some(n) = radix("0b", 2).or_else(|| radix("0B", 2)) {
        return n;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && t.chars().any(|c| c.is_ascii_digit());
    if valid { t.parse::<f64>().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// `a > b` for two values JavaScript would compare as numbers.
pub fn gt(a: Option<&Json>, b: Option<&Json>) -> bool {
    to_number(a) > to_number(b)
}

/// A number as JSON.
pub fn json_num(n: f64) -> Json {
    serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number)
}

/// `Object.keys(value)`.
pub fn keys(json: Option<&Json>) -> Vec<String> {
    match json {
        Some(Json::Object(object)) => object.keys().cloned().collect(),
        Some(Json::Array(items)) => (0..items.len()).map(|i| i.to_string()).collect(),
        Some(Json::String(text)) => (0..text::length(text)).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// The fields `{...value}` spreads.
pub fn spread(json: Option<&Json>) -> Object {
    match json {
        Some(Json::Object(object)) => object.clone(),
        Some(Json::Array(items)) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        Some(Json::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Object::new(),
    }
}

/// `{...(value || {})}`.
pub fn spread_or_empty(json: Option<&Json>) -> Object {
    if truthy(json) { spread(json) } else { Object::new() }
}

/// Whether a JavaScript `Map` would take two values as the same key (SameValueZero).
pub fn same_key(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        (a, b) => a == b,
    }
}

/// How the TypeScript names a bad value in a message: the way its author wrote it.
pub fn show_value(json: Option<&Json>) -> String {
    match json {
        None => "undefined".to_owned(),
        Some(Json::String(text)) => Json::String(text.clone()).to_string(),
        Some(Json::Null) => "null".to_owned(),
        Some(Json::Array(_)) => "a list".to_owned(),
        Some(Json::Object(_)) => "a record".to_owned(),
        Some(other) => js_string(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_take_javascripts_order() {
        let ordered = js_order(json!({ "b": 1, "10": 2, "a": { "2": 0, "z": 1, "1": 2 }, "01": 3, "2": 4 }));
        assert_eq!(ordered.to_string(), r#"{"2":4,"10":2,"b":1,"a":{"1":2,"2":0,"z":1},"01":3}"#);
    }

    #[test]
    fn strings_are_javascripts() {
        assert_eq!(js_string(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(js_string(&json!(2.5)), "2.5");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(show_value(Some(&json!("a\"b"))), r#""a\"b""#);
        assert_eq!(show_value(Some(&json!(1e21))), "1e+21");
        assert_eq!(show_value(None), "undefined");
    }

    #[test]
    fn spreading_reads_what_javascript_reads() {
        assert_eq!(Json::Object(spread(Some(&json!("ab")))).to_string(), r#"{"0":"a","1":"b"}"#);
        assert!(spread_or_empty(Some(&json!(0))).is_empty());
        assert_eq!(keys(Some(&json!("ab"))), ["0", "1"]);
    }

    #[test]
    fn comparisons_coerce_as_javascript_does() {
        assert!(gt(Some(&json!("3")), Some(&json!(2))));
        assert!(!gt(None, Some(&json!(0))));
        assert!(gt(Some(&json!(true)), Some(&json!(0))));
        assert_eq!(to_number(Some(&json!(" 0x10 "))), 16.0);
        assert!(to_number(Some(&json!("1,0"))).is_nan());
    }
}
