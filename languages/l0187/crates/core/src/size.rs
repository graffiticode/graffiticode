// SPDX-License-Identifier: MIT

//! Sizing under `FIGJAM_V1`: every mark's box and text lines, every label's box, and the room a
//! section's title needs, measured from the full text at the requested font size (design §6).
//!
//! - A **sticky** has a fixed width (square, or wide when a square would grow) and grows taller to
//!   fit its text, as FigJam's does; L0187 never shrinks text.
//! - A **shape** is sized by the compiler: a box on the canvas grid, within the profile's size
//!   and aspect limits, whose content area holds the wrapped text — preferring one that breaks
//!   no word inside, then the smallest area, nudged towards square.
//! - A **textbox** is as wide as its widest paragraph (rounded up, as FigJam rounds a text
//!   node), up to a measure proportional to its font size, and as tall as its lines.
//! - A **label** is one line per paragraph, padded.

use std::collections::HashMap;

use serde::Serialize;

use crate::ir::{Board, Child, Connector, Mark, Region};
use crate::measure::{Break, Line, Rect, content_box, coverage, wrap};
use crate::profile::{self, line_height};

/// A measured mark or label: its size, where its text sits inside it, and its lines.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub width: f64,
    pub height: f64,
    /// The area the text is laid out in, relative to the box.
    pub content: Rect,
    pub font_size: f64,
    pub line_height: f64,
    pub lines: Vec<Line>,
    /// How many emoji were measured at the profile's modeled advance.
    #[serde(skip)]
    pub emoji: usize,
}

/// Why a text could not be sized: the object's id, and the message.
#[derive(Clone, Debug, PartialEq)]
pub struct Limit {
    pub id: String,
    pub code: &'static str,
    pub message: String,
}

/// Everything sized on a board, by id.
#[derive(Clone, Debug, Default)]
pub struct Sizes {
    pub marks: HashMap<String, Measured>,
    pub labels: HashMap<String, Measured>,
    /// The width a section must have for its title.
    pub titles: HashMap<String, f64>,
}

fn text_height(lines: &[Line], font: f64, lh: f64) -> f64 {
    lines.len() as f64 * font * lh
}

fn widest(lines: &[Line]) -> f64 {
    lines.iter().map(|l| l.width).fold(0.0, f64::max)
}

fn unsupported(word: &str, id: &str, text: &str) -> Result<usize, Limit> {
    coverage(text).map_err(|u| Limit {
        id: id.to_owned(),
        code: "unsupported-text",
        message: format!(
            "{word} {id:?}: {}. Write the text with characters FIGJAM_V1 supports (Latin, Greek and Cyrillic scripts, common symbols and emoji).",
            u.describe()
        ),
    })
}

/// A sticky's height for `lines` lines at `font` (FigJam grows a sticky to fit).
pub fn sticky_height(lines: usize, font: f64) -> f64 {
    use profile::sticky::{PAD_Y, SIZE, TAIL_EMS};
    SIZE.max(2.0 * PAD_Y + font * (line_height::NOTE * lines as f64 + TAIL_EMS))
}

fn sticky(m: &Mark) -> Result<Measured, Limit> {
    use profile::sticky::{PAD_X, PAD_Y, SIZE, WIDE};
    let emoji = unsupported("sticky", &m.id, &m.text)?;
    let font = profile::font_size(&m.font_size);
    // A square sticky, unless its text would make it grow and a wide one would hold it with
    // less growth.
    let mut chosen = None;
    for width in [SIZE, WIDE] {
        let lines = wrap(&m.text, font, Some(width - 2.0 * PAD_X));
        let height = sticky_height(lines.len(), font);
        let better = chosen.as_ref().is_none_or(|(_, h, _): &(f64, f64, Vec<Line>)| height < *h);
        if better {
            chosen = Some((width, height, lines));
        }
        if height <= SIZE {
            break;
        }
    }
    let (width, height, lines) = chosen.expect("a sticky width");
    let content = Rect { x: PAD_X, y: PAD_Y, w: width - 2.0 * PAD_X, h: height - 2.0 * PAD_Y };
    Ok(Measured { width, height, content, font_size: font, line_height: line_height::NOTE, lines, emoji })
}

fn shape(m: &Mark) -> Result<Measured, Limit> {
    use profile::shape::{MAX, MAX_ASPECT, MIN, STEP};
    let emoji = unsupported("shape", &m.id, &m.text)?;
    let kind = m.kind.as_deref().unwrap_or("SQUARE");
    let font = profile::font_size(&m.font_size);
    let lh = line_height::NOTE;
    let steps = ((MAX - MIN) / STEP) as usize;
    let mut best: Option<((bool, f64), Measured)> = None;
    for wi in 0..=steps {
        let w = MIN + wi as f64 * STEP;
        // The text area's width depends on the height too (a square's padding follows its shorter
        // side), so each height is wrapped for on its own.
        let h_min = MIN.max((w / MAX_ASPECT / STEP).ceil() * STEP);
        let found =
            (0..=steps).map(|hi| MIN + hi as f64 * STEP).filter(|h| *h >= h_min && w >= h / MAX_ASPECT).find_map(|h| {
                let area = content_box(kind, w, h);
                let lines = wrap(&m.text, font, Some(area.w));
                let fits = widest(&lines) <= area.w + 1e-9 && text_height(&lines, font, lh) <= area.h + 1e-9;
                fits.then_some((h, lines))
            });
        let Some((h, lines)) = found else { continue };
        // Prefer a box that breaks no word inside, then the smallest area, nudged towards
        // square so text does not stack into a tower or run into a ribbon.
        let breaks_words = lines.iter().any(|l| l.ends == Break::Cluster);
        let score = (breaks_words, w * h * (1.0 + 0.25 * (w / h).ln().abs()));
        let better = best.as_ref().is_none_or(|(b, _)| score.partial_cmp(b) == Some(std::cmp::Ordering::Less));
        if better {
            let content = content_box(kind, w, h);
            best = Some((
                score,
                Measured { width: w, height: h, content, font_size: font, line_height: lh, lines, emoji },
            ));
        }
    }
    best.map(|(_, m)| m).ok_or_else(|| Limit {
        id: m.id.clone(),
        code: "shape-overflow",
        message: format!(
            "shape {:?}: its text does not fit a {kind} up to {MAX}×{MAX} at {} ({font}px). L0187 does not shrink text or change the shape: shorten the text, choose a smaller font-size, or use a textbox.",
            m.id, m.font_size
        ),
    })
}

fn textbox(m: &Mark) -> Result<Measured, Limit> {
    let emoji = unsupported("textbox", &m.id, &m.text)?;
    let font = profile::font_size(&m.font_size);
    let natural = widest(&wrap(&m.text, font, None));
    let measure = profile::textbox::MAX_EMS * font;
    let width = natural.min(measure).max(font).ceil();
    let lines = wrap(&m.text, font, Some(width));
    let width = width.max(widest(&lines).ceil());
    let height = lines.len() as f64 * profile::text_line(font);
    let content = Rect { x: 0.0, y: 0.0, w: width, h: height };
    let line_height = profile::text_line(font) / font;
    Ok(Measured { width, height, content, font_size: font, line_height, lines, emoji })
}

fn label(c: &Connector) -> Result<Option<Measured>, Limit> {
    let Some(text) = c.label.as_deref().filter(|t| !t.is_empty()) else { return Ok(None) };
    let emoji = unsupported("connector", &c.id, text)?;
    let font = profile::font_size(&c.font_size);
    let lines = wrap(text, font, None);
    let (px, py) = profile::label::pad(font, profile::stroke_width(&c.stroke_width));
    let w = widest(&lines).ceil();
    let h = text_height(&lines, font, profile::label::LINE_HEIGHT).ceil();
    let content = Rect { x: px, y: py, w, h };
    Ok(Some(Measured {
        width: w + 2.0 * px,
        height: h + 2.0 * py,
        content,
        font_size: font,
        line_height: profile::label::LINE_HEIGHT,
        lines,
        emoji,
    }))
}

/// Sizes one mark: a sticky, shape or textbox.
pub fn mark(child: &Child) -> Option<Result<Measured, Limit>> {
    match child {
        Child::Sticky(m) => Some(sticky(m)),
        Child::Shape(m) => Some(shape(m)),
        Child::Textbox(m) => Some(textbox(m)),
        _ => None,
    }
}

fn region(r: &Region, sizes: &mut Sizes, limits: &mut Vec<Limit>) {
    for child in &r.children {
        let measured = match child {
            Child::Sticky(m) => Some(sticky(m)),
            Child::Shape(m) => Some(shape(m)),
            Child::Textbox(m) => Some(textbox(m)),
            Child::Section(s) => {
                match unsupported("section", &s.id, &s.name) {
                    Ok(_) => {
                        let title = crate::measure::advance(&s.name, profile::section::TITLE_SIZE);
                        sizes.titles.insert(s.id.clone(), (title + profile::section::TITLE_PAD).ceil());
                    }
                    Err(limit) => limits.push(limit),
                }
                None
            }
            Child::Group(_) => None,
        };
        match measured {
            Some(Ok(m)) => {
                sizes.marks.insert(child.id().to_owned(), m);
            }
            Some(Err(limit)) => limits.push(limit),
            None => {}
        }
        if let Some(inner) = child.region() {
            region(inner, sizes, limits);
        }
    }
}

/// Sizes every mark, label and section title on the board, or reports every text that cannot
/// be sized.
pub fn size(board: &Board) -> Result<Sizes, Vec<Limit>> {
    let mut sizes = Sizes::default();
    let mut limits = Vec::new();
    for page in &board.pages {
        region(&page.region, &mut sizes, &mut limits);
        for c in &page.connectors {
            match label(c) {
                Ok(Some(m)) => {
                    sizes.labels.insert(c.id.clone(), m);
                }
                Ok(None) => {}
                Err(limit) => limits.push(limit),
            }
        }
    }
    if limits.is_empty() { Ok(sizes) } else { Err(limits) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(text: &str, kind: Option<&str>, font: &str) -> Mark {
        Mark {
            id: "m".into(),
            text: text.into(),
            kind: kind.map(str::to_owned),
            fill: None,
            stroke: None,
            stroke_width: None,
            color: None,
            opacity: 100.0,
            font_size: font.into(),
            before: Vec::new(),
        }
    }

    #[test]
    fn a_sticky_keeps_its_width_and_grows_as_figjam_does() {
        let short = sticky(&mark("Shipped on time", None, "MEDIUM")).unwrap();
        assert_eq!((short.width, short.height), (240.0, 240.0));
        // FigJam's readings: k explicit lines at 16px and 24px on a square sticky.
        for (font, k, expect) in [(16.0, 8, 248.0), (16.0, 14, 392.0), (24.0, 6, 276.0), (24.0, 10, 420.0)] {
            assert_eq!(sticky_height(k, font), expect, "{k} lines at {font}");
        }
        // At 40px FigJam drew 304: the model is 4px taller, never shorter, so a sticky never
        // overlaps what is placed below it.
        assert!((304.0..=308.0).contains(&sticky_height(4, 40.0)));
        // Text a square would grow for goes on a wide sticky.
        let long = sticky(&mark(&"word ".repeat(40), None, "MEDIUM")).unwrap();
        assert_eq!(long.width, 416.0);
        assert!(long.lines.iter().all(|l| l.width <= long.content.w + 1e-9));
    }

    #[test]
    fn a_shape_grows_on_the_grid_to_fit_its_text() {
        let small = shape(&mark("A", Some("SQUARE"), "MEDIUM")).unwrap();
        assert_eq!((small.width, small.height), (176.0, 176.0));
        let long =
            shape(&mark("Quarantine flaky tests and assign owners before the release", Some("DIAMOND"), "MEDIUM"))
                .unwrap();
        assert!(long.width > 176.0 || long.height > 176.0);
        assert_eq!(long.width % 24.0, 176.0 % 24.0);
        let needed = long.lines.len() as f64 * long.font_size * long.line_height;
        assert!(long.content.h >= needed - 1e-9);
        assert!(long.lines.iter().all(|l| l.width <= long.content.w + 1e-9));
        assert!(long.width / long.height <= profile::shape::MAX_ASPECT + 1e-9);
        let huge = shape(&mark(&"word ".repeat(400), Some("DIAMOND"), "HUGE")).unwrap_err();
        assert_eq!(huge.code, "shape-overflow");
    }

    #[test]
    fn a_textbox_wraps_at_its_measure() {
        let short = textbox(&mark("Workshop agenda", None, "LARGE")).unwrap();
        assert_eq!(short.lines.len(), 1);
        let long = textbox(&mark(&"agree on scope ".repeat(20), None, "MEDIUM")).unwrap();
        assert!(long.lines.len() > 1);
        assert!(long.width <= profile::textbox::MAX_EMS * 24.0);
    }

    #[test]
    fn unsupported_text_is_a_content_limit() {
        let err = sticky(&mark("שלום", None, "MEDIUM")).unwrap_err();
        assert_eq!(err.code, "unsupported-text");
    }
}
