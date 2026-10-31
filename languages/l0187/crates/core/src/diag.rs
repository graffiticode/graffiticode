// SPDX-License-Identifier: MIT

//! Classified diagnostics (design §11). Every L0187 error carries a `category` — what kind of
//! failure it is — and a `code` naming the rule it broke, beside its message and position.

use graffiticode_l0000::{Diagnostic, Span};

/// What kind of failure a diagnostic reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    /// The program is not valid L0187: fix the source.
    Source,
    /// Valid source whose content the target cannot hold at the requested readability.
    ContentLimit,
    /// Text the measurement profile cannot measure.
    Measurement,
    /// Valid source the layout could not place within its work budget: a compiler failure.
    Layout,
    /// A resource limit was reached.
    Resource,
    /// A required check could not be performed.
    Unverified,
}

impl Category {
    pub fn name(self) -> &'static str {
        match self {
            Category::Source => "source",
            Category::ContentLimit => "content-limit",
            Category::Measurement => "measurement",
            Category::Layout => "layout",
            Category::Resource => "resource",
            Category::Unverified => "unverified",
        }
    }
}

/// A diagnostic of `category` breaking rule `code`, at `span` when there is one.
pub fn diagnostic(category: Category, code: &str, message: impl Into<String>, span: Option<Span>) -> Diagnostic {
    Diagnostic { category: Some(category.name().to_owned()), ..Diagnostic::at(message, span).with_code(code) }
}

/// A source error.
pub fn source(code: &str, message: impl Into<String>, span: Option<Span>) -> Diagnostic {
    diagnostic(Category::Source, code, message, span)
}
