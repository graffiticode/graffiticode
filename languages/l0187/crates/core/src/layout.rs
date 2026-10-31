// SPDX-License-Identifier: MIT

//! Layout under `FIGJAM_V1` (design §5): every page, section and group arranges its direct
//! children by its `layout`, and its own measured extent is placed as one block by its parent.
//!
//! - **ROW / COLUMN** keep the written order on one line; **GRID** keeps it row by row in
//!   `columns` tracks that grow to fit. Children start-align on the cross axis.
//! - **FLOW** layers its children along `direction`: `before` orders are strict (a child is in an
//!   earlier layer than every sibling it precedes), and connectors between children (including
//!   ones between marks deep inside them) are preferred progression. A connector that would close
//!   a cycle with what is already placed is drawn against the flow instead; connections may
//!   cycle, strict order may not. Within a layer, children are ordered by a fixed number of
//!   barycentre sweeps, declaration order breaking ties. Layers are centred on the cross axis.
//! - **AUTO** is unordered: children joined by connectors are laid out as a flow to the right,
//!   one block per connected group; the rest are packed in a near-square grid; the blocks stack
//!   in the order their first child was written.
//!
//! A FLOW reserves a routing channel beside its layers (below a horizontal flow, right of a
//! vertical one) with one lane per connector that runs against the flow or skips a layer, so the
//! router has somewhere to take them that crosses nothing.
//!
//! Gaps between siblings are the profile's gutter (stronger next to a section or group), widened
//! to hold the label of any connector that runs between them, plus any extra spacing the routing
//! repair loop asks for. A section's title band sits above its border, outside it, and is part
//! of its block. Coordinates are whole pixels.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::ir::{Board, Child, Connector, Direction, Layout, Region};
use crate::profile::{limits, section, spacing};
use crate::size::Sizes;

/// A rectangle in page coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Frame {
    fn moved(self, dx: f64, dy: f64) -> Frame {
        Frame { x: self.x + dx, y: self.y + dy, ..self }
    }

    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// What the layout placed on one page.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageLayout {
    pub width: f64,
    pub height: f64,
    /// Marks: their boxes. Sections: their borders. Groups: their bounds.
    pub frames: HashMap<String, Frame>,
    /// Sections' title bands, above their borders.
    pub titles: HashMap<String, Frame>,
    /// Routing channels a FLOW reserves beside its layers for connectors that run against the
    /// flow or skip a layer, by region id (a region may have several, one per AUTO group).
    pub channels: Vec<(String, Frame)>,
    /// The connectors given a lane in a channel: they run against their flow or skip a layer.
    pub against: Vec<String>,
}

/// Extra clearance between the children of a region, by region id: the routing repair loop's
/// lever. Order, membership and content never change; only spacing grows.
pub type Spacing = HashMap<String, f64>;

/// A laid-out child or region: its extent, and every frame inside it relative to its origin.
#[derive(Clone, Debug, Default)]
struct Block {
    w: f64,
    h: f64,
    frames: Vec<(String, Frame)>,
    titles: Vec<(String, Frame)>,
    channels: Vec<(String, Frame)>,
    against: Vec<String>,
}

impl Block {
    fn place(&mut self, other: Block, x: f64, y: f64) {
        self.frames.extend(other.frames.into_iter().map(|(id, f)| (id, f.moved(x, y))));
        self.titles.extend(other.titles.into_iter().map(|(id, f)| (id, f.moved(x, y))));
        self.channels.extend(other.channels.into_iter().map(|(id, f)| (id, f.moved(x, y))));
        self.against.extend(other.against);
    }
}

/// A region's arrangement: where each child goes, and any routing channels it reserves, relative
/// to the region's origin.
type Arrangement = (Vec<(f64, f64)>, Vec<Frame>, Vec<String>);

/// One block of an AUTO region: its first member, each member's position and its channel
/// relative to the block, and the block's height.
type Part = (usize, Vec<(usize, (f64, f64))>, Option<Frame>, f64);

/// Everything a page's layout needs besides its region tree.
struct Context<'a> {
    sizes: &'a Sizes,
    connectors: &'a [Connector],
    spacing: &'a Spacing,
}

/// The mark ids inside a child, itself included.
fn marks_in(child: &Child, out: &mut Vec<String>) {
    match child.region() {
        Some(region) => region.children.iter().for_each(|c| marks_in(c, out)),
        None => out.push(child.id().to_owned()),
    }
}

/// A connector between two different children of a region, lifted to their indices, with the
/// label size it needs room for.
#[derive(Clone, Copy, Debug)]
struct Edge {
    from: usize,
    to: usize,
    label: (f64, f64),
    /// The connector's index on its page.
    connector: usize,
}

fn half(x: f64) -> f64 {
    (x / 2.0).floor()
}

impl Context<'_> {
    /// The connectors that join different children of `region`, in declaration order.
    fn edges(&self, region: &Region) -> Vec<Edge> {
        let mut owner: HashMap<String, usize> = HashMap::new();
        for (i, child) in region.children.iter().enumerate() {
            let mut ids = Vec::new();
            marks_in(child, &mut ids);
            owner.extend(ids.into_iter().map(|id| (id, i)));
        }
        self.connectors
            .iter()
            .enumerate()
            .filter_map(|(connector, c)| {
                let (from, to) = (*owner.get(&c.from)?, *owner.get(&c.to)?);
                let label = self.sizes.labels.get(&c.id).map(|m| (m.width, m.height)).unwrap_or((0.0, 0.0));
                (from != to).then_some(Edge { from, to, label, connector })
            })
            .collect()
    }

    fn block(&self, child: &Child) -> Block {
        match child {
            Child::Sticky(m) | Child::Shape(m) | Child::Textbox(m) => {
                let (w, h) = self.sizes.marks.get(&m.id).map(|s| (s.width, s.height)).unwrap_or((0.0, 0.0));
                Block { w, h, frames: vec![(m.id.clone(), Frame { x: 0.0, y: 0.0, w, h })], ..Block::default() }
            }
            Child::Group(g) => {
                let mut block = self.region(&g.region, &g.id);
                if g.region.children.is_empty() {
                    block.w = spacing::EMPTY_GROUP;
                    block.h = spacing::EMPTY_GROUP;
                }
                block.frames.push((g.id.clone(), Frame { x: 0.0, y: 0.0, w: block.w, h: block.h }));
                block
            }
            Child::Section(s) => {
                let inner = self.region(&s.region, &s.id);
                let (iw, ih) =
                    if s.region.children.is_empty() { (section::EMPTY, section::EMPTY) } else { (inner.w, inner.h) };
                let title = self.sizes.titles.get(&s.id).copied().unwrap_or(0.0);
                let w = (iw + 2.0 * section::PADDING).max(title);
                let h = ih + 2.0 * section::PADDING;
                let top = section::TITLE_BAND + section::TITLE_GAP;
                let mut block = Block { w, h: top + h, ..Block::default() };
                let ix = section::PADDING + half(w - 2.0 * section::PADDING - iw);
                block.place(inner, ix, top + section::PADDING);
                block.frames.push((s.id.clone(), Frame { x: 0.0, y: top, w, h }));
                block.titles.push((s.id.clone(), Frame { x: 0.0, y: 0.0, w: title.max(1.0), h: section::TITLE_BAND }));
                block
            }
        }
    }

    /// The gap between two siblings: the gutter, stronger next to a region, plus the room a
    /// label between them needs and the repair loop's extra.
    fn gap(&self, a: &Child, b: &Child, label: f64, region_id: &str) -> f64 {
        let base = if a.region().is_some() || b.region().is_some() { spacing::REGION_GUTTER } else { spacing::GUTTER };
        base.max(label + spacing::GUTTER) + self.spacing.get(region_id).copied().unwrap_or(0.0)
    }

    /// Lays out a region's children, returning its block (origin at its top-left).
    fn region(&self, region: &Region, region_id: &str) -> Block {
        let blocks: Vec<Block> = region.children.iter().map(|c| self.block(c)).collect();
        if blocks.is_empty() {
            return Block::default();
        }
        let edges = self.edges(region);
        let all: Vec<usize> = (0..blocks.len()).collect();
        let (positions, channels, against) = match region.layout {
            Layout::Row => (self.line(region, region_id, &blocks, &edges, true), Vec::new(), Vec::new()),
            Layout::Column => (self.line(region, region_id, &blocks, &edges, false), Vec::new(), Vec::new()),
            Layout::Grid { columns } => {
                (self.grid(region, region_id, &blocks, &edges, &all, columns as usize), Vec::new(), Vec::new())
            }
            Layout::Flow { direction } => {
                let (positions, channel, against) = self.flow(region, region_id, &blocks, &edges, &all, direction);
                (positions, channel.into_iter().collect(), against)
            }
            Layout::Auto => self.auto(region, region_id, &blocks, &edges),
        };
        let mut out = Block { against, ..Block::default() };
        for channel in channels {
            out.w = out.w.max(channel.right());
            out.h = out.h.max(channel.bottom());
            out.channels.push((region_id.to_owned(), channel));
        }
        for (block, (x, y)) in blocks.into_iter().zip(positions) {
            out.w = out.w.max(x + block.w);
            out.h = out.h.max(y + block.h);
            out.place(block, x, y);
        }
        out
    }

    /// ROW (`horizontal`) or COLUMN: the written order, start-aligned.
    fn line(&self, region: &Region, id: &str, blocks: &[Block], edges: &[Edge], horizontal: bool) -> Vec<(f64, f64)> {
        let mut at = 0.0;
        let mut out = Vec::with_capacity(blocks.len());
        for (i, block) in blocks.iter().enumerate() {
            if i > 0 {
                // A label between these two neighbours needs room along the line.
                let label = edges
                    .iter()
                    .filter(|e| (e.from.min(e.to), e.from.max(e.to)) == (i - 1, i))
                    .map(|e| if horizontal { e.label.0 } else { e.label.1 })
                    .fold(0.0, f64::max);
                at += self.gap(&region.children[i - 1], &region.children[i], label, id);
            }
            out.push(if horizontal { (at, 0.0) } else { (0.0, at) });
            at += if horizontal { block.w } else { block.h };
        }
        out
    }

    /// The written order in `columns` tracks, row by row; tracks grow to fit, cells start-align.
    fn grid(
        &self,
        region: &Region,
        id: &str,
        blocks: &[Block],
        edges: &[Edge],
        members: &[usize],
        columns: usize,
    ) -> Vec<(f64, f64)> {
        let columns = columns.max(1);
        let rows = members.len().div_ceil(columns);
        let mut widths = vec![0.0f64; columns];
        let mut heights = vec![0.0f64; rows];
        for (k, &i) in members.iter().enumerate() {
            widths[k % columns] = widths[k % columns].max(blocks[i].w);
            heights[k / columns] = heights[k / columns].max(blocks[i].h);
        }
        let any_region = members.iter().any(|&i| region.children[i].region().is_some());
        let base = if any_region { spacing::REGION_GUTTER } else { spacing::GUTTER };
        let label_w = edges.iter().map(|e| e.label.0).fold(0.0, f64::max);
        let label_h = edges.iter().map(|e| e.label.1).fold(0.0, f64::max);
        let extra = self.spacing.get(id).copied().unwrap_or(0.0);
        let gap_x = base.max(label_w + spacing::GUTTER) + extra;
        let gap_y = base.max(label_h + spacing::GUTTER) + extra;
        let xs: Vec<f64> = (0..columns)
            .scan(0.0, |at, c| {
                let x = *at;
                *at += widths[c] + gap_x;
                Some(x)
            })
            .collect();
        let ys: Vec<f64> = (0..rows)
            .scan(0.0, |at, r| {
                let y = *at;
                *at += heights[r] + gap_y;
                Some(y)
            })
            .collect();
        let mut out = vec![(0.0, 0.0); blocks.len()];
        for (k, &i) in members.iter().enumerate() {
            out[i] = (xs[k % columns], ys[k / columns]);
        }
        out
    }

    /// FLOW over `members` (indices into the region's children) in `direction`.
    fn flow(
        &self,
        region: &Region,
        id: &str,
        blocks: &[Block],
        edges: &[Edge],
        members: &[usize],
        direction: Direction,
    ) -> (Vec<(f64, f64)>, Option<Frame>, Vec<String>) {
        let local: HashMap<usize, usize> = members.iter().enumerate().map(|(k, &i)| (i, k)).collect();
        let n = members.len();
        // Strict edges: `before`.
        let mut succ: Vec<Vec<usize>> = vec![Vec::new(); n];
        for (k, &i) in members.iter().enumerate() {
            for target in region.children[i].before() {
                if let Some(j) = region.children.iter().position(|c| c.id() == target)
                    && let Some(&t) = local.get(&j)
                {
                    succ[k].push(t);
                }
            }
        }
        // Preferred edges: connectors, unless one would close a cycle.
        let reaches = |succ: &Vec<Vec<usize>>, from: usize, to: usize| {
            let mut seen = vec![false; n];
            let mut stack = vec![from];
            while let Some(v) = stack.pop() {
                if v == to {
                    return true;
                }
                if !std::mem::replace(&mut seen[v], true) {
                    stack.extend(succ[v].iter().copied());
                }
            }
            false
        };
        let mut lifted: Vec<(usize, usize, (f64, f64))> = Vec::new();
        let mut lifted_ids: Vec<usize> = Vec::new();
        for e in edges {
            let (Some(&a), Some(&b)) = (local.get(&e.from), local.get(&e.to)) else { continue };
            lifted.push((a, b, e.label));
            lifted_ids.push(e.connector);
            if !succ[a].contains(&b) && !reaches(&succ, b, a) {
                succ[a].push(b);
            }
        }
        // Layers: the longest path from a source, in topological order (ties by index).
        let mut indegree = vec![0usize; n];
        for targets in &succ {
            for &t in targets {
                indegree[t] += 1;
            }
        }
        let mut layer = vec![0usize; n];
        let mut ready: std::collections::BTreeSet<usize> = (0..n).filter(|&v| indegree[v] == 0).collect();
        while let Some(v) = ready.pop_first() {
            for &t in &succ[v] {
                layer[t] = layer[t].max(layer[v] + 1);
                indegree[t] -= 1;
                if indegree[t] == 0 {
                    ready.insert(t);
                }
            }
        }
        let layers = layer.iter().copied().max().unwrap_or(0) + 1;
        let mut order: Vec<Vec<usize>> = vec![Vec::new(); layers];
        for v in 0..n {
            order[layer[v]].push(v);
        }
        // Crossing reduction: barycentre sweeps over all connections, a fixed number of times.
        let mut neighbours: Vec<Vec<usize>> = vec![Vec::new(); n];
        for &(a, b, _) in &lifted {
            neighbours[a].push(b);
            neighbours[b].push(a);
        }
        let mut pos = vec![0.0f64; n];
        let reindex = |order: &Vec<Vec<usize>>, pos: &mut Vec<f64>| {
            for row in order {
                for (k, &v) in row.iter().enumerate() {
                    pos[v] = k as f64;
                }
            }
        };
        reindex(&order, &mut pos);
        for sweep in 0..limits::CROSSING_SWEEPS {
            let forward = sweep % 2 == 0;
            let sequence: Vec<usize> =
                if forward { (1..layers).collect() } else { (0..layers.saturating_sub(1)).rev().collect() };
            for l in sequence {
                let reference = if forward { l - 1 } else { l + 1 };
                let mut keyed: Vec<(f64, usize, usize)> = order[l]
                    .iter()
                    .map(|&v| {
                        let near: Vec<f64> =
                            neighbours[v].iter().filter(|&&u| layer[u] == reference).map(|&u| pos[u]).collect();
                        let bary = if near.is_empty() { pos[v] } else { near.iter().sum::<f64>() / near.len() as f64 };
                        (bary, members[v], v)
                    })
                    .collect();
                keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
                order[l] = keyed.into_iter().map(|(_, _, v)| v).collect();
                reindex(&order, &mut pos);
            }
        }
        // Coordinates along the flow (main) and across it (cross).
        let horizontal = matches!(direction, Direction::Right | Direction::Left);
        let main = |v: usize| if horizontal { blocks[members[v]].w } else { blocks[members[v]].h };
        let cross = |v: usize| if horizontal { blocks[members[v]].h } else { blocks[members[v]].w };
        let thickness: Vec<f64> = order.iter().map(|row| row.iter().map(|&v| main(v)).fold(0.0, f64::max)).collect();
        let extra = self.spacing.get(id).copied().unwrap_or(0.0);
        let flow_gap = |l: usize| {
            let label = lifted
                .iter()
                .filter(|(a, b, _)| layer[*a].min(layer[*b]) <= l && layer[*a].max(layer[*b]) > l)
                .map(|(_, _, (w, h))| if horizontal { *w } else { *h })
                .fold(0.0, f64::max);
            let regions = order[l].iter().chain(&order[l + 1]).any(|&v| region.children[members[v]].region().is_some());
            let base = if regions { spacing::REGION_GUTTER } else { spacing::GUTTER };
            (2.0 * base).max(label + 2.0 * spacing::GUTTER) + extra
        };
        let mut starts = vec![0.0f64; layers];
        for l in 1..layers {
            starts[l] = starts[l - 1] + thickness[l - 1] + flow_gap(l - 1);
        }
        let total_main = starts[layers - 1] + thickness[layers - 1];
        let stack_gap = |a: usize, b: usize| {
            let regions =
                region.children[members[a]].region().is_some() || region.children[members[b]].region().is_some();
            (if regions { spacing::REGION_GUTTER } else { spacing::GUTTER }) + extra
        };
        let extents: Vec<f64> = order
            .iter()
            .map(|row| {
                row.iter().map(|&v| cross(v)).sum::<f64>() + row.windows(2).map(|p| stack_gap(p[0], p[1])).sum::<f64>()
            })
            .collect();
        let widest = extents.iter().copied().fold(0.0, f64::max);
        let mut out = vec![(0.0, 0.0); blocks.len()];
        for (l, row) in order.iter().enumerate() {
            let mut at = half(widest - extents[l]);
            for (k, &v) in row.iter().enumerate() {
                if k > 0 {
                    at += stack_gap(row[k - 1], v);
                }
                let mut m = starts[l] + half(thickness[l] - main(v));
                if matches!(direction, Direction::Left | Direction::Up) {
                    m = total_main - m - main(v);
                }
                out[members[v]] = if horizontal { (m, at) } else { (at, m) };
                at += cross(v);
            }
        }
        // A channel beside the layers for every connector that runs against the flow or skips a
        // layer: one lane each, wide enough for its label.
        let lanes: f64 = lifted
            .iter()
            .filter(|(a, b, _)| layer[*b] != layer[*a] + 1)
            .map(|(_, _, (w, h))| spacing::GUTTER + if horizontal { *h } else { *w })
            .sum();
        let against: Vec<String> = lifted
            .iter()
            .zip(&lifted_ids)
            .filter(|((a, b, _), _)| layer[*b] != layer[*a] + 1)
            .map(|(_, &k)| self.connectors[k].id.clone())
            .collect();
        let channel = (lanes > 0.0).then(|| {
            let at = widest + spacing::GUTTER;
            if horizontal {
                Frame { x: 0.0, y: at, w: total_main, h: lanes }
            } else {
                Frame { x: at, y: 0.0, w: lanes, h: total_main }
            }
        });
        (out, channel, against)
    }

    /// AUTO: connected groups as flows to the right, the rest in a near-square grid.
    fn auto(&self, region: &Region, id: &str, blocks: &[Block], edges: &[Edge]) -> Arrangement {
        let n = blocks.len();
        let mut group: Vec<usize> = (0..n).collect();
        fn find(g: &mut [usize], v: usize) -> usize {
            let mut r = v;
            while g[r] != r {
                r = g[r];
            }
            let mut c = v;
            while g[c] != r {
                let next = g[c];
                g[c] = r;
                c = next;
            }
            r
        }
        for e in edges {
            let (a, b) = (find(&mut group, e.from), find(&mut group, e.to));
            if a != b {
                group[a.max(b)] = a.min(b);
            }
        }
        let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for v in 0..n {
            let root = find(&mut group, v);
            components.entry(root).or_default().push(v);
        }
        let (connected, single): (Vec<Vec<usize>>, Vec<Vec<usize>>) =
            components.into_values().partition(|c| c.len() > 1);
        let singles: Vec<usize> = single.into_iter().flatten().collect();
        // Each part: its first member, member positions and channel relative to it, its height.
        let mut parts: Vec<Part> = Vec::new();
        let mut against = Vec::new();
        for members in &connected {
            let (positions, channel, mut back) = self.flow(region, id, blocks, edges, members, Direction::Right);
            against.append(&mut back);
            parts.push(Self::part(blocks, members, &positions, channel));
        }
        if !singles.is_empty() {
            let columns = (singles.len() as f64).sqrt().ceil() as usize;
            let positions = self.grid(region, id, blocks, &[], &singles, columns);
            parts.push(Self::part(blocks, &singles, &positions, None));
        }
        parts.sort_by_key(|p| p.0);
        let mut out = vec![(0.0, 0.0); n];
        let mut channels = Vec::new();
        let mut at = 0.0;
        let extra = self.spacing.get(id).copied().unwrap_or(0.0);
        for (k, (_, placed, channel, h)) in parts.iter().enumerate() {
            if k > 0 {
                at += spacing::REGION_GUTTER + extra;
            }
            for &(i, (x, y)) in placed {
                out[i] = (x, at + y);
            }
            channels.extend(channel.map(|c| c.moved(0.0, at)));
            at += h;
        }
        (out, channels, against)
    }

    fn part(blocks: &[Block], members: &[usize], positions: &[(f64, f64)], channel: Option<Frame>) -> Part {
        let placed: Vec<(usize, (f64, f64))> = members.iter().map(|&i| (i, positions[i])).collect();
        let h = placed.iter().map(|&(i, (_, y))| y + blocks[i].h).fold(channel.map_or(0.0, |c| c.bottom()), f64::max);
        (members[0], placed, channel, h)
    }
}

/// Lays out every page of the board, each on its own canvas from (0, 0).
pub fn layout(board: &Board, sizes: &Sizes, spacing: &Spacing) -> Vec<PageLayout> {
    board
        .pages
        .iter()
        .map(|page| {
            let cx = Context { sizes, connectors: &page.connectors, spacing };
            let block = cx.region(&page.region, &page.id);
            PageLayout {
                width: block.w,
                height: block.h,
                frames: block.frames.into_iter().collect(),
                titles: block.titles.into_iter().collect(),
                channels: block.channels,
                against: block.against,
            }
        })
        .collect()
}
