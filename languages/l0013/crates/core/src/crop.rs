// SPDX-License-Identifier: MIT

//! Where to crop a screenshot: a pure function of its pixels.
//!
//! Analysis runs on a downscaled greyscale copy of the capture (a [`Scan`]), with an integral
//! image so the ink inside any window is an O(1) lookup. A pixel is "ink" when it differs
//! enough from the background, which is taken to be the top-left pixel.
//!
//! - With no `slice`: the bounding box of the inked content, plus a small margin.
//! - With a `slice` aspect: the zoom-0 frame is the smallest rectangle of that aspect that
//!   *contains* all the ink (`"1:1"` is a square enclosing every inked pixel). Zoom 1 is the
//!   densest natural region: the window of that aspect inside the frame that maximizes
//!   ink²/area, i.e. the tightest window still holding a dense cluster. `zoom` interpolates the
//!   window's *size* between the two and re-finds the densest position at that size, so
//!   zooming always stays on the same content.
//! - A page with no ink at all: its top region, so a crop is never empty.

/// Greyscale distance from the background at which a pixel counts as ink.
pub const INK_THRESHOLD: u8 = 12;
/// Padding around trimmed content, in capture pixels.
const INK_MARGIN: f64 = 16.0;
/// Width : height of the fallback crop for a blank page.
const BLANK_ASPECT: f64 = 4.0 / 3.0;
/// Lower bound on the zoom-1 size search, as a fraction of the frame's height. It only bounds
/// the search; the density score picks the size.
const ZOOM_SEARCH_MIN: f64 = 0.05;
/// The geometric shrink between candidate sizes in that search.
const ZOOM_SEARCH_STEP: f64 = 0.9;

/// A rectangle in capture pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

/// A downscaled greyscale copy of a capture: `width × height` bytes, row by row.
#[derive(Clone, Copy, Debug)]
pub struct Scan<'a> {
    pub width: usize,
    pub height: usize,
    pub luma: &'a [u8],
}

/// `"W:H"` → width / height, or `None` if it is not two positive numbers.
pub fn parse_aspect(slice: &str) -> Option<f64> {
    let (w, h) = slice.split_once(':')?;
    if h.contains(':') {
        return None;
    }
    let (w, h): (f64, f64) = (w.trim().parse().ok()?, h.trim().parse().ok()?);
    (w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite()).then_some(w / h)
}

/// Rounds half up, as the capture pipeline has always done.
fn round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// The crop for a capture of `full_width × full_height` pixels, decided from its `scan`.
pub fn content_rect(scan: Scan<'_>, full_width: u32, full_height: u32, aspect: Option<f64>, zoom: Option<f64>) -> Rect {
    let (w, h) = (scan.width as i64, scan.height as i64);
    let (full_w, full_h) = (i64::from(full_width), i64::from(full_height));
    let scale = full_width as f64 / scan.width.max(1) as f64;
    let background = scan.luma.first().copied().unwrap_or(0);

    // Integral image of the ink mask, (w+1) × (h+1), and the content's bounding box.
    let stride = scan.width + 1;
    let mut integral = vec![0i64; stride * (scan.height + 1)];
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, -1i64, -1i64);
    for y in 0..scan.height {
        let mut row = 0;
        for x in 0..scan.width {
            if scan.luma[y * scan.width + x].abs_diff(background) > INK_THRESHOLD {
                row += 1;
                let (x, y) = (x as i64, y as i64);
                (min_x, max_x) = (min_x.min(x), max_x.max(x));
                (min_y, max_y) = (min_y.min(y), max_y.max(y));
            }
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
        }
    }
    // Ink in [x0, x1) × [y0, y1), in scan space.
    let ink = |x0: i64, y0: i64, x1: i64, y1: i64| {
        let at = |x: i64, y: i64| integral[y as usize * stride + x as usize];
        at(x1, y1) - at(x1, y0) - at(x0, y1) + at(x0, y0)
    };
    // A scan-space rectangle in capture pixels, clamped to the image.
    let to_capture = |x0: i64, y0: i64, x1: i64, y1: i64| {
        let left = round(x0 as f64 * scale).clamp(0, full_w - 1);
        let top = round(y0 as f64 * scale).clamp(0, full_h - 1);
        Rect {
            left: left as u32,
            top: top as u32,
            width: round((x1 - x0) as f64 * scale).clamp(1, full_w - left) as u32,
            height: round((y1 - y0) as f64 * scale).clamp(1, full_h - top) as u32,
        }
    };

    if max_x < 0 {
        let height = full_h.min(round(full_w as f64 / BLANK_ASPECT)).max(1);
        return Rect { left: 0, top: 0, width: full_width, height: height as u32 };
    }
    let Some(aspect) = aspect else {
        let margin = round(INK_MARGIN / scale).max(1);
        return to_capture(
            (min_x - margin).max(0),
            (min_y - margin).max(0),
            (max_x + 1 + margin).min(w),
            (max_y + 1 + margin).min(h),
        );
    };

    // The zoom-0 frame, centred on the content and clamped to the image.
    let (mut frame_w, mut frame_h) = (max_x - min_x + 1, max_y - min_y + 1);
    if (frame_w as f64) < frame_h as f64 * aspect {
        frame_w = round(frame_h as f64 * aspect); // content narrower than the aspect: widen
    } else {
        frame_h = round(frame_w as f64 / aspect); // content wider: heighten
    }
    let (frame_w, frame_h) = (frame_w.clamp(1, w), frame_h.clamp(1, h));
    let centre_x = (min_x + max_x + 1) as f64 / 2.0;
    let centre_y = (min_y + max_y + 1) as f64 / 2.0;
    let frame_x = round(centre_x - frame_w as f64 / 2.0).clamp(0, w - frame_w);
    let frame_y = round(centre_y - frame_h as f64 / 2.0).clamp(0, h - frame_h);

    let zoom = zoom.filter(|z| !z.is_nan()).map_or(0.0, |z| z.clamp(0.0, 1.0));
    if zoom <= 0.0 {
        return to_capture(frame_x, frame_y, frame_x + frame_w, frame_y + frame_h);
    }

    // The window of a given size, inside the frame, holding the most ink: (ink, x, y, w, h).
    let densest = |window_w: i64, window_h: i64| {
        let (ww, wh) = (window_w.clamp(1, frame_w), window_h.clamp(1, frame_h));
        let mut best = (-1, frame_x, frame_y);
        for y in frame_y..=frame_y + frame_h - wh {
            for x in frame_x..=frame_x + frame_w - ww {
                let found = ink(x, y, x + ww, y + wh);
                if found > best.0 {
                    best = (found, x, y);
                }
            }
        }
        (best.0, best.1, best.2, ww, wh)
    };

    // The zoom-1 size: scan candidate heights and keep the best density score.
    let mut best_score = -1.0;
    let mut dense_h = frame_h;
    let min_h = round(frame_h as f64 * ZOOM_SEARCH_MIN).max(2);
    let mut candidate = frame_h;
    while candidate >= min_h {
        let (found, _, _, ww, wh) = densest(round(candidate as f64 * aspect), candidate);
        let score = (found * found) as f64 / (ww * wh) as f64;
        if score > best_score {
            (best_score, dense_h) = (score, wh);
        }
        // Strictly decreasing: a bare 10% step has fixed points at small sizes and would stall.
        candidate = (candidate - 1).min(round(candidate as f64 * ZOOM_SEARCH_STEP));
    }

    let height = round(frame_h as f64 - zoom * (frame_h - dense_h) as f64).max(1);
    let (_, x, y, ww, wh) = densest(round(height as f64 * aspect), height);
    to_capture(x, y, x + ww, y + wh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A white `width × height` scan with black rectangles `(x, y, w, h)` painted on it.
    fn page(width: usize, height: usize, ink: &[(usize, usize, usize, usize)]) -> Vec<u8> {
        let mut luma = vec![255u8; width * height];
        for &(x, y, w, h) in ink {
            for row in y..y + h {
                luma[row * width + x..row * width + x + w].fill(0);
            }
        }
        luma
    }

    fn rect(luma: &[u8], width: usize, full: (u32, u32), slice: Option<&str>, zoom: Option<f64>) -> Rect {
        let scan = Scan { width, height: luma.len() / width, luma };
        content_rect(scan, full.0, full.1, slice.and_then(parse_aspect), zoom)
    }

    #[test]
    fn an_aspect_is_two_positive_numbers() {
        assert_eq!(parse_aspect("4:1"), Some(4.0));
        assert_eq!(parse_aspect("1:4"), Some(0.25));
        assert_eq!(parse_aspect("16 : 9"), Some(16.0 / 9.0));
        for bad in ["", "4", "4:", ":1", "0:1", "4:0", "-4:1", "a:b", "4:1:2"] {
            assert_eq!(parse_aspect(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_default_crop_trims_to_the_ink_with_a_margin() {
        // Ink at (100,50) 200×100 on a 512×384 scan of a 2048×1536 capture (scale 4).
        let luma = page(512, 384, &[(100, 50, 200, 100)]);
        // The margin is 16 capture px = 4 scan px each side.
        assert_eq!(
            rect(&luma, 512, (2048, 1536), None, None),
            Rect { left: 96 * 4, top: 46 * 4, width: 208 * 4, height: 108 * 4 }
        );
    }

    #[test]
    fn the_margin_stops_at_the_edge_of_the_image() {
        let luma = page(512, 384, &[(462, 334, 50, 50)]);
        assert_eq!(rect(&luma, 512, (512, 384), None, None), Rect { left: 446, top: 318, width: 66, height: 66 });
    }

    #[test]
    fn the_background_is_whatever_the_top_left_pixel_is() {
        // A dark page with one light block: the block is the ink.
        let mut luma = vec![20u8; 512 * 384];
        for row in 100..150 {
            luma[row * 512 + 200..row * 512 + 300].fill(240);
        }
        assert_eq!(rect(&luma, 512, (512, 384), None, None), Rect { left: 184, top: 84, width: 132, height: 82 });
    }

    #[test]
    fn a_blank_page_crops_to_its_top_region() {
        let luma = page(512, 2000, &[]);
        assert_eq!(rect(&luma, 512, (1024, 4000), None, None), Rect { left: 0, top: 0, width: 1024, height: 768 });
        // A page shorter than that region is taken whole.
        let luma = page(512, 100, &[]);
        assert_eq!(rect(&luma, 512, (1024, 200), None, None), Rect { left: 0, top: 0, width: 1024, height: 200 });
    }

    #[test]
    fn a_slice_frames_all_the_ink_at_its_aspect() {
        // A 100×100 block: a 4:1 frame must widen to 400×100 around it; a 1:4 frame must
        // heighten, and is clamped to the image's height.
        let luma = page(512, 384, &[(200, 100, 100, 100)]);
        assert_eq!(
            rect(&luma, 512, (512, 384), Some("4:1"), None),
            Rect { left: 50, top: 100, width: 400, height: 100 }
        );
        assert_eq!(
            rect(&luma, 512, (512, 384), Some("1:4"), None),
            Rect { left: 200, top: 0, width: 100, height: 384 }
        );
        // A square slice encloses a wide strip of content rather than fitting inside it.
        let strip = page(512, 384, &[(100, 150, 300, 20)]);
        assert_eq!(
            rect(&strip, 512, (512, 384), Some("1:1"), None),
            Rect { left: 100, top: 10, width: 300, height: 300 }
        );
    }

    #[test]
    fn zoom_one_finds_the_densest_region_and_zoom_interpolates_toward_it() {
        // A solid 80×80 block and, far to its right, a thin line. The square frame holds both;
        // the densest square is the block.
        let luma = page(512, 384, &[(40, 150, 80, 80), (400, 189, 60, 2)]);
        let frame = rect(&luma, 512, (512, 384), Some("1:1"), Some(0.0));
        assert_eq!(frame, rect(&luma, 512, (512, 384), Some("1:1"), None));
        assert!(frame.left <= 40 && frame.left + frame.width >= 460, "{frame:?}");

        let dense = rect(&luma, 512, (512, 384), Some("1:1"), Some(1.0));
        assert!(dense.width < frame.width / 2, "{dense:?}");
        // The size search steps geometrically, so the window fits the block to within a step.
        assert!((72..=88).contains(&dense.width), "about the size of the block: {dense:?}");
        assert!(dense.left >= 32 && dense.left + dense.width <= 128, "on the block: {dense:?}");
        assert!(dense.left + dense.width < 400, "the line is outside {dense:?}");

        let halfway = rect(&luma, 512, (512, 384), Some("1:1"), Some(0.5));
        assert!(dense.width < halfway.width && halfway.width < frame.width, "{halfway:?}");
        // Out-of-range zooms are clamped.
        assert_eq!(rect(&luma, 512, (512, 384), Some("1:1"), Some(7.0)), dense);
        assert_eq!(rect(&luma, 512, (512, 384), Some("1:1"), Some(-1.0)), frame);
    }

    #[test]
    fn a_tiny_frame_does_not_stall_the_size_search() {
        let luma = page(64, 64, &[(30, 30, 3, 3)]);
        let found = rect(&luma, 64, (64, 64), Some("1:1"), Some(1.0));
        assert!(found.width >= 1 && found.height >= 1);
    }
}
