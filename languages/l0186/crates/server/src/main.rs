// SPDX-License-Identifier: MIT

use graffiticode_l0186::{L0186, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0186, lexicon()).await
}
