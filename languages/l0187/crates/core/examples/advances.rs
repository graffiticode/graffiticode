// SPDX-License-Identifier: MIT

//! Prints L0187's measured advances for strings given as `size:text` arguments, for comparison
//! with FigJam during calibration: `cargo run -q --example advances -- "24:Hello world"`.

fn main() {
    for arg in std::env::args().skip(1) {
        let (size, text) = arg.split_once(':').expect("size:text");
        let size: f64 = size.parse().expect("a size");
        println!("{size}\t{:.3}\t{text:?}", graffiticode_l0187::measure::advance(text, size));
    }
}
