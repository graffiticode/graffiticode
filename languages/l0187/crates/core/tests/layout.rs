// SPDX-License-Identifier: MIT

//! Geometric guarantees of the layout (design §5, §8), checked on every valid test program's
//! compiled output: siblings never overlap and keep the gutter on at least one axis; children sit
//! inside their section's padding and their group's bounds; ROW, COLUMN and GRID keep the written
//! order; every `before` holds along its flow, with clearance; coordinates are whole pixels.
//! Then the design's examples, one by one.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::L0187;
use graffiticode_l0187::profile::{section, spacing};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    name: String,
    ast: Json,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("cases.json")).unwrap()
}

async fn board(case: &Case) -> Json {
    let compiled = Compiler::new(L0187).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    compiled.result.unwrap_or_else(|e| panic!("{}: {e:?}", case.name)).to_json().unwrap()
}

#[derive(Clone, Copy, Debug)]
struct R {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl R {
    fn of(v: &Json) -> R {
        let n = |k: &str| v[k].as_f64().unwrap_or_else(|| panic!("no {k} in {v}"));
        R { x: n("x"), y: n("y"), w: n("w"), h: n("h") }
    }
}

/// A child's layout bounds: its frame, and a section's title band above it.
fn bounds(child: &Json) -> R {
    let f = R::of(&child["frame"]);
    if child["type"] == "section" {
        let top = section::TITLE_BAND + section::TITLE_GAP;
        R { y: f.y - top, h: f.h + top, ..f }
    } else {
        f
    }
}

fn gap(a: R, b: R) -> f64 {
    let dx = (b.x - (a.x + a.w)).max(a.x - (b.x + b.w));
    let dy = (b.y - (a.y + a.h)).max(a.y - (b.y + b.h));
    dx.max(dy)
}

fn check_region(name: &str, region: &Json, inside: Option<R>, failures: &mut Vec<String>) {
    let children = region["children"].as_array().unwrap();
    let layout = &region["layout"];
    let mode = layout["mode"].as_str().unwrap();
    let rects: Vec<R> = children.iter().map(bounds).collect();
    for (i, c) in children.iter().enumerate() {
        let r = rects[i];
        for v in [r.x, r.y, r.w, r.h] {
            if v.fract() != 0.0 {
                failures.push(format!("{name}: {} has a fractional coordinate {v}", c["id"]));
            }
        }
        if let Some(outer) = inside
            && (r.x < outer.x - 1e-9
                || r.y < outer.y - 1e-9
                || r.x + r.w > outer.x + outer.w + 1e-9
                || r.y + r.h > outer.y + outer.h + 1e-9)
        {
            failures.push(format!("{name}: {} {r:?} is outside its container {outer:?}", c["id"]));
        }
        for (j, d) in children.iter().enumerate().skip(i + 1) {
            if gap(r, rects[j]) < spacing::GUTTER - 1e-9 {
                failures.push(format!("{name}: {} and {} are {} apart", c["id"], d["id"], gap(r, rects[j])));
            }
        }
    }
    // Written order.
    for i in 1..children.len() {
        let (a, b) = (rects[i - 1], rects[i]);
        let ok = match mode {
            "ROW" => b.x >= a.x + a.w,
            "COLUMN" => b.y >= a.y + a.h,
            _ => true,
        };
        if !ok {
            failures.push(format!(
                "{name}: {mode} order broken between {} and {}",
                children[i - 1]["id"],
                children[i]["id"]
            ));
        }
    }
    if mode == "GRID" {
        let columns = layout["columns"].as_u64().unwrap() as usize;
        for i in 0..children.len() {
            for j in i + 1..children.len() {
                let (ri, rj) = (rects[i], rects[j]);
                let ok = if i / columns == j / columns { rj.x >= ri.x + ri.w } else { rj.y >= ri.y + ri.h };
                if !ok {
                    failures.push(format!(
                        "{name}: GRID order broken between {} and {}",
                        children[i]["id"], children[j]["id"]
                    ));
                }
            }
        }
    }
    // Strict order: disjoint along the flow, with clearance.
    if mode == "FLOW" {
        let direction = layout["direction"].as_str().unwrap();
        for (i, c) in children.iter().enumerate() {
            for target in c["before"].as_array().into_iter().flatten() {
                let j = children.iter().position(|d| d["id"] == *target).unwrap();
                let (a, b) = (rects[i], rects[j]);
                let clearance = match direction {
                    "RIGHT" => b.x - (a.x + a.w),
                    "LEFT" => a.x - (b.x + b.w),
                    "DOWN" => b.y - (a.y + a.h),
                    _ => a.y - (b.y + b.h),
                };
                if clearance < spacing::GUTTER - 1e-9 {
                    failures
                        .push(format!("{name}: {} before {target}: clearance {clearance} along {direction}", c["id"]));
                }
            }
        }
    }
    for c in children {
        if let Some(inner) = c.get("region") {
            let f = R::of(&c["frame"]);
            let area = if c["type"] == "section" {
                let p = section::PADDING;
                R { x: f.x + p, y: f.y + p, w: f.w - 2.0 * p, h: f.h - 2.0 * p }
            } else {
                f
            };
            check_region(name, inner, Some(area), failures);
        }
    }
}

fn marks(region: &Json, out: &mut Vec<(String, R)>) {
    for c in region["children"].as_array().unwrap() {
        match c.get("region") {
            Some(inner) => marks(inner, out),
            None => out.push((c["id"].as_str().unwrap().to_owned(), R::of(&c["frame"]))),
        }
    }
}

#[tokio::test]
async fn every_valid_program_lays_out_within_the_geometric_contract() {
    let mut failures = Vec::new();
    for case in cases().iter().filter(|c| !c.name.starts_with("invalid-")) {
        let board = board(case).await;
        for page in board["pages"].as_array().unwrap() {
            check_region(&case.name, &page["region"], None, &mut failures);
            // A routing channel crosses no mark.
            let mut all = Vec::new();
            marks(&page["region"], &mut all);
            for channel in page["channels"].as_array().unwrap() {
                let c = R::of(&channel["frame"]);
                for (id, m) in &all {
                    if gap(c, *m) <= 0.0 {
                        failures.push(format!("{}: channel of {} crosses {id}", case.name, channel["region"]));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn find<'a>(region: &'a Json, id: &str) -> Option<&'a Json> {
    region["children"]
        .as_array()?
        .iter()
        .find_map(|c| if c["id"] == id { Some(c) } else { c.get("region").and_then(|r| find(r, id)) })
}

async fn frames(name: &str) -> impl Fn(&str) -> R {
    let all = cases();
    let case = all.iter().find(|c| c.name == name).unwrap();
    let board = board(case).await;
    move |id: &str| {
        let page = board["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|p| find(&p["region"], id))
            .unwrap_or_else(|| panic!("{id}"));
        bounds(page)
    }
}

#[tokio::test]
async fn the_retrospective_keeps_its_sections_and_notes_in_order() {
    let f = frames("retro").await;
    assert!(f("went-well").x < f("improve").x && f("improve").x < f("actions").x);
    assert!(f("shipped").y < f("pairing").y);
    // Sections share a top edge (start-aligned row).
    assert_eq!(f("went-well").y, f("improve").y);
}

#[tokio::test]
async fn the_agenda_grid_has_two_on_its_first_row() {
    let f = frames("agenda").await;
    assert!(f("heading").y + f("heading").h <= f("agenda-panels").y);
    assert!(f("goals").x < f("topics").x);
    assert_eq!(f("scope").y, f("risk").y);
    assert!(f("scope").x < f("risk").x);
    assert!(f("owner").y > f("scope").y);
    assert_eq!(f("owner").x, f("scope").x);
}

#[tokio::test]
async fn a_return_edge_gets_a_routing_channel_below_the_flow() {
    let all = cases();
    let case = all.iter().find(|c| c.name == "flow-return").unwrap();
    let board = board(case).await;
    let channels = board["pages"][0]["channels"].as_array().unwrap();
    assert_eq!(channels.len(), 1);
    let c = R::of(&channels[0]["frame"]);
    let mut all_marks = Vec::new();
    marks(&board["pages"][0]["region"], &mut all_marks);
    let lowest = all_marks.iter().map(|(_, m)| m.y + m.h).fold(0.0, f64::max);
    assert!(c.y >= lowest + spacing::GUTTER);
    // Without a return edge or a long edge there is none.
    let planning = all.iter().find(|c| c.name == "planning").unwrap();
    assert!(self::board(planning).await["pages"][0]["channels"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_flow_follows_before_and_keeps_the_return_edge_out_of_its_order() {
    let f = frames("flow-return").await;
    assert!(f("fetch").x < f("valid").x);
    assert!(f("valid").x < f("save").x && f("valid").x < f("error").x);
    // Save and Error share a layer: no order between them.
    assert_eq!(f("save").x, f("error").x);
    // A chain is centred: fetch and valid sit on one line.
    assert_eq!(f("fetch").y + f("fetch").h / 2.0, f("valid").y + f("valid").h / 2.0);
}

#[tokio::test]
async fn a_connection_between_regions_orders_their_flow() {
    // g2 is written first, but the connector a → b runs from inside g1 to inside g2.
    let f = frames("flow-lifted").await;
    assert!(f("g1").x + f("g1").w < f("g2").x);
}

#[tokio::test]
async fn auto_lays_connected_marks_out_as_a_flow_and_packs_the_rest() {
    let f = frames("auto-mixed").await;
    assert!(f("a").x < f("b").x && f("b").x < f("c").x);
    assert_eq!(f("a").y + f("a").h / 2.0, f("b").y + f("b").h / 2.0);
    // The loose stickies are packed apart from the flow.
    assert!(f("d").y >= f("a").y + f("a").h || f("d").y + f("d").h <= f("a").y);
}

#[tokio::test]
async fn reversed_flows_run_left_and_up() {
    let f = frames("flow-reversed").await;
    assert!(f("one").x > f("two").x);
    assert!(f("low").y > f("high").y);
}

#[tokio::test]
async fn cross_section_flow_runs_down() {
    let f = frames("cross-section-flow").await;
    assert!(f("left").y + f("left").h < f("right").y);
}
