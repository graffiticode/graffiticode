// SPDX-License-Identifier: MIT

//! The survey record, and the rules that hold a response to it (`survey.ts`).
//!
//! A program names a survey; its data says which of two styles it is — ranked choice
//! (`ranked.rs`) or rating (`rating.rs`) — and holds everything it asks. What the program
//! contributes is the response, written inside `survey`'s list and lifted out to the top level
//! of the output, because it is an answer to the survey rather than part of it. There is no
//! player, so the compiler is the only enforcement there is.

use crate::attributes::{assert_known_attributes, merge_attributes};
use crate::js::{Js, Obj, js_string, show_value, trim};
use crate::rating::read_ratings;
use crate::source::Loaded;
use crate::{ranked, rating};

const STYLES: [&str; 2] = ["ranked-choice", "rating"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Ranked,
    Rating,
}

/// Which style a survey's data declares. Required, not inferred; a bare list is the one
/// shorthand, and means ranked-choice options.
fn style_of(instance: &str, data: &Js) -> Result<Style, String> {
    if matches!(data, Js::List(_)) {
        return Ok(Style::Ranked);
    }
    if !data.is_record() {
        return Err(format!(
            "survey: {instance} is {}. A survey's data is a record with its `style`, title, instructions and contents.",
            show_value(data)
        ));
    }
    match data.get("style") {
        Js::Str(style) if style == STYLES[0] => Ok(Style::Ranked),
        Js::Str(style) if style == STYLES[1] => Ok(Style::Rating),
        other => Err(format!(
            "survey: {instance} {}. Give \"style\": \"ranked-choice\" (options to choose and rank) or \"style\": \"rating\" (items answered on a scale).",
            if other.is_undefined() {
                "does not say its `style`".to_owned()
            } else {
                format!("has the style {}", show_value(other))
            }
        )),
    }
}

/// Trims a free-text answer, refusing an empty one rather than recording a blank.
fn free_text(word: &str, raw: &Js, what: &str) -> Result<Js, String> {
    if raw.is_undefined() {
        return Ok(Js::Undefined);
    }
    let text = trim(&js_string(raw)).to_owned();
    if text.is_empty() {
        return Err(format!(
            "response: `{word}` is empty. Write {what}, or leave `{word}` out — an empty one says nothing."
        ));
    }
    Ok(Js::Str(text))
}

fn field<'a>(attrs: &'a Obj, name: &str) -> &'a Js {
    attrs.get(name).unwrap_or(&Js::Undefined)
}

/// Assembles a response from its attribute list. It is checked against the survey later, once
/// the survey is known.
pub fn build_response(raw: &Js) -> Result<Js, String> {
    let attrs = merge_attributes(raw, "response")?;
    assert_known_attributes("response", &attrs)?;
    let (choices, write_in, ratings, comment) =
        (field(&attrs, "choices"), field(&attrs, "writeIn"), field(&attrs, "ratings"), field(&attrs, "comment"));
    if [choices, write_in, ratings, comment].iter().all(|v| v.is_undefined()) {
        return Err(
            "response: is empty. Answer a ranked-choice survey with the options chosen and, optionally, a write-in — response [choices [\"…\" \"…\"] write-in \"…\"] — or a rating survey with its ratings — response [ratings [[item \"…\" rating \"…\"]]]."
                .to_owned(),
        );
    }
    let write_in = free_text("write-in", write_in, "the new option")?;
    let comment = free_text("comment", comment, "the comment")?;
    let mut out = Obj::new();
    if !choices.is_undefined() {
        out.insert("choices".into(), choices.clone());
    }
    if !write_in.is_undefined() {
        out.insert("writeIn".into(), write_in);
    }
    if !ratings.is_undefined() {
        out.insert("ratings".into(), read_ratings(ratings)?);
    }
    if !comment.is_undefined() {
        out.insert("comment".into(), comment);
    }
    Ok(Js::Obj(out))
}

/// What a `survey`'s list says before the survey is loaded: its id and session.
pub struct Asked {
    pub id: Js,
    /// Trimmed; absent when empty, which is what an unresolved `get-val-public` leaves.
    pub session: Option<String>,
    attrs: Obj,
}

/// Reads a `survey`'s attribute list far enough to know what to load.
pub fn read_survey_attributes(raw: &Js) -> Result<Asked, String> {
    let attrs = merge_attributes(raw, "survey")?;
    assert_known_attributes("survey", &attrs)?;
    let id = field(&attrs, "id").clone();
    if id.is_undefined() {
        return Err("survey: needs `id`, the survey being taken, e.g. survey [id \"civic-priorities\" session-id get-val-public \"itemId\"]. What the survey asks comes from the survey itself, so the id is what says which survey this is.".to_owned());
    }
    let session = field(&attrs, "sessionId").as_str().map(trim).filter(|s| !s.is_empty()).map(str::to_owned);
    Ok(Asked { id, session, attrs })
}

/// Refuses the words of one style written in answer to the other, naming the words that fit.
fn assert_style_words(style: Style, instance: &str, response: &Js) -> Result<(), String> {
    let given = |name: &str| !response.get(name).is_undefined();
    let wrong: Vec<&str> = match style {
        Style::Rating => [("choices", "choices"), ("write-in", "writeIn")],
        Style::Ranked => [("ratings", "ratings"), ("comment", "comment")],
    }
    .into_iter()
    .filter(|(_, field)| given(field))
    .map(|(word, _)| word)
    .collect();
    if wrong.is_empty() {
        return Ok(());
    }
    let words: Vec<String> = wrong.iter().map(|w| format!("`{w}`")).collect();
    let words = words.join(" and ");
    let verb = if wrong.len() == 1 { "answers" } else { "answer" };
    Err(match style {
        Style::Rating => format!(
            "response: {words} {verb} a ranked-choice survey, but {instance} is a rating survey. Answer it with ratings [[item \"…\" rating \"…\"] …], naming each item by its text, and a `comment` if the survey asks for one."
        ),
        Style::Ranked => format!(
            "response: {words} {verb} a rating survey, but {instance} is a ranked-choice survey. Answer it with choices [\"…\" \"…\"], naming each option by its text, and optionally one `write-in`."
        ),
    })
}

/// Assembles the compiled survey from what the program asked and the survey data loaded for
/// it, and checks the response against it. The response is lifted out to the top level.
pub fn build_survey(asked: &Asked, loaded: &Loaded) -> Result<Js, String> {
    let instance = js_string(&loaded.instance);
    let mut survey = Obj::new();
    survey.insert("id".into(), asked.id.clone());
    if let Some(session) = &asked.session {
        survey.insert("sessionId".into(), Js::Str(session.clone()));
    }
    survey.insert("instance".into(), loaded.instance.clone());
    let style = style_of(&instance, &loaded.data)?;
    // `if (!authored)`: a record literal can carry a falsy `response`, which is no response.
    let authored = Some(field(&asked.attrs, "response")).filter(|r| r.is_truthy()).unwrap_or(&Js::Undefined);

    let response = match style {
        Style::Rating => {
            let assembled = rating::assemble(&instance, &loaded.data)?;
            assembled.fields(&mut survey);
            if authored.is_undefined() {
                None
            } else {
                assert_style_words(style, &instance, authored)?;
                Some(rating::resolve_response(authored.get("ratings"), authored.get("comment"), &assembled)?)
            }
        }
        Style::Ranked => {
            let assembled = ranked::assemble(&instance, &loaded.data)?;
            assembled.fields(&mut survey);
            if authored.is_undefined() {
                None
            } else {
                assert_style_words(style, &instance, authored)?;
                Some(ranked::resolve_response(authored.get("choices"), authored.get("writeIn"), &assembled)?)
            }
        }
    };

    let mut out = Obj::from([("survey".to_owned(), Js::Obj(survey))]);
    if let Some(response) = response {
        out.insert("response".into(), response);
    }
    Ok(Js::Obj(out))
}
