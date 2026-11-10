// SPDX-License-Identifier: MIT

//! Compiles one test program and prints its first page's geometry (marks, sections, routes,
//! label boxes, report quality), and writes an SVG sketch of it to the given path.
//! `cargo run -q --example dump -- <case-name> [out.svg]`.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use serde_json::{Value as Json, json};

fn walk(nodes: &Json, svg: &mut String) {
    for n in nodes.as_array().into_iter().flatten() {
        let (x, y, w, h) = (
            n["x"].as_f64().unwrap_or(0.0),
            n["y"].as_f64().unwrap_or(0.0),
            n["width"].as_f64().unwrap_or(0.0),
            n["height"].as_f64().unwrap_or(0.0),
        );
        match n["type"].as_str().unwrap_or("") {
            "connector" => {
                let pts: Vec<String> =
                    n["route"].as_array().unwrap().iter().map(|p| format!("{},{}", p["x"], p["y"])).collect();
                println!("conn {:28} {}->{} {}", n["id"].as_str().unwrap(), n["fromSide"], n["toSide"], pts.join(" "));
                svg.push_str(&format!("<polyline points=\"{}\" fill=\"none\" stroke=\"#64748b\" stroke-width=\"3\" marker-end=\"url(#a)\"/>\n", pts.join(" ")));
                if let Some(b) = n.get("labelBox") {
                    println!("     label {:?} box {}", n["label"].as_str(), b);
                    svg.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#fff\" stroke=\"#f00\" stroke-width=\"0.5\"/><text x=\"{}\" y=\"{}\" font-size=\"12\" text-anchor=\"middle\">{}</text>\n", b["x"], b["y"], b["w"], b["h"], b["x"].as_f64().unwrap() + b["w"].as_f64().unwrap() / 2.0, b["y"].as_f64().unwrap() + b["h"].as_f64().unwrap() / 2.0 + 4.0, n["label"].as_str().unwrap_or("")));
                }
            }
            "section" => {
                println!("sect {:28} {x},{y} {w}x{h} title {}", n["id"].as_str().unwrap(), n["titleFrame"]);
                svg.push_str(&format!(
                    "<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" fill=\"#fff\" stroke=\"#ccc\"/>\n"
                ));
                if let Some(t) = n.get("titleFrame") {
                    svg.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#eee\"/>\n",
                        t["x"], t["y"], t["w"], t["h"]
                    ));
                }
                walk(&n["nodes"], svg);
            }
            kind => {
                println!("{kind:5} {:28} {x},{y} {w}x{h}", n["id"].as_str().unwrap_or(""));
                svg.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" rx=\"12\" fill=\"#eef\" stroke=\"#88a\"/><text x=\"{}\" y=\"{}\" font-size=\"11\">{}</text>\n", x + 4.0, y + 14.0, n["id"].as_str().unwrap_or("")));
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let cases: Vec<Json> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("tests/cases.json")).unwrap()).unwrap();
    let case = cases.iter().find(|c| c["name"] == args[1].as_str()).expect("no such case");
    let compiled = Compiler::new(L0187).compile(&case["ast"], &json!({}), &json!({}), Identity::default()).await;
    let board = compiled.result.expect("compiles").to_json().unwrap();
    let page = &board["pages"][0];
    let mut svg = String::new();
    walk(&page["nodes"], &mut svg);
    println!("quality {}", board["report"]["quality"]);
    println!("repair {}", board["report"]["repair"]);
    if let Some(out) = args.get(2) {
        let doc = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"-20 -20 2800 1100\" width=\"2800\" height=\"1100\" style=\"background:#f8fafc\"><defs><marker id=\"a\" markerWidth=\"10\" markerHeight=\"10\" refX=\"9\" refY=\"5\" orient=\"auto\"><path d=\"M0,0 L10,5 L0,10\" fill=\"none\" stroke=\"#64748b\"/></marker></defs>\n{svg}</svg>"
        );
        std::fs::write(out, doc).unwrap();
    }
}
