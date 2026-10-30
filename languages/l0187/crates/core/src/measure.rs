// SPDX-License-Identifier: MIT

//! Text measurement under `FIGJAM_V1`: Inter Medium, shaped with rustybuzz (glyph substitution,
//! ligatures, kerning) over ttf-parser, wrapped greedily at UAX #14 break opportunities, and
//! broken inside a word only between grapheme clusters.
//!
//! Coverage policy (checked before measuring):
//! - a grapheme cluster Inter shapes without `.notdef` is measured normally;
//! - an emoji cluster Inter has no glyph for takes [`profile::EMOJI_ADVANCE_EMS`] and is
//!   reported as *modeled* only (FigJam draws it with a fallback font we do not have);
//! - any other `.notdef` cluster, and any strong right-to-left character, is unsupported text in
//!   `FIGJAM_V1`: a content limitation naming the character.
//!
//! The compiler emits the lines it measured; the preview draws exactly those, and the validator
//! re-measures each line with [`advance`].

use std::sync::LazyLock;

use rustybuzz::{Direction, Face, UnicodeBuffer};
use serde::Serialize;
use unicode_linebreak::{BreakOpportunity, linebreaks};
use unicode_segmentation::UnicodeSegmentation;

use crate::profile;

static FACE: LazyLock<Face<'static>> =
    LazyLock::new(|| Face::from_slice(profile::FONT, 0).expect("the embedded font parses"));

/// Text `FIGJAM_V1` cannot measure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unsupported {
    /// A character the font has no glyph for, and which is not an emoji.
    Missing(char),
    /// A strong right-to-left character.
    RightToLeft(char),
}

impl Unsupported {
    pub fn describe(&self) -> String {
        match self {
            Unsupported::Missing(c) => format!(
                "the character {c:?} (U+{:04X}) has no glyph in FIGJAM_V1's font, so it cannot be measured",
                *c as u32
            ),
            Unsupported::RightToLeft(c) => format!(
                "the character {c:?} (U+{:04X}) is right-to-left text, which FIGJAM_V1 does not lay out",
                *c as u32
            ),
        }
    }
}

/// A strong right-to-left character: the Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan and
/// Mandaic blocks and their presentation forms, and the supplementary RTL ranges.
fn is_rtl(c: char) -> bool {
    matches!(c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// A character that makes a grapheme cluster an emoji.
fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF | 0xFE0F | 0x20E3 | 0xE0020..=0xE007F)
}

struct Shaped {
    /// Advance of the glyphs the font has, in pixels.
    width: f64,
    /// Byte offsets of the clusters that came out as `.notdef`.
    missing: Vec<usize>,
}

fn shape(text: &str, size: f64) -> Shaped {
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    buffer.set_direction(Direction::LeftToRight);
    let glyphs = rustybuzz::shape(&FACE, &[], buffer);
    let scale = size / f64::from(FACE.units_per_em());
    let mut width = 0.0;
    let mut missing = Vec::new();
    for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
        if info.glyph_id == 0 {
            missing.push(info.cluster as usize);
        } else {
            width += f64::from(pos.x_advance) * scale;
        }
    }
    Shaped { width, missing }
}

/// The grapheme clusters that contain a `.notdef` glyph.
fn missing_clusters<'a>(text: &'a str, missing: &[usize]) -> Vec<&'a str> {
    if missing.is_empty() {
        return Vec::new();
    }
    text.grapheme_indices(true)
        .filter(|(start, g)| missing.iter().any(|m| (*start..start + g.len()).contains(m)))
        .map(|(_, g)| g)
        .collect()
}

/// Whether `text` is measurable under `FIGJAM_V1`, and how many emoji it models.
pub fn coverage(text: &str) -> Result<usize, Unsupported> {
    if let Some(c) = text.chars().find(|c| is_rtl(*c)) {
        return Err(Unsupported::RightToLeft(c));
    }
    let shaped = shape(text, 16.0);
    let mut emoji = 0;
    for cluster in missing_clusters(text, &shaped.missing) {
        if cluster.chars().any(is_emoji) {
            emoji += 1;
        } else if let Some(c) = cluster.chars().find(|c| !c.is_whitespace() && !c.is_control()) {
            return Err(Unsupported::Missing(c));
        }
    }
    Ok(emoji)
}

/// The advance of `text` at `size` pixels: its shaped width, with each emoji cluster the font
/// lacks at the profile's emoji advance. Text that failed [`coverage`] measures its missing
/// clusters the same way, so this never fails.
pub fn advance(text: &str, size: f64) -> f64 {
    let shaped = shape(text, size);
    let modeled = missing_clusters(text, &shaped.missing)
        .iter()
        .filter(|g| g.chars().any(|c| !c.is_whitespace() && !c.is_control()))
        .count();
    shaped.width + modeled as f64 * profile::EMOJI_ADVANCE_EMS * size
}

/// Running advances over a text shaped once: the width of any slice, to within kerning at its
/// edges.
struct Prefix {
    /// `sums[i]` is the advance of `text[..i]` at each char boundary `i` (and the end).
    sums: Vec<f64>,
}

impl Prefix {
    fn new(text: &str, size: f64) -> Prefix {
        let mut at = vec![0.0; text.len() + 1];
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        buffer.set_direction(Direction::LeftToRight);
        let glyphs = rustybuzz::shape(&FACE, &[], buffer);
        let scale = size / f64::from(FACE.units_per_em());
        let mut missing = Vec::new();
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            if info.glyph_id == 0 {
                missing.push(info.cluster as usize);
            } else {
                at[info.cluster as usize] += f64::from(pos.x_advance) * scale;
            }
        }
        for (start, g) in text.grapheme_indices(true) {
            if g.chars().any(|c| !c.is_whitespace() && !c.is_control())
                && missing.iter().any(|m| (start..start + g.len()).contains(m))
            {
                at[start] += profile::EMOJI_ADVANCE_EMS * size;
            }
        }
        let mut sums = vec![0.0; text.len() + 1];
        for i in 0..text.len() {
            sums[i + 1] = sums[i] + at[i];
        }
        Prefix { sums }
    }

    fn width(&self, a: usize, b: usize) -> f64 {
        self.sums[b] - self.sums[a]
    }
}

/// What ended a line, so the lines re-joined reproduce the text exactly.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "text")]
pub enum Break {
    /// A newline in the text (the newline itself, `\n` or `\r\n`).
    Hard(String),
    /// A wrap at a break opportunity; the white space consumed there.
    Soft(String),
    /// A word too long for the line, broken between grapheme clusters.
    Cluster,
    /// The end of the text; the white space it ends with.
    End(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Line {
    pub text: String,
    #[serde(rename = "break")]
    pub ends: Break,
    /// The line's measured advance in pixels.
    #[serde(skip)]
    pub width: f64,
}

impl Break {
    pub fn consumed(&self) -> &str {
        match self {
            Break::Hard(s) | Break::Soft(s) | Break::End(s) => s,
            Break::Cluster => "",
        }
    }
}

/// Re-joins lines into the text they were split from.
pub fn rejoin(lines: &[Line]) -> String {
    lines.iter().map(|l| format!("{}{}", l.text, l.ends.consumed())).collect()
}

/// The text a line shows, and the white space and newline after it that it consumes.
fn split_trailing(segment: &str) -> (&str, &str) {
    let visible = segment.trim_end_matches(|c: char| c.is_whitespace());
    (visible, &segment[visible.len()..])
}

fn line(text: &str, ends: Break, size: f64) -> Line {
    Line { text: text.to_owned(), width: advance(text, size), ends }
}

/// Wraps `text` at `size` pixels into lines no wider than `max` (no limit when `None`). Explicit
/// newlines always break. Every character appears in exactly one line or its break.
pub fn wrap(text: &str, size: f64, max: Option<f64>) -> Vec<Line> {
    let prefix = Prefix::new(text, size);
    let base = text.as_ptr() as usize;
    // A candidate is judged from the text shaped once; only one within a pixel of the limit is
    // shaped on its own, so the answer is always the exact one `advance` gives.
    let fits = |s: &str| {
        let Some(m) = max else { return true };
        let a = s.as_ptr() as usize - base;
        let estimate = prefix.width(a, a + s.len());
        if estimate < m - 1.0 {
            true
        } else if estimate > m + 1.0 {
            false
        } else {
            advance(s, size) <= m + 1e-9
        }
    };
    let mut lines = Vec::new();
    let mut start = 0;
    let mut last_fit: Option<usize> = None;
    let opportunities: Vec<(usize, BreakOpportunity)> = linebreaks(text).collect();
    let mut i = 0;
    while i < opportunities.len() {
        let (end, kind) = opportunities[i];
        let (visible, trailing) = split_trailing(&text[start..end]);
        if fits(visible) {
            if kind == BreakOpportunity::Mandatory {
                let ends = if end == text.len() && !trailing.contains('\n') && !trailing.contains('\r') {
                    Break::End(trailing.to_owned())
                } else {
                    Break::Hard(trailing.to_owned())
                };
                lines.push(line(visible, ends, size));
                start = end;
                last_fit = None;
            } else {
                last_fit = Some(end);
            }
            i += 1;
            continue;
        }
        if let Some(fit_end) = last_fit {
            // Wrap at the last opportunity that fitted, then reconsider this one.
            let (visible, trailing) = split_trailing(&text[start..fit_end]);
            lines.push(line(visible, Break::Soft(trailing.to_owned()), size));
            start = fit_end;
            last_fit = None;
            continue;
        }
        // One word wider than the line: break it between grapheme clusters, at least one per
        // line, then reconsider what is left.
        let mut cut = start;
        for (offset, g) in text[start..].grapheme_indices(true) {
            let candidate = start + offset + g.len();
            if cut > start && !fits(&text[start..candidate]) {
                break;
            }
            cut = candidate;
            if cut >= start + visible.len() {
                break;
            }
        }
        if cut >= start + visible.len() {
            // The whole visible segment fits after all (a rounding edge): take it as is.
            last_fit = Some(end);
            i += 1;
            continue;
        }
        lines.push(line(&text[start..cut], Break::Cluster, size));
        start = cut;
    }
    if lines.is_empty() || start < text.len() || matches!(lines.last().map(|l| &l.ends), Some(Break::Hard(_))) {
        let (visible, trailing) = split_trailing(&text[start..]);
        lines.push(line(visible, Break::End(trailing.to_owned()), size));
    }
    lines
}

/// A box: position relative to its owner, and size.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The area a shape of `kind` and size `w`×`h` holds its text in, centred: as wide and as tall as
/// the profile's calibrated bounds ([`profile::shape::text_width`], [`profile::shape::text_height`]).
pub fn content_box(kind: &str, w: f64, h: f64) -> Rect {
    let tw = profile::shape::text_width(kind, w, h);
    let th = profile::shape::text_height(kind, w, h).max(0.0);
    Rect { x: (w - tw) / 2.0, y: (h - th) / 2.0, w: tw, h: th }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|l| l.text.as_str()).collect()
    }

    #[test]
    fn widths_are_positive_and_scale_with_size() {
        let a = advance("Hello world", 16.0);
        let b = advance("Hello world", 32.0);
        assert!(a > 50.0 && a < 120.0, "{a}");
        assert!((b - 2.0 * a).abs() < 1e-6);
        assert_eq!(advance("", 16.0), 0.0);
    }

    #[test]
    fn shaping_applies_kerning() {
        // Kerning pulls "AV" tighter than "A" and "V" measured apart.
        assert!(advance("AV", 100.0) < advance("A", 100.0) + advance("V", 100.0));
    }

    #[test]
    fn wrapping_breaks_between_words_and_keeps_every_character() {
        let text = "Pairing helped us resolve the integration issues";
        let lines = wrap(text, 24.0, Some(200.0));
        assert!(lines.len() > 1);
        assert_eq!(rejoin(&lines), text);
        for l in &lines {
            assert!(l.width <= 200.0, "{l:?}");
            assert_eq!(l.width, advance(&l.text, 24.0));
        }
        assert!(matches!(lines.last().unwrap().ends, Break::End(_)));
    }

    #[test]
    fn hard_breaks_always_break() {
        let lines = wrap("one\ntwo\n\nthree", 16.0, None);
        assert_eq!(texts(&lines), ["one", "two", "", "three"]);
        assert_eq!(rejoin(&lines), "one\ntwo\n\nthree");
        let trailing = wrap("end\n", 16.0, None);
        assert_eq!(texts(&trailing), ["end", ""]);
        assert_eq!(rejoin(&trailing), "end\n");
    }

    #[test]
    fn a_long_word_breaks_between_clusters() {
        let text = "Supercalifragilisticexpialidocious";
        let lines = wrap(text, 24.0, Some(100.0));
        assert!(lines.len() > 2);
        assert_eq!(rejoin(&lines), text);
        assert!(lines.iter().all(|l| l.width <= 100.0));
        // Combining marks stay with their base character.
        let accented = "e\u{301}e\u{301}e\u{301}e\u{301}e\u{301}e\u{301}e\u{301}";
        let lines = wrap(accented, 24.0, Some(30.0));
        assert_eq!(rejoin(&lines), accented);
        assert!(lines.iter().all(|l| !l.text.starts_with('\u{301}')));
    }

    /// Many generated texts — words, runs of spaces, newlines, combining marks, emoji, long
    /// words — wrapped at many widths: every character survives, in order, and every line fits
    /// unless it is a single grapheme cluster wider than the line.
    #[test]
    fn wrapping_is_lossless_and_fits() {
        let pieces = ["a", "word", " ", "  ", "\n", "e\u{301}", "🚀", "Supercalifragilistic", "—", "x-y", "\r\n", "Ü"];
        let mut seed: u64 = 0x1872_0187;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n
        };
        for _ in 0..400 {
            let text: String = (0..next(24)).map(|_| pieces[next(pieces.len())]).collect();
            let width = [20.0, 60.0, 120.0, 300.0][next(4)];
            let lines = wrap(&text, 16.0, Some(width));
            assert_eq!(rejoin(&lines), text, "{text:?} at {width}");
            for l in &lines {
                let one_cluster = l.text.graphemes(true).count() <= 1;
                assert!(l.width <= width + 1e-9 || one_cluster, "{l:?} in {text:?} at {width}");
                assert!(!l.text.contains('\n'), "{l:?}");
            }
        }
    }

    #[test]
    fn empty_text_is_one_empty_line() {
        let lines = wrap("", 16.0, Some(100.0));
        assert_eq!(texts(&lines), [""]);
    }

    #[test]
    fn coverage_policy() {
        assert_eq!(coverage("Ship it — naïve café"), Ok(0));
        assert_eq!(coverage("Launch 🚀 now 👍🏽"), Ok(2));
        assert_eq!(coverage("שלום"), Err(Unsupported::RightToLeft('ש')));
        assert!(matches!(coverage("漢字"), Err(Unsupported::Missing('漢'))));
        // An emoji the font lacks measures at the profile's emoji advance.
        let rocket = advance("🚀", 20.0);
        assert!((rocket - profile::EMOJI_ADVANCE_EMS * 20.0).abs() < 1e-9, "{rocket}");
    }

    /// FigJam calibration (2026-10-30, `profile::shape::text_width`): at every observed size, a
    /// word FigJam held on one line is at least as wide as the modeled area, so the model never
    /// keeps on one line what FigJam would wrap.
    #[test]
    fn shape_text_areas_stay_under_what_figjam_holds() {
        let held = [
            ("SQUARE", 176.0, 176.0, 145.41),
            ("SQUARE", 300.0, 300.0, 239.79),
            ("SQUARE", 480.0, 280.0, 423.76),
            ("ROUNDED_RECTANGLE", 300.0, 300.0, 239.79),
            ("ELLIPSE", 300.0, 300.0, 215.22),
            ("ELLIPSE", 480.0, 280.0, 343.38),
            ("DIAMOND", 300.0, 300.0, 143.35),
            ("DIAMOND", 480.0, 280.0, 231.43),
            ("PARALLELOGRAM_RIGHT", 300.0, 300.0, 155.50),
            ("PARALLELOGRAM_RIGHT", 480.0, 280.0, 263.34),
            ("PREDEFINED_PROCESS", 176.0, 176.0, 96.0),
            ("PREDEFINED_PROCESS", 300.0, 300.0, 203.62),
            ("PREDEFINED_PROCESS", 480.0, 280.0, 383.66),
            ("DOCUMENT_SINGLE", 300.0, 300.0, 263.34),
            ("DOCUMENT_SINGLE", 480.0, 280.0, 443.73),
            ("ENG_DATABASE", 300.0, 300.0, 263.34),
            ("ENG_DATABASE", 480.0, 280.0, 443.73),
        ];
        for (kind, w, h, held) in held {
            let modeled = content_box(kind, w, h).w;
            assert!(modeled <= held, "{kind} {w}×{h}: modeled {modeled} > held {held}");
            assert!(modeled > held * 0.9, "{kind} {w}×{h}: modeled {modeled} is far narrower than {held}");
        }
        // A 320×440 DIAMOND showed five 24px lines of six: the model holds at most five.
        assert!(content_box("DIAMOND", 320.0, 440.0).h < 6.0 * 36.0);
    }

    #[test]
    fn content_boxes_sit_inside_their_shapes() {
        for kind in [
            "SQUARE",
            "ROUNDED_RECTANGLE",
            "ELLIPSE",
            "DIAMOND",
            "PARALLELOGRAM_RIGHT",
            "PREDEFINED_PROCESS",
            "DOCUMENT_SINGLE",
            "ENG_DATABASE",
        ] {
            let r = content_box(kind, 176.0, 176.0);
            assert!(r.x > 0.0 && r.y > 0.0 && r.x + r.w < 176.0 && r.y + r.h < 176.0, "{kind}: {r:?}");
        }
    }
}
