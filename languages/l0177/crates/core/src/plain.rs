// SPDX-License-Identifier: MIT

//! Values as the plain JSON objects L0176 works on, and the JavaScript readings of them the
//! TypeScript compiler's messages and output were written against.
//!
//! L0177's words collect a design as JSON objects and check it once its context is known, so
//! they read their arguments as JSON ([`plain`]) and build JSON. An object's keys keep the order a JavaScript object would give
//! them — array-index keys first, ascending, then the rest as written — because that is the
//! order the TypeScript compiler emits.

use graffiticode_l0000::{Number, Value};
use serde_json::{Map, Value as Json};

pub type Object = Map<String, Json>;

/// A value as plain JSON, or `None` for a missing one.
pub fn plain(value: &Value) -> Option<Json> {
    value.to_json().map(js_order)
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

/// A value as JavaScript's `String()` writes it.
pub fn js_string(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        Json::Null => "null".to_owned(),
        Json::Bool(flag) => flag.to_string(),
        Json::Number(number) => Number::Float(number.as_f64().unwrap_or(f64::NAN)).display(),
        Json::Array(items) => {
            let items: Vec<String> =
                items.iter().map(|item| if item.is_null() { String::new() } else { js_string(item) }).collect();
            items.join(",")
        }
        Json::Object(_) => "[object Object]".to_owned(),
    }
}

/// A value as JavaScript's `String()` writes it, a missing value included.
pub fn js_string_or_undefined(json: Option<&Json>) -> String {
    json.map_or_else(|| "undefined".to_owned(), js_string)
}

/// What JavaScript's `typeof` calls a value, after the article, for a message.
pub fn describe(json: Option<&Json>) -> String {
    match json {
        Some(Json::Array(items)) => {
            format!("a list of {} value{}", items.len(), if items.len() == 1 { "" } else { "s" })
        }
        None | Some(Json::Null) => "nothing".to_owned(),
        Some(Json::String(_)) => "a string".to_owned(),
        Some(Json::Number(_)) => "a number".to_owned(),
        Some(Json::Bool(_)) => "a boolean".to_owned(),
        Some(Json::Object(_)) => "a object".to_owned(),
    }
}

/// A field name as the language spells it: `valid_response` is `valid-response`.
pub fn kebab(field: &str) -> String {
    field.replace('_', "-")
}

/// A string's length in UTF-16 code units, as JavaScript counts it.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
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
    fn strings_are_javascripts() {
        assert_eq!(js_string(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(js_string(&json!(2.5)), "2.5");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(describe(Some(&json!([1]))), "a list of 1 value");
        assert_eq!(describe(None), "nothing");
    }
}
