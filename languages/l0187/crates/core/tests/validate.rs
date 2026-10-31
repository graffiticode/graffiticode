// SPDX-License-Identifier: MIT

//! The independent validator rejects bad candidates (design §8, §12): each test takes a board
//! the compiler produced and accepted, breaks one thing about it, and requires the validator to
//! fail the check that guards it. The obligations come from the semantic board; the geometry from
//! the broken candidate.

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0187::validate::{Status, validate};
use graffiticode_l0187::{L0187, ir::Board, semantic};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    name: String,
    ast: Json,
}

async fn compiled(name: &str) -> (Board, Json) {
    let all: Vec<Case> = serde_json::from_str(include_str!("cases.json")).unwrap();
    let case = all.into_iter().find(|c| c.name == name).unwrap();
    let board = semantic(&case.ast).await.unwrap();
    let out = Compiler::new(L0187).compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
    let mut json = out.result.unwrap().to_json().unwrap();
    json.as_object_mut().unwrap().remove("report");
    (board, json)
}

/// The node with `id` anywhere on page `p`, mutably.
fn node<'a>(candidate: &'a mut Json, p: usize, id: &str) -> &'a mut Json {
    fn find<'a>(list: &'a mut Json, id: &str) -> Option<&'a mut Json> {
        for n in list.as_array_mut()? {
            if n["id"] == id {
                return Some(n);
            }
            if n["type"] == "section"
                && let Some(found) = find(&mut n["nodes"], id)
            {
                return Some(found);
            }
        }
        None
    }
    find(&mut candidate["pages"][p]["nodes"], id).unwrap_or_else(|| panic!("no {id}"))
}

fn fails(board: &Board, candidate: &Json, check: &str) {
    let report = validate(board, candidate);
    assert!(!report.accepted, "accepted a broken candidate ({check})");
    let c = report.checks.iter().find(|c| c.name == check).unwrap();
    assert_eq!(c.status, Status::Fail, "{check} did not fail: {:#?}", report.checks);
}

#[tokio::test]
async fn the_compiled_candidates_are_accepted() {
    for name in ["retro", "agenda", "flow-return", "empty-template", "parallel-three", "sticky-grows"] {
        let (board, candidate) = compiled(name).await;
        let report = validate(&board, &candidate);
        assert!(report.accepted, "{name}: {:?}", report.failures());
    }
}

// Geometry.

#[tokio::test]
async fn overlapping_peers_are_rejected() {
    let (board, mut c) = compiled("retro").await;
    let x = node(&mut c, 0, "went-well")["x"].clone();
    node(&mut c, 0, "improve")["x"] = x;
    fails(&board, &c, "peer-clearance");
}

#[tokio::test]
async fn a_label_on_a_node_is_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    let save = node(&mut c, 0, "save").clone();
    let label = node(&mut c, 0, "valid-save");
    label["labelBox"]["x"] = save["x"].clone();
    label["labelBox"]["y"] = save["y"].clone();
    fails(&board, &c, "labels");
}

#[tokio::test]
async fn a_label_off_its_legs_midpoint_is_rejected() {
    let (board, mut c) = compiled("planning").await;
    let label = node(&mut c, 0, "idea-plan");
    let x = label["labelBox"]["x"].as_f64().unwrap();
    label["labelBox"]["x"] = json!(x + 10.0);
    fails(&board, &c, "labels");
}

#[tokio::test]
async fn a_thick_line_grazing_a_node_is_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    let error_bottom = {
        let e = node(&mut c, 0, "error");
        e["y"].as_f64().unwrap() + e["height"].as_f64().unwrap()
    };
    let retry = node(&mut c, 0, "retry");
    let lane = error_bottom + 6.0;
    for key in ["waypoints", "route"] {
        let points = retry[key].as_array_mut().unwrap();
        for p in points.iter_mut() {
            if p["y"].as_f64().unwrap() > error_bottom + 1.0 {
                p["y"] = json!(lane);
            }
        }
    }
    retry["strokeWidth"] = json!(8);
    fails(&board, &c, "routes");
}

#[tokio::test]
async fn a_route_that_leaves_the_wrong_magnet_is_rejected() {
    let (board, mut c) = compiled("planning").await;
    node(&mut c, 0, "idea-plan")["fromSide"] = json!("TOP");
    fails(&board, &c, "routes");
}

// Preservation.

#[tokio::test]
async fn a_dropped_mark_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    node(&mut c, 0, "went-well")["nodes"].as_array_mut().unwrap().retain(|n| n["id"] != "shipped");
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn an_extra_node_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    let mut extra = node(&mut c, 0, "shipped").clone();
    extra["id"] = json!("extra");
    extra["x"] = json!(5000);
    c["pages"][0]["nodes"].as_array_mut().unwrap().push(extra);
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn a_changed_endpoint_is_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    node(&mut c, 0, "valid-save")["to"] = json!("error");
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn changed_text_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    node(&mut c, 0, "shipped")["text"] = json!("Shipped late");
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn a_mark_moved_out_of_its_section_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    let flaky = node(&mut c, 0, "flaky").clone();
    node(&mut c, 0, "improve")["nodes"].as_array_mut().unwrap().retain(|n| n["id"] != "flaky");
    c["pages"][0]["nodes"].as_array_mut().unwrap().push(flaky);
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn a_mark_outside_its_lowered_group_is_rejected() {
    let (board, mut c) = compiled("agenda").await;
    let group =
        c["pages"][0]["groups"].as_array_mut().unwrap().iter_mut().find(|g| g["id"] == "agenda-panels").unwrap();
    group["frame"]["w"] = json!(100);
    fails(&board, &c, "preservation");
}

#[tokio::test]
async fn reordered_pages_are_rejected() {
    let (board, mut c) = compiled("empty-template").await;
    c["pages"].as_array_mut().unwrap().swap(0, 1);
    fails(&board, &c, "preservation");
}

// Order.

#[tokio::test]
async fn a_violated_row_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    let (a, b) = (node(&mut c, 0, "went-well")["x"].clone(), node(&mut c, 0, "actions")["x"].clone());
    node(&mut c, 0, "went-well")["x"] = b;
    node(&mut c, 0, "actions")["x"] = a;
    fails(&board, &c, "order");
}

#[tokio::test]
async fn a_violated_grid_is_rejected() {
    let (board, mut c) = compiled("agenda").await;
    let (a, b) = (node(&mut c, 0, "scope")["x"].clone(), node(&mut c, 0, "risk")["x"].clone());
    node(&mut c, 0, "scope")["x"] = b;
    node(&mut c, 0, "risk")["x"] = a;
    fails(&board, &c, "order");
}

#[tokio::test]
async fn a_violated_before_is_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    let (a, b) = (node(&mut c, 0, "fetch")["x"].clone(), node(&mut c, 0, "valid")["x"].clone());
    node(&mut c, 0, "fetch")["x"] = b;
    node(&mut c, 0, "valid")["x"] = a;
    fails(&board, &c, "order");
}

// Text.

fn lines(texts: &[(&str, &str, &str)]) -> Json {
    texts.iter().map(|(t, kind, consumed)| json!({ "text": t, "break": { "kind": kind, "text": consumed } })).collect()
}

#[tokio::test]
async fn a_truncated_line_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    node(&mut c, 0, "pairing")["lines"] = lines(&[("Pairing helped us", "end", "")]);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn reordered_lines_are_rejected() {
    let (board, mut c) = compiled("retro").await;
    let mut l = node(&mut c, 0, "pairing")["lines"].as_array().unwrap().clone();
    l.swap(0, 1);
    node(&mut c, 0, "pairing")["lines"] = Json::Array(l);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn an_overwide_line_is_rejected() {
    let (board, mut c) = compiled("retro").await;
    node(&mut c, 0, "pairing")["lines"] = lines(&[("Pairing helped us resolve the integration issues", "end", "")]);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn too_many_lines_for_the_box_are_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    // "Fetch data", one grapheme per line: nine lines in a 176 shape.
    let mut l: Vec<(&str, &str, &str)> = ["F", "e", "t", "c"].iter().map(|s| (*s, "cluster", "")).collect();
    l.push(("h", "soft", " "));
    l.extend(["d", "a", "t"].iter().map(|s| (*s, "cluster", "")));
    l.push(("a", "end", ""));
    node(&mut c, 0, "fetch")["lines"] = lines(&l);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn a_content_box_that_disagrees_with_its_kind_is_rejected() {
    let (board, mut c) = compiled("flow-return").await;
    node(&mut c, 0, "valid")["content"]["w"] = json!(170);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn a_sticky_shorter_than_figjam_grows_it_is_rejected() {
    let (board, mut c) = compiled("sticky-grows").await;
    node(&mut c, 0, "long")["height"] = json!(240);
    fails(&board, &c, "text-fit");
}

#[tokio::test]
async fn unverifiable_native_checks_are_never_reported_as_passed() {
    let (board, c) = compiled("flow-return").await;
    let report = validate(&board, &c);
    for check in report.checks.iter().filter(|c| c.scope == "native-unverified") {
        assert_eq!(check.status, Status::Unverified);
        assert!(!check.required);
    }
}

// Bounded work.

#[tokio::test]
async fn exhausting_the_repair_budget_is_a_classified_layout_failure() {
    let all: Vec<Case> = serde_json::from_str(include_str!("cases.json")).unwrap();
    let case = all.into_iter().find(|c| c.name == "repair-loop").unwrap();
    let board = semantic(&case.ast).await.unwrap();
    let sizes = graffiticode_l0187::size::size(&board).unwrap();
    // With no rounds of added spacing, the crowded loop cannot be routed.
    let err = graffiticode_l0187::position_within(&board, &sizes, 0, 4096).unwrap_err();
    assert_eq!(err.category.as_deref(), Some("layout"));
    assert_eq!(err.code.as_deref(), Some("layout-failure"));
    assert!(err.message.contains("\"again\"") && err.message.contains("compiler limitation"), "{}", err.message);
    // With one candidate per page and one round of added spacing, routing gives up the same way
    // (the loop needs two rounds before its first candidate fits).
    let err = graffiticode_l0187::position_within(&board, &sizes, 1, 1).unwrap_err();
    assert_eq!(err.code.as_deref(), Some("layout-failure"));
    // The profile's own limits succeed, after added spacing.
    assert!(graffiticode_l0187::position_within(&board, &sizes, 4, 4096).is_ok());
}

#[tokio::test]
async fn a_connector_arriving_where_another_leaves_is_rejected() {
    let (board, mut c) = compiled("parallel-three").await;
    // Draw "response" straight back along "request": it leaves Server's LEFT magnet, where
    // "request" arrives, and arrives at Client's RIGHT magnet, where "request" leaves.
    let req = node(&mut c, 0, "req").clone();
    let res = node(&mut c, 0, "res");
    res["fromSide"] = json!("LEFT");
    res["toSide"] = json!("RIGHT");
    res["waypoints"] = json!([]);
    let mut route = req["route"].as_array().unwrap().clone();
    route.reverse();
    res["route"] = Json::Array(route);
    fails(&board, &c, "routes");
}
