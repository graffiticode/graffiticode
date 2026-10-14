// SPDX-License-Identifier: MIT

use graffiticode_l0180::{L0180, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0180, lexicon()).await
}
