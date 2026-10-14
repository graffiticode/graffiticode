// SPDX-License-Identifier: MIT

//! How a typed answer is compared to an authored one: `packages/core/src/matching.ts`, the
//! half of it the compiler uses. The scorer that uses the other half stays TypeScript.

use std::sync::LazyLock;

use num_bigint::BigUint;
use num_integer::Integer;
use num_traits::{One, Zero};
use regex::Regex;

use crate::decimal::Decimal;
use crate::text;

/// String comparison: white space normalized, case only when the author says it matters.
pub fn normalize(s: &str, case_sensitive: bool) -> String {
    let t: String = text::trim(s).split(text::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    // `.replace(/\s+/g, " ")` after `trim` leaves no empty runs to drop, so joining the
    // non-empty words is the same string.
    if case_sensitive { t } else { text::lower(&t) }
}

/// The ways a number may be written. `numeric` is the umbrella over all of them.
pub const NUMBER_FORMATS: [&str; 3] = ["decimal", "fraction", "scientific"];

pub struct ParsedNumber {
    pub value: Decimal,
    pub format: &'static str,
}

static THOUSANDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([+-]?)([0-9]{1,3}(?:,[0-9]{3})+)(\.[0-9]*)?$").unwrap());
static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$").unwrap());
static SCIENTIFIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[eE][+-]?[0-9]+$").unwrap());

fn decimal_only(s: &str) -> Option<Decimal> {
    let t = text::trim(s);
    if t.is_empty() {
        return None;
    }
    let bare = match THOUSANDS.captures(t) {
        Some(c) => format!("{}{}{}", &c[1], c[2].replace(',', ""), c.get(3).map_or("", |m| m.as_str())),
        None => t.to_owned(),
    };
    if !DECIMAL.is_match(&bare) {
        return None;
    }
    Decimal::parse(&bare)
}

/// `/` splits a fraction at its first slash, in UTF-16 terms the same place.
fn split_slash(t: &str) -> Option<(&str, &str)> {
    t.find('/').map(|at| (&t[..at], &t[at + 1..]))
}

/// Parse a typed number: integers, decimals, a sign, simple fractions, scientific notation.
pub fn parse_number(s: &str) -> Option<ParsedNumber> {
    let t = text::trim(s);
    if t.is_empty() {
        return None;
    }
    if let Some((numerator, denominator)) = split_slash(t) {
        let numerator = decimal_only(numerator)?;
        let denominator = decimal_only(denominator)?;
        return numerator.div(&denominator).map(|value| ParsedNumber { value, format: "fraction" });
    }
    if SCIENTIFIC.is_match(t) {
        return Decimal::parse(t).map(|value| ParsedNumber { value, format: "scientific" });
    }
    decimal_only(t).map(|value| ParsedNumber { value, format: "decimal" })
}

/// Does this number have an exact decimal expansion? `true` for anything it cannot analyze.
pub fn terminates(s: &str) -> bool {
    let t = text::trim(s);
    let Some((numerator, denominator)) = split_slash(t) else { return true };
    let (Some(numerator), Some(denominator)) = (decimal_only(numerator), decimal_only(denominator)) else {
        return true;
    };
    if denominator.is_zero() {
        return true;
    }
    let scale = numerator.decimal_places().max(denominator.decimal_places());
    let n = numerator.scaled(scale).abs();
    let d = denominator.scaled(scale).abs();
    if n.precision() > 15 || d.precision() > 15 {
        return true;
    }
    let (Some(n), Some(mut d)) = (n.to_integer(), d.to_integer()) else { return true };
    d /= n.gcd(&d);
    let (two, five) = (BigUint::from(2u32), BigUint::from(5u32));
    while !d.is_zero() && (&d % &two).is_zero() {
        d /= &two;
    }
    while !d.is_zero() && (&d % &five).is_zero() {
        d /= &five;
    }
    d.is_one()
}

/// Which forms an `input-formats` list permits; `numeric`, or nothing, is all of them.
pub fn permitted_formats(formats: Option<&[String]>) -> Vec<&'static str> {
    match formats {
        Some(formats) if !formats.is_empty() && !formats.iter().any(|f| f == "numeric") => {
            NUMBER_FORMATS.iter().copied().filter(|f| formats.iter().any(|g| g == f)).collect()
        }
        _ => NUMBER_FORMATS.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_parse_as_written() {
        let value = |s: &str| parse_number(s).map(|p| (p.format, p.value.is_integer()));
        assert_eq!(value("1,000"), Some(("decimal", true)));
        assert_eq!(value("1/2"), Some(("fraction", false)));
        assert_eq!(value("4/2"), Some(("fraction", true)));
        assert_eq!(value("5e-1"), Some(("scientific", false)));
        assert_eq!(value("1,2"), None);
        assert_eq!(value("1/0"), None);
        assert_eq!(value("x"), None);
        assert!(parse_number("0.5").unwrap().value.compare(&parse_number(".5").unwrap().value).is_eq());
    }

    #[test]
    fn a_fraction_terminates_when_its_reduced_denominator_is_tens() {
        assert!(terminates("1/8"));
        assert!(!terminates("1/3"));
        assert!(!terminates("100/300"));
        assert!(terminates("4/2"));
        assert!(terminates("0.3/0.6"));
        assert!(terminates("1/0"));
        assert!(terminates("x/3"));
        assert!(terminates("0.5"));
        assert!(terminates("1/3333333333333333"));
    }

    #[test]
    fn white_space_and_case() {
        assert_eq!(normalize("  New\u{a0}  York ", false), "new york");
        assert_eq!(normalize("Paris", true), "Paris");
        assert_eq!(permitted_formats(Some(&["fraction".to_owned()])), ["fraction"]);
        assert_eq!(permitted_formats(None), NUMBER_FORMATS);
    }
}
