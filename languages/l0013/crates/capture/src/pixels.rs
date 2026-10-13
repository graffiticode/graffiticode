// SPDX-License-Identifier: MIT

//! Image work on a capture: the greyscale scan the crop is decided from, and the final
//! crop, resize and PNG encoding.

use std::io::Cursor;

use graffiticode_l0013::crop::Rect;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};

use crate::CameraError;

/// The default output width when a snap asks for no size: crisp on a retina display.
pub const DEFAULT_OUTPUT_WIDTH: u32 = 1024;

pub fn decode(png: &[u8]) -> Result<DynamicImage, CameraError> {
    Ok(image::load_from_memory_with_format(png, ImageFormat::Png)?)
}

/// A greyscale copy no wider than `width`: `(bytes, width, height)`.
pub fn scan(image: &DynamicImage, width: u32, filter: FilterType) -> (Vec<u8>, usize, usize) {
    let scaled;
    let image = if image.width() > width {
        let height = (f64::from(image.height()) * f64::from(width) / f64::from(image.width())).round().max(1.0);
        scaled = image.resize_exact(width, height as u32, filter);
        &scaled
    } else {
        image
    };
    let luma = image.to_luma8();
    let (w, h) = (luma.width() as usize, luma.height() as usize);
    (luma.into_raw(), w, h)
}

/// The output size: with neither bound, the default width; otherwise the largest size that
/// fits inside the bounds given. The aspect is always kept, and a small crop is enlarged.
pub fn output_size(width: u32, height: u32, max_width: Option<u32>, max_height: Option<u32>) -> (u32, u32) {
    let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let scale = match (max_width, max_height) {
        (None, None) => f64::from(DEFAULT_OUTPUT_WIDTH) / w,
        (Some(max_w), None) => f64::from(max_w) / w,
        (None, Some(max_h)) => f64::from(max_h) / h,
        (Some(max_w), Some(max_h)) => (f64::from(max_w) / w).min(f64::from(max_h) / h),
    };
    (((w * scale).round() as u32).max(1), ((h * scale).round() as u32).max(1))
}

/// Crops to `rect` if one is given, resizes to the output size and encodes a PNG.
pub fn finish(
    image: &DynamicImage,
    rect: Option<Rect>,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<Vec<u8>, CameraError> {
    let cropped;
    let image = match rect {
        Some(rect) => {
            cropped = image.crop_imm(rect.left, rect.top, rect.width, rect.height);
            &cropped
        }
        None => image,
    };
    let (width, height) = output_size(image.width(), image.height(), max_width, max_height);
    let resized = image.resize_exact(width, height, FilterType::Lanczos3);
    let mut png = Vec::new();
    resized.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn white(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]))
    }

    #[test]
    fn the_output_fits_inside_whatever_bounds_are_given() {
        assert_eq!(output_size(400, 200, None, None), (1024, 512));
        assert_eq!(output_size(2048, 1024, None, None), (1024, 512));
        assert_eq!(output_size(400, 200, Some(240), None), (240, 120));
        assert_eq!(output_size(400, 200, None, Some(50)), (100, 50));
        assert_eq!(output_size(400, 200, Some(240), Some(60)), (120, 60));
        assert_eq!(output_size(400, 200, Some(100), Some(500)), (100, 50));
        assert_eq!(output_size(3, 1000, Some(1), Some(1)), (1, 1));
    }

    #[test]
    fn a_scan_is_greyscale_and_no_wider_than_asked() {
        let mut page = white(2048, 1000);
        for x in 1000..1100 {
            for y in 400..500 {
                page.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let (luma, width, height) = scan(&DynamicImage::ImageRgba8(page), 512, FilterType::Triangle);
        assert_eq!((width, height, luma.len()), (512, 250, 512 * 250));
        assert_eq!(luma[0], 255);
        assert!(luma[112 * 512 + 262] < 16, "the block is dark at its centre");

        let (_, width, height) = scan(&DynamicImage::ImageRgba8(white(300, 90)), 512, FilterType::Triangle);
        assert_eq!((width, height), (300, 90));
    }

    #[test]
    fn finishing_crops_then_resizes_and_writes_a_png() {
        let mut page = white(800, 600);
        for x in 100..300 {
            for y in 200..300 {
                page.put_pixel(x, y, Rgba([200, 0, 0, 255]));
            }
        }
        let rect = Rect { left: 100, top: 200, width: 200, height: 100 };
        let png = finish(&DynamicImage::ImageRgba8(page), Some(rect), Some(50), None).unwrap();
        let out = decode(&png).unwrap().to_rgba8();
        assert_eq!((out.width(), out.height()), (50, 25));
        assert_eq!(out.get_pixel(25, 12), &Rgba([200, 0, 0, 255]));
    }
}
