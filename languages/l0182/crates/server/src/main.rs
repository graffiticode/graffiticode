// SPDX-License-Identifier: MIT

use graffiticode_l0182::{L0182, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0182::default(), lexicon()).await
}
