// SPDX-License-Identifier: MIT

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use aws_lc_rs::encoding::AsDer;
use aws_lc_rs::rsa::{KeyPair as RsaKeyPair, KeySize};
use aws_lc_rs::signature::KeyPair as _;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use graffiticode_l0000::canonical::args_digest;
use graffiticode_l0000::{Compiler, L0000, RevisionIdentity};
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use l0000r_server::auth::{AuthContext, AuthError, TokenVerifier};
use l0000r_server::gateway::GoogleGateways;
use l0000r_server::{AppState, FormCaching, HttpCaching, app_with};
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

const GATEWAY: &str = "api-run@graffiticode.iam.gserviceaccount.com";
const REVISION: &str = "l0000-00042-abc";

/// A throwaway RS256 key standing in for Google's ID-token signing key.
struct GoogleKey {
    encoding: EncodingKey,
    jwk: Value,
}

impl GoogleKey {
    fn generate() -> Self {
        let pair = RsaKeyPair::generate(KeySize::Rsa2048).unwrap();
        let public = pair.public_key();
        let number = |bytes: &[u8]| URL_SAFE_NO_PAD.encode(bytes);
        let jwk = json!({
            "kty": "RSA", "kid": "g1", "alg": "RS256", "use": "sig",
            "n": number(public.modulus().big_endian_without_leading_zero()),
            "e": number(public.exponent().big_endian_without_leading_zero()),
        });
        // PKCS#8 wraps the PKCS#1 key the signer wants in a fixed 26-byte header.
        let pkcs8 = AsDer::<aws_lc_rs::encoding::Pkcs8V1Der>::as_der(&pair).unwrap();
        Self { encoding: EncodingKey::from_rsa_der(&pkcs8.as_ref()[26..]), jwk }
    }

    /// An ID token as Google issues one for a service account, with `claims` laid over it.
    fn id_token(&self, claims: Value) -> String {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let mut all = json!({
            "iss": "https://accounts.google.com", "aud": "urn:graffiticode:0000", "iat": now, "exp": now + 3600,
            "email": GATEWAY, "email_verified": true,
        });
        all.as_object_mut().unwrap().extend(claims.as_object().unwrap().clone());
        let header = Header { kid: Some("g1".to_owned()), ..Header::new(Algorithm::RS256) };
        jsonwebtoken::encode(&header, &all, &self.encoding).unwrap()
    }
}

static GOOGLE: std::sync::LazyLock<GoogleKey> = std::sync::LazyLock::new(GoogleKey::generate);

fn server() -> Server {
    server_for(Compiler::new(L0000))
}

fn server_for(compiler: Compiler) -> Server {
    server_with(compiler, HttpCaching::default())
}

fn server_with(compiler: Compiler, caching: HttpCaching) -> Server {
    let static_dir = tempfile::tempdir().unwrap();
    std::fs::write(static_dir.path().join("index.html"), "<!doctype html><title>form</title>").unwrap();
    std::fs::write(static_dir.path().join("schema.json"), r#"{"type":"object"}"#).unwrap();
    std::fs::create_dir(static_dir.path().join("assets")).unwrap();
    std::fs::write(static_dir.path().join("assets/index-abc123.js"), "console.log(1)").unwrap();
    let verifier = Arc::new(Verifier::default());
    let revision = RevisionIdentity {
        revision: Some(REVISION.to_owned()),
        image_digest: Some(format!("sha256:{}", "1".repeat(64))),
    };
    let keys = serde_json::from_value(json!({ "keys": [GOOGLE.jwk] })).unwrap();
    let state = AppState {
        compiler: compiler.with_revision(revision),
        verifier: verifier.clone(),
        gateways: Arc::new(GoogleGateways::with_keys("0000", &[GATEWAY.to_owned()], keys)),
        revision: Some(REVISION.to_owned()),
        lexicon: graffiticode_l0000::Lexicon::base_json().into(),
    };
    Server { app: app_with(state, static_dir.path(), caching), verifier, _static_dir: static_dir }
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

async fn interpret(app: &Router, body: Value) -> Reply {
    send(app, post_compile("/interpret").body(Body::from(body.to_string())).unwrap()).await
}

// B1 (docs/graffiticode-interpreter-plan.md): the model form, and the interpreter pass.
#[tokio::test]
async fn compile_returns_a_model_only_when_asked() {
    let server = server();
    let reply = compile(&server.app, json!({ "code": data_program(), "data": {}, "form": "model" })).await;
    assert_eq!(reply.status, StatusCode::OK);
    let body = reply.json();
    assert_eq!(body["errors"], json!([]));
    assert_eq!((body["model"]["lang"].clone(), body["model"]["kind"].clone()), (json!("0000"), json!("plan")));
    assert_eq!(body["model"]["program"], data_program());
    // Asked for nothing, or for null: today's envelope.
    let reply = compile(&server.app, json!({ "code": data_program(), "data": { "x": 1 }, "form": null })).await;
    assert_eq!(reply.json(), json!({ "data": { "x": 1 }, "errors": [] }));
    assert_eq!(
        compile(&server.app, json!({ "code": data_program(), "data": {}, "form": "value" })).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn interpreting_a_model_answers_as_compiling_its_program_does() {
    let server = server();
    for (code, input) in [
        (add_1_2(), json!({})),
        (data_program(), json!({ "x": 1 })),
        (data_program(), json!({ "data": { "x": 1 }, "errors": [] })),
    ] {
        let model =
            compile(&server.app, json!({ "code": code, "data": {}, "form": "model" })).await.json()["model"].clone();
        let compiled = compile(&server.app, json!({ "code": code, "data": input })).await;
        for mode in [json!(null), json!("evaluate"), json!("present")] {
            let interpreted = interpret(&server.app, json!({ "model": model, "input": input, "mode": mode })).await;
            assert_eq!(
                (interpreted.status, interpreted.text()),
                (compiled.status, compiled.text()),
                "{code} {input} {mode}"
            );
        }
    }
}

#[tokio::test]
async fn interpret_refuses_what_isn_t_a_model_or_a_mode() {
    let server = server();
    let model =
        compile(&server.app, json!({ "code": add_1_2(), "data": {}, "form": "model" })).await.json()["model"].clone();
    let mut tampered = model.clone();
    tampered["program"]["root"] = json!(2);
    for body in [
        json!({ "input": {} }),
        json!({ "model": model }),
        json!({ "model": tampered, "input": {} }),
        json!({ "model": { "kind": "plan" }, "input": {} }),
        json!({ "model": model, "input": {}, "mode": "render" }),
    ] {
        assert_eq!(interpret(&server.app, body.clone()).await.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let other =
        json!({ "lang": "0158", "kind": model["kind"], "digest": model["digest"], "program": model["program"] });
    let reply = interpret(&server.app, json!({ "model": other, "input": {} })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["errors"][0]["code"], "model-language-mismatch");
    let reply = interpret(&server.app, json!({ "model": model, "input": {}, "auth": "bad-token" })).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
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
        // As Express serves the file in the TypeScript servers.
        assert_eq!(reply.headers[header::CONTENT_TYPE], "application/json; charset=UTF-8");
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

// P4: a language's caching matches its TypeScript server's, so switching its routing changes no
// response header.
#[tokio::test]
async fn by_default_static_files_carry_express_s_headers() {
    let server = server();
    for (uri, content_type) in [
        ("/form", "text/html; charset=UTF-8"),
        ("/schema.json", "application/json; charset=UTF-8"),
        ("/lexicon.json", "application/json; charset=UTF-8"),
        ("/lexicon.js", "application/json; charset=UTF-8"),
        ("/assets/index-abc123.js", "text/javascript; charset=UTF-8"),
    ] {
        let reply = get(&server.app, uri).await;
        assert_eq!(reply.status, StatusCode::OK, "{uri}");
        assert_eq!(reply.headers[header::CACHE_CONTROL], "public, max-age=0", "{uri}");
        assert_eq!(reply.headers[header::CONTENT_TYPE], content_type, "{uri}");
    }
    // A miss is never marked, and the routes that compute an answer are left as they are.
    assert!(get(&server.app, "/missing.json").await.headers.get(header::CACHE_CONTROL).is_none());
    let compiled = compile(&server.app, json!({ "code": add_1_2(), "data": {} })).await;
    assert!(compiled.headers.get(header::CACHE_CONTROL).is_none());
    assert_eq!(compiled.headers[header::CONTENT_TYPE], "application/json");
}

#[tokio::test]
async fn a_language_can_keep_its_form_from_being_cached() {
    let no_cache =
        server_with(Compiler::new(L0000), HttpCaching { form: FormCaching::NoCache, immutable_assets: false });
    let form = get(&no_cache.app, "/form?id=abc").await;
    assert_eq!(form.headers[header::CACHE_CONTROL], "no-cache");
    assert!(form.headers.get("cdn-cache-control").is_none());

    let no_store =
        server_with(Compiler::new(L0000), HttpCaching { form: FormCaching::NoStore, immutable_assets: false });
    let form = get(&no_store.app, "/form").await;
    assert_eq!(form.status, StatusCode::OK);
    assert_eq!(form.headers[header::CACHE_CONTROL], "no-store, no-cache, must-revalidate");
    assert_eq!(form.headers["cdn-cache-control"], "no-store");
    assert_eq!(form.headers["cloudflare-cdn-cache-control"], "no-store");
    // Only the form; other files keep Express's default.
    assert_eq!(get(&no_store.app, "/schema.json").await.headers[header::CACHE_CONTROL], "public, max-age=0");
}

#[tokio::test]
async fn hashed_assets_are_immutable_and_a_miss_is_never_marked() {
    let server = server_with(Compiler::new(L0000), HttpCaching { form: FormCaching::NoStore, immutable_assets: true });
    let asset = get(&server.app, "/assets/index-abc123.js").await;
    assert_eq!(asset.status, StatusCode::OK);
    assert_eq!(asset.headers[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    let missing = get(&server.app, "/assets/index-gone.js").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert!(missing.headers.get(header::CACHE_CONTROL).is_none());
    // Not under /assets/: Express's default.
    assert_eq!(get(&server.app, "/schema.json").await.headers[header::CACHE_CONTROL], "public, max-age=0");
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

async fn preflight(app: &Router, caller: Option<&str>, body: Value) -> Reply {
    let mut request = Request::post("/preflight").header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = caller {
        request = request.header("x-caller-identity", token);
    }
    send(app, request.body(Body::from(body.to_string())).unwrap()).await
}

#[tokio::test]
async fn preflight_answers_the_gateway_with_the_stage_manifest() {
    let gateway = GOOGLE.id_token(json!({}));
    let request =
        json!({ "stage": "s1", "lang": "L0000", "code": add_1_2(), "config": { "a": 1 }, "options": { "b": 2 } });
    let reply = preflight(&server().app, Some(&gateway), request).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        reply.json(),
        json!({
            "status": "success",
            "data": { "manifest": {
                "stage": "s1", "lang": "0000",
                "sourceDigest": args_digest(&add_1_2()), "programDigest": args_digest(&add_1_2()),
                // The request's config is hashed, never its options, so preflight and compile agree.
                "optionsDigest": args_digest(&json!({ "a": 1 })),
                "revision": REVISION, "imageDigest": format!("sha256:{}", "1".repeat(64)),
                "registryVersion": 0, "requiredFunctions": [],
            } },
        })
    );

    // With no config, the options are the empty options, whatever else the request carries.
    let request = json!({ "stage": "s0", "code": add_1_2(), "options": { "a": 1 } });
    let reply = preflight(&server().app, Some(&format!("Bearer {gateway}")), request).await;
    assert_eq!(reply.json()["data"]["manifest"]["optionsDigest"], args_digest(&json!({})));
}

#[tokio::test]
async fn preflight_reports_a_program_that_would_not_compile() {
    let code = json!({
        "4": { "tag": "NUM", "elts": ["3"] }, "5": { "tag": "NUM", "elts": ["0"] },
        "6": { "tag": "STR", "elts": ["Too few arguments for ADD. Expected 2."] },
        "7": { "tag": "ERROR", "elts": [6, 5, 4] }, "root": 7,
    });
    let reply =
        preflight(&server().app, Some(&GOOGLE.id_token(json!({}))), json!({ "stage": "s0", "code": code })).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["data"]["errors"][0]["message"], "Too few arguments for ADD. Expected 2.");
    assert_eq!(reply.json()["data"].get("manifest"), None);
}

#[tokio::test]
async fn preflight_is_for_the_gateway_only() {
    let server = server();
    let impostor = GoogleKey::generate();
    let unsigned = {
        let part = |value: Value| URL_SAFE_NO_PAD.encode(value.to_string());
        let claims = json!({
            "email": GATEWAY, "email_verified": true, "aud": "urn:graffiticode:0000",
            "iss": "https://accounts.google.com",
        });
        format!("{}.{}.", part(json!({ "alg": "none" })), part(claims))
    };
    let past = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 10;
    for (who, token, status, reason) in [
        ("an anonymous caller", None, 401, "caller-rejected"),
        (
            "another service account",
            Some(GOOGLE.id_token(json!({ "email": "l0176-run@graffiticode.iam.gserviceaccount.com" }))),
            403,
            "route-not-allowed-for-caller",
        ),
        (
            "an unverified email",
            Some(GOOGLE.id_token(json!({ "email_verified": false }))),
            403,
            "route-not-allowed-for-caller",
        ),
        (
            "another language's audience",
            Some(GOOGLE.id_token(json!({ "aud": "urn:graffiticode:0176" }))),
            401,
            "caller-rejected",
        ),
        ("another issuer", Some(GOOGLE.id_token(json!({ "iss": "https://example.test" }))), 401, "caller-rejected"),
        ("an expired token", Some(GOOGLE.id_token(json!({ "exp": past }))), 401, "caller-rejected"),
        ("a token signed by someone else", Some(impostor.id_token(json!({}))), 401, "caller-rejected"),
        ("an unsigned token", Some(unsigned), 401, "caller-rejected"),
    ] {
        let reply = preflight(&server.app, token.as_deref(), json!({ "stage": "s1", "code": add_1_2() })).await;
        assert_eq!(reply.status.as_u16(), status, "{who}");
        assert_eq!(
            reply.json(),
            json!({
                "status": "error", "data": null,
                "error": { "code": status, "message": "preflight is for the gateway only", "reason": reason },
            }),
            "{who}"
        );
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store", "{who}");
    }

    // The identity is read from its own header: the same token as a bearer token is no identity.
    let bearer = Request::post("/preflight")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {}", GOOGLE.id_token(json!({}))))
        .body(Body::from(json!({ "stage": "s1", "code": add_1_2() }).to_string()));
    assert_eq!(send(&server.app, bearer.unwrap()).await.status, StatusCode::UNAUTHORIZED);
    // Preflight reads no user token.
    assert!(server.verifier.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn preflight_refuses_a_malformed_request_or_another_languages_program() {
    let server = server();
    let gateway = GOOGLE.id_token(json!({}));
    for (body, message) in [
        (json!({ "stage": "first", "code": add_1_2() }), "preflight needs { stage, lang, code, config? }"),
        (json!({ "stage": "s1234", "code": add_1_2() }), "preflight needs { stage, lang, code, config? }"),
        (json!({ "stage": "s1" }), "preflight needs { stage, lang, code, config? }"),
        (json!({ "stage": "s1", "code": [] }), "preflight needs { stage, lang, code, config? }"),
        (json!({ "stage": "s1", "lang": "0176", "code": add_1_2() }), "this compiler is 0000, not 0176"),
    ] {
        let reply = preflight(&server.app, Some(&gateway), body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.json()["error"], json!({ "code": 400, "message": message, "reason": "bad-request" }));
    }
}

#[tokio::test]
async fn a_planned_stage_reports_the_revision_that_answered() {
    let server = server();
    // No policy is configured here, so the stage is refused; the revision is reported anyway.
    let planned = json!({ "code": add_1_2(), "data": {}, "stage": "s0", "admissionToken": "adm" });
    let reply = compile(&server.app, planned).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json(),
        json!({
            "data": null,
            "errors": [{
                "message": "This compiler can't run an admitted plan: no permission service is configured.",
                "from": -1, "to": -1,
            }],
            "revision": REVISION,
        })
    );
    // An ordinary compile carries neither a revision nor effects.
    let reply = compile(&server.app, json!({ "code": add_1_2(), "data": {} })).await;
    assert_eq!(reply.json(), json!({ "data": 3, "errors": [] }));
}

/// A language whose output expires (L0176's signed previews) says so, so nothing caches it.
#[tokio::test]
async fn a_language_whose_output_expires_says_it_must_not_be_cached() {
    struct Expiring;
    impl graffiticode_l0000::Dialect for Expiring {
        fn lang_id(&self) -> &str {
            "0000"
        }

        fn cacheable(&self) -> bool {
            false
        }
    }
    let ok = compile(&server_for(Compiler::new(Expiring)).app, json!({ "code": add_1_2(), "data": {} })).await;
    assert_eq!(ok.text(), r#"{"data":3,"errors":[],"cache":false}"#);
    let ordinary = compile(&server().app, json!({ "code": add_1_2(), "data": {} })).await;
    assert_eq!(ordinary.json().get("cache"), None);
}

/// The response writes numbers as the TypeScript servers do.
#[tokio::test]
async fn a_large_number_is_written_as_javascript_writes_it() {
    let code = json!({ "1": { "tag": "NUM", "elts": ["12345678901234567890"] }, "2": { "tag": "EXPRS", "elts": [1] },
        "3": { "tag": "PROG", "elts": [2] }, "root": 3 });
    let reply = compile(&server().app, json!({ "code": code, "data": {} })).await;
    assert_eq!(reply.text(), r#"{"data":12345678901234567000,"errors":[]}"#);
}

#[tokio::test]
async fn egress_reports_whether_the_proxy_is_in_use() {
    // The route reads the process environment; the test runs without a proxy.
    let server = server();
    let reply = get(&server.app, "/egress").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json()["installed"],
        json!(std::env::var("HTTPS_PROXY").is_ok() || std::env::var("HTTP_PROXY").is_ok())
    );
    // The report itself, for an environment with the proxy (the deploy CLI's candidate check
    // compares httpsProxy with the service's network.proxy).
    let env = l0000r_server::egress::EgressEnv::from_lookup(|name| {
        (name == "HTTPS_PROXY").then(|| "http://10.8.0.2:3128".to_string())
    });
    assert_eq!(
        l0000r_server::egress_report(&env),
        json!({ "installed": true, "httpsProxy": "http://10.8.0.2:3128", "httpProxy": null, "noProxy": "metadata.google.internal,169.254.169.254" })
    );
    let none = l0000r_server::egress::EgressEnv::from_lookup(|_| None);
    assert_eq!(l0000r_server::egress_report(&none)["installed"], json!(false));
}
