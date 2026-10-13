// SPDX-License-Identifier: MIT

//! Numbers and decimal arithmetic.
//!
//! Graffiticode numbers are decimal: `add 0.1 0.2` is `0.3`, not `0.30000000000000004`. A
//! number enters a computation as the decimal it is written as, and results are rounded to
//! [`PRECISION`] significant digits (half up). Infinities and `NaN` follow IEEE 754.
//!
//! A [`Number`] is an `f64` whenever an `f64` holds its value, and an exact decimal otherwise
//! (`12345678901234567890`, `1.00000000000000000001`), so arithmetic on values an `f64` would
//! round stays exact. On output every number becomes an `f64`.

use std::cmp::Ordering;
use std::num::NonZeroU64;
use std::str::FromStr;

use bigdecimal::num_bigint::BigInt;
use bigdecimal::num_traits::{Signed, ToPrimitive, Zero};
use bigdecimal::{BigDecimal, RoundingMode};

use crate::value::{Value, format_number};

const PRECISION: NonZeroU64 = NonZeroU64::new(20).unwrap();
/// A numeric string's exponent may have this many digits. Anything longer is far outside what a
/// number can hold, and would only make the arithmetic allocate.
const MAX_EXPONENT_DIGITS: usize = 4;
/// Integer powers up to this exponent are computed exactly; larger ones in floating point.
const MAX_EXACT_EXPONENT: i64 = 1024;

/// A number value. `Exact` holds only finite values that no `f64` represents, so two numbers
/// are the same value exactly when they are the same variant with equal contents.
#[derive(Clone, Debug, PartialEq)]
pub enum Number {
    Float(f64),
    Exact(BigDecimal),
}

impl Number {
    pub const NAN: Number = Number::Float(f64::NAN);

    /// The value of a number as written in source: `"1.50"`, `"2e4"`, `"12345678901234567890"`.
    /// Text that is not a number is `NaN`.
    pub fn parse(text: &str) -> Self {
        Decimal::parse(text).map_or(Self::NAN, Decimal::into_number)
    }

    /// The nearest `f64`.
    pub fn to_f64(&self) -> f64 {
        match self {
            Number::Float(n) => *n,
            Number::Exact(d) => decimal_to_f64(d),
        }
    }

    /// An `f64` holds a decimal when the decimal is what that `f64` prints as (`0.1`) or its
    /// exact binary value (1699…632, which prints as `1.7e+308`).
    fn from_decimal(d: BigDecimal) -> Self {
        let n = decimal_to_f64(&d);
        if n.is_finite() && (shortest_decimal(n) == d || exact_decimal(n) == d) {
            Number::Float(n)
        } else {
            Number::Exact(d)
        }
    }

    /// Display text: every digit of an exact value, in the notation `f64`s print in
    /// (positional between `1e-6` and `1e21`, exponential outside).
    pub fn display(&self) -> String {
        match self {
            Number::Float(n) => format_number(*n),
            Number::Exact(d) => format_decimal(d),
        }
    }
}

impl From<f64> for Number {
    fn from(n: f64) -> Self {
        Number::Float(n)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Min,
    Max,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("expected a number, got {0}")]
pub struct NotANumber(String);

/// An operand of decimal arithmetic.
#[derive(Clone, Debug)]
pub enum Decimal {
    Finite(BigDecimal),
    /// An infinity or `NaN`.
    Special(f64),
}

impl Decimal {
    /// A number is itself; a string is a number if it is written as one (`"1.5"`, `"-2e3"`).
    pub fn from_value(value: &Value) -> Result<Self, NotANumber> {
        match value {
            Value::Num(n) => Ok(Self::from(n)),
            Value::Str(s) => Self::parse(s).ok_or_else(|| NotANumber(format!("{s:?}"))),
            other => Err(NotANumber(other.kind().to_owned())),
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "NaN" => return Some(Self::Special(f64::NAN)),
            "Infinity" | "+Infinity" => return Some(Self::Special(f64::INFINITY)),
            "-Infinity" => return Some(Self::Special(f64::NEG_INFINITY)),
            _ => {}
        }
        let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
        let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (mantissa, Some(exponent)),
            None => (unsigned, None),
        };
        let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
        let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let well_formed = digits(int)
            && digits(frac)
            && !(int.is_empty() && frac.is_empty())
            && exponent.is_none_or(|e| {
                let e = e.strip_prefix(['+', '-']).unwrap_or(e);
                !e.is_empty() && e.len() <= MAX_EXPONENT_DIGITS && digits(e)
            });
        if !well_formed {
            return None;
        }
        BigDecimal::from_str(s).ok().map(Self::Finite)
    }

    /// The value as a [`Number`]: an `f64` if one holds it.
    pub fn into_number(self) -> Number {
        match self {
            Self::Finite(d) => Number::from_decimal(d),
            Self::Special(n) => Number::Float(n),
        }
    }

    pub fn to_f64(&self) -> f64 {
        match self {
            Self::Finite(d) => decimal_to_f64(d),
            Self::Special(n) => *n,
        }
    }

    pub fn is_zero(&self) -> bool {
        matches!(self, Self::Finite(d) if d.is_zero())
    }

    pub fn is_finite(&self) -> bool {
        matches!(self, Self::Finite(_))
    }

    /// `None` when either side is `NaN`.
    pub fn compare(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Finite(a), Self::Finite(b)) => Some(a.cmp(b)),
            _ => self.to_f64().partial_cmp(&other.to_f64()),
        }
    }

    /// The result of an operation, rounded to [`PRECISION`] significant digits.
    pub fn apply(&self, op: BinaryOp, other: &Self) -> Self {
        let (Self::Finite(a), Self::Finite(b)) = (self, other) else {
            return Self::from(float_op(op, self.to_f64(), other.to_f64()));
        };
        let exact = match op {
            BinaryOp::Add => a + b,
            BinaryOp::Sub => a - b,
            BinaryOp::Mul => a * b,
            BinaryOp::Div if !b.is_zero() => a / b,
            // Truncated: the result takes the sign of the dividend.
            BinaryOp::Mod if !b.is_zero() => a % b,
            BinaryOp::Min => a.min(b).clone(),
            BinaryOp::Max => a.max(b).clone(),
            BinaryOp::Pow => match integer_power(a, b) {
                Some(power) => power,
                None => return Self::from(float_op(op, self.to_f64(), other.to_f64())),
            },
            BinaryOp::Div | BinaryOp::Mod => return Self::from(float_op(op, self.to_f64(), other.to_f64())),
        };
        Self::Finite(round(exact))
    }

    /// The value an operation yields. A result that is an approximation anyway — a quotient
    /// that had to be rounded (`1/3`), a power with a fractional or negative exponent — is
    /// simply the nearest `f64`; any other keeps its exact decimal value.
    pub fn evaluate(&self, op: BinaryOp, other: &Self) -> Number {
        let result = self.apply(op, other);
        let exact = match (op, &result, self, other) {
            (BinaryOp::Div, Self::Finite(q), Self::Finite(a), Self::Finite(b)) => round(q * b) == *a,
            (BinaryOp::Pow, _, _, Self::Finite(exponent)) => exponent.is_integer() && !exponent.is_negative(),
            (BinaryOp::Pow, ..) => false,
            _ => true,
        };
        if exact { result.into_number() } else { Number::Float(result.to_f64()) }
    }
}

impl From<f64> for Decimal {
    fn from(n: f64) -> Self {
        if n.is_finite() { Self::Finite(shortest_decimal(n)) } else { Self::Special(n) }
    }
}

impl From<&Number> for Decimal {
    fn from(n: &Number) -> Self {
        match n {
            Number::Float(n) => Self::from(*n),
            Number::Exact(d) => Self::Finite(d.clone()),
        }
    }
}

fn round(d: BigDecimal) -> BigDecimal {
    d.with_precision_round(PRECISION, RoundingMode::HalfUp)
}

fn decimal_to_f64(d: &BigDecimal) -> f64 {
    // Through the decimal text, which `f64` parsing rounds correctly.
    d.to_scientific_notation().parse().ok().or_else(|| d.to_f64()).unwrap_or(f64::NAN)
}

/// The shortest decimal that reads back as `n`: 0.1 is 0.1, not its binary expansion.
fn shortest_decimal(n: f64) -> BigDecimal {
    BigDecimal::from_str(&n.to_string()).expect("a finite f64 prints as a decimal")
}

/// The exact value of a finite `f64`.
fn exact_decimal(n: f64) -> BigDecimal {
    let bits = n.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i64;
    let fraction = bits & 0x000f_ffff_ffff_ffff;
    let (mantissa, exponent) = if biased == 0 { (fraction, -1074) } else { (fraction | (1 << 52), biased - 1075) };
    let mantissa = if n.is_sign_negative() { -BigInt::from(mantissa) } else { BigInt::from(mantissa) };
    if exponent >= 0 {
        BigDecimal::new(mantissa << exponent as usize, 0)
    } else {
        // m / 2^k = m * 5^k / 10^k
        let k = exponent.unsigned_abs() as u32;
        BigDecimal::new(mantissa * BigInt::from(5).pow(k), i64::from(k))
    }
}

/// A decimal in the notation `f64`s print in.
pub(crate) fn format_decimal(d: &BigDecimal) -> String {
    let (unscaled, scale) = d.normalized().as_bigint_and_exponent();
    let sign = if unscaled.is_negative() { "-" } else { "" };
    let digits = unscaled.abs().to_string();
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

fn integer_power(base: &BigDecimal, exponent: &BigDecimal) -> Option<BigDecimal> {
    if !exponent.is_integer() {
        return None;
    }
    let n = exponent.to_i64().filter(|n| n.abs() <= MAX_EXACT_EXPONENT)?;
    if n < 0 && base.is_zero() {
        return None;
    }
    // Guard digits keep the rounding of intermediate squares out of the final 20.
    let guard = NonZeroU64::new(PRECISION.get() + 10).unwrap();
    let mut result = BigDecimal::from(1);
    let mut square = base.clone();
    let mut bits = n.unsigned_abs();
    while bits > 0 {
        if bits & 1 == 1 {
            result = (&result * &square).with_precision_round(guard, RoundingMode::HalfUp);
        }
        bits >>= 1;
        if bits > 0 {
            square = (&square * &square).with_precision_round(guard, RoundingMode::HalfUp);
        }
    }
    Some(if n < 0 { BigDecimal::from(1) / result } else { result })
}

fn float_op(op: BinaryOp, a: f64, b: f64) -> f64 {
    match op {
        BinaryOp::Add => a + b,
        BinaryOp::Sub => a - b,
        BinaryOp::Mul => a * b,
        BinaryOp::Div => a / b,
        BinaryOp::Mod => a % b,
        BinaryOp::Pow => a.powf(b),
        BinaryOp::Min if a.is_nan() || b.is_nan() => f64::NAN,
        BinaryOp::Min => a.min(b),
        BinaryOp::Max if a.is_nan() || b.is_nan() => f64::NAN,
        BinaryOp::Max => a.max(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIG: &str = "12345678901234567890";
    const BIG1: &str = "12345678901234567891";

    fn eval(op: BinaryOp, a: f64, b: f64) -> f64 {
        Decimal::from(a).evaluate(op, &Decimal::from(b)).to_f64()
    }

    fn evaluate(op: BinaryOp, a: &str, b: &str) -> Number {
        Decimal::from(&Number::parse(a)).evaluate(op, &Decimal::from(&Number::parse(b)))
    }

    #[test]
    fn arithmetic_is_decimal() {
        assert_eq!(eval(BinaryOp::Add, 0.1, 0.2), 0.3);
        assert_eq!(eval(BinaryOp::Sub, 0.3, 0.1), 0.2);
        assert_eq!(eval(BinaryOp::Mul, 1.1, 1.1), 1.21);
        assert_eq!(eval(BinaryOp::Div, 1.0, 3.0), 0.3333333333333333);
        assert_eq!(eval(BinaryOp::Mod, -7.0, 3.0), -1.0);
        assert_eq!(eval(BinaryOp::Pow, 2.0, -2.0), 0.25);
        assert_eq!(eval(BinaryOp::Pow, 2.0, 0.5), std::f64::consts::SQRT_2);
        assert_eq!(eval(BinaryOp::Pow, 10.0, 30.0), 1e30);
    }

    #[test]
    fn division_by_zero_is_ieee() {
        assert_eq!(eval(BinaryOp::Div, 1.0, 0.0), f64::INFINITY);
        assert!(eval(BinaryOp::Div, 0.0, 0.0).is_nan());
        assert!(eval(BinaryOp::Mod, 1.0, 0.0).is_nan());
    }

    #[test]
    fn numeric_strings_are_numbers() {
        let parse = |s: &str| Decimal::from_value(&Value::from(s)).map(|d| d.to_f64());
        assert_eq!(parse("1.5"), Ok(1.5));
        assert_eq!(parse("-2e3"), Ok(-2000.0));
        assert_eq!(parse(".5"), Ok(0.5));
        assert_eq!(parse("1e9999"), Ok(f64::INFINITY));
        for bad in ["", "abc", "1 ", "0x10", "1e", "--1", ".", "1e99999"] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            Decimal::from_value(&Value::Bool(true)).unwrap_err().to_string(),
            "expected a number, got a boolean"
        );
    }

    #[test]
    fn a_value_an_f64_holds_is_an_f64() {
        for (text, n) in
            [("1.50", 1.5), ("0.1", 0.1), ("2e4", 20000.0), ("0", 0.0), ("9007199254740992", 9007199254740992.0)]
        {
            assert_eq!(Number::parse(text), Number::Float(n), "{text}");
        }
        // Written out in full, the exact binary value of an f64 is that f64.
        assert_eq!(Number::parse("12345678901234567168"), Number::Float(12345678901234567168.0));
        assert_eq!(Number::parse(&exact_decimal(1.7e308).to_plain_string()), Number::Float(1.7e308));
        assert!(Number::parse("abc").to_f64().is_nan());
    }

    #[test]
    fn a_value_an_f64_would_round_stays_exact() {
        for text in [BIG, BIG1, "9007199254740993", "1.00000000000000000001", "1e400"] {
            assert!(matches!(Number::parse(text), Number::Exact(_)), "{text}");
        }
        assert_ne!(Number::parse(BIG), Number::parse(BIG1));
        assert_eq!(Number::parse(BIG).to_f64(), Number::parse(BIG1).to_f64());
        assert_eq!(evaluate(BinaryOp::Sub, BIG1, BIG), Number::Float(1.0));
        assert_eq!(evaluate(BinaryOp::Add, BIG, "1"), Number::parse(BIG1));
        assert_eq!(evaluate(BinaryOp::Add, BIG, "1").display(), BIG1);
    }

    #[test]
    fn approximations_are_plain_f64s() {
        assert_eq!(evaluate(BinaryOp::Div, "1", "3"), Number::Float(1.0 / 3.0));
        assert_eq!(evaluate(BinaryOp::Div, "10", "4"), Number::Float(2.5));
        assert_eq!(evaluate(BinaryOp::Pow, "2", "0.5"), Number::Float(std::f64::consts::SQRT_2));
        assert!(matches!(evaluate(BinaryOp::Pow, "3", "40"), Number::Exact(_)));
    }

    #[test]
    fn exact_values_display_every_digit() {
        for (text, shown) in [
            (BIG, BIG),
            ("1.00000000000000000001", "1.00000000000000000001"),
            ("-12345678901234567891", "-12345678901234567891"),
            ("1234567890123456789012345", "1.234567890123456789012345e+24"),
            ("0.00000000123456789012345678", "1.23456789012345678e-9"),
        ] {
            assert_eq!(Number::parse(text).display(), shown);
        }
    }
}
