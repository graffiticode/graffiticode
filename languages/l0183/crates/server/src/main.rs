// SPDX-License-Identifier: MIT

use graffiticode_l0183::{L0183, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0183, lexicon()).await
}
