// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

use crate::ast::Span;

/// A compile error as it appears on the wire: `from`/`to` are source offsets, `-1` when the
/// error has no position.
///
/// An error may carry structured fields beside its message: a refusal's reason as `code`, its
/// category, the stage, and the protected function and step that failed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub message: String,
    pub from: i64,
    pub to: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, rename = "fn", skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
}

impl Diagnostic {
    pub fn new(message: impl Into<String>) -> Self {
        Self::spanning(message, -1, -1)
    }

    pub fn spanning(message: impl Into<String>, from: i64, to: i64) -> Self {
        Self { message: message.into(), from, to, ..Self::default() }
    }

    pub fn at(message: impl Into<String>, span: Option<Span>) -> Self {
        match span {
            Some(Span { from, to }) => Self::spanning(message, from.into(), to.into()),
            None => Self::new(message),
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_fields_appear_only_when_set() {
        let plain = Diagnostic::spanning("Too few arguments", 0, 3);
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "message": "Too few arguments", "from": 0, "to": 3 })
        );

        let refusal = Diagnostic {
            code: Some("authorization-denied:not-granted".into()),
            category: Some("permission".into()),
            stage: Some("s0".into()),
            function: Some("save-it".into()),
            step: Some("items".into()),
            ..Diagnostic::new("Item bank save partial")
        };
        assert_eq!(
            serde_json::to_value(&refusal).unwrap(),
            serde_json::json!({
                "message": "Item bank save partial", "from": -1, "to": -1,
                "code": "authorization-denied:not-granted", "category": "permission",
                "stage": "s0", "fn": "save-it", "step": "items",
            })
        );
    }
}
