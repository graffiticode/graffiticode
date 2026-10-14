// SPDX-License-Identifier: MIT

//! L0182 — surveys: ranked choice and rating scales. A program names the survey being taken
//! and, once something has answered, carries the response to it:
//!
//! ```text
//! survey [
//!   id "team-retro"
//!   session-id get-val-public "itemId"
//!   response [ choices ["fix the flaky tests before adding features"] write-in "…" ]
//! ]..
//! ```
//!
//! What the survey asks — its options or items, scales, wording and bounds — is not in the
//! program: the compiler reads it from the installed surveys (`source.rs`). Every word is an
//! attribute that evaluates to a one-key record; `survey`, `response` and each `ratings` entry
//! merge a list of them. All checking happens where a value is used.

pub mod attributes;
pub mod js;
pub mod ranked;
pub mod rating;
pub mod resolve;
pub mod scales;
pub mod source;
pub mod survey;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use graffiticode_l0000::{Diagnostic, Dialect, Evaluator, Lexicon, NodeId, Op, Value};

use crate::attributes::{VOCAB, check_value};
use crate::js::{Js, Obj};
use crate::source::{Files, SurveySource};

/// The words L0182 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0182")).expect("L0182 redefines no base word")
});

/// L0182's vocabulary: the base lexicon with the survey words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The dialect, holding the source it reads surveys from. The default reads the installed
/// surveys and draws versions at random; `with_source` is the seam the TypeScript calls
/// `setSource`.
#[derive(Clone)]
pub struct L0182 {
    source: Arc<dyn SurveySource>,
}

impl Default for L0182 {
    fn default() -> Self {
        L0182::with_source(Files::default())
    }
}

impl L0182 {
    pub fn with_source(source: impl SurveySource + 'static) -> Self {
        L0182 { source: Arc::new(source) }
    }
}

fn record(field: &str, value: Js) -> Value {
    Js::Obj(Obj::from([(field.to_owned(), value)])).to_value()
}

fn empty() -> Value {
    Js::Obj(Obj::new()).to_value()
}

/// Reports a failed word and stands in the empty record for it, so the enclosing list merges
/// nothing and the compile goes on to report everything else.
fn refuse(cx: &mut Evaluator<'_>, message: String) -> Value {
    cx.report_diagnostic(Diagnostic::new(message));
    empty()
}

#[async_trait]
impl Dialect for L0182 {
    fn lang_id(&self) -> &str {
        "0182"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if tag == "SURVEY" {
            let raw = Js::from_value(&cx.eval_arg(id, elts, 0).await);
            let asked = match survey::read_survey_attributes(&raw) {
                Ok(asked) => asked,
                Err(message) => return Some(refuse(cx, message)),
            };
            let built = self
                .source
                .load(&asked.id, asked.session.as_deref())
                .and_then(|loaded| survey::build_survey(&asked, &loaded));
            return Some(match built {
                Ok(compiled) => compiled.to_value(),
                Err(message) => refuse(cx, message),
            });
        }
        if tag == "RESPONSE" {
            let raw = Js::from_value(&cx.eval_arg(id, elts, 0).await);
            return Some(match survey::build_response(&raw) {
                Ok(response) => record("response", response),
                Err(message) => refuse(cx, message),
            });
        }
        let row = VOCAB.attributes.get(tag)?;
        let raw = Js::from_value(&cx.eval_arg(id, elts, 0).await);
        Some(match check_value(tag, row, &raw) {
            Some(message) => refuse(cx, message),
            None => record(&row.field, raw),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lexicon_carries_every_word() {
        for word in
            ["survey", "response", "id", "session-id", "choices", "write-in", "ratings", "item", "rating", "comment"]
        {
            assert!(lexicon().get(word).is_some(), "{word}");
        }
    }
}
