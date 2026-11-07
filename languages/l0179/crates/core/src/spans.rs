// SPDX-License-Identifier: MIT

//! Merged cells: `packages/core/src/spans.ts`. Two cells whose rectangles meet are refused (a
//! covered cell would be hidden), as is a span crossing the edge of the frozen rows or columns
//! (its sticky anchor would pin all of it). The messages are the TypeScript's, word for word.

use crate::attributes::MAX_COUNT;
use crate::js::{Js, number_string, string_to_number};

struct Rect {
    key: String,
    c1: f64,
    r1: f64,
    c2: f64,
    r2: f64,
    spanned: bool,
}

fn cell_name(c: f64, r: f64) -> String {
    format!("{}{}", char::from(64 + c as u8), number_string(r))
}

fn describe(r: &Rect) -> String {
    if r.spanned { format!("{} (spanning {}:{})", r.key, r.key, cell_name(r.c2, r.r2)) } else { r.key.clone() }
}

/// A span's value: absent is 1, and a raw record can reach here unvalidated.
fn span_of(cell: &Js, word: &str, key: &str) -> Result<f64, String> {
    match cell.at(word) {
        Js::Undefined => Ok(1.0),
        Js::Num(n) if n.fract() == 0.0 && (1.0..=MAX_COUNT).contains(&n) => Ok(n),
        _ => Err(format!("cells: {key}'s {word} must be a whole number from 1 to {}.", number_string(MAX_COUNT))),
    }
}

/// A freeze count, or 0 when absent or not a count.
fn count_of(v: &Js) -> f64 {
    match v {
        Js::Num(n) if n.is_finite() && n.fract() == 0.0 && *n > 0.0 => *n,
        _ => 0.0,
    }
}

/// `/^([A-Z])([1-9][0-9]*)$/`: the column (1 for A) and the row's digits.
fn address(key: &str) -> Option<(f64, &str)> {
    let bytes = key.as_bytes();
    let (&first, rest) = bytes.split_first()?;
    if !first.is_ascii_uppercase() || rest.is_empty() || rest[0] == b'0' || !rest.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((f64::from(first - 64), &key[1..]))
}

/// The first problem with a sheet's spans, or none. `attrs` is the sheet's merged attributes.
pub fn check_spans(attrs: &Js) -> Option<String> {
    let cells = attrs.at("cells");
    if !cells.truthy() || !cells.is_object() {
        return None;
    }
    let mut rects: Vec<Rect> = Vec::new();
    for key in cells.keys().unwrap_or_default() {
        let cell = cells.at(&key);
        let Some((c1, digits)) = address(&key) else {
            if cell.truthy() {
                for word in ["colspan", "rowspan"] {
                    if cell.at(word) != Js::Undefined {
                        return Some(format!("cells: \"{key}\" has {word} but is not a cell address like A1."));
                    }
                }
            }
            continue;
        };
        let cs = match span_of(&cell, "colspan", &key) {
            Ok(n) => n,
            Err(message) => return Some(message),
        };
        let rs = match span_of(&cell, "rowspan", &key) {
            Ok(n) => n,
            Err(message) => return Some(message),
        };
        let r1 = string_to_number(digits);
        let rect = Rect { c1, r1, c2: c1 + cs - 1.0, r2: r1 + rs - 1.0, spanned: cs > 1.0 || rs > 1.0, key };
        if rect.c2 > 26.0 {
            return Some(format!(
                "cells: {} colspan {} runs past column Z, the last column.",
                rect.key,
                number_string(cs)
            ));
        }
        rects.push(rect);
    }
    for (i, a) in rects.iter().enumerate() {
        for b in &rects[i + 1..] {
            if !a.spanned && !b.spanned {
                continue;
            }
            if a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2 {
                let at = cell_name(a.c1.max(b.c1), a.r1.max(b.r1));
                return Some(format!(
                    "cells: {} and {} overlap at {at}. A cell inside another cell's span is hidden, so its content never shows. Shorten the span or remove the covered cell.",
                    describe(a),
                    describe(b)
                ));
            }
        }
    }
    let freeze_rows = count_of(&attrs.at("freezeRows"));
    let freeze_columns = count_of(&attrs.at("freezeColumns"));
    for r in rects.iter().filter(|r| r.spanned) {
        if freeze_rows > 0.0 && r.r1 <= freeze_rows && r.r2 > freeze_rows {
            return Some(format!(
                "sheet: {} crosses the edge of the frozen rows (freeze-rows {}). A merged cell must sit entirely inside or entirely outside them: widen freeze-rows to {}, or shorten the span.",
                describe(r),
                number_string(freeze_rows),
                number_string(r.r2)
            ));
        }
        if freeze_columns > 0.0 && r.c1 <= freeze_columns && r.c2 > freeze_columns {
            return Some(format!(
                "sheet: {} crosses the edge of the frozen columns (freeze-columns {}). A merged cell must sit entirely inside or entirely outside them: widen freeze-columns to {}, or shorten the span.",
                describe(r),
                number_string(freeze_columns),
                number_string(r.c2)
            ));
        }
    }
    None
}
