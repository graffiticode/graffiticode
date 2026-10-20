// SPDX-License-Identifier: MIT

//! One headless Chrome, one page: enough to lay a form out and photograph it.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;
use chromiumoxide::cdp::browser_protocol::page::{CaptureScreenshotFormat, CaptureScreenshotParams, Viewport};
use chromiumoxide::page::Page;
use futures_util::StreamExt;
use tokio::task::JoinHandle;

use crate::CameraError;
use crate::egress::{QUIET_DISABLED_FEATURES, QUIET_SWITCHES, build_nss_db, chrome_egress};

/// A rectangle in the page's own (CSS) pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct Session {
    browser: Browser,
    events: JoinHandle<()>,
    page: Page,
    // Each browser gets its own profile, so concurrent snaps never share one.
    _profile: tempfile::TempDir,
    // Behind the egress proxy: the HOME whose NSS database trusts the proxy's CA.
    _home: Option<tempfile::TempDir>,
}

impl Session {
    pub async fn launch(chrome: Option<&Path>) -> Result<Self, CameraError> {
        let profile = tempfile::Builder::new().prefix("l0013-chrome-").tempdir()?;
        // ISOLATE-01: with HTTPS_PROXY set, Chrome goes through the proxy and trusts its CA.
        let egress = chrome_egress(|name| std::env::var(name).ok())?;
        let mut config = BrowserConfig::builder()
            .no_sandbox()
            // Switch names without `--`: chromiumoxide adds it (a `--` here became `----x`, which
            // Chrome ignores).
            .args(["disable-setuid-sandbox", "disable-dev-shm-usage", "disable-gpu", "hide-scrollbars"])
            .args(QUIET_SWITCHES.iter().copied())
            .arg(("disable-features", QUIET_DISABLED_FEATURES))
            .args(egress.switches.iter().map(|(name, value)| (name.as_str(), value.as_str())))
            .user_data_dir(profile.path())
            // The window is sized per snap, through device metrics.
            .viewport(None);
        let home = match egress.ca {
            Some(ca) => {
                let home = tempfile::Builder::new().prefix("l0013-chrome-home-").tempdir()?;
                build_nss_db(home.path(), &ca)?;
                config = config.env("HOME", home.path().display().to_string());
                Some(home)
            }
            None => None,
        };
        if let Some(chrome) = chrome {
            config = config.chrome_executable(chrome);
        }
        let (browser, mut handler) = Browser::launch(config.build()?).await?;
        let events = tokio::spawn(async move { while handler.next().await.is_some() {} });
        let page = browser.new_page("about:blank").await?;
        Ok(Self { browser, events, page, _profile: profile, _home: home })
    }

    /// Sizes the window the page lays out into. Changing only the scale re-renders the same
    /// layout at a different pixel density.
    pub async fn set_window(&self, width: u32, height: u32, device_scale: f64) -> Result<(), CameraError> {
        self.page.execute(SetDeviceMetricsOverrideParams::new(width, height, device_scale, false)).await?;
        Ok(())
    }

    /// Loads `url`. Returns `false` if it had not finished loading within `timeout`; the page
    /// is left as it is, to be captured anyway.
    pub async fn goto(&self, url: &str, timeout: Duration) -> Result<bool, CameraError> {
        match tokio::time::timeout(timeout, self.page.goto(url)).await {
            Ok(loaded) => loaded.map(|_| true).map_err(Into::into),
            Err(_) => Ok(false),
        }
    }

    /// A PNG of the whole page, including what is below the fold.
    pub async fn capture_page(&self) -> Result<Vec<u8>, CameraError> {
        let size = self.page.layout_metrics().await?.css_content_size;
        self.capture(CssRect { x: 0.0, y: 0.0, width: size.width.max(1.0), height: size.height.max(1.0) }).await
    }

    /// A PNG of one rectangle of the page, at the current device scale.
    pub async fn capture(&self, clip: CssRect) -> Result<Vec<u8>, CameraError> {
        let params = CaptureScreenshotParams {
            format: Some(CaptureScreenshotFormat::Png),
            clip: Some(Viewport { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1.0 }),
            capture_beyond_viewport: Some(true),
            ..Default::default()
        };
        let shot = self.page.execute(params).await?;
        let encoded: &str = shot.result.data.as_ref();
        Ok(base64::engine::general_purpose::STANDARD.decode(encoded)?)
    }

    pub async fn close(mut self) {
        if self.browser.close().await.is_err() {
            let _ = self.browser.kill().await;
        }
        let _ = self.browser.wait().await;
        self.events.abort();
    }
}
