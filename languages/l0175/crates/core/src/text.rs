// SPDX-License-Identifier: MIT

//! Text measures the composer needs: normalising, splitting prose into sentences, estimating
//! a reading level, and a seeded shuffle.
//!
//! These are held to the TypeScript compiler's results exactly, because an item's option
//! order, its warnings and its selectable sentences all follow from them. Where that means
//! JavaScript's notion of something (a string's length, what counts as white space, how a
//! half rounds), the function says so.

use std::cmp::Ordering;

/// White space as JavaScript's `\s` and `trim` see it.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// Words separated by white space, none of them empty.
pub fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_space).filter(|word| !word.is_empty())
}

/// A string's length as JavaScript counts it, in UTF-16 code units. Lengths appear in
/// warnings and weigh on a distractor's score, so they are counted the same way.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Text reduced to what two options must differ in to count as different: lowercase letters,
/// digits and single spaces.
pub fn norm(text: &str) -> String {
    let lower = text.to_lowercase();
    let kept = lower.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == ' ');
    let mut out = String::new();
    for c in kept {
        if c != ' ' || !(out.is_empty() || out.ends_with(' ')) {
            out.push(c);
        }
    }
    out.truncate(out.trim_end_matches(' ').len());
    out
}

/// A passage heading as an id: lowercase, each run of anything else a hyphen.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { "p".to_owned() } else { out.to_owned() }
}

/// Abbreviations whose full stop does not end a sentence. Grade 5 literary prose is full of
/// honorifics ("Mr. Ruiz never learned who had fixed his porch."), and splitting at each would
/// make "Mr." a sentence a student could click.
const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "hon", "capt", "gen", "sgt", "lt", "col", "sen", "gov", "pres",
    "jr", "sr", "st", "mt", "ft", "rd", "ave", "blvd", "no", "vs", "etc", "approx", "dept",
];

/// Whether a piece of text stops inside an abbreviation: a known one ("Mr."), an initial
/// ("J.") or a dotted pair ("a.m.").
fn ends_mid_abbreviation(piece: &str) -> bool {
    let Some(body) = piece.strip_suffix('.') else { return false };
    let chars: Vec<char> = body.chars().collect();
    let before = |len: usize| chars.len().checked_sub(len + 1).map(|at| chars[at]);
    let starts_word = |len: usize| before(len).is_none_or(is_space);
    let known = ABBREVIATIONS.iter().any(|abbreviation| {
        let len = abbreviation.len();
        chars.len() >= len
            && chars[chars.len() - len..].iter().map(char::to_ascii_lowercase).eq(abbreviation.chars())
            && before(len).is_none_or(|c| is_space(c) || matches!(c, '(' | '"' | '\'' | '‘' | '“'))
    });
    let initial = matches!(chars.last(), Some(c) if c.is_ascii_alphabetic()) && starts_word(1);
    let pair = matches!(chars[chars.len().saturating_sub(3)..], [a, '.', b] if a.is_ascii_alphabetic() && b.is_ascii_alphabetic())
        && starts_word(3);
    known || initial || pair
}

/// A paragraph as sentences, for Hot Text: each run up to its closing punctuation, with any
/// closing quote or bracket, rejoined where the break fell inside an abbreviation. Text after
/// the last full stop is not a sentence, unless there is no full stop at all.
///
/// A heuristic. An occasional dialogue tag is split wrongly; what is correct in an item is
/// anchored to authored quotes, not to this.
pub fn sentences(text: &str) -> Vec<String> {
    let text = trim(text);
    if text.is_empty() {
        return Vec::new();
    }
    let ends = |c: char| matches!(c, '.' | '!' | '?');
    let chars: Vec<char> = text.chars().collect();
    let mut pieces: Vec<String> = Vec::new();
    let mut matched = false;
    let mut at = 0;
    while at < chars.len() {
        if ends(chars[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len() && !ends(chars[at]) {
            at += 1;
        }
        if at == chars.len() {
            break;
        }
        while at < chars.len() && ends(chars[at]) {
            at += 1;
        }
        while at < chars.len() && matches!(chars[at], '"' | '\'' | '”' | '’' | ')' | ']') {
            at += 1;
        }
        while at < chars.len() && is_space(chars[at]) {
            at += 1;
        }
        matched = true;
        let piece: String = chars[start..at].iter().collect();
        let piece = trim(&piece);
        if piece.is_empty() {
            continue;
        }
        match pieces.last_mut() {
            Some(last) if ends_mid_abbreviation(last) => {
                last.push(' ');
                last.push_str(piece);
            }
            _ => pieces.push(piece.to_owned()),
        }
    }
    if matched { pieces } else { vec![text.to_owned()] }
}

/// A rough syllable count: runs of vowels, less a silent final "e", at least one.
fn syllables(word: &str) -> usize {
    let letters: Vec<char> = word.chars().filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_lowercase()).collect();
    if letters.is_empty() {
        return 0;
    }
    let vowel = |c: &char| matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
    let mut count = letters.chunk_by(|a, b| vowel(a) == vowel(b)).filter(|run| vowel(&run[0])).count();
    if let [.., before, 'e'] = letters[..]
        && letters.len() > 2
        && !vowel(&before)
    {
        count = count.saturating_sub(1);
    }
    count.max(1)
}

/// The words a reading-level formula counts: runs of letters, with one inner apostrophe.
fn prose_words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut found = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if !chars[at].is_ascii_alphabetic() {
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len() && chars[at].is_ascii_alphabetic() {
            at += 1;
        }
        if chars.get(at) == Some(&'\'') && chars.get(at + 1).is_some_and(char::is_ascii_alphabetic) {
            at += 1;
            while at < chars.len() && chars[at].is_ascii_alphabetic() {
                at += 1;
            }
        }
        found.push(chars[start..at].iter().collect());
    }
    found
}

/// The Flesch–Kincaid grade level of a block of prose, or `None` for fewer than twenty words.
/// A proxy for complexity: enough to flag prose that reads well above its grade.
pub fn grade_level(text: &str) -> Option<f64> {
    let sentences = sentences(text).len();
    let words = prose_words(text);
    if sentences == 0 || words.len() < 20 {
        return None;
    }
    let syllables: usize = words.iter().map(|word| syllables(word)).sum();
    let words = words.len() as f64;
    Some(0.39 * (words / sentences as f64) + 11.8 * (syllables as f64 / words) - 15.59)
}

/// The order ids are ranked in when scores tie: the order JavaScript's `localeCompare` gives
/// ASCII text. Punctuation sorts before digits and digits before letters; case only breaks a
/// tie between otherwise equal ids, lowercase first. Other characters follow, by code point.
pub fn collate(a: &str, b: &str) -> Ordering {
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
    let weight = |c: char| match c {
        c if c.is_ascii_alphabetic() => 100 + (c.to_ascii_lowercase() as u32 - 'a' as u32),
        c => ORDER.find(c).map_or(1000 + c as u32, |at| at as u32),
    };
    let upper = |c: char| c.is_ascii_uppercase();
    a.chars().map(weight).cmp(b.chars().map(weight)).then_with(|| a.chars().map(upper).cmp(b.chars().map(upper)))
}

/// A string's hash (FNV-1a over its UTF-16 code units), which seeds the shuffle.
pub fn hash(text: &str) -> u32 {
    text.encode_utf16().fold(2_166_136_261, |hash, unit| (hash ^ u32::from(unit)).wrapping_mul(16_777_619))
}

/// The mulberry32 generator: a sequence of numbers in `0..1` that depends only on its seed.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// Shuffles by a seed, so compiling the same program again labels its options the same way.
pub fn shuffle<T>(mut items: Vec<T>, seed: &str) -> Vec<T> {
    let mut random = Mulberry32(hash(seed));
    for i in (1..items.len()).rev() {
        let j = (random.next() * (i + 1) as f64).floor() as usize;
        items.swap(i, j);
    }
    items
}

/// Rounds to the nearest integer, a half going up, as JavaScript's `Math.round` does.
pub fn round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// One decimal place, a half going up, as JavaScript's `toFixed(1)` prints it.
pub fn one_decimal(x: f64) -> String {
    // Rust rounds an exact half to even; only quarters are exact halves at one decimal place.
    let quarters = x * 4.0;
    if quarters.fract() == 0.0 && quarters % 2.0 != 0.0 {
        format!("{:.1}", ((x * 10.0).floor() + 1.0) / 10.0)
    } else {
        format!("{x:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_keep_abbreviations_whole() {
        let split = |text| sentences(text);
        assert_eq!(split("Mr. Ruiz ran. He won."), ["Mr. Ruiz ran.", "He won."]);
        // Rejoined pieces are joined by a space, so a dotted pair comes back apart.
        assert_eq!(
            split("She left at 9 a.m. on Main St. and J. K. Lee saw."),
            ["She left at 9 a. m. on Main St. and J. K. Lee saw."]
        );
        assert_eq!(
            split("\"Stop!\" she cried. (Why?) No one knew..."),
            ["\"Stop!\"", "she cried.", "(Why?)", "No one knew..."]
        );
        assert_eq!(split("One. Two"), ["One."], "text after the last stop is dropped");
        assert_eq!(split("No stop at all"), ["No stop at all"]);
        assert_eq!(split("...Leading. Fine."), ["Leading.", "Fine."]);
        assert!(split("   ").is_empty());
    }

    #[test]
    fn norm_and_slug() {
        assert_eq!(norm("  Mara is ANGRY —\tat her\nbrother!  "), "mara is angry at herbrother");
        assert_eq!(slug("  ¡The Tide—Pool!  "), "the-tide-pool");
        assert_eq!(slug("???"), "p");
    }

    #[test]
    fn syllables_follow_the_vowel_group_heuristic() {
        for (word, count) in [
            ("cat", 1),
            ("table", 1),
            ("tree", 1),
            ("the", 1),
            ("be", 1),
            ("municipal", 4),
            ("rhythm", 1),
            ("x", 1),
            ("", 0),
        ] {
            assert_eq!(syllables(word), count, "{word}");
        }
        assert_eq!(
            prose_words("Rhythm isn't the lake's edge — o'clock's"),
            ["Rhythm", "isn't", "the", "lake's", "edge", "o'clock", "s"]
        );
    }

    #[test]
    fn ids_collate_as_javascript_orders_them() {
        let expected: Vec<String> = serde_json::from_str(include_str!("../tests/conformance/collation.json")).unwrap();
        let mut sorted = expected.clone();
        sorted.reverse();
        sorted.sort_by(|a, b| collate(a, b));
        assert_eq!(sorted, expected);
    }

    #[test]
    fn the_shuffle_is_the_typescript_shuffle() {
        // Values from the TypeScript implementation's strHash and seededShuffle.
        assert_eq!(hash("the-tide-pool:q1:ebsr:A"), 4_024_845_481);
        assert_eq!(shuffle(vec![0, 1, 2, 3, 4, 5], "the-tide-pool:q1:ebsr:A"), [1, 5, 0, 4, 3, 2]);
    }

    #[test]
    fn rounding_is_javascripts() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(one_decimal(7.25), "7.3");
        assert_eq!(one_decimal(7.75), "7.8");
        assert_eq!(one_decimal(7.349), "7.3");
        assert_eq!(one_decimal(9.96), "10.0");
    }
}
