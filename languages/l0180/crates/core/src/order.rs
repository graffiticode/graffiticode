// SPDX-License-Identifier: MIT

//! Sequencing: `packages/core/src/order.ts`. The authored order is the order the candidate
//! sees, and each element says where it belongs.

use serde_json::{Value as Json, json};

use crate::anchors::option_label;
use crate::attributes::assert_assess_words;
use crate::plain::{js_str, prop};
use crate::text;

pub struct Sequenced {
    pub elements: Vec<Json>,
    pub correct_response: Vec<Json>,
    pub interchangeable: Option<Vec<Vec<String>>>,
}

pub fn sequence(elements: &[Json], at: &str) -> Result<Sequenced, String> {
    if elements.len() < 2 {
        return Err(format!(
            "{at}: needs at least two elements — one thing is already in order. e.g. elements [[text \"First\" assess [position 1]] [text \"Second\" assess [position 2]]] {{}}."
        ));
    }
    let mut seen: Vec<(String, usize)> = Vec::new();
    let mut presented: Vec<(String, String)> = Vec::new();
    // Position → element, in the order claimed.
    let mut claimed: Vec<(f64, usize)> = Vec::new();
    for (i, el) in elements.iter().enumerate() {
        let at = format!("{at}: element {}", i + 1);
        let id = match prop(Some(el), "id") {
            Some(id) => js_str(Some(id)),
            None => option_label(i),
        };
        if let Some((_, prior)) = seen.iter().find(|(seen, _)| *seen == id) {
            return Err(format!(
                "{at}: two elements share the id \"{id}\" (elements {prior} and {}). Ids must be unique; omit `id` to have them derived.",
                i + 1
            ));
        }
        seen.push((id.clone(), i + 1));
        let text = prop(Some(el), "text").map_or_else(String::new, |t| js_str(Some(t)));
        if text::trim(&text).is_empty() {
            return Err(format!("{at}: needs the `text` the candidate reads and moves."));
        }
        presented.push((id, text));

        let assess = prop(Some(el), "assess");
        assert_assess_words(assess, &["position"], &at)?;
        let Some(position) = prop(assess, "position") else {
            return Err(format!(
                "{at}: needs `assess [position N]` saying where it belongs in the right sequence, counting from 1. Every element needs one — the order they are written here is the order the candidate sees, not the answer."
            ));
        };
        let shown = js_str(Some(position));
        let Some(p) = position.as_f64().filter(|p| p.fract() == 0.0 && p.is_finite()) else {
            return Err(format!("{at}: position {shown} is not a whole number. Positions count 1, 2, 3…"));
        };
        if p < 1.0 || p > elements.len() as f64 {
            return Err(format!(
                "{at}: position {shown} is outside 1…{}, and there are {} elements to place.",
                elements.len(),
                elements.len()
            ));
        }
        if let Some((_, prior)) = claimed.iter().find(|(claimed, _)| *claimed == p) {
            return Err(format!(
                "{at}: position {} is already taken by element {prior}. Each element holds one place in the sequence.",
                shown
            ));
        }
        claimed.push((p, i + 1));
    }
    claimed.sort_by(|a, b| a.0.total_cmp(&b.0));
    let correct_response = claimed.iter().map(|(_, at)| json!(presented[at - 1].0)).collect();

    let mut by_text: Vec<(String, Vec<String>)> = Vec::new();
    for (id, text) in &presented {
        let key = text::trim(text).to_owned();
        match by_text.iter_mut().find(|(k, _)| *k == key) {
            Some((_, ids)) => ids.push(id.clone()),
            None => by_text.push((key, vec![id.clone()])),
        }
    }
    let groups: Vec<Vec<String>> = by_text.into_iter().map(|(_, ids)| ids).filter(|ids| ids.len() > 1).collect();
    Ok(Sequenced {
        elements: presented.into_iter().map(|(id, text)| json!({ "id": id, "text": text })).collect(),
        correct_response,
        interchangeable: if groups.is_empty() { None } else { Some(groups) },
    })
}
