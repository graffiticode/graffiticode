// SPDX-License-Identifier: MIT

//! L0174 — the forms language. It inherits the base language and adds a vocabulary for
//! describing a form.
//!
//! A form is a flat chain of two-argument words ending in `{}`: each takes a value and the
//! rest of the chain, and returns the rest with one more field. `fields` wraps a list of
//! field elements (`text`, `email`, `select`, …), each built the same way from attribute words:
//!
//! ```text
//! title 'Get in touch'
//! theme LIGHT
//! fields [
//!   text  label 'Name'  required true {},
//!   email label 'Email' required true {}
//! ]
//! submit 'Send' {}..
//! ```
//!
//! compiles to `{ title, theme, fields: [{ type, name, label, required }, …], submit }`.
//!
//! `min` and `max` are field-range attributes here, not the base language's arithmetic: this
//! dialect deliberately overrides those two words.

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Dialect, Evaluator, Key, Lexicon, NodeId, Op, Record, Value};

/// The words L0174 adds to, or redefines in, the base lexicon. Generated from the TypeScript
/// package by `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

/// The base words this dialect replaces: in a forms language they bound a field's value.
const OVERRIDES: [&str; 2] = ["min", "max"];

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &OVERRIDES, Some("L0174")).expect("L0174 overrides exactly min and max")
});

/// L0174's vocabulary: the base lexicon with the forms words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The field each attribute or top-level word sets, by node tag.
const ATTRIBUTES: [(&str, &str); 13] = [
    ("LABEL", "label"),
    ("NAME", "name"),
    ("PLACEHOLDER", "placeholder"),
    ("HELP", "help"),
    ("REQUIRED", "required"),
    ("MIN", "min"),
    ("MAX", "max"),
    ("MINLENGTH", "minLength"),
    ("MAXLENGTH", "maxLength"),
    ("PATTERN", "pattern"),
    ("OPTIONS", "options"),
    ("TITLE", "title"),
    ("METADATA", "metadata"),
];

/// The field type each element word stamps, by node tag.
const ELEMENTS: [(&str, &str); 10] = [
    ("TEXT", "text"),
    ("EMAIL", "email"),
    ("NUMBER", "number"),
    ("TEL", "tel"),
    ("URL", "url"),
    ("TEXTAREA", "textarea"),
    ("SELECT", "select"),
    ("RADIO", "radio"),
    ("CHECKBOX", "checkbox"),
    ("DATE", "date"),
];

#[derive(Clone, Copy, Debug, Default)]
pub struct L0174;

#[async_trait]
impl Dialect for L0174 {
    fn lang_id(&self) -> &str {
        "0174"
    }

    fn overrides(&self, op: &Op) -> bool {
        matches!(op, Op::Prog | Op::Min | Op::Max)
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if let Some((_, field)) = ATTRIBUTES.iter().find(|(word, _)| *word == tag) {
            let value = cx.eval_arg(id, elts, 0).await;
            let rest = cx.eval_arg(id, elts, 1).await;
            return Some(with(rest, field, value));
        }
        if let Some((_, kind)) = ELEMENTS.iter().find(|(word, _)| *word == tag) {
            return Some(element(cx, id, kind, elts).await);
        }
        Some(match tag {
            // The program's result is the form definition, with the form's posted state (the
            // upstream data) laid over it. Anything that is not a record passes through.
            "PROG" => match fields(cx.eval_kernel(id).await) {
                Ok(mut form) => {
                    if let Value::Record(data) = cx.data() {
                        form.extend(data.iter().map(|(key, value)| (key.clone(), value.clone())));
                    }
                    Value::Record(form)
                }
                Err(value) => value,
            },
            "FIELDS" => {
                let list = match cx.eval_arg(id, elts, 0).await {
                    Value::List(list) => list,
                    Value::Undefined | Value::Null => Vec::new(),
                    one => vec![one],
                };
                let rest = cx.eval_arg(id, elts, 1).await;
                with(rest, "fields", Value::List(list))
            }
            // A bare string is the button's label; a record passes through.
            "SUBMIT" => {
                let submit = match cx.eval_arg(id, elts, 0).await {
                    Value::Str(label) => [(Key::tag("label"), Value::Str(label))].into_iter().collect(),
                    other => plain(other),
                };
                let rest = cx.eval_arg(id, elts, 1).await;
                with(rest, "submit", Value::Record(submit))
            }
            "THEME" => {
                let theme = cx.eval_arg(id, elts, 0).await;
                let rest = cx.eval_arg(id, elts, 1).await;
                let name = match &theme {
                    Value::Tag(name) if name == "DARK" || name == "LIGHT" => Value::Str(name.to_lowercase()),
                    Value::Tag(name) => {
                        cx.report(id, format!("theme expects the tag DARK or LIGHT. Got tag {name}."));
                        Value::Str(name.to_lowercase())
                    }
                    other => {
                        let got = other.to_json().map_or_else(|| "undefined".to_owned(), |json| json.to_string());
                        cx.report(id, format!("theme expects the tag DARK or LIGHT. Got {got}."));
                        Value::Undefined
                    }
                };
                with(rest, "theme", name)
            }
            _ => return None,
        })
    }
}

/// A field element: the attributes chained onto it, with its type stamped and a name derived
/// from its label unless one was given.
async fn element(cx: &mut Evaluator<'_>, id: NodeId, kind: &str, elts: &[NodeId]) -> Value {
    let attributes = plain(cx.eval_arg(id, elts, 0).await);
    let truthy = |name: &str| attributes.get(&Key::tag(name)).filter(|value| value.is_truthy());
    if matches!(kind, "select" | "radio")
        && !matches!(truthy("options"), Some(Value::List(options)) if !options.is_empty())
    {
        let called = truthy("label").or(truthy("name")).map_or_else(|| kind.to_owned(), Value::display);
        cx.report(id, format!("The {kind} field \"{called}\" requires a non-empty options list."));
    }
    let name = match truthy("name") {
        Some(name) => name.clone(),
        None => Value::Str(slug(&truthy("label").map_or_else(|| kind.to_owned(), Value::display))),
    };
    let mut field: Record =
        [(Key::tag("type"), Value::Str(kind.to_owned())), (Key::tag("name"), name)].into_iter().collect();
    field.extend(attributes);
    Value::Record(field)
}

/// A label as a submission key: lowercased, with each run of anything but letters and digits
/// collapsed to `_`.
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.to_lowercase().trim().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_');
    if out.is_empty() { "field".to_owned() } else { out.to_owned() }
}

/// The rest of a chain with one more field set.
fn with(rest: Value, field: &str, value: Value) -> Value {
    let mut record = plain(rest);
    record.insert(Key::tag(field), value);
    Value::Record(record)
}

/// A value as a record keyed by name alone, whatever kind of key each field was written with;
/// nested records too. Anything that is not a record is an empty one.
fn plain(value: Value) -> Record {
    match value {
        Value::Record(record) => record
            .into_iter()
            .map(|(key, value)| {
                let value = match value {
                    nested @ Value::Record(_) => Value::Record(plain(nested)),
                    other => other,
                };
                (Key::tag(key.name().into_owned()), value)
            })
            .collect(),
        _ => Record::new(),
    }
}

/// A value as the fields of a record, if it has any: a record's own, or the one field a tag
/// (`tag`) or a function (`lambda`) is written with. Anything else is handed back.
fn fields(value: Value) -> Result<Record, Value> {
    match value {
        Value::Record(record) => Ok(record),
        Value::Tag(name) => Ok([(Key::tag("tag"), Value::Str(name))].into_iter().collect()),
        Value::Lambda(lambda) => {
            let params = Value::List(lambda.params.into_iter().map(Value::Str).collect());
            let lambda: Record = [(Key::tag("params"), params)].into_iter().collect();
            Ok([(Key::tag("lambda"), Value::Record(lambda))].into_iter().collect())
        }
        other => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_is_a_safe_submission_key() {
        for (label, key) in [
            ("Full name", "full_name"),
            ("  E-mail address!  ", "e_mail_address"),
            ("Guests (max 5)", "guests_max_5"),
            ("Ünïcödé", "n_c_d"),
            ("___", "field"),
            ("", "field"),
            ("42", "42"),
        ] {
            assert_eq!(slug(label), key, "{label:?}");
        }
    }
}
