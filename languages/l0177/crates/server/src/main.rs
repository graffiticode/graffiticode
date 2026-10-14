// SPDX-License-Identifier: MIT

use graffiticode_l0177::{L0177, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0177, lexicon()).await
}
