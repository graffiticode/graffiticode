// SPDX-License-Identifier: MIT

//! The compile-time passes that build the output contract, as `packages/core/src/validation.ts`
//! transcribes them from L0166 — quirks included, because the output depends on them and the
//! deployed scorer reads it:
//!
//! - `rowInRegion` tests `row >= min || row <= max`, so every region contains every row that
//!   has a number; the first region in key order wins, and `Object.keys` puts integer-like
//!   regions (`"2"`) before the rest (`"*"`, `"1..5"`).
//! - Row numbers are read with `Number()`, so `A1` is row 0, `A` is row -1 and `Ax` is `NaN`;
//!   `rows[rowIndex] = …` then writes an element, or (for -1, `NaN`, 0.5) a property JSON never
//!   shows. Skipped rows are holes, written as `null`.
//! - A row's `id` is `rowIndex + 1` unless the region's order is `"actual"` or that is 0/`NaN`.
//! - An assessed cell without its own `points` counts 1 toward the total.

use indexmap::IndexMap;

use crate::js::{Arr, Js, Obj, TypeError, array_index, number_string, slice, spread, spread_into, to_number};

/// The longest rows array written. The TypeScript writes any index below 2³²-1 and then fails
/// to serialize the result; here a row past this is an error.
const MAX_ROWS: u32 = 1 << 24;

/// `rowInRegion`.
pub fn row_in_region(region: &str, cell_name: &str) -> bool {
    let mut bounds = region.split("..");
    let min = bounds.next().map_or(Js::Undefined, Js::str);
    let max = bounds.next().map_or(Js::Undefined, Js::str);
    let row = to_number(&Js::Str(slice(cell_name, 1, None)));
    row >= to_number(&min) || row <= to_number(&max)
}

/// `getPrimaryColumn`: the region a cell's row falls in, and its index column.
pub fn primary_column(rows: &Js, cell_name: &str) -> Result<(String, Js), TypeError> {
    let region = if rows.truthy() {
        rows.keys()?.into_iter().find(|key| !key.is_empty() && (key == "*" || row_in_region(key, cell_name)))
    } else {
        None
    }
    .unwrap_or_else(|| "*".to_owned());
    let index = if rows.truthy() { rows.get(&region)?.at("assess").at("index") } else { Js::Undefined };
    Ok((region, index.or(Js::Null)))
}

/// `hasOwnPoints`.
fn has_own_points(assess: &Js) -> bool {
    let own = match assess {
        Js::Obj(obj) => obj.get("points"),
        Js::Arr(arr) => arr.props.get("points"),
        _ => None,
    };
    own.is_some_and(|points| *points != Js::Undefined)
}

/// `const { rows = {}, … } = val`: a default only for `undefined`.
fn field_or_empty(val: &Js, key: &str) -> Js {
    match val.at(key) {
        Js::Undefined => Js::Obj(Obj::new()),
        other => other,
    }
}

/// `resolveInheritedPoints`: every assessed cell without its own `points` takes its row
/// region's, else its column's.
pub fn resolve_inherited_points(val: &Js) -> Result<Js, TypeError> {
    let source = if val.truthy() { val.clone() } else { Js::Obj(Obj::new()) };
    let rows = field_or_empty(&source, "rows");
    let columns = field_or_empty(&source, "columns");
    let cells = field_or_empty(&source, "cells");
    let mut resolved = Obj::new();
    for key in cells.keys()? {
        let cell = cells.get(&key)?;
        let assess = if cell.truthy() { cell.at("assess") } else { cell.clone() };
        if !assess.truthy() || has_own_points(&assess) {
            resolved.set(key, cell);
            continue;
        }
        let (region, _) = primary_column(&rows, &key)?;
        let row_points = rows.get(&region)?.at("assess").at("points");
        let column_points = columns.get(&slice(&key, 0, Some(1)))?.at("assess").at("points");
        let inherited = match (row_points, column_points) {
            (points @ Js::Num(_), _) | (_, points @ Js::Num(_)) => points,
            _ => {
                resolved.set(key, cell);
                continue;
            }
        };
        let mut assess = spread(&assess);
        assess.set("points", inherited);
        let mut cell = spread(&cell);
        cell.set("assess", Js::Obj(assess));
        resolved.set(key, Js::Obj(cell));
    }
    let mut out = spread(val);
    out.set("cells", Js::Obj(resolved));
    Ok(Js::Obj(out))
}

struct Region {
    primary_column: Js,
    order: Js,
    rows: Arr,
}

/// `getValidation`: the answer key, by row region, and the maximum score.
pub fn validation(val: &Js) -> Result<Js, TypeError> {
    let rows = field_or_empty(val, "rows");
    let cells = field_or_empty(val, "cells");
    let mut points = 0.0;
    let mut regions: IndexMap<String, Region> = IndexMap::new();
    for key in cells.keys()? {
        let (region, primary_column) = primary_column(&rows, &key)?;
        let cell = cells.get(&key)?;
        let col = slice(&key, 0, Some(1));
        let row_index = to_number(&Js::Str(slice(&key, 1, None))) - 1.0;
        let index_key = number_string(row_index);
        if array_index(&index_key).is_some_and(|i| i >= MAX_ROWS) {
            return Err(TypeError(format!(
                "RangeError: row {} is too far down the sheet.",
                number_string(row_index + 1.0)
            )));
        }
        let order = rows.get(&region)?.at("assess").at("order").or(Js::str("expected"));
        // An existing region keeps its place (and its rows array); its other fields are the
        // latest cell's.
        let id = if order != Js::str("actual") { Js::Num(row_index + 1.0) } else { Js::Bool(false) };
        let region = regions.entry(region).or_insert_with(|| Region {
            primary_column: Js::Null,
            order: Js::Null,
            rows: Arr::default(),
        });
        let row = region.rows.get(&index_key).or(Js::Obj(Obj::new()));
        let mut entry = spread(&row);
        entry.set("id", id.or(Js::Undefined));
        entry.set(col, cell.clone());
        region.rows.set(&index_key, Js::Obj(entry));
        region.primary_column = primary_column;
        region.order = order;
        let assess = cell.at("assess");
        let cell_points = if assess.truthy() { assess.at("points") } else { Js::Num(0.0) };
        points += match cell_points {
            Js::Num(n) => n,
            _ => 1.0,
        };
    }
    let mut out = Obj::new();
    out.set("points", Js::Num(points));
    let mut regions_obj = Obj::new();
    for (name, region) in regions {
        let mut entry = Obj::new();
        entry.set("primaryColumn", region.primary_column);
        entry.set("order", region.order);
        entry.set("rows", Js::Arr(region.rows));
        regions_obj.set(name, Js::Obj(entry));
    }
    out.set("regions", Js::Obj(regions_obj));
    out.set("cells", Js::Obj(Obj::new()));
    Ok(Js::Obj(out))
}

/// `{...a, ...b}` for a validation and the multi-sheet fields laid over it.
pub fn merged(base: &Js, over: Obj) -> Obj {
    let mut out = spread(base);
    spread_into(&mut out, &Js::Obj(over));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_numbered_row_is_in_every_region() {
        // `||`, transcribed from L0166: row 7 is "in" 1..5 because 7 >= 1.
        assert!(row_in_region("1..5", "A7"));
        assert!(row_in_region("9", "A10"));
        assert!(!row_in_region("9", "A1"));
        assert!(!row_in_region("9", "Ax"));
    }
}
