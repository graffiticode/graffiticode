// SPDX-License-Identifier: MIT

//! The extension point child languages build on.
//!
//! L0000 is the root of a tree of Graffiticode dialects. A child adds words to the lexicon
//! (see [`Lexicon::merge`](crate::Lexicon::merge)); each word's `name` is a node tag, and the
//! child's [`Dialect`] says what a node with that tag evaluates to. Everything the child does
//! not define is L0000.
//!
//! ```
//! use async_trait::async_trait;
//! use graffiticode_l0000::{Dialect, Evaluator, NodeId, Op, Value};
//!
//! struct Hello;
//!
//! #[async_trait]
//! impl Dialect for Hello {
//!     fn lang_id(&self) -> &str {
//!         "0001"
//!     }
//!
//!     async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
//!         match op.tag() {
//!             "HELLO" => {
//!                 let name = cx.eval_arg(id, elts, 0).await;
//!                 Some(Value::from(format!("hello, {}!", name.display())))
//!             }
//!             _ => None,
//!         }
//!     }
//! }
//! ```

use async_trait::async_trait;

use crate::ast::{Ast, NodeId, Op};
use crate::error::Diagnostic;
use crate::eval::Evaluator;
use crate::protected::ProtectedFunction;
use crate::value::Value;

#[async_trait]
pub trait Dialect: Send + Sync {
    /// The language id, e.g. `"0000"`.
    fn lang_id(&self) -> &str;

    /// Evaluates a node the kernel offers this dialect: every node whose tag the kernel does
    /// not define, and every kernel node whose operator [`overrides`](Self::overrides) claims.
    ///
    /// `None` declines. For a kernel operator that falls back to L0000's meaning; for any other
    /// tag it is a compile error, since nothing defines the node. Report errors through
    /// [`Evaluator::report`] and evaluate children with [`Evaluator::eval`].
    async fn eval(&self, _cx: &mut Evaluator<'_>, _id: NodeId, _op: &Op, _elts: &[NodeId]) -> Option<Value> {
        None
    }

    /// Whether this dialect redefines a kernel operator. Only claimed operators are offered to
    /// [`eval`](Self::eval), so the common case — a dialect that only adds words — costs the
    /// kernel's own nodes nothing.
    fn overrides(&self, _op: &Op) -> bool {
        false
    }

    /// Static checks beyond the kernel's, run before evaluation.
    fn check(&self, _ast: &Ast, _errors: &mut Vec<Diagnostic>) {}

    /// The protected function a node tag invokes, if any. See [`crate::protected`].
    fn protected_function(&self, _tag: &str) -> Option<&ProtectedFunction> {
        None
    }

    /// Protected functions every compile of this language performs without a node in the
    /// source. None of them may be a write.
    fn implicit_protected_functions(&self) -> &[ProtectedFunction] {
        &[]
    }
}

/// L0000 itself: the kernel with nothing added.
#[derive(Clone, Copy, Debug, Default)]
pub struct L0000;

impl Dialect for L0000 {
    fn lang_id(&self) -> &str {
        "0000"
    }
}
