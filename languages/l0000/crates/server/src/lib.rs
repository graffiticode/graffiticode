// SPDX-License-Identifier: MIT

//! The language server for L0000, and for any dialect built on it: [`serve`] runs one for a
//! [`Dialect`] and its lexicon.
//!
//! | route | |
//! |---|---|
//! | `GET /` | health check |
//! | `POST /compile` | `{ code, data, config }` → `{ data, errors }` (and `cache: false` for a language whose output expires) |
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
/// For a child language's own clients (ISOLATE-01): build them with `egress::client_builder()`.
pub use graffiticode_l0000::egress;
use graffiticode_l0000::policy_client::{HttpPolicyClient, MetadataIdTokens};
use graffiticode_l0000::schema::HttpSchemas;
use graffiticode_l0000::{Compiler, Dialect, Identity, Keyring, Lexicon, RevisionIdentity};
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::auth::{AuthService, TokenVerifier, token_from_request};
use crate::gateway::{GatewayVerifier, GoogleGateways, canonical_lang};

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
    /// The language's lexicon, as the JSON document served at `/lexicon.json`.
    pub lexicon: Arc<str>,
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

async fn lexicon(State(state): State<AppState>) -> impl IntoResponse {
    ([(CONTENT_TYPE, "application/json")], state.lexicon.to_string())
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
    // Output that carries something that expires (a signature) must not be stored or served
    // again; the API reads this, strips it, and neither caches the compile nor lets the
    // response be cached.
    if !state.compiler.cacheable() {
        envelope["cache"] = json!(false);
    }
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

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|value| !value.is_empty()).unwrap_or_else(|| default.to_owned())
}

/// Runs the language server for `dialect` until the process is told to stop.
///
/// Everything else comes from the environment: `PORT` (default `50000`), `AUTH_URL`,
/// `STATIC_DIR` (default `static`), `LOG_LEVEL`, `GRAFFITICODE_API_URL`, the
/// `GRAFFITICODE_SECRET_KEY(S)` keyring, and for chain admission `POLICY_URL`,
/// `PREFLIGHT_GATEWAYS`, `K_REVISION` and `GC_IMAGE_DIGEST`.
pub async fn serve(dialect: impl Dialect + 'static, lexicon: &Lexicon) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter(env_or("LOG_LEVEL", "info")).init();

    let port: u16 = env_or("PORT", "50000").parse()?;
    let auth_url = env_or("AUTH_URL", "https://auth.graffiticode.org");
    let static_dir = env_or("STATIC_DIR", "static");
    if !std::path::Path::new(&static_dir).join("index.html").is_file() {
        tracing::warn!(%static_dir, "no index.html in the static directory; /form will be 404 (run `npm run build:static`)");
    }

    // ISOLATE-01: every outbound request goes through the egress proxy when HTTPS_PROXY is set;
    // identity tokens come from the metadata server directly (`MetadataIdTokens::direct`).
    let egress = graffiticode_l0000::egress::EgressEnv::from_env();
    if let Some((proxy, _)) = &egress.proxy {
        tracing::info!(%proxy, "outbound requests go through the egress proxy");
    }
    let client = graffiticode_l0000::egress::client_builder_with(&egress)?
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let revision = RevisionIdentity::from_env();
    let mut compiler = Compiler::new(dialect)
        .with_schemas(HttpSchemas::from_env(client.clone()))
        .with_keyring(Keyring::from_env())
        .with_revision(revision.clone());
    // Chain admission: with POLICY_URL, a stage of an admitted plan asks policy for its
    // binding. BROKER_URL is needed only by a language with protected functions.
    let policy_url = env_or("POLICY_URL", "");
    if !policy_url.is_empty() {
        let broker_url = Some(env_or("BROKER_URL", "")).filter(|url| !url.is_empty());
        let id_tokens = MetadataIdTokens::direct()?;
        compiler = compiler.with_policy(HttpPolicyClient::new(client.clone(), policy_url, broker_url, id_tokens));
    }
    // The gateway service accounts allowed to preflight. With none, every preflight is refused.
    let gateways: Vec<String> = env_or("PREFLIGHT_GATEWAYS", "").split(',').map(str::to_owned).collect();
    let lang_id = compiler.lang_id().to_owned();
    let state = AppState {
        gateways: Arc::new(GoogleGateways::new(client.clone(), &lang_id, &gateways)),
        verifier: Arc::new(AuthService::new(client, &auth_url)),
        revision: revision.revision,
        lexicon: serde_json::to_string(lexicon)?.into(),
        compiler,
    };

    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(lang = %lang_id, port, %auth_url, %static_dir, "language server listening");
    axum::serve(listener, app(state, static_dir)).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

/// Cloud Run stops an instance with SIGTERM; finish the requests in flight first.
async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("install the SIGTERM handler");
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
