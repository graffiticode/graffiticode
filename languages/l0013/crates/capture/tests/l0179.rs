// SPDX-License-Identifier: MIT

//! C5: a command's capture of a real L0179 form, under a render grant, through L0179's own
//! /form View bundle (`tools/build-capture-test-views.mjs`), with its assets slow (cold, as
//! from l0179r) and immediate (as from the edge cache).
//!
//! In production the View's first `update` posted a compile, which a render grant refuses, and
//! when the assets came from the edge the camera photographed the refusal ("failed to post
//! compile ..."). In the display-only capture context the camera sets, nothing is posted and
//! the settled sheet is what is photographed, however fast the assets arrive.
//!
//! Needs Chrome and a built View: `L0179_VIEW_DIR` (the fixed build). With
//! `L0179_RELEASED_VIEW_DIR` too, the released build is run as the control: it must still post
//! the compile, or this test proves nothing. Skipped, loudly, without them. The View sends its
//! API calls to `http://localhost:3100` when served from localhost, so the stand-in API listens
//! there, and the tests here take turns with it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json as Body, Router};
use graffiticode_l0013::{Camera, RenderGrant, SnapRequest};
use l0013_capture::{CameraError, ChromeCamera, Config, Storage, pixels};
use serde_json::{Value, json};

const API_PORT: u16 = 3100;
const TASK: &str = "eyJ0YXNrSWRzIjpbInZRQ0NtYjlMR01KalBJVTlXQjA4Il19";
const ITEM: &str = "c5a-fixture";
const GRANT: &str = "grant-l0179";
const GRANT_HEADER: &str = "graffiticode-render-grant";
/// The compiled sheet, exactly as production's GET /data answered it for the public fixture.
const DATA: &str = include_str!("fixtures/l0179-sheet.data.json");
/// One API test at a time: they share port 3100.
static PORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct Seen {
    /// (path, grant header) of every API request.
    requests: Mutex<Vec<(String, Option<String>)>>,
    compiles: Mutex<usize>,
}

fn cors(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Percent-encodes a query value as `URLSearchParams` does (the api's /form writes the data URL
/// this way).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => (b as char).to_string(),
            b' ' => "+".to_owned(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn grant_of(headers: &HeaderMap) -> Option<String> {
    headers.get(GRANT_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The API, as production answers a capture under a render grant: /form redirects to the
/// language's View with the data URL, /data answers the stored sheet, and POST /compile is
/// refused (a grant reads only).
async fn serve_api(view_origin: String, seen: Arc<Seen>) -> tokio::task::JoinHandle<()> {
    let data_url = format!("http://localhost:{API_PORT}/data?id={TASK}&generations=%40L0179%3Dinterp-4");
    let app = Router::new()
        .route(
            "/form",
            get(|State((seen, view, data)): State<(Arc<Seen>, String, String)>, headers: HeaderMap| async move {
                seen.requests.lock().unwrap().push(("/form".into(), grant_of(&headers)));
                let location = format!("{view}/form?id={TASK}&url={}", encode(&data));
                let mut response = StatusCode::FOUND.into_response();
                response.headers_mut().insert(header::LOCATION, HeaderValue::from_str(&location).unwrap());
                response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
            }),
        )
        .route(
            "/data",
            get(|State((seen, _, _)): State<(Arc<Seen>, String, String)>, headers: HeaderMap| async move {
                seen.requests.lock().unwrap().push(("/data".into(), grant_of(&headers)));
                cors(Body(serde_json::from_str::<Value>(DATA).unwrap()).into_response())
            })
            .options(|| async { cors(StatusCode::NO_CONTENT.into_response()) }),
        )
        .route(
            "/compile",
            axum::routing::post(
                |State((seen, _, _)): State<(Arc<Seen>, String, String)>, headers: HeaderMap| async move {
                    seen.requests.lock().unwrap().push(("/compile".into(), grant_of(&headers)));
                    *seen.compiles.lock().unwrap() += 1;
                    cors(
                        (
                            StatusCode::NOT_FOUND,
                            Body(json!({ "status": "error", "error": { "code": 404, "message": "" } })),
                        )
                            .into_response(),
                    )
                },
            )
            .options(|| async { cors(StatusCode::NO_CONTENT.into_response()) }),
        )
        .route(
            "/api/form/resolve",
            get(|Query(query): Query<HashMap<String, String>>| async move {
                // As production's resolver answered the gate's fixture: its task, no language.
                assert_eq!(query.get("id").map(String::as_str), Some(ITEM));
                Body(json!({ "taskId": TASK }))
            }),
        )
        .with_state((seen, view_origin, data_url));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", API_PORT))
        .await
        .unwrap_or_else(|e| panic!("the stand-in API needs 127.0.0.1:{API_PORT} (the View's localhost API): {e}"));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() })
}

/// L0179's View bundle: /form is its index.html, and every asset waits `delay` first.
async fn serve_view(dir: PathBuf, delay: Duration) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route(
            "/form",
            get(|State((dir, _)): State<(PathBuf, Duration)>| async move {
                let html = std::fs::read_to_string(dir.join("index.html")).unwrap();
                ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html)
            }),
        )
        .route(
            "/assets/{file}",
            get(|State((dir, delay)): State<(PathBuf, Duration)>, Path(file): Path<String>| async move {
                tokio::time::sleep(delay).await;
                let bytes = std::fs::read(dir.join("assets").join(&file)).unwrap();
                let kind = if file.ends_with(".js") { "text/javascript" } else { "text/css" };
                ([(header::CONTENT_TYPE, kind)], bytes)
            }),
        )
        .with_state((dir, delay));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // `localhost`, so the View sends its API calls to localhost:3100 (l0000-view's lib/api.ts).
    let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
    (origin, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }))
}

struct Discard;

#[async_trait::async_trait]
impl Storage for Discard {
    async fn put_png(&self, _: &str, _: &[u8]) -> Result<String, CameraError> {
        unreachable!("a command's capture stores nothing")
    }
}

/// One command capture of the fixture under a render grant, with assets delayed by `delay`.
async fn capture(view_dir: &std::path::Path, delay: Duration) -> (Vec<u8>, Vec<(String, Option<String>)>, usize) {
    let seen = Arc::new(Seen::default());
    let (view_origin, view) = serve_view(view_dir.to_path_buf(), delay).await;
    let api = serve_api(view_origin, seen.clone()).await;
    let api_url = format!("http://localhost:{API_PORT}");
    let config = Config { api_url: api_url.clone(), app_url: api_url, chrome: None, fallback_token: None };
    let camera = ChromeCamera::new(config, reqwest::Client::new(), Discard);
    let request = SnapRequest {
        item: ITEM.to_owned(),
        render_grant: Some(RenderGrant::new(GRANT.into(), 1)),
        ..SnapRequest::default()
    };
    let png = camera.render(request).await.unwrap();
    api.abort();
    view.abort();
    let _ = api.await;
    let requests = seen.requests.lock().unwrap().clone();
    let compiles = *seen.compiles.lock().unwrap();
    (png, requests, compiles)
}

/// What the sheet looks like, from its pixels: the share of reddish pixels (the error banner is
/// Tailwind's red-50 on red-200) and how many are the focus outline's blue.
fn looks(png: &[u8]) -> (f64, usize, (u32, u32)) {
    let image = pixels::decode(png).unwrap().to_rgba8();
    let total = (image.width() * image.height()) as f64;
    let reddish = image.pixels().filter(|p| p[0] as i32 - (p[1].max(p[2]) as i32) >= 8).count() as f64 / total;
    let blue = image.pixels().filter(|p| p[2] as i32 - p[0] as i32 >= 60).count();
    (reddish, blue, (image.width(), image.height()))
}

fn view_dir(var: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var(var).ok()?);
    dir.join("index.html").exists().then_some(dir)
}

fn ready() -> Option<PathBuf> {
    if chromiumoxide::detection::default_executable(Default::default()).is_err() {
        eprintln!("SKIPPED: no Chrome found on this machine; the L0179 capture was not exercised");
        return None;
    }
    let dir = view_dir("L0179_VIEW_DIR");
    if dir.is_none() {
        eprintln!("SKIPPED: set L0179_VIEW_DIR to a built L0179 View (tools/build-capture-test-views.mjs)");
    }
    dir
}

const COLD: Duration = Duration::from_millis(1_500);
const CACHED: Duration = Duration::ZERO;

#[tokio::test(flavor = "multi_thread")]
async fn a_capture_of_l0179_posts_no_compile_and_photographs_the_settled_sheet_cold_and_cached() {
    let Some(dir) = ready() else { return };
    let _port = PORT.lock().await;
    let mut images = vec![];
    for (label, delay) in [("cold", COLD), ("cached", CACHED)] {
        let (png, requests, compiles) = capture(&dir, delay).await;
        assert_eq!(compiles, 0, "{label}: the capture posted a compile: {requests:?}");
        let paths: Vec<&str> = requests.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, ["/form", "/data"], "{label}: {requests:?}");
        assert!(requests.iter().all(|(_, g)| g.as_deref() == Some(GRANT)), "{label}: {requests:?}");
        let (reddish, blue, size) = looks(&png);
        assert!(reddish < 0.001, "{label}: the photograph shows an error ({reddish:.3} reddish)");
        assert!(blue >= 500, "{label}: the sheet's focused cell isn't in the photograph ({blue} blue pixels)");
        eprintln!("{label}: {size:?}, {reddish:.4} reddish, {blue} blue, {} bytes", png.len());
        images.push(png);
    }
    // Settled: however fast the assets came, the same sheet.
    let decoded: Vec<_> = images.iter().map(|png| pixels::decode(png).unwrap().to_rgba8()).collect();
    assert_eq!(decoded[0].dimensions(), decoded[1].dimensions());
    assert!(decoded[0].as_raw() == decoded[1].as_raw(), "the cold and cached photographs differ");
}

/// The control: the released View, which production ran, must still post the compile (and,
/// with cached assets, photograph its refusal), or the test above can't tell the fix apart.
#[tokio::test(flavor = "multi_thread")]
async fn the_released_view_posts_the_compile_production_photographed() {
    if ready().is_none() {
        return;
    }
    let Some(dir) = view_dir("L0179_RELEASED_VIEW_DIR") else {
        eprintln!("SKIPPED: set L0179_RELEASED_VIEW_DIR to run the released View as the control");
        return;
    };
    let _port = PORT.lock().await;
    for (label, delay) in [("cold", COLD), ("cached", CACHED)] {
        let (png, requests, compiles) = capture(&dir, delay).await;
        assert!(compiles >= 1, "{label}: the released View posted no compile: {requests:?}");
        let (reddish, blue, _) = looks(&png);
        eprintln!("{label} (released): {compiles} compile(s), {reddish:.3} reddish, {blue} blue");
        if delay == CACHED {
            assert!(reddish > 0.5, "cached (released): the refusal wasn't photographed ({reddish:.3} reddish)");
        }
    }
}
