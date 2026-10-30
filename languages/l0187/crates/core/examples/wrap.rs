// SPDX-License-Identifier: MIT

//! Prints how L0187 wraps `text` at `size` within `width`, for calibration against FigJam:
//! `cargo run -q --example wrap -- 24 200 "Pairing helped us resolve the integration issues"`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (size, width): (f64, f64) = (args[0].parse().unwrap(), args[1].parse().unwrap());
    for line in graffiticode_l0187::measure::wrap(&args[2], size, Some(width)) {
        println!("{:8.2}  {:?}", line.width, line.text);
    }
}
