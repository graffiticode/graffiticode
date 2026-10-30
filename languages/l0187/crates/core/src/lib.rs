// SPDX-License-Identifier: MIT

//! L0187 — declarative FigJam boards. A program declares content, membership, relationships
//! and meaningful order; the compiler measures, arranges, routes and validates the board and
//! returns it positioned. Coordinates are compiled output, never source
//! (docs/l0187-language-design.md).
//!
//! ```text
//! board [
//!   page [
//!     sticky id "idea" text "Idea" {}
//!     sticky id "plan" text "Plan" {}
//!     connector id "idea-plan" from "idea" to "plan" label "develop" {}
//!   ] id "planning" name "Planning" layout FLOW direction RIGHT {}
//! ] title "Planning board" layout-profile FIGJAM_V1 {}..
//! ```
//!
//! L0187 has no TypeScript implementation: [`vocab`] is the source of truth for its words, and
//! [`lexicon`] is derived from it. Compiling evaluates and checks every word ([`eval`]), builds
//! the semantic board ([`ir`]) and resolves its ids, endpoints and orders ([`resolve`]).

pub mod check;
pub mod diag;
pub mod eval;
pub mod ir;
pub mod lexicon;
pub mod resolve;
pub mod vocab;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Node, NodeId, Op, Value};

use crate::eval::{is_own, key, report};
pub use crate::lexicon::lexicon;
use crate::resolve::SourceMap;
use crate::vocab::{REMOVED_GEOMETRY, REMOVED_OTHER, SAVE_TO_FIGJAM};

#[derive(Clone, Copy, Debug, Default)]
pub struct L0187;

#[async_trait]
impl Dialect for L0187 {
    fn lang_id(&self) -> &str {
        "0187"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    /// No L0187 word reads upstream data, so a program that does not read it (`data`, a
    /// `get-var` that may name it) compiles to a value model (interpreter plan C1).
    fn input_independent(&self, ast: &Ast) -> bool {
        !ast.reads_input()
    }

    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        explain_removed_words(errors);
        explain_missing_terminator(errors);
        early_close(ast, errors);
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        if *op == Op::Prog {
            return Some(prog(cx, id, elts).await);
        }
        let word = vocab::word_of_tag(op.tag())?;
        let before = cx.error_count();
        let value = if vocab::property(word).is_some() {
            let given = cx.eval_arg(id, elts, 0).await;
            let rest = cx.eval_arg(id, elts, 1).await;
            eval::property(cx, id, word, given, rest)
        } else if vocab::member(word).is_some() {
            let raw = cx.eval_arg(id, elts, 0).await;
            let quiet = cx.error_count() > before;
            eval::member(cx, id, word, raw, quiet)
        } else if word == SAVE_TO_FIGJAM {
            let raw = cx.eval_arg(id, elts, 0).await;
            eval::save_to_figjam(cx, id, raw)
        } else {
            let list = cx.eval_arg(id, elts, 0).await;
            let settings = cx.eval_arg(id, elts, 1).await;
            let quiet = cx.error_count() > before;
            eval::container(cx, id, word, list, settings, quiet)
        };
        Some(value)
    }
}

/// A word L0187 removed reaches the parser as an undefined reference. Say where placement went
/// (design §6) instead of only that the word is unknown.
fn explain_removed_words(errors: &mut [Diagnostic]) {
    for error in errors {
        let Some(word) = error.message.strip_prefix("Undefined reference '").and_then(|rest| rest.strip_suffix("'."))
        else {
            continue;
        };
        if REMOVED_GEOMETRY.contains(&word) {
            error.message.push_str(&format!(
                " L0187 computes placement, so `{word}` is not a word: arrange content with `layout` (ROW, COLUMN, GRID with `columns`, or FLOW with `direction` and `before`) on the page, section or group that holds it, e.g. `group [ … ] id \"cards\" layout GRID columns 3 {{}}`."
            ));
            error.code = Some("removed-geometry".to_owned());
            error.category = Some(diag::Category::Source.name().to_owned());
        } else if REMOVED_OTHER.contains(&word) {
            error.message.push_str(&format!(" `{word}` is not part of L0187."));
            error.code = Some("removed-word".to_owned());
            error.category = Some(diag::Category::Source.name().to_owned());
        }
    }
}

/// A description missing its `{}` leaves its last property a value short. Say how a description
/// ends (design §11: the terminator stays a parser error, taught prominently).
fn explain_missing_terminator(errors: &mut [Diagnostic]) {
    for error in errors {
        let Some(tag) = error.message.strip_prefix("Too few arguments for ").and_then(|rest| rest.split('.').next())
        else {
            continue;
        };
        let Some(word) = vocab::word_of_tag(tag) else { continue };
        if vocab::property(word).is_some() {
            error.message.push_str(&format!(
                " `{word}` takes a value and then the rest of its description: every description ends in `{{}}` after its last word, e.g. `sticky id \"a\" text \"A\" {{}}`."
            ));
            error.code = Some("unterminated-description".to_owned());
            error.category = Some(diag::Category::Source.name().to_owned());
        }
    }
}

/// A `{}` written before the end of a description ends it there, and the words after it parse
/// as a second top-level description — well formed, and silently dropped. The board is the
/// only top-level expression built from L0187's description words.
fn early_close(ast: &Ast, errors: &mut Vec<Diagnostic>) {
    let Some(Node::Form { elts, .. }) = ast.get(ast.root()) else { return };
    let Some(Node::Form { elts: exprs, .. }) = elts.first().and_then(|&id| ast.get(id)) else { return };
    let own: Vec<NodeId> = exprs
        .iter()
        .copied()
        .filter(|&id| matches!(ast.get(id), Some(Node::Form { op, .. }) if is_own(op.tag()) || *op == Op::Record))
        .collect();
    if own.len() > 1 {
        errors.push(diag::source(
            "early-close",
            format!(
                "A `{{}}` ended a description early: the program has {} top-level descriptions where one `board [ … ] {{}}` was expected, and the words after the early `{{}}` started a new one. Every description ends in exactly one `{{}}`, after its last word: write `sticky id \"a\" text \"A\" fill \"yellow\" {{}}`, not `sticky id \"a\" text \"A\" {{}} fill \"yellow\" {{}}`.",
                own.len()
            ),
            ast.span(own[1]),
        ));
    }
}

const PROGRAM_EXAMPLE: &str = "board [ page [ sticky id \"a\" text \"Hello\" {} ] id \"p1\" name \"Page 1\" {} ] {}";

/// The program is one board, and optionally one `save-to-figjam` statement. Upstream data is
/// never spread into the output: the board is exactly what this program declares.
async fn prog(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let values = top_level(cx, id, elts).await;
    if cx.error_count() > before {
        return Value::Record(Default::default());
    }
    let single = |v: &Value, word: &str| matches!(v, Value::Record(r) if r.len() == 1 && r.get(&key(word)).is_some());
    let boards: Vec<&Value> = values.iter().filter(|v| single(v, "board")).collect();
    let saves: Vec<&Value> = values.iter().filter(|v| single(v, SAVE_TO_FIGJAM)).collect();
    if boards.len() != 1 {
        let tail = if saves.is_empty() {
            ""
        } else {
            " save-to-figjam names where to draw it, and needs the board beside it."
        };
        report(
            cx,
            id,
            "program-shape",
            format!("A program is one board, ending in `..`: e.g. {PROGRAM_EXAMPLE}..{tail}"),
        );
        return Value::Record(Default::default());
    }
    if saves.len() > 1 {
        report(
            cx,
            id,
            "save-to-figjam",
            "save-to-figjam is given twice. A board is drawn into one FigJam file: keep one save-to-figjam line.",
        );
        return Value::Record(Default::default());
    }
    let file_key = saves.first().and_then(|v| match v {
        Value::Record(r) => match r.get(&key(SAVE_TO_FIGJAM)) {
            Some(Value::Str(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    });
    let Value::Record(board) = boards[0] else { unreachable!() };
    let board = match ir::build(board.get(&key("board")).expect("a board"), file_key) {
        Ok(board) => board,
        Err(message) => {
            report(cx, id, "internal", message);
            return Value::Record(Default::default());
        }
    };
    let errors = resolve::resolve(&board, &source_map(cx.ast()));
    if !errors.is_empty() {
        for error in errors {
            cx.report_diagnostic(error);
        }
        return Value::Record(Default::default());
    }
    output(&board)
}

/// The compiled board. Until layout exists (phase 4) this is the semantic board itself.
fn output(board: &ir::Board) -> Value {
    let mut json = serde_json::to_value(board).expect("the board serializes");
    if let Some(object) = json.as_object_mut() {
        let mut out = serde_json::Map::new();
        out.insert("type".to_owned(), "board".into());
        out.append(object);
        json = out.into();
    }
    Value::from_json(&json)
}

/// Where every literal id was written: the span of each `id "…"` property, in source order.
fn source_map(ast: &Ast) -> SourceMap {
    let mut map = SourceMap::new();
    let tag = vocab::node_tag("id");
    for (id, node) in ast.nodes() {
        let Node::Form { op, elts } = node else { continue };
        if op.tag() != tag {
            continue;
        }
        if let (Some(Node::Str(text)), Some(span)) = (elts.first().and_then(|&e| ast.get(e)), ast.span(id)) {
            map.entry(text.clone()).or_default().push(span);
        }
    }
    for spans in map.values_mut() {
        spans.sort_by_key(|s| s.from);
    }
    map
}

/// The value of every top-level expression, as L0000's `EXPRS` gives them to `PROG`: each in
/// order, or the one value of a parenthesized function applied to the rest.
async fn top_level(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Vec<Value> {
    let ast = cx.ast();
    let Some(&exprs) = elts.first() else { return vec![cx.eval_arg(id, elts, 0).await] };
    match ast.get(exprs) {
        Some(Node::Form { op: Op::Exprs, elts: items }) if !(items.len() > 1 && is_function(ast, items[0])) => {
            let mut values = Vec::with_capacity(items.len());
            for &item in items {
                values.push(cx.eval(item).await);
            }
            values
        }
        _ => match cx.eval_arg(id, elts, 0).await {
            Value::List(items) if !matches!(ast.get(exprs), Some(Node::Form { op: Op::Exprs, .. })) => items,
            one => vec![one],
        },
    }
}

/// A `LAMBDA`, or one in parentheses.
fn is_function(ast: &Ast, id: NodeId) -> bool {
    match ast.get(id) {
        Some(Node::Form { op: Op::Lambda, .. }) => true,
        Some(Node::Form { op: Op::Paren, elts }) => elts.first().is_some_and(|&inner| is_function(ast, inner)),
        _ => false,
    }
}
