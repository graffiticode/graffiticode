// SPDX-License-Identifier: MIT

//! Dates as the TypeScript compiler reads and writes them.
//!
//! `format` turns numbers and date strings into text with an Excel date pattern
//! (`packages/core/src/dates.ts`). What counts as a date string is whatever V8's `Date.parse`
//! reads — ISO 8601 and V8's lenient legacy forms (`"Nov 3 2024"`, `"2024/11/03 10:15"`) —
//! so [`parse`] is a port of V8's date parser (`src/date/dateparser-inl.h`). Everything is
//! UTC: the server runs with `TZ=UTC`, which is where V8's "local time" falls too.

const MS_PER_DAY: f64 = 86_400_000.0;
const MAX_TIME: f64 = 8.64e15;

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// ECMAScript `TimeClip`.
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > MAX_TIME { f64::NAN } else { t.trunc() + 0.0 }
}

/// Days from 1970-01-01 to the first of a month (`month` 0-based, any integer).
fn make_day(year: i64, month: i64, day: i64) -> i64 {
    let year = year + month.div_euclid(12);
    let month = month.rem_euclid(12) + 1;
    days_from_civil(year, month, 1) + day - 1
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A valid time value broken into its UTC fields.
#[derive(Clone, Copy, Debug)]
pub struct Fields {
    pub year: i64,
    /// 0-based.
    pub month: i64,
    pub day: i64,
    pub weekday: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub ms: i64,
}

pub fn fields(t: f64) -> Option<Fields> {
    if t.is_nan() {
        return None;
    }
    let t = t as i64;
    let days = t.div_euclid(MS_PER_DAY as i64);
    let in_day = t.rem_euclid(MS_PER_DAY as i64);
    let (year, month, day) = civil_from_days(days);
    Some(Fields {
        year,
        month: month - 1,
        day,
        weekday: (days + 4).rem_euclid(7),
        hour: in_day / 3_600_000,
        minute: in_day / 60_000 % 60,
        second: in_day / 1000 % 60,
        ms: in_day % 1000,
    })
}

/// `Date.prototype.toISOString`, or `None` for an invalid date (whose `toJSON` is `null`).
pub fn to_iso_string(t: f64) -> Option<String> {
    let f = fields(t)?;
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else if f.year < 0 {
        format!("-{:06}", -f.year)
    } else {
        format!("+{:06}", f.year)
    };
    Some(format!("{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", f.month + 1, f.day, f.hour, f.minute, f.second, f.ms))
}

/// `Date.prototype.toString` in UTC.
pub fn to_string(t: f64) -> String {
    let Some(f) = fields(t) else { return "Invalid Date".to_owned() };
    format!(
        "{} {} {:02} {:04} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        &DAYS[f.weekday as usize][..3],
        &MONTHS[f.month as usize][..3],
        f.day,
        f.year,
        f.hour,
        f.minute,
        f.second
    )
}

/* ------------------------------------------------------------- Date.parse */

const NONE: i64 = i64::MIN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeywordType {
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
    Number { value: i64, length: usize },
    Symbol(u16),
    WhiteSpace,
    Keyword { kind: KeywordType, value: i64, length: usize },
    End,
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
        *self == Token::Symbol(u16::from(c))
    }
    fn is_ascii_sign(&self) -> bool {
        self.is_symbol(b'+') || self.is_symbol(b'-')
    }
    fn ascii_sign(&self) -> i64 {
        if self.is_symbol(b'+') { 1 } else { -1 }
    }
    fn is_keyword_z(&self) -> bool {
        matches!(self, Token::Keyword { kind: KeywordType::TimeZoneName, value: 0, length: 1 })
    }
}

const KEYWORDS: [([u8; 3], KeywordType, i64); 27] = [
    (*b"jan", KeywordType::MonthName, 1),
    (*b"feb", KeywordType::MonthName, 2),
    (*b"mar", KeywordType::MonthName, 3),
    (*b"apr", KeywordType::MonthName, 4),
    (*b"may", KeywordType::MonthName, 5),
    (*b"jun", KeywordType::MonthName, 6),
    (*b"jul", KeywordType::MonthName, 7),
    (*b"aug", KeywordType::MonthName, 8),
    (*b"sep", KeywordType::MonthName, 9),
    (*b"oct", KeywordType::MonthName, 10),
    (*b"nov", KeywordType::MonthName, 11),
    (*b"dec", KeywordType::MonthName, 12),
    (*b"am\0", KeywordType::AmPm, 0),
    (*b"pm\0", KeywordType::AmPm, 12),
    (*b"ut\0", KeywordType::TimeZoneName, 0),
    (*b"utc", KeywordType::TimeZoneName, 0),
    (*b"z\0\0", KeywordType::TimeZoneName, 0),
    (*b"gmt", KeywordType::TimeZoneName, 0),
    (*b"cdt", KeywordType::TimeZoneName, -5),
    (*b"cst", KeywordType::TimeZoneName, -6),
    (*b"edt", KeywordType::TimeZoneName, -4),
    (*b"est", KeywordType::TimeZoneName, -5),
    (*b"mdt", KeywordType::TimeZoneName, -6),
    (*b"mst", KeywordType::TimeZoneName, -7),
    (*b"pdt", KeywordType::TimeZoneName, -7),
    (*b"pst", KeywordType::TimeZoneName, -8),
    (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

fn keyword(prefix: [u32; 3], length: usize) -> (KeywordType, i64) {
    for (word, kind, value) in KEYWORDS {
        if (0..3).all(|j| prefix[j] == u32::from(word[j])) && (length <= 3 || kind == KeywordType::MonthName) {
            return (kind, value);
        }
    }
    (KeywordType::Invalid, 0)
}

fn is_white_space(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(|c| crate::js::is_space(c) || c == '\u{2028}' || c == '\u{2029}')
}

struct Scanner {
    text: Vec<u16>,
    pos: usize,
    next: Token,
}

impl Scanner {
    fn new(text: &str) -> Self {
        let mut scanner = Scanner { text: text.encode_utf16().collect(), pos: 0, next: Token::End };
        scanner.next = scanner.scan();
        scanner
    }

    fn ch(&self) -> Option<u16> {
        self.text.get(self.pos).copied()
    }

    fn is_digit(&self) -> bool {
        self.ch().is_some_and(|c| (u16::from(b'0')..=u16::from(b'9')).contains(&c))
    }

    fn scan(&mut self) -> Token {
        let start = self.pos;
        let Some(c) = self.ch() else { return Token::End };
        if self.is_digit() {
            let mut n: i64 = 0;
            let mut i = 0;
            while self.ch() == Some(u16::from(b'0')) {
                self.pos += 1;
            }
            while self.is_digit() {
                if i < 9 {
                    n = n * 10 + i64::from(self.ch().unwrap_or(0) - u16::from(b'0'));
                }
                i += 1;
                self.pos += 1;
            }
            return Token::Number { value: n, length: self.pos - start };
        }
        for symbol in *b":-+.)" {
            if c == u16::from(symbol) {
                self.pos += 1;
                return Token::Symbol(c);
            }
        }
        if c >= u16::from(b'A') && !is_white_space(c) {
            let mut prefix = [0u32; 3];
            let mut length = 0;
            while let Some(c) = self.ch().filter(|c| *c >= u16::from(b'A') && !is_white_space(*c)) {
                if length < 3 {
                    prefix[length] = u32::from(c | 0x20);
                }
                length += 1;
                self.pos += 1;
            }
            let (kind, value) = keyword(prefix, length);
            return Token::Keyword { kind, value, length };
        }
        if is_white_space(c) {
            while self.ch().is_some_and(is_white_space) {
                self.pos += 1;
            }
            return Token::WhiteSpace;
        }
        if c == u16::from(b'(') {
            let mut depth = 0;
            while let Some(c) = self.ch() {
                if c == u16::from(b')') {
                    depth -= 1;
                    if depth == 0 {
                        self.pos += 1;
                        break;
                    }
                } else if c == u16::from(b'(') {
                    depth += 1;
                }
                self.pos += 1;
            }
            return Token::Unknown;
        }
        self.pos += 1;
        Token::Unknown
    }

    fn next(&mut self) -> Token {
        let token = self.next;
        self.next = self.scan();
        token
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn skip_symbol(&mut self, c: u8) -> bool {
        if self.next.is_symbol(c) {
            self.next();
            true
        } else {
            false
        }
    }
}

fn between(x: i64, lo: i64, hi: i64) -> bool {
    (lo..=hi).contains(&x)
}

#[derive(Default)]
struct Day {
    comp: [i64; 3],
    index: usize,
    named_month: Option<i64>,
    iso: bool,
}

impl Day {
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
        let (mut year, month, day);
        match self.named_month {
            None => {
                if self.iso || !between(self.comp[0], 1, 31) {
                    (year, month, day) = (self.comp[0], self.comp[1], self.comp[2]);
                } else {
                    (month, day, year) = (self.comp[0], self.comp[1], self.comp[2]);
                }
            }
            Some(named) => {
                month = named;
                if !between(self.comp[0], 1, 31) {
                    (year, day) = (self.comp[0], self.comp[1]);
                } else {
                    (day, year) = (self.comp[0], self.comp[1]);
                }
            }
        }
        if !self.iso {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !between(year, -(1 << 30), (1 << 30) - 1) || !between(month, 1, 12) || !between(day, 1, 31) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

struct Time {
    comp: [i64; 4],
    index: usize,
    hour_offset: i64,
}

impl Time {
    fn new() -> Self {
        Time { comp: [0; 4], index: 0, hour_offset: NONE }
    }
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

struct Zone {
    sign: i64,
    hour: i64,
    minute: i64,
}

impl Zone {
    fn new() -> Self {
        Zone { sign: NONE, hour: NONE, minute: NONE }
    }
    fn set(&mut self, offset_hours: i64) {
        self.sign = if offset_hours < 0 { -1 } else { 1 };
        self.hour = offset_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i64) {
        self.sign = if sign < 0 { -1 } else { 1 };
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
    /// The offset in seconds, or `None` for local time.
    fn write(&mut self) -> Result<Option<i64>, ()> {
        if self.sign == NONE {
            return Ok(None);
        }
        if self.hour == NONE {
            self.hour = 0;
        }
        if self.minute == NONE {
            self.minute = 0;
        }
        let total = self.hour.wrapping_mul(3600).wrapping_add(self.minute.wrapping_mul(60));
        if !(0..=(1 << 30) - 1).contains(&total) {
            return Err(());
        }
        Ok(Some(if self.sign < 0 { -total } else { total }))
    }
}

fn read_milliseconds(token: Token) -> i64 {
    let Token::Number { value, length } = token else { return 0 };
    let mut number = value;
    let mut length = length;
    if length == 1 {
        number *= 100;
    } else if length == 2 {
        number *= 10;
    } else if length > 3 {
        length = length.min(9);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

fn parse_es5(scanner: &mut Scanner, day: &mut Day, time: &mut Time, tz: &mut Zone) -> Token {
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
        let year = scanner.next().number();
        day.add(year);
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 12) {
            return scanner.next();
        }
        let month = scanner.next().number();
        day.add(month);
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 31) {
                return scanner.next();
            }
            let d = scanner.next().number();
            day.add(d);
        }
    }
    if !matches!(scanner.peek(), Token::Keyword { kind: KeywordType::TimeSeparator, .. }) {
        if scanner.peek() != Token::End {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return Token::Invalid;
        }
        let hour_is_24 = scanner.peek().number() == 24;
        let hour = scanner.next().number();
        time.add(hour);
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !between(scanner.peek().number(), 0, 59)
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return Token::Invalid;
        }
        let minute = scanner.next().number();
        time.add(minute);
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !between(scanner.peek().number(), 0, 59)
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return Token::Invalid;
            }
            let second = scanner.next().number();
            time.add(second);
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return Token::Invalid;
                }
                let ms = read_milliseconds(scanner.next());
                time.add(ms);
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_ascii_sign() {
            let sign = scanner.next().ascii_sign();
            tz.set_sign(sign);
            if scanner.peek().is_fixed_length_number(4) {
                let hourmin = scanner.next().number();
                let (hour, minute) = (hourmin / 100, hourmin % 100);
                if !between(hour, 0, 23) || !between(minute, 0, 59) {
                    return Token::Invalid;
                }
                tz.hour = hour;
                tz.minute = minute;
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
        if scanner.peek() != Token::End {
            return Token::Invalid;
        }
    }
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.iso = true;
    Token::End
}

/// `Date.parse(text)`: the time value, or NaN.
pub fn parse(text: &str) -> f64 {
    let mut scanner = Scanner::new(text);
    let mut day = Day::default();
    let mut time = Time::new();
    let mut tz = Zone::new();
    let mut token = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
    if token == Token::Invalid {
        return f64::NAN;
    }
    let mut has_read_number = day.index > 0;
    while token != Token::End {
        match token {
            Token::Number { value: n, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if !time.is_empty() {
                            return f64::NAN;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        if !time.add(n) {
                            return f64::NAN;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return f64::NAN;
                    }
                    let ms = read_milliseconds(scanner.next());
                    if ms < 0 {
                        return f64::NAN;
                    }
                    time.add_final(ms);
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    let peek = scanner.peek();
                    if peek != Token::End && peek != Token::WhiteSpace && !peek.is_keyword_z() && !peek.is_ascii_sign()
                    {
                        return f64::NAN;
                    }
                } else {
                    if !day.add(n) {
                        return f64::NAN;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == KeywordType::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == KeywordType::MonthName {
                    day.named_month = Some(value);
                    scanner.skip_symbol(b'-');
                } else if kind == KeywordType::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    if has_read_number {
                        return f64::NAN;
                    }
                    if scanner.peek().is_number() {
                        return f64::NAN;
                    }
                }
            }
            t if t.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
                tz.set_sign(t.ascii_sign());
                let (mut n, mut length) = (0, 0);
                if let Token::Number { value, length: l } = scanner.peek() {
                    scanner.next();
                    (n, length) = (value, l);
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 2 || length == 1 {
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 4 || length == 3 {
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return f64::NAN;
                }
            }
            t if (t.is_ascii_sign() || t.is_symbol(b')')) && has_read_number => return f64::NAN,
            _ => {}
        }
        token = scanner.next();
    }
    let Some((year, month, d)) = day.write() else { return f64::NAN };
    let Some([hour, minute, second, ms]) = time.write() else { return f64::NAN };
    let Ok(offset) = tz.write() else { return f64::NAN };
    let days = make_day(year, month, d) as f64;
    let time_ms = (hour * 3_600_000 + minute * 60_000 + second * 1000 + ms) as f64;
    let mut t = days * MS_PER_DAY + time_ms;
    if let Some(offset) = offset {
        t -= offset as f64 * 1000.0;
    }
    time_clip(t)
}

/* ---------------------------------------------------------------- format */

/// A pattern is a date pattern when, outside quoted text, it uses y, d, h or s.
pub fn is_date_pattern(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"'
            && let Some(end) = chars[i + 1..].iter().position(|c| *c == '"')
        {
            i += end + 2;
            continue;
        }
        if c == '\\' && chars.get(i + 1).is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
            i += 2;
            continue;
        }
        if matches!(c.to_ascii_lowercase(), 'y' | 'd' | 'h' | 's') {
            return true;
        }
        i += 1;
    }
    false
}

/// The date a value stands for: a number is a Unix time (seconds below 1e11, else
/// milliseconds), a string whatever `Date.parse` reads. `None` when it is neither.
pub fn to_date(value: &crate::js::Js) -> Option<f64> {
    use crate::js::Js;
    match value {
        Js::Num(n) if n.is_finite() => Some(time_clip(if n.abs() < 1e11 { n * 1000.0 } else { *n })),
        Js::Str(s) if !crate::js::trim(s).is_empty() => {
            let t = parse(s);
            (!t.is_nan()).then_some(t)
        }
        _ => None,
    }
}

enum Part {
    Code(String),
    Text(String),
}

fn tokenize(pattern: &str) -> Vec<Part> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let end = chars[i + 1..].iter().position(|c| *c == '"').map(|e| e + i + 1);
            out.push(Part::Text(chars[i + 1..end.unwrap_or(chars.len())].iter().collect()));
            i = end.map_or(chars.len(), |e| e + 1);
        } else if c == '\\' {
            out.push(Part::Text(chars.get(i + 1).map(char::to_string).unwrap_or_default()));
            i += 2;
        } else if chars.len() - i >= 5 && chars[i..i + 5].iter().collect::<String>().eq_ignore_ascii_case("am/pm") {
            out.push(Part::Code("AM/PM".to_owned()));
            i += 5;
        } else if matches!(c.to_ascii_lowercase(), 'y' | 'm' | 'd' | 'h' | 's') {
            let mut j = i;
            while j < chars.len() && chars[j].eq_ignore_ascii_case(&c) {
                j += 1;
            }
            out.push(Part::Code(chars[i..j].iter().collect::<String>().to_lowercase()));
            i = j;
        } else {
            out.push(Part::Text(c.to_string()));
            i += 1;
        }
    }
    out
}

fn pad(n: i64) -> String {
    format!("{n:02}")
}

/// Format a time value with an Excel date pattern, in UTC. An invalid date fails as the
/// TypeScript does: the names it would index are `undefined`.
pub fn format_date(pattern: &str, t: f64) -> Result<String, String> {
    let parts = tokenize(pattern);
    let codes: Vec<(usize, &str)> = parts
        .iter()
        .enumerate()
        .filter_map(|(i, p)| match p {
            Part::Code(code) => Some((i, code.as_str())),
            Part::Text(_) => None,
        })
        .collect();
    let ampm = codes.iter().any(|(_, code)| *code == "AM/PM");
    let f = fields(t);
    let num = |get: fn(&Fields) -> i64| f.as_ref().map_or_else(|| "NaN".to_owned(), |f| get(f).to_string());
    let padded = |get: fn(&Fields) -> i64| f.as_ref().map_or_else(|| "NaN".to_owned(), |f| pad(get(f)));
    let undefined_slice = || Err("Cannot read properties of undefined (reading 'slice')".to_owned());
    let mut out = String::new();
    for (i, part) in parts.iter().enumerate() {
        let code = match part {
            Part::Text(text) => {
                out.push_str(text);
                continue;
            }
            Part::Code(code) => code.as_str(),
        };
        if code == "m" || code == "mm" {
            let k = codes.iter().position(|(at, _)| *at == i).unwrap_or(0);
            let minutes =
                (k > 0 && codes[k - 1].1.starts_with('h')) || codes.get(k + 1).is_some_and(|c| c.1.starts_with('s'));
            if minutes {
                out.push_str(&if code == "mm" { padded(|f| f.minute) } else { num(|f| f.minute) });
                continue;
            }
        }
        let hour12 = |f: &Fields| if f.hour % 12 == 0 { 12 } else { f.hour % 12 };
        let text = match code {
            "yyyy" | "yyy" => num(|f| f.year),
            "yy" | "y" => padded(|f| f.year % 100),
            "mmmmm" => match &f {
                Some(f) => MONTHS[f.month as usize][..1].to_owned(),
                None => return Err("Cannot read properties of undefined (reading '0')".to_owned()),
            },
            "mmmm" => f.map_or_else(String::new, |f| MONTHS[f.month as usize].to_owned()),
            "mmm" => match &f {
                Some(f) => MONTHS[f.month as usize][..3].to_owned(),
                None => return undefined_slice(),
            },
            "mm" => padded(|f| f.month + 1),
            "m" => num(|f| f.month + 1),
            "dddd" => f.map_or_else(String::new, |f| DAYS[f.weekday as usize].to_owned()),
            "ddd" => match &f {
                Some(f) => DAYS[f.weekday as usize][..3].to_owned(),
                None => return undefined_slice(),
            },
            "dd" => padded(|f| f.day),
            "d" => num(|f| f.day),
            "hh" | "h" => {
                let hour = match (&f, ampm) {
                    (Some(f), true) => Some(hour12(f)),
                    (Some(f), false) => Some(f.hour),
                    (None, true) => Some(12),
                    (None, false) => None,
                };
                match hour {
                    Some(h) if code == "hh" => pad(h),
                    Some(h) => h.to_string(),
                    None => "NaN".to_owned(),
                }
            }
            "ss" => padded(|f| f.second),
            "s" => num(|f| f.second),
            "AM/PM" => if f.is_some_and(|f| f.hour < 12) { "AM" } else { "PM" }.to_owned(),
            other => other.to_owned(),
        };
        out.push_str(&text);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(text: &str) -> Option<String> {
        to_iso_string(parse(text))
    }

    #[test]
    fn parses_what_v8_parses() {
        assert_eq!(iso("2024-11-03").as_deref(), Some("2024-11-03T00:00:00.000Z"));
        assert_eq!(iso("2024-11-03T10:15Z").as_deref(), Some("2024-11-03T10:15:00.000Z"));
        assert_eq!(iso("2024-03-05T14:07:00+01:00").as_deref(), Some("2024-03-05T13:07:00.000Z"));
        assert_eq!(iso("Nov 3 2024").as_deref(), Some("2024-11-03T00:00:00.000Z"));
        assert_eq!(iso("2024/11/03 10:15").as_deref(), Some("2024-11-03T10:15:00.000Z"));
        assert_eq!(iso("hello 2").as_deref(), Some("2001-02-01T00:00:00.000Z"));
        assert_eq!(iso("2024-02-30").as_deref(), Some("2024-03-01T00:00:00.000Z"));
        assert_eq!(iso("soon"), None);
        assert_eq!(iso("2024-13-01"), None);
    }

    #[test]
    fn formats_in_utc() {
        let t = parse("2024-03-05T14:07:00Z");
        assert_eq!(format_date("mm/dd h:mm AM/PM", t).unwrap(), "03/05 2:07 PM");
        assert_eq!(
            format_date("dddd, mmmm d \"at\" hh\"h\"", parse("2024-03-05T09:00:00Z")).unwrap(),
            "Tuesday, March 5 at 09h"
        );
        assert_eq!(format_date("yyyy mmmm", f64::NAN).unwrap(), "NaN ");
        assert!(format_date("mmm", f64::NAN).is_err());
        assert_eq!(to_string(t), "Tue Mar 05 2024 14:07:00 GMT+0000 (Coordinated Universal Time)");
    }
}
