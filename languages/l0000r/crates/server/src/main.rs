// SPDX-License-Identifier: MIT

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use graffiticode_l0000::policy_client::{HttpPolicyClient, MetadataIdTokens};
use graffiticode_l0000::schema::HttpSchemas;
use graffiticode_l0000::{Compiler, Keyring, L0000, RevisionIdentity};
use l0000r_server::auth::AuthService;
use l0000r_server::gateway::GoogleGateways;
use l0000r_server::{AppState, app};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|value| !value.is_empty()).unwrap_or_else(|| default.to_owned())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter(env_or("LOG_LEVEL", "info")).init();

    let port: u16 = env_or("PORT", "50000").parse()?;
    let auth_url = env_or("AUTH_URL", "https://auth.graffiticode.org");
    let static_dir = env_or("STATIC_DIR", "static");
    if !std::path::Path::new(&static_dir).join("index.html").is_file() {
        tracing::warn!(%static_dir, "no index.html in the static directory; /form will be 404 (run `npm run build:static`)");
    }

    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()?;
    let revision = RevisionIdentity::from_env();
    let mut compiler = Compiler::new(L0000)
        .with_schemas(HttpSchemas::from_env(client.clone()))
        .with_keyring(Keyring::from_env())
        .with_revision(revision.clone());
    // Chain admission: with POLICY_URL, a stage of an admitted plan asks policy for its
    // binding. L0000 has no protected functions, so there is no broker.
    if let Ok(policy_url) = std::env::var("POLICY_URL")
        && !policy_url.is_empty()
    {
        let id_tokens = MetadataIdTokens::new(client.clone());
        compiler = compiler.with_policy(HttpPolicyClient::new(client.clone(), policy_url, None, id_tokens));
    }
    // The gateway service accounts allowed to preflight. With none, every preflight is refused.
    let gateways: Vec<String> = env_or("PREFLIGHT_GATEWAYS", "").split(',').map(str::to_owned).collect();
    let state = AppState {
        gateways: Arc::new(GoogleGateways::new(client.clone(), compiler.lang_id(), &gateways)),
        verifier: Arc::new(AuthService::new(client, &auth_url)),
        revision: revision.revision,
        compiler,
    };

    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))).await?;
    tracing::info!(port, %auth_url, %static_dir, "L0000 language server listening");
    axum::serve(listener, app(state, static_dir)).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

/// Cloud Run stops an instance with SIGTERM; finish the requests in flight first.
async fn shutdown() {
    let mut terminate = signal(SignalKind::terminate()).expect("install the SIGTERM handler");
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
