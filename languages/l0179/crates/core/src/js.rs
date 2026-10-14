// SPDX-License-Identifier: MIT

//! Values as the TypeScript compiler's handlers see them: plain JavaScript values.
//!
//! L0179's output is built by code transcribed from L0166, and its exact shape — which keys an
//! object has, in which order, and what they hold — follows from JavaScript semantics, not from
//! intent: a key holding `undefined` still has its place (and a later spread can fill it), an
//! object puts array-index keys first, `{...x}` copies a string's characters, and an array
//! written at a negative or fractional index grows a property instead of an element. [`Js`] is
//! that model, with the handful of JavaScript operations the compiler uses.
//!
//! A value crosses into it from the kernel as `toPlainObject` would leave it ([`Js::from_value`])
//! and back out as a kernel [`Value`] ([`Js::to_value`]).

use graffiticode_l0000::value::format_number;
use graffiticode_l0000::{Key, Lambda, Number, Record, Value};
use indexmap::IndexMap;

/// A JavaScript value.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Js {
    #[default]
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    /// A `Decimal`: a number literal no JavaScript number holds (`12345678901234567890`). The
    /// TypeScript sees an object, not a number.
    Dec(Number),
    Str(String),
    Arr(Arr),
    Obj(Obj),
}

/// A plain object: its own properties in insertion order. Iteration gives JavaScript's order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(IndexMap<String, Js>);

/// An array: its elements (a hole reads as `undefined`) and any non-index properties, which
/// JSON never shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Arr {
    pub items: Vec<Js>,
    pub props: Obj,
}

/// A `TypeError` the TypeScript would throw. It never answers then (the exception escapes the
/// visitor's callbacks); here it is a compile error.
#[derive(Debug, PartialEq)]
pub struct TypeError(pub String);

impl TypeError {
    pub fn null_to_object() -> Self {
        TypeError("TypeError: Cannot convert undefined or null to object".to_owned())
    }

    pub fn read(base: &Js, key: &str) -> Self {
        TypeError(format!("TypeError: Cannot read properties of {} (reading '{key}')", js_string(base)))
    }
}

/// The largest array index JavaScript has, plus one.
const MAX_INDEX: u64 = u32::MAX as u64;

/// A key JavaScript treats as an array index.
pub fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| u64::from(*n) < MAX_INDEX && n.to_string() == key)
}

impl Obj {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.0.get(key)
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    /// `obj[key] = value`: a new key goes last, an existing one keeps its place.
    pub fn set(&mut self, key: impl Into<String>, value: Js) {
        self.0.insert(key.into(), value);
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

    /// `Object.keys`: array-index keys ascending, then the rest as inserted.
    pub fn keys(&self) -> Vec<String> {
        let mut indices: Vec<(u32, &String)> =
            self.0.keys().filter_map(|key| array_index(key).map(|i| (i, key))).collect();
        indices.sort_by_key(|(i, _)| *i);
        let named = self.0.keys().filter(|key| array_index(key).is_none());
        indices.into_iter().map(|(_, key)| key).chain(named).cloned().collect()
    }

    /// `Object.entries`.
    pub fn entries(&self) -> Vec<(String, Js)> {
        self.keys().into_iter().map(|key| (key.clone(), self.0[&key].clone())).collect()
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

impl Arr {
    pub fn new(items: Vec<Js>) -> Self {
        Arr { items, props: Obj::new() }
    }

    /// `arr[key]`.
    pub fn get(&self, key: &str) -> Js {
        match array_index(key) {
            Some(i) => self.items.get(i as usize).cloned().unwrap_or_default(),
            None if key == "length" => Js::Num(self.items.len() as f64),
            None => self.props.get(key).cloned().unwrap_or_default(),
        }
    }

    /// `arr[key] = value`. An index past the end leaves holes.
    pub fn set(&mut self, key: &str, value: Js) {
        match array_index(key) {
            Some(i) => {
                let i = i as usize;
                if i >= self.items.len() {
                    self.items.resize(i + 1, Js::Undefined);
                }
                self.items[i] = value;
            }
            None => self.props.set(key, value),
        }
    }
}

impl Js {
    pub fn obj(obj: Obj) -> Js {
        Js::Obj(obj)
    }

    pub fn str(text: impl Into<String>) -> Js {
        Js::Str(text.into())
    }

    /// A kernel value as `toPlainObject` leaves it: a record becomes an object (its keys lose
    /// their kinds), a tag is `{tag}`, a function value is `{lambda: {params}}`.
    pub fn from_value(value: &Value) -> Js {
        match value {
            Value::Undefined => Js::Undefined,
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(*b),
            Value::Num(Number::Float(n)) => Js::Num(*n),
            Value::Num(n) => Js::Dec(n.clone()),
            Value::Str(s) => Js::Str(s.clone()),
            Value::Tag(name) => Js::Obj([("tag".to_owned(), Js::str(name))].into_iter().collect()),
            Value::List(items) => Js::Arr(Arr::new(items.iter().map(Js::from_value).collect())),
            Value::Record(record) => {
                Js::Obj(record.iter().map(|(key, value)| (key.name().into_owned(), Js::from_value(value))).collect())
            }
            Value::Lambda(Lambda { params, .. }) => {
                let params = Js::Arr(Arr::new(params.iter().map(Js::str).collect()));
                let lambda = Js::Obj([("params".to_owned(), params)].into_iter().collect());
                Js::Obj([("lambda".to_owned(), lambda)].into_iter().collect())
            }
        }
    }

    /// Back to a kernel value, keys in JavaScript's order so the JSON it writes is the JSON
    /// `JSON.stringify` writes. `{tag: "x"}` reads back as a tag, as it does from JSON.
    pub fn to_value(&self) -> Value {
        match self {
            Js::Undefined => Value::Undefined,
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Num(n) => Value::Num(Number::Float(*n)),
            Js::Dec(n) => Value::Num(n.clone()),
            Js::Str(s) => Value::Str(s.clone()),
            Js::Arr(arr) => Value::List(arr.items.iter().map(Js::to_value).collect()),
            Js::Obj(obj) => match (obj.len(), obj.get("tag")) {
                (1, Some(Js::Str(name))) => Value::Tag(name.clone()),
                _ => {
                    let mut record = Record::new();
                    for (key, value) in obj.entries() {
                        record.insert(Key::tag(key), value.to_value());
                    }
                    Value::Record(record)
                }
            },
        }
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, Js::Undefined | Js::Null)
    }

    /// Whether `typeof` says `"object"` (null included).
    pub fn is_object(&self) -> bool {
        matches!(self, Js::Null | Js::Dec(_) | Js::Arr(_) | Js::Obj(_))
    }

    pub fn truthy(&self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(b) => *b,
            Js::Num(n) => *n != 0.0 && !n.is_nan(),
            Js::Str(s) => !s.is_empty(),
            Js::Dec(_) | Js::Arr(_) | Js::Obj(_) => true,
        }
    }

    /// `x || y`.
    pub fn or(self, other: Js) -> Js {
        if self.truthy() { self } else { other }
    }

    /// `x?.[key]`: a missing base reads as `undefined`.
    pub fn at(&self, key: &str) -> Js {
        match self {
            Js::Obj(obj) => obj.get(key).cloned().unwrap_or_default(),
            Js::Arr(arr) => arr.get(key),
            Js::Str(s) => {
                let units: Vec<u16> = s.encode_utf16().collect();
                match array_index(key) {
                    Some(i) => units.get(i as usize).map_or(Js::Undefined, |unit| Js::Str(from_utf16(&[*unit]))),
                    None if key == "length" => Js::Num(units.len() as f64),
                    None => Js::Undefined,
                }
            }
            _ => Js::Undefined,
        }
    }

    /// `x[key]`, which throws on `null` and `undefined`.
    pub fn get(&self, key: &str) -> Result<Js, TypeError> {
        if self.is_nullish() { Err(TypeError::read(self, key)) } else { Ok(self.at(key)) }
    }

    /// `Object.keys(x)`.
    pub fn keys(&self) -> Result<Vec<String>, TypeError> {
        Ok(match self {
            Js::Undefined | Js::Null => return Err(TypeError::null_to_object()),
            Js::Obj(obj) => obj.keys(),
            Js::Arr(arr) => (0..arr.items.len()).map(|i| i.to_string()).chain(arr.props.keys()).collect(),
            Js::Str(s) => (0..s.encode_utf16().count()).map(|i| i.to_string()).collect(),
            Js::Bool(_) | Js::Num(_) | Js::Dec(_) => Vec::new(),
        })
    }

    /// The own enumerable properties `{...x}` and `Object.assign` copy, in order.
    pub fn own_entries(&self) -> Vec<(String, Js)> {
        match self {
            Js::Obj(obj) => obj.entries(),
            Js::Arr(arr) => arr
                .items
                .iter()
                .enumerate()
                .map(|(i, item)| (i.to_string(), item.clone()))
                .chain(arr.props.entries())
                .collect(),
            Js::Str(s) => {
                s.encode_utf16().enumerate().map(|(i, unit)| (i.to_string(), Js::Str(from_utf16(&[unit])))).collect()
            }
            _ => Vec::new(),
        }
    }
}

/// `{...a, ...b}`, one source at a time.
pub fn spread_into(target: &mut Obj, source: &Js) {
    for (key, value) in source.own_entries() {
        target.set(key, value);
    }
}

/// `{...x}`.
pub fn spread(source: &Js) -> Obj {
    let mut obj = Obj::new();
    spread_into(&mut obj, source);
    obj
}

/// Text from UTF-16 code units; a lone surrogate (which JSON would escape) becomes U+FFFD.
pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `s.slice(start)` and `s.slice(start, end)` in UTF-16 code units, as JavaScript counts.
pub fn slice(s: &str, start: usize, end: Option<usize>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.unwrap_or(units.len()).min(units.len());
    if start >= end { String::new() } else { from_utf16(&units[start..end]) }
}

/// A number as JavaScript's `String()` writes it.
pub fn number_string(n: f64) -> String {
    format_number(n)
}

/// `String(x)`.
pub fn js_string(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".to_owned(),
        Js::Null => "null".to_owned(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => number_string(*n),
        Js::Dec(n) => n.display(),
        Js::Str(s) => s.clone(),
        Js::Arr(arr) => join(&arr.items, ","),
        Js::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `items.join(separator)`: `null` and `undefined` are empty.
pub fn join(items: &[Js], separator: &str) -> String {
    items
        .iter()
        .map(|item| if item.is_nullish() { String::new() } else { js_string(item) })
        .collect::<Vec<_>>()
        .join(separator)
}

/// White space as JavaScript's `trim` and `Number()` see it.
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

/// `Number(x)` (and unary `+`).
pub fn to_number(value: &Js) -> f64 {
    match value {
        Js::Undefined => f64::NAN,
        Js::Null => 0.0,
        Js::Bool(b) => f64::from(u8::from(*b)),
        Js::Num(n) => *n,
        Js::Dec(n) => n.to_f64(),
        Js::Str(s) => string_to_number(s),
        Js::Arr(_) | Js::Obj(_) => string_to_number(&js_string(value)),
    }
}

/// JavaScript's StringToNumber: white space trimmed, empty is 0, `0x`/`0o`/`0b` integers,
/// `Infinity`, or a decimal literal; anything else is `NaN`.
pub fn string_to_number(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |n, c| n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)));
        }
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    let negative = s.starts_with('-');
    if unsigned == "Infinity" {
        return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    match decimal_prefix(unsigned) {
        Some(len) if len == unsigned.len() => {
            let n: f64 = unsigned.parse().unwrap_or(f64::NAN);
            if negative { -n } else { n }
        }
        _ => f64::NAN,
    }
}

/// `parseFloat(s)`: the longest decimal literal at the start, after leading white space.
pub fn parse_float(s: &str) -> f64 {
    let s = s.trim_start_matches(is_space);
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    let negative = s.starts_with('-');
    let n = if unsigned.starts_with("Infinity") {
        f64::INFINITY
    } else {
        match decimal_prefix(unsigned) {
            Some(len) => unsigned[..len].parse().unwrap_or(f64::NAN),
            None => return f64::NAN,
        }
    };
    if negative { -n } else { n }
}

/// The length of the unsigned decimal literal (`1`, `1.`, `.5`, `1.5e-3`) at the start of `s`.
fn decimal_prefix(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let int = digits(0);
    let mut at = int;
    let mut frac = 0;
    if bytes.get(at) == Some(&b'.') {
        frac = digits(at + 1);
        if int > 0 || frac > 0 {
            at += 1 + frac;
        }
    }
    if int == 0 && frac == 0 {
        return None;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(at + 1), Some(b'+' | b'-')));
        let exponent = digits(at + 1 + sign);
        if exponent > 0 {
            at += 1 + sign + exponent;
        }
    }
    Some(at)
}

/// `String.fromCharCode(x)`: ToUint16 of the number.
pub fn from_char_code(n: f64) -> String {
    let unit = if n.is_finite() { (n.trunc().rem_euclid(65536.0)) as u16 } else { 0 };
    from_utf16(&[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_take_javascripts_order() {
        let obj: Obj = ["b", "10", "a", "01", "2", "*", "1..5"].iter().map(|k| ((*k).to_owned(), Js::Null)).collect();
        assert_eq!(obj.keys(), ["2", "10", "b", "a", "01", "*", "1..5"]);
    }

    #[test]
    fn an_array_written_off_its_indices_grows_properties() {
        let mut arr = Arr::default();
        arr.set("2", Js::Num(1.0));
        arr.set("-1", Js::Num(2.0));
        arr.set("NaN", Js::Num(3.0));
        assert_eq!(arr.items, [Js::Undefined, Js::Undefined, Js::Num(1.0)]);
        assert_eq!(arr.get("NaN"), Js::Num(3.0));
        assert_eq!(Js::Arr(arr).to_value().to_json().unwrap().to_string(), "[null,null,1]");
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(string_to_number(" 12 "), 12.0);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x1F"), 31.0);
        assert!(string_to_number("1x").is_nan());
        assert!(string_to_number("-0x1").is_nan());
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert!(string_to_number(".").is_nan());
        assert_eq!(parse_float("  1.5abc"), 1.5);
        assert_eq!(parse_float("1e3x"), 1000.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(parse_float("-.5"), -0.5);
        assert!(parse_float("x1").is_nan());
        assert_eq!(parse_float("Infinityx"), f64::INFINITY);
    }

    #[test]
    fn strings_are_javascripts() {
        let list = Js::Arr(Arr::new(vec![Js::Num(1.0), Js::Null, Js::str("a")]));
        assert_eq!(js_string(&list), "1,,a");
        assert_eq!(js_string(&Js::Num(-0.0)), "0");
        assert_eq!(slice("A12", 1, None), "12");
        assert_eq!(slice("A12", 0, Some(1)), "A");
        assert_eq!(from_char_code(970.0), "\u{3ca}");
        assert_eq!(from_char_code(65536.0 + 65.0), "A");
    }

    #[test]
    fn a_spread_string_is_its_characters() {
        let obj = spread(&Js::str("ab"));
        assert_eq!(obj.entries(), [("0".to_owned(), Js::str("a")), ("1".to_owned(), Js::str("b"))]);
        assert!(spread(&Js::Num(5.0)).is_empty());
    }
}
