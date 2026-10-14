// SPDX-License-Identifier: MIT

//! Cutting a sentence into text and blanks, and binding each blank to its responses:
//! `packages/core/src/textentry.ts`. `cut_markers` is shared with `inline-choice` and
//! `gap-match`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value as Json, json};

use crate::attributes::assert_assess_words;
use crate::decimal::Decimal;
use crate::matching::{NUMBER_FORMATS, normalize, parse_number, permitted_formats, terminates};
use crate::plain::{Object, js_order, js_str, json_num, num, number, prop, string};
use crate::text;

static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{([^{}]*)\}\}").unwrap());

/// What to call a hole in the sentence, so an error names the reader's own word.
pub struct MarkerWords {
    pub one: &'static str,
    pub list: &'static str,
    pub marker: &'static str,
    pub sentence: &'static str,
    pub unit: &'static str,
    pub fill: &'static str,
}

const TEXT_ENTRY_WORDS: MarkerWords = MarkerWords {
    one: "blank",
    list: "blanks",
    marker: "{{capital}}",
    sentence: "The capital of France is {{capital}}.",
    unit: "input",
    fill: "be typed into it",
};

/// Cut the text at its markers, and check that markers and holes account for each other.
/// `declared` is the holes in the order they were declared; `segment` builds a hole's segment.
pub fn cut_markers<T>(
    text: &str,
    declared: &[(String, T)],
    words: &MarkerWords,
    at: &str,
    segment: impl Fn(&str, &T) -> Json,
) -> Result<Vec<Json>, String> {
    let mut segments = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut last = 0;
    for m in MARKER.captures_iter(text) {
        let whole = m.get(0).expect("a match has a whole");
        let id = text::trim(&m[1]);
        if id.is_empty() {
            return Err(format!(
                "{at}: a marker at position {} names no {}. Write {{{{<id>}}}}, e.g. {}, matching an id in `{}`.",
                text::offset(text, whole.start()),
                words.one,
                words.marker,
                words.list
            ));
        }
        let Some((_, entry)) = declared.iter().find(|(declared, _)| declared == id) else {
            let ids: Vec<&str> = declared.iter().map(|(id, _)| id.as_str()).collect();
            let ids = if ids.is_empty() { "nothing".to_owned() } else { ids.join(", ") };
            return Err(format!(
                "{at}: the text has {{{{{id}}}}} but no {} declares that id. `{}` declares: {ids}.",
                words.one, words.list
            ));
        };
        if seen.iter().any(|s| s == id) {
            return Err(format!(
                "{at}: {{{{{id}}}}} appears twice. One {} is one {} — give the second its own id and its own entry in `{}`.",
                words.one, words.unit, words.list
            ));
        }
        seen.push(id.to_owned());
        if whole.start() > last {
            segments.push(json!({ "text": &text[last..whole.start()] }));
        }
        segments.push(segment(id, entry));
        last = whole.end();
    }
    if seen.is_empty() {
        return Err(format!(
            "{at}: `text` has no {{{{…}}}} marker, so the item renders with nothing to fill in. Put {{{{<id>}}}} where the answer goes, e.g. \"{}\"",
            words.sentence
        ));
    }
    if last < text.len() {
        segments.push(json!({ "text": &text[last..] }));
    }
    if let Some((orphan, _)) = declared.iter().find(|(id, _)| !seen.contains(id)) {
        return Err(format!(
            "{at}: {} \"{orphan}\" has no {{{{{orphan}}}}} in the text, so nothing can {}. Add the marker, or remove the {}.",
            words.one, words.fill, words.one
        ));
    }
    Ok(segments)
}

pub struct Cut {
    pub segments: Vec<Json>,
    /// The key, in JavaScript's key order.
    pub mapping: Object,
}

fn strings(json: Option<&Json>) -> Option<Vec<String>> {
    match json {
        Some(Json::Array(items)) => Some(items.iter().map(|item| js_str(Some(item))).collect()),
        _ => None,
    }
}

/// Cut a text-entry's sentence and bind each blank to the answers it recognizes.
pub fn cut(text: &str, blanks: &[Json], case_sensitive: bool, at: &str) -> Result<Cut, String> {
    let mut declared: Vec<(String, Object)> = Vec::new();
    for (i, b) in blanks.iter().enumerate() {
        let at = format!("{at}: blank {}", i + 1);
        let id = string(prop(Some(b), "id")).map(text::trim).unwrap_or_default();
        if id.is_empty() {
            return Err(format!(
                "{at}: needs an `id`, which is what the marker in the text refers to — e.g. [ id \"capital\" responses [ [ response \"Paris\" assess [ correct ] ] ] {{}} ] with {{{{capital}}}} in the text."
            ));
        }
        if declared.iter().any(|(declared, _)| declared == id) {
            return Err(format!("{at}: the id \"{id}\" is already used. Each blank needs its own."));
        }
        let responses = match prop(Some(b), "responses") {
            Some(Json::Array(responses)) if !responses.is_empty() => responses,
            _ => {
                return Err(format!(
                    "{at}: needs at least one response, e.g. responses [ [ response \"Paris\" assess [ correct ] ] ] {{}}."
                ));
            }
        };

        let base_type = prop(Some(b), "baseType").cloned().unwrap_or(json!("string"));
        let numeric = base_type != json!("string");
        let base_name = js_str(Some(&base_type));
        let given_case = prop(Some(b), "caseSensitive");
        let tolerance = prop(Some(b), "tolerance");
        let formats = prop(Some(b), "inputFormats");
        if numeric && given_case.is_some() {
            return Err(format!(
                "{at}: `case-sensitive` means nothing on a {base_name} blank — numbers have no case. Remove it, or drop `base-type` to compare the answers as text."
            ));
        }
        if !numeric && tolerance.is_some() {
            return Err(format!(
                "{at}: `tolerance` means nothing on a text blank — it is how close a NUMBER may be. Add `base-type \"float\"` to compare numerically, or remove the tolerance."
            ));
        }
        if let Some(t) = tolerance
            && crate::plain::to_number(Some(t)) < 0.0
        {
            return Err(format!("{at}: tolerance {} is negative. It is a distance, so it cannot be.", js_str(Some(t))));
        }
        if !numeric && formats.is_some() {
            return Err(format!(
                "{at}: `input-formats` means nothing on a text blank — it says how a NUMBER may be written. Add `base-type \"float\"`, or remove it."
            ));
        }
        let listed = strings(formats);
        if let Some(listed) = &listed
            && listed.iter().any(|f| f == "numeric")
            && listed.len() > 1
        {
            let others: Vec<String> = listed.iter().filter(|f| *f != "numeric").map(|f| format!("`{f}`")).collect();
            return Err(format!(
                "{at}: `numeric` already means every form, so listing it beside {} says two different things. List the forms you want, or just `numeric`.",
                others.join(" and ")
            ));
        }
        let allowed = permitted_formats(listed.as_deref());
        let constrains = allowed.len() < NUMBER_FORMATS.len();

        let cs = !numeric
            && match given_case {
                Some(given) => given == &json!(true),
                None => case_sensitive,
            };
        let mut recognized: Vec<Json> = Vec::new();
        let mut claimed: Vec<(String, usize)> = Vec::new();
        let mut numbers: Vec<(usize, Decimal, String)> = Vec::new();
        for (j, r) in responses.iter().enumerate() {
            let rat = format!("{at}: response {}", j + 1);
            let value = string(prop(Some(r), "response")).map(text::trim).unwrap_or_default();
            if value.is_empty() {
                return Err(format!(
                    "{rat}: needs the answer it recognizes, e.g. [ response \"Paris\" assess [ correct ] ]."
                ));
            }
            if numeric {
                let Some(parsed) = parse_number(value) else {
                    return Err(format!(
                        "{rat}: \"{value}\" is not a number this can compare. Whole numbers, decimals and simple fractions are understood — 8, -3, 0.5, .5, 1/2, 1,000. Expressions, units and symbols are not."
                    ));
                };
                if base_type == json!("integer") && !parsed.value.is_integer() {
                    return Err(format!(
                        "{rat}: \"{value}\" is not a whole number, but the blank says `base-type \"integer\"`. Use `base-type \"float\"`, or give a whole number."
                    ));
                }
                if !terminates(value) && tolerance.is_none() && allowed.iter().any(|f| *f != "fraction") {
                    return Err(format!(
                        "{rat}: \"{value}\" has no exact decimal form, so no decimal a candidate types can ever match it — 0.333 and 0.3333 would both be wrong, with nothing said about why. Either ask for a fraction with `input-formats [ \"fraction\" ]`, which says so when one is not given, or add a `tolerance` saying how close a decimal must be."
                    ));
                }
                // decimal.js reads a JavaScript number through its `toString`.
                let reach = match tolerance {
                    Some(t) => crate::plain::to_number(Some(t)) * 2.0,
                    None => 0.0,
                };
                let reach = Decimal::parse(&num(reach));
                let clash = numbers.iter().find(|(_, prev, _)| {
                    reach.as_ref().is_some_and(|reach| prev.minus(&parsed.value).abs().lte(reach))
                });
                if let Some((at, _, text)) = clash {
                    let within = match tolerance {
                        Some(t) => format!(" within a tolerance of {}", js_str(Some(t))),
                        None => String::new(),
                    };
                    return Err(format!(
                        "{rat}: \"{value}\" is the same answer as response {at} (\"{text}\"){within}. Two responses cannot claim the same typed input — merge them, or tighten the tolerance so they are told apart."
                    ));
                }
                numbers.push((j + 1, parsed.value, value.to_owned()));
            } else {
                let norm = normalize(value, cs);
                if let Some((_, prior)) = claimed.iter().find(|(claimed, _)| *claimed == norm) {
                    return Err(format!(
                        "{rat}: \"{value}\" is the same answer as response {prior}{}. Two responses cannot claim the same typed input — merge them, or set `case-sensitive true` if the difference is meant to matter.",
                        if cs { "" } else { " once capitals are ignored" }
                    ));
                }
                claimed.push((norm, j + 1));
            }

            let Some(assess) = prop(Some(r), "assess") else {
                return Err(format!(
                    "{rat}: needs an `assess` saying what \"{value}\" is worth — `assess [correct]` for a right answer, `assess [points 1]` for partial credit, `assess [rationale \"…\"]` to explain a wrong one."
                ));
            };
            assert_assess_words(Some(assess), &["correct", "points", "rationale"], &rat)?;
            let is_correct = prop(Some(assess), "correct") == Some(&json!(true));
            let points = number(prop(Some(assess), "points"));
            let rationale = string(prop(Some(assess), "rationale"));
            if !is_correct && points.is_none() && rationale.is_none() {
                return Err(format!("{rat}: assess must say what it asserts — `correct`, `points`, or `rationale`."));
            }
            let mut entry = Object::new();
            entry.insert("response".into(), json!(value));
            if is_correct {
                entry.insert("correct".into(), json!(true));
            }
            entry.insert(
                "points".into(),
                match points {
                    Some(_) => prop(Some(assess), "points").cloned().unwrap_or_default(),
                    None => json!(if is_correct { 1 } else { 0 }),
                },
            );
            if let Some(rationale) = rationale {
                entry.insert("rationale".into(), json!(rationale));
            }
            recognized.push(Json::Object(entry));
        }

        let correct: Vec<f64> = recognized
            .iter()
            .filter(|r| r.get("correct").is_some())
            .map(|r| r["points"].as_f64().unwrap_or(f64::NAN))
            .collect();
        if correct.is_empty() {
            return Err(format!(
                "{at}: no response is marked `correct`, so the blank cannot be scored. Add `assess [correct]` to the right answer."
            ));
        }
        let mut entry = Object::new();
        entry.insert("baseType".into(), base_type.clone());
        entry.insert("points".into(), json_num(js_max(&correct)));
        if numeric {
            if let Some(t) = tolerance {
                entry.insert("tolerance".into(), t.clone());
            }
            if constrains {
                entry.insert("inputFormats".into(), json!(allowed));
            }
        } else {
            entry.insert("caseSensitive".into(), json!(cs));
        }
        entry.insert("responses".into(), Json::Array(recognized));
        declared.push((id.to_owned(), entry));
    }

    let segments = cut_markers(text, &declared, &TEXT_ENTRY_WORDS, at, |id, entry| {
        let mut segment = json!({ "id": id, "blank": true });
        if entry.get("baseType") != Some(&json!("string")) {
            segment["numeric"] = json!(true);
        }
        segment
    })?;
    let mapping = match js_order(Json::Object(declared.into_iter().map(|(id, e)| (id, Json::Object(e))).collect())) {
        Json::Object(mapping) => mapping,
        _ => Object::new(),
    };
    Ok(Cut { segments, mapping })
}

/// `Math.max(...values)`.
pub fn js_max(values: &[f64]) -> f64 {
    values.iter().fold(f64::NEG_INFINITY, |max, &v| {
        if max.is_nan() || v.is_nan() {
            f64::NAN
        } else if v > max || (v == 0.0 && max == 0.0 && max.is_sign_negative()) {
            v
        } else {
            max
        }
    })
}

/// The sum of every entry's `points`, in key order.
pub fn total_points(mapping: &Object) -> f64 {
    mapping.values().fold(0.0, |n, e| n + crate::plain::to_number(e.get("points")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marker_is_found_by_its_utf16_offset() {
        let declared: Vec<(String, ())> = vec![("a".into(), ())];
        let err = cut_markers("é𝒳 {{ }}", &declared, &TEXT_ENTRY_WORDS, "t", |_, _| json!(null)).unwrap_err();
        assert!(err.starts_with("t: a marker at position 4 names no blank."), "{err}");
    }

    #[test]
    fn the_largest_value_wins_as_math_max_has_it() {
        assert_eq!(js_max(&[1.0, 3.0, 2.0]), 3.0);
        assert!(js_max(&[0.0, -0.0]).is_sign_positive());
    }
}
