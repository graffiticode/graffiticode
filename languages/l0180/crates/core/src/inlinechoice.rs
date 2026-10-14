// SPDX-License-Identifier: MIT

//! A sentence whose holes are dropdowns: `packages/core/src/inlinechoice.ts`.

use serde_json::{Value as Json, json};

use crate::anchors::{is_anchored, option_label};
use crate::attributes::assert_assess_words;
use crate::plain::{Object, js_order, js_str, json_num, number, prop, string};
use crate::text;
use crate::textentry::{MarkerWords, cut_markers, js_max};

const WORDS: MarkerWords = MarkerWords {
    one: "dropdown",
    list: "dropdowns",
    marker: "{{gas}}",
    sentence: "Plants absorb {{gas}} and release oxygen.",
    unit: "menu",
    fill: "be chosen for it",
};

struct Held {
    entry: Object,
    menu: Vec<Json>,
}

/// Read one dropdown's options into a key, applying `choice`'s rules unchanged.
fn read_options(d: &Json, at: &str) -> Result<Held, String> {
    let opts: &[Json] = match prop(Some(d), "options") {
        Some(Json::Array(opts)) => opts,
        _ => &[],
    };
    if opts.is_empty() {
        return Err(format!(
            "{at}: needs at least one option, e.g. options [ [ text \"oxygen\" assess [ correct ] ] ] {{}}."
        ));
    }
    let mut seen: Vec<(String, usize)> = Vec::new();
    let mut options = Object::new();
    let mut menu = Vec::new();
    let mut correct: Vec<f64> = Vec::new();
    for (i, opt) in opts.iter().enumerate() {
        let id = match prop(Some(opt), "id") {
            Some(id) => js_str(Some(id)),
            None => option_label(i),
        };
        if let Some((_, prior)) = seen.iter().find(|(seen, _)| *seen == id) {
            return Err(format!(
                "{at}: two options share the id \"{id}\" (options {prior} and {}). Ids must be unique within a dropdown; omit `id` to have them derived.",
                i + 1
            ));
        }
        seen.push((id.clone(), i + 1));
        let text = prop(Some(opt), "text").map_or_else(String::new, |t| js_str(Some(t)));
        if text::trim(&text).is_empty() {
            return Err(format!("{at}: option {} needs the `text` the candidate reads in the menu.", i + 1));
        }
        let mut item = json!({ "id": id, "text": text });
        if is_anchored(&text) {
            item["anchored"] = json!(true);
        }
        menu.push(item);

        let Some(assess) = prop(Some(opt), "assess") else { continue };
        assert_assess_words(Some(assess), &["correct", "points", "rationale"], &format!("{at}: option \"{id}\""))?;
        let is_correct = prop(Some(assess), "correct") == Some(&json!(true));
        let points = number(prop(Some(assess), "points"));
        let rationale = string(prop(Some(assess), "rationale"));
        if !is_correct && points.is_none() && rationale.is_none() {
            return Err(format!(
                "{at}: option \"{id}\": assess must say what it asserts — `correct`, `points`, or `rationale`. `assess [correct]` marks the answer; `assess [points -1]` penalizes a distractor; `assess [rationale \"…\"]` explains one."
            ));
        }
        if !is_correct && points.is_none() {
            options.insert(id, json!({ "points": 0, "rationale": rationale }));
            continue;
        }
        let value = points.unwrap_or(1.0);
        let mut entry = Object::new();
        if is_correct {
            entry.insert("correct".into(), json!(true));
        }
        entry.insert(
            "points".into(),
            prop(Some(assess), "points").filter(|_| points.is_some()).cloned().unwrap_or(json!(1)),
        );
        if let Some(rationale) = rationale {
            entry.insert("rationale".into(), json!(rationale));
        }
        options.insert(id, Json::Object(entry));
        if is_correct {
            correct.push(value);
        }
    }
    if correct.is_empty() {
        return Err(format!(
            "{at}: no option is marked `correct`, so the dropdown cannot be scored. Add `assess [correct]` to the right one."
        ));
    }
    let mut entry = Object::new();
    entry.insert("baseType".into(), json!("identifier"));
    entry.insert("points".into(), json_num(js_max(&correct)));
    entry.insert("options".into(), Json::Object(options));
    Ok(Held { entry, menu })
}

pub struct Cut {
    pub segments: Vec<Json>,
    pub mapping: Object,
}

/// Cut the text at its markers and bind each dropdown to its menu.
pub fn cut(text: &str, dropdowns: &[Json], at: &str) -> Result<Cut, String> {
    let mut declared: Vec<(String, Held)> = Vec::new();
    for (i, d) in dropdowns.iter().enumerate() {
        let at = format!("{at}: dropdown {}", i + 1);
        let id = string(prop(Some(d), "id")).map(text::trim).unwrap_or_default();
        if id.is_empty() {
            return Err(format!(
                "{at}: needs an `id`, which is what the marker in the text refers to — e.g. [ id \"gas\" options [ [ text \"oxygen\" assess [ correct ] ] ] {{}} ] with {{{{gas}}}} in the text."
            ));
        }
        if declared.iter().any(|(declared, _)| declared == id) {
            return Err(format!("{at}: the id \"{id}\" is already used. Each dropdown needs its own."));
        }
        let held = read_options(d, &at)?;
        declared.push((id.to_owned(), held));
    }
    let segments =
        cut_markers(text, &declared, &WORDS, at, |id, held| json!({ "id": id, "choice": true, "options": held.menu }))?;
    let mapping =
        match js_order(Json::Object(declared.into_iter().map(|(id, held)| (id, Json::Object(held.entry))).collect())) {
            Json::Object(mapping) => mapping,
            _ => Object::new(),
        };
    Ok(Cut { segments, mapping })
}
