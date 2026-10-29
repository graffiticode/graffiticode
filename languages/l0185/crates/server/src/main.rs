// SPDX-License-Identifier: MIT

use graffiticode_l0185::{L0185, lexicon};

use l0000r_server::{FormCaching, HttpCaching};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The same caching as the TypeScript server's app.ts (interpreter plan P4): /form is never
    // held, and the content-hashed /assets are immutable.
    let caching = HttpCaching { form: FormCaching::NoStore, immutable_assets: true };
    l0000r_server::serve_with(L0185::from_env()?, lexicon(), caching).await
}
