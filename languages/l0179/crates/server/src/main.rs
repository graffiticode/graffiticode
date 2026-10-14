// SPDX-License-Identifier: MIT

use graffiticode_l0179::{L0179, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0179, lexicon()).await
}
