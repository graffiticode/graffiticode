// SPDX-License-Identifier: MIT

use graffiticode_l0176::{L0176, lexicon};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0176::new(), lexicon()).await
}
