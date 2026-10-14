// SPDX-License-Identifier: MIT

//! L0181 — flashcard study decks. A program is one chain: `cards` takes the deck and then the
//! rest of the chain, and every other word contributes one field to the record it is handed.
//!
//! ```text
//! cards [["hola" "hello"] ["adiós" "goodbye"]] title "Spanish Vocab" theme LIGHT {}..
//! ```
//!
//! compiles to `{"title":"Spanish Vocab","theme":"light","cards":[{"id":0,"front":"hola",...}]}`,
//! with the upstream data (the learner's state) merged over it last.
//!
//! The values are those of the TypeScript compiler (`packages/core/src/compiler.ts`,
//! `cards.ts`), byte for byte: the records the words build are JavaScript objects spread into
//! one another, so [`spread`] reproduces what JavaScript's `{...value}` takes from each kind of
//! value, and [`js::order`] the key order a JavaScript object enumerates in.

pub mod js;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Key, Lexicon, Node, NodeId, Number, Op, Record, Value};

/// The words L0181 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0181")).expect("L0181 redefines no base word")
});

/// L0181's vocabulary: the base lexicon with the deck words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The deck as the error messages show it.
const FORM: &str = r#"cards [["hola" "hello"] ["adiós" "goodbye"]] {}"#;

#[derive(Clone, Copy, Debug, Default)]
pub struct L0181;

#[async_trait]
impl Dialect for L0181 {
    fn lang_id(&self) -> &str {
        "0181"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    /// The TypeScript Checker's one rule: `theme` takes the tag `DARK` or `LIGHT`, written as
    /// a literal. It fires only where that Checker walks (see [`checked`]).
    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        check_node(ast, ast.root(), errors);
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        Some(match op.tag() {
            "PROG" => prog(cx, id).await,
            "CARDS" => {
                let deck = cx.eval_arg(id, elts, 0).await;
                let rest = cx.eval_arg(id, elts, 1).await;
                match cards_from_pairs(&deck) {
                    Ok(cards) => {
                        let mut record = spread(&rest);
                        record.insert(Key::tag("cards"), cards);
                        Value::Record(record)
                    }
                    Err(message) => {
                        cx.report_diagnostic(Diagnostic::new(message));
                        Value::Record(Record::new())
                    }
                }
            }
            "TITLE" => attribute(cx, id, elts, "title", r#"title "Spanish Vocab""#).await,
            "INSTRUCTIONS" => {
                attribute(cx, id, elts, "instructions", r#"instructions "Flip each card to reveal the answer.""#).await
            }
            "THEME" => {
                let theme = cx.eval_arg(id, elts, 0).await;
                let rest = cx.eval_arg(id, elts, 1).await;
                // `v0?.tag?.toLowerCase?.() ?? v0`: a tag is written as its lowercased name;
                // anything else (only reachable where the Checker does not look) as itself.
                let theme = match theme {
                    Value::Tag(name) => Value::Str(name.to_lowercase()),
                    other => other,
                };
                let mut record = spread(&rest);
                record.insert(Key::tag("theme"), theme);
                Value::Record(record)
            }
            _ => return None,
        })
    }
}

/// The program's value is its last expression, and the upstream data (the learner's state)
/// merges over it last when it is an object, so the state rides over the compiled deck.
async fn prog(cx: &mut Evaluator<'_>, id: NodeId) -> Value {
    let value = cx.eval_kernel(id).await;
    let value = match value {
        // `typeof val === "object"`: a record, and the tag and function values, which are
        // objects in JavaScript.
        Value::Record(_) | Value::Tag(_) | Value::Lambda(_) => {
            let mut record = spread(&value);
            let data = cx.data();
            if data.is_truthy() {
                record.extend(spread(data));
            }
            Value::Record(record)
        }
        other => other,
    };
    // Every object in the TypeScript output is a JavaScript object, whose integer-like keys
    // come first.
    value.to_json().map_or(Value::Undefined, |json| Value::from_json(&js::order(json)))
}

/// `title` and `instructions`: one string field over the rest of the chain.
async fn attribute(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], word: &str, example: &str) -> Value {
    let given = cx.eval_arg(id, elts, 0).await;
    let rest = cx.eval_arg(id, elts, 1).await;
    let mut record = spread(&rest);
    match plain(&given) {
        Value::Str(text) => record.insert(Key::tag(word), Value::Str(text)),
        other => cx.report_diagnostic(Diagnostic::new(format!(
            "{word}: expected a string, e.g. {example}. Got {}.",
            show(&other)
        ))),
    }
    Value::Record(record)
}

/// Validates and numbers the deck: a list of `["front" "back"]` string pairs.
pub fn cards_from_pairs(deck: &Value) -> Result<Value, String> {
    let Value::List(pairs) = plain(deck) else {
        return Err(format!("cards: expected a list of pairs, e.g. {FORM}. Got {}.", show(&plain(deck))));
    };
    if pairs.is_empty() {
        return Err(format!("cards: the deck is empty. Give it at least one pair, e.g. {FORM}."));
    }
    let mut cards = Vec::with_capacity(pairs.len());
    for (i, pair) in pairs.into_iter().enumerate() {
        let place = format!("cards: pair {}", i + 1);
        let Value::List(sides) = pair else {
            return Err(format!(r#"{place} is {}, not a ["front" "back"] pair."#, show(&pair)));
        };
        let [front, back] = <[Value; 2]>::try_from(sides).map_err(|sides| {
            let n = sides.len();
            format!(
                "{place} has {n} element{}; a card needs exactly two — a front and a back.",
                if n == 1 { "" } else { "s" }
            )
        })?;
        let (Value::Str(front), Value::Str(back)) = (&front, &back) else {
            let bad = if matches!(front, Value::Str(_)) {
                format!("back is {}", show(&back))
            } else {
                format!("front is {}", show(&front))
            };
            return Err(format!("{place}: both sides must be strings, but its {bad}."));
        };
        let card: Record = [
            (Key::tag("id"), Value::from(i as f64)),
            (Key::tag("front"), Value::Str(front.clone())),
            (Key::tag("back"), Value::Str(back.clone())),
        ]
        .into_iter()
        .collect();
        cards.push(Value::Record(card));
    }
    Ok(Value::List(cards))
}

/// `toPlainObject`: a record as the plain object its fields name, all the way down. The kind
/// of a key is dropped (a later field of the same name keeps the earlier one's place).
pub fn plain(value: &Value) -> Value {
    match value {
        Value::Record(record) => {
            let mut out = Record::new();
            for (key, value) in record.iter() {
                out.insert(Key::tag(key.name()), plain(value));
            }
            Value::Record(out)
        }
        Value::List(items) => Value::List(items.iter().map(plain).collect()),
        other => other.clone(),
    }
}

/// `{...(toPlainObject(value) || {})}`: the fields JavaScript's spread takes from a value.
/// A list gives its indices, a string its UTF-16 code units, and a tag or a function the one
/// field it is written with; a falsy value, a number and a boolean give nothing.
pub fn spread(value: &Value) -> Record {
    match plain(value) {
        Value::Record(record) => record,
        Value::List(items) => items.into_iter().enumerate().map(|(i, item)| (Key::tag(i.to_string()), item)).collect(),
        Value::Str(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (Key::tag(i.to_string()), Value::Str(String::from_utf16_lossy(&[unit]))))
            .collect(),
        Value::Tag(name) => [(Key::tag("tag"), Value::Str(name))].into_iter().collect(),
        lambda @ Value::Lambda(_) => {
            let json = lambda.to_json().unwrap_or_default();
            [(Key::tag("lambda"), Value::from_json(&json["lambda"]))].into_iter().collect()
        }
        // An exact number is a `Decimal` object in JavaScript, whose spread is its internals;
        // that is not reproduced (see the crate's CLAUDE.md).
        Value::Undefined | Value::Null | Value::Bool(_) | Value::Num(_) => Record::new(),
    }
}

/// `show`: a bad value named the way its author wrote it.
pub fn show(value: &Value) -> String {
    match value {
        Value::Str(text) => serde_json::to_string(text).expect("a string serializes"),
        Value::List(items) => format!("a list of {}", items.len()),
        Value::Undefined | Value::Null => "nothing".to_owned(),
        // Objects in JavaScript, a `Decimal` included.
        Value::Record(_) | Value::Tag(_) | Value::Lambda(_) | Value::Num(Number::Exact(_)) => "a record".to_owned(),
        Value::Num(n) => n.display(),
        Value::Bool(flag) => flag.to_string(),
    }
}

/// The children the TypeScript Checker visits under a node: L0000's Checker visits only some
/// (a list its first element, a record none), and L0181's words both of theirs.
fn checked<'a>(op: &Op, elts: &'a [NodeId]) -> &'a [NodeId] {
    let n = match op.tag() {
        "EXPRS" => elts.len(),
        "CARDS" | "TITLE" | "INSTRUCTIONS" | "THEME" => 2,
        "ERROR" | "RANGE" => 3,
        "SET_VAR" | "CONCAT" | "ADD" | "SUB" | "DIV" | "GET" | "LT" | "MUL" | "POW" | "GT" | "GE" | "LE" | "NE"
        | "EQ" | "MOD" | "MIN" | "MAX" | "EQUIV" | "OR" | "AND" | "CONS" | "APPEND" | "DROP" | "TAKE"
        | "FORMAT_NUMBER" => 2,
        "PROG" | "LAMBDA" | "LIST" | "STR_OF" | "JSON" | "GET_VAR" | "GET_VAL_PRIVATE" | "GET_VAL_PUBLIC" | "NOT"
        | "HD" | "TL" | "LOG" | "ISEMPTY" | "LAST" => 1,
        _ => 0,
    };
    &elts[..n.min(elts.len())]
}

/// Walks the tree as the TypeScript Checker does, reporting a `theme` that is not given the
/// tag `DARK` or `LIGHT`. A `theme`'s error follows the errors of the chain it wraps.
fn check_node(ast: &Ast, id: NodeId, errors: &mut Vec<Diagnostic>) {
    let Some(Node::Form { op, elts }) = ast.get(id) else { return };
    if op.tag() == "THEME" {
        // The Checker drops whatever its first argument reports, and walks the rest.
        if let Some(&rest) = elts.get(1) {
            check_node(ast, rest, errors);
        }
        let Some(&given) = elts.first() else { return };
        let got = match ast.get(given) {
            Some(Node::Tag(name)) if name == "DARK" || name == "LIGHT" => return,
            Some(Node::Tag(name)) => format!("tag {name}"),
            Some(Node::Str(text)) => serde_json::to_string(text).expect("a string serializes"),
            Some(Node::Num(n)) => n.display().to_lowercase(),
            Some(Node::Bool(_)) => "bool".to_owned(),
            Some(Node::Null) => "null".to_owned(),
            Some(Node::Ident(_)) => "ident".to_owned(),
            Some(Node::Form { op, .. }) => op.tag().to_lowercase(),
            None => "undefined".to_owned(),
        };
        errors.push(Diagnostic::at(format!("theme: expected the tag DARK or LIGHT. Got {got}."), ast.span(given)));
        return;
    }
    for &elt in checked(op, elts) {
        check_node(ast, elt, errors);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: Vec<Value>) -> Value {
        Value::List(items)
    }

    #[test]
    fn a_deck_is_numbered_in_order() {
        let deck = list(vec![list(vec!["a".into(), "b".into()]), list(vec!["c".into(), "d".into()])]);
        let cards = cards_from_pairs(&deck).unwrap().to_json().unwrap();
        assert_eq!(cards.to_string(), r#"[{"id":0,"front":"a","back":"b"},{"id":1,"front":"c","back":"d"}]"#);
    }

    #[test]
    fn a_bad_deck_names_what_is_wrong() {
        let err = |deck: Value| cards_from_pairs(&deck).unwrap_err();
        assert!(err(Value::from("x")).ends_with(r#"Got "x"."#));
        assert!(err(list(vec![])).contains("the deck is empty"));
        assert_eq!(
            err(list(vec![list(vec!["a".into()])])),
            "cards: pair 1 has 1 element; a card needs exactly two — a front and a back."
        );
        assert_eq!(
            err(list(vec![list(vec!["a".into(), Value::Tag("X".into())])])),
            "cards: pair 1: both sides must be strings, but its back is a record."
        );
    }

    #[test]
    fn spread_takes_what_javascript_takes() {
        let json = |record: Record| Value::Record(record).to_json().unwrap().to_string();
        assert_eq!(json(spread(&Value::from("añ"))), r#"{"0":"a","1":"ñ"}"#);
        // A lone surrogate has no Rust string, so each half is U+FFFD; JavaScript keeps it.
        assert_eq!(json(spread(&Value::from("😀"))), "{\"0\":\"\u{fffd}\",\"1\":\"\u{fffd}\"}");
        assert_eq!(json(spread(&list(vec![1.0.into(), Value::Undefined]))), r#"{"0":1}"#);
        assert_eq!(json(spread(&Value::Tag("DARK".into()))), r#"{"tag":"DARK"}"#);
        assert_eq!(json(spread(&Value::from(5.0))), "{}");
        assert_eq!(json(spread(&Value::Null)), "{}");
    }

    #[test]
    fn show_names_values_as_typescript_does() {
        assert_eq!(show(&Value::from("a\"b")), r#""a\"b""#);
        assert_eq!(show(&Value::from(-1.5)), "-1.5");
        assert_eq!(show(&Value::Num(Number::parse("12345678901234567890"))), "a record");
        assert_eq!(show(&Value::Bool(false)), "false");
        assert_eq!(show(&Value::Undefined), "nothing");
        assert_eq!(show(&list(vec![Value::Null; 3])), "a list of 3");
    }
}
