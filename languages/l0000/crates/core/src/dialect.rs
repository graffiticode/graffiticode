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

use std::borrow::Cow;

use async_trait::async_trait;
use serde_json::Value as Json;

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

    /// The protected functions this language's words invoke, each with the node tag that
    /// invokes it. See [`crate::protected`].
    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &[]
    }

    /// Protected functions every compile of this language performs without a node in the
    /// source. None of them may be a write.
    fn implicit_protected_functions(&self) -> &[ProtectedFunction] {
        &[]
    }

    /// Turns a stored program into the one that executes (a language that lowers a legacy
    /// form does it here). Compile and preflight both apply it, so they agree on what runs.
    fn normalize<'a>(&self, code: &'a Json) -> Result<Cow<'a, Json>, String> {
        Ok(Cow::Borrowed(code))
    }

    /// The registry version this language's protected declarations were written for. A
    /// language with protected functions must say; one with none is version 0.
    fn registry_version(&self) -> Option<u32> {
        None
    }

    /// Whether this language's protected behaviour cannot be found by scanning a program. Such
    /// a language can never run in an admitted plan.
    fn undeclarable_protected(&self) -> bool {
        false
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
