// SPDX-License-Identifier: MIT

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use graffiticode_l0000::schema::HttpSchemas;
use graffiticode_l0000::{Compiler, Keyring, L0000};
use l0000r_server::auth::AuthService;
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
    let compiler =
        Compiler::new(L0000).with_schemas(HttpSchemas::from_env(client.clone())).with_keyring(Keyring::from_env());
    let state = AppState { compiler, verifier: Arc::new(AuthService::new(client, &auth_url)) };

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
