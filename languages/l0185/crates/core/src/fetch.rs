// SPDX-License-Identifier: MIT

//! The guarded fetcher `fetch` uses in the language server (`packages/api/src/fetch.ts`).
//! Source text controls the URL, so this is the SSRF boundary: only public https addresses,
//! checked where the socket connects.
//!
//! - The URL: https only, port 443, no credentials, no local/internal host names, and a
//!   literal IP only if it is public.
//! - Every address a host name resolves to must be public unicast — checked in the client's
//!   own resolver, so the connection uses exactly the addresses that passed (no DNS-rebinding
//!   window). IPv4-mapped IPv6 is unwrapped; private, loopback, link-local (the metadata
//!   server), CGNAT, multicast, reserved, NAT64/6to4/Teredo and other non-unicast ranges are
//!   refused (ipaddr.js 2.5's ranges). No proxy is ever used.
//! - Redirects are followed by hand, at most 3, each checked like the original URL.
//! - 10 s per URL, redirects and body included (5 s to connect); 5 MB of decoded body,
//!   counted while streaming.
//! - GET with fixed headers; source text sets none. A 60 s in-process cache (at most 200
//!   URLs), with requests in flight shared; a failure is not cached.
//!
//! Messages never echo a resolved address.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use indexmap::IndexMap;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tokio::sync::OnceCell;
use url::{Host, Url};

use crate::js::quote;
use crate::source::{FetchResult, Fetcher};

/// Limits, and the seams the tests use. Source text can reach none of them.
#[derive(Clone)]
pub struct GuardOptions {
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_bytes: usize,
    pub max_redirects: usize,
    pub cache_ttl: Duration,
    /// TEST ONLY: also allow plain `http:`.
    pub allow_http: bool,
    /// TEST ONLY: which addresses may be connected to (default: public unicast).
    pub is_allowed_address: fn(IpAddr) -> bool,
}

impl Default for GuardOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(5),
            max_bytes: 5_000_000,
            max_redirects: 3,
            cache_ttl: Duration::from_secs(60),
            allow_http: false,
            is_allowed_address: is_public_address,
        }
    }
}

fn v4_ranges() -> [(Ipv4Addr, u32); 19] {
    [
        (Ipv4Addr::new(0, 0, 0, 0), 8),
        (Ipv4Addr::new(255, 255, 255, 255), 32),
        (Ipv4Addr::new(224, 0, 0, 0), 4),
        (Ipv4Addr::new(169, 254, 0, 0), 16),
        (Ipv4Addr::new(127, 0, 0, 0), 8),
        (Ipv4Addr::new(100, 64, 0, 0), 10),
        (Ipv4Addr::new(10, 0, 0, 0), 8),
        (Ipv4Addr::new(172, 16, 0, 0), 12),
        (Ipv4Addr::new(192, 168, 0, 0), 16),
        (Ipv4Addr::new(192, 0, 0, 0), 24),
        (Ipv4Addr::new(192, 0, 2, 0), 24),
        (Ipv4Addr::new(192, 88, 99, 0), 24),
        (Ipv4Addr::new(198, 18, 0, 0), 15),
        (Ipv4Addr::new(198, 51, 100, 0), 24),
        (Ipv4Addr::new(203, 0, 113, 0), 24),
        (Ipv4Addr::new(240, 0, 0, 0), 4),
        (Ipv4Addr::new(192, 175, 48, 0), 24),
        (Ipv4Addr::new(192, 31, 196, 0), 24),
        (Ipv4Addr::new(192, 52, 193, 0), 24),
    ]
}

fn v6_ranges() -> [(Ipv6Addr, u32); 23] {
    let v6 = |s: [u16; 8]| Ipv6Addr::new(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
    [
        (v6([0, 0, 0, 0, 0, 0, 0, 0]), 128),
        (v6([0xfe80, 0, 0, 0, 0, 0, 0, 0]), 10),
        (v6([0xff00, 0, 0, 0, 0, 0, 0, 0]), 8),
        (v6([0, 0, 0, 0, 0, 0, 0, 1]), 128),
        (v6([0xfc00, 0, 0, 0, 0, 0, 0, 0]), 7),
        (v6([0, 0, 0, 0, 0, 0xffff, 0, 0]), 96),
        (v6([0xfec0, 0, 0, 0, 0, 0, 0, 0]), 10),
        (v6([0x100, 0, 0, 0, 0, 0, 0, 0]), 64),
        (v6([0, 0, 0, 0, 0xffff, 0, 0, 0]), 96),
        (v6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0]), 96),
        (v6([0x64, 0xff9b, 0x1, 0, 0, 0, 0, 0]), 48),
        (v6([0x2002, 0, 0, 0, 0, 0, 0, 0]), 16),
        (v6([0x2001, 0, 0, 0, 0, 0, 0, 0]), 32),
        (v6([0x2001, 0x2, 0, 0, 0, 0, 0, 0]), 48),
        (v6([0x2001, 0x3, 0, 0, 0, 0, 0, 0]), 32),
        (v6([0x2001, 0x4, 0x112, 0, 0, 0, 0, 0]), 48),
        (v6([0x2620, 0x4f, 0x8000, 0, 0, 0, 0, 0]), 48),
        (v6([0x2001, 0x10, 0, 0, 0, 0, 0, 0]), 28),
        (v6([0x2001, 0x20, 0, 0, 0, 0, 0, 0]), 28),
        (v6([0x2001, 0x30, 0, 0, 0, 0, 0, 0]), 28),
        (v6([0x5f00, 0, 0, 0, 0, 0, 0, 0]), 16),
        (v6([0x2001, 0, 0, 0, 0, 0, 0, 0]), 23),
        (v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32),
    ]
}

fn in_prefix(addr: u128, net: u128, bits: u32, width: u32) -> bool {
    let shift = width - bits;
    bits == 0 || (addr >> shift) == (net >> shift)
}

/// Public unicast only: anything in one of ipaddr.js's special ranges is refused, and an
/// IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
pub fn is_public_address(addr: IpAddr) -> bool {
    let addr = match addr {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    match addr {
        IpAddr::V4(v4) => {
            v4_ranges().iter().all(|(net, bits)| !in_prefix(u32::from(v4).into(), u32::from(*net).into(), *bits, 32))
        }
        IpAddr::V6(v6) => {
            let reserved_3fff =
                in_prefix(u128::from(v6), u128::from(Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0)), 20, 128);
            !reserved_3fff
                && v6_ranges().iter().all(|(net, bits)| !in_prefix(u128::from(v6), u128::from(*net), *bits, 128))
        }
    }
}

fn blocked(url: &str) -> String {
    format!(
        "fetch: {} cannot be fetched. Only public https:// addresses are allowed (no private, local or internal hosts), e.g. fetch \"https://example.org/data.csv\".",
        quote(url)
    )
}

fn denied_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
}

/// Check a URL before connecting: scheme, port, credentials, host name, literal IPs.
pub fn check_url(raw: &str, opts: &GuardOptions) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| {
        format!(
            "fetch: {} is not a URL. Write a full https address, e.g. fetch \"https://example.org/data.json\".",
            quote(raw)
        )
    })?;
    let scheme_ok = url.scheme() == "https" || (opts.allow_http && url.scheme() == "http");
    if !scheme_ok || !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return Err(blocked(raw));
    }
    if url.scheme() == "https" && url.port().is_some_and(|p| p != 443) {
        return Err(blocked(raw));
    }
    match url.host() {
        Some(Host::Domain(host)) if denied_host(host) => return Err(blocked(raw)),
        Some(Host::Ipv4(ip)) if !(opts.is_allowed_address)(IpAddr::V4(ip)) => return Err(blocked(raw)),
        Some(Host::Ipv6(ip)) if !(opts.is_allowed_address)(IpAddr::V6(ip)) => return Err(blocked(raw)),
        _ => {}
    }
    Ok(url)
}

#[derive(Debug)]
struct BlockedAddress;

impl std::fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blocked")
    }
}

impl std::error::Error for BlockedAddress {}

#[derive(Debug)]
struct NotFound;

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ENOTFOUND")
    }
}

impl std::error::Error for NotFound {}

/// The system resolver, refusing a host if any of its addresses is not allowed.
struct GuardedResolver {
    allowed: fn(IpAddr) -> bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allowed = self.allowed;
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host.as_str(), 0)).await {
                Ok(addrs) => addrs.collect(),
                Err(_) => return Err(Box::new(NotFound) as Box<dyn std::error::Error + Send + Sync>),
            };
            if addrs.is_empty() {
                return Err(Box::new(NotFound) as Box<dyn std::error::Error + Send + Sync>);
            }
            if addrs.iter().any(|a| !allowed(a.ip())) {
                return Err(Box::new(BlockedAddress) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn caused_by<E: std::error::Error + 'static>(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if e.is::<E>() {
            return true;
        }
        cur = e.source();
    }
    false
}

type Shared = Arc<OnceCell<Result<FetchResult, String>>>;

/// The fetcher the language server gives L0185.
pub struct GuardedFetcher {
    client: reqwest::Client,
    opts: GuardOptions,
    cache: Mutex<IndexMap<String, (Instant, Shared)>>,
}

impl GuardedFetcher {
    pub fn new(opts: GuardOptions) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(opts.connect_timeout)
            .no_proxy()
            .dns_resolver(Arc::new(GuardedResolver { allowed: opts.is_allowed_address }))
            .build()
            .expect("the HTTP client builds");
        Self { client, opts, cache: Mutex::new(IndexMap::new()) }
    }

    async fn once(&self, raw: &str) -> Result<FetchResult, String> {
        let timed_out =
            || format!("fetch: fetching {} timed out after {} s.", quote(raw), self.opts.timeout.as_secs_f64().round());
        match tokio::time::timeout(self.opts.timeout, self.follow(raw)).await {
            Ok(result) => result,
            Err(_) => Err(timed_out()),
        }
    }

    async fn follow(&self, raw: &str) -> Result<FetchResult, String> {
        let max_mb = (self.opts.max_bytes as f64 / 1_000_000.0).round();
        let too_large = || format!("fetch: {} is larger than {max_mb} MB.", quote(raw));
        let mut current = check_url(raw, &self.opts)?;
        let mut hop = 0;
        loop {
            if hop > 0 {
                check_url(current.as_str(), &self.opts)?;
            }
            let response = self
                .client
                .get(current.clone())
                .header("accept", "application/json, text/csv;q=0.9, text/plain;q=0.5, */*;q=0.1")
                .header("accept-encoding", "gzip, deflate, br")
                .header("user-agent", "Graffiticode-L0185/1")
                .send()
                .await;
            let mut response = match response {
                Ok(response) => response,
                Err(err) => {
                    if caused_by::<BlockedAddress>(&err) {
                        return Err(blocked(raw));
                    }
                    let why = if caused_by::<NotFound>(&err) { "no such host" } else { "could not connect" };
                    return Err(format!("fetch: fetching {} failed: {why}.", quote(raw)));
                }
            };
            let status = response.status().as_u16();
            let location = response.headers().get("location").and_then(|l| l.to_str().ok()).map(str::to_owned);
            if (300..400).contains(&status)
                && let Some(location) = location
            {
                if hop >= self.opts.max_redirects {
                    return Err(format!(
                        "fetch: {} redirected more than {} times.",
                        quote(raw),
                        self.opts.max_redirects
                    ));
                }
                // `new URL(location, current)`, whose failure is a bare TypeError.
                current = current.join(&location).map_err(|_| "Invalid URL".to_owned())?;
                hop += 1;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(format!("fetch: fetching {} failed: the server answered {status}.", quote(raw)));
            }
            let length = response.content_length().unwrap_or(0);
            if length as usize > self.opts.max_bytes {
                return Err(too_large());
            }
            let content_type =
                response.headers().get("content-type").and_then(|c| c.to_str().ok()).unwrap_or_default().to_owned();
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        body.extend_from_slice(&chunk);
                        if body.len() > self.opts.max_bytes {
                            return Err(too_large());
                        }
                    }
                    Ok(None) => break,
                    Err(_) => return Err(format!("fetch: fetching {} failed: could not connect.", quote(raw))),
                }
            }
            return Ok(FetchResult { text: String::from_utf8_lossy(&body).into_owned(), content_type });
        }
    }
}

#[async_trait]
impl Fetcher for GuardedFetcher {
    async fn fetch(&self, url: &str) -> Result<FetchResult, String> {
        let shared = {
            let mut cache = self.cache.lock().expect("the fetch cache is not poisoned");
            let now = Instant::now();
            match cache.get(url) {
                Some((at, shared)) if now.duration_since(*at) < self.opts.cache_ttl => shared.clone(),
                _ => {
                    let shared: Shared = Arc::new(OnceCell::new());
                    cache.insert(url.to_owned(), (now, shared.clone()));
                    if cache.len() > 200 {
                        cache.shift_remove_index(0);
                    }
                    shared
                }
            }
        };
        let result = shared.get_or_init(|| self.once(url)).await.clone();
        if result.is_err() {
            let mut cache = self.cache.lock().expect("the fetch cache is not poisoned");
            if cache.get(url).is_some_and(|(_, s)| Arc::ptr_eq(s, &shared)) {
                cache.shift_remove(url);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn only_public_unicast_is_allowed() {
        for addr in ["8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(is_public_address(addr.parse().unwrap()), "{addr}");
        }
        for addr in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "::ffff:127.0.0.1",
            "64:ff9b::1.2.3.4",
            "2002::1",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
            "ff02::1",
        ] {
            assert!(!is_public_address(addr.parse().unwrap()), "{addr}");
        }
    }

    #[test]
    fn urls_are_checked_before_connecting() {
        let opts = GuardOptions::default();
        assert!(check_url("https://example.org/data.json", &opts).is_ok());
        assert!(check_url("https://example.org:443/data.json", &opts).is_ok());
        for bad in [
            "http://example.org/",
            "https://example.org:8443/",
            "https://user:pw@example.org/",
            "https://localhost/",
            "https://a.localhost/",
            "https://printer.local/",
            "https://metadata.google.internal/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://0x7f.1/",
            "https://169.254.169.254/latest",
            "file:///etc/passwd",
        ] {
            assert_eq!(check_url(bad, &opts).unwrap_err(), blocked(bad), "{bad}");
        }
        assert!(check_url("not a url", &opts).unwrap_err().contains("is not a URL"));
    }

    /// A one-shot HTTP server on loopback answering every request with `response`.
    async fn serve(responses: Vec<String>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        format!("http://localhost:{}", addr.port())
    }

    fn test_options() -> GuardOptions {
        GuardOptions {
            allow_http: true,
            is_allowed_address: |_| true,
            timeout: Duration::from_secs(2),
            max_bytes: 64,
            ..GuardOptions::default()
        }
    }

    fn reply(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn fetches_follows_redirects_and_caps() {
        // Loopback is a denied host name, so the tests reach it by its address.
        let base = serve(vec![
            reply("302 Found", "location: /data\r\n", ""),
            reply("200 OK", "content-type: application/json\r\n", "[1]"),
        ])
        .await
        .replace("localhost", "127.0.0.1");
        let fetcher = GuardedFetcher::new(test_options());
        let got = fetcher.fetch(&format!("{base}/start")).await.unwrap();
        assert_eq!(got, FetchResult { text: "[1]".into(), content_type: "application/json".into() });
        // Cached: the server is gone, the answer is not.
        assert_eq!(fetcher.fetch(&format!("{base}/start")).await.unwrap().text, "[1]");

        let base = serve(vec![reply("404 Not Found", "", "")]).await.replace("localhost", "127.0.0.1");
        let url = format!("{base}/x");
        assert_eq!(
            fetcher.fetch(&url).await.unwrap_err(),
            format!("fetch: fetching {} failed: the server answered 404.", quote(&url))
        );

        let big = "x".repeat(100);
        let base = serve(vec![reply("200 OK", "", &big)]).await.replace("localhost", "127.0.0.1");
        let url = format!("{base}/big");
        assert_eq!(fetcher.fetch(&url).await.unwrap_err(), format!("fetch: {} is larger than 0 MB.", quote(&url)));

        let hops: Vec<String> = (0..4).map(|_| reply("301 Moved", "location: /again\r\n", "")).collect();
        let base = serve(hops).await.replace("localhost", "127.0.0.1");
        let url = format!("{base}/loop");
        assert_eq!(
            fetcher.fetch(&url).await.unwrap_err(),
            format!("fetch: {} redirected more than 3 times.", quote(&url))
        );
    }

    #[tokio::test]
    async fn a_host_resolving_to_a_private_address_is_refused() {
        // `localhost` resolves (from the hosts file) to loopback, which the resolver refuses
        // before anything connects. By name it is refused earlier still, in `check_url`.
        let resolver = GuardedResolver { allowed: is_public_address };
        let err = resolver.resolve("localhost".parse().unwrap()).await.err().unwrap();
        assert!(err.is::<BlockedAddress>(), "{err}");
        let allowing = GuardedResolver { allowed: |_| true };
        assert!(allowing.resolve("localhost".parse().unwrap()).await.is_ok());
    }
}
