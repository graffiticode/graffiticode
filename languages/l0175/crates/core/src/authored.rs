// SPDX-License-Identifier: MIT

//! What a program authored, read out of the records its builder words assembled.
//!
//! A program is loose: any attribute may be missing, or hold a tag where text was expected.
//! Each field is read here once, into the form composition needs. The loose-to-text and
//! loose-to-number readings are JavaScript's, because the TypeScript compiler's results are
//! what authors and the generator's repair loop have learned.

use graffiticode_l0000::{NodeId, Number, Record, Value};

/// The key a wrapper word (`claim`, `source`, …) leaves on its record to say where in the
/// source the element was written, so an error about it can point there.
pub const NODE: &str = "\u{0}node";

static UNDEFINED: Value = Value::Undefined;

/// A value as text: a tag is its name, a missing value is empty, a number prints as itself.
pub fn text(value: &Value) -> String {
    match value {
        Value::Tag(name) => name.clone(),
        Value::Str(text) => text.clone(),
        Value::Undefined | Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Num(number) => number.display(),
        Value::List(items) => {
            let items: Vec<String> = items
                .iter()
                .map(|item| if matches!(item, Value::Tag(_)) { "[object Object]".to_owned() } else { text(item) })
                .collect();
            items.join(",")
        }
        Value::Record(record) => match find(record, "tag") {
            Value::Str(name) => name.clone(),
            _ => "[object Object]".to_owned(),
        },
        Value::Lambda(_) => "[object Object]".to_owned(),
    }
}

/// A value as a number, or NaN.
pub fn number(value: &Value) -> f64 {
    match value {
        Value::Num(number) => number.to_f64(),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        Value::Str(text) => match crate::text::trim(text) {
            "" => 0.0,
            "Infinity" | "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            digits if digits.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')) => {
                digits.parse().unwrap_or(f64::NAN)
            }
            _ => f64::NAN,
        },
        _ => f64::NAN,
    }
}

/// A record's field by name, whichever kind of key it was written with; the last one wins.
fn find<'a>(record: &'a Record, name: &str) -> &'a Value {
    record.iter().filter(|(key, _)| key.name() == name).last().map_or(&UNDEFINED, |(_, value)| value)
}

/// The fields of one authored element. Anything that is not a record has none.
#[derive(Clone, Copy)]
struct Fields<'a>(Option<&'a Record>);

impl<'a> Fields<'a> {
    fn of(value: &'a Value) -> Self {
        Fields(match value {
            Value::Record(record) => Some(record),
            _ => None,
        })
    }

    fn get(self, name: &str) -> &'a Value {
        self.0.map_or(&UNDEFINED, |record| find(record, name))
    }

    fn text(self, name: &str) -> String {
        text(self.get(name))
    }

    fn list(self, name: &str) -> Option<&'a [Value]> {
        match self.get(name) {
            Value::List(items) => Some(items),
            _ => None,
        }
    }

    /// A list field as text, or nothing if the field is not a list.
    fn texts(self, name: &str) -> Vec<String> {
        self.list(name).unwrap_or_default().iter().map(text).collect()
    }

    fn has(self, name: &str) -> bool {
        !matches!(self.get(name), Value::Undefined)
    }

    fn node(self) -> Option<NodeId> {
        match self.get(NODE) {
            Value::Num(Number::Float(id)) => Some(NodeId(*id as u32)),
            _ => None,
        }
    }
}

/// An element's id, and whether it was given one at all: only elements with an id can be
/// referred to.
#[derive(Debug, Default)]
pub struct Id {
    pub text: String,
    pub given: bool,
}

impl Id {
    fn read(fields: Fields<'_>) -> Self {
        Id { text: fields.text("id"), given: fields.has("id") }
    }
}

/// A candidate inference or conclusion: the correct answer to some question, or a foil.
#[derive(Debug)]
pub struct Claim {
    pub node: Option<NodeId>,
    pub id: Id,
    pub status: String,
    pub dimension: String,
    pub error_type: String,
    pub text: String,
    pub rationale: String,
    pub subject: String,
    pub standard: String,
    /// The evidence this claim cites.
    pub cites: Vec<String>,
    /// The questions a distractor foils, or `None` if it does not say.
    pub targets: Option<Vec<String>>,
    /// An author's override of how tempting a distractor is.
    pub plausibility: Value,
}

/// A piece of the passage offered as evidence.
#[derive(Debug)]
pub struct Source {
    pub node: Option<NodeId>,
    pub id: Id,
    pub status: String,
    pub quote: String,
    /// The passage line, as written.
    pub line: Value,
    /// The claims this evidence backs.
    pub supports: Vec<String>,
    pub rationale: String,
}

impl Source {
    /// The passage line this source points at, if it gave a number.
    pub fn line_number(&self) -> Option<f64> {
        match &self.line {
            Value::Num(number) => Some(number.to_f64()),
            _ => None,
        }
    }
}

/// One candidate meaning of a targeted word.
#[derive(Debug)]
pub struct Meaning {
    pub id: Id,
    pub status: String,
    pub text: String,
    pub error_type: String,
    pub rationale: String,
    pub standard: String,
}

/// A targeted word or phrase, with its candidate meanings.
#[derive(Debug)]
pub struct Word {
    pub node: Option<NodeId>,
    pub id: Id,
    pub text: String,
    pub line: Value,
    pub quote: String,
    pub targets: Vec<String>,
    pub meanings: Vec<Meaning>,
    /// Whether `meanings` was authored at all: a word with none is a click-the-word candidate.
    pub has_meanings: bool,
}

/// One question to compose.
#[derive(Debug)]
pub struct Outcome {
    pub node: Option<NodeId>,
    pub id: Id,
    /// The item type, authored or (once validated) inferred from the task model.
    pub kind: String,
    pub task_model: String,
    pub dimension: String,
    /// The companion standard, if one was authored.
    pub standard: Option<String>,
    /// The id of the correct answer; several for a multi-select over statements.
    pub focus: Vec<String>,
    pub stem: String,
    pub stem_b: String,
    pub subject: String,
    pub dok: String,
    /// Scoring bands for a constructed response: each a score and its descriptor.
    pub rubric: Vec<(f64, String)>,
}

/// Everything a program authored.
#[derive(Debug)]
pub struct Program {
    pub target: String,
    pub grade: f64,
    pub heading: String,
    /// The passage type, if the program states one.
    pub passage_type: Option<String>,
    pub lines: Vec<String>,
    pub claims: Vec<Claim>,
    pub sources: Vec<Source>,
    pub words: Vec<Word>,
    pub outcomes: Vec<Outcome>,
    pub title: String,
}

impl Program {
    /// Reads a program's value: the record its top-level chain assembled.
    pub fn read(top: &Value) -> Self {
        let fields = Fields::of(top);
        let each = |name: &str| fields.list(name).unwrap_or_default().iter().map(Fields::of);
        Program {
            target: fields.text("target"),
            grade: number(fields.get("grade")),
            heading: fields.text("passage"),
            passage_type: fields.has("type").then(|| fields.text("type")),
            lines: fields.texts("lines"),
            claims: each("claims").map(claim).collect(),
            sources: each("evidence").map(source).collect(),
            words: each("words").map(word).collect(),
            outcomes: each("outcomes").map(outcome).collect(),
            title: fields.text("title"),
        }
    }
}

fn claim(fields: Fields<'_>) -> Claim {
    Claim {
        node: fields.node(),
        id: Id::read(fields),
        status: fields.text("status"),
        dimension: fields.text("dimension"),
        error_type: fields.text("errorType"),
        text: fields.text("text"),
        rationale: fields.text("rationale"),
        subject: fields.text("subject"),
        standard: fields.text("standard"),
        cites: fields.texts("cites"),
        targets: fields.list("targets").map(|targets| targets.iter().map(text).collect()),
        plausibility: fields.get("plausibility").clone(),
    }
}

fn source(fields: Fields<'_>) -> Source {
    Source {
        node: fields.node(),
        id: Id::read(fields),
        status: fields.text("status"),
        quote: fields.text("quote"),
        line: fields.get("line").clone(),
        supports: fields.texts("supports"),
        rationale: fields.text("rationale"),
    }
}

fn word(fields: Fields<'_>) -> Word {
    Word {
        node: fields.node(),
        id: Id::read(fields),
        text: fields.text("text"),
        line: fields.get("line").clone(),
        quote: fields.text("quote"),
        targets: fields.texts("targets"),
        meanings: fields.list("meanings").unwrap_or_default().iter().map(Fields::of).map(meaning).collect(),
        has_meanings: fields.get("meanings").is_truthy(),
    }
}

fn meaning(fields: Fields<'_>) -> Meaning {
    Meaning {
        id: Id::read(fields),
        status: fields.text("status"),
        text: fields.text("text"),
        error_type: fields.text("errorType"),
        rationale: fields.text("rationale"),
        standard: fields.text("standard"),
    }
}

fn outcome(fields: Fields<'_>) -> Outcome {
    let focus = match fields.get("focus") {
        Value::List(ids) => ids.iter().map(text).collect(),
        one => vec![text(one)],
    };
    let band = |band: &Value| {
        let band = Fields::of(band);
        (number(band.get("score")), band.text("descriptor"))
    };
    Outcome {
        node: fields.node(),
        id: Id::read(fields),
        kind: fields.text("type"),
        task_model: fields.text("taskModel"),
        dimension: fields.text("dimension"),
        standard: fields.has("standard").then(|| fields.text("standard")),
        focus: focus.into_iter().filter(|id| !id.is_empty()).collect(),
        stem: fields.text("stem"),
        stem_b: fields.text("stemB"),
        subject: fields.text("subject"),
        dok: fields.text("dok"),
        rubric: fields.list("rubric").unwrap_or_default().iter().map(band).collect(),
    }
}
