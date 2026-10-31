// SPDX-License-Identifier: MIT

//! Layout and routing on the compiled (lowered) board: every valid program is accepted by the
//! independent validator with every required check passing; then the design's examples, one by
//! one, on the positions and routes they compile to.

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

async fn named(name: &str) -> Json {
    let all = cases();
    board(all.iter().find(|c| c.name == name).unwrap()).await
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct R {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn n(v: &Json, k: &str) -> f64 {
    v[k].as_f64().unwrap_or_else(|| panic!("no {k} in {v}"))
}

/// Every placed thing on a page by id: marks and sections (a section with its title band), and
/// groups (their bounds).
fn frames(page: &Json) -> std::collections::HashMap<String, R> {
    let mut out = std::collections::HashMap::new();
    fn walk(list: &Json, out: &mut std::collections::HashMap<String, R>) {
        for node in list.as_array().unwrap() {
            if node["type"] == "connector" {
                continue;
            }
            let mut r = R { x: n(node, "x"), y: n(node, "y"), w: n(node, "width"), h: n(node, "height") };
            if node["type"] == "section" {
                let top = section::TITLE_BAND + section::TITLE_GAP;
                r = R { y: r.y - top, h: r.h + top, ..r };
                walk(&node["nodes"], out);
            }
            out.insert(node["id"].as_str().unwrap().to_owned(), r);
        }
    }
    walk(&page["nodes"], &mut out);
    for g in page["groups"].as_array().unwrap() {
        let f = &g["frame"];
        out.insert(g["id"].as_str().unwrap().to_owned(), R { x: n(f, "x"), y: n(f, "y"), w: n(f, "w"), h: n(f, "h") });
    }
    out
}

fn connector<'a>(page: &'a Json, id: &str) -> &'a Json {
    page["nodes"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap()
}

#[tokio::test]
async fn every_valid_program_is_accepted_by_the_validator() {
    let mut failures = Vec::new();
    for case in cases().iter().filter(|c| !c.name.starts_with("invalid-")) {
        let board = board(case).await;
        let report = &board["report"];
        if report["accepted"] != true {
            failures.push(format!("{}: not accepted: {report}", case.name));
        }
        for check in report["checks"].as_array().unwrap() {
            let required = check["required"] == true;
            if required && check["status"] != "pass" {
                failures.push(format!("{}: {} is {}", case.name, check["name"], check["status"]));
            }
            if !required && check["status"] == "pass" {
                failures.push(format!("{}: unverifiable {} reported as passed", case.name, check["name"]));
            }
        }
        for page in board["pages"].as_array().unwrap() {
            for (id, r) in frames(page) {
                if r.x < 0.0 || r.y < 0.0 || r.x + r.w > n(page, "width") || r.y + r.h > n(page, "height") {
                    failures.push(format!("{}: {id} {r:?} is off its page", case.name));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn the_retrospective_keeps_its_sections_and_notes_in_order() {
    let board = named("retro").await;
    let f = frames(&board["pages"][0]);
    assert!(f["went-well"].x < f["improve"].x && f["improve"].x < f["actions"].x);
    assert!(f["shipped"].y < f["pairing"].y);
    assert_eq!(f["went-well"].y, f["improve"].y);
}

#[tokio::test]
async fn the_agenda_grid_has_two_on_its_first_row() {
    let board = named("agenda").await;
    let f = frames(&board["pages"][0]);
    assert!(f["heading"].y + f["heading"].h <= f["agenda-panels"].y);
    assert!(f["goals"].x < f["topics"].x);
    assert_eq!(f["scope"].y, f["risk"].y);
    assert!(f["scope"].x < f["risk"].x);
    assert!(f["owner"].y > f["scope"].y);
    assert_eq!(f["owner"].x, f["scope"].x);
    // The group is lowered away and kept for diagnostics.
    assert!(board["pages"][0]["nodes"].as_array().unwrap().iter().all(|n| n["type"] != "group"));
}

#[tokio::test]
async fn the_flow_follows_before_and_routes_the_return_edge_below_it() {
    let board = named("flow-return").await;
    let page = &board["pages"][0];
    let f = frames(page);
    assert!(f["fetch"].x < f["valid"].x);
    assert!(f["valid"].x < f["save"].x && f["valid"].x < f["error"].x);
    assert_eq!(f["save"].x, f["error"].x);
    assert_eq!(f["fetch"].y + f["fetch"].h / 2.0, f["valid"].y + f["valid"].h / 2.0);
    // Retry runs against the flow: through the channel below every mark, bottom to bottom.
    let retry = connector(page, "retry");
    assert_eq!(retry["routeKind"], "channel");
    assert_eq!((retry["fromSide"].as_str(), retry["toSide"].as_str()), (Some("BOTTOM"), Some("BOTTOM")));
    let lowest = f.values().map(|r| r.y + r.h).fold(0.0, f64::max);
    assert!(retry["waypoints"].as_array().unwrap().iter().all(|w| n(w, "y") >= lowest + spacing::GUTTER / 2.0));
    // Fetch to Valid is level: one straight leg.
    assert_eq!(connector(page, "fetch-valid")["routeKind"], "straight");
}

#[tokio::test]
async fn a_connection_between_regions_orders_their_flow() {
    let board = named("flow-lifted").await;
    let f = frames(&board["pages"][0]);
    assert!(f["g1"].x + f["g1"].w < f["g2"].x);
}

#[tokio::test]
async fn auto_lays_connected_marks_out_as_a_flow_and_packs_the_rest() {
    let board = named("auto-mixed").await;
    let f = frames(&board["pages"][0]);
    assert!(f["a"].x < f["b"].x && f["b"].x < f["c"].x);
    assert_eq!(f["a"].y + f["a"].h / 2.0, f["b"].y + f["b"].h / 2.0);
    assert!(f["d"].y >= f["a"].y + f["a"].h || f["d"].y + f["d"].h <= f["a"].y);
}

#[tokio::test]
async fn reversed_flows_run_left_and_up() {
    let board = named("flow-reversed").await;
    let f = frames(&board["pages"][0]);
    assert!(f["one"].x > f["two"].x);
    assert!(f["low"].y > f["high"].y);
}

#[tokio::test]
async fn cross_section_flow_runs_down() {
    let board = named("cross-section-flow").await;
    let f = frames(&board["pages"][0]);
    assert!(f["left"].y + f["left"].h < f["right"].y);
}

#[tokio::test]
async fn parallel_connectors_take_separate_routes_with_separate_labels() {
    let board = named("parallel-three").await;
    let page = &board["pages"][0];
    let ids = ["req", "res", "ping"];
    let sides: Vec<(String, String)> = ids
        .iter()
        .map(|id| {
            let c = connector(page, id);
            (c["fromSide"].as_str().unwrap().to_owned(), c["toSide"].as_str().unwrap().to_owned())
        })
        .collect();
    for i in 0..3 {
        for j in i + 1..3 {
            assert_ne!(sides[i], sides[j], "{} and {} share sides", ids[i], ids[j]);
        }
    }
    assert_eq!(board["report"]["quality"]["crossings"], 0);
}

#[tokio::test]
async fn a_self_loop_goes_around_a_corner_with_its_label_on_the_middle_leg() {
    let board = named("self-loop-parallel").await;
    let c = connector(&board["pages"][0], "loop");
    assert_eq!(c["routeKind"], "loop");
    assert_eq!(c["waypoints"].as_array().unwrap().len(), 3);
    assert_eq!(c["labelLeg"], 1);
}

#[tokio::test]
async fn crowded_connectors_get_room_from_the_repair_loop() {
    let board = named("repair-loop").await;
    assert!(board["report"]["repair"]["rounds"].as_u64().unwrap() > 0);
    assert_eq!(board["report"]["accepted"], true);
}
