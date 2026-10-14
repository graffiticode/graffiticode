// SPDX-License-Identifier: MIT

//! Field access, and the did-you-mean for a field the data does not have
//! (`packages/core/src/paths.ts`).

use indexmap::IndexSet;

use crate::js::{Js, has_own, prop, quote};

/// A field by exact key first, then as a dot-path into nested records.
pub fn get_path(row: &Js, field: &str) -> Js {
    if !row.is_object() {
        return Js::Undef;
    }
    if has_own(row, field) {
        return prop(row, field);
    }
    if !field.contains('.') {
        return Js::Undef;
    }
    let mut cur = row.clone();
    for part in field.split('.') {
        if !cur.is_object() {
            return Js::Undef;
        }
        cur = prop(&cur, part);
    }
    cur
}

/// The fields of the first records, in first-seen order.
pub fn fields_of(data: &[Js]) -> Vec<String> {
    let mut seen = IndexSet::new();
    for row in data.iter().take(1000) {
        if let Js::Obj(obj) = row {
            seen.extend(obj.keys().cloned());
        }
    }
    seen.into_iter().collect()
}

/// Levenshtein distance over UTF-16 code units.
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut row = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            row[j] = (prev[j] + 1).min(row[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = row;
    }
    prev[b.len()]
}

/// JavaScript's `toLowerCase`.
fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// The closest candidate within two edits, if any.
pub fn did_you_mean<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut best = None;
    let mut best_d = 3;
    let name = lower(name);
    for c in candidates {
        let d = distance(&name, &lower(c));
        if d < best_d {
            best = Some(c);
            best_d = d;
        }
    }
    best
}

/// Dot-paths to the values nested in records (not lists), down to `depth` levels.
fn nested_paths(row: &Js, prefix: &str, depth: usize) -> Vec<String> {
    // A Date is an object with no fields of its own; anything else that is not a record has none.
    let Js::Obj(obj) = row else { return Vec::new() };
    if depth == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (k, v) in obj.iter() {
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        if matches!(v, Js::Obj(_) | Js::Date(_)) {
            out.push(path.clone());
            out.extend(nested_paths(v, &path, depth - 1));
        } else {
            out.push(path);
        }
    }
    out
}

fn last_of(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or(path)
}

/// The nested path a top-level name was probably reaching for.
fn nested_match(field: &str, data: &[Js]) -> Option<String> {
    let nested: Vec<String> = data
        .first()
        .map(|row| nested_paths(row, "", 3))
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.contains('.'))
        .collect();
    if let Some(exact) = nested.iter().find(|p| last_of(p) == last_of(field)) {
        return Some(exact.clone());
    }
    let near = did_you_mean(last_of(field), nested.iter().map(|p| last_of(p)))?.to_owned();
    nested.iter().find(|p| last_of(p) == near).cloned()
}

/// An error unless a field names something in the data. Empty data is not checked.
pub fn assert_field(word: &str, field: &str, data: &[Js]) -> Result<(), String> {
    if data.is_empty() || data.iter().take(1000).any(|r| !matches!(get_path(r, field), Js::Undef)) {
        return Ok(());
    }
    let fields = fields_of(data);
    let guess =
        did_you_mean(field, fields.iter().map(String::as_str)).map(str::to_owned).or_else(|| nested_match(field, data));
    let list: Vec<String> = fields.iter().take(20).map(|f| quote(f)).collect();
    let more = if fields.len() > 20 { ", …" } else { "" };
    let mean = guess.map(|g| format!(" Did you mean {}?", quote(&g))).unwrap_or_default();
    Err(format!("{word}: no field {} in the data. Its fields are: {}{more}.{mean}", quote(field), list.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distances_are_levenshtein() {
        assert_eq!(distance("agee", "age"), 1);
        assert_eq!(did_you_mean("Agee", ["name", "age"]), Some("age"));
        assert_eq!(did_you_mean("zzzz", ["name"]), None);
    }
}
