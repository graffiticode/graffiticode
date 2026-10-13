// SPDX-License-Identifier: MIT

use graffiticode_l0003::{L0003, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0003, lexicon()).await
}
