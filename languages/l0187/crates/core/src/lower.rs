// SPDX-License-Identifier: MIT

//! Lowering: the semantic board, its sizes, layout and routes, as the positioned board the
//! Graffiticode FigJam plugin draws and the preview renders (design §8). It is L0186's board
//! shape with every geometry field filled and `positioned: 1`, which tells the plugin to draw
//! exactly what it is given:
//!
//! - marks carry absolute `x`, `y`, `width`, `height`, their `lines` (the preview draws exactly
//!   these and never measures) and their text `content` box; stickies say whether they are wide;
//! - a section carries its border box, its `titleFrame`, and its members' nodes (absolute);
//! - groups are lowered away; each page lists them under `groups` with their bounds and members,
//!   for diagnostics and the validator;
//! - connectors come after the nodes, as straight legs: `lineType "straight"`, `fromSide`,
//!   `toSide`, `waypoints`, plus the modeled `route` and `labelBox` for the preview.

use serde_json::{Map, Value as Json, json};

use crate::ir::{Board, Child, Connector, Region};
use crate::layout::{Frame, PageLayout};
use crate::profile;
use crate::route::Route;
use crate::size::{Measured, Sizes};

fn frame(f: &Frame) -> Json {
    json!({ "x": f.x, "y": f.y, "w": f.w, "h": f.h })
}

fn put(o: &mut Map<String, Json>, key: &str, value: Option<impl Into<Json>>) {
    if let Some(v) = value {
        o.insert(key.to_owned(), v.into());
    }
}

fn text_fields(o: &mut Map<String, Json>, m: &Measured, text: &str) {
    o.insert("text".to_owned(), text.into());
    o.insert("fontSize".to_owned(), m.font_size.into());
    o.insert("lineHeight".to_owned(), m.line_height.into());
    o.insert("lines".to_owned(), serde_json::to_value(&m.lines).expect("lines serialize"));
    o.insert("content".to_owned(), json!({ "x": m.content.x, "y": m.content.y, "w": m.content.w, "h": m.content.h }));
}

fn nodes(region: &Region, layout: &PageLayout, sizes: &Sizes, groups: &mut Vec<Json>) -> Vec<Json> {
    let mut out = Vec::new();
    for child in &region.children {
        let f = layout.frames.get(child.id()).copied().unwrap_or(Frame { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let mut o = Map::new();
        match child {
            Child::Group(g) => {
                let mut members = Vec::new();
                collect_ids(&g.region, &mut members);
                groups.push(json!({ "id": g.id, "frame": frame(&f), "members": members }));
                out.extend(nodes(&g.region, layout, sizes, groups));
                continue;
            }
            Child::Section(s) => {
                o.insert("type".to_owned(), "section".into());
                o.insert("id".to_owned(), s.id.clone().into());
                o.insert("name".to_owned(), s.name.clone().into());
                put(&mut o, "fill", s.fill.clone());
                o.insert("opacity".to_owned(), s.opacity.into());
                o.insert("x".to_owned(), f.x.into());
                o.insert("y".to_owned(), f.y.into());
                o.insert("width".to_owned(), f.w.into());
                o.insert("height".to_owned(), f.h.into());
                if let Some(t) = layout.titles.get(&s.id) {
                    o.insert("titleFrame".to_owned(), frame(t));
                }
                o.insert("nodes".to_owned(), nodes(&s.region, layout, sizes, groups).into());
            }
            Child::Sticky(m) | Child::Shape(m) | Child::Textbox(m) => {
                let measured = &sizes.marks[&m.id];
                let kind = match child {
                    Child::Sticky(_) => "sticky",
                    Child::Shape(_) => "shape",
                    _ => "text",
                };
                o.insert("type".to_owned(), kind.into());
                o.insert("id".to_owned(), m.id.clone().into());
                o.insert("x".to_owned(), f.x.into());
                o.insert("y".to_owned(), f.y.into());
                o.insert("width".to_owned(), f.w.into());
                o.insert("height".to_owned(), f.h.into());
                if kind == "sticky" {
                    o.insert("wide".to_owned(), (f.w == profile::sticky::WIDE).into());
                }
                if kind == "shape" {
                    o.insert("shapeType".to_owned(), m.kind.clone().unwrap_or_else(|| "SQUARE".into()).into());
                    o.insert(
                        "strokeWidth".to_owned(),
                        profile::stroke_width(m.stroke_width.as_deref().unwrap_or("THIN")).into(),
                    );
                    put(&mut o, "stroke", m.stroke.clone());
                }
                put(&mut o, "fill", m.fill.clone());
                put(&mut o, "color", m.color.clone());
                o.insert("opacity".to_owned(), m.opacity.into());
                text_fields(&mut o, measured, &m.text);
            }
        }
        out.push(Json::Object(o));
    }
    out
}

fn collect_ids(region: &Region, out: &mut Vec<String>) {
    for child in &region.children {
        out.push(child.id().to_owned());
        if let Some(inner) = child.region() {
            collect_ids(inner, out);
        }
    }
}

fn connector(c: &Connector, r: &Route, sizes: &Sizes) -> Json {
    let mut o = Map::new();
    o.insert("type".to_owned(), "connector".into());
    o.insert("id".to_owned(), c.id.clone().into());
    o.insert("from".to_owned(), c.from.clone().into());
    o.insert("to".to_owned(), c.to.clone().into());
    o.insert("lineType".to_owned(), "straight".into());
    o.insert("fromSide".to_owned(), r.from_side.name().into());
    o.insert("toSide".to_owned(), r.to_side.name().into());
    o.insert(
        "waypoints".to_owned(),
        r.waypoints.iter().map(|p| json!({ "x": p.x, "y": p.y })).collect::<Vec<_>>().into(),
    );
    o.insert("fromCap".to_owned(), c.from_cap.clone().into());
    o.insert("toCap".to_owned(), c.to_cap.clone().into());
    if c.line_style == "DASHED" {
        o.insert("lineStyle".to_owned(), "dashed".into());
    }
    put(&mut o, "stroke", c.stroke.clone());
    o.insert("strokeWidth".to_owned(), profile::stroke_width(&c.stroke_width).into());
    o.insert("opacity".to_owned(), c.opacity.into());
    o.insert("fontSize".to_owned(), profile::font_size(&c.font_size).into());
    if let Some(label) = c.label.as_ref().filter(|l| !l.is_empty()) {
        o.insert("label".to_owned(), label.clone().into());
        if let Some(m) = sizes.labels.get(&c.id) {
            o.insert("labelLines".to_owned(), serde_json::to_value(&m.lines).expect("lines serialize"));
        }
    }
    o.insert("route".to_owned(), r.points.iter().map(|p| json!({ "x": p.x, "y": p.y })).collect::<Vec<_>>().into());
    o.insert("labelLeg".to_owned(), r.label_leg.into());
    if let Some(b) = &r.label_box {
        o.insert("labelBox".to_owned(), frame(b));
    }
    o.insert("routeKind".to_owned(), r.kind.into());
    Json::Object(o)
}

/// Moves everything on a page by whole pixels so nothing — no mark, title band, route or label —
/// lies left of or above the page's origin, and sizes the page to hold it all.
fn normalize(page: &mut Map<String, Json>) {
    let mut lo = (0.0f64, 0.0f64);
    let mut hi = (num(page, "width"), num(page, "height"));
    let mut see = |x: f64, y: f64, w: f64, h: f64| {
        lo = (lo.0.min(x), lo.1.min(y));
        hi = (hi.0.max(x + w), hi.1.max(y + h));
    };
    fn walk(list: &Json, see: &mut dyn FnMut(f64, f64, f64, f64)) {
        for n in list.as_array().into_iter().flatten() {
            let f = |k: &str| n.get(k).and_then(Json::as_f64).unwrap_or(0.0);
            if n["type"] == "connector" {
                let pad = f("strokeWidth") / 2.0 + (5.0 * f("strokeWidth")).max(16.0);
                for p in n["route"].as_array().into_iter().flatten() {
                    let (x, y) = (p["x"].as_f64().unwrap_or(0.0), p["y"].as_f64().unwrap_or(0.0));
                    see(x - pad, y - pad, 2.0 * pad, 2.0 * pad);
                }
                if let Some(b) = n.get("labelBox") {
                    see(
                        b["x"].as_f64().unwrap_or(0.0),
                        b["y"].as_f64().unwrap_or(0.0),
                        b["w"].as_f64().unwrap_or(0.0),
                        b["h"].as_f64().unwrap_or(0.0),
                    );
                }
                continue;
            }
            see(f("x"), f("y"), f("width"), f("height"));
            if let Some(t) = n.get("titleFrame") {
                see(
                    t["x"].as_f64().unwrap_or(0.0),
                    t["y"].as_f64().unwrap_or(0.0),
                    t["w"].as_f64().unwrap_or(0.0),
                    t["h"].as_f64().unwrap_or(0.0),
                );
            }
            if n["type"] == "section" {
                walk(&n["nodes"], see);
            }
        }
    }
    walk(&page["nodes"], &mut see);
    let (dx, dy) = ((-lo.0).max(0.0).ceil(), (-lo.1).max(0.0).ceil());
    page.insert("width".to_owned(), (hi.0 + dx).ceil().into());
    page.insert("height".to_owned(), (hi.1 + dy).ceil().into());
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    fn shift_point(p: &mut Json, dx: f64, dy: f64, (kx, ky): (&str, &str)) {
        if let Some(x) = p.get(kx).and_then(Json::as_f64) {
            p[kx] = (x + dx).into();
        }
        if let Some(y) = p.get(ky).and_then(Json::as_f64) {
            p[ky] = (y + dy).into();
        }
    }
    fn shift(list: &mut Json, dx: f64, dy: f64) {
        for n in list.as_array_mut().into_iter().flatten() {
            if n["type"] == "connector" {
                for key in ["route", "waypoints"] {
                    for p in n[key].as_array_mut().into_iter().flatten() {
                        shift_point(p, dx, dy, ("x", "y"));
                    }
                }
                if let Some(b) = n.get_mut("labelBox") {
                    shift_point(b, dx, dy, ("x", "y"));
                }
                continue;
            }
            shift_point(n, dx, dy, ("x", "y"));
            if let Some(t) = n.get_mut("titleFrame") {
                shift_point(t, dx, dy, ("x", "y"));
            }
            if n["type"] == "section" {
                shift(&mut n["nodes"], dx, dy);
            }
        }
    }
    shift(page.get_mut("nodes").expect("nodes"), dx, dy);
    for g in page.get_mut("groups").and_then(Json::as_array_mut).into_iter().flatten() {
        shift_point(&mut g["frame"], dx, dy, ("x", "y"));
    }
}

fn num(o: &Map<String, Json>, k: &str) -> f64 {
    o.get(k).and_then(Json::as_f64).unwrap_or(0.0)
}

/// The positioned board, without its report (the validator adds it).
pub fn lower(
    board: &Board,
    sizes: &Sizes,
    layouts: &[PageLayout],
    routes: &[std::collections::HashMap<String, Route>],
) -> Json {
    let mut pages = Vec::new();
    for ((page, layout), routes) in board.pages.iter().zip(layouts).zip(routes) {
        let mut groups = Vec::new();
        let mut list = nodes(&page.region, layout, sizes, &mut groups);
        for c in &page.connectors {
            if let Some(r) = routes.get(&c.id) {
                list.push(connector(c, r, sizes));
            }
        }
        let mut o = Map::new();
        o.insert("id".to_owned(), page.id.clone().into());
        o.insert("name".to_owned(), page.name.clone().into());
        put(&mut o, "background", page.background.clone());
        o.insert("width".to_owned(), layout.width.into());
        o.insert("height".to_owned(), layout.height.into());
        o.insert("nodes".to_owned(), list.into());
        o.insert("groups".to_owned(), groups.into());
        normalize(&mut o);
        pages.push(Json::Object(o));
    }
    let mut o = Map::new();
    o.insert("type".to_owned(), "board".into());
    o.insert("positioned".to_owned(), 1.into());
    o.insert("profile".to_owned(), board.profile.clone().into());
    o.insert(
        "revision".to_owned(),
        json!({ "compiler": env!("CARGO_PKG_VERSION"), "font": profile::FONT_REVISION, "layout": profile::NAME }),
    );
    put(&mut o, "title", board.title.clone());
    o.insert("showPageTabs".to_owned(), board.show_page_tabs.into());
    o.insert("showPageMenu".to_owned(), board.show_page_menu.into());
    put(&mut o, "fileKey", board.file_key.clone());
    o.insert("pages".to_owned(), pages.into());
    Json::Object(o)
}
