// SPDX-License-Identifier: MIT

//! CSV as Papa Parse reads it.
//!
//! The TypeScript reads a CSV body with `Papa.parse(text, {header: true, dynamicTyping: true,
//! skipEmptyLines: "greedy"})` (papaparse 5.7). A record's fields and their values are exactly
//! what that call produces, so this is a port of the parts of Papa it uses: line-ending and
//! delimiter guessing, the quote-aware parser, duplicate-header renaming, and dynamic typing
//! (numbers, `true`/`false`, ISO date-times as `Date`s, empty as `null`). Indices are byte
//! offsets: every character Papa searches for is ASCII, so they find the same places.

use crate::dates;
use crate::js::{Js, Obj, is_space, parse_float, trim};

const RECORD_SEP: &str = "\u{1e}";
const UNIT_SEP: &str = "\u{1f}";
const QUOTE: &str = "\"";

/// What Papa returns: the rows and the first error, if any.
pub struct Parsed {
    pub data: Vec<Js>,
    pub errors: Vec<String>,
}

fn find(input: &str, pat: &str, from: i64) -> i64 {
    if from < 0 || from as usize > input.len() {
        return -1;
    }
    input.get(from as usize..).and_then(|rest| rest.find(pat)).map_or(-1, |i| (i + from as usize) as i64)
}

fn substring(input: &str, from: i64, to: i64) -> &str {
    let len = input.len() as i64;
    let (a, b) = (from.clamp(0, len), to.clamp(0, len));
    let (a, b) = if a > b { (b, a) } else { (a, b) };
    input.get(a as usize..b as usize).unwrap_or("")
}

fn guess_line_endings(input: &str) -> &'static str {
    // At most 1 MB (of UTF-16 units) is looked at, with quoted text removed.
    let mut units = 0;
    let end = input
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > 1024 * 1024
        })
        .map_or(input.len(), |(i, _)| i);
    let mut text = String::new();
    let mut rest = &input[..end];
    while let Some(open) = rest.find('"') {
        match rest[open + 1..].find('"') {
            Some(close) => {
                text.push_str(&rest[..open]);
                rest = &rest[open + 1 + close + 1..];
            }
            None => break,
        }
    }
    text.push_str(rest);
    let r: Vec<&str> = text.split('\r').collect();
    let n: Vec<&str> = text.split('\n').collect();
    let n_first = n.len() > 1 && n[0].len() < r[0].len();
    if r.len() == 1 || n_first {
        return "\n";
    }
    let with_n = r.iter().filter(|s| s.starts_with('\n')).count();
    if with_n as f64 >= r.len() as f64 / 2.0 { "\r\n" } else { "\r" }
}

struct ParseOut {
    data: Vec<Vec<String>>,
    errors: Vec<String>,
}

/// Papa's `Parser`: rows of strings.
fn parse_rows(input: &str, delim: &str, newline: &str, preview: usize, header: bool) -> ParseOut {
    let mut data: Vec<Vec<String>> = Vec::new();
    let mut errors = Vec::new();
    let finish_header = |data: &mut Vec<Vec<String>>| {
        if header && let Some(first) = data.first_mut() {
            rename_headers(first);
        }
    };
    if input.is_empty() {
        return ParseOut { data, errors };
    }
    if !input.contains(QUOTE) {
        let rows: Vec<&str> = input.split(newline).collect();
        for (i, row) in rows.iter().enumerate() {
            data.push(row.split(delim).map(str::to_owned).collect());
            if preview > 0 && i >= preview {
                data.truncate(preview);
                finish_header(&mut data);
                return ParseOut { data, errors };
            }
        }
        finish_header(&mut data);
        return ParseOut { data, errors };
    }

    let input_len = input.len() as i64;
    let delim_len = delim.len() as i64;
    let newline_len = newline.len() as i64;
    let mut cursor: i64 = 0;
    let mut row: Vec<String> = Vec::new();
    let mut next_delim = find(input, delim, cursor);
    let mut next_newline = find(input, newline, cursor);
    let mut quote_search;
    let unescape = |s: &str| s.replace("\"\"", "\"");
    let extra_spaces = |quote_search: i64, index: i64| -> i64 {
        if index != -1 {
            let between = substring(input, quote_search + 1, index);
            if !between.is_empty() && between.chars().all(is_space) {
                return between.len() as i64;
            }
        }
        0
    };
    let byte = |i: i64| -> Option<u8> { (i >= 0).then(|| input.as_bytes().get(i as usize).copied()).flatten() };

    loop {
        if byte(cursor) == Some(b'"') {
            quote_search = cursor;
            cursor += 1;
            loop {
                quote_search = find(input, QUOTE, quote_search + 1);
                if quote_search == -1 {
                    errors.push("Quoted field unterminated".to_owned());
                    row.push(substring(input, cursor, input_len).to_owned());
                    data.push(row);
                    finish_header(&mut data);
                    return ParseOut { data, errors };
                }
                if quote_search == input_len - 1 {
                    row.push(unescape(substring(input, cursor, quote_search)));
                    data.push(row);
                    finish_header(&mut data);
                    return ParseOut { data, errors };
                }
                if byte(quote_search + 1) == Some(b'"') {
                    quote_search += 1;
                    continue;
                }
                if next_delim != -1 && next_delim < quote_search + 1 {
                    next_delim = find(input, delim, quote_search + 1);
                }
                if next_newline != -1 && next_newline < quote_search + 1 {
                    next_newline = find(input, newline, quote_search + 1);
                }
                let check_up_to = if next_newline == -1 { next_delim } else { next_delim.min(next_newline) };
                let spaces_delim = extra_spaces(quote_search, check_up_to);
                let at = quote_search + 1 + spaces_delim;
                if substring(input, at, at + delim_len) == delim {
                    row.push(unescape(substring(input, cursor, quote_search)));
                    cursor = at + delim_len;
                    next_delim = find(input, delim, cursor);
                    next_newline = find(input, newline, cursor);
                    break;
                }
                let spaces_newline = extra_spaces(quote_search, next_newline);
                let at = quote_search + 1 + spaces_newline;
                if substring(input, at, at + newline_len) == newline {
                    row.push(unescape(substring(input, cursor, quote_search)));
                    cursor = at + newline_len;
                    data.push(std::mem::take(&mut row));
                    next_newline = find(input, newline, cursor);
                    next_delim = find(input, delim, cursor);
                    if preview > 0 && data.len() >= preview {
                        finish_header(&mut data);
                        return ParseOut { data, errors };
                    }
                    break;
                }
                errors.push("Trailing quote on quoted field is malformed".to_owned());
                quote_search += 1;
            }
            continue;
        }
        if next_delim != -1 && (next_delim < next_newline || next_newline == -1) {
            row.push(substring(input, cursor, next_delim).to_owned());
            cursor = next_delim + delim_len;
            next_delim = find(input, delim, cursor);
            continue;
        }
        if next_newline != -1 {
            row.push(substring(input, cursor, next_newline).to_owned());
            cursor = next_newline + newline_len;
            data.push(std::mem::take(&mut row));
            next_newline = find(input, newline, cursor);
            if preview > 0 && data.len() >= preview {
                finish_header(&mut data);
                return ParseOut { data, errors };
            }
            continue;
        }
        break;
    }
    row.push(substring(input, cursor, input_len).to_owned());
    data.push(row);
    finish_header(&mut data);
    ParseOut { data, errors }
}

/// Papa renames a repeated header `a` to `a_1`, `a_2`, … skipping names already used.
fn rename_headers(headers: &mut [String]) {
    let mut count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut used: std::collections::HashSet<String> = headers.iter().cloned().collect();
    for header in headers.iter_mut() {
        let base = header.strip_prefix('\u{feff}').unwrap_or(header).to_owned();
        match count.get(&base).copied() {
            None | Some(0) => {
                count.insert(base.clone(), 1);
                *header = base.clone();
            }
            Some(n) => {
                let mut suffix = n;
                let renamed = loop {
                    let candidate = format!("{base}_{suffix}");
                    suffix += 1;
                    if !used.contains(&candidate) {
                        break candidate;
                    }
                };
                used.insert(renamed.clone());
                *header = renamed;
                count.insert(base.clone(), n + 1);
            }
        }
        used.insert(base);
    }
}

fn is_empty_line(row: &[String]) -> bool {
    trim(&row.concat()).is_empty()
}

fn guess_delimiter(input: &str, newline: &str) -> Option<&'static str> {
    let mut best: Option<(&'static str, f64, f64)> = None;
    for delim in [",", "\t", "|", ";", RECORD_SEP, UNIT_SEP] {
        let preview = parse_rows(input, delim, newline, 10, false).data;
        let (mut delta, mut avg, mut empty) = (0.0, 0.0, 0usize);
        let mut prev: Option<usize> = None;
        for row in &preview {
            if is_empty_line(row) {
                empty += 1;
                continue;
            }
            let count = row.len();
            avg += count as f64;
            match prev {
                None => prev = Some(count),
                Some(p) if count > 0 => {
                    delta += (count as f64 - p as f64).abs();
                    prev = Some(count);
                }
                Some(_) => {}
            }
        }
        if !preview.is_empty() {
            avg /= (preview.len() - empty) as f64;
        }
        if avg > 1.99
            && best
                .is_none_or(|(_, best_delta, best_avg)| delta < best_delta || (delta == best_delta && avg > best_avg))
        {
            best = Some((delim, delta, avg));
        }
    }
    best.map(|(delim, ..)| delim)
}

/// Papa's FLOAT test: `^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$`, within ±2^53.
fn as_float(s: &str) -> Option<f64> {
    let t = trim(s);
    let b = t.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if int_digits == 0 && i == frac_start {
            return None;
        }
    } else if int_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    let value = parse_float(s);
    const MAX: f64 = 9_007_199_254_740_992.0;
    (value > -MAX && value < MAX).then_some(value)
}

/// Papa's `ISO_DATE`: a date-time with minutes, and a `Z` or offset.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let range = |i: usize, hi: u8| b.get(i).is_some_and(|c| (b'0'..=hi).contains(c));
    let date = b.len() >= 16
        && (0..4).all(d)
        && b[4] == b'-'
        && range(5, b'1')
        && d(6)
        && b[7] == b'-'
        && range(8, b'3')
        && d(9)
        && b[10] == b'T'
        && range(11, b'2')
        && d(12)
        && b[13] == b':'
        && range(14, b'5')
        && d(15);
    if !date {
        return false;
    }
    let zone = |i: usize| {
        (b.get(i) == Some(&b'Z') && b.len() == i + 1)
            || (matches!(b.get(i), Some(b'+' | b'-'))
                && range(i + 1, b'2')
                && d(i + 2)
                && b.get(i + 3) == Some(&b':')
                && range(i + 4, b'5')
                && d(i + 5)
                && b.len() == i + 6)
    };
    if zone(16) {
        return true;
    }
    if !(b.get(16) == Some(&b':') && range(17, b'5') && d(18)) {
        return false;
    }
    if zone(19) {
        return true;
    }
    if b.get(19) != Some(&b'.') || !d(20) {
        return false;
    }
    let mut i = 20;
    while d(i) {
        i += 1;
    }
    zone(i)
}

fn dynamic(value: String) -> Js {
    if value == "true" || value == "TRUE" {
        Js::Bool(true)
    } else if value == "false" || value == "FALSE" {
        Js::Bool(false)
    } else if let Some(n) = as_float(&value) {
        Js::Num(n)
    } else if is_iso_date(&value) {
        Js::Date(dates::parse(&value))
    } else if value.is_empty() {
        Js::Null
    } else {
        Js::Str(value)
    }
}

/// `Papa.parse(text, {header: true, dynamicTyping: true, skipEmptyLines: "greedy"})`.
pub fn parse(text: &str) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let newline = guess_line_endings(text);
    let delim = guess_delimiter(text, newline);
    let out = parse_rows(text, delim.unwrap_or(","), newline, 0, true);
    let mut errors = out.errors;
    if delim.is_none() {
        errors.push("Unable to auto-detect delimiting character; defaulted to ','".to_owned());
    }
    let mut rows: Vec<Vec<String>> = out.data.into_iter().filter(|row| !is_empty_line(row)).collect();
    let fields: Vec<String> = if rows.is_empty() { Vec::new() } else { rows.remove(0) };
    let data = rows
        .into_iter()
        .map(|row| {
            let count = row.len();
            let mut record = Obj::new();
            let mut extra = Vec::new();
            for (j, value) in row.into_iter().enumerate() {
                match fields.get(j) {
                    Some(field) if field != "__parsed_extra" => record.set(field.clone(), dynamic(value)),
                    _ => {
                        extra.push(dynamic(value));
                        record.set("__parsed_extra", Js::Arr(extra.clone()));
                    }
                }
            }
            if count > fields.len() {
                errors.push(format!("Too many fields: expected {} fields but parsed {count}", fields.len()));
            } else if count < fields.len() {
                errors.push(format!("Too few fields: expected {} fields but parsed {count}", fields.len()));
            }
            Js::Obj(record)
        })
        .collect();
    Parsed { data, errors }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::stringify;

    fn csv(text: &str) -> String {
        stringify(&Js::Arr(parse(text).data)).unwrap()
    }

    #[test]
    fn reads_papas_way() {
        assert_eq!(csv("a,b\n1,x\n\n2.5,\n"), r#"[{"a":1,"b":"x"},{"a":2.5,"b":null}]"#);
        assert_eq!(csv("a;b\r\n\"x;\"\"y\"\"\";TRUE\r\n"), r#"[{"a":"x;\"y\"","b":true}]"#);
        // Unterminated: the whole rest is one field, and the delimiter cannot be guessed.
        assert_eq!(csv("a;b\r\n\"x;\"\"y\"\";TRUE\r\n"), r#"[{"a;b":"x;\"\"y\"\";TRUE\r\n"}]"#);
        assert_eq!(csv("2020,name,2020\n1,a,2"), r#"[{"2020":1,"name":"a","2020_1":2}]"#);
        assert_eq!(csv("a,b\n1,2,3"), r#"[{"a":1,"b":2,"__parsed_extra":[3]}]"#);
        assert!(parse("name\n").errors[0].starts_with("Unable to auto-detect"));
    }

    #[test]
    fn floats_are_papas() {
        assert_eq!(as_float(" 1. "), Some(1.0));
        assert_eq!(as_float(".5e2"), Some(50.0));
        assert_eq!(as_float("+1"), None);
        assert_eq!(as_float("9007199254740993"), None);
        assert!(is_iso_date("2024-01-01T10:00Z"));
        assert!(is_iso_date("2024-01-01T10:00:00.5+01:00"));
        assert!(!is_iso_date("2024-01-01"));
    }
}
