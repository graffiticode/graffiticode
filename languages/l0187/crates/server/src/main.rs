// SPDX-License-Identifier: MIT

use graffiticode_l0187::{L0187, lexicon};

use l0000r_server::{FormCaching, HttpCaching};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // /form is never held, and the content-hashed /assets are immutable (interpreter plan P4).
    let caching = HttpCaching { form: FormCaching::NoStore, immutable_assets: true };
    l0000r_server::serve_with(L0187, lexicon(), caching).await
}
