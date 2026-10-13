// SPDX-License-Identifier: MIT

//! L0000 — the root Graffiticode language, and the kernel its dialects build on.
//!
//! A Graffiticode language server receives a program as the parser's AST and compiles it to a
//! JSON data model. [`Compiler`] does that for one language:
//!
//! ```
//! use graffiticode_l0000::{Ast, Compiler, Identity, L0000, Value};
//! use serde_json::json;
//!
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! // `add 1 2..`
//! let ast = Ast::from_json(&json!({
//!     "1": { "tag": "NUM", "elts": ["1"] },
//!     "2": { "tag": "NUM", "elts": ["2"] },
//!     "3": { "tag": "ADD", "elts": [1, 2] },
//!     "4": { "tag": "EXPRS", "elts": [3] },
//!     "5": { "tag": "PROG", "elts": [4] },
//!     "root": 5,
//! }))
//! .unwrap();
//! let value = Compiler::new(L0000).compile(&ast, &json!({}), &json!({}), Identity::default()).await;
//! assert_eq!(value, Ok(Value::Num(3.0)));
//! # });
//! ```
//!
//! A child language implements [`Dialect`] for the words it adds and hands that to
//! [`Compiler::new`] instead; see the [`dialect`] module.

pub mod ast;
pub mod canonical;
pub mod check;
mod compiler;
pub mod dialect;
mod error;
mod eval;
pub mod exec;
pub mod lexicon;
pub mod number;
#[cfg(feature = "http")]
pub mod policy_client;
pub mod protected;
pub mod schema;
pub mod secret;
pub mod value;

pub use ast::{Ast, AstError, Node, NodeId, Op, Span};
pub use compiler::Compiler;
pub use dialect::{Dialect, L0000};
pub use error::Diagnostic;
pub use eval::{Eval, Evaluator};
pub use exec::{ExecContext, Identity};
pub use lexicon::{Lexicon, LexiconEntry, LexiconError};
pub use protected::{
    PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError, ProtectedFunction, ProtectedKind, SnapshotRequest,
};
pub use schema::{LanguageSchema, NoSchemas, SchemaError, SchemaSource};
pub use secret::Keyring;
pub use value::{Key, Lambda, Record, Value};
