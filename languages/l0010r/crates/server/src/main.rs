// SPDX-License-Identifier: MIT

use graffiticode_l0010::{L0010, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0010, lexicon()).await
}
