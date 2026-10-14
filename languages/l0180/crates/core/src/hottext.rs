// SPDX-License-Identifier: MIT

//! Segmenting text into selectable units, and resolving an author's quotes onto them:
//! `packages/core/src/hottext.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value as Json, json};

use crate::attributes::assert_assess_words;
use crate::plain::{Object, number, prop, string};
use crate::text::{self, SPACE};

/// A unit is `{id, text, pre?, post?, selectable}`, kept as the object it is emitted as.
pub type Unit = Object;

const SENTENCE_ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "hon", "capt", "gen", "sgt", "lt", "col", "sen", "gov", "pres",
    "jr", "sr", "st", "mt", "ft", "rd", "ave", "blvd", "no", "vs", "etc", "approx", "dept",
];

// JavaScript's `/i` without `/u` folds ASCII letters only, so the abbreviations fold as bytes.
static ABBREV_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"(?:^|{}|[("'‘“])(?i-u:{})\.$"#, SPACE, SENTENCE_ABBREVIATIONS.join("|"))).unwrap()
});
static INITIAL_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?:^|{SPACE})[A-Za-z]\.$")).unwrap());
static DOTTED_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?:^|{SPACE})[A-Za-z]\.[A-Za-z]\.$")).unwrap());
static SENTENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#"[^.!?]+[.!?]+["'”’)\]]*{SPACE}*"#)).unwrap());
static LEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^A-Za-z0-9]+").unwrap());
static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9]+$").unwrap());
static NOT_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

fn ends_mid_abbreviation(s: &str) -> bool {
    ABBREV_END.is_match(s) || INITIAL_END.is_match(s) || DOTTED_END.is_match(s)
}

/// Split a paragraph into sentences.
pub fn split_sentences(text: &str) -> Vec<String> {
    let t = text::trim(text);
    if t.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = SENTENCE.find_iter(t).map(|m| m.as_str()).collect();
    if parts.is_empty() {
        return vec![t.to_owned()];
    }
    let mut out: Vec<String> = Vec::new();
    for raw in &parts {
        let piece = text::trim(raw);
        if piece.is_empty() {
            continue;
        }
        let continues = piece.starts_with(|c: char| c.is_ascii_lowercase());
        match out.last_mut() {
            Some(last) if continues || ends_mid_abbreviation(last) => {
                last.push(' ');
                last.push_str(piece);
            }
            _ => out.push(piece.to_owned()),
        }
    }
    // `t.slice(parts.join("").length)`: the matched length, in UTF-16 units, as an offset
    // from the start — which is not where the last match ended when a run was skipped.
    let consumed: usize = parts.iter().map(|p| text::length(p)).sum();
    let tail = text::slice(t, consumed, usize::MAX);
    let tail = text::trim(&tail);
    if !tail.is_empty() {
        match out.last_mut() {
            Some(last) if ends_mid_abbreviation(last) => {
                last.push(' ');
                last.push_str(tail);
            }
            _ => out.push(tail.to_owned()),
        }
    }
    out
}

/// Sentence units over paragraphs `(id, text)`. Every sentence is selectable.
pub fn sentence_units(paragraphs: &[(String, String)]) -> Vec<Unit> {
    let mut units = Vec::new();
    for (id, text) in paragraphs {
        for (i, sentence) in split_sentences(text).into_iter().enumerate() {
            let unit = json!({ "id": format!("{id}.{}", i + 1), "text": sentence, "selectable": true });
            units.push(unit.as_object().cloned().unwrap_or_default());
        }
    }
    units
}

/// Word units over a single run of text. Nothing is selectable until a selection names it.
pub fn word_units(text: &str) -> Vec<Unit> {
    text.split(text::is_space)
        .filter(|w| !w.is_empty())
        .enumerate()
        .map(|(i, raw)| {
            let pre = LEADING.find(raw).map_or("", |m| m.as_str());
            let post = TRAILING.find(raw).map_or("", |m| m.as_str());
            let core = if pre.len() + post.len() >= raw.len() { "" } else { &raw[pre.len()..raw.len() - post.len()] };
            let unit = json!({
                "id": format!("w{}", i + 1),
                "text": if core.is_empty() { raw } else { core },
                "pre": if core.is_empty() { "" } else { pre },
                "post": if core.is_empty() { "" } else { post },
                "selectable": false,
            });
            unit.as_object().cloned().unwrap_or_default()
        })
        .collect()
}

/// Case, punctuation and spacing all stop mattering.
pub fn norm(s: &str) -> String {
    let lowered = text::lower(s);
    text::trim(&NOT_ALNUM.replace_all(&lowered, " ")).to_owned()
}

/// Levenshtein over normalized text (which is ASCII).
fn distance(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut row = vec![i];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            row.push((prev[j] + 1).min(row[j - 1] + 1).min(prev[j - 1] + cost));
        }
        prev = row;
    }
    prev[b.len()]
}

/// Enough of a long sentence to recognise it in an error.
fn excerpt(s: &str, n: usize) -> String {
    if text::length(s) <= n { s.to_owned() } else { format!("{}…", text::slice(s, 0, n - 1)) }
}

fn unit_text(unit: &Unit) -> &str {
    unit.get("text").and_then(Json::as_str).unwrap_or_default()
}

/// Which units a quote names: equality or containment either way, over normalized text.
fn matches(units: &[Unit], quote: &str) -> Vec<usize> {
    let q = norm(quote);
    if q.is_empty() {
        return Vec::new();
    }
    (0..units.len())
        .filter(|&i| {
            let n = norm(unit_text(&units[i]));
            q == n || q.contains(&n) || n.contains(&q)
        })
        .collect()
}

pub struct Resolved {
    pub mapping: Object,
    pub feedback: Object,
    pub correct_ids: Vec<String>,
}

/// Resolve authored selections onto segmented units, marking the named ones selectable.
pub fn resolve_selections(units: &mut [Unit], selections: &[Json], at: &str) -> Result<Resolved, String> {
    let mut mapping = Object::new();
    let mut feedback = Object::new();
    let mut correct_ids = Vec::new();
    let mut claimed: Vec<(String, usize)> = Vec::new();

    for (i, sel) in selections.iter().enumerate() {
        let at = format!("{at}: selection {}", i + 1);
        let quote = string(prop(Some(sel), "quote")).unwrap_or_default();
        if text::trim(quote).is_empty() {
            return Err(format!(
                "{at}: needs a `quote` naming the text to select, e.g. [ quote \"…\" assess [ correct ] ]."
            ));
        }
        let hits = matches(units, quote);
        if hits.is_empty() {
            let q = norm(quote);
            let mut order: Vec<&Unit> = units.iter().collect();
            order.sort_by_key(|u| distance(&norm(unit_text(u)), &q));
            let near = order
                .first()
                .map_or_else(String::new, |near| format!("The closest is \"{}\". ", excerpt(unit_text(near), 60)));
            return Err(format!(
                "{at}: \"{}\" does not appear in the text. {near}A quote must match the text it selects; copy it from the passage.",
                excerpt(quote, 60)
            ));
        }
        if hits.len() > 1 {
            return Err(format!(
                "{at}: \"{}\" matches {} places — \"{}\" and \"{}\". Quote more of the surrounding text so it names one.",
                excerpt(quote, 60),
                hits.len(),
                excerpt(unit_text(&units[hits[0]]), 40),
                excerpt(unit_text(&units[hits[1]]), 40)
            ));
        }
        let unit = &mut units[hits[0]];
        let id = unit.get("id").and_then(Json::as_str).unwrap_or_default().to_owned();
        if let Some((_, prior)) = claimed.iter().find(|(claimed, _)| *claimed == id) {
            return Err(format!(
                "{at}: selects the same text as selection {prior}. Each selection must name a different place."
            ));
        }
        claimed.push((id.clone(), i + 1));
        unit.insert("selectable".into(), json!(true));

        let Some(assess) = prop(Some(sel), "assess") else { continue };
        assert_assess_words(Some(assess), &["correct", "points", "rationale"], &at)?;
        let is_correct = prop(Some(assess), "correct") == Some(&json!(true));
        let points = number(prop(Some(assess), "points"));
        let rationale = string(prop(Some(assess), "rationale"));
        if !is_correct && points.is_none() && rationale.is_none() {
            return Err(format!("{at}: assess must say what it asserts — `correct`, `points`, or `rationale`."));
        }
        if let Some(rationale) = rationale {
            feedback.insert(id.clone(), json!(rationale));
        }
        if is_correct {
            correct_ids.push(id.clone());
        }
        if is_correct || points.is_some() {
            let value = prop(Some(assess), "points").filter(|_| points.is_some()).cloned().unwrap_or(json!(1));
            mapping.insert(
                id,
                if is_correct { json!({ "correct": true, "points": value }) } else { json!({ "points": value }) },
            );
        }
    }
    Ok(Resolved { mapping, feedback, correct_ids })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_split_as_l0175s_do_less_two_departures() {
        assert_eq!(split_sentences("Mr. Ruiz smiled. He left."), ["Mr. Ruiz smiled.", "He left."]);
        assert_eq!(split_sentences("\"Stop!\" she called. Then quiet"), ["\"Stop!\" she called.", "Then quiet"]);
        assert_eq!(split_sentences("No terminator"), ["No terminator"]);
        assert_eq!(split_sentences("It was 5 p.m. Then J. Smith came."), ["It was 5 p. m. Then J. Smith came."]);
        assert_eq!(split_sentences("A. .. B."), ["A. B. B."]);
        assert_eq!(split_sentences("X. .. b c. D."), ["X. b c. D. D."]);
    }

    #[test]
    fn words_keep_their_punctuation_apart() {
        let units = word_units("Hello, (world)! --");
        let texts: Vec<&str> = units.iter().map(unit_text).collect();
        assert_eq!(texts, ["Hello", "world", "--"]);
        assert_eq!(units[1]["pre"], "(");
        assert_eq!(units[1]["post"], ")!");
        assert_eq!(units[2]["pre"], "");
    }

    #[test]
    fn quotes_match_loosely() {
        assert_eq!(norm("  All of the Above! "), "all of the above");
        assert_eq!(distance("kitten", "sitting"), 3);
        assert_eq!(excerpt("abcdef", 4), "abc…");
    }
}
