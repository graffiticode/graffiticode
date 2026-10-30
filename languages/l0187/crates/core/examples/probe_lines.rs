// SPDX-License-Identifier: MIT

//! Calibration helper: single words whose advance at `size` lands just under each target
//! width, built from n, r and i: `cargo run -q --release --example probe_lines -- 24 140 156 1`.
//! Prints a JSON list of [target, advance, word].

fn main() {
    let args: Vec<f64> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let (size, from, to, step) = (args[0], args[1], args[2], args[3]);
    let adv = |s: &str| graffiticode_l0187::measure::advance(s, size);
    let mut w = from;
    let mut out = Vec::new();
    while w <= to {
        let mut best = (0.0, String::new());
        for n in 0..40 {
            for r in 0..4 {
                for i in 0..8 {
                    let s = format!("{}{}{}", "n".repeat(n), "r".repeat(r), "i".repeat(i));
                    let a = adv(&s);
                    if a <= w - 0.2 && a > best.0 {
                        best = (a, s);
                    }
                }
            }
        }
        out.push(format!("[{w},{:.2},{:?}]", best.0, best.1));
        w += step;
    }
    println!("[{}]", out.join(","));
}
