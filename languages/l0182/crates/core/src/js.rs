// SPDX-License-Identifier: MIT

//! Values as the TypeScript compiler sees them, and the JavaScript readings its messages and
//! output were written against.
//!
//! The TypeScript works on plain JavaScript values: a program's values after `toPlainObject`,
//! and a survey's data after `JSON.parse`. [`Js`] is that value: `undefined` stays distinct
//! from `null`, an object keeps JavaScript's key order (array-index keys first, ascending, then
//! the rest as written), and a tag is the object `{tag: name}` it is in TypeScript.

use graffiticode_l0000::value::format_number;
use graffiticode_l0000::{Key, Number, Record, Value};
use indexmap::IndexMap;
use serde_json::Value as Json;

pub type Obj = IndexMap<String, Js>;

#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Js>),
    Obj(Obj),
    /// A value TypeScript holds as an object of its own: a number too precise for an `f64`
    /// (a `Decimal` there). It is "a record" in a message and is otherwise carried through.
    Opaque(Value),
}

impl Js {
    /// A program's value, as `toPlainObject` gives it to the TypeScript handlers.
    pub fn from_value(value: &Value) -> Js {
        match value {
            Value::Undefined => Js::Undefined,
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(*b),
            Value::Num(Number::Float(n)) => Js::Num(*n),
            Value::Num(Number::Exact(_)) => Js::Opaque(value.clone()),
            Value::Str(s) => Js::Str(s.clone()),
            Value::Tag(name) => Js::Obj(Obj::from([("tag".to_owned(), Js::Str(name.clone()))])),
            Value::List(items) => Js::List(items.iter().map(Js::from_value).collect()),
            Value::Record(record) => {
                let mut obj = Obj::new();
                for (key, value) in record.iter() {
                    obj.insert(key.name().into_owned(), Js::from_value(value));
                }
                Js::Obj(js_order(obj))
            }
            // A function value is the record `{lambda: {params}}` in both implementations.
            Value::Lambda(_) => value.to_json().map_or(Js::Undefined, |json| Js::from_json(&json)),
        }
    }

    /// Parsed JSON, as `JSON.parse` gives it.
    pub fn from_json(json: &Json) -> Js {
        match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Num(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Js::Str(s.clone()),
            Json::Array(items) => Js::List(items.iter().map(Js::from_json).collect()),
            Json::Object(object) => {
                Js::Obj(js_order(object.iter().map(|(key, value)| (key.clone(), Js::from_json(value))).collect()))
            }
        }
    }

    /// The value handed back to the kernel. `undefined` is dropped from an object and is `null`
    /// in a list when it is written out, as `JSON.stringify` does.
    pub fn to_value(&self) -> Value {
        match self {
            Js::Undefined => Value::Undefined,
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Num(n) => Value::from(*n),
            Js::Str(s) => Value::Str(s.clone()),
            Js::List(items) => Value::List(items.iter().map(Js::to_value).collect()),
            Js::Obj(obj) => Value::Record(
                obj.iter().map(|(key, value)| (Key::str(key.as_str()), value.to_value())).collect::<Record>(),
            ),
            Js::Opaque(value) => value.clone(),
        }
    }

    /// `obj[key]`, `undefined` for a missing key or a value that is not an object.
    pub fn get(&self, key: &str) -> &Js {
        match self {
            Js::Obj(obj) => obj.get(key).unwrap_or(&Js::Undefined),
            _ => &Js::Undefined,
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, Js::Undefined)
    }

    /// Whether JavaScript counts the value as true.
    pub fn is_truthy(&self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(b) => *b,
            Js::Num(n) => *n != 0.0 && !n.is_nan(),
            Js::Str(s) => !s.is_empty(),
            Js::List(_) | Js::Obj(_) | Js::Opaque(_) => true,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `typeof v === "object" && v !== null && !Array.isArray(v)`.
    pub fn is_record(&self) -> bool {
        matches!(self, Js::Obj(_) | Js::Opaque(_))
    }

    /// `Number.isInteger(v)`.
    pub fn is_integer(&self) -> bool {
        matches!(self, Js::Num(n) if is_integer(*n))
    }
}

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// Orders an object's keys as a JavaScript object orders them.
pub fn js_order(obj: Obj) -> Obj {
    let (mut indices, named): (Vec<_>, Vec<_>) = obj.into_iter().partition(|(key, _)| index(key).is_some());
    indices.sort_by_key(|(key, _)| index(key));
    indices.into_iter().chain(named).collect()
}

/// A key JavaScript treats as an array index.
fn index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// A number as JavaScript's `String()` writes it.
pub fn num(n: f64) -> String {
    format_number(n)
}

/// A value as JavaScript's `String()` (or a template literal) writes it.
pub fn js_string(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => num(*n),
        Js::Str(s) => s.clone(),
        Js::List(items) => items
            .iter()
            .map(|item| if matches!(item, Js::Undefined | Js::Null) { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Js::Obj(_) => "[object Object]".to_owned(),
        Js::Opaque(value) => value.display(),
    }
}

/// A string as `JSON.stringify` writes it.
pub fn quote(text: &str) -> String {
    Json::String(text.to_owned()).to_string()
}

/// A value as `JSON.stringify` writes it (`undefined` as a template literal writes it).
pub fn stringify(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) if n.is_finite() => num(*n),
        Js::Num(_) => "null".to_owned(),
        Js::Str(s) => quote(s),
        Js::List(items) => {
            let items: Vec<String> = items
                .iter()
                .map(|item| if item.is_undefined() { "null".to_owned() } else { stringify(item) })
                .collect();
            format!("[{}]", items.join(","))
        }
        Js::Obj(obj) => {
            let fields: Vec<String> = obj
                .iter()
                .filter(|(_, value)| !value.is_undefined())
                .map(|(key, value)| format!("{}:{}", quote(key), stringify(value)))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Js::Opaque(value) => value.to_json().map_or_else(|| "undefined".to_owned(), |json| json.to_string()),
    }
}

/// Names a bad value the way its author wrote it, so the message points at the mistake
/// (`showValue` in `resolve.ts`).
pub fn show_value(value: &Js) -> String {
    match value {
        Js::Str(s) => quote(s),
        Js::Null => "null".to_owned(),
        Js::List(_) => "a list".to_owned(),
        Js::Obj(_) | Js::Opaque(_) => "a record".to_owned(),
        other => js_string(other),
    }
}

/// White space as JavaScript's `\s` and `trim` see it.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// A non-empty line of text: `typeof v === "string" && !!v.trim()`.
pub fn is_text(value: &Js) -> bool {
    value.as_str().is_some_and(|s| !trim(s).is_empty())
}

/// Loosens a text match: trim, fold case, collapse white space (`normaliseText`).
pub fn normalise_text(text: &str) -> String {
    let lower = trim(text).to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_space = false;
    for c in lower.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_take_javascripts_order() {
        let Js::Obj(obj) = Js::from_json(&json!({ "b": 1, "10": 2, "01": 3, "2": 4 })) else { panic!() };
        assert_eq!(obj.keys().collect::<Vec<_>>(), ["2", "10", "b", "01"]);
    }

    #[test]
    fn values_read_as_javascript_writes_them() {
        assert_eq!(js_string(&Js::from_json(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(js_string(&Js::Num(1.5)), "1.5");
        assert_eq!(js_string(&Js::Num(-0.0)), "0");
        assert_eq!(js_string(&Js::from_json(&json!({ "a": 1 }))), "[object Object]");
        assert_eq!(show_value(&Js::Undefined), "undefined");
        assert_eq!(show_value(&Js::Str("a\"b".into())), r#""a\"b""#);
        assert_eq!(show_value(&Js::from_json(&json!([1]))), "a list");
        assert_eq!(show_value(&Js::from_json(&json!({}))), "a record");
        assert_eq!(stringify(&Js::from_json(&json!({ "a": [1, "x"], "1": null }))), r#"{"1":null,"a":[1,"x"]}"#);
    }

    #[test]
    fn text_folds_as_javascript_folds_it() {
        assert_eq!(normalise_text("  Strongly \n\t AGREE\u{a0} "), "strongly agree");
        assert_eq!(trim("\u{feff} x \u{3000}"), "x");
        assert!(!is_text(&Js::Str("  ".into())));
    }
}
