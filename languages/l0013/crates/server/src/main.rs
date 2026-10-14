// SPDX-License-Identifier: MIT

use std::time::Duration;

use graffiticode_l0013::{L0013, lexicon};
use l0013_capture::{ChromeCamera, Config, GoogleStorage, bucket_from_env};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Through the egress proxy when HTTPS_PROXY is set (ISOLATE-01). `gcp_auth` fetches the
    // storage token from the metadata server with its own direct client.
    let http = l0000r_server::egress::client_builder()?.timeout(Duration::from_secs(60)).build()?;
    let storage = GoogleStorage::new(http.clone(), bucket_from_env());
    let camera = ChromeCamera::new(Config::from_env(), http, storage);
    l0000r_server::serve(L0013::new(camera), lexicon()).await
}
