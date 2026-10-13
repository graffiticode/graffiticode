// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

use crate::ast::Span;

/// A compile error as it appears on the wire: `from`/`to` are source offsets, `-1` when the
/// error has no position.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub message: String,
    pub from: i64,
    pub to: i64,
}

impl Diagnostic {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), from: -1, to: -1 }
    }

    pub fn at(message: impl Into<String>, span: Option<Span>) -> Self {
        match span {
            Some(Span { from, to }) => Self { message: message.into(), from: from.into(), to: to.into() },
            None => Self::new(message),
        }
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
