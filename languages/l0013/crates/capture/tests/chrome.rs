// SPDX-License-Identifier: MIT

//! The capture pipeline against a real headless Chrome, a local stand-in for the Graffiticode
//! API and app, and storage that keeps the PNG in memory. Nothing here touches production.
//!
//! The Chrome tests are skipped, loudly, where no Chrome is installed (CI's Rust image has
//! none); the resolver tests need no browser.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Html;
use axum::routing::get;
use axum::{Json as Body, Router};
use graffiticode_l0013::{Camera, Clip, Size, SnapRequest};
use image::Rgba;
use l0013_capture::{CameraError, ChromeCamera, Config, Storage, pixels};
use serde_json::json;

const BLUE: Rgba<u8> = Rgba([0, 0, 255, 255]);
const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);

/// A form: a blue 300×150 block at (100, 80) on a white page.
const FORM: &str = r#"<!doctype html>
<html><body style="margin:0;background:#fff">
<div style="position:absolute;left:100px;top:80px;width:300px;height:150px;background:#00f"></div>
</body></html>"#;

/// What the stand-in API and app were asked.
#[derive(Default)]
struct Seen {
    forms: Mutex<Vec<HashMap<String, String>>>,
    resolver_tokens: Mutex<Vec<Option<String>>>,
}

async fn serve() -> (String, Arc<Seen>) {
    let seen = Arc::new(Seen::default());
    let app =
        Router::new()
            .route(
                "/form",
                get(|State(seen): State<Arc<Seen>>, Query(query): Query<HashMap<String, String>>| async move {
                    seen.forms.lock().unwrap().push(query);
                    Html(FORM)
                }),
            )
            .route(
                "/api/form/resolve",
                get(
                    |State(seen): State<Arc<Seen>>,
                     headers: HeaderMap,
                     Query(query): Query<HashMap<String, String>>| async move {
                        let token = headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned);
                        seen.resolver_tokens.lock().unwrap().push(token);
                        let id = query.get("id").cloned().unwrap_or_default();
                        Body(match id.as_str() {
                            "item1" => json!({ "taskId": "task1", "lang": "0166" }),
                            "private1" => json!({ "taskId": "task2", "allowed": false }),
                            // The real resolver echoes an id it does not know.
                            other => json!({ "taskId": other }),
                        })
                    },
                ),
            )
            .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

/// Object path and bytes of everything stored.
type Stored = Vec<(String, Vec<u8>)>;

#[derive(Clone, Default)]
struct Memory(Arc<Mutex<Stored>>);

#[async_trait]
impl Storage for Memory {
    async fn put_png(&self, object: &str, png: &[u8]) -> Result<String, CameraError> {
        self.0.lock().unwrap().push((object.to_owned(), png.to_vec()));
        Ok(format!("https://storage.example/bucket/{object}"))
    }
}

struct Studio {
    camera: ChromeCamera<Memory>,
    storage: Memory,
    seen: Arc<Seen>,
}

async fn studio() -> Studio {
    let (url, seen) = serve().await;
    let storage = Memory::default();
    let config = Config { api_url: url.clone(), app_url: url, chrome: None, fallback_token: None };
    Studio { camera: ChromeCamera::new(config, reqwest::Client::new(), storage.clone()), storage, seen }
}

fn chrome_is_installed() -> bool {
    let found = chromiumoxide::detection::default_executable(Default::default()).is_ok();
    if !found {
        eprintln!("SKIPPED: no Chrome found on this machine; the capture pipeline was not exercised");
    }
    found
}

fn item(id: &str) -> SnapRequest {
    SnapRequest { item: id.to_owned(), ..SnapRequest::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_snap_trims_to_the_content_and_stores_a_crisp_png() {
    if !chrome_is_installed() {
        return;
    }
    let studio = studio().await;
    let snapshot = studio.camera.snap(item("item1")).await.unwrap();

    // The item was resolved to its task and language, and that form was rendered.
    let forms = studio.seen.forms.lock().unwrap().clone();
    assert_eq!(forms[0].get("id").map(String::as_str), Some("task1"));
    assert_eq!(forms[0].get("lang").map(String::as_str), Some("0166"));
    assert!(!forms[0].contains_key("access_token"));

    let stored = studio.storage.0.lock().unwrap().clone();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, "thumbnails/item1.png");
    let (url, version) = snapshot.url.split_once("?v=").expect("a content-hash cache-buster");
    assert_eq!(url, "https://storage.example/bucket/thumbnails/item1.png");
    assert!(version.len() == 16 && version.bytes().all(|b| b.is_ascii_hexdigit()), "{version}");
    assert_eq!(snapshot.item, "item1");

    // The block plus an 8px margin is 316×166; at the default width that is 1024×538.
    let png = pixels::decode(&stored[0].1).unwrap().to_rgba8();
    assert_eq!(png.width(), 1024);
    assert!((530..=546).contains(&png.height()), "{}", png.height());
    assert_eq!(png.get_pixel(512, png.height() / 2), &BLUE);
    assert_eq!(png.get_pixel(3, 3), &WHITE);
    // The crop was smaller than the output, so it was re-rendered rather than enlarged: the
    // edge of the block is one sharp step, not a blur.
    let row = png.height() / 2;
    let edge: Vec<u32> = (0..60).filter(|&x| ![BLUE, WHITE].contains(png.get_pixel(x, row))).collect();
    assert!(edge.len() <= 2, "a soft edge {edge:?} means the image was upscaled");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_output_fits_the_size_asked_for() {
    if !chrome_is_installed() {
        return;
    }
    let studio = studio().await;
    studio.camera.snap(SnapRequest { width: Some(100.0), ..item("item1") }).await.unwrap();
    studio.camera.snap(SnapRequest { width: Some(400.0), height: Some(40.0), ..item("item1") }).await.unwrap();
    let stored = studio.storage.0.lock().unwrap().clone();
    let size = |i: usize| {
        let png = pixels::decode(&stored[i].1).unwrap();
        (png.width(), png.height())
    };
    assert_eq!(size(0).0, 100);
    assert!((50..=55).contains(&size(0).1), "{:?}", size(0));
    // Both bounds: the height is the tighter one.
    assert_eq!(size(1).1, 40);
    assert!((72..=80).contains(&size(1).0), "{:?}", size(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slice_frames_the_content_at_its_aspect() {
    if !chrome_is_installed() {
        return;
    }
    let studio = studio().await;
    studio.camera.snap(SnapRequest { slice: Some("1:1".into()), width: Some(200.0), ..item("item1") }).await.unwrap();
    let png = pixels::decode(&studio.storage.0.lock().unwrap()[0].1).unwrap().to_rgba8();
    assert_eq!(png.width(), 200);
    assert!((196..=204).contains(&png.height()), "a square: {}", png.height());
    // A 300×300 square around the 300×150 block: blue in the middle band, white above it.
    assert_eq!(png.get_pixel(100, 100), &BLUE);
    assert_eq!(png.get_pixel(100, 10), &WHITE);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_explicit_crop_is_taken_as_given() {
    if !chrome_is_installed() {
        return;
    }
    let studio = studio().await;
    let request = SnapRequest {
        crop: Clip { x: Some(100.0), y: Some(80.0), width: Some(300.0), height: Some(150.0) },
        width: Some(300.0),
        viewport: Size { width: Some(800.0), height: Some(600.0) },
        task: Some("explicit-task".into()),
        ..item("whatever")
    };
    studio.camera.snap(request).await.unwrap();
    let png = pixels::decode(&studio.storage.0.lock().unwrap()[0].1).unwrap().to_rgba8();
    assert_eq!((png.width(), png.height()), (300, 150));
    for (x, y) in [(2, 2), (150, 75), (297, 147)] {
        assert_eq!(png.get_pixel(x, y), &BLUE, "({x}, {y})");
    }
    // An explicit task is rendered directly; nothing is resolved.
    assert!(studio.seen.resolver_tokens.lock().unwrap().is_empty());
    assert_eq!(studio.seen.forms.lock().unwrap()[0].get("id").map(String::as_str), Some("explicit-task"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_callers_token_goes_to_the_resolver_and_the_form() {
    if !chrome_is_installed() {
        return;
    }
    let studio = studio().await;
    studio
        .camera
        .snap(SnapRequest { token: Some("owner-token".into()), width: Some(50.0), ..item("item1") })
        .await
        .unwrap();
    assert_eq!(*studio.seen.resolver_tokens.lock().unwrap(), [Some("owner-token".to_owned())]);
    assert_eq!(studio.seen.forms.lock().unwrap()[0].get("access_token").map(String::as_str), Some("owner-token"));
}

#[tokio::test]
async fn an_item_that_cannot_be_resolved_is_refused_before_any_browser_starts() {
    let studio = studio().await;
    let unknown = studio.camera.snap(item("nope")).await.unwrap_err().to_string();
    assert!(unknown.starts_with("item nope not found at http://127.0.0.1:"), "{unknown}");

    let private = studio.camera.snap(item("private1")).await.unwrap_err().to_string();
    assert_eq!(
        private,
        "item private1 resolved (task task2) but its task is not public and no valid owner token was supplied."
    );
    assert!(studio.seen.forms.lock().unwrap().is_empty());
    assert!(studio.storage.0.lock().unwrap().is_empty());
}
