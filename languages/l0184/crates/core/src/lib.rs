// SPDX-License-Identifier: MIT

//! L0184 — charts drawn with Apache ECharts 6. A program is one collection of charts; each
//! chart holds datasets, axes, plots, a legend and a tooltip, and compiles to a complete
//! ECharts option, checked before anything is drawn.
//!
//! ```text
//! charts [
//!   chart [
//!     plots [ plot kind BAR name "Visitors" values [120 132 101 134] {} ] {}
//!   ] title "Weekly visitors" {}
//! ] {}..
//! ```
//!
//! Four construct shapes, as in `packages/core/src/attributes.ts`: CONTAINERS (`charts`,
//! `chart`, `datasets`, `axes`, `plots`: a member list, then a settings chain), MEMBERS
//! (`dataset`, `axis`, `plot`, `legend`, `tooltip`: one description), PROPERTIES (everything
//! else: a value, then the rest of the chain), and TAGS (`BAR`, `DARK`, …, which the kernel
//! evaluates). Every handler is driven by the vocabulary table, as the TypeScript's are
//! generated from it. A handler sees its arguments as the TypeScript does after
//! `toPlainObject` ([`js::Js`]), and errors accumulate as the TypeScript's do: a property or
//! member that fails reports and yields `{}`; a container whose parts failed yields `{}`
//! without adding an error of its own.

// `!(a > b)` is the TypeScript's own test, and it is deliberately true for NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod chart;
pub mod collection;
pub mod colors;
pub mod data;
pub mod date;
#[macro_use]
pub mod js;
pub mod stats;
pub mod vocab;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Lexicon, Node, NodeId, Op, Value};

use crate::js::{Js, is_record, keys};
use crate::vocab::{
    VOCAB, assert_known_attributes, assert_known_settings, check_value, example_of, hint_for, show_value, source_word,
    word_of,
};

/// The words L0184 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0184")).expect("L0184 redefines no base word")
});

/// L0184's vocabulary: the base lexicon with the chart words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

const PROGRAM_EXAMPLE: &str = "charts [ chart [ plots [ plot kind BAR values [3 5 2] {} ] {} ] {} ] {}";

/// The values L0184's own words built that are a `charts` envelope. A program's value must be
/// one of them: a record literal `{type: "charts"}` is not (in TypeScript it is still L0000's
/// internal record, which has no `type`).
#[derive(Default)]
struct Envelopes(Vec<Value>);

#[derive(Clone, Copy, Debug, Default)]
pub struct L0184;

#[async_trait]
impl Dialect for L0184 {
    fn lang_id(&self) -> &str {
        "0184"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    /// A `{}` written before the end of a description ends it there, and the words after it
    /// parse as a second top-level expression — well formed, and silently dropped. An L0184
    /// word or a bare `{}` anywhere but the last position is reported. L0000 expressions may
    /// still precede the program.
    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        let Some(Node::Form { op: Op::Prog, elts }) = ast.get(ast.root()) else { return };
        let exprs: &[NodeId] = match elts.first().and_then(|&e| ast.get(e)) {
            Some(Node::Form { elts, .. }) => elts,
            _ => &[],
        };
        let own = |id: NodeId| match ast.get(id) {
            Some(Node::Form { op, .. }) => *op == Op::Record || word(op.tag()).is_some(),
            _ => false,
        };
        let Some(at) = exprs.iter().take(exprs.len().saturating_sub(1)).position(|&e| own(e)) else { return };
        errors.push(Diagnostic::at(
            format!(
                "A `{{}}` ended a description early: the program has {} top-level expressions where one `charts [ … ] {{}}` was expected, and the words after the early `{{}}` started a new one. Every description ends in exactly one `{{}}`, after its last word: write `plot kind BAR values [1 2] {{}}`, not `plot kind BAR {{}} values [1 2] {{}}`.",
                exprs.len()
            ),
            ast.span(exprs[at + 1]),
        ));
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if *op == Op::Prog {
            let value = cx.eval_kernel(id).await;
            if cx.error_count() > 0 {
                return Some(Value::Record(Default::default()));
            }
            if !cx.exec().state::<Envelopes>().0.contains(&value) {
                cx.report_diagnostic(Diagnostic::new(format!(
                    "A program is one charts collection, ending in `..`: e.g. {PROGRAM_EXAMPLE}.."
                )));
                return Some(Value::Record(Default::default()));
            }
            return Some(value);
        }
        let result = match word(tag)? {
            Word::Property => {
                let v0 = Js::from_value(&cx.eval_arg(id, elts, 0).await);
                let v1 = Js::from_value(&cx.eval_arg(id, elts, 1).await);
                property(tag, v0, v1)
            }
            Word::Member => {
                let v0 = Js::from_value(&cx.eval_arg(id, elts, 0).await);
                let meta = &VOCAB.member_fields[tag];
                check_value(tag, meta, v0).map(|value| Js::Obj(obj! { meta.field.as_str() => value }))
            }
            Word::Container => {
                let before = cx.error_count();
                let v0 = Js::from_value(&cx.eval_arg(id, elts, 0).await);
                let v1 = Js::from_value(&cx.eval_arg(id, elts, 1).await);
                if cx.error_count() > before {
                    return Some(Value::Record(Default::default()));
                }
                container(tag, v0, v1)
            }
        };
        Some(match result {
            Ok(js) => {
                let value = js.to_value();
                if matches!(&js, Js::Obj(o) if o.get("type").and_then(Js::as_str) == Some("charts")) {
                    cx.exec().state::<Envelopes>().0.push(value.clone());
                }
                value
            }
            Err(message) => {
                cx.report_diagnostic(Diagnostic::new(message));
                Value::Record(Default::default())
            }
        })
    }
}

enum Word {
    Property,
    Member,
    Container,
}

fn word(tag: &str) -> Option<Word> {
    if VOCAB.chain_fields.contains_key(tag) {
        Some(Word::Property)
    } else if VOCAB.member_fields.contains_key(tag) {
        Some(Word::Member)
    } else if VOCAB.container_fields.contains_key(tag) {
        Some(Word::Container)
    } else {
        None
    }
}

/* ------------------------------------------------------------------ properties */

/// Where a property's chain goes, for the "must end in a record" error.
fn chain_example(word: &str) -> String {
    let owner = VOCAB.valid_settings.iter().find(|(_, ws)| ws.iter().any(|w| w == word)).map(|(c, _)| c.as_str());
    match owner {
        Some("charts") => format!("charts [ … ] {word} … {{}}"),
        Some("chart") => format!("chart [ … ] {word} … {{}}"),
        _ => format!("plot kind BAR {word} … {{}}"),
    }
}

/// A property: its value AND the rest of the chain; returns the chain's record plus this key.
fn property(name: &str, v0: Js, rest: Js) -> Result<Js, String> {
    let meta = &VOCAB.chain_fields[name];
    let word = word_of(name);
    let value = check_value(name, meta, v0)?;
    let mut rest = match rest {
        Js::Obj(object) if is_record(&Js::Obj(object.clone())) => object,
        other => return Err(not_a_record(&word, &other)),
    };
    if rest.contains_key(&meta.field) {
        return Err(format!("{word}: is given twice. Each word may appear once in a description."));
    }
    rest.insert(meta.field.clone(), value);
    Ok(Js::Obj(js::js_order(rest)))
}

fn not_a_record(word: &str, rest: &Js) -> String {
    format!(
        "{word}: a description must end in a record — write `{{}}` after its last word, e.g. {}. Got {}.",
        chain_example(word),
        show_value(rest)
    )
}

/* ------------------------------------------------------------------ containers */

fn article(w: &str) -> String {
    format!("{} `{w}`", if w.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" })
}

/// Something in a list, as written, for an error message.
fn describe(m: &Js) -> String {
    if is_record(m) {
        let ks = keys(m);
        return match ks.len() {
            0 => "a stray `{}` — a description ends in exactly one `{}`".to_owned(),
            1 => article(&source_word(&ks[0])),
            _ => {
                let words: Vec<String> = ks.iter().map(|k| source_word(k)).collect();
                format!("a description ({}) with no word in front of it", words.join(", "))
            }
        };
    }
    show_value(m)
}

/// Words that start a list item on their own, as opposed to properties inside one.
fn is_item_word(w: &str) -> bool {
    VOCAB.member_fields.keys().chain(VOCAB.container_fields.keys()).any(|name| word_of(name) == w)
}

/// When a list item is a bare property, the usual cause is a `{}` that ended the previous
/// description early.
fn early_close(m: &Js, prev: &str) -> String {
    let ks = if is_record(m) { keys(m) } else { Vec::new() };
    if ks.len() != 1 || is_item_word(&source_word(&ks[0])) {
        return String::new();
    }
    let w = source_word(&ks[0]);
    format!(
        " If `{w}` belongs to the {prev} before it, a `{{}}` ended that {prev} early: a description ends in exactly one `{{}}`, after its last word."
    )
}

fn container(tag: &str, list: Js, settings: Js) -> Result<Js, String> {
    let word = VOCAB.container_fields[tag].word.clone();
    let Js::Arr(list) = list else {
        return Err(format!("{word}: expected a list in [brackets], e.g. {}.", example_of(&word)));
    };
    if !is_record(&settings) {
        return Err(format!(
            "{word}: needs its settings after the `]`, ending in a record — write `{{}}` when there are none, e.g. {}.",
            example_of(&word)
        ));
    }
    match word.as_str() {
        "charts" => {
            assert_known_settings("charts", &settings, "charts")?;
            let got = collect_parts("charts", &list, "charts")?;
            let datasets = got.iter().find(|(p, _)| p == "datasets").and_then(|(_, v)| v.first());
            let charts = got.iter().find(|(p, _)| p == "chart").map(|(_, v)| v.clone()).unwrap_or_default();
            collection::build_collection(datasets, &charts, &settings)
        }
        "chart" => {
            let id = settings.get("id");
            let place = if id.is_undefined() { "chart".to_owned() } else { format!("chart {}", js::stringify(id)) };
            assert_known_settings("chart", &settings, &place)?;
            let got = collect_parts("chart", &list, &place)?;
            let part = |p: &str| got.iter().find(|(name, _)| name == p).and_then(|(_, v)| v.first());
            let plots = part("plots").cloned().unwrap_or(Js::Undefined);
            if plots.prop("items")?.as_arr().is_some_and(Vec::is_empty) {
                return Err(format!(
                    "{place}: plots is empty. A chart needs at least one plot, e.g. {}.",
                    example_of("plots")
                ));
            }
            let mut parts = obj! { "plots" => plots };
            for p in ["datasets", "axes", "legend", "tooltip"] {
                if let Some(v) = part(p) {
                    parts.insert(p.into(), v.clone());
                }
            }
            Ok(Js::Obj(obj! { "chart" => obj! { "parts" => parts, "settings" => settings } }))
        }
        list_word => {
            assert_known_settings(list_word, &settings, list_word)?;
            let member = VOCAB.list_member[list_word].clone();
            let mut items = Vec::with_capacity(list.len());
            for (i, m) in list.iter().enumerate() {
                let ks = if is_record(m) { keys(m) } else { Vec::new() };
                if ks.len() != 1 || ks[0] != member {
                    let early = if i > 0 { early_close(m, &member) } else { String::new() };
                    return Err(format!(
                        "{list_word}: item {} is {}, not {}. Every item is written {}.{early}",
                        i + 1,
                        describe(m),
                        article(&member),
                        example_of(&member)
                    ));
                }
                let rec = m.get(&member);
                let id = rec.prop("id")?;
                let named = if id.truthy() { js::stringify(id) } else { (i + 1).to_string() };
                assert_known_attributes(&member, rec, &format!("{member} {named}"), None)?;
                items.push(rec.clone());
            }
            Ok(Js::Obj(obj! { list_word => obj! { "items" => Js::Arr(items) } }))
        }
    }
}

/// A container's parts, each at most (and at least) as often as `containerParts` allows.
fn collect_parts(word: &str, list: &[Js], place: &str) -> Result<Vec<(String, Vec<Js>)>, String> {
    let allowed = &VOCAB.container_parts[word];
    let mut got: Vec<(String, Vec<Js>)> = Vec::new();
    for (i, m) in list.iter().enumerate() {
        let ks = if is_record(m) { keys(m) } else { Vec::new() };
        let part = (ks.len() == 1).then(|| source_word(&ks[0]));
        let Some(part) = part.clone().filter(|p| allowed.contains_key(p)) else {
            let hint = match &part {
                None => String::new(),
                Some(p) if VOCAB.valid_settings.get(word).is_some_and(|s| s.contains(p)) => format!(
                    " `{p}` is a setting of {word}: write it after the {} `]`, e.g. {word} [ … ] {p} … {{}}.",
                    if word == "charts" { "outer" } else { "chart's" }
                ),
                Some(p) => hint_for(p, word),
            };
            let holds: Vec<&str> = allowed.keys().map(String::as_str).collect();
            return Err(format!(
                "{place}: item {} is {}, which is not a part of {word}. It holds: {}.{hint}",
                i + 1,
                describe(m),
                holds.join(", ")
            ));
        };
        let at = match got.iter().position(|(p, _)| *p == part) {
            Some(at) => at,
            None => {
                got.push((part.clone(), Vec::new()));
                got.len() - 1
            }
        };
        got[at].1.push(m.get(&ks[0]).clone());
        let count = got[at].1.len();
        if allowed[&part].max.is_some_and(|max| count as f64 > max) {
            return Err(format!(
                "{place}: `{part}` appears {count} times. {} takes one `{part}`; put everything in it.",
                if word == "chart" { "A chart" } else { "The collection" }
            ));
        }
    }
    for (part, limits) in allowed {
        let count = got.iter().find(|(p, _)| p == part).map_or(0, |(_, v)| v.len());
        if (count as f64) < limits.min {
            let need = if limits.min == 1.0 { "a".to_owned() } else { format!("at least {}", js::num(limits.min)) };
            return Err(format!("{place}: needs {need} `{part}`, e.g. {}.", example_of(word)));
        }
    }
    Ok(got)
}

#[cfg(test)]
mod tests {
    use super::*;
    use graffiticode_l0000::{Compiler, Identity};
    use serde_json::json;

    #[test]
    fn the_lexicon_adds_words_and_overrides_none() {
        let lexicon = lexicon();
        for word in ["data", "use", "map", "filter", "min", "max", "log", "range", "get"] {
            assert_eq!(lexicon.get(word), Lexicon::base().get(word), "{word}");
        }
        assert_eq!(lexicon.get("min-value").map(|e| e.arity), Some(2));
        assert_eq!(lexicon.get("plot").map(|e| e.arity), Some(1));
        assert_eq!(lexicon.get("BAR").map(|e| e.name.as_str()), Some("TAG"));
    }

    #[test]
    fn every_tag_is_one_kind_of_word() {
        assert!(matches!(word("X_AXIS"), Some(Word::Property)));
        assert!(matches!(word("PLOT"), Some(Word::Member)));
        assert!(matches!(word("CHARTS"), Some(Word::Container)));
        assert!(word("BAR").is_none() && word("ADD").is_none());
    }

    /// `{} 42..` — a stray `{}` before the program's last expression.
    #[tokio::test]
    async fn an_early_closing_record_is_reported_before_anything_runs() {
        let code = json!({
            "1": { "tag": "RECORD", "elts": [] },
            "2": { "tag": "NUM", "elts": ["42"] },
            "3": { "tag": "EXPRS", "elts": [1, 2] },
            "4": { "tag": "PROG", "elts": [3] },
            "root": 4,
        });
        let compiled = Compiler::new(L0184).compile(&code, &json!({}), &json!({}), Identity::default()).await;
        let errors = compiled.result.unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.starts_with("A `{}` ended a description early: the program has 2 top-level"));
    }
}
