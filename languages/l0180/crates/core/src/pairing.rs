// SPDX-License-Identifier: MIT

//! Pairing things with other things — the key behind `match` and `classification`
//! (`packages/core/src/pairing.ts`) — and the sentence filled from a shared bank that reuses
//! it, `gap-match` (`gapmatch.ts`).

use serde_json::{Value as Json, json};

use crate::anchors::option_label;
use crate::attributes::assert_assess_words;
use crate::plain::{Object, js_str, prop, same_key, string};
use crate::text;
use crate::textentry::{MarkerWords, cut_markers};

/// What to call things, so an error reads in the vocabulary the author is writing.
pub struct PairWords {
    pub container: &'static str,
    pub key: &'static str,
    pub list: &'static str,
    pub item_list: &'static str,
    pub place: &'static str,
    pub one_to_one: bool,
}

pub struct Paired {
    pub items: Vec<Json>,
    pub places: Vec<Json>,
    pub mapping: Object,
    pub correct_response: Vec<Json>,
    pub points: f64,
}

/// A text as the browser reads it, for the shuffle rule.
pub fn texts(entries: &[Json]) -> Vec<String> {
    entries.iter().map(|e| crate::plain::js_str_or_empty(prop(Some(e), "text"))).collect()
}

/// Read the places things can go. Each must be named by its author.
fn read_places(places: &[Json], words: &PairWords) -> Result<(Vec<String>, Vec<Json>), String> {
    if places.is_empty() {
        return Err(format!(
            "{}: needs at least one {}, e.g. {} [[id \"a\" text \"A\"]] {{}}.",
            words.container, words.place, words.list
        ));
    }
    if places.len() < 2 {
        return Err(format!(
            "{}: needs at least two {}, or there is nothing to decide between — every item would go in the only {} there is.",
            words.container, words.list, words.place
        ));
    }
    let mut known: Vec<String> = Vec::new();
    let mut resolved = Vec::new();
    for (i, p) in places.iter().enumerate() {
        let at = format!("{}: {} {}", words.container, words.place, i + 1);
        let id = string(prop(Some(p), "id")).map(text::trim).unwrap_or_default();
        if id.is_empty() {
            return Err(format!(
                "{at}: needs an `id`, which is what an item's `assess [{} \"…\"]` refers to — e.g. [ id \"paris\" text \"Paris\" ].",
                words.key
            ));
        }
        if known.iter().any(|k| k == id) {
            return Err(format!("{at}: the id \"{id}\" is already used. Each {} needs its own.", words.place));
        }
        let text = string(prop(Some(p), "text")).unwrap_or_default();
        if text::trim(text).is_empty() {
            return Err(format!("{at}: needs the `text` the candidate reads."));
        }
        known.push(id.to_owned());
        resolved.push(json!({ "id": id, "text": text }));
    }
    Ok((known, resolved))
}

/// Where an item says it belongs, if that names a declared place.
fn find<'a>(known: &'a [String], belongs: &Json) -> Option<&'a String> {
    known.iter().find(|k| belongs.as_str() == Some(k.as_str()))
}

fn pair_value(points: Option<&Json>, rationale: Option<&Json>) -> (Json, f64) {
    let value = points.filter(|p| p.is_number()).cloned().unwrap_or(json!(1));
    let mut entry = json!({ "correct": true, "points": value });
    if let Some(rationale) = string(rationale) {
        entry["rationale"] = json!(rationale);
    }
    let n = value.as_f64().unwrap_or(1.0);
    (entry, n)
}

pub fn pair(items: &[Json], places: &[Json], words: &PairWords) -> Result<Paired, String> {
    if items.is_empty() {
        return Err(format!(
            "{}: needs at least one item, e.g. {} [[text \"France\" assess [{} \"a\"]]] {{}}.",
            words.container, words.item_list, words.key
        ));
    }
    let (known, resolved) = read_places(places, words)?;
    let mut seen_ids: Vec<(String, usize)> = Vec::new();
    let mut taken: Vec<(Json, usize)> = Vec::new();
    let mut mapping = Object::new();
    let mut correct_response = Vec::new();
    let mut resolved_items = Vec::new();
    let mut points = 0.0;
    for (i, item) in items.iter().enumerate() {
        let at = format!("{}: item {}", words.container, i + 1);
        let id = match prop(Some(item), "id") {
            Some(id) => js_str(Some(id)),
            None => option_label(i),
        };
        if let Some((_, prior)) = seen_ids.iter().find(|(seen, _)| *seen == id) {
            return Err(format!(
                "{at}: two items share the id \"{id}\" (items {prior} and {}). Ids must be unique; omit `id` to have them derived.",
                i + 1
            ));
        }
        seen_ids.push((id.clone(), i + 1));
        let text = prop(Some(item), "text").map_or_else(String::new, |t| js_str(Some(t)));
        if text::trim(&text).is_empty() {
            return Err(format!("{at}: needs the `text` the candidate reads."));
        }
        resolved_items.push(json!({ "id": id, "text": text }));

        let assess = prop(Some(item), "assess");
        assert_assess_words(assess, &[words.key, "points", "rationale"], &at)?;
        let Some(belongs) = prop(assess, words.key) else {
            return Err(format!(
                "{at}: needs `assess [{} \"…\"]` saying where it belongs, naming one of the {}: {}.",
                words.key,
                words.list,
                known.join(", ")
            ));
        };
        let shown = js_str(Some(belongs));
        if find(&known, belongs).is_none() {
            return Err(format!(
                "{at}: no {} has the id \"{shown}\". `{}` declares: {}.",
                words.place,
                words.list,
                known.join(", ")
            ));
        }
        if let Some((_, already)) = taken.iter().find(|(taken, _)| same_key(taken, belongs))
            && words.one_to_one
        {
            return Err(format!(
                "{at}: item {already} already matches \"{shown}\", and a match pairs each {} with one item. If they are meant to be shared, this is a `classification`.",
                words.place
            ));
        }
        match taken.iter_mut().find(|(taken, _)| same_key(taken, belongs)) {
            Some(entry) => entry.1 = i + 1,
            None => taken.push((belongs.clone(), i + 1)),
        }
        let (entry, value) = pair_value(prop(assess, "points"), prop(assess, "rationale"));
        let pair_id = format!("{id} {shown}");
        mapping.insert(pair_id.clone(), entry);
        correct_response.push(json!(pair_id));
        points += value;
    }
    Ok(Paired { items: resolved_items, places: resolved, mapping, correct_response, points })
}

const GAP_WORDS: MarkerWords = MarkerWords {
    one: "gap",
    list: "gaps",
    marker: "{{a}}",
    sentence: "The {{a}} orbits the {{b}}.",
    unit: "hole",
    fill: "be dragged into it",
};

const BANK: PairWords = PairWords {
    container: "gap-match",
    key: "token",
    list: "tokens",
    item_list: "gaps",
    place: "token",
    one_to_one: true,
};

pub struct Filled {
    pub segments: Vec<Json>,
    pub tokens: Vec<Json>,
    pub mapping: Object,
    pub correct_response: Vec<Json>,
    pub points: f64,
}

/// A sentence with holes, filled from a shared bank of tokens.
pub fn fill(text: &str, gaps: &[Json], tokens: &[Json]) -> Result<Filled, String> {
    let (known, resolved) = read_places(tokens, &BANK)?;
    let mut declared: Vec<(String, ())> = Vec::new();
    let mut mapping = Object::new();
    let mut correct_response = Vec::new();
    let mut spent: Vec<(Json, usize)> = Vec::new();
    let mut points = 0.0;
    for (i, gap) in gaps.iter().enumerate() {
        let at = format!("gap-match: gap {}", i + 1);
        let id = string(prop(Some(gap), "id")).map(text::trim).unwrap_or_default();
        if id.is_empty() {
            return Err(format!(
                "{at}: needs an `id`, which is the marker that positions it — e.g. [ id \"a\" assess [ token \"moon\" ] ] with {{{{a}}}} in the text."
            ));
        }
        if declared.iter().any(|(declared, _)| declared == id) {
            return Err(format!("{at}: the id \"{id}\" is already used. Each gap needs its own."));
        }
        let assess = prop(Some(gap), "assess");
        let Some(belongs) = prop(assess, "token") else {
            return Err(format!(
                "{at}: needs `assess [token \"…\"]` saying which token fills it, naming one of the tokens: {}.",
                known.join(", ")
            ));
        };
        let shown = js_str(Some(belongs));
        if find(&known, belongs).is_none() {
            return Err(format!("{at}: no token has the id \"{shown}\". `tokens` declares: {}.", known.join(", ")));
        }
        if let Some((_, already)) = spent.iter().find(|(spent, _)| same_key(spent, belongs)) {
            return Err(format!(
                "{at}: gap {already} already takes \"{shown}\", and a token can only be dragged into one gap. Add another token for this one, or use `inline-choice`, where each hole has its own menu and an answer may repeat."
            ));
        }
        spent.push((belongs.clone(), i + 1));
        declared.push((id.to_owned(), ()));
        let (entry, value) = pair_value(prop(assess, "points"), prop(assess, "rationale"));
        let pair_id = format!("{id} {shown}");
        mapping.insert(pair_id.clone(), entry);
        correct_response.push(json!(pair_id));
        points += value;
    }
    let segments = cut_markers(text, &declared, &GAP_WORDS, "gap-match", |id, _| json!({ "id": id, "gap": true }))?;
    Ok(Filled { segments, tokens: resolved, mapping, correct_response, points })
}
