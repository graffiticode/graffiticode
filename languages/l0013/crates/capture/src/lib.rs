// SPDX-License-Identifier: MIT

//! The side-effecting half of L0013: render an item's form view in headless Chrome, crop it,
//! upload the PNG, and return its public URL.
//!
//! The crop is content-aware by default (trim to the inked content, or with a `slice` the
//! densest band of that aspect; see [`graffiticode_l0013::crop`]). An explicit `crop` is a
//! fixed clip instead.

mod browser;
pub mod pixels;
pub mod storage;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use graffiticode_l0013::crop::{INK_THRESHOLD, Scan, content_rect, parse_aspect};
use graffiticode_l0013::{Camera, SnapRequest, Snapshot};
use image::imageops::FilterType;
use serde_json::Value as Json;
use sha1::{Digest, Sha1};

use crate::browser::{CssRect, Session};
pub use crate::storage::{GoogleStorage, Storage};

pub use graffiticode_l0013::CameraError;

/// The window a form lays out into unless a snap says otherwise. Most forms fill the window.
const VIEWPORT: (u32, u32) = (1024, 768);
const DEVICE_SCALE: f64 = 2.0;
/// When the crop is smaller than the requested output, resizing would enlarge it into a blur.
/// The form is a DOM, not a fixed raster, so it is re-rendered at a higher device scale and
/// only the crop re-captured: the pixels are real. This caps that scale.
const MAX_DEVICE_SCALE: f64 = 8.0;
/// Time for the page to repaint after a change of device scale.
const RERENDER: Duration = Duration::from_millis(250);
/// The overall bound on waiting for a form to render before capturing whatever is there.
const RENDER_TIMEOUT: Duration = Duration::from_secs(30);
/// Readiness is the pixels appearing and going still: the form posts no signal to wait for,
/// and its network idles well before its content paints. These are the width of the frame
/// compared, the least ink that counts as real content, and the gap between samples. The
/// width must be large enough that small content (a lone digit in a corner) still registers.
const PROBE_WIDTH: u32 = 512;
const PROBE_MIN_INK: usize = 4;
const PROBE_INTERVAL: Duration = Duration::from_millis(250);
/// A last paint buffer once the content is stable.
const SETTLE: Duration = Duration::from_millis(250);
/// The width of the copy the crop is decided from; positioning does not need full resolution.
const SCAN_WIDTH: u32 = 512;
/// Width : height of an explicit crop given no height.
const CROP_ASPECT: f64 = 4.0 / 3.0;

#[derive(Clone, Debug)]
pub struct Config {
    /// The API whose `/form` route renders a bare form.
    pub api_url: String,
    /// The app whose resolver maps an item id to its task and language.
    pub app_url: String,
    /// The Chrome to run; found on the system if not given.
    pub chrome: Option<PathBuf>,
    /// A token to render with when the request carries none. For running the server alone.
    pub fallback_token: Option<String>,
}

impl Config {
    /// `GRAFFITICODE_API_URL`, `GRAFFITICODE_APP_URL`, `CHROME_PATH` (or
    /// `PUPPETEER_EXECUTABLE_PATH`) and `GC_SNAP_ACCESS_TOKEN`.
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            api_url: var("GRAFFITICODE_API_URL").unwrap_or_else(|| "https://api.graffiticode.org".to_owned()),
            app_url: var("GRAFFITICODE_APP_URL").unwrap_or_else(|| "https://app.graffiticode.org".to_owned()),
            chrome: var("CHROME_PATH").or_else(|| var("PUPPETEER_EXECUTABLE_PATH")).map(PathBuf::from),
            fallback_token: var("GC_SNAP_ACCESS_TOKEN"),
        }
    }
}

/// The bucket thumbnails are stored in: `THUMBNAIL_BUCKET`, or the project's default.
pub fn bucket_from_env() -> String {
    std::env::var("THUMBNAIL_BUCKET")
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "graffiticode.appspot.com".to_owned())
}

pub struct ChromeCamera<S> {
    config: Config,
    http: reqwest::Client,
    storage: S,
}

impl<S: Storage> ChromeCamera<S> {
    pub fn new(config: Config, http: reqwest::Client, storage: S) -> Self {
        Self { config, http, storage }
    }

    /// Resolves an item id to its task (and language) through the app's server-side resolver.
    /// It works for a public item with no token and for the owner's own item with theirs.
    async fn resolve(&self, item: &str, token: Option<&str>) -> Result<(String, Option<String>), CameraError> {
        let app = &self.config.app_url;
        let url = format!("{app}/api/form/resolve");
        let mut request = self.http.get(&url).query(&[("id", item)]);
        if let Some(token) = token {
            request = request.header("Authorization", token);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            return Err(format!("could not resolve item {item}: HTTP {} from {url}", response.status().as_u16()).into());
        }
        let body: Json = response.json().await?;
        // The resolver echoes the id as the task id when it finds nothing.
        let task = body["taskId"].as_str().filter(|task| !task.is_empty() && *task != item);
        let Some(task) = task else {
            return Err(format!(
                "item {item} not found at {app} — wrong environment? Point GRAFFITICODE_APP_URL at where the item lives."
            )
            .into());
        };
        if body["allowed"] == false {
            return Err(format!(
                "item {item} resolved (task {task}) but its task is not public and no valid owner token was supplied."
            )
            .into());
        }
        Ok((task.to_owned(), body["lang"].as_str().map(str::to_owned)))
    }

    /// Waits until the page has painted content that has stopped changing. Returns `false` if
    /// it had not by `deadline`.
    async fn wait_for_render(&self, session: &Session, deadline: Instant) -> Result<bool, CameraError> {
        let mut previous: Option<Vec<u8>> = None;
        while Instant::now() < deadline {
            // The whole page, not the window: a form may render its content below the fold.
            let frame = pixels::decode(&session.capture_page().await?)?;
            let (luma, ..) = pixels::scan(&frame, PROBE_WIDTH, FilterType::Triangle);
            let background = luma.first().copied().unwrap_or(0);
            let ink = luma.iter().filter(|&&p| p.abs_diff(background) > INK_THRESHOLD).count();
            let still = previous.as_ref().is_some_and(|previous| {
                previous.len() == luma.len() && previous.iter().zip(&luma).all(|(a, b)| a.abs_diff(*b) <= INK_THRESHOLD)
            });
            if ink >= PROBE_MIN_INK && still {
                return Ok(true);
            }
            previous = Some(luma);
            tokio::time::sleep(PROBE_INTERVAL).await;
        }
        Ok(false)
    }

    /// Lays the form out, waits for it, and takes the photograph: the finished PNG.
    async fn photograph(&self, session: &Session, url: &str, request: &SnapRequest) -> Result<Vec<u8>, CameraError> {
        let dimension = |value: Option<f64>, default: u32| match value {
            Some(v) if v >= 1.0 => v.round() as u32,
            _ => default,
        };
        let (window_w, window_h) =
            (dimension(request.viewport.width, VIEWPORT.0), dimension(request.viewport.height, VIEWPORT.1));
        let bound = |value: Option<f64>| value.map(|v| (v.round().max(1.0)) as u32);
        let (max_w, max_h) = (bound(request.width), bound(request.height));

        session.set_window(window_w, window_h, DEVICE_SCALE).await?;
        let deadline = Instant::now() + RENDER_TIMEOUT;
        if !session.goto(url, RENDER_TIMEOUT).await? {
            tracing::warn!(item = %request.item, "the form did not finish loading in time; capturing anyway");
        }
        if !self.wait_for_render(session, deadline).await? {
            tracing::warn!(item = %request.item, "the form did not stop changing in time; capturing anyway");
        }
        tokio::time::sleep(SETTLE).await;

        if request.crop.is_set() {
            // A manual override: a fixed clip in the form's own pixels, anchored at the top.
            let width = request.crop.width.unwrap_or(f64::from(window_w)).min(f64::from(window_w));
            let height = request.crop.height.unwrap_or((width / CROP_ASPECT).round()).min(f64::from(window_h));
            let clip = CssRect { x: request.crop.x.unwrap_or(0.0), y: request.crop.y.unwrap_or(0.0), width, height };
            let shot = pixels::decode(&session.capture(clip).await?)?;
            return pixels::finish(&shot, None, max_w, max_h);
        }

        // Pass 1, measure: capture the whole form and decide the crop.
        let shot = pixels::decode(&session.capture_page().await?)?;
        let (luma, scan_w, scan_h) = pixels::scan(&shot, SCAN_WIDTH, FilterType::Lanczos3);
        let aspect = request.slice.as_deref().and_then(parse_aspect);
        let scan = Scan { width: scan_w, height: scan_h, luma: &luma };
        let rect = content_rect(scan, shot.width(), shot.height(), aspect, request.zoom);

        // How far would the final resize have to enlarge this crop to fill the output?
        let enlarge = match (max_w, max_h) {
            (None, None) => f64::from(pixels::DEFAULT_OUTPUT_WIDTH) / f64::from(rect.width),
            (w, h) => {
                let by = |bound: Option<u32>, side: u32| bound.map_or(0.0, |b| f64::from(b) / f64::from(side));
                by(w, rect.width).max(by(h, rect.height))
            }
        };
        let render_scale = (DEVICE_SCALE * enlarge.max(1.0)).min(MAX_DEVICE_SCALE);
        if render_scale <= DEVICE_SCALE + 1e-6 {
            // The crop is already at least output-sized: extract it and shrink.
            return pixels::finish(&shot, Some(rect), max_w, max_h);
        }
        // Pass 2, enlarge and re-capture. Device scale does not reflow the layout, so the crop
        // is the same rectangle of the form; only its pixel density changes.
        let css = |capture_px: u32| (f64::from(capture_px) / DEVICE_SCALE).round();
        let clip = CssRect {
            x: css(rect.left),
            y: css(rect.top),
            width: css(rect.width).max(1.0),
            height: css(rect.height).max(1.0),
        };
        session.set_window(window_w, window_h, render_scale).await?;
        tokio::time::sleep(RERENDER).await;
        let sharp = pixels::decode(&session.capture(clip).await?)?;
        pixels::finish(&sharp, None, max_w, max_h)
    }
}

/// The bare form, from the API's route (the app's mounts a sign-in shell around it). A public
/// task renders with no token; a private one when the token is its owner's.
fn form_url(api_url: &str, task: &str, lang: Option<&str>, token: Option<&str>) -> Result<String, CameraError> {
    let mut url = reqwest::Url::parse(&format!("{api_url}/form"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("id", task);
        if let Some(lang) = lang {
            query.append_pair("lang", lang);
        }
        if let Some(token) = token {
            query.append_pair("access_token", token);
        }
    }
    Ok(url.into())
}

/// Where an item's thumbnail is kept. The path is stable: each snap overwrites the last.
fn object_path(item: &str) -> String {
    let safe: String =
        item.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    format!("thumbnails/{safe}.png")
}

#[async_trait]
impl<S: Storage> Camera for ChromeCamera<S> {
    async fn snap(&self, request: SnapRequest) -> Result<Snapshot, CameraError> {
        let started = Instant::now();
        let token = request.token.as_deref().or(self.config.fallback_token.as_deref());
        let (task, lang) = match &request.task {
            Some(task) => (task.clone(), request.lang.clone()),
            None => self.resolve(&request.item, token).await?,
        };
        let url = form_url(&self.config.api_url, &task, lang.as_deref(), token)?;

        let session = Session::launch(self.config.chrome.as_deref()).await?;
        let photographed = self.photograph(&session, &url, &request).await;
        session.close().await;
        let png = photographed?;
        let captured = started.elapsed();

        let public_url = self.storage.put_png(&object_path(&request.item), &png).await?;
        tracing::info!(
            item = %request.item,
            capture_ms = captured.as_millis() as u64,
            total_ms = started.elapsed().as_millis() as u64,
            bytes = png.len(),
            "snap"
        );
        // The stored object is overwritten in place, so a fixed URL would be served stale. The
        // content hash changes the URL exactly when the image changes.
        let version = &hex::encode(Sha1::digest(&png))[..16];
        Ok(Snapshot { url: format!("{public_url}?v={version}"), item: request.item })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_url_carries_the_task_and_whatever_else_is_known() {
        assert_eq!(form_url("https://api.example", "task1", None, None).unwrap(), "https://api.example/form?id=task1");
        assert_eq!(
            form_url("https://api.example", "a+b", Some("0166"), Some("tok en")).unwrap(),
            "https://api.example/form?id=a%2Bb&lang=0166&access_token=tok+en"
        );
    }

    #[test]
    fn a_thumbnail_path_is_safe_whatever_the_item_is_called() {
        assert_eq!(object_path("abc-123_X"), "thumbnails/abc-123_X.png");
        assert_eq!(object_path("../etc/passwd"), "thumbnails/___etc_passwd.png");
        assert_eq!(object_path("a b/ç"), "thumbnails/a_b__.png");
    }
}
