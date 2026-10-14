// SPDX-License-Identifier: MIT

//! L0183 — concept webs: a hub in the centre, nodes on a circle around it, and lines between
//! them. A node or line with `assess` is a blank the learner fills from a tray.
//!
//! ```text
//! concept-web [
//!   hub text "The Cell" {}
//!   nodes [ node text "Nucleus" {} node text "Ribosome" assess [expected] {} ] tray-align left {}
//! ] title "Parts of a cell" {}..
//! ```
//!
//! A chain word (arity 2) takes its value and the rest of the chain and adds its field to the
//! chain's record; a typed member (`hub`, `node`, `edge`, arity 1) wraps a chain as
//! `{node: {...}}`; `assess [...]` holds the flags `expected`/`distractor` and `points`. The
//! containers `nodes`, `edges` and `concept-web` take a list and a settings record. Every word
//! is driven by the tables in `attributes.json`; the web itself is assembled in [`web`].
//!
//! Errors are reported as the TypeScript propagates them: a word reports after its arguments,
//! and a container whose arguments failed reports nothing more.

pub mod attributes;
pub mod js;
pub mod text;
pub mod web;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Diagnostic, Dialect, Evaluator, Lexicon, NodeId, Op, Record, Value};
use serde_json::{Value as Json, json};

use crate::attributes::{
    VOCAB, assert_known_attributes, assert_known_settings, check_value, member_example, merge_attributes, source_word,
    word_of,
};
use crate::js::{Object, get, is_record, plain, show_value, value};

/// The words L0183 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0183")).expect("L0183 redefines no base word")
});

/// L0183's vocabulary: the base lexicon with the concept-web words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

const WEB_EXAMPLE: &str = "concept-web [ hub text \"The Cell\" {} nodes [ node text \"Nucleus\" {} ] {} ] {}";

#[derive(Clone, Copy, Debug, Default)]
pub struct L0183;

#[async_trait]
impl Dialect for L0183 {
    fn lang_id(&self) -> &str {
        "0183"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let name = op.tag();
        Some(match name {
            "PROG" => program(cx, id).await,
            "CONCEPT_WEB" => concept_web(cx, id, elts).await,
            "NODES" => member_list(cx, id, elts, "nodes", "node").await,
            "EDGES" => member_list(cx, id, elts, "edges", "edge").await,
            _ if VOCAB.chain_fields.contains_key(name) => chain(cx, id, elts, name).await,
            _ if VOCAB.member_fields.contains_key(name) => member(cx, id, elts, name, &VOCAB.member_fields).await,
            _ => match VOCAB.assess_fields.get(name) {
                Some(meta) if meta.expects == "flag" => value(json!({ meta.field.clone(): true })),
                Some(_) => member(cx, id, elts, name, &VOCAB.assess_fields).await,
                None => return None,
            },
        })
    }
}

/// Reports an error as the TypeScript's string errors read: no source position.
fn fail(cx: &mut Evaluator<'_>, message: impl Into<String>) -> Value {
    cx.report_diagnostic(Diagnostic::new(message));
    Value::Record(Record::new())
}

/// An example chain for a word, for the "must end in a record" error.
fn chain_example(word: &str) -> String {
    match VOCAB.valid_settings.iter().find(|(_, words)| words.iter().any(|w| w == word)) {
        Some((owner, _)) if owner == "concept-web" => format!("] {word} … {{}}"),
        Some((owner, _)) => {
            format!("{owner} [ … ] {word} {} {{}}", if owner == "edges" { "bottom" } else { "left" })
        }
        None => format!("node {word} … {{}}"),
    }
}

/// A chain word, arity 2: its value and the rest of the chain, which must be a record.
/// `text "Nucleus" color "blue" {}` computes `{color, text}`.
async fn chain(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], name: &str) -> Value {
    let given = plain(&cx.eval_arg(id, elts, 0).await);
    let rest = plain(&cx.eval_arg(id, elts, 1).await);
    let meta = &VOCAB.chain_fields[name];
    let word = word_of(name);
    let checked = match check_value(name, meta, given.as_ref()) {
        Ok(checked) => checked,
        Err(error) => return fail(cx, error),
    };
    let Some(Json::Object(mut rest)) = rest.clone().filter(|rest| is_record(Some(rest))) else {
        return fail(
            cx,
            format!(
                "{word}: a chain must end in a record — write `{{}}` after the last word, e.g. {}. Got {}.",
                chain_example(&word),
                show_value(rest.as_ref())
            ),
        );
    };
    if rest.contains_key(&meta.field) {
        return fail(cx, format!("{word}: is given twice. Each word may appear once in a chain."));
    }
    rest.insert(meta.field.clone(), checked);
    value(Json::Object(rest))
}

/// A typed member (`node <chain>`) or `points n`, arity 1: `{field: value}`.
async fn member(
    cx: &mut Evaluator<'_>,
    id: NodeId,
    elts: &[NodeId],
    name: &str,
    table: &indexmap::IndexMap<String, attributes::Meta>,
) -> Value {
    let given = plain(&cx.eval_arg(id, elts, 0).await);
    let meta = &table[name];
    match check_value(name, meta, given.as_ref()) {
        Ok(checked) => value(json!({ meta.field.clone(): checked })),
        Err(error) => fail(cx, error),
    }
}

fn article(word: &str) -> String {
    let an = word.starts_with(['a', 'e', 'i', 'o', 'u']);
    format!("{} `{word}`", if an { "an" } else { "a" })
}

/// A misplaced member, as written.
fn describe(m: &Json) -> String {
    if let Some(fields) = m.as_object().filter(|_| is_record(Some(m))) {
        match fields.keys().collect::<Vec<_>>().as_slice() {
            [] => return "a stray `{}` — a chain ends in exactly one `{}`".to_owned(),
            [key] => return article(&source_word(key)),
            _ => {}
        }
    }
    show_value(Some(m))
}

/// Evaluates a container's list and settings: `None` when either reported an error, which the
/// container then adds nothing to.
async fn list_and_settings(
    cx: &mut Evaluator<'_>,
    id: NodeId,
    elts: &[NodeId],
) -> Option<(Option<Json>, Option<Json>)> {
    let before = cx.error_count();
    let list = plain(&cx.eval_arg(id, elts, 0).await);
    let settings = plain(&cx.eval_arg(id, elts, 1).await);
    (cx.error_count() == before).then_some((list, settings))
}

/// `nodes [ … ] {settings}` and `edges [ … ] {settings}`: the typed members, each checked as it
/// is read, and the tray's settings, handed to `concept-web` as `{nodes: {items, settings}}`.
async fn member_list(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], word: &str, member: &str) -> Value {
    let Some((list, settings)) = list_and_settings(cx, id, elts).await else {
        return Value::Record(Record::new());
    };
    let example = format!("{word} [ {} ] {{}}", member_example(member));
    let Some(Json::Array(list)) = list else {
        return fail(cx, format!("{word}: expected a list in [brackets], e.g. {example}."));
    };
    if !is_record(settings.as_ref()) {
        return fail(
            cx,
            format!(
                "{word}: needs its settings after the list, ending in a record — write `{{}}` when there are none, e.g. {example}."
            ),
        );
    }
    let read = || -> Result<Json, String> {
        let mut items = Vec::new();
        for (i, m) in list.iter().enumerate() {
            let fields = m.as_object().filter(|_| is_record(Some(m)));
            let only = fields.filter(|fields| fields.len() == 1).and_then(|fields| fields.get(member));
            let Some(attrs) = only else {
                return Err(format!(
                    "{word}: member {} is {}, not {}. Every member is written {}.",
                    i + 1,
                    describe(m),
                    article(member),
                    member_example(member)
                ));
            };
            // Checked here, member by member, so a word that ended a chain early is reported
            // where it was written, not as the stray `{}` after it.
            assert_known_attributes(member, Some(attrs), &format!("{member} {}", i + 1))?;
            items.push(attrs.clone());
        }
        assert_known_settings(word, settings.as_ref())?;
        Ok(json!({ word: { "items": items, "settings": settings } }))
    };
    match read() {
        Ok(members) => value(members),
        Err(error) => fail(cx, error),
    }
}

/// `concept-web [children] {settings}`: the children say what the diagram is, the settings how
/// it is presented.
async fn concept_web(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let Some((children, settings)) = list_and_settings(cx, id, elts).await else {
        return Value::Record(Record::new());
    };
    let Some(Json::Object(settings)) = settings.filter(|settings| is_record(Some(settings))) else {
        return fail(
            cx,
            "concept-web: needs its settings after the list, ending in a record — write `{}` when there are none, e.g. concept-web [ … ] title \"…\" {}.",
        );
    };
    let data = plain(cx.data());
    let build = || -> Result<Json, String> {
        let web: Object = merge_attributes(children.as_ref(), "concept-web", WEB_EXAMPLE)?;
        assert_known_attributes("concept-web", Some(&Json::Object(web.clone())), "concept-web")?;
        assert_known_settings("concept-web", Some(&Json::Object(settings.clone())))?;
        web::build_web(&web, &settings, data)
    };
    match build() {
        Ok(web) => value(web),
        Err(error) => fail(cx, error),
    }
}

/// The program's value is its last expression, which must be a concept web. Nothing from
/// upstream data is spread over it: `concept-web` takes exactly each blank's answer from there.
async fn program(cx: &mut Evaluator<'_>, id: NodeId) -> Value {
    let before = cx.error_count();
    let value = cx.eval_kernel(id).await;
    let json = plain(&value);
    let is_web = is_record(json.as_ref())
        && get(get(json.as_ref(), "interaction").as_ref(), "type").is_some_and(|kind| kind == "concept-web");
    if cx.error_count() == before && !is_web {
        return fail(
            cx,
            format!(
                "A program is one concept web: concept-web [ hub … {{}} nodes [ … ] {{}} ] {{}}.. — e.g. {WEB_EXAMPLE}.."
            ),
        );
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lexicon_carries_every_word_of_the_tables() {
        let tables = [&VOCAB.chain_fields, &VOCAB.member_fields, &VOCAB.assess_fields];
        for name in tables.into_iter().flat_map(|table| table.keys()) {
            assert!(lexicon().get(&word_of(name)).is_some(), "{name} is not in the lexicon");
        }
        for word in ["concept-web", "nodes", "edges", "DARK", "left"] {
            assert!(lexicon().get(word).is_some(), "{word} is not in the lexicon");
        }
    }

    #[test]
    fn examples_name_where_a_setting_goes() {
        assert_eq!(chain_example("title"), "] title … {}");
        assert_eq!(chain_example("tray-align"), "nodes [ … ] tray-align left {}");
        assert_eq!(chain_example("text"), "node text … {}");
        assert_eq!(article("edge"), "an `edge`");
        assert_eq!(describe(&json!({})), "a stray `{}` — a chain ends in exactly one `{}`");
        assert_eq!(describe(&json!({ "trayAlign": "x" })), "a `tray-align`");
        assert_eq!(describe(&json!("x")), "\"x\"");
    }
}
