// SPDX-License-Identifier: MIT

use graffiticode_l0181::{L0181, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0181, lexicon()).await
}
