// SPDX-License-Identifier: MIT

//! L0186 — FigJam boards: sticky notes, text, shapes with text, sections, reaction stamps and
//! connectors, on one or more pages. A program is one board; compiling it checks every word
//! and resolves every connector, and yields the board the Graffiticode FigJam plugin draws.
//!
//! ```text
//! save-to-figjam "https://www.figma.com/board/ABC123/Planning"
//! board [
//!   page [
//!     sticky id "idea" text "Idea" x 0 y 0 {}
//!     sticky id "plan" text "Plan" x 300 y 0 {}
//!     connector from "idea" to "plan" {}
//!   ] {}
//! ] {}..
//! ```
//!
//! Four construct shapes: containers (`board`, `page`, `section`: a member list, then a
//! settings chain), members (`sticky`, `shape`, `textbox`, `stamp`, `connector`, `waypoint`:
//! one description), properties (everything else: a value, then the rest of the chain), and
//! uppercase tags. Plus one statement, `save-to-figjam`, which `PROG` merges into the board.
//!
//! Every word works on its arguments as the TypeScript does, as plain JavaScript values
//! ([`plain::Plain`]); an error is reported where the TypeScript adds one to its error list,
//! and a word that fails yields `{}`, as the TypeScript's does.

pub mod board;
pub mod plain;
pub mod vocab;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Lexicon, Node, NodeId, Op, Value};

use crate::board::{build_board, node_name, parse_file_key, to_node};
use crate::plain::{Plain, entries, object, stringify};
use crate::vocab::{
    SAVE_HINT, VOCAB, a_or_an, assert_known_attributes, assert_known_settings, check_value, example_of, hint_for,
    is_record, show_value, source_word, word_of,
};

/// The words L0186 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0186")).expect("L0186 redefines no base word")
});

/// L0186's vocabulary: the base lexicon with the board words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0186;

#[async_trait]
impl Dialect for L0186 {
    fn lang_id(&self) -> &str {
        "0186"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    /// A board is the same for every input unless the program reads it (`data`, a `get-var`
    /// that may name it): none of L0186's own words does, so a program the kernel finds doesn't
    /// read its input compiles to a value model (interpreter plan C1).
    fn input_independent(&self, ast: &Ast) -> bool {
        !ast.reads_input()
    }

    /// A `{}` written before the end of a description ends it there, and the words after it
    /// parse as a SECOND top-level expression — well formed, and silently dropped. The board is
    /// the only top-level expression built from L0186's description words, so a second one is
    /// an early-closed description. `save-to-figjam` and L0000 expressions may stand beside it.
    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        let Some(Node::Form { elts, .. }) = ast.get(ast.root()) else { return };
        let Some(Node::Form { elts: exprs, .. }) = elts.first().and_then(|&id| ast.get(id)) else { return };
        let own: Vec<NodeId> = exprs
            .iter()
            .copied()
            .filter(|&id| matches!(ast.get(id), Some(Node::Form { op, .. }) if is_own(op.tag())))
            .collect();
        if own.len() > 1 {
            errors.push(Diagnostic::at(
                format!(
                    "A `{{}}` ended a description early: the program has {} top-level descriptions where one `board [ … ] {{}}` was expected, and the words after the early `{{}}` started a new one. Every description ends in exactly one `{{}}`, after its last word: write `sticky text \"A\" x 0 {{}}`, not `sticky text \"A\" {{}} x 0 {{}}`.",
                    own.len()
                ),
                ast.span(own[1]),
            ));
        }
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        let value = if *op == Op::Prog {
            prog(cx, id, elts).await.to_value()
        } else if let Some(meta) = VOCAB.chain_fields.get(tag) {
            let given = arg(cx, id, elts, 0).await;
            let rest = arg(cx, id, elts, 1).await;
            fail(cx, property(tag, meta, &given, &rest))
        } else if let Some(meta) = VOCAB.member_fields.get(tag) {
            let raw = arg(cx, id, elts, 0).await;
            fail(cx, member(tag, meta, &raw))
        } else if tag == VOCAB.save_to_figjam.name {
            let raw = arg(cx, id, elts, 0).await;
            fail(cx, parse_file_key(&raw).map(|key| object([(VOCAB.save_to_figjam.field.as_str(), Plain::Str(key))])))
        } else {
            // A container builds nothing on a failed member or setting: their errors stand.
            let word = VOCAB.container_fields.get(tag)?;
            let before = cx.error_count();
            let list = arg(cx, id, elts, 0).await;
            let settings = arg(cx, id, elts, 1).await;
            if cx.error_count() > before {
                return Some(empty());
            }
            fail(cx, container(word, &list, &settings))
        };
        Some(value)
    }
}

/// The node tags L0186's own descriptions produce, plus a bare `{}`.
fn is_own(tag: &str) -> bool {
    tag == "RECORD"
        || VOCAB.chain_fields.contains_key(tag)
        || VOCAB.member_fields.contains_key(tag)
        || VOCAB.container_fields.contains_key(tag)
}

async fn arg(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], index: usize) -> Plain {
    Plain::from_value(&cx.eval_arg(id, elts, index).await)
}

fn empty() -> Value {
    Value::Record(Default::default())
}

/// A word's value, or its error reported and `{}` in its place.
fn fail(cx: &mut Evaluator<'_>, result: Result<Plain, String>) -> Value {
    match result {
        Ok(value) => value.to_value(),
        Err(message) => {
            cx.report_diagnostic(Diagnostic::new(message));
            empty()
        }
    }
}

/// The marker `save-to-figjam` evaluates to, found where a description was expected.
fn is_save_marker(value: &Plain) -> bool {
    is_record(value) && value.as_object().is_some_and(|object| object.contains_key(&VOCAB.save_to_figjam.field))
}

/// Where a property's chain goes, for the "must end in a record" error.
fn chain_example(word: &str) -> String {
    let owner = VOCAB.valid_settings.iter().find(|(_, words)| words.iter().any(|w| w == word)).map(|(c, _)| c);
    match owner.map(String::as_str) {
        Some("board") => format!("board [ … ] {word} … {{}}"),
        Some("page") => format!("page [ … ] {word} … {{}}"),
        _ => format!("sticky {word} … {{}}"),
    }
}

/// Properties, arity 2: the value AND the rest of the chain; the chain's record plus this key.
/// The value is checked even when the rest of the chain failed (its `{}` is a record).
fn property(name: &str, meta: &vocab::Meta, given: &Plain, rest: &Plain) -> Result<Plain, String> {
    let word = word_of(name);
    let value = check_value(name, meta, given)?;
    if is_save_marker(rest) {
        return Err(format!("{word}: save-to-figjam cannot end a description.{SAVE_HINT}"));
    }
    if !is_record(rest) {
        return Err(format!(
            "{word}: a description must end in a record — write `{{}}` after its last word, e.g. {}. Got {}.",
            chain_example(&word),
            show_value(rest)
        ));
    }
    if rest.as_object().is_some_and(|object| object.contains_key(&meta.field)) {
        return Err(format!("{word}: is given twice. Each word may appear once in a description."));
    }
    Ok(object([(meta.field.clone(), value)].into_iter().chain(entries(rest))))
}

/// Members, arity 1: `sticky <description>` evaluates to `{sticky: {...}}`.
fn member(name: &str, meta: &vocab::Meta, raw: &Plain) -> Result<Plain, String> {
    if is_save_marker(raw) {
        return Err(format!("{}: save-to-figjam cannot be a description.{SAVE_HINT}", word_of(name)));
    }
    let value = check_value(name, meta, raw)?;
    Ok(object([(meta.field.clone(), value)]))
}

/// Something in a list, as written, for an error message.
fn describe(m: &Plain) -> String {
    if !is_record(m) {
        return show_value(m);
    }
    let keys = m.keys().unwrap_or_default();
    match keys.as_slice() {
        [] => "a stray `{}` — a description ends in exactly one `{}`".to_owned(),
        [key] => {
            let w = source_word(key);
            format!("{} `{w}`", a_or_an(&w))
        }
        _ => {
            let words: Vec<String> = keys.iter().map(|key| source_word(key)).collect();
            format!("a description ({}) with no word in front of it", words.join(", "))
        }
    }
}

/// Words that start a list item on their own, as opposed to properties inside one.
fn is_item_word(word: &str) -> bool {
    VOCAB.member_fields.keys().chain(VOCAB.container_fields.keys()).any(|name| word_of(name) == word)
}

/// When a list item is a bare property (`x …`, `text …`), the usual cause is a `{}` that ended
/// the previous description early, so the rest of it became an item of its own.
fn early_close(m: &Plain) -> String {
    let keys = if is_record(m) { m.keys().unwrap_or_default() } else { Vec::new() };
    let [key] = keys.as_slice() else { return String::new() };
    let w = source_word(key);
    if is_item_word(&w) {
        return String::new();
    }
    format!(
        " If `{w}` belongs to the description before it, a `{{}}` ended that description early: a description ends in exactly one `{{}}`, after its last word."
    )
}

struct Item {
    member: String,
    rec: Plain,
    at: String,
}

/// A typed list: every entry is one of the container's member words, and each member's words
/// are checked as it is reached, so an error lands on the member that caused it.
fn members(word: &str, list: &[Plain], at: &str) -> Result<Vec<Item>, String> {
    let allowed = &VOCAB.container_members[word];
    let mut items = Vec::with_capacity(list.len());
    for (i, m) in list.iter().enumerate() {
        let keys = if is_record(m) { m.keys()? } else { Vec::new() };
        let member = match keys.as_slice() {
            [key] => Some(source_word(key)),
            _ => None,
        };
        if member.as_deref() == Some(VOCAB.save_to_figjam.word.as_str()) {
            return Err(format!("{at}: item {} is save-to-figjam, which is not a member of {word}.{SAVE_HINT}", i + 1));
        }
        if is_record(m) && keys.is_empty() {
            let example = example_of(&allowed[0]);
            let doubled = match example.strip_suffix(" {}") {
                Some(stem) => format!("{stem} {{}} {{}}"),
                None => example.clone(),
            };
            return Err(format!(
                "{at}: item {} is a stray `{{}}`. A description ends in exactly one `{{}}`, after its last word: write {example}, not {doubled}.",
                i + 1
            ));
        }
        let Some(member) = member.filter(|member| allowed.contains(member)) else {
            let hint = match keys.as_slice() {
                [key] if !source_word(key).is_empty() => hint_for(&source_word(key), word),
                _ => String::new(),
            };
            let early = if i > 0 { early_close(m) } else { String::new() };
            return Err(format!(
                "{at}: item {} is {}, which is not a member of {word}. It holds: {}.{hint}{early}",
                i + 1,
                describe(m),
                allowed.join(", ")
            ));
        };
        let rec = m.get(&keys[0])?.clone();
        let item_at = format!("{at}: {}", node_name(&member, &rec, i)?);
        if !VOCAB.valid_settings.contains_key(&member) {
            assert_known_attributes(&member, &rec, &item_at)?;
        }
        items.push(Item { member, rec, at: item_at });
    }
    Ok(items)
}

/// Members of a page or section, as the nodes the plugin draws. A section arrives built.
fn to_nodes(word: &str, list: &[Plain], at: &str) -> Result<Plain, String> {
    let nodes = members(word, list, at)?
        .into_iter()
        .map(|item| if item.member == "section" { Ok(item.rec) } else { to_node(&item.member, &item.rec, &item.at) })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Plain::List(nodes))
}

/// `board`, `page` and `section`: a list in brackets, then a settings chain.
fn container(word: &str, list: &Plain, settings: &Plain) -> Result<Plain, String> {
    let Plain::List(list) = list else {
        return Err(format!("{word}: expected a list in [brackets], e.g. {}.", example_of(word)));
    };
    if !is_record(settings) {
        return Err(format!(
            "{word}: needs its settings after the `]`, ending in a record — write `{{}}` when there are none, e.g. {}.",
            example_of(word)
        ));
    }
    let named = |container: &str| match settings.get("name") {
        Ok(name) if !name.is_undefined() => format!("{container} {}", stringify(name)),
        _ => container.to_owned(),
    };
    match word {
        // A titled area of a page holding nodes.
        "section" => {
            let at = named("section");
            assert_known_settings("section", settings, &at)?;
            let nodes = to_nodes("section", list, &at)?;
            let section = [("type".to_owned(), Plain::Str("section".to_owned()))]
                .into_iter()
                .chain(entries(settings))
                .chain([("nodes".to_owned(), nodes)]);
            Ok(object([("section", object(section))]))
        }
        // One page. Its name waits for the board, which knows how many pages there are.
        "page" => {
            let at = named("page");
            assert_known_settings("page", settings, &at)?;
            let nodes = to_nodes("page", list, &at)?;
            Ok(object([("page", object([("nodes", nodes), ("settings", settings.clone())]))]))
        }
        // The FigJam file.
        _ => {
            assert_known_settings("board", settings, "board")?;
            let pages: Vec<Plain> = members("board", list, "board")?.into_iter().map(|item| item.rec).collect();
            build_board(&pages, settings)
        }
    }
}

const PROGRAM_EXAMPLE: &str = "board [ page [ sticky text \"Hello\" {} ] {} ] {}";

/// The program is one board, and optionally one `save-to-figjam` statement in either order,
/// which adds the board's `fileKey`. Upstream data is never spread into the output: it is
/// exactly what this program compiled.
async fn prog(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Plain {
    let before = cx.error_count();
    let vals = top_level(cx, id, elts).await;
    if cx.error_count() > before {
        return Plain::Object(Default::default());
    }
    let boards: Vec<&Plain> =
        vals.iter().filter(|v| is_record(v) && v.get("type").ok().and_then(Plain::as_str) == Some("board")).collect();
    let saves: Vec<&Plain> = vals.iter().filter(|v| is_save_marker(v)).collect();
    let error = if boards.len() != 1 {
        let tail = if saves.is_empty() {
            ""
        } else {
            " save-to-figjam names where to draw it, and needs the board beside it."
        };
        Some(format!("A program is one board, ending in `..`: e.g. {PROGRAM_EXAMPLE}..{tail}"))
    } else if saves.len() > 1 {
        Some(
            "save-to-figjam is given twice. A board is drawn into one FigJam file: keep one save-to-figjam line."
                .to_owned(),
        )
    } else {
        None
    };
    if let Some(message) = error {
        cx.report_diagnostic(Diagnostic::new(message));
        return Plain::Object(Default::default());
    }
    let mut board = boards[0].as_object().cloned().unwrap_or_default();
    if let Some(save) = saves.first() {
        let key = save.get(&VOCAB.save_to_figjam.field).cloned().unwrap_or(Plain::Undefined);
        board.insert("fileKey".to_owned(), key);
    }
    Plain::Object(plain::js_order(board))
}

/// The value of every top-level expression, as L0000's `EXPRS` gives them to `PROG`: each in
/// order, or the one value of a parenthesized function applied to the rest.
async fn top_level(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Vec<Plain> {
    let ast = cx.ast();
    let Some(&exprs) = elts.first() else { return vec![arg(cx, id, elts, 0).await] };
    match ast.get(exprs) {
        Some(Node::Form { op: Op::Exprs, elts: items }) if items.is_empty() => vec![Plain::Str(String::new())],
        Some(Node::Form { op: Op::Exprs, elts: items }) if !(items.len() > 1 && is_function(ast, items[0])) => {
            let mut vals = Vec::with_capacity(items.len());
            for &item in items {
                vals.push(Plain::from_value(&cx.eval(item).await));
            }
            vals
        }
        _ => match arg(cx, id, elts, 0).await {
            Plain::List(items) if !matches!(ast.get(exprs), Some(Node::Form { op: Op::Exprs, .. })) => items,
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
