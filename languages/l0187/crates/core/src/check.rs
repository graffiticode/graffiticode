// SPDX-License-Identifier: MIT

//! Value checks: whether a value is one a property takes, and the error when it is not. Every
//! value is checked when it is evaluated, wherever it came from — a literal, a binding, a record
//! or upstream data (design §6, §11).

use graffiticode_l0000::Value;

use crate::vocab::{self, NAMED_COLORS, Property, TagSet, ValueType};

/// A value as it was written, for an error message.
pub fn show(value: &Value) -> String {
    match value {
        Value::Undefined => "nothing".to_owned(),
        Value::Tag(name) => name.clone(),
        other => other.display_source(),
    }
}

/// Why `raw` is not an id, or `None` when it is one.
pub fn id_problem(raw: &Value) -> Option<String> {
    let Value::Str(text) = raw else {
        return Some(format!("an id is a quoted string, like \"idea\"; got {}", show(raw)));
    };
    if text.trim().is_empty() {
        return Some(format!("an id must have characters other than white space; got {}", show(raw)));
    }
    if text.trim() != text {
        return Some(format!("an id must not start or end with white space; write {:?}", text.trim()));
    }
    if text == "*" {
        return Some("\"*\" is reserved and cannot be an id or a reference".to_owned());
    }
    None
}

fn tag_problem(word: &str, set: &TagSet, raw: &Value) -> Option<String> {
    let one_of = set.names().collect::<Vec<_>>().join(", ");
    match raw {
        Value::Tag(tag) if set.contains(tag) => None,
        Value::Tag(tag) => {
            let elsewhere =
                vocab::tag_set(tag).map(|other| format!(" {tag} is a {} tag.", other.name)).unwrap_or_default();
            Some(format!("expected one of {one_of}, got {tag}.{elsewhere}"))
        }
        Value::Str(text) => {
            let written = text.trim().to_uppercase().replace(['-', ' '], "_");
            let hint = if set.contains(&written) {
                format!(" Write it bare and uppercase, without quotes: {word} {written}.")
            } else {
                String::new()
            };
            Some(format!("expected one of {one_of}, got {}.{hint}", show(raw)))
        }
        _ => Some(format!("expected one of {one_of}, got {}.", show(raw))),
    }
}

fn is_hex(color: &str) -> bool {
    color
        .strip_prefix('#')
        .is_some_and(|digits| matches!(digits.len(), 3 | 6) && digits.chars().all(|c| c.is_ascii_hexdigit()))
}

fn number(raw: &Value) -> Option<f64> {
    match raw {
        Value::Num(n) => Some(n.to_f64()),
        _ => None,
    }
}

/// The value a property takes, normalized (a named colour lower-cased), or the message for a
/// value it does not take. The message starts with the word: `fill: expected …`.
pub fn check_value(property: &Property, raw: &Value) -> Result<Value, String> {
    let word = property.word;
    let problem = match property.value {
        ValueType::Id | ValueType::IdRef => id_problem(raw).map(|p| format!("{p}.")),
        ValueType::IdList => match raw {
            Value::List(items) if items.is_empty() => {
                Some(format!("expected a nonempty list of ids, like {word} [\"b\" \"c\"]; got []."))
            }
            Value::List(items) => {
                let mut problem = None;
                for (i, item) in items.iter().enumerate() {
                    if let Some(p) = id_problem(item) {
                        problem = Some(format!("item {} is not an id: {p}.", i + 1));
                        break;
                    }
                    if items[..i].contains(item) {
                        problem = Some(format!("{} is listed twice.", show(item)));
                        break;
                    }
                }
                problem
            }
            Value::Str(_) => Some(format!("expected a list of ids in [brackets], like {word} [{}].", show(raw))),
            _ => Some(format!("expected a list of ids in [brackets], like {word} [\"b\" \"c\"]; got {}.", show(raw))),
        },
        ValueType::Text => match raw {
            Value::Str(_) => None,
            _ => Some(format!("expected a quoted string, got {}.", show(raw))),
        },
        ValueType::Name => match raw {
            Value::Str(text) if !text.trim().is_empty() => None,
            Value::Str(_) => Some("expected a name with characters other than white space.".to_owned()),
            _ => Some(format!("expected a quoted name, got {}.", show(raw))),
        },
        ValueType::Tag(set) => tag_problem(word, set, raw),
        ValueType::Count => match number(raw) {
            Some(n) if n.is_finite() && n >= 1.0 && n.fract() == 0.0 => None,
            _ => Some(format!("expected a whole number of columns, 1 or more, got {}.", show(raw))),
        },
        ValueType::Opacity => match number(raw) {
            Some(n) if (0.0..=100.0).contains(&n) => None,
            _ => Some(format!("expected a number from 0 to 100, got {}.", show(raw))),
        },
        ValueType::Color => match raw {
            Value::Str(text) if is_hex(text.trim()) => return Ok(Value::Str(text.trim().to_owned())),
            Value::Str(text) if NAMED_COLORS.contains(&text.trim().to_lowercase().as_str()) => {
                return Ok(Value::Str(text.trim().to_lowercase()));
            }
            _ => Some(format!(
                "expected a hex colour like \"#ffcc00\" or one of {}, got {}.",
                NAMED_COLORS.join(", "),
                show(raw)
            )),
        },
        ValueType::Boolean => match raw {
            Value::Bool(_) => None,
            _ => Some(format!("expected true or false, got {}.", show(raw))),
        },
    };
    match problem {
        None => Ok(raw.clone()),
        Some(problem) => Err(format!("{word}: {problem}")),
    }
}
