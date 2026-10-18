//! ISOLATE-01 rollout step 0: the Rust egress helper, run in a compiler class
//! behind the egress proxy, the way a `*r` server uses it
//! (`deploy/egress-proxy/step0/runtime.cloudbuild.yaml` builds it into an image).
//!
//!   egress_probe <listed-host> <unlisted-host>
//!
//! It shows, through the real helper:
//! - an ID token from the metadata server, through `MetadataIdTokens::direct()`, never
//!   the proxy;
//! - a listed HTTPS host through the proxy, trusting the CA in `NODE_EXTRA_CA_CERTS`;
//! - an unlisted host refused by the proxy.
//!
//! It prints one line, `AT11-RUNTIME rust <json>`, and exits 0 only if all three hold.

use graffiticode_l0000::egress::client_builder;
use graffiticode_l0000::policy_client::{IdTokenSource, MetadataIdTokens};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let listed = args.get(1).cloned().unwrap_or_else(|| "api.graffiticode.org".into());
    let unlisted = args.get(2).cloned().unwrap_or_else(|| "example.com".into());

    let token = match MetadataIdTokens::direct() {
        Ok(tokens) => tokens.id_token("urn:graffiticode:at11").await.map(|t| t.split('.').count() == 3),
        Err(e) => Err(e.to_string().into()),
    };
    let client = client_builder().and_then(|b| b.build().map_err(Into::into));
    let (listed_status, unlisted_refused) = match &client {
        Ok(client) => {
            let listed_status = client.get(format!("https://{listed}/")).send().await.map(|r| r.status().as_u16());
            let unlisted = client.get(format!("https://{unlisted}/")).send().await;
            (listed_status.map_err(|e| e.to_string()), unlisted.is_err())
        }
        Err(e) => (Err(format!("{e:?}")), false),
    };
    let token_ok = matches!(token, Ok(true));
    let listed_ok = matches!(listed_status, Ok(s) if s < 500);
    let passed = token_ok && listed_ok && unlisted_refused;
    println!(
        "AT11-RUNTIME rust {}",
        serde_json::json!({
            "passed": passed,
            "idToken": token_ok,
            "idTokenError": token.err().map(|e| e.to_string()),
            "listed": { "host": listed, "status": listed_status.as_ref().ok(), "error": listed_status.as_ref().err() },
            "unlistedRefused": { "host": unlisted, "refused": unlisted_refused },
        })
    );
    std::process::exit(if passed { 0 } else { 1 });
}
