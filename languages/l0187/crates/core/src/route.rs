// SPDX-License-Identifier: MIT

//! Connector routing under `FIGJAM_V1` (design §5, §8).
//!
//! Every connector is drawn as **straight legs between fixed points**: it leaves its start mark
//! at a side's midpoint (a FigJam magnet), runs through compiler-placed waypoints, and enters its
//! end mark at a side's midpoint. The plugin draws each leg as its own straight FigJam connector,
//! so the route modeled here is the route FigJam draws: nothing is left to FigJam's own router.
//! The plugin rounds each turn with a corner of at most 16px ([`corner`], its `cornerAt`) and
//! writes the label on leg `floor((legs - 1) / 2)` at that leg's midpoint, so the modeled label
//! box is derived from the same rule and never placed freely.
//!
//! Candidates are tried in a fixed order, the first that keeps clear of every mark, every label
//! and every connector already placed is kept:
//!
//! 1. a straight line between facing sides, when the marks are level;
//! 2. an elbow (Z or L) through the middle of the gap between them;
//! 3. a lane in the routing channel the flow reserved, for a connector that runs against the flow
//!    or skips a layer;
//! 4. an arc over or under both marks (also how parallel connectors are separated);
//! 5. an orthogonal search over the free space around the marks.
//!
//! A self-loop leaves one side and returns on the next, around a corner of its mark. When no
//! candidate fits, the connector is reported with the region whose spacing the repair loop
//! should widen. Work is counted, never timed.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap};

use serde::Serialize;

use crate::ir::{Board, Child, Connector, Page, Region};
use crate::layout::{Frame, PageLayout};
use crate::profile::{self, spacing};
use crate::size::Sizes;

/// A point on the page.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct P {
    pub x: f64,
    pub y: f64,
}

/// A side of a mark, where a connector attaches at its midpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    pub const ALL: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

    /// The outward direction of the side.
    pub fn dir(self) -> P {
        match self {
            Side::Top => P { x: 0.0, y: -1.0 },
            Side::Right => P { x: 1.0, y: 0.0 },
            Side::Bottom => P { x: 0.0, y: 1.0 },
            Side::Left => P { x: -1.0, y: 0.0 },
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Side::Top => "TOP",
            Side::Right => "RIGHT",
            Side::Bottom => "BOTTOM",
            Side::Left => "LEFT",
        }
    }

    pub fn parse(name: &str) -> Option<Side> {
        Side::ALL.into_iter().find(|s| s.name() == name)
    }
}

/// The midpoint of a side of a frame: the FigJam magnet.
pub fn anchor(f: &Frame, side: Side) -> P {
    let (cx, cy) = (f.x + f.w / 2.0, f.y + f.h / 2.0);
    match side {
        Side::Top => P { x: cx, y: f.y },
        Side::Right => P { x: f.x + f.w, y: cy },
        Side::Bottom => P { x: cx, y: f.y + f.h },
        Side::Left => P { x: f.x, y: cy },
    }
}

pub fn centre(f: &Frame) -> P {
    P { x: f.x + f.w / 2.0, y: f.y + f.h / 2.0 }
}

/// A routed connector.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Route {
    pub from_side: Side,
    pub to_side: Side,
    /// The points between the two magnets.
    pub waypoints: Vec<P>,
    /// The modeled polyline: start magnet, waypoints, end magnet.
    pub points: Vec<P>,
    /// The leg the label is written on, and its box.
    pub label_leg: usize,
    pub label_box: Option<Frame>,
    /// Which candidate it is.
    pub kind: &'static str,
}

/// The rounded turn the plugin draws at a waypoint, as its `cornerAt` computes it: the leg into
/// waypoint `k` of `stops` stops `r` short of it and the leg out starts `r` past it, with
/// `r = min(16, runIn / 4, runOut / 4)` measured to the neighbouring waypoint or end mark's
/// centre; no corner under 1px, or where the legs run straight on or double back.
fn corner(stops: &[P], anchors: &[P], k: usize) -> Option<(P, P)> {
    const RADIUS: f64 = 16.0;
    let w = stops[k];
    let unit = |v: P| {
        let l = v.x.hypot(v.y);
        if l == 0.0 { P { x: 0.0, y: 0.0 } } else { P { x: v.x / l, y: v.y / l } }
    };
    let din = unit(P { x: w.x - stops[k - 1].x, y: w.y - stops[k - 1].y });
    let dout = unit(P { x: stops[k + 1].x - w.x, y: stops[k + 1].y - w.y });
    if (din.x * dout.y - din.y * dout.x).abs() < 1e-6 {
        return None;
    }
    let (prev, next) = (anchors[k - 1], anchors[k + 1]);
    let run_in = ((w.x - prev.x) * din.x + (w.y - prev.y) * din.y).abs();
    let run_out = ((next.x - w.x) * dout.x + (next.y - w.y) * dout.y).abs();
    let r = RADIUS.min(run_in / 4.0).min(run_out / 4.0);
    if r < 1.0 {
        return None;
    }
    Some((P { x: w.x - din.x * r, y: w.y - din.y * r }, P { x: w.x + dout.x * r, y: w.y + dout.y * r }))
}

/// The gap FigJam leaves between a mark's magnet and the end of a connector attached to it
/// (calibrated 2026-10-30: legs drawn to a magnet began and ended 8px off the mark's edge).
pub const ENDPOINT_GAP: f64 = 8.0;

/// The leg the plugin writes a label on, and where on the page its midpoint falls: after the
/// plugin has rounded the turns at either end of it, and FigJam has held its ends at a mark
/// [`ENDPOINT_GAP`] off the mark.
pub fn label_point(points: &[P], from: &Frame, to: &Frame) -> (usize, P) {
    let legs = points.len() - 1;
    let leg = (legs - 1) / 2;
    let mut anchors = points.to_vec();
    anchors[0] = centre(from);
    *anchors.last_mut().expect("two points") = centre(to);
    let toward = |a: P, b: P, d: f64| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy);
        if l <= d { a } else { P { x: a.x + dx / l * d, y: a.y + dy / l * d } }
    };
    let start = if leg > 0 {
        corner(points, &anchors, leg).map_or(points[leg], |(_, b)| b)
    } else {
        toward(points[0], points[1], ENDPOINT_GAP)
    };
    let end = if leg + 1 < legs {
        corner(points, &anchors, leg + 1).map_or(points[leg + 1], |(a, _)| a)
    } else {
        toward(points[legs], points[legs - 1], ENDPOINT_GAP)
    };
    (leg, P { x: (start.x + end.x) / 2.0, y: (start.y + end.y) / 2.0 })
}

/// The label box for a route, centred on its label point.
pub fn label_box(points: &[P], from: &Frame, to: &Frame, size: Option<(f64, f64)>) -> (usize, Option<Frame>) {
    let (leg, at) = label_point(points, from, to);
    let label = size.map(|(w, h)| Frame { x: at.x - w / 2.0, y: at.y - h / 2.0, w, h });
    (leg, label)
}

/// The clearance a connector keeps from everything it must not touch.
pub const CLEARANCE: f64 = 8.0;

/// A segment's band: the segment widened by half the stroke and the clearance.
pub fn band(a: P, b: P, stroke: f64) -> Frame {
    let pad = stroke / 2.0 + CLEARANCE;
    let (x0, x1) = (a.x.min(b.x), a.x.max(b.x));
    let (y0, y1) = (a.y.min(b.y), a.y.max(b.y));
    Frame { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2.0 * pad, h: y1 - y0 + 2.0 * pad }
}

/// The area an end cap covers, with the clearance around it: `L = max(16, 5 × stroke)` back
/// along the line from where it ends, and `L / 2` to either side (an arrowhead's spread).
/// `None` for an end without a cap.
pub fn cap_box(end: P, toward: P, stroke: f64, cap: &str) -> Option<Frame> {
    if cap == "NONE" {
        return None;
    }
    let l = (5.0 * stroke).max(16.0);
    let (dx, dy) = (toward.x - end.x, toward.y - end.y);
    let len = dx.hypot(dy).max(1e-9);
    let tip = P { x: end.x + dx / len * l, y: end.y + dy / len * l };
    let (x0, x1) = (end.x.min(tip.x), end.x.max(tip.x));
    let (y0, y1) = (end.y.min(tip.y), end.y.max(tip.y));
    let (px, py) = if dx.abs() >= dy.abs() { (0.0, l / 2.0) } else { (l / 2.0, 0.0) };
    Some(Frame {
        x: x0 - px - CLEARANCE,
        y: y0 - py - CLEARANCE,
        w: x1 - x0 + 2.0 * (px + CLEARANCE),
        h: y1 - y0 + 2.0 * (py + CLEARANCE),
    })
}

/// One end of a connector: the mark and the side whose magnet it uses.
pub type End<'a> = (&'a str, Side);

/// Why two routed connectors clash, if they do:
///
/// - a magnet is shared only by connectors that all leave it (fan-out) or all enter it (fan-in);
///   one arriving where another leaves puts an arrowhead on the other's line;
/// - connectors never run along one another, except on the trunk of a fan-out or fan-in: the
///   first legs of two connectors leaving the same magnet, or the last legs of two entering one.
pub fn clash(a: (&[P], End, End), b: (&[P], End, End)) -> Option<&'static str> {
    let (pa, fa, ta) = a;
    let (pb, fb, tb) = b;
    if fa == tb || ta == fb {
        return Some("arrives at a magnet another connector leaves from");
    }
    let (la, lb) = (pa.len() - 2, pb.len() - 2);
    for (i, sa) in pa.windows(2).enumerate() {
        for (j, sb) in pb.windows(2).enumerate() {
            if !collinear_overlap(sa[0], sa[1], sb[0], sb[1]) {
                continue;
            }
            let trunk = (i == 0 && j == 0 && fa == fb) || (i == la && j == lb && ta == tb);
            if !trunk {
                return Some("runs along another connector");
            }
        }
    }
    None
}

/// Whether two axis-aligned segments lie on one line and share more than a pixel of it.
fn collinear_overlap(a: P, b: P, c: P, d: P) -> bool {
    let along = |p: f64, q: f64, r: f64, s: f64| p.max(q).min(r.max(s)) - p.min(q).max(r.min(s)) > 1.0;
    if a.y == b.y && c.y == d.y && a.y == c.y {
        return along(a.x, b.x, c.x, d.x);
    }
    if a.x == b.x && c.x == d.x && a.x == c.x {
        return along(a.y, b.y, c.y, d.y);
    }
    false
}

/// Whether two frames share interior.
pub fn overlaps(a: &Frame, b: &Frame) -> bool {
    a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9
}

/// Whether segment `a`–`b` passes through the interior of `f` (an axis-aligned segment only
/// touching its edge does not).
pub fn crosses(a: P, b: P, f: &Frame) -> bool {
    // Liang–Barsky clipping against the open rectangle.
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let edges = [(-dx, a.x - f.x), (dx, f.x + f.w - a.x), (-dy, a.y - f.y), (dy, f.y + f.h - a.y)];
    for (p, q) in edges {
        if p.abs() < 1e-12 {
            if q <= 1e-9 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 > t1 - 1e-12 {
                return false;
            }
        }
    }
    true
}

/// A connector already placed: id, leg bands, label box, points, and both ends.
type Placed = (String, Vec<Frame>, Option<Frame>, Vec<P>, (String, Side), (String, Side));

/// What a page's routing works against.
struct Scene<'a> {
    marks: Vec<(String, Frame)>,
    frames: &'a HashMap<String, Frame>,
    sizes: &'a Sizes,
    channels: &'a [(String, Frame)],
    /// Each object's chain of enclosing regions, innermost first (the page last).
    regions: HashMap<String, Vec<String>>,
    /// Routes and labels already placed.
    placed: Vec<Placed>,
    lanes_used: HashMap<String, usize>,
    evaluations: usize,
    max: usize,
    /// For each mark, the other marks its connectors join it to.
    neighbours: HashMap<String, Vec<String>>,
}

/// A candidate route before it is checked.
struct Candidate {
    from_side: Side,
    to_side: Side,
    waypoints: Vec<P>,
    kind: &'static str,
}

fn round(p: P) -> P {
    P { x: p.x.round(), y: p.y.round() }
}

impl Scene<'_> {
    fn lowest_common_region(&self, a: &str, b: &str) -> String {
        let (ra, rb) = (&self.regions[a], &self.regions[b]);
        ra.iter().find(|r| rb.contains(r)).cloned().unwrap_or_else(|| ra.last().cloned().unwrap_or_default())
    }

    fn stroke(c: &Connector) -> f64 {
        profile::stroke_width(&c.stroke_width)
    }

    /// Whether a route keeps clear of every mark (its own end marks only where it attaches),
    /// every label and every connector already placed; and whether its label does too.
    fn fits(&self, c: &Connector, points: &[P], label: Option<&Frame>) -> bool {
        let stroke = Self::stroke(c);
        let legs = points.len() - 1;
        let bands: Vec<Frame> = points.windows(2).map(|s| band(s[0], s[1], stroke)).collect();
        for (i, seg) in points.windows(2).enumerate() {
            for (id, m) in &self.marks {
                let own_start = *id == c.from && i == 0;
                let own_end = *id == c.to && i == legs - 1;
                if own_start || own_end {
                    // The leg that attaches runs outward from the magnet, never through the mark.
                    if crosses(seg[0], seg[1], m) {
                        return false;
                    }
                } else if overlaps(&bands[i], m) {
                    // Every other leg keeps its band clear of every mark, its own included.
                    return false;
                }
            }
        }
        // Caps: an arrowhead keeps clear of every mark but the one it points at.
        for (end, at, owner, cap) in
            [(points[0], points[1], &c.from, &c.from_cap), (points[legs], points[legs - 1], &c.to, &c.to_cap)]
        {
            if let Some(b) = cap_box(end, at, stroke, cap)
                && self.marks.iter().any(|(id, m)| id != owner && overlaps(&b, m))
            {
                return false;
            }
        }
        if let Some(lb) = label {
            let grown = Frame {
                x: lb.x - CLEARANCE,
                y: lb.y - CLEARANCE,
                w: lb.w + 2.0 * CLEARANCE,
                h: lb.h + 2.0 * CLEARANCE,
            };
            if self.marks.iter().any(|(_, m)| overlaps(&grown, m)) {
                return false;
            }
            for (_, other_bands, other_label, _, _, _) in &self.placed {
                if other_bands.iter().any(|b| overlaps(&grown, b)) || other_label.is_some_and(|o| overlaps(&grown, &o))
                {
                    return false;
                }
            }
        }
        for (_, _, other_label, _, _, _) in &self.placed {
            if let Some(o) = other_label
                && bands.iter().any(|b| overlaps(b, o))
            {
                return false;
            }
        }
        true
    }

    fn candidates(&mut self, c: &Connector, parallel: usize, region: &str, against_flow: bool) -> Vec<Candidate> {
        let (a, b) = (self.frames[&c.from], self.frames[&c.to]);
        let mut out = Vec::new();
        if c.from == c.to {
            // A self-loop: out one side, around the corner, in on the next side. Its label sits on
            // the leg beside the first side, so the loop reaches out far enough to clear it.
            let label = self.sizes.labels.get(&c.id).map_or((0.0, 0.0), |m| (m.width, m.height));
            let stroke = Self::stroke(c);
            // The corner facing away from the mark's other connections goes first.
            let ca = centre(&a);
            let mut away = P { x: 0.0, y: 0.0 };
            for other in self.neighbours.get(&c.from).into_iter().flatten() {
                let cb = centre(&self.frames[other]);
                let (dx, dy) = (cb.x - ca.x, cb.y - ca.y);
                let l = dx.hypot(dy).max(1e-9);
                away = P { x: away.x - dx / l, y: away.y - dy / l };
            }
            let mut corners = [
                (Side::Top, Side::Right),
                (Side::Right, Side::Bottom),
                (Side::Bottom, Side::Left),
                (Side::Left, Side::Top),
            ];
            let facing = |(s, t): &(Side, Side)| {
                let (ds, dt) = (s.dir(), t.dir());
                -((ds.x + dt.x) * away.x + (ds.y + dt.y) * away.y)
            };
            corners.sort_by(|p, q| facing(p).partial_cmp(&facing(q)).unwrap_or(std::cmp::Ordering::Equal));
            for step in [parallel, parallel + 1] {
                for (s, t) in corners {
                    let across = if s.dir().x == 0.0 { label.1 } else { label.0 };
                    let d =
                        (spacing::GUTTER / 2.0).max((across / 2.0 + CLEARANCE + stroke).ceil()) + 16.0 * step as f64;
                    let (p, q) = (anchor(&a, s), anchor(&a, t));
                    let (ds, dt) = (s.dir(), t.dir());
                    let w1 = P { x: p.x + ds.x * d, y: p.y + ds.y * d };
                    let w3 = P { x: q.x + dt.x * d, y: q.y + dt.y * d };
                    let w2 = if ds.x == 0.0 { P { x: w3.x, y: w1.y } } else { P { x: w1.x, y: w3.y } };
                    out.push(Candidate { from_side: s, to_side: t, waypoints: vec![w1, w2, w3], kind: "loop" });
                }
            }
            return out;
        }
        let horizontal_gap = b.x >= a.x + a.w || a.x >= b.x + b.w;
        let vertical_gap = b.y >= a.y + a.h || a.y >= b.y + b.h;
        let (ca, cb) = (centre(&a), centre(&b));
        let mut direct = Vec::new();
        if horizontal_gap {
            let (s, t) = if cb.x > ca.x { (Side::Right, Side::Left) } else { (Side::Left, Side::Right) };
            let (p, q) = (anchor(&a, s), anchor(&b, t));
            if p.y == q.y {
                direct.push(Candidate { from_side: s, to_side: t, waypoints: vec![], kind: "straight" });
            } else {
                let mx = ((p.x + q.x) / 2.0).round();
                direct.push(Candidate {
                    from_side: s,
                    to_side: t,
                    waypoints: vec![P { x: mx, y: p.y }, P { x: mx, y: q.y }],
                    kind: "elbow",
                });
            }
        }
        if vertical_gap {
            let (s, t) = if cb.y > ca.y { (Side::Bottom, Side::Top) } else { (Side::Top, Side::Bottom) };
            let (p, q) = (anchor(&a, s), anchor(&b, t));
            if p.x == q.x {
                direct.push(Candidate { from_side: s, to_side: t, waypoints: vec![], kind: "straight" });
            } else {
                let my = ((p.y + q.y) / 2.0).round();
                direct.push(Candidate {
                    from_side: s,
                    to_side: t,
                    waypoints: vec![P { x: p.x, y: my }, P { x: q.x, y: my }],
                    kind: "elbow",
                });
            }
        }
        if horizontal_gap && vertical_gap {
            // L-shapes: across then down, or down then across.
            let s = if cb.x > ca.x { Side::Right } else { Side::Left };
            let t = if cb.y > ca.y { Side::Top } else { Side::Bottom };
            let p = anchor(&a, s);
            let q = anchor(&b, t);
            direct.push(Candidate { from_side: s, to_side: t, waypoints: vec![P { x: q.x, y: p.y }], kind: "elbow" });
            let s = if cb.y > ca.y { Side::Bottom } else { Side::Top };
            let t = if cb.x > ca.x { Side::Left } else { Side::Right };
            let p = anchor(&a, s);
            let q = anchor(&b, t);
            direct.push(Candidate { from_side: s, to_side: t, waypoints: vec![P { x: p.x, y: q.y }], kind: "elbow" });
        }
        // Lanes in the region's routing channel.
        let mut channel = Vec::new();
        for (owner, ch) in self.channels.iter().filter(|(owner, _)| owner == region) {
            let label_h = self.sizes.labels.get(&c.id).map_or(0.0, |m| if ch.w >= ch.h { m.height } else { m.width });
            let lane = *self.lanes_used.get(owner).unwrap_or(&0) as f64;
            let horizontal = ch.w >= ch.h;
            let offset = spacing::GUTTER / 2.0 + label_h / 2.0 + lane * (spacing::GUTTER + label_h);
            if horizontal {
                let y = (ch.y + offset).round();
                let (p, q) = (anchor(&a, Side::Bottom), anchor(&b, Side::Bottom));
                channel.push(Candidate {
                    from_side: Side::Bottom,
                    to_side: Side::Bottom,
                    waypoints: vec![P { x: p.x, y }, P { x: q.x, y }],
                    kind: "channel",
                });
            } else {
                let x = (ch.x + offset).round();
                let (p, q) = (anchor(&a, Side::Right), anchor(&b, Side::Right));
                channel.push(Candidate {
                    from_side: Side::Right,
                    to_side: Side::Right,
                    waypoints: vec![P { x, y: p.y }, P { x, y: q.y }],
                    kind: "channel",
                });
            }
        }
        // Arcs over and under both marks (and beside them), further out for each parallel.
        let reach = spacing::GUTTER / 2.0 + 24.0 * parallel as f64;
        let mut arcs = Vec::new();
        let top = a.y.min(b.y) - reach;
        let bottom = (a.y + a.h).max(b.y + b.h) + reach;
        let left = a.x.min(b.x) - reach;
        let right = (a.x + a.w).max(b.x + b.w) + reach;
        let (pt, qt) = (anchor(&a, Side::Top), anchor(&b, Side::Top));
        arcs.push(Candidate {
            from_side: Side::Top,
            to_side: Side::Top,
            waypoints: vec![P { x: pt.x, y: top }, P { x: qt.x, y: top }],
            kind: "arc",
        });
        let (pb, qb) = (anchor(&a, Side::Bottom), anchor(&b, Side::Bottom));
        arcs.push(Candidate {
            from_side: Side::Bottom,
            to_side: Side::Bottom,
            waypoints: vec![P { x: pb.x, y: bottom }, P { x: qb.x, y: bottom }],
            kind: "arc",
        });
        let (pl, ql) = (anchor(&a, Side::Left), anchor(&b, Side::Left));
        arcs.push(Candidate {
            from_side: Side::Left,
            to_side: Side::Left,
            waypoints: vec![P { x: left, y: pl.y }, P { x: left, y: ql.y }],
            kind: "arc",
        });
        let (pr, qr) = (anchor(&a, Side::Right), anchor(&b, Side::Right));
        arcs.push(Candidate {
            from_side: Side::Right,
            to_side: Side::Right,
            waypoints: vec![P { x: right, y: pr.y }, P { x: right, y: qr.y }],
            kind: "arc",
        });
        // Order: a connector against the flow tries its channel first; a parallel one its arcs.
        if against_flow {
            out.extend(channel);
            out.extend(direct);
            out.extend(arcs);
        } else if parallel > 0 {
            out.extend(arcs);
            out.extend(direct);
            out.extend(channel);
        } else {
            out.extend(direct);
            out.extend(channel);
            out.extend(arcs);
        }
        out
    }

    /// Checks a candidate; on success, the route.
    fn check(&mut self, c: &Connector, k: Candidate) -> Option<Route> {
        self.evaluations += 1;
        let (from, to) = (self.frames[&c.from], self.frames[&c.to]);
        let mut points = vec![anchor(&from, k.from_side)];
        points.extend(k.waypoints.iter().map(|&p| round(p)));
        points.push(anchor(&to, k.to_side));
        // Drop points that repeat or run straight on.
        let mut clean: Vec<P> = Vec::with_capacity(points.len());
        for p in points {
            if clean.last() == Some(&p) {
                continue;
            }
            if clean.len() >= 2 {
                let (q, r) = (clean[clean.len() - 2], clean[clean.len() - 1]);
                if (q.x == r.x && r.x == p.x) || (q.y == r.y && r.y == p.y) {
                    clean.pop();
                }
            }
            clean.push(p);
        }
        if clean.len() < 2 {
            return None;
        }
        let size = self.sizes.labels.get(&c.id).map(|m| (m.width, m.height));
        let (label_leg, label_box) = label_box(&clean, &from, &to, size);
        if !self.fits(c, &clean, label_box.as_ref()) {
            return None;
        }
        let ends = ((c.from.as_str(), k.from_side), (c.to.as_str(), k.to_side));
        if self.placed.iter().any(|(_, _, _, points, f, t)| {
            clash((&clean, ends.0, ends.1), (points, (f.0.as_str(), f.1), (t.0.as_str(), t.1))).is_some()
        }) {
            return None;
        }
        let waypoints = clean[1..clean.len() - 1].to_vec();
        Some(Route {
            from_side: k.from_side,
            to_side: k.to_side,
            waypoints,
            points: clean,
            label_leg,
            label_box,
            kind: k.kind,
        })
    }

    /// An orthogonal path through the free space around the marks: Dijkstra over the grid of
    /// lines just outside every mark, preferring few turns.
    fn search(&mut self, c: &Connector) -> Option<Route> {
        let (a, b) = (self.frames[&c.from], self.frames[&c.to]);
        let m = spacing::GUTTER / 3.0;
        let inflated: Vec<(String, Frame)> = self
            .marks
            .iter()
            .map(|(id, f)| (id.clone(), Frame { x: f.x - m, y: f.y - m, w: f.w + 2.0 * m, h: f.h + 2.0 * m }))
            .collect();
        let mut xs = BTreeSet::new();
        let mut ys = BTreeSet::new();
        let key = |v: f64| (v * 2.0).round() as i64;
        let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for (_, f) in &inflated {
            xs.insert(key(f.x));
            xs.insert(key(f.x + f.w));
            ys.insert(key(f.y));
            ys.insert(key(f.y + f.h));
            lo_x = lo_x.min(f.x);
            lo_y = lo_y.min(f.y);
            hi_x = hi_x.max(f.x + f.w);
            hi_y = hi_y.max(f.y + f.h);
        }
        for v in [lo_x - m, hi_x + m] {
            xs.insert(key(v));
        }
        for v in [lo_y - m, hi_y + m] {
            ys.insert(key(v));
        }
        let ends: Vec<(bool, Side, P, P)> = [(true, &a), (false, &b)]
            .into_iter()
            .flat_map(|(start, f)| {
                Side::ALL.into_iter().map(move |s| {
                    let p = anchor(f, s);
                    let d = s.dir();
                    (start, s, p, P { x: p.x + d.x * m, y: p.y + d.y * m })
                })
            })
            .collect();
        for (_, _, p, q) in &ends {
            xs.insert(key(p.x));
            xs.insert(key(q.x));
            ys.insert(key(p.y));
            ys.insert(key(q.y));
        }
        let xs: Vec<f64> = xs.into_iter().map(|k| k as f64 / 2.0).collect();
        let ys: Vec<f64> = ys.into_iter().map(|k| k as f64 / 2.0).collect();
        let (nx, ny) = (xs.len(), ys.len());
        let blocked = |p: P| {
            inflated
                .iter()
                .any(|(_, f)| p.x > f.x + 1e-9 && p.x < f.x + f.w - 1e-9 && p.y > f.y + 1e-9 && p.y < f.y + f.h - 1e-9)
        };
        let clear = |p: P, q: P| !inflated.iter().any(|(_, f)| crosses(p, q, f));
        let index = |v: f64, axis: &[f64]| axis.iter().position(|&a| (a - v).abs() < 1e-6);
        // State: (grid x, grid y, direction 0..4); cost in tenths of a pixel.
        const BEND: i64 = 400;
        let dirs = [(0i64, -1i64), (1, 0), (0, 1), (-1, 0)];
        let mut best: HashMap<(usize, usize, usize), i64> = HashMap::new();
        let mut came: HashMap<(usize, usize, usize), (usize, usize, usize)> = HashMap::new();
        let mut heap = BinaryHeap::new();
        let mut counter = 0u64;
        let mut starts: HashMap<(usize, usize, usize), Side> = HashMap::new();
        for (start, s, p, q) in &ends {
            if !start || blocked(*q) {
                continue;
            }
            let (Some(i), Some(j)) = (index(q.x, &xs), index(q.y, &ys)) else { continue };
            let d = Side::ALL.iter().position(|x| x == s).expect("a side");
            let cost = ((p.x - q.x).abs() + (p.y - q.y).abs()) as i64 * 10;
            if cost < *best.get(&(i, j, d)).unwrap_or(&i64::MAX) {
                best.insert((i, j, d), cost);
                starts.insert((i, j, d), *s);
                heap.push(Reverse((cost, counter, i, j, d)));
                counter += 1;
            }
        }
        let targets: Vec<(Side, usize, usize, P)> = ends
            .iter()
            .filter(|(start, _, _, q)| !start && !blocked(*q))
            .filter_map(|(_, s, p, q)| Some((*s, index(q.x, &xs)?, index(q.y, &ys)?, *p)))
            .collect();
        let mut found: Option<((usize, usize, usize), Side)> = None;
        let mut steps = 0usize;
        while let Some(Reverse((cost, _, i, j, d))) = heap.pop() {
            steps += 1;
            if steps > 200_000 || self.evaluations > self.max {
                break;
            }
            if cost > *best.get(&(i, j, d)).unwrap_or(&i64::MAX) {
                continue;
            }
            let here = P { x: xs[i], y: ys[j] };
            if let Some((s, _, _, p)) = targets.iter().find(|(s, ti, tj, _)| {
                *ti == i && *tj == j && {
                    // Arrive moving into the side: opposite of its outward direction.
                    let o = s.dir();
                    dirs[d] == (-(o.x as i64), -(o.y as i64))
                }
            }) {
                let _ = p;
                found = Some(((i, j, d), *s));
                break;
            }
            for (nd, (dx, dy)) in dirs.iter().enumerate() {
                if (nd + 2) % 4 == d {
                    continue;
                }
                let (ni, nj) = (i as i64 + dx, j as i64 + dy);
                if ni < 0 || nj < 0 || ni >= nx as i64 || nj >= ny as i64 {
                    continue;
                }
                let (ni, nj) = (ni as usize, nj as usize);
                let next = P { x: xs[ni], y: ys[nj] };
                if blocked(next) || !clear(here, next) {
                    continue;
                }
                let step = ((next.x - here.x).abs() + (next.y - here.y).abs()) * 10.0;
                let ncost = cost + step as i64 + if nd != d { BEND } else { 0 };
                if ncost < *best.get(&(ni, nj, nd)).unwrap_or(&i64::MAX) {
                    best.insert((ni, nj, nd), ncost);
                    came.insert((ni, nj, nd), (i, j, d));
                    heap.push(Reverse((ncost, counter, ni, nj, nd)));
                    counter += 1;
                }
            }
        }
        let ((i, j, d), to_side) = found?;
        let mut path = vec![P { x: xs[i], y: ys[j] }];
        let mut state = (i, j, d);
        while let Some(&prev) = came.get(&state) {
            path.push(P { x: xs[prev.0], y: ys[prev.1] });
            state = prev;
        }
        let from_side = *starts.get(&state)?;
        path.reverse();
        self.check(c, Candidate { from_side, to_side, waypoints: path, kind: "search" })
    }
}

/// Why a connector could not be routed: its id, and the region the repair loop should widen.
#[derive(Clone, Debug, PartialEq)]
pub struct Unrouted {
    pub connector: String,
    pub region: String,
}

/// What routing a board did: each page's routes by connector id, and how much work it took.
#[derive(Clone, Debug, Default)]
pub struct Routed {
    pub pages: Vec<HashMap<String, Route>>,
    pub evaluations: usize,
}

fn chains(region: &Region, chain: &[String], out: &mut HashMap<String, Vec<String>>) {
    for child in &region.children {
        out.insert(child.id().to_owned(), chain.to_vec());
        if let Some(inner) = child.region() {
            let mut next = vec![child.id().to_owned()];
            next.extend(chain.iter().cloned());
            chains(inner, &next, out);
        }
    }
}

fn marks_of(region: &Region, frames: &HashMap<String, Frame>, out: &mut Vec<(String, Frame)>) {
    for child in &region.children {
        match child {
            Child::Section(s) => marks_of(&s.region, frames, out),
            Child::Group(g) => marks_of(&g.region, frames, out),
            _ => {
                if let Some(f) = frames.get(child.id()) {
                    out.push((child.id().to_owned(), *f));
                }
            }
        }
    }
}

fn route_page(
    page: &Page,
    layout: &PageLayout,
    sizes: &Sizes,
    budget: &mut usize,
    max: usize,
) -> Result<HashMap<String, Route>, Vec<Unrouted>> {
    let mut marks = Vec::new();
    marks_of(&page.region, &layout.frames, &mut marks);
    let mut regions = HashMap::new();
    chains(&page.region, std::slice::from_ref(&page.id), &mut regions);
    let mut scene = Scene {
        marks,
        frames: &layout.frames,
        sizes,
        channels: &layout.channels,
        regions,
        placed: Vec::new(),
        lanes_used: HashMap::new(),
        evaluations: 0,
        max,
        neighbours: HashMap::new(),
    };
    for c in &page.connectors {
        if c.from != c.to {
            scene.neighbours.entry(c.from.clone()).or_default().push(c.to.clone());
            scene.neighbours.entry(c.to.clone()).or_default().push(c.from.clone());
        }
    }
    let mut routes = HashMap::new();
    let mut failed = Vec::new();
    let mut pairs: HashMap<(String, String), usize> = HashMap::new();
    for c in &page.connectors {
        let pair = if c.from <= c.to { (c.from.clone(), c.to.clone()) } else { (c.to.clone(), c.from.clone()) };
        let parallel = *pairs.entry(pair.clone()).and_modify(|n| *n += 1).or_insert(0);
        let region = scene.lowest_common_region(&c.from, &c.to);
        let against = layout.against.contains(&c.id);
        let mut chosen = None;
        for k in scene.candidates(c, parallel, &region, against) {
            if scene.evaluations >= max {
                break;
            }
            let uses_channel = k.kind == "channel";
            if let Some(r) = scene.check(c, k) {
                if uses_channel {
                    *scene.lanes_used.entry(region.clone()).or_insert(0) += 1;
                }
                chosen = Some(r);
                break;
            }
        }
        if chosen.is_none() && c.from != c.to && scene.evaluations < max {
            scene.max = max;
            chosen = scene.search(c);
        }
        match chosen {
            Some(r) => {
                let stroke = Scene::stroke(c);
                let bands = r.points.windows(2).map(|s| band(s[0], s[1], stroke)).collect();
                let ends = ((c.from.clone(), r.from_side), (c.to.clone(), r.to_side));
                scene.placed.push((c.id.clone(), bands, r.label_box, r.points.clone(), ends.0, ends.1));
                routes.insert(c.id.clone(), r);
            }
            None => failed.push(Unrouted { connector: c.id.clone(), region }),
        }
    }
    *budget += scene.evaluations;
    if failed.is_empty() { Ok(routes) } else { Err(failed) }
}

/// Routes every connector on every page, or reports the ones that did not fit, spending at most
/// `max` candidate evaluations per page (`profile::limits::ROUTE_EVALUATIONS`).
pub fn route(
    board: &Board,
    layouts: &[PageLayout],
    sizes: &Sizes,
    max: usize,
) -> Result<Routed, (Vec<Unrouted>, usize)> {
    let mut routed = Routed::default();
    let mut failures = Vec::new();
    for (page, layout) in board.pages.iter().zip(layouts) {
        match route_page(page, layout, sizes, &mut routed.evaluations, max) {
            Ok(routes) => routed.pages.push(routes),
            Err(mut f) => {
                failures.append(&mut f);
                routed.pages.push(HashMap::new());
            }
        }
    }
    if failures.is_empty() { Ok(routed) } else { Err((failures, routed.evaluations)) }
}
