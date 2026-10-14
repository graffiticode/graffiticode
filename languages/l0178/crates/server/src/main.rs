// SPDX-License-Identifier: MIT

use graffiticode_l0178::{L0178, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0178, lexicon()).await
}
