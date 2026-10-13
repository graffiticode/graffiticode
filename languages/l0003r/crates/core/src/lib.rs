// SPDX-License-Identifier: MIT

//! L0003 — the first child of L0000. It inherits the whole base language and adds four words:
//!
//! | word | |
//! |---|---|
//! | `hello <string>` | a greeting: `{ hello }` |
//! | `image <url>` | an image: `{ image }` |
//! | `theme <DARK\|LIGHT> <body>` | the body, with a `theme` beside it |
//! | `id <string> <body>` | the body, with an `id` beside it |
//!
//! A program's result, when it is a record, is merged with the upstream data it is chained
//! onto: the form posts its state back as data, and that state wins.

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Key, Lexicon, Node, NodeId, Op, Record, Value};

/// The words L0003 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0003")).expect("L0003 shadows no base word")
});

/// L0003's vocabulary: the base lexicon and its own words.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0003;

#[async_trait]
impl Dialect for L0003 {
    fn lang_id(&self) -> &str {
        "0003"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        Some(match op.tag() {
            // The program's result is the data model. A record takes the upstream data over
            // its own fields; anything else passes through as it is.
            "PROG" => match fields(cx.eval_kernel(id).await) {
                Ok(result) => merged(result, cx.data()),
                Err(value) => value,
            },
            "HELLO" => {
                let name = cx.eval_arg(id, elts, 0).await;
                let mut result = upstream(cx.data());
                // A greeting the form has already edited stands.
                if result.get(&Key::tag("hello")).is_none() {
                    result.insert(Key::tag("hello"), name);
                }
                Value::Record(result)
            }
            "IMAGE" => {
                let url = cx.eval_arg(id, elts, 0).await;
                merged([(Key::tag("image"), url)].into_iter().collect(), cx.data())
            }
            "THEME" => {
                let theme = match cx.eval_arg(id, elts, 0).await {
                    Value::Tag(name) => Value::Str(name.to_lowercase()),
                    _ => Value::Undefined,
                };
                let body = cx.eval_arg(id, elts, 1).await;
                merged(labelled("theme", theme, body), cx.data())
            }
            "ID" => {
                let name = cx.eval_arg(id, elts, 0).await;
                let body = cx.eval_arg(id, elts, 1).await;
                merged(labelled("id", name, body), cx.data())
            }
            _ => return None,
        })
    }

    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        for (_, node) in ast.reachable() {
            let Node::Form { op: Op::Dialect(tag), elts } = node else { continue };
            let Some(&first) = elts.first() else { continue };
            let problem = match (&**tag, ast.get(first)) {
                ("THEME", Some(Node::Tag(name))) if name == "DARK" || name == "LIGHT" => None,
                ("THEME", arg) => Some(format!("Expecting a tag DARK or tag LIGHT. Got {}.", written(arg))),
                ("ID", Some(Node::Str(_))) => None,
                ("ID", arg) => {
                    Some(format!("id: expecting a string, e.g. id \"greeting\" hello \"world\". Got {}.", written(arg)))
                }
                _ => None,
            };
            if let Some(problem) = problem {
                errors.push(Diagnostic::at(problem, ast.span(first)));
            }
        }
    }
}

/// An argument as its author wrote it, for an error message.
fn written(node: Option<&Node>) -> String {
    match node {
        Some(Node::Tag(name)) => format!("tag {name}"),
        Some(Node::Str(text)) => format!("the string {text:?}"),
        Some(Node::Num(n)) => format!("the number {}", n.display()),
        Some(Node::Bool(b)) => format!("{b}"),
        Some(Node::Null) => "null".to_owned(),
        Some(Node::Ident(name)) => name.clone(),
        Some(Node::Form { op, .. }) => format!("an expression ({})", op.tag().to_lowercase()),
        None => "nothing".to_owned(),
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

/// `{ <label>: <value>, ...body }`: a record body keeps its fields beside the label; a scalar or
/// a list goes under `value` so it is not lost.
fn labelled(label: &str, value: Value, body: Value) -> Record {
    let mut record: Record = [(Key::tag(label), value)].into_iter().collect();
    match fields(body) {
        Ok(body) => record.extend(body),
        Err(body) => record.insert(Key::tag("value"), body),
    }
    record
}

/// The upstream data's fields, when it is a record.
fn upstream(data: &Value) -> Record {
    match data {
        Value::Record(record) => record.clone(),
        _ => Record::new(),
    }
}

/// `result` with the upstream data laid over it.
fn merged(mut result: Record, data: &Value) -> Value {
    result.extend(upstream(data));
    Value::Record(result)
}
