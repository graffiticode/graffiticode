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

/// A model's identity: the digest of its language, its kind and what it carries, together. Every
/// part changes its meaning, so none can change without the digest changing: a plan relabelled as a
/// value, or a model claimed for another language, no longer matches.
fn identity(lang: &str, kind: &str, carried: &Json) -> String {
    digest_of(&json!({ "lang": lang, "kind": kind, "carried": carried }))
}

impl Model {
    /// The model's JSON: `{ lang, kind, digest, value | program }`, where the digest identifies the
    /// whole model (see [`Model::digest`]).
    pub fn to_json(&self) -> Json {
        let digest = self.digest();
        match &self.kind {
            ModelKind::Value(value) => json!({ "lang": self.lang, "kind": "value", "digest": digest, "value": value }),
            ModelKind::Plan(program) => {
                json!({ "lang": self.lang, "kind": "plan", "digest": digest, "program": program })
            }
        }
    }

    /// The digest of the language, kind and payload together: what a cache or an admission binds.
    pub fn digest(&self) -> String {
        match &self.kind {
            ModelKind::Value(value) => identity(&self.lang, "value", value),
            ModelKind::Plan(program) => identity(&self.lang, "plan", program),
        }
    }

    /// Reads a model, checking its shape and digest. The error says why it isn't one.
    pub fn from_json(json: &Json) -> Result<Self, String> {
        let bad = |why: &str| format!("Error: not a model: {why}");
        let object = json.as_object().ok_or_else(|| bad("expected an object"))?;
        let lang = object.get("lang").and_then(Json::as_str).ok_or_else(|| bad("no lang"))?.to_owned();
        let digest = object.get("digest").and_then(Json::as_str).ok_or_else(|| bad("no digest"))?;
        let kind = match object.get("kind").and_then(Json::as_str) {
            Some("value") => {
                ModelKind::Value(object.get("value").ok_or_else(|| bad("a value model carries its value"))?.clone())
            }
            Some("plan") => {
                ModelKind::Plan(object.get("program").ok_or_else(|| bad("a plan model carries its program"))?.clone())
            }
            _ => return Err(bad("kind must be \"value\" or \"plan\"")),
        };
        let model = Self { lang, kind };
        if model.digest() != digest {
            return Err(bad("its digest doesn't match its language, kind and contents"));
        }
        Ok(model)
    }
}
