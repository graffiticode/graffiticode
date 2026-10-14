// SPDX-License-Identifier: MIT

//! L0014 — a language for authoring TransLaTeX translation rule sets. It inherits the base
//! language and adds the rule-authoring words: `words`, `rules`, `types`, a set of parser
//! options, and `tests`, a corpus the rule set is scored against.
//!
//! **The output contract is fixed**: a program evaluates to `{ options, tests }`. `options` is
//! what a consumer passes to `TransLaTeX.buildTranslator` as its rule set, key for key and in
//! the order written: TransLaTeX takes the first pattern that matches, so the order rules are
//! written in is their precedence. `tests` is each corpus case with its score.
//!
//! Each statement contributes one key, and the program merges them, so statements may come in
//! any order. Translating is not done here: TransLaTeX is a JavaScript library, reached
//! through the [`Translator`] trait.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use graffiticode_l0000::{Dialect, Evaluator, Key, Lexicon, Node, NodeId, Op, Record, Value};
use serde_json::Value as Json;

/// The words L0014 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0014")).expect("L0014 shadows no base word")
});

/// L0014's vocabulary: the base lexicon and the rule-authoring words.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The compiled key each option word writes, by node tag.
///
/// The word is kebab-case; the key is whatever TransLaTeX already reads, and those are not the
/// same string (`allow-thousands-separator` writes `allowThousandsSeparator`). Renaming a key
/// would silently disable the option rather than fail, so this table is transcribed.
///
/// **Its order is part of the output**: options are emitted in this order, which is the order
/// the shipping rule set's keys run in.
const OPTIONS: [(&str, &str); 10] = [
    ("ALLOW_THOUSANDS_SEPARATOR", "allowThousandsSeparator"),
    ("SET_DECIMAL_SEPARATOR", "setDecimalSeparator"),
    ("SET_THOUSANDS_SEPARATOR", "setThousandsSeparator"),
    ("ALLOW_INTERVAL", "allowInterval"),
    ("IGNORE_TEXT", "ignoreText"),
    ("IGNORE_COEFFICIENT_ONE", "ignoreCoefficientOne"),
    ("PARSING_INTEGRAL_EXPR", "parsingIntegralExpr"),
    ("RHS", "RHS"),
    ("NO_PARENS", "NoParens"),
    ("END_ROOT", "EndRoot"),
];

/// The key under which a statement's value records which part of the rule set it is.
const CONTRIBUTES: &str = "__l0014";

/// One source string translated: the translation, and anything the translator complained of.
#[derive(Clone, Debug, PartialEq)]
pub struct Translation {
    pub value: Json,
    pub errors: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TranslatorError(pub String);

/// Runs TransLaTeX.
#[async_trait]
pub trait Translator: Send + Sync {
    /// Translates each of `sources` against the rule set `rules`: one result per source, in
    /// order. A source that cannot be translated is a result with errors, not a failure.
    async fn translate(&self, rules: &Json, sources: &[String]) -> Result<Vec<Translation>, TranslatorError>;
}

#[derive(Clone)]
pub struct L0014 {
    translator: Arc<dyn Translator>,
}

impl L0014 {
    pub fn new(translator: impl Translator + 'static) -> Self {
        Self { translator: Arc::new(translator) }
    }
}

#[async_trait]
impl Dialect for L0014 {
    fn lang_id(&self) -> &str {
        "0014"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        Some(match tag {
            "PROG" => self.program(cx, id, elts).await,
            "WORDS" | "TYPES" => {
                let value = Some(plain(cx.eval_arg(id, elts, 0).await)).filter(Value::is_truthy);
                contribution(&tag.to_lowercase(), value.unwrap_or_else(|| Value::Record(Record::new())))
            }
            // `rules { "pattern": "expansion" }` compiles to `{ "pattern": ["expansion"] }`: a
            // bare expansion becomes a one-element list, and a list is left alone. Every rule
            // set there is has this shape.
            "RULES" => {
                let rules = match plain(cx.eval_arg(id, elts, 0).await) {
                    Value::Record(rules) => rules
                        .into_iter()
                        .map(|(pattern, expansion)| match expansion {
                            Value::List(_) => (pattern, expansion),
                            bare => (pattern, Value::List(vec![bare])),
                        })
                        .collect(),
                    _ => Record::new(),
                };
                contribution("rules", Value::Record(rules))
            }
            // The corpus, carried unevaluated: the program scores it once the whole rule set
            // is known, which is why `tests` need not come last.
            "TESTS" => match plain(cx.eval_arg(id, elts, 0).await) {
                corpus @ Value::List(_) => contribution("tests", corpus),
                _ => contribution("tests", Value::List(Vec::new())),
            },
            // One source string, against a rule set with nothing in it.
            "TRANSLATE" => {
                let source = text(&cx.eval_arg(id, elts, 0).await);
                match self.translator.translate(&to_json(&options(&Record::new())), &[source]).await {
                    Ok(mut translated) if translated.len() == 1 => {
                        let Translation { value, errors } = translated.remove(0);
                        for error in errors {
                            cx.report(id, error);
                        }
                        Value::from_json(&value)
                    }
                    Ok(_) => {
                        cx.report(id, "translate: the translator did not answer for the source.");
                        Value::Str(String::new())
                    }
                    Err(err) => {
                        cx.report(id, format!("translate: {err}"));
                        Value::Str(String::new())
                    }
                }
            }
            _ => match OPTIONS.iter().find(|(word, _)| *word == tag) {
                Some((_, field)) => contribution(field, plain(cx.eval_arg(id, elts, 0).await)),
                None => return None,
            },
        })
    }
}

impl L0014 {
    /// Merges the statements' contributions in source order (a repeated statement wins), then
    /// scores the corpus against the assembled rule set.
    async fn program(&self, cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
        let ast = cx.ast();
        // Every statement counts, not only the last, so the sequence is walked here.
        let statements: Vec<NodeId> = match elts.first().map(|&body| (body, ast.get(body))) {
            Some((_, Some(Node::Form { op: Op::Exprs, elts }))) => elts.clone(),
            Some((body, _)) => vec![body],
            None => Vec::new(),
        };
        let mut merged = Record::new();
        let mut corpus = Vec::new();
        for statement in statements {
            let Value::Record(mut value) = cx.eval(statement).await else { continue };
            let Some(Value::Str(part)) = value.get(&Key::tag(CONTRIBUTES)).cloned() else { continue };
            let contributed = value.remove(&Key::tag("value")).unwrap_or(Value::Undefined);
            match (part.as_str(), contributed) {
                ("tests", Value::List(cases)) => corpus = cases,
                ("tests", _) => corpus = Vec::new(),
                (_, contributed) => merged.insert(Key::tag(part), contributed),
            }
        }
        let compiled = options(&merged);
        let tests = match self.score(&compiled, corpus).await {
            Ok(tests) => tests,
            Err(err) => {
                cx.report(id, format!("tests: {err}"));
                Vec::new()
            }
        };
        Value::Record(
            [(Key::tag("options"), Value::Record(compiled)), (Key::tag("tests"), Value::List(tests))]
                .into_iter()
                .collect(),
        )
    }

    /// Scores each `[source, expected]` case: 1 if the translation is exactly the expected
    /// text, -1 otherwise. An empty expected value records what the rule set does today.
    async fn score(&self, compiled: &Record, corpus: Vec<Value>) -> Result<Vec<Value>, TranslatorError> {
        let cases: Vec<Vec<Value>> = corpus
            .into_iter()
            .filter_map(|case| match case {
                Value::List(case) => Some(case),
                _ => None,
            })
            .collect();
        if cases.is_empty() {
            return Ok(Vec::new());
        }
        let sources: Vec<String> = cases.iter().map(|case| case.first().map(text).unwrap_or_default()).collect();
        let translated = self.translator.translate(&to_json(compiled), &sources).await?;
        if translated.len() != cases.len() {
            return Err(TranslatorError(format!(
                "the translator answered {} of {} cases",
                translated.len(),
                cases.len()
            )));
        }
        Ok(cases
            .into_iter()
            .zip(translated)
            .map(|(case, translation)| {
                let mut case = case.into_iter();
                let source = case.next().unwrap_or(Value::Undefined);
                // The expected text is hand-written and wraps across lines, so it is
                // normalized; the translator's output is already canonical, and is not.
                let expected = Value::Str(trim(case.next().as_ref()));
                let actual = Value::from_json(&translation.value);
                let score = if actual == expected { 1.0 } else { -1.0 };
                Value::Record(
                    [
                        (Key::tag("score"), Value::from(score)),
                        (Key::tag("source"), source),
                        (Key::tag("actual"), actual),
                        (Key::tag("expected"), expected),
                    ]
                    .into_iter()
                    .collect(),
                )
            })
            .collect())
    }
}

/// A statement's value: one key of the rule set, tagged so the program can merge it.
fn contribution(part: &str, value: Value) -> Value {
    Value::Record(
        [(Key::tag(CONTRIBUTES), Value::Str(part.to_owned())), (Key::tag("value"), value)].into_iter().collect(),
    )
}

/// The compiled rule set. `data` is always present and always empty: every rule set there is
/// carries it, and emitting it keeps a compiled rule set identical to the shipping ones.
fn options(merged: &Record) -> Record {
    let mut out: Record = [(Key::tag("data"), Value::Record(Record::new()))].into_iter().collect();
    for part in ["words", "types", "rules"] {
        if let Some(value) = merged.get(&Key::tag(part)).filter(|value| value.is_truthy()) {
            out.insert(Key::tag(part), value.clone());
        }
    }
    for (_, field) in OPTIONS {
        match merged.get(&Key::tag(field)) {
            Some(Value::Undefined) | None => {}
            Some(value) => out.insert(Key::tag(field), value.clone()),
        }
    }
    out
}

/// A value as the JavaScript consumers of a rule set see it: every record keyed by name
/// alone, in the order written. When two keys share a name, the later one's value stands in
/// the earlier one's place. Keys that are array indices come first, in numeric order, because
/// that is the order a JavaScript object keeps them in whatever order they were written.
fn plain(value: Value) -> Value {
    match value {
        Value::Record(record) => {
            let named: Record =
                record.into_iter().map(|(key, value)| (Key::tag(key.name().into_owned()), plain(value))).collect();
            let index = |key: &Key| match key {
                Key::Tag(name) if name == "0" || !name.starts_with('0') => {
                    name.parse::<u32>().ok().filter(|n| *n < u32::MAX)
                }
                _ => None,
            };
            let mut indices: Vec<(u32, Key, Value)> = Vec::new();
            let mut names = Record::new();
            for (key, value) in named {
                match index(&key) {
                    Some(n) => indices.push((n, key, value)),
                    None => names.insert(key, value),
                }
            }
            indices.sort_by_key(|(n, ..)| *n);
            Value::Record(indices.into_iter().map(|(_, key, value)| (key, value)).chain(names).collect())
        }
        Value::List(items) => Value::List(items.into_iter().map(plain).collect()),
        other => other,
    }
}

fn to_json(record: &Record) -> Json {
    Value::Record(record.clone()).to_json().unwrap_or(Json::Null)
}

/// A value as source text for the translator; a missing one is the empty string.
fn text(value: &Value) -> String {
    match value {
        Value::Undefined | Value::Null => String::new(),
        other => other.display(),
    }
}

/// Collapses runs of spaces, tabs and newlines to one space and trims the ends.
pub fn trim(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::Str(text)) => text.clone(),
        Some(other) => text(other),
        None => String::new(),
    };
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\n') {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_collapses_whitespace_and_drops_the_ends() {
        let trimmed = |s: &str| trim(Some(&Value::from(s)));
        assert_eq!(trimmed("  a \t\n b  "), "a b");
        assert_eq!(trimmed("\\frac{1}{2}"), "\\frac{1}{2}");
        assert_eq!(trimmed(" \n "), "");
        assert_eq!(trimmed(""), "");
        // A carriage return is not one of the three, and stays.
        assert_eq!(trimmed("a\r\nb"), "a\r b");
        assert_eq!(trim(None), "");
        assert_eq!(trim(Some(&Value::Null)), "");
        assert_eq!(trim(Some(&Value::from(12.0))), "12");
    }

    #[test]
    fn options_are_emitted_in_the_shipping_order() {
        let merged: Record = [
            (Key::tag("RHS"), Value::Bool(false)),
            (Key::tag("rules"), Value::Record(Record::new())),
            (Key::tag("allowInterval"), Value::Bool(true)),
            (Key::tag("words"), Value::Record(Record::new())),
            (Key::tag("ignoreText"), Value::Undefined),
        ]
        .into_iter()
        .collect();
        let keys: Vec<String> = options(&merged).iter().map(|(key, _)| key.name().into_owned()).collect();
        assert_eq!(keys, ["data", "words", "rules", "allowInterval", "RHS"]);
    }
}
