// SPDX-License-Identifier: MIT

//! Whether JavaScript's `Date.parse` reads a string as a date.
//!
//! The TypeScript compiler accepts a string on a TIME axis exactly when
//! `!Number.isNaN(Date.parse(v))`, so what it accepts is what V8 accepts: an ES5 ISO date-time,
//! or failing that V8's legacy date grammar, which reads things like `"Mar 1, 2026"`,
//! `"3/1/2026 10:00 PM"` and even `"1"` (2001-01-01). This is a port of V8's `DateParser`
//! (`src/date/dateparser*.{h,cc}`) followed by its `MakeDay`/`MakeTime` and time-value range.
//! Only validity is needed, and local time is taken to be UTC, as it is on the server.

const NONE: i64 = i64::MAX;
const MAX_SIGNIFICANT_DIGITS: usize = 9;
/// V8's largest small integer without pointer compression, as in Node.
const SMI_MAX: u64 = (1 << 31) - 1;
const MAX_TIME_MS: f64 = 8.64e15;

pub fn parses(text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let Some(out) = parse(&units) else { return false };
    let day = make_day(out.year, out.month, out.day);
    let time =
        out.hour as f64 * 3_600_000.0 + out.minute as f64 * 60_000.0 + out.second as f64 * 1000.0 + out.ms as f64;
    let mut date = day * 86_400_000.0 + time;
    if let Some(offset) = out.utc_offset {
        date -= offset as f64 * 1000.0;
    }
    date.is_finite() && date.abs() <= MAX_TIME_MS
}

struct Parsed {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
    utc_offset: Option<i64>,
}

fn between(x: i64, lo: i64, hi: i64) -> bool {
    lo <= x && x <= hi
}

/* ------------------------------------------------------------------ input and tokens */

struct Reader<'a> {
    units: &'a [u16],
    index: usize,
    ch: u32,
}

impl<'a> Reader<'a> {
    fn new(units: &'a [u16]) -> Self {
        let mut reader = Self { units, index: 0, ch: 0 };
        reader.next();
        reader
    }

    fn position(&self) -> usize {
        self.index
    }

    fn next(&mut self) {
        self.ch = self.units.get(self.index).map_or(0, |&u| u32::from(u));
        self.index += 1;
    }

    fn read_unsigned_numeral(&mut self) -> i64 {
        let mut n = 0;
        let mut i = 0;
        while self.ch == u32::from(b'0') {
            self.next();
        }
        while self.is_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + i64::from(self.ch - u32::from(b'0'));
            }
            i += 1;
            self.next();
        }
        n
    }

    fn read_word(&mut self) -> ([u32; 3], usize) {
        let mut prefix = [0; 3];
        let mut len = 0;
        while self.is_alpha_or_above() && !is_white_space(self.ch) {
            if len < 3 {
                prefix[len] = self.ch | 0x20;
            }
            len += 1;
            self.next();
        }
        (prefix, len)
    }

    fn skip(&mut self, c: u8) -> bool {
        if self.ch == u32::from(c) {
            self.next();
            true
        } else {
            false
        }
    }

    fn skip_white_space(&mut self) -> bool {
        if is_white_space(self.ch) || is_line_terminator(self.ch) {
            self.next();
            true
        } else {
            false
        }
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch != 0) {
                break;
            }
        }
        true
    }

    fn is_end(&self) -> bool {
        self.ch == 0
    }

    fn is_digit(&self) -> bool {
        (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
    }

    fn is_alpha_or_above(&self) -> bool {
        self.ch >= u32::from(b'A')
    }
}

fn is_white_space(c: u32) -> bool {
    matches!(c, 0x09 | 0x0b | 0x0c | 0x20 | 0xa0 | 0xfeff | 0x1680 | 0x2000..=0x200a | 0x202f | 0x205f | 0x3000)
}

fn is_line_terminator(c: u32) -> bool {
    matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Keyword {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Token {
    Invalid,
    Unknown,
    WhiteSpace,
    Number { value: i64, length: usize },
    Symbol(u8),
    EndOfInput,
    Keyword { kind: Keyword, value: i64, length: usize },
}

impl Token {
    fn is_number(&self) -> bool {
        matches!(self, Token::Number { .. })
    }

    fn number(&self) -> i64 {
        match self {
            Token::Number { value, .. } => *value,
            _ => 0,
        }
    }

    fn is_fixed_length_number(&self, n: usize) -> bool {
        matches!(self, Token::Number { length, .. } if *length == n)
    }

    fn is_symbol(&self, c: u8) -> bool {
        *self == Token::Symbol(c)
    }

    fn is_ascii_sign(&self) -> bool {
        self.is_symbol(b'+') || self.is_symbol(b'-')
    }

    fn ascii_sign(&self) -> i64 {
        if self.is_symbol(b'-') { -1 } else { 1 }
    }

    fn is_keyword_type(&self, kind: Keyword) -> bool {
        matches!(self, Token::Keyword { kind: k, .. } if *k == kind)
    }

    fn is_keyword_z(&self) -> bool {
        matches!(self, Token::Keyword { kind: Keyword::TimeZoneName, value: 0, length: 1 })
    }
}

const KEYWORDS: &[(&[u8; 3], Keyword, i64)] = &[
    (b"jan", Keyword::MonthName, 1),
    (b"feb", Keyword::MonthName, 2),
    (b"mar", Keyword::MonthName, 3),
    (b"apr", Keyword::MonthName, 4),
    (b"may", Keyword::MonthName, 5),
    (b"jun", Keyword::MonthName, 6),
    (b"jul", Keyword::MonthName, 7),
    (b"aug", Keyword::MonthName, 8),
    (b"sep", Keyword::MonthName, 9),
    (b"oct", Keyword::MonthName, 10),
    (b"nov", Keyword::MonthName, 11),
    (b"dec", Keyword::MonthName, 12),
    (b"am\0", Keyword::AmPm, 0),
    (b"pm\0", Keyword::AmPm, 12),
    (b"ut\0", Keyword::TimeZoneName, 0),
    (b"utc", Keyword::TimeZoneName, 0),
    (b"z\0\0", Keyword::TimeZoneName, 0),
    (b"gmt", Keyword::TimeZoneName, 0),
    (b"cdt", Keyword::TimeZoneName, -5),
    (b"cst", Keyword::TimeZoneName, -6),
    (b"edt", Keyword::TimeZoneName, -4),
    (b"est", Keyword::TimeZoneName, -5),
    (b"mdt", Keyword::TimeZoneName, -6),
    (b"mst", Keyword::TimeZoneName, -7),
    (b"pdt", Keyword::TimeZoneName, -7),
    (b"pst", Keyword::TimeZoneName, -8),
    (b"t\0\0", Keyword::TimeSeparator, 0),
];

/// A word longer than its keyword matches only a month name.
fn lookup(prefix: [u32; 3], len: usize) -> (Keyword, i64) {
    for (word, kind, value) in KEYWORDS {
        if word.iter().zip(prefix).all(|(&w, p)| u32::from(w) == p) && (len <= 3 || *kind == Keyword::MonthName) {
            return (*kind, *value);
        }
    }
    (Keyword::Invalid, 0)
}

struct Tokenizer<'a> {
    input: Reader<'a>,
    next: Token,
}

impl<'a> Tokenizer<'a> {
    fn new(units: &'a [u16]) -> Self {
        let mut input = Reader::new(units);
        let next = scan(&mut input);
        Self { input, next }
    }

    fn next(&mut self) -> Token {
        let result = self.next;
        self.next = scan(&mut self.input);
        result
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn skip_symbol(&mut self, c: u8) -> bool {
        if self.next.is_symbol(c) {
            self.next = scan(&mut self.input);
            true
        } else {
            false
        }
    }
}

fn scan(input: &mut Reader<'_>) -> Token {
    let pre = input.position();
    if input.is_end() {
        return Token::EndOfInput;
    }
    if input.is_digit() {
        let value = input.read_unsigned_numeral();
        return Token::Number { value, length: input.position() - pre };
    }
    for &c in b":-+.)" {
        if input.skip(c) {
            return Token::Symbol(c);
        }
    }
    if input.is_alpha_or_above() && !is_white_space(input.ch) {
        let (prefix, length) = input.read_word();
        let (kind, value) = lookup(prefix, length);
        return Token::Keyword { kind, value, length };
    }
    if input.skip_white_space() {
        return Token::WhiteSpace;
    }
    if input.skip_parentheses() {
        return Token::Unknown;
    }
    input.next();
    Token::Unknown
}

/* ------------------------------------------------------------------ composers */

struct TimeZone {
    sign: i64,
    hour: i64,
    minute: i64,
}

impl TimeZone {
    fn set(&mut self, offset_in_hours: i64) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }

    fn is_expecting(&self, n: i64) -> bool {
        self.hour != NONE && self.minute == NONE && between(n, 0, 59)
    }

    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }

    fn is_empty(&self) -> bool {
        self.hour == NONE
    }

    fn write(&mut self) -> Option<Option<i64>> {
        if self.sign == NONE {
            return Some(None);
        }
        if self.hour == NONE {
            self.hour = 0;
        }
        if self.minute == NONE {
            self.minute = 0;
        }
        // Unsigned 32-bit arithmetic, as V8 does it.
        let total = (self.hour as u32).wrapping_mul(3600).wrapping_add((self.minute as u32).wrapping_mul(60));
        if u64::from(total) > SMI_MAX {
            return None;
        }
        let total = i64::from(total);
        Some(Some(if self.sign < 0 { -total } else { total }))
    }
}

struct Time {
    comp: [i64; 4],
    index: usize,
    hour_offset: i64,
}

impl Time {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn is_expecting(&self, n: i64) -> bool {
        (self.index == 1 && between(n, 0, 59))
            || (self.index == 2 && between(n, 0, 59))
            || (self.index == 3 && between(n, 0, 999))
    }

    fn add(&mut self, n: i64) -> bool {
        if self.index < 4 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn add_final(&mut self, n: i64) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }

    fn write(&mut self) -> Option<[i64; 4]> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, ms] = self.comp;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        if !(between(hour, 0, 23) && between(minute, 0, 59) && between(second, 0, 59) && between(ms, 0, 999))
            && (hour != 24 || minute != 0 || second != 0 || ms != 0)
        {
            return None;
        }
        Some([hour, minute, second, ms])
    }
}

struct Day {
    comp: [i64; 3],
    index: usize,
    named_month: i64,
    iso: bool,
}

impl Day {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn add(&mut self, n: i64) -> bool {
        if self.index < 3 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn write(&mut self) -> Option<(i64, i64, i64)> {
        if self.index < 1 {
            return None;
        }
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let is_day = |x| between(x, 1, 31);
        let (mut year, month, day);
        if self.named_month == NONE {
            if self.iso || !is_day(self.comp[0]) {
                (year, month, day) = (self.comp[0], self.comp[1], self.comp[2]);
            } else {
                (month, day, year) = (self.comp[0], self.comp[1], self.comp[2]);
            }
        } else {
            month = self.named_month;
            if !is_day(self.comp[0]) {
                (year, day) = (self.comp[0], self.comp[1]);
            } else {
                (day, year) = (self.comp[0], self.comp[1]);
            }
        }
        if !self.iso {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !(between(year, -(1 << 31), (1 << 31) - 1) && between(month, 1, 12) && is_day(day)) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

/* ------------------------------------------------------------------ the grammar */

fn parse(units: &[u16]) -> Option<Parsed> {
    let mut scanner = Tokenizer::new(units);
    let mut tz = TimeZone { sign: NONE, hour: NONE, minute: NONE };
    let mut time = Time { comp: [0; 4], index: 0, hour_offset: NONE };
    let mut day = Day { comp: [0; 3], index: 0, named_month: NONE, iso: false };

    let next = es5(&mut scanner, &mut day, &mut time, &mut tz);
    if next == Token::Invalid {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    let mut token = next;
    while token != Token::EndOfInput {
        match token {
            Token::Number { value: n, length: _ } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    let ms = read_milliseconds(scanner.next());
                    if ms < 0 {
                        return None;
                    }
                    time.add_final(ms);
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    let peek = scanner.peek();
                    if !(peek == Token::EndOfInput
                        || peek == Token::WhiteSpace
                        || peek.is_keyword_z()
                        || peek.is_ascii_sign())
                    {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == Keyword::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == Keyword::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol(b'-');
                } else if kind == Keyword::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // Garbage words are illegal once a number has been read, and must be
                    // separated from the first number.
                    if has_read_number || scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            t if t.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
                tz.sign = if t.ascii_sign() < 0 { -1 } else { 1 };
                let (mut n, mut length) = (0, 0);
                if let Token::Number { value, length: l } = scanner.peek() {
                    scanner.next();
                    (n, length) = (value, l);
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 1 || length == 2 {
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 3 || length == 4 {
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return None;
                }
            }
            t if (t.is_ascii_sign() || t.is_symbol(b')')) && has_read_number => return None,
            _ => {}
        }
        token = scanner.next();
    }

    let (year, month, d) = day.write()?;
    let [hour, minute, second, ms] = time.write()?;
    let utc_offset = tz.write()?;
    Some(Parsed { year, month, day: d, hour, minute, second, ms, utc_offset })
}

fn read_milliseconds(token: Token) -> i64 {
    let Token::Number { value, length } = token else { return -1 };
    let mut number = value;
    if length == 1 {
        number *= 100;
    } else if length == 2 {
        number *= 10;
    } else if length > 3 {
        let mut length = length.min(MAX_SIGNIFICANT_DIGITS);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

/// `[('-'|'+')yy]yyyy[-MM[-DD]][THH:mm[:ss[.sss]][Z|(+|-)hh:mm]]`. Returns the token the
/// legacy grammar continues with, `EndOfInput` when the whole string was an ES5 date, or
/// `Invalid`.
fn es5(scanner: &mut Tokenizer<'_>, day: &mut Day, time: &mut Time, tz: &mut TimeZone) -> Token {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 12) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 31) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !scanner.peek().is_keyword_type(Keyword::TimeSeparator) {
        if scanner.peek() != Token::EndOfInput {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return Token::Invalid;
        }
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !between(scanner.peek().number(), 0, 59)
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return Token::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !between(scanner.peek().number(), 0, 59)
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_ascii_sign() {
            tz.sign = scanner.next().ascii_sign();
            if scanner.peek().is_fixed_length_number(4) {
                let hourmin = scanner.next().number();
                let (hour, min) = (hourmin / 100, hourmin % 100);
                if !between(hour, 0, 23) || !between(min, 0, 59) {
                    return Token::Invalid;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 23) {
                    return Token::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return Token::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 59) {
                    return Token::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if scanner.peek() != Token::EndOfInput {
            return Token::Invalid;
        }
    }
    // A date-only form is UTC; a date-time is local time, which is UTC here too.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.iso = true;
    Token::EndOfInput
}

/* ------------------------------------------------------------------ the time value */

const MIN_YEAR: i64 = -1_000_000;
const MAX_YEAR: i64 = 1_000_000;

/// ECMAScript's MakeDay, with V8's year bounds.
fn make_day(year: i64, month: i64, date: i64) -> f64 {
    if !(between(year, MIN_YEAR, MAX_YEAR) && between(month, -10_000_000, 10_000_000)) {
        return f64::NAN;
    }
    let mut y = year + month / 12;
    let mut m = month % 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    const YEAR_DELTA: i64 = 399_999;
    let days = |y: i64| 365 * (y + YEAR_DELTA) + (y + YEAR_DELTA) / 4 - (y + YEAR_DELTA) / 100 + (y + YEAR_DELTA) / 400;
    let mut day_from_year = days(y) - days(1970);
    const COMMON: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    let leap = !(y % 4 != 0 || (y % 100 == 0 && y % 400 != 0));
    day_from_year += if leap { LEAP } else { COMMON }[m as usize];
    (day_from_year - 1 + date) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_v8_reads() {
        for (text, ok) in [
            ("2026-03-01", true),
            ("2026-03-01T10:00:00.123Z", true),
            ("2026-03-01T25:00:00Z", false),
            ("2026-13-01", false),
            ("March 1, 2026", true),
            ("1", true),
            ("abc 2026", true),
            ("2026 abc", false),
            ("s 1 2026", false),
            ("Jan 1 1970 13:00 PM", false),
            ("Mar 1 2026 GMT+999999999:00", true),
            ("275760-09-13", true),
            ("+275760-09-13T00:00:00.001Z", false),
            ("1/1/999999", false),
            ("2026-03-01\u{0}garbage", true),
            ("Jan 1 2026 \u{2028}", false),
            ("", false),
        ] {
            assert_eq!(parses(text), ok, "{text:?}");
        }
    }
}
