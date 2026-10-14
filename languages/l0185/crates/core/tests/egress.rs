// SPDX-License-Identifier: MIT

//! ISOLATE-01: the guarded fetcher behind the egress proxy. A stand-in proxy tunnels a CONNECT
//! for `good.test` (to an HTTPS origin signed by a CA made here, mounted as the proxy CA) and
//! answers 403 for anything else, as the egress proxy does for a name that lands on a private
//! address. The fetcher's own limits hold through the tunnel.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use graffiticode_l0000::egress::EgressEnv;
use graffiticode_l0185::fetch::{GuardOptions, GuardedFetcher};
use graffiticode_l0185::source::{FetchResult, Fetcher};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls;

type Seen = Arc<Mutex<Vec<String>>>;

struct Setup {
    seen: Seen,
    ca_file: std::path::PathBuf,
    proxy: String,
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.ca_file);
    }
}

fn reply(status: &str, headers: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
}

async fn read_head<S: AsyncReadExt + Unpin>(socket: &mut S) -> Option<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if socket.read(&mut byte).await.unwrap_or(0) == 0 {
            return None;
        }
        head.push(byte[0]);
    }
    Some(String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned())
}

async fn setup() -> Setup {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::DigitalSignature];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca, ca_key);
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["good.test".to_owned()]).unwrap().signed_by(&leaf_key, &issuer).unwrap();
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let ca_file = std::env::temp_dir().join(format!("l0185-egress-ca-{}-{n}.pem", std::process::id()));
    std::fs::write(&ca_file, ca_cert.pem()).unwrap();
    let key = rustls::pki_types::PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone()], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

    // The HTTPS origin for good.test.
    let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_addr = origin.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (socket, _) = origin.accept().await.unwrap();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(socket).await else { return };
                let Some(line) = read_head(&mut tls).await else { return };
                let path = line.split(' ').nth(1).unwrap_or("/").to_owned();
                let response = match path.as_str() {
                    "/data.json" => reply("200 OK", "content-type: application/json\r\n", "[1]"),
                    "/to-evil" => reply("302 Found", "location: https://evil.test/data.json\r\n", ""),
                    "/loop" => reply("301 Moved", "location: /loop\r\n", ""),
                    "/big" => reply("200 OK", "", &"x".repeat(100)),
                    "/slow" => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        reply("200 OK", "", "[]")
                    }
                    _ => reply("404 Not Found", "", ""),
                };
                let _ = tls.write_all(response.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });

    // The stand-in egress proxy. It ignores the CONNECT's port (the fetcher only ever asks
    // for 443) and carries good.test to the origin.
    let seen: Seen = Arc::default();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = proxy.accept().await.unwrap();
            let record = Arc::clone(&record);
            tokio::spawn(async move {
                let Some(line) = read_head(&mut socket).await else { return };
                record.lock().unwrap().push(line.clone());
                let mut parts = line.split(' ');
                let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                if method != "CONNECT" || target.split(':').next() != Some("good.test") {
                    let _ = socket.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n").await;
                    return;
                }
                let mut upstream = TcpStream::connect(origin_addr).await.unwrap();
                socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
            });
        }
    });
    Setup { seen, ca_file, proxy: proxy_url }
}

fn fetcher(setup: &Setup, tweak: impl FnOnce(&mut GuardOptions)) -> GuardedFetcher {
    let (proxy, ca) = (setup.proxy.clone(), setup.ca_file.to_string_lossy().into_owned());
    let mut opts = GuardOptions {
        // Never consulted in proxy mode: the proxy resolves. Refusing everything proves it.
        is_allowed_address: |_| false,
        cache_ttl: Duration::ZERO,
        egress: EgressEnv::from_lookup(|name| match name {
            "HTTPS_PROXY" => Some(proxy.clone()),
            "NODE_EXTRA_CA_CERTS" => Some(ca.clone()),
            _ => None,
        }),
        ..GuardOptions::default()
    };
    tweak(&mut opts);
    GuardedFetcher::new(opts)
}

fn blocked(url: &str) -> String {
    format!(
        "fetch: \"{url}\" cannot be fetched. Only public https:// addresses are allowed (no private, local or internal hosts), e.g. fetch \"https://example.org/data.csv\"."
    )
}

#[tokio::test]
async fn fetches_through_the_proxy_trusting_its_ca() {
    let setup = setup().await;
    let got = fetcher(&setup, |_| {}).fetch("https://good.test/data.json").await.unwrap();
    assert_eq!(got, FetchResult { text: "[1]".into(), content_type: "application/json".into() });
    assert_eq!(setup.seen.lock().unwrap().as_slice(), ["CONNECT good.test:443 HTTP/1.1"]);
}

#[tokio::test]
async fn a_refusal_by_the_proxy_reads_as_the_guards_own() {
    let setup = setup().await;
    let url = "https://evil.test/data.json";
    assert_eq!(fetcher(&setup, |_| {}).fetch(url).await.unwrap_err(), blocked(url));
    assert_eq!(setup.seen.lock().unwrap().as_slice(), ["CONNECT evil.test:443 HTTP/1.1"]);
}

#[tokio::test]
async fn every_redirect_hop_is_rechecked_at_the_proxy() {
    let setup = setup().await;
    let url = "https://good.test/to-evil";
    assert_eq!(fetcher(&setup, |_| {}).fetch(url).await.unwrap_err(), blocked(url));
    assert_eq!(
        setup.seen.lock().unwrap().as_slice(),
        ["CONNECT good.test:443 HTTP/1.1", "CONNECT evil.test:443 HTTP/1.1"]
    );
}

#[tokio::test]
async fn the_limits_hold_through_the_tunnel() {
    let setup = setup().await;
    let f = fetcher(&setup, |o| {
        o.max_bytes = 64;
        o.timeout = Duration::from_millis(500);
    });
    let url = "https://good.test/loop";
    assert_eq!(f.fetch(url).await.unwrap_err(), format!("fetch: \"{url}\" redirected more than 3 times."));
    let url = "https://good.test/big";
    assert_eq!(f.fetch(url).await.unwrap_err(), format!("fetch: \"{url}\" is larger than 0 MB."));
    let url = "https://good.test/slow";
    assert!(f.fetch(url).await.unwrap_err().contains("timed out"));
    let url = "https://good.test/nope";
    assert_eq!(f.fetch(url).await.unwrap_err(), format!("fetch: fetching \"{url}\" failed: the server answered 404."));
}

#[tokio::test]
async fn the_url_is_checked_before_the_proxy_sees_anything() {
    let setup = setup().await;
    let f = fetcher(&setup, |_| {});
    for url in ["https://metadata.google.internal/x", "https://169.254.169.254/latest", "https://good.test:8443/x"] {
        assert_eq!(f.fetch(url).await.unwrap_err(), blocked(url));
    }
    assert!(setup.seen.lock().unwrap().is_empty());
}
