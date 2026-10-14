// SPDX-License-Identifier: MIT

use graffiticode_l0184::{L0184, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0184, lexicon()).await
}
