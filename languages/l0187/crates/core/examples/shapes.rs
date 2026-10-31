// SPDX-License-Identifier: MIT

//! Prints the compiled size and lines of a shape of each `KIND:text` argument at 24px, as JSON,
//! for drawing in FigJam during calibration: `cargo run -q --example shapes -- "DIAMOND:Valid?"`.

use graffiticode_l0187::ir::{Child, Mark};

fn main() {
    let mut out = Vec::new();
    for arg in std::env::args().skip(1) {
        let (kind, text) = arg.split_once(':').expect("KIND:text");
        let m = Mark {
            id: "m".into(),
            text: text.into(),
            kind: Some(kind.into()),
            fill: None,
            stroke: None,
            stroke_width: None,
            color: None,
            opacity: 100.0,
            font_size: "MEDIUM".into(),
            before: Vec::new(),
        };
        let measured = graffiticode_l0187::size::mark(&Child::Shape(m)).unwrap().unwrap();
        let lines: Vec<&str> = measured.lines.iter().map(|l| l.text.as_str()).collect();
        out.push(serde_json::json!({ "kind": kind, "text": text, "w": measured.width, "h": measured.height, "lines": lines }));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
