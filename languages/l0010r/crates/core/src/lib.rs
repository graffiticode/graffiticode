// SPDX-License-Identifier: MIT

//! L0010 — the composition-planning dialect. It inherits the whole base language and adds one
//! word: `plan ["0158" "0166"]` evaluates to `{ langs: ["0158", "0166"] }`, the ordered sequence
//! of languages a request is composed from (head first; each consumes the next). One id is an
//! atomic plan; an empty list is no composition.

use std::collections::HashSet;
use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Key, Lexicon, Node, NodeId, Op, Value};

/// The most languages a plan may chain.
pub const MAX_STAGES: usize = 4;

/// The word L0010 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0010")).expect("L0010 shadows no base word")
});

/// L0010's vocabulary: the base lexicon and `plan`.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// A language id is three to five digits: `"0158"`.
pub fn is_language_id(text: &str) -> bool {
    (3..=5).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0010;

#[async_trait]
impl Dialect for L0010 {
    fn lang_id(&self) -> &str {
        "0010"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        if op.tag() != "PLAN" {
            return None;
        }
        let langs = match cx.eval_arg(id, elts, 0).await {
            Value::List(langs) => langs.iter().map(|lang| Value::Str(lang.display())).collect(),
            _ => Vec::new(),
        };
        Some(Value::Record([(Key::tag("langs"), Value::List(langs))].into_iter().collect()))
    }

    /// A plan is written out: a list of language-id strings, none twice, at most
    /// [`MAX_STAGES`]. A bad plan is rejected, not trimmed, so its author sees the problem.
    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        for (id, node) in ast.reachable() {
            let Node::Form { op: Op::Dialect(tag), elts } = node else { continue };
            if &**tag != "PLAN" {
                continue;
            }
            let arg = elts.first().and_then(|&arg| ast.get(arg));
            let Some(Node::Form { elts: stages, .. }) = arg else {
                let at = elts.first().and_then(|&arg| ast.span(arg)).or(ast.span(id));
                errors.push(Diagnostic::at("plan: each element must be a language id string.", at));
                continue;
            };
            let mut seen = HashSet::new();
            for &stage in stages {
                let at = ast.span(stage).or(ast.span(id));
                let problem = match ast.get(stage) {
                    Some(Node::Str(lang)) if !is_language_id(lang) => format!("plan: \"{lang}\" is not a language id."),
                    Some(Node::Str(lang)) if !seen.insert(lang.as_str()) => {
                        format!("plan: duplicate language \"{lang}\".")
                    }
                    Some(Node::Str(_)) => continue,
                    _ => "plan: each element must be a language id string.".to_owned(),
                };
                errors.push(Diagnostic::at(problem, at));
            }
            if stages.len() > MAX_STAGES {
                errors.push(Diagnostic::at(format!("plan: at most {MAX_STAGES} stages."), ast.span(id)));
            }
        }
    }
}
