// SPDX-License-Identifier: MIT

//! ISOLATE-01: outbound HTTP from a language server goes through the compiler network's egress
//! proxy, and identity tokens come straight from the metadata server.
//!
//! Every client a server or dialect makes is built from [`client_builder`]. With `HTTPS_PROXY`
//! (or `HTTP_PROXY`) set it sends everything through that proxy except the metadata server, and
//! trusts the proxy's CA from `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` (the file the deploy CLI
//! mounts), alongside the usual roots. An explicitly configured [`reqwest::Proxy`] has no
//! exclusions of its own and doesn't read `NO_PROXY`, so the metadata exclusion is set here.
//!
//! [`metadata_client`] is the one client that never uses a proxy: it resolves only
//! `metadata.google.internal`, follows no redirects, and refuses any URL that isn't plain `http`
//! to that name (an IP literal never reaches a resolver, so the name is checked per request). [`crate::policy_client::MetadataIdTokens`]
//! is built from it, so a misconfigured proxy can't swallow the server's identity.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Certificate, ClientBuilder, NoProxy, Proxy};

/// The hosts that bypass the proxy: the metadata server, by name and by address. The same list
/// the deploy CLI sets as `NO_PROXY`.
pub const METADATA_HOSTS: &str = "metadata.google.internal,169.254.169.254";
const METADATA_NAME: &str = "metadata.google.internal";
const METADATA_ADDRESS: IpAddr = IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254));

#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    #[error("egress: {0} is not a proxy URL: {1}")]
    Proxy(String, reqwest::Error),
    #[error("egress: {0} names a proxy but neither NODE_EXTRA_CA_CERTS nor SSL_CERT_FILE names its CA")]
    NoCa(&'static str),
    #[error("egress: the proxy CA {0} can't be read: {1}")]
    CaFile(PathBuf, std::io::Error),
    #[error("egress: the proxy CA {0} holds no certificate: {1}")]
    CaPem(PathBuf, String),
    #[error("egress: {0}")]
    Build(#[from] reqwest::Error),
    #[error("egress: the metadata client sends only http://{METADATA_NAME}/..., not {0}")]
    NotMetadataUrl(String),
}

/// What the environment says about egress.
#[derive(Clone, Debug, Default)]
pub struct EgressEnv {
    /// The proxy URL and the variable it came from.
    pub proxy: Option<(String, &'static str)>,
    /// The proxy's CA bundle.
    pub ca_file: Option<PathBuf>,
}

impl EgressEnv {
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let read = |name: &'static str| {
            get(name).or_else(|| get(&name.to_lowercase())).filter(|v| !v.is_empty()).map(|v| (v, name))
        };
        let proxy = read("HTTPS_PROXY").or_else(|| read("HTTP_PROXY"));
        let ca_file = read("NODE_EXTRA_CA_CERTS").or_else(|| read("SSL_CERT_FILE")).map(|(v, _)| PathBuf::from(v));
        Self { proxy, ca_file }
    }
}

/// A client builder for any outbound request, configured from the process environment.
pub fn client_builder() -> Result<ClientBuilder, EgressError> {
    client_builder_with(&EgressEnv::from_env())
}

/// [`client_builder`], for a given environment.
pub fn client_builder_with(env: &EgressEnv) -> Result<ClientBuilder, EgressError> {
    let builder = reqwest::Client::builder();
    let Some((url, var)) = &env.proxy else {
        // No proxy configured: direct, and never one picked up from elsewhere.
        return Ok(builder.no_proxy());
    };
    let proxy = Proxy::all(url.as_str())
        .map_err(|err| EgressError::Proxy(url.clone(), err))?
        .no_proxy(NoProxy::from_string(METADATA_HOSTS));
    let ca_file = env.ca_file.as_ref().ok_or(EgressError::NoCa(var))?;
    let pem = std::fs::read(ca_file).map_err(|err| EgressError::CaFile(ca_file.clone(), err))?;
    let roots =
        Certificate::from_pem_bundle(&pem).map_err(|err| EgressError::CaPem(ca_file.clone(), err.to_string()))?;
    if roots.is_empty() {
        return Err(EgressError::CaPem(ca_file.clone(), "empty".into()));
    }
    // `proxy` replaces any proxy reqwest would read for itself, and the CA is added to the
    // built-in roots, not instead of them.
    Ok(builder.proxy(proxy).tls_certs_merge(roots))
}

/// The client for the metadata server: no proxy, no redirects, a resolver that knows only
/// `metadata.google.internal`, and requests only to `http://metadata.google.internal/...`.
pub fn metadata_client() -> Result<MetadataClient, EgressError> {
    metadata_client_at(SocketAddr::new(METADATA_ADDRESS, 80))
}

/// [`metadata_client`], with the metadata name resolving to `address` (for tests).
pub fn metadata_client_at(address: SocketAddr) -> Result<MetadataClient, EgressError> {
    Ok(MetadataClient(
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .dns_resolver(Arc::new(MetadataOnly(address)))
            .build()?,
    ))
}

/// A direct client that can only ask the metadata server. The resolver can't stop an IP
/// literal (`http://10.0.0.1/`) or another scheme, so every request's URL is checked first.
#[derive(Clone, Debug)]
pub struct MetadataClient(reqwest::Client);

impl MetadataClient {
    /// A GET to `url`, which must be `http://metadata.google.internal[:port]/...`.
    pub fn get(&self, url: &str) -> Result<reqwest::RequestBuilder, EgressError> {
        let parsed = reqwest::Url::parse(url).map_err(|_| EgressError::NotMetadataUrl(url.to_owned()))?;
        // An IP literal's host is the address itself, so it never equals the name.
        let named = parsed.host_str().is_some_and(|host| host.eq_ignore_ascii_case(METADATA_NAME));
        if parsed.scheme() != "http" || !named || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(EgressError::NotMetadataUrl(url.to_owned()));
        }
        Ok(self.0.get(parsed))
    }
}

#[derive(Debug, thiserror::Error)]
#[error("egress: the metadata client resolves only {METADATA_NAME}")]
struct NotMetadata;

struct MetadataOnly(SocketAddr);

impl Resolve for MetadataOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let address = self.0;
        let ok = name.as_str().eq_ignore_ascii_case(METADATA_NAME);
        Box::pin(async move {
            if ok {
                Ok(Box::new(std::iter::once(address)) as Addrs)
            } else {
                Err(Box::new(NotMetadata) as Box<dyn std::error::Error + Send + Sync>)
            }
        })
    }
}
