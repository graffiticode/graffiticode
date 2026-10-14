// SPDX-License-Identifier: MIT

use graffiticode_l0185::{L0185, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0185::default(), lexicon()).await
}
