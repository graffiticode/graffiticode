// SPDX-License-Identifier: MIT

use graffiticode_l0014::{L0014, lexicon};
use l0014_worker::NodeTranslator;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    l0000r_server::serve(L0014::new(NodeTranslator::from_env()), lexicon()).await
}
