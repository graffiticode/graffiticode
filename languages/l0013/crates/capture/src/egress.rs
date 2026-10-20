// SPDX-License-Identifier: MIT

//! Headless Chrome behind the ISOLATE-01 egress proxy. Neither the kernel's
//! `egress::client_builder()` nor the proxy variables reach Chrome: it needs the proxy on its
//! command line, and it trusts only its own NSS database, not `NODE_EXTRA_CA_CERTS` or
//! `SSL_CERT_FILE`. With `HTTPS_PROXY` set, every launch goes through [`chrome_egress`].
//!
//! Inventory: the pages Chrome loads are the api's `/form` (`GRAFFITICODE_API_URL`, by default
//! `api.graffiticode.org`) and whatever that form loads in turn (the language's view bundle,
//! served by the api). Loopback stays direct, by Chrome's own implicit bypass.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::CameraError;

/// The nickname the proxy's CA is stored under in Chrome's NSS database.
pub const CA_NICKNAME: &str = "isolate01-egress-ca";

/// Chrome's own background traffic, off: sign-in, component updates, sync, autofill, its
/// connectivity and default-search checks. A capture needs none of it, and through the egress
/// proxy each request is a refusal in the log (2026-10-20). Names without `--`, as chromiumoxide
/// wants them; a bare name is a switch without a value.
pub const QUIET_SWITCHES: &[&str] = &[
    "disable-background-networking",
    "disable-component-update",
    "disable-sync",
    "disable-default-apps",
    "no-first-run",
    "no-default-browser-check",
    "disable-domain-reliability",
    "disable-client-side-phishing-detection",
];
/// The `disable-features` switch's value, set beside QUIET_SWITCHES.
pub const QUIET_DISABLED_FEATURES: &str = "OptimizationHints,Translate,MediaRouter,AutofillServerCommunication";

/// What a launch adds for the proxy: Chrome switches (name without `--`, and value), and the CA
/// it must trust. chromiumoxide adds the `--` itself, so a switch is never passed pre-formatted.
#[derive(Debug, Default, PartialEq)]
pub struct ChromeEgress {
    pub switches: Vec<(String, String)>,
    pub ca: Option<PathBuf>,
}

fn set(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name).filter(|v| !v.trim().is_empty())
}

/// The proxy arguments and CA from the environment (`get` reads one variable). No proxy: no
/// arguments. A proxy without a CA is refused, as the kernel's helper refuses it: the proxy
/// terminates TLS with a private CA, so Chrome could reach nothing.
pub fn chrome_egress(get: impl Fn(&str) -> Option<String>) -> Result<ChromeEgress, CameraError> {
    let Some(proxy) = set(&get, "HTTPS_PROXY").or_else(|| set(&get, "https_proxy")) else {
        return Ok(ChromeEgress::default());
    };
    let ca = set(&get, "NODE_EXTRA_CA_CERTS").or_else(|| set(&get, "SSL_CERT_FILE")).ok_or(
        "HTTPS_PROXY is set without NODE_EXTRA_CA_CERTS or SSL_CERT_FILE: Chrome can't trust the egress proxy",
    )?;
    let pac = pac_url(&proxy).map_err(|e| format!("HTTPS_PROXY {proxy}: {e}"))?;
    Ok(ChromeEgress { switches: vec![("proxy-pac-url".into(), pac)], ca: Some(PathBuf::from(ca)) })
}

/// Chrome's proxy, as a PAC script: the Graffiticode hosts a capture loads go to the egress proxy,
/// loopback stays direct, and everything else goes to a closed local port, so it fails inside the
/// container. A switch can't reach Chrome's own background services (sign-in, updates,
/// connectivity checks); this does, so they no longer reach the proxy only to be refused
/// (2026-10-20). The proxy still enforces its own exact list.
pub fn pac_script(proxy: &str) -> Result<String, String> {
    let rest = proxy.split_once("://").map(|(_, r)| r).unwrap_or(proxy);
    let host_port = rest.trim_end_matches('/');
    if host_port.is_empty() || host_port.contains(['/', '"', '\\', ' ']) {
        return Err("not a proxy address".into());
    }
    Ok([
        "function FindProxyForURL(url, host) {".to_string(),
        r#"  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "DIRECT";"#.to_string(),
        format!(r#"  if (host === "graffiticode.org" || dnsDomainIs(host, ".graffiticode.org")) return "PROXY {host_port}";"#),
        r#"  return "PROXY 127.0.0.1:9";"#.to_string(),
        "}".to_string(),
    ]
    .join("\n"))
}

pub fn pac_url(proxy: &str) -> Result<String, String> {
    use base64::Engine;
    Ok(format!(
        "data:application/x-ns-proxy-autoconfig;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(pac_script(proxy)?)
    ))
}

/// The `certutil` invocations that make an NSS database at `nssdb` trusting `ca` for TLS.
pub fn nss_commands(nssdb: &Path, ca: &Path) -> Vec<Vec<String>> {
    let db = format!("sql:{}", nssdb.display());
    vec![
        vec!["certutil".into(), "-N".into(), "-d".into(), db.clone(), "--empty-password".into()],
        vec![
            "certutil".into(),
            "-A".into(),
            "-d".into(),
            db,
            "-n".into(),
            CA_NICKNAME.into(),
            "-t".into(),
            "C,,".into(),
            "-i".into(),
            ca.display().to_string(),
        ],
    ]
}

/// Makes `$home/.pki/nssdb` trusting `ca`, where Chrome on Linux looks for it when `HOME` is
/// `home`. Fails closed: without `certutil`, a proxied launch is an error, never a launch that
/// can't verify anything.
pub fn build_nss_db(home: &Path, ca: &Path) -> Result<(), CameraError> {
    let nssdb = home.join(".pki").join("nssdb");
    std::fs::create_dir_all(&nssdb)?;
    for command in nss_commands(&nssdb, ca) {
        let output = Command::new(&command[0]).args(&command[1..]).output().map_err(|e| -> CameraError {
            if e.kind() == std::io::ErrorKind::NotFound {
                "certutil not found: the image needs NSS tools (libnss3-tools) to trust the egress proxy's CA".into()
            } else {
                e.into()
            }
        })?;
        if !output.status.success() {
            return Err(format!(
                "{} failed: {}",
                command[..2].join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_pac_script_proxies_only_graffiticode() {
        let pac = pac_script("http://10.8.0.2:3128").unwrap();
        assert!(pac.contains(r#"return "PROXY 10.8.0.2:3128";"#));
        assert!(pac.contains(r#"dnsDomainIs(host, ".graffiticode.org")"#));
        assert!(pac.contains(r#"return "PROXY 127.0.0.1:9";"#));
        assert!(pac_script("http://a\"b:1").is_err());
        assert!(pac_url("http://10.8.0.2:3128").unwrap().starts_with("data:application/x-ns-proxy-autoconfig;base64,"));
    }

    #[test]
    fn chromes_background_traffic_is_off() {
        for s in ["disable-background-networking", "disable-component-update", "disable-sync", "no-first-run"] {
            assert!(QUIET_SWITCHES.contains(&s), "{s}");
        }
        assert!(QUIET_SWITCHES.iter().all(|s| !s.starts_with('-') && !s.contains('=')));
        assert!(QUIET_DISABLED_FEATURES.contains("AutofillServerCommunication"));
    }

    #[test]
    fn no_proxy_adds_nothing() {
        assert_eq!(chrome_egress(env(&[])).unwrap(), ChromeEgress::default());
        assert_eq!(
            chrome_egress(env(&[("HTTPS_PROXY", " "), ("NODE_EXTRA_CA_CERTS", "/ca.pem")])).unwrap(),
            ChromeEgress::default()
        );
    }

    #[test]
    fn a_proxy_sets_the_server_and_the_ca() {
        let got = chrome_egress(env(&[
            ("HTTPS_PROXY", "http://10.8.0.2:3128"),
            ("NODE_EXTRA_CA_CERTS", "/etc/egress/ca.pem"),
        ]))
        .unwrap();
        assert_eq!(got.switches, vec![("proxy-pac-url".to_string(), pac_url("http://10.8.0.2:3128").unwrap())]);
        assert_eq!(got.ca, Some(PathBuf::from("/etc/egress/ca.pem")));
        let lower = chrome_egress(env(&[("https_proxy", "http://p:3128"), ("SSL_CERT_FILE", "/ca.pem")])).unwrap();
        assert_eq!(lower.switches, vec![("proxy-pac-url".to_string(), pac_url("http://p:3128").unwrap())]);
        assert_eq!(lower.ca, Some(PathBuf::from("/ca.pem")));
    }

    #[test]
    fn a_proxy_without_a_ca_is_refused() {
        let err = chrome_egress(env(&[("HTTPS_PROXY", "http://10.8.0.2:3128")])).unwrap_err();
        assert!(err.to_string().contains("without NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn the_nss_database_trusts_the_ca_for_tls() {
        let commands = nss_commands(Path::new("/h/.pki/nssdb"), Path::new("/ca.pem"));
        assert_eq!(commands[0], ["certutil", "-N", "-d", "sql:/h/.pki/nssdb", "--empty-password"]);
        assert_eq!(
            commands[1],
            ["certutil", "-A", "-d", "sql:/h/.pki/nssdb", "-n", CA_NICKNAME, "-t", "C,,", "-i", "/ca.pem"]
        );
    }
}
