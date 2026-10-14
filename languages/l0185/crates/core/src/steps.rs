// SPDX-License-Identifier: MIT

//! What each word does to the record to its right (`packages/core/src/steps.ts`).
//!
//! The record — the [`State`] — carries the data so far plus working annotations (source
//! options, grouping); it is never the output. Every function here is pure and returns the
//! error message the compile reports. `where` and `derive` with a function of the record, and
//! `fetch`, need the evaluator and live in `lib.rs`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use graffiticode_l0000::Number;
use graffiticode_l0000::format::format_number;
use graffiticode_l0000::number::{BinaryOp, Decimal};
use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use indexmap::IndexMap;

use crate::dates;
use crate::js::{
    Js, Obj, entries, has_own, is_num, is_record, quote, show_value, spread, stringify, tag_of, to_number, trim,
};
use crate::paths::{assert_field, get_path};
use crate::vocab::{self, AGGS, JOIN_KINDS, NO_VALUE_OPS, OPS, word_of};

pub const MAX_ROWS: usize = 50_000;

/// The record to a word's right: the data so far and what the words to its right left for it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    /// `None` is `undefined`: no source yet.
    pub data: Option<Js>,
    pub source: Option<&'static str>,
    /// Source options by tag name (`AT`), in the order they were written right to left.
    pub opts: Vec<(String, Js)>,
    pub group_by: Option<Vec<String>>,
    /// Whether the state came from a source, which gives its object form the keys `source`,
    /// `groupBy` and `data`.
    pub sourced: bool,
}

impl State {
    fn opt(&self, name: &str) -> Option<&Js> {
        self.opts.iter().find(|(n, _)| n == name).map(|(_, v)| v).filter(|v| !matches!(v, Js::Undef))
    }

    fn sourced(source: &'static str, group_by: Option<Vec<String>>, data: Js) -> Result<State, String> {
        with_data(State { data: None, source: Some(source), opts: Vec::new(), group_by, sourced: true }, data)
    }

    /// The state as the plain object the TypeScript holds, for a state used as data.
    pub fn to_js(&self) -> Js {
        let mut obj = Obj::new();
        obj.set("__l0185", Js::Bool(true));
        obj.set("opts", Js::Obj(self.opts.iter().cloned().collect()));
        if self.sourced {
            obj.set("source", self.source.map_or(Js::Undef, Js::from));
            obj.set(
                "groupBy",
                self.group_by.as_ref().map_or(Js::Undef, |g| Js::Arr(g.iter().map(|f| Js::from(f.as_str())).collect())),
            );
            obj.set("data", self.data.clone().unwrap_or(Js::Undef));
        }
        Js::Obj(obj)
    }
}

/// `isState(v)`: the object form of a state.
pub fn is_state(v: &Js) -> bool {
    matches!(v, Js::Obj(obj) if obj.get("__l0185") == Some(&Js::Bool(true)))
}

fn state_data(v: &Js) -> Js {
    match v {
        Js::Obj(obj) => obj.get("data").cloned().unwrap_or(Js::Undef),
        _ => Js::Undef,
    }
}

/* ------------------------------------------------------------------ helpers */

fn rows_of<'a>(word: &str, state: &'a State) -> Result<&'a [Js], String> {
    match &state.data {
        Some(Js::Arr(rows)) => Ok(rows),
        other => Err(format!(
            "{word}: needs a list of records, but the data to its right is {}. Use at \"…\" on the fetch to reach the list.",
            show_value(other.as_ref().unwrap_or(&Js::Undef))
        )),
    }
}

pub fn with_data(mut state: State, data: Js) -> Result<State, String> {
    if let Js::Arr(rows) = &data
        && rows.len() > MAX_ROWS
    {
        return Err(format!(
            "The data has {} records, more than the {MAX_ROWS} L0185 processes. Fetch a smaller file or a narrower query.",
            rows.len()
        ));
    }
    state.data = Some(data);
    Ok(state)
}

fn field_list(word: &str, v: &Js, allow_empty: bool) -> Result<Vec<String>, String> {
    match v {
        Js::Arr(items) if items.iter().all(|f| matches!(f, Js::Str(_))) && (allow_empty || !items.is_empty()) => {
            Ok(items.iter().filter_map(|f| f.str().map(str::to_owned)).collect())
        }
        _ => Err(format!(
            "{word}: expects a list of field names in \"quotes\", e.g. {word} [\"name\" \"email\"]. Got {}.",
            show_value(v)
        )),
    }
}

/// A number, or text that reads as one (`Number(v)`, which may be infinite).
pub fn numeric(v: &Js) -> Option<f64> {
    match v {
        Js::Num(n) if n.is_finite() => Some(*n),
        Js::Str(s) if !trim(s).is_empty() && !to_number(s).is_nan() => Some(to_number(s)),
        _ => None,
    }
}

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), CollatorOptions::default()).expect("the root collation is compiled in")
});

/// `a.localeCompare(b)`.
pub fn locale_compare(a: &str, b: &str) -> f64 {
    match COLLATOR.compare(a, b) {
        Ordering::Less => -1.0,
        Ordering::Equal => 0.0,
        Ordering::Greater => 1.0,
    }
}

/// Ordering for sort and MIN/MAX: numbers numerically, then text; null/undefined last.
fn compare(a: &Js, b: &Js) -> f64 {
    let (an, bn) = (a.is_nullish(), b.is_nullish());
    if an || bn {
        return if an && bn {
            0.0
        } else if an {
            1.0
        } else {
            -1.0
        };
    }
    match (numeric(a), numeric(b)) {
        (Some(na), Some(nb)) => na - nb,
        (Some(_), None) => -1.0,
        (None, Some(_)) => 1.0,
        (None, None) => locale_compare(&crate::js::js_string(a), &crate::js::js_string(b)),
    }
}

/// A stable merge sort that, like JavaScript's, never fails on an inconsistent comparator.
fn stable_sort<T: Clone>(items: &mut [T], less_or_equal: &mut impl FnMut(&T, &T) -> bool) {
    if items.len() < 2 {
        return;
    }
    let mid = items.len() / 2;
    stable_sort(&mut items[..mid], less_or_equal);
    stable_sort(&mut items[mid..], less_or_equal);
    let (left, right) = (items[..mid].to_vec(), items[mid..].to_vec());
    let (mut i, mut j, mut k) = (0, 0, 0);
    while i < left.len() && j < right.len() {
        if less_or_equal(&left[i], &right[j]) {
            items[k] = left[i].clone();
            i += 1;
        } else {
            items[k] = right[j].clone();
            j += 1;
        }
        k += 1;
    }
    for item in left[i..].iter().chain(&right[j..]) {
        items[k] = item.clone();
        k += 1;
    }
}

/// Sorts by a comparator returning a number, as `Array.prototype.sort` does: only a positive
/// result moves the right element first.
fn sort_by_number<T: Clone>(items: &mut [T], mut cmp: impl FnMut(&T, &T) -> f64) {
    stable_sort(items, &mut |a, b| cmp(a, b).partial_cmp(&0.0) != Some(Ordering::Greater));
}

/* ------------------------------------------------------------------ sources */

fn start_source<'a>(word: &str, state: &'a State) -> Result<&'a [(String, Js)], String> {
    if state.data.is_some() {
        return Err(format!(
            "{word}: the data already has a source to its right ({}). A program has exactly one source, rightmost, just before {{}}.",
            state.source.unwrap_or("undefined")
        ));
    }
    for (name, value) in &state.opts {
        if matches!(value, Js::Undef) {
            continue;
        }
        let meta = vocab::meta(name);
        let owner = meta.and_then(|m| m.of.as_deref()).unwrap_or("undefined");
        if owner != word {
            let example = meta.map_or("", |m| m.example.as_str());
            return Err(format!(
                "{}: is an option of {owner}, not {word}. Write it to the right of {owner}, e.g. {example}.",
                word_of(name)
            ));
        }
    }
    Ok(&state.opts)
}

/// `fetch`, up to the request: the checks that come before anything is fetched.
pub fn fetch_check(url: &Js, state: &State) -> Result<String, String> {
    start_source("fetch", state)?;
    let Js::Str(url) = url else {
        return Err(format!(
            "fetch: expects a URL in \"quotes\", e.g. fetch \"https://example.org/data.json\" {{}}. Got {}.",
            show_value(url)
        ));
    };
    if state.opt("CONNECTION_ID").is_some() {
        return Err("connection-id: authenticated sources are not available yet. Use a public https URL.".to_owned());
    }
    Ok(url.clone())
}

/// `fetch`, once the body is in.
pub fn fetch_finish(url: &str, body: &crate::FetchResult, state: &State) -> Result<State, String> {
    let format = state.opt("PARSE").and_then(Js::str);
    let mut data = crate::source::parse_body(url, body, format)?;
    if let Some(at) = state.opt("AT") {
        let at = at.str().unwrap_or_default();
        let found = get_path(&data, at);
        if matches!(found, Js::Undef) {
            let keys: Vec<String> = match &data {
                Js::Obj(obj) => obj.keys().take(20).map(|k| quote(k)).collect(),
                _ => Vec::new(),
            };
            let listed =
                if keys.is_empty() { String::new() } else { format!(" Its top-level keys are: {}.", keys.join(", ")) };
            return Err(format!("at: {} names nothing in the data from {}.{listed}", quote(at), quote(url)));
        }
        data = found;
    }
    State::sourced("fetch", state.group_by.clone(), data)
}

pub fn rows_source(rows: &Js, state: &State) -> Result<State, String> {
    start_source("rows", state)?;
    let Js::Arr(items) = rows else {
        return Err(format!(
            "rows: expects a list of records or of lists, e.g. rows [{{name: \"Pen\" price: 1.5}}] {{}}. Got {}.",
            show_value(rows)
        ));
    };
    let columns = state.opt("COLUMNS");
    let data = if items.iter().any(|r| matches!(r, Js::Arr(_))) {
        let Some(Js::Arr(columns)) = columns else {
            return Err("rows: rows written as lists need columns to name them, to the right of rows: rows [[\"Oslo\" 709]] columns [\"city\" \"population\"] {}.".to_owned());
        };
        let names: Vec<String> = columns.iter().map(crate::js::js_string).collect();
        let mut out = Vec::with_capacity(items.len());
        for (i, r) in items.iter().enumerate() {
            match r {
                Js::Arr(values) if values.len() == names.len() => {
                    out.push(Js::Obj(names.iter().cloned().zip(values.iter().cloned()).collect()));
                }
                _ => {
                    let n = if let Js::Arr(values) = r { values.len() } else { 1 };
                    return Err(format!(
                        "rows: row {} has {n} {}, but there are {} columns ({}).",
                        i + 1,
                        if n == 1 { "value" } else { "values" },
                        names.len(),
                        names.join(", ")
                    ));
                }
            }
        }
        Js::Arr(out)
    } else if columns.is_some() {
        return Err("columns: names rows written as lists; these rows are records, which carry their own field names. Remove columns.".to_owned());
    } else {
        rows.clone()
    };
    State::sourced("rows", state.group_by.clone(), data)
}

pub fn from_source(value: &Js, state: &State) -> Result<State, String> {
    start_source("from", state)?;
    let data = if is_state(value) { state_data(value) } else { value.clone() };
    if matches!(data, Js::Undef) {
        return Err(
            "from: expects data, e.g. a source bound with let: let people = fetch \"https://…\" {}.. … from people {}."
                .to_owned(),
        );
    }
    State::sourced("from", state.group_by.clone(), data)
}

pub fn option(name: &str, value: &Js, state: &State) -> Result<State, String> {
    let word = word_of(name);
    let meta = vocab::meta(name).expect("an option is in the vocabulary");
    let of = meta.of.as_deref().unwrap_or("undefined");
    if state.data.is_some() {
        return Err(format!(
            "{word}: is an option of {of}, so it goes to the right of {of}, not to its left: {}.",
            meta.example
        ));
    }
    if state.opt(name).is_some() {
        return Err(format!("{word}: is given twice."));
    }
    let v = match meta.expects.as_str() {
        "tag" => match tag_of(value) {
            Some(tag) if meta.one_of.iter().any(|t| t == tag) => Js::from(tag),
            _ => {
                return Err(format!(
                    "{word}: expects {}, written bare, e.g. {}. Got {}.",
                    meta.one_of.join(" or "),
                    meta.example,
                    show_value(value)
                ));
            }
        },
        "fields" => Js::Arr(field_list(&word, value, false)?.into_iter().map(Js::Str).collect()),
        _ => match value {
            Js::Str(_) => value.clone(),
            _ => {
                return Err(format!(
                    "{word}: expects text in \"quotes\", e.g. {}. Got {}.",
                    meta.example,
                    show_value(value)
                ));
            }
        },
    };
    let mut next = state.clone();
    match next.opts.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 = v,
        None => next.opts.push((name.to_owned(), v)),
    }
    Ok(next)
}

/* ------------------------------------------------------------------ steps */

pub fn need_data(word: &str, state: &State) -> Result<(), String> {
    if state.data.is_some() {
        return Ok(());
    }
    let example = vocab::meta(&word.to_uppercase().replace('-', "_"))
        .map_or_else(|| format!("{word} … fetch \"https://…\" {{}}"), |m| m.example.clone());
    Err(format!("{word}: there is no data to its right. The source goes last, just before {{}}: {example}."))
}

/// `where` up to its rows: the checks every form of it makes first.
pub fn where_rows(state: &State) -> Result<&[Js], String> {
    need_data("where", state)?;
    rows_of("where", state)
}

/// `where [field OP value]`.
pub fn where_condition(cond: &Js, state: &State) -> Result<State, String> {
    let rows = where_rows(state)?;
    let items = match cond {
        Js::Arr(items)
            if matches!(items.first(), Some(Js::Str(_))) && items.get(1).is_some_and(|op| tag_of(op).is_some()) =>
        {
            items
        }
        _ => {
            return Err(format!(
                "where: expects [field OP value], e.g. where [\"age\" ABOVE 30], or a function of the record, e.g. where (<row: gt (get \"age\" row) 30>). Got {}.",
                show_value(cond)
            ));
        }
    };
    let field = items[0].str().unwrap_or_default().to_owned();
    let op = tag_of(&items[1]).unwrap_or_default().to_owned();
    let value = items.get(2).cloned().unwrap_or(Js::Undef);
    if !OPS.contains(&op.as_str()) {
        return Err(format!("where: {op} is not an operator. Use one of {}.", OPS.join(", ")));
    }
    let no_value = NO_VALUE_OPS.contains(&op.as_str());
    if if no_value { items.len() != 2 } else { items.len() != 3 } {
        return Err(if no_value {
            format!("where: {op} takes no value: where [{} {op}].", quote(&field))
        } else {
            format!("where: {op} needs a value: where [{} {op} …].", quote(&field))
        });
    }
    if (op == "IN" || op == "NOT-IN") && !matches!(value, Js::Arr(_)) {
        return Err(format!("where: {op} needs a list of values, e.g. where [{} {op} [\"a\" \"b\"]].", quote(&field)));
    }
    assert_field("where", &field, rows)?;
    let eq = |a: &Js, b: &Js| match (numeric(a), numeric(b)) {
        (Some(na), Some(nb)) if is_num(a) || is_num(b) => na == nb,
        _ => crate::js::strict_eq(a, b),
    };
    let ordered = |a: &Js, test: fn(f64) -> bool| -> Result<bool, String> {
        if a.is_nullish() {
            return Ok(false);
        }
        if let (Some(na), Some(nb)) = (numeric(a), numeric(&value)) {
            return Ok(test(na - nb));
        }
        if let (Js::Str(a), Js::Str(b)) = (a, &value) {
            return Ok(test(locale_compare(a, b)));
        }
        Err(format!(
            "where: cannot compare {} in {} with {} using {op}.",
            show_value(a),
            quote(&field),
            show_value(&value)
        ))
    };
    let text = |a: &Js, f: &dyn Fn(&str, &str) -> bool| {
        !a.is_nullish() && f(&crate::js::js_string(a), &crate::js::js_string(&value))
    };
    let list = || match &value {
        Js::Arr(values) => values.as_slice(),
        _ => &[],
    };
    let mut kept = Vec::new();
    for row in rows {
        let a = get_path(row, &field);
        let keep = match op.as_str() {
            "EQUALS" => !a.is_nullish() && eq(&a, &value),
            "NOT-EQUALS" => a.is_nullish() || !eq(&a, &value),
            "ABOVE" => ordered(&a, |d| d > 0.0)?,
            "AT-LEAST" => ordered(&a, |d| d >= 0.0)?,
            "BELOW" => ordered(&a, |d| d < 0.0)?,
            "AT-MOST" => ordered(&a, |d| d <= 0.0)?,
            "IN" => !a.is_nullish() && list().iter().any(|v| eq(&a, v)),
            "NOT-IN" => a.is_nullish() || !list().iter().any(|v| eq(&a, v)),
            "CONTAINS" => text(&a, &|s, v| s.contains(v)),
            "STARTS-WITH" => text(&a, &|s, v| s.starts_with(v)),
            "ENDS-WITH" => text(&a, &|s, v| s.ends_with(v)),
            "MISSING" => a.is_nullish(),
            _ => !a.is_nullish(),
        };
        if keep {
            kept.push(row.clone());
        }
    }
    with_data(state.clone(), Js::Arr(kept))
}

pub fn pick(fields: &Js, state: &State) -> Result<State, String> {
    need_data("pick", state)?;
    let rows = rows_of("pick", state)?;
    let fs = field_list("pick", fields, false)?;
    for f in &fs {
        assert_field("pick", f, rows)?;
    }
    let out = rows
        .iter()
        .map(|r| {
            Js::Obj(
                fs.iter()
                    .map(|f| {
                        let v = get_path(r, f);
                        (f.clone(), if v.is_nullish() { Js::Null } else { v })
                    })
                    .collect(),
            )
        })
        .collect();
    with_data(state.clone(), Js::Arr(out))
}

pub fn omit(fields: &Js, state: &State) -> Result<State, String> {
    need_data("omit", state)?;
    let rows = rows_of("omit", state)?;
    let fs: Vec<String> =
        field_list("omit", fields, false)?.into_iter().collect::<indexmap::IndexSet<_>>().into_iter().collect();
    for f in &fs {
        assert_field("omit", f, rows)?;
    }
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(Js::Obj(entries(r)?.into_iter().filter(|(k, _)| !fs.contains(k)).collect()));
    }
    with_data(state.clone(), Js::Arr(out))
}

fn object_entries(map: &Js) -> Vec<(String, Js)> {
    entries(map).unwrap_or_default()
}

pub fn rename(map: &Js, state: &State) -> Result<State, String> {
    need_data("rename", state)?;
    let rows = rows_of("rename", state)?;
    let pairs = object_entries(map);
    if !is_record(map) || pairs.iter().any(|(_, v)| !matches!(v, Js::Str(_))) {
        return Err(format!(
            "rename: expects {{old: \"new\"}}, e.g. rename {{pop: \"population\"}}. Got {}.",
            show_value(map)
        ));
    }
    let renames: Vec<(String, String)> =
        pairs.into_iter().map(|(k, v)| (k, v.str().unwrap_or_default().to_owned())).collect();
    for (f, _) in &renames {
        assert_field("rename", f, rows)?;
    }
    let lookup: HashMap<&str, &str> = renames.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let clash = |k: &str, nk: &str| {
        format!(
            "rename: {} would become {}, which is already a field. Rename or omit {} first.",
            quote(k),
            quote(nk),
            quote(nk)
        )
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let mut rec = Obj::new();
        for (k, v) in entries(r)? {
            let nk = lookup.get(k.as_str()).map_or(k.as_str(), |nk| nk).to_owned();
            if rec.has(&nk) {
                return Err(clash(&k, &nk));
            }
            rec.set(nk, v);
        }
        for (k, nk) in &renames {
            if has_own(r, k) || !k.contains('.') {
                continue;
            }
            let root = k.split('.').next().unwrap_or_default();
            if nk != root && rec.has(nk) {
                return Err(clash(k, nk));
            }
            let v = get_path(r, k);
            rec.set(nk.clone(), if v.is_nullish() { Js::Null } else { v });
        }
        out.push(Js::Obj(rec));
    }
    with_data(state.clone(), Js::Arr(out))
}

pub fn fill(map: &Js, state: &State) -> Result<State, String> {
    need_data("fill", state)?;
    let rows = rows_of("fill", state)?;
    let pairs = object_entries(map);
    if !is_record(map) || pairs.is_empty() {
        return Err(format!(
            "fill: expects {{field: value}}, e.g. fill {{region: \"unknown\"}}. Got {}.",
            show_value(map)
        ));
    }
    let out = rows
        .iter()
        .map(|r| {
            let mut rec = spread(r);
            for (k, v) in &pairs {
                if rec.get(k).is_none_or(Js::is_nullish) {
                    rec.set(k.clone(), v.clone());
                }
            }
            Js::Obj(rec)
        })
        .collect();
    with_data(state.clone(), Js::Arr(out))
}

pub fn group_by(fields: &Js, state: &State) -> Result<State, String> {
    need_data("group-by", state)?;
    let rows = rows_of("group-by", state)?;
    let fs = field_list("group-by", fields, false)?;
    for f in &fs {
        assert_field("group-by", f, rows)?;
    }
    if state.group_by.is_some() {
        return Err("group-by: is given twice before a summarize. List every field in one group-by.".to_owned());
    }
    let mut next = state.clone();
    next.group_by = Some(fs);
    Ok(next)
}

/// `getPath` with a field that may not be text: a number is looked up as its own key, and
/// then fails as JavaScript does when it calls a string method on it.
fn get_path_any(row: &Js, field: &Js) -> Result<Js, String> {
    match field {
        Js::Str(f) => Ok(get_path(row, f)),
        other => {
            if !row.is_object() {
                return Ok(Js::Undef);
            }
            let key = crate::js::js_string(other);
            if has_own(row, &key) {
                return Ok(crate::js::prop(row, &key));
            }
            Err("field.includes is not a function".to_owned())
        }
    }
}

struct Agg {
    name: String,
    agg: String,
    field: Js,
}

pub fn summarize(spec: &Js, state: &State) -> Result<State, String> {
    need_data("summarize", state)?;
    let rows = rows_of("summarize", state)?;
    let pairs = object_entries(spec);
    if !is_record(spec) || pairs.is_empty() {
        return Err(format!(
            "summarize: expects {{name: AGG}} or {{name: [AGG \"field\"]}}, e.g. summarize {{orders: COUNT revenue: [SUM \"amount\"]}}. Got {}.",
            show_value(spec)
        ));
    }
    let mut aggs = Vec::new();
    for (name, v) in pairs {
        let agg = tag_of(&v).map(str::to_owned).or_else(|| match &v {
            Js::Arr(items) => items.first().and_then(tag_of).map(str::to_owned),
            _ => None,
        });
        let field = match &v {
            Js::Arr(items) => items.get(1).cloned().unwrap_or(Js::Undef),
            _ => Js::Undef,
        };
        let Some(agg) = agg.filter(|a| AGGS.contains(&a.as_str())) else {
            return Err(format!(
                "summarize: {} must be one of {}, alone or as [AGG \"field\"], e.g. {name}: [SUM \"amount\"].",
                quote(&name),
                AGGS.join(", ")
            ));
        };
        if agg != "COUNT" && !matches!(field, Js::Str(_)) {
            return Err(format!("summarize: {agg} needs a field: {name}: [{agg} \"field\"]."));
        }
        match &field {
            Js::Undef => {}
            Js::Str(f) => assert_field("summarize", f, rows)?,
            other => {
                if !rows.is_empty() {
                    let mut found = false;
                    for r in rows.iter().take(1000) {
                        if !matches!(get_path_any(r, other)?, Js::Undef) {
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        assert_field("summarize", &crate::js::js_string(other), rows)?;
                    }
                }
            }
        }
        aggs.push(Agg { name, agg, field });
    }
    let by = state.group_by.clone().unwrap_or_default();
    let mut groups: IndexMap<String, Vec<&Js>> = IndexMap::new();
    for r in rows {
        let key: Vec<Js> =
            by.iter().map(|f| get_path(r, f)).map(|v| if v.is_nullish() { Js::Null } else { v }).collect();
        groups.entry(stringify(&Js::Arr(key)).unwrap_or_default()).or_default().push(r);
    }
    if by.is_empty() && groups.is_empty() {
        groups.insert("[]".to_owned(), Vec::new());
    }
    let mut out = Vec::with_capacity(groups.len());
    for (key, members) in groups {
        let mut rec = Obj::new();
        if let Some(Js::Arr(values)) = Js::parse_json(&key) {
            for (i, v) in values.into_iter().enumerate() {
                rec.set(by.get(i).cloned().unwrap_or_else(|| "undefined".to_owned()), v);
            }
        }
        for Agg { name, agg, field } in &aggs {
            rec.set(name.clone(), aggregate(agg, field, &members)?);
        }
        out.push(Js::Obj(rec));
    }
    let mut next = with_data(state.clone(), Js::Arr(out))?;
    next.group_by = None;
    Ok(next)
}

fn aggregate(agg: &str, field: &Js, rows: &[&Js]) -> Result<Js, String> {
    let vals: Vec<Js> = if matches!(field, Js::Undef) {
        rows.iter().map(|r| (*r).clone()).collect()
    } else {
        let mut vals = Vec::new();
        for r in rows {
            let v = get_path_any(r, field)?;
            if !v.is_nullish() {
                vals.push(v);
            }
        }
        vals
    };
    if agg == "COUNT" {
        return Ok(Js::Num(vals.len() as f64));
    }
    if agg == "COUNT-DISTINCT" {
        let distinct: HashSet<Option<String>> = vals.iter().map(stringify).collect();
        return Ok(Js::Num(distinct.len() as f64));
    }
    if agg == "MIN" || agg == "MAX" {
        let sign = if agg == "MIN" { 1.0 } else { -1.0 };
        let mut it = vals.into_iter();
        let Some(first) = it.next() else { return Ok(Js::Null) };
        return Ok(it.fold(first, |a, b| if compare(&a, &b) * sign <= 0.0 { a } else { b }));
    }
    let field_name = field.str().unwrap_or_default();
    let mut nums = Vec::with_capacity(vals.len());
    for v in &vals {
        match numeric(v) {
            Some(n) => nums.push(n),
            None => {
                return Err(format!(
                    "summarize: {agg} of {} needs numbers; it found {}.",
                    quote(field_name),
                    show_value(v)
                ));
            }
        }
    }
    if nums.is_empty() {
        return Ok(Js::Null);
    }
    let decimal = |n: f64| Decimal::from(&Number::Float(n));
    if agg == "MEDIAN" {
        let mut s = nums.clone();
        sort_by_number(&mut s, |a, b| a - b);
        let m = s.len() / 2;
        return Ok(Js::Num(if s.len() % 2 == 1 {
            s[m]
        } else {
            decimal(s[m - 1]).apply(BinaryOp::Add, &decimal(s[m])).apply(BinaryOp::Div, &decimal(2.0)).to_f64()
        }));
    }
    let sum = nums.iter().fold(decimal(0.0), |acc, n| acc.apply(BinaryOp::Add, &decimal(*n)));
    Ok(Js::Num(if agg == "SUM" {
        sum.to_f64()
    } else {
        sum.apply(BinaryOp::Div, &decimal(nums.len() as f64)).to_f64()
    }))
}

pub fn sort_by(spec: &Js, state: &State) -> Result<State, String> {
    need_data("sort-by", state)?;
    let rows = rows_of("sort-by", state)?;
    let items = match spec {
        Js::Arr(items) if matches!(items.first(), Some(Js::Str(_))) => items,
        _ => {
            return Err(format!(
                "sort-by: expects fields, each optionally followed by ASC or DESC, e.g. sort-by [\"revenue\" DESC \"name\"]. Got {}.",
                show_value(spec)
            ));
        }
    };
    let mut keys: Vec<(String, f64)> = Vec::new();
    for item in items {
        match item {
            Js::Str(field) => keys.push((field.clone(), 1.0)),
            _ if matches!(tag_of(item), Some("ASC" | "DESC")) && !keys.is_empty() => {
                if let Some(last) = keys.last_mut() {
                    last.1 = if tag_of(item) == Some("DESC") { -1.0 } else { 1.0 };
                }
            }
            _ => {
                return Err(format!(
                    "sort-by: {} is not a field or ASC/DESC. Write sort-by [\"revenue\" DESC \"name\"].",
                    show_value(item)
                ));
            }
        }
    }
    for (field, _) in &keys {
        assert_field("sort-by", field, rows)?;
    }
    let mut sorted = rows.to_vec();
    sort_by_number(&mut sorted, |a, b| {
        for (field, dir) in &keys {
            let (va, vb) = (get_path(a, field), get_path(b, field));
            let (miss_a, miss_b) = (va.is_nullish(), vb.is_nullish());
            if miss_a || miss_b {
                if miss_a && miss_b {
                    continue;
                }
                return if miss_a { 1.0 } else { -1.0 };
            }
            let c = compare(&va, &vb) * dir;
            if c != 0.0 && !c.is_nan() {
                return c;
            }
        }
        0.0
    });
    with_data(state.clone(), Js::Arr(sorted))
}

fn count(word: &str, n: &Js) -> Result<usize, String> {
    match n {
        Js::Num(n) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 => Ok(*n as usize),
        _ => Err(format!("{word}: expects a whole number of records, e.g. {word} 10. Got {}.", show_value(n))),
    }
}

pub fn limit(n: &Js, state: &State) -> Result<State, String> {
    need_data("limit", state)?;
    let rows = rows_of("limit", state)?;
    let n = count("limit", n)?;
    with_data(state.clone(), Js::Arr(rows.iter().take(n).cloned().collect()))
}

pub fn skip(n: &Js, state: &State) -> Result<State, String> {
    need_data("skip", state)?;
    let rows = rows_of("skip", state)?;
    let n = count("skip", n)?;
    with_data(state.clone(), Js::Arr(rows.iter().skip(n).cloned().collect()))
}

pub fn distinct(fields: &Js, state: &State) -> Result<State, String> {
    need_data("distinct", state)?;
    let rows = rows_of("distinct", state)?;
    let fs = field_list("distinct", fields, true)?;
    for f in &fs {
        assert_field("distinct", f, rows)?;
    }
    let mut seen: HashSet<Option<String>> = HashSet::new();
    let out = rows
        .iter()
        .filter(|r| {
            let key = if fs.is_empty() {
                stringify(r)
            } else {
                stringify(&Js::Arr(
                    fs.iter().map(|f| get_path(r, f)).map(|v| if v.is_nullish() { Js::Null } else { v }).collect(),
                ))
            };
            seen.insert(key)
        })
        .cloned()
        .collect();
    with_data(state.clone(), Js::Arr(out))
}

/// `r[field]`, which throws for a `null` or `undefined` row.
fn member(r: &Js, field: &str) -> Result<Js, String> {
    if r.is_nullish() {
        return Err(crate::js::read_error(r, field));
    }
    Ok(crate::js::prop(r, field))
}

pub fn unnest(field: &Js, state: &State) -> Result<State, String> {
    need_data("unnest", state)?;
    let rows = rows_of("unnest", state)?;
    let Js::Str(field) = field else {
        return Err(format!("unnest: expects one field name, e.g. unnest \"items\". Got {}.", show_value(field)));
    };
    assert_field("unnest", field, rows)?;
    let mut out = Vec::new();
    for r in rows {
        let Js::Arr(items) = member(r, field)? else {
            out.push(r.clone());
            continue;
        };
        let mut rest = spread(r);
        rest.remove(field);
        for el in &items {
            let mut rec = rest.clone();
            if is_record(el) {
                for (k, x) in entries(el)? {
                    rec.set(format!("{field}.{k}"), x);
                }
            } else {
                rec.set(field.clone(), el.clone());
            }
            out.push(Js::Obj(rec));
        }
    }
    with_data(state.clone(), Js::Arr(out))
}

pub fn spread_step(field: &Js, state: &State) -> Result<State, String> {
    need_data("spread", state)?;
    let rows = rows_of("spread", state)?;
    let Js::Str(field) = field else {
        return Err(format!("spread: expects one field name, e.g. spread \"address\". Got {}.", show_value(field)));
    };
    assert_field("spread", field, rows)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let inner = member(r, field)?;
        if !is_record(&inner) {
            out.push(r.clone());
            continue;
        }
        let mut rec = Obj::new();
        for (k, v) in entries(r)? {
            if &k == field {
                for (ik, iv) in entries(&v)? {
                    rec.set(format!("{field}.{ik}"), iv);
                }
            } else {
                rec.set(k, v);
            }
        }
        out.push(Js::Obj(rec));
    }
    with_data(state.clone(), Js::Arr(out))
}

pub fn join(spec: &Js, state: &State) -> Result<State, String> {
    need_data("join", state)?;
    let left = rows_of("join", state)?;
    let with = crate::js::prop(spec, "with");
    if !is_record(spec) || matches!(with, Js::Undef) {
        return Err("join: expects {with: <data> on: \"field\"}, e.g. join {with: customers on: [\"customer-id\" \"id\"]}, with customers bound by let.".to_owned());
    }
    let unknown: Vec<String> = object_entries(spec)
        .into_iter()
        .map(|(k, _)| k)
        .filter(|k| !["with", "on", "kind", "prefix"].contains(&k.as_str()))
        .collect();
    if !unknown.is_empty() {
        let named: Vec<String> = unknown.iter().map(|k| quote(k)).collect();
        return Err(format!("join: {} is not part of join. It takes: with, on, kind, prefix.", named.join(", ")));
    }
    let right = if is_state(&with) { state_data(&with) } else { with };
    let Js::Arr(right) = right else {
        return Err("join: with must be a list of records, e.g. a source bound with let: let customers = fetch \"https://…\" {}..".to_owned());
    };
    let on = crate::js::prop(spec, "on");
    let (lk, rk) = match &on {
        Js::Str(s) => (Js::Str(s.clone()), Js::Str(s.clone())),
        Js::Arr(pair) if pair.len() == 2 => (pair[0].clone(), pair[1].clone()),
        _ => (Js::Undef, Js::Undef),
    };
    let (Js::Str(lk), Js::Str(rk)) = (lk, rk) else {
        return Err(
            "join: on is a field name, or [left right] when they differ, e.g. on: [\"customer-id\" \"id\"].".to_owned()
        );
    };
    let kind = match crate::js::prop(spec, "kind") {
        Js::Undef => Some("LEFT".to_owned()),
        k => tag_of(&k).map(str::to_owned),
    };
    if !kind.as_deref().is_some_and(|k| JOIN_KINDS.contains(&k)) {
        return Err("join: kind is LEFT or INNER, written bare.".to_owned());
    }
    let prefix = match crate::js::prop(spec, "prefix") {
        Js::Undef | Js::Null => String::new(),
        Js::Str(s) => s,
        _ => return Err("join: prefix is text, e.g. prefix: \"customer-\".".to_owned()),
    };
    assert_field("join", &lk, left)?;
    assert_field("join", &rk, &right)?;
    let key_of = |r: &Js, k: &str| {
        let v = get_path(r, k);
        stringify(&if v.is_nullish() { Js::Null } else { v }).unwrap_or_default()
    };
    let mut index: HashMap<String, Vec<&Js>> = HashMap::new();
    for r in &right {
        index.entry(key_of(r, &rk)).or_default().push(r);
    }
    let mut out = Vec::new();
    for l in left {
        let matches = index.get(&key_of(l, &lk)).map(Vec::as_slice).unwrap_or_default();
        if matches.is_empty() && kind.as_deref() == Some("LEFT") {
            out.push(l.clone());
        }
        for m in matches {
            let mut rec = spread(l);
            for (k, v) in entries(m)? {
                if k == rk {
                    continue;
                }
                let nk = format!("{prefix}{k}");
                if rec.has(&nk) {
                    return Err(format!(
                        "join: both sides have a field {}. Add a prefix, e.g. prefix: \"right-\".",
                        quote(&nk)
                    ));
                }
                rec.set(nk, v);
            }
            out.push(Js::Obj(rec));
        }
    }
    with_data(state.clone(), Js::Arr(out))
}

pub fn format(map: &Js, state: &State) -> Result<State, String> {
    need_data("format", state)?;
    let rows = rows_of("format", state)?;
    let pairs = object_entries(map);
    if !is_record(map) || pairs.iter().any(|(_, v)| !matches!(v, Js::Str(_))) {
        return Err(format!(
            "format: expects {{field: \"pattern\"}}, e.g. format {{revenue: \"$#,##0.00\"}}. Got {}.",
            show_value(map)
        ));
    }
    for (f, _) in &pairs {
        assert_field("format", f, rows)?;
    }
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let mut rec = spread(r);
        for (f, pattern) in &pairs {
            let pattern = pattern.str().unwrap_or_default();
            let value = rec.get(f).cloned().unwrap_or(Js::Undef);
            if dates::is_date_pattern(pattern) {
                if let Some(t) = dates::to_date(&value) {
                    rec.set(f.clone(), Js::Str(dates::format_date(pattern, t)?));
                }
            } else if let Js::Num(n) = value
                && n.is_finite()
            {
                let text = format_number(pattern, &Number::Float(n)).map_err(|e| e.to_string())?;
                rec.set(f.clone(), Js::Str(text));
            }
        }
        out.push(Js::Obj(rec));
    }
    with_data(state.clone(), Js::Arr(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_compare_is_icus() {
        assert!(locale_compare("a", "B") < 0.0);
        assert!(locale_compare("b", "A") > 0.0);
        assert!(locale_compare("a", "A") < 0.0);
        assert!(locale_compare("Bergen", "Oslo") < 0.0);
    }

    #[test]
    fn sorting_is_stable_and_numeric_first() {
        let mut items = vec![Js::from("b"), Js::Num(10.0), Js::from("2"), Js::Null, Js::from("a")];
        sort_by_number(&mut items, compare);
        assert_eq!(stringify(&Js::Arr(items)).unwrap(), r#"["2",10,"a","b",null]"#);
    }
}
