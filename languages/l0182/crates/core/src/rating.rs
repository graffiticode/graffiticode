// SPDX-License-Identifier: MIT

//! The rating style (`rating.ts`): a list of items, each answered on a scale. The Likert
//! family, NPS, stars and the semantic differential differ only in their scale, and
//! `scales.rs` reduces every scale to one list of points, so nothing here knows which it has.

use indexmap::IndexMap;

use crate::attributes::{VOCAB, assert_known_attributes, merge_attributes};
use crate::js::{Js, Obj, is_text, normalise_text, num, quote, show_value, trim};
use crate::resolve::{Index, Named, not_text};
use crate::scales::{Scale, read_anchors, read_scale};

/// One item as compiled, its scale resolved inline.
#[derive(Clone, Debug)]
pub struct Item {
    pub id: String,
    pub text: String,
    pub scale: Scale,
    /// Must a response answer it? An opt-out counts as an answer.
    pub required: bool,
    /// This item's words for the two ends of its scale.
    pub anchors: Option<(String, String)>,
}

impl Named for Item {
    fn id(&self) -> &str {
        &self.id
    }
    fn text(&self) -> &str {
        &self.text
    }
}

/// The rating half of a compiled survey.
pub struct Rating {
    pub title: Js,
    pub instructions: Js,
    pub items: Vec<Item>,
    /// Present when the survey asks for a comment; the prompt is the question it asks.
    pub comment: Option<Option<String>>,
}

impl Rating {
    /// The fields in the order the TypeScript writes them.
    pub fn fields(&self, out: &mut Obj) {
        out.insert("style".into(), Js::Str("rating".into()));
        if !self.title.is_undefined() {
            out.insert("title".into(), self.title.clone());
        }
        out.insert("instructions".into(), self.instructions.clone());
        let items = self
            .items
            .iter()
            .map(|item| {
                let mut obj = Obj::new();
                obj.insert("id".into(), Js::Str(item.id.clone()));
                obj.insert("text".into(), Js::Str(item.text.clone()));
                obj.insert("scale".into(), item.scale.to_js());
                obj.insert("required".into(), Js::Bool(item.required));
                if let Some((low, high)) = &item.anchors {
                    obj.insert("anchors".into(), Js::List(vec![Js::Str(low.clone()), Js::Str(high.clone())]));
                }
                Js::Obj(obj)
            })
            .collect();
        out.insert("items".into(), Js::List(items));
        if let Some(prompt) = &self.comment {
            let comment = prompt.iter().map(|p| ("prompt".to_owned(), Js::Str(p.clone()))).collect();
            out.insert("comment".into(), Js::Obj(comment));
        }
    }
}

/// The scale an item or the survey names: its own `scales` first, then the presets.
fn scale_for(place: &str, raw: &Js, named: &IndexMap<String, Scale>) -> Result<Scale, String> {
    if let Some(scale) = raw.as_str().and_then(|name| named.get(name)) {
        return Ok(scale.clone());
    }
    read_scale(place, raw, None)
}

/// Checks and assembles a rating survey from its data. Every message names the file.
pub fn assemble(instance: &str, data: &Js) -> Result<Rating, String> {
    let mut named: IndexMap<String, Scale> = IndexMap::new();
    let scales = data.get("scales");
    if !scales.is_undefined() {
        let Js::Obj(scales) = scales else {
            return Err(format!(
                "survey: {instance} has `scales` that are {}; `scales` is a record of named scales.",
                show_value(scales)
            ));
        };
        for (name, raw) in scales {
            let scale = read_scale(&format!("survey: {instance}, scale {}", quote(name)), raw, Some(name))?;
            named.insert(name.clone(), scale);
        }
    }

    let fallback = match data.get("scale") {
        Js::Undefined => None,
        raw => Some(scale_for(&format!("survey: {instance}, `scale`"), raw, &named)?),
    };

    let entries = match data.get("items") {
        Js::List(entries) if !entries.is_empty() => entries,
        _ => {
            return Err(format!(
                "survey: {instance} holds no items. A rating survey's data has an `items` list — each a line of text, or a record like {{\"id\": \"q1\", \"text\": \"…\", \"scale\": \"agreement-5\"}}."
            ));
        }
    };

    let mut items: Vec<Item> = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let place = format!("survey: {instance}, item {}", i + 1);
        let rec = match entry {
            Js::Str(_) => Js::Obj(Obj::from([("text".to_owned(), entry.clone())])),
            other => other.clone(),
        };
        if !rec.is_record() {
            return Err(format!(
                "{place} is {}. An item is a line of text, or a record with its `text`.",
                show_value(entry)
            ));
        }
        let text = rec.get("text");
        if !is_text(text) {
            return Err(format!("{place} has no `text`, the statement or question to rate."));
        }
        let id = rec.get("id");
        if !id.is_undefined() && !is_text(id) {
            return Err(format!("{place} has an `id` that is {}; ids are strings.", show_value(id)));
        }
        let required = rec.get("required");
        if !required.is_undefined() && !matches!(required, Js::Bool(_)) {
            return Err(format!("{place} has a `required` of {}; it is true or false.", show_value(required)));
        }
        let scale = match (rec.get("scale"), &fallback) {
            (Js::Undefined, Some(fallback)) => fallback.clone(),
            (Js::Undefined, None) => {
                return Err(format!(
                    "{place} has no `scale`, and the survey sets no default `scale` for it to fall back on."
                ));
            }
            (raw, _) => scale_for(&format!("{place}, `scale`"), raw, &named)?,
        };
        let anchors = read_anchors(&place, rec.get("anchors"))?;
        items.push(Item {
            id: id.as_str().map_or_else(|| format!("q{i}"), str::to_owned),
            text: trim(text.as_str().unwrap_or_default()).to_owned(),
            scale,
            required: !matches!(required, Js::Bool(false)),
            anchors,
        });
    }

    for (i, item) in items.iter().enumerate() {
        if let Some(seen) = items[..i].iter().position(|x| x.text == item.text) {
            return Err(format!(
                "survey: {instance} has items {} and {} both {}. Each item must be distinct — a duplicate asks the same thing twice.",
                seen + 1,
                i + 1,
                quote(&item.text)
            ));
        }
        if let Some(seen) = items[..i].iter().position(|x| x.id == item.id) {
            return Err(format!(
                "survey: {instance} has items {} and {} sharing the id {}, so a rating naming it is ambiguous. Give each item its own id, or drop the ids and let them be numbered by position.",
                seen + 1,
                i + 1,
                quote(&item.id)
            ));
        }
    }

    let comment = match data.get("comment") {
        Js::Undefined | Js::Bool(false) => None,
        Js::Bool(true) => Some(None),
        given => {
            let prompt = given.get("prompt");
            if !matches!(given, Js::Obj(_) | Js::Opaque(_) | Js::List(_))
                || (!prompt.is_undefined() && !is_text(prompt))
            {
                return Err(format!(
                    "survey: {instance} has a `comment` of {}. It is true, or a record with the `prompt` to ask.",
                    show_value(given)
                ));
            }
            Some(prompt.as_str().map(|p| trim(p).to_owned()))
        }
    };

    let instructions = match data.get("instructions") {
        Js::Undefined => Js::Str(VOCAB.default_rating_instructions.clone()),
        given => given.clone(),
    };
    Ok(Rating { title: data.get("title").clone(), instructions, items, comment })
}

/// Reads `ratings [[item … rating …] …]`: each entry is its own attribute list, and both words
/// are needed.
pub fn read_ratings(raw: &Js) -> Result<Js, String> {
    let Js::List(raw) = raw else {
        // Only a record literal (`{ratings: 5}`) skips the `ratings` word's own check.
        return Err("raw.map is not a function".to_owned());
    };
    raw.iter()
        .enumerate()
        .map(|(i, entry)| {
            let place = format!("ratings: entry {}", i + 1);
            let attrs = merge_attributes(entry, &place)?;
            assert_known_attributes("ratings", &attrs)?;
            let item = attrs.get("item").unwrap_or(&Js::Undefined);
            let rating = attrs.get("rating").unwrap_or(&Js::Undefined);
            if item.is_undefined() || rating.is_undefined() {
                let missing = if item.is_undefined() { "item" } else { "rating" };
                return Err(format!(
                    "{place} has no `{missing}`. Each rating names the item and its answer: [item \"The course met its goals\" rating \"Agree\"]."
                ));
            }
            Ok(Js::Obj(Obj::from([("item".to_owned(), item.clone()), ("rating".to_owned(), rating.clone())])))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Js::List)
}

/// What an item's scale accepts, in words, for a message about an answer it did not.
fn accepts(item: &Item) -> String {
    let points = &item.scale.points;
    let lo = num(points[0].value);
    let hi = num(points[points.len() - 1].value);
    let labels: Vec<String> = points
        .iter()
        .filter_map(|p| p.label.as_ref().filter(|l| !l.is_empty()).map(|l| format!("{} {}", num(p.value), quote(l))))
        .collect();
    let ends = item
        .anchors
        .as_ref()
        .map(|(low, high)| format!(", or its ends {} ({lo}) and {} ({hi})", quote(low), quote(high)))
        .unwrap_or_default();
    let by_label = if labels.len() == points.len() {
        format!(", or by label: {}", labels.join(", "))
    } else if !labels.is_empty() {
        format!(" ({})", labels.join(", "))
    } else {
        String::new()
    };
    let out = item
        .scale
        .opt_out
        .as_ref()
        .filter(|o| !o.is_empty())
        .map(|o| format!("; or {} to opt out", quote(o)))
        .unwrap_or_default();
    format!("a value from {lo} to {hi}{by_label}{ends}{out}")
}

/// An answer resolved: a value on the item's scale, or the opt-out.
enum Answer {
    Value(f64),
    OptOut,
}

/// Resolves one answer against its item's scale. A number is the scale's own value, never a
/// position; a string is a point's label, an anchor, the opt-out, or a number in quotes.
fn resolve_answer(answer: &Js, item: &Item, place: &str) -> Result<Answer, String> {
    let points = &item.scale.points;
    let by_value = |v: f64| points.iter().find(|p| p.value == v);

    let text = match answer {
        Js::Num(n) => {
            return match by_value(*n) {
                Some(point) => Ok(Answer::Value(point.value)),
                None => Err(format!(
                    "{place} rates {} {}, which is not on its scale. It takes {}.",
                    quote(&item.text),
                    num(*n),
                    accepts(item)
                )),
            };
        }
        Js::Str(text) => text,
        other => return Err(not_text(other)),
    };

    let key = normalise_text(text);
    if let Some(point) = points.iter().find(|p| p.label.as_deref().is_some_and(|l| normalise_text(l) == key)) {
        return Ok(Answer::Value(point.value));
    }
    if let Some((low, high)) = &item.anchors {
        if normalise_text(low) == key {
            return Ok(Answer::Value(points[0].value));
        }
        if normalise_text(high) == key {
            return Ok(Answer::Value(points[points.len() - 1].value));
        }
    }
    if item.scale.opt_out.as_deref().is_some_and(|o| normalise_text(o) == key) {
        return Ok(Answer::OptOut);
    }
    if is_whole(&key)
        && let Some(point) = by_value(key.parse::<f64>().unwrap_or(f64::NAN))
    {
        return Ok(Answer::Value(point.value));
    }
    Err(format!(
        "{place} rates {} {}, which is not an answer on its scale. It takes {}.",
        quote(&item.text),
        quote(text),
        accepts(item)
    ))
}

/// `/^-?\d+$/`.
fn is_whole(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Checks a rating response against the survey it answers and resolves it to item ids and
/// values, in the survey's item order whatever order the answers were written in.
///
/// The answers are as written: each a `{item, rating}` record when they came through `ratings`,
/// raw when the program wrote the response as a record literal (see `ranked::resolve_response`).
pub fn resolve_response(ratings: &Js, comment: &Js, survey: &Rating) -> Result<Js, String> {
    let ratings: &[Js] = match ratings {
        Js::Undefined | Js::Null => &[],
        Js::List(ratings) => ratings,
        _ => return Err("authored.ratings.forEach is not a function".to_owned()),
    };
    let index = Index::new(&survey.items);
    let mut answered: IndexMap<String, Answer> = IndexMap::new();
    for (i, entry) in ratings.iter().enumerate() {
        let (reference, rating) = (entry.get("item"), entry.get("rating"));
        let place = format!("response: `ratings` entry {}", i + 1);
        let item = index.resolve(reference, &format!("{place}'s `item`"), "item")?;
        if answered.contains_key(&item.id) {
            return Err(format!(
                "response: `ratings` rates {} twice. Each item takes one answer — keep the one you mean.",
                quote(&item.text)
            ));
        }
        let answer = resolve_answer(rating, item, &place)?;
        answered.insert(item.id.clone(), answer);
    }

    let missing: Vec<&Item> = survey.items.iter().filter(|x| x.required && !answered.contains_key(&x.id)).collect();
    if !missing.is_empty() {
        let one = missing.len() == 1;
        let texts: Vec<String> = missing.iter().map(|x| quote(&x.text)).collect();
        let opt_out = missing.iter().any(|x| x.scale.opt_out.as_deref().is_some_and(|o| !o.is_empty()));
        return Err(format!(
            "response: `ratings` leaves out {} required {}: {}. Rate {}{}",
            missing.len(),
            if one { "item" } else { "items" },
            texts.join(", "),
            if one { "it" } else { "each one" },
            if opt_out { ", or answer with the scale's opt-out where it has one." } else { "." }
        ));
    }

    if !comment.is_undefined() && survey.comment.is_none() {
        return Err("response: `comment` is not asked for by this survey, so there is nowhere to record it. Leave `comment` out.".to_owned());
    }

    let ratings = survey
        .items
        .iter()
        .filter_map(|x| {
            let answer = answered.get(&x.id)?;
            let mut obj = Obj::from([("item".to_owned(), Js::Str(x.id.clone()))]);
            match answer {
                Answer::Value(value) => obj.insert("value".into(), Js::Num(*value)),
                Answer::OptOut => obj.insert("optOut".into(), Js::Bool(true)),
            };
            Some(Js::Obj(obj))
        })
        .collect();
    let mut out = Obj::from([("ratings".to_owned(), Js::List(ratings))]);
    if !comment.is_undefined() {
        out.insert("comment".into(), comment.clone());
    }
    Ok(Js::Obj(out))
}
