// SPDX-License-Identifier: MIT

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use graffiticode_l0000::{Compiler, L0000};
use http_body_util::BodyExt;
use l0000r_server::auth::{AuthContext, AuthError, TokenVerifier};
use l0000r_server::{AppState, app};
use serde_json::{Value, json};
use tower::ServiceExt;

/// Accepts `good-token` as user `u1` and remembers every token it was shown.
#[derive(Default)]
struct Verifier {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl TokenVerifier for Verifier {
    async fn verify(&self, token: &str) -> Result<AuthContext, AuthError> {
        self.seen.lock().unwrap().push(token.to_owned());
        match token {
            "good-token" => Ok(AuthContext { uid: Some("u1".to_owned()) }),
            _ => Err(AuthError { code: "401".to_owned(), message: "invalid token".to_owned() }),
        }
    }
}

struct Server {
    app: Router,
    verifier: Arc<Verifier>,
    _static_dir: tempfile::TempDir,
}

fn server() -> Server {
    let static_dir = tempfile::tempdir().unwrap();
    std::fs::write(static_dir.path().join("index.html"), "<!doctype html><title>form</title>").unwrap();
    std::fs::write(static_dir.path().join("schema.json"), r#"{"type":"object"}"#).unwrap();
    std::fs::create_dir(static_dir.path().join("assets")).unwrap();
    std::fs::write(static_dir.path().join("assets/index-abc123.js"), "console.log(1)").unwrap();
    let verifier = Arc::new(Verifier::default());
    let state = AppState { compiler: Compiler::new(L0000), verifier: verifier.clone() };
    Server { app: app(state, static_dir.path()), verifier, _static_dir: static_dir }
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|err| panic!("{err}: {:?}", self.text()))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    Reply { status: parts.status, headers: parts.headers, body: body.collect().await.unwrap().to_bytes().to_vec() }
}

async fn get(app: &Router, uri: &str) -> Reply {
    send(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

fn post_compile(uri: &str) -> axum::http::request::Builder {
    Request::post(uri).header(header::CONTENT_TYPE, "application/json")
}

async fn compile(app: &Router, body: Value) -> Reply {
    send(app, post_compile("/compile").body(Body::from(body.to_string())).unwrap()).await
}

/// `add 1 2..`
fn add_1_2() -> Value {
    json!({
        "2": { "tag": "NUM", "elts": ["1"] }, "3": { "tag": "NUM", "elts": ["2"] },
        "6": { "tag": "ADD", "elts": [2, 3] }, "7": { "tag": "EXPRS", "elts": [6] },
        "8": { "tag": "PROG", "elts": [7] }, "root": 8,
    })
}

/// `data {}..`
fn data_program() -> Value {
    json!({
        "1": { "tag": "RECORD", "elts": [] }, "2": { "tag": "DATA", "elts": [1] },
        "3": { "tag": "EXPRS", "elts": [2] }, "4": { "tag": "PROG", "elts": [3] }, "root": 4,
    })
}

#[tokio::test]
async fn the_root_is_a_health_check() {
    let reply = get(&server().app, "/").await;
    assert_eq!((reply.status, reply.text().as_str()), (StatusCode::OK, "OK"));
}

#[tokio::test]
async fn compile_returns_the_data_envelope() {
    let reply = compile(&server().app, json!({ "code": add_1_2(), "data": {} })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "data": 3, "errors": [] }));
}

#[tokio::test]
async fn compile_reads_upstream_data_bare_or_enveloped() {
    let server = server();
    for data in [json!({ "x": 1 }), json!({ "data": { "x": 1 }, "errors": [] })] {
        let reply = compile(&server.app, json!({ "code": data_program(), "data": data })).await;
        assert_eq!(reply.json(), json!({ "data": { "x": 1 }, "errors": [] }));
    }
}

#[tokio::test]
async fn compile_errors_come_back_in_the_envelope() {
    // `add 1..` as the parser reports it.
    let code = json!({
        "4": { "tag": "NUM", "elts": ["3"] }, "5": { "tag": "NUM", "elts": ["0"] },
        "6": { "tag": "STR", "elts": ["Too few arguments for ADD. Expected 2."] },
        "7": { "tag": "ERROR", "elts": [6, 5, 4] }, "root": 7,
    });
    let reply = compile(&server().app, json!({ "code": code, "data": {} })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json(),
        json!({ "data": null, "errors": [{ "message": "Too few arguments for ADD. Expected 2.", "from": 0, "to": 3 }] })
    );
}

#[tokio::test]
async fn a_malformed_ast_is_a_compile_error() {
    let reply = compile(&server().app, json!({ "code": { "root": 9 }, "data": {} })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["errors"][0]["message"], "1001: Node ID 9 not found in pool.");
    assert_eq!(reply.json()["data"], Value::Null);
}

#[tokio::test]
async fn code_and_data_are_required() {
    let server = server();
    for body in
        [json!({}), json!({ "code": add_1_2() }), json!({ "data": {} }), json!({ "code": add_1_2(), "data": null })]
    {
        let reply = compile(&server.app, body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.json(), json!({ "error": "Missing required parameters: code and data" }));
    }
    let not_json = Request::post("/compile").header(header::CONTENT_TYPE, "application/json").body(Body::from("{"));
    assert_eq!(send(&server.app, not_json.unwrap()).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_anonymous_compile_never_consults_the_auth_service() {
    let server = server();
    let reply = compile(&server.app, json!({ "code": add_1_2(), "data": {} })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(server.verifier.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_token_is_verified_wherever_it_is_sent() {
    let server = server();
    let body = json!({ "code": add_1_2(), "data": {} });
    let in_header =
        post_compile("/compile").header(header::AUTHORIZATION, "Bearer good-token").body(Body::from(body.to_string()));
    assert_eq!(send(&server.app, in_header.unwrap()).await.json()["data"], 3);

    let in_query = post_compile("/compile?access_token=good-token").body(Body::from(body.to_string()));
    assert_eq!(send(&server.app, in_query.unwrap()).await.json()["data"], 3);

    let reply = compile(&server.app, json!({ "code": add_1_2(), "data": {}, "auth": "good-token" })).await;
    assert_eq!(reply.json()["data"], 3);
    assert_eq!(*server.verifier.seen.lock().unwrap(), ["good-token", "good-token", "good-token"]);
}

#[tokio::test]
async fn a_rejected_token_is_unauthorized() {
    let reply = compile(&server().app, json!({ "code": add_1_2(), "data": {}, "auth": "bad-token" })).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    assert_eq!(reply.json(), json!({ "status": "error", "error": { "code": 401, "message": "401 - invalid token" } }));
}

#[tokio::test]
async fn the_lexicon_is_served_under_both_names() {
    let server = server();
    for uri in ["/lexicon.json", "/lexicon.js"] {
        let reply = get(&server.app, uri).await;
        assert_eq!(reply.status, StatusCode::OK, "{uri}");
        assert_eq!(reply.headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(reply.json()["add"]["name"], "ADD");
        // The console slices from the first `{`.
        assert!(reply.text().starts_with('{'));
    }
}

#[tokio::test]
async fn static_assets_and_the_form_are_public() {
    let server = server();
    let schema = get(&server.app, "/schema.json").await;
    assert_eq!((schema.status, schema.json()), (StatusCode::OK, json!({ "type": "object" })));

    let asset = get(&server.app, "/assets/index-abc123.js").await;
    assert_eq!((asset.status, asset.text().as_str()), (StatusCode::OK, "console.log(1)"));

    let form = get(&server.app, "/form?id=abc&access_token=bad-token").await;
    assert_eq!(form.status, StatusCode::OK);
    assert!(form.text().contains("<title>form</title>"));
    assert!(form.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
    assert!(server.verifier.seen.lock().unwrap().is_empty());

    assert_eq!(get(&server.app, "/missing.json").await.status, StatusCode::NOT_FOUND);
    // A directory is not an index page: `/` stays the health check and nothing else lists.
    assert_eq!(get(&server.app, "/assets/").await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&server.app, "/../Cargo.toml").await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn every_response_can_be_embedded_cross_origin() {
    let server = server();
    for uri in ["/", "/form", "/schema.json", "/lexicon.json"] {
        let reply = send(
            &server.app,
            Request::get(uri).header(header::ORIGIN, "https://claude.ai").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(reply.headers["cross-origin-resource-policy"], "cross-origin", "{uri}");
        assert_eq!(reply.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*", "{uri}");
    }
    let body = json!({ "code": add_1_2(), "data": {} });
    let reply = send(
        &server.app,
        post_compile("/compile")
            .header(header::ORIGIN, "https://console.graffiticode.org")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
}

#[tokio::test]
async fn a_browser_preflight_is_answered() {
    let preflight = Request::options("/compile")
        .header(header::ORIGIN, "https://console.graffiticode.org")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type, authorization")
        .body(Body::empty())
        .unwrap();
    let reply = send(&server().app, preflight).await;
    assert!(reply.status.is_success(), "{}", reply.status);
    assert_eq!(reply.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert!(reply.headers.contains_key(header::ACCESS_CONTROL_ALLOW_METHODS));
    assert!(reply.headers.contains_key(header::ACCESS_CONTROL_ALLOW_HEADERS));
}

#[tokio::test]
async fn plain_http_behind_a_proxy_is_sent_to_https() {
    let server = server();
    let forwarded = |host: &str, proto: &str| {
        Request::get("/form?id=1")
            .header(header::HOST, host)
            .header("x-forwarded-proto", proto)
            .body(Body::empty())
            .unwrap()
    };
    let reply = send(&server.app, forwarded("l0000.graffiticode.org", "http")).await;
    assert_eq!(reply.status, StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(reply.headers[header::LOCATION], "https://l0000.graffiticode.org/form?id=1");

    assert_eq!(send(&server.app, forwarded("l0000.graffiticode.org", "https")).await.status, StatusCode::OK);
    assert_eq!(send(&server.app, forwarded("localhost:50000", "http")).await.status, StatusCode::OK);
}
