// SPDX-License-Identifier: MIT

//! The ranked-choice style (`ranked.ts`): a set of options, some of which a response chooses
//! and puts in priority order, plus at most one write-in that was not in the set.

use crate::attributes::VOCAB;
use crate::js::{Js, Obj, is_integer, js_string, quote, show_value, trim};
use crate::resolve::{Index, Named};

/// How many options a response may name when the survey does not say.
const DEFAULT_MIN_CHOICES: f64 = 1.0;
/// Capped again at one fewer than the set, so a default never permits choosing everything.
const DEFAULT_MAX_CHOICES: f64 = 5.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Option_ {
    pub id: String,
    pub text: String,
}

impl Named for Option_ {
    fn id(&self) -> &str {
        &self.id
    }
    fn text(&self) -> &str {
        &self.text
    }
}

/// The ranked-choice half of a compiled survey.
pub struct Ranked {
    pub title: Js,
    pub instructions: Js,
    pub options: Vec<Option_>,
    pub min_choices: f64,
    pub max_choices: f64,
}

impl Ranked {
    /// The fields in the order the TypeScript writes them.
    pub fn fields(&self, out: &mut Obj) {
        out.insert("style".into(), Js::Str("ranked-choice".into()));
        if !self.title.is_undefined() {
            out.insert("title".into(), self.title.clone());
        }
        out.insert("instructions".into(), self.instructions.clone());
        let options = self
            .options
            .iter()
            .map(|o| {
                Js::Obj(Obj::from([
                    ("id".to_owned(), Js::Str(o.id.clone())),
                    ("text".to_owned(), Js::Str(o.text.clone())),
                ]))
            })
            .collect();
        out.insert("options".into(), Js::List(options));
        out.insert("minChoices".into(), Js::Num(self.min_choices));
        out.insert("maxChoices".into(), Js::Num(self.max_choices));
    }
}

/// Checks what a ranked-choice file holds. A program can neither cause nor fix any of these, so
/// they name the file.
fn assert_loaded<'a>(instance: &str, list: &'a Js) -> Result<&'a [Js], String> {
    let entries = match list {
        Js::List(entries) if !entries.is_empty() => entries,
        _ => {
            return Err(format!(
                "survey: {instance} holds no options. A ranked-choice survey's data has an `options` list alongside its title and instructions."
            ));
        }
    };
    for (i, entry) in entries.iter().enumerate() {
        let place = format!("survey: {instance}, option {}", i + 1);
        if let Js::Str(text) = entry {
            if trim(text).is_empty() {
                return Err(format!("{place} is empty. Every option is a line of text."));
            }
            continue;
        }
        if !entry.is_record() {
            return Err(format!(
                "{place} is {}. Every option is a line of text, or a record naming its id — e.g. {{\"id\": \"a3\", \"text\": \"affordable housing\"}}.",
                show_value(entry)
            ));
        }
        if !crate::js::is_text(entry.get("text")) {
            return Err(format!("{place} has no `text`, the line to show."));
        }
        let id = entry.get("id");
        if !id.is_undefined() && !crate::js::is_text(id) {
            return Err(format!("{place} has an `id` that is {}; ids are strings.", show_value(id)));
        }
    }
    Ok(entries)
}

/// Gives every option an id: its own when it names one, otherwise its position, `o0` upward.
fn normalise_options(raw: &[Js]) -> Vec<Option_> {
    raw.iter()
        .enumerate()
        .map(|(i, entry)| match entry {
            Js::Str(text) => Option_ { id: format!("o{i}"), text: trim(text).to_owned() },
            _ => Option_ {
                id: entry.get("id").as_str().map_or_else(|| format!("o{i}"), str::to_owned),
                text: trim(&js_string(entry.get("text"))).to_owned(),
            },
        })
        .collect()
}

/// Refuses a set that cannot support a meaningful choice, or that cannot be chosen from
/// unambiguously.
fn assert_options(instance: &str, options: &[Option_]) -> Result<(), String> {
    if options.len() < 2 {
        return Err(format!(
            "survey: {instance} has {}, so there is nothing to choose between. A survey needs at least two.",
            if options.len() == 1 { "only one option" } else { "no options" }
        ));
    }
    for (i, option) in options.iter().enumerate() {
        if let Some(seen) = options[..i].iter().position(|o| o.text == option.text) {
            return Err(format!(
                "survey: {instance} has options {} and {} both {}. Each option must be distinct — a duplicate splits the choice between two entries that mean the same thing.",
                seen + 1,
                i + 1,
                quote(&option.text)
            ));
        }
        if let Some(seen) = options[..i].iter().position(|o| o.id == option.id) {
            return Err(format!(
                "survey: {instance} has options {} and {} sharing the id {}, so a choice naming it is ambiguous. Give each option its own id, or drop the ids and let them be numbered by position.",
                seen + 1,
                i + 1,
                quote(&option.id)
            ));
        }
    }
    Ok(())
}

/// The bounds a response must satisfy. The default ceiling is five, or one fewer than the set,
/// so a default never asks for every option; a stated ceiling may take the whole set.
fn resolve_bounds(instance: &str, data: &Js, options: &[Option_]) -> Result<(f64, f64), String> {
    let min = match data.get("minChoices") {
        Js::Undefined => Js::Num(DEFAULT_MIN_CHOICES),
        given => given.clone(),
    };
    let max = match data.get("maxChoices") {
        Js::Undefined => Js::Num(DEFAULT_MAX_CHOICES.min(options.len() as f64 - 1.0)),
        given => given.clone(),
    };
    let min_choices = match min {
        Js::Num(n) if is_integer(n) && n >= 0.0 => n,
        _ => {
            return Err(format!(
                "survey: {instance} has a `minChoices` of {}; it must be a whole number of 0 or more.",
                js_string(&min)
            ));
        }
    };
    let max_choices = match max {
        Js::Num(n) if is_integer(n) && n >= 1.0 => n,
        _ => {
            return Err(format!(
                "survey: {instance} has a `maxChoices` of {}; it must be a whole number of at least 1.",
                js_string(&max)
            ));
        }
    };
    if min_choices > max_choices {
        return Err(format!(
            "survey: {instance} asks for at least {} and at most {}, so no selection can satisfy both.",
            crate::js::num(min_choices),
            crate::js::num(max_choices)
        ));
    }
    if max_choices > options.len() as f64 {
        return Err(format!(
            "survey: {instance} allows {} choices but holds {} options, so there are never enough options to pick that many.",
            crate::js::num(max_choices),
            options.len()
        ));
    }
    Ok((min_choices, max_choices))
}

/// Assembles a ranked-choice survey from its data. A bare list is the shorthand for a set with
/// nothing else to say.
pub fn assemble(instance: &str, raw: &Js) -> Result<Ranked, String> {
    let data = match raw {
        Js::List(_) => Js::Obj(Obj::from([("options".to_owned(), raw.clone())])),
        _ => raw.clone(),
    };
    let options = normalise_options(assert_loaded(instance, data.get("options"))?);
    assert_options(instance, &options)?;
    let (min_choices, max_choices) = resolve_bounds(instance, &data, &options)?;
    let instructions = match data.get("instructions") {
        Js::Undefined => Js::Str(VOCAB.default_instructions.clone()),
        given => given.clone(),
    };
    Ok(Ranked { title: data.get("title").clone(), instructions, options, min_choices, max_choices })
}

/// Checks a ranked-choice response against the set it answers, and resolves it to ids.
///
/// `choices` and `write-in` are as written: checked by `response` when they came through it,
/// raw when the program wrote the response as a record literal, where a value of the wrong kind
/// fails as the TypeScript fails, with JavaScript's own `TypeError`.
pub fn resolve_response(choices: &Js, write_in: &Js, survey: &Ranked) -> Result<Js, String> {
    let choices: &[Js] = match choices {
        Js::Undefined | Js::Null => &[],
        Js::List(choices) => choices,
        _ => return Err("authored.choices.forEach is not a function".to_owned()),
    };
    let index = Index::new(&survey.options);
    let mut chosen: Vec<String> = Vec::new();
    for (i, reference) in choices.iter().enumerate() {
        let id = &index.resolve(reference, &format!("response: `choices` entry {}", i + 1), "option")?.id;
        if chosen.contains(id) {
            return Err(format!(
                "response: `choices` names {} twice. An option holds one place in the order, so each id may appear once.",
                quote(id)
            ));
        }
        chosen.push(id.clone());
    }

    let n = chosen.len();
    if (n as f64) < survey.min_choices {
        return Err(format!(
            "response: `choices` has {n} {}, but this survey's `minChoices` is {}. Choose more options.",
            if n == 1 { "option" } else { "options" },
            crate::js::num(survey.min_choices)
        ));
    }
    if n as f64 > survey.max_choices {
        return Err(format!(
            "response: `choices` has {n} options, but this survey's `maxChoices` is {}. Choose fewer options — keep the most important ones.",
            crate::js::num(survey.max_choices)
        ));
    }

    if !write_in.is_undefined() {
        let write_in = match write_in {
            Js::Str(write_in) => write_in,
            Js::Null => return Err("Cannot read properties of null (reading 'toLowerCase')".to_owned()),
            _ => return Err("writeIn.toLowerCase is not a function".to_owned()),
        };
        let lower = write_in.to_lowercase();
        if let Some(clash) = survey.options.iter().find(|o| o.text.to_lowercase() == lower) {
            return Err(format!(
                "response: `write-in` repeats {}, which is already in the set as {}. `write-in` is for one that is NOT there — choose the existing one instead.",
                quote(&clash.text),
                quote(&clash.id)
            ));
        }
    }

    let mut out = Obj::from([("choices".to_owned(), Js::List(chosen.into_iter().map(Js::Str).collect()))]);
    if !write_in.is_undefined() {
        out.insert("writeIn".into(), write_in.clone());
    }
    Ok(Js::Obj(out))
}
