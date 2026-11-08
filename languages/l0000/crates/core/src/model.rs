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
use sha2::{Digest, Sha256};

use crate::value::json_text;

/// A compiled model, as `/compile` returns it with `"form": "model"` and `/interpret` accepts it.
#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    /// The language that produced it.
    pub lang: String,
    pub kind: ModelKind,
    /// The effect intents a `start` of this model may execute (B5, docs/b5-commands-plan.md §4).
    /// Empty for a model with none, which is then serialized and digested exactly as before.
    pub intents: Vec<Intent>,
}

/// One effect a command may perform: a protected function and operation, with the occurrence
/// ids it may run as. A static intent lists them; a runtime-expanded one names an upper bound,
/// and each occurrence is an expansion of it ([`crate::ExecContext::expand`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub id: String,
    pub function: String,
    pub op: String,
    /// Static occurrence ids (`<key>.<N>`). Empty for a runtime-expanded intent.
    pub occurrences: Vec<String>,
    /// A runtime-expanded intent's most occurrences. `None` for a static one.
    pub max_occurrences: Option<u32>,
    /// The connection it acts on, when it names one.
    pub scope: Option<String>,
}

impl Intent {
    /// A static intent: these occurrences and no others.
    pub fn fixed(
        id: impl Into<String>,
        function: impl Into<String>,
        op: impl Into<String>,
        occurrences: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            function: function.into(),
            op: op.into(),
            occurrences,
            max_occurrences: None,
            scope: None,
        }
    }

    /// A runtime-expanded intent of at most `max` occurrences.
    pub fn expanding(id: impl Into<String>, function: impl Into<String>, op: impl Into<String>, max: u32) -> Self {
        Self {
            id: id.into(),
            function: function.into(),
            op: op.into(),
            occurrences: Vec::new(),
            max_occurrences: Some(max),
            scope: None,
        }
    }

    pub fn is_runtime(&self) -> bool {
        self.max_occurrences.is_some()
    }

    /// Policy's shape for it (packages/policy/src/policy.ts, `modelIntents`).
    pub fn to_json(&self) -> Json {
        let mut json = json!({ "id": self.id, "fn": self.function, "op": self.op });
        match self.max_occurrences {
            Some(max) => {
                json["runtime"] = true.into();
                json["bounds"] = json!({ "maxOccurrences": max });
            }
            None => json["occurrences"] = json!(self.occurrences),
        }
        if let Some(scope) = &self.scope {
            json["scope"] = scope.clone().into();
        }
        json
    }

    pub fn from_json(json: &Json) -> Result<Self, String> {
        let text = |name: &str| {
            json.get(name).and_then(Json::as_str).map(str::to_owned).ok_or_else(|| format!("an intent needs {name}"))
        };
        let runtime = json.get("runtime") == Some(&Json::Bool(true));
        let max_occurrences = if runtime {
            let max = json["bounds"]["maxOccurrences"]
                .as_u64()
                .filter(|max| *max >= 1)
                .ok_or("a runtime intent needs bounds.maxOccurrences")?;
            Some(u32::try_from(max).map_err(|_| "bounds.maxOccurrences is too large")?)
        } else {
            None
        };
        let occurrences = if runtime {
            Vec::new()
        } else {
            json.get("occurrences")
                .and_then(Json::as_array)
                .and_then(|list| list.iter().map(|o| o.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>())
                .ok_or("a static intent lists its occurrences")?
        };
        let scope = json.get("scope").and_then(Json::as_str).map(str::to_owned);
        Ok(Self { id: text("id")?, function: text("fn")?, op: text("op")?, occurrences, max_occurrences, scope })
    }
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
///
/// The digest is of the exact JSON text, key order included. A result's text follows its model's
/// key order (an L0186 connector's attributes come out in the order its program gave them), so two
/// models equal up to key order are different models. Until 2026-11-07 the digest was key-sorted,
/// and the B5 drive found the API's stage cache serving two such L0186 programs each other's
/// answers (the API keys exactly since #296; admission binds this digest, B5). The key-sorted
/// digest was still accepted through the rollout; since B5 slice 4b it is refused.
///
/// A model's intents join the digest only when it has some, so a model without any keeps the
/// digest it always had (decision 5 of the B5 plan): what a `start` may execute is bound into what
/// admission binds.
fn identity(lang: &str, kind: &str, carried: &Json, intents: &[Intent]) -> String {
    let mut whole = json!({ "lang": lang, "kind": kind, "carried": carried });
    if !intents.is_empty() {
        whole["intents"] = intents.iter().map(Intent::to_json).collect();
    }
    hex::encode(Sha256::digest(json_text(&whole)))
}

impl Model {
    /// A model with no intents.
    pub fn new(lang: impl Into<String>, kind: ModelKind) -> Self {
        Self { lang: lang.into(), kind, intents: Vec::new() }
    }

    /// The model's JSON: `{ lang, kind, digest, value | program }`, where the digest identifies the
    /// whole model (see [`Model::digest`]).
    pub fn to_json(&self) -> Json {
        let digest = self.digest();
        let mut json = match &self.kind {
            ModelKind::Value(value) => json!({ "lang": self.lang, "kind": "value", "digest": digest, "value": value }),
            ModelKind::Plan(program) => {
                json!({ "lang": self.lang, "kind": "plan", "digest": digest, "program": program })
            }
        };
        // Omitted when empty, so a model without intents has exactly the text it always had.
        if !self.intents.is_empty() {
            json["intents"] = self.intents.iter().map(Intent::to_json).collect();
        }
        json
    }

    /// The digest of the language, kind and payload together: what a cache or an admission binds.
    pub fn digest(&self) -> String {
        match &self.kind {
            ModelKind::Value(value) => identity(&self.lang, "value", value, &self.intents),
            ModelKind::Plan(program) => identity(&self.lang, "plan", program, &self.intents),
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
        let intents = match object.get("intents") {
            None => Vec::new(),
            Some(Json::Array(list)) => {
                list.iter().map(Intent::from_json).collect::<Result<_, _>>().map_err(|why| bad(&why))?
            }
            Some(_) => return Err(bad("intents must be a list")),
        };
        let model = Self { lang, kind, intents };
        if model.digest() != digest {
            return Err(bad("its digest doesn't match its language, kind and contents"));
        }
        Ok(model)
    }
}
