// SPDX-License-Identifier: MIT

//! Values as the plain JavaScript objects the TypeScript L0186 works on, and the JavaScript
//! readings of them its messages and output were written against.
//!
//! The TypeScript unwraps every value it is handed to plain JavaScript (`toPlainObject`) and
//! builds plain objects. [`Plain`] is that model: unlike JSON it keeps `undefined` (a record
//! field given nothing still has its key) and non-finite numbers (`div 1 0` is `Infinity` in a
//! message). An object's keys keep the order a JavaScript object gives them — array-index keys
//! first, ascending, then the rest as inserted.

use graffiticode_l0000::{Key, Lambda, Number, Record, Value};
use indexmap::IndexMap;

pub type Object = IndexMap<String, Plain>;

#[derive(Clone, Debug, PartialEq)]
pub enum Plain {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    /// A number literal no `f64` holds exactly: a decimal.js object in the TypeScript, which
    /// L0186's checks see as a record. Its fields are never read; only its keys are seen.
    Decimal(Number),
    Str(String),
    List(Vec<Plain>),
    Object(Object),
}

pub static UNDEFINED: Plain = Plain::Undefined;

impl Plain {
    /// A kernel value as `toPlainObject` leaves it: a tag is `{tag}`, a function value
    /// `{lambda: {params}}`, a record a plain object (an assignment to `__proto__` sets no key).
    pub fn from_value(value: &Value) -> Plain {
        match value {
            Value::Undefined => Plain::Undefined,
            Value::Null => Plain::Null,
            Value::Bool(flag) => Plain::Bool(*flag),
            Value::Num(n @ Number::Exact(_)) => Plain::Decimal(n.clone()),
            Value::Num(n) => Plain::Num(n.to_f64()),
            Value::Str(text) => Plain::Str(text.clone()),
            Value::Tag(name) => object([("tag", Plain::Str(name.clone()))]),
            Value::List(items) => Plain::List(items.iter().map(Plain::from_value).collect()),
            Value::Record(record) => {
                let mut out = Object::new();
                for (key, value) in record.iter() {
                    let name = key.name();
                    if name != "__proto__" {
                        out.insert(name.into_owned(), Plain::from_value(value));
                    }
                }
                Plain::Object(js_order(out))
            }
            Value::Lambda(Lambda { params }) => object([(
                "lambda",
                object([("params", Plain::List(params.iter().map(|p| Plain::Str(p.clone())).collect()))]),
            )]),
        }
    }

    /// Back to a kernel value. `{tag: name}` reads back as a tag, as JSON from upstream does.
    pub fn to_value(&self) -> Value {
        match self {
            Plain::Undefined => Value::Undefined,
            Plain::Null => Value::Null,
            Plain::Bool(flag) => Value::Bool(*flag),
            Plain::Num(n) => Value::Num(Number::Float(*n)),
            Plain::Decimal(n) => Value::Num(n.clone()),
            Plain::Str(text) => Value::Str(text.clone()),
            Plain::List(items) => Value::List(items.iter().map(Plain::to_value).collect()),
            Plain::Object(object) => match (object.len(), object.get("tag")) {
                (1, Some(Plain::Str(name))) => Value::Tag(name.clone()),
                _ => Value::Record(
                    object.iter().map(|(key, value)| (Key::tag(key.as_str()), value.to_value())).collect::<Record>(),
                ),
            },
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Plain::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Plain::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, Plain::Undefined)
    }

    /// `null` or `undefined`: what `??` and `!= null` test for.
    pub fn is_nullish(&self) -> bool {
        matches!(self, Plain::Undefined | Plain::Null)
    }

    /// A finite number (`Number.isFinite`).
    pub fn finite(&self) -> Option<f64> {
        match self {
            Plain::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// `v.prop`: a property read, which throws on `null` and `undefined`. Nothing else has the
    /// properties L0186 reads.
    pub fn get(&self, key: &str) -> Result<&Plain, String> {
        match self {
            Plain::Undefined | Plain::Null => {
                Err(format!("Cannot read properties of {} (reading '{key}')", js_string(self)))
            }
            Plain::Object(object) => Ok(object.get(key).unwrap_or(&UNDEFINED)),
            _ => Ok(&UNDEFINED),
        }
    }

    /// `Object.keys(v)`, which throws on `null` and `undefined`.
    pub fn keys(&self) -> Result<Vec<String>, String> {
        match self {
            Plain::Undefined | Plain::Null => Err("Cannot convert undefined or null to object".to_owned()),
            _ => Ok(entries(self).into_iter().map(|(key, _)| key).collect()),
        }
    }
}

/// An object from its entries, in JavaScript's key order.
pub fn object<K: Into<String>>(entries: impl IntoIterator<Item = (K, Plain)>) -> Plain {
    Plain::Object(js_order(entries.into_iter().map(|(key, value)| (key.into(), value)).collect()))
}

/// A value's own enumerable entries, as `Object.entries` and a `...spread` give them: a
/// string's are its UTF-16 code units, a list's its items.
pub fn entries(value: &Plain) -> Vec<(String, Plain)> {
    match value {
        Plain::Object(object) => object.iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Plain::List(items) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        // A decimal.js instance's own enumerable keys.
        Plain::Decimal(_) => ["constructor", "s", "e", "d"].map(|key| (key.to_owned(), Plain::Undefined)).to_vec(),
        Plain::Str(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Plain::Str(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Vec::new(),
    }
}

/// Orders an object's keys as a JavaScript object orders them.
pub fn js_order(object: Object) -> Object {
    if !object.keys().any(|key| index(key).is_some()) {
        return object;
    }
    let (mut indices, named): (Vec<_>, Vec<_>) = object.into_iter().partition(|(key, _)| index(key).is_some());
    indices.sort_by_key(|(key, _)| index(key));
    indices.into_iter().chain(named).collect()
}

/// A key JavaScript treats as an array index.
fn index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// A number as JavaScript writes it.
pub fn js_number(n: f64) -> String {
    Number::Float(n).display()
}

/// A value as JavaScript's `String()` (and a template literal) writes it.
pub fn js_string(value: &Plain) -> String {
    match value {
        Plain::Undefined => "undefined".to_owned(),
        Plain::Null => "null".to_owned(),
        Plain::Bool(flag) => flag.to_string(),
        Plain::Num(n) => js_number(*n),
        Plain::Decimal(n) => n.display(),
        Plain::Str(text) => text.clone(),
        Plain::List(items) => {
            let items: Vec<String> =
                items.iter().map(|item| if item.is_nullish() { String::new() } else { js_string(item) }).collect();
            items.join(",")
        }
        Plain::Object(_) => "[object Object]".to_owned(),
    }
}

/// A value as `JSON.stringify` writes it — `undefined` for a missing value, as a template
/// literal shows what `JSON.stringify` returns for one.
pub fn stringify(value: &Plain) -> String {
    match value {
        Plain::Undefined => "undefined".to_owned(),
        Plain::Null => "null".to_owned(),
        Plain::Bool(flag) => flag.to_string(),
        Plain::Num(n) if n.is_finite() => js_number(*n),
        Plain::Num(_) => "null".to_owned(),
        // decimal.js's `toJSON` is its string.
        Plain::Decimal(n) => quote(&n.display()),
        Plain::Str(text) => quote(text),
        Plain::List(items) => {
            let items: Vec<String> = items
                .iter()
                .map(|item| if item.is_undefined() { "null".to_owned() } else { stringify(item) })
                .collect();
            format!("[{}]", items.join(","))
        }
        Plain::Object(object) => {
            let fields: Vec<String> = object
                .iter()
                .filter(|(_, value)| !value.is_undefined())
                .map(|(key, value)| format!("{}:{}", quote(key), stringify(value)))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
    }
}

/// A string as `JSON.stringify` quotes it.
pub fn quote(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

/// Whether a value is truthy in JavaScript.
pub fn truthy(value: &Plain) -> bool {
    match value {
        Plain::Undefined | Plain::Null => false,
        Plain::Bool(flag) => *flag,
        Plain::Num(n) => *n != 0.0 && !n.is_nan(),
        Plain::Str(text) => !text.is_empty(),
        Plain::List(_) | Plain::Object(_) | Plain::Decimal(_) => true,
    }
}

/// `Math.round`: halves round up, toward +∞.
pub fn js_round(n: f64) -> f64 {
    let floor = n.floor();
    if n - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// White space as JavaScript's `trim` sees it.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_take_javascripts_order() {
        let ordered =
            object([("b", Plain::Num(1.0)), ("10", Plain::Num(2.0)), ("01", Plain::Num(3.0)), ("2", Plain::Num(4.0))]);
        assert_eq!(stringify(&ordered), r#"{"2":4,"10":2,"b":1,"01":3}"#);
    }

    #[test]
    fn strings_are_javascripts() {
        let list = Plain::List(vec![Plain::Num(1.0), Plain::Null, Plain::Str("a".into()), Plain::Undefined]);
        assert_eq!(js_string(&list), "1,,a,");
        assert_eq!(stringify(&list), r#"[1,null,"a",null]"#);
        assert_eq!(js_string(&Plain::Num(f64::INFINITY)), "Infinity");
        assert_eq!(stringify(&Plain::Num(f64::NAN)), "null");
        assert_eq!(js_string(&Plain::Num(1e21)), "1e+21");
        assert_eq!(js_string(&object([("a", Plain::Num(1.0))])), "[object Object]");
        assert_eq!(stringify(&object([("a", Plain::Undefined), ("b", Plain::Bool(true))])), r#"{"b":true}"#);
    }

    #[test]
    fn rounding_is_math_round() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(14.499999999999998), 14.0);
    }

    #[test]
    fn property_reads_throw_on_nothing() {
        assert_eq!(Plain::Null.get("id").unwrap_err(), "Cannot read properties of null (reading 'id')");
        assert_eq!(Plain::Undefined.get("name").unwrap_err(), "Cannot read properties of undefined (reading 'name')");
        assert_eq!(Plain::Num(5.0).get("id"), Ok(&Plain::Undefined));
        assert_eq!(Plain::Str("ab".into()).keys().unwrap(), ["0", "1"]);
        assert!(Plain::Null.keys().is_err());
    }
}
