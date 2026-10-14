// SPDX-License-Identifier: MIT

//! ISOLATE-01: the egress helper against a local proxy standing in for the egress proxy. A
//! listed name goes through it, an unlisted one is refused there and never reached, and the
//! metadata server is always reached directly: by `MetadataIdTokens` (built the way the server
//! builds it) and by a general client, for that name only.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use base64::Engine;
use graffiticode_l0000::egress::{EgressEnv, EgressError, METADATA_HOSTS, client_builder_with, metadata_client_at};
use graffiticode_l0000::policy_client::{IdTokenSource, MetadataIdTokens};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const LISTED: &str = "listed.test";

type Seen = Arc<Mutex<Vec<String>>>;

async fn serve(router: Router) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    address
}

/// An origin that records what reaches it.
async fn origin() -> (SocketAddr, Seen) {
    let hits: Seen = Arc::default();
    let record = Arc::clone(&hits);
    let router = Router::new().fallback(move |uri: axum::http::Uri| {
        let record = Arc::clone(&record);
        async move {
            record.lock().unwrap().push(uri.path().to_owned());
            "origin"
        }
    });
    (serve(router).await, hits)
}

/// A fake metadata server whose identity endpoint returns a token expiring in an hour.
async fn metadata() -> (SocketAddr, Seen) {
    let hits: Seen = Arc::default();
    let record = Arc::clone(&hits);
    let router = Router::new().route(
        "/computeMetadata/v1/instance/service-accounts/default/identity",
        get(move |headers: axum::http::HeaderMap| {
            let record = Arc::clone(&record);
            async move {
                record.lock().unwrap().push(headers["metadata-flavor"].to_str().unwrap().to_owned());
                let b64 = |v: serde_json::Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
                let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3600;
                format!("{}.{}.c2ln", b64(serde_json::json!({"alg": "RS256"})), b64(serde_json::json!({"exp": exp})))
            }
        }),
    );
    (serve(router).await, hits)
}

/// The stand-in egress proxy: a CONNECT, or an absolute-form request, for `listed.test` is
/// carried to the origin; anything else gets the egress proxy's 403.
async fn proxy(origin: SocketAddr) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let record = Arc::clone(&record);
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let line = String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned();
                record.lock().unwrap().push(line.clone());
                let mut parts = line.split(' ');
                let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                let authority = if method == "CONNECT" {
                    target.to_owned()
                } else {
                    target.trim_start_matches("http://").split('/').next().unwrap_or("").to_owned()
                };
                if authority.split(':').next() != Some(LISTED) {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 403 Forbidden\r\nx-isolate01-refused: unlisted\r\ncontent-length: 0\r\n\r\n",
                        )
                        .await;
                    return;
                }
                let mut upstream = TcpStream::connect(origin).await.unwrap();
                if method == "CONNECT" {
                    socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                } else {
                    upstream.write_all(&head).await.unwrap();
                }
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
            });
        }
    });
    (url, seen)
}

/// A CA made for the test (no key is kept), its certificate in a temporary file standing in for
/// the mounted `network.ca`, and a TLS acceptor for `listed.test` signed by it.
struct TestCa {
    file: std::path::PathBuf,
    acceptor: tokio_rustls::TlsAcceptor,
}

impl TestCa {
    fn new() -> Self {
        use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::DigitalSignature];
        let ca_key = KeyPair::generate().unwrap();
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca, ca_key);
        let leaf_key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec![LISTED.to_owned()]).unwrap().signed_by(&leaf_key, &issuer).unwrap();
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("egress-ca-{}-{n}.pem", std::process::id()));
        std::fs::write(&file, ca_cert.pem()).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap();
        let config =
            rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![leaf.der().clone()], key)
                .unwrap();
        Self { file, acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(config)) }
    }
}

impl Drop for TestCa {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
    }
}

use tokio_rustls::rustls;

/// An HTTPS origin for `listed.test`, with a certificate from the test CA.
async fn tls_origin(ca: &TestCa) -> (SocketAddr, Seen) {
    let hits: Seen = Arc::default();
    let record = Arc::clone(&hits);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = ca.acceptor.clone();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let (acceptor, record) = (acceptor.clone(), Arc::clone(&record));
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(socket).await else { return };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if tls.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                record
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned());
                let _ = tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\norigin").await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (address, hits)
}

fn env(proxy: &str, ca: &TestCa) -> EgressEnv {
    EgressEnv::from_lookup(|name| match name {
        "HTTPS_PROXY" | "HTTP_PROXY" => Some(proxy.to_owned()),
        "NO_PROXY" => Some(METADATA_HOSTS.to_owned()),
        "NODE_EXTRA_CA_CERTS" => Some(ca.file.to_string_lossy().into_owned()),
        _ => None,
    })
}

#[tokio::test]
async fn a_listed_host_goes_through_the_proxy() {
    let (origin, hits) = origin().await;
    let (proxy, seen) = proxy(origin).await;
    let ca = TestCa::new();
    let client = client_builder_with(&env(&proxy, &ca)).unwrap().build().unwrap();
    let response = client.get(format!("http://{LISTED}:{}/listed", origin.port())).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "origin");
    assert_eq!(hits.lock().unwrap().as_slice(), ["/listed"]);
    assert!(seen.lock().unwrap().iter().any(|line| line.contains(&format!("{LISTED}:{}", origin.port()))));
}

#[tokio::test]
async fn a_listed_https_host_is_reached_through_the_proxy_trusting_the_mounted_ca() {
    let ca = TestCa::new();
    let (origin, hits) = tls_origin(&ca).await;
    let (proxy, seen) = proxy(origin).await;
    let client = client_builder_with(&env(&proxy, &ca)).unwrap().build().unwrap();
    let response = client.get(format!("https://{LISTED}:{}/secure", origin.port())).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "origin");
    assert_eq!(seen.lock().unwrap().as_slice(), [format!("CONNECT {LISTED}:{} HTTP/1.1", origin.port())]);
    assert_eq!(hits.lock().unwrap().as_slice(), ["GET /secure HTTP/1.1"]);
}

#[tokio::test]
async fn without_the_mounted_ca_the_proxy_s_certificate_is_not_trusted() {
    let ca = TestCa::new();
    let (origin, hits) = tls_origin(&ca).await;
    let (proxy, _) = proxy(origin).await;
    // The same proxy, with only the built-in roots.
    let client = reqwest::Client::builder().proxy(reqwest::Proxy::all(&proxy).unwrap()).build().unwrap();
    assert!(client.get(format!("https://{LISTED}:{}/secure", origin.port())).send().await.is_err());
    assert!(hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unlisted_host_is_refused_at_the_proxy_and_never_reached() {
    let (origin, hits) = origin().await;
    let (proxy, seen) = proxy(origin).await;
    let ca = TestCa::new();
    let client = client_builder_with(&env(&proxy, &ca)).unwrap().build().unwrap();
    // The origin is reachable directly; the request must not get there.
    let response = client.get(format!("http://127.0.0.1:{}/unlisted", origin.port())).send().await.unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(response.headers()["x-isolate01-refused"], "unlisted");
    assert!(hits.lock().unwrap().is_empty());
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn identity_tokens_come_from_the_metadata_server_directly() {
    let (origin, _) = origin().await;
    let (_proxy, seen) = proxy(origin).await;
    let (metadata, asked) = metadata().await;
    // The way the server builds it (`MetadataIdTokens::direct`), with the metadata name
    // resolving to the fake server instead of 169.254.169.254.
    let tokens = MetadataIdTokens::with_endpoint(
        metadata_client_at(metadata).unwrap(),
        format!(
            "http://metadata.google.internal:{}/computeMetadata/v1/instance/service-accounts/default/identity",
            metadata.port()
        ),
    );
    let token = tokens.id_token("https://policy.example").await.unwrap();
    assert_eq!(token.split('.').count(), 3);
    assert_eq!(asked.lock().unwrap().as_slice(), ["Google"]);
    assert!(seen.lock().unwrap().is_empty(), "the proxy saw nothing");
}

#[tokio::test]
async fn the_metadata_client_resolves_nothing_else() {
    let (origin, hits) = origin().await;
    let client = metadata_client_at(origin).unwrap();
    assert!(client.get(format!("http://{LISTED}:{}/", origin.port())).send().await.is_err());
    assert!(hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_general_client_bypasses_the_proxy_for_the_metadata_name_only() {
    let (origin, _) = origin().await;
    let (proxy, seen) = proxy(origin).await;
    let (metadata, asked) = metadata().await;
    let ca = TestCa::new();
    let client =
        client_builder_with(&env(&proxy, &ca)).unwrap().resolve("metadata.google.internal", metadata).build().unwrap();
    let response = client
        .get(format!(
            "http://metadata.google.internal:{}/computeMetadata/v1/instance/service-accounts/default/identity",
            metadata.port()
        ))
        .header("Metadata-Flavor", "Google")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(asked.lock().unwrap().len(), 1);
    assert!(seen.lock().unwrap().is_empty());
    // Any other name still goes to the proxy.
    let other = client.get(format!("http://other.test:{}/", origin.port())).send().await.unwrap();
    assert_eq!(other.status(), 403);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn without_a_proxy_the_client_is_direct_and_needs_no_ca() {
    let env = EgressEnv::from_lookup(|_| None);
    assert!(env.proxy.is_none());
    client_builder_with(&env).unwrap().build().unwrap();
}

#[test]
fn a_proxy_without_its_ca_is_refused_at_startup() {
    let env = EgressEnv::from_lookup(|name| (name == "HTTPS_PROXY").then(|| "http://10.8.0.2:3128".to_owned()));
    assert!(matches!(client_builder_with(&env), Err(EgressError::NoCa("HTTPS_PROXY"))));
    let env = EgressEnv::from_lookup(|name| match name {
        "HTTPS_PROXY" => Some("http://10.8.0.2:3128".to_owned()),
        "SSL_CERT_FILE" => Some("/nonexistent/ca.pem".to_owned()),
        _ => None,
    });
    assert!(matches!(client_builder_with(&env), Err(EgressError::CaFile(..))));
}

#[test]
fn lowercase_variables_count_and_https_proxy_wins() {
    let env = EgressEnv::from_lookup(|name| match name {
        "https_proxy" => Some("http://a:1".to_owned()),
        "HTTP_PROXY" => Some("http://b:2".to_owned()),
        "SSL_CERT_FILE" => Some("/x".to_owned()),
        _ => None,
    });
    assert_eq!(env.proxy, Some(("http://a:1".to_owned(), "HTTPS_PROXY")));
    assert_eq!(env.ca_file, Some("/x".into()));
}
