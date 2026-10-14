// SPDX-License-Identifier: MIT

//! How a response names something the survey holds — an option in `choices`, an item in
//! `item` — shared by both styles (`resolve.ts`): by its text (case, surrounding space and runs
//! of white space forgiven), by its id, or by its 0-based position. A number is always a
//! position and a string never is; between the two string forms an id wins.

use std::collections::HashMap;

use crate::js::{Js, normalise_text, num, quote};

/// What the TypeScript says when a reference that is neither text nor a number reaches
/// `normaliseText`. Only a response written as a record literal, which skips `response`'s
/// checks, gets here; the message is JavaScript's own `TypeError`.
pub fn not_text(value: &Js) -> String {
    match value {
        Js::Undefined => "Cannot read properties of undefined (reading 'trim')".to_owned(),
        Js::Null => "Cannot read properties of null (reading 'trim')".to_owned(),
        _ => "t.trim is not a function".to_owned(),
    }
}

/// Anything a response can name.
pub trait Named {
    fn id(&self) -> &str;
    fn text(&self) -> &str;
}

/// How a reference finds its entry. Built once per response, so text that names more than one
/// entry is known to be ambiguous rather than resolved to the first.
pub struct Index<'a, T> {
    list: &'a [T],
    by_id: HashMap<&'a str, usize>,
    /// Normalised text to the entry, or `None` when more than one entry normalises to it.
    by_text: HashMap<String, Option<usize>>,
}

impl<'a, T: Named> Index<'a, T> {
    pub fn new(list: &'a [T]) -> Self {
        let mut by_id = HashMap::new();
        let mut by_text: HashMap<String, Option<usize>> = HashMap::new();
        for (i, x) in list.iter().enumerate() {
            by_id.insert(x.id(), i);
            by_text.entry(normalise_text(x.text())).and_modify(|found| *found = None).or_insert(Some(i));
        }
        Index { list, by_id, by_text }
    }

    /// Resolves one reference. `place` prefixes every message; `noun` is what the survey holds.
    pub fn resolve(&self, reference: &Js, place: &str, noun: &str) -> Result<&'a T, String> {
        let list = self.list;
        let text = match reference {
            Js::Num(n) => {
                let n = *n;
                if n < 0.0 || n >= list.len() as f64 {
                    return Err(format!(
                        "{place} is the position {}, but this survey has {} {noun}s. Positions count from 0, so the last one is {}.",
                        num(n),
                        list.len(),
                        list.len() as i64 - 1
                    ));
                }
                return Ok(&list[n as usize]);
            }
            Js::Str(text) => text,
            other => return Err(not_text(other)),
        };
        if let Some(&i) = self.by_id.get(text.as_str()) {
            return Ok(&list[i]);
        }
        match self.by_text.get(&normalise_text(text)) {
            Some(Some(i)) => Ok(&list[*i]),
            Some(None) => Err(format!(
                "{place} is {}, which is the text of more than one {noun} in this survey, so it does not say which. Name the {noun}'s id instead.",
                quote(text)
            )),
            None => {
                let ids: Vec<&str> = list.iter().map(Named::id).collect();
                Err(format!(
                    "{place} is {}, which is not an {noun} in this survey. Name an {noun} by its exact text, by its id ({}), or by its position counting from 0.",
                    quote(text),
                    ids.join(", ")
                ))
            }
        }
    }
}
