// SPDX-License-Identifier: MIT

//! Compiled models and the interpreter pass (docs/graffiticode-interpreter-design.md §4–§5;
//! docs/graffiticode-interpreter-plan.md, B1).
//!
//! A task compiles on its own into a [`Model`]; a language then interprets its model against the
//! previous stage's resolved data. Two kinds:
//!
//! - a **value** model is already fully evaluated: the language declared the program independent
//!   of its input and it has no protected functions, so its value is the same for any input.
//!   Interpreting it is identity.
//! - a **plan** model is everything else. It carries the stored source program, so interpreting it
//!   against an input is exactly today's compile of that program with that input.
//!
//! Nothing routes to the interpreter yet: `POST /compile` answers today's envelope unless the
//! request asks for `"form": "model"`, and `POST /interpret` is new.

use serde_json::{Value as Json, json};

use crate::preflight::digest_of;

/// A compiled model, as `/compile` returns it with `"form": "model"` and `/interpret` accepts it.
#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    /// The language that produced it.
    pub lang: String,
    pub kind: ModelKind,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelKind {
    /// The program's value, the same for every input.
    Value(Json),
    /// The stored source program (the parser's AST as JSON), evaluated against each input.
    Plan(Json),
}

/// What a result is for: data for the next stage of a chain, or what the final consumer gets.
/// The API sets it, never the language (design §5, rule 2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Evaluate,
    Present,
}

impl Mode {
    pub fn from_json(json: &Json) -> Result<Self, String> {
        match json {
            Json::Null => Ok(Self::Evaluate),
            Json::String(mode) if mode == "evaluate" => Ok(Self::Evaluate),
            Json::String(mode) if mode == "present" => Ok(Self::Present),
            _ => Err("mode must be \"evaluate\" or \"present\"".to_owned()),
        }
    }
}

impl Model {
    /// The model's JSON: `{ lang, kind, digest, value | program }`. The digest is of what it
    /// carries, so a model can't be edited without its digest disagreeing.
    pub fn to_json(&self) -> Json {
        match &self.kind {
            ModelKind::Value(value) => {
                json!({ "lang": self.lang, "kind": "value", "digest": digest_of(value), "value": value })
            }
            ModelKind::Plan(program) => {
                json!({ "lang": self.lang, "kind": "plan", "digest": digest_of(program), "program": program })
            }
        }
    }

    /// Reads a model, checking its shape and digest. The error says why it isn't one.
    pub fn from_json(json: &Json) -> Result<Self, String> {
        let bad = |why: &str| format!("Error: not a model: {why}");
        let object = json.as_object().ok_or_else(|| bad("expected an object"))?;
        let lang = object.get("lang").and_then(Json::as_str).ok_or_else(|| bad("no lang"))?.to_owned();
        let digest = object.get("digest").and_then(Json::as_str).ok_or_else(|| bad("no digest"))?;
        let (kind, carried) = match object.get("kind").and_then(Json::as_str) {
            Some("value") => {
                let value = object.get("value").ok_or_else(|| bad("a value model carries its value"))?;
                (ModelKind::Value(value.clone()), value)
            }
            Some("plan") => {
                let program = object.get("program").ok_or_else(|| bad("a plan model carries its program"))?;
                (ModelKind::Plan(program.clone()), program)
            }
            _ => return Err(bad("kind must be \"value\" or \"plan\"")),
        };
        if digest_of(carried) != digest {
            return Err(bad("its digest doesn't match what it carries"));
        }
        Ok(Self { lang, kind })
    }
}
