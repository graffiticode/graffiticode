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
//! [`lexicon`] is derived from it.

pub mod lexicon;
pub mod vocab;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Dialect, Evaluator, NodeId, Op, Value};

pub use crate::lexicon::lexicon;

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

    async fn eval(&self, _cx: &mut Evaluator<'_>, _id: NodeId, _op: &Op, _elts: &[NodeId]) -> Option<Value> {
        None
    }
}
