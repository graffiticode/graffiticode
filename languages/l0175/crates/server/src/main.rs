// SPDX-License-Identifier: MIT

use graffiticode_l0175::{L0175, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0175, lexicon()).await
}
