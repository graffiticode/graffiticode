// SPDX-License-Identifier: MIT

//! The policy/broker client against a fake policy and broker: what it sends, which answers it
//! believes, and what it reports when one is refused, late or lost.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json as Body, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use graffiticode_l0000::canonical::args_digest;
use graffiticode_l0000::policy_client::{HttpPolicyClient, IdTokenSource};
use graffiticode_l0000::{
    ExecContext, Identity, PolicyClient, ProtectedCall, ProtectedCallError, SnapshotRequest, StageManifest,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value as Json, json};

/// A throwaway ES256 key, as the policy service's session-signing key.
struct SigningKey {
    kid: &'static str,
    encoding: EncodingKey,
    jwk: Json,
}

impl SigningKey {
    fn generate(kid: &'static str) -> Self {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
        // An uncompressed point: 0x04, then x and y.
        let point = pair.public_key().as_ref();
        let coordinate = |range: std::ops::Range<usize>| URL_SAFE_NO_PAD.encode(&point[range]);
        let jwk = json!({
            "kty": "EC", "crv": "P-256", "x": coordinate(1..33), "y": coordinate(33..65),
            "kid": kid, "alg": "ES256", "use": "sig",
        });
        Self { kid, encoding: EncodingKey::from_ec_der(pair.to_pkcs8v1().unwrap().as_ref()), jwk }
    }

    fn session(&self, typ: &str, claims: Json) -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let mut all = json!({
            "iss": "urn:graffiticode:policy", "aud": "urn:graffiticode:policy", "iat": now, "exp": now + 900,
            "fns": ["sign-it"], "bind": { "revision": "r" },
        });
        all.as_object_mut().unwrap().extend(claims.as_object().unwrap().clone());
        let header =
            Header { typ: Some(typ.to_owned()), kid: Some(self.kid.to_owned()), ..Header::new(Algorithm::ES256) };
        jsonwebtoken::encode(&header, &all, &self.encoding).unwrap()
    }
}

type Reply = (StatusCode, String);

fn success(data: Json) -> Reply {
    (StatusCode::OK, json!({ "status": "success", "data": data }).to_string())
}

fn refusal(status: u16, error: Json) -> Reply {
    (StatusCode::from_u16(status).unwrap(), json!({ "status": "error", "error": error }).to_string())
}

/// One server standing in for both policy and the broker.
#[derive(Default)]
struct Fake {
    requests: Mutex<Vec<(String, Json, HeaderMap)>>,
    jwks: Mutex<Vec<Json>>,
    jwks_served: AtomicUsize,
    session_token: Mutex<Option<String>>,
    /// Scripted answers, in order; the default answer once they run out.
    mint: Mutex<Vec<Reply>>,
    execute: Mutex<Vec<Reply>>,
}

impl Fake {
    fn sent(&self, path: &str) -> Vec<(Json, HeaderMap)> {
        let requests = self.requests.lock().unwrap();
        requests.iter().filter(|(p, ..)| p == path).map(|(_, body, headers)| (body.clone(), headers.clone())).collect()
    }

    fn next(queue: &Mutex<Vec<Reply>>, default: Reply) -> Reply {
        let mut queue = queue.lock().unwrap();
        if queue.is_empty() { default } else { queue.remove(0) }
    }
}

async fn serve(fake: Arc<Fake>) -> String {
    let record = |path: &'static str| {
        move |State(fake): State<Arc<Fake>>, headers: HeaderMap, Body(body): Body<Json>| async move {
            fake.requests.lock().unwrap().push((path.to_owned(), body, headers));
            match path {
                "/v1/snapshot" => {
                    let mut data = json!({ "allowed": ["sign-it"] });
                    if let Some(token) = fake.session_token.lock().unwrap().clone() {
                        data["sessionToken"] = token.into();
                    }
                    success(data)
                }
                "/v1/mint" => {
                    let n = fake.sent("/v1/mint").len();
                    Fake::next(&fake.mint, success(json!({ "executionToken": format!("exec-{n}") })))
                }
                _ => Fake::next(&fake.execute, success(json!({ "status": "succeeded", "steps": [] }))),
            }
        }
    };
    let app = Router::new()
        .route(
            "/v1/jwks",
            get(|State(fake): State<Arc<Fake>>| async move {
                fake.jwks_served.fetch_add(1, Ordering::Relaxed);
                Body(json!({ "keys": *fake.jwks.lock().unwrap() }))
            }),
        )
        .route("/v1/snapshot", post(record("/v1/snapshot")))
        .route("/v1/mint", post(record("/v1/mint")))
        .route("/v1/execute", post(record("/v1/execute")))
        .with_state(fake);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// An address nothing listens on.
async fn nowhere() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

struct Audiences;

#[async_trait]
impl IdTokenSource for Audiences {
    async fn id_token(&self, audience: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("id-{audience}"))
    }
}

fn client(policy: &str, broker: Option<&str>) -> HttpPolicyClient<Audiences> {
    HttpPolicyClient::new(reqwest::Client::new(), policy, broker.map(str::to_owned), Audiences)
}

fn identity(admission: Option<&str>) -> Identity {
    Identity {
        uid: Some("u1".into()),
        connection_id: Some("conn-1".into()),
        user_token: Some("user-token".into()),
        invocation_token: Some("inv".into()),
        stage: Some("s1".into()),
        admission_token: admission.map(str::to_owned),
    }
}

fn manifest() -> StageManifest {
    StageManifest {
        stage: Some("s1".into()),
        lang: "9999".into(),
        source_digest: "a".into(),
        program_digest: "b".into(),
        options_digest: "c".into(),
        revision: "r".into(),
        image_digest: "i".into(),
        registry_version: 6,
        required_functions: vec!["sign-it".into()],
    }
}

async fn snapshot(
    client: &HttpPolicyClient<Audiences>,
    identity: Identity,
) -> Result<graffiticode_l0000::PolicySnapshot, ProtectedCallError> {
    let exec = ExecContext::new(identity);
    let functions = ["sign-it".to_owned()];
    let manifest = manifest();
    let manifest = exec.is_planned().then_some(&manifest);
    client.snapshot(SnapshotRequest { exec: &exec, lang_id: "9999", functions: &functions, manifest }).await
}

fn call() -> ProtectedCall {
    ProtectedCall {
        function: "save-it".into(),
        op: "toy.write".into(),
        payload: json!({ "b": 2, "a": 1 }),
        occurrence_id: "n6.0".into(),
    }
}

mod snapshots {
    use super::*;

    #[tokio::test]
    async fn carry_the_user_the_invocation_and_both_service_identities() {
        let fake = Arc::new(Fake::default());
        *fake.session_token.lock().unwrap() = Some("opaque-session".into());
        let url = serve(fake.clone()).await;
        let snapshot = snapshot(&client(&url, None), identity(None)).await.unwrap();
        assert_eq!(snapshot.allowed, ["sign-it"]);
        assert_eq!(snapshot.session_token.as_deref(), Some("opaque-session"));
        assert_eq!(snapshot.bind, None);

        let (body, headers) = &fake.sent("/v1/snapshot")[0];
        assert_eq!(
            *body,
            json!({ "lang": "9999", "connectionId": "conn-1", "fns": ["sign-it"], "invocationToken": "inv", "stage": "s1" })
        );
        assert_eq!(headers["authorization"], "Bearer user-token");
        assert_eq!(headers["x-serverless-authorization"], format!("Bearer id-{url}"));
        assert_eq!(headers["x-caller-identity"], "id-urn:graffiticode:policy");
        // An unplanned snapshot sends no admission, and needs no keys.
        assert_eq!(fake.jwks_served.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn under_a_plan_send_the_admission_and_manifest_and_return_the_binding_of_a_verified_session() {
        let key = SigningKey::generate("k1");
        let fake = Arc::new(Fake::default());
        fake.jwks.lock().unwrap().push(key.jwk.clone());
        *fake.session_token.lock().unwrap() = Some(key.session("gc-session+jwt", json!({})));
        let url = serve(fake.clone()).await;

        let snapshot = snapshot(&client(&url, None), identity(Some("adm"))).await.unwrap();
        assert_eq!(snapshot.bind, Some(json!({ "revision": "r" })));
        assert!(snapshot.session_token.is_some());
        let (body, _) = &fake.sent("/v1/snapshot")[0];
        assert_eq!(body["admissionToken"], "adm");
        assert_eq!(body["manifest"], serde_json::to_value(manifest()).unwrap());
    }

    #[tokio::test]
    async fn refuse_a_session_that_does_not_verify_as_policys() {
        let key = SigningKey::generate("k1");
        let stranger = SigningKey::generate("k1");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        for (why, session) in [
            ("signed by someone else", stranger.session("gc-session+jwt", json!({}))),
            ("another kind of token", key.session("gc-exec+jwt", json!({}))),
            ("for another audience", key.session("gc-session+jwt", json!({ "aud": "urn:graffiticode:broker" }))),
            ("from another issuer", key.session("gc-session+jwt", json!({ "iss": "urn:someone:else" }))),
            ("expired", key.session("gc-session+jwt", json!({ "exp": now - 5 }))),
            ("not a token", "not.a.jwt".to_owned()),
        ] {
            let fake = Arc::new(Fake::default());
            fake.jwks.lock().unwrap().push(key.jwk.clone());
            *fake.session_token.lock().unwrap() = Some(session);
            let url = serve(fake).await;
            let refused = snapshot(&client(&url, None), identity(Some("adm"))).await.unwrap_err();
            assert!(matches!(refused, ProtectedCallError::BadSession), "{why}: {refused:?}");
            assert_eq!(refused.reason(), Some("bad-session"));
        }
    }

    #[tokio::test]
    async fn load_a_key_policy_rotated_in() {
        let (old, new) = (SigningKey::generate("k1"), SigningKey::generate("k2"));
        let fake = Arc::new(Fake::default());
        fake.jwks.lock().unwrap().push(old.jwk.clone());
        *fake.session_token.lock().unwrap() = Some(old.session("gc-session+jwt", json!({})));
        let url = serve(fake.clone()).await;
        let client = client(&url, None);
        snapshot(&client, identity(Some("adm"))).await.unwrap();
        snapshot(&client, identity(Some("adm"))).await.unwrap();
        assert_eq!(fake.jwks_served.load(Ordering::Relaxed), 1);

        fake.jwks.lock().unwrap().push(new.jwk.clone());
        *fake.session_token.lock().unwrap() = Some(new.session("gc-session+jwt", json!({})));
        let rotated = snapshot(&client, identity(Some("adm"))).await.unwrap();
        assert_eq!(rotated.bind, Some(json!({ "revision": "r" })));
        assert_eq!(fake.jwks_served.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn an_unreachable_policy_is_a_definite_failure() {
        let refused = snapshot(&client(&nowhere().await, None), identity(None)).await.unwrap_err();
        assert!(matches!(refused, ProtectedCallError::Unreachable { effect_unknown: false, .. }), "{refused:?}");
    }
}

mod calls {
    use super::*;

    async fn fake() -> (Arc<Fake>, String) {
        let fake = Arc::new(Fake::default());
        let url = serve(fake.clone()).await;
        (fake, url)
    }

    #[tokio::test]
    async fn mint_a_token_for_exactly_the_payload_then_spend_it_at_the_broker() {
        let (fake, url) = fake().await;
        let outcome = client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap();
        assert_eq!(outcome, json!({ "status": "succeeded", "steps": [] }));

        let (mint, headers) = &fake.sent("/v1/mint")[0];
        assert_eq!(
            *mint,
            json!({
                "sessionToken": "session-1", "fn": "save-it", "op": "toy.write", "occurrenceId": "n6.0",
                "argsDigest": args_digest(&json!({ "a": 1, "b": 2 })),
            })
        );
        assert!(!headers.contains_key("authorization"));
        let (execute, headers) = &fake.sent("/v1/execute")[0];
        assert_eq!(*execute, json!({ "op": "toy.write", "payload": { "b": 2, "a": 1 } }));
        assert_eq!(headers["authorization"], "Bearer exec-1");
        assert_eq!(headers["x-caller-identity"], "id-urn:graffiticode:broker");
    }

    #[tokio::test]
    async fn a_mint_refusal_never_reaches_the_broker() {
        let (fake, url) = fake().await;
        let refused = refusal(403, json!({ "code": 403, "reason": "operation-not-allowed", "category": "permission" }));
        fake.mint.lock().unwrap().push(refused);
        let err = client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap_err();
        assert_eq!(err.to_string(), "/v1/mint failed (403)");
        assert_eq!((err.reason(), err.category()), (Some("operation-not-allowed"), Some("permission")));
        assert!(!err.effect_unknown());
        assert!(fake.sent("/v1/execute").is_empty());
    }

    #[tokio::test]
    async fn a_token_expiring_refusal_is_retried_once_with_a_fresh_token_for_the_same_operation() {
        let (fake, url) = fake().await;
        let expiring = || refusal(409, json!({ "code": 409, "reason": "token-expiring", "category": "conflict" }));
        fake.execute.lock().unwrap().push(expiring());
        client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap();
        let mints = fake.sent("/v1/mint");
        let executes = fake.sent("/v1/execute");
        assert_eq!((mints.len(), executes.len()), (2, 2));
        assert_eq!(mints[0].0["occurrenceId"], mints[1].0["occurrenceId"]);
        assert_ne!(executes[0].1["authorization"], executes[1].1["authorization"]);

        // A second one is reported, not retried again.
        fake.execute.lock().unwrap().extend([expiring(), expiring()]);
        let err = client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap_err();
        assert_eq!((err.reason(), err.category()), (Some("token-expiring"), Some("conflict")));
        assert_eq!(fake.sent("/v1/execute").len(), 4);
    }

    #[tokio::test]
    async fn other_broker_refusals_are_definite_and_not_retried() {
        let (fake, url) = fake().await;
        fake.execute.lock().unwrap().push(refusal(409, json!({ "code": 409, "reason": "token-replayed" })));
        let err = client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap_err();
        // An older broker sends no category; the refusal still stands.
        assert_eq!((err.reason(), err.category(), err.effect_unknown()), (Some("token-replayed"), None, false));
        assert_eq!((fake.sent("/v1/mint").len(), fake.sent("/v1/execute").len()), (1, 1));
    }

    #[tokio::test]
    async fn a_lost_broker_answer_is_uncertain_never_a_refusal() {
        // The broker answered, but not with an outcome: a proxy error.
        let (fake, url) = fake().await;
        fake.execute.lock().unwrap().push((StatusCode::BAD_GATEWAY, "Bad Gateway".to_owned()));
        let err = client(&url, Some(&url)).invoke("session-1", &call()).await.unwrap_err();
        assert!(err.effect_unknown(), "{err:?}");

        // The broker did not answer at all.
        let err = client(&url, Some(&nowhere().await)).invoke("session-1", &call()).await.unwrap_err();
        assert_eq!(err.to_string(), "/v1/execute unreachable");
        assert!(err.effect_unknown());
    }

    #[tokio::test]
    async fn an_unreachable_policy_at_mint_is_a_definite_failure() {
        let (fake, url) = fake().await;
        let err = client(&nowhere().await, Some(&url)).invoke("session-1", &call()).await.unwrap_err();
        assert_eq!(err.to_string(), "/v1/mint unreachable");
        // Nothing was asked of the broker.
        assert!(!err.effect_unknown());
        assert!(fake.sent("/v1/execute").is_empty());
    }

    #[tokio::test]
    async fn a_client_with_no_broker_executes_nothing() {
        let (fake, url) = fake().await;
        let err = client(&url, None).invoke("session-1", &call()).await.unwrap_err();
        assert_eq!(err.reason(), Some("unavailable"));
        assert!(fake.requests.lock().unwrap().is_empty());
    }
}
