// SPDX-License-Identifier: MIT

//! L0180 — quizzes and assessment items delivered in a browser. A program is one item: an
//! interaction (`choice`, `hottext`, `text-entry`, `inline-choice`, `order`, `match`,
//! `classification`, `gap-match`, `extended-text`), an `item` wrapping several of them over a
//! stimulus, or an activity of items (`items [ … ] {}`).
//!
//! ```text
//! choice [
//!   prompt "What is 2 + 2?"
//!   options [ [ text "3" ] [ text "4" assess [ correct ] ] [ text "5" ] ] {}
//! ]..
//! ```
//!
//! A compiled item is `interaction` (what the candidate sees) and `validation` (the answer key),
//! kept apart so a graded delivery can withhold the second. Every attribute word evaluates to a
//! one-key record and a `[…]` list of them merges; the containers assemble the two halves and
//! refuse, with a message naming the fix, anything that would compile to a broken item.

pub mod anchors;
pub mod attributes;
pub mod decimal;
pub mod hottext;
pub mod inlinechoice;
pub mod matching;
pub mod order;
pub mod pairing;
pub mod plain;
pub mod text;
pub mod textentry;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Diagnostic, Dialect, Evaluator, Lexicon, Node, NodeId, Op, Value};
use serde_json::{Value as Json, json};

use crate::anchors::{is_anchored, keeps_order, option_label};
use crate::attributes::{
    Meta, VOCAB, assert_assess_words, assert_known_attributes, check_value, merge_attributes, template_id, word_of,
};
use crate::hottext::{Unit, resolve_selections, sentence_units, word_units};
use crate::pairing::{PairWords, pair, texts};
use crate::plain::{
    Object, gt, join, js_str, js_str_or_empty, json_num, num, number, plain, prop, same_key, spread, spread_or_empty,
    string, to_number, truthy, value,
};

/// The words L0180 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0180")).expect("L0180 redefines no base word")
});

/// L0180's vocabulary: the base lexicon with the assessment words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0180;

/// What a word's evaluation produced: its value, or the error that replaced it with `{}`.
type Built = Result<Json, String>;

#[async_trait]
impl Dialect for L0180 {
    fn lang_id(&self) -> &str {
        "0180"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if tag == "PROG" {
            return Some(prog(cx, id, elts).await);
        }
        if let Some(meta) = VOCAB.attributes.get(tag) {
            if meta.is_flag() {
                return Some(value(json!({ meta.field.clone(): true })));
            }
            let raw = plain(&cx.eval_arg(id, elts, 0).await);
            return Some(finish(cx, attribute(tag, meta, raw)));
        }
        if let Some(meta) = VOCAB.config.get(tag) {
            let raw = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            return Some(finish(cx, config_word(tag, meta, raw, rest)));
        }
        let member = |container: &'static str, field: &'static str, error: String| Member { container, field, error };
        let list = |field: &str, example: &str| format!("{}: expected a list, e.g. {example}", word_of(field));
        let members = match tag {
            "OPTIONS" => Some(member(
                "option",
                "options",
                "options: expected a list of options, e.g. options [[text \"A\"] [text \"B\"]] {}.".into(),
            )),
            "SELECTIONS" => Some(member(
                "selection",
                "selections",
                "selections: expected a list of selections, e.g. selections [[quote \"…\" assess [correct]]] {}."
                    .into(),
            )),
            "RUBRIC" => Some(member(
                "band",
                "rubric",
                "rubric: expected a list of bands, e.g. rubric [[score 2 descriptor \"…\"]] {}.".into(),
            )),
            "BLANKS" => Some(member(
                "blank",
                "blanks",
                "blanks: expected a list of blanks, e.g. blanks [[id \"capital\" responses [...] {}]] {}.".into(),
            )),
            "RESPONSES" => Some(member(
                "response",
                "responses",
                "responses: expected a list of answers, e.g. responses [[response \"Paris\" assess [correct]]] {}."
                    .into(),
            )),
            "DROPDOWNS" => Some(member(
                "dropdown",
                "dropdowns",
                "dropdowns: expected a list of dropdowns, e.g. dropdowns [[id \"gas\" options [...] {}]] {}.".into(),
            )),
            "ELEMENTS" => Some(member(
                "element",
                "elements",
                "elements: expected a list of elements, e.g. elements [[text \"First\" assess [position 1]]] {}."
                    .into(),
            )),
            "TARGETS" => {
                Some(member("target", "targets", list("targets", "targets [[id \"paris\" text \"Paris\"]] {}.")))
            }
            "MATCH_ITEMS" => Some(member(
                "match-item",
                "matchItems",
                list("matchItems", "match-items [[text \"France\" assess [target \"paris\"]]] {}."),
            )),
            "CATEGORIES" => Some(member(
                "category",
                "categories",
                list("categories", "categories [[id \"mammal\" text \"Mammal\"]] {}."),
            )),
            "CLASSIFICATION_ITEMS" => Some(member(
                "classification-item",
                "classificationItems",
                list("classificationItems", "classification-items [[text \"Whale\" assess [category \"mammal\"]]] {}."),
            )),
            "TOKENS" => Some(member("token", "tokens", list("tokens", "tokens [[id \"moon\" text \"Moon\"]] {}."))),
            "GAPS" => Some(member("gap", "gaps", list("gaps", "gaps [[id \"a\" assess [token \"moon\"]]] {}."))),
            _ => None,
        };
        if let Some(members) = members {
            let raw = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            return Some(finish(cx, members.build(raw, rest)));
        }
        match tag {
            "PARTS" | "ITEMS" => {
                let raw = plain(&cx.eval_arg(id, elts, 0).await);
                let rest = plain(&cx.eval_arg(id, elts, 1).await);
                let built = if tag == "PARTS" { parts(raw, rest) } else { items(raw, rest) };
                Some(finish(cx, built))
            }
            "CHOICE" | "HOTTEXT" | "TEXT_ENTRY" | "INLINE_CHOICE" | "ORDER" | "MATCH" | "CLASSIFICATION"
            | "GAP_MATCH" | "EXTENDED_TEXT" | "ITEM" => {
                let raw = plain(&cx.eval_arg(id, elts, 0).await);
                let container = word_of(tag);
                let built = merged(&container, raw.as_ref()).and_then(|attrs| match tag {
                    "CHOICE" => choice(&attrs),
                    "HOTTEXT" => hottext(&attrs),
                    "TEXT_ENTRY" => text_entry(&attrs),
                    "INLINE_CHOICE" => inline_choice(&attrs),
                    "ORDER" => order(&attrs),
                    "MATCH" => pairing_interaction("match", &MATCH_WORDS, "targets", "matchItems", &attrs),
                    "CLASSIFICATION" => pairing_interaction(
                        "classification",
                        &CLASSIFICATION_WORDS,
                        "categories",
                        "classificationItems",
                        &attrs,
                    ),
                    "GAP_MATCH" => gap_match(&attrs),
                    "EXTENDED_TEXT" => extended_text(&attrs),
                    _ => item(&attrs),
                });
                Some(finish(cx, built))
            }
            _ => None,
        }
    }
}

/// A word's value, or `{}` with its error reported — the TypeScript's `resume(err, {})`.
fn finish(cx: &mut Evaluator<'_>, built: Built) -> Value {
    match built {
        Ok(json) => value(json),
        Err(message) => {
            cx.report_diagnostic(Diagnostic::new(message));
            value(json!({}))
        }
    }
}

/// A container's attribute list, merged and checked against what it takes.
fn merged(container: &str, raw: Option<&Json>) -> Result<Object, String> {
    let attrs = merge_attributes(raw, container)?;
    assert_known_attributes(container, &attrs)?;
    Ok(attrs)
}

/// An attribute word applied to its value: a one-key record.
fn attribute(name: &str, meta: &Meta, raw: Option<Json>) -> Built {
    if let Some(error) = check_value(name, meta, raw.as_ref()) {
        return Err(error);
    }
    let field = meta.field.clone();
    if meta.shape.as_deref() == Some("object") {
        return Ok(json!({ field: merged(&word_of(name), raw.as_ref())? }));
    }
    let mut out = Object::new();
    if let Some(raw) = raw {
        out.insert(field, raw);
    }
    Ok(Json::Object(out))
}

/// An activity-level word: its value, and the rest of the chain it adds itself to.
fn config_word(name: &str, meta: &Meta, raw: Option<Json>, rest: Option<Json>) -> Built {
    if let Some(error) = check_value(name, meta, raw.as_ref()) {
        return Err(error);
    }
    let word = word_of(name);
    match rest {
        Some(Json::Object(mut rest)) => {
            if rest.contains_key(&meta.field) {
                return Err(format!("{word}: is given twice. Each activity setting may appear once."));
            }
            rest.insert(meta.field.clone(), raw.unwrap_or(Json::Null));
            Ok(Json::Object(rest))
        }
        _ => Err(format!("{word}: the activity's settings must end in a record, e.g. items [ … ] {word} … {{}}.")),
    }
}

/// A member list: homogeneous children, each merged and checked on its own, plus the
/// container's own configuration record.
struct Member {
    container: &'static str,
    field: &'static str,
    error: String,
}

impl Member {
    fn build(self, raw: Option<Json>, rest: Option<Json>) -> Built {
        let Some(Json::Array(entries)) = raw else { return Err(self.error) };
        let list = entries
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let merged = merge_attributes(Some(entry), &format!("{} {}", self.container, i + 1))?;
                assert_known_attributes(self.container, &merged)?;
                Ok(Json::Object(merged))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut out = spread_or_empty(rest.as_ref());
        out.insert(self.field.into(), Json::Array(list));
        Ok(Json::Object(out))
    }
}

/// The attribute, when it was given (`attrs.x !== undefined`).
fn given<'a>(attrs: &'a Object, field: &str) -> Option<&'a Json> {
    attrs.get(field)
}

/// `attrs.x !== undefined ? attrs.x : fallback`.
fn or(attrs: &Object, field: &str, fallback: Json) -> Json {
    attrs.get(field).cloned().unwrap_or(fallback)
}

/// The list an attribute holds, or nothing when it is not a list.
fn list<'a>(attrs: &'a Object, field: &str) -> &'a [Json] {
    match attrs.get(field) {
        Some(Json::Array(items)) => items,
        _ => &[],
    }
}

/// `attrs.x || []`, read as a list.
fn or_empty_list(attrs: &Object, field: &str) -> Vec<Json> {
    match attrs.get(field) {
        Some(Json::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// Starts an interaction: `{type, prompt?}`.
fn interaction(kind: &str, attrs: &Object) -> Object {
    let mut out = Object::new();
    out.insert("type".into(), json!(kind));
    if let Some(prompt) = given(attrs, "prompt") {
        out.insert("prompt".into(), prompt.clone());
    }
    out
}

fn assembled(interaction: Object, validation: Object) -> Json {
    json!({ "interaction": Json::Object(interaction), "validation": Json::Object(validation) })
}

/// Randomizing is the default; what the author wrote always wins, and `keeps_order` decides
/// only when they wrote nothing, over the options that are not anchored.
fn resolve_shuffle(authored: Option<&Json>, options: &[Json]) -> bool {
    if let Some(Json::Bool(authored)) = authored {
        return *authored;
    }
    let unanchored: Vec<Json> = options.iter().filter(|o| !truthy(prop(Some(o), "anchored"))).cloned().collect();
    !keeps_order(&texts(&unanchored))
}

/// The response-processing template an interaction names, and whether it is exact-set.
fn template(attrs: &Object) -> (Json, bool) {
    let template = or(attrs, "responseProcessing", json!("map-response"));
    let exact = template == json!("match-correct");
    (template, exact)
}

/* --------------------------------------------------------------------------- choice */

fn choice(attrs: &Object) -> Built {
    let opts = or_empty_list(attrs, "options");
    if opts.is_empty() {
        return Err("choice: needs at least one option, e.g. options [[text \"A\"]] {}.".into());
    }
    let mut seen: Vec<(Json, usize)> = Vec::new();
    let mut with_ids: Vec<(Json, Object)> = Vec::new();
    for (i, opt) in opts.iter().enumerate() {
        let id = prop(Some(opt), "id").cloned().unwrap_or_else(|| json!(option_label(i)));
        if let Some((_, prior)) = seen.iter().find(|(seen, _)| same_key(seen, &id)) {
            return Err(format!(
                "choice: two options share the id \"{}\" (options {prior} and {}). Ids must be unique; omit `id` to have them derived.",
                js_str(Some(&id)),
                i + 1
            ));
        }
        seen.push((id.clone(), i + 1));
        let mut opt = spread(Some(opt));
        opt.insert("id".into(), id.clone());
        with_ids.push((id, opt));
    }

    let (template, exact) = template(attrs);
    let mut mapping = Object::new();
    let mut correct_response: Vec<Json> = Vec::new();
    let mut feedback = Object::new();
    let mut points = 0.0;
    let mut assessed = 0;
    for (id, opt) in &with_ids {
        let key = js_str(Some(id));
        let Some(assess) = opt.get("assess") else { continue };
        assert_assess_words(Some(assess), &["correct", "points", "rationale"], &format!("option \"{key}\""))?;
        assessed += 1;
        let is_correct = prop(Some(assess), "correct") == Some(&json!(true));
        let has_points = number(prop(Some(assess), "points")).is_some();
        let rationale = string(prop(Some(assess), "rationale"));
        if !is_correct && !has_points && rationale.is_none() {
            return Err(format!(
                "option \"{key}\": assess must say what it asserts — `correct`, `points`, or `rationale`. `assess [correct]` marks the answer; `assess [points -1]` penalizes a distractor; `assess [rationale \"…\"]` explains one."
            ));
        }
        if let Some(rationale) = rationale {
            feedback.insert(key.clone(), json!(rationale));
        }
        if is_correct {
            correct_response.push(id.clone());
        }
        if exact {
            if has_points {
                return Err(format!(
                    "option \"{key}\": `points` is not meaningful under `response-processing \"match-correct\"`, which awards the item's points for exactly the correct set and nothing otherwise. Remove `points`, or use the default `response-processing \"map-response\"` to score each option."
                ));
            }
            continue;
        }
        if !is_correct && !has_points {
            continue;
        }
        let value = if has_points { prop(Some(assess), "points").cloned().unwrap_or_default() } else { json!(1) };
        if is_correct {
            points += to_number(Some(&value));
        }
        mapping.insert(
            key,
            if is_correct { json!({ "correct": true, "points": value }) } else { json!({ "points": value }) },
        );
    }
    let correct_count = correct_response.len();
    if assessed > 0 && correct_count == 0 {
        return Err("choice: no option is marked `correct`, so the item cannot be scored. Add `assess [correct]` to the right answer, or remove every `assess` for an unscored item.".into());
    }
    if exact && correct_count == 0 {
        return Err("choice: `response-processing \"match-correct\"` scores against the correct set, but no option is marked `correct`. Add `assess [correct]` to every option that belongs in the answer.".into());
    }
    let mut points = json_num(if exact { 1.0 } else { points });
    let upper_bound = given(attrs, "upperBound");
    let bounded = upper_bound.is_some() && !exact;
    if upper_bound.is_some() && exact {
        return Err("choice: `upper-bound` is not meaningful under `response-processing \"match-correct\"`, which already requires exactly the correct set.".into());
    }
    if bounded {
        if gt(upper_bound, Some(&points)) {
            return Err(format!(
                "choice: upper-bound is {} but the correct options are only worth {}. Lower `upper-bound`, or mark more options correct.",
                js_str(upper_bound),
                js_str(Some(&points))
            ));
        }
        points = upper_bound.cloned().unwrap_or_default();
    }
    let max_choices = or(attrs, "maxChoices", json!(1));
    let min_choices = or(attrs, "minChoices", json!(0));
    if gt(Some(&json!(correct_count)), Some(&max_choices)) && !bounded {
        return Err(format!(
            "choice: {correct_count} options are marked `correct` but max-choices is {}. Raise `max-choices` for a multi-select item, or mark fewer options correct.",
            js_str(Some(&max_choices))
        ));
    }
    if gt(Some(&min_choices), Some(&max_choices)) {
        return Err(format!(
            "choice: min-choices ({}) is greater than max-choices ({}).",
            js_str(Some(&min_choices)),
            js_str(Some(&max_choices))
        ));
    }

    let options: Vec<Json> = with_ids
        .iter()
        .map(|(id, opt)| {
            let label = opt.get("text").cloned().unwrap_or(json!(""));
            let mut option = json!({ "id": id, "text": label });
            if is_anchored(&js_str_or_empty(Some(&label))) {
                option["anchored"] = json!(true);
            }
            option
        })
        .collect();
    let shuffle = resolve_shuffle(given(attrs, "shuffle"), &options);

    let mut shown = interaction("choice", attrs);
    shown.insert("minChoices".into(), min_choices);
    shown.insert("maxChoices".into(), max_choices.clone());
    shown.insert("shuffle".into(), json!(shuffle));
    shown.insert("options".into(), Json::Array(options));
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!(template_id(&js_str(Some(&template)))));
    validation.insert("cardinality".into(), json!(cardinality(&max_choices)));
    validation.insert("baseType".into(), json!("identifier"));
    validation.insert("points".into(), points);
    if exact {
        validation.insert("correctResponse".into(), Json::Array(correct_response));
    } else {
        validation.insert("mapping".into(), Json::Object(mapping));
    }
    if bounded {
        validation.insert("upperBound".into(), upper_bound.cloned().unwrap_or_default());
    }
    if !feedback.is_empty() {
        validation.insert("feedback".into(), Json::Object(feedback));
    }
    Ok(assembled(shown, validation))
}

fn cardinality(max_choices: &Json) -> &'static str {
    if gt(Some(max_choices), Some(&json!(1))) { "multiple" } else { "single" }
}

/* -------------------------------------------------------------------------- hottext */

/// Assemble a hottext once its units are known.
fn assemble_hottext(attrs: &Object, mut units: Vec<Unit>, at: &str) -> Built {
    let selections = or_empty_list(attrs, "selections");
    let resolved = resolve_selections(&mut units, &selections, at)?;
    let (template, exact) = template(attrs);
    let correct = &resolved.correct_ids;
    let scored = !resolved.mapping.is_empty();
    if scored && correct.is_empty() {
        return Err(format!(
            "{at}: no selection is marked `correct`, so the item cannot be scored. Add `assess [correct]` to the right one, or remove every `assess` for an unscored item."
        ));
    }
    if exact && correct.is_empty() {
        return Err(format!(
            "{at}: `response-processing \"match-correct\"` scores against the correct set, but no selection is marked `correct`."
        ));
    }
    let sum = correct.iter().fold(0.0, |n, id| {
        n + resolved.mapping.get(id).and_then(|m| m.get("points")).map_or(0.0, |p| to_number(Some(p)))
    });
    let sum_json = json_num(sum);
    let upper = given(attrs, "upperBound");
    let bounded = upper.is_some();
    let upper_bound = upper.cloned().unwrap_or_else(|| sum_json.clone());
    if bounded && gt(upper, Some(&sum_json)) {
        return Err(format!(
            "{at}: upper-bound is {} but the correct selections are only worth {}. Lower `upper-bound`, or mark more selections correct.",
            js_str(upper),
            num(sum)
        ));
    }
    let max_choices = match given(attrs, "maxChoices") {
        Some(max) => max.clone(),
        None if bounded => upper_bound.clone(),
        None => json!(if correct.is_empty() { 1 } else { correct.len() }),
    };
    let min_choices = or(attrs, "minChoices", max_choices.clone());
    if gt(Some(&min_choices), Some(&max_choices)) {
        return Err(format!(
            "{at}: min-choices ({}) is greater than max-choices ({}).",
            js_str(Some(&min_choices)),
            js_str(Some(&max_choices))
        ));
    }
    if !bounded && gt(Some(&json!(correct.len())), Some(&max_choices)) {
        return Err(format!(
            "{at}: {} selections are marked `correct` but max-choices is {}. Raise `max-choices`, or set `upper-bound` to ask for that many of them.",
            correct.len(),
            js_str(Some(&max_choices))
        ));
    }
    let mut shown = interaction("hottext", attrs);
    shown.insert("granularity".into(), or(attrs, "granularity", json!("sentence")));
    shown.insert("minChoices".into(), min_choices);
    shown.insert("maxChoices".into(), max_choices.clone());
    shown.insert("units".into(), Json::Array(units.into_iter().map(Json::Object).collect()));
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!(template_id(&js_str(Some(&template)))));
    validation.insert("cardinality".into(), json!(cardinality(&max_choices)));
    validation.insert("baseType".into(), json!("identifier"));
    validation
        .insert("points".into(), if exact { json!(1) } else { json_num(js_min(sum, to_number(Some(&upper_bound)))) });
    if exact {
        validation.insert("correctResponse".into(), json!(correct));
    } else {
        validation.insert("mapping".into(), Json::Object(resolved.mapping));
    }
    if bounded && !exact {
        validation.insert("upperBound".into(), upper_bound);
    }
    if !resolved.feedback.is_empty() {
        validation.insert("feedback".into(), Json::Object(resolved.feedback));
    }
    Ok(assembled(shown, validation))
}

/// `Math.min(a, b)`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else {
        a.min(b)
    }
}

/// The units of a hottext carrying its own text, at its granularity.
fn own_units(attrs: &Object) -> Vec<Unit> {
    let text = js_str_or_empty(given(attrs, "text"));
    if given(attrs, "granularity") == Some(&json!("word")) {
        word_units(&text)
    } else {
        sentence_units(&[("p1".to_owned(), text)])
    }
}

fn hottext(attrs: &Object) -> Built {
    if list(attrs, "selections").is_empty() {
        return Err(
            "hottext: needs at least one selection, e.g. selections [[quote \"…\" assess [correct]]] {}.".into()
        );
    }
    let (has_text, has_within) = (given(attrs, "text").is_some(), given(attrs, "within").is_some());
    if has_text && has_within {
        return Err("hottext: takes `text` or `within`, not both. `text` gives it its own passage; `within \"stimulus\"` selects inside the item's passage.".into());
    }
    if !has_text && !has_within {
        return Err("hottext: needs the text it selects within — either its own `text \"…\"`, or `within \"stimulus\"` to use the passage of the item it is a part of.".into());
    }
    if has_within {
        // Deferred: the item has the stimulus and will finish this.
        return Ok(json!({ "pending": { "scope": attrs["within"], "attrs": Json::Object(attrs.clone()) } }));
    }
    let units = own_units(attrs);
    if units.is_empty() {
        return Err("hottext: `text` is empty, so there is nothing to select.".into());
    }
    assemble_hottext(attrs, units, "hottext")
}

/* ----------------------------------------------------------------------- text-entry */

fn text_entry(attrs: &Object) -> Built {
    let text = match string(given(attrs, "text")) {
        Some(text) if !text::trim(text).is_empty() => text,
        _ => return Err("text-entry: needs the sentence it blanks out, e.g. text \"The capital of France is {{capital}}.\" Put {{<id>}} where each answer goes.".into()),
    };
    let blanks = list(attrs, "blanks");
    if blanks.is_empty() {
        return Err("text-entry: needs at least one blank, e.g. blanks [[id \"capital\" responses [[response \"Paris\" assess [correct]]] {}]] {}.".into());
    }
    let cut = textentry::cut(text, blanks, given(attrs, "caseSensitive") == Some(&json!(true)), "text-entry")?;
    let mut shown = interaction("text-entry", attrs);
    shown.insert("segments".into(), Json::Array(cut.segments));
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!("map_response"));
    validation.insert("cardinality".into(), json!("single"));
    validation.insert("points".into(), json_num(textentry::total_points(&cut.mapping)));
    validation.insert("mapping".into(), Json::Object(cut.mapping));
    Ok(assembled(shown, validation))
}

/* -------------------------------------------------------------------- inline-choice */

/// True when every dropdown in a sentence is a list whose order is already information.
fn menus_keep_order(segments: &[Json]) -> bool {
    let menus: Vec<&Json> = segments.iter().filter(|s| truthy(prop(Some(s), "choice"))).collect();
    if menus.is_empty() {
        return false;
    }
    menus.iter().all(|menu| {
        let options: &[Json] = match prop(Some(menu), "options") {
            Some(Json::Array(options)) => options,
            _ => &[],
        };
        let unanchored: Vec<Json> = options.iter().filter(|o| !truthy(prop(Some(o), "anchored"))).cloned().collect();
        keeps_order(&texts(&unanchored))
    })
}

fn inline_choice(attrs: &Object) -> Built {
    let text = match string(given(attrs, "text")) {
        Some(text) if !text::trim(text).is_empty() => text,
        _ => return Err("inline-choice: needs the sentence its dropdowns sit in, e.g. text \"Plants absorb {{gas}} and release oxygen.\" Put {{<id>}} where each dropdown goes.".into()),
    };
    let dropdowns = list(attrs, "dropdowns");
    if dropdowns.is_empty() {
        return Err("inline-choice: needs at least one dropdown, e.g. dropdowns [[id \"gas\" options [[text \"carbon dioxide\" assess [correct]]] {}]] {}.".into());
    }
    let cut = inlinechoice::cut(text, dropdowns, "inline-choice")?;
    let mut shown = interaction("inline-choice", attrs);
    let shuffle = match given(attrs, "shuffle") {
        Some(Json::Bool(shuffle)) => *shuffle,
        _ => !menus_keep_order(&cut.segments),
    };
    shown.insert("shuffle".into(), json!(shuffle));
    shown.insert("segments".into(), Json::Array(cut.segments));
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!("map_response"));
    validation.insert("cardinality".into(), json!("single"));
    validation.insert("points".into(), json_num(textentry::total_points(&cut.mapping)));
    validation.insert("mapping".into(), Json::Object(cut.mapping));
    Ok(assembled(shown, validation))
}

/* ---------------------------------------------------------------------------- order */

fn order(attrs: &Object) -> Built {
    let elements = list(attrs, "elements");
    if elements.is_empty() {
        return Err("order: needs the things to be put in order, e.g. elements [[text \"First\" assess [position 1]] [text \"Second\" assess [position 2]]] {}.".into());
    }
    let sequenced = order::sequence(elements, "order")?;
    let mut shown = interaction("order", attrs);
    let shuffle = match given(attrs, "shuffle") {
        Some(Json::Bool(shuffle)) => *shuffle,
        _ => true,
    };
    shown.insert("shuffle".into(), json!(shuffle));
    shown.insert("elements".into(), Json::Array(sequenced.elements));
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!("match_correct"));
    validation.insert("cardinality".into(), json!("ordered"));
    validation.insert("baseType".into(), json!("identifier"));
    validation.insert("points".into(), json!(1));
    validation.insert("correctResponse".into(), Json::Array(sequenced.correct_response));
    if let Some(groups) = sequenced.interchangeable {
        validation.insert("interchangeable".into(), json!(groups));
    }
    Ok(assembled(shown, validation))
}

/* -------------------------------------------------------------------------- pairing */

const MATCH_WORDS: PairWords = PairWords {
    container: "match",
    key: "target",
    list: "targets",
    item_list: "match-items",
    place: "target",
    one_to_one: true,
};

const CLASSIFICATION_WORDS: PairWords = PairWords {
    container: "classification",
    key: "category",
    list: "categories",
    item_list: "classification-items",
    place: "category",
    one_to_one: false,
};

fn pairing_interaction(kind: &str, words: &PairWords, list_field: &str, item_field: &str, attrs: &Object) -> Built {
    let places = list(attrs, list_field);
    let items = list(attrs, item_field);
    if places.is_empty() {
        return Err(format!(
            "{kind}: needs its {}, e.g. {} [[id \"a\" text \"A\"] [id \"b\" text \"B\"]] {{}}.",
            words.list, words.list
        ));
    }
    if items.is_empty() {
        return Err(format!(
            "{kind}: needs its {}, e.g. {} [[text \"France\" assess [{} \"a\"]]] {{}}.",
            words.item_list, words.item_list, words.key
        ));
    }
    let paired = pair(items, places, words)?;
    let (template, exact) = template(attrs);
    let mut shown = interaction(kind, attrs);
    shown.insert("shuffle".into(), json!(resolve_shuffle(given(attrs, "shuffle"), &paired.items)));
    shown.insert("items".into(), Json::Array(paired.items));
    shown.insert(list_field.into(), Json::Array(paired.places));
    Ok(assembled(shown, pairing_validation(&template, exact, paired.points, paired.correct_response, paired.mapping)))
}

fn pairing_validation(template: &Json, exact: bool, points: f64, correct: Vec<Json>, mapping: Object) -> Object {
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!(template_id(&js_str(Some(template)))));
    validation.insert("cardinality".into(), json!("multiple"));
    validation.insert("baseType".into(), json!("directedPair"));
    validation.insert("points".into(), if exact { json!(1) } else { json_num(points) });
    if exact {
        validation.insert("correctResponse".into(), Json::Array(correct));
    } else {
        validation.insert("mapping".into(), Json::Object(mapping));
    }
    validation
}

fn gap_match(attrs: &Object) -> Built {
    let text = match string(given(attrs, "text")) {
        Some(text) if !text::trim(text).is_empty() => text,
        _ => return Err("gap-match: needs the sentence its gaps sit in, e.g. text \"The {{a}} orbits the {{b}}.\" Put {{<id>}} where each gap goes.".into()),
    };
    let tokens = list(attrs, "tokens");
    if tokens.is_empty() {
        return Err(
            "gap-match: needs the bank its gaps are filled from, e.g. tokens [[id \"moon\" text \"Moon\"]] {}.".into(),
        );
    }
    let gaps = list(attrs, "gaps");
    if gaps.is_empty() {
        return Err("gap-match: needs at least one gap, e.g. gaps [[id \"a\" assess [token \"moon\"]]] {}.".into());
    }
    let filled = pairing::fill(text, gaps, tokens)?;
    let (template, exact) = template(attrs);
    let mut shown = interaction("gap-match", attrs);
    shown.insert("shuffle".into(), json!(resolve_shuffle(given(attrs, "shuffle"), &filled.tokens)));
    shown.insert("segments".into(), Json::Array(filled.segments));
    shown.insert("tokens".into(), Json::Array(filled.tokens));
    Ok(assembled(shown, pairing_validation(&template, exact, filled.points, filled.correct_response, filled.mapping)))
}

/* -------------------------------------------------------------------- extended-text */

fn extended_text(attrs: &Object) -> Built {
    let bands = or_empty_list(attrs, "rubric");
    if bands.len() < 2 {
        return Err("extended-text: needs a rubric of at least two bands, e.g. rubric [[score 2 descriptor \"…\"] [score 0 descriptor \"…\"]] {}. A written response is scored by a person, and the rubric is what they score against.".into());
    }
    let mut seen: Vec<(f64, usize)> = Vec::new();
    let mut scored: Vec<(f64, Json)> = Vec::new();
    for (i, band) in bands.iter().enumerate() {
        let Some(points) = number(prop(Some(band), "points")) else {
            return Err(format!("band {}: needs `points`, e.g. [ points 2 descriptor \"…\" ].", i + 1));
        };
        let descriptor = match string(prop(Some(band), "descriptor")) {
            Some(descriptor) if !text::trim(descriptor).is_empty() => descriptor,
            _ => {
                return Err(format!(
                    "band {}: needs a `descriptor` saying what earns {}. A bare score tells the person marking it nothing.",
                    i + 1,
                    num(points)
                ));
            }
        };
        if let Some((_, prior)) = seen.iter().find(|(seen, _)| *seen == points) {
            return Err(format!(
                "band {}: {} points is already band {prior}. Each band scores differently.",
                i + 1,
                num(points)
            ));
        }
        seen.push((points, i + 1));
        scored.push((points, json!({ "points": band["points"], "descriptor": descriptor })));
    }
    let points = textentry::js_max(&scored.iter().map(|(p, _)| *p).collect::<Vec<_>>());
    if points <= 0.0 {
        return Err("extended-text: no band earns anything, so the response cannot be scored. Give the top band a score above zero.".into());
    }
    // Ordered high to low, which is how a rubric is read.
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let shown = interaction("extended-text", attrs);
    let mut validation = Object::new();
    validation.insert("responseProcessing".into(), json!("human"));
    validation.insert("points".into(), json_num(points));
    validation.insert("rubric".into(), Json::Array(scored.into_iter().map(|(_, band)| band).collect()));
    if let Some(exemplar) = given(attrs, "exemplar") {
        validation.insert("exemplar".into(), exemplar.clone());
    }
    Ok(assembled(shown, validation))
}

/* ----------------------------------------------------------------------------- item */

fn parts(raw: Option<Json>, rest: Option<Json>) -> Built {
    let parts = match raw {
        Some(Json::Array(parts)) if !parts.is_empty() => parts,
        _ => return Err("parts: expected at least one interaction, e.g. parts [ choice [ ... ] ] {}.".into()),
    };
    let is_interaction =
        |p: &Json| p.is_object() && (truthy(prop(Some(p), "interaction")) || truthy(prop(Some(p), "pending")));
    if let Some(bad) = parts.iter().position(|p| !is_interaction(p)) {
        return Err(format!(
            "parts: entry {} is not an interaction. Each part is a whole interaction, e.g. parts [ choice [ ... ] hottext [ ... ] ] {{}}.",
            bad + 1
        ));
    }
    let mut out = spread_or_empty(rest.as_ref());
    out.insert("parts".into(), Json::Array(parts));
    Ok(Json::Object(out))
}

fn item(attrs: &Object) -> Built {
    let mut parts: Vec<Json> = match given(attrs, "parts") {
        Some(Json::Array(parts)) => parts.clone(),
        _ => Vec::new(),
    };
    if parts.is_empty() {
        return Err("item: needs at least one part, e.g. parts [ choice [ ... ] ] {}.".into());
    }
    let stimulus = given(attrs, "stimulus").filter(|s| truthy(Some(s)));
    let paragraph_texts: Vec<Json> = match stimulus.and_then(|s| prop(Some(s), "paragraphs")) {
        Some(Json::Array(texts)) => texts.clone(),
        _ => Vec::new(),
    };
    let paragraphs: Vec<(String, Json)> =
        paragraph_texts.iter().enumerate().map(|(i, text)| (format!("p{}", i + 1), text.clone())).collect();

    // Finish the parts that could not finish themselves.
    let mut owner: Option<usize> = None;
    for (i, part) in parts.iter_mut().enumerate() {
        let Some(pending) = prop(Some(part), "pending").filter(|p| truthy(Some(p))).cloned() else { continue };
        if paragraphs.is_empty() {
            return Err(format!(
                "part {}: hottext says `within \"stimulus\"` but the item has no stimulus. Add `stimulus [ paragraphs [ … ] ]`, or give the hottext its own `text`.",
                i + 1
            ));
        }
        if let Some(owner) = owner {
            return Err(format!(
                "part {}: a second hottext selects `within \"stimulus\"`, but part {} already does. One passage cannot be two interactions; give this one its own `text`.",
                i + 1,
                owner + 1
            ));
        }
        owner = Some(i);
        let a = match prop(Some(&pending), "attrs") {
            Some(Json::Object(a)) => a.clone(),
            _ => Object::new(),
        };
        let units = if a.get("granularity") == Some(&json!("word")) {
            let texts: Vec<Json> = paragraphs.iter().map(|(_, text)| text.clone()).collect();
            word_units(&join(&texts, " "))
        } else {
            let paragraphs: Vec<(String, String)> =
                paragraphs.iter().map(|(id, text)| (id.clone(), js_str_or_empty(Some(text)))).collect();
            sentence_units(&paragraphs)
        };
        let mut assembled = match assemble_hottext(&a, units, &format!("part {}", i + 1))? {
            Json::Object(assembled) => assembled,
            _ => Object::new(),
        };
        assembled.insert("within".into(), json!("stimulus"));
        *part = Json::Object(assembled);
    }

    let scoring = or(attrs, "scoring", json!("additive"));
    let conjunctive = scoring == json!("conjunctive");
    if given(attrs, "points").is_some() && !conjunctive {
        return Err("item: `points` is only meaningful with `scoring \"conjunctive\"`. With additive scoring the item is worth the sum of its parts, so setting it here would be a second, disagreeing answer to what a correct response earns.".into());
    }

    let ids: Vec<String> = (1..=parts.len()).map(|i| i.to_string()).collect();
    let mut part_validation = Object::new();
    let mut summed = 0.0;
    for (id, p) in ids.iter().zip(&parts) {
        let v = prop(Some(p), "validation")
            .filter(|v| truthy(Some(v)))
            .cloned()
            .unwrap_or_else(|| json!({ "points": 0, "options": {} }));
        summed += number(prop(Some(&v), "points")).unwrap_or(0.0);
        part_validation.insert(id.clone(), v);
    }
    if conjunctive {
        let human: Vec<&str> = ids
            .iter()
            .filter(|id| prop(part_validation.get(*id), "responseProcessing") == Some(&json!("human")))
            .map(String::as_str)
            .collect();
        if !human.is_empty() {
            return Err(format!(
                "item: conjunctive scoring needs every part to be scoreable, but part {} is a written response scored by a person. Use the default additive scoring, so the rest of the item scores while that part waits to be marked.",
                human.join(", ")
            ));
        }
        let unscored: Vec<&str> =
            ids.iter().filter(|id| !positive(prop(part_validation.get(*id), "points"))).map(String::as_str).collect();
        if !unscored.is_empty() {
            return Err(format!(
                "item: conjunctive scoring needs every part to be scoreable, but part {} earns nothing. Mark a correct answer in it, or use the default additive scoring.",
                unscored.join(", ")
            ));
        }
    }
    let points = if conjunctive { or(attrs, "points", json!(1)) } else { json_num(summed) };

    let mut shown = Object::new();
    shown.insert("type".into(), json!("item"));
    if let Some(stimulus) = stimulus {
        let mut out = Object::new();
        if let Some(title) = prop(Some(stimulus), "title") {
            out.insert("title".into(), title.clone());
        }
        let paragraphs: Vec<Json> = paragraphs.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect();
        out.insert("paragraphs".into(), Json::Array(paragraphs));
        shown.insert("stimulus".into(), Json::Object(out));
    }
    let rendered: Vec<Json> = ids
        .iter()
        .zip(&parts)
        .map(|(id, p)| {
            let mut part = Object::new();
            part.insert("id".into(), json!(id));
            part.extend(spread(prop(Some(p), "interaction")));
            if let Some(within) = prop(Some(p), "within").filter(|w| truthy(Some(w))) {
                part.insert("within".into(), within.clone());
            }
            Json::Object(part)
        })
        .collect();
    shown.insert("parts".into(), Json::Array(rendered));
    Ok(json!({
        "interaction": Json::Object(shown),
        "validation": { "points": points, "scoring": scoring, "parts": Json::Object(part_validation) },
    }))
}

/// `x > 0` for a value that may be missing (`undefined > 0` is false).
fn positive(json: Option<&Json>) -> bool {
    json.is_some() && to_number(json) > 0.0
}

/* ------------------------------------------------------------------------- activity */

const PENDING: &str = "hottext: `within \"stimulus\"` needs the hottext to be a part of an item that has one. Wrap it in `item [ stimulus [ … ] parts [ … ] {} ]`, or give it its own `text`.";

fn items(raw: Option<Json>, rest: Option<Json>) -> Built {
    let Some(Json::Array(items)) = raw else {
        return Err(
            "items: expected a list of items, e.g. items [ choice [prompt \"…\" options [[text \"A\"]] {}] ] {}."
                .into(),
        );
    };
    if items.is_empty() {
        return Err("items: an activity needs at least one item.".into());
    }
    let Some(Json::Object(config)) = rest else {
        return Err("items: needs the activity's settings after the list, ending in a record — e.g. items [ … ] navigation \"linear\" {}. Write `{}` when there are none.".into());
    };
    if items.iter().any(|i| truthy(prop(Some(i), "pending"))) {
        return Err(PENDING.into());
    }
    if let Some(bad) = items.iter().position(|i| !(i.is_object() && truthy(prop(Some(i), "interaction")))) {
        return Err(format!(
            "items: entry {} is not an item. Each entry must be an interaction or an `item [ … ]`, e.g. items [ choice [prompt \"…\" options [[text \"A\"]] {{}}] ] {{}}.",
            bad + 1
        ));
    }
    let numbered: Vec<Json> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut out = Object::new();
            out.insert("id".into(), json!(i));
            out.extend(spread(Some(item)));
            Json::Object(out)
        })
        .collect();
    Ok(json!({
        "activity": {
            "navigation": or(&config, "navigation", json!("nonlinear")),
            "submission": or(&config, "submission", json!("simultaneous")),
            "items": numbered,
        }
    }))
}

/* ----------------------------------------------------------------------------- PROG */

/// The values of a program's expressions, as the TypeScript's `EXPRS` gives them: one per
/// expression, or the one value of a function applied to the rest.
async fn expressions(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Vec<Value> {
    let ast = cx.ast();
    let Some(&body) = elts.first() else { return vec![cx.eval_arg(id, elts, 0).await] };
    let exprs: Vec<NodeId> = match ast.get(body) {
        Some(Node::Form { op: Op::Exprs, elts }) => elts.clone(),
        _ => return vec![cx.eval(body).await],
    };
    if exprs.len() > 1 && is_function(cx, exprs[0]) {
        return vec![cx.eval(body).await];
    }
    if exprs.is_empty() {
        return vec![Value::Str(String::new())];
    }
    let mut values = Vec::with_capacity(exprs.len());
    for expr in exprs {
        values.push(cx.eval(expr).await);
    }
    values
}

fn is_function(cx: &Evaluator<'_>, mut id: NodeId) -> bool {
    let ast = cx.ast();
    loop {
        match ast.get(id) {
            Some(Node::Form { op: Op::Lambda, .. }) => return true,
            Some(Node::Form { op: Op::Paren, elts }) if !elts.is_empty() => id = elts[0],
            _ => return false,
        }
    }
}

/// A question: anything carrying an interaction, a pending hottext or an activity.
fn is_question(v: Option<&Json>) -> bool {
    matches!(v, Some(Json::Object(_)))
        && (truthy(prop(v, "interaction")) || truthy(prop(v, "pending")) || truthy(prop(v, "activity")))
}

/// The program's value is its last expression, with the upstream data spread under it.
async fn prog(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let mut values = expressions(cx, id, elts).await;
    let last = values.pop().unwrap_or(Value::Undefined);
    let val = plain(&last);
    if matches!(val, Some(Json::Object(_))) && truthy(prop(val.as_ref(), "pending")) {
        cx.report_diagnostic(Diagnostic::new(PENDING));
        return value(json!({}));
    }
    let dropped = values.iter().filter(|v| is_question(plain(v).as_ref())).count();
    let several = match &val {
        Some(Json::Array(items)) => items.iter().any(|i| is_question(Some(i))),
        _ => false,
    };
    if several || (dropped > 0 && is_question(val.as_ref())) {
        let count = match &val {
            Some(Json::Array(items)) => items.len(),
            _ => dropped + 1,
        };
        cx.report_diagnostic(Diagnostic::new(format!(
            "A program is one item, and this one has {count} questions side by side. Several questions are an activity: wrap them in `items [ … ] {{}}`, e.g. items [ choice [prompt \"…\" options [[text \"A\"]] {{}}] choice [prompt \"…\" options [[text \"B\"]] {{}}] ] {{}}."
        )));
        return value(json!({}));
    }
    match val {
        Some(Json::Object(val)) => {
            // `data` first, so the fresh compile wins over a previous one carried back in it.
            let data = plain(cx.data());
            let mut out = spread_or_empty(data.as_ref());
            if data.is_some() && !truthy(data.as_ref()) {
                out = Object::new();
            }
            out.extend(val);
            value(Json::Object(out))
        }
        _ => last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lexicon_carries_every_word() {
        for word in ["choice", "options", "correct", "items", "navigation", "gap-match", "classification-items"] {
            assert!(lexicon().get(word).is_some(), "{word}");
        }
        assert_eq!(lexicon().get("correct").map(|w| w.arity), Some(0));
        assert_eq!(lexicon().get("options").map(|w| w.arity), Some(2));
    }

    #[test]
    fn math_min_keeps_javascripts_zero() {
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert_eq!(js_min(3.0, 2.0), 2.0);
        assert!(js_min(f64::NAN, 1.0).is_nan());
    }
}
