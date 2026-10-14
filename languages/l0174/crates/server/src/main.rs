// SPDX-License-Identifier: MIT

use graffiticode_l0174::{L0174, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0174, lexicon()).await
}
