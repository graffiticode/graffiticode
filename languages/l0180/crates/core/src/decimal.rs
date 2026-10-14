// SPDX-License-Identifier: MIT

//! The slice of decimal.js the TypeScript compiler's arithmetic goes through, with its default
//! configuration: twenty significant digits, rounding half away from zero.
//!
//! A literal is read exactly. A quotient, a sum and a difference are rounded to twenty
//! significant digits, which is what makes `1/3` a twenty-digit decimal rather than a repeating
//! one, and why the compiler can decide that two authored answers are the same number exactly as
//! the scorer will. Comparisons are exact.

use std::cmp::Ordering;

use num_bigint::BigUint;
use num_integer::Integer;
use num_traits::{One, Zero};

/// decimal.js's default `precision`.
const PRECISION: usize = 20;

/// `(-1)^negative × coefficient × 10^exponent`, with no trailing zeros in the coefficient.
#[derive(Clone, Debug)]
pub struct Decimal {
    negative: bool,
    coefficient: BigUint,
    exponent: i64,
}

fn ten_pow(n: u64) -> BigUint {
    num_traits::pow(BigUint::from(10u32), n as usize)
}

fn digits(n: &BigUint) -> i64 {
    if n.is_zero() { 1 } else { n.to_string().len() as i64 }
}

impl Decimal {
    fn new(negative: bool, coefficient: BigUint, exponent: i64) -> Self {
        let mut decimal = Self { negative, coefficient, exponent };
        decimal.normalize();
        decimal
    }

    fn normalize(&mut self) {
        if self.coefficient.is_zero() {
            self.exponent = 0;
            return;
        }
        let ten = BigUint::from(10u32);
        while (&self.coefficient % &ten).is_zero() {
            self.coefficient /= &ten;
            self.exponent = self.exponent.saturating_add(1);
        }
    }

    /// Reads a decimal literal, `[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?`, exactly. `None` for
    /// anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let (negative, rest) = match text.as_bytes().first()? {
            b'-' => (true, &text[1..]),
            b'+' => (false, &text[1..]),
            _ => (false, text),
        };
        let (mantissa, exponent) = match rest.find(['e', 'E']) {
            Some(at) => (&rest[..at], Some(&rest[at + 1..])),
            None => (rest, None),
        };
        let (whole, fraction) = match mantissa.find('.') {
            Some(at) => (&mantissa[..at], &mantissa[at + 1..]),
            None => (mantissa, ""),
        };
        let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
        if whole.is_empty() && fraction.is_empty() || !all_digits(whole) || !all_digits(fraction) {
            return None;
        }
        let exponent = match exponent {
            None => 0i64,
            Some(e) => {
                let (sign, e) = match e.as_bytes().first()? {
                    b'-' => (-1, &e[1..]),
                    b'+' => (1, &e[1..]),
                    _ => (1, e),
                };
                if e.is_empty() || !all_digits(e) {
                    return None;
                }
                // Far past anything decimal.js keeps finite; saturating keeps the arithmetic
                // below from ever materializing such a power.
                sign * e.parse::<i64>().unwrap_or(i64::MAX / 4).min(i64::MAX / 4)
            }
        };
        let coefficient: BigUint = format!("{whole}{fraction}").trim_start_matches('0').parse().unwrap_or_default();
        Some(Self::new(negative, coefficient, exponent - fraction.len() as i64))
    }

    pub fn is_zero(&self) -> bool {
        self.coefficient.is_zero()
    }

    /// The exponent of the most significant digit.
    fn adjusted(&self) -> i64 {
        self.exponent + digits(&self.coefficient) - 1
    }

    /// `isInteger()`.
    pub fn is_integer(&self) -> bool {
        self.is_zero() || self.exponent >= 0
    }

    /// `decimalPlaces()`.
    pub fn decimal_places(&self) -> u64 {
        if self.exponent < 0 { self.exponent.unsigned_abs() } else { 0 }
    }

    /// `precision()`: significant digits, trailing zeros not counted.
    pub fn precision(&self) -> i64 {
        digits(&self.coefficient)
    }

    pub fn abs(&self) -> Self {
        Self { negative: false, ..self.clone() }
    }

    fn negate(&self) -> Self {
        Self { negative: !self.negative, ..self.clone() }
    }

    /// Rounded to `PRECISION` significant digits, half away from zero.
    fn round(mut self) -> Self {
        let excess = digits(&self.coefficient) - PRECISION as i64;
        if excess > 0 {
            let unit = ten_pow(excess as u64);
            let (mut kept, dropped) = self.coefficient.div_rem(&unit);
            if dropped * 2u32 >= unit {
                kept += 1u32;
            }
            self.coefficient = kept;
            self.exponent += excess;
            self.normalize();
        }
        self
    }

    /// Magnitudes compared.
    fn cmp_abs(&self, other: &Self) -> Ordering {
        match (self.is_zero(), other.is_zero()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        match self.adjusted().cmp(&other.adjusted()) {
            Ordering::Equal => {}
            unequal => return unequal,
        }
        let low = self.exponent.min(other.exponent);
        let scaled = |d: &Self| &d.coefficient * ten_pow((d.exponent - low) as u64);
        scaled(self).cmp(&scaled(other))
    }

    /// Exact comparison; `-0` equals `0`.
    pub fn compare(&self, other: &Self) -> Ordering {
        let sign = |d: &Self| {
            if d.is_zero() {
                0
            } else if d.negative {
                -1
            } else {
                1
            }
        };
        match sign(self).cmp(&sign(other)) {
            Ordering::Equal if sign(self) < 0 => other.cmp_abs(self),
            Ordering::Equal => self.cmp_abs(other),
            unequal => unequal,
        }
    }

    pub fn gt(&self, other: &Self) -> bool {
        self.compare(other) == Ordering::Greater
    }

    pub fn lt(&self, other: &Self) -> bool {
        self.compare(other) == Ordering::Less
    }

    pub fn lte(&self, other: &Self) -> bool {
        self.compare(other) != Ordering::Greater
    }

    /// `plus`, rounded.
    pub fn plus(&self, other: &Self) -> Self {
        if other.is_zero() {
            return self.clone().round();
        }
        if self.is_zero() {
            return other.clone().round();
        }
        let (big, small) = if self.cmp_abs(other) == Ordering::Less { (other, self) } else { (self, other) };
        // A term far below every digit the rounded sum can keep only decides which way a tie
        // goes, so any value that small, with its sign, rounds the same and keeps the powers of
        // ten below bounded.
        let floor = big.exponent.min(big.adjusted() - PRECISION as i64 - 1) - 2;
        let small = if small.adjusted() < floor {
            Self { negative: small.negative, coefficient: BigUint::one(), exponent: floor }
        } else {
            small.clone()
        };
        let low = big.exponent.min(small.exponent);
        let scaled = |d: &Self| &d.coefficient * ten_pow((d.exponent - low) as u64);
        let (a, b) = (scaled(big), scaled(&small));
        let sum = if big.negative == small.negative {
            Self::new(big.negative, a + b, low)
        } else {
            Self::new(big.negative, a - b, low)
        };
        sum.round()
    }

    /// `minus`, rounded.
    pub fn minus(&self, other: &Self) -> Self {
        self.plus(&other.negate())
    }

    /// `div`, rounded. `None` for a zero divisor.
    pub fn div(&self, other: &Self) -> Option<Self> {
        if other.is_zero() {
            return None;
        }
        if self.is_zero() {
            return Some(Self::new(false, BigUint::zero(), 0));
        }
        // Enough quotient digits to round: rounding half away from zero needs only the digit
        // after the last one kept, so truncating below that changes nothing.
        let shift = (PRECISION as i64 + 2 + digits(&other.coefficient) - digits(&self.coefficient)).max(0);
        let quotient = &self.coefficient * ten_pow(shift as u64) / &other.coefficient;
        Some(Self::new(self.negative != other.negative, quotient, self.exponent - other.exponent - shift).round())
    }

    /// `times` by a power of ten, rounded.
    pub fn scaled(&self, power: u64) -> Self {
        Self { exponent: self.exponent + power as i64, ..self.clone() }.round()
    }

    /// The value as a whole number, when it is one.
    pub fn to_integer(&self) -> Option<BigUint> {
        if !self.is_integer() {
            return None;
        }
        Some(&self.coefficient * ten_pow(self.exponent.max(0) as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Decimal {
        Decimal::parse(text).unwrap()
    }

    #[test]
    fn literals_read_exactly() {
        assert_eq!(d("0.50").compare(&d(".5")), Ordering::Equal);
        assert_eq!(d("5e-1").compare(&d("0.5")), Ordering::Equal);
        assert_eq!(d("-0").compare(&d("0")), Ordering::Equal);
        assert!(d("3.").is_integer());
        assert!(!d("1.5").is_integer());
        assert_eq!(d("1.50").decimal_places(), 1);
        assert_eq!(d("1200").precision(), 2);
        assert!(Decimal::parse("1e").is_none());
        assert!(Decimal::parse(".").is_none());
        assert!(Decimal::parse("1,0").is_none());
    }

    #[test]
    fn a_quotient_has_twenty_digits() {
        let third = d("1").div(&d("3")).unwrap();
        assert_eq!(third.compare(&d("0.33333333333333333333")), Ordering::Equal);
        let two_thirds = d("2").div(&d("3")).unwrap();
        assert_eq!(two_thirds.compare(&d("0.66666666666666666667")), Ordering::Equal);
        assert!(d("4").div(&d("2")).unwrap().is_integer());
        assert!(d("1").div(&d("0")).is_none());
        assert_eq!(d("-1").div(&d("8")).unwrap().compare(&d("-0.125")), Ordering::Equal);
    }

    #[test]
    fn a_difference_rounds_like_decimal_js() {
        let third = d("1").div(&d("3")).unwrap();
        assert_eq!(third.minus(&d("0.3333")).compare(&d("0.00003333333333333333")), Ordering::Equal);
        assert_eq!(d("1").minus(&d("1e-40")).compare(&d("1")), Ordering::Equal);
        assert_eq!(d("1").minus(&d("1e-19")).compare(&d("0.9999999999999999999")), Ordering::Equal);
        assert_eq!(d("1.00000000000000000005").minus(&d("1e-40")).compare(&d("1")), Ordering::Equal);
        assert_eq!(d("1.00000000000000000005").plus(&d("0")).compare(&d("1.0000000000000000001")), Ordering::Equal);
        assert!(d("0.5").minus(&d("0.51")).abs().lte(&d("0.02")));
        assert!(d("1e999999999999999999999").gt(&d("1")));
    }
}
