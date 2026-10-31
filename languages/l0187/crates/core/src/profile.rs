// SPDX-License-Identifier: MIT

//! `FIGJAM_V1`: the measurement, sizing, spacing and work-limit policy a board is compiled with
//! (design §9). Every geometry constant lives here, in one place.
//!
//! **Status: frozen (2026-10-30).** The font metrics and constants below were calibrated against
//! FigJam, and the native-fidelity comparison (phase 7, which recalibrated `label`) passed; see
//! `docs/evidence/l0187-calibration/`. Any geometry change now needs a new profile tag selected in
//! source, which changes task identity.
//!
//! Provenance of each value is noted: `L0186` values were measured through the Plugin API on
//! 2026-10-08 (`languages/l0186/packages/view/src/lib/figjam.ts`); `calibrated` values were
//! measured for L0187 (see `docs/evidence/l0187-calibration/` when present); `policy` values are
//! L0187's own choices, not FigJam facts.

/// The profile tag this module implements.
pub const NAME: &str = "FIGJAM_V1";

/// The embedded font: Inter 3.19 Medium (SIL OFL 1.1), the face the plugin loads for every text.
/// Calibrated 2026-10-30: FigJam's text widths are this font's shaped advances rounded up, for
/// every probe (Inter 4.1 differs by up to 1.4px; FigJam does not use its optical sizes).
pub const FONT: &[u8] = include_bytes!("../fonts/Inter-Medium.otf");
pub const FONT_REVISION: &str =
    "Inter-Medium 3.19 sha256:99dab2bdcb613c4c8264000a94351d1227f74dc95a86d1249493aeee0c0179c4";

/// Font-size presets in pixels (L0186 vocabulary; the design keeps them).
pub fn font_size(tag: &str) -> f64 {
    match tag {
        "SMALL" => 16.0,
        "LARGE" => 40.0,
        "EXTRA_LARGE" => 64.0,
        "HUGE" => 96.0,
        _ => 24.0, // MEDIUM
    }
}

/// Stroke-width presets in pixels.
pub fn stroke_width(tag: &str) -> f64 {
    if tag == "THICK" { 8.0 } else { 4.0 }
}

/// Line height as a multiple of the font size.
pub mod line_height {
    /// Text on a sticky or in a shape: FigJam's 150% (calibrated 2026-10-30, sticky and shape
    /// sublayers both read back `PERCENT 150`).
    pub const NOTE: f64 = 1.5;
}

/// The height of one line of a textbox: Inter's AUTO line height, whole pixels per line
/// (calibrated 2026-10-30: 14→17, 16→19, 24→29, 40→48, 96→116; k lines are exactly k × this).
pub fn text_line(size: f64) -> f64 {
    (size * 1.21).round()
}

/// A sticky has a fixed width and grows taller to fit its text (calibrated 2026-10-30).
pub mod sticky {
    /// The square sticky's width and minimum height.
    pub const SIZE: f64 = 240.0;
    /// The wide sticky's width (`isWideWidth`).
    pub const WIDE: f64 = 416.0;
    /// Horizontal padding: text wraps at width − 32 in FigJam (a 208-wide line fits a square,
    /// a 212 one wraps; 382 fits a wide one, 384 wraps). One more pixel each side for safety.
    pub const PAD_X: f64 = 17.0;
    /// Vertical padding: a sticky is `max(240, 2 × PAD_Y + size × (1.5 × lines + 0.5))` high
    /// (exact for every probe at 16 and 24px; 4px taller than FigJam at 40px, never shorter).
    pub const PAD_Y: f64 = 24.0;
    /// The extra half line of height a sticky adds below its text, in ems.
    pub const TAIL_EMS: f64 = 0.5;
}

/// Shapes are sized by the compiler on the canvas grid, from FigJam's default up to a limit
/// (default size: L0186; steps and limit: policy). A resized shape does not grow to fit its text
/// in FigJam (calibrated 2026-10-30), so the size the compiler picks must hold it.
pub mod shape {
    /// The width a shape's text wraps within, per kind, for a `w`×`h` shape: a bound just below
    /// the narrowest width FigJam was seen to hold on one line, at every calibrated size
    /// (2026-10-30; 24px probe words on resized 300×300 and 480×280 shapes, read from
    /// screenshots, and the default 176 shape's auto-growth). Held ↔ wrapped, per kind:
    ///
    /// | kind | 176×176 | 300×300 | 480×280 |
    /// | --- | --- | --- | --- |
    /// | SQUARE, ROUNDED_RECTANGLE | 145.4 ↔ 147.5 | 239.8 ↔ 251.7 | ≥ 423.8 |
    /// | ELLIPSE | 112 ↔ 128 | 215.2 ↔ 227.2 | 343.4 ↔ 351.7 |
    /// | DIAMOND | — | 143.4 ↔ 155.5 | 231.4 ↔ 239.8 |
    /// | PARALLELOGRAM_RIGHT | — | 155.5 ↔ 167.8 | ≥ 263.3 |
    /// | PREDEFINED_PROCESS | 96 ↔ 105 | 203.6 ↔ 215.2 | ≥ 383.7 |
    /// | DOCUMENT_SINGLE, ENG_DATABASE | — | 263.3 ↔ 275.3 | ≥ 443.7 |
    ///
    /// FigJam's area is not a fixed share of the width (a square's padding follows its shorter
    /// side), so each rule is fitted under the observations; a narrower model only wraps earlier
    /// than FigJam, never later.
    pub fn text_width(kind: &str, w: f64, h: f64) -> f64 {
        match kind {
            "ELLIPSE" => 0.715 * w,
            "DIAMOND" => 0.475 * w,
            "PARALLELOGRAM_RIGHT" => 0.515 * w,
            "PREDEFINED_PROCESS" => 0.88 * w - 61.0,
            "DOCUMENT_SINGLE" | "ENG_DATABASE" => w - 37.0,
            _ => w - 0.205 * w.min(h), // SQUARE, ROUNDED_RECTANGLE
        }
    }

    /// The height a shape's text fits within, per kind: FigJam truncates text past it with an
    /// ellipsis. From the default shape's auto-growth (a SQUARE is `36 × lines + 32` high at
    /// 24px; a DIAMOND `72 × lines + 88`) and a 320×440 DIAMOND that showed five of six lines.
    /// ELLIPSE and the outlined kinds keep L0186's modeled insets.
    pub fn text_height(kind: &str, w: f64, h: f64) -> f64 {
        match kind {
            "DIAMOND" => (h - 88.0) / 2.0,
            "ELLIPSE" => 0.7 * h,
            "DOCUMENT_SINGLE" => 0.74 * h,
            "ENG_DATABASE" => {
                let ry = (h * 0.13).min(w * 0.25);
                h - ry * 3.4
            }
            _ => h - 32.0,
        }
    }

    pub const MIN: f64 = 176.0;
    pub const MAX: f64 = 608.0;
    pub const STEP: f64 = 24.0;
    /// The widest a shape may be relative to its height, so text does not run into a ribbon.
    pub const MAX_ASPECT: f64 = 3.0;
}

/// A textbox wraps at its content's natural width, up to a measure proportional to its font size
/// (policy).
pub mod textbox {
    pub const MAX_EMS: f64 = 20.0;
}

/// A connector label's box (calibrated 2026-10-30, the phase 7 fidelity check). FigJam draws a
/// label in Inter Medium at 150% line height and −1.1% letter spacing, centred on its leg, in a
/// box `lines × 1.5 em + 13 + stroke` high (exact at 16–64px, 4 and 8px strokes) and about
/// `text + 1 em + stroke` wide (padding 13 at 16px, 21.5–23.5 at 24, 38.5 at 40, 64 at 64). The
/// width pads by a full em and measures without the letter spacing, so it is never narrower than
/// FigJam's.
pub mod label {
    pub const LINE_HEIGHT: f64 = 1.5;
    /// The padding across the text, in ems, both sides together, before the stroke.
    pub const PAD_X_EMS: f64 = 1.0;
    /// The padding above and below the text, together, before the stroke.
    pub const PAD_Y: f64 = 13.0;

    /// Padding on each side of a label's text: (horizontal, vertical).
    pub fn pad(font_size: f64, stroke: f64) -> (f64, f64) {
        ((PAD_X_EMS * font_size + stroke) / 2.0, (PAD_Y + stroke) / 2.0)
    }
}

/// Sections: the title is drawn above the section's top edge, outside it (L0186).
pub mod section {
    /// Space between a section's border and its contents (L0186: the plugin's PAD).
    pub const PADDING: f64 = 24.0;
    /// The title's font size and the band it occupies above the section (L0186).
    pub const TITLE_SIZE: f64 = 14.0;
    pub const TITLE_BAND: f64 = 28.0;
    /// The gap between the title band and the section's top edge (L0186: page bounds grow by
    /// 28 + 6 for a named section).
    pub const TITLE_GAP: f64 = 6.0;
    /// Horizontal room the title needs besides its text (policy).
    pub const TITLE_PAD: f64 = 16.0;
    /// The content area of an empty section (policy: one sticky).
    pub const EMPTY: f64 = 240.0;
}

/// Spacing between placed objects (policy).
pub mod spacing {
    /// The clearance between sibling bounds in any region.
    pub const GUTTER: f64 = 48.0;
    /// The clearance around a group or section placed among siblings: stronger separation
    /// between groups than within them.
    pub const REGION_GUTTER: f64 = 72.0;
    /// The extent of an empty group.
    pub const EMPTY_GROUP: f64 = 48.0;
    /// The step the repair loop widens a gutter by.
    pub const REPAIR_STEP: f64 = 24.0;
}

/// An emoji cluster Inter has no glyph for (FigJam draws it with a fallback font): its advance
/// in ems. Calibrated 2026-10-30 (🚀 at 24px is 30px wide); reported as modeled only.
pub const EMOJI_ADVANCE_EMS: f64 = 1.25;

/// Deterministic work limits: counted, never timed, so the result never depends on load.
pub mod limits {
    /// Crossing-reduction sweeps in a FLOW or AUTO region.
    pub const CROSSING_SWEEPS: usize = 8;
    /// Rounds of the routing repair loop.
    pub const REPAIR_ROUNDS: usize = 4;
    /// Candidate route evaluations per page.
    pub const ROUTE_EVALUATIONS: usize = 4096;
    /// The most marks, regions and connectors a board may have.
    pub const OBJECTS: usize = 2000;
    /// The longest text a mark or label may have, in characters.
    pub const TEXT_CHARS: usize = 4000;
}
