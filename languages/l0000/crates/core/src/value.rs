// SPDX-License-Identifier: MIT

//! Runtime values.
//!
//! A record's keys keep the kind they were written with (`{x: 1}`, `{"x": 1}` and `{0: 1}` are
//! three different keys), which is why a record is not simply a JSON object. JSON objects
//! arriving from upstream become records with tag keys; the kind is dropped again on output.

use indexmap::IndexMap;
use serde_json::Value as Json;

use crate::number::Number;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// The result of a lookup that found nothing. It is omitted from records on output and is
    /// `null` inside a list.
    Undefined,
    Null,
    Bool(bool),
    Num(Number),
    Str(String),
    /// A symbolic constant, `tag red`.
    Tag(String),
    List(Vec<Value>),
    Record(Record),
    /// A function that has not been applied to all of its arguments. It names the parameters
    /// still unbound; functions are applied where they are written, so it carries no body.
    Lambda(Lambda),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Lambda {
    pub params: Vec<String>,
}

/// A record key and the kind it was written with.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Tag(String),
    Str(String),
    Num(NumKey),
}

/// A number usable as a map key: compared by value, with `-0` and `0` the same key.
#[derive(Clone, Debug)]
pub struct NumKey(Number);

impl NumKey {
    pub fn new(n: Number) -> Self {
        // `-0` and `0` are equal, and are one key.
        Self(if n == Number::Float(0.0) { Number::Float(0.0) } else { n })
    }

    pub fn get(&self) -> &Number {
        &self.0
    }
}

impl PartialEq for NumKey {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            // By bits, so that a NaN key is equal to itself.
            (Number::Float(a), Number::Float(b)) => a.to_bits() == b.to_bits(),
            (a, b) => a == b,
        }
    }
}

impl Eq for NumKey {}

impl std::hash::Hash for NumKey {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match &self.0 {
            Number::Float(n) => n.to_bits().hash(state),
            Number::Exact(d) => d.hash(state),
        }
    }
}

impl Key {
    pub fn tag(name: impl Into<String>) -> Self {
        Key::Tag(name.into())
    }

    pub fn str(name: impl Into<String>) -> Self {
        Key::Str(name.into())
    }

    pub fn num(n: impl Into<Number>) -> Self {
        Key::Num(NumKey::new(n.into()))
    }

    /// The key a runtime value denotes: a tag, string or number is a key of its own kind, and
    /// anything else is a tag key named by its display text.
    pub fn of(value: &Value) -> Self {
        match value {
            Value::Tag(name) => Key::tag(name),
            Value::Str(s) => Key::str(s),
            Value::Num(n) => Key::num(n.clone()),
            other => Key::tag(other.display()),
        }
    }

    /// The key as it appears in JSON output, where the kind is not kept.
    pub fn name(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Key::Tag(name) | Key::Str(name) => name.into(),
            Key::Num(n) => n.get().display().into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Record {
    entries: IndexMap<Key, Value>,
}

impl Record {
    pub fn new() -> Self {
        Self::default()
    }

    /// Looks a key up by its exact kind first. A tag key then falls back to the string key of
    /// the same name, and a string key to the tag; a number key never falls back.
    pub fn get(&self, key: &Key) -> Option<&Value> {
        self.entries.get(key).or_else(|| match key {
            Key::Tag(name) => self.entries.get(&Key::str(name.as_str())),
            Key::Str(name) => self.entries.get(&Key::tag(name.as_str())),
            Key::Num(_) => None,
        })
    }

    /// Sets a key, keeping its position if it is already present.
    pub fn insert(&mut self, key: Key, value: Value) {
        self.entries.insert(key, value);
    }

    /// Removes a key of exactly this kind, keeping the order of the rest.
    pub fn remove(&mut self, key: &Key) -> Option<Value> {
        self.entries.shift_remove(key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Key, &Value)> {
        self.entries.iter()
    }
}

impl FromIterator<(Key, Value)> for Record {
    fn from_iter<I: IntoIterator<Item = (Key, Value)>>(iter: I) -> Self {
        Self { entries: iter.into_iter().collect() }
    }
}

impl Extend<(Key, Value)> for Record {
    fn extend<I: IntoIterator<Item = (Key, Value)>>(&mut self, iter: I) {
        self.entries.extend(iter);
    }
}

impl IntoIterator for Record {
    type Item = (Key, Value);
    type IntoIter = indexmap::map::IntoIter<Key, Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl Value {
    /// Whether the value counts as true in `if`, `filter`, `and`, `or` and `not`: everything
    /// except `false`, `0`, `NaN`, `""`, `null` and a missing value.
    pub fn is_truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(Number::Float(n)) => *n != 0.0 && !n.is_nan(),
            Value::Num(Number::Exact(_)) => true,
            Value::Str(s) => !s.is_empty(),
            Value::Tag(_) | Value::List(_) | Value::Record(_) | Value::Lambda(_) => true,
        }
    }

    /// The kind of value, phrased for an error message ("expected a list, got a number").
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Undefined => "undefined",
            Value::Null => "null",
            Value::Bool(_) => "a boolean",
            Value::Num(_) => "a number",
            Value::Str(_) => "a string",
            Value::Tag(_) => "a tag",
            Value::List(_) => "a list",
            Value::Record(_) => "a record",
            Value::Lambda(_) => "a function",
        }
    }

    /// The display text of a value (`str`). At the top level a string is itself and a tag is
    /// its name, so text reads naturally in templates. Inside a list or record every value
    /// renders as Graffiticode source — strings quoted, tags as `tag red` — so the aggregate
    /// reads as code.
    pub fn display(&self) -> String {
        let mut out = String::new();
        self.write_display(&mut out, false);
        out
    }

    /// The value as Graffiticode source: a string quoted, a tag as `tag red`.
    pub fn display_source(&self) -> String {
        let mut out = String::new();
        self.write_display(&mut out, true);
        out
    }

    fn write_display(&self, out: &mut String, nested: bool) {
        match self {
            Value::Undefined | Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Num(n) => out.push_str(&n.display()),
            Value::Str(s) if nested => out.push_str(&quote(s)),
            Value::Str(s) => out.push_str(s),
            Value::Tag(name) => {
                if nested {
                    out.push_str("tag ");
                }
                out.push_str(name);
            }
            Value::List(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(' ');
                    }
                    item.write_display(out, true);
                }
                out.push(']');
            }
            Value::Record(record) => {
                out.push('{');
                for (i, (key, value)) in record.iter().enumerate() {
                    if i > 0 {
                        out.push(' ');
                    }
                    match key {
                        Key::Tag(name) if is_identifier(name) => out.push_str(name),
                        Key::Tag(name) | Key::Str(name) => out.push_str(&quote(name)),
                        Key::Num(n) => out.push_str(&n.get().display()),
                    }
                    out.push_str(": ");
                    value.write_display(out, true);
                }
                out.push('}');
            }
            Value::Lambda(lambda) => {
                out.push('<');
                out.push_str(&lambda.params.join(" "));
                out.push('>');
            }
        }
    }

    /// The JSON form of a value, or `None` for a missing value. Records lose their key kinds;
    /// when two keys share a name, the later one wins.
    pub fn to_json(&self) -> Option<Json> {
        Some(match self {
            Value::Undefined => return None,
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Num(n) => number_to_json(n.to_f64()),
            Value::Str(s) => Json::String(s.clone()),
            Value::Tag(name) => serde_json::json!({ "tag": name }),
            Value::List(items) => Json::Array(items.iter().map(|item| item.to_json().unwrap_or(Json::Null)).collect()),
            Value::Record(record) => {
                let mut object = serde_json::Map::new();
                for (key, value) in record.iter() {
                    if let Some(value) = value.to_json() {
                        object.insert(key.name().into_owned(), value);
                    }
                }
                Json::Object(object)
            }
            Value::Lambda(lambda) => serde_json::json!({ "lambda": { "params": lambda.params } }),
        })
    }

    /// Reads a JSON value. An object becomes a record with tag keys, except `{"tag": "red"}`,
    /// which is how a tag is written on the wire and reads back as one.
    pub fn from_json(json: &Json) -> Self {
        match json {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::from(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Value::Str(s.clone()),
            Json::Array(items) => Value::List(items.iter().map(Value::from_json).collect()),
            Json::Object(object) => match (object.len(), object.get("tag")) {
                (1, Some(Json::String(name))) => Value::Tag(name.clone()),
                _ => Value::Record(
                    object.iter().map(|(key, value)| (Key::tag(key.as_str()), Value::from_json(value))).collect(),
                ),
            },
        }
    }
}

impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Num(Number::Float(n))
    }
}

impl From<Number> for Value {
    fn from(n: Number) -> Self {
        Value::Num(n)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_owned())
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Self {
        Value::List(items)
    }
}

impl From<Record> for Value {
    fn from(record: Record) -> Self {
        Value::Record(record)
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn quote(s: &str) -> String {
    Json::String(s.to_owned()).to_string()
}

/// Formats a number the way every other Graffiticode component does (the ECMAScript
/// `Number::toString`): shortest digits that round-trip, positional between `1e-6` and `1e21`,
/// exponential outside.
pub fn format_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if n == 0.0 {
        return "0".to_owned();
    }
    if (1e-6..1e21).contains(&n.abs()) {
        return n.to_string();
    }
    let exponential = format!("{n:e}");
    match exponential.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => format!("{mantissa}e+{exponent}"),
        _ => exponential,
    }
}

/// A number as a JSON value: an integer when it is one that an `f64` holds exactly, so it is
/// written without a fraction; otherwise the `f64`. A non-finite number has no JSON form and
/// becomes `null`. How it is written as text is [`json_text`]'s business.
fn number_to_json(n: f64) -> Json {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
        Json::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number)
    }
}

/// Writes floating-point numbers as `JSON.stringify` does, through [`format_number`]:
/// `12345678901234567000` and `100000000000000000000`, not `1.2345678901234567e19` and `1e20`;
/// `1e+21` and `1e-7` beyond the positional range. Integers and everything else are written as
/// `serde_json` writes them.
struct JsNumbers;

impl serde_json::ser::Formatter for JsNumbers {
    fn write_f64<W: ?Sized + std::io::Write>(&mut self, writer: &mut W, value: f64) -> std::io::Result<()> {
        writer.write_all(format_number(value).as_bytes())
    }

    fn write_f32<W: ?Sized + std::io::Write>(&mut self, writer: &mut W, value: f32) -> std::io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }
}

/// JSON as text, written the way every other Graffiticode component writes it: like
/// `serde_json::to_string`, except that every number is written as `JSON.stringify` writes it.
/// The language servers answer with this, and the conformance tests compare it.
///
/// The kernel does not turn on `serde_json`'s `arbitrary_precision` to get the same result: the
/// feature reaches every crate in a language's build, and it breaks `chromiumoxide`'s reading
/// of Chrome's replies (`languages/l0013`'s capture hangs).
pub fn json_text(json: &Json) -> String {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsNumbers);
    serde::Serialize::serialize(json, &mut serializer).expect("JSON serializes to memory");
    String::from_utf8(out).expect("JSON text is UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_as_json_stringify_writes_them() {
        let text = |n: f64| json_text(&number_to_json(n));
        for (n, js) in [
            (3.0, "3"),
            (-0.0, "0"),
            (0.1 + 0.2, "0.30000000000000004"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (12_345_678_901_234_567_890.0, "12345678901234567000"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.2345678901234568e21, "1.2345678901234568e+21"),
            (1e-7, "1e-7"),
            (-2.5e-7, "-2.5e-7"),
            (123.456, "123.456"),
        ] {
            assert_eq!(text(n), js, "{n:e}");
        }
        assert_eq!(number_to_json(f64::NAN), Json::Null);
        assert_eq!(number_to_json(f64::INFINITY), Json::Null);
        // Inside a document, and a float written as an integer.
        let doc = serde_json::json!({ "a": [1e20, 2.0, "x"], "b": { "c": 0.5 } });
        assert_eq!(json_text(&doc), r#"{"a":[100000000000000000000,2,"x"],"b":{"c":0.5}}"#);
    }

    #[test]
    fn numbers_format_like_ecmascript() {
        for (n, text) in [
            (3.0, "3"),
            (-0.5, "-0.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (-0.0, "0"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(format_number(n), text);
        }
    }

    #[test]
    fn record_lookup_falls_back_across_tag_and_string_only() {
        let record: Record =
            [(Key::tag("x"), Value::from(2.0)), (Key::str("y"), Value::from(3.0)), (Key::num(0.0), Value::from(4.0))]
                .into_iter()
                .collect();
        assert_eq!(record.get(&Key::str("x")), Some(&Value::from(2.0)));
        assert_eq!(record.get(&Key::tag("y")), Some(&Value::from(3.0)));
        assert_eq!(record.get(&Key::num(0.0)), Some(&Value::from(4.0)));
        assert_eq!(record.get(&Key::str("0")), None);
    }

    #[test]
    fn json_round_trip_keeps_tags_and_drops_missing_values() {
        let json = serde_json::json!({ "kind": { "tag": "circle" }, "r": 3, "pts": [1.5, null] });
        let value = Value::from_json(&json);
        assert_eq!(value.to_json(), Some(json));

        let record: Record = [(Key::tag("a"), Value::Undefined), (Key::tag("b"), Value::List(vec![Value::Undefined]))]
            .into_iter()
            .collect();
        assert_eq!(Value::Record(record).to_json(), Some(serde_json::json!({ "b": [null] })));
        assert_eq!(Value::from(f64::INFINITY).to_json(), Some(Json::Null));
    }
}
