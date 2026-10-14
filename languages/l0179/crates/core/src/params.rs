// SPDX-License-Identifier: MIT

//! Parameter expansion (`params`), as `packages/core/src/params.ts` transcribes it from L0166.
//!
//! A parameter's value is a comma-separated list of expressions, each a literal or a range
//! `start..stop:step`, and the parameters multiply out into rows. The TypeScript steps ranges
//! with `decimal.js` (20 significant digits, half up), so this does too, over `bigdecimal`, and
//! writes each value as `decimal.js` does.
//!
//! Two quirks are kept because the output depends on them: a range whose bounds do not read as
//! numbers steps character codes, and its value is `String.fromCharCode(n + i)` where `n + i`
//! adds a JavaScript number to a `Decimal` — which concatenates their text (`"a..c"` is
//! `ϊ ϋ ό`, codes 970–972); and `+start >= +stop` reads both bounds with `Number()` while the
//! range itself reads them with `parseFloat`.

use std::num::NonZeroU64;
use std::str::FromStr;

use bigdecimal::num_traits::Zero;
use bigdecimal::{BigDecimal, RoundingMode};

use crate::js::{from_char_code, number_string, parse_float, slice, string_to_number, trim};

pub const MAX_LIMIT: usize = 249;

/// The most values one range may expand to. The TypeScript has no bound (and never returns on a
/// step of zero or a range to `Infinity`); here such a range is an error.
const MAX_RANGE: usize = 1_000_000;

const PRECISION: NonZeroU64 = NonZeroU64::new(20).unwrap();

/// A `decimal.js` value.
#[derive(Clone, Debug)]
enum Dec {
    Finite(BigDecimal),
    /// An infinity; `true` is positive.
    Infinite(bool),
    NaN,
}

impl Dec {
    /// `new Decimal(n)`: the decimal a JavaScript number prints as.
    fn of(n: f64) -> Dec {
        if n.is_nan() {
            Dec::NaN
        } else if n.is_infinite() {
            Dec::Infinite(n > 0.0)
        } else {
            Dec::Finite(BigDecimal::from_str(&n.to_string()).expect("a finite f64 prints as a decimal"))
        }
    }

    fn add(&self, other: &Dec) -> Dec {
        match (self, other) {
            (Dec::Finite(a), Dec::Finite(b)) => Dec::Finite(round(a + b)),
            (Dec::Infinite(a), Dec::Infinite(b)) if a != b => Dec::NaN,
            (Dec::Infinite(a), Dec::Finite(_) | Dec::Infinite(_)) | (Dec::Finite(_), Dec::Infinite(a)) => {
                Dec::Infinite(*a)
            }
            _ => Dec::NaN,
        }
    }

    fn sub(&self, other: &Dec) -> Dec {
        let negated = match other {
            Dec::Finite(b) => Dec::Finite(-b),
            Dec::Infinite(positive) => Dec::Infinite(!positive),
            Dec::NaN => Dec::NaN,
        };
        self.add(&negated)
    }

    /// `a.cmp(b) <= 0`: false when either is `NaN`.
    fn le(&self, other: &Dec) -> bool {
        match (self, other) {
            (Dec::Finite(a), Dec::Finite(b)) => a <= b,
            (Dec::NaN, _) | (_, Dec::NaN) => false,
            (Dec::Infinite(a), Dec::Infinite(b)) => !*a || *b,
            (Dec::Infinite(positive), Dec::Finite(_)) => !positive,
            (Dec::Finite(_), Dec::Infinite(positive)) => *positive,
        }
    }

    /// `String(d)` (and, for these non-negative values, `d.valueOf()`).
    fn text(&self) -> String {
        match self {
            Dec::Finite(d) => decimal_text(d),
            Dec::Infinite(true) => "Infinity".to_owned(),
            Dec::Infinite(false) => "-Infinity".to_owned(),
            Dec::NaN => "NaN".to_owned(),
        }
    }
}

fn round(d: BigDecimal) -> BigDecimal {
    d.with_precision_round(PRECISION, RoundingMode::HalfUp)
}

/// A decimal as `decimal.js` writes it: no trailing zeros, positional for exponents from -7 to
/// 20, exponential (`1e+21`, `1.5e-7`) outside.
fn decimal_text(d: &BigDecimal) -> String {
    if d.is_zero() {
        return "0".to_owned();
    }
    let (unscaled, scale) = d.normalized().as_bigint_and_exponent();
    let negative = unscaled.sign() == bigdecimal::num_bigint::Sign::Minus;
    let sign = if negative { "-" } else { "" };
    let digits = unscaled.magnitude().to_string();
    let len = digits.len() as i64;
    let exponent = len - 1 - scale;
    if !(-7 < exponent && exponent < 21) {
        let (head, rest) = digits.split_at(1);
        let point = if rest.is_empty() { "" } else { "." };
        let exponent_sign = if exponent < 0 { '-' } else { '+' };
        return format!("{sign}{head}{point}{rest}e{exponent_sign}{}", exponent.abs());
    }
    if scale <= 0 {
        format!("{sign}{digits}{}", "0".repeat(scale.unsigned_abs() as usize))
    } else if len > scale {
        let (int, frac) = digits.split_at((len - scale) as usize);
        format!("{sign}{int}.{frac}")
    } else {
        format!("{sign}0.{}{digits}", "0".repeat((scale - len) as usize))
    }
}

/// Why a parameter could not be expanded. The TypeScript never answers in these cases.
#[derive(Debug, PartialEq)]
pub struct ExpandError(pub String);

/// `expandArgs`: each parameter's values.
fn expand_args(args: &[String]) -> Result<Vec<Vec<String>>, ExpandError> {
    let mut table = Vec::new();
    for s in args {
        let mut vals = Vec::new();
        for expr in s.split(',') {
            let mut parts = expr.split(':');
            let r = parts.next().unwrap_or_default();
            let incr = parts.next();
            let mut bounds = r.split("..");
            let start = bounds.next().unwrap_or_default();
            let mut stop = bounds.next();
            if let Some(s) = stop
                && string_to_number(start) >= string_to_number(s)
            {
                // Guard against nonsense.
                stop = None;
            }
            let Some(stop) = stop else {
                vals.push(trim(start).to_owned());
                continue;
            };
            let float = !parse_float(start).is_nan();
            let units: Vec<u16> = start.encode_utf16().collect();
            let stop_units: Vec<u16> = stop.encode_utf16().collect();
            let unit = |units: &[u16]| units.first().map_or(f64::NAN, |u| f64::from(*u));
            let (n, e) =
                if float { (parse_float(start), parse_float(stop)) } else { (unit(&units), unit(&stop_units)) };
            let incr = match incr.map(string_to_number) {
                None => 1.0,
                Some(step) if step.is_nan() => 1.0,
                Some(step) => step,
            };
            let span = Dec::of(e).sub(&Dec::of(n));
            let step = Dec::of(incr);
            let mut i = Dec::of(0.0);
            let endless = || {
                ExpandError(format!(
                    "params: the range \"{expr}\" does not end within {MAX_RANGE} values (a step of {} from {} to {}).",
                    number_string(incr),
                    number_string(n),
                    number_string(e)
                ))
            };
            // A range that would run at all with a step that never advances, or to an infinity,
            // is known to be endless before it starts.
            if i.le(&span) && (incr.is_nan() || incr <= 0.0 || matches!(span, Dec::Infinite(true))) {
                return Err(endless());
            }
            let mut count = 0;
            while i.le(&span) {
                count += 1;
                if count > MAX_RANGE {
                    return Err(endless());
                }
                if float {
                    vals.push(Dec::of(n).add(&i).text());
                } else {
                    // `n + i` is a number plus a Decimal: their text, concatenated.
                    let code = string_to_number(&format!("{}{}", number_string(n), i.text()));
                    vals.push(from_char_code(code) + &slice(start, 1, None));
                }
                i = i.add(&step);
            }
        }
        table.push(vals);
    }
    Ok(table)
}

/// `generateDataFromArgs`: one parameter row's values, multiplied out.
pub fn generate_data_from_args(args: &[String]) -> Result<Vec<Vec<String>>, ExpandError> {
    let table = expand_args(args)?;
    let mut data: Vec<Vec<String>> = Vec::new();
    let mut count = 0;
    for column in &table {
        let len = data.len();
        let mut new_data = Vec::new();
        for (j, val) in column.iter().enumerate() {
            if len == 0 {
                new_data.push(vec![val.clone()]);
                continue;
            }
            let mut k = 0;
            while k < len && (count < MAX_LIMIT + len || j < 1) {
                if val.starts_with('=') {
                    return Err(ExpandError(format!(
                        "params: \"{val}\" is a formula, which a parameter value cannot be yet."
                    )));
                }
                let mut row = data[k].clone();
                row.push(val.clone());
                new_data.push(row);
                count += 1;
                k += 1;
            }
        }
        data = new_data;
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(s: &str) -> Vec<String> {
        expand_args(&[s.to_owned()]).unwrap().remove(0)
    }

    #[test]
    fn ranges_step_in_decimal() {
        assert_eq!(expand("10..50:10"), ["10", "20", "30", "40", "50"]);
        assert_eq!(expand("1..2:0.5"), ["1", "1.5", "2"]);
        assert_eq!(expand("0.1..0.3:0.1"), ["0.1", "0.2", "0.3"]);
        assert_eq!(expand("5..1"), ["5"]);
        assert_eq!(expand(" a , b"), ["a", "b"]);
        assert_eq!(expand("1..3:x"), ["1", "2", "3"]);
    }

    #[test]
    fn a_character_range_concatenates_its_codes() {
        assert_eq!(expand("a..c"), ["\u{3ca}", "\u{3cb}", "\u{3cc}"]);
        assert_eq!(expand("ab..cd"), ["\u{3ca}b", "\u{3cb}b", "\u{3cc}b"]);
        // `+"ab" >= +"ad"` is false (both NaN), and both start with `a`: one value.
        assert_eq!(expand("ab..ad"), ["\u{3ca}b"]);
    }

    #[test]
    fn decimals_print_as_decimal_js_prints_them() {
        let text = |s: &str| decimal_text(&BigDecimal::from_str(s).unwrap());
        assert_eq!(text("1.50"), "1.5");
        assert_eq!(text("100"), "100");
        assert_eq!(text("1e21"), "1e+21");
        assert_eq!(text("0.0000001"), "1e-7");
        assert_eq!(text("0.000001"), "0.000001");
        assert_eq!(text("-2.5"), "-2.5");
    }

    #[test]
    fn a_range_that_never_ends_is_an_error() {
        assert!(expand_args(&["1..2:0".to_owned()]).is_err());
        assert!(expand_args(&["1..Infinity".to_owned()]).is_err());
    }

    #[test]
    fn parameters_multiply_out() {
        let rows = generate_data_from_args(&["1..2".to_owned(), "x,y".to_owned()]).unwrap();
        assert_eq!(rows, [["1", "x"], ["2", "x"], ["1", "y"], ["2", "y"]]);
    }
}
