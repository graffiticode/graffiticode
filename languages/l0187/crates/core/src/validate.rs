// SPDX-License-Identifier: MIT

//! Independent validation of a positioned board (design §8): the semantic board says what must be
//! preserved; the candidate (the lowered board) is the geometry. Nothing here calls the layout or
//! the router: every box, line, magnet, label position and clearance is recomputed from the
//! candidate and the profile, so a backend mistake cannot pass by agreeing with itself.
//!
//! Checks, in order (each `modeled` unless it says otherwise):
//!
//! - **preservation**: every page, section, group, mark and connector appears exactly once with
//!   its text, kind, font size, style and endpoints; nothing extra; pages in order; each mark in
//!   its section; each group's members inside its bounds.
//! - **geometry**: finite numbers, positive sizes, whole pixels.
//! - **text-fit**: each text's lines re-join to its text exactly, every line's re-measured advance
//!   fits its content box, the lines fit its height, the content box is the one its kind and
//!   size give, a sticky is FigJam's width and grown height.
//! - **peer-clearance**: siblings in every region keep the gutter on at least one axis.
//! - **containment**: children inside their section's padding (its title band above it) and
//!   their group's bounds.
//! - **order**: ROW, COLUMN and GRID sequences; every `before` disjoint along its flow, with
//!   clearance.
//! - **routes**: each route starts and ends at its marks' side magnets, its waypoints are its
//!   interior points, its legs keep their band clear of every mark (their own end marks only
//!   where they attach), and its caps clear other marks.
//! - **labels**: each label box is where the plugin's rule puts it (the middle leg's midpoint
//!   after corner rounding), sized from its re-measured text, and clear of every mark, every
//!   other label and every other connector.
//! - **native-text-fit**, **native-labels** (`native-unverified`): FigJam's own text layout in
//!   shapes and its label placement cannot be observed from here; never reported as passed.
//!
//! A required check that fails blocks acceptance. Crossings between connectors are quality, not
//! validity.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value as Json;

use crate::ir::{Board, Child, Layout, Region};
use crate::layout::Frame;
use crate::measure::{advance, content_box, rejoin, wrap};
use crate::profile::{self, line_height, section, spacing};
use crate::route::{self, P, Side, band, crosses, overlaps};
use crate::size::sticky_height;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Pass,
    Fail,
    Unverified,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub scope: &'static str,
    pub required: bool,
    pub status: Status,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Quality {
    pub crossings: usize,
    pub bends: usize,
    pub route_length: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Report {
    pub accepted: bool,
    pub checks: Vec<Check>,
    pub quality: Quality,
}

impl Report {
    pub fn failures(&self) -> Vec<String> {
        self.checks
            .iter()
            .filter(|c| c.required && c.status == Status::Fail)
            .flat_map(|c| c.failures.iter().map(move |f| format!("{}: {f}", c.name)))
            .collect()
    }
}

fn num(v: &Json, k: &str) -> f64 {
    v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN)
}

fn frame_of(v: &Json) -> Frame {
    Frame { x: num(v, "x"), y: num(v, "y"), w: num(v, "width"), h: num(v, "height") }
}

fn rect_of(v: &Json) -> Frame {
    Frame { x: num(v, "x"), y: num(v, "y"), w: num(v, "w"), h: num(v, "h") }
}

fn point_of(v: &Json) -> P {
    P { x: num(v, "x"), y: num(v, "y") }
}

fn gap(a: &Frame, b: &Frame) -> f64 {
    let dx = (b.x - (a.x + a.w)).max(a.x - (b.x + b.w));
    let dy = (b.y - (a.y + a.h)).max(a.y - (b.y + b.h));
    dx.max(dy)
}

fn inside(inner: &Frame, outer: &Frame) -> bool {
    inner.x >= outer.x - 1e-6
        && inner.y >= outer.y - 1e-6
        && inner.x + inner.w <= outer.x + outer.w + 1e-6
        && inner.y + inner.h <= outer.y + outer.h + 1e-6
}

/// What the candidate holds on one page.
struct PageView<'a> {
    /// Every node by id, with the section it sits in.
    nodes: HashMap<String, (&'a Json, Option<String>)>,
    connectors: Vec<&'a Json>,
    groups: HashMap<String, (Frame, Vec<String>)>,
    duplicates: Vec<String>,
}

fn view(page: &Json) -> PageView<'_> {
    let mut v =
        PageView { nodes: HashMap::new(), connectors: Vec::new(), groups: HashMap::new(), duplicates: Vec::new() };
    fn walk<'a>(list: &'a Json, section: Option<String>, v: &mut PageView<'a>) {
        for n in list.as_array().into_iter().flatten() {
            if n["type"] == "connector" {
                v.connectors.push(n);
                continue;
            }
            let id = n["id"].as_str().unwrap_or_default().to_owned();
            if v.nodes.insert(id.clone(), (n, section.clone())).is_some() {
                v.duplicates.push(id.clone());
            }
            if n["type"] == "section" {
                walk(&n["nodes"], Some(id), v);
            }
        }
    }
    walk(&page["nodes"], None, &mut v);
    for g in page["groups"].as_array().into_iter().flatten() {
        let members =
            g["members"].as_array().into_iter().flatten().filter_map(Json::as_str).map(str::to_owned).collect();
        v.groups.insert(g["id"].as_str().unwrap_or_default().to_owned(), (rect_of(&g["frame"]), members));
    }
    v
}

struct Checks {
    list: Vec<Check>,
}

impl Checks {
    fn add(&mut self, name: &'static str, failures: Vec<String>) {
        let status = if failures.is_empty() { Status::Pass } else { Status::Fail };
        self.list.push(Check { name, scope: "modeled", required: true, status, failures });
    }

    fn unverified(&mut self, name: &'static str, why: &str) {
        self.list.push(Check {
            name,
            scope: "native-unverified",
            required: false,
            status: Status::Unverified,
            failures: vec![why.to_owned()],
        });
    }
}

/// The frame a child occupies in its region: its box, a section's title band included, a
/// group's bounds.
fn region_bounds(child: &Child, v: &PageView) -> Option<Frame> {
    match child {
        Child::Group(g) => v.groups.get(&g.id).map(|(f, _)| *f),
        Child::Section(s) => v.nodes.get(&s.id).map(|(n, _)| {
            let f = frame_of(n);
            let top = section::TITLE_BAND + section::TITLE_GAP;
            Frame { y: f.y - top, h: f.h + top, ..f }
        }),
        _ => v.nodes.get(child.id()).map(|(n, _)| frame_of(n)),
    }
}

fn check_regions(
    region: &Region,
    area: Option<Frame>,
    v: &PageView,
    peers: &mut Vec<String>,
    contained: &mut Vec<String>,
    order: &mut Vec<String>,
) {
    let rects: Vec<Option<Frame>> = region.children.iter().map(|c| region_bounds(c, v)).collect();
    for (i, c) in region.children.iter().enumerate() {
        let Some(r) = rects[i] else { continue };
        if let Some(a) = area
            && !inside(&r, &a)
        {
            contained.push(format!("{} {:?} lies outside its container", c.word(), c.id()));
        }
        for (j, d) in region.children.iter().enumerate().skip(i + 1) {
            if let Some(q) = rects[j]
                && gap(&r, &q) < spacing::GUTTER - 1e-6
            {
                peers.push(format!(
                    "{:?} and {:?} are {} apart; the gutter is {}",
                    c.id(),
                    d.id(),
                    gap(&r, &q),
                    spacing::GUTTER
                ));
            }
        }
    }
    let at = |i: usize| rects[i];
    match region.layout {
        Layout::Row | Layout::Column => {
            for i in 1..region.children.len() {
                if let (Some(a), Some(b)) = (at(i - 1), at(i)) {
                    let ok = if region.layout == Layout::Row { b.x >= a.x + a.w } else { b.y >= a.y + a.h };
                    if !ok {
                        order.push(format!(
                            "{:?} does not follow {:?}",
                            region.children[i].id(),
                            region.children[i - 1].id()
                        ));
                    }
                }
            }
        }
        Layout::Grid { columns } => {
            let c = columns as usize;
            for i in 0..region.children.len() {
                for j in i + 1..region.children.len() {
                    if let (Some(a), Some(b)) = (at(i), at(j)) {
                        let ok = if i / c == j / c { b.x >= a.x + a.w } else { b.y >= a.y + a.h };
                        if !ok {
                            order.push(format!(
                                "grid cell {:?} is out of order with {:?}",
                                region.children[j].id(),
                                region.children[i].id()
                            ));
                        }
                    }
                }
            }
        }
        Layout::Flow { direction } => {
            for (i, c) in region.children.iter().enumerate() {
                for target in c.before() {
                    let Some(j) = region.children.iter().position(|d| d.id() == target) else { continue };
                    if let (Some(a), Some(b)) = (at(i), at(j)) {
                        let clearance = match direction {
                            crate::ir::Direction::Right => b.x - (a.x + a.w),
                            crate::ir::Direction::Left => a.x - (b.x + b.w),
                            crate::ir::Direction::Down => b.y - (a.y + a.h),
                            crate::ir::Direction::Up => a.y - (b.y + b.h),
                        };
                        if clearance < spacing::GUTTER - 1e-6 {
                            order.push(format!(
                                "{:?} before {target:?} has clearance {clearance} along the flow",
                                c.id()
                            ));
                        }
                    }
                }
            }
        }
        Layout::Auto => {}
    }
    for c in &region.children {
        let inner_area = match c {
            Child::Section(s) => v.nodes.get(&s.id).map(|(n, _)| {
                let f = frame_of(n);
                let p = section::PADDING;
                Frame { x: f.x + p, y: f.y + p, w: f.w - 2.0 * p, h: f.h - 2.0 * p }
            }),
            Child::Group(g) => v.groups.get(&g.id).map(|(f, _)| *f),
            _ => None,
        };
        if let Some(inner) = c.region() {
            check_regions(inner, inner_area, v, peers, contained, order);
        }
    }
}

/// The section each mark belongs to in the semantic board (through groups), and every id.
fn membership(
    region: &Region,
    section: Option<&str>,
    out: &mut HashMap<String, Option<String>>,
    kinds: &mut HashMap<String, &'static str>,
) {
    for c in &region.children {
        kinds.insert(c.id().to_owned(), c.word());
        match c {
            Child::Section(s) => {
                out.insert(s.id.clone(), section.map(str::to_owned));
                membership(&s.region, Some(&s.id), out, kinds);
            }
            Child::Group(g) => membership(&g.region, section, out, kinds),
            _ => {
                out.insert(c.id().to_owned(), section.map(str::to_owned));
            }
        }
    }
}

fn group_members(region: &Region, out: &mut Vec<(String, Vec<String>)>) {
    for c in &region.children {
        if let Child::Group(g) = c {
            let mut ids = Vec::new();
            fn all(r: &Region, ids: &mut Vec<String>) {
                for c in &r.children {
                    ids.push(c.id().to_owned());
                    if let Some(inner) = c.region() {
                        all(inner, ids);
                    }
                }
            }
            all(&g.region, &mut ids);
            out.push((g.id.clone(), ids));
        }
        if let Some(inner) = c.region() {
            group_members(inner, out);
        }
    }
}

fn label_size(text: &str, size: f64, stroke: f64) -> (f64, f64) {
    let lines = wrap(text, size, None);
    let w = lines.iter().map(|l| advance(&l.text, size)).fold(0.0, f64::max).ceil();
    let h = (lines.len() as f64 * size * profile::label::LINE_HEIGHT).ceil();
    let (px, py) = profile::label::pad(size, stroke);
    (w + 2.0 * px, h + 2.0 * py)
}

/// A connector already checked: its id, its legs' bands, its legs, its label box, its points and
/// its two ends.
type Placed = (String, Vec<Frame>, Vec<(P, P)>, Option<Frame>, Vec<P>, (String, Side), (String, Side));

fn segments_cross(a: P, b: P, c: P, d: P) -> bool {
    let orient = |p: P, q: P, r: P| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    o1 * o2 < 0.0 && o3 * o4 < 0.0
}

/// Validates `candidate` against the semantic `board`.
pub fn validate(board: &Board, candidate: &Json) -> Report {
    let mut checks = Checks { list: Vec::new() };
    let mut preservation = Vec::new();
    let mut geometry = Vec::new();
    let mut text = Vec::new();
    let mut peers = Vec::new();
    let mut contained = Vec::new();
    let mut order = Vec::new();
    let mut routes = Vec::new();
    let mut labels = Vec::new();
    let mut quality = Quality { crossings: 0, bends: 0, route_length: 0.0 };
    let pages = candidate["pages"].as_array().cloned().unwrap_or_default();
    if pages.len() != board.pages.len() {
        preservation.push(format!("the board has {} pages; the candidate has {}", board.pages.len(), pages.len()));
    }
    for (page, json) in board.pages.iter().zip(&pages) {
        if json["id"] != page.id.as_str() || json["name"] != page.name.as_str() {
            preservation.push(format!("page {:?} is missing or out of order", page.id));
        }
        let v = view(json);
        for id in &v.duplicates {
            preservation.push(format!("{id:?} appears more than once"));
        }
        // Preservation.
        let mut sections_of = HashMap::new();
        let mut kinds = HashMap::new();
        membership(&page.region, None, &mut sections_of, &mut kinds);
        let mut expected: HashSet<String> = HashSet::new();
        let mut marks: Vec<(String, Frame)> = Vec::new();
        crate::ir::walk(&page.region, &mut |child, _| {
            if matches!(child, Child::Group(_)) {
                return;
            }
            expected.insert(child.id().to_owned());
            let Some((n, section)) = v.nodes.get(child.id()) else {
                preservation.push(format!("{} {:?} is missing", child.word(), child.id()));
                return;
            };
            if *section != sections_of.get(child.id()).cloned().flatten() {
                preservation.push(format!("{} {:?} is not in its section", child.word(), child.id()));
            }
            match child {
                Child::Section(s) => {
                    if n["type"] != "section" || n["name"] != s.name.as_str() {
                        preservation.push(format!("section {:?} changed", s.id));
                    }
                }
                Child::Sticky(m) | Child::Shape(m) | Child::Textbox(m) => {
                    let ty = match child {
                        Child::Sticky(_) => "sticky",
                        Child::Shape(_) => "shape",
                        _ => "text",
                    };
                    let same = n["type"] == ty
                        && n["text"] == m.text.as_str()
                        && num(n, "fontSize") == profile::font_size(&m.font_size)
                        && num(n, "opacity") == m.opacity
                        && n.get("fill").and_then(Json::as_str) == m.fill.as_deref()
                        && n.get("color").and_then(Json::as_str) == m.color.as_deref()
                        && (ty != "shape"
                            || (n["shapeType"].as_str() == m.kind.as_deref()
                                && n.get("stroke").and_then(Json::as_str) == m.stroke.as_deref()));
                    if !same {
                        preservation.push(format!("{} {:?} changed", child.word(), m.id));
                    }
                    marks.push((m.id.clone(), frame_of(n)));
                }
                Child::Group(_) => {}
            }
        });
        for id in v.nodes.keys() {
            if !expected.contains(id) {
                preservation.push(format!("{id:?} is not in the program"));
            }
        }
        let mut groups = Vec::new();
        group_members(&page.region, &mut groups);
        for (gid, members) in &groups {
            match v.groups.get(gid) {
                None => preservation.push(format!("group {gid:?} is missing")),
                Some((f, listed)) => {
                    if listed != members {
                        preservation.push(format!("group {gid:?} lists other members"));
                    }
                    for m in members {
                        let mf = v.nodes.get(m).map(|(n, _)| frame_of(n)).or_else(|| v.groups.get(m).map(|(g, _)| *g));
                        if let Some(mf) = mf
                            && !inside(&mf, f)
                        {
                            preservation.push(format!("{m:?} lies outside its group {gid:?}"));
                        }
                    }
                }
            }
        }
        let by_id: HashMap<&str, &Json> =
            v.connectors.iter().map(|c| (c["id"].as_str().unwrap_or_default(), *c)).collect();
        for c in &page.connectors {
            match by_id.get(c.id.as_str()) {
                None => preservation.push(format!("connector {:?} is missing", c.id)),
                Some(j) => {
                    let label = j.get("label").and_then(Json::as_str).unwrap_or("");
                    let same = j["from"] == c.from.as_str()
                        && j["to"] == c.to.as_str()
                        && label == c.label.as_deref().unwrap_or("")
                        && j["fromCap"] == c.from_cap.as_str()
                        && j["toCap"] == c.to_cap.as_str()
                        && (j.get("lineStyle").is_some() == (c.line_style == "DASHED"));
                    if !same {
                        preservation.push(format!("connector {:?} changed", c.id));
                    }
                }
            }
        }
        if v.connectors.len() != page.connectors.len() {
            preservation.push(format!(
                "page {:?} has {} connectors; the program has {}",
                page.id,
                v.connectors.len(),
                page.connectors.len()
            ));
        }
        // Geometry and text.
        for (id, (n, _)) in &v.nodes {
            let f = frame_of(n);
            if ![f.x, f.y, f.w, f.h].iter().all(|x| x.is_finite()) || f.w <= 0.0 || f.h <= 0.0 {
                geometry.push(format!("{id:?} has an invalid box {f:?}"));
            } else if [f.x, f.y, f.w, f.h].iter().any(|x| x.fract() != 0.0) {
                geometry.push(format!("{id:?} is not on whole pixels: {f:?}"));
            }
            let ty = n["type"].as_str().unwrap_or_default();
            if ty == "section" {
                if let Some(t) = n.get("titleFrame").map(rect_of)
                    && (t.y + t.h > f.y + 1e-6 || t.x < f.x - 1e-6 || t.x + t.w > f.x + f.w + 1e-6)
                {
                    contained.push(format!("section {id:?}: its title band is not above its border"));
                }
                continue;
            }
            let fs = num(n, "fontSize");
            let source = n["text"].as_str().unwrap_or_default();
            let lines: Vec<crate::measure::Line> = serde_json::from_value(n["lines"].clone()).unwrap_or_default();
            if rejoin(&lines) != source {
                text.push(format!(
                    "{id:?}: its lines {:?} do not re-join to its text",
                    lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
                ));
            }
            let (expected_box, per_line) = match ty {
                "sticky" => {
                    let (px, py) = (profile::sticky::PAD_X, profile::sticky::PAD_Y);
                    if f.w != profile::sticky::SIZE && f.w != profile::sticky::WIDE {
                        text.push(format!(
                            "{id:?}: a sticky is {} or {} wide, not {}",
                            profile::sticky::SIZE,
                            profile::sticky::WIDE,
                            f.w
                        ));
                    }
                    if f.h != sticky_height(lines.len(), fs) {
                        text.push(format!(
                            "{id:?}: a sticky with {} lines at {fs}px is {} high, not {}",
                            lines.len(),
                            sticky_height(lines.len(), fs),
                            f.h
                        ));
                    }
                    (Frame { x: px, y: py, w: f.w - 2.0 * px, h: f.h - 2.0 * py }, fs * line_height::NOTE)
                }
                "shape" => {
                    let r = content_box(n["shapeType"].as_str().unwrap_or("SQUARE"), f.w, f.h);
                    (Frame { x: r.x, y: r.y, w: r.w, h: r.h }, fs * line_height::NOTE)
                }
                _ => (Frame { x: 0.0, y: 0.0, w: f.w, h: f.h }, profile::text_line(fs)),
            };
            let given = rect_of(&n["content"]);
            if (given.x - expected_box.x).abs() > 1e-6
                || (given.y - expected_box.y).abs() > 1e-6
                || (given.w - expected_box.w).abs() > 1e-6
                || (given.h - expected_box.h).abs() > 1e-6
            {
                text.push(format!(
                    "{id:?}: its content box {given:?} is not the one its kind and size give, {expected_box:?}"
                ));
            }
            for l in &lines {
                let w = advance(&l.text, fs);
                if w > expected_box.w + 1e-6 {
                    text.push(format!(
                        "{id:?}: the line {:?} is {w:.2} wide; its content box is {}",
                        l.text, expected_box.w
                    ));
                }
            }
            if lines.len() as f64 * per_line > expected_box.h + 1e-6 {
                text.push(format!(
                    "{id:?}: {} lines need {}; its content box is {} high",
                    lines.len(),
                    lines.len() as f64 * per_line,
                    expected_box.h
                ));
            }
        }
        check_regions(&page.region, None, &v, &mut peers, &mut contained, &mut order);
        // Routes and labels.
        let mut placed: Vec<Placed> = Vec::new();
        for c in &page.connectors {
            let Some(j) = by_id.get(c.id.as_str()) else { continue };
            let (Some(from), Some(to)) = (
                marks.iter().find(|(id, _)| *id == c.from).map(|m| m.1),
                marks.iter().find(|(id, _)| *id == c.to).map(|m| m.1),
            ) else {
                routes.push(format!("connector {:?}: an endpoint is missing", c.id));
                continue;
            };
            let points: Vec<P> = j["route"].as_array().into_iter().flatten().map(point_of).collect();
            let waypoints: Vec<P> = j["waypoints"].as_array().into_iter().flatten().map(point_of).collect();
            let (Some(fs), Some(ts)) =
                (j["fromSide"].as_str().and_then(Side::parse), j["toSide"].as_str().and_then(Side::parse))
            else {
                routes.push(format!("connector {:?}: no sides", c.id));
                continue;
            };
            if points.len() < 2
                || points[0] != route::anchor(&from, fs)
                || *points.last().expect("two") != route::anchor(&to, ts)
            {
                routes.push(format!(
                    "connector {:?}: its route does not start and end at its marks' {} and {} magnets",
                    c.id,
                    fs.name(),
                    ts.name()
                ));
                continue;
            }
            if points[1..points.len() - 1] != waypoints[..] {
                routes.push(format!("connector {:?}: its waypoints are not its route's interior points", c.id));
            }
            let stroke = num(j, "strokeWidth");
            let legs = points.len() - 1;
            quality.bends += legs - 1;
            quality.route_length +=
                points.windows(2).map(|s| (s[1].x - s[0].x).abs() + (s[1].y - s[0].y).abs()).sum::<f64>();
            let bands: Vec<Frame> = points.windows(2).map(|s| band(s[0], s[1], stroke)).collect();
            for (i, seg) in points.windows(2).enumerate() {
                for (id, m) in &marks {
                    let attach = (*id == c.from && i == 0) || (*id == c.to && i == legs - 1);
                    if attach {
                        if crosses(seg[0], seg[1], m) {
                            routes.push(format!("connector {:?}: leg {i} runs through its own end {id:?}", c.id));
                        }
                    } else if overlaps(&bands[i], m) {
                        routes.push(format!(
                            "connector {:?}: leg {i} runs within {} of {id:?}",
                            c.id,
                            route::CLEARANCE
                        ));
                    }
                }
            }
            for (end, at, owner, cap) in
                [(points[0], points[1], &c.from, &c.from_cap), (points[legs], points[legs - 1], &c.to, &c.to_cap)]
            {
                let Some(b) = route::cap_box(end, at, stroke, cap) else { continue };
                for (id, m) in &marks {
                    if id != owner && overlaps(&b, m) {
                        routes.push(format!("connector {:?}: its cap at {owner:?} reaches {id:?}", c.id));
                    }
                }
            }
            let label_box = match c.label.as_deref().filter(|l| !l.is_empty()) {
                Some(label) => {
                    let size = label_size(label, profile::font_size(&c.font_size), stroke);
                    let (leg, expect) = route::label_box(&points, &from, &to, Some(size));
                    let expect = expect.expect("a label box");
                    let given = j.get("labelBox").map(rect_of);
                    if j["labelLeg"].as_u64() != Some(leg as u64)
                        || given.is_none_or(|g| {
                            (g.x - expect.x).abs() > 1e-6
                                || (g.y - expect.y).abs() > 1e-6
                                || (g.w - expect.w).abs() > 1e-6
                                || (g.h - expect.h).abs() > 1e-6
                        })
                    {
                        labels.push(format!(
                            "connector {:?}: its label is not where the plugin writes it (leg {leg}, {expect:?})",
                            c.id
                        ));
                    }
                    let grown = Frame {
                        x: expect.x - route::CLEARANCE,
                        y: expect.y - route::CLEARANCE,
                        w: expect.w + 2.0 * route::CLEARANCE,
                        h: expect.h + 2.0 * route::CLEARANCE,
                    };
                    for (id, m) in &marks {
                        if overlaps(&grown, m) {
                            labels.push(format!(
                                "connector {:?}: its label is within {} of {id:?}",
                                c.id,
                                route::CLEARANCE
                            ));
                        }
                    }
                    Some((expect, grown))
                }
                None => None,
            };
            for (other, other_bands, other_segments, other_label, other_points, of, ot) in &placed {
                if let Some(why) = route::clash(
                    (&points, (c.from.as_str(), fs), (c.to.as_str(), ts)),
                    (other_points, (of.0.as_str(), of.1), (ot.0.as_str(), ot.1)),
                ) {
                    routes.push(format!("connector {:?} {why} ({other:?})", c.id));
                }
                if let Some((_, grown)) = &label_box {
                    if other_bands.iter().any(|b| overlaps(grown, b)) {
                        labels.push(format!("connector {:?}: its label touches connector {other:?}", c.id));
                    }
                    if other_label.is_some_and(|o| overlaps(grown, &o)) {
                        labels.push(format!("connector {:?}: its label touches the label of {other:?}", c.id));
                    }
                }
                if let Some(o) = other_label
                    && bands.iter().any(|b| overlaps(b, o))
                {
                    labels.push(format!("connector {:?} runs through the label of {other:?}", c.id));
                }
                for s in points.windows(2) {
                    for &(p, q) in other_segments {
                        if segments_cross(s[0], s[1], p, q) {
                            quality.crossings += 1;
                        }
                    }
                }
            }
            let segments = points.windows(2).map(|s| (s[0], s[1])).collect();
            placed.push((
                c.id.clone(),
                bands,
                segments,
                label_box.map(|(b, _)| b),
                points.clone(),
                (c.from.clone(), fs),
                (c.to.clone(), ts),
            ));
        }
    }
    checks.add("preservation", preservation);
    checks.add("geometry", geometry);
    checks.add("text-fit", text);
    checks.add("peer-clearance", peers);
    checks.add("containment", contained);
    checks.add("order", order);
    checks.add("routes", routes);
    checks.add("labels", labels);
    checks.unverified(
        "native-text-fit",
        "FigJam lays out the text in shapes itself; the model's text areas are calibrated bounds, not observations",
    );
    checks.unverified(
        "native-labels",
        "FigJam places a connector's label on its leg itself; the plugin's rule is modeled, not observed",
    );
    let accepted = checks.list.iter().all(|c| !c.required || c.status == Status::Pass);
    Report { accepted, checks: checks.list, quality }
}
