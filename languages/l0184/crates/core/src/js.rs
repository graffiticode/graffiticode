// SPDX-License-Identifier: MIT

//! Values as the TypeScript compiler sees them once `toPlainObject` has unwrapped L0000's
//! records: plain JavaScript values, `undefined` and non-finite numbers included, with an
//! object's keys in the order a JavaScript object keeps them (array-index keys first,
//! ascending, then the rest as inserted). A tag is `{tag: "NAME"}`, as it reaches a TypeScript
//! handler. The readings here (`String()`, `JSON.stringify`, `trim`, truthiness) are the
//! JavaScript ones the TypeScript's messages and output were written against.

use graffiticode_l0000::value::format_number;
use graffiticode_l0000::{Key, Record, Value};
use indexmap::IndexMap;

pub type Obj = IndexMap<String, Js>;

#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
}

impl Js {
    pub fn str(s: impl Into<String>) -> Self {
        Js::Str(s.into())
    }

    /// A runtime value as `toPlainObject` hands it to a TypeScript handler.
    pub fn from_value(value: &Value) -> Self {
        match value {
            Value::Undefined => Js::Undefined,
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(*b),
            Value::Num(n) => Js::Num(n.to_f64()),
            Value::Str(s) => Js::Str(s.clone()),
            Value::Tag(name) => Js::Obj(Obj::from([("tag".to_owned(), Js::Str(name.clone()))])),
            Value::List(items) => Js::Arr(items.iter().map(Js::from_value).collect()),
            Value::Record(record) => {
                let mut object = Obj::new();
                for (key, value) in record.iter() {
                    // A later key of the same name replaces the earlier one in its place.
                    object.insert(key.name().into_owned(), Js::from_value(value));
                }
                Js::Obj(js_order(object))
            }
            Value::Lambda(lambda) => Js::Obj(Obj::from([(
                "lambda".to_owned(),
                Js::Obj(Obj::from([(
                    "params".to_owned(),
                    Js::Arr(lambda.params.iter().map(|p| Js::Str(p.clone())).collect()),
                )])),
            )])),
        }
    }

    /// The runtime value a handler returns: an object becomes a record with tag keys.
    pub fn to_value(&self) -> Value {
        match self {
            Js::Undefined => Value::Undefined,
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Num(n) => Value::from(*n),
            Js::Str(s) => Value::Str(s.clone()),
            Js::Arr(items) => Value::List(items.iter().map(Js::to_value).collect()),
            Js::Obj(object) => {
                Value::Record(object.iter().map(|(k, v)| (Key::tag(k.as_str()), v.to_value())).collect::<Record>())
            }
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, Js::Undefined)
    }

    /// `undefined` or `null`: what `??` replaces.
    pub fn is_nullish(&self) -> bool {
        matches!(self, Js::Undefined | Js::Null)
    }

    /// `v ?? other`.
    pub fn or(&self, other: Js) -> Js {
        if self.is_nullish() { other } else { self.clone() }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(b) => *b,
            Js::Num(n) => *n != 0.0 && !n.is_nan(),
            Js::Str(s) => !s.is_empty(),
            Js::Arr(_) | Js::Obj(_) => true,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            Js::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&Vec<Js>> {
        match self {
            Js::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            Js::Obj(object) => Some(object),
            _ => None,
        }
    }

    /// `v.key` on a value known not to be `null` or `undefined` (anything else reads as
    /// `undefined`).
    pub fn get(&self, key: &str) -> &Js {
        const UNDEFINED: &Js = &Js::Undefined;
        match self {
            Js::Obj(object) => object.get(key).unwrap_or(UNDEFINED),
            Js::Arr(items) => index(key).and_then(|i| items.get(i)).unwrap_or(UNDEFINED),
            _ => UNDEFINED,
        }
    }

    /// `v.key`, failing as JavaScript does on `null` and `undefined`.
    pub fn prop(&self, key: &str) -> Result<&Js, String> {
        match self {
            Js::Undefined | Js::Null => Err(format!("Cannot read properties of {} (reading '{key}')", js_string(self))),
            other => Ok(other.get(key)),
        }
    }

    /// `Object.prototype.hasOwnProperty.call(v, key)` for an object.
    pub fn has(&self, key: &str) -> bool {
        match self {
            Js::Obj(object) => object.contains_key(key),
            _ => false,
        }
    }
}

/// `typeof v === "object" && v !== null && !Array.isArray(v) && typeof v.tag === "string"`.
pub fn is_tag(v: &Js) -> bool {
    matches!(v, Js::Obj(object) if matches!(object.get("tag"), Some(Js::Str(_))))
}

/// A record in the TypeScript's sense: an object that is not a list and not a tag.
pub fn is_record(v: &Js) -> bool {
    matches!(v, Js::Obj(_)) && !is_tag(v)
}

/// `Object.keys(v)`.
pub fn keys(v: &Js) -> Vec<String> {
    match v {
        Js::Obj(object) => object.keys().cloned().collect(),
        Js::Arr(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        Js::Str(s) => (0..s.encode_utf16().count()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// A key JavaScript treats as an array index.
fn index(key: &str) -> Option<usize> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key).map(|n| n as usize)
}

/// Orders an object's keys as a JavaScript object orders them.
pub fn js_order(object: Obj) -> Obj {
    if !object.keys().any(|k| index(k).is_some()) {
        return object;
    }
    let (mut indices, named): (Vec<_>, Vec<_>) = object.into_iter().partition(|(key, _)| index(key).is_some());
    indices.sort_by_key(|(key, _)| index(key));
    indices.into_iter().chain(named).collect()
}

/// A number as JavaScript's `String()` writes it.
pub fn num(n: f64) -> String {
    format_number(n)
}

/// A value as JavaScript's `String()` writes it.
pub fn js_string(v: &Js) -> String {
    match v {
        Js::Undefined => "undefined".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => num(*n),
        Js::Str(s) => s.clone(),
        Js::Arr(items) => items
            .iter()
            .map(|item| if item.is_nullish() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Js::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `JSON.stringify(v)`; `undefined` at the top level has no JSON text and gives `undefined`,
/// as a template literal would write it.
pub fn stringify(v: &Js) -> String {
    match v {
        Js::Undefined => "undefined".to_owned(),
        other => json_text(other),
    }
}

fn json_text(v: &Js) -> String {
    match v {
        Js::Undefined | Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) if n.is_finite() => num(*n),
        Js::Num(_) => "null".to_owned(),
        Js::Str(s) => quote(s),
        Js::Arr(items) => format!("[{}]", items.iter().map(json_text).collect::<Vec<_>>().join(",")),
        Js::Obj(object) => format!(
            "{{{}}}",
            object
                .iter()
                .filter(|(_, v)| !v.is_undefined())
                .map(|(k, v)| format!("{}:{}", quote(k), json_text(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// `JSON.stringify` of a string.
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string serializes")
}

/// White space as JavaScript's `\s` and `trim` see it.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `a === b`. Objects and lists are never the same object here: each was built on its own.
pub fn strict_eq(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Undefined, Js::Undefined) | (Js::Null, Js::Null) => true,
        (Js::Bool(a), Js::Bool(b)) => a == b,
        (Js::Num(a), Js::Num(b)) => a == b,
        (Js::Str(a), Js::Str(b)) => a == b,
        _ => false,
    }
}

/// Builds an object from `key => value` pairs, in order.
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut object = $crate::js::Obj::new();
        $(object.insert(String::from($key), $crate::js::Js::from($value));)*
        object
    }};
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

impl From<&String> for Js {
    fn from(s: &String) -> Self {
        Js::Str(s.clone())
    }
}

impl From<f64> for Js {
    fn from(n: f64) -> Self {
        Js::Num(n)
    }
}

impl From<usize> for Js {
    fn from(n: usize) -> Self {
        Js::Num(n as f64)
    }
}

impl From<bool> for Js {
    fn from(b: bool) -> Self {
        Js::Bool(b)
    }
}

impl From<Obj> for Js {
    fn from(object: Obj) -> Self {
        Js::Obj(object)
    }
}

impl From<Vec<Js>> for Js {
    fn from(items: Vec<Js>) -> Self {
        Js::Arr(items)
    }
}

impl From<&Js> for Js {
    fn from(v: &Js) -> Self {
        v.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_take_javascripts_order() {
        let object: Obj = [("b", 1.0), ("10", 2.0), ("01", 3.0), ("2", 4.0)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Js::Num(v)))
            .collect();
        assert_eq!(js_order(object).keys().cloned().collect::<Vec<_>>(), ["2", "10", "b", "01"]);
    }

    #[test]
    fn strings_are_javascripts() {
        let list = Js::Arr(vec![Js::Num(1.0), Js::Null, Js::str("a"), Js::Arr(vec![Js::Num(2.0), Js::Num(3.0)])]);
        assert_eq!(js_string(&list), "1,,a,2,3");
        assert_eq!(js_string(&Js::Num(2.5)), "2.5");
        assert_eq!(js_string(&Js::Obj(Obj::new())), "[object Object]");
        assert_eq!(stringify(&Js::str("a\"b\n")), r#""a\"b\n""#);
        assert_eq!(stringify(&Js::Num(f64::INFINITY)), "null");
        assert_eq!(trim("\u{a0} x \u{feff}"), "x");
    }

    #[test]
    fn reading_a_property_of_nothing_fails_as_javascript_does() {
        assert_eq!(Js::Null.prop("id"), Err("Cannot read properties of null (reading 'id')".to_owned()));
        assert_eq!(Js::Num(5.0).prop("id"), Ok(&Js::Undefined));
    }
}
