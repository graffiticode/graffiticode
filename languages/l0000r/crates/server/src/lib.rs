// SPDX-License-Identifier: MIT

//! The L0000 language server.
//!
//! | route | |
//! |---|---|
//! | `GET /` | health check |
//! | `POST /compile` | `{ code, data, config }` → `{ data, errors }` |
//! | `POST /preflight` | the gateway only: a stage's manifest, without running anything |
//! | `GET /form` | the embeddable View bundle |
//! | `GET /lexicon.json`, `GET /lexicon.js` | the lexicon |
//! | anything else | a file from the static directory |
//!
//! Everything is public. `/compile` verifies a token when one is sent, to learn who is
//! compiling, but does not require one.

pub mod auth;
pub mod gateway;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, RawQuery, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HOST, HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use graffiticode_l0000::{Compiler, Identity, Lexicon};
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::auth::{TokenVerifier, token_from_request};
use crate::gateway::{GatewayVerifier, canonical_lang};

const BODY_LIMIT: usize = 50 * 1024 * 1024;
const MISSING_PARAMETERS: &str = "Missing required parameters: code and data";

#[derive(Clone)]
pub struct AppState {
    pub compiler: Compiler,
    pub verifier: Arc<dyn TokenVerifier>,
    /// Who may preflight.
    pub gateways: Arc<dyn GatewayVerifier>,
    /// The Cloud Run revision this server runs as, reported to the gateway for a planned stage.
    pub revision: Option<String>,
}

/// `static_dir` holds the public assets (`schema.json`, `spec.html`, `instructions.md`, …) and
/// the View bundle, whose `index.html` is `/form`.
pub fn app(state: AppState, static_dir: impl Into<PathBuf>) -> Router {
    let static_dir = static_dir.into();
    Router::new()
        .route("/", get(|| async { "OK" }))
        .route("/compile", post(compile))
        .route("/preflight", post(preflight))
        .route_service("/form", ServeFile::new(static_dir.join("index.html")))
        .route("/lexicon.json", get(lexicon))
        // The deployed console still asks for lexicon.js; it reads the body from the first `{`
        // and parses it as JSON, so the same document serves both.
        .route("/lexicon.js", get(lexicon))
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(false))
        .with_state(state)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        // Lets the /form bundle load inside COEP-isolated hosts (widget iframes). Without it
        // the browser blocks the frame.
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("cross-origin"),
        ))
        .layer(CorsLayer::permissive())
        .layer(middleware::from_fn(require_https))
        .layer(TraceLayer::new_for_http())
}

/// Behind a proxy that terminated plain HTTP, send the caller to HTTPS. Only a proxy sets
/// `X-Forwarded-Proto`, so local requests pass through.
async fn require_https(request: Request, next: Next) -> Response {
    match https_location(request.headers(), request.uri()) {
        Some(location) => Redirect::temporary(&location).into_response(),
        None => next.run(request).await,
    }
}

fn https_location(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    let header = |name: HeaderName| headers.get(name)?.to_str().ok();
    let proto = header(HeaderName::from_static("x-forwarded-proto"))?;
    let host = header(HOST)?;
    (proto != "https" && !host.starts_with("localhost"))
        .then(|| format!("https://{host}{}", uri.path_and_query().map_or("/", |path| path.as_str())))
}

async fn lexicon() -> impl IntoResponse {
    ([(CONTENT_TYPE, "application/json")], Lexicon::base_json())
}

async fn compile(
    State(state): State<AppState>,
    uri: Uri,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return bad_request(MISSING_PARAMETERS);
    };
    let access_token = query.as_deref().and_then(|query| query_param(query, "access_token"));
    let token = token_from_request(access_token.as_deref(), &body, &headers);
    // The uid comes only from the verified token, never from the body.
    let uid = match &token {
        Some(token) => match state.verifier.verify(token).await {
            Ok(context) => context.uid,
            Err(err) => {
                tracing::debug!(%uri, error = %err, "token rejected");
                let error = json!({ "status": "error", "error": { "code": 401, "message": err.to_string() } });
                return (StatusCode::UNAUTHORIZED, Json(error)).into_response();
            }
        },
        None => None,
    };
    let (code, data) = (&body["code"], &body["data"]);
    if is_absent(code) || is_absent(data) {
        return bad_request(MISSING_PARAMETERS);
    }
    let field = |name: &str| body.get(name).and_then(Value::as_str).map(str::to_owned);
    let identity = Identity {
        // Policy re-verifies the user token, so it is forwarded only alongside a verified uid.
        user_token: uid.as_ref().and(token),
        uid,
        // The connection is the caller's selection, checked by policy. The invocation token and
        // stage come from the gateway; policy verifies the token, so a forged one only gets
        // the compile refused.
        connection_id: field("connectionId"),
        invocation_token: field("invocationToken"),
        stage: field("stage"),
        // The admitted plan, from the gateway; policy verifies it.
        admission_token: field("admissionToken"),
    };
    let planned = identity.admission_token.is_some();
    let compiled = state.compiler.compile(code, data, &body["config"], identity).await;
    // Compiled output goes in `data` and compile errors in `errors`, which is always present;
    // consumers branch on whether it is empty.
    let mut envelope = match compiled.result {
        Ok(value) => match value.to_json() {
            Some(data) => json!({ "data": data, "errors": [] }),
            None => json!({ "errors": [] }),
        },
        Err(errors) => json!({ "data": null, "errors": errors }),
    };
    // What the compile's protected writes did. The gateway collects it per stage and keeps it
    // out of the next stage's input.
    if !compiled.effects.is_empty() {
        envelope["effects"] = json!(compiled.effects);
    }
    // Under an admitted plan the gateway checks the revision that answered against the one
    // the plan pins.
    if planned {
        envelope["revision"] = json!(state.revision);
    }
    Json(envelope).into_response()
}

/// Preflight is side-effect free: it reads no user token and runs nothing.
async fn preflight(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let refused = |status: StatusCode, reason: &str, message: String| {
        let error = json!({ "code": status.as_u16(), "message": message, "reason": reason });
        (status, Json(json!({ "status": "error", "error": error, "data": null })))
    };
    let (status, body) = 'answer: {
        if let Err(caller) = state.gateways.verify(&headers).await {
            break 'answer refused(caller.status, caller.reason, "preflight is for the gateway only".to_owned());
        }
        let body = body.map(|Json(body)| body).unwrap_or(Value::Null);
        let stage = body["stage"].as_str().filter(|stage| is_stage(stage));
        let (Some(stage), code @ Value::Object(_)) = (stage, &body["code"]) else {
            let message = "preflight needs { stage, lang, code, config? }".to_owned();
            break 'answer refused(StatusCode::BAD_REQUEST, "bad-request", message);
        };
        let lang = match &body["lang"] {
            Value::String(lang) => Some(lang.clone()),
            Value::Number(lang) => Some(lang.to_string()),
            _ => None,
        };
        let ours = state.compiler.lang_id();
        if let Some(lang) = lang.filter(|lang| canonical_lang(lang) != ours) {
            let message = format!("this compiler is {ours}, not {lang}");
            break 'answer refused(StatusCode::BAD_REQUEST, "bad-request", message);
        }
        // `config` is what a compile runs with; a caller's `options` never reach the compiler,
        // so they are not hashed, and preflight and compile agree on the options digest.
        let data = match state.compiler.preflight(code, stage, &body["config"]) {
            Ok(manifest) => json!({ "manifest": manifest }),
            Err(errors) => json!({ "errors": errors }),
        };
        (StatusCode::OK, Json(json!({ "status": "success", "data": data })))
    };
    (status, [(CACHE_CONTROL, "no-store")], body).into_response()
}

/// `s0` … `s999`: a stage's position in the chain.
fn is_stage(stage: &str) -> bool {
    stage.strip_prefix('s').is_some_and(|n| (1..=3).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

/// `code` and `data` are required; an empty object counts as present.
fn is_absent(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

fn query_param(query: &str, name: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Pair(String, String);
    let pairs: Vec<Pair> = serde_urlencoded::from_str(query).ok()?;
    pairs.into_iter().find(|Pair(key, _)| key == name).map(|Pair(_, value)| value)
}
