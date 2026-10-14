// SPDX-License-Identifier: MIT

//! L0179 — interactive spreadsheets, in the attribute-list style. A program is a `sheets` list
//! of `sheet`s, each an attribute list of `cells`, `columns` and `rows`, with the program-level
//! words (`title`, `params`, …) chained after the list:
//!
//! ```text
//! sheets [
//!   sheet "s1" [
//!     cells [ cell A1 [text "10"] cell A2 [text "" assess [method "value" expected "=A1*2"]] ] {}
//!   ]
//! ] title "Doubling" params {"A1": "1..5"} {"v": "0.0.1"}..
//! ```
//!
//! The output is L0166's contract — `{title, instructions, templateVariablesRecords, validation,
//! interaction: {type: "table", rows, columns, cells}, errors}`, with `interaction.sheets` and
//! `validation.sheets` only when there is more than one sheet or a named one — byte for byte
//! what the TypeScript compiler writes. Its shape follows from JavaScript semantics as much as
//! from intent, so the words work on [`js::Js`], a model of the plain JavaScript values the
//! TypeScript handlers see.
//!
//! Attribute words are driven by the table in `attributes.json` (generated from
//! `packages/core/src/attributes.ts`): arity 1, or arity 2 when chaining. The containers
//! (`sheets`/`sheet`, `cells`/`cell`, `columns`/`column`, `rows`/`row`), `params` and `PROG` are
//! written by hand, as in the TypeScript.

pub mod attributes;
pub mod js;
pub mod params;
pub mod validation;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Diagnostic, Dialect, Evaluator, Lexicon, NodeId, Op, Record, Value};

use crate::attributes::{VOCABULARY, assert_known, check_value, coerce, merge, tag_value};
use crate::js::{Arr, Js, Obj, TypeError, js_string, number_string, spread, spread_into, to_number};
use crate::params::{MAX_LIMIT, generate_data_from_args};
use crate::validation::{resolve_inherited_points, validation};

/// The words L0179 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0179")).expect("L0179 redefines no base word")
});

/// L0179's vocabulary: the base lexicon with the spreadsheet words laid over it, and the
/// regex-keyed `TAG` entries that make `A1` and `A` barewords.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0179;

#[async_trait]
impl Dialect for L0179 {
    fn lang_id(&self) -> &str {
        "0179"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        let result = match tag {
            "PROG" => {
                let program = Js::from_value(&cx.eval_kernel(id).await);
                let upstream = Js::from_value(cx.data());
                prog(cx, program, upstream)
            }
            "SHEETS" => {
                let (v0, v1) = (arg(cx, id, elts, 0).await, arg(cx, id, elts, 1).await);
                sheets(v0, v1)
            }
            "SHEET" => {
                let (v0, v1) = (arg(cx, id, elts, 0).await, arg(cx, id, elts, 1).await);
                sheet(v0, v1)
            }
            "CELL" | "COLUMN" | "ROW" => {
                let (v0, v1) = (arg(cx, id, elts, 0).await, arg(cx, id, elts, 1).await);
                keyed(tag, v0, v1)
            }
            "CELLS" | "COLUMNS" | "ROWS" => {
                let (v0, v1) = (arg(cx, id, elts, 0).await, arg(cx, id, elts, 1).await);
                Ok(member(&tag.to_lowercase(), v0, v1))
            }
            "PARAMS" => {
                let before = cx.error_count();
                let v0 = arg(cx, id, elts, 0).await;
                if cx.error_count() > before {
                    // The TypeScript stops at its argument's errors; they are already reported.
                    Ok(Js::Obj(Obj::new()))
                } else {
                    let upstream = Js::from_value(cx.data());
                    params(v0, &upstream)
                }
            }
            _ => {
                let meta = VOCABULARY.attributes.get(tag)?;
                let raw = arg(cx, id, elts, 0).await;
                match attribute(tag, meta, raw) {
                    Ok((field, value)) if meta.chaining => {
                        // Arity 2: the rest of the chain is merged in, after this word.
                        let rest = arg(cx, id, elts, 1).await;
                        let mut out = Obj::new();
                        out.set(field, value);
                        spread_into(&mut out, &rest.or(Js::Obj(Obj::new())));
                        Ok(Js::Obj(out))
                    }
                    Ok((field, value)) => Ok(Js::Obj([(field, value)].into_iter().collect())),
                    Err(message) => Err(message),
                }
            }
        };
        Some(match result {
            Ok(value) => value.to_value(),
            Err(message) => {
                cx.report_diagnostic(Diagnostic::new(message));
                Value::Record(Record::new())
            }
        })
    }
}

async fn arg(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], index: usize) -> Js {
    Js::from_value(&cx.eval_arg(id, elts, index).await)
}

impl From<TypeError> for String {
    fn from(error: TypeError) -> Self {
        error.0
    }
}

fn empty() -> Js {
    Js::Obj(Obj::new())
}

/// An attribute word: its value read, checked and coerced, under the field it emits.
fn attribute(tag: &str, meta: &attributes::Meta, raw: Js) -> Result<(String, Js), String> {
    if let Some(error) = check_value(tag, meta, &raw) {
        return Err(error);
    }
    let value = if meta.is_object() {
        let attrs = Js::Obj(merge(&raw, &meta.field)?);
        assert_known(tag, &attrs)?;
        attrs
    } else {
        coerce(meta, raw)
    };
    Ok((meta.field.clone(), value))
}

/// `sheets [ sheet … ] {config}`: the sheets, with the program-level words merged over the
/// first. The `sheets` array goes out only when it carries something the flat fields cannot.
fn sheets(v0: Js, v1: Js) -> Result<Js, String> {
    let listed = match v0 {
        Js::Arr(arr) => arr.items,
        one => vec![one],
    };
    let listed: Vec<Js> = listed.into_iter().filter(|s| !s.is_nullish()).collect();
    if listed.is_empty() {
        return Err("sheets: expected at least one `sheet`.".to_owned());
    }
    let config = v1.or(empty());
    assert_known("SHEETS", &config)?;
    let resolved: Vec<Js> = listed
        .iter()
        .enumerate()
        .map(|(i, sheet)| {
            let id = sheet.at("id").or(Js::Str(format!("s{}", i + 1)));
            let mut out = spread(sheet);
            out.set("id", id.clone());
            out.set("name", sheet.at("name").or(id));
            Js::Obj(out)
        })
        .collect();
    let ids: Vec<Js> = resolved.iter().map(|sheet| sheet.at("id")).collect();
    for (i, id) in ids.iter().enumerate() {
        if ids[..i].iter().any(|seen| same_value_zero(seen, id)) {
            return Err(format!(
                "sheets: two sheets share the id \"{}\". Ids key each sheet's answers and grading, so a duplicate silently overwrites one sheet with the other. Give each sheet a distinct id.",
                js_string(id)
            ));
        }
    }
    let needs_envelope = resolved.len() > 1 || listed.iter().any(|sheet| sheet.at("name").truthy());
    let mut out = spread(&config);
    spread_into(&mut out, &resolved[0]);
    if needs_envelope {
        out.set("sheets", Js::Arr(Arr::new(resolved)));
    }
    out.set("sheetIds", Js::Arr(Arr::new(ids)));
    Ok(Js::Obj(out))
}

/// JavaScript's SameValueZero, for what a `Set` holds: objects are equal only to themselves,
/// and no two values here are the same object.
fn same_value_zero(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Num(x), Js::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
        (Js::Dec(_) | Js::Arr(_) | Js::Obj(_), _) => false,
        _ => a == b,
    }
}

/// `sheet "id" [attributes]`.
fn sheet(v0: Js, v1: Js) -> Result<Js, String> {
    let mut attrs = merge(&v1, "sheet")?;
    assert_known("SHEET", &Js::Obj(attrs.clone()))?;
    let cells = attrs.get("cells").cloned().unwrap_or_default();
    if !cells.truthy() || cells.keys()?.is_empty() {
        return Err("sheet: no cells. A sheet needs a `cells` block holding at least one cell, e.g. cells [ cell A1 [text \"Total\"] ] {} — styling a row or column has no effect on its own.".to_owned());
    }
    if let Some(id) = tag_value(&v0) {
        attrs.set("id", Js::Str(id));
    }
    Ok(Js::Obj(attrs))
}

/// `cell A1 [...]`, `column A [...]`, `row "1..5" [...]`: `{key: attributes}`.
fn keyed(tag: &str, v0: Js, v1: Js) -> Result<Js, String> {
    let container = tag.to_lowercase();
    let key = match (tag, &v0) {
        ("ROW", Js::Str(s)) if !s.is_empty() => Some(s.clone()),
        ("ROW", Js::Num(n)) => Some(number_string(*n)),
        _ => tag_value(&v0),
    };
    let Some(key) = key else {
        return Err(format!("{container}: expected a name, e.g. {container} A1 [text \"x\"]."));
    };
    let attrs = Js::Obj(merge(&v1, &format!("{container} {key}"))?);
    assert_known(tag, &attrs)?;
    Ok(Js::Obj([(key, attrs)].into_iter().collect()))
}

/// `cells [...] {config}`: the entries merged under `field`, after the configuration.
fn member(field: &str, v0: Js, v1: Js) -> Js {
    let entries = match v0 {
        Js::Arr(arr) => arr.items,
        one => vec![one],
    };
    let mut merged = Obj::new();
    for entry in &entries {
        spread_into(&mut merged, entry);
    }
    let mut out = spread(&v1);
    out.set(field, Js::Obj(merged));
    Js::Obj(out)
}

/// `params {...}`: the parameter rows, expanded. The upstream data's `params` (the form's)
/// win over the program's defaults, and its `limit` caps the rows. The continuation is never
/// read, which is why `params` goes last.
fn params(v0: Js, upstream: &Js) -> Result<Js, String> {
    let from_data = upstream.at("params");
    let given = if upstream.truthy() && from_data.truthy() { from_data } else { v0 };
    let mut values: Vec<Vec<String>> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    if given.truthy() {
        let (head, rows) = match &given {
            Js::Arr(arr) => {
                (arr.items.first().cloned().unwrap_or_default(), arr.items.iter().skip(1).cloned().collect())
            }
            other => {
                let entries = other.own_entries();
                let head = Js::Arr(Arr::new(entries.iter().map(|(k, _)| Js::Str(k.clone())).collect()));
                (head, vec![Js::Arr(Arr::new(entries.into_iter().map(|(_, v)| v).collect()))])
            }
        };
        let Js::Arr(head) = head else {
            return Err(format!("TypeError: keys.forEach is not a function ({})", js_string(&head)));
        };
        for key in &head.items {
            let Js::Str(key) = key else {
                return Err(format!("TypeError: k.trim is not a function ({})", js_string(key)));
            };
            keys.push(js::trim(key).to_owned());
        }
        values.push(keys.clone());
        for row in rows {
            let args = match row {
                row if !row.truthy() => Vec::new(),
                Js::Arr(arr) => arr.items,
                other => return Err(format!("TypeError: args.forEach is not a function ({})", js_string(&other))),
            };
            let mut strings = Vec::with_capacity(args.len());
            for arg in args {
                let Js::Str(arg) = arg else {
                    return Err(format!("TypeError: s.split is not a function ({})", js_string(&arg)));
                };
                strings.push(arg);
            }
            values.extend(generate_data_from_args(&strings).map_err(|e| e.0)?);
        }
    }
    let len = values.len() as f64;
    let from_data = upstream.at("limit");
    let mut limit = if upstream.truthy() && from_data.truthy() { from_data } else { Js::Num(MAX_LIMIT as f64) };
    // `(limit < values.length && limit) || values.length`: a `NaN` comparison is false.
    if to_number(&limit).partial_cmp(&len) != Some(std::cmp::Ordering::Less) {
        limit = Js::Num(len);
    }
    if !(to_number(&limit) < MAX_LIMIT as f64 && limit.truthy()) {
        limit = Js::Num(MAX_LIMIT as f64);
    }
    if len > to_number(&limit) {
        // `values.slice(0, limit + 1)`, with JavaScript's `+`: a string limit concatenates.
        let end = match &limit {
            Js::Num(n) => n + 1.0,
            Js::Bool(_) | Js::Undefined | Js::Null => to_number(&limit) + 1.0,
            other => js::string_to_number(&format!("{}1", js_string(other))),
        };
        let end = if end.is_nan() {
            0.0
        } else if end < 0.0 {
            (len + end.trunc()).max(0.0)
        } else {
            end.trunc().min(len)
        };
        values.truncate(end as usize);
    }
    let records: Vec<Js> = values
        .iter()
        .skip(1)
        .map(|row| {
            let mut env = Obj::new();
            for (i, key) in values[0].iter().enumerate() {
                if let Some(value) = row.get(i) {
                    env.set(key.clone(), Js::Str(value.clone()));
                }
            }
            Js::Obj(env)
        })
        .collect();
    Ok(Js::Obj([("templateVariablesRecords".to_owned(), Js::Arr(Arr::new(records)))].into_iter().collect()))
}

/// PROG: the output contract, per sheet where the passes look things up globally, with the
/// upstream data (less its `errors`) laid over it.
fn prog(cx: &mut Evaluator<'_>, program: Js, upstream: Js) -> Result<Js, String> {
    let mut data = spread(&upstream.or(empty()));
    data.remove("errors");
    let val0 = program.or(empty());
    let sheet_list = match val0.at("sheets") {
        Js::Arr(arr) => arr.items,
        _ => vec![val0.clone()],
    };
    let resolved_sheets =
        sheet_list.iter().map(|s| resolve_inherited_points(&s.clone().or(empty()))).collect::<Result<Vec<_>, _>>()?;
    let per_sheet = resolved_sheets.iter().map(validation).collect::<Result<Vec<_>, _>>()?;

    let val0 = resolve_inherited_points(&val0)?;
    let field = |name: &str| val0.at(name);
    let records = field("templateVariablesRecords");
    let sheet_ids = field("sheetIds");
    let multi = matches!(val0.at("sheets"), Js::Arr(ref arr) if arr.items.len() > 1);

    let mut errors = Vec::new();
    if multi && field("hideSheetMenu") == Js::Bool(true) && field("showSheetTabs") == Js::Bool(false) {
        errors.push("sheets: `hide-sheet-menu true` with `show-sheet-tabs false` leaves no way to reach sheets beyond the first — there is no tab strip and no sheet menu. Drop one of the two.".to_owned());
    }
    let listed = match records.clone().or(Js::Arr(Arr::default())) {
        Js::Arr(arr) => arr.items,
        Js::Str(s) => s.encode_utf16().map(|unit| Js::Str(js::from_utf16(&[unit]))).collect(),
        other => return Err(format!("TypeError: {} is not iterable", js_string(&other))),
    };
    for record in listed {
        for key in record.or(empty()).keys()? {
            let Some(bang) = key.find('!') else { continue };
            let (sheet_id, address) = (&key[..bang], &key[bang + 1..]);
            let known = match &sheet_ids {
                ids if !ids.truthy() => true,
                Js::Arr(ids) => ids.items.iter().any(|id| same_value_zero(id, &Js::str(sheet_id))),
                Js::Str(ids) => ids.contains(sheet_id),
                other => return Err(format!("TypeError: sheetIds.includes is not a function ({})", js_string(other))),
            };
            if !known {
                let Js::Arr(ids) = &sheet_ids else {
                    return Err("TypeError: sheetIds.join is not a function".to_owned());
                };
                errors.push(format!(
                    "params: \"{key}\" names the sheet \"{sheet_id}\", which this program does not have. Its sheets are: {}.",
                    js::join(&ids.items, ", ")
                ));
            } else if !is_address(address) {
                errors.push(format!(
                    "params: \"{key}\" is not a cell address. A qualified param name is a sheet id, \"!\", and an address, e.g. \"s2!A1\"."
                ));
            }
        }
    }

    let total: f64 = per_sheet.iter().fold(0.0, |n, v| {
        n + match v.at("points") {
            points if points.truthy() => to_number(&points),
            _ => 0.0,
        }
    });
    let mut out = Obj::new();
    out.set("title", field("title").or(Js::str("")));
    out.set("instructions", field("instructions").or(Js::str("")));
    if field("feedback") != Js::Undefined {
        out.set("feedback", field("feedback"));
    }
    out.set("templateVariablesRecords", records);
    let mut checks = spread(&validation(&val0)?);
    if multi {
        checks.set("points", Js::Num(total));
        let mut by_sheet = Obj::new();
        for (s, v) in sheet_list.iter().zip(&per_sheet) {
            by_sheet.set(js_string(&s.get("id")?), v.clone());
        }
        checks.set("sheets", Js::Obj(by_sheet));
    }
    out.set("validation", Js::Obj(checks));
    let mut interaction = Obj::new();
    interaction.set("type", Js::str("table"));
    for name in ["rows", "columns", "cells"] {
        interaction.set(name, field(name));
    }
    for name in ["hideMenu", "showSheetTabs", "hideSheetMenu", "hideHeadings"] {
        if field(name) != Js::Undefined {
            interaction.set(name, field(name));
        }
    }
    if let Js::Arr(_) = val0.at("sheets") {
        let mut listed = Vec::new();
        for (s, resolved) in sheet_list.iter().zip(&resolved_sheets) {
            let mut entry = Obj::new();
            entry.set("id", s.get("id")?);
            entry.set("name", s.get("name")?);
            for name in ["rows", "columns", "cells"] {
                entry.set(name, resolved.at(name));
            }
            if s.at("hideMenu") != Js::Undefined {
                entry.set("hideMenu", s.at("hideMenu"));
            }
            listed.push(Js::Obj(entry));
        }
        interaction.set("sheets", Js::Arr(Arr::new(listed)));
    }
    out.set("interaction", Js::Obj(interaction));
    out.set("errors", field("errors"));
    spread_into(&mut out, &Js::Obj(data));
    for error in errors {
        cx.report_diagnostic(Diagnostic::new(error));
    }
    Ok(Js::Obj(out))
}

/// `/^[A-Z]+[0-9]+$/`.
fn is_address(s: &str) -> bool {
    let letters = s.bytes().take_while(u8::is_ascii_uppercase).count();
    let digits = s[letters..].bytes().take_while(u8::is_ascii_digit).count();
    letters > 0 && digits > 0 && letters + digits == s.len()
}
