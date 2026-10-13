// SPDX-License-Identifier: MIT

use graffiticode_l0000::{L0000, Lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0000, Lexicon::base()).await
}
