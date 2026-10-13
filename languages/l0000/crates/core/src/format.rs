// SPDX-License-Identifier: MIT

//! `format-number`: a number as text, by an Excel number-format pattern. The supported subset,
//! and what is reported as an error instead of ignored, is in `spec.md` under `format-number`.
//!
//! Arithmetic is decimal and exact, never binary: an `f64` is read from its shortest decimal
//! (`1.005` is 1.005, so `"0.00"` gives "1.01"), and an exact number keeps every digit.
//! Rounding is half away from zero, as in Excel.

use bigdecimal::num_traits::{Signed, Zero};
use bigdecimal::{BigDecimal, RoundingMode};

use crate::number::{Decimal, Number, format_decimal};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FormatError {
    /// The pattern is outside the supported subset.
    #[error("{0}")]
    Pattern(String),
    /// The value is an infinity or `NaN`.
    #[error("cannot format {0}")]
    NotFinite(String),
}

fn bad_pattern<T>(message: impl Into<String>) -> Result<T, FormatError> {
    Err(FormatError::Pattern(message.into()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Placeholder {
    /// `0`: always shown.
    Zero,
    /// `#`: shown only if significant.
    Hash,
    /// `?`: shown, or replaced by a space.
    Question,
}

impl Placeholder {
    fn of(c: Option<char>) -> Option<Self> {
        match c? {
            '0' => Some(Self::Zero),
            '#' => Some(Self::Hash),
            '?' => Some(Self::Question),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Comma {
    /// Thousands grouping: `#,##0`.
    Group,
    /// Divides by 1000: `#,##0,,`.
    Scale,
    Literal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Digit(Placeholder),
    Point,
    Comma(Comma),
    Percent,
    /// `E+00` always writes the exponent's sign; `E-00`, and the unsigned `E00`, only a minus.
    Exponent {
        letter: char,
        always_signed: bool,
    },
    General,
    Literal(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Section {
    tokens: Vec<Token>,
    general: bool,
    integer: Vec<Placeholder>,
    fraction: Vec<Placeholder>,
    exponent: Vec<Placeholder>,
    scientific: bool,
    grouping: bool,
    /// Thousands to divide by, one per scaling comma.
    scale: i64,
    /// Hundreds to multiply by, one per `%`.
    percent: i64,
}

/// A parsed pattern: `positive;negative;zero`, `nonnegative;negative`, or a single section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern(Vec<Section>);

impl Pattern {
    pub fn parse(pattern: &str) -> Result<Self, FormatError> {
        if pattern.is_empty() {
            return bad_pattern("the pattern is empty");
        }
        let sections = tokenize(pattern)?;
        if sections.len() > 3 {
            return bad_pattern(
                "at most three sections (positive;negative;zero); a fourth, text section is not supported",
            );
        }
        sections.into_iter().map(analyze).collect::<Result<_, _>>().map(Self)
    }

    pub fn format(&self, value: &Number) -> Result<String, FormatError> {
        let Decimal::Finite(value) = Decimal::from(value) else {
            return Err(FormatError::NotFinite(value.display()));
        };
        let magnitude = value.abs();
        let sections = &self.0;
        if let [only] = sections.as_slice() {
            // One section: a minus is written only when the rounded result is not zero.
            let (text, nonzero) = only.render(&magnitude);
            return Ok(if value.is_negative() && nonzero { format!("-{text}") } else { text });
        }
        // Sections are chosen by the unrounded value, as in Excel; a negative one writes no minus.
        let section = if value.is_negative() {
            &sections[1]
        } else if value.is_zero() && sections.len() == 3 {
            &sections[2]
        } else {
            &sections[0]
        };
        Ok(section.render(&magnitude).0)
    }
}

/// `value` as text, by an Excel number-format `pattern`.
pub fn format_number(pattern: &str, value: &Number) -> Result<String, FormatError> {
    Pattern::parse(pattern)?.format(value)
}

fn tokenize(pattern: &str) -> Result<Vec<Vec<Token>>, FormatError> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut sections = vec![Vec::new()];
    let (mut has_point, mut has_exponent) = (false, false);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let tokens = sections.last_mut().expect("there is always a current section");
        match c {
            ';' => {
                sections.push(Vec::new());
                (has_point, has_exponent) = (false, false);
            }
            '"' => {
                let Some(len) = chars[i + 1..].iter().position(|&c| c == '"') else {
                    return bad_pattern("a quoted string is not closed");
                };
                tokens.push(Token::Literal(chars[i + 1..i + 1 + len].iter().collect()));
                i += len + 1;
            }
            '\\' | '_' | '*' => {
                let Some(next) = next else {
                    return bad_pattern(format!("'{c}' at the end of the pattern needs a character after it"));
                };
                // \c is c; _c is a space as wide as c; *c repeats c to fill a cell, and there is
                // no cell.
                match c {
                    '\\' => tokens.push(Token::Literal(next.to_string())),
                    '_' => tokens.push(Token::Literal(" ".to_owned())),
                    _ => {}
                }
                i += 1;
            }
            '0' | '#' | '?' => tokens.extend(Placeholder::of(Some(c)).map(Token::Digit)),
            // The first decimal point of the mantissa is the decimal point; any other is text.
            '.' => {
                tokens.push(if has_point || has_exponent { Token::Literal(".".to_owned()) } else { Token::Point });
                has_point = true;
            }
            ',' => tokens.push(Token::Comma(Comma::Literal)),
            '%' => tokens.push(Token::Percent),
            'E' | 'e'
                if !has_exponent
                    && (Placeholder::of(next).is_some()
                        || (matches!(next, Some('+' | '-'))
                            && Placeholder::of(chars.get(i + 2).copied()).is_some())) =>
            {
                tokens.push(Token::Exponent { letter: c, always_signed: next == Some('+') });
                if matches!(next, Some('+' | '-')) {
                    i += 1;
                }
                has_exponent = true;
            }
            _ if starts_with_general(&chars[i..]) => {
                tokens.push(Token::General);
                i += "general".len() - 1;
            }
            '[' => return bad_pattern("[…] (colors, conditions and locales) is not supported"),
            '@' => return bad_pattern("@ (text sections) is not supported"),
            '/' if matches!(tokens.last(), Some(Token::Digit(_)))
                && next.is_some_and(|next| Placeholder::of(Some(next)).is_some() || next.is_ascii_digit()) =>
            {
                return bad_pattern("fractions (/ between digit placeholders) are not supported");
            }
            _ if c.is_ascii_alphabetic() => {
                return bad_pattern(if "ymdhsYMDHS".contains(c) {
                    format!("'{c}': date and time codes are not supported")
                } else {
                    format!("'{c}': put literal text in double quotes")
                });
            }
            '1'..='9' => return bad_pattern(format!("'{c}': put literal digits in double quotes")),
            _ => tokens.push(Token::Literal(c.to_string())),
        }
        i += 1;
    }
    Ok(sections)
}

fn starts_with_general(chars: &[char]) -> bool {
    chars.len() >= 7 && chars[..7].iter().zip("general".chars()).all(|(a, b)| a.to_ascii_lowercase() == b)
}

fn analyze(mut tokens: Vec<Token>) -> Result<Section, FormatError> {
    let is_digit = |token: &Token| matches!(token, Token::Digit(_));
    let general = tokens.contains(&Token::General);
    if general && tokens.iter().any(is_digit) {
        return bad_pattern("General cannot be combined with digit placeholders");
    }
    let exponent_at = tokens.iter().position(|token| matches!(token, Token::Exponent { .. }));
    let mantissa_end = exponent_at.unwrap_or(tokens.len());
    let point_at = tokens.iter().position(|token| *token == Token::Point);
    let integer_end = point_at.unwrap_or(mantissa_end);

    let mut grouping = false;
    let mut scale = 0;
    for i in 0..tokens.len() {
        if !matches!(tokens[i], Token::Comma(_)) {
            continue;
        }
        let any_digit = |from: usize, to: usize| from < to && tokens[from..to].iter().any(is_digit);
        let role = if i < integer_end && any_digit(0, i) && any_digit(i + 1, integer_end) {
            grouping = true; // #,##0
            Comma::Group
        } else {
            // A run of commas right after the mantissa's last digits divides by 1000 each: #,##0,,
            let is_comma = |token: &Token| matches!(token, Token::Comma(_));
            let before = tokens[..i].iter().rev().find(|token| !is_comma(token));
            let after = i + 1 + tokens[i + 1..].iter().take_while(|token| is_comma(token)).count();
            let ends_the_digits = match tokens.get(after) {
                None | Some(Token::Point | Token::Exponent { .. }) => true,
                Some(_) => !any_digit(after, mantissa_end),
            };
            if i < mantissa_end && before.is_some_and(is_digit) && ends_the_digits {
                scale += 1;
                Comma::Scale
            } else {
                Comma::Literal
            }
        };
        tokens[i] = Token::Comma(role);
    }

    let digits = |from: usize, to: usize| -> Vec<Placeholder> {
        tokens[from..to]
            .iter()
            .filter_map(|token| match token {
                Token::Digit(placeholder) => Some(*placeholder),
                _ => None,
            })
            .collect()
    };
    Ok(Section {
        general,
        integer: digits(0, integer_end),
        fraction: point_at.map_or_else(Vec::new, |point| digits(point + 1, mantissa_end)),
        exponent: exponent_at.map_or_else(Vec::new, |at| digits(at + 1, tokens.len())),
        scientific: exponent_at.is_some(),
        grouping,
        scale,
        percent: tokens.iter().filter(|token| **token == Token::Percent).count() as i64,
        tokens,
    })
}

impl Section {
    /// The text for a non-negative value, and whether any digit written is not zero.
    fn render(&self, value: &BigDecimal) -> (String, bool) {
        if self.general {
            let text = self
                .tokens
                .iter()
                .map(|token| match token {
                    Token::General => format_decimal(value),
                    Token::Literal(text) => text.clone(),
                    _ => String::new(),
                })
                .collect();
            return (text, !value.is_zero());
        }
        let places = self.fraction.len() as i64;
        let mut value = times_power_of_ten(value, 2 * self.percent - 3 * self.scale);
        let mut exponent = 0;
        if self.scientific {
            // As many integer digits as `0` placeholders; with any `#`, the exponent is a
            // multiple of the integer placeholder count instead (engineering form, ##0.0E+0).
            let width = self.integer.len().max(1) as i64;
            let engineering = self.integer.contains(&Placeholder::Hash);
            let exponent_for = |x: &BigDecimal| match leading_exponent(x) {
                None => 0,
                Some(e) if engineering => e.div_euclid(width) * width,
                Some(e) => e - (width - 1),
            };
            exponent = exponent_for(&value);
            let mut mantissa = round(&times_power_of_ten(&value, -exponent), places);
            // Rounding carried into a new digit: 9.99 → 10.0.
            if exponent_for(&mantissa) != 0 {
                exponent += exponent_for(&mantissa);
                mantissa = round(&times_power_of_ten(&value, -exponent), places);
            }
            value = mantissa;
        }
        let fixed = round(&value, places).to_plain_string();
        let (integer_part, fraction_part) = fixed.split_once('.').unwrap_or((&fixed, ""));
        let integer_digits = if integer_part == "0" { "" } else { integer_part };
        let nonzero = fixed.bytes().any(|b| (b'1'..=b'9').contains(&b));

        let integer = fill_integer(integer_digits, &self.integer, self.grouping && !self.scientific);
        let fraction = fill_fraction(fraction_part, &self.fraction);
        let exponent_digits = if exponent == 0 { String::new() } else { exponent.abs().to_string() };
        let exponent_slots = fill_integer(&exponent_digits, &self.exponent, false);

        let mut text = String::new();
        let (mut integer, mut fraction, mut exponent_slots) =
            (integer.into_iter(), fraction.into_iter(), exponent_slots.into_iter());
        let (mut past_point, mut in_exponent) = (false, false);
        for token in &self.tokens {
            match token {
                Token::Digit(_) => {
                    let slot = if in_exponent {
                        exponent_slots.next()
                    } else if past_point {
                        fraction.next()
                    } else {
                        integer.next()
                    };
                    text.push_str(&slot.unwrap_or_default());
                }
                Token::Point => {
                    // With no integer placeholders, the integer digits still come before the point.
                    if self.integer.is_empty() {
                        text.push_str(integer_digits);
                    }
                    text.push('.');
                    past_point = true;
                }
                Token::Exponent { letter, always_signed } => {
                    text.push(*letter);
                    if exponent < 0 {
                        text.push('-');
                    } else if *always_signed {
                        text.push('+');
                    }
                    in_exponent = true;
                }
                Token::Percent => text.push('%'),
                Token::Comma(Comma::Literal) => text.push(','),
                Token::Comma(_) | Token::General => {}
                Token::Literal(literal) => text.push_str(literal),
            }
        }
        (text, nonzero)
    }
}

/// `value × 10^power`, exactly.
fn times_power_of_ten(value: &BigDecimal, power: i64) -> BigDecimal {
    let (unscaled, scale) = value.as_bigint_and_exponent();
    BigDecimal::new(unscaled, scale - power)
}

/// Half away from zero, to `places` decimal places.
fn round(value: &BigDecimal, places: i64) -> BigDecimal {
    value.with_scale_round(places, RoundingMode::HalfUp)
}

/// The power of ten of a value's leading digit; `None` for zero.
fn leading_exponent(value: &BigDecimal) -> Option<i64> {
    let (unscaled, scale) = value.as_bigint_and_exponent();
    (!unscaled.is_zero()).then(|| unscaled.abs().to_string().len() as i64 - 1 - scale)
}

/// Digits right-aligned into placeholders: extra digits go to the leftmost one, and an unfilled
/// `0` shows 0, `?` a space and `#` nothing. Returns one string per placeholder.
fn fill_integer(digits: &str, placeholders: &[Placeholder], grouping: bool) -> Vec<String> {
    let mut slots: Vec<Vec<String>> = vec![Vec::new(); placeholders.len()];
    let mut remaining = digits.chars().rev();
    for (j, placeholder) in placeholders.iter().enumerate().rev() {
        match remaining.next() {
            Some(digit) => slots[j].push(digit.to_string()),
            None => slots[j].push(
                match placeholder {
                    Placeholder::Zero => "0",
                    Placeholder::Question => " ",
                    Placeholder::Hash => "",
                }
                .to_owned(),
            ),
        }
        if j == 0 {
            for digit in remaining.by_ref() {
                slots[0].insert(0, digit.to_string());
            }
        }
    }
    if grouping {
        // A comma before every third digit from the right that has a digit to its left.
        let mut count = 0;
        for cell in slots.iter_mut().rev().flat_map(|slot| slot.iter_mut().rev()) {
            if !cell.starts_with(|c: char| c.is_ascii_digit()) {
                continue;
            }
            if count > 0 && count % 3 == 0 {
                cell.push(',');
            }
            count += 1;
        }
    }
    slots.into_iter().map(|cells| cells.concat()).collect()
}

/// Trailing zeros under `#` are dropped and under `?` become spaces; `0` always shows.
fn fill_fraction(digits: &str, placeholders: &[Placeholder]) -> Vec<String> {
    let mut slots: Vec<String> = digits.chars().map(String::from).collect();
    for (slot, placeholder) in slots.iter_mut().zip(placeholders).rev() {
        if slot != "0" || *placeholder == Placeholder::Zero {
            break;
        }
        *slot = if *placeholder == Placeholder::Question { " ".to_owned() } else { String::new() };
    }
    slots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_by_pattern() {
        for (pattern, value, expected) in [
            // placeholders, decimal point and grouping
            ("#,##0.00", 1234.5, "1,234.50"),
            ("0", 0.0, "0"),
            ("#", 0.0, ""),
            (".00", 0.5, ".50"),
            (".00", 12.5, "12.50"),
            ("#.##", 1.0, "1."),
            ("0,000", 5.0, "0,005"),
            ("??0.0?", 1.5, "  1.5 "),
            ("000-00-0000", 123456789.0, "123-45-6789"),
            // percent and scaling commas
            ("0.0%", 0.256, "25.6%"),
            ("#,##0,,\"M\"", 1234567890.0, "1,235M"),
            ("0.0,", 1500.0, "1.5"),
            // literal text
            ("$#,##0", 1234567.8, "$1,234,568"),
            ("0 \"kg\"", 3.0, "3 kg"),
            ("\\#0", 7.0, "#7"),
            ("0_)", 7.0, "7 "),
            ("*-0", 7.0, "7"),
            // rounding: half away from zero, in decimal
            ("0", 2.5, "3"),
            ("0", -2.5, "-3"),
            ("0.00", 1.005, "1.01"),
            ("0.00", -0.001, "0.00"),
            // sections
            ("#,##0;(#,##0)", -1500.0, "(1,500)"),
            ("#,##0;(#,##0)", 1500.0, "1,500"),
            ("0.00;(0.00)", -0.001, "(0.00)"),
            ("0;-0;\"zero\"", 0.0, "zero"),
            ("0;-0;\"zero\"", -0.0, "zero"),
            ("#,##0.00_);(#,##0.00)", -1234.5, "(1,234.50)"),
            ("#,##0.00_);(#,##0.00)", 1234.5, "1,234.50 "),
            // scientific: E+ always signs the exponent; E- and the unsigned E only a minus
            ("0.00E+00", 12345.0, "1.23E+04"),
            ("0.00E+00", 0.00123, "1.23E-03"),
            ("0.00E-00", 12345.0, "1.23E04"),
            ("0.00E-00", 0.00123, "1.23E-03"),
            ("0.00e00", 12345.0, "1.23e04"),
            ("0.00e00", 0.00123, "1.23e-03"),
            ("0.00e+00", 12345.0, "1.23e+04"),
            ("0.00E+00", 9.999, "1.00E+01"),
            ("0.0E+00", 0.0, "0.0E+00"),
            ("##0.0E+0", 12345.0, "12.3E+3"),
            // General
            ("General", 0.1, "0.1"),
            ("General\" kg\"", -3.25, "-3.25 kg"),
        ] {
            assert_eq!(format_number(pattern, &Number::Float(value)).as_deref(), Ok(expected), "{pattern} {value}");
        }
    }

    #[test]
    fn an_exact_number_keeps_every_digit() {
        let big = Number::parse("12345678901234567891");
        assert_eq!(format_number("#,##0", &big).as_deref(), Ok("12,345,678,901,234,567,891"));
        assert_eq!(format_number("0.0%", &big).as_deref(), Ok("1234567890123456789100.0%"));
    }

    #[test]
    fn rejects_patterns_outside_the_supported_subset() {
        for (pattern, message) in [
            ("", "the pattern is empty"),
            ("[Red]0", "[…] (colors, conditions and locales) is not supported"),
            ("@", "@ (text sections) is not supported"),
            ("0;0;0;0", "at most three sections"),
            ("0/0", "fractions"),
            ("yyyy", "date and time codes are not supported"),
            ("0 kg", "'k': put literal text in double quotes"),
            ("1", "put literal digits in double quotes"),
            ("\"open", "a quoted string is not closed"),
            ("0\\", "needs a character after it"),
            ("General0", "General cannot be combined with digit placeholders"),
        ] {
            match format_number(pattern, &Number::Float(1.0)) {
                Err(FormatError::Pattern(actual)) => assert!(actual.contains(message), "{pattern:?}: {actual}"),
                other => panic!("{pattern:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn rejects_a_value_that_is_not_finite() {
        assert_eq!(format_number("0", &Number::NAN), Err(FormatError::NotFinite("NaN".into())));
        assert_eq!(
            format_number("0", &Number::Float(f64::INFINITY)).unwrap_err().to_string(),
            "cannot format Infinity"
        );
    }
}
