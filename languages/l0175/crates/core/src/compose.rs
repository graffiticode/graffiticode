// SPDX-License-Identifier: MIT

//! Composition: from a program's superset of tagged content to finished assessment items.
//!
//! A program authors more than any one item uses — candidate claims, evidence sources, and for
//! each question (an `outcome`) which claim is correct. For each outcome this selects the
//! content that fits best and assembles the item. It is deterministic: no model, and the same
//! program always yields the same items with the same option labels.
//!
//! Two kinds of finding come out of it. A [`Problem`] is a mistake in the program — a value
//! outside its vocabulary, a required field missing, a reference to nothing — and fails the
//! compile. A warning is a compromise composition had to make (a thin pool of distractors, a
//! stem that gives the answer away); it rides on the item, for an author or the generator's
//! repair loop to act on.
//!
//! The items, their field order and every message are held to the TypeScript compiler's.

use std::collections::{HashMap, HashSet, VecDeque};

use graffiticode_l0000::{NodeId, Number, Value};
use indexmap::IndexSet;
use serde_json::{Map, Value as Json, json};

use crate::authored::{Claim, Meaning, Outcome, Program, Source, Word};
use crate::targets::{AnswerKind, DEFAULT, Target, targets};
use crate::text::{self, norm};

/// A mistake in the program, at the element it concerns when that is known.
#[derive(Debug, PartialEq)]
pub struct Problem {
    pub at: Option<NodeId>,
    pub message: String,
}

// Hand-tuned thresholds, kept together for later calibration against response data.

/// Fewer distinct distractors than this bound to a question, and selection has no real choice.
const MIN_VIABLE_DISTRACTORS: usize = 5;
/// Fewer Part B foil sources than this, and the best three cannot be chosen.
const MIN_VIABLE_PART_B: usize = 5;
/// Foils chosen per item.
const DISTRACTOR_SLOTS: usize = 3;
/// Options per part of an EBSR item, and in a Multiple Choice item.
const PART_OPTIONS: usize = 4;
/// Options in a Multi-Select item: the correct set and its distractors.
const MULTI_SELECT_OPTIONS: usize = 6;
/// The most sentences a Hot Text item asks for.
const HOT_TEXT_SELECT_MAX: usize = 3;
/// A constructed response wants at least this many passage paragraphs.
const SHORT_TEXT_MIN_LINES: usize = 3;
/// A correct option this many times the mean distractor length gives itself away.
const LENGTH_BALANCE_RATIO: f64 = 1.35;
/// How many grades above its target a passage may read before it is flagged.
const GRADE_LEVEL_TOLERANCE: f64 = 1.5;
/// A stem sharing this fraction of the correct option's content words gives it away …
const STEM_GIVEAWAY_RATIO: f64 = 0.5;
/// … if it shares at least this many.
const STEM_GIVEAWAY_MIN: usize = 4;

const LABELS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];
const LEAD_IN: &str = "This question has two parts. First, answer Part A. Then, answer Part B.";
const HOT_TEXT_PART_B: &str = "Click the sentence(s) from the passage that support your answer in Part A.";

/// How tempting each kind of error is, before anything is known about the distractor.
fn error_type_prior(error_type: &str) -> f64 {
    match error_type {
        "faulty-reasoning" | "too-narrow" => 0.1,
        "erroneous-inference" => 0.08,
        "too-broad" => 0.07,
        "misreads-detail" | "insignificant" => 0.05,
        _ => 0.0,
    }
}

fn scoring(kind: &str) -> &'static str {
    match kind {
        "short-text" => "0–2 points; hand-scored against the rubric.",
        "multiple-choice" => "Correct option = 1 point; otherwise 0.",
        "multi-select" => "All correct selections (and no others) = 1 point; otherwise 0.",
        _ => "Both parts correct = 1 point; otherwise 0.",
    }
}

/// A number as JSON: an integer without a fraction, and nothing for a value JSON cannot hold.
fn num(n: f64) -> Json {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        Json::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number)
    }
}

struct Passage {
    id: String,
    heading: String,
    kind: String,
    lines: Vec<String>,
}

impl Passage {
    /// The text of a numbered line, lines being numbered from one.
    fn line(&self, number: &Value) -> Option<&str> {
        let Value::Num(number) = number else { return None };
        let number = number.to_f64();
        (number.fract() == 0.0 && number >= 1.0)
            .then(|| self.lines.get(number as usize - 1))
            .flatten()
            .map(String::as_str)
    }

    fn to_json(&self) -> Json {
        let lines: Vec<Json> =
            self.lines.iter().enumerate().map(|(i, text)| json!({ "id": i + 1, "text": text })).collect();
        json!({ "id": self.id, "heading": self.heading, "type": self.kind, "lines": lines })
    }
}

/// A program's content, indexed for composition.
struct Context<'a> {
    passage: Passage,
    target: &'static Target,
    claims: &'a [Claim],
    sources: &'a [Source],
    words: &'a [Word],
    outcomes: &'a [Outcome],
    claim_by_id: HashMap<&'a str, &'a Claim>,
    source_by_id: HashMap<&'a str, &'a Source>,
    word_by_id: HashMap<&'a str, &'a Word>,
    outcome_ids: HashSet<&'a str>,
}

/// Composes a program: its item, or its items when it asks more than one question, and the
/// problems that fail it. The value is only meaningful when there are no problems.
pub fn compose(mut program: Program) -> (Json, Vec<Problem>) {
    let mut problems = Vec::new();
    let all = targets();
    // The target shapes validation and the standards. A missing or unknown one falls back, so
    // the rest of the program is still checked.
    let known = all.get(&program.target);
    let target = known.unwrap_or(all.default_target());
    let grade = if program.grade > 0.0 { program.grade } else { target.grade };
    let passage_type = program.passage_type.clone().unwrap_or_else(|| target.text_type.clone());
    let every_target = || all.ids().collect::<Vec<_>>();

    let mut fail = |message: String| problems.push(Problem { at: None, message });
    if !program.target.is_empty() && known.is_none() {
        fail(format!("unknown target '{}'. Expected one of: {}.", program.target, every_target().join(", ")));
    }
    if !passage_type.is_empty() && !matches!(passage_type.as_str(), "literary" | "informational") {
        fail(format!("Unknown passage type '{passage_type}'. Expected one of: literary, informational."));
    }
    if program.lines.is_empty() {
        fail("Passage has no `lines`.".to_owned());
    }
    for claim in &program.claims {
        check_claim(claim, target, &mut problems);
    }
    for source in &program.sources {
        check_source(source, &mut problems);
    }
    for word in &program.words {
        check_word(word, target, &mut problems);
    }
    for outcome in &mut program.outcomes {
        check_outcome(outcome, target, &mut problems);
    }

    let passage = Passage {
        id: text::slug(&program.heading),
        heading: program.heading.clone(),
        kind: passage_type,
        lines: program.lines.clone(),
    };
    fn index<'a, T>(items: &'a [T], id: impl Fn(&'a T) -> &'a crate::authored::Id) -> HashMap<&'a str, &'a T> {
        items.iter().filter(|item| id(item).given).map(|item| (id(item).text.as_str(), item)).collect()
    }
    let cx = Context {
        passage,
        target,
        claims: &program.claims,
        sources: &program.sources,
        words: &program.words,
        outcomes: &program.outcomes,
        claim_by_id: index(&program.claims, |claim| &claim.id),
        source_by_id: index(&program.sources, |source| &source.id),
        word_by_id: index(&program.words, |word| &word.id),
        outcome_ids: program
            .outcomes
            .iter()
            .filter(|outcome| outcome.id.given)
            .map(|outcome| outcome.id.text.as_str())
            .collect(),
    };

    // Warnings about the program as a whole lead every item's own.
    let mut shared = Vec::new();
    if program.target.is_empty() {
        shared.push(format!(
            "No target declared; defaulting to {DEFAULT}. Author a top-level 'target' ({}).",
            every_target().join(" | ")
        ));
    }
    check_readability(&cx.passage, grade, &mut shared);
    check_references(&cx, &mut problems, &mut shared);

    let mut items: Vec<Map<String, Json>> = program
        .outcomes
        .iter()
        .enumerate()
        .map(|(index, outcome)| compose_outcome(outcome, index, &cx, &shared))
        .collect();
    let mut result = if items.len() == 1 {
        items.remove(0)
    } else {
        let mut result = Map::new();
        result.insert("kind".into(), json!("items"));
        result.insert("items".into(), Json::Array(items.into_iter().map(Json::Object).collect()));
        result
    };
    result.insert("grade".into(), num(grade));
    // `title` is no longer in the lexicon, but a program that already carries one keeps it.
    if !program.title.is_empty() {
        result.insert("title".into(), json!(program.title));
    }
    (Json::Object(result), problems)
}

// --- validation ------------------------------------------------------------------------------

/// Collects problems about one element, each prefixed with which element it is.
struct Checking<'a> {
    problems: &'a mut Vec<Problem>,
    at: Option<NodeId>,
    whom: String,
}

impl Checking<'_> {
    fn fail(&mut self, what: impl AsRef<str>) {
        self.problems.push(Problem { at: self.at, message: format!("{}: {}", self.whom, what.as_ref()) });
    }
}

fn named(kind: &str, article: &str, id: &str) -> String {
    if id.is_empty() { format!("{article} {kind}") } else { format!("{kind} '{id}'") }
}

fn check_claim(claim: &Claim, target: &Target, problems: &mut Vec<Problem>) {
    let mut check = Checking { problems, at: claim.node, whom: named("claim", "a", &claim.id.text) };
    if !matches!(claim.status.as_str(), "supported" | "distractor") {
        check.fail(format!("invalid status '{}'. Expected supported or distractor.", claim.status));
    }
    // A supported claim needs its dimension, to match its outcome. A distractor is bound to
    // its questions by `targets`, so its dimension is optional, but checked if given.
    if !claim.dimension.is_empty() {
        if !target.dimensions.contains(&claim.dimension) {
            check.fail(format!("invalid dimension '{}' for target {}.", claim.dimension, target.id));
        }
    } else if claim.status == "supported" {
        check.fail("supported claim needs a dimension.");
    }
    if claim.text.is_empty() {
        check.fail("missing text.");
    }
    if claim.status == "distractor" {
        if !target.error_types.contains(&claim.error_type) {
            check.fail(format!(
                "distractor needs a valid error-type for target {} ({}).",
                target.id,
                target.error_types.join(", ")
            ));
        }
        if claim.rationale.is_empty() {
            check.fail("distractor needs a rationale (the justification for the foil).");
        }
        if claim.targets.as_ref().is_none_or(Vec::is_empty) {
            check.fail("distractor needs targets (the outcome id(s) of the question(s) it foils).");
        }
    }
    let in_range = |value: &Value| matches!(value, Value::Num(n) if (0.0..=1.0).contains(&n.to_f64()));
    if !matches!(claim.plausibility, Value::Undefined) && !in_range(&claim.plausibility) {
        check.fail("plausibility must be a number between 0 and 1.");
    }
}

fn check_source(source: &Source, problems: &mut Vec<Problem>) {
    let mut check = Checking { problems, at: source.node, whom: named("source", "a", &source.id.text) };
    if source.id.text.is_empty() {
        check.fail("missing id.");
    }
    if !matches!(source.status.as_str(), "directly-supports" | "supports-wrong-claim" | "irrelevant") {
        check.fail(format!(
            "invalid status '{}'. Expected directly-supports, supports-wrong-claim, or irrelevant.",
            source.status
        ));
    }
    if matches!(source.line, Value::Undefined) && source.quote.is_empty() {
        check.fail("needs a line number or a quote.");
    }
}

/// A targeted word. With meanings it is a Multiple Choice or Multi-Select question's word and
/// needs a correct meaning and a distractor; without, it is a click-the-word candidate.
fn check_word(word: &Word, target: &Target, problems: &mut Vec<Problem>) {
    let whom = named("word", "a", &word.id.text);
    let mut check = Checking { problems, at: word.node, whom: whom.clone() };
    if word.id.text.is_empty() {
        check.fail("missing id.");
    }
    if word.text.is_empty() {
        check.fail("missing text (the targeted word/phrase).");
    }
    if word.meanings.is_empty() {
        return;
    }
    for meaning in &word.meanings {
        let id = if meaning.id.text.is_empty() { "?" } else { &meaning.id.text };
        check.whom = format!("{whom} meaning '{id}'");
        if !matches!(meaning.status.as_str(), "correct" | "distractor") {
            check.fail(format!("invalid status '{}'. Expected correct or distractor.", meaning.status));
        }
        if meaning.text.is_empty() {
            check.fail("missing text (the meaning).");
        }
        if meaning.status == "distractor" {
            if !target.error_types.contains(&meaning.error_type) {
                check.fail(format!(
                    "distractor meaning needs a valid error-type for target {} ({}).",
                    target.id,
                    target.error_types.join(", ")
                ));
            }
            if meaning.rationale.is_empty() {
                check.fail("distractor meaning needs a rationale.");
            }
        }
    }
    check.whom = whom;
    let correct = word.meanings.iter().filter(|meaning| meaning.status == "correct").count();
    if correct == 0 {
        check.fail("needs at least one meaning with status correct.");
    }
    if correct == word.meanings.len() {
        check.fail("needs at least one distractor meaning.");
    }
}

/// Checks a question, and settles its item type: a task model alone implies one.
fn check_outcome(outcome: &mut Outcome, target: &Target, problems: &mut Vec<Problem>) {
    let mut check = Checking { problems, at: outcome.node, whom: named("outcome", "an", &outcome.id.text) };
    if outcome.id.text.is_empty() {
        check.fail("missing id (each question needs a unique id so distractors can target it).");
    }
    // A task model is resolved against this target's table, and must agree with an authored
    // type. This takes the number-to-type step off the generator and makes it a hard check.
    if !outcome.task_model.is_empty() {
        match target.task_models.get(&outcome.task_model) {
            None => {
                let allowed: Vec<String> =
                    target.task_models.iter().map(|(model, kind)| format!("{model}→{kind}")).collect();
                check.fail(format!(
                    "task model '{}' is not available for target {} (allowed: {}).",
                    outcome.task_model,
                    target.id,
                    allowed.join(", ")
                ));
            }
            Some(resolved) if outcome.kind.is_empty() => outcome.kind = resolved.clone(),
            Some(resolved) if outcome.kind != *resolved => check.fail(format!(
                "task model '{}' is {resolved} for target {}, but type is '{}'.",
                outcome.task_model, target.id, outcome.kind
            )),
            Some(_) => {}
        }
    }
    let kind = outcome.kind.as_str();
    let offered = target.item_types();
    if !targets().item_types().contains(kind) {
        let every: Vec<&str> = targets().item_types().into_iter().collect();
        check.fail(format!("invalid type '{kind}'. Expected {}.", every.join(", ")));
    } else if !offered.contains(kind) {
        let offered: Vec<&str> = offered.into_iter().collect();
        check.fail(format!(
            "item type '{kind}' is not available for target {} (allowed: {}).",
            target.id,
            offered.join(", ")
        ));
    }
    if !target.dimensions.contains(&outcome.dimension) {
        check.fail(format!("invalid dimension '{}' for target {}.", outcome.dimension, target.id));
    }
    if let Some(standard) = &outcome.standard
        && !target.standards.contains(standard)
    {
        check.fail(format!("invalid standard '{standard}' for target {}.", target.id));
    }
    // The question owns its correct answer. Only a multi-select over statements takes several:
    // where the options are evidence, `focus` is the one given inference.
    let over_statements = kind == "multi-select" && target.answer_kind == AnswerKind::Statement;
    if outcome.focus.is_empty() {
        check.fail("missing focus (the id of the supported claim this question is built around).");
    } else if over_statements && outcome.focus.len() < 2 {
        check.fail("multi-select needs at least 2 focus claims (the correct set).");
    } else if !over_statements && outcome.focus.len() > 1 {
        check.fail(format!("{kind} takes a single focus claim; only statement multi-select takes a list."));
    }
    if outcome.stem.is_empty() {
        check.fail("missing stem (author it from the guideline's Appropriate-Stem catalog).");
    }
    if kind == "ebsr" && outcome.stem_b.is_empty() {
        check.fail("EBSR needs a Part B stem (stem-b).");
    }
}

/// How many distinct distractors are bound to a question.
fn distractors_bound_to(outcome: &str, cx: &Context<'_>) -> usize {
    let bound = |claim: &&Claim| {
        claim.status == "distractor" && claim.targets.as_ref().is_some_and(|ids| ids.iter().any(|id| id == outcome))
    };
    cx.claims.iter().filter(bound).map(|claim| norm(&claim.text)).collect::<HashSet<_>>().len()
}

/// Checks the program's references. A duplicate id, a distractor aimed at no question, a focus
/// that is not a supported claim and too few foils fail the compile; a dangling citation or a
/// line outside the passage is a warning.
fn check_references(cx: &Context<'_>, problems: &mut Vec<Problem>, warnings: &mut Vec<String>) {
    let target = cx.target;
    // Each target is tied to a text type. A mismatch is allowed, but said.
    if !cx.passage.kind.is_empty() && cx.passage.kind != target.text_type {
        warnings.push(format!(
            "Target {} expects an {} passage, but this passage is {}.",
            target.id, target.text_type, cx.passage.kind
        ));
    }
    let mut duplicates = |kind: &str, ids: &mut dyn Iterator<Item = (&str, Option<NodeId>)>| {
        let mut seen = HashSet::new();
        for (id, at) in ids {
            if !id.is_empty() && !seen.insert(id) {
                problems.push(Problem { at, message: format!("Duplicate {kind} id '{id}'.") });
            }
        }
    };
    duplicates("claim", &mut cx.claims.iter().map(|claim| (claim.id.text.as_str(), claim.node)));
    duplicates("source", &mut cx.sources.iter().map(|source| (source.id.text.as_str(), source.node)));
    duplicates("outcome", &mut cx.outcomes.iter().map(|outcome| (outcome.id.text.as_str(), outcome.node)));

    for claim in cx.claims {
        for cited in &claim.cites {
            if !cx.source_by_id.contains_key(cited.as_str()) {
                warnings.push(format!("claim '{}' cites unknown evidence id '{cited}'.", claim.id.text));
            }
        }
        if claim.status == "distractor" {
            for aimed in claim.targets.iter().flatten() {
                if !cx.outcome_ids.contains(aimed.as_str()) {
                    let message = format!("distractor '{}' targets unknown outcome id '{aimed}'.", claim.id.text);
                    problems.push(Problem { at: claim.node, message });
                }
            }
        }
    }
    for word in cx.words {
        for aimed in &word.targets {
            if !cx.outcome_ids.contains(aimed.as_str()) {
                warnings.push(format!("word '{}' targets unknown outcome id '{aimed}'.", word.id.text));
            }
        }
    }
    for outcome in cx.outcomes {
        let id = &outcome.id.text;
        let mut fail = |message: String| problems.push(Problem { at: outcome.node, message });
        for focus in &outcome.focus {
            if target.answer_kind == AnswerKind::Meaning {
                if !cx.word_by_id.contains_key(focus.as_str()) {
                    fail(format!("outcome '{id}' focus '{focus}' is not a known word id."));
                }
            } else {
                match cx.claim_by_id.get(focus.as_str()) {
                    None => fail(format!("outcome '{id}' focus '{focus}' is not a known claim id.")),
                    Some(claim) if claim.status != "supported" => fail(format!(
                        "outcome '{id}' focus '{focus}' must be a supported claim, not a {}.",
                        claim.status
                    )),
                    Some(_) => {}
                }
            }
        }
        // An item whose options are distractor claims cannot be composed without enough of
        // them. Items whose foils are sources are judged when they are composed.
        let kind = outcome.kind.as_str();
        let foils_are_sources =
            target.answer_kind != AnswerKind::Statement || (kind == "hot-text" && target.single_part_hot_text);
        let needed = match kind {
            _ if foils_are_sources => 0,
            "ebsr" | "hot-text" | "multiple-choice" => DISTRACTOR_SLOTS,
            "multi-select" => 2,
            _ => 0,
        };
        if !id.is_empty() && needed > 0 {
            let bound = distractors_bound_to(id, cx);
            if bound < needed {
                fail(format!(
                    "outcome '{id}': only {bound} distractor(s) target it; a {kind} item needs at least {needed}."
                ));
            }
        }
    }
    let lines = cx.passage.lines.len();
    for source in cx.sources {
        for backed in &source.supports {
            if !cx.claim_by_id.contains_key(backed.as_str()) {
                warnings.push(format!("source '{}' supports unknown claim id '{backed}'.", source.id.text));
            }
        }
        if !matches!(source.line, Value::Undefined) && source.quote.is_empty() {
            let line = crate::authored::number(&source.line);
            if !line.is_finite() || line < 1.0 || line > lines as f64 {
                let written = crate::authored::text(&source.line);
                warnings
                    .push(format!("source '{}' line {written} is outside the passage (1..{lines}).", source.id.text));
            }
        }
    }
}

/// Warns when a passage reads well above its grade, so the prose can be simplified.
fn check_readability(passage: &Passage, grade: f64, warnings: &mut Vec<String>) {
    let Some(level) = text::grade_level(&passage.lines.join(" ")) else { return };
    if level > grade + GRADE_LEVEL_TOLERANCE {
        warnings.push(format!(
            "Passage reads above grade {} (est. grade {}); shorten sentences and use simpler, more concrete vocabulary to match the target reading level.",
            Number::Float(grade).display(),
            text::one_decimal(level)
        ));
    }
}

// --- options ---------------------------------------------------------------------------------

/// One answer option: a claim, a piece of evidence or a meaning.
#[derive(Clone, Debug, Default)]
struct Choice<'a> {
    key: Option<&'static str>,
    /// The passage line of an EBSR Part B option, as authored.
    line: Option<Json>,
    text: String,
    correct: bool,
    /// What the option is made from: the field it is reported under, and the id.
    made_from: (&'static str, String),
    error_type: Option<String>,
    status: Option<String>,
    ties_to: Option<String>,
    claim: Option<&'a Claim>,
}

impl<'a> Choice<'a> {
    fn claim(claim: &'a Claim, correct: bool) -> Self {
        Choice {
            text: claim.text.clone(),
            correct,
            made_from: ("claimId", claim.id.text.clone()),
            error_type: (!correct).then(|| claim.error_type.clone()),
            claim: Some(claim),
            ..Choice::default()
        }
    }

    /// A piece of evidence: the correct one, or a foil to the claim it does not support.
    fn source(source: &Source, passage: &Passage, foil_to: Option<&Claim>) -> Self {
        Choice {
            text: source_text(source, passage),
            correct: foil_to.is_none(),
            made_from: ("sourceId", source.id.text.clone()),
            status: foil_to.map(|_| source.status.clone()),
            ties_to: foil_to.map(|correct| first_other_claim(source, correct)),
            ..Choice::default()
        }
    }

    fn meaning(meaning: &Meaning, correct: bool) -> Self {
        Choice {
            text: meaning.text.clone(),
            correct,
            made_from: ("meaningId", meaning.id.text.clone()),
            error_type: (!meaning.error_type.is_empty()).then(|| meaning.error_type.clone()),
            ..Choice::default()
        }
    }

    fn to_json(&self) -> Json {
        let mut option = Map::new();
        let mut set = |name: &str, value: Option<Json>| {
            if let Some(value) = value {
                option.insert(name.to_owned(), value);
            }
        };
        set("key", self.key.map(Json::from));
        set("line", self.line.clone());
        set("text", Some(json!(self.text)));
        set("correct", Some(json!(self.correct)));
        set(self.made_from.0, Some(json!(self.made_from.1)));
        set("errorType", self.error_type.clone().map(Json::from));
        set("status", self.status.clone().map(Json::from));
        set("tiesTo", self.ties_to.clone().map(Json::from));
        Json::Object(option)
    }
}

fn options_json(options: &[Choice<'_>]) -> Json {
    json!({ "options": options.iter().map(Choice::to_json).collect::<Vec<_>>() })
}

fn labelled(mut options: Vec<Choice<'_>>) -> Vec<Choice<'_>> {
    for (option, label) in options.iter_mut().zip(LABELS) {
        option.key = Some(label);
    }
    options
}

/// The label of the correct option.
fn correct_key(options: &[Choice<'_>]) -> Option<&'static str> {
    options.iter().find(|option| option.correct).and_then(|option| option.key)
}

/// The labels of every correct option.
fn correct_keys(options: &[Choice<'_>]) -> Vec<Option<&'static str>> {
    options.iter().filter(|option| option.correct).map(|option| option.key).collect()
}

/// Labels the options with the correct one at a balanced position.
///
/// A shuffle alone is uniform in expectation, but over the few items of one program it can
/// put the answer first every time, which authors noticed. So the distractors are shuffled
/// among themselves and the correct option takes a position that advances with each outcome,
/// offset per program and part: the key neither always starts at A nor repeats.
fn place_correct<'a>(
    correct: Choice<'a>,
    distractors: Vec<Choice<'a>>,
    seed: &str,
    passage: &str,
    part: &str,
    index: usize,
) -> Vec<Choice<'a>> {
    let mut options = text::shuffle(distractors, &format!("{seed}:{part}"));
    let count = options.len() + 1;
    let slot = (index + text::hash(&format!("{passage}:{part}")) as usize % count) % count;
    options.insert(slot, correct);
    labelled(options)
}

fn source_text(source: &Source, passage: &Passage) -> String {
    if source.quote.is_empty() {
        passage.line(&source.line).unwrap_or_default().to_owned()
    } else {
        source.quote.clone()
    }
}

/// The first claim a source backs other than the correct one.
fn first_other_claim(source: &Source, correct: &Claim) -> String {
    source.supports.iter().find(|id| **id != correct.id.text).cloned().unwrap_or_default()
}

fn source_rationale(source: Option<&Source>, status: &str) -> String {
    match source {
        Some(source) if !source.rationale.is_empty() => source.rationale.clone(),
        _ if status == "supports-wrong-claim" => {
            "Real evidence, but it supports a different (erroneous) inference, not the correct one.".to_owned()
        }
        _ => "Does not directly support the inference.".to_owned(),
    }
}

/// How tempting a distractor is to a student who half understands, from 0 to 1. An author's
/// `plausibility` settles it. Otherwise it is read off the program: evidence that also backs
/// the correct claim (which a confused student would cite), the same dimension as the correct
/// answer, a similar length, and how tempting its kind of error tends to be.
pub fn plausibility(distractor: &Claim, correct: &Claim, sources: &HashMap<&str, &Source>) -> f64 {
    if let Value::Num(pinned) = &distractor.plausibility {
        return pinned.to_f64().clamp(0.0, 1.0);
    }
    let mut score = 0.4;
    let overlaps = distractor
        .cites
        .iter()
        .filter_map(|id| sources.get(id.as_str()))
        .any(|source| source.status == "supports-wrong-claim" && source.supports.contains(&correct.id.text));
    if overlaps {
        score += 0.3;
    }
    if !distractor.dimension.is_empty() && distractor.dimension == correct.dimension {
        score += 0.15;
    }
    let (a, b) = (text::length(&distractor.text) as f64, text::length(&correct.text) as f64);
    if a > 0.0 && b > 0.0 {
        score += 0.1 * (1.0 - (a - b).abs() / a.max(b));
    }
    score += error_type_prior(&distractor.error_type);
    score.clamp(0.0, 1.0)
}

/// Chooses an item's foils from the distractors bound to its question: first the most
/// tempting of each kind of error, in the taxonomy's order, then the most tempting left.
fn select_distractors<'a>(
    outcome: &Outcome,
    correct: &Claim,
    cx: &Context<'a>,
    slots: usize,
    warnings: &mut Vec<String>,
) -> Vec<&'a Claim> {
    let error_types = &cx.target.error_types;
    // A correct claim is never its own foil.
    let pool: Vec<&Claim> = cx
        .claims
        .iter()
        .filter(|claim| {
            claim.status == "distractor"
                && !outcome.focus.contains(&claim.id.text)
                && claim.targets.as_ref().is_some_and(|ids| ids.contains(&outcome.id.text))
        })
        .collect();
    let score = |claim: &Claim| plausibility(claim, correct, &cx.source_by_id);
    let most_tempting_first =
        |a: &&Claim, b: &&Claim| score(b).total_cmp(&score(a)).then_with(|| text::collate(&a.id.text, &b.id.text));

    let mut seen = HashSet::from([norm(&correct.text)]);
    let mut chosen: Vec<&Claim> = Vec::new();
    let mut take = |claim: &'a Claim, chosen: &mut Vec<&'a Claim>| {
        if seen.insert(norm(&claim.text)) {
            chosen.push(claim);
        } else {
            warnings.push(format!("Dropped near-duplicate distractor '{}'.", claim.id.text));
        }
    };
    for error_type in error_types {
        if chosen.len() < slots {
            let mut of_type: Vec<&Claim> =
                pool.iter().copied().filter(|claim| claim.error_type == *error_type).collect();
            of_type.sort_by(most_tempting_first);
            if let Some(&claim) = of_type.first() {
                take(claim, &mut chosen);
            }
        }
    }
    let mut rest: VecDeque<&Claim> = {
        let mut rest: Vec<&Claim> =
            pool.iter().copied().filter(|claim| !chosen.iter().any(|taken| std::ptr::eq(*taken, *claim))).collect();
        rest.sort_by(most_tempting_first);
        rest.into()
    };
    while chosen.len() < slots
        && let Some(claim) = rest.pop_front()
    {
        take(claim, &mut chosen);
    }
    if chosen.len() < slots {
        warnings
            .push(format!("Only {} distractor claim(s) target this outcome; this item wants {slots}.", chosen.len()));
    }
    // Every kind of error can only be represented when the taxonomy fits the slots.
    if error_types.len() <= slots {
        let missing: Vec<&str> = error_types
            .iter()
            .filter(|kind| !chosen.iter().any(|claim| claim.error_type == **kind))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            warnings.push(format!("Distractor error types not represented: {}.", missing.join(", ")));
        }
    }
    chosen.truncate(slots);
    chosen
}

/// The sources that do not support the correct claim, the most tempting first: one that backs
/// a chosen distractor and the correct claim too looks right for more than one option, and an
/// irrelevant line is the least tempting. Gives how many candidates there were, and the best.
fn select_foil_sources<'a>(
    correct: &Claim,
    distractors: &[&Claim],
    cx: &Context<'a>,
    slots: usize,
) -> (usize, Vec<&'a Source>) {
    let mut candidates: Vec<&Source> = cx
        .sources
        .iter()
        .filter(|source| matches!(source.status.as_str(), "supports-wrong-claim" | "irrelevant"))
        .collect();
    let pool = candidates.len();
    let score = |source: &Source| -> f64 {
        if source.status != "supports-wrong-claim" {
            return 0.0;
        }
        let backs_a_distractor = source.supports.iter().any(|id| distractors.iter().any(|claim| claim.id.text == *id));
        0.5 + if backs_a_distractor { 2.0 } else { 0.0 }
            + if source.supports.contains(&correct.id.text) { 1.0 } else { 0.0 }
    };
    candidates.sort_by(|a, b| score(b).total_cmp(&score(a)).then_with(|| text::collate(&a.id.text, &b.id.text)));
    candidates.truncate(slots);
    (pool, candidates)
}

/// Options made of evidence, where the inference is given and the student finds its support:
/// the directly supporting source (or all of them, for Multi-Select) among the most tempting
/// sources that do not support it.
fn evidence_options<'a>(
    correct: &Claim,
    direct: &[&Source],
    cx: &Context<'a>,
    seed: &str,
    index: usize,
    many: bool,
) -> (Vec<Choice<'a>>, usize) {
    let correct_sources = if many { direct } else { &direct[..direct.len().min(1)] };
    let slots = (if many { MULTI_SELECT_OPTIONS } else { PART_OPTIONS }).saturating_sub(correct_sources.len()).max(1);
    let (pool, foils) = select_foil_sources(correct, &[], cx, slots);
    let mut right: Vec<Choice> =
        correct_sources.iter().map(|source| Choice::source(source, &cx.passage, None)).collect();
    let foils: Vec<Choice> = foils.iter().map(|source| Choice::source(source, &cx.passage, Some(correct))).collect();
    let options = if many {
        right.extend(foils);
        labelled(text::shuffle(right, &format!("{seed}:ev")))
    } else if right.is_empty() {
        labelled(text::shuffle(foils, &format!("{seed}:MC")))
    } else {
        place_correct(right.remove(0), foils, seed, &cx.passage.id, "MC", index)
    };
    (options, pool)
}

/// The passage as selectable sentences, with the ones the direct sources support marked: a
/// source with a quote marks the matching sentence, one without marks its whole paragraph.
/// Also how many the student is asked for: one fewer than are valid, so that the expected
/// answer is a subset of the valid ones.
fn selectable_sentences(
    direct: &[&Source],
    cx: &Context<'_>,
    warnings: &mut Vec<String>,
) -> (Vec<Json>, Vec<String>, usize) {
    let whole_lines: Vec<f64> =
        direct.iter().filter(|source| source.quote.is_empty()).filter_map(|source| source.line_number()).collect();
    let quotes: Vec<String> =
        direct.iter().filter(|source| !source.quote.is_empty()).map(|source| norm(&source.quote)).collect();
    let mut selectable = Vec::new();
    let mut correct_ids = Vec::new();
    for (line, paragraph) in cx.passage.lines.iter().enumerate().map(|(i, paragraph)| (i + 1, paragraph)) {
        for (sentence, text) in text::sentences(paragraph).into_iter().enumerate().map(|(i, text)| (i + 1, text)) {
            let normal = norm(&text);
            let correct = whole_lines.contains(&(line as f64))
                || quotes
                    .iter()
                    .any(|quote| *quote == normal || quote.contains(&normal) || normal.contains(quote.as_str()));
            let id = format!("{line}.{sentence}");
            if correct {
                correct_ids.push(id.clone());
            }
            selectable
                .push(json!({ "id": id, "lineId": line, "sentence": sentence, "text": text, "correct": correct }));
        }
    }
    match correct_ids.len() {
        0 => warnings.push("No directly-supporting evidence; Part B has no correct selection.".to_owned()),
        1 => warnings.push("Only 1 valid supporting sentence; author a superset (2+ directly-supporting sentences) so the expected answer is a subset of the valid responses.".to_owned()),
        _ => {}
    }
    let count = if correct_ids.len() <= 1 { 1 } else { HOT_TEXT_SELECT_MAX.min(correct_ids.len() - 1) };
    (selectable, correct_ids, count)
}

// --- warnings about options ------------------------------------------------------------------

/// Warns when the correct option stands out as the longest: a student can pick it on heft.
fn check_length_balance(options: &[Choice<'_>], label: &str, warnings: &mut Vec<String>) {
    let Some(correct) = options.iter().find(|option| option.correct) else { return };
    let foils: Vec<usize> =
        options.iter().filter(|option| !option.correct).map(|option| text::length(&option.text)).collect();
    if foils.is_empty() {
        return;
    }
    let correct = text::length(&correct.text);
    let mean = foils.iter().sum::<usize>() as f64 / foils.len() as f64;
    if mean == 0.0 {
        return;
    }
    let ratio = correct as f64 / mean;
    if foils.iter().all(|foil| *foil <= correct) && ratio >= LENGTH_BALANCE_RATIO {
        warnings.push(format!(
            "{label}: the correct option ({correct} chars) is {}% longer than the average distractor ({} chars) — possible length giveaway. Balance the options' length/detail.",
            text::round((ratio - 1.0) * 100.0),
            text::round(mean)
        ));
    }
}

/// Function words and stem boilerplate, which say nothing about whether a stem echoes its answer.
const STEM_STOPWORDS: &[&str] = &[
    "the",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "and",
    "or",
    "but",
    "that",
    "this",
    "these",
    "those",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "its",
    "as",
    "by",
    "with",
    "from",
    "into",
    "about",
    "which",
    "what",
    "how",
    "who",
    "whose",
    "why",
    "where",
    "when",
    "your",
    "their",
    "them",
    "they",
    "had",
    "has",
    "have",
    "do",
    "does",
    "did",
    "will",
    "would",
    "can",
    "could",
    "more",
    "than",
    "then",
    "so",
    "such",
    "best",
    "most",
    "two",
    "three",
    "passage",
    "sentence",
    "sentences",
    "inference",
    "inferences",
    "conclusion",
    "conclusions",
    "click",
    "statement",
    "statements",
    "supported",
    "support",
    "supports",
    "answer",
    "part",
    "show",
    "shows",
    "select",
    "provides",
    "author",
    "most",
    "likely",
];

/// The distinctive words of a stem or an answer: not function words, and not the subject.
fn content_words(text: &str, subject: &str) -> IndexSet<String> {
    let subject = norm(subject);
    let subject: HashSet<&str> = subject.split(' ').collect();
    norm(text)
        .split(' ')
        .filter(|word| word.len() > 2 && !STEM_STOPWORDS.contains(word) && !subject.contains(word))
        .map(str::to_owned)
        .collect()
}

/// Warns when a stem reuses most of the correct option's distinctive words, which makes the
/// answer obvious without reading the options. Naming the subject is not a giveaway.
fn check_stem_giveaway(stem: &str, correct: &str, subject: &str, warnings: &mut Vec<String>) {
    let stem = content_words(stem, subject);
    let answer = content_words(correct, subject);
    if answer.len() < STEM_GIVEAWAY_MIN {
        return;
    }
    let shared: Vec<&str> = answer.iter().filter(|word| stem.contains(*word)).map(String::as_str).collect();
    if shared.len() >= STEM_GIVEAWAY_MIN && shared.len() as f64 / answer.len() as f64 >= STEM_GIVEAWAY_RATIO {
        warnings.push(format!(
            "Part A: the stem reuses much of the correct option's wording (shared: {}) — reword the stem into a neutral question so it doesn't echo the answer.",
            shared[..shared.len().min(8)].join(", ")
        ));
    }
}

// --- items -----------------------------------------------------------------------------------

/// The correct answer an item is built around: a claim, or a word's correct meaning.
struct Correct<'a> {
    id: &'a str,
    text: &'a str,
    subject: &'a str,
    standard: &'a str,
}

impl<'a> From<&'a Claim> for Correct<'a> {
    fn from(claim: &'a Claim) -> Self {
        Correct { id: &claim.id.text, text: &claim.text, subject: &claim.subject, standard: &claim.standard }
    }
}

/// An item under construction. Fields keep the order they are first set in.
struct Item(Map<String, Json>);

impl Item {
    fn set(&mut self, name: &str, value: Json) {
        self.0.insert(name.to_owned(), value);
    }

    fn review(&mut self, name: &str, value: Json) {
        self.0["review"][name] = value;
    }

    /// What every item has, whatever its type.
    fn new(kind: &str, outcome: &Outcome, cx: &Context<'_>, dok: &str, correct: Option<Correct<'_>>) -> Self {
        let target = cx.target;
        let dimension = &outcome.dimension;
        // The cite-evidence standard, and a companion: authored, the claim's, or the dimension's.
        let companion =
            [outcome.standard.as_deref().unwrap_or_default(), correct.as_ref().map_or("", |correct| correct.standard)]
                .into_iter()
                .find(|standard| !standard.is_empty())
                .or(target.dim_standard.get(dimension).map(String::as_str));
        let mut standards = vec![target.base_standard.as_str()];
        standards.extend(companion.filter(|standard| !standard.is_empty() && *standard != target.base_standard));

        let mut stem = Map::new();
        stem.insert("partA".into(), json!(outcome.stem));
        // Only the two-part models carry the lead-in.
        match kind {
            "ebsr" => {
                stem.insert("leadIn".into(), json!(LEAD_IN));
                stem.insert("partB".into(), json!(outcome.stem_b));
            }
            "hot-text" => {
                stem.insert("leadIn".into(), json!(LEAD_IN));
                stem.insert("partB".into(), json!(HOT_TEXT_PART_B));
            }
            _ => {}
        }

        let mut item = Item(Map::new());
        item.set("kind", json!("item"));
        let suffix = if outcome.id.text.is_empty() { format!("{kind}-{dimension}") } else { outcome.id.text.clone() };
        item.set("id", json!(format!("{}-{suffix}", cx.passage.id)));
        item.set("type", json!(kind));
        item.set("target", json!(target.id));
        // The task model as authored. It is not derived from the type: several can share one.
        let model = &outcome.task_model;
        let model = if model.len() >= 2 && model[..2].eq_ignore_ascii_case("tm") { &model[2..] } else { model };
        if !model.is_empty() {
            item.set("taskModel", json!(model));
        }
        item.set("standards", json!(standards));
        item.set("dok", json!(dok));
        item.set("dimension", json!(dimension));
        item.set("passage", cx.passage.to_json());
        item.set("passages", Json::Null);
        item.set("stem", Json::Object(stem));
        item.set("distractorAnalysis", json!([]));
        item.set("answerKey", json!({}));
        let correct_claim = correct.map_or(Json::Null, |correct| {
            let mut claim = json!({ "id": correct.id, "text": correct.text });
            if !correct.subject.is_empty() {
                claim["subject"] = json!(correct.subject);
            }
            claim
        });
        item.set(
            "review",
            json!({
                "target": target.id, "standards": standards, "dok": dok, "dimension": dimension,
                "scoring": scoring(kind), "correctClaim": correct_claim, "alternativeClaims": 0,
            }),
        );
        item.set("warnings", json!([]));
        item
    }
}

fn compose_outcome(outcome: &Outcome, index: usize, cx: &Context<'_>, shared: &[String]) -> Map<String, Json> {
    let mut warnings = shared.to_vec();
    let mut item = compose_item(outcome, index, cx, &mut warnings);
    item.set("warnings", json!(warnings));
    item.0
}

fn compose_item(outcome: &Outcome, index: usize, cx: &Context<'_>, warnings: &mut Vec<String>) -> Item {
    let kind = outcome.kind.as_str();
    let id = &outcome.id.text;
    // A written summary is strategic reasoning, whatever its target's usual depth.
    let dok = match (outcome.dok.as_str(), kind) {
        ("", "short-text") => "r-dok3",
        ("", _) => &cx.target.default_dok,
        (authored, _) => authored,
    };
    let seed = format!("{}:{id}:{kind}", cx.passage.id);
    let passage = cx.passage.id.as_str();

    // Optional, but it makes the item's task model explicit and checkable.
    if outcome.task_model.is_empty() {
        warnings.push(format!(
            "Outcome '{id}' does not specify a task-model; add one (e.g. `task-model tm3`) so the item's task model is explicit."
        ));
    }
    if cx.target.answer_kind == AnswerKind::Meaning {
        return compose_word_meaning(outcome, index, cx, dok, &seed, warnings);
    }

    // The question's correct answer: one claim, or the whole correct set of a multi-select.
    let correct_claims: Vec<&Claim> =
        outcome.focus.iter().filter_map(|id| cx.claim_by_id.get(id.as_str()).copied()).collect();
    let Some(&correct) = correct_claims.first() else {
        warnings.push(format!("Outcome '{id}' focus '{}' not found; cannot compose.", outcome.focus.join(", ")));
        return Item::new(kind, outcome, cx, dok, None);
    };
    let mut item = Item::new(kind, outcome, cx, dok, Some(correct.into()));
    let alternatives =
        cx.claims.iter().filter(|claim| claim.status == "supported" && claim.dimension == outcome.dimension).count();
    item.review("alternativeClaims", json!(alternatives.saturating_sub(1)));

    let direct: Vec<&Source> = correct
        .cites
        .iter()
        .filter_map(|id| cx.source_by_id.get(id.as_str()).copied())
        .filter(|source| source.status == "directly-supports")
        .collect();
    let stem_giveaway = |answer: &str, warnings: &mut Vec<String>| {
        check_stem_giveaway(&outcome.stem, answer, &outcome.subject, warnings)
    };
    let key = |key: Option<&str>| key.map(Json::from);
    let answer_key = |entries: Vec<(&str, Option<Json>)>| {
        let mut answer = Map::new();
        for (name, value) in entries {
            if let Some(value) = value {
                answer.insert(name.to_owned(), value);
            }
        }
        answer.insert("rationale".into(), json!(correct.rationale));
        Json::Object(answer)
    };

    match kind {
        "short-text" => {
            item.set("prompt", json!(outcome.stem));
            let rubric = if outcome.rubric.is_empty() {
                json!([
                    { "score": 2, "descriptor": "Makes a valid inference and supports it with specific, relevant details from the passage." },
                    { "score": 1, "descriptor": "Makes a partially valid inference, or supports it with limited or only partially relevant details." },
                    { "score": 0, "descriptor": "Does not make a valid inference, or provides no relevant textual support." },
                ])
            } else {
                outcome
                    .rubric
                    .iter()
                    .map(|(score, descriptor)| json!({ "score": num(*score), "descriptor": descriptor }))
                    .collect()
            };
            item.set("rubric", rubric);
            item.set("distractorAnalysis", json!([]));
            item.set("answerKey", answer_key(vec![]));
            if cx.passage.lines.len() < SHORT_TEXT_MIN_LINES {
                warnings.push("Short Text items should use a long literary passage; this passage is short.".to_owned());
            }
            return item;
        }
        "multiple-choice" | "multi-select" if cx.target.answer_kind == AnswerKind::Evidence => {
            // The inference is given in the stem; the options are passage evidence.
            let many = kind == "multi-select";
            if many && direct.len() < 2 {
                warnings.push(
                    "Multi-select (evidence) needs at least 2 directly-supporting sources as the correct set."
                        .to_owned(),
                );
            } else if !many && direct.is_empty() {
                warnings.push(
                    "No directly-supporting evidence for the given inference; this item has no correct option."
                        .to_owned(),
                );
            }
            let (options, pool) = evidence_options(correct, &direct, cx, &seed, index, many);
            if pool < MIN_VIABLE_PART_B {
                let advice = if many { "" } else { " so the best foils can be chosen" };
                warnings.push(format!(
                    "Only {pool} non-supporting evidence source(s) available; author at least {MIN_VIABLE_PART_B}{advice}."
                ));
            }
            check_length_balance(&options, "Options", warnings);
            if !many {
                stem_giveaway(options.iter().find(|option| option.correct).map_or("", |option| &option.text), warnings);
            }
            item.set("choice", options_json(&options));
            if many {
                item.set("selectCount", json!(correct_keys(&options).len()));
            }
            let analysis: Vec<Json> = options
                .iter()
                .filter(|option| !option.correct)
                .map(|option| source_analysis(option, "A", cx))
                .collect();
            item.set("distractorAnalysis", json!(analysis));
            item.set(
                "answerKey",
                if many {
                    answer_key(vec![("choices", Some(json!(correct_keys(&options))))])
                } else {
                    answer_key(vec![("choice", key(correct_key(&options)))])
                },
            );
            return item;
        }
        "multiple-choice" => {
            let distractors = select_distractors(outcome, correct, cx, DISTRACTOR_SLOTS, warnings);
            let options = statement_options(correct, &distractors, &seed, passage, index);
            check_length_balance(&options, "Options", warnings);
            stem_giveaway(&correct.text, warnings);
            item.set("choice", options_json(&options));
            item.set("distractorAnalysis", claim_analysis(&options, correct, cx));
            item.set("answerKey", answer_key(vec![("choice", key(correct_key(&options)))]));
            return item;
        }
        "multi-select" => {
            // The correct set is `focus`; the rest of the options are distractors.
            let slots = MULTI_SELECT_OPTIONS.saturating_sub(correct_claims.len()).max(1);
            let distractors = select_distractors(outcome, correct, cx, slots, warnings);
            let all = correct_claims
                .iter()
                .map(|claim| Choice::claim(claim, true))
                .chain(distractors.iter().map(|claim| Choice::claim(claim, false)));
            let options = labelled(text::shuffle(all.collect(), &format!("{seed}:MS")));
            check_length_balance(&options, "Options", warnings);
            stem_giveaway(&correct.text, warnings);
            item.set("choice", options_json(&options));
            item.set("selectCount", json!(correct_claims.len()));
            item.set("distractorAnalysis", claim_analysis(&options, correct, cx));
            item.set("answerKey", answer_key(vec![("choices", Some(json!(correct_keys(&options))))]));
            return item;
        }
        "hot-text" if cx.target.single_part_hot_text => {
            // The stem is the whole instruction; the student clicks the supporting sentences.
            let (selectable, correct_ids, count) = selectable_sentences(&direct, cx, warnings);
            item.set("selectable", json!(selectable));
            item.set("selectCount", json!(count));
            item.set("stem", json!({ "partA": outcome.stem }));
            item.set("distractorAnalysis", json!([]));
            item.set("answerKey", answer_key(vec![("partB", Some(json!(correct_ids.join(", "))))]));
            return item;
        }
        _ => {}
    }

    // EBSR and two-part Hot Text share a Part A of statements. Fewer than three foils failed
    // the compile earlier; fewer than five leaves selection little to choose from.
    let bound = distractors_bound_to(id, cx);
    if bound < MIN_VIABLE_DISTRACTORS {
        warnings.push(format!(
            "Only {bound} viable distractor(s) target outcome '{id}'; author at least 5 for stronger selection."
        ));
    }
    let distractors = select_distractors(outcome, correct, cx, DISTRACTOR_SLOTS, warnings);
    let part_a = statement_options(correct, &distractors, &seed, passage, index);
    item.set("partA", options_json(&part_a));
    check_length_balance(&part_a, "Part A", warnings);
    stem_giveaway(&correct.text, warnings);
    let Json::Array(mut analysis) = claim_analysis(&part_a, correct, cx) else { unreachable!("an analysis is a list") };

    if kind == "hot-text" {
        // Part A asks for a statement. Selecting sentences is Part B, which is fixed here.
        if mentions_sentences(&outcome.stem) {
            warnings.push(
                "Hot Text Part A must ask for the best STATEMENT (an inference), not passage sentences — selecting sentences is Part B (fixed by the compiler). Use a \"Click on the statement that best…\" stem from stems.md Task Model 2."
                    .to_owned(),
            );
        }
        let (selectable, correct_ids, count) = selectable_sentences(&direct, cx, warnings);
        item.set("selectable", json!(selectable));
        item.set("selectCount", json!(count));
        item.0["stem"]["partB"] = json!(if count <= 1 {
            "Click 1 sentence from the passage that supports your answer in Part A.".to_owned()
        } else {
            format!("Click {count} sentences from the passage that support your answer in Part A.")
        });
        item.set("distractorAnalysis", json!(analysis));
        item.set(
            "answerKey",
            answer_key(vec![("partA", key(correct_key(&part_a))), ("partB", Some(json!(correct_ids.join(", "))))]),
        );
        return item;
    }

    // EBSR Part B: the supporting line among three that do not support it.
    let correct_source = direct.first().copied();
    let (pool, foils) = select_foil_sources(correct, &distractors, cx, DISTRACTOR_SLOTS);
    if pool < MIN_VIABLE_PART_B {
        warnings.push(format!(
            "Only {pool} Part B foil source(s) available; author at least {MIN_VIABLE_PART_B} non-supporting evidence lines (supports-wrong-claim + irrelevant) so the best 3 can be chosen."
        ));
    }
    let with_line = |source: &Source, correct: Option<&Claim>| Choice {
        line: source.line.to_json(),
        ..Choice::source(source, &cx.passage, correct)
    };
    let foil_options: Vec<Choice> = foils.iter().map(|source| with_line(source, Some(correct))).collect();
    let available = usize::from(correct_source.is_some()) + foil_options.len();
    if correct_source.is_none() {
        warnings.push(
            "No directly-supporting evidence for the correct claim; EBSR Part B has no correct option.".to_owned(),
        );
    }
    if available < PART_OPTIONS {
        warnings.push(format!(
            "Only {available} Part B option(s) available; EBSR wants 4. Add irrelevant or supports-wrong-claim evidence sources."
        ));
    }
    let part_b = match correct_source {
        Some(source) => place_correct(with_line(source, None), foil_options, &seed, passage, "B", index),
        None => labelled(text::shuffle(foil_options, &format!("{seed}:B"))),
    };
    item.set("partB", options_json(&part_b));
    check_length_balance(&part_b, "Part B", warnings);
    // If no Part B foil also ties to the correct claim, Part B points back at Part A's answer.
    if !foils.is_empty() && !foils.iter().any(|source| source.supports.contains(&correct.id.text)) {
        warnings.push("Part B options do not overlap the correct Part A option — possible A↔B giveaway.".to_owned());
    }
    analysis.extend(part_b.iter().filter(|option| !option.correct).map(|option| source_analysis(option, "B", cx)));
    item.set("distractorAnalysis", json!(analysis));
    item.set("answerKey", answer_key(vec![("partA", key(correct_key(&part_a))), ("partB", key(correct_key(&part_b)))]));
    item
}

/// Whether a stem asks about a "sentence" or "sentences", as a whole word.
fn mentions_sentences(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    lower.match_indices("sentence").any(|(at, found)| {
        let rest = &lower[at + found.len()..];
        let rest = rest.strip_prefix('s').unwrap_or(rest);
        !lower[..at].chars().next_back().is_some_and(word) && !rest.chars().next().is_some_and(word)
    })
}

fn statement_options<'a>(
    correct: &'a Claim,
    distractors: &[&'a Claim],
    seed: &str,
    passage: &str,
    index: usize,
) -> Vec<Choice<'a>> {
    let distractors = distractors.iter().map(|claim| Choice::claim(claim, false)).collect();
    place_correct(Choice::claim(correct, true), distractors, seed, passage, "A", index)
}

/// Why each wrong statement is wrong, and how tempting it is.
fn claim_analysis(options: &[Choice<'_>], correct: &Claim, cx: &Context<'_>) -> Json {
    let analysis = options.iter().filter(|option| !option.correct).map(|option| {
        let id = &option.made_from.1;
        // By id, as readers of the item will find it; the chosen claim itself if it has none.
        let claim = cx.claim_by_id.get(id.as_str()).copied().or(option.claim);
        let tempting = claim.map_or(0.0, |claim| plausibility(claim, correct, &cx.source_by_id));
        let mut entry = Map::new();
        entry.insert("part".into(), json!("A"));
        entry.extend(option.key.map(|key| ("key".to_owned(), json!(key))));
        entry.insert("claimId".into(), json!(id));
        entry.extend(option.error_type.as_ref().map(|kind| ("errorType".to_owned(), json!(kind))));
        entry.insert("tiesTo".into(), json!([id]));
        entry.insert("plausibility".into(), num(text::round(tempting * 100.0) / 100.0));
        entry.insert("rationale".into(), json!(claim.map_or("", |claim| &claim.rationale)));
        Json::Object(entry)
    });
    analysis.collect()
}

/// Why a wrong piece of evidence is wrong.
fn source_analysis(option: &Choice<'_>, part: &str, cx: &Context<'_>) -> Json {
    let id = &option.made_from.1;
    let status = option.status.as_deref().unwrap_or_default();
    let mut entry = Map::new();
    entry.insert("part".into(), json!(part));
    entry.extend(option.key.map(|key| ("key".to_owned(), json!(key))));
    entry.insert("sourceId".into(), json!(id));
    entry.insert("status".into(), json!(status));
    entry.insert("tiesTo".into(), json!(option.ties_to));
    entry.insert("rationale".into(), json!(source_rationale(cx.source_by_id.get(id.as_str()).copied(), status)));
    Json::Object(entry)
}

/// Function words, which are never the answer to a click-the-word item.
const CLICK_STOPWORDS: &[&str] = &[
    "the", "and", "are", "was", "were", "for", "but", "with", "this", "that", "these", "those", "its", "into", "their",
    "they", "them", "from", "has", "have", "had", "not", "you", "your",
];

/// Word Meanings: an item about the meaning of a targeted word. Its options are the word's
/// candidate meanings, or, for the click-the-word model, the words of its paragraph.
fn compose_word_meaning(
    outcome: &Outcome,
    index: usize,
    cx: &Context<'_>,
    dok: &str,
    seed: &str,
    warnings: &mut Vec<String>,
) -> Item {
    let kind = outcome.kind.as_str();
    let id = &outcome.id.text;
    let focus = outcome.focus.first();
    let word = focus.and_then(|id| cx.word_by_id.get(id.as_str()).copied());
    let meanings: &[Meaning] = word.map_or(&[], |word| &word.meanings);
    let right: Vec<&Meaning> = meanings.iter().filter(|meaning| meaning.status == "correct").collect();
    let wrong: Vec<&Meaning> = meanings.iter().filter(|meaning| meaning.status == "distractor").collect();
    let key = right.first().copied();
    let rationale = key.map_or("", |meaning| &meaning.rationale);
    let correct = key.map(|meaning| Correct {
        id: &meaning.id.text,
        text: &meaning.text,
        subject: "",
        standard: &meaning.standard,
    });
    let mut item = Item::new(kind, outcome, cx, dok, correct);
    let Some(word) = word else {
        let focus = focus.map_or("undefined", String::as_str);
        warnings.push(format!("Outcome '{id}' focus '{focus}' is not a known word; cannot compose."));
        return item;
    };
    let mut shown = Map::new();
    shown.insert("text".into(), json!(word.text));
    shown.extend(word.line.to_json().map(|line| ("line".to_owned(), line)));
    if !word.quote.is_empty() {
        shown.insert("quote".into(), json!(word.quote));
    }
    item.set("word", Json::Object(shown));

    let meaning_analysis = |options: &[Choice<'_>]| -> Json {
        let by_id: HashMap<&str, &Meaning> = meanings
            .iter()
            .filter(|meaning| meaning.id.given)
            .map(|meaning| (meaning.id.text.as_str(), meaning))
            .collect();
        let analysis = options.iter().filter(|option| !option.correct).map(|option| {
            let id = &option.made_from.1;
            let mut entry = Map::new();
            entry.insert("part".into(), json!("A"));
            entry.extend(option.key.map(|key| ("key".to_owned(), json!(key))));
            entry.insert("meaningId".into(), json!(id));
            entry.extend(option.error_type.as_ref().map(|kind| ("errorType".to_owned(), json!(kind))));
            entry.insert("rationale".into(), json!(by_id.get(id.as_str()).map_or("", |meaning| &meaning.rationale)));
            Json::Object(entry)
        });
        analysis.collect()
    };

    match kind {
        // Click the word: the paragraph containing the word is shown, and the student clicks
        // the word that matches the definition in the stem.
        "hot-text" => {
            let correct_norm = norm(&word.text);
            let by_line = cx.passage.line(&word.line).unwrap_or_default();
            let by_containing = cx
                .passage
                .lines
                .iter()
                .find(|line| norm(line).split(' ').any(|word| word == correct_norm))
                .map_or("", String::as_str);
            let excerpt =
                [by_line, by_containing, &word.quote].into_iter().find(|text| !text.is_empty()).unwrap_or_default();
            if excerpt.is_empty() {
                let focus = &word.id.text;
                warnings.push(format!(
                    "Outcome '{id}': word '{focus}' needs a 'line' (the paragraph it appears in) or a 'quote' so there is an excerpt to select from."
                ));
            }
            let excerpt_norm = norm(excerpt);
            let in_excerpt: HashSet<&str> = excerpt_norm.split(' ').filter(|word| !word.is_empty()).collect();
            // The choices are curated when the author gave any: other words in this paragraph,
            // or the word's own one-word distractor meanings (the generator often authors the
            // candidates that way). Otherwise every content word is a choice.
            let others: Vec<&Word> = cx.words.iter().filter(|other| other.id.text != word.id.text).collect();
            let one_word = |text: &str| !text::trim(text).contains(text::is_space);
            let candidates: HashSet<String> = others
                .iter()
                .map(|other| norm(&other.text))
                .chain(wrong.iter().filter(|meaning| one_word(&meaning.text)).map(|meaning| norm(&meaning.text)))
                .filter(|candidate| in_excerpt.contains(candidate.as_str()))
                .collect();
            let curated = !candidates.is_empty();
            let mut any_correct = false;
            let mut selectable_count = 0;
            let tokens: Vec<Json> = text::words(excerpt)
                .enumerate()
                .map(|(idx, raw)| {
                    let outside = |c: char| !c.is_ascii_alphanumeric();
                    let core = raw.trim_matches(outside);
                    let before = &raw[..raw.len() - raw.trim_start_matches(outside).len()];
                    let after = &raw[raw.trim_end_matches(outside).len()..];
                    let normal = norm(core);
                    let selectable = if curated {
                        normal == correct_norm || candidates.contains(&normal)
                    } else {
                        text::length(core) > 2 && !CLICK_STOPWORDS.contains(&normal.as_str())
                    };
                    let correct = selectable && normal == correct_norm;
                    any_correct |= correct;
                    selectable_count += usize::from(selectable);
                    let shown = if core.is_empty() { raw } else { core };
                    json!({ "idx": idx, "pre": before, "text": shown, "post": after, "selectable": selectable, "correct": correct })
                })
                .collect();
            // A candidate outside the paragraph cannot be a choice. Words that belong to
            // another item — another outcome's focus, or a word with meanings — are not candidates.
            let focused: HashSet<&str> =
                cx.outcomes.iter().flat_map(|outcome| &outcome.focus).map(String::as_str).collect();
            for other in others {
                if focused.contains(other.id.text.as_str()) || other.has_meanings {
                    continue;
                }
                if !in_excerpt.contains(norm(&other.text).as_str()) {
                    warnings.push(format!(
                        "word '{}' (\"{}\") is not in the correct word's paragraph, so it cannot be a click-the-word choice — keep all candidates in that paragraph.",
                        other.id.text, other.text
                    ));
                }
            }
            if !any_correct {
                warnings.push(format!(
                    "Outcome '{id}': the correct word \"{}\" is not a selectable word in the excerpt.",
                    word.text
                ));
            }
            if selectable_count < 3 {
                warnings.push(format!(
                    "Click-the-word: only {selectable_count} selectable word(s) — author a few distractor candidate words in the correct word's paragraph (or use a fuller paragraph)."
                ));
            }
            if !excerpt.is_empty() && norm(&outcome.stem).contains(&excerpt_norm) {
                warnings.push(
                    "Click-the-word stem should be just the instruction and the definition — the paragraph is shown separately; do not paste it into the stem."
                        .to_owned(),
                );
            }
            item.set("wordSelect", json!({ "excerpt": excerpt, "tokens": tokens }));
            item.set("selectCount", json!(1));
            item.set("stem", json!({ "partA": outcome.stem }));
            item.review("correctClaim", json!({ "id": word.id.text, "text": word.text }));
            item.set("distractorAnalysis", json!([]));
            item.set("answerKey", json!({ "word": word.text, "rationale": rationale }));
        }
        "multi-select" => {
            if right.len() < 2 {
                warnings.push("Multi-select (word meaning) needs at least 2 correct meanings.".to_owned());
            }
            let slots = MULTI_SELECT_OPTIONS.saturating_sub(right.len()).max(1);
            let all = right
                .iter()
                .map(|meaning| Choice::meaning(meaning, true))
                .chain(wrong.iter().take(slots).map(|meaning| Choice::meaning(meaning, false)));
            let options = labelled(text::shuffle(all.collect(), &format!("{seed}:WM")));
            check_length_balance(&options, "Options", warnings);
            item.set("choice", options_json(&options));
            item.set("selectCount", json!(correct_keys(&options).len()));
            item.set("distractorAnalysis", meaning_analysis(&options));
            item.set("answerKey", json!({ "choices": correct_keys(&options), "rationale": rationale }));
        }
        // Multiple Choice: the correct meaning among up to three others.
        _ => {
            let foils: Vec<Choice> =
                wrong.iter().take(PART_OPTIONS - 1).map(|meaning| Choice::meaning(meaning, false)).collect();
            let options = match key {
                Some(meaning) => {
                    place_correct(Choice::meaning(meaning, true), foils, seed, &cx.passage.id, "MC", index)
                }
                None => {
                    warnings
                        .push("No correct meaning for the targeted word; this item has no correct option.".to_owned());
                    labelled(text::shuffle(foils, &format!("{seed}:MC")))
                }
            };
            check_length_balance(&options, "Options", warnings);
            check_stem_giveaway(&outcome.stem, key.map_or("", |meaning| &meaning.text), &outcome.subject, warnings);
            item.set("choice", options_json(&options));
            item.set("distractorAnalysis", meaning_analysis(&options));
            let mut answer = Map::new();
            answer.extend(correct_key(&options).map(|key| ("choice".to_owned(), json!(key))));
            answer.insert("rationale".into(), json!(rationale));
            item.set("answerKey", Json::Object(answer));
        }
    }
    item
}
