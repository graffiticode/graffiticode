// SPDX-License-Identifier: MIT

//! L0175 — a language for composing Grade 5 ELA assessment items (Smarter Balanced, Claim 1).
//!
//! A program names a learning target, then authors a superset of tagged content — a passage,
//! candidate `claim`s, evidence `source`s — and one or more `outcome`s, the questions to ask.
//! Compiling selects, for each outcome, the content that fits best and assembles a finished
//! item: an EBSR, a Hot Text, a Multiple Choice, a Multi-Select or a Short Text.
//!
//! ```text
//! target c1-t4 passage "The Tide Pool" type literary lines ["Mara crouched at the edge …" …]
//! claims [
//!   claim id "c1" status supported dimension character text "Mara cares more about …" cites ["e1"] {},
//!   claim id "c2" status distractor error-type misreads-detail targets ["q1"] text "…" rationale "…" {}
//! ]
//! evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
//! outcomes [ outcome id "q1" task-model tm1 dimension character focus "c1" stem "…" stem-b "…" {} ]
//! {}..
//! ```
//!
//! The words are builders. An attribute word takes a value and the rest of its chain and
//! returns the rest with one more field; `claim`, `source`, `outcome`, `word`, `meaning` and
//! `band` each close an element's chain. The program's value is then composed: see [`compose`].
//!
//! - [`targets`] — what each learning target allows.
//! - [`authored`] — a program's content, read from the records the builders made.
//! - [`compose`] — validation and item assembly.
//! - [`text`] — the text measures composition rests on.

pub mod authored;
pub mod compose;
pub mod targets;
pub mod text;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Key, Lexicon, NodeId, Number, Op, Record, Value};

use crate::authored::{NODE, Program};

/// The words L0175 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0175")).expect("L0175 redefines no base word")
});

/// L0175's vocabulary: the base lexicon with the item-composition words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The field each attribute word sets, by node tag. The collection words (`claims`,
/// `evidence`, …) are attributes too: their value is a list of elements.
const ATTRIBUTES: [(&str, &str); 35] = [
    ("ID", "id"),
    ("STATUS", "status"),
    ("DIMENSION", "dimension"),
    ("ERROR_TYPE", "errorType"),
    ("TEXT", "text"),
    ("RATIONALE", "rationale"),
    ("CITES", "cites"),
    ("TARGETS", "targets"),
    ("LINE", "line"),
    ("QUOTE", "quote"),
    ("SUPPORTS", "supports"),
    ("TYPE", "type"),
    ("TASK_MODEL", "taskModel"),
    ("SUBJECT", "subject"),
    ("STANDARD", "standard"),
    ("FOCUS", "focus"),
    ("PASSAGE", "passage"),
    ("LINES", "lines"),
    ("TITLE", "title"),
    ("TARGET", "target"),
    ("GRADE", "grade"),
    ("STEM", "stem"),
    ("RUBRIC", "rubric"),
    ("DOK", "dok"),
    ("PLAUSIBILITY", "plausibility"),
    ("MODE", "mode"),
    ("OTHER", "other"),
    ("STEM_B", "stemB"),
    ("SCORE", "score"),
    ("DESCRIPTOR", "descriptor"),
    ("CLAIMS", "claims"),
    ("EVIDENCE", "evidence"),
    ("OUTCOMES", "outcomes"),
    ("WORDS", "words"),
    ("MEANINGS", "meanings"),
];

/// The words that close an element's chain.
const ELEMENTS: [&str; 6] = ["CLAIM", "SOURCE", "OUTCOME", "BAND", "WORD", "MEANING"];

#[derive(Clone, Copy, Debug, Default)]
pub struct L0175;

#[async_trait]
impl Dialect for L0175 {
    fn lang_id(&self) -> &str {
        "0175"
    }

    fn overrides(&self, op: &Op) -> bool {
        matches!(op, Op::Prog)
    }

    /// An item is composed from its program alone; no L0175 word reads the input, so a program
    /// the kernel finds doesn't read it (no `data`, no `get-var` that may name it) compiles to a
    /// value model (interpreter plan C1).
    fn input_independent(&self, ast: &Ast) -> bool {
        !ast.reads_input()
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if let Some((_, field)) = ATTRIBUTES.iter().find(|(word, _)| *word == tag) {
            let value = cx.eval_arg(id, elts, 0).await;
            let rest = cx.eval_arg(id, elts, 1).await;
            return Some(with(rest, field, value));
        }
        if ELEMENTS.contains(&tag) {
            // The element is the record its chain built. Where it was written goes with it, so
            // an error about it can point at it.
            let mut element = cx.eval_arg(id, elts, 0).await;
            if let Value::Record(record) = &mut element {
                let at = if cx.ast().span(id).is_some() { Some(id) } else { elts.first().copied() };
                if let Some(at) = at {
                    record.insert(Key::tag(NODE), Value::Num(Number::Float(f64::from(at.0))));
                }
            }
            return Some(element);
        }
        if *op != Op::Prog {
            return None;
        }
        let top = cx.eval_kernel(id).await;
        let (value, problems) = compose::compose(Program::read(&top));
        for problem in problems {
            match problem.at {
                Some(at) => cx.report(at, problem.message),
                None => cx.report_diagnostic(Diagnostic::new(problem.message)),
            }
        }
        Some(Value::from_json(&value))
    }
}

/// The rest of a chain with one more field set. A rest that is not a record is an empty one.
fn with(rest: Value, field: &str, value: Value) -> Value {
    let mut record: Record = match rest {
        Value::Record(record) => {
            record.into_iter().map(|(key, value)| (Key::tag(key.name().into_owned()), value)).collect()
        }
        _ => Record::new(),
    };
    record.insert(Key::tag(field), value);
    Value::Record(record)
}
