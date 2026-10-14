// SPDX-License-Identifier: MIT

//! Text as JavaScript reads it: its white space, and lengths and offsets in UTF-16 code units.

/// White space as JavaScript's `\s` and `trim` see it.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `\s`, for a regular expression.
pub const SPACE: &str =
    r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// A string's length in UTF-16 code units, as JavaScript counts it.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(from, to)` over UTF-16 code units.
pub fn slice(text: &str, from: usize, to: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let to = to.min(units.len());
    let from = from.min(to);
    String::from_utf16_lossy(&units[from..to])
}

/// The UTF-16 offset of a byte offset into `text`.
pub fn offset(text: &str, byte: usize) -> usize {
    length(&text[..byte])
}

/// JavaScript's `toLowerCase`.
pub fn lower(text: &str) -> String {
    text.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_count_utf16_units() {
        assert_eq!(length("é𝒳"), 3);
        assert_eq!(offset("é𝒳 {{", 7), 4);
        assert_eq!(slice("abcdef", 2, 4), "cd");
        assert_eq!(trim("\u{feff} a \u{a0}"), "a");
    }
}
