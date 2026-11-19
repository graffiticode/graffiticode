// SPDX-License-Identifier: MIT

use std::time::Duration;

use async_trait::async_trait;
use graffiticode_l0013::faults::{self, CaptureFault, CaptureFaults, FaultRuntime};
use graffiticode_l0013::{L0013, lexicon};
use l0013_capture::{ChromeCamera, Config, GoogleStorage, bucket_from_env};

/// The drive's faults act on the real process: they log, wait on a timer, and exit.
struct ProcessFaults;

#[async_trait]
impl FaultRuntime for ProcessFaults {
    /// The fault has logged `WARN capture fault <kind> command <id>` (through `warn`) already.
    fn exit(&self, _fault: CaptureFault, _command: &str) {
        std::process::exit(faults::EXIT_CODE);
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn warn(&self, line: &str) {
        tracing::warn!("{line}");
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The C5d drive's capture faults: refused, before anything else, on the production service
    // or when malformed.
    let targets =
        faults::parse_targets(std::env::var(faults::ENV).ok().as_deref(), std::env::var("K_SERVICE").ok().as_deref())?;
    // Through the egress proxy when HTTPS_PROXY is set (ISOLATE-01). `gcp_auth` fetches the
    // storage token from the metadata server with its own direct client.
    let http = l0000r_server::egress::client_builder()?.timeout(Duration::from_secs(60)).build()?;
    let storage = GoogleStorage::new(http.clone(), bucket_from_env());
    let camera = ChromeCamera::new(Config::from_env(), http, storage);
    let mut dialect = L0013::new(camera);
    if let Some(targets) = targets {
        // The server's log subscriber starts in `serve`, so this line goes to stderr directly.
        eprintln!("WARN {} names {} target command(s): a drive service", faults::ENV, targets.len());
        dialect = dialect.with_capture_faults(CaptureFaults::new(targets, ProcessFaults));
    }
    l0000r_server::serve(dialect, lexicon()).await
}
