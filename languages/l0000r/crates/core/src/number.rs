// SPDX-License-Identifier: MIT

//! Decimal arithmetic.
//!
//! Graffiticode numbers are decimal: `add 0.1 0.2` is `0.3`, not `0.30000000000000004`. A
//! number enters a computation as the decimal it is written as, results are rounded to
//! [`PRECISION`] significant digits (half up), and the value handed on is the nearest `f64`.
//! Infinities and `NaN` follow IEEE 754.

use std::cmp::Ordering;
use std::num::NonZeroU64;
use std::str::FromStr;

use bigdecimal::num_traits::{ToPrimitive, Zero};
use bigdecimal::{BigDecimal, RoundingMode};

use crate::value::Value;

const PRECISION: NonZeroU64 = NonZeroU64::new(20).unwrap();
/// A numeric string's exponent may have this many digits. Anything longer is far outside what a
/// number can hold, and would only make the arithmetic allocate.
const MAX_EXPONENT_DIGITS: usize = 4;
/// Integer powers up to this exponent are computed exactly; larger ones in floating point.
const MAX_EXACT_EXPONENT: i64 = 1024;

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
            Value::Num(n) => Ok(Self::from(*n)),
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

    pub fn to_f64(&self) -> f64 {
        match self {
            Self::Finite(d) => d.with_precision_round(PRECISION, RoundingMode::HalfUp).to_f64().unwrap_or(f64::NAN),
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
        Self::Finite(exact.with_precision_round(PRECISION, RoundingMode::HalfUp))
    }
}

impl From<f64> for Decimal {
    fn from(n: f64) -> Self {
        if !n.is_finite() {
            return Self::Special(n);
        }
        // The shortest decimal that reads back as `n`: 0.1 is 0.1, not its binary expansion.
        BigDecimal::from_str(&n.to_string()).map_or(Self::Special(f64::NAN), Self::Finite)
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

    fn eval(op: BinaryOp, a: f64, b: f64) -> f64 {
        Decimal::from(a).apply(op, &Decimal::from(b)).to_f64()
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
}
