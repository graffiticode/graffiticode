// SPDX-License-Identifier: MIT

//! Text measurement: Inter Medium, shaped with rustybuzz (glyph substitution, ligatures,
//! kerning) over ttf-parser, wrapped greedily at UAX #14 break opportunities, and broken inside a
//! word only between grapheme clusters.
//!
//! Coverage policy (checked before measuring, per profile):
//! - a grapheme cluster Inter shapes without `.notdef` is measured normally;
//! - an emoji cluster Inter has no glyph for takes [`profile::EMOJI_ADVANCE_EMS`] and is
//!   reported as *modeled* only (FigJam draws it with a fallback font we do not have);
//! - a CJK cluster Inter has no glyph for ([`is_cjk`]) takes [`profile::CJK_ADVANCE_EMS`] under
//!   `FIGJAM_V2`, and is unsupported text under `FIGJAM_V1`;
//! - any other `.notdef` cluster, and any strong right-to-left character, is unsupported text: a
//!   content limitation naming the character.
//!
//! [`advance`] and [`wrap`] take no profile: they measure CJK at its V2 advance, which only ever
//! reaches a V1 board's output through text V1's [`coverage`] has already rejected.
//!
//! The compiler emits the lines it measured; the preview draws exactly those, and the validator
//! re-measures each line with [`advance`].

use std::sync::LazyLock;

use rustybuzz::{Direction, Face, UnicodeBuffer};
use serde::{Deserialize, Serialize};
use unicode_linebreak::{BreakOpportunity, linebreaks};
use unicode_segmentation::UnicodeSegmentation;

use crate::profile::{self, Profile};

static FACE: LazyLock<Face<'static>> =
    LazyLock::new(|| Face::from_slice(profile::FONT, 0).expect("the embedded font parses"));

/// Text a profile cannot measure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unsupported {
    /// A character the font has no glyph for, and which is neither an emoji nor CJK the profile
    /// measures.
    Missing(Profile, char),
    /// A CJK character, under a profile that does not measure CJK (`FIGJAM_V1`).
    Cjk(Profile, char),
    /// A strong right-to-left character.
    RightToLeft(Profile, char),
}

impl Unsupported {
    pub fn describe(&self) -> String {
        match self {
            Unsupported::Missing(p, c) => format!(
                "the character {c:?} (U+{:04X}) has no glyph in {}'s font, so it cannot be measured",
                *c as u32,
                p.name()
            ),
            Unsupported::Cjk(p, c) => format!(
                "the character {c:?} (U+{:04X}) is Chinese or Japanese text, which {} does not measure; FIGJAM_V2 does",
                *c as u32,
                p.name()
            ),
            Unsupported::RightToLeft(p, c) => format!(
                "the character {c:?} (U+{:04X}) is right-to-left text, which {} does not lay out",
                *c as u32,
                p.name()
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

/// A character FigJam draws one em wide from its CJK fallback font (calibrated 2026-11-11): CJK
/// punctuation (not the ideographic space), hiragana, katakana, the Han ideographs (unified,
/// extension A, the supplementary planes and the compatibility block) and the full-width forms.
/// Hangul (proportional) and half-width katakana (half an em) are not CJK here.
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3001..=0x303F | 0x3040..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF | 0xFF01..=0xFF60 | 0xFFE0..=0xFFE6 | 0x20000..=0x3FFFF)
}

/// The first character of a cluster that shows: what a missing cluster is judged by.
fn visible(cluster: &str) -> Option<char> {
    cluster.chars().find(|c| !c.is_whitespace() && !c.is_control())
}

/// The modeled advance, in ems, of a cluster the font has no glyph for: CJK at
/// [`profile::CJK_ADVANCE_EMS`], anything else that shows at [`profile::EMOJI_ADVANCE_EMS`],
/// white space and controls at nothing.
fn modeled_ems(cluster: &str) -> f64 {
    match visible(cluster) {
        None => 0.0,
        Some(c) if is_cjk(c) && !cluster.chars().any(is_emoji) => profile::CJK_ADVANCE_EMS,
        Some(_) => profile::EMOJI_ADVANCE_EMS,
    }
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

/// Whether `text` is measurable under `profile`, and how many emoji it models.
pub fn coverage(text: &str, profile: Profile) -> Result<usize, Unsupported> {
    if let Some(c) = text.chars().find(|c| is_rtl(*c)) {
        return Err(Unsupported::RightToLeft(profile, c));
    }
    let shaped = shape(text, 16.0);
    let mut emoji = 0;
    for cluster in missing_clusters(text, &shaped.missing) {
        if cluster.chars().any(is_emoji) {
            emoji += 1;
        } else if let Some(c) = visible(cluster) {
            if !is_cjk(c) {
                return Err(Unsupported::Missing(profile, c));
            }
            if !profile.measures_cjk() {
                return Err(Unsupported::Cjk(profile, c));
            }
        }
    }
    Ok(emoji)
}

/// The advance of `text` at `size` pixels: its shaped width, with each cluster the font lacks at
/// its modeled advance (CJK at one em, emoji and anything else at the emoji advance). Text that
/// failed [`coverage`] measures its missing clusters the same way, so this never fails.
pub fn advance(text: &str, size: f64) -> f64 {
    let shaped = shape(text, size);
    let modeled: f64 = missing_clusters(text, &shaped.missing).iter().map(|g| modeled_ems(g)).sum();
    shaped.width + modeled * size
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
            if missing.iter().any(|m| (start..start + g.len()).contains(m)) {
                at[start] += modeled_ems(g) * size;
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub text: String,
    #[serde(rename = "break")]
    pub ends: Break,
    /// The line's measured advance in pixels.
    #[serde(skip, default)]
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
        for p in [Profile::V1, Profile::V2] {
            assert_eq!(coverage("Ship it — naïve café", p), Ok(0));
            assert_eq!(coverage("Launch 🚀 now 👍🏽", p), Ok(2));
            assert_eq!(coverage("שלום", p), Err(Unsupported::RightToLeft(p, 'ש')));
            // Hangul and half-width katakana are not one em wide in FigJam: unsupported in both.
            assert_eq!(coverage("한국어", p), Err(Unsupported::Missing(p, '한')));
            assert_eq!(coverage("ｱｲｳ", p), Err(Unsupported::Missing(p, 'ｱ')));
        }
        // CJK is rejected by V1 (naming V2) and measured by V2.
        assert_eq!(coverage("漢字", Profile::V1), Err(Unsupported::Cjk(Profile::V1, '漢')));
        assert!(coverage("漢字", Profile::V1).unwrap_err().describe().contains("FIGJAM_V2"));
        for text in [
            "业务读写",
            "旧业务 API",
            "，。：？、「」【】《》",
            "ひらがなカタカナ",
            "ＡＰＩ１２３",
            "鑫龘𠀀",
            "業務資料庫",
        ] {
            assert_eq!(coverage(text, Profile::V2), Ok(0), "{text}");
        }
        // An emoji the font lacks measures at the profile's emoji advance.
        let rocket = advance("🚀", 20.0);
        assert!((rocket - profile::EMOJI_ADVANCE_EMS * 20.0).abs() < 1e-9, "{rocket}");
    }

    /// FigJam calibration (2026-11-11, `profile::CJK_ADVANCE_EMS`): auto-width Inter Medium text
    /// nodes, read back once FigJam's CJK fallback font had loaded. Each width is the model's
    /// advance rounded up, as FigJam rounds a text node.
    #[test]
    fn cjk_widths_match_figjam() {
        let probes = [
            (16.0, "业", 16.0),
            (16.0, "业务读写", 64.0),
            (16.0, "一二三四五六七八九十", 160.0),
            (24.0, "业务读写", 96.0),
            (24.0, "一二三四五六七八九十", 240.0),
            (40.0, "业务读写", 160.0),
            (64.0, "业", 64.0),
            (96.0, "业", 96.0),
            (16.0, "，。：？", 64.0),
            (16.0, "、「」【】《》", 112.0),
            (16.0, "ひらがなカタカナ", 128.0),
            (16.0, "ＡＰＩ１２３", 96.0),
            (16.0, "鑫龘𠀀", 48.0),
            (64.0, "かな业", 192.0),
            (16.0, "镜像迁移头与对应业务库版本一致？", 256.0),
            (16.0, "旧业务 API", 78.0),
            (16.0, "前端请求 → 本机 API :7291", 196.0),
            (16.0, "Nginx · /edu-api/", 129.0),
        ];
        for (size, text, figjam) in probes {
            assert_eq!(advance(text, size).ceil(), figjam, "{text} at {size}");
        }
    }

    /// FigJam calibration (2026-11-11): fixed-width text nodes, screenshotted. FigJam breaks
    /// between ideographs, never puts closing punctuation (`，`) at the start of a line, and holds
    /// a line exactly as wide as the box.
    #[test]
    fn cjk_wraps_where_figjam_does() {
        let text = "业务数据各自存放，实例资源和故障范围共用";
        assert_eq!(texts(&wrap(text, 16.0, Some(100.0))), ["业务数据各自", "存放，实例资", "源和故障范围", "共用"]);
        assert_eq!(texts(&wrap(text, 16.0, Some(130.0))), ["业务数据各自存", "放，实例资源和故", "障范围共用"]);
        let long = "正常发布只核对迁移版本。结构变更走单独维护流程，先在隔离环境验证，再执行正式迁移。";
        assert_eq!(
            texts(&wrap(long, 16.0, Some(200.0))),
            ["正常发布只核对迁移版本。", "结构变更走单独维护流程，", "先在隔离环境验证，再执行", "正式迁移。"]
        );
        assert_eq!(wrap(long, 24.0, Some(200.0)).len(), 6);
        assert_eq!(
            texts(&wrap("旧业务 API 与 Worker 共用连接", 16.0, Some(120.0))),
            ["旧业务 API 与", "Worker 共用连", "接"]
        );
        // A wrap between ideographs consumes nothing, so the lines re-join to the text.
        assert_eq!(rejoin(&wrap(long, 16.0, Some(200.0))), long);
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
