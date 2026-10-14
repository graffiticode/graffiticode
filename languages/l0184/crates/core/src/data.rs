// SPDX-License-Identifier: MIT

//! Datasets, resolved at compile time (`packages/core/src/data.ts`).
//!
//! A dataset is a table: an id, unique column names, and rectangular rows. A data property
//! takes either an inline list or a string naming a column of the chart's selected dataset;
//! every column reference is resolved here, so the output carries inline data only.
//! `normalize_rows` also reads what an upstream hands over through `rows data use "0185"`: the
//! integer-keyed record L0000's `DATA` makes from an upstream list, `{}` when nothing is bound,
//! or `{rows, columns?}`.

use crate::js::{Js, js_string, keys, quote, strict_eq, trim};

#[derive(Clone, Debug)]
pub struct Dataset {
    pub id: Js,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Js>>,
}

/// Datasets in one scope, in order, keyed by id as a JavaScript `Map` keys them.
#[derive(Clone, Debug, Default)]
pub struct Scope(pub Vec<Dataset>);

impl Scope {
    fn position(&self, id: &Js) -> Option<usize> {
        self.0.iter().position(|d| same_value_zero(&d.id, id))
    }
}

/// How a JavaScript `Map` compares keys.
pub fn same_value_zero(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Num(a), Js::Num(b)) if a.is_nan() && b.is_nan() => true,
        _ => strict_eq(a, b),
    }
}

fn is_plain_record(v: &Js) -> bool {
    matches!(v, Js::Obj(_))
}

fn is_cell(v: &Js) -> bool {
    match v {
        Js::Null | Js::Str(_) | Js::Bool(_) => true,
        Js::Num(n) => n.is_finite(),
        _ => false,
    }
}

pub fn check_cell(v: &Js, place: &str) -> Result<(), String> {
    if is_cell(v) {
        Ok(())
    } else {
        Err(format!("{place}: a value must be a number, a string, true/false or null — got a list or a record."))
    }
}

/// An integer-keyed record (`{0: …, 1: …}`) back to a list. Keys must be exactly 0..n-1.
pub fn from_indexed(rec: &Js, place: &str) -> Result<Vec<Js>, String> {
    let names = keys(rec);
    let is_index = |k: &str| {
        k == "0" || (k.starts_with(|c: char| ('1'..='9').contains(&c)) && k.bytes().all(|b| b.is_ascii_digit()))
    };
    if !names.iter().all(|k| is_index(k)) {
        let shown: Vec<String> = names.iter().take(5).map(|k| quote(k)).collect();
        return Err(format!("{place}: expected a list of rows; got a record with keys {}.", shown.join(", ")));
    }
    let mut numbers: Vec<f64> = names.iter().map(|k| k.parse::<f64>().unwrap_or(f64::NAN)).collect();
    numbers.sort_by(|a, b| a.total_cmp(b));
    for (i, n) in numbers.iter().enumerate() {
        if *n != i as f64 {
            return Err(format!("{place}: rows are numbered 0 to {} with a gap at {i}.", names.len() as i64 - 1));
        }
    }
    Ok((0..numbers.len()).map(|i| rec.get(&i.to_string()).clone()).collect())
}

/// Rows in any accepted shape → columns and rectangular list rows.
pub fn normalize_rows(raw: &Js, given_columns: &Js, place: &str) -> Result<(Vec<String>, Vec<Vec<Js>>), String> {
    let mut columns = given_columns.clone();
    let from_upstream = is_plain_record(raw);
    let rows: Js = if is_plain_record(raw) && matches!(raw.get("rows"), Js::Arr(_)) {
        if columns.is_nullish() {
            columns = raw.get("columns").clone();
        }
        raw.get("rows").clone()
    } else if is_plain_record(raw) {
        Js::Arr(from_indexed(raw, place)?)
    } else {
        raw.clone()
    };
    let Js::Arr(rows) = rows else { return Err(format!("{place}: rows must be a list in [brackets].")) };
    if from_upstream && rows.is_empty() && !columns.truthy() {
        return Err(format!(
            "{place}: its rows come from an upstream program and there are none yet, so name its columns: columns [\"region\" \"revenue\"] rows data use \"0185\"."
        ));
    }
    let columns: Option<Vec<String>> =
        if columns.is_undefined() { None } else { Some(check_columns(&columns, place)?) };

    if rows.iter().all(|r| matches!(r, Js::Arr(_))) {
        let Some(columns) = columns else {
            if rows.is_empty() {
                return Ok((Vec::new(), Vec::new()));
            }
            return Err(format!(
                "{place}: rows written as lists need `columns` to name them, e.g. columns [\"month\" \"revenue\"]."
            ));
        };
        let mut out = Vec::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            let r = r.as_arr().expect("every row is a list");
            if r.len() != columns.len() {
                return Err(format!(
                    "{place}: row {} has {} value{}, but there are {} columns ({}).",
                    i + 1,
                    r.len(),
                    if r.len() == 1 { "" } else { "s" },
                    columns.len(),
                    columns.join(", ")
                ));
            }
            for (j, c) in r.iter().enumerate() {
                check_cell(c, &format!("{place} row {}, column \"{}\"", i + 1, columns[j]))?;
            }
            out.push(r.clone());
        }
        return Ok((columns, out));
    }

    if rows.iter().all(is_plain_record) {
        let mut seen: Vec<String> = Vec::new();
        for r in &rows {
            for k in keys(r) {
                if !seen.contains(&k) {
                    seen.push(k);
                }
            }
        }
        let cols = columns.unwrap_or_else(|| seen.clone());
        if !from_upstream && let Some(extra) = seen.iter().find(|k| !cols.contains(k)) {
            return Err(format!(
                "{place}: rows have the column \"{extra}\", which is not in columns ({}).",
                cols.join(", ")
            ));
        }
        let mut out = Vec::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            let mut row = Vec::with_capacity(cols.len());
            for c in &cols {
                if !r.has(c) {
                    if from_upstream {
                        let fields: Vec<String> = seen.iter().map(|k| quote(k)).collect();
                        return Err(format!(
                            "{place}: the data from the upstream program has no field \"{c}\"; its fields are {}. Name those in columns.",
                            fields.join(", ")
                        ));
                    }
                    return Err(format!(
                        "{place}: row {} has no \"{c}\". Every row needs every column; write null for a missing value.",
                        i + 1
                    ));
                }
                let cell = r.get(c);
                check_cell(cell, &format!("{place} row {}, column \"{c}\"", i + 1))?;
                row.push(cell.clone());
            }
            out.push(row);
        }
        return Ok((cols, out));
    }

    Err(format!("{place}: rows must all be lists (in column order) or all be records."))
}

fn check_columns(columns: &Js, place: &str) -> Result<Vec<String>, String> {
    let names: Option<Vec<String>> = columns.as_arr().and_then(|items| {
        items.iter().map(|c| c.as_str().filter(|s| !trim(s).is_empty()).map(str::to_owned)).collect()
    });
    let Some(names) = names else {
        return Err(format!(
            "{place}: columns must be a list of names in \"quotes\", e.g. columns [\"month\" \"revenue\"]."
        ));
    };
    if let Some(dup) = names.iter().enumerate().find(|(i, c)| names[..*i].contains(c)).map(|(_, c)| c) {
        return Err(format!("{place}: the column \"{dup}\" is named twice. Column names must differ."));
    }
    Ok(names)
}

/// A `dataset … {}` description → a Dataset, defaulting its id by position.
fn normalize_dataset(rec: &Js, index: usize, place: &str) -> Result<Dataset, String> {
    if rec.prop("rows")?.is_undefined() {
        return Err(format!(
            "{place}: needs `rows`, e.g. dataset columns [\"month\" \"revenue\"] rows [[\"Jan\" 120]] {{}}."
        ));
    }
    let (columns, rows) = normalize_rows(rec.get("rows"), rec.get("columns"), place)?;
    Ok(Dataset { id: rec.get("id").or(Js::Str(format!("d{}", index + 1))), columns, rows })
}

/// Datasets in one scope, checked for duplicate ids after defaults resolve.
pub fn scope_datasets(recs: &[Js], scope: &str) -> Result<Scope, String> {
    let mut out = Scope::default();
    for (i, rec) in recs.iter().enumerate() {
        let id = rec.prop("id")?;
        let named = if id.truthy() { crate::js::stringify(id) } else { (i + 1).to_string() };
        let ds = normalize_dataset(rec, i, &format!("{scope} dataset {named}"))?;
        if out.position(&ds.id).is_some() {
            return Err(format!(
                "{scope}: two datasets have the id \"{}\". Give each dataset in one list its own id.",
                js_string(&ds.id)
            ));
        }
        out.0.push(ds);
    }
    Ok(out)
}

/// What a chart's column names can refer to.
pub struct Selection {
    pub selected: Option<Dataset>,
    pub visible: Vec<Js>,
}

/// The dataset a chart's column names refer to. A chart-local dataset shadows a shared one
/// with the same id; left out, the choice is made only when exactly one dataset is visible.
pub fn select_dataset(shared: &Scope, local: &Scope, dataset_id: &Js, place: &str) -> Result<Selection, String> {
    let mut visible = shared.clone();
    for ds in &local.0 {
        match visible.position(&ds.id) {
            Some(at) => visible.0[at] = ds.clone(),
            None => visible.0.push(ds.clone()),
        }
    }
    let ids: Vec<Js> = visible.0.iter().map(|d| d.id.clone()).collect();
    if !dataset_id.is_undefined() {
        let Some(at) = visible.position(dataset_id) else {
            let listed = if ids.is_empty() {
                " There are no datasets.".to_owned()
            } else {
                let ids: Vec<String> = ids.iter().map(|i| format!("\"{}\"", js_string(i))).collect();
                format!(" Datasets here: {}.", ids.join(", "))
            };
            return Err(format!("{place}: dataset-id \"{}\" names no dataset.{listed}", js_string(dataset_id)));
        };
        return Ok(Selection { selected: Some(visible.0[at].clone()), visible: ids });
    }
    let selected = if ids.len() == 1 { visible.0.into_iter().next() } else { None };
    Ok(Selection { selected, visible: ids })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Flat,
    Nested,
}

pub struct Resolved {
    pub values: Vec<Js>,
    pub column: Option<Js>,
}

/// Resolves a data property: an inline list as written, or a column of the selected dataset.
/// A `Nested` property (a list of lists) can only be written inline.
pub fn resolve_data(
    value: &Js,
    prop: &str,
    selection: &Selection,
    place: &str,
    shape: Shape,
) -> Result<Resolved, String> {
    if let Js::Arr(items) = value {
        for (i, item) in items.iter().enumerate() {
            if shape == Shape::Nested {
                let Js::Arr(row) = item else {
                    return Err(format!(
                        "{place}: {prop} item {} must be a list in [brackets] — this form is a list of lists.",
                        i + 1
                    ));
                };
                for (j, v) in row.iter().enumerate() {
                    check_cell(v, &format!("{place}: {prop} item {}, value {}", i + 1, j + 1))?;
                }
            } else {
                check_cell(item, &format!("{place}: {prop} item {}", i + 1))?;
            }
        }
        return Ok(Resolved { values: items.clone(), column: None });
    }
    let written = js_string(value);
    if shape == Shape::Nested {
        return Err(format!(
            "{place}: {prop} \"{written}\" names a column, but a column is a flat list and this form needs a list of lists. With a dataset, use the long form: x, y and values for a HEATMAP, or values and group for a BOXPLOT."
        ));
    }
    let Some(selected) = &selection.selected else {
        let why = if selection.visible.is_empty() {
            "there is no dataset — add one, or write the values inline as a list".to_owned()
        } else {
            let ids: Vec<String> = selection.visible.iter().map(|i| format!("\"{}\"", js_string(i))).collect();
            format!(
                "{} datasets are visible ({}), so write dataset-id \"…\" in the chart's settings to pick one",
                selection.visible.len(),
                ids.join(", ")
            )
        };
        return Err(format!("{place}: {prop} \"{written}\" names a column, but {why}."));
    };
    let Some(j) = selected.columns.iter().position(|c| value.as_str() == Some(c.as_str())) else {
        let columns: Vec<String> = selected.columns.iter().map(|c| format!("\"{c}\"")).collect();
        return Err(format!(
            "{place}: {prop} \"{written}\" is not a column of dataset \"{}\". Its columns are: {}.",
            js_string(&selected.id),
            columns.join(", ")
        ));
    };
    Ok(Resolved { values: selected.rows.iter().map(|r| r[j].clone()).collect(), column: Some(value.clone()) })
}
